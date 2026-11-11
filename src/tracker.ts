import * as fs from 'fs';
import * as vscode from 'vscode';
import { Config, readConfig } from './config';
import { findRepoRoot, normalizePath, Repo } from './git/repo';
import { computeLineKeys, splitLines } from './tracking/lineKeys';
import { computeNewLines } from './tracking/newLines';
import { bumpScore, getScore, Progress, pruneScores, ScoreMap, setScore, summarize } from './tracking/scoring';
import { ReviewStore } from './tracking/store';

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;

export interface FileState {
  repo: Repo;
  rel: string;
  /** 'doc:<version>' for open documents, 'disk:<mtime>' for files read from disk. */
  tag: string;
  keys: string[];
  isNew: Uint8Array;
}

export interface FileStats {
  repo: Repo;
  rel: string;
  progress: Progress;
}

/**
 * Central model: repos, per-file "which lines are new" state, and scores.
 * UI components subscribe to `onDidChange`.
 */
export class Tracker implements vscode.Disposable {
  config: Config = readConfig();
  readonly store: ReviewStore;

  private repos = new Map<string, Repo>();
  private docStates = new Map<string, FileState>();
  private diskStates = new Map<string, FileState>();
  /** Keys of the last seen version of each open document, for typing transfer. */
  private keysCache = new Map<string, { version: number; keys: string[] }>();
  private stats = new Map<string, FileStats>();
  private statsDirty = new Set<string>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fired (throttled) when scores, new-line state or file lists change. */
  readonly onDidChange = this._onDidChange.event;
  private fireTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;

  constructor(memento: vscode.Memento) {
    this.store = new ReviewStore(memento);
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
    for (const repo of this.repos.values()) {
      const oldKey = repo.storeKey;
      const changed = await repo.refresh(this.config.baseBranch);
      if (changed || oldKey !== repo.storeKey) {
        this.invalidateRepo(repo);
      }
    }
    await this.recomputeAllStats();
    this.fireNow();
  }

  private async discoverRepos(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = new Set<string>();
    for (const f of folders) {
      if (f.uri.scheme !== 'file') {
        continue;
      }
      const root = await findRepoRoot(f.uri.fsPath);
      if (root) {
        roots.add(root);
      }
    }
    const seen = new Set<string>();
    for (const root of roots) {
      const n = normalizePath(root);
      seen.add(n);
      if (!this.repos.has(n)) {
        this.repos.set(n, new Repo(root));
      }
    }
    for (const n of [...this.repos.keys()]) {
      if (!seen.has(n)) {
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

  // ---------------------------------------------------------------- file state

  private computeState(repo: Repo, rel: string, lines: string[], tag: string, base: string | null): FileState {
    return {
      repo,
      rel,
      tag,
      keys: computeLineKeys(lines),
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
      void repo.loadBase(rel).then(() => this.fireSoon());
      return undefined;
    }
    const lines = splitLines(doc.getText());
    const state = this.computeState(repo, rel, lines, tag, base);
    this.docStates.set(uriKey, state);
    this.keysCache.set(uriKey, { version: doc.version, keys: state.keys });
    this.markStatsDirty(repo, rel);
    return state;
  }

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
      this.store.markDirty(state.repo.storeKey);
      this.markStatsDirty(state.repo, state.rel);
      this.fireSoon();
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
      this.store.markDirty(state.repo.storeKey);
      this.markStatsDirty(state.repo, state.rel);
      this.fireSoon();
    }
  }

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
      this.store.markDirty(state.repo.storeKey);
      this.markStatsDirty(state.repo, state.rel);
      this.fireSoon();
    }
    return n;
  }

  /**
   * Handles an edit. When it looks like the user typing (small edit, in the
   * focused active editor, making the document dirty), the score of the edited
   * line is carried over to its new content and increased. Anything else (AI
   * tools writing to disk, large pastes/insertions) leaves the new content at
   * score 0 → blue.
   */
  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    const repo = this.repoFor(doc.uri);
    if (!repo?.ready || e.contentChanges.length === 0) {
      return;
    }
    const uriKey = doc.uri.toString();
    const prev = this.keysCache.get(uriKey);
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

    // The set of changed files may have grown (first edit in a file from main).
    if (!repo.changed.has(rel)) {
      this.scheduleRefresh(1500);
    }
    this.markStatsDirty(repo, rel);
    this.fireSoon();
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

  getStats(): FileStats[] {
    return [...this.stats.values()].filter((s) => s.repo.ready && s.repo.changed.has(s.rel));
  }

  getFileStats(repo: Repo, rel: string): FileStats | undefined {
    return this.stats.get(this.statKey(repo, rel));
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
    const tag = `disk:${stat.mtimeMs}:${stat.size}`;
    const cached = this.diskStates.get(key);
    if (cached && cached.tag === tag && cached.repo === repo) {
      return cached;
    }
    const buf = await fs.promises.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) {
      return undefined; // binary
    }
    const base = await repo.loadBase(rel);
    const lines = splitLines(buf.toString('utf8'));
    const state = this.computeState(repo, rel, lines, tag, base);
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
        jobs.push(this.recomputeStat(repo, rel));
      }
    }
    await Promise.all(jobs);
    for (const k of [...this.stats.keys()]) {
      if (!live.has(k)) {
        this.stats.delete(k);
      }
    }
  }

  private async recomputeStat(repo: Repo, rel: string): Promise<void> {
    const key = this.statKey(repo, rel);
    try {
      const state = await this.getFileState(repo, rel);
      if (!state) {
        this.stats.delete(key);
        return;
      }
      const progress = summarize(state.keys, state.isNew, this.store.peekFile(repo.storeKey, rel), this.config.reviewedThreshold);
      if (progress.total === 0) {
        this.stats.delete(key);
        return;
      }
      this.stats.set(key, { repo, rel, progress });
    } catch {
      this.stats.delete(key);
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
        void this.recomputeStat(repo, rel).then(() => this.fireSoon());
        continue;
      }
      const progress = summarize(state.keys, state.isNew, this.store.peekFile(repo.storeKey, rel), this.config.reviewedThreshold);
      if (progress.total === 0) {
        this.stats.delete(key);
      } else {
        this.stats.set(key, { repo, rel, progress });
      }
    }
  }

  // ---------------------------------------------------------------- events

  fireSoon(): void {
    if (this.fireTimer) {
      return;
    }
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      this.fireNow();
    }, 60);
  }

  private fireNow(): void {
    this.flushDirtyStats();
    this._onDidChange.fire();
  }

  reloadConfig(): void {
    const old = this.config;
    this.config = readConfig();
    if (old.baseBranch !== this.config.baseBranch || old.ignoreWhitespaceOnlyLines !== this.config.ignoreWhitespaceOnlyLines) {
      this.docStates.clear();
      this.diskStates.clear();
      void this.refresh();
    } else if (old.reviewedThreshold !== this.config.reviewedThreshold) {
      // "Lines fully seen" counts depend on the threshold.
      void this.recomputeAllStats().then(() => this.fireNow());
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
    const map = this.store.peekFile(repo.storeKey, repo.rel(doc.uri.fsPath));
    if (map && pruneScores(map, computeLineKeys(splitLines(doc.getText()))) > 0) {
      this.store.markDirty(repo.storeKey);
    }
  }

  forgetDocument(doc: vscode.TextDocument): void {
    const k = doc.uri.toString();
    this.docStates.delete(k);
    this.keysCache.delete(k);
  }

  dispose(): void {
    if (this.fireTimer) {
      clearTimeout(this.fireTimer);
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChange.dispose();
    this.store.dispose();
  }
}
