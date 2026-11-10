import * as vscode from 'vscode';
import { Tracker } from '../tracker';
import { bucketOf } from '../tracking/scoring';
import { mix, parseColor, toCss } from './color';

const BUCKETS = 10;
const FALLBACK_UNSEEN = { r: 40, g: 120, b: 255, a: 0.28 };
const FALLBACK_SEEN = { r: 255, g: 70, b: 170, a: 0.22 };

/**
 * Colours new lines on a blue (unseen) → pink (reviewed) gradient using
 * BUCKETS + 1 decoration types.
 */
export class DecorationPainter implements vscode.Disposable {
  private types: vscode.TextEditorDecorationType[] = [];
  private enabled = true;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly tracker: Tracker) {
    this.createTypes();
    this.disposables.push(
      tracker.onDidChange(() => this.paintAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintAll()),
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.paintAll();
    return this.enabled;
  }

  /** Recreates decoration types after a colour setting change. */
  recreate(): void {
    this.types.forEach((t) => t.dispose());
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

  paintAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.paint(editor);
    }
  }

  paint(editor: vscode.TextEditor): void {
    const state = this.enabled ? this.tracker.getDocState(editor.document) : undefined;
    const ranges: vscode.Range[][] = this.types.map(() => []);
    if (state) {
      const scores = this.tracker.store.peekFile(state.repo.storeKey, state.rel);
      for (let l = 0; l < state.keys.length && l < editor.document.lineCount; l++) {
        if (!state.isNew[l]) {
          continue;
        }
        const b = bucketOf(scores?.get(state.keys[l]) ?? 0, BUCKETS);
        ranges[b].push(new vscode.Range(l, 0, l, 0));
      }
    }
    this.types.forEach((t, i) => editor.setDecorations(t, ranges[i]));
  }

  dispose(): void {
    this.types.forEach((t) => t.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
