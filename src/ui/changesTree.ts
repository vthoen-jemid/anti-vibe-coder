import * as path from 'path';
import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { FileStats, Tracker } from '../tracker';
import { Category, categoryOf, progressRatio } from '../tracking/scoring';

export type Node = RepoNode | GroupNode | FileNode | MessageNode;

export class RepoNode {
  readonly kind = 'repo';
  constructor(readonly repo: Repo) {}
}

export class GroupNode {
  readonly kind = 'group';
  constructor(readonly repo: Repo, readonly category: Category, readonly files: FileStats[]) {}
}

export class FileNode {
  readonly kind = 'file';
  constructor(readonly stats: FileStats) {}
}

class MessageNode {
  readonly kind = 'message';
  constructor(readonly text: string, readonly icon = 'info', readonly id?: string) {}
}

const GROUPS: { category: Category; label: string; icon: string; color: string; expanded: boolean }[] = [
  { category: 'unseen', label: 'Unseen', icon: 'eye-closed', color: 'charts.blue', expanded: true },
  { category: 'partial', label: 'Partially seen', icon: 'eye', color: 'charts.purple', expanded: true },
  { category: 'reviewed', label: 'Fully reviewed', icon: 'pass-filled', color: 'charts.green', expanded: false },
];

/** Sidebar overview: changed files split into Unseen / Partially seen / Fully reviewed. */
export class ChangesTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private timer: NodeJS.Timeout | undefined;
  private sub: vscode.Disposable;

  constructor(private readonly tracker: Tracker) {
    // Scores change every second while reading; refresh the tree at a calmer pace.
    this.sub = tracker.onDidChange(() => {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this._onDidChangeTreeData.fire();
        }, 1000);
      }
    });
  }

  /** Files ordered least reviewed first. */
  orderedFiles(repo?: Repo): FileStats[] {
    return this.tracker
      .getStats()
      .filter((s) => !repo || s.repo === repo)
      .sort((a, b) => progressRatio(a.progress) - progressRatio(b.progress) || a.rel.localeCompare(b.rel));
  }

  getChildren(node?: Node): Node[] {
    const repos = this.tracker.allRepos();
    if (!node) {
      if (repos.length === 0) {
        return [new MessageNode('No git repository in this workspace.')];
      }
      if (repos.length > 1) {
        return repos.map((r) => new RepoNode(r));
      }
      return this.groupsOf(repos[0]);
    }
    if (node.kind === 'repo') {
      return this.groupsOf(node.repo);
    }
    if (node.kind === 'group') {
      if (node.files.length === 0) {
        return [new MessageNode('None', 'blank', `none:${node.repo.normRoot}:${node.category}`)];
      }
      return node.files.map((s) => new FileNode(s));
    }
    return [];
  }

  private groupsOf(repo: Repo): Node[] {
    if (!repo.ready) {
      return [new MessageNode(repo.error ?? 'Loading…', repo.error ? 'warning' : 'loading~spin')];
    }
    const files = this.orderedFiles(repo);
    if (files.length === 0) {
      return [new MessageNode(`No changes compared to ${repo.baseRef}.`)];
    }
    return GROUPS.map((g) => new GroupNode(repo, g.category, files.filter((f) => categoryOf(f.progress) === g.category)));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.id) {
        item.id = node.id;
      }
      return item;
    }
    if (node.kind === 'repo') {
      const r = node.repo;
      const item = new vscode.TreeItem(path.basename(r.root), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `repo:${r.normRoot}`;
      item.description = r.ready ? `${r.branch} ↔ ${r.baseRef}` : r.error;
      item.iconPath = new vscode.ThemeIcon('repo');
      return item;
    }
    if (node.kind === 'group') {
      const g = GROUPS.find((x) => x.category === node.category)!;
      const item = new vscode.TreeItem(
        `${g.label} (${node.files.length})`,
        g.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      // Stable id keeps the user's expand/collapse choice across refreshes.
      item.id = `group:${node.repo.normRoot}:${node.category}`;
      item.iconPath = new vscode.ThemeIcon(g.icon, new vscode.ThemeColor(g.color));
      let lines = 0;
      let open = 0;
      for (const f of node.files) {
        lines += f.progress.total;
        open += f.progress.total - f.progress.reviewed;
      }
      item.description = node.category === 'reviewed' ? `${lines} lines` : `${open} of ${lines} lines to go`;
      item.contextValue = `antiVibeGroup-${node.category}`;
      return item;
    }
    const { repo, rel, progress } = node.stats;
    const ratio = progressRatio(progress);
    const pct = Math.floor(ratio * 100);
    const item = new vscode.TreeItem(path.posix.basename(rel));
    item.id = `file:${repo.normRoot}:${rel}`;
    const dir = path.posix.dirname(rel);
    item.description = `${pct}%${dir !== '.' ? ' · ' + dir : ''}`;
    item.tooltip = new vscode.MarkdownString(
      `**${rel}**\n\n${pct}% reviewed · ${progress.reviewed}/${progress.total} new lines reviewed` +
        (repo.untracked.has(rel) ? '\n\n_untracked file_' : ''),
    );
    item.iconPath = vscode.ThemeIcon.File;
    item.resourceUri = vscode.Uri.file(repo.abs(rel));
    item.contextValue = 'antiVibeFile';
    item.command = { command: 'antiVibe.openFile', title: 'Open', arguments: [node] };
    return item;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
