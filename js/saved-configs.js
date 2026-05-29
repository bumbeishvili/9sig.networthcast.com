// Saved strategy configurations.
//
// A "saved config" is a frozen snapshot of one base strategy's knobs (9sig /
// SMA / Buy & Hold / Invested Compounded). It renders as its own independent
// chart line + a pill in the Parameters panel, with the SAME signature as the
// top legend pills (eye toggle, color dot, name, CAGR/DD) plus per-pill save +
// delete. Editing reuses the existing shared sidebar: opening a config loads
// its numbers into the live controls; saving writes the current controls back.
//
// Only the strategy-specific knobs are frozen — initial investment, monthly
// contribution and the entry/exit date range stay global and apply to every
// pill (including saved ones).

const LS_SAVED_KEY = '9sig-saved-configs';

// Strategy-knob control IDs per type. These are the values captured into a
// saved config; everything else (initial / monthly / dates) stays global.
const CONFIG_PARAM_IDS = {
  '9sig': ['select-9sig-underlying', 'select-9sig-growth', 'select-9sig-crashdrop',
           'select-9sig-crashwin', 'select-9sig-spike', 'select-9sig-period',
           'select-9sig-cash', 'select-9sig-cashrate', 'select-9sig-buypower',
           'select-9sig-deploy', 'select-9sig-target-compound'],
  'sma':  ['select-sma-asset', 'select-sma-window', 'select-sma-underlying',
           'select-sma-cashrate', 'select-sma-entry-buf', 'select-sma-exit-buf',
           'select-sma-rsi-oh', 'select-sma-rsi-cool',
           'select-sma-out-asset', 'select-sma-dca-in', 'select-sma-dca-to-out',
           'select-sma-bg-delev', 'select-sma-bg-gtfo'],
  'bh':   ['select-bh-underlying'],
  'invested': ['slider-rate'],
};

// Distinct-ish palette for config lines. Picked to avoid clashing too hard
// with the fixed base-strategy hues.
const CONFIG_COLORS = ['#e879f9', '#f59e0b', '#34d399', '#fb7185', '#60a5fa',
                       '#c084fc', '#f97316', '#2dd4bf', '#a78bfa', '#f43f5e',
                       '#84cc16', '#38bdf8'];

let savedConfigs = [];
// Which saved strategy (if any) is currently loaded into the shared sidebar for
// editing. When set, edits auto-save to it and the panel shows no save button
// (saved strategies can't be forked); when null, the sidebar edits the main/base
// strategy. Exposed on window so chart.js can clear it when a base panel opens.
window._editingConfigId = null;

(function loadSavedConfigs() {
  try {
    const raw = localStorage.getItem(LS_SAVED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) savedConfigs = arr.filter(c => c && c.type && CONFIG_PARAM_IDS[c.type]);
    }
  } catch (e) {}
})();

function persistSavedConfigs() {
  // Configs loaded from a share-link arrive as `_transient`: they render on
  // the chart so the recipient can see them, but they're NOT written to
  // localStorage until the user explicitly clicks "Save" on the banner. So
  // every persist filters transient entries out — only saved-for-real configs
  // end up in localStorage.
  const persistable = savedConfigs.filter(c => !c._transient);
  try { localStorage.setItem(LS_SAVED_KEY, JSON.stringify(persistable)); } catch (e) {}
}
function getSavedConfigs() { return savedConfigs; }

// --- per-line color (base strategies + saved strategies) ----------------
// Saved strategies store their colour on the config (cfg.color). Base
// strategies are canonical, so their colour override is SESSION-ONLY — it's
// kept in memory but never persisted, so a refresh restores the default hue.
const DEFAULT_BASE_COLORS = { '9sig': '#22d3ee', 'bh': '#f87171', 'invested': '#e2e8f0', 'sma': '#a3e635' };
const BASE_COLOR_DATASET_IDX = { '9sig': 0, 'bh': 2, 'invested': 7, 'sma': 8 };
window._lineColorOverrides = {};
function getBaseColor(type) {
  const ov = window._lineColorOverrides || {};
  return ov[type] || DEFAULT_BASE_COLORS[type] || '#94a3b8';
}
function setBaseColor(type, color) {
  window._lineColorOverrides = window._lineColorOverrides || {};
  window._lineColorOverrides[type] = color;
}
// Apply any base-strategy colour overrides to their datasets. Called from
// render() — only touches the main line of each base strategy.
function applyBaseColorOverrides(chart) {
  if (!chart || !chart.data) return;
  const ov = window._lineColorOverrides || {};
  for (const [type, idx] of Object.entries(BASE_COLOR_DATASET_IDX)) {
    if (ov[type] && chart.data.datasets[idx]) chart.data.datasets[idx].borderColor = ov[type];
  }
}
// 9sig's supporting lines (Holding / Target / Cash) share the 9sig line colour
// and are told apart only by stroke width + dash pattern (dotted vs long-dash
// vs dash-dot). Called from render() so it tracks the current 9sig colour.
function applyNineSigFamily(chart) {
  if (!chart || !chart.data) return;
  const color = getBaseColor('9sig'); // datasets 1/5/6 are ALWAYS the main 9sig's
  const ds = chart.data.datasets;
  if (ds[0]) ds[0].borderColor = color;                                                          // 9sig (solid, thick)
  if (ds[1]) { ds[1].borderColor = color; ds[1].borderDash = [2, 2];        ds[1].borderWidth = 1.5; }       // Holding — dotted
  if (ds[5]) { ds[5].borderColor = color; ds[5].borderDash = [9, 4];        ds[5].borderWidth = 1.5; }       // Target — long dash
  if (ds[6]) { ds[6].borderColor = color; ds[6].borderDash = [2, 4, 9, 4];  ds[6].borderWidth = 1.5; ds[6].fill = false; } // Cash — dash-dot
}
// Per-saved-9sig sub-series (Holding/Target/Cash). Like the envelope, each saved
// strategy owns its breakdown lines, drawn from ITS params and tied to it — so
// they persist correctly (no flipping to the canonical base on close). Toggled
// via cfg.subShown[key]; the main 9sig keeps its own datasets 1/5/6.
const CONFIG_SUB_DEFS = [
  { key: 'holding', label: 'Holding', src: 'tqqqVal', dash: [2, 2] },
  { key: 'target',  label: 'Target',  src: 'target',  dash: [9, 4] },
  { key: 'cash',    label: 'Cash',    src: 'cash',    dash: [2, 4, 9, 4] },
];
// Sub-series chips for a saved 9sig (toggle cfg.subShown[key], persisted).
function buildConfigSubChipsHtml(cfg) {
  const sv = cfg.subShown || {};
  const eyeOpen = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>';
  const eyeOff = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
  return CONFIG_SUB_DEFS.map(def => {
    const on = !!sv[def.key];
    return `<div class="legend-chip cfg-sub-chip${on ? '' : ' legend-hidden'}" data-config-id="${cfg.id}" data-config-sub="${def.key}" role="button" tabindex="0" title="Show / hide on chart">
      <svg class="legend-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${on ? eyeOpen : eyeOff}</svg>
      <span class="legend-dot" style="background:${cfg.color}"></span>
      <span class="legend-name">${def.label}</span>
    </div>`;
  }).join('');
}
// Colour the sidebar picker should show: the saved strategy's colour when one
// is being edited, otherwise the base strategy's (override or default).
function currentLineColor(type) {
  if (window._editingConfigId) {
    const cfg = savedConfigs.find(c => c.id === window._editingConfigId);
    if (cfg) return cfg.color;
  }
  return getBaseColor(type);
}
// Google Workspace standard palette (Docs / Sheets / Slides): 10 columns ×
// 8 rows — grayscale, standard saturated, 3 tint rows, 3 shade rows.
const COLOR_SWATCHES = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
  '#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47',
  '#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130',
];
let _colorPickerOriginal = null; // actual dataset border colour when the popup opened (for cancel/revert)

function buildColorPickerHtml(type) {
  const color = currentLineColor(type);
  const hex = String(color || '').replace(/^#/, '').toLowerCase();
  const swatches = COLOR_SWATCHES.map(c =>
    `<button type="button" class="lc-swatch${c.toLowerCase() === '#' + hex ? ' is-sel' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`
  ).join('');
  return `
    <div class="config-colorbar">
      <span class="config-colorbar-label">Line color</span>
      <button type="button" id="line-color-trigger" class="line-color-trigger" style="background:${color}" aria-label="Pick line color" title="Pick line color"></button>
      <div id="line-color-pop" class="line-color-pop" hidden>
        <div class="lc-swatches">${swatches}</div>
        <div class="lc-row">
          <span class="lc-hash">#</span>
          <input type="text" id="lc-hex" class="lc-hex" maxlength="6" spellcheck="false" value="${hex}" aria-label="Hex color">
          <button type="button" id="lc-ok" class="lc-ok">OK</button>
        </div>
      </div>
    </div>`;
}

// The colour the picker should display (saved strategy's, or base override/default).
function activeLineColor() {
  if (window._editingConfigId) {
    const cfg = savedConfigs.find(c => c.id === window._editingConfigId);
    if (cfg) return cfg.color;
  }
  const type = (typeof getOpenPanelKey === 'function') ? getOpenPanelKey() : null;
  return type ? getBaseColor(type) : '#94a3b8';
}
// The actual borderColor currently on the chart for the active line (so cancel
// restores it exactly — e.g. Invested Compounded's faint default).
function currentDatasetBorderColor() {
  if (typeof chart === 'undefined' || !chart) return activeLineColor();
  if (window._editingConfigId) {
    const i = chart.data.datasets.findIndex(d => d._configId === window._editingConfigId && !d._isShift);
    if (i >= 0) return chart.data.datasets[i].borderColor;
  } else {
    const type = (typeof getOpenPanelKey === 'function') ? getOpenPanelKey() : null;
    const idx = type ? BASE_COLOR_DATASET_IDX[type] : -1;
    if (idx >= 0 && chart.data.datasets[idx]) return chart.data.datasets[idx].borderColor;
  }
  return activeLineColor();
}
function normHex(v) {
  const s = String(v || '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? ('#' + s.toLowerCase()) : null;
}
function setColorUI(hex) {
  const trig = document.getElementById('line-color-trigger');
  if (trig) trig.style.background = hex;
  const inp = document.getElementById('lc-hex');
  if (inp && normHex(inp.value) !== hex) inp.value = hex.replace(/^#/, '');
  document.querySelectorAll('#line-color-pop .lc-swatch').forEach(s =>
    s.classList.toggle('is-sel', (s.dataset.color || '').toLowerCase() === hex.toLowerCase()));
}
function openColorPopup() {
  const pop = document.getElementById('line-color-pop');
  const trig = document.getElementById('line-color-trigger');
  if (!pop || !trig) return;
  _colorPickerOriginal = currentDatasetBorderColor();
  pop.hidden = false;
  // Fixed-position + anchor to the trigger so the panel's overflow:auto can't
  // clip it; nudge back inside the viewport if it would overflow an edge.
  const r = trig.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = r.left + 'px';
  const pr = pop.getBoundingClientRect();
  if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - 8 - pr.width) + 'px';
  if (pr.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, r.top - 6 - pr.height) + 'px';
}
function closeColorPopup(revert) {
  const pop = document.getElementById('line-color-pop');
  if (pop) pop.hidden = true;
  if (revert) {
    if (_colorPickerOriginal != null) applyColorPreview(_colorPickerOriginal);
    setColorUI(activeLineColor());
  }
  _colorPickerOriginal = null;
}
// Live preview while the user moves through the native picker — recolours the
// chart without persisting or rebuilding the panel (so the picker stays open).
function applyColorPreview(color) {
  if (typeof chart === 'undefined' || !chart) return;
  if (window._editingConfigId) {
    chart.data.datasets.forEach(ds => {
      if (ds._configId === window._editingConfigId) {
        ds.borderColor = ds._isShift ? fadeColor(color, 0.13) : color;
      }
    });
  } else {
    const type = (typeof getOpenPanelKey === 'function') ? getOpenPanelKey() : null;
    const idx = type ? BASE_COLOR_DATASET_IDX[type] : -1;
    if (idx >= 0 && chart.data.datasets[idx]) chart.data.datasets[idx].borderColor = color;
    if (type === '9sig') {
      // 9sig's supporting lines share its colour …
      [1, 5, 6].forEach(i => { if (chart.data.datasets[i]) chart.data.datasets[i].borderColor = color; });
      // … and its envelope band ("alternate runs") tracks it too (faded).
      const env = fadeColor(color, 0.12);
      chart.data.datasets.forEach(ds => { if (ds._isShift && !ds._configId) ds.borderColor = env; });
    }
  }
  chart.update('none');
}
// Commit (persist) the chosen colour — fired by the OK button.
function commitLineColor(color) {
  if (window._editingConfigId) {
    const cfg = savedConfigs.find(c => c.id === window._editingConfigId);
    if (cfg) { cfg.color = color; persistSavedConfigs(); }
  } else {
    const type = (typeof getOpenPanelKey === 'function') ? getOpenPanelKey() : null;
    if (type) setBaseColor(type, color);
  }
  if (typeof render === 'function') render();
}

// --- params capture / apply --------------------------------------------
function captureParams(type) {
  const out = {};
  for (const id of CONFIG_PARAM_IDS[type] || []) {
    const el = document.getElementById(id);
    if (!el) continue;
    out[id] = (el.type === 'checkbox') ? (el.checked ? '1' : '0') : el.value;
  }
  return out;
}
function applyParams(type, params) {
  for (const id of CONFIG_PARAM_IDS[type] || []) {
    const el = document.getElementById(id);
    if (!el || !(id in params)) continue;
    if (el.type === 'checkbox') { el.checked = (params[id] === '1' || params[id] === true); continue; }
    el.value = params[id];
    // Keep the `selected` attribute in sync (mirrors preview-dropdown's
    // setSelectValue): re-inserting a <select> during a panel rebuild otherwise
    // snaps it back to whichever option still carries selected="".
    if (el.tagName === 'SELECT') {
      const v = String(params[id]);
      for (const o of el.options) { if (o.value === v) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
    }
  }
}
function pget(p, id, dflt) { return (p && id in p) ? p[id] : dflt; }
function ulColFromVal(v) { return v === 'qqq5' ? 5 : v === 'qld' ? 4 : v === 'sso' ? 6 : v === 'spxl' ? 7 : 1; }

// Canonical (HTML-default) value of every strategy knob, snapshotted ONCE at
// load. This must NOT be re-read live: picking a value from a bar-preview
// dropdown calls setSelectValue, which sets selected="" on the chosen option —
// so afterwards `defaultSelected` would report the user's pick as the default,
// and resetting the main strategy would "reset" to the edit instead of the real
// default. Strategy knobs aren't persisted, so at load they're at their defaults.
const CANONICAL_DEFAULTS = (function captureCanonicalDefaults() {
  const out = {};
  for (const type in CONFIG_PARAM_IDS) {
    for (const id of CONFIG_PARAM_IDS[type]) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') { out[id] = el.defaultChecked ? '1' : '0'; }
      else if (el.tagName === 'SELECT') {
        let def = null;
        for (const o of el.options) if (o.defaultSelected) { def = o.value; break; }
        out[id] = (def != null) ? def : (el.options.length ? el.options[0].value : el.value);
      } else { out[id] = el.defaultValue; }
    }
  }
  return out;
})();
// The canonical (HTML-default) value of each control — used to reset a base
// strategy to its defaults. Served from the load-time snapshot above.
function captureDefaultParams(type) {
  const out = {};
  for (const id of CONFIG_PARAM_IDS[type] || []) {
    if (id in CANONICAL_DEFAULTS) out[id] = CANONICAL_DEFAULTS[id];
  }
  return out;
}
function paramsEqual(a, b, type) {
  for (const id of CONFIG_PARAM_IDS[type] || []) {
    if (String(a[id]) !== String(b[id])) return false;
  }
  return true;
}

// Step-resample [{date,value}] onto the chart's label dates (same approach as
// the SMA alignment in chart.js): for each label take the latest point
// at-or-before it, so a config whose rebalance grain differs from the chart
// x-axis still aligns and its endpoint matches the pill's stat.
function resampleByDate(points, labels) {
  if (!points || !points.length) return labels.map(() => null);
  let j = 0;
  return labels.map(d => {
    while (j + 1 < points.length && points[j + 1].date <= d) j++;
    return points[j].value;
  });
}

// ===== Custom (user / LLM-written) strategies ==========================
// A custom strategy is a saved config of type 'custom' carrying pasted JS in
// cfg.code. The code must evaluate to { name, params, run(data, p) } (or a bare
// run function). New strategies start empty — the build modal walks the user
// through describe → prompt → paste.

// Prompt the user copies into ChatGPT / Claude (their description is injected at
// the end). Deliberately exhaustive so the model has everything the app passes,
// needs and expects — leaving no room for guesswork.
const CUSTOM_PROMPT = `You are writing ONE backtest strategy for a charting app. Output a single JavaScript object and nothing else.

=== OUTPUT FORMAT (strict) ===
- Reply with ONLY the object literal. No prose, no explanation, no Markdown, no code fences.
- Your reply MUST start with the character {  and end with the character }
- Do NOT wrap it in parentheses, assign it to a variable, or use module.exports / export default.
- Pure, synchronous, deterministic JavaScript. NOT allowed: import/require, async/await,
  fetch/XMLHttpRequest, setTimeout/setInterval, DOM access, Math.random, or any global other than
  the two arguments (data, p). Never throw — guard against missing or zero prices.
- Keep it efficient (it re-runs on every UI change): do not scan all of history for every single day.

=== THE OBJECT SHAPE ===
{
  name: "Short human name",
  // OPTIONAL. Each param becomes a DROPDOWN in the sidebar; the chosen value is passed to run() as p.<id>.
  // EVERY param MUST be a dropdown with an explicit list of choices:
  //   { id, label, options: [v1, v2, v3, ...], default: v2 }
  // - options may be numbers or strings; for an on/off toggle use options: [true, false].
  // - give a sensible spread (e.g. [50,100,150,200,250,300]) — the UI shows each option's
  //   resulting final value as a bar, so the user can scan the whole range.
  // - "id" must be a valid JS identifier. Use an empty array if nothing is configurable.
  params: [],
  run(data, p) {
    // build and return the portfolio value over time (see RETURN)
  }
}

=== INPUTS: data (every array has the SAME length and is aligned by index i) ===
data.dates : array of ISO "YYYY-MM-DD" strings, ascending. TRADING days only, so they are NOT
             consecutive calendar days (weekends and holidays are skipped).
data.tqqq  : daily closing price of TQQQ  (3x Nasdaq-100), synthesized back to 1938
data.qqq   : daily closing price of QQQ   (Nasdaq-100)
data.spy   : daily closing price of SPY   (S&P 500)
data.qld   : daily closing price of QLD   (2x Nasdaq-100, ProShares Ultra QQQ)
data.qqq5  : daily closing price of a synthetic 5x Nasdaq-100
data.sso   : daily closing price of SSO   (2x S&P 500, ProShares Ultra S&P500)
data.spxl  : daily closing price of SPXL  (3x S&P 500, Direxion Daily S&P500 Bull 3x)
- Prices are positive numbers; a few of the earliest values may be 0 (missing history) — guard divisions.
- The arrays span the FULL history. You MAY read indices before p.startIdx for warm-up (e.g. to seed a
  moving average), but only push LOG rows for indices within [p.startIdx, p.endIdx].

=== INPUTS: p ===
p.initial     : starting cash, available at p.startIdx (number)
p.monthly     : new cash to ADD at the start of each new month, i.e. when
                data.dates[i].slice(0,7) !== data.dates[i-1].slice(0,7). May be 0.
p.annualRaise : fraction to grow the monthly contribution each calendar year (e.g. 0.03 = +3%/yr; 0 = none)
p.startIdx    : first index to simulate (inclusive)
p.endIdx      : last index to simulate (inclusive)
p.entryDate   : equals data.dates[p.startIdx];   p.exitDate equals data.dates[p.endIdx]
p.<yourId>    : the user's chosen value for each param you declared (already typed for you: number for
                number/numeric-option params, boolean for type:"bool", string otherwise)

=== RETURN ===
Return { log }  (returning the array directly is also accepted). "log" is an array, in ASCENDING date
order, of rows. "date" and "value" are REQUIRED; the rest are strongly recommended so the user can
read what happened:
  { date, value, price, contributed, action }
    date        : a string taken from data.dates (so it lines up with the chart's time axis)
    value       : TOTAL portfolio value that day = cash + market value of every holding (positive number)
    price       : the close price of the main asset you traded on that row (e.g. data.tqqq[i])
    contributed : new cash added on this row (the contribution amount; 0 when none)
    action      : a short label of what happened — e.g. "contribution", "buy", "sell", "rebalance", "hold"
- ALWAYS push a row for each monthly contribution (action "contribution", contributed = the amount added),
  AND for every trade/rebalance, AND at least once per month. More rows = a richer log + smoother line.
- The first logged value is normally about p.initial.
- You may add any extra keys (they appear as extra log columns).

=== HOW THE SIMULATION WORKS ===
- You manage cash and holdings yourself in local variables — nothing is auto-invested.
- Trade at that day's close, data.<asset>[i]. tqqq, qld, qqq5, sso, and spxl are ALREADY leveraged products; do not
  invent additional borrowing or leverage.
- Add p.monthly of new cash at each new month (optionally grown by p.annualRaise per calendar year),
  and record that as a row with action "contribution".
- Decide each day using only data up to that day (no look-ahead / no future prices).

=== IF MY STRATEGY NAMES A KNOWN STRATEGY ===
- If my description references a named or published strategy (e.g. "9sig" / "9 Sig", "dual momentum",
  "HFEA", "risk parity", "200-day SMA timing", "Dalio All-Weather"), look it up — search the web if you
  have browsing — and implement its ACTUAL, correct rules and parameters. Do not guess from the name.

=== A COMPLETE, WORKING EXAMPLE (for reference — do NOT just copy it) ===
{
  name: "QQQ 200-day trend (TQQQ or cash)",
  params: [
    { id: "window", label: "SMA window (days)", options: [50, 100, 150, 200, 250, 300], default: 200 }
  ],
  run(data, p) {
    const log = [];
    let shares = 0, cash = p.initial, invested = false, prevMonth = null;
    const w = p.window;
    for (let i = p.startIdx; i <= p.endIdx; i++) {
      const px = data.tqqq[i];
      const month = data.dates[i].slice(0, 7);
      let contributed = 0, action = "hold";
      if (prevMonth !== null && month !== prevMonth && p.monthly > 0) {   // monthly contribution
        cash += p.monthly; contributed = p.monthly; action = "contribution";
      }
      prevMonth = month;
      let sum = 0, n = 0;                                   // QQQ moving average over the last w days
      for (let k = Math.max(0, i - w + 1); k <= i; k++) { sum += data.qqq[k]; n++; }
      const sma = n ? sum / n : 0;
      const bullish = data.qqq[i] > sma;
      if (bullish && !invested && px > 0) { shares = cash / px; cash = 0; invested = true; action = "buy"; }
      else if (!bullish && invested)      { cash = shares * px; shares = 0; invested = false; action = "sell"; }
      else if (invested && cash > 0 && px > 0) { shares += cash / px; cash = 0; } // deploy new cash
      const monthEnd = i === p.endIdx || data.dates[i + 1].slice(0, 7) !== month;
      if (contributed > 0 || action === "buy" || action === "sell" || monthEnd) {
        log.push({ date: data.dates[i], value: shares * px + cash, price: px, contributed: contributed, action: action });
      }
    }
    return { log };
  }
}

=== MY STRATEGY (write code that implements THIS) ===
<<describe your strategy here>>`;

// Inject the user's plain-English description into the structured prompt.
function buildCustomPrompt(desc) {
  const d = (desc || '').trim();
  return CUSTOM_PROMPT.replace('<<describe your strategy here>>', d || '<<describe your strategy here>>');
}

let _customDataCache = null;
function buildCustomData() {
  if (_customDataCache) return _customDataCache;
  if (typeof daily === 'undefined' || !daily) return { dates: [], tqqq: [], qqq: [], spy: [], qld: [], qqq5: [], sso: [], spxl: [] };
  _customDataCache = {
    dates: daily.map(d => d.date),
    tqqq:  daily.map(d => d.tqqq),
    qqq:   daily.map(d => d.qqq),
    spy:   daily.map(d => d.spy),
    qld:   daily.map(d => d.qld),
    qqq5:  daily.map(d => d.qqq5),
    sso:   daily.map(d => d.sso),
    spxl:  daily.map(d => d.spxl),
  };
  return _customDataCache;
}

// === Sandboxed execution ================================================
// Custom strategy code is NEVER evaluated on the main thread. It runs inside a
// Web Worker: no DOM, no window/document, no localStorage/cookies, no access to
// the page — and we additionally remove fetch / XMLHttpRequest / WebSocket /
// importScripts, plus a wall-clock timeout that kills runaway loops. The only
// input is public market data, so even hostile shared code can't read anything
// sensitive or reach the network. That makes running a stranger's strategy safe.
//
// The function below is stringified (never called on the main thread) and runs
// inside the worker.
function customWorkerMain() {
  // Strip anything that could exfiltrate, persist, or spawn more workers.
  ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'caches',
   'Notification', 'SharedWorker', 'Worker', 'BroadcastChannel'].forEach(function (k) {
    try { self[k] = undefined; } catch (e) {}
  });
  var DATA = null;
  function sanitize(raw) {
    var s = String(raw || '').trim();
    var f = s.match(/```[a-zA-Z0-9]*\s*([\s\S]*?)```/);
    if (f) s = f[1].trim();
    s = s.replace(/^\s*(?:module\.exports\s*=|export\s+default|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=)\s*/, '').trim();
    s = s.replace(/;\s*$/, '').trim();
    return s;
  }
  function asMod(m) {
    if (typeof m === 'function') return { name: null, run: m, params: undefined };
    if (m && typeof m.run === 'function') return { name: m.name || null, run: m.run, params: m.params };
    return null;
  }
  function evalMod(code) {
    var base = sanitize(code), cands = [base], t = base, k;
    for (k = 0; k < 4 && /^\(/.test(t) && /\)$/.test(t); k++) { t = t.slice(1, -1).trim(); cands.push(t); }
    var fo = Math.min.apply(null, ['{', '('].map(function (c) { var i = base.indexOf(c); return i < 0 ? Infinity : i; }));
    var lc = Math.max(base.lastIndexOf('}'), base.lastIndexOf(')'));
    if (isFinite(fo) && fo > 0 && lc > fo) cands.push(base.slice(fo, lc + 1));
    var fb = base.indexOf('{'), lb = base.lastIndexOf('}');
    if (fb >= 0 && lb > fb) cands.push(base.slice(fb, lb + 1));
    if (base.length > 4 && /^\(\{/.test(base) && /\}\)$/.test(base)) cands.push(base.slice(2, -2).trim());
    var mod = null, lastErr;
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci]; if (!c) continue;
      try { var r = asMod((new Function('"use strict"; return (' + c + '\n);'))()); if (r) { mod = r; break; } } catch (e) { lastErr = e; }
      try { var r2 = asMod((new Function('"use strict";\n' + c + '\n'))()); if (r2) { mod = r2; break; } } catch (e2) { lastErr = e2; }
    }
    if (!mod) throw new Error('Could not read a strategy — it must be a function run(data, p) or an object with one (no surrounding text or code fences). ' + (lastErr ? lastErr.message : ''));
    return mod;
  }
  function coerce(sp, raw) {
    if (sp.type === 'bool' || sp.type === 'boolean') return raw === true || raw === 'true' || raw === '1' || raw === 1;
    var numeric = (sp.type === 'number') || ('min' in sp) || ('max' in sp) || ('step' in sp) || (Array.isArray(sp.options) && typeof sp.options[0] === 'number') || (typeof sp.default === 'number');
    if (numeric) { var n = Number(raw); return isFinite(n) ? n : (sp.default != null ? sp.default : 0); }
    return raw != null ? String(raw) : (sp.default != null ? String(sp.default) : '');
  }
  self.onmessage = function (e) {
    var msg = e.data || {};
    if (msg.type === 'data') { DATA = msg.data; return; }
    if (msg.type !== 'run') return;
    var out;
    try {
      var mod = evalMod(msg.code);
      var schema = Array.isArray(mod.params) ? mod.params : [];
      try { schema = JSON.parse(JSON.stringify(schema)); } catch (e0) { schema = []; }
      var p = {}, g = msg.globals || {}, key;
      for (key in g) p[key] = g[key];
      var raw = msg.rawParams || {};
      for (var si = 0; si < schema.length; si++) {
        var sp = schema[si];
        if (sp && sp.id != null) p[sp.id] = coerce(sp, (raw && (sp.id in raw)) ? raw[sp.id] : sp.default);
      }
      var res = mod.run(DATA, p);
      var rawLog = Array.isArray(res) ? res : (res && Array.isArray(res.log) ? res.log : null);
      if (!rawLog) throw new Error('Your function must return an array of { date, value } (or { log: [...] }).');
      var log = [];
      for (var li = 0; li < rawLog.length; li++) {
        var row = rawLog[li]; if (!row || row.date == null) continue;
        var o = {}, rk;
        for (rk in row) { var rv = row[rk]; if (typeof rv === 'number' || typeof rv === 'string' || typeof rv === 'boolean') o[rk] = rv; }
        log.push(o);
      }
      out = { reqId: msg.reqId, schema: schema, name: mod.name || null, log: log,
              totalContributed: (res && typeof res.totalContributed === 'number') ? res.totalContributed : null };
    } catch (err) {
      out = { reqId: msg.reqId, error: (err && err.message) ? err.message : String(err) };
    }
    self.postMessage(out);
  };
}

// --- main-thread orchestration of the sandbox --------------------------
window._customLogs = window._customLogs || {};
window._customErrors = window._customErrors || {};
window._customSchemas = window._customSchemas || {};
window._customResults = window._customResults || {}; // cfgId -> { sig, log, schema, name, error, totalContributed }
const CUSTOM_TIMEOUT_MS = 4000;
let _customWorker = null, _customWorkerSeq = 0, _customDataSent = false;
const _customPending = {};   // reqId -> { cfgId, sig, timer }
const _customRunTimers = {}; // cfgId -> { sig, t }

function ensureCustomWorker() {
  if (_customWorker) return _customWorker;
  try {
    const src = '(' + customWorkerMain.toString() + ')()';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const w = new Worker(url);
    w.onmessage = onCustomWorkerMessage;
    w.onerror = function () { try { w.terminate(); } catch (e) {} _customWorker = null; _customDataSent = false; };
    _customWorker = w;
    _customDataSent = false;
  } catch (e) { _customWorker = null; }
  return _customWorker;
}
function sendCustomData() {
  const w = ensureCustomWorker();
  if (!w || _customDataSent) return;
  w.postMessage({ type: 'data', data: buildCustomData() });
  _customDataSent = true;
}
function customSig(cfg, ctx) {
  return [cfg.code || '', JSON.stringify(cfg.params || {}), ctx.initial, ctx.monthly, ctx.annualRaise, ctx.simEntryIdx, ctx.exitIdx].join('');
}
function computeCustomGlobals(cfg, ctx) {
  let entryDate = null, exitDate = null, startIdx = 0, endIdx = 0;
  if (typeof quarterlyData !== 'undefined' && quarterlyData) {
    entryDate = (quarterlyData[ctx.simEntryIdx] || [])[0];
    exitDate  = (quarterlyData[ctx.exitIdx] || [])[0];
  }
  if (typeof dailyDateToIdx !== 'undefined' && dailyDateToIdx) {
    const s = dailyDateToIdx.get(entryDate), en = dailyDateToIdx.get(exitDate);
    if (s != null) startIdx = s;
    if (en != null) endIdx = en;
  }
  const dlen = (typeof daily !== 'undefined' && daily) ? daily.length : 0;
  if (!endIdx) endIdx = Math.max(0, dlen - 1);
  return { initial: ctx.initial, monthly: ctx.monthly, annualRaise: ctx.annualRaise, startIdx, endIdx, entryDate, exitDate };
}
// Debounce so a slider drag coalesces into a single worker run.
function scheduleCustomRun(cfg, sig, globals) {
  for (const k in _customPending) if (_customPending[k].cfgId === cfg.id && _customPending[k].sig === sig) return;
  if (_customRunTimers[cfg.id]) clearTimeout(_customRunTimers[cfg.id].t);
  _customRunTimers[cfg.id] = { sig, t: setTimeout(function () { delete _customRunTimers[cfg.id]; runCustomInWorker(cfg, sig, globals); }, 120) };
}
function runCustomInWorker(cfg, sig, globals) {
  const w = ensureCustomWorker();
  if (!w) { window._customResults[cfg.id] = { sig, log: [], schema: [], error: 'Sandbox (Web Worker) unavailable in this browser.' }; if (typeof render === 'function') render(); return; }
  sendCustomData();
  const reqId = ++_customWorkerSeq;
  const timer = setTimeout(function () {
    delete _customPending[reqId];
    try { w.terminate(); } catch (e) {}
    _customWorker = null; _customDataSent = false; // rebuilt on next use
    window._customResults[cfg.id] = { sig, log: [], schema: (window._customSchemas[cfg.id] || []), error: 'Strategy timed out — possible infinite loop.' };
    if (typeof render === 'function') render();
  }, CUSTOM_TIMEOUT_MS);
  _customPending[reqId] = { cfgId: cfg.id, sig, timer };
  w.postMessage({ type: 'run', reqId: reqId, code: cfg.code, globals: globals, rawParams: cfg.params || {} });
}
// One-off sandbox run for a bar preview (a param override). Result goes to `cb`,
// NOT into the main result cache, so it never disturbs the live line.
function runCustomPreview(cfg, overrides, globals, cb) {
  const w = ensureCustomWorker();
  if (!w) { cb(null, 'no-sandbox'); return; }
  sendCustomData();
  const reqId = ++_customWorkerSeq;
  const timer = setTimeout(function () {
    delete _customPending[reqId];
    try { w.terminate(); } catch (e) {}
    _customWorker = null; _customDataSent = false;
    cb(null, 'timeout');
  }, CUSTOM_TIMEOUT_MS);
  _customPending[reqId] = { cb, timer };
  w.postMessage({ type: 'run', reqId: reqId, code: cfg.code, globals: globals, rawParams: Object.assign({}, cfg.params || {}, overrides) });
}
function onCustomWorkerMessage(e) {
  const msg = e.data || {};
  const pend = _customPending[msg.reqId];
  if (!pend) return; // stale or timed-out
  clearTimeout(pend.timer);
  delete _customPending[msg.reqId];
  if (pend.cb) { pend.cb(msg, msg.error); return; } // bar-preview run
  window._customResults[pend.cfgId] = {
    sig: pend.sig, log: msg.log || [], schema: msg.schema || [],
    name: msg.name || null, error: msg.error || null,
    totalContributed: (typeof msg.totalContributed === 'number') ? msg.totalContributed : null,
  };
  window._customSchemas[pend.cfgId] = msg.schema || [];
  if (typeof render === 'function') render(); // now a cache hit → no new run
}

// Schema comes from the worker (we never evaluate strategy code on the main thread).
function getCustomSchema(cfg) { return (window._customSchemas || {})[cfg.id] || []; }
// Coerce a stored/raw param value to the type implied by its schema entry.
function coerceCustomVal(sp, raw) {
  if (sp.type === 'bool' || sp.type === 'boolean') return raw === true || raw === 'true' || raw === '1' || raw === 1;
  const numericHint = (sp.type === 'number') || ('min' in sp) || ('max' in sp) || ('step' in sp)
    || (Array.isArray(sp.options) && typeof sp.options[0] === 'number')
    || (typeof sp.default === 'number');
  if (numericHint) { const n = Number(raw); return Number.isFinite(n) ? n : (sp.default != null ? sp.default : 0); }
  return raw != null ? String(raw) : (sp.default != null ? String(sp.default) : '');
}
function customParamValue(cfg, sp) {
  const stored = cfg.params && (sp.id in cfg.params) ? cfg.params[sp.id] : sp.default;
  return coerceCustomVal(sp, stored);
}

// Money-weighted CAGR (%) for a saved/custom config, using the shared chart
// contribution schedule (ctx) and the config's own final value. The x-axis
// labels span the same dates as the main strategy, so labels[0]/labels[last]
// give the contribution window. Falls back to the simple end/contributed CAGR
// when metrics.js isn't loaded or the span is unknown.
function cfgMoneyWeightedCAGR(ctx, finalV) {
  const labels = ctx.labels || [];
  const startDate = labels.length ? labels[0] : null;
  const endDate = labels.length ? labels[labels.length - 1] : null;
  if (typeof moneyWeightedCAGR === 'function' && startDate && endDate) {
    return moneyWeightedCAGR(ctx.initial, ctx.monthly, ctx.annualRaise, startDate, endDate,
      ctx.years, finalV, (typeof monthlyData !== 'undefined' ? monthlyData : null), ctx.totalContributed);
  }
  return (ctx.years > 0 && ctx.totalContributed > 0 && finalV > 0)
    ? (Math.pow(finalV / ctx.totalContributed, 1 / ctx.years) - 1) * 100 : 0;
}

// Turn a (worker-computed) log into a label-aligned series + stats. No code eval.
function customSeriesResult(log, ctx, error, tcOverride) {
  const labels = ctx.labels;
  if (error) return { data: labels.map(() => null), cagr: 0, maxDD: 0, start: 0, end: 0 };
  const points = (log || [])
    .filter(r => r && r.date != null && typeof r.value === 'number' && Number.isFinite(r.value))
    .map(r => ({ date: String(r.date), value: r.value }))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const series = resampleByDate(points, labels);
  const finalV = series.length ? series[series.length - 1] : 0;
  const startV = series.length ? series[0] : 0;
  // Custom strategies have no reconstructable share/cash control points, so
  // drawdown stays on the rebalance-grain series. CAGR is money-weighted.
  const cagr = cfgMoneyWeightedCAGR(ctx, finalV);
  const maxDD = (typeof computeMaxDrawdown === 'function') ? computeMaxDrawdown(series) * 100 : 0;
  return { data: series, cagr, maxDD, start: startV, end: finalV };
}

// Custom strategy series — served from the worker-result cache. On a cache miss
// (new code/params/range) it schedules a sandboxed run and, until that returns,
// shows the last good line so the chart doesn't flicker.
function computeCustomSeries(cfg, ctx) {
  window._customCtx = ctx; // shared by the bar-preview popup
  if (!cfg.code || !String(cfg.code).trim()) {
    window._customErrors[cfg.id] = null;
    window._customLogs[cfg.id] = [];
    return customSeriesResult([], ctx, true);
  }
  const sig = customSig(cfg, ctx);
  const cached = window._customResults[cfg.id];
  if (cached && cached.sig === sig) {
    window._customErrors[cfg.id] = cached.error || null;
    window._customLogs[cfg.id] = cached.log || [];
    window._customSchemas[cfg.id] = cached.schema || [];
    return customSeriesResult(cached.log, ctx, cached.error, cached.totalContributed);
  }
  scheduleCustomRun(cfg, sig, computeCustomGlobals(cfg, ctx));
  window._customErrors[cfg.id] = null; // computing…
  window._customLogs[cfg.id] = (cached && cached.log) || [];
  return customSeriesResult(cached ? cached.log : [], ctx, null, cached ? cached.totalContributed : null);
}

// Run the right engine for a config and return its label-aligned series + stats.
function computeConfigSeries(cfg, ctx) {
  if (cfg.type === 'custom') return computeCustomSeries(cfg, ctx);
  const { initial, monthly, annualRaise, simEntryIdx, exitIdx, labels, years, totalContributed } = ctx;
  const p = cfg.params || {};
  let points = null;
  let subPoints = null; // 9sig Holding/Target/Cash breakdown (for its sub-series)
  // #3 Daily-drawdown control points (date/shares/cash) + the daily price field
  // to revalue against. Filled per strategy below; null → fall back to the
  // rebalance-grain series drawdown (e.g. Invested Compounded, custom).
  let ddControls = null, ddKey = null;
  const UL_KEY = { 1: 'tqqq', 2: 'qqq', 3: 'spy', 4: 'qld', 5: 'qqq5', 6: 'sso', 7: 'spxl' };

  if (cfg.type === '9sig') {
    const cd = +pget(p, 'select-9sig-crashdrop', 30);
    const sp = +pget(p, 'select-9sig-spike', 100);
    const opts = {
      qGrowth: (+pget(p, 'select-9sig-growth', 9)) / 100 || 0.09,
      underlyingCol: ulColFromVal(pget(p, 'select-9sig-underlying', 'tqqq')),
      crashDropPct: Number.isFinite(cd) ? cd : 30,
      crashLookbackMonths: +pget(p, 'select-9sig-crashwin', 24) || 24,
      spikeTriggerPct: Number.isFinite(sp) ? sp : 100,
      rebalancePeriod: pget(p, 'select-9sig-period', 'quarterly') || 'quarterly',
      cashPct: (+pget(p, 'select-9sig-cash', 40) || 0) / 100,
      contribDeployPct: (pget(p, 'select-9sig-deploy', '0') === '1') ? 0.5 : 0,
      targetFromPrevTarget: pget(p, 'select-9sig-target-compound', '0') === '1',
      buyThrottlePct: +pget(p, 'select-9sig-buypower', 90) || 90,
    };
    // A yearly config is coarser than the chart's quarterly axis floor → get
    // quarter-end value snapshots so its line/sub-series draw at quarter detail.
    opts.sampleQuarterly = (opts.rebalancePeriod === 'yearly');
    const cashRate = (+pget(p, 'select-9sig-cashrate', 4) || 0) / 100;
    const r = simulate(initial, monthly, cashRate, simEntryIdx, exitIdx, annualRaise, opts);
    const seriesRows = (r.samplePoints && r.samplePoints.length) ? r.samplePoints : (r.log || []);
    points = seriesRows.map(l => ({ date: l.date, value: l.total }));
    subPoints = {
      holding: seriesRows.map(l => ({ date: l.date, value: l.tqqqVal })),
      target:  seriesRows.map(l => ({ date: l.date, value: l.target })),
      cash:    seriesRows.map(l => ({ date: l.date, value: l.cash })),
    };
    ddControls = (r.log || []).map(l => ({ date: l.date, shares: l.price > 0 ? l.tqqqVal / l.price : 0, cash: l.cash }));
    ddKey = UL_KEY[opts.underlyingCol] || 'tqqq';
    if (window._editingConfigId === cfg.id) window._editingConfigSim = { type: '9sig', log: r.log, bhPoints: r.bhPoints, qqqPoints: r.qqqPoints, spyPoints: r.spyPoints, qldPoints: r.qldPoints, qqq5Points: r.qqq5Points, ssoPoints: r.ssoPoints, spxlPoints: r.spxlPoints };
  } else if (cfg.type === 'sma') {
    const opts = {
      smaAsset: pget(p, 'select-sma-asset', 'qqq') || 'qqq',
      smaWindow: +pget(p, 'select-sma-window', 200) || 200,
      underlyingCol: ulColFromVal(pget(p, 'select-sma-underlying', 'tqqq')),
      entryBufferPct: +pget(p, 'select-sma-entry-buf', 0) || 0,
      exitBufferPct: +pget(p, 'select-sma-exit-buf', 0) || 0,
      rsiOverheatThreshold: +pget(p, 'select-sma-rsi-oh', 0) || 0,
      rsiCoolThreshold: +pget(p, 'select-sma-rsi-cool', 0) || 0,
      outAsset: pget(p, 'select-sma-out-asset', 'cash') || 'cash',
      dcaInMonths: +pget(p, 'select-sma-dca-in', 0) || 0,
      dcaToOutMonths: +pget(p, 'select-sma-dca-to-out', 0) || 0,
      bgDelevPct: +pget(p, 'select-sma-bg-delev', 0) || 0,
      bgGtfoPct: +pget(p, 'select-sma-bg-gtfo', 0) || 0,
    };
    const cashRate = (+pget(p, 'select-sma-cashrate', 4) || 0) / 100;
    const r = simulateSMA(initial, monthly, cashRate, simEntryIdx, exitIdx, annualRaise, opts);
    points = (r.smaPoints || []).map(pt => ({ date: pt.date, value: pt.value }));
    ddControls = (r.smaLog || []).map(row => ({ date: row.date, shares: row.shares, cash: row.cash }));
    ddKey = UL_KEY[opts.underlyingCol] || 'qqq';
    if (window._editingConfigId === cfg.id) window._editingConfigSim = { type: 'sma', smaLog: r.smaLog, smaPoints: r.smaPoints };
  } else if (cfg.type === 'bh') {
    const r = simulate(initial, monthly, 0, simEntryIdx, exitIdx, annualRaise, {});
    const key = pget(p, 'select-bh-underlying', 'tqqq');
    const arr = key === 'qqq' ? r.qqqPoints
              : key === 'spy' ? r.spyPoints
              : key === 'qld' ? (r.qldPoints || [])
              : key === 'qqq5' ? (r.qqq5Points || [])
              : key === 'sso' ? (r.ssoPoints || [])
              : key === 'spxl' ? (r.spxlPoints || [])
              : r.bhPoints;
    points = (arr || []).map(pt => ({ date: pt.date, value: pt.value }));
    ddControls = (arr || []).map(pt => ({ date: pt.date, shares: pt.shares, cash: 0 }));
    ddKey = key === 'qqq' ? 'qqq' : key === 'spy' ? 'spy' : key === 'qld' ? 'qld' : key === 'qqq5' ? 'qqq5' : key === 'sso' ? 'sso' : key === 'spxl' ? 'spxl' : 'tqqq';
    if (window._editingConfigId === cfg.id) window._editingConfigSim = { type: 'bh', log: r.log, bhPoints: r.bhPoints, qqqPoints: r.qqqPoints, spyPoints: r.spyPoints, qldPoints: r.qldPoints, qqq5Points: r.qqq5Points, ssoPoints: r.ssoPoints, spxlPoints: r.spxlPoints };
  } else if (cfg.type === 'invested') {
    const rate = (typeof sliderToRate === 'function' ? sliderToRate(+pget(p, 'slider-rate', 0)) : 0) / 100;
    const r = simulate(initial, monthly, 0, simEntryIdx, exitIdx, annualRaise, { baselineRate: rate });
    points = (r.log || []).map(l => ({ date: l.date, value: l.investedCompounded }));
    if (window._editingConfigId === cfg.id) window._editingConfigSim = { type: 'invested', log: r.log };
  }

  const data = resampleByDate(points, labels);
  const finalV = data.length ? data[data.length - 1] : 0;
  const startV = data.length ? data[0] : 0;
  // #2 Money-weighted (IRR) return — same contribution schedule as the main
  // chart; only this strategy's final value differs.
  const cagr = cfgMoneyWeightedCAGR(ctx, finalV);
  // #3 Daily-sampled drawdown when we have control points to revalue daily;
  // otherwise fall back to the rebalance-grain series drawdown.
  const dailyRows = (typeof daily !== 'undefined' && daily) ? daily : null;
  const maxDD = (ddControls && ddControls.length && dailyRows && typeof computeDailyMaxDrawdown === 'function')
    ? computeDailyMaxDrawdown(ddControls, dailyRows, ddKey) * 100
    : ((typeof computeMaxDrawdown === 'function') ? computeMaxDrawdown(data) * 100 : 0);
  return { data, cagr, maxDD, start: startV, end: finalV, subPoints };
}

function fadeColor(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// "Show alternate runs" is a PER-STRATEGY setting (so toggling it for one strategy
// never affects another's line, and it stays on when the panel is closed). The main
// 9sig keeps a session flag; each saved 9sig stores its own cfg.showEnvelope. The
// single panel checkbox reflects/sets whichever strategy is currently open.
window._mainEnvelopeOn = false;
function editingSaved9sigCfg() {
  if (!window._editingConfigId) return null;
  const cfg = savedConfigs.find(c => c.id === window._editingConfigId);
  return (cfg && cfg.type === '9sig') ? cfg : null;
}
function currentEnvelopeFlag() {
  const cfg = editingSaved9sigCfg();
  return cfg ? !!cfg.showEnvelope : !!window._mainEnvelopeOn;
}
function setCurrentEnvelopeFlag(on) {
  const cfg = editingSaved9sigCfg();
  if (cfg) { cfg.showEnvelope = !!on; persistSavedConfigs(); }
  else { window._mainEnvelopeOn = !!on; }
}

// Alternate-runs ("envelope") band for a saved 9sig strategy: rebalance-day-
// shifted ghost lines computed from the strategy's OWN params. Shown whenever the
// strategy's own showEnvelope flag is on and its line is visible — independent of
// the panel and of every other strategy.
function computeConfigGhosts(cfg, ctx) {
  if (cfg.type !== '9sig' || cfg.hidden) return [];
  if (!cfg.showEnvelope) return [];
  if (typeof simulate !== 'function' || typeof buildEnvelopeShifts !== 'function'
      || typeof getShiftedPeriodData !== 'function') return [];
  const { initial, monthly, annualRaise, simEntryIdx, exitIdx, labels } = ctx;
  const p = cfg.params || {};
  const period = pget(p, 'select-9sig-period', 'quarterly') || 'quarterly';
  // Lazily build (and memoize, reusing data.js's cache) the period's shifts.
  let entry = (typeof _envelopeCacheByPeriod !== 'undefined' && _envelopeCacheByPeriod)
    ? _envelopeCacheByPeriod[period] : null;
  if (!entry) {
    const shifts = buildEnvelopeShifts(period);
    entry = { shifts, cache: shifts.map(s => getShiftedPeriodData(period, s)) };
    if (typeof _envelopeCacheByPeriod !== 'undefined' && _envelopeCacheByPeriod) {
      _envelopeCacheByPeriod[period] = entry;
    }
  }
  const cd = +pget(p, 'select-9sig-crashdrop', 30);
  const sp = +pget(p, 'select-9sig-spike', 100);
  const sigParams = {
    qGrowth: (+pget(p, 'select-9sig-growth', 9)) / 100 || 0.09,
    underlyingCol: ulColFromVal(pget(p, 'select-9sig-underlying', 'tqqq')),
    crashDropPct: Number.isFinite(cd) ? cd : 30,
    crashLookbackMonths: +pget(p, 'select-9sig-crashwin', 24) || 24,
    spikeTriggerPct: Number.isFinite(sp) ? sp : 100,
    rebalancePeriod: period,
    cashPct: (+pget(p, 'select-9sig-cash', 40) || 0) / 100,
    contribDeployPct: (pget(p, 'select-9sig-deploy', '0') === '1') ? 0.5 : 0,
    buyThrottlePct: +pget(p, 'select-9sig-buypower', 90) || 90,
  };
  const cashRate = (+pget(p, 'select-9sig-cashrate', 4) || 0) / 100;
  // Build a per-ghost qData anchored at the chart's entry date. Each ghost
  // rebalances at entry + dayOffset, then every `period_days` after. We pass
  // the canonical entryIdx/exitIdx so simulate()'s yearly entry-remap finds
  // qData[0] (which we set to the canonical entry date) and walks the full
  // qData without slicing it down to a single row.
  const entryDate = quarterlyData[simEntryIdx] && quarterlyData[simEntryIdx][0];
  const exitDate  = quarterlyData[exitIdx]    && quarterlyData[exitIdx][0];
  return entry.shifts.map(dayShift => {
    const qData = (typeof buildEnvelopeQData === 'function')
      ? buildEnvelopeQData(period, dayShift, entryDate, exitDate)
      : null;
    if (!qData || qData.length < 2) return labels.map(() => null);
    const r = simulate(initial, monthly, cashRate, simEntryIdx, exitIdx, annualRaise, { ...sigParams, qData, skipBH: true });
    const rows = r.log || [];
    return resampleByDate(rows.map(l => ({ date: l.date, value: l.total })), labels);
  });
}

// --- chart dataset sync (called from render() in chart.js) -------------
function removeConfigDatasets(chart) {
  if (!chart || !chart.data) return;
  for (let i = chart.data.datasets.length - 1; i >= 0; i--) {
    if (chart.data.datasets[i]._configLine) chart.data.datasets.splice(i, 1);
  }
}
function appendConfigDatasets(chart, ctx) {
  if (!chart || !chart.data) return;
  window._configMetrics = {};
  // Recomputed below if the edited config is among these; the side panel uses it
  // to show the EDITED strategy's stats/log (the base sim is canonical now).
  window._editingConfigSim = null;
  for (const cfg of savedConfigs) {
    const s = computeConfigSeries(cfg, ctx);
    window._configMetrics[cfg.id] = { cagr: s.cagr, maxDD: s.maxDD, start: s.start, end: s.end };
    chart.data.datasets.push({
      label: cfg.name,
      data: s.data,
      borderColor: cfg.color,
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.3,
      pointRadius: 0,
      pointHitRadius: 10,
      borderWidth: 2,
      hidden: !!cfg.hidden,
      _configLine: true,
      _configId: cfg.id,
    });
    chart.setDatasetVisibility(chart.data.datasets.length - 1, !cfg.hidden);

    // Per-strategy sub-series (Holding/Target/Cash) — each saved 9sig owns its
    // own breakdown lines, drawn from its sim, shown per cfg.subShown[key]. They
    // persist (tied to the strategy), so they never flip to the canonical base.
    if (cfg.type === '9sig' && s.subPoints && cfg.subShown) {
      for (const def of CONFIG_SUB_DEFS) {
        if (!cfg.subShown[def.key]) continue;
        chart.data.datasets.push({
          label: cfg.name + ' ' + def.label,
          data: resampleByDate(s.subPoints[def.key], ctx.labels),
          borderColor: cfg.color, borderDash: def.dash, borderWidth: 1.5,
          backgroundColor: 'transparent', fill: false, tension: def.key === 'target' ? 0 : 0.3,
          pointRadius: 0, pointHitRadius: 10, hidden: !!cfg.hidden,
          _configLine: true, _configId: cfg.id, _configSub: def.key,
        });
        chart.setDatasetVisibility(chart.data.datasets.length - 1, !cfg.hidden);
      }
    }

    // Per-strategy alternate-runs band (9sig + envelope on + visible). Tagged
    // with the same _configId so it hides/shows and gets removed with the
    // strategy; _isShift keeps it out of the tooltip + end-labels.
    const ghosts = computeConfigGhosts(cfg, ctx);
    if (ghosts.length) {
      const gColor = fadeColor(cfg.color, 0.13);
      for (const g of ghosts) {
        chart.data.datasets.push({
          label: '_cfgshift_', data: g, borderColor: gColor, backgroundColor: 'transparent',
          fill: false, tension: 0.3, pointRadius: 0, pointHitRadius: 0, borderWidth: 1,
          order: -1, _configLine: true, _configId: cfg.id, _isShift: true,
        });
        chart.setDatasetVisibility(chart.data.datasets.length - 1, true);
      }
    }
  }
}

// --- naming -------------------------------------------------------------
// Default names are PLAIN type labels — they don't encode (or track) the
// strategy's parameters. The user can rename a saved strategy to anything.
const BASE_LABELS = { '9sig': '9sig', 'sma': 'SMA', 'bh': 'Buy & Hold', 'invested': 'Invested Compounded', 'custom': 'Custom strategy' };
function genBaseName(type) {
  return BASE_LABELS[type] || type;
}
// Ensure a name is unique among saved configs, appending " (2)", " (3)"… on
// collision. `exceptId` lets an in-place rename keep its own current name.
function uniqueName(desired, exceptId) {
  const existing = new Set(savedConfigs.filter(c => c.id !== exceptId).map(c => c.name));
  let name = desired, n = 2;
  while (existing.has(name)) name = `${desired} (${n++})`;
  return name;
}
function nextConfigColor() {
  const used = new Set(savedConfigs.map(c => c.color));
  for (const c of CONFIG_COLORS) if (!used.has(c)) return c;
  return CONFIG_COLORS[savedConfigs.length % CONFIG_COLORS.length];
}

// --- CRUD ---------------------------------------------------------------
function saveConfigFromType(type) {
  if (!CONFIG_PARAM_IDS[type]) return;
  const params = captureParams(type);
  // Default name is a plain type label ("9sig", "SMA", …) — unless the user typed
  // one into the panel title before saving. Names never auto-change with params;
  // the user can rename freely at any time.
  const desired = window._pendingConfigName || genBaseName(type);
  window._pendingConfigName = null;
  const cfg = {
    id: 'cfg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    name: uniqueName(desired),
    params,
    // Keep the main strategy's colour — the saved strategy is its variant, not a
    // differently-coloured line.
    color: (typeof getBaseColor === 'function') ? getBaseColor(type) : nextConfigColor(),
    hidden: false,
  };
  // The copy inherits the main's "show alternate runs" state (per-strategy from
  // here on); the main then resets, so its own envelope flag clears.
  if (type === '9sig') { cfg.showEnvelope = !!window._mainEnvelopeOn; window._mainEnvelopeOn = false; }
  savedConfigs.push(cfg);
  persistSavedConfigs();
  // After saving we're editing the COPY, not the main strategy: its controls stay
  // loaded so further tweaks auto-save into it (and it shows no "Save as strategy"
  // button). The MAIN strategy is reset to its defaults — automatically, because
  // the base line is frozen to canonical while a saved strategy is edited — and
  // its line is hidden so the copy stands alone on the chart.
  window._editingConfigId = cfg.id;
  setPanelTitle(cfg.name);
  setBaseStrategyVisibility(type, false);
  if (typeof render === 'function') render();
  flashSaveSuccess(cfg.id);
}
// Show / hide a base strategy's chart line (and its 9sig sub-series + envelope),
// persisting the choice the same way the legend toggles do.
function setBaseStrategyVisibility(type, visible) {
  if (typeof chart === 'undefined' || !chart) return;
  const idx = (typeof PANEL_IDX_BY_KEY !== 'undefined') ? PANEL_IDX_BY_KEY[type] : null;
  if (idx == null) return;
  chart.setDatasetVisibility(idx, visible);
  if (!visible && typeof SUB_LEGEND !== 'undefined' && SUB_LEGEND[idx]) {
    for (const s of SUB_LEGEND[idx]) chart.setDatasetVisibility(s, false);
  }
  if (typeof syncEnvelopeVisibility === 'function') syncEnvelopeVisibility();
  if (typeof saveSliders === 'function') saveSliders();
}
// While a saved (non-custom) strategy is open in the shared sidebar, mirror the
// live control values into it on every render — so its line updates the instant
// the user changes a dropdown, with no separate "Update" step. The NAME is left
// alone (it doesn't track the params). Custom strategies edit their own params
// directly, so they're skipped here.
function syncEditingConfig() {
  const id = window._editingConfigId;
  if (!id) return;
  const cfg = savedConfigs.find(c => c.id === id);
  if (!cfg || cfg.type === 'custom' || !CONFIG_PARAM_IDS[cfg.type]) return;
  const next = captureParams(cfg.type);
  let changed = false;
  for (const k of CONFIG_PARAM_IDS[cfg.type]) {
    if (String((cfg.params || {})[k]) !== String(next[k])) { changed = true; break; }
  }
  if (!changed) return;
  cfg.params = next;
  persistSavedConfigs();
}

// --- base line vs. saved strategy: keep them from mixing ----------------
// The top pills (9sig / SMA / B&H / Invested) are FIXED canonical references.
// While a saved strategy is open for editing, the live sidebar controls belong
// to THAT strategy's line, not the base. So just before render() simulates the
// base line we swap the edited type's knob controls to their canonical (HTML
// default) values, then put the user's edits straight back afterwards. The swap
// is fully synchronous (no repaint in between) so the sidebar never flickers,
// and the saved-strategy line is computed from cfg.params — never the controls —
// so it keeps showing the edits. Net effect: editing a saved 9sig moves only the
// saved line; the canonical 9sig line stays put.
let _baseFreezeSnapshot = null;
function freezeBaseForEditing() {
  _baseFreezeSnapshot = null;
  // The ONE base type currently being drafted — its panel open AND we're not
  // editing a saved strategy — keeps its live controls (that's the draft line).
  // EVERY other base type is a fixed canonical reference, so swap its knobs to
  // canonical for the base-line sim. This covers: editing a saved base strategy
  // (freeze that type), editing a CUSTOM strategy (freeze all — no base draft),
  // and idle (freeze all → bases never show leftover params from a prior edit).
  const draftType = (!window._editingConfigId && typeof getOpenPanelKey === 'function')
    ? getOpenPanelKey() : null;
  const snap = {};
  for (const type in CONFIG_PARAM_IDS) {
    if (type === draftType) continue; // active draft keeps its live controls
    for (const cid of CONFIG_PARAM_IDS[type]) {
      if (cid in snap) continue;
      const el = document.getElementById(cid);
      if (!el) continue;
      const def = CANONICAL_DEFAULTS[cid];
      if (def == null) continue;
      snap[cid] = (el.type === 'checkbox') ? el.checked : el.value;
      if (el.type === 'checkbox') el.checked = (def === '1');
      else el.value = def;
    }
  }
  _baseFreezeSnapshot = Object.keys(snap).length ? snap : null;
}
function restoreBaseAfterEditing() {
  if (!_baseFreezeSnapshot) return;
  const snap = _baseFreezeSnapshot;
  _baseFreezeSnapshot = null;
  for (const cid in snap) {
    const el = document.getElementById(cid);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = snap[cid];
    else el.value = snap[cid];
  }
}
// Put a base strategy's knob controls back to their canonical defaults. Called
// when a base panel is opened or closed so the base line never inherits leftover
// values from a saved strategy that was previously loaded into the sidebar —
// "open sig tqqq" always starts from a clean canonical copy.
function resetBaseControlsToCanonical(type) {
  if (!CONFIG_PARAM_IDS[type]) return;
  applyParams(type, captureDefaultParams(type));
  if (typeof refresh9sigDisplayLabels === 'function') refresh9sigDisplayLabels();
  if (typeof update9sigCashSpans === 'function') update9sigCashSpans();
  if (typeof updateDeployAvailability === 'function') updateDeployAvailability();
  if (typeof window.refreshPreviewTriggers === 'function') window.refreshPreviewTriggers();
}
// Create a new (empty) custom strategy and open the build modal. The describe →
// prompt → paste flow happens in the modal; the sidebar only shows the result.
function createCustomStrategy() {
  const cfg = {
    id: 'cfg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: 'custom',
    name: uniqueName('Custom strategy'),
    code: '',
    desc: '',
    params: {},
    color: nextConfigColor(),
    hidden: false,
  };
  savedConfigs.push(cfg);
  window._editingConfigId = cfg.id;
  persistSavedConfigs();
  if (typeof render === 'function') render();
  openCustomBuilder(cfg.id, true);
}

// ===== Custom-strategy build modal (describe → generate → paste) =========
let _builderId = null, _builderPhase = 'describe', _builderIsNew = false;
function openCustomBuilder(cfgId, isNew) {
  const cfg = savedConfigs.find(c => c.id === cfgId);
  if (!cfg) return;
  _builderId = cfgId;
  _builderIsNew = !!isNew;
  // New strategies start at "describe"; editing an existing one jumps to the
  // prompt/paste step (it already has code).
  _builderPhase = (isNew || !cfg.code) ? 'describe' : 'generate';
  renderCustomBuilder();
}
function closeCustomBuilder(cancelled) {
  const modal = document.getElementById('custom-builder-modal');
  if (modal) modal.remove();
  const id = _builderId, isNew = _builderIsNew;
  _builderId = null; _builderIsNew = false;
  // Abandoning a brand-new strategy before any code is applied removes it.
  if (cancelled && isNew) {
    const cfg = savedConfigs.find(c => c.id === id);
    if (cfg && !cfg.code) deleteConfig(id);
  }
}
function renderCustomBuilder() {
  const cfg = savedConfigs.find(c => c.id === _builderId);
  if (!cfg) return;
  let modal = document.getElementById('custom-builder-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'sc-modal-overlay';
    modal.id = 'custom-builder-modal';
    document.body.appendChild(modal);
  }
  const err = (window._customErrors || {})[cfg.id];
  let inner;
  if (_builderPhase === 'describe') {
    inner = `
      <div class="builder-modal">
        <div class="sc-modal-title">Describe your strategy</div>
        <div class="wip-note">⚠ Custom strategies are a work in progress — their results may still change.</div>
        <div class="builder-help">In plain English, describe your strategy in as much detail as you can. You can base it on any of these tickers — <b>TQQQ</b>, <b>QLD</b>, <b>QQQ</b>, <b>SPY</b>, <b>QQQ5</b>, <b>SSO</b>, <b>SPXL</b> — plus entry/exit rules, thresholds, and how monthly contributions are handled.</div>
        <textarea id="builder-desc" class="builder-textarea" placeholder="e.g. Hold TQQQ. At each month-end, if QQQ closed below its 200-day moving average, move everything to cash; when it closes back above, buy TQQQ again. Add the monthly contribution to whatever I'm holding.">${_escHtml(cfg.desc || '')}</textarea>
        <div class="builder-actions">
          <button type="button" class="sc-modal-btn" data-builder-cancel>Cancel</button>
          <button type="button" class="sc-modal-btn primary" data-builder-complete>Complete →</button>
        </div>
      </div>`;
  } else {
    inner = `
      <div class="builder-modal">
        <div class="sc-modal-title">Generate &amp; paste</div>
        <div class="builder-help">Copy the prompt, paste it into <b>ChatGPT</b> or <b>Claude</b> and send. Then copy its reply and paste it below.</div>
        <button type="button" class="custom-copy-btn" data-builder-copy>Copy prompt for ChatGPT / Claude</button>
        <div class="builder-step-label">Paste the reply here</div>
        ${(err && cfg.code) ? `<div class="custom-error"><b>Couldn't run it:</b> ${_escHtml(err)}</div>` : ''}
        <textarea id="builder-code" class="builder-textarea code" spellcheck="false" placeholder="Paste the strategy code here…">${_escHtml(cfg.code || '')}</textarea>
        <div class="builder-actions">
          <button type="button" class="sc-modal-btn" data-builder-back>← Back</button>
          <button type="button" class="sc-modal-btn primary" data-builder-apply>Apply &amp; show</button>
        </div>
      </div>`;
  }
  modal.innerHTML = inner;
  const focusEl = modal.querySelector('textarea');
  if (focusEl) focusEl.focus();
}

// Merge saved strategies carried in a share link. Custom code is safe to run
// because it executes in the sandboxed worker. Deduped by content signature so
// reloading the same link doesn't pile up copies.
function importSharedConfigs(arr) {
  if (!Array.isArray(arr)) return;
  const sig = (c) => `${c.type}|${c.name || ''}|${c.code || ''}|${JSON.stringify(c.params || {})}`;
  const existing = new Set(savedConfigs.map(sig));
  for (const c of arr) {
    if (!c || !c.type || existing.has(sig(c))) continue;
    const cfg = {
      id: 'cfg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: c.type,
      // Keep the shared name (it may be a name the author chose); fall back to the
      // plain type label.
      name: uniqueName(c.name || genBaseName(c.type)),
      params: c.params || {},
      color: c.color || nextConfigColor(),
      hidden: !!c.hidden,
      // Transient: shown on the chart this session but NOT written to localStorage.
      // The recipient clicks "Save" on the banner to keep them locally.
      _transient: true,
    };
    if (c.type === 'custom') { cfg.code = c.code || ''; cfg.desc = c.desc || ''; } // safe to run: sandboxed
    savedConfigs.push(cfg);
    existing.add(sig(c));
  }
}

// Convert every currently-transient (share-link) config into a regular saved
// strategy and write to localStorage. Triggered by the "Save" banner button.
function saveSharedStrategies() {
  let changed = false;
  for (const c of savedConfigs) {
    if (c._transient) { delete c._transient; changed = true; }
  }
  if (changed) {
    persistSavedConfigs();
    renderSavedConfigPills();
  }
}

// Green success flash after a save/update. The save bar gets rebuilt by the
// render() above, so we flash the freshly-rendered primary button (briefly
// swapping its label to a checkmark) plus the saved pill in the Parameters
// panel as a second confirmation that it landed there.
function flashSaveSuccess(configId) {
  const btn = document.querySelector('.config-savebar .config-savebar-btn.primary');
  if (btn) {
    const restore = btn.textContent;
    btn.classList.add('flash-success');
    btn.textContent = '✓ Saved';
    setTimeout(() => {
      if (!btn.isConnected) return; // panel rebuilt meanwhile — leave the new button alone
      btn.classList.remove('flash-success');
      btn.textContent = restore;
    }, 1100);
  }
  if (configId) {
    const pill = document.querySelector(`.saved-config-pill[data-config-id="${configId}"]`);
    if (pill) { pill.classList.add('flash-success'); setTimeout(() => pill.classList.remove('flash-success'), 1100); }
  }
}
function deleteConfig(id) {
  savedConfigs = savedConfigs.filter(c => c.id !== id);
  if (window._editingConfigId === id) window._editingConfigId = null;
  // If the deleted strategy's custom editor is open, close the panel.
  if (window._openCustomCfgId === id && typeof closeStrategyPanel === 'function') closeStrategyPanel();
  persistSavedConfigs();
  if (typeof render === 'function') render();
}
// Rename a saved strategy to whatever the user typed (deduped against the others).
function renameConfig(id, name) {
  const cfg = savedConfigs.find(c => c.id === id);
  if (!cfg) return;
  const trimmed = (name || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return;
  const next = uniqueName(trimmed, id);
  if (next === cfg.name) return;
  cfg.name = next;
  persistSavedConfigs();
  if (typeof render === 'function') render();
}
function toggleConfigVisibility(id) {
  const cfg = savedConfigs.find(c => c.id === id);
  if (!cfg) return;
  cfg.hidden = !cfg.hidden;
  persistSavedConfigs();
  // Full re-render so the strategy's main line AND its alternate-runs band
  // (created only while visible) appear/disappear together.
  if (typeof render === 'function') render();
  else renderSavedConfigPills();
}
// Load a saved config into the shared sidebar controls and open its panel for
// editing. The base/live strategy of the same type now reflects these numbers
// (shared-sidebar model) — the config's own frozen line still shows the
// last-saved version until the user hits Update.
function openConfigForEdit(id) {
  const cfg = savedConfigs.find(c => c.id === id);
  if (!cfg) return;
  window._pendingConfigName = null;
  // Custom strategies have their own panel (code editor + generated controls).
  if (cfg.type === 'custom') {
    window._editingConfigId = id;
    if (typeof openCustomPanel === 'function') openCustomPanel(id);
    return;
  }
  applyParams(cfg.type, cfg.params);
  if (typeof refresh9sigDisplayLabels === 'function') refresh9sigDisplayLabels();
  if (typeof update9sigCashSpans === 'function') update9sigCashSpans();
  if (typeof updateDeployAvailability === 'function') updateDeployAvailability();
  if (typeof saveSliders === 'function') saveSliders();
  window._editingConfigId = id;
  if (typeof render === 'function') render();
  if (typeof window.refreshPreviewTriggers === 'function') window.refreshPreviewTriggers();
  if (typeof openPanelByKey === 'function') openPanelByKey(cfg.type);
  // openStrategyPanel sets the title to the base strategy label — override it
  // with the saved strategy's own (auto-derived) name.
  setPanelTitle(cfg.name);
}

// --- editable panel title (= strategy name) ----------------------------
// The name is free-form: whatever the user types becomes the strategy's name.
// It never changes on its own when parameters are tweaked.
function setPanelTitle(text) {
  const el = document.getElementById('strategy-panel-title');
  if (el && el.textContent !== text) el.textContent = text;
}
function commitPanelTitle(text) {
  const name = (text || '').replace(/\s+/g, ' ').trim();
  if (window._editingConfigId) {
    const cfg = savedConfigs.find(c => c.id === window._editingConfigId);
    if (cfg) {
      if (name) { renameConfig(cfg.id, name); setPanelTitle(cfg.name); }
      else setPanelTitle(cfg.name); // empty → revert to existing name
    }
  } else {
    // Editing a base strategy that isn't saved yet — remember the typed name so
    // the next "Save as strategy" uses it.
    window._pendingConfigName = name || null;
  }
}
function focusPanelTitle() {
  const el = document.getElementById('strategy-panel-title');
  if (!el) return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
(function wirePanelTitle() {
  const el = document.getElementById('strategy-panel-title');
  if (!el) return;
  let focusValue = '';
  el.addEventListener('focus', () => { focusValue = el.textContent; });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); el.textContent = focusValue; el.blur(); }
  });
  el.addEventListener('blur', () => commitPanelTitle(el.textContent));
  const pencil = document.getElementById('strategy-panel-title-edit');
  if (pencil) pencil.addEventListener('click', focusPanelTitle);
})();

// --- in-sidebar save bar (rendered by renderStrategyPanelBody) ---------
function buildPanelSaveBarHtml(type) {
  if (!CONFIG_PARAM_IDS[type]) return '';
  // Editing a SAVED strategy auto-saves live (see syncEditingConfig) and can't be
  // forked — so it shows no save button. Only the main/base strategy offers
  // "Save as strategy", which spins off a new saved strategy.
  const editingSaved = window._editingConfigId
    && savedConfigs.find(c => c.id === window._editingConfigId && c.type === type);
  if (editingSaved) return '';
  return `
    <div class="config-savebar">
      <button type="button" class="config-savebar-btn primary" data-sc-savenew="${type}" title="Save the current settings as a new saved strategy">Save as strategy</button>
    </div>`;
}

// --- Parameters-panel pill list ----------------------------------------
function buildConfigPillHtml(cfg) {
  const m = (window._configMetrics || {})[cfg.id] || {};
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hidden = !!cfg.hidden;
  let metrics = '';
  if (Number.isFinite(m.cagr)) {
    const cagrSign = m.cagr >= 0 ? '+' : '';
    const cagrCls = m.cagr >= 0 ? 'positive' : 'negative';
    const ddStr = Number.isFinite(m.maxDD) ? (m.maxDD > 0 ? `−${m.maxDD.toFixed(1)}%` : '0.0%') : '';
    metrics = `
      <div class="sc-metrics">
        <span class="sc-metric"><span class="sc-metric-label">CAGR</span> <span class="sc-metric-value ${cagrCls}">${cagrSign}${m.cagr.toFixed(1)}%</span></span>
        ${ddStr ? `<span class="sc-metric"><span class="sc-metric-label">DD</span> <span class="sc-metric-value negative">${ddStr}</span></span>` : ''}
      </div>`;
  }
  const eyeSvg = hidden
    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
    : '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>';
  return `
    <div class="saved-config-pill${hidden ? ' is-hidden' : ''}" data-config-id="${cfg.id}" draggable="true" title="Click to show / hide on chart">
      <div class="sc-top">
        <span class="sc-handle-col">
          <button type="button" class="sc-eye" aria-label="Toggle visibility" title="Show / hide on chart">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${eyeSvg}</svg>
          </button>
          <span class="sc-drag" aria-label="Drag to reorder" title="Drag to reorder">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>
          </span>
        </span>
        <span class="sc-dot" style="background:${cfg.color}"></span>
        <span class="sc-name">${esc(cfg.name)}</span>
        ${cfg.type === 'custom' ? `<span class="sc-badge" title="Custom strategy (runs in a sandbox)">ƒ</span>` : ''}
        <div class="sc-actions">
          <button type="button" class="sc-edit" title="Edit in sidebar" aria-label="Edit">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button type="button" class="sc-delete" title="Delete strategy" aria-label="Delete">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      ${metrics}
    </div>`;
}
function renderSavedConfigPills() {
  const host = document.getElementById('saved-configs');
  if (!host) return;
  if (!savedConfigs.length) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;
  // Shared-link configs aren't auto-saved — they're only kept locally if the
  // user clicks "Save" on this banner. (Without the click they'll disappear
  // when the recipient leaves the page; with it they're written to localStorage
  // like any other saved strategy.)
  const transientN = savedConfigs.reduce((n, c) => n + (c._transient ? 1 : 0), 0);
  const banner = transientN > 0 ? `
    <div class="shared-strategies-banner">
      <span class="ssb-text">${transientN} shared strateg${transientN === 1 ? 'y' : 'ies'} from the link — won't be kept unless you save.</span>
      <button type="button" class="ssb-save" id="save-shared-strategies">Save${transientN > 1 ? ' all' : ''}</button>
    </div>` : '';
  host.innerHTML = `
    <div class="saved-configs-label">Saved strategies</div>
    ${banner}
    <div class="saved-configs-list">${savedConfigs.map(buildConfigPillHtml).join('')}</div>`;
  setupConfigDragReorder();
}

// Which pill the dragged one should land before, given the cursor's Y. Returns
// the first pill whose vertical midpoint sits below the cursor (null = append).
function _dragAfterPill(list, y) {
  const els = [...list.querySelectorAll('.saved-config-pill:not(.dragging)')];
  let closest = null, closestOffset = -Infinity;
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = el; }
  }
  return closest;
}

// Commit a new saved-strategy order (array of config ids) → reorder savedConfigs,
// persist, and redraw the chart (dataset/legend order follows savedConfigs).
function reorderSavedConfigs(idOrder) {
  const byId = new Map(savedConfigs.map(c => [c.id, c]));
  const next = [];
  for (const id of idOrder) { const c = byId.get(id); if (c) { next.push(c); byId.delete(id); } }
  for (const c of savedConfigs) if (byId.has(c.id)) next.push(c); // safety: keep any stragglers
  const changed = next.length !== savedConfigs.length || next.some((c, i) => c !== savedConfigs[i]);
  if (!changed) return;
  savedConfigs = next;
  persistSavedConfigs();
  if (typeof render === 'function') render();
  renderSavedConfigPills();
}

// Drag-to-reorder for the saved-strategy list. Wired once on the stable host
// (delegation survives innerHTML rebuilds). Dragging is gated to the grip handle
// so clicking a pill still toggles its visibility. The dragged pill is moved in
// the DOM live during dragover; the new order is committed on drop.
function setupConfigDragReorder() {
  const host = document.getElementById('saved-configs');
  if (!host || host._dragWired) return;
  host._dragWired = true;
  let fromHandle = false;
  host.addEventListener('mousedown', (e) => { fromHandle = !!(e.target.closest && e.target.closest('.sc-drag')); });
  host.addEventListener('dragstart', (e) => {
    const pill = e.target.closest && e.target.closest('.saved-config-pill');
    if (!pill || !fromHandle) { e.preventDefault(); return; } // only the grip starts a drag
    pill.classList.add('dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', pill.dataset.configId); } catch (_) {} }
  });
  host.addEventListener('dragover', (e) => {
    const list = host.querySelector('.saved-configs-list');
    const dragging = list && list.querySelector('.saved-config-pill.dragging');
    if (!dragging) return;
    e.preventDefault();
    const after = _dragAfterPill(list, e.clientY);
    if (after == null) { if (list.lastElementChild !== dragging) list.appendChild(dragging); }
    else if (after !== dragging) list.insertBefore(dragging, after);
  });
  host.addEventListener('drop', (e) => { if (host.querySelector('.saved-config-pill.dragging')) e.preventDefault(); });
  host.addEventListener('dragend', () => {
    fromHandle = false;
    const list = host.querySelector('.saved-configs-list');
    if (!list) return;
    const dragging = list.querySelector('.saved-config-pill.dragging');
    if (dragging) dragging.classList.remove('dragging');
    reorderSavedConfigs([...list.querySelectorAll('.saved-config-pill')].map(el => el.dataset.configId));
  });
}

// --- custom strategy sidebar -------------------------------------------
const _escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Normalize a param's choices into [{ value, label }]. Supports an explicit
// options list, a true/false toggle, or a min/max/step range (sampled to ≤24).
function customParamOptions(sp) {
  if (Array.isArray(sp.options) && sp.options.length) {
    return sp.options.map(o => (o && typeof o === 'object')
      ? { value: o.value, label: (o.label != null ? o.label : o.value) }
      : { value: o, label: o });
  }
  if (sp.type === 'bool' || sp.type === 'boolean') {
    return [{ value: true, label: 'Yes' }, { value: false, label: 'No' }];
  }
  if (('min' in sp) || ('max' in sp) || sp.type === 'number') {
    let min = Number(sp.min), max = Number(sp.max), step = Number(sp.step);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = min + 10;
    if (!Number.isFinite(step) || step <= 0) step = (max - min) / 10 || 1;
    let n = Math.floor((max - min) / step) + 1;
    if (n > 24) { step = (max - min) / 23; n = 24; }
    if (n < 1) n = 1;
    const out = [];
    for (let i = 0; i < n; i++) { const v = +(min + i * step).toFixed(6); out.push({ value: v, label: String(v) }); }
    return out;
  }
  return [{ value: sp.default, label: String(sp.default) }];
}
function customOptionLabel(sp, val) {
  const m = customParamOptions(sp).find(o => String(o.value) === String(val));
  return m ? String(m.label) : String(val);
}
// Each param is a bar-preview dropdown (same look as the 9sig selectors): the
// popup runs the strategy once per option (in the sandbox) and shows each
// option's resulting final value as a proportional bar.
function buildCustomControlsHtml(cfg, schema) {
  if (!schema || !schema.length) return '';
  const rows = schema.map(sp => {
    if (!sp || sp.id == null) return '';
    const label = _escHtml(sp.label || sp.id);
    const curLabel = _escHtml(customOptionLabel(sp, customParamValue(cfg, sp)));
    return `<div class="custom-param-row">
      <label>${label}</label>
      <button type="button" class="pdrop-trigger inline-select cp-trigger" data-cp-cfg="${_escHtml(cfg.id)}" data-cp-id="${_escHtml(sp.id)}">
        <span class="pdrop-trigger-label">${curLabel}</span><span class="pdrop-caret">▾</span>
      </button>
    </div>`;
  }).join('');
  return `<div class="custom-params">${rows}</div>`;
}

// ---- bar-preview popup for a custom param ------------------------------
let _cpOpen = null; // { trigger, popup, cfgId, paramId }
window._customPreviewCache = window._customPreviewCache || {}; // key -> final value

function positionCpPopup(popup, trigger) {
  const r = trigger.getBoundingClientRect();
  const pw = Math.max(r.width, 240);
  let left = r.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  if (left < 8) left = 8;
  popup.style.left = left + 'px';
  popup.style.minWidth = pw + 'px';
  const below = window.innerHeight - r.bottom - 8;
  if (below < 180 && r.top > below) {
    popup.style.top = ''; popup.style.bottom = (window.innerHeight - r.top + 4) + 'px';
    popup.style.maxHeight = Math.min(340, r.top - 8) + 'px';
  } else {
    popup.style.bottom = ''; popup.style.top = (r.bottom + 4) + 'px';
    popup.style.maxHeight = Math.min(340, below) + 'px';
  }
}
function closeCustomParamPopup() {
  if (!_cpOpen) return;
  _cpOpen.popup.remove();
  _cpOpen.trigger.classList.remove('pdrop-open');
  _cpOpen = null;
  document.removeEventListener('mousedown', _cpDocDown, true);
  document.removeEventListener('keydown', _cpKeyDown, true);
  window.removeEventListener('resize', _cpReposition);
  window.removeEventListener('scroll', _cpReposition, true);
}
function _cpReposition() { if (_cpOpen) positionCpPopup(_cpOpen.popup, _cpOpen.trigger); }
function _cpKeyDown(e) { if (e.key === 'Escape') closeCustomParamPopup(); }
function _cpDocDown(e) {
  if (_cpOpen && !_cpOpen.popup.contains(e.target) && e.target !== _cpOpen.trigger && !_cpOpen.trigger.contains(e.target)) closeCustomParamPopup();
}
function openCustomParamPopup(trigger, cfg, sp) {
  if (_cpOpen && _cpOpen.trigger === trigger) { closeCustomParamPopup(); return; }
  closeCustomParamPopup();
  const opts = customParamOptions(sp);
  const cur = customParamValue(cfg, sp);
  const popup = document.createElement('div');
  popup.className = 'pdrop-popup';
  popup.innerHTML = `<div class="pdrop-head">final value if chosen</div>` + opts.map((o, i) =>
    `<div class="pdrop-row${String(o.value) === String(cur) ? ' selected' : ''}" data-cp-i="${i}">
       <span class="pdrop-rlabel">${_escHtml(o.label)}</span>
       <span class="pdrop-track"><span class="pdrop-fill"></span></span>
       <span class="pdrop-rval">…</span>
     </div>`).join('');
  document.body.appendChild(popup);
  let maxW = 0; popup.querySelectorAll('.pdrop-rlabel').forEach(el => { maxW = Math.max(maxW, el.offsetWidth); });
  if (maxW > 0) popup.style.setProperty('--pdrop-label-w', Math.ceil(maxW) + 'px');
  positionCpPopup(popup, trigger);
  trigger.classList.add('pdrop-open');
  _cpOpen = { trigger, popup, cfgId: cfg.id, paramId: sp.id };
  popup.addEventListener('click', (e) => {
    const row = e.target.closest('.pdrop-row'); if (!row) return;
    const i = +row.getAttribute('data-cp-i');
    const o = opts[i]; if (!o) return;
    const c = savedConfigs.find(x => x.id === cfg.id);
    if (c) { c.params = c.params || {}; c.params[sp.id] = (typeof o.value === 'boolean') ? o.value : String(o.value); persistSavedConfigs(); if (typeof render === 'function') render(); }
    closeCustomParamPopup();
  });
  const sel = popup.querySelector('.pdrop-row.selected');
  if (sel) popup.scrollTop = Math.max(0, sel.offsetTop - (popup.clientHeight - sel.offsetHeight) / 2);
  document.addEventListener('mousedown', _cpDocDown, true);
  document.addEventListener('keydown', _cpKeyDown, true);
  window.addEventListener('resize', _cpReposition);
  window.addEventListener('scroll', _cpReposition, true);
  computeCustomParamBars(cfg, sp, opts, popup);
}
// Run the strategy once per option (in the sandbox) and draw the bars.
function computeCustomParamBars(cfg, sp, opts, popup) {
  const ctx = window._customCtx;
  if (!ctx || !cfg.code) return;
  const globals = computeCustomGlobals(cfg, ctx);
  const finals = new Array(opts.length).fill(null);
  let remaining = opts.length;
  const done = () => { if (_cpOpen && _cpOpen.popup === popup) cpFillBars(popup, finals); };
  opts.forEach((o, i) => {
    const overrides = {}; overrides[sp.id] = (typeof o.value === 'boolean') ? o.value : String(o.value);
    const merged = Object.assign({}, cfg.params || {}, overrides);
    const key = [cfg.code, JSON.stringify(merged), globals.startIdx, globals.endIdx, globals.initial, globals.monthly, globals.annualRaise].join('');
    const cached = window._customPreviewCache[key];
    if (cached != null) { finals[i] = cached; if (--remaining === 0) done(); return; }
    runCustomPreview(cfg, overrides, globals, (msg) => {
      let fv = 0;
      if (msg && msg.log && msg.log.length) {
        for (let k = msg.log.length - 1; k >= 0; k--) { const v = msg.log[k].value; if (typeof v === 'number' && isFinite(v)) { fv = v; break; } }
      }
      window._customPreviewCache[key] = fv;
      finals[i] = fv;
      if (--remaining === 0) done();
    });
  });
}
function cpFillBars(popup, finals) {
  const rows = Array.from(popup.querySelectorAll('.pdrop-row'));
  const maxT = Math.max(0, ...finals.map(f => f || 0));
  const bestIdx = finals.indexOf(maxT);
  rows.forEach((row, i) => {
    const t = finals[i] || 0;
    const pct = maxT > 0 ? Math.max(1.5, (t / maxT) * 100) : 0;
    const fill = row.querySelector('.pdrop-fill'); const val = row.querySelector('.pdrop-rval');
    if (fill) fill.style.width = pct + '%';
    if (val) val.textContent = (typeof fmt === 'function') ? fmt(Math.round(t)) : String(Math.round(t));
    if (i === bestIdx && maxT > 0) row.classList.add('best');
  });
}

function buildCustomLogTableHtml(log) {
  if (!log || !log.length) return '';
  // Column order: date, value, then any extra keys in first-seen order.
  const keys = [];
  const seen = new Set();
  for (const row of log) { if (!row) continue; for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); keys.push(k); } }
  const rank = (k) => (k === 'date' ? 0 : k === 'value' ? 1 : 2);
  keys.sort((a, b) => rank(a) - rank(b) || 0);
  const fmtCell = (k, v) => {
    if (v == null || v === '') return '';
    if (k === 'date') return (typeof fmtLogDate === 'function') ? fmtLogDate(String(v)) : String(v);
    if (typeof v === 'number') {
      const lk = k.toLowerCase();
      if (lk.includes('price')) return (typeof fmtLogPrice === 'function') ? fmtLogPrice(v) : '$' + v.toFixed(2);
      if (lk.includes('share') || lk.includes('unit') || lk.includes('qty')) return (typeof fmtLogShares === 'function') ? fmtLogShares(v) : String(+v.toFixed(2));
      if ((lk.includes('contrib') || lk.includes('deposit')) && v === 0) return ''; // hide non-contribution rows' 0
      return (typeof fmtFull === 'function') ? fmtFull(v) : String(Math.round(v));
    }
    return _escHtml(v);
  };
  const title = (k) => k === 'value' ? 'Value' : k === 'price' ? 'Price' : k.charAt(0).toUpperCase() + k.slice(1);
  const head = keys.map(k => `<th>${_escHtml(title(k))}</th>`).join('');
  const body = log.map(row => `<tr>${keys.map(k => `<td>${fmtCell(k, row ? row[k] : null)}</td>`).join('')}</tr>`).join('');
  return `
    <div class="strategy-panel-section-label" style="margin-top:18px">Log (${log.length} rows)</div>
    <div class="custom-log-wrap"><table class="custom-log"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Sidebar for a custom strategy — focuses on the RESULT (settings + an Edit
// button that reopens the build modal). The describe/prompt/paste flow lives in
// the modal, not here.
function renderCustomPanelBody(cfgId) {
  const body = document.getElementById('strategy-panel-body');
  if (!body) return;
  const cfg = savedConfigs.find(c => c.id === cfgId);
  if (!cfg) return;
  // A base panel may have injected its live controls (e.g. the 9sig knobs) into
  // the body. Move them back to their hidden host BEFORE we overwrite innerHTML —
  // otherwise they're destroyed, and render() then reads null and falls back to
  // wrong defaults, so the main 9sig line stops resetting correctly.
  if (typeof detachLiveControls === 'function') detachLiveControls();
  const _scrollTop = body.scrollTop;
  const err = (window._customErrors || {})[cfgId];

  let html = '';

  html += `<div class="wip-note">⚠ Custom strategies are a work in progress — their results may still change.</div>`;
  html += `<div class="custom-tickers-note">Your strategy can read these tickers: <code>tqqq</code>, <code>qld</code>, <code>qqq</code>, <code>spy</code>, <code>qqq5</code>, <code>sso</code>, <code>spxl</code> (daily closes). Base your rules on any of them.</div>`;
  html += `<button type="button" id="custom-edit-builder" class="custom-edit-btn">Edit strategy</button>`;
  if (cfg.desc) html += `<div class="custom-desc-readout">${_escHtml(cfg.desc)}</div>`;
  if (err) html += `<div class="custom-error"><b>Couldn't run it:</b> ${_escHtml(err)} <span class="custom-error-hint">— click Edit strategy to fix the code.</span></div>`;

  // CAGR / Max DD / End (when the strategy ran successfully).
  const m = (window._configMetrics || {})[cfgId];
  if (!err && m && Number.isFinite(m.cagr)) {
    const cagrCls = m.cagr >= 0 ? 'positive' : 'negative';
    const ddStr = Number.isFinite(m.maxDD) ? (m.maxDD > 0 ? `−${m.maxDD.toFixed(1)}%` : '0.0%') : '—';
    html += `
      <div class="custom-stats">
        <div class="custom-stat"><span>CAGR</span><b class="${cagrCls}">${m.cagr >= 0 ? '+' : ''}${m.cagr.toFixed(1)}%</b></div>
        <div class="custom-stat"><span>Max DD</span><b class="negative">${ddStr}</b></div>
        <div class="custom-stat"><span>End</span><b>${(typeof fmtFull === 'function') ? fmtFull(m.end || 0) : Math.round(m.end || 0)}</b></div>
      </div>`;
  }

  // Generated controls from the strategy's `params` (what it declared configurable).
  // Each change is passed back into run() as p.<id>.
  const controls = buildCustomControlsHtml(cfg, getCustomSchema(cfg));
  if (controls) html += `<div class="strategy-panel-section-label" style="margin-top:14px">Settings</div>${controls}`;

  // The strategy's own log (whatever its run() returned), as a table.
  html += buildCustomLogTableHtml((window._customLogs || {})[cfgId] || []);

  body.innerHTML = html;
  body.scrollTop = _scrollTop;
}

// --- styled delete confirmation (replaces the native confirm()) --------
function showDeleteDialog(cfg) {
  closeDeleteDialog();
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const overlay = document.createElement('div');
  overlay.className = 'sc-modal-overlay';
  overlay.id = 'sc-delete-modal';
  overlay._configId = cfg.id;
  overlay.innerHTML = `
    <div class="sc-modal" role="dialog" aria-modal="true" aria-labelledby="sc-modal-title">
      <div class="sc-modal-title" id="sc-modal-title">Delete strategy</div>
      <div class="sc-modal-body">Delete “<b>${esc(cfg.name)}</b>”? This can’t be undone.</div>
      <div class="sc-modal-actions">
        <button type="button" class="sc-modal-btn" data-sc-cancel>Cancel</button>
        <button type="button" class="sc-modal-btn danger" data-sc-confirm>Delete</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const cancel = overlay.querySelector('[data-sc-cancel]');
  if (cancel) cancel.focus();
}
function closeDeleteDialog() {
  const m = document.getElementById('sc-delete-modal');
  if (m) m.remove();
}

// --- styled unsaved-changes confirmation (panel close with dirty knobs) -
function showUnsavedDialog(type, onSave, onDiscard) {
  closeUnsavedDialog();
  const label = (typeof genBaseName === 'function') ? genBaseName(type) : type;
  const overlay = document.createElement('div');
  overlay.className = 'sc-modal-overlay';
  overlay.id = 'sc-unsaved-modal';
  overlay.innerHTML = `
    <div class="sc-modal" role="dialog" aria-modal="true" aria-labelledby="sc-unsaved-title">
      <div class="sc-modal-title" id="sc-unsaved-title">Save changes?</div>
      <div class="sc-modal-body">You’ve edited the <b>${label}</b> strategy. The base strategy doesn’t persist edits — closing will reset it to defaults. Save your changes as a new strategy first?</div>
      <div class="sc-modal-actions">
        <button type="button" class="sc-modal-btn" data-sc-unsaved-discard>Close</button>
        <button type="button" class="sc-modal-btn primary" data-sc-unsaved-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-sc-unsaved-save]').addEventListener('click', () => { closeUnsavedDialog(); if (onSave) onSave(); });
  overlay.querySelector('[data-sc-unsaved-discard]').addEventListener('click', () => { closeUnsavedDialog(); if (onDiscard) onDiscard(); });
  const save = overlay.querySelector('[data-sc-unsaved-save]');
  if (save) save.focus();
}
function closeUnsavedDialog() {
  const m = document.getElementById('sc-unsaved-modal');
  if (m) m.remove();
}

// Esc closes the dialog. Capture phase + stopImmediatePropagation so it wins
// over the strategy-panel's own Esc handler.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('sc-delete-modal')) { e.stopImmediatePropagation(); closeDeleteDialog(); return; }
  if (document.getElementById('sc-unsaved-modal')) { e.stopImmediatePropagation(); closeUnsavedDialog(); return; }
  if (document.getElementById('custom-builder-modal')) { e.stopImmediatePropagation(); closeCustomBuilder(true); return; }
}, true);

// --- delegated event handling ------------------------------------------
// Hex field in the custom colour popup → live preview when it's a valid colour.
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'lc-hex') {
    const h = normHex(e.target.value);
    if (h) { applyColorPreview(h); setColorUI(h); }
  }
});


document.addEventListener('click', (e) => {
  const tgt = e.target;
  if (!tgt || !tgt.closest) return;
  // "Save shared strategies" banner — persists the share-link strategies that
  // are currently transient (rendering on the chart but not in localStorage).
  if (tgt.closest('#save-shared-strategies')) { saveSharedStrategies(); return; }
  // Sub-series chip for a saved 9sig → toggle that strategy's own Holding/Target/
  // Cash line (persisted on the config, so it never flips to the canonical base).
  const subChip = tgt.closest('.cfg-sub-chip');
  if (subChip) {
    const cfg = savedConfigs.find(c => c.id === subChip.getAttribute('data-config-id'));
    const key = subChip.getAttribute('data-config-sub');
    if (cfg && key) {
      cfg.subShown = cfg.subShown || {};
      cfg.subShown[key] = !cfg.subShown[key];
      persistSavedConfigs();
      if (typeof render === 'function') render();
    }
    return;
  }
  // Delete-confirmation modal.
  if (tgt.closest('[data-sc-confirm]')) {
    const m = document.getElementById('sc-delete-modal');
    const id = m && m._configId;
    closeDeleteDialog();
    if (id) deleteConfig(id);
    return;
  }
  if (tgt.closest('[data-sc-cancel]')) { closeDeleteDialog(); return; }
  if (tgt.closest('#sc-delete-modal')) { if (!tgt.closest('.sc-modal')) closeDeleteDialog(); return; }
  // Custom line-color popup. Picking a swatch applies it immediately and closes
  // the popup; the hex field still previews live and commits via OK.
  const pop = document.getElementById('line-color-pop');
  const popOpen = pop && !pop.hidden;
  if (tgt.closest('#line-color-trigger')) { popOpen ? closeColorPopup(true) : openColorPopup(); return; }
  if (popOpen) {
    const sw = tgt.closest('#line-color-pop .lc-swatch');
    if (sw) { const c = sw.dataset.color; closeColorPopup(false); commitLineColor(c); return; }
    if (tgt.closest('#lc-ok')) {
      const inp = document.getElementById('lc-hex');
      const hex = normHex(inp && inp.value) || _colorPickerOriginal || activeLineColor();
      closeColorPopup(false);
      commitLineColor(hex);
      return;
    }
    if (tgt.closest('#line-color-pop')) return; // click inside popup (hex field, etc.)
    closeColorPopup(true); // click anywhere outside → cancel + revert
    return;
  }
  // Bar-preview dropdown for a custom param.
  const cpTrig = tgt.closest('.cp-trigger');
  if (cpTrig) {
    const cfg = savedConfigs.find(c => c.id === cpTrig.getAttribute('data-cp-cfg'));
    const sp = cfg && getCustomSchema(cfg).find(s => s && String(s.id) === cpTrig.getAttribute('data-cp-id'));
    if (cfg && sp) openCustomParamPopup(cpTrig, cfg, sp);
    return;
  }
  // New custom strategy → open the build modal.
  if (tgt.closest('#new-custom-strategy')) { createCustomStrategy(); return; }
  // Sidebar "Edit strategy" → reopen the build modal for the open custom strategy.
  if (tgt.closest('#custom-edit-builder')) {
    if (window._editingConfigId) openCustomBuilder(window._editingConfigId, false);
    return;
  }
  // Build modal: cancel / complete / back / copy prompt / apply.
  if (tgt.closest('[data-builder-cancel]')) { closeCustomBuilder(true); return; }
  if (tgt.closest('[data-builder-complete]')) {
    const cfg = savedConfigs.find(c => c.id === _builderId);
    const d = document.getElementById('builder-desc');
    if (cfg) { cfg.desc = d ? d.value : ''; persistSavedConfigs(); }
    _builderPhase = 'generate';
    renderCustomBuilder();
    return;
  }
  if (tgt.closest('[data-builder-back]')) {
    const cfg = savedConfigs.find(c => c.id === _builderId);
    const c = document.getElementById('builder-code');
    if (cfg && c) { cfg.code = c.value; persistSavedConfigs(); } // keep the draft
    _builderPhase = 'describe';
    renderCustomBuilder();
    return;
  }
  const bCopy = tgt.closest('[data-builder-copy]');
  if (bCopy) {
    const cfg = savedConfigs.find(c => c.id === _builderId);
    const promptText = buildCustomPrompt(cfg ? cfg.desc : '');
    const done = () => {
      bCopy.textContent = 'Copied ✓ — paste into ChatGPT / Claude';
      bCopy.classList.add('flash-success');
      setTimeout(() => { if (bCopy.isConnected) { bCopy.textContent = 'Copy prompt for ChatGPT / Claude'; bCopy.classList.remove('flash-success'); } }, 2400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(promptText).then(done).catch(() => window.prompt('Copy this prompt:', promptText));
    else window.prompt('Copy this prompt:', promptText);
    return;
  }
  if (tgt.closest('[data-builder-apply]')) {
    const cfg = savedConfigs.find(c => c.id === _builderId);
    const c = document.getElementById('builder-code');
    if (!cfg || !c) return;
    cfg.code = c.value;
    persistSavedConfigs();
    const id = cfg.id;
    closeCustomBuilder(false);
    if (typeof render === 'function') render();                      // schedules the sandboxed run
    if (typeof openCustomPanel === 'function') openCustomPanel(id);  // sidebar shows the line/log (or an error) when it returns
    return;
  }

  // In-sidebar save bar.
  const savenew = e.target.closest('[data-sc-savenew]');
  if (savenew) { saveConfigFromType(savenew.getAttribute('data-sc-savenew')); return; }

  // Parameters-panel config pills.
  const pill = e.target.closest('.saved-config-pill');
  if (!pill) return;
  const id = pill.dataset.configId;
  if (e.target.closest('.sc-drag'))   return; // drag handle: reorder only, never toggle
  if (e.target.closest('.sc-edit'))   { openConfigForEdit(id); return; }
  if (e.target.closest('.sc-delete')) {
    const cfg = savedConfigs.find(c => c.id === id);
    if (cfg) showDeleteDialog(cfg);
    return;
  }
  // Like the top legend chips: clicking anywhere else on the pill — including
  // the name — toggles the line's visibility. Names are auto-derived from the
  // strategy's parameters, so there's nothing to rename.
  toggleConfigVisibility(id);
});
