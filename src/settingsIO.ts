import * as vscode from 'vscode';

export const SECTION = 'antiVibe';

/**
 * Every setting that is shared by export/import and "Reset to defaults".
 * `baseBranch` is left out on purpose: it belongs to one repository, not to a
 * personal review style.
 */
export const SHAREABLE_KEYS = [
  'signals.viewport.enabled',
  'signals.viewport.weight',
  'signals.viewport.focusArea',
  'signals.cursor.enabled',
  'signals.cursor.weight',
  'signals.selection.enabled',
  'signals.selection.weight',
  'signals.hover.enabled',
  'signals.hover.weight',
  'signals.typing.enabled',
  'signals.typing.weight',
  'signals.typing.maxChars',
  'idleTimeoutSeconds',
  'reviewedThreshold',
  'partiallySeenThreshold',
  'colors.unseen',
  'colors.seen',
  'hideWhenFullyReviewed',
  'ignoreWhitespaceOnlyLines',
] as const;

/**
 * The exported file uses full setting ids ("antiVibe.signals.cursor.weight"),
 * so its contents can also be pasted straight into a settings.json.
 */
export function currentSettings(): Record<string, unknown> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const out: Record<string, unknown> = {};
  for (const k of SHAREABLE_KEYS) {
    out[`${SECTION}.${k}`] = c.get(k);
  }
  return out;
}

export async function exportSettings(): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    title: 'Export Anti-Vibe Coder settings',
    defaultUri: defaultUri('anti-vibe-settings.json'),
    filters: { JSON: ['json'] },
  });
  if (!target) {
    return;
  }
  const json = JSON.stringify(currentSettings(), null, 2) + '\n';
  await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
  const open = await vscode.window.showInformationMessage(`Anti-Vibe Coder settings exported to ${target.fsPath}.`, 'Open File');
  if (open) {
    await vscode.window.showTextDocument(target);
  }
}

export async function importSettings(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import Anti-Vibe Coder settings',
    defaultUri: defaultUri(),
    canSelectMany: false,
    filters: { JSON: ['json'] },
  });
  if (!picked?.[0]) {
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(`Anti-Vibe Coder: could not read ${picked[0].fsPath}: ${(err as Error).message}`);
    return;
  }
  const { values, skipped } = parseSettings(data);
  const keys = Object.keys(values);
  if (keys.length === 0) {
    vscode.window.showErrorMessage('Anti-Vibe Coder: the file contains no Anti-Vibe Coder settings.');
    return;
  }
  const c = vscode.workspace.getConfiguration(SECTION);
  for (const k of keys) {
    await c.update(k, values[k], vscode.ConfigurationTarget.Global);
  }
  const note = skipped.length ? ` Skipped ${skipped.length} unknown or invalid: ${skipped.join(', ')}.` : '';
  vscode.window.showInformationMessage(`Anti-Vibe Coder: imported ${keys.length} settings.${note}`);
}

/**
 * Accepts `{ "antiVibe.x": v }`, `{ "x": v }` or `{ "antiVibe": { "x": v } }`.
 * Values whose type differs from the setting's default are skipped.
 */
function parseSettings(data: unknown): { values: Record<string, unknown>; skipped: string[] } {
  const values: Record<string, unknown> = {};
  const skipped: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { values, skipped };
  }
  let obj = data as Record<string, unknown>;
  const nested = obj[SECTION];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    obj = nested as Record<string, unknown>;
  }
  const c = vscode.workspace.getConfiguration(SECTION);
  const known = new Set<string>(SHAREABLE_KEYS);
  for (const [rawKey, v] of Object.entries(obj)) {
    const key = rawKey.startsWith(`${SECTION}.`) ? rawKey.slice(SECTION.length + 1) : rawKey;
    if (!known.has(key) || typeof v !== typeof c.inspect(key)?.defaultValue) {
      skipped.push(rawKey);
      continue;
    }
    values[key] = v;
  }
  return { values, skipped };
}

export async function resetSettings(): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  for (const k of SHAREABLE_KEYS) {
    await c.update(k, undefined, vscode.ConfigurationTarget.Global);
    if (c.inspect(k)?.workspaceValue !== undefined) {
      await c.update(k, undefined, vscode.ConfigurationTarget.Workspace);
    }
  }
}

function defaultUri(file?: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder && file ? vscode.Uri.joinPath(folder, file) : folder;
}
