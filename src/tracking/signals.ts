import * as vscode from 'vscode';
import { Tracker } from '../tracker';
import { focusLines } from './focus';

const TICK_MS = 1000;
/** Visible ranges must be stable this long before viewport time counts (fast scrolling ≠ reading). */
const VIEWPORT_STABLE_MS = 700;
/** Above this many visible lines the viewport increment is damped. */
const COMFORTABLE_LINES = 40;
const CURSOR_NEIGHBOURS = 2;
const MAX_SELECTION_LINES = 200;

/**
 * Collects "has the user looked at this" signals:
 *  - viewport: lines in the focus area (middle band) of the screen, per second
 *  - cursor: cursor line (+ neighbours), per second
 *  - selection: every selected line, per second
 *  - hover: mouse hovering over code (via a silent HoverProvider)
 * Typing is handled in Tracker.onDocumentChanged.
 */
export class SignalCollector implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private lastActivity = Date.now();
  private visibleChangedAt = new WeakMap<vscode.TextEditor, number>();
  private timer: NodeJS.Timeout;

  constructor(private readonly tracker: Tracker) {
    this.timer = setInterval(() => this.tick(), TICK_MS);

    const activity = () => {
      this.lastActivity = Date.now();
    };
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        activity();
        this.onSelectionChanged(e);
      }),
      vscode.window.onDidChangeActiveTextEditor(activity),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        activity();
        this.visibleChangedAt.set(e.textEditor, Date.now());
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          activity();
        }
      }),
      vscode.workspace.onDidChangeTextDocument(activity),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, {
        provideHover: (doc, pos) => {
          activity();
          const h = this.tracker.config.hover;
          if (h.enabled && vscode.window.state.focused) {
            this.tracker.bump(doc, pos.line, h.weight);
          }
          return undefined; // never show a popup
        },
      }),
    );
  }

  private isIdle(): boolean {
    return Date.now() - this.lastActivity > this.tracker.config.idleTimeoutSeconds * 1000;
  }

  private tick(): void {
    if (!vscode.window.state.focused || this.isIdle()) {
      return;
    }
    const cfg = this.tracker.config;
    const dt = TICK_MS / 1000;
    const now = Date.now();
    const active = vscode.window.activeTextEditor;

    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (doc.uri.scheme !== 'file' || !this.tracker.getDocState(doc)) {
        continue;
      }
      const deltas = new Map<number, number>();
      const add = (line: number, d: number) => deltas.set(line, (deltas.get(line) ?? 0) + d);

      if (cfg.viewport.enabled) {
        const stableFor = now - (this.visibleChangedAt.get(editor) ?? 0);
        if (stableFor >= VIEWPORT_STABLE_MS) {
          const visible: number[] = [];
          for (const r of editor.visibleRanges) {
            for (let l = r.start.line; l <= r.end.line; l++) {
              visible.push(l);
            }
          }
          const lines = focusLines(visible, doc.lineCount, cfg.viewport.focusArea);
          // Editors other than the focused one get half weight.
          const focusFactor = editor === active ? 1 : 0.5;
          const inc = cfg.viewport.weight * dt * focusFactor * Math.min(1, COMFORTABLE_LINES / Math.max(1, lines.length));
          for (const l of lines) {
            add(l, inc);
          }
        }
      }

      if (editor === active) {
        const wc = cfg.cursor.weight * dt;
        const ws = cfg.selection.weight * dt;
        for (const sel of editor.selections) {
          if (sel.isEmpty) {
            if (cfg.cursor.enabled) {
              const l = sel.active.line;
              add(l, wc);
              for (let d = 1; d <= CURSOR_NEIGHBOURS; d++) {
                add(l - d, wc / 2);
                add(l + d, wc / 2);
              }
            }
          } else if (cfg.selection.enabled && sel.end.line - sel.start.line <= MAX_SELECTION_LINES) {
            for (let l = sel.start.line; l <= sel.end.line; l++) {
              add(l, ws);
            }
          }
        }
      }

      if (deltas.size > 0) {
        this.tracker.bumpMany(doc, deltas);
      }
    }
  }

  /**
   * At the maximum setting (weight >= 1, "instant") cursor and selection count
   * the moment you click or select, instead of on the next one-second tick.
   */
  private onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent): void {
    // Only real user input: ignore programmatic moves such as "Go to Next Unreviewed".
    if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse && e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard) {
      return;
    }
    if (!vscode.window.state.focused || e.textEditor !== vscode.window.activeTextEditor) {
      return;
    }
    const cfg = this.tracker.config;
    const instantCursor = cfg.cursor.enabled && cfg.cursor.weight >= 1;
    const instantSelection = cfg.selection.enabled && cfg.selection.weight >= 1;
    if (!instantCursor && !instantSelection) {
      return;
    }
    const deltas = new Map<number, number>();
    for (const sel of e.selections) {
      if (sel.isEmpty) {
        if (instantCursor) {
          deltas.set(sel.active.line, 1);
        }
      } else if (instantSelection && sel.end.line - sel.start.line <= MAX_SELECTION_LINES) {
        for (let l = sel.start.line; l <= sel.end.line; l++) {
          deltas.set(l, 1);
        }
      }
    }
    if (deltas.size > 0) {
      this.tracker.bumpMany(e.textEditor.document, deltas);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
