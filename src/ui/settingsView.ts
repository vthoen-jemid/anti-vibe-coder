import * as vscode from 'vscode';
import { resetSettings, SECTION, SHAREABLE_KEYS } from '../settingsIO';

/**
 * Signals are shown as "how long / how often until a line is fully seen"
 * (the inverse of the stored weight), which is easier to reason about than a
 * score per second. `instant` signals react to the click itself at the top step.
 */
interface SignalField {
  key: string;
  label: string;
  hint: string;
  unit: 'sec' | 'hover' | 'edit';
  instant?: string;
  eta: string;
}

const SIGNALS: SignalField[] = [
  {
    key: 'signals.viewport',
    label: 'Code in view',
    hint: 'Lines inside the focus area of an open editor, while you are not scrolling.',
    unit: 'sec',
    eta: 'in the focus area',
  },
  {
    key: 'signals.cursor',
    label: 'Cursor on a line',
    hint: 'The line with the cursor. The 2 lines around it count half.',
    unit: 'sec',
    instant: 'the moment you click on it',
    eta: 'with the cursor on it',
  },
  {
    key: 'signals.selection',
    label: 'Selected lines',
    hint: 'Every line inside a selection.',
    unit: 'sec',
    instant: 'the moment you select it',
    eta: 'selected',
  },
  {
    key: 'signals.hover',
    label: 'Mouse hover',
    hint: 'The mouse resting on a line (after the editor hover delay).',
    unit: 'hover',
    eta: '',
  },
  {
    key: 'signals.typing',
    label: 'Typed by you',
    hint: 'Small edits you make by hand. Pastes and AI edits never count.',
    unit: 'edit',
    eta: '',
  },
];

/** Slider steps: amount of time / events until a line is fully seen. */
const SEC_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 90, 120, 150, 180, 240, 300, 450, 600];
const COUNT_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100];

/** Collapsible "Settings" block in the sidebar to tune signals, thresholds and colours. */
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
    for (const k of SHAREABLE_KEYS) {
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
        if (msg.key && (SHAREABLE_KEYS as readonly string[]).includes(msg.key)) {
          this.pending.set(msg.key, msg.value);
          this.scheduleWrite();
        }
        break;
      case 'reset':
        void resetSettings();
        break;
      case 'export':
        void this.flushWrites().then(() => vscode.commands.executeCommand('antiVibe.exportSettings'));
        break;
      case 'import':
        void vscode.commands.executeCommand('antiVibe.importSettings');
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
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = undefined;
    const c = vscode.workspace.getConfiguration(SECTION);
    const entries = [...this.pending];
    this.pending.clear();
    for (const [k, v] of entries) {
      await c.update(k, v, vscode.ConfigurationTarget.Global);
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
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 16px 0 2px; font-weight: 600; }
  .intro { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0 0 10px; }
  .row { margin: 0 0 14px; }
  .head { display: flex; align-items: center; gap: 6px; }
  .head label { flex: 1; font-weight: 600; }
  .value { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); text-align: right; white-space: nowrap; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 2px 0 4px; }
  .eta { font-size: 11px; margin: 2px 0 0; }
  .eta.off { color: var(--vscode-descriptionForeground); }
  input[type=range] { width: 100%; margin: 0; accent-color: var(--vscode-focusBorder); }
  input[type=range]:disabled { opacity: .4; }
  input[type=checkbox] { margin: 0; accent-color: var(--vscode-focusBorder); }
  input[type=number] { width: 4.5em; padding: 1px 4px; text-align: right; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; font-variant-numeric: tabular-nums; }
  input[type=number]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input[type=number]:disabled { opacity: .4; }
  .ends { display: flex; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
  .sub { margin: 8px 0 0 18px; }
  .focus { display: flex; gap: 8px; align-items: center; }
  .focus input[type=range] { flex: 1; }
  .screen { width: 14px; height: 28px; border: 1px solid var(--vscode-descriptionForeground); border-radius: 2px; position: relative; flex: none; opacity: .8; }
  .screen .band { position: absolute; left: 0; right: 0; background: var(--vscode-focusBorder); }
  .color { display: flex; align-items: center; gap: 8px; }
  .color input[type=color] { width: 32px; height: 22px; padding: 0; border: 1px solid var(--vscode-input-border, transparent); background: none; }
  .color input[type=range] { flex: 1; }
  .swatch { height: 6px; border-radius: 3px; margin-top: 4px; }
  .scale { position: relative; margin: 6px 0 22px; }
  #gradient { height: 10px; border-radius: 5px; }
  .mark { position: absolute; top: -2px; width: 2px; height: 14px; background: var(--vscode-foreground); transform: translateX(-1px); }
  .mark span { position: absolute; top: 15px; font-size: 10px; white-space: nowrap; color: var(--vscode-descriptionForeground); transform: translateX(-50%); }
  .buttons { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 16px; }
  button { border: none; padding: 4px 10px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <h3>What counts as seeing code</h3>
  <p class="intro">Drag right to make a signal count faster. The number is how long (or how often) it takes for a line to become fully seen.</p>
  <div id="signals"></div>

  <h3>When is code seen</h3>
  <div class="row" data-key="reviewedThreshold">
    <div class="head"><label for="thr-full">Fully seen at</label><span class="value"></span></div>
    <div class="hint">A line gets the full seen colour and is skipped by “Next Unreviewed” once it reaches this progress.</div>
    <input type="range" id="thr-full" min="5" max="100" step="1">
  </div>
  <div class="row" data-key="partiallySeenThreshold">
    <div class="head"><label for="thr-part">Partially seen at</label><span class="value"></span></div>
    <div class="hint">A file moves from Unseen to Partially seen once its new lines reach this average progress.</div>
    <input type="range" id="thr-part" min="1" max="100" step="1">
  </div>
  <div class="scale">
    <div id="gradient"></div>
    <div class="mark" id="mark-part"><span></span></div>
    <div class="mark" id="mark-full"><span></span></div>
  </div>

  <h3>General</h3>
  <div class="row" data-key="idleTimeoutSeconds">
    <div class="head"><label for="idle">Pause after inactivity</label><span class="value"></span></div>
    <div class="hint">Stop counting when you have not touched VS Code for this long.</div>
    <input type="range" id="idle" min="5" max="600" step="5">
  </div>
  <div class="row" data-color="colors.unseen">
    <div class="head"><label>Unseen colour</label><span class="value"></span></div>
    <div class="color"><input type="color" title="Colour"><input type="range" min="0.05" max="0.8" step="0.01" title="Opacity"></div>
    <div class="swatch"></div>
  </div>
  <div class="row" data-color="colors.seen">
    <div class="head"><label>Seen colour</label><span class="value"></span></div>
    <div class="color"><input type="color" title="Colour"><input type="range" min="0.05" max="0.8" step="0.01" title="Opacity"></div>
    <div class="swatch"></div>
  </div>
  <div class="row">
    <div class="head"><input type="checkbox" id="hide"><label for="hide">Hide colour on fully seen lines</label></div>
  </div>

  <div class="buttons">
    <button id="export" class="primary" title="Save these settings to a JSON file you can share">Export…</button>
    <button id="import" title="Load settings from a JSON file">Import…</button>
    <button id="reset">Reset to defaults</button>
    <button id="json">Open in Settings</button>
  </div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const SIGNALS = ${JSON.stringify(SIGNALS)};
const STEPS = { sec: ${JSON.stringify(SEC_STEPS)}, hover: ${JSON.stringify(COUNT_STEPS)}, edit: ${JSON.stringify(COUNT_STEPS)} };
const UNIT = { sec: 's', hover: 'hovers', edit: 'edits' };
let values = {};
const $ = (s, el = document) => el.querySelector(s);
const send = (key, value) => { values[key] = value; vscode.postMessage({ type: 'set', key, value }); };
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

/** weight (score per unit) -> amount until fully seen */
const amountOf = (w) => (w > 0 ? Math.max(1, 1 / w) : Infinity);
const weightOf = (n) => +(1 / Math.max(1, n)).toFixed(6);
const round = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
function nearestStep(steps, n) {
  let best = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(Math.log(steps[i] / n)) < Math.abs(Math.log(steps[best] / n))) best = i;
  }
  return best;
}
function duration(s) {
  if (s < 60) return round(s) + ' s';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? m + ' min ' + r + ' s' : m + ' min';
}
function etaText(f, n) {
  if (f.instant && n <= 1) return 'Fully seen ' + f.instant + '.';
  if (f.unit === 'sec') return 'Fully seen after ' + duration(n) + ' ' + f.eta + '.';
  const r = Math.ceil(n - 1e-9);
  return 'Fully seen after ' + plural(r, f.unit === 'hover' ? 'hover' : 'small edit') + '.';
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
    const steps = STEPS[f.unit];
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.key = f.key;
    row.innerHTML =
      '<div class="head"><input type="checkbox" id="' + f.key + '-on"><label for="' + f.key + '-on">' + f.label + '</label>' +
      '<span class="value"><input type="number" min="1" step="any" title="Exact amount until fully seen"> ' + UNIT[f.unit] + '</span></div>' +
      '<div class="hint">' + f.hint + '</div>' +
      '<input type="range" class="speed" min="0" max="' + (steps.length - 1) + '" step="1">' +
      '<div class="ends"><span>slower</span><span>' + (f.instant ? 'instant' : 'faster') + '</span></div>' +
      '<div class="eta"></div>' +
      (f.key === 'signals.viewport'
        ? '<div class="sub" data-focus><div class="head"><label for="focus-area">Focus area</label><span class="value"></span></div>' +
          '<div class="hint">Only this middle part of the editor counts, where you are actually reading. Near the top or bottom of a file the area moves along to the edge.</div>' +
          '<div class="focus"><div class="screen"><div class="band"></div></div><input type="range" id="focus-area" min="5" max="100" step="5"></div></div>'
        : '');
    const on = $('input[type=checkbox]', row), range = $('input.speed', row), num = $('input[type=number]', row);
    on.addEventListener('change', () => { send(f.key + '.enabled', on.checked); render(); });
    // Slider is reversed: right = fewer seconds/events = faster.
    range.addEventListener('input', () => { send(f.key + '.weight', weightOf(steps[steps.length - 1 - +range.value])); render(); });
    num.addEventListener('change', () => {
      const n = +num.value;
      if (n >= 1 && isFinite(n)) send(f.key + '.weight', weightOf(n));
      render();
    });
    const focus = $('#focus-area', row);
    if (focus) focus.addEventListener('input', () => { send('signals.viewport.focusArea', +focus.value / 100); render(); });
    sig.appendChild(row);
  }

  const pct = (id, key) => { const r = $(id); r.addEventListener('input', () => { send(key, +r.value / 100); render(); }); };
  pct('#thr-full', 'reviewedThreshold');
  pct('#thr-part', 'partiallySeenThreshold');
  const idle = $('#idle');
  idle.addEventListener('input', () => { send('idleTimeoutSeconds', +idle.value); render(); });

  for (const row of document.querySelectorAll('[data-color]')) {
    const key = row.dataset.color, pick = $('input[type=color]', row), alpha = $('input[type=range]', row);
    const update = () => {
      const n = parseInt(pick.value.slice(1), 16);
      send(key, rgba({ r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: +alpha.value }));
      render();
    };
    pick.addEventListener('input', update);
    alpha.addEventListener('input', update);
  }
  const hide = $('#hide');
  hide.addEventListener('change', () => send('hideWhenFullyReviewed', hide.checked));

  for (const id of ['export', 'import', 'reset', 'json']) {
    $('#' + id).addEventListener('click', () => vscode.postMessage({ type: id === 'json' ? 'openJson' : id }));
  }
}

const setIfIdle = (el, v) => { if (document.activeElement !== el) el.value = v; };

function render() {
  for (const f of SIGNALS) {
    const steps = STEPS[f.unit];
    const row = $('[data-key="' + f.key + '"]');
    const on = values[f.key + '.enabled'] !== false, n = amountOf(+values[f.key + '.weight'] || 0);
    const cb = $('input[type=checkbox]', row), range = $('input.speed', row), num = $('input[type=number]', row);
    cb.checked = on;
    range.disabled = num.disabled = !on;
    if (isFinite(n)) {
      setIfIdle(range, steps.length - 1 - nearestStep(steps, n));
      setIfIdle(num, round(n));
    }
    const eta = $('.eta', row);
    eta.textContent = !on ? 'Off: this signal does not count.' : isFinite(n) ? etaText(f, n) : 'Counts for nothing.';
    eta.classList.toggle('off', !on);
    const focus = $('[data-focus]', row);
    if (focus) {
      const a = Math.round((+values['signals.viewport.focusArea'] || 1) * 100);
      setIfIdle($('#focus-area', focus), a);
      $('.value', focus).textContent = a >= 100 ? 'whole screen' : 'middle ' + a + '%';
      const band = $('.band', focus);
      band.style.top = (100 - a) / 2 + '%';
      band.style.height = a + '%';
      focus.style.opacity = on ? '' : '.4';
    }
  }

  const full = Math.round((+values.reviewedThreshold || 0) * 100);
  const part = Math.round((+values.partiallySeenThreshold || 0) * 100);
  setIfIdle($('#thr-full'), full);
  setIfIdle($('#thr-part'), part);
  $('[data-key="reviewedThreshold"] .value').textContent = full + '%';
  $('[data-key="partiallySeenThreshold"] .value').textContent = part + '%';

  const idle = +values.idleTimeoutSeconds || 0;
  setIfIdle($('#idle'), idle);
  $('[data-key="idleTimeoutSeconds"] .value').textContent = duration(idle);

  for (const row of document.querySelectorAll('[data-color]')) {
    const c = parse(values[row.dataset.color]), pick = $('input[type=color]', row), alpha = $('input[type=range]', row);
    setIfIdle(pick, hex(c));
    setIfIdle(alpha, c.a);
    $('.value', row).textContent = Math.round(c.a * 100) + '% opacity';
    $('.swatch', row).style.background = rgba(c);
  }
  $('#hide').checked = !!values.hideWhenFullyReviewed;

  // Line colour scale: unseen -> seen, reaching the seen colour at "fully seen".
  const a = parse(values['colors.unseen']), b = parse(values['colors.seen']);
  const strong = (c) => rgba({ ...c, a: Math.min(1, c.a * 2.5) });
  $('#gradient').style.background = 'linear-gradient(to right, ' + strong(a) + ' 0%, ' + strong(b) + ' ' + full + '%, ' + strong(b) + ' 100%)';
  const mark = (id, p, text) => { const m = $(id); m.style.left = p + '%'; $('span', m).textContent = text; };
  mark('#mark-part', part, 'partially ' + part + '%');
  mark('#mark-full', full, 'fully ' + full + '%');
  $('#mark-part span').style.transform = 'translateX(' + (part < 15 ? '0' : '-50%') + ')';
  $('#mark-full span').style.transform = 'translateX(' + (full > 85 ? '-100%' : '-50%') + ')';
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
      void this.flushWrites();
    }
    this.sub.dispose();
  }
}
