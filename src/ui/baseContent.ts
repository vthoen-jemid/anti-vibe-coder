import * as vscode from 'vscode';
import { Tracker } from '../tracker';
import { normalizePath, Repo } from '../git/repo';

export const BASE_SCHEME = 'antivibe-base';

/** Serves file content at the merge-base, for diff editors. */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly tracker: Tracker) {}

  static uriFor(repo: Repo, rel: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: BASE_SCHEME,
      path: '/' + rel,
      query: new URLSearchParams({ root: repo.root, ref: repo.mergeBase }).toString(),
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const root = q.get('root') ?? '';
    const ref = q.get('ref') ?? '';
    const repo = this.tracker.allRepos().find((r) => r.normRoot === normalizePath(root));
    if (!repo) {
      return '';
    }
    return (await repo.showAt(ref, uri.path.replace(/^\//, ''))) ?? '';
  }
}
