import * as vscode from 'vscode';
import { ScoreMap } from './scoring';

const PREFIX = 'antiVibe.v1:';
type Serialized = Record<string, Record<string, number>>;

/**
 * Review scores, persisted per (repo, branch) in workspaceState.
 * Kept in memory and flushed with a debounce.
 */
export class ReviewStore implements vscode.Disposable {
  private data = new Map<string, Map<string, ScoreMap>>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly memento: vscode.Memento) {}

  file(storeKey: string, rel: string): ScoreMap {
    const branch = this.branch(storeKey);
    let m = branch.get(rel);
    if (!m) {
      m = new Map();
      branch.set(rel, m);
    }
    return m;
  }

  peekFile(storeKey: string, rel: string): ScoreMap | undefined {
    return this.branch(storeKey).get(rel);
  }

  resetFile(storeKey: string, rel: string): void {
    this.branch(storeKey).delete(rel);
    this.markDirty(storeKey);
  }

  resetBranch(storeKey: string): void {
    this.data.set(storeKey, new Map());
    this.markDirty(storeKey);
  }

  markDirty(storeKey: string): void {
    this.dirty.add(storeKey);
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 3000);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const keys = [...this.dirty];
    this.dirty.clear();
    await Promise.all(keys.map((k) => this.memento.update(PREFIX + k, this.serialize(k))));
  }

  private branch(storeKey: string): Map<string, ScoreMap> {
    let b = this.data.get(storeKey);
    if (!b) {
      b = new Map();
      const raw = this.memento.get<Serialized>(PREFIX + storeKey);
      if (raw) {
        for (const [rel, scores] of Object.entries(raw)) {
          b.set(rel, new Map(Object.entries(scores)));
        }
      }
      this.data.set(storeKey, b);
    }
    return b;
  }

  private serialize(storeKey: string): Serialized | undefined {
    const b = this.data.get(storeKey);
    if (!b || b.size === 0) {
      return undefined;
    }
    const out: Serialized = {};
    for (const [rel, scores] of b) {
      if (scores.size === 0) {
        continue;
      }
      const o: Record<string, number> = {};
      for (const [k, v] of scores) {
        o[k] = Math.round(v * 1000) / 1000;
      }
      out[rel] = o;
    }
    return out;
  }

  dispose(): void {
    void this.flush();
  }
}
