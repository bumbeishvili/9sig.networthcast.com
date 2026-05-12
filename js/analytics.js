// Analytics dashboard. First chart is a (period × ending year) heatmap of a
// chosen strategy's final value. Coloring is derived from the cell value's
// ratio to the "invested-compounded" baseline — i.e., what the same money
// would have grown to if just left in cash earning the configured rate.
//   derived = cellValue / investedCompounded     (≥ 1 = beat cash, < 1 = lost)
// Globally (across all cells, all columns) we find max(log(derived)) and
// min(log(derived)). Each cell's intensity sits on a diverging scale:
//   derived = 1   → 0.5 (neutral slate, break-even)
//   derived ↑     → toward 1   (green, beat baseline)
//   derived ↓     → toward 0   (red, lost vs baseline)
// Because the divider is the *same* number that already appears on the main
// chart's "Invested Compounded" line, cells are directly comparable across
// columns of very different absolute scale.

// Heatmap period columns: full data range. With 1938→present data this
// is ~88 columns and naturally grows by 1 each year. The per-row sim
// optimization keeps build time linear in years, so even at the maximum
// triangular cell count (~years²/2) the build stays fast.

// === STRATEGY_REGISTRY ====================================================
// Single source of truth for everything strategy-shaped: label, where its
// per-quarter array lives in a `simulate()` result, how to project a scalar
// value out of one of those records, whether it skips the entry quarter
// (BH variants do — they start at qi=1), and the earliest quarterly index
// for which it has usable data (used to clamp the date-range slider and the
// heatmap when a limited-history strategy is active).
//
// Adding a new strategy is one row here + the simulate logic. No more
// editing six parallel switch statements.
//
// Notes on the points shape per strategy:
//   '9sig'      → sim.log[i].total           (also adopts log's other fields)
//   'bh-*'      → sim.{bh,qqq,spy,soxl}Points[i].value, skips entry quarter
//   'sma'       → sim.smaPoints[i].value, includes entry, has .state
//   'adaptive'  → sim.adaptivePoints[i].value, includes entry, has .state
// Map a side-panel underlying selector to its earliest valid quarterly
// index. TQQQ / QQQ5 are synthesized to 1938; SOXL only exists from 1994.
// Used by 9sig + Adaptive + SMA earliestQIdxFn entries below.
function _earliestQIdxForUnderlyingSelect(selectId) {
  const v = (document.getElementById(selectId) || {}).value || 'tqqq';
  if (v !== 'soxl') return 0;
  if (typeof quarterlyData === 'undefined' || !quarterlyData) return 0;
  for (let q = 0; q < quarterlyData.length; q++) {
    if ((quarterlyData[q][4] || 0) > 0) return q;
  }
  return 0;
}

const STRATEGY_REGISTRY = {
  '9sig':    { label: '9sig',     pointsKey: 'log',            valueOf: (p) => p.total, prependStart: false,
               labelFn: () => (typeof nineSigName === 'function') ? nineSigName() : '9sig',
               earliestQIdxFn: () => _earliestQIdxForUnderlyingSelect('select-9sig-underlying') },
  'bh-tqqq': { label: 'B&H TQQQ', pointsKey: 'bhPoints',       valueOf: (p) => p.value, prependStart: true  },
  'bh-qqq':  { label: 'B&H QQQ',  pointsKey: 'qqqPoints',      valueOf: (p) => p.value, prependStart: true  },
  'bh-spy':  { label: 'B&H SPY',  pointsKey: 'spyPoints',      valueOf: (p) => p.value, prependStart: true  },
  'bh-soxl': { label: 'B&H SOXL', pointsKey: 'soxlPoints',     valueOf: (p) => p.value, prependStart: true,
               firstNonZeroCol: 4 /* quarterlyData column index — SOXL only starts 1994 */ },
  'bh-qqq5': { label: 'B&H QQQ5', pointsKey: 'qqq5Points',     valueOf: (p) => p.value, prependStart: true  },
  'sma':     { label: 'SMA',      pointsKey: 'smaPoints',      valueOf: (p) => p.value, prependStart: false,
               // SMA depends on (a) the current asset+window — earliest valid
               // quarter is when the SMA series first becomes non-null — and
               // (b) the chosen underlying — SOXL only has data from 1994.
               earliestQIdxFn: () => {
                 let minQ = 0;
                 if (typeof smaAtMonthlyByKey !== 'undefined' && smaAtMonthlyByKey
                     && typeof monthlyData !== 'undefined' && monthlyData
                     && typeof quarterlyData !== 'undefined' && quarterlyData) {
                   const a = (document.getElementById('select-sma-asset')  || {}).value || 'qqq';
                   const w = +((document.getElementById('select-sma-window') || {}).value) || 200;
                   const series = smaAtMonthlyByKey[a + '_' + w];
                   if (series) {
                     let firstM = -1;
                     for (let i = 0; i < series.length; i++) if (series[i] != null) { firstM = i; break; }
                     if (firstM >= 0) {
                       const date = monthlyData[firstM][0];
                       for (let q = 0; q < quarterlyData.length; q++) if (quarterlyData[q][0] >= date) { minQ = q; break; }
                     }
                   }
                 }
                 // Underlying constraint: holding SOXL requires SOXL data (1994+).
                 const ul = (document.getElementById('select-sma-underlying') || {}).value || 'tqqq';
                 if (ul === 'soxl' && quarterlyData) {
                   for (let q = 0; q < quarterlyData.length; q++) {
                     if ((quarterlyData[q][4] || 0) > 0) { if (q > minQ) minQ = q; break; }
                   }
                 }
                 return minQ;
               } },
  'adaptive':{ label: 'Adaptive (WIP)', pointsKey: 'adaptivePoints', valueOf: (p) => p.value, prependStart: false,
               earliestQIdxFn: () => _earliestQIdxForUnderlyingSelect('select-9sig-underlying') },
};

// Earliest quarterly index where each strategy has usable history. Computed
// once after quarterlyData loads (called from init). Strategies without a
// `firstNonZeroCol` start at index 0.
let earliestQIdxByStrategy = {};

function recomputeEarliestQIdx() {
  earliestQIdxByStrategy = {};
  if (typeof quarterlyData === 'undefined' || !quarterlyData) return;
  for (const [key, spec] of Object.entries(STRATEGY_REGISTRY)) {
    if (spec.firstNonZeroCol == null) {
      earliestQIdxByStrategy[key] = 0;
      continue;
    }
    let idx = 0;
    for (let i = 0; i < quarterlyData.length; i++) {
      if ((quarterlyData[i][spec.firstNonZeroCol] || 0) > 0) { idx = i; break; }
    }
    earliestQIdxByStrategy[key] = idx;
  }
}

// Resolve a strategy's earliest valid quarterly index. Strategies whose
// earliest changes with current UI state (e.g. SMA with its asset+window
// selectors) provide an `earliestQIdxFn`; static ones use the precomputed
// `earliestQIdxByStrategy` map.
function earliestQIdxOf(key) {
  const spec = STRATEGY_REGISTRY[key];
  if (!spec) return 0;
  if (typeof spec.earliestQIdxFn === 'function') return spec.earliestQIdxFn();
  return earliestQIdxByStrategy[key] || 0;
}

// Lowest entry index allowed given which strategy datasets are currently
// visible on the main chart. Used to clamp the date-range slider so the
// chart doesn't show "all zeros until 1994" when SOXL is enabled.
//
// `extraKeys` lets the heatmap pass in its currently-selected strategy and
// baseline without those needing to be visible on the chart.
function effectiveEntryMinQIdx(extraKeys) {
  let min = 0;
  if (typeof chart !== 'undefined' && chart) {
    for (const [keyStr, idx] of Object.entries(STRATEGY_KEY_TO_DATASET_IDX)) {
      if (!chart.isDatasetVisible(idx)) continue;
      const e = earliestQIdxOf(keyStr);
      if (e > min) min = e;
    }
  }
  if (Array.isArray(extraKeys)) {
    for (const k of extraKeys) {
      const e = earliestQIdxOf(k);
      if (e > min) min = e;
    }
  }
  return min;
}

// Map analytics-strategy keys back to chart dataset indices (used by the
// data-range clamping logic in chart.js).
const STRATEGY_KEY_TO_DATASET_IDX = {
  '9sig':    0,
  'bh-tqqq': 2,
  'bh-qqq':  3,
  'bh-spy':  4,
  'bh-soxl': 9,
  'adaptive':8,
  'sma':     10,
  'bh-qqq5': 11,
};

// Reverse map. Cheap to build at module load.
const DATASET_IDX_TO_STRATEGY_KEY = Object.fromEntries(
  Object.entries(STRATEGY_KEY_TO_DATASET_IDX).map(([k, v]) => [v, k])
);

// Backwards-compat label map. Existing callers refer to STRATEGY_LABELS;
// it's a Proxy so reads always re-run the registry's labelFn (if any),
// which lets dynamic names like "15sig" stay live as the user toggles.
const STRATEGY_LABELS = new Proxy({}, {
  get(_, k) {
    const s = STRATEGY_REGISTRY[k];
    if (!s) return undefined;
    return (typeof s.labelFn === 'function') ? s.labelFn() : s.label;
  },
});

// Update static "9sig" labels in the analytics modal (buttons + dropdown
// option). The metric pill row already re-reads on every render, so this
// only handles the strategy/baseline pickers whose textContent lives in
// raw HTML. Safe to call any time; no-op if elements aren't mounted yet.
function refresh9sigDisplayLabels() {
  const nm = (typeof nineSigName === 'function') ? nineSigName() : '9sig';
  const btn = document.querySelector('#analytics-strategy-options button[data-strat="9sig"]');
  if (btn) btn.textContent = nm;
  const opt = document.querySelector('#analytics-baseline option[value="9sig"]');
  if (opt) opt.textContent = nm;
}

let analyticsStrategy = 'adaptive';
let analyticsBaseline = 'compounded';
let analyticsCustomTarget = 1000000; // default $1M when "Custom Target ($)" is selected
let analyticsCustomGrowthPct = 20;   // default 20%/yr when "Custom Growth (%)" is selected
let analyticsBuildEpoch = 0;
let analyticsRefreshTimer = null;

const BASELINE_LABELS = {
  'compounded':  'Compounded Cash',
  'bh-spy':      'B&H SPY',
  'bh-qqq':      'B&H QQQ',
  'adaptive':    'Adaptive',
  '9sig':        '9sig',
  'bh-tqqq':     'B&H TQQQ',
  'custom':      'Custom Target',
  'custom-pct':  'Custom Growth % per year',
};

// Parse user-entered amounts like "$1M", "1m", "100k", "$1,000,000", "10000".
function parseAmount(str) {
  if (typeof str !== 'string') return NaN;
  const cleaned = str.replace(/[$,\s]/g, '').trim();
  if (!cleaned) return NaN;
  const m = cleaned.match(/^([\d.]+)\s*([kKmMbB])?$/);
  if (!m) return NaN;
  const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] : 1;
  return parseFloat(m[1]) * mult;
}

// Generic per-strategy accessors driven by STRATEGY_REGISTRY. Each strategy
// declares which key on the simulate() result holds its array and how to
// project a scalar value off a record; these helpers do the rest.
function _strategyArray(sim, key) {
  const spec = STRATEGY_REGISTRY[key];
  return spec && sim ? sim[spec.pointsKey] : null;
}

// Pull a baseline value out of a simulate() result for the chosen divisor.
// 'compounded' is the cash-only baseline plotted as "Invested Compounded";
// 'custom' / 'custom-pct' are special-cased; everything else delegates to
// the strategy registry.
function baselineFinalValue(sim, key) {
  if (key === 'custom')     return analyticsCustomTarget;
  if (key === 'custom-pct') return 0; // handled separately at color time (cell-to-cell comparison)
  if (key === 'compounded' || !STRATEGY_REGISTRY[key]) {
    const a = sim && sim.log;
    return a && a.length ? a[a.length - 1].investedCompounded : 0;
  }
  return strategyFinalValue(sim, key);
}

// Same as baselineFinalValue but reads the value at a specific quarter
// offset within a sim (used by the heatmap's per-row optimization where one
// simulate() covers many cells, each at a different exit quarter).
function baselineValueAtOffset(sim, key, offset) {
  if (key === 'custom')     return analyticsCustomTarget;
  if (key === 'custom-pct') return 0;
  if (key === 'compounded' || !STRATEGY_REGISTRY[key]) {
    const a = sim && sim.log;
    return a && a[offset] ? a[offset].investedCompounded : 0;
  }
  return strategyValueAtOffset(sim, key, offset);
}

// Same as strategyFinalValue but reads the value at a specific quarter
// offset within a sim. Mirrors the per-cell sim's "final" semantics for the
// heatmap's row-shared sim.
function strategyValueAtOffset(sim, strat, offset) {
  const spec = STRATEGY_REGISTRY[strat] || STRATEGY_REGISTRY['adaptive'];
  const arr = sim && sim[spec.pointsKey];
  return arr && arr[offset] ? spec.valueOf(arr[offset]) : 0;
}

// For a row-shared sim, return the strategy's full per-quarter value array
// (so we can compute a max-drawdown prefix once and answer every cell's
// drawdown in O(1)).
function strategyValueArray(sim, strat) {
  const spec = STRATEGY_REGISTRY[strat] || STRATEGY_REGISTRY['adaptive'];
  const arr = sim && sim[spec.pointsKey];
  return arr ? arr.map(spec.valueOf) : [];
}

// Prefix max-drawdown: out[i] = peak-to-trough decline observed across
// series[0..i]. Lets the heatmap answer maxDD per cell in O(1) after one
// linear pass over the row's full strategy series.
function computeMaxDDPrefix(series) {
  const out = new Array(series.length);
  let peak = -Infinity;
  let maxDD = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (Number.isFinite(v)) {
      if (v > peak) peak = v;
      if (peak > 0) {
        const dd = (peak - v) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }
    out[i] = maxDD;
  }
  return out;
}

// Pull the chosen strategy's final value out of a simulate() result.
function strategyFinalValue(sim, strat) {
  const spec = STRATEGY_REGISTRY[strat] || STRATEGY_REGISTRY['adaptive'];
  const arr = sim && sim[spec.pointsKey];
  return arr && arr.length ? spec.valueOf(arr[arr.length - 1]) : 0;
}

// Extract the per-quarter value series of a strategy from a simulate() result.
// Used to compute max drawdown.
function strategySeries(sim, strat) {
  return strategyValueArray(sim, strat);
}

// Max drawdown of a value series: largest peak-to-trough decline expressed as
// a positive fraction (e.g. 0.42 = 42%). Returns 0 for monotonically growing
// series like the cash-only baseline.
function computeMaxDrawdown(series) {
  if (!series || series.length < 2) return 0;
  let peak = -Infinity, maxDD = 0;
  for (const v of series) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

// 3 significant figures, with K/M/B suffix. No currency symbol.
function fmt3sig(n) {
  if (!Number.isFinite(n) || n === 0) return '0';
  let suffix = '', v = n;
  const abs = Math.abs(n);
  if      (abs >= 1e9) { suffix = 'B'; v = n / 1e9; }
  else if (abs >= 1e6) { suffix = 'M'; v = n / 1e6; }
  else if (abs >= 1e3) { suffix = 'K'; v = n / 1e3; }
  const av = Math.abs(v);
  let s;
  if      (av >= 100) s = v.toFixed(0);
  else if (av >= 10)  s = v.toFixed(1);
  else                s = v.toFixed(2);
  return s + suffix;
}

function isAnalyticsOpen() {
  const m = document.getElementById('analytics-modal');
  return m && !m.hasAttribute('hidden');
}

function toggleAnalytics() {
  const modal = document.getElementById('analytics-modal');
  const willOpen = modal.hasAttribute('hidden');
  if (willOpen) {
    modal.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
    buildHeatmap();
  } else {
    modal.setAttribute('hidden', '');
    document.body.style.overflow = '';
    // Abort any in-progress heatmap build so we don't keep simulating ~3,500
    // cells in the background while the modal isn't even visible.
    analyticsBuildEpoch++;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isAnalyticsOpen()) toggleAnalytics();
});

// Snapshot the analytics chart (header + full grid) and download as PNG.
// Two complications handled:
//  1. The grid lives inside nested flex/scroll containers — every level needs
//     `overflow: visible` and unbounded sizing to expose the full content.
//  2. html2canvas renders native <select> controls inconsistently (text shifts
//     down). We swap each select for a styled <strong> showing the selected
//     option's text just for the duration of the capture, then restore.
async function downloadAnalytics() {
  if (typeof html2canvas !== 'function') {
    alert('Image library still loading — please try again in a moment.');
    return;
  }
  const target = document.querySelector('#analytics-modal .analytics-chart');
  if (!target) return;

  const expandTargets = [
    document.querySelector('#analytics-modal .modal-content'),
    document.querySelector('#analytics-modal .modal-body'),
    target,
    document.getElementById('analytics-heatmap'),
  ].filter(Boolean);
  const origStyles = expandTargets.map(el => ({
    el,
    overflow:  el.style.overflow,
    maxHeight: el.style.maxHeight,
    height:    el.style.height,
    flex:      el.style.flex,
  }));
  expandTargets.forEach(el => {
    el.style.overflow  = 'visible';
    el.style.maxHeight = 'none';
    el.style.height    = 'auto';
    el.style.flex      = '0 0 auto';
  });

  // Swap each <select> for a <strong> with the selected option's display text.
  const selectSwaps = [];
  target.querySelectorAll('select').forEach(sel => {
    const opt = sel.options[sel.selectedIndex];
    const repl = document.createElement('strong');
    repl.textContent = opt ? opt.text : sel.value;
    repl.style.cssText = 'color: var(--text); font-weight: 600; font-family: "JetBrains Mono", monospace; font-size: 10px; padding: 0 4px;';
    sel.style.display = 'none';
    sel.parentNode.insertBefore(repl, sel);
    selectSwaps.push({ sel, repl });
  });

  // Let layout settle after style changes.
  await new Promise(r => requestAnimationFrame(r));

  try {
    const fullW = Math.max(target.scrollWidth, target.offsetWidth);
    const fullH = Math.max(target.scrollHeight, target.offsetHeight);
    const canvas = await html2canvas(target, {
      backgroundColor: '#0a0e17',
      scale: 2,
      logging: false,
      useCORS: true,
      width:        fullW,
      height:       fullH,
      windowWidth:  fullW,
      windowHeight: fullH,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const baseStr = analyticsBaseline === 'custom'
      ? `custom-${Math.round(analyticsCustomTarget)}`
      : analyticsBaseline;
    const filename = `tqqq-analytics-${analyticsStrategy}-vs-${baseStr}-${stamp}.png`;
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = filename;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 200);
    }, 'image/png');
  } catch (err) {
    console.error('Download failed:', err);
    alert('Download failed: ' + err.message);
  } finally {
    selectSwaps.forEach(({ sel, repl }) => {
      repl.remove();
      sel.style.display = '';
    });
    origStyles.forEach(({ el, overflow, maxHeight, height, flex }) => {
      el.style.overflow  = overflow;
      el.style.maxHeight = maxHeight;
      el.style.height    = height;
      el.style.flex      = flex;
    });
  }
}

// Strategy selector: click a pill to rebuild the heatmap with that strategy.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#analytics-strategy-options button[data-strat]');
  if (!btn) return;
  const next = btn.dataset.strat;
  if (next === analyticsStrategy) return;
  analyticsStrategy = next;
  document.querySelectorAll('#analytics-strategy-options button').forEach(b => {
    b.classList.toggle('active', b.dataset.strat === next);
  });
  buildHeatmap();
});

// Baseline selector: changes the divisor used to compute cell coloring.
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'analytics-baseline') {
    analyticsBaseline = e.target.value;
    const customInput = document.getElementById('analytics-baseline-custom-input');
    const pctInput    = document.getElementById('analytics-baseline-pct-input');
    const pctDisplay  = document.getElementById('analytics-baseline-pct-display');
    if (customInput) customInput.setAttribute('hidden', '');
    if (pctInput)    pctInput.setAttribute('hidden', '');
    if (pctDisplay)  pctDisplay.setAttribute('hidden', '');
    if (analyticsBaseline === 'custom' && customInput) {
      customInput.removeAttribute('hidden');
      customInput.value = fmtFull(analyticsCustomTarget);
    } else if (analyticsBaseline === 'custom-pct' && pctInput) {
      pctInput.removeAttribute('hidden');
      pctInput.value = String(analyticsCustomGrowthPct);
      if (pctDisplay) {
        pctDisplay.removeAttribute('hidden');
        pctDisplay.textContent = (analyticsCustomGrowthPct >= 0 ? '+' : '') + analyticsCustomGrowthPct + '%';
      }
    }
    buildHeatmap();
  }
});

// Custom-target input: parse + rebuild on change/blur.
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'analytics-baseline-custom-input') {
    const v = parseAmount(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      analyticsCustomTarget = v;
      e.target.value = fmtFull(v); // re-format to canonical
      buildHeatmap();
    }
  }
});

// Custom growth-percentage slider: ranges from -100% to +100%, rebuilds the
// chart on every drag step. Spiral mode is fast enough that live rebuild is
// fine — the chart re-renders without flicker.
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'analytics-baseline-pct-input') {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    analyticsCustomGrowthPct = v;
    const display = document.getElementById('analytics-baseline-pct-display');
    if (display) display.textContent = (v >= 0 ? '+' : '') + v + '%';
    buildHeatmap();
  }
});

// Metric dropdowns inside the modal — change feeds back to the underlying
// page slider/select, dispatches the appropriate event so the main chart
// updates and localStorage saves, then rebuilds the heatmap.
document.addEventListener('change', (e) => {
  if (!e.target || !e.target.classList || !e.target.classList.contains('metric-select')) return;
  const key = e.target.dataset.metricKey;
  const rawValue = e.target.value;
  const fireInput = (id, sliderValue) => {
    const el = document.getElementById(id);
    el.value = String(sliderValue);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const fireChange = (id, val) => {
    const el = document.getElementById(id);
    el.value = String(val);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Strategy-specific pills (tu/td/tw/sa/sw/...) dispatch through the def map.
  const def = STRATEGY_METRIC_DEFS[key];
  if (def) {
    fireChange(def.elementId, def.kind === 'string' ? rawValue : parseFloat(rawValue));
    buildHeatmap();
    return;
  }
  const value = parseFloat(rawValue);
  if (!Number.isFinite(value)) return;
  switch (key) {
    case 'initial': fireInput('slider-initial', initialToSlider(value)); break;
    case 'monthly': fireInput('slider-monthly', value); break;
    case 'raise':   fireInput('slider-raise',   value); break;
    case 'rate':    fireInput('slider-rate',    rateToSlider(value)); break;
  }
  buildHeatmap();
});

// Cross-hair hover: highlight the row + column of the hovered cell, and show
// the rich tooltip. Listeners live on the (stable) heatmap wrapper, so they
// survive every rebuild without re-wiring.
(function setupHeatmapHover() {
  const grid = document.getElementById('analytics-heatmap');
  const tooltip = document.getElementById('heatmap-tooltip');
  if (!grid || !tooltip) return;

  function clearHighlights() {
    grid.querySelectorAll('.row-hover, .col-hover').forEach(el => el.classList.remove('row-hover', 'col-hover'));
  }
  function applyHighlights(r, c) {
    if (r) grid.querySelectorAll(`[data-r="${r}"]`).forEach(el => el.classList.add('row-hover'));
    if (c) grid.querySelectorAll(`[data-c="${c}"]`).forEach(el => el.classList.add('col-hover'));
  }
  function hideTooltip() { tooltip.setAttribute('hidden', ''); }
  function positionTooltip(td, e) {
    // Anchor the tooltip below+right of the *cell* so it never overlaps the
    // highlighted row's horizontal band or the highlighted column's vertical
    // band. Falls back to cursor coords if no cell rect.
    const margin = 14;
    tooltip.style.left = '0px'; tooltip.style.top = '0px';
    const rect = tooltip.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x, y;
    if (td) {
      const cr = td.getBoundingClientRect();
      x = cr.right  + margin;
      y = cr.bottom + margin;
      // Flip to the left of the cell if it would overflow right.
      if (x + rect.width > vw - 8) x = cr.left - rect.width - margin;
      // Flip above the cell if it would overflow bottom.
      if (y + rect.height > vh - 8) y = cr.top - rect.height - margin;
    } else {
      x = e.clientX + margin;
      y = e.clientY + margin;
    }
    tooltip.style.left = Math.max(4, x) + 'px';
    tooltip.style.top  = Math.max(4, y) + 'px';
  }
  function fillTooltip(td) {
    const startYear = +td.dataset.r;
    const period    = +td.dataset.c;
    const endYear   = +td.dataset.endYear;
    const value     = +td.dataset.value;
    const derived   = +td.dataset.derived;
    const maxDD     = +td.dataset.maxDd;
    const stratLabel = STRATEGY_LABELS[analyticsStrategy] || 'Adaptive';

    // Run (or reuse cached) simulate() for this exact (startYear, period)
    // range so we can render the same line chart that spiral mode uses.
    const cellSim = getCellSim(startYear, period);

    // For custom-pct, the baseline depends on the previous cell's value;
    // for everything else, the cell's `derived` field already encodes the
    // baseline → strategy ratio so we can recover the baseline directly.
    let baselineVal = derived > 0 ? value / derived : 0;
    if (analyticsBaseline === 'custom-pct') {
      const prevPeriod = period - 1;
      let prevValue = +(sliderToInitial(+document.getElementById('slider-initial').value));
      if (prevPeriod > 0) {
        const prevTd = grid.querySelector(`td[data-yp="${startYear}:${prevPeriod}"]`);
        if (prevTd && prevTd.dataset.value) prevValue = +prevTd.dataset.value;
      }
      baselineVal = prevValue * (1 + analyticsCustomGrowthPct / 100);
    }

    // Build the line chart, overlaying the baseline series so the user
    // can see the comparison curve, not just the ratio number.
    let lineChart = '';
    if (cellSim) {
      const series = strategyDateValues(cellSim, analyticsStrategy);
      if (series.length >= 2) {
        const baselineSeries = baselineDateValues(cellSim, analyticsBaseline, baselineVal, series);
        lineChart = buildTooltipLineChart(series, {
          baselineSeries: (baselineSeries && analyticsBaseline !== analyticsStrategy) ? baselineSeries : null,
        });
      }
    }
    const ddStr = Number.isFinite(maxDD) && maxDD > 0 ? '−' + (maxDD * 100).toFixed(1) + '%' : '0.0%';

    tooltip.innerHTML = `
      <button class="tt-close" type="button" aria-label="Close" data-tt-close>&times;</button>
      <div class="tt-period">
        <span>${stratLabel} &middot; INVESTED ${startYear} &middot; ${period}Y</span>
        <span class="tt-dd">DD ${ddStr}</span>
      </div>
      <div class="tt-strat">${fmtFull(Math.round(value))} <span style="color:var(--text-muted);font-size:11px;font-weight:500">(ended ${endYear})</span></div>
      ${lineChart}
    `;
  }

  // Touch / coarse-pointer devices don't get hover events reliably — tapping
  // a cell fires emulated mousemove + mouseleave in quick succession which
  // would flash the tooltip closed. Detect once and switch to a sticky,
  // click-driven flow on those devices.
  const isTouch = window.matchMedia && window.matchMedia('(hover: none)').matches;

  if (!isTouch) {
    grid.addEventListener('mousemove', (e) => {
      // Spiral mode owns its own tooltip lifecycle on each <rect>; don't let
      // this grid-level handler hide what the spiral just showed.
      if (e.target && e.target.closest && e.target.closest('.spiral-svg')) return;
      const cell = e.target.closest('td.heatmap-cell, th[data-r], th[data-c]');
      if (!cell || !grid.contains(cell)) {
        clearHighlights();
        hideTooltip();
        return;
      }
      clearHighlights();
      applyHighlights(cell.dataset.r, cell.dataset.c);
      if (cell.matches('td.heatmap-cell:not(.empty)') && cell.dataset.value != null) {
        fillTooltip(cell);
        tooltip.removeAttribute('hidden');
        positionTooltip(cell, e);
      } else {
        hideTooltip();
      }
    });
    grid.addEventListener('mouseleave', () => {
      clearHighlights();
      hideTooltip();
    });
  }

  // Click handler — primary trigger on touch devices, also active on desktop
  // (a tap or stylus click works the same as hover there).
  grid.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('.spiral-svg')) return;
    const cell = e.target.closest('td.heatmap-cell:not(.empty)');
    if (!cell || !grid.contains(cell) || cell.dataset.value == null) return;
    clearHighlights();
    applyHighlights(cell.dataset.r, cell.dataset.c);
    fillTooltip(cell);
    tooltip.removeAttribute('hidden');
    positionTooltip(cell, e);
  });

  // Close button (rendered inside fillTooltip's HTML) — hides the sticky
  // tooltip on touch devices. Also handles the case where it's tapped on
  // desktop.
  tooltip.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-tt-close]')) {
      clearHighlights();
      hideTooltip();
    }
  });

  // Tap outside the heatmap on touch devices → dismiss sticky tooltip.
  if (isTouch) {
    document.addEventListener('click', (e) => {
      if (tooltip.hasAttribute('hidden')) return;
      if (e.target.closest('#heatmap-tooltip')) return;
      if (e.target.closest('#analytics-heatmap')) return;
      clearHighlights();
      hideTooltip();
    });
  }
})();

// Called from chart.js render() after a parameter change. Debounced so the
// expensive simulation grid only runs after the user stops adjusting.
function refreshAnalytics() {
  if (!isAnalyticsOpen()) return;
  if (analyticsRefreshTimer) clearTimeout(analyticsRefreshTimer);
  analyticsRefreshTimer = setTimeout(buildHeatmap, 300);
}

// Common dropdown options per metric. The current value is always inserted
// into the option list (sorted) if it isn't already there, so any value the
// user has set on the page sliders shows up correctly even if it's not in
// the canonical list.
const METRIC_OPTS = {
  initial: [0, 100, 500, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 25000, 35000, 50000, 75000, 100000, 150000, 200000, 250000, 350000, 500000, 750000, 1000000, 1500000, 2000000, 3000000, 5000000, 10000000],
  monthly: [0, 50, 100, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 50000, 100000],
  raise:   [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10, 12, 15, 20],
  rate:    [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100],
  tu:      [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.2, 2.4, 2.5, 2.7, 3.0, 3.3, 3.5, 4.0, 4.5, 5.0],
  td:      [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.3, 2.5, 3.0],
  tw:      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 18, 20, 22, 25, 28, 30],
  sa:      ['qqq', 'spy'],
  sw:      [100, 150, 200, 250],
  // 9sig + Adaptive: which leveraged ETF to trade, and signal-line growth.
  nu:      ['tqqq', 'qqq5', 'soxl'],
  ng:      [6, 7, 8, 9, 10, 12, 15, 18, 20, 25],
  // 9sig + Adaptive rule customization:
  //   nc = 30-down no-sell drop % below 2-yr high (≥100 effectively disables)
  //   ns = spike-reset trigger (quarterly gain %; 0 disables)
  nc:      [30, 60, 90, 120, 150, 180],
  ns:      [0, 50, 75, 100, 150, 200, 300, 400],
  // SMA: which leveraged ETF the strategy holds when the signal is "in".
  su:      ['tqqq', 'qqq5', 'soxl'],
};

// Per-metric definition for the analytics-modal settings bar. The bar
// auto-renders pills for whichever metrics are currently relevant (see
// STRATEGY_METRICS below). Each def says:
//   - which page-level <select>/<input> mirrors this metric (so the change
//     handler can dispatch back to the real control),
//   - how to format the option labels,
//   - whether the value is numeric (parsed with parseFloat) or a string
//     ('qqq'/'spy' style).
const STRATEGY_METRIC_DEFS = {
  tu: { label: '→ 9sig',     elementId: 'select-tqqq-above',     fmt: x => `×${x}`,                 kind: 'number' },
  td: { label: '→ TQQQ',     elementId: 'select-tqqq-below',     fmt: x => `×${x}`,                 kind: 'number' },
  tw: { label: 'Window',     elementId: 'select-tqqq-window',    fmt: x => `${x}y`,                 kind: 'number' },
  sa: { label: 'Signal',     elementId: 'select-sma-asset',      fmt: v => String(v).toUpperCase(), kind: 'string' },
  sw: { label: 'SMA window', elementId: 'select-sma-window',     fmt: x => `${x}d`,                 kind: 'number' },
  su: { label: 'Holds',      elementId: 'select-sma-underlying', fmt: v => String(v).toUpperCase(), kind: 'string' },
  nu: { label: 'Trades',     elementId: 'select-9sig-underlying',fmt: v => String(v).toUpperCase(), kind: 'string' },
  ng: { label: 'Signal +/q', elementId: 'select-9sig-growth',    fmt: x => `${x}%`,                 kind: 'number' },
  nc: { label: '30-down',    elementId: 'select-9sig-crashdrop', fmt: x => x >= 100 ? 'off' : `-${x}%`, kind: 'number' },
  ns: { label: 'Spike',      elementId: 'select-9sig-spike',     fmt: x => x === 0 ? 'off' : `+${x}%/q`, kind: 'number' },
};

// Which metric keys each strategy exposes in the analytics settings bar.
// Strategies without an entry get no extra pills (the base initial / monthly /
// raise / rate row still renders unconditionally).
const STRATEGY_METRICS = {
  '9sig':     ['nu', 'ng', 'nc', 'ns'],
  'adaptive': ['nu', 'ng', 'nc', 'ns', 'tu', 'td', 'tw'],
  'sma':      ['su', 'sa', 'sw'],
};

function metricSelect(key, label, current, fmt, dim) {
  const def = STRATEGY_METRIC_DEFS[key];
  const isString = def && def.kind === 'string';
  const base = METRIC_OPTS[key].slice();
  const same = (a, b) => isString ? String(a) === String(b) : Math.abs(a - b) < 1e-9;
  if (current != null && !base.some(v => same(v, current))) base.push(current);
  base.sort((a, b) => isString ? String(a).localeCompare(String(b)) : a - b);
  const optionsHtml = base.map(v =>
    `<option value="${v}"${current != null && same(v, current) ? ' selected' : ''}>${fmt(v)}</option>`
  ).join('');
  const cls = dim ? 'metric metric--dim' : 'metric';
  return `<span class="${cls}" title="${dim ? 'Not currently affecting the result' : ''}">${label} <select class="metric-select" data-metric-key="${key}">${optionsHtml}</select></span>`;
}

function renderAnalyticsMetrics(initial, monthly, annualRaise, rate, tqqqAboveMult, tqqqBelowMult, tqqqWindow, strategy) {
  const m = document.getElementById('analytics-metrics');
  if (!m) return;
  const pct = (x) => (x % 1 === 0 ? x.toFixed(0) : x.toFixed(1)) + '%';
  // Cash interest rate — used by 9sig, Adaptive, and the SMA strategy (each
  // parks money in cash that earns this rate) AND by the "Compounded Cash"
  // baseline. B&H strategies/baselines + Custom Target + Custom Growth
  // ignore it. Dimmed when there's no cash flow at all (init=0 AND monthly=0).
  const stratUsesCash    = (strategy === '9sig' || strategy === 'adaptive' || strategy === 'sma');
  const baselineUsesCash = (analyticsBaseline === 'compounded' || analyticsBaseline === '9sig' || analyticsBaseline === 'adaptive' || analyticsBaseline === 'sma');
  const cashActive       = stratUsesCash || baselineUsesCash;
  const dimInitial       = initial <= 0;
  const dimMonthly       = monthly <= 0;
  const dimRaise         = monthly <= 0 || annualRaise <= 0;
  const dimRate          = (initial <= 0 && monthly <= 0);
  const items = [
    metricSelect('initial', 'Initial', initial, fmtFull, dimInitial),
    metricSelect('monthly', 'Monthly', monthly, fmtFull, dimMonthly),
    metricSelect('raise',   'Annual raise', annualRaise * 100, pct, dimRaise),
  ];
  if (cashActive) {
    items.push(metricSelect('rate', 'Cash interest rate', rate * 100, pct, dimRate));
  }

  // Strategy-specific pills, driven by STRATEGY_METRICS. Show metrics for
  // whichever of (strategy, baseline) actually use them. The current value
  // is read off the corresponding page <select>/<input>.
  const relevant = new Set();
  for (const k of (STRATEGY_METRICS[strategy] || []))         relevant.add(k);
  for (const k of (STRATEGY_METRICS[analyticsBaseline] || [])) relevant.add(k);
  for (const k of relevant) {
    const def = STRATEGY_METRIC_DEFS[k];
    if (!def) continue;
    const el = document.getElementById(def.elementId);
    if (!el) continue;
    const cur = def.kind === 'string' ? el.value : +el.value;
    items.push(metricSelect(k, def.label, cur, def.fmt, false));
  }
  m.innerHTML = items.join('');
}

// Position the shared #heatmap-tooltip near the cursor (with viewport-edge
// flipping). Used by spiral-mode hover.
function positionSpiralTooltip(tooltip, e) {
  const margin = 14;
  tooltip.style.left = '0px';
  tooltip.style.top  = '0px';
  const r  = tooltip.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX + margin;
  let y = e.clientY + margin;
  if (x + r.width  > vw - 8) x = e.clientX - r.width  - margin;
  if (y + r.height > vh - 8) y = e.clientY - r.height - margin;
  tooltip.style.left = Math.max(4, x) + 'px';
  tooltip.style.top  = Math.max(4, y) + 'px';
}

// Render the rich tooltip for a spiral-mode bar hover.
// The "amount" answer is: "if I'd started investing in this year with my
// current params, what's my portfolio worth today?" — we run a fresh
// simulate() from start-of-year → most recent quarter (lazily cached per
// year) and show its final value plus a small SVG line chart of the full
// growth trajectory.
function showSpiralTooltip(tooltip, e, d, threshold) {
  const stratLabel = STRATEGY_LABELS[analyticsStrategy] || 'Adaptive';
  const sign       = d.pct >= 0 ? '+' : '';
  const hit        = d.pct >= threshold;
  const hitColor   = hit ? '#22c55e' : '#ef4444';
  const tag        = d.partial ? ' (YTD)' : '';
  const thrSign    = threshold >= 0 ? '+' : '';
  const thrTxt     = `${thrSign}${threshold}%`;

  // Run (or fetch from cache) a sim starting from this bar's year.
  const startSim    = getYearStartSim(d.year);
  let startBalance  = 0;
  let todayValue    = 0;
  let lineChart     = '';
  let yearsLater    = 0;
  let endYearLabel  = '';
  if (startSim) {
    const series = strategyDateValues(startSim, analyticsStrategy);
    if (series.length) {
      startBalance  = series[0].value;
      todayValue    = series[series.length - 1].value;
      lineChart     = buildTooltipLineChart(series);
      const endY    = parseInt(series[series.length - 1].date.substring(0, 4));
      yearsLater    = endY - d.year;
      endYearLabel  = String(endY);
    }
  }

  tooltip.innerHTML = `
    <div class="tt-period">${stratLabel} &middot; STARTED ${d.year}</div>
    <div class="tt-strat">${fmtFull(Math.round(todayValue))}${yearsLater > 0 ? ` <span style="color:var(--text-muted);font-size:11px;font-weight:500">(${yearsLater}y later, ${endYearLabel})</span>` : ''}</div>
    ${lineChart}
    <div class="tt-foot">
      <span>${d.year}${tag} alone: <strong style="color:var(--text)">${sign}${d.pct.toFixed(2)}%</strong></span>
      <span class="tt-dd" style="color:${hitColor}">vs ${thrTxt} ${hit ? '✓' : '✗'}</span>
    </div>
  `;
  tooltip.removeAttribute('hidden');
  positionSpiralTooltip(tooltip, e);
}

// Map a strategy to the underlying asset whose price drives the spiral's
// year-over-year comparison.
const SPIRAL_ASSET_FOR_STRATEGY = {
  'bh-spy':   'spy',
  'bh-qqq':   'qqq',
  'bh-tqqq':  'tqqq',
  'bh-soxl':  'soxl',
  'sma':      'tqqq',
  '9sig':     'tqqq',
  'adaptive': 'tqqq',
};

// Extract the strategy's quarterly (date, value) pairs from a simulate()
// result. Used by the spiral to get per-year portfolio values.
//
// `simulate()` builds bhPoints / qqqPoints / spyPoints starting from qi = 1
// (it skips the entry quarter), while log and adaptivePoints include qi = 0.
// We normalize this here by prepending the entry-quarter snapshot to the BH
// variants so every series starts at the user's actual starting balance —
// otherwise per-year YoY math downstream would use Q1 of year Y as Y's start
// instead of Q4 of (Y-1), reading as ~9-month growth instead of full-year.
function strategyDateValues(sim, strat) {
  const spec = STRATEGY_REGISTRY[strat] || STRATEGY_REGISTRY['adaptive'];
  const arr = sim && sim[spec.pointsKey];
  if (!arr || !arr.length) return [];
  // Normalize each record to { date, value, ...optional state }.
  const pts = arr.map(p => {
    const out = { date: p.date, value: spec.valueOf(p) };
    if (p.state != null) out.state = p.state;
    return out;
  });
  // BH variants skip qi=0 in simulate(); prepend the entry-quarter snapshot
  // so per-year YoY math downstream reads as full years.
  if (spec.prependStart && sim.log && sim.log.length && pts[0].date !== sim.log[0].date) {
    return [{ date: sim.log[0].date, value: sim.log[0].total }, ...pts];
  }
  return pts;
}

// Quarterly (date, value) pairs for the heatmap's currently selected
// baseline. Mirrors strategyDateValues for strategy-shaped baselines and
// adds: 'compounded' (invested-cash growth), 'custom' (flat dollar target),
// 'custom-pct' (per-cell flat target derived from prior cell × (1+pct)).
function baselineDateValues(sim, key, cellBaselineVal, stratSeries) {
  if (!sim) return [];
  if (key === '9sig' || key === 'adaptive' || key === 'bh-tqqq' || key === 'bh-qqq' || key === 'bh-spy' || key === 'bh-soxl' || key === 'sma') {
    return strategyDateValues(sim, key);
  }
  if (key === 'compounded') {
    return sim.log ? sim.log.map(l => ({ date: l.date, value: l.investedCompounded })) : [];
  }
  // 'custom' (dollar target) or 'custom-pct' (cell-derived target). Both
  // are rendered as a flat horizontal line at the target value.
  if (key === 'custom' || key === 'custom-pct') {
    const target = key === 'custom' ? analyticsCustomTarget : cellBaselineVal;
    if (!Number.isFinite(target) || target <= 0 || !stratSeries || stratSeries.length < 2) return [];
    return [
      { date: stratSeries[0].date,                   value: target },
      { date: stratSeries[stratSeries.length - 1].date, value: target },
    ];
  }
  return [];
}

// Cache for the spiral's full-range simulate() result so that dragging the
// percentage slider (which only changes the colour threshold, not the sim
// inputs) doesn't trigger a fresh simulation each frame.
let _spiralSim = null;
let _spiralSimKey = null;

// Cache for the rendered spiral SVG. When only the threshold changes (slider
// drag), we skip the full SVG rebuild and just repaint the bar colors.
let _spiralRenderKey = null;
let _spiralBarsSel   = null;
let _spiralPoints    = null;

// Per-start-year simulate() cache for the spiral tooltip — computes lazily
// on first hover, reused for repeat hovers. Invalidated when sim params
// change (same key as the full-range sim cache).
let _perYearSims    = new Map();
let _perYearSimsKey = null;

// Read the per-strategy underlying selectors and the 9sig signal-growth
// selector off the side-panel UI. Mirror of the helper in chart.js's render().
function _underlyingAndGrowth() {
  const ulSel = (id) => {
    const v = (document.getElementById(id) || {}).value;
    return v === 'qqq5' ? 5 : (v === 'soxl' ? 4 : 1);
  };
  const cd = +((document.getElementById('select-9sig-crashdrop') || {}).value);
  const sp = +((document.getElementById('select-9sig-spike')     || {}).value);
  return {
    sigUlCol: ulSel('select-9sig-underlying'),
    smaUlCol: ulSel('select-sma-underlying'),
    qGrowth:  +((document.getElementById('select-9sig-growth') || {}).value) / 100 || 0.09,
    crashDropPct:   Number.isFinite(cd) ? cd : 30,
    spikeTriggerPct: Number.isFinite(sp) ? sp : 100,
  };
}

// Helper for analytics sim sites: run simulate() and (only when the SMA
// strategy is in play either as the heatmap strategy or as its baseline)
// also run simulateSMA() and attach its result. Avoids paying for the SMA
// loop in the common case where it isn't displayed.
function _smaParamsForAnalytics() {
  const usesSMA = (analyticsStrategy === 'sma' || analyticsBaseline === 'sma');
  if (!usesSMA) return null;
  const { smaUlCol } = _underlyingAndGrowth();
  return {
    smaAsset:      (document.getElementById('select-sma-asset')  || {}).value || 'qqq',
    smaWindow:     +((document.getElementById('select-sma-window') || {}).value) || 200,
    underlyingCol: smaUlCol,
  };
}

function _runAnalyticsSim(initial, monthly, rate, entryIdx, exitIdx, annualRaise, opts) {
  // Inject the page-level underlying + qGrowth + rule choices into opts so
  // the main sim runs on whatever the user picked. Caller-provided opts win
  // — e.g. the adaptive cache passes pre-computed adaptiveStates.
  const { sigUlCol, qGrowth, crashDropPct, spikeTriggerPct } = _underlyingAndGrowth();
  opts = Object.assign({ underlyingCol: sigUlCol, qGrowth, crashDropPct, spikeTriggerPct }, opts);
  const sim = simulate(initial, monthly, rate, entryIdx, exitIdx, annualRaise, opts);
  const smaP = _smaParamsForAnalytics();
  if (smaP) {
    const r = simulateSMA(initial, monthly, rate, entryIdx, exitIdx, annualRaise, smaP);
    sim.smaPoints = r.smaPoints;
  }
  return sim;
}

// Per-(startYear, period) simulate() cache for the heatmap-cell tooltip.
// Populated lazily on first hover of each cell, reused after that.
let _cellSims    = new Map();
let _cellSimsKey = null;

// Run simulate() for a heatmap cell's exact (startYear, period) range and
// cache the result. Cell entries are anchored at "start of startYear" (= end
// of previous year's last quarter) through end of (startYear + period - 1).
function getCellSim(startYear, period) {
  const initial      = sliderToInitial(+document.getElementById('slider-initial').value);
  const monthly      = +document.getElementById('slider-monthly').value;
  const annualRaise  = +document.getElementById('slider-raise').value / 100;
  const rate         = sliderToRate(+document.getElementById('slider-rate').value) / 100;
  const tqqqAbove    = +document.getElementById('select-tqqq-above').value;
  const tqqqBelow    = +document.getElementById('select-tqqq-below').value;
  const tqqqWindow   = +document.getElementById('select-tqqq-window').value;
  const switchTo9sig = tqqqAbove * 100;
  const switchToAll  = tqqqBelow > 0 ? 100 / tqqqBelow : 100;

  const smaP = _smaParamsForAnalytics();
  const _ug = _underlyingAndGrowth();
  const key = JSON.stringify({ initial, monthly, rate, annualRaise, s: switchTo9sig, a: switchToAll, w: tqqqWindow, sma: smaP, ul: _ug.sigUlCol, qg: _ug.qGrowth, cd: _ug.crashDropPct, sp: _ug.spikeTriggerPct });
  if (_cellSimsKey !== key) {
    _cellSims    = new Map();
    _cellSimsKey = key;
  }
  const cellKey = startYear + ':' + period;
  if (_cellSims.has(cellKey)) return _cellSims.get(cellKey);

  const endYear = startYear + period - 1;
  let prevYearLast = -1, firstOfStart = -1, lastOfEnd = -1;
  for (let i = 0; i < quarterlyData.length; i++) {
    const y = parseInt(quarterlyData[i][0].substring(0, 4));
    if (y === startYear - 1) prevYearLast = i;
    if (y === startYear && firstOfStart === -1) firstOfStart = i;
    if (y === endYear) lastOfEnd = i;
    if (y > endYear) break;
  }
  const entryIdx = prevYearLast >= 0 ? prevYearLast : firstOfStart;
  const exitIdx  = lastOfEnd;
  if (entryIdx < 0 || exitIdx < 0 || exitIdx <= entryIdx) return null;

  const { sigUlCol: _ulC, qGrowth: _qG } = _underlyingAndGrowth();
  const adaptiveStates = computeAdaptiveStates(switchTo9sig, switchToAll, tqqqWindow, _ulC, _qG);
  const opts = { switchTo9sig, switchToAllIn: switchToAll, yearsBack: tqqqWindow, adaptiveStates };
  const sim = _runAnalyticsSim(initial, monthly, rate, entryIdx, exitIdx, annualRaise, opts);
  _cellSims.set(cellKey, sim);
  return sim;
}

// Run simulate() from "start of `startYear`" to the latest available
// quarter, with the user's current sliders. Lazy + cached.
function getYearStartSim(startYear) {
  const initial      = sliderToInitial(+document.getElementById('slider-initial').value);
  const monthly      = +document.getElementById('slider-monthly').value;
  const annualRaise  = +document.getElementById('slider-raise').value / 100;
  const rate         = sliderToRate(+document.getElementById('slider-rate').value) / 100;
  const tqqqAbove    = +document.getElementById('select-tqqq-above').value;
  const tqqqBelow    = +document.getElementById('select-tqqq-below').value;
  const tqqqWindow   = +document.getElementById('select-tqqq-window').value;
  const switchTo9sig = tqqqAbove * 100;
  const switchToAll  = tqqqBelow > 0 ? 100 / tqqqBelow : 100;

  const smaP = _smaParamsForAnalytics();
  const _ug = _underlyingAndGrowth();
  const key = JSON.stringify({ initial, monthly, rate, annualRaise, s: switchTo9sig, a: switchToAll, w: tqqqWindow, sma: smaP, ul: _ug.sigUlCol, qg: _ug.qGrowth, cd: _ug.crashDropPct, sp: _ug.spikeTriggerPct });
  if (_perYearSimsKey !== key) {
    _perYearSims    = new Map();
    _perYearSimsKey = key;
  }
  if (_perYearSims.has(startYear)) return _perYearSims.get(startYear);

  // Entry: last quarter of (startYear - 1) (= start of startYear), or first
  // quarter of startYear if no prior year exists.
  let entryIdx = -1;
  let firstOfYear = -1;
  for (let i = 0; i < quarterlyData.length; i++) {
    const y = parseInt(quarterlyData[i][0].substring(0, 4));
    if (y === startYear - 1) entryIdx = i;
    if (y === startYear && firstOfYear === -1) firstOfYear = i;
    if (y > startYear) break;
  }
  if (entryIdx < 0) entryIdx = firstOfYear;
  if (entryIdx < 0) return null;
  const exitIdx = quarterlyData.length - 1;
  if (exitIdx <= entryIdx) return null;

  const { sigUlCol: _ulC, qGrowth: _qG } = _underlyingAndGrowth();
  const adaptiveStates = computeAdaptiveStates(switchTo9sig, switchToAll, tqqqWindow, _ulC, _qG);
  const opts = { switchTo9sig, switchToAllIn: switchToAll, yearsBack: tqqqWindow, adaptiveStates };
  const sim = _runAnalyticsSim(initial, monthly, rate, entryIdx, exitIdx, annualRaise, opts);
  _perYearSims.set(startYear, sim);
  return sim;
}

// Spiral tooltip's mini chart. Top strip is a per-year YoY bar chart
// (positive bars rise above the 0% baseline, negative drop below — bar
// height proportional to |YoY %|). Bottom is the actual portfolio line
// over time, with start/end value labels pinned at the line endpoints.
function buildTooltipLineChart(series, opts) {
  opts = opts || {};
  const width  = opts.width  || 340;
  const height = opts.height || 168; // larger to fit the bigger fonts
  // Optional second series rendered as a dashed muted line — used by the
  // heatmap tooltip to overlay the comparison baseline (e.g. compounded
  // cash, B&H SPY, custom target) on top of the strategy line so the user
  // can eyeball the relationship instead of just reading the ratio number.
  const baselineSeries = opts.baselineSeries || null;
  if (!series || series.length < 2) return '';

  // Group series by year → {year, startIdx, endIdx, startVal, endVal, pct}.
  const yearGroups = [];
  let cur = null;
  for (let i = 0; i < series.length; i++) {
    const y = parseInt(series[i].date.substring(0, 4));
    if (!cur || cur.year !== y) {
      cur = { year: y, startIdx: i, endIdx: i, startVal: series[i].value, endVal: series[i].value };
      yearGroups.push(cur);
    } else {
      cur.endIdx = i;
      cur.endVal = series[i].value;
    }
  }
  // YoY base is the *previous* year's last value (≈ Dec 31 prev year, which
  // is "start of this year"). Without this, the first rendered year would
  // measure Q1→Q4 only and undercount the full-year growth. The first group
  // (often just the prepended entry-quarter snapshot) has no prior year, so
  // it falls back to its own startVal — that group is then filtered out
  // below since rendering a single-point year as a bar is meaningless.
  yearGroups.forEach((g, i) => {
    const prev = yearGroups[i - 1];
    const base = prev ? prev.endVal : g.startVal;
    g.pct = base > 0 ? (g.endVal / base - 1) * 100 : 0;
  });

  // Layout: top bar-chart strip, gap, then line chart, then x-axis labels.
  const padX        = 4;
  const barTop      = 10;
  const barH        = 36;
  const baselineY   = barTop + barH / 2;        // 0% line in bar strip
  const lineTop     = barTop + barH + 10;       // breathing space
  const xAxisH      = 18;                       // strip reserved for year labels
  const lineBot     = height - xAxisH - 2;
  const lineH       = lineBot - lineTop;

  const w   = width - padX * 2;
  const dx  = w / (series.length - 1);
  const xAt = i => padX + i * dx;

  // Bars scaled to the largest |YoY %| seen (capped at 200 to keep extreme
  // years from collapsing all other bars).
  let maxAbsPct = 1;
  for (const g of yearGroups) {
    const a = Math.abs(g.pct);
    if (a > maxAbsPct) maxAbsPct = a;
  }
  maxAbsPct = Math.min(maxAbsPct, 200);
  const halfBarSpace = barH / 2 - 3;
  const barScale     = halfBarSpace / maxAbsPct;

  let bars = '';
  let barLabels = '';
  for (let i = 0; i < yearGroups.length; i++) {
    const g     = yearGroups[i];
    const prev  = yearGroups[i - 1];
    const next  = yearGroups[i + 1];
    // Don't paint a bar for the entry-quarter snapshot group (one data point,
    // no prior year, used only as the YoY baseline for the next year).
    if (i === 0 && g.startIdx === g.endIdx) continue;
    // Left edge: midpoint between previous year's last sample and this
    // year's first sample, or chart's left edge if this is the first year.
    const xLeft  = prev ? (xAt(prev.endIdx) + xAt(g.startIdx)) / 2 : xAt(0);
    // Right edge: midpoint between this year's last sample and next year's
    // first sample, or chart's right edge if this is the final year.
    const xRight = next ? (xAt(g.endIdx) + xAt(next.startIdx)) / 2 : xAt(series.length - 1);
    // Tiny 1px gap between adjacent bars so the histogram reads as discrete
    // years instead of one continuous strip.
    const bw     = Math.max(0.5, xRight - xLeft - 1);

    const mag      = Math.min(Math.abs(g.pct), 200);
    const bh       = mag * barScale;
    const positive = g.pct >= 0;
    const by       = positive ? baselineY - bh : baselineY;
    const fill     = positive ? '#22c55e' : '#ef4444';
    bars += `<rect x="${xLeft.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${fill}"/>`;

    if (bw > 22) {
      const lbl   = (positive ? '+' : '') + Math.round(g.pct) + '%';
      const cx    = (xLeft + xRight) / 2;
      const ly    = positive ? Math.max(9, by - 2)
                             : Math.min(barTop + barH - 1, by + bh + 9);
      const color = positive ? '#86efac' : '#fca5a5';
      barLabels += `<text x="${cx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" font-weight="600" fill="${color}" stroke="rgba(10,14,23,0.9)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${lbl}</text>`;
    }
  }

  // 0% baseline through the bar strip.
  const baseline = `<line x1="${padX}" y1="${baselineY.toFixed(1)}" x2="${(width - padX).toFixed(1)}" y2="${baselineY.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>`;

  // Line chart of portfolio value across the same x-range. The y-scale
  // expands to include the baseline series too so both lines fit cleanly.
  let mn = Infinity, mx = -Infinity;
  for (const p of series) {
    if (p.value < mn) mn = p.value;
    if (p.value > mx) mx = p.value;
  }
  if (baselineSeries && baselineSeries.length) {
    for (const p of baselineSeries) {
      if (Number.isFinite(p.value)) {
        if (p.value < mn) mn = p.value;
        if (p.value > mx) mx = p.value;
      }
    }
  }
  if (mx <= mn) mx = mn + 1;
  const yLineAt = v => lineTop + (1 - (v - mn) / (mx - mn)) * lineH;

  let line = '';
  for (let i = 0; i < series.length; i++) {
    line += (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yLineAt(series[i].value).toFixed(1) + ' ';
  }
  const area = `M${xAt(0).toFixed(1)},${lineBot.toFixed(1)} ` + line.replace(/^M/, 'L') + `L${xAt(series.length - 1).toFixed(1)},${lineBot.toFixed(1)} Z`;

  // Baseline overlay: dashed muted line spanning the same x-range. If the
  // baseline has the same sample count as the strategy series we map
  // index-for-index; otherwise we treat it as a flat target and stretch
  // its first value across the full width.
  let baselinePath = '';
  let baselineEndLabel = '';
  if (baselineSeries && baselineSeries.length) {
    let bPath = '';
    if (baselineSeries.length === series.length) {
      for (let i = 0; i < baselineSeries.length; i++) {
        const v = baselineSeries[i].value;
        if (!Number.isFinite(v)) continue;
        bPath += (bPath === '' ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yLineAt(v).toFixed(1) + ' ';
      }
    } else {
      // Flat target — paint as a horizontal line at the (constant) value.
      const v = baselineSeries[baselineSeries.length - 1].value;
      if (Number.isFinite(v)) {
        const yy = yLineAt(v).toFixed(1);
        bPath = `M${xAt(0).toFixed(1)},${yy} L${xAt(series.length - 1).toFixed(1)},${yy}`;
      }
    }
    if (bPath) {
      baselinePath = `<path d="${bPath}" fill="none" stroke="rgba(226,232,240,0.55)" stroke-width="1.2" stroke-dasharray="3,3"/>`;
      // Dollar-value tag pinned at the right end of the dashed line —
      // shows the baseline's endpoint value so the user can compare it
      // against the strategy's end value at a glance.
      const lastV = baselineSeries[baselineSeries.length - 1].value;
      if (Number.isFinite(lastV)) {
        const yEnd = yLineAt(lastV);
        const xEnd = xAt(series.length - 1);
        baselineEndLabel = `<text x="${(xEnd - 4).toFixed(1)}" y="${(yEnd - 4).toFixed(1)}" text-anchor="end" font-family="JetBrains Mono" font-size="11" font-weight="600" fill="rgba(226,232,240,0.85)" stroke="rgba(10,14,23,0.92)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${fmtFull(Math.round(lastV))}</text>`;
      }
    }
  }

  // Start / end markers + value labels at the line endpoints. Decide whether
  // to place each label above or below the dot based on which side has more
  // breathing room (so labels don't crash into the bar strip or the bottom).
  const startX = xAt(0),                     startY = yLineAt(series[0].value);
  const endX   = xAt(series.length - 1),     endY   = yLineAt(series[series.length - 1].value);
  const labelAbove = (cy) => cy - lineTop > lineH * 0.45;
  const startLabelY = labelAbove(startY) ? startY - 6 : startY + 12;
  const endLabelY   = labelAbove(endY)   ? endY   - 6 : endY   + 12;
  const startTxt = fmtFull(Math.round(series[0].value));
  const endTxt   = fmtFull(Math.round(series[series.length - 1].value));
  const endpoints = `
    <circle cx="${startX.toFixed(1)}" cy="${startY.toFixed(1)}" r="2.6" fill="#22d3ee"/>
    <circle cx="${endX.toFixed(1)}"   cy="${endY.toFixed(1)}"   r="2.6" fill="#22d3ee"/>
    <text x="${(startX + 4).toFixed(1)}" y="${startLabelY.toFixed(1)}" text-anchor="start" font-family="JetBrains Mono" font-size="12" font-weight="700" fill="#e2e8f0" stroke="rgba(10,14,23,0.92)" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${startTxt}</text>
    <text x="${(endX - 15).toFixed(1)}"  y="${endLabelY.toFixed(1)}"   text-anchor="end"   font-family="JetBrains Mono" font-size="12" font-weight="700" fill="#e2e8f0" stroke="rgba(10,14,23,0.92)" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${endTxt}</text>
  `;

  // X-axis: year labels under each bar. Show every label when there's room
  // (≤ ~10 years), otherwise sample every Nth label and always include the
  // last so the right edge is anchored.
  const renderableYears = yearGroups.filter((g, i) => !(i === 0 && g.startIdx === g.endIdx));
  const xAxisLabelStep  = Math.max(1, Math.ceil(renderableYears.length / 10));
  const xAxisY          = lineBot + 13;
  let xAxis = '';
  renderableYears.forEach((g, i) => {
    const isLast = (i === renderableYears.length - 1);
    if (i % xAxisLabelStep !== 0 && !isLast) return;
    const cx = (xAt(g.startIdx) + xAt(g.endIdx)) / 2;
    xAxis += `<text x="${cx.toFixed(1)}" y="${xAxisY.toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="rgba(148,163,184,0.85)" stroke="rgba(10,14,23,0.85)" stroke-width="2.5" stroke-linejoin="round" paint-order="stroke">${g.year}</text>`;
  });
  // Subtle x-axis baseline.
  const xAxisLine = `<line x1="${padX}" y1="${(lineBot + 1).toFixed(1)}" x2="${(width - padX).toFixed(1)}" y2="${(lineBot + 1).toFixed(1)}" stroke="rgba(148,163,184,0.18)" stroke-width="0.5"/>`;

  return `<svg class="tt-line-chart" width="${width}" height="${height}" style="display:block;margin:6px 0">
    ${bars}
    ${baseline}
    <path d="${area}" fill="rgba(34,211,238,0.18)"/>
    ${baselinePath}
    <path d="${line}" fill="none" stroke="#22d3ee" stroke-width="1.5"/>
    ${barLabels}
    ${baselineEndLabel}
    ${endpoints}
    ${xAxisLine}
    ${xAxis}
  </svg>`;
}

function getSpiralSim(initial, monthly, rate, annualRaise, opts) {
  const smaP = _smaParamsForAnalytics();
  const _ug  = _underlyingAndGrowth();
  const key = JSON.stringify({
    initial, monthly, rate, annualRaise,
    s: opts && opts.switchTo9sig,
    a: opts && opts.switchToAllIn,
    w: opts && opts.yearsBack,
    sma: smaP,
    ul: _ug.sigUlCol,
    qg: _ug.qGrowth,
    cd: _ug.crashDropPct,
    sp: _ug.spikeTriggerPct,
  });
  if (_spiralSimKey === key && _spiralSim) return _spiralSim;
  _spiralSim    = _runAnalyticsSim(initial, monthly, rate, 0, quarterlyData.length - 1, annualRaise, opts);
  _spiralSimKey = key;
  return _spiralSim;
}

// Spiral chart for "Custom Growth (% per year)" mode. Uses D3 with the
// canonical "spiral path + getPointAtLength" technique (Stack Overflow's
// reference implementation): build a smooth radial spiral as a single SVG
// path, then walk along it placing one rect per data point at the right
// angle. One bar per year: the year-over-year change in the *first trading
// day's price* of the chosen strategy's underlying asset. Oldest year at
// the center, newest at the outer edge.
//
// Renders directly into `#analytics-heatmap` (mutates the DOM).
function renderSpiralChart(sim) {
  const grid = document.getElementById('analytics-heatmap');
  if (!grid) return;
  if (typeof d3 === 'undefined') {
    grid.innerHTML = '<div class="spiral-loading">D3 still loading — try again in a moment.</div>';
    return;
  }

  // Fast path: if the underlying sim, strategy, and DOM SVG are still the
  // same as the last render, ONLY the threshold can have changed. In that
  // case we just repaint the bar fills against the new threshold — no rebuild,
  // no resampling, no DOM churn. Makes the slider feel instant.
  const renderKey  = _spiralSimKey + '|' + analyticsStrategy;
  const stillMounted = grid.querySelector('.spiral-svg');
  if (renderKey === _spiralRenderKey && _spiralBarsSel && stillMounted) {
    const t = analyticsCustomGrowthPct;
    _spiralBarsSel.style('fill', d => d.pct >= t ? '#22c55e' : '#ef4444');
    return;
  }

  // Strategy's quarterly (date, value) series from the precomputed sim.
  const series = strategyDateValues(sim, analyticsStrategy);
  if (!series.length) {
    grid.innerHTML = '<div class="spiral-loading">Not enough data.</div>';
    return;
  }

  // Build year → strategy value at end of year. Each year's last quarterly
  // entry wins (Q4 close = Dec 31), so this captures end-of-year portfolio
  // value. For the in-progress latest year, the "end" is whatever the most
  // recent quarterly snapshot is (partial-YTD).
  const yearEndValue = new Map();
  for (const item of series) {
    const y = parseInt(item.date.substring(0, 4));
    yearEndValue.set(y, item.value);
  }
  const years = Array.from(yearEndValue.keys()).sort((a, b) => a - b);

  // One bar per year (skip the first, no prior year-end to compare against).
  // Each bar is labeled with the year it measures: bar "2025" = growth from
  // start of 2025 to start of 2026 (= Dec 31 2024 portfolio → Dec 31 2025).
  // The latest in-progress year compares Dec 31 last-year → most recent
  // quarterly snapshot, so it reads as partial-YTD.
  const lastSeriesEntry = series[series.length - 1];
  const lastMonth = parseInt(lastSeriesEntry.date.substring(5, 7));
  const lastDay   = parseInt(lastSeriesEntry.date.substring(8, 10));
  const latestYearComplete = (lastMonth === 12 && lastDay >= 28);

  const points = [];
  for (let i = 1; i < years.length; i++) {
    const yPrev = years[i - 1], yCur = years[i];
    const startV = yearEndValue.get(yPrev);
    const endV   = yearEndValue.get(yCur);
    if (!(startV > 0 && endV > 0)) continue;
    const isLast = (i === years.length - 1);
    points.push({
      year:      yCur,
      pct:       (endV / startV - 1) * 100,
      prevPrice: startV, // strategy value at start of yCur
      price:     endV,   // strategy value at end of yCur (or latest, if partial)
      partial:   isLast && !latestYearComplete,
    });
  }
  if (!points.length) {
    grid.innerHTML = '<div class="spiral-loading">Not enough data.</div>';
    return;
  }

  // Mount point — fill the existing heatmap container.
  grid.innerHTML = '<div class="spiral-wrap"></div>';
  const wrap   = grid.querySelector('.spiral-wrap');
  const w      = wrap.clientWidth  || 600;
  const h      = wrap.clientHeight || 600;
  const size   = Math.max(300, Math.min(w, h));
  const r      = size / 2 - 40;

  // Spiral params: oldest at center, exactly 4 full turns clockwise so the
  // path ends at 12 o'clock (the latest year sits at the top of the figure).
  const start       = 0;
  const end         = 2.0;
  const numSpirals  = 4;
  // Negative angle → wind in the opposite direction. With d3.lineRadial's
  // angle convention (0 at 12 o'clock, positive = one direction), negating
  // here flips the spiral's progression so chronological order (oldest at
  // center → newest at outer edge) winds clockwise as viewed on screen.
  const theta       = (rr) => -numSpirals * Math.PI * rr;
  const radius      = d3.scaleLinear().domain([start, end]).range([40, r]);

  const svg = d3.select(wrap).append('svg')
    .attr('width', size)
    .attr('height', size)
    .attr('class', 'spiral-svg');
  const g = svg.append('g')
    .attr('transform', `translate(${size / 2},${size / 2})`);

  // Draw the underlying spiral as a path so we can walk along it.
  const samples    = d3.range(start, end + 0.001, (end - start) / 1000);
  const spiralLine = d3.lineRadial()
    .curve(d3.curveCardinal)
    .angle(theta)
    .radius(radius);
  const path = g.append('path')
    .datum(samples)
    .attr('id', 'spiral-guide')
    .attr('d', spiralLine)
    .style('fill', 'none')
    .style('stroke', 'rgba(100,116,139,0.18)')
    .style('stroke-width', 1);

  const spiralLength = path.node().getTotalLength();
  const N            = points.length;
  const barWidth = 48;

  // Compressed height range with a log curve, so a +200% year isn't
  // visually 10× a +20% year — they read as the same "kind of bar" with
  // a small magnitude hint.
  const minBarH  = 18;
  const maxBarH  = 41;
  const logCap   = Math.log1p(200);
  const heightFor = (pctMag) => minBarH + (Math.log1p(Math.min(pctMag, 200)) / logCap) * (maxBarH - minBarH);
  const threshold = analyticsCustomGrowthPct;

  // Build each bar as a *polygon that follows the actual spiral segment*.
  // For each bar we sample the spiral guide path at several points across
  // the bar's arc-length width, push each sample perpendicular to the local
  // tangent by ±height/2, and connect them as a closed polygon. The bar's
  // centerline therefore traces the spiral exactly, and the inner/outer
  // edges stay parallel to the spiral even on the tightly-wound inner turns.
  const SAMPLES_PER_BAR = 6;

  // Sample the spiral path with linear extrapolation past either endpoint —
  // ensures bars at the very start or end (e.g. the latest year sitting at
  // 12 o'clock) render as complete polygons instead of collapsing because
  // their out-of-range samples got clamped to the same endpoint.
  function spiralPointAt(lp) {
    if (lp >= 0 && lp <= spiralLength) return path.node().getPointAtLength(lp);
    if (lp > spiralLength) {
      const end  = path.node().getPointAtLength(spiralLength);
      const back = path.node().getPointAtLength(Math.max(0, spiralLength - 1));
      const overshoot = lp - spiralLength;
      return { x: end.x + (end.x - back.x) * overshoot, y: end.y + (end.y - back.y) * overshoot };
    }
    // lp < 0
    const start = path.node().getPointAtLength(0);
    const fwd   = path.node().getPointAtLength(Math.min(spiralLength, 1));
    return { x: start.x + (start.x - fwd.x) * (-lp), y: start.y + (start.y - fwd.y) * (-lp) };
  }

  const bars = g.selectAll('path.spiral-bar')
    .data(points)
    .enter()
    .append('path')
    .attr('class', 'spiral-bar')
    .each(function (d, i) {
      const linePer = N > 1 ? (i / (N - 1)) * spiralLength : 0;
      const pos     = path.node().getPointAtLength(linePer);
      const ahead   = path.node().getPointAtLength(Math.min(linePer + 1, spiralLength));
      d.x = pos.x;
      d.y = pos.y;
      d.a = Math.atan2(ahead.y - pos.y, ahead.x - pos.x) * 180 / Math.PI;
      d.dist = Math.hypot(pos.x, pos.y) || 1;
      d.linePer = linePer;
    })
    .attr('d', d => {
      const h     = heightFor(Math.abs(d.pct));
      const halfH = h / 2;
      // Sample the spiral guide across the bar's arc-length range, using
      // linear extrapolation past either endpoint so the start/end bars are
      // complete polygons (no collapse on out-of-range clamping).
      const inner = []; // edge facing the spiral center
      const outer = []; // edge facing outward
      for (let s = 0; s <= SAMPLES_PER_BAR; s++) {
        const t  = (s / SAMPLES_PER_BAR - 0.5) * barWidth; // -halfBar..+halfBar
        const lp = d.linePer + t;
        const p  = spiralPointAt(lp);
        const q  = spiralPointAt(lp + 0.75);
        const tx = q.x - p.x, ty = q.y - p.y;
        const tlen = Math.hypot(tx, ty) || 1;
        // Perpendicular to the local tangent (rotate +90°).
        let nx = -ty / tlen;
        let ny =  tx / tlen;
        // Make sure nx,ny points OUTWARD (radially away from origin) so
        // "outer" stays consistent across the bar (otherwise the polygon
        // self-intersects when the spiral curves heavily).
        const radDot = nx * p.x + ny * p.y;
        if (radDot < 0) { nx = -nx; ny = -ny; }
        outer.push([p.x + nx * halfH, p.y + ny * halfH]);
        inner.push([p.x - nx * halfH, p.y - ny * halfH]);
      }
      let pathD = `M ${outer[0][0].toFixed(2)} ${outer[0][1].toFixed(2)}`;
      for (let k = 1; k < outer.length; k++) pathD += ` L ${outer[k][0].toFixed(2)} ${outer[k][1].toFixed(2)}`;
      for (let k = inner.length - 1; k >= 0; k--) pathD += ` L ${inner[k][0].toFixed(2)} ${inner[k][1].toFixed(2)}`;
      return pathD + ' Z';
    })
    .style('fill', d => d.pct >= threshold ? '#22c55e' : '#ef4444')
    .style('stroke', 'none')
    .attr('data-year', d => d.year)
    .attr('data-pct',  d => d.pct.toFixed(2));

  // Custom rich tooltip on hover (same .tt-* classes as the heatmap grid
  // tooltip) — appears instantly, follows the cursor.
  const tooltip = document.getElementById('heatmap-tooltip');
  if (tooltip) {
    bars
      .style('cursor', 'pointer')
      .on('mouseenter', function (event, d) { showSpiralTooltip(tooltip, event, d, threshold); })
      .on('mousemove',  function (event)    { if (!tooltip.hasAttribute('hidden')) positionSpiralTooltip(tooltip, event); })
      .on('mouseleave', function ()         { tooltip.setAttribute('hidden', ''); });
  }

  // Percent text *inside* each bar — small and bold, white for contrast on
  // green/red. Same tangent-rotation + auto-flip logic as year labels.
  g.selectAll('text.spiral-pct')
    .data(points)
    .enter()
    .append('text')
    .attr('class', 'spiral-pct')
    .attr('x', d => d.x)
    .attr('y', d => d.y)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .style('font', '700 8.4px "JetBrains Mono", monospace')
    .style('fill', '#ffffff')
    .style('pointer-events', 'none')
    .attr('transform', d => {
      const flip = d.a > 90 || d.a < -90;
      return `rotate(${flip ? d.a + 180 : d.a},${d.x},${d.y})`;
    })
    .text(d => (d.pct >= 0 ? '+' : '') + Math.round(d.pct) + '%');

  // Per-bar year labels. Each label sits just outside its bar along the
  // *radial-outward* direction (computed directly from origin → bar vector),
  // so labels always end up on the side facing away from the spiral center
  // — including the last year, which sits above the figure's top. The
  // rotation matches the local tangent so labels read "along" the spiral,
  // and we auto-flip 180° on the back half of each turn so no label ends up
  // upside-down.
  g.selectAll('text.spiral-year')
    .data(points)
    .enter()
    .append('text')
    .attr('class', 'spiral-year')
    .each(function (d) {
      const dist   = Math.hypot(d.x, d.y) || 1;
      const offset = heightFor(Math.abs(d.pct)) / 2 + 9;
      d.tx = d.x + (d.x / dist) * offset;
      d.ty = d.y + (d.y / dist) * offset;
    })
    .attr('x', d => d.tx)
    .attr('y', d => d.ty)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .style('font', '8.4px "JetBrains Mono", monospace')
    .style('fill', 'rgba(148,163,184,0.75)')
    .style('pointer-events', 'none')
    .attr('transform', d => {
      const flip = d.a > 90 || d.a < -90;
      return `rotate(${flip ? d.a + 180 : d.a},${d.tx},${d.ty})`;
    })
    .text(d => d.year);

  // Cache the rendered chart so the next slider-only change can repaint
  // colors instead of rebuilding from scratch.
  _spiralRenderKey = renderKey;
  _spiralBarsSel   = bars;
  _spiralPoints    = points;
}

async function buildHeatmap() {
  if (!quarterlyData) return;
  const epoch = ++analyticsBuildEpoch;
  const grid = document.getElementById('analytics-heatmap');
  const progEl = document.getElementById('analytics-progress');
  const progBar = document.getElementById('analytics-progress-bar');
  const progText = document.getElementById('analytics-progress-text');

  // Mirror render()'s parameter pull
  const initial = sliderToInitial(+document.getElementById('slider-initial').value);
  const monthly = +document.getElementById('slider-monthly').value;
  const annualRaise = +document.getElementById('slider-raise').value / 100;
  const rate = sliderToRate(+document.getElementById('slider-rate').value) / 100;
  const tqqqAboveMult = +document.getElementById('select-tqqq-above').value;
  const tqqqBelowMult = +document.getElementById('select-tqqq-below').value;
  const tqqqWindow    = +document.getElementById('select-tqqq-window').value;
  const switchTo9sig  = tqqqAboveMult * 100;
  const switchToAllIn = tqqqBelowMult > 0 ? 100 / tqqqBelowMult : 100;
  // Cache the adaptive states once — they're identical for every cell.
  const { sigUlCol: _ulC, qGrowth: _qG } = _underlyingAndGrowth();
  const adaptiveStates = computeAdaptiveStates(switchTo9sig, switchToAllIn, tqqqWindow, _ulC, _qG);
  const opts = { switchTo9sig, switchToAllIn, yearsBack: tqqqWindow, adaptiveStates };

  renderAnalyticsMetrics(initial, monthly, annualRaise, rate, tqqqAboveMult, tqqqBelowMult, tqqqWindow, analyticsStrategy);
  const subEl = document.querySelector('.analytics-chart-sub');
  if (subEl) {
    if (analyticsBaseline === 'custom-pct') {
      // Spiral mode: no rows/columns; each bar represents one calendar year
      // of growth in the strategy's portfolio value.
      const sign   = analyticsCustomGrowthPct >= 0 ? '+' : '';
      const pctTxt = (analyticsCustomGrowthPct % 1 === 0 ? analyticsCustomGrowthPct.toFixed(0) : analyticsCustomGrowthPct.toFixed(1));
      const bLabel = `${sign}${pctTxt}% per year`;
      subEl.innerHTML = `each bar = one calendar year · oldest at center, latest at outer edge · bar color vs <strong>${bLabel}</strong> (green = grew at least that much, red = didn\'t)`;
    } else {
      let bLabel, modeNote;
      if (analyticsBaseline === 'custom') {
        bLabel   = `Custom Target (${fmtFull(analyticsCustomTarget)})`;
        modeNote = 'green = hit the goal, red = below it';
      } else {
        bLabel   = BASELINE_LABELS[analyticsBaseline] || 'baseline';
        modeNote = '1× = match, anchored at slate midpoint';
      }
      subEl.innerHTML = `rows: year you started investing &nbsp;·&nbsp; columns: N years later &nbsp;·&nbsp; cell color vs <strong>${bLabel}</strong> (${modeNote})`;
    }
  }

  // Spiral mode: run a single full-history simulate() with the user's
  // current params (initial / monthly / raise / cash rate / adaptive params)
  // and feed its strategy-value series into the spiral. The sim is cached
  // by params, so dragging the threshold slider only repaints — no resim.
  if (analyticsBaseline === 'custom-pct') {
    progEl.setAttribute('hidden', '');
    const fullSim = getSpiralSim(initial, monthly, rate, annualRaise, opts);
    renderSpiralChart(fullSim);
    return;
  }

  // Year -> first/last quarter index.
  const yearFirst = new Map();
  const yearLast  = new Map();
  for (let i = 0; i < quarterlyData.length; i++) {
    const y = parseInt(quarterlyData[i][0].substring(0, 4));
    if (!yearFirst.has(y)) yearFirst.set(y, i);
    yearLast.set(y, i);
  }
  const allYears = Array.from(yearFirst.keys()).sort((a, b) => a - b);
  if (allYears.length < 2) { grid.classList.remove('loading'); grid.textContent = 'Not enough data.'; return; }
  const minYear = allYears[0];
  const maxYear = allYears[allYears.length - 1];
  const periods = [];
  for (let p = 1; p <= (maxYear - minYear); p++) periods.push(p);

  // Build the list of valid (startYear, period) cells. The row is the year
  // you started investing; the column is "N years later". Entry anchors at
  // the *last trading day of the previous year* — that's effectively the
  // first close of the starting year, matching what a normal person means by
  // "I invested at the start of 2025". For the earliest year in the dataset
  // (no prior year exists), we fall back to the first quarter of the starting
  // year. We include the latest year (maxYear) even when only partial data
  // exists for it — its row will just show fewer columns / partial-year values.
  // Floor entry by the most-restrictive of (selected heatmap strategy,
  // selected heatmap baseline) — and ONLY those. The main chart's legend
  // visibility is independent: hiding SOXL on the main chart shouldn't shrink
  // the heatmap, and showing it shouldn't shrink it either unless the heatmap
  // itself is using SOXL data.
  let floorEntryIdx = 0;
  for (const k of [analyticsStrategy, analyticsBaseline]) {
    if (!k) continue;
    const e = (typeof earliestQIdxOf === 'function') ? earliestQIdxOf(k) : 0;
    if (e > floorEntryIdx) floorEntryIdx = e;
  }

  const cells = [];
  for (let sy = maxYear; sy >= minYear; sy--) {
    for (const p of periods) {
      const endYear = sy + p - 1;
      if (endYear > maxYear) continue;
      if (!yearLast.has(endYear)) continue;
      const entryIdx = (sy > minYear && yearLast.has(sy - 1))
        ? yearLast.get(sy - 1)
        : yearFirst.get(sy);
      if (entryIdx == null) continue;
      if (entryIdx < floorEntryIdx) continue;
      const exitIdx  = yearLast.get(endYear);
      if (exitIdx - entryIdx < 1) continue; // need at least one quarter of span
      cells.push({ year: sy, period: p, entryIdx, exitIdx, value: 0 });
    }
  }
  const lookup = new Map();
  for (const c of cells) lookup.set(c.year + ':' + c.period, c);

  // Reuse the existing skeleton if its structure matches the expected cell
  // set — then we don't blow away the previous run's values + colors when
  // the user changes a parameter. The new build overwrites each cell
  // in-place as its sim completes; until then the old colors stay visible.
  const expectedYps = new Set();
  for (const c of cells) expectedYps.add(c.year + ':' + c.period);
  const existingTable = grid.querySelector('table.heatmap-table');
  let canReuse = !!existingTable;
  if (canReuse) {
    const existingTds = existingTable.querySelectorAll('td.heatmap-cell[data-yp]');
    if (existingTds.length !== expectedYps.size) {
      canReuse = false;
    } else {
      for (const td of existingTds) {
        if (!expectedYps.has(td.dataset.yp)) { canReuse = false; break; }
      }
    }
  }
  if (!canReuse) {
    // First open (or structure changed) → render empty skeleton.
    const headerHTML = '<tr><th></th>' + periods.map(p => `<th data-c="${p}">${p}y</th>`).join('') + '</tr>';
    const bodyParts = [];
    for (let sy = maxYear; sy >= minYear; sy--) {
      bodyParts.push(`<tr><th data-r="${sy}">${sy}</th>`);
      for (const p of periods) {
        const c = lookup.get(sy + ':' + p);
        bodyParts.push(c
          ? `<td class="heatmap-cell" data-yp="${sy}:${p}" data-r="${sy}" data-c="${p}"></td>`
          : `<td class="heatmap-cell empty" data-r="${sy}" data-c="${p}"></td>`);
      }
      bodyParts.push('</tr>');
    }
    grid.innerHTML = '<table class="heatmap-table"><thead>' + headerHTML + '</thead><tbody>' + bodyParts.join('') + '</tbody></table>';
  }
  grid.classList.remove('loading');
  // Heatmap-mode rebuild wipes the spiral SVG → invalidate its cache.
  _spiralRenderKey = null;
  _spiralBarsSel   = null;
  _spiralPoints    = null;
  const cellRefs = new Map();
  grid.querySelectorAll('td.heatmap-cell[data-yp]').forEach(td => cellRefs.set(td.dataset.yp, td));

  // Show progress
  progEl.removeAttribute('hidden');
  progBar.style.width = '0%';
  progText.textContent = '0 / ' + cells.length;

  // Per-row optimization: every cell with the same start year shares the
  // same entryIdx, and simulate() is forward-only — so one sim from
  // entryIdx → max(exitIdx in row) gives every shorter cell's answer too.
  // Cuts ~2640 sims down to ~88 sims, with each cell sampled at the right
  // quarter offset. Plus simulate's monthly-contribution loops now use the
  // O(1) monthlyByQuarter index, so each sim is also faster.
  const cellsByRow = new Map();
  for (const c of cells) {
    let arr = cellsByRow.get(c.year);
    if (!arr) { arr = []; cellsByRow.set(c.year, arr); }
    arr.push(c);
  }

  const strat = analyticsStrategy;
  let processed = 0;
  let rowsProcessed = 0;
  const totalRows = cellsByRow.size;
  for (const [, rowCells] of cellsByRow) {
    const entryIdx = rowCells[0].entryIdx;
    let maxExitIdx = entryIdx;
    for (const c of rowCells) if (c.exitIdx > maxExitIdx) maxExitIdx = c.exitIdx;

    const sim = _runAnalyticsSim(initial, monthly, rate, entryIdx, maxExitIdx, annualRaise, opts);
    const stratSeries = strategyValueArray(sim, strat);
    const ddPrefix    = computeMaxDDPrefix(stratSeries);

    for (const c of rowCells) {
      const offset = c.exitIdx - entryIdx;
      c.value   = strategyValueAtOffset(sim, strat, offset);
      const baseline = baselineValueAtOffset(sim, analyticsBaseline, offset);
      c.derived = baseline > 0 && c.value > 0 ? c.value / baseline : 0;
      c.maxDD   = ddPrefix[offset] || 0;

      const td = cellRefs.get(c.year + ':' + c.period);
      if (td) {
        const endYear = c.year + c.period - 1;
        td.innerHTML = `<span class="cell-val">${fmt3sig(c.value)}</span><span class="cell-year">${endYear}</span>`;
        td.dataset.value   = String(c.value);
        td.dataset.derived = String(c.derived);
        td.dataset.endYear = String(endYear);
        td.dataset.maxDd   = String(c.maxDD);
      }
      processed++;
    }

    rowsProcessed++;
    // Yield once per row instead of per cell — far fewer rAF round-trips
    // than the old chunked-by-30-cells approach.
    progBar.style.width = ((processed / cells.length) * 100).toFixed(1) + '%';
    progText.textContent = processed + ' / ' + cells.length;
    if (rowsProcessed % 8 === 0 || rowsProcessed === totalRows) {
      await new Promise(r => requestAnimationFrame(r));
      if (epoch !== analyticsBuildEpoch) return;
    }
  }

  // Global log-derived range for the diverging color scale.
  let minLogD = 0, maxLogD = 0;
  for (const c of cells) {
    if (c.derived > 0) {
      const ld = Math.log(c.derived);
      if (ld < minLogD) minLogD = ld;
      if (ld > maxLogD) maxLogD = ld;
    }
  }

  // Apply colors: diverging palette anchored at derived = 1 (intensity 0.5).
  // Above 1 gradates toward green, below 1 toward red, log-spaced so a 4×
  // baseline cell looks the same regardless of period length or scale.
  for (const c of cells) {
    const td = cellRefs.get(c.year + ':' + c.period);
    if (!td) continue;
    let intensity = 0.5;
    if (c.derived > 0) {
      const ld = Math.log(c.derived);
      if (ld >= 0 && maxLogD > 0) {
        intensity = 0.5 + 0.5 * (ld / maxLogD);
      } else if (ld < 0 && minLogD < 0) {
        intensity = 0.5 - 0.5 * (ld / minLogD);
      } else {
        intensity = 0.5;
      }
    }
    intensity = Math.max(0, Math.min(1, intensity));
    let r, g, b;
    if (analyticsBaseline === 'custom') {
      // Binary mode for "Custom Target": flat green if the cell hit the goal,
      // flat red if not. No gradient — the question is binary ("did I get
      // there?") so the color should be too.
      if (c.value >= analyticsCustomTarget) { r = 34;  g = 197; b = 94;  } // #22c55e
      else                                  { r = 239; g = 68;  b = 68;  } // #ef4444
    } else if (analyticsBaseline === 'custom-pct') {
      // Year-over-year growth check: did this cell's value increase by ≥ X%
      // vs the same starting year's previous-period cell (one column to the
      // left)? Each column represents +1 year of holding, so this measures
      // growth during that single year. Period 1 has no prior column, so it
      // falls back to comparing against the entry point (initial investment).
      const prevC = c.period > 1 ? lookup.get(c.year + ':' + (c.period - 1)) : null;
      const prevValue = prevC ? prevC.value : initial;
      const threshold = prevValue * (1 + analyticsCustomGrowthPct / 100);
      if (prevValue > 0 && c.value >= threshold) { r = 34;  g = 197; b = 94;  } // green
      else                                       { r = 239; g = 68;  b = 68;  } // red
    } else {
      // Diverging palette: red-500 (#ef4444) → slate-600 (#475569) → green-500
      // (#22c55e). Pre-apply a sqrt-based curve so small deviations from the
      // 0.5 midpoint produce strong visible color shifts — "slight red" and
      // "slight green" cells are clearly distinguishable from each other
      // and from the neutral midpoint.
      const delta = intensity - 0.5;
      const curvedDelta = Math.sign(delta) * Math.pow(Math.abs(delta) * 2, 0.5) * 0.5;
      const t = 0.5 + curvedDelta;
      if (t < 0.5) {
        const u = t * 2;
        r = Math.round(239 + (71  - 239) * u);
        g = Math.round(68  + (85  - 68)  * u);
        b = Math.round(68  + (105 - 68)  * u);
      } else {
        const u = (t - 0.5) * 2;
        r = Math.round(71  + (34  - 71)  * u);
        g = Math.round(85  + (197 - 85)  * u);
        b = Math.round(105 + (94  - 105) * u);
      }
    }
    td.style.background = `rgb(${r},${g},${b})`;
  }

  progEl.setAttribute('hidden', '');
}
