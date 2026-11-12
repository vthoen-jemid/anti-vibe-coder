import * as path from 'path';
import { git, tryGit } from './git';

const MAX_BASE_BYTES = 2 * 1024 * 1024;

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * One git repository: knows the current branch, the base it is compared to,
 * the merge-base commit and which files differ from it.
 */
export class Repo {
  /** Absolute repo root as reported by git (native separators). */
  readonly root: string;
  readonly normRoot: string;

  branch = '';
  baseRef = '';
  mergeBase = '';
  /** Repo-relative paths ('/' separated) changed on this branch, incl. uncommitted + untracked. */
  changed = new Set<string>();
  /** Untracked (non-ignored) files: have no base version. */
  untracked = new Set<string>();
  ready = false;
  error: string | undefined;

  private baseCache = new Map<string, string | null>();
  private basePending = new Map<string, Promise<string | null>>();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.normRoot = normalizePath(root);
  }

  get storeKey(): string {
    return `${this.normRoot}::${this.branch}`;
  }

  contains(fsPath: string): boolean {
    const n = normalizePath(fsPath);
    return n === this.normRoot || n.startsWith(this.normRoot + path.sep);
  }

  rel(fsPath: string): string {
    return path.relative(this.root, fsPath).split(path.sep).join('/');
  }

  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  /** Whether the file is tracked by this extension (changed or tracked in base). */
  isRelevant(rel: string): boolean {
    return this.changed.has(rel);
  }

  /**
   * Re-reads branch, base, merge-base and changed files. Returns true if anything changed.
   * `baseFor` gets the current branch and returns the base to compare against ('' = auto-detect).
   */
  async refresh(baseFor: (branch: string) => string): Promise<boolean> {
    const before = this.signature();
    try {
      const branch = (await git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      this.branch = branch === 'HEAD' ? (await git(this.root, ['rev-parse', '--short', 'HEAD'])).trim() : branch;

      const { ref, mergeBase: mb } = await this.resolveBase(baseFor(this.branch));
      this.baseRef = ref;
      if (mb !== this.mergeBase) {
        this.baseCache.clear();
        this.basePending.clear();
      }
      this.mergeBase = mb;

      const diffOut = await git(this.root, ['diff', '--name-only', '--no-renames', '-z', '--diff-filter=d', mb]);
      const untrackedOut = await git(this.root, ['ls-files', '--others', '--exclude-standard', '-z']);
      const changed = new Set(diffOut.split('\0').filter(Boolean));
      const untracked = new Set(untrackedOut.split('\0').filter(Boolean));
      for (const u of untracked) {
        changed.add(u);
      }
      this.changed = changed;
      this.untracked = untracked;
      this.error = undefined;
      this.ready = true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.ready = false;
      this.changed = new Set();
    }
    return before !== this.signature();
  }

  private signature(): string {
    return [this.branch, this.baseRef, this.mergeBase, this.ready, [...this.changed].sort().join('|')].join('\n');
  }

  /**
   * Picks the base ref and its merge-base with HEAD. A configured base is used
   * as-is; otherwise candidates are tried in order and the first one that
   * shares history with HEAD wins.
   */
  private async resolveBase(configuredBase: string): Promise<{ ref: string; mergeBase: string }> {
    const candidates = configuredBase ? [configuredBase] : await this.baseCandidates();
    if (candidates.length === 0) {
      throw new Error('Could not find a base branch (main/master). Choose a base branch in the Anti-Vibe Coder settings.');
    }
    for (const ref of candidates) {
      const mb = (await tryGit(this.root, ['merge-base', 'HEAD', ref]))?.trim();
      if (mb) {
        return { ref, mergeBase: mb };
      }
    }
    throw new Error(await this.noMergeBaseMessage(candidates, !!configuredBase));
  }

  /** Existing base-branch candidates, most preferred first, without duplicates. */
  private async baseCandidates(): Promise<string[]> {
    const originHead = (await tryGit(this.root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
    const names = [originHead, 'main', 'master', 'origin/main', 'origin/master', 'develop'];
    const found: string[] = [];
    for (const cand of names) {
      if (!cand || found.includes(cand)) {
        continue;
      }
      if (await tryGit(this.root, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`])) {
        found.push(cand);
      }
    }
    return found;
  }

  private async noMergeBaseMessage(tried: string[], configured: boolean): Promise<string> {
    const list = tried.map((r) => `"${r}"`).join(', ');
    const shallow = (await tryGit(this.root, ['rev-parse', '--is-shallow-repository']))?.trim() === 'true';
    if (shallow) {
      return `No merge-base between HEAD and ${list}: this is a shallow clone. Run "git fetch --unshallow".`;
    }
    const hint = configured
      ? 'Check that the base branch you chose is a branch your work is based on.'
      : 'HEAD shares no history with these branches. Choose the branch your work is based on in the Anti-Vibe Coder settings.';
    return `No merge-base between HEAD and ${list}. ${hint}`;
  }

  hasBaseLoaded(rel: string): boolean {
    return this.baseCache.has(rel);
  }

  getBaseSync(rel: string): string | null | undefined {
    return this.baseCache.get(rel);
  }

  /** Content of the file at the merge-base, or null if it did not exist there. */
  loadBase(rel: string): Promise<string | null> {
    if (this.baseCache.has(rel)) {
      return Promise.resolve(this.baseCache.get(rel)!);
    }
    let p = this.basePending.get(rel);
    if (!p) {
      const mb = this.mergeBase;
      p = this.showAt(mb, rel).then((content) => {
        if (this.mergeBase === mb) {
          this.baseCache.set(rel, content);
        }
        this.basePending.delete(rel);
        return content;
      });
      this.basePending.set(rel, p);
    }
    return p;
  }

  async showAt(ref: string, rel: string): Promise<string | null> {
    if (!ref || this.untracked.has(rel)) {
      return null;
    }
    try {
      const out = await git(this.root, ['show', `${ref}:${rel}`], MAX_BASE_BYTES * 4);
      return out;
    } catch {
      return null;
    }
  }

  /** Whether `ref` names an existing commit-ish in this repo. */
  async refExists(ref: string): Promise<boolean> {
    return !!(await tryGit(this.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
  }

  async listBranches(): Promise<string[]> {
    const out = await tryGit(this.root, ['branch', '-a', '--format=%(refname:short)']);
    return (out ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.endsWith('/HEAD') && s !== 'origin');
  }
}

export async function findRepoRoot(dir: string): Promise<string | undefined> {
  const out = await tryGit(dir, ['rev-parse', '--show-toplevel']);
  return out?.trim() || undefined;
}
