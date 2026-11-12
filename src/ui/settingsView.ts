import * as path from 'path';
import * as vscode from 'vscode';
import { resetSettings, SECTION, SHAREABLE_KEYS } from '../settingsIO';
import { Tracker } from '../tracker';

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
    label: 'Reading (code on screen)',
    hint: 'Lines inside the reading area of the editor (see below), while you are not scrolling.',
    unit: 'sec',
    eta: 'in the reading area',
  },
  {
    key: 'signals.cursor',
    label: 'Cursor on a line',
    hint: 'The line with the text cursor. The 2 lines around it count for half.',
    unit: 'sec',
    instant: 'the moment you click on it',
    eta: 'with the cursor on it',
  },
  {
    key: 'signals.selection',
    label: 'Selecting lines',
    hint: 'Every line inside a selection (mouse, Shift+arrows, Ctrl+A/L/D, ...).',
    unit: 'sec',
    instant: 'the moment you select it',
    eta: 'selected',
  },
  {
    key: 'signals.hover',
    label: 'Hovering with the mouse',
    hint: 'The mouse resting on code. VS Code only reports this after its hover delay (editor.hover.delay, 300 ms by default) and only while editor.hover.enabled is on.',
    unit: 'hover',
    instant: 'the moment the mouse rests on it',
    eta: '',
  },
  {
    key: 'signals.typing',
    label: 'Typing it yourself',
    hint: 'Small edits you make by hand. Pastes and AI edits never count.',
    unit: 'edit',
    eta: '',
  },
];

/** Builds a dense list of slider steps: [from, to, step] segments. */
function steps(segments: [number, number, number][]): number[] {
  const out: number[] = [];
  for (const [from, to, step] of segments) {
    for (let v = from; v < to - 1e-9; v += step) {
      out.push(Math.round(v * 10) / 10);
    }
  }
  out.push(segments[segments.length - 1][1]);
  return out;
}

/** Slider steps: amount of time / events until a line is fully seen (index 0 = fastest). */
const SEC_STEPS = steps([[1, 10, 0.5], [10, 30, 1], [30, 60, 2], [60, 120, 5], [120, 300, 10], [300, 600, 30], [600, 1200, 60]]);
const COUNT_STEPS = steps([[1, 20, 1], [20, 50, 2], [50, 100, 5]]);

/** Collapsible "Settings" block in the sidebar to tune signals, thresholds and colours. */
export class SettingsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private subs: vscode.Disposable[];
  private pending = new Map<string, unknown>();
  private writeTimer: NodeJS.Timeout | undefined;
  private lastRepos = '';

  constructor(private readonly tracker: Tracker) {
    this.subs = [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
          this.postValues();
        }
      }),
      tracker.onDidChange(() => this.postRepos()),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => (this.view = undefined));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postValues();
        this.postRepos(true);
      }
    });
  }

  /** Per repo: current branch and what it is compared against. Only sent when it changed. */
  private postRepos(force = false): void {
    if (!this.view) {
      return;
    }
    const repos = this.tracker.allRepos().map((r) => {
      const base = this.tracker.baseFor(r);
      return {
        id: r.normRoot,
        name: path.basename(r.root),
        branch: r.branch,
        baseRef: r.baseRef,
        own: base.source === 'branch' ? base.ref : '',
        fallback: this.tracker.config.baseBranch,
        error: r.error,
      };
    });
    const json = JSON.stringify(repos);
    if (force || json !== this.lastRepos) {
      this.lastRepos = json;
      void this.view.webview.postMessage({ type: 'repos', repos });
    }
  }

  private async setBase(id: string, value: string): Promise<void> {
    const repo = this.tracker.allRepos().find((r) => r.normRoot === id);
    if (!repo) {
      return;
    }
    value = value.trim();
    if (value && !(await repo.refExists(value))) {
      void this.view?.webview.postMessage({ type: 'baseError', id, message: `"${value}" is not a branch, tag or commit in this repository.` });
      return;
    }
    await this.tracker.setBranchBase(repo, value);
    this.postRepos(true);
  }

  private async postBranches(id: string): Promise<void> {
    const repo = this.tracker.allRepos().find((r) => r.normRoot === id);
    if (repo) {
      void this.view?.webview.postMessage({ type: 'branches', id, list: await repo.listBranches() });
    }
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

  private onMessage(msg: { type: string; key?: string; value?: unknown; id?: string }): void {
    switch (msg.type) {
      case 'ready':
        this.postValues();
        this.postRepos(true);
        break;
      case 'setBase':
        if (msg.id) {
          void this.setBase(msg.id, String(msg.value ?? ''));
        }
        break;
      case 'branches':
        if (msg.id) {
          void this.postBranches(msg.id);
        }
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
  .eta, .area-text { font-size: 11px; margin: 2px 0 0; }
  .area-text { margin: 0 0 4px; }
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
  .base { display: flex; gap: 6px; margin-top: 4px; }
  .base input { flex: 1; min-width: 0; padding: 2px 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; }
  .base input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .base input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  .base button:disabled { opacity: .4; cursor: default; }
  .base-msg { font-size: 11px; margin: 3px 0 0; }
  .base-msg.err { color: var(--vscode-errorForeground); }
  .buttons { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 16px; }
  button { border: none; padding: 4px 10px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <h3>Compare against</h3>
  <p class="intro">The branch your work will be merged into. Only changes since that branch count as new. Remembered per branch, so a branch stacked on another branch can compare against that one instead of main.</p>
  <div id="repos"></div>

  <h3>How code becomes seen</h3>
  <p class="intro">Every new line has a progress from 0% to 100%. Each signal below adds progress. The number is how long (or how many times) one signal alone needs to make a line fully seen. Slide right for less, type in the box for an exact value, or use the arrow keys on a slider for small steps.</p>
  <div id="signals"></div>

  <h3>Seen levels</h3>
  <p class="intro">Where the line between unseen, partially seen and fully seen lies.</p>
  <div class="row" data-key="partiallySeenThreshold">
    <div class="head"><label for="thr-part">Partially seen from</label><span class="value"><input type="number" min="0" max="100" step="1" data-for="thr-part"> %</span></div>
    <div class="hint">A file moves from <b>Unseen</b> to <b>Partially seen</b> in the overview once its new lines reach this average progress.</div>
    <input type="range" id="thr-part" min="0" max="100" step="1">
  </div>
  <div class="row" data-key="reviewedThreshold">
    <div class="head"><label for="thr-full">Fully seen from</label><span class="value"><input type="number" min="5" max="100" step="1" data-for="thr-full"> %</span></div>
    <div class="hint">A line with this much progress gets the full seen colour and is skipped by “Next Unreviewed”. A file is <b>Fully seen</b> when all its new lines are.</div>
    <input type="range" id="thr-full" min="5" max="100" step="1">
  </div>
  <div class="scale">
    <div id="gradient"></div>
    <div class="mark" id="mark-part"><span></span></div>
    <div class="mark" id="mark-full"><span></span></div>
  </div>

  <h3>General</h3>
  <div class="row" data-key="idleTimeoutSeconds">
    <div class="head"><label for="idle">Pause after no activity for</label><span class="value"><input type="number" min="5" max="3600" step="1" data-for="idle"> s</span></div>
    <div class="hint">Reading time stops counting when you have not touched VS Code for this long.</div>
    <input type="range" id="idle" min="5" max="600" step="1">
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
      '<div class="ends"><span>needs more</span><span>' + (f.instant ? 'instant' : 'needs less') + '</span></div>' +
      '<div class="eta"></div>' +
      (f.key === 'signals.viewport'
        ? '<div class="sub" data-focus><div class="head"><label for="focus-area">Reading area</label><span class="value"><input type="number" min="5" max="100" step="1" data-for="focus-area"> %</span></div>' +
          '<div class="hint">Only this band in the middle of the editor counts, not the whole screen. Near the top or bottom of a file the band moves along to the edge. In a file that fits on screen it follows your cursor. 100% = the whole screen.</div>' +
          '<div class="area-text"></div>' +
          '<div class="focus"><div class="screen"><div class="band"></div></div><input type="range" id="focus-area" min="5" max="100" step="1"></div></div>'
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
    sig.appendChild(row);
  }

  // Sliders with an exact number box next to them. Both call the same setter.
  const setters = {
    'focus-area': (v) => send('signals.viewport.focusArea', v / 100),
    'thr-part': (v) => {
      send('partiallySeenThreshold', v / 100);
      if (v / 100 > (+values.reviewedThreshold || 0)) send('reviewedThreshold', Math.max(5, v) / 100);
    },
    'thr-full': (v) => {
      send('reviewedThreshold', v / 100);
      if (v / 100 < (+values.partiallySeenThreshold || 0)) send('partiallySeenThreshold', v / 100);
    },
    'idle': (v) => send('idleTimeoutSeconds', v),
  };
  for (const [id, set] of Object.entries(setters)) {
    const r = $('#' + id), num = $('input[data-for="' + id + '"]');
    r.addEventListener('input', () => { set(+r.value); render(); });
    num.addEventListener('change', () => {
      const v = +num.value;
      if (num.value !== '' && isFinite(v)) set(Math.min(+num.max, Math.max(+num.min, v)));
      render();
    });
  }

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
      setIfIdle($('input[data-for="focus-area"]'), a);
      $('.area-text', focus).textContent = a >= 100
        ? 'Now: everything on screen counts.'
        : 'Now: the middle ' + a + '% of the screen (about ' + Math.max(1, Math.round(a / 2)) + ' of 50 visible lines).';
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
  setIfIdle($('input[data-for="thr-full"]'), full);
  setIfIdle($('input[data-for="thr-part"]'), part);

  const idle = +values.idleTimeoutSeconds || 0;
  setIfIdle($('#idle'), idle);
  setIfIdle($('input[data-for="idle"]'), idle);

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

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ESC[c]);
const loadedBranches = new Set();
const repoRow = (id) => [...$('#repos').children].find((el) => el.dataset.id === id);
function renderRepos(repos) {
  const box = $('#repos');
  for (const el of [...box.children]) if (!repos.some((r) => r.id === el.dataset.id)) el.remove();
  $('#no-repo') && $('#no-repo').remove();
  if (!repos.length) { box.innerHTML = '<p class="hint" id="no-repo">No git repository in this workspace.</p>'; return; }
  repos.forEach((r, i) => {
    let row = repoRow(r.id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'row';
      row.dataset.id = r.id;
      row.innerHTML = '<div class="head"><label for="base-' + i + '"></label></div>' +
        '<div class="base"><input id="base-' + i + '" list="dl-' + i + '" spellcheck="false" autocomplete="off"><button title="Forget the choice for this branch">Default</button></div>' +
        '<datalist id="dl-' + i + '"></datalist><div class="base-msg"></div>';
      const input = $('input', row);
      // Branch suggestions are only fetched when you actually open the field.
      input.addEventListener('focus', () => {
        if (!loadedBranches.has(r.id)) { loadedBranches.add(r.id); vscode.postMessage({ type: 'branches', id: r.id }); }
      });
      input.addEventListener('change', () => vscode.postMessage({ type: 'setBase', id: r.id, value: input.value }));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.value = row.dataset.own; input.classList.remove('invalid'); input.blur(); }
      });
      $('button', row).addEventListener('click', () => { input.value = ''; vscode.postMessage({ type: 'setBase', id: r.id, value: '' }); });
      box.appendChild(row);
    }
    row.dataset.own = r.own;
    $('label', row).innerHTML = (repos.length > 1 ? esc(r.name) + ': ' : '') + 'Compare <b>' + esc(r.branch || '…') + '</b> against';
    const input = $('input', row);
    input.placeholder = r.fallback ? r.fallback + ' (setting)' : 'auto-detect' + (r.baseRef && !r.own ? ': ' + r.baseRef : '');
    setIfIdle(input, r.own);
    input.classList.remove('invalid');
    $('button', row).disabled = !r.own;
    const msg = $('.base-msg', row);
    msg.classList.toggle('err', !!r.error);
    msg.textContent = r.error ? r.error
      : r.own ? 'Now: ' + r.branch + ' ↔ ' + r.baseRef + ', only for this branch.'
      : r.baseRef ? 'Now: ' + r.branch + ' ↔ ' + r.baseRef + '. Type a branch to use another one for ' + r.branch + '.' : '';
  });
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (d.type === 'values') { values = d.values; render(); }
  else if (d.type === 'repos') renderRepos(d.repos);
  else if (d.type === 'branches') {
    const row = repoRow(d.id);
    if (row) $('datalist', row).innerHTML = d.list.map((b) => '<option value="' + esc(b) + '">').join('');
  } else if (d.type === 'baseError') {
    const row = repoRow(d.id);
    if (row) { $('input', row).classList.add('invalid'); const m = $('.base-msg', row); m.classList.add('err'); m.textContent = d.message; }
  }
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
    for (const sub of this.subs) {
      sub.dispose();
    }
  }
}
