import * as vscode from 'vscode';

const SECTION = 'antiVibe';

type Field =
  | { kind: 'signal'; key: string; label: string; hint: string; max: number; step: number; unit: 'sec' | 'hover' | 'edit' }
  | { kind: 'number'; key: string; label: string; hint: string; min: number; max: number; step: number; suffix: string; scale?: number }
  | { kind: 'color'; key: string; label: string }
  | { kind: 'bool'; key: string; label: string; hint: string };

const SIGNALS: Field[] = [
  { kind: 'signal', key: 'signals.viewport', label: 'Code on screen', hint: 'Lines visible in an open editor', max: 0.2, step: 0.005, unit: 'sec' },
  { kind: 'signal', key: 'signals.cursor', label: 'Cursor on line', hint: 'Line with the cursor (neighbours half)', max: 1, step: 0.01, unit: 'sec' },
  { kind: 'signal', key: 'signals.selection', label: 'Selecting code', hint: 'Every selected line', max: 1, step: 0.01, unit: 'sec' },
  { kind: 'signal', key: 'signals.hover', label: 'Hovering code', hint: 'Mouse resting over code', max: 0.5, step: 0.01, unit: 'hover' },
  { kind: 'signal', key: 'signals.typing', label: 'Typing yourself', hint: 'Small edits you make', max: 1, step: 0.01, unit: 'edit' },
];

const GENERAL: Field[] = [
  { kind: 'number', key: 'idleTimeoutSeconds', label: 'Idle timeout', hint: 'Stop counting after no activity', min: 5, max: 600, step: 5, suffix: 's' },
  { kind: 'number', key: 'reviewedThreshold', label: 'Reviewed at', hint: 'Score at which a line counts as reviewed', min: 5, max: 100, step: 5, suffix: '%', scale: 100 },
  { kind: 'color', key: 'colors.unseen', label: 'Unseen colour' },
  { kind: 'color', key: 'colors.seen', label: 'Reviewed colour' },
  { kind: 'bool', key: 'hideWhenFullyReviewed', label: 'Hide fully reviewed', hint: 'Remove the colour once a line is fully reviewed' },
];

const ALL_KEYS = [
  ...SIGNALS.flatMap((f) => [`${f.key}.enabled`, `${f.key}.weight`]),
  ...GENERAL.map((f) => f.key),
];

/** Collapsible "Settings" block in the sidebar to tune signal weights and colours. */
export class SettingsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private sub: vscode.Disposable;
  private pending = new Map<string, unknown>();
  private writeTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        this.postValues();
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => (this.view = undefined));
    view.onDidChangeVisibility(() => view.visible && this.postValues());
  }

  private values(): Record<string, unknown> {
    const c = vscode.workspace.getConfiguration(SECTION);
    const out: Record<string, unknown> = {};
    for (const k of ALL_KEYS) {
      out[k] = c.get(k);
    }
    return out;
  }

  private postValues(): void {
    void this.view?.webview.postMessage({ type: 'values', values: this.values() });
  }

  private onMessage(msg: { type: string; key?: string; value?: unknown }): void {
    switch (msg.type) {
      case 'ready':
        this.postValues();
        break;
      case 'set':
        if (msg.key && ALL_KEYS.includes(msg.key)) {
          this.pending.set(msg.key, msg.value);
          this.scheduleWrite();
        }
        break;
      case 'reset':
        void this.resetAll();
        break;
      case 'openJson':
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jem-id.anti-vibe-coder');
        break;
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => void this.flushWrites(), 300);
  }

  private async flushWrites(): Promise<void> {
    this.writeTimer = undefined;
    const c = vscode.workspace.getConfiguration(SECTION);
    const entries = [...this.pending];
    this.pending.clear();
    for (const [k, v] of entries) {
      await c.update(k, v, vscode.ConfigurationTarget.Global);
    }
  }

  private async resetAll(): Promise<void> {
    const c = vscode.workspace.getConfiguration(SECTION);
    for (const k of ALL_KEYS) {
      await c.update(k, undefined, vscode.ConfigurationTarget.Global);
      if (c.inspect(k)?.workspaceValue !== undefined) {
        await c.update(k, undefined, vscode.ConfigurationTarget.Workspace);
      }
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { padding: 4px 12px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 14px 0 6px; font-weight: 600; }
  .row { margin: 0 0 12px; }
  .head { display: flex; align-items: center; gap: 6px; }
  .head label { flex: 1; font-weight: 600; }
  .value { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); min-width: 4.5em; text-align: right; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 2px 0 4px; }
  input[type=range] { width: 100%; margin: 0; accent-color: var(--vscode-focusBorder); }
  input[type=range]:disabled { opacity: .4; }
  input[type=checkbox] { margin: 0; accent-color: var(--vscode-focusBorder); }
  .color { display: flex; align-items: center; gap: 8px; }
  .color input[type=color] { width: 32px; height: 22px; padding: 0; border: 1px solid var(--vscode-input-border, transparent); background: none; }
  .color input[type=range] { flex: 1; }
  .swatch { height: 6px; border-radius: 3px; margin-top: 4px; }
  .buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
  button { border: none; padding: 4px 10px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #gradient { height: 10px; border-radius: 5px; margin: 4px 0 2px; }
  .legend { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h3>How much each signal counts</h3>
  <div id="signals"></div>
  <h3>General</h3>
  <div id="general"></div>
  <div id="gradient"></div>
  <div class="legend"><span>unseen</span><span>reviewed</span></div>
  <div class="buttons">
    <button id="reset">Reset to defaults</button>
    <button id="json">Open in Settings</button>
  </div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const SIGNALS = ${JSON.stringify(SIGNALS)};
const GENERAL = ${JSON.stringify(GENERAL)};
let values = {};
const $ = (s, el = document) => el.querySelector(s);
const send = (key, value) => { values[key] = value; vscode.postMessage({ type: 'set', key, value }); };

function hintFor(f, w) {
  if (!w) return 'off';
  const n = Math.ceil(1 / w);
  if (f.unit === 'sec') return n >= 60 ? '≈ ' + (n / 60).toFixed(1).replace('.0', '') + ' min to reviewed' : '≈ ' + n + ' s to reviewed';
  return '≈ ' + n + ' ' + f.unit + (n === 1 ? '' : 's') + ' to reviewed';
}

function parse(c) {
  const m = /rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+))?\\s*\\)/i.exec(c || '');
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  const h = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec((c || '').trim());
  if (h) { const n = parseInt(h[1], 16); return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: h[2] ? parseInt(h[2], 16) / 255 : 1 }; }
  return { r: 128, g: 128, b: 128, a: .25 };
}
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const rgba = (c) => 'rgba(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ', ' + (+c.a.toFixed(2)) + ')';

function build() {
  const sig = $('#signals');
  for (const f of SIGNALS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<div class="head"><input type="checkbox" id="' + f.key + '-on"><label for="' + f.key + '-on">' + f.label + '</label><span class="value"></span></div>' +
      '<div class="hint">' + f.hint + ' · <span class="eta"></span></div>' +
      '<input type="range" min="0" max="' + f.max + '" step="' + f.step + '">';
    const on = $('input[type=checkbox]', row), range = $('input[type=range]', row);
    on.addEventListener('change', () => { send(f.key + '.enabled', on.checked); render(); });
    range.addEventListener('input', () => { send(f.key + '.weight', +range.value); render(); });
    row.dataset.key = f.key;
    sig.appendChild(row);
  }
  const gen = $('#general');
  for (const f of GENERAL) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.key = f.key;
    if (f.kind === 'number') {
      row.innerHTML = '<div class="head"><label>' + f.label + '</label><span class="value"></span></div><div class="hint">' + f.hint + '</div>' +
        '<input type="range" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '">';
      const range = $('input', row);
      range.addEventListener('input', () => { send(f.key, +range.value / (f.scale || 1)); render(); });
    } else if (f.kind === 'color') {
      row.innerHTML = '<div class="head"><label>' + f.label + '</label><span class="value"></span></div>' +
        '<div class="color"><input type="color"><input type="range" min="0.05" max="0.8" step="0.01" title="Opacity"></div><div class="swatch"></div>';
      const pick = $('input[type=color]', row), alpha = $('input[type=range]', row);
      const update = () => {
        const n = parseInt(pick.value.slice(1), 16);
        send(f.key, rgba({ r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: +alpha.value }));
        render();
      };
      pick.addEventListener('input', update);
      alpha.addEventListener('input', update);
    } else {
      row.innerHTML = '<div class="head"><input type="checkbox" id="' + f.key + '"><label for="' + f.key + '">' + f.label + '</label></div><div class="hint">' + f.hint + '</div>';
      const cb = $('input', row);
      cb.addEventListener('change', () => send(f.key, cb.checked));
    }
    gen.appendChild(row);
  }
  $('#reset').addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
  $('#json').addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
}

function render() {
  for (const f of SIGNALS) {
    const row = $('[data-key="' + f.key + '"]');
    const on = values[f.key + '.enabled'] !== false, w = +values[f.key + '.weight'] || 0;
    const cb = $('input[type=checkbox]', row), range = $('input[type=range]', row);
    if (document.activeElement !== range) range.value = w;
    cb.checked = on;
    range.disabled = !on;
    $('.value', row).textContent = on ? w.toFixed(3).replace(/0+$/, '').replace(/\\.$/, '') + (f.unit === 'sec' ? ' /s' : ' /' + f.unit) : 'off';
    $('.eta', row).textContent = hintFor(f, on ? w : 0);
  }
  for (const f of GENERAL) {
    const row = $('[data-key="' + f.key + '"]');
    const v = values[f.key];
    if (f.kind === 'number') {
      const range = $('input', row), shown = Math.round(+v * (f.scale || 1));
      if (document.activeElement !== range) range.value = shown;
      $('.value', row).textContent = shown + f.suffix;
    } else if (f.kind === 'color') {
      const c = parse(v), pick = $('input[type=color]', row), alpha = $('input[type=range]', row);
      if (document.activeElement !== pick) pick.value = hex(c);
      if (document.activeElement !== alpha) alpha.value = c.a;
      $('.value', row).textContent = Math.round(c.a * 100) + '%';
      $('.swatch', row).style.background = rgba(c);
    } else {
      $('input', row).checked = !!v;
    }
  }
  const a = parse(values['colors.unseen']), b = parse(values['colors.seen']);
  $('#gradient').style.background = 'linear-gradient(to right, ' + rgba({ ...a, a: Math.min(1, a.a * 2.5) }) + ', ' + rgba({ ...b, a: Math.min(1, b.a * 2.5) }) + ')';
}

window.addEventListener('message', (e) => {
  if (e.data.type === 'values') { values = e.data.values; render(); }
});
build();
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      void this.flushWrites();
    }
    this.sub.dispose();
  }
}
