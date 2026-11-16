import * as vscode from 'vscode';
import { ChangeEvent, Tracker } from '../tracker';
import { bucketOf } from '../tracking/scoring';
import { mix, parseColor, toCss } from './color';

/** Colour steps between unseen and fully seen (BUCKETS + 1 decoration types). */
const BUCKETS = 10;
const FALLBACK_UNSEEN = { r: 40, g: 120, b: 255, a: 0.28 };
const FALLBACK_SEEN = { r: 255, g: 70, b: 170, a: 0.22 };
/** Marker in the per-line cache for "no decoration". */
const NONE = 255;

/** What was last sent to one editor, so unchanged colour steps are not sent again. */
interface Painted {
  version: number;
  /** Per line: decoration type index, or NONE. */
  buckets: Uint8Array;
}

/**
 * Colours new lines on a blue (unseen) → pink (reviewed) gradient using
 * BUCKETS + 1 decoration types (see docs/decisions/0009-bucketed-decorations.md).
 *
 * Painting is incremental: only editors whose document is named in the
 * change event are repainted, and within an editor only the decoration types
 * whose set of lines changed are sent to the renderer. While reading, a score
 * tick usually moves a few lines one step, so 2 of the 11 types are updated
 * instead of all of them for every visible editor.
 */
export class DecorationPainter implements vscode.Disposable {
  private types: vscode.TextEditorDecorationType[] = [];
  private enabled = true;
  private disposables: vscode.Disposable[] = [];
  private painted = new WeakMap<vscode.TextEditor, Painted>();
  private visible = new Set<vscode.TextEditor>(vscode.window.visibleTextEditors);

  constructor(private readonly tracker: Tracker) {
    this.createTypes();
    this.disposables.push(
      tracker.onDidChange((e) => this.onChange(e)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        // An editor that (re)appears has no decorations yet: forget what we sent.
        const now = new Set(editors);
        for (const ed of editors) {
          if (!this.visible.has(ed)) {
            this.painted.delete(ed);
          }
        }
        this.visible = now;
        this.paintAll();
      }),
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.paintAll();
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** Recreates decoration types after a colour setting change. */
  recreate(): void {
    this.types.forEach((t) => t.dispose());
    this.painted = new WeakMap();
    this.createTypes();
    this.paintAll();
  }

  private createTypes(): void {
    const cfg = this.tracker.config;
    const from = parseColor(cfg.colorUnseen, FALLBACK_UNSEEN);
    const to = parseColor(cfg.colorSeen, FALLBACK_SEEN);
    this.types = [];
    for (let i = 0; i <= BUCKETS; i++) {
      const t = i / BUCKETS;
      const c = mix(from, to, t);
      const hidden = cfg.hideWhenFullyReviewed && i === BUCKETS;
      this.types.push(
        vscode.window.createTextEditorDecorationType(
          hidden
            ? {}
            : {
                isWholeLine: true,
                backgroundColor: toCss(c),
                overviewRulerColor: toCss(c, Math.min(1, c.a * 3)),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
                // A stronger stripe in the gutter area so the colour is visible on any theme.
                borderWidth: '0 0 0 3px',
                borderStyle: 'solid',
                borderColor: toCss(c, Math.min(1, c.a * 3)),
              },
        ),
      );
    }
  }

  private onChange(e: ChangeEvent): void {
    if (e.docs === 'all') {
      this.paintAll();
      return;
    }
    if (e.docs.size === 0) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (e.docs.has(editor.document.uri.toString())) {
        this.paint(editor);
      }
    }
  }

  paintAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.paint(editor);
    }
  }

  paint(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const lineCount = doc.lineCount;
    const buckets = new Uint8Array(lineCount).fill(NONE);
    const state = this.enabled ? this.tracker.getDocState(doc) : undefined;
    if (state) {
      const scores = this.tracker.store.peekFile(state.repo.storeKey, state.rel);
      const threshold = Math.max(0.01, this.tracker.config.reviewedThreshold);
      const n = Math.min(state.keys.length, lineCount);
      for (let l = 0; l < n; l++) {
        if (state.isNew[l]) {
          // Scale so a line reaches the full "seen" colour at the fully-seen threshold.
          buckets[l] = bucketOf((scores?.get(state.keys[l]) ?? 0) / threshold, BUCKETS);
        }
      }
    }

    // Which decoration types changed? After an edit VS Code has already moved
    // the old decorations around, so the cache is only trusted for the same version.
    const prev = this.painted.get(editor);
    const dirty = new Uint8Array(this.types.length);
    if (!prev || prev.version !== doc.version || prev.buckets.length !== lineCount) {
      dirty.fill(1);
    } else {
      const old = prev.buckets;
      for (let l = 0; l < lineCount; l++) {
        if (old[l] !== buckets[l]) {
          if (old[l] !== NONE) {
            dirty[old[l]] = 1;
          }
          if (buckets[l] !== NONE) {
            dirty[buckets[l]] = 1;
          }
        }
      }
    }
    if (!dirty.includes(1)) {
      return;
    }

    const ranges: vscode.Range[][] = this.types.map(() => []);
    for (let l = 0; l < lineCount; l++) {
      const b = buckets[l];
      if (b !== NONE && dirty[b]) {
        ranges[b].push(new vscode.Range(l, 0, l, 0));
      }
    }
    this.types.forEach((t, i) => {
      if (dirty[i]) {
        editor.setDecorations(t, ranges[i]);
      }
    });
    this.painted.set(editor, { version: doc.version, buckets });
  }

  dispose(): void {
    this.types.forEach((t) => t.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
