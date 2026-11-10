import * as path from 'path';
import * as vscode from 'vscode';
import { Repo } from './git/repo';
import { FileState, Tracker } from './tracker';
import { SignalCollector } from './tracking/signals';
import { BASE_SCHEME, BaseContentProvider } from './ui/baseContent';
import { ChangesTreeProvider, FileNode } from './ui/changesTree';
import { DecorationPainter } from './ui/decorations';
import { SettingsViewProvider } from './ui/settingsView';
import { ReviewStatusBar } from './ui/statusBar';

let tracker: Tracker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const t = new Tracker(context.workspaceState);
  tracker = t;
  const painter = new DecorationPainter(t);
  const tree = new ChangesTreeProvider(t);
  const treeView = vscode.window.createTreeView('antiVibe.changes', { treeDataProvider: tree, showCollapseAll: true });
  const settingsView = new SettingsViewProvider();

  context.subscriptions.push(
    settingsView,
    vscode.window.registerWebviewViewProvider('antiVibe.settings', settingsView),
    vscode.commands.registerCommand('antiVibe.openSettings', () =>
      vscode.commands.executeCommand('antiVibe.settings.focus'),
    ),
    t,
    painter,
    tree,
    treeView,
    new SignalCollector(t),
    new ReviewStatusBar(t),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider(t)),
  );

  // Show overall progress in the view title.
  context.subscriptions.push(
    t.onDidChange(() => {
      let total = 0;
      let sum = 0;
      for (const s of t.getStats()) {
        total += s.progress.total;
        sum += s.progress.sum;
      }
      treeView.description = total ? `${Math.floor((sum / total) * 100)}% reviewed` : undefined;
    }),
  );

  // ------------------------------------------------------------ events
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => t.scheduleRefresh(1500)),
    watcher.onDidDelete(() => t.scheduleRefresh(1500)),
    watcher.onDidChange(() => t.scheduleRefresh(1500)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme === 'file') {
        t.onDocumentChanged(e);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      t.pruneDocument(doc);
      t.scheduleRefresh(500);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => t.forgetDocument(doc)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => t.scheduleRefresh(100)),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        t.scheduleRefresh(300); // catch commits / AI edits made outside VS Code
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antiVibe')) {
        t.reloadConfig();
        if (
          e.affectsConfiguration('antiVibe.colors') ||
          e.affectsConfiguration('antiVibe.hideWhenFullyReviewed')
        ) {
          painter.recreate();
        }
      }
    }),
  );

  // ------------------------------------------------------------ commands
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('antiVibe.refresh', () => t.refresh());

  reg('antiVibe.openFile', async (node: FileNode) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(node.stats.repo.abs(node.stats.rel)));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const state = await t.getDocStateAsync(doc);
    if (state) {
      const line = findUnreviewed(t, state, 0, false) ?? firstNew(state);
      if (line !== undefined) {
        reveal(editor, line);
      }
    }
  });

  reg('antiVibe.openDiff', async (node?: FileNode) => {
    const target = node?.stats ?? currentFile(t);
    if (!target) {
      return;
    }
    const { repo, rel } = target;
    const right = vscode.Uri.file(repo.abs(rel));
    const left = BaseContentProvider.uriFor(repo, rel);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(rel)} (${repo.baseRef} ↔ ${repo.branch})`);
  });

  reg('antiVibe.openAllChanges', async () => {
    const files = tree.orderedFiles();
    if (files.length === 0) {
      vscode.window.showInformationMessage('Anti-Vibe Coder: no changes on this branch.');
      return;
    }
    const resources = files.map((s) => {
      const right = vscode.Uri.file(s.repo.abs(s.rel));
      return [right, BaseContentProvider.uriFor(s.repo, s.rel), right];
    });
    const repos = [...new Set(files.map((f) => f.repo))];
    const title = repos.map((r) => `${r.branch} ↔ ${r.baseRef}`).join(', ');
    await vscode.commands.executeCommand('vscode.changes', `Branch review: ${title}`, resources);
  });

  reg('antiVibe.nextUnreviewed', async () => {
    const editor = vscode.window.activeTextEditor;
    let wrapState: FileState | undefined;
    if (editor) {
      const state = await t.getDocStateAsync(editor.document);
      if (state) {
        const line = findUnreviewed(t, state, editor.selection.active.line + 1, false);
        if (line !== undefined) {
          reveal(editor, line);
          return;
        }
        wrapState = state;
      }
    }
    // Next file with unreviewed lines (least reviewed first).
    for (const s of tree.orderedFiles()) {
      if (wrapState && s.repo === wrapState.repo && s.rel === wrapState.rel) {
        continue;
      }
      if (s.progress.reviewed >= s.progress.total) {
        continue;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.repo.abs(s.rel)));
      const state = await t.getDocStateAsync(doc);
      const line = state && findUnreviewed(t, state, 0, false);
      if (line !== undefined && line !== null) {
        reveal(await vscode.window.showTextDocument(doc, { preview: true }), line);
        return;
      }
    }
    if (editor && wrapState) {
      const line = findUnreviewed(t, wrapState, 0, false);
      if (line !== undefined) {
        reveal(editor, line);
        return;
      }
    }
    vscode.window.showInformationMessage('Anti-Vibe Coder: everything on this branch is reviewed. 🎉');
  });

  const markSelection = (value: number) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    let n = 0;
    for (const sel of editor.selections) {
      n += t.setLines(editor.document, sel.start.line, sel.end.line, value);
    }
    vscode.window.setStatusBarMessage(`Anti-Vibe Coder: ${n} line(s) marked ${value ? 'reviewed' : 'unreviewed'}`, 2500);
  };
  reg('antiVibe.markReviewed', () => markSelection(1));
  reg('antiVibe.markUnreviewed', () => markSelection(0));

  reg('antiVibe.resetFile', async (node?: FileNode) => {
    const target = node?.stats ?? currentFile(t);
    if (target) {
      t.resetFile(target.repo, target.rel);
    }
  });

  reg('antiVibe.resetBranch', async () => {
    const repo = await pickRepo(t);
    if (!repo) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Reset all review progress for branch "${repo.branch}"?`,
      { modal: true },
      'Reset',
    );
    if (ok === 'Reset') {
      t.resetBranch(repo);
    }
  });

  reg('antiVibe.selectBaseBranch', async () => {
    const repo = await pickRepo(t);
    if (!repo) {
      return;
    }
    const branches = await repo.listBranches();
    const pick = await vscode.window.showQuickPick(
      [{ label: '$(sync) Auto-detect', value: '' }, ...branches.map((b) => ({ label: b, value: b, description: b === repo.baseRef ? 'current' : undefined }))],
      { placeHolder: `Compare ${repo.branch} against…` },
    );
    if (pick) {
      await vscode.workspace.getConfiguration('antiVibe').update('baseBranch', pick.value, vscode.ConfigurationTarget.Workspace);
    }
  });

  reg('antiVibe.toggleDecorations', () => {
    const on = painter.toggle();
    vscode.window.setStatusBarMessage(`Anti-Vibe Coder colours ${on ? 'on' : 'off'}`, 2000);
  });

  void t.refresh();
}

export function deactivate(): Thenable<void> | undefined {
  return tracker?.store.flush();
}

// ------------------------------------------------------------------ helpers

function findUnreviewed(t: Tracker, state: FileState, from: number, wrap: boolean): number | undefined {
  const thr = t.config.reviewedThreshold;
  const n = state.keys.length;
  for (let i = 0; i < n; i++) {
    const l = from + i;
    if (l >= n && !wrap) {
      return undefined;
    }
    const line = l % n;
    if (state.isNew[line] && t.scoreAt(state, line) < thr) {
      return line;
    }
  }
  return undefined;
}

function firstNew(state: FileState): number | undefined {
  const i = state.isNew.indexOf(1);
  return i < 0 ? undefined : i;
}

function reveal(editor: vscode.TextEditor, line: number): void {
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function currentFile(t: Tracker): { repo: Repo; rel: string } | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  const repo = doc && t.repoFor(doc.uri);
  return repo && doc ? { repo, rel: repo.rel(doc.uri.fsPath) } : undefined;
}

async function pickRepo(t: Tracker): Promise<Repo | undefined> {
  const repos = t.allRepos();
  if (repos.length <= 1) {
    return repos[0];
  }
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: path.basename(r.root), description: r.branch, repo: r })),
    { placeHolder: 'Select repository' },
  );
  return pick?.repo;
}
