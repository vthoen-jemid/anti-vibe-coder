import * as path from 'path';
import { splitLines } from '../tracking/lineKeys';
import { CatFile } from './catFile';
import { git, GitError, tryGit } from './git';

/** Base versions larger than this are treated as absent (the whole file counts as new). */
const MAX_BASE_BYTES = 8 * 1024 * 1024;

/**
 * Base branches tried when nothing is configured, most preferred first.
 * `origin/HEAD` (the remote's default branch) is resolved separately and goes first.
 */
const BASE_CANDIDATES: { ref: string; name: string }[] = [
  { ref: 'refs/heads/main', name: 'main' },
  { ref: 'refs/heads/master', name: 'master' },
  { ref: 'refs/remotes/origin/main', name: 'origin/main' },
  { ref: 'refs/remotes/origin/master', name: 'origin/master' },
  { ref: 'refs/heads/develop', name: 'develop' },
];
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** What a {@link Repo.refresh} changed. */
export interface RefreshResult {
  /**
   * Branch, base ref, merge-base or readiness changed. Everything derived from
   * the base (new-line state, stats, the store key) must be recomputed.
   */
  baseChanged: boolean;
  /** Files that joined the changed set (only meaningful when `baseChanged` is false). */
  added: string[];
  /** Files that left the changed set (only meaningful when `baseChanged` is false). */
  removed: string[];
}

/**
 * One git repository: knows the current branch, the base it is compared to,
 * the merge-base commit and which files differ from it.
 *
 * All git access goes through the `git` CLI (see docs/decisions/0007-git-cli.md);
 * file contents at the merge-base are read through one persistent
 * `git cat-file --batch` process (docs/decisions/0010-persistent-cat-file.md).
 */
export class Repo {
  /** Absolute repo root as reported by git (native separators). */
  readonly root: string;
  /** `root` normalised for comparisons (lower-case on Windows). Used as the repo id. */
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

  /** Base content per file at `mergeBase`, as lines (null = did not exist there). */
  private baseCache = new Map<string, readonly string[] | null>();
  private basePending = new Map<string, Promise<readonly string[] | null>>();
  private readonly catFile: CatFile;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.normRoot = normalizePath(root);
    this.catFile = new CatFile(this.root, MAX_BASE_BYTES);
  }

  /** Key under which review scores are stored: one score set per repo + branch. */
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

  /** Whether the file is tracked by this extension (part of the branch diff). */
  isRelevant(rel: string): boolean {
    return this.changed.has(rel);
  }

  /**
   * Re-reads branch, base, merge-base and changed files.
   * `baseFor` gets the current branch and returns the base to compare against ('' = auto-detect).
   *
   * Costs 3–4 sequential git calls: branch, (base candidates,) merge-base, and
   * `diff` + `ls-files` in parallel.
   */
  async refresh(baseFor: (branch: string) => string): Promise<RefreshResult> {
    const before = { branch: this.branch, baseRef: this.baseRef, mergeBase: this.mergeBase, ready: this.ready };
    const oldChanged = this.changed;
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

      const [diffOut, untrackedOut] = await Promise.all([
        git(this.root, ['diff', '--name-only', '--no-renames', '-z', '--diff-filter=d', mb]),
        git(this.root, ['ls-files', '--others', '--exclude-standard', '-z']),
      ]);
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
    const baseChanged =
      before.branch !== this.branch ||
      before.baseRef !== this.baseRef ||
      before.mergeBase !== this.mergeBase ||
      before.ready !== this.ready;
    return {
      baseChanged,
      added: [...this.changed].filter((f) => !oldChanged.has(f)),
      removed: [...oldChanged].filter((f) => !this.changed.has(f)),
    };
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

  /**
   * Existing base-branch candidates, most preferred first, without duplicates:
   * origin/HEAD's target, main, master, origin/main, origin/master, develop.
   * One `for-each-ref` call instead of a `rev-parse` per candidate.
   */
  private async baseCandidates(): Promise<string[]> {
    const out = await tryGit(this.root, [
      'for-each-ref',
      '--format=%(refname)%00%(symref)',
      ORIGIN_HEAD,
      ...BASE_CANDIDATES.map((c) => c.ref),
    ]);
    return orderBaseCandidates(out ?? '');
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

  /** Base lines if already loaded; undefined while not loaded yet. */
  getBaseSync(rel: string): readonly string[] | null | undefined {
    return this.baseCache.get(rel);
  }

  /** Lines of the file at the merge-base, or null if it did not exist there. Cached per merge-base. */
  loadBase(rel: string): Promise<readonly string[] | null> {
    if (this.baseCache.has(rel)) {
      return Promise.resolve(this.baseCache.get(rel)!);
    }
    let p = this.basePending.get(rel);
    if (!p) {
      const mb = this.mergeBase;
      p = this.showAt(mb, rel).then((content) => {
        const lines = content === null ? null : splitLines(content);
        if (this.mergeBase === mb) {
          this.baseCache.set(rel, lines);
          this.basePending.delete(rel);
        }
        return lines;
      });
      this.basePending.set(rel, p);
    }
    return p;
  }

  /** Content of `rel` at `ref`, or null if it does not exist there (or is too large / not a file). */
  async showAt(ref: string, rel: string): Promise<string | null> {
    if (!ref || this.untracked.has(rel)) {
      return null;
    }
    const spec = `${ref}:${rel}`;
    if (CatFile.canRead(spec)) {
      try {
        const r = await this.catFile.read(spec);
        return r.kind === 'blob' ? r.content.toString('utf8') : null;
      } catch {
        // cat-file unavailable or crashed: fall back to one `git show`.
      }
    }
    try {
      return await git(this.root, ['show', spec], MAX_BASE_BYTES);
    } catch {
      return null;
    }
  }

  /**
   * The subset of `rels` that git ignores (.gitignore, info/exclude, …), or
   * undefined when git could not tell. Tracked files are never reported.
   */
  async ignored(rels: string[]): Promise<Set<string> | undefined> {
    try {
      const input = rels.map((r) => r + '\0').join('');
      const out = await git(this.root, ['check-ignore', '-z', '--stdin'], undefined, input);
      return new Set(out.split('\0').filter(Boolean));
    } catch (e) {
      // Exit code 1 means "none of these paths are ignored".
      return e instanceof GitError && e.code === 1 ? new Set() : undefined;
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

  /** Stops the cat-file process. */
  dispose(): void {
    this.catFile.dispose();
  }
}

/**
 * Turns `for-each-ref --format=%(refname)%00%(symref)` output into base
 * candidates in preference order. Exported for tests.
 */
export function orderBaseCandidates(forEachRefOut: string): string[] {
  const existing = new Map<string, string>(); // refname -> symref target ('' if none)
  for (const line of forEachRefOut.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const [ref, symref = ''] = line.split('\0');
    existing.set(ref, symref);
  }
  const found: string[] = [];
  const target = existing.get(ORIGIN_HEAD);
  if (target) {
    found.push(shortRef(target));
  }
  for (const c of BASE_CANDIDATES) {
    if (existing.has(c.ref) && !found.includes(c.name)) {
      found.push(c.name);
    }
  }
  return found;
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, '');
}

export async function findRepoRoot(dir: string): Promise<string | undefined> {
  const out = await tryGit(dir, ['rev-parse', '--show-toplevel']);
  return out?.trim() || undefined;
}
