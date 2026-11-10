import * as vscode from 'vscode';
import { Tracker } from '../tracker';

/** "$(eye) 42% reviewed" for the whole branch. */
export class ReviewStatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private sub: vscode.Disposable;

  constructor(private readonly tracker: Tracker) {
    this.item.command = 'antiVibe.changes.focus';
    this.sub = tracker.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    let total = 0;
    let sum = 0;
    let files = 0;
    for (const s of this.tracker.getStats()) {
      total += s.progress.total;
      sum += s.progress.sum;
      files++;
    }
    const repos = this.tracker.allRepos().filter((r) => r.ready);
    if (repos.length === 0) {
      this.item.hide();
      return;
    }
    const pct = total === 0 ? 100 : Math.floor((sum / total) * 100);
    this.item.text = `$(eye) ${pct}% reviewed`;
    const bases = repos.map((r) => `${r.branch} ↔ ${r.baseRef}`).join(', ');
    this.item.tooltip = `Anti-Vibe Coder: ${total} new lines in ${files} files (${bases})`;
    this.item.show();
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
