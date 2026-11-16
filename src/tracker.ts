import * as fs from 'fs';
import * as vscode from 'vscode';
import { Config, readConfig } from './config';
import { findRepoRoot, normalizePath, Repo } from './git/repo';
import { computeLineKeys, splitLines } from './tracking/lineKeys';
import { computeNewLines } from './tracking/newLines';
import { bumpScore, getScore, Progress, pruneScores, ScoreMap, setScore, summarize } from './tracking/scoring';
import { ReviewStore } from './tracking/store';
import { limit } from './util/limit';

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
/** workspaceState key: { "<normRoot>::<branch>": "<base ref>" }. */
const BRANCH_BASES_KEY = 'antiVibe.branchBases';
/** Files read from disk at the same time during a stats recompute. */
const READ_CONCURRENCY = 16;
/** Above this many paths, a burst of file events just triggers a full refresh. */
const MAX_IGNORE_CHECK = 200;
/**
 * Files inside `.git` whose change can change the branch diff: HEAD and refs
 * (checkout, commit), the index (`git add` / `git rm --cached` move files in or
 * out of "untracked") and the repo-local ignore rules.
 */
const GIT_STATE_FILE = /^\.git\/(HEAD|packed-refs|index|info\/exclude|refs\/)/;

export type BaseSource = 'branch' | 'setting' | 'auto';

export interface FileState {
  repo: Repo;
  rel: string;
  /** 'doc:<version>' for open documents, 'disk:<mtime>:<size>' for files read from disk. */
  tag: string;
  /** Content-based identity per line, see tracking/lineKeys.ts. */
  keys: string[];
  /** 1 for lines that are new on this branch (added/modified vs. the merge-base). */
  isNew: Uint8Array;
}

export interface FileStats {
  repo: Repo;
  rel: string;
  progress: Progress;
}

/** Branch-wide totals, computed once per change event. */
export interface Totals {
  /** Tracked (new) lines over all changed files. */
  total: number;
  /** Sum of line scores. `sum / total` is the overall progress. */
  sum: number;
  /** Changed files with at least one tracked line. */
  files: number;
}

/**
 * What a change event affects. `docs` holds `uri.toString()` keys of open
 * documents whose colours may have changed, or 'all'. An empty set means only
 * file stats / totals changed (nothing to repaint).
 */
export interface ChangeEvent {
  docs: ReadonlySet<string> | 'all';
}

/**
 * Central model: repos, per-file "which lines are new" state, and scores.
 * UI components subscribe to `onDidChange`.
 *
 * Caching (see docs/ARCHITECTURE.md, "Caching and invalidation"):
 * - `docStates`: per open document, keyed by URI, valid for one document version.
 * - `diskStates`: per closed changed file, valid while mtime and size match.
 * - `stats`: per changed file, refreshed when marked dirty.
 * All three are dropped for a repo when its branch, base or merge-base changes.
 */
export class Tracker implements vscode.Disposable {
  config: Config = readConfig();
  readonly store: ReviewStore;

  private repos = new Map<string, Repo>();
  /** Repo root per workspace folder (undefined = not inside a git repo). */
  private folderRoots = new Map<string, string | undefined>();
  private docStates = new Map<string, FileState>();
  private diskStates = new Map<string, FileState>();
  /** Keys of the last seen version of each open document, for typing transfer and reuse. */
  private keysCache = new Map<string, { version: number; keys: string[] }>();
  private stats = new Map<string, FileStats>();
  private statsDirty = new Set<string>();
  private totals: Totals = { total: 0, sum: 0, files: 0 };

  private readonly _onDidChange = new vscode.EventEmitter<ChangeEvent>();
  /** Fired (throttled) when scores, new-line state or file lists change. */
  readonly onDidChange = this._onDidChange.event;
  private fireTimer: NodeJS.Timeout | undefined;
  private pendingDocs: Set<string> | 'all' = new Set();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;

  /** File events waiting for triage (see `onFileEvent`). */
  private syncTimer: NodeJS.Timeout | undefined;
  private pendingCandidates = new Map<Repo, Set<string>>();
  private pendingDisk = new Map<Repo, Set<string>>();

  private readonly readLimit = limit(READ_CONCURRENCY);

  constructor(private readonly memento: vscode.Memento) {
    this.store = new ReviewStore(memento);
  }

  // ---------------------------------------------------------- base branch

  private branchBases(): Record<string, string> {
    return this.memento.get<Record<string, string>>(BRANCH_BASES_KEY, {});
  }

  /** Base chosen for this repo + branch only, or '' if none. */
  branchBase(repo: Repo, branch = repo.branch): string {
    return this.branchBases()[`${repo.normRoot}::${branch}`] ?? '';
  }

  /** Base to compare against: per-branch choice, then the `baseBranch` setting, then '' (auto-detect). */
  baseFor(repo: Repo, branch = repo.branch): { ref: string; source: BaseSource } {
    const own = this.branchBase(repo, branch);
    if (own) {
      return { ref: own, source: 'branch' };
    }
    return this.config.baseBranch ? { ref: this.config.baseBranch, source: 'setting' } : { ref: '', source: 'auto' };
  }

  /** Remembers `ref` as the base for the repo's current branch ('' = forget). */
  async setBranchBase(repo: Repo, ref: string): Promise<void> {
    const all = { ...this.branchBases() };
    const key = `${repo.normRoot}::${repo.branch}`;
    ref = ref.trim();
    if (ref) {
      all[key] = ref;
    } else {
      delete all[key];
    }
    await this.memento.update(BRANCH_BASES_KEY, all);
    await this.refresh();
  }

  // ---------------------------------------------------------------- repos

  allRepos(): Repo[] {
    return [...this.repos.values()];
  }

  repoFor(uri: vscode.Uri): Repo | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    let best: Repo | undefined;
    for (const r of this.repos.values()) {
      if (r.contains(uri.fsPath) && (!best || r.normRoot.length > best.normRoot.length)) {
        best = r;
      }
    }
    return best;
  }

  /** Debounced full refresh (git state + stats). */
  scheduleRefresh(delay = 800): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  /** Workspace folders were added or removed: look for repos again. */
  workspaceFoldersChanged(): void {
    this.folderRoots.clear();
    this.scheduleRefresh(100);
  }

  /**
   * Re-reads git state for every repo and recomputes stats. Concurrent calls
   * are coalesced: a call during a refresh triggers exactly one more refresh.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    this.config = readConfig();
    await this.discoverRepos();
    await Promise.all(
      [...this.repos.values()].map(async (repo) => {
        const result = await repo.refresh((branch) => this.baseFor(repo, branch).ref);
        if (result.baseChanged) {
          this.invalidateRepo(repo);
        }
        // Files that joined or left the diff need no invalidation: their
        // state is computed (or dropped) by recomputeAllStats below.
      }),
    );
    await this.recomputeAllStats();
    this.fireNow('all');
  }

  /**
   * Maps workspace folders to repo roots. Roots are cached per folder; only
   * folders without a repo are checked again (e.g. after `git init`).
   */
  private async discoverRepos(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    await Promise.all(
      folders.map(async (f) => {
        const key = f.uri.fsPath;
        if (this.folderRoots.get(key) === undefined) {
          this.folderRoots.set(key, await findRepoRoot(key));
        }
      }),
    );
    const seen = new Set<string>();
    for (const f of folders) {
      const root = this.folderRoots.get(f.uri.fsPath);
      if (!root) {
        continue;
      }
      const n = normalizePath(root);
      seen.add(n);
      if (!this.repos.has(n)) {
        this.repos.set(n, new Repo(root));
      }
    }
    for (const [n, repo] of [...this.repos]) {
      if (!seen.has(n)) {
        this.invalidateRepo(repo);
        repo.dispose();
        this.repos.delete(n);
      }
    }
  }

  private invalidateRepo(repo: Repo): void {
    for (const [k, s] of this.docStates) {
      if (s.repo === repo) {
        this.docStates.delete(k);
      }
    }
    for (const [k, s] of this.diskStates) {
      if (s.repo === repo) {
        this.diskStates.delete(k);
      }
    }
    for (const [k, s] of this.stats) {
      if (s.repo === repo) {
        this.stats.delete(k);
      }
    }
  }

  /** Drops all derived state (e.g. after a setting that changes what counts as new). */
  private invalidateAll(): void {
    this.docStates.clear();
    this.diskStates.clear();
  }

  // ---------------------------------------------------------------- file events

  /**
   * Triage of file-system events, so that saves, builds and tool output don't
   * each cost a full git refresh:
   * - `.git/HEAD`, `.git/refs/**`, `.git/packed-refs`, `.git/index`,
   *   `.git/info/exclude` → branch, commit, staging or ignore rules changed: refresh.
   * - other files in `.git` (logs, objects, …) → ignored.
   * - a file already in the branch diff changed → re-read it from disk only.
   * - an open document → ignored; document events cover it.
   * - a file outside the diff was created or changed → refresh, unless git
   *   ignores it (checked in one `git check-ignore` call per burst).
   * - a deleted path that is (or contains) a file in the diff → refresh;
   *   other deletions → ignored (deletions are never shown).
   * - while the repo is in an error state → a slow refresh, to recover.
   */
  onFileEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete'): void {
    const repo = this.repoFor(uri);
    if (!repo) {
      return;
    }
    const rel = repo.rel(uri.fsPath);
    if (rel === '.git' || rel.startsWith('.git/')) {
      if (GIT_STATE_FILE.test(rel)) {
        this.scheduleRefresh(1500);
      }
      return;
    }
    if (!repo.ready) {
      if (!this.refreshTimer) {
        this.scheduleRefresh(5000);
      }
      return;
    }
    if (kind === 'delete') {
      // A deleted folder is reported as one event for the folder itself.
      const prefix = rel + '/';
      if (repo.changed.has(rel) || [...repo.changed].some((f) => f.startsWith(prefix))) {
        this.scheduleRefresh(1500);
      }
      return;
    }
    if (repo.changed.has(rel)) {
      if (!this.findOpenDoc(repo, rel)) {
        addTo(this.pendingDisk, repo, rel);
        this.scheduleSync();
      }
      return;
    }
    addTo(this.pendingCandidates, repo, rel);
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.sync();
    }, 500);
  }

  private async sync(): Promise<void> {
    const candidates = this.pendingCandidates;
    const disk = this.pendingDisk;
    this.pendingCandidates = new Map();
    this.pendingDisk = new Map();

    let needRefresh = false;
    for (const [repo, rels] of candidates) {
      if (rels.size > MAX_IGNORE_CHECK) {
        needRefresh = true;
        break;
      }
      const ignored = await repo.ignored([...rels]);
      if (!ignored || [...rels].some((r) => !ignored.has(r))) {
        needRefresh = true;
        break;
      }
    }
    if (needRefresh) {
      this.scheduleRefresh(0);
      return; // a refresh recomputes every stat anyway
    }
    const jobs: Promise<void>[] = [];
    for (const [repo, rels] of disk) {
      for (const rel of rels) {
        jobs.push(this.readLimit(() => this.recomputeStat(repo, rel)));
      }
    }
    if (jobs.length > 0) {
      await Promise.all(jobs);
      this.fireSoon(null);
    }
  }

  // ---------------------------------------------------------------- file state

  private computeState(repo: Repo, rel: string, keys: string[], lines: readonly string[], tag: string, base: readonly string[] | null): FileState {
    return {
      repo,
      rel,
      tag,
      keys,
      isNew: computeNewLines(base, lines, this.config.ignoreWhitespaceOnlyLines),
    };
  }

  /**
   * Synchronous state for an open document. Returns undefined when the file
   * is not part of the branch diff or its base content is still loading (a
   * load is then started and `onDidChange` fires when ready).
   */
  getDocState(doc: vscode.TextDocument): FileState | undefined {
    const repo = this.repoFor(doc.uri);
    if (!repo || !repo.ready) {
      return undefined;
    }
    const rel = repo.rel(doc.uri.fsPath);
    if (!repo.isRelevant(rel)) {
      return undefined;
    }
    const uriKey = doc.uri.toString();
    const tag = `doc:${doc.version}`;
    const cached = this.docStates.get(uriKey);
    if (cached && cached.tag === tag && cached.repo === repo) {
      return cached;
    }
    const base = repo.getBaseSync(rel);
    if (base === undefined) {
      void repo.loadBase(rel).then(() => this.fireSoon(uriKey));
      return undefined;
    }
    const lines = splitLines(doc.getText());
    // onDocumentChanged usually computed the keys of this version already.
    const known = this.keysCache.get(uriKey);
    const keys = known && known.version === doc.version ? known.keys : computeLineKeys(lines);
    const state = this.computeState(repo, rel, keys, lines, tag, base);
    this.docStates.set(uriKey, state);
    this.keysCache.set(uriKey, { version: doc.version, keys });
    this.markStatsDirty(repo, rel);
    return state;
  }

  /** Like {@link getDocState}, but waits for the base content to load. */
  async getDocStateAsync(doc: vscode.TextDocument): Promise<FileState | undefined> {
    const repo = this.repoFor(doc.uri);
    if (repo?.ready) {
      const rel = repo.rel(doc.uri.fsPath);
      if (repo.isRelevant(rel)) {
        await repo.loadBase(rel);
      }
    }
    return this.getDocState(doc);
  }

  scoresFor(state: FileState): ScoreMap {
    return this.store.file(state.repo.storeKey, state.rel);
  }

  scoreAt(state: FileState, line: number): number {
    return getScore(this.store.peekFile(state.repo.storeKey, state.rel), state.keys[line]);
  }

  // ---------------------------------------------------------------- scoring

  /** Adds review score to a line of an open document (no-op for lines that are not new). */
  bump(doc: vscode.TextDocument, line: number, delta: number): void {
    if (delta <= 0) {
      return;
    }
    const state = this.getDocState(doc);
    if (!state || line < 0 || line >= state.keys.length || !state.isNew[line]) {
      return;
    }
    if (bumpScore(this.scoresFor(state), state.keys[line], delta)) {
      this.scoresChanged(state, doc);
    }
  }

  /** Bumps many lines at once; `deltas` maps line -> delta. */
  bumpMany(doc: vscode.TextDocument, deltas: Map<number, number>): void {
    const state = this.getDocState(doc);
    if (!state) {
      return;
    }
    const map = this.scoresFor(state);
    let changed = false;
    for (const [line, delta] of deltas) {
      if (line >= 0 && line < state.keys.length && state.isNew[line] && delta > 0) {
        changed = bumpScore(map, state.keys[line], delta) || changed;
      }
    }
    if (changed) {
      this.scoresChanged(state, doc);
    }
  }

  /** Sets the score of every new line in `[fromLine, toLine]`. Returns how many changed. */
  setLines(doc: vscode.TextDocument, fromLine: number, toLine: number, value: number): number {
    const state = this.getDocState(doc);
    if (!state) {
      return 0;
    }
    const map = this.scoresFor(state);
    let n = 0;
    for (let l = Math.max(0, fromLine); l <= Math.min(toLine, state.keys.length - 1); l++) {
      if (state.isNew[l] && setScore(map, state.keys[l], value)) {
        n++;
      }
    }
    if (n > 0) {
      this.scoresChanged(state, doc);
    }
    return n;
  }

  private scoresChanged(state: FileState, doc: vscode.TextDocument): void {
    this.store.markDirty(state.repo.storeKey);
    this.markStatsDirty(state.repo, state.rel);
    this.fireSoon(doc.uri.toString());
  }

  /**
   * Handles an edit. When it looks like the user typing (small edit, in the
   * focused active editor, making the document dirty), the score of the edited
   * line is carried over to its new content and increased. Anything else (AI
   * tools writing to disk, large pastes/insertions) leaves the new content at
   * score 0 → blue. See docs/decisions/0005-typing-heuristic.md.
   */
  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    const repo = this.repoFor(doc.uri);
    if (!repo?.ready || e.contentChanges.length === 0) {
      return;
    }
    const uriKey = doc.uri.toString();
    const prev = this.keysCache.get(uriKey);
    // Computed once per version and reused by getDocState.
    const newKeys = computeLineKeys(splitLines(doc.getText()));
    this.keysCache.set(uriKey, { version: doc.version, keys: newKeys });

    const t = this.config.typing;
    const active = vscode.window.activeTextEditor;
    const isUserTyping =
      t.enabled &&
      prev !== undefined &&
      prev.version === doc.version - 1 &&
      doc.isDirty &&
      vscode.window.state.focused &&
      active?.document === doc &&
      e.contentChanges.every((c) => c.text.length <= t.maxChars && c.rangeLength <= Math.max(t.maxChars, 2000));

    const rel = repo.rel(doc.uri.fsPath);
    if (isUserTyping && prev) {
      const map = this.store.file(repo.storeKey, rel);
      // Change ranges refer to the document *before* the edit and don't overlap.
      // Walk top to bottom, tracking how many lines earlier changes added.
      const asc = [...e.contentChanges].sort((a, b) => a.range.start.line - b.range.start.line);
      let shift = 0;
      for (const c of asc) {
        const oldStart = c.range.start.line;
        const oldEnd = c.range.end.line;
        const insertedLines = c.text.split('\n').length - 1;
        let carried = 0;
        for (let l = oldStart; l <= oldEnd && l < prev.keys.length; l++) {
          carried = Math.max(carried, getScore(map, prev.keys[l]));
        }
        const newStart = oldStart + shift;
        for (let l = newStart; l <= newStart + insertedLines && l < newKeys.length; l++) {
          const k = newKeys[l];
          const target = Math.max(getScore(map, k), carried) + t.weight;
          setScore(map, k, target);
        }
        shift += insertedLines - (oldEnd - oldStart);
      }
      this.store.markDirty(repo.storeKey);
    }

    // A file outside the diff joins it once saved (git only sees disk content):
    // the save goes through onFileEvent, so nothing to schedule here.
    this.markStatsDirty(repo, rel);
    this.fireSoon(uriKey);
  }

  resetFile(repo: Repo, rel: string): void {
    this.store.resetFile(repo.storeKey, rel);
    this.markStatsDirty(repo, rel);
    this.fireSoon();
  }

  resetBranch(repo: Repo): void {
    this.store.resetBranch(repo.storeKey);
    for (const rel of repo.changed) {
      this.markStatsDirty(repo, rel);
    }
    this.fireSoon();
  }

  // ---------------------------------------------------------------- stats

  private statKey(repo: Repo, rel: string): string {
    return `${repo.normRoot}|${rel}`;
  }

  private markStatsDirty(repo: Repo, rel: string): void {
    this.statsDirty.add(this.statKey(repo, rel));
  }

  /** Progress per changed file with at least one new line. */
  getStats(): FileStats[] {
    return [...this.stats.values()].filter((s) => s.repo.ready && s.repo.changed.has(s.rel));
  }

  getFileStats(repo: Repo, rel: string): FileStats | undefined {
    return this.stats.get(this.statKey(repo, rel));
  }

  /** Branch-wide totals as of the last change event. */
  getTotals(): Totals {
    return this.totals;
  }

  private findOpenDoc(repo: Repo, rel: string): vscode.TextDocument | undefined {
    const target = normalizePath(repo.abs(rel));
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && normalizePath(d.uri.fsPath) === target);
  }

  /** State for any changed file: from the open document if any, else from disk. */
  async getFileState(repo: Repo, rel: string): Promise<FileState | undefined> {
    const doc = this.findOpenDoc(repo, rel);
    if (doc) {
      return this.getDocStateAsync(doc);
    }
    const abs = repo.abs(rel);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      return undefined;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return undefined;
    }
    const key = this.statKey(repo, rel);
    // The merge-base is part of the tag: a state computed against an older
    // base (a refresh moved it while we were reading) never counts as current.
    const mergeBase = repo.mergeBase;
    const tag = `disk:${mergeBase}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.diskStates.get(key);
    if (cached && cached.tag === tag && cached.repo === repo) {
      return cached;
    }
    const buf = await fs.promises.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) {
      return undefined; // binary
    }
    const base = await repo.loadBase(rel);
    if (repo.mergeBase !== mergeBase) {
      return undefined; // superseded; the refresh that moved the base recomputes this file
    }
    const lines = splitLines(buf.toString('utf8'));
    const state = this.computeState(repo, rel, computeLineKeys(lines), lines, tag, base);
    this.diskStates.set(key, state);
    // Content on disk is authoritative: drop scores of lines that no longer exist.
    const map = this.store.peekFile(repo.storeKey, rel);
    if (map && pruneScores(map, state.keys) > 0) {
      this.store.markDirty(repo.storeKey);
    }
    return state;
  }

  private async recomputeAllStats(): Promise<void> {
    const live = new Set<string>();
    const jobs: Promise<void>[] = [];
    for (const repo of this.repos.values()) {
      if (!repo.ready) {
        continue;
      }
      for (const rel of repo.changed) {
        live.add(this.statKey(repo, rel));
        jobs.push(this.readLimit(() => this.recomputeStat(repo, rel)));
      }
    }
    await Promise.all(jobs);
    for (const k of [...this.stats.keys()]) {
      if (!live.has(k)) {
        this.stats.delete(k);
        this.diskStates.delete(k);
      }
    }
  }

  private async recomputeStat(repo: Repo, rel: string): Promise<void> {
    const key = this.statKey(repo, rel);
    const mergeBase = repo.mergeBase;
    try {
      const state = await this.getFileState(repo, rel);
      if (repo.mergeBase !== mergeBase) {
        return; // a refresh moved the base meanwhile and owns this stat now
      }
      if (!state) {
        this.stats.delete(key);
        return;
      }
      this.setStat(key, repo, rel, state);
    } catch {
      this.stats.delete(key);
    }
  }

  private setStat(key: string, repo: Repo, rel: string, state: FileState): void {
    const progress = summarize(state.keys, state.isNew, this.store.peekFile(repo.storeKey, rel), this.config.reviewedThreshold);
    if (progress.total === 0) {
      this.stats.delete(key);
    } else {
      this.stats.set(key, { repo, rel, progress });
    }
  }

  private flushDirtyStats(): void {
    if (this.statsDirty.size === 0) {
      return;
    }
    const dirty = [...this.statsDirty];
    this.statsDirty.clear();
    for (const key of dirty) {
      const sep = key.lastIndexOf('|');
      const repo = this.repos.get(key.slice(0, sep));
      const rel = key.slice(sep + 1);
      if (!repo?.ready || !repo.changed.has(rel)) {
        continue;
      }
      const doc = this.findOpenDoc(repo, rel);
      const state = doc ? this.getDocState(doc) : this.diskStates.get(key);
      if (!state) {
        void this.recomputeStat(repo, rel).then(() => this.fireSoon(null));
        continue;
      }
      this.setStat(key, repo, rel, state);
    }
  }

  private computeTotals(): void {
    let total = 0;
    let sum = 0;
    let files = 0;
    for (const s of this.getStats()) {
      total += s.progress.total;
      sum += s.progress.sum;
      files++;
    }
    this.totals = { total, sum, files };
  }

  // ---------------------------------------------------------------- events

  /**
   * Schedules a change event (throttled to one per 60 ms).
   * @param doc `uri.toString()` of the open document whose colours changed,
   *            `null` when only stats changed, or omitted for "everything".
   */
  fireSoon(doc?: string | null): void {
    if (this.pendingDocs !== 'all') {
      if (doc === undefined) {
        this.pendingDocs = 'all';
      } else if (doc !== null) {
        this.pendingDocs.add(doc);
      }
    }
    if (this.fireTimer) {
      return;
    }
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      const docs = this.pendingDocs;
      this.pendingDocs = new Set();
      this.fireNow(docs);
    }, 60);
  }

  private fireNow(docs: Set<string> | 'all'): void {
    if (docs === 'all') {
      this.pendingDocs = new Set();
    }
    this.flushDirtyStats();
    this.computeTotals();
    this._onDidChange.fire({ docs });
  }

  reloadConfig(): void {
    const old = this.config;
    this.config = readConfig();
    if (old.baseBranch !== this.config.baseBranch || old.ignoreWhitespaceOnlyLines !== this.config.ignoreWhitespaceOnlyLines) {
      this.invalidateAll();
      void this.refresh();
    } else if (old.reviewedThreshold !== this.config.reviewedThreshold) {
      // "Lines fully seen" counts depend on the threshold.
      void this.recomputeAllStats().then(() => this.fireNow('all'));
    } else {
      this.fireSoon();
    }
  }

  /** Drops scores of lines that no longer exist in the (saved) document. */
  pruneDocument(doc: vscode.TextDocument): void {
    const repo = this.repoFor(doc.uri);
    if (!repo?.ready || doc.isDirty) {
      return;
    }
    const uriKey = doc.uri.toString();
    const known = this.keysCache.get(uriKey);
    const keys = known && known.version === doc.version ? known.keys : computeLineKeys(splitLines(doc.getText()));
    const map = this.store.peekFile(repo.storeKey, repo.rel(doc.uri.fsPath));
    if (map && pruneScores(map, keys) > 0) {
      this.store.markDirty(repo.storeKey);
    }
  }

  forgetDocument(doc: vscode.TextDocument): void {
    const k = doc.uri.toString();
    this.docStates.delete(k);
    this.keysCache.delete(k);
  }

  dispose(): void {
    for (const t of [this.fireTimer, this.refreshTimer, this.syncTimer]) {
      if (t) {
        clearTimeout(t);
      }
    }
    this._onDidChange.dispose();
    this.store.dispose();
    for (const repo of this.repos.values()) {
      repo.dispose();
    }
  }
}

function addTo(map: Map<Repo, Set<string>>, repo: Repo, rel: string): void {
  let set = map.get(repo);
  if (!set) {
    set = new Set();
    map.set(repo, set);
  }
  set.add(rel);
}
