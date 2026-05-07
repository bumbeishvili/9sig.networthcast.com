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

const ANALYTICS_MAX_PERIOD = 40;

const STRATEGY_LABELS = {
  'adaptive': 'Adaptive',
  '9sig':     '9sig',
  'bh-tqqq':  'B&H TQQQ',
  'bh-qqq':   'B&H QQQ',
  'bh-spy':   'B&H SPY',
};

let analyticsStrategy = 'adaptive';
let analyticsBaseline = 'compounded';
let analyticsCustomTarget = 1000000; // default $1M when "Custom Target" is selected
let analyticsBuildEpoch = 0;
let analyticsRefreshTimer = null;

const BASELINE_LABELS = {
  'compounded': 'Compounded Cash',
  'bh-spy':     'B&H SPY',
  'bh-qqq':     'B&H QQQ',
  'adaptive':   'Adaptive',
  '9sig':       '9sig',
  'bh-tqqq':    'B&H TQQQ',
  'custom':     'Custom Target',
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

// Pull a baseline value out of a simulate() result for the chosen divisor.
// 'compounded' is the cash-only baseline plotted as "Invested Compounded";
// the others mirror strategyFinalValue.
function baselineFinalValue(sim, key) {
  switch (key) {
    case 'custom':    return analyticsCustomTarget;
    case '9sig':      { const a = sim.log;           return a && a.length ? a[a.length - 1].total : 0; }
    case 'bh-tqqq':   { const a = sim.bhPoints;      return a && a.length ? a[a.length - 1].value : 0; }
    case 'bh-qqq':    { const a = sim.qqqPoints;     return a && a.length ? a[a.length - 1].value : 0; }
    case 'bh-spy':    { const a = sim.spyPoints;     return a && a.length ? a[a.length - 1].value : 0; }
    case 'adaptive':  { const a = sim.adaptivePoints;return a && a.length ? a[a.length - 1].value : 0; }
    case 'compounded':
    default:          { const a = sim.log;           return a && a.length ? a[a.length - 1].investedCompounded : 0; }
  }
}

// Pull the chosen strategy's final value out of a simulate() result.
function strategyFinalValue(sim, strat) {
  switch (strat) {
    case '9sig': {
      const log = sim.log;
      return log && log.length ? log[log.length - 1].total : 0;
    }
    case 'bh-tqqq': {
      const a = sim.bhPoints;
      return a && a.length ? a[a.length - 1].value : 0;
    }
    case 'bh-qqq': {
      const a = sim.qqqPoints;
      return a && a.length ? a[a.length - 1].value : 0;
    }
    case 'bh-spy': {
      const a = sim.spyPoints;
      return a && a.length ? a[a.length - 1].value : 0;
    }
    case 'adaptive':
    default: {
      const a = sim.adaptivePoints;
      return a && a.length ? a[a.length - 1].value : 0;
    }
  }
}

// Extract the per-quarter value series of a strategy from a simulate() result.
// Used to compute max drawdown.
function strategySeries(sim, strat) {
  switch (strat) {
    case '9sig':     return sim.log           ? sim.log.map(l => l.total)            : [];
    case 'bh-tqqq':  return sim.bhPoints      ? sim.bhPoints.map(p => p.value)       : [];
    case 'bh-qqq':   return sim.qqqPoints     ? sim.qqqPoints.map(p => p.value)      : [];
    case 'bh-spy':   return sim.spyPoints     ? sim.spyPoints.map(p => p.value)      : [];
    case 'adaptive':
    default:         return sim.adaptivePoints? sim.adaptivePoints.map(p => p.value) : [];
  }
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
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isAnalyticsOpen()) toggleAnalytics();
});

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
    if (customInput) {
      if (analyticsBaseline === 'custom') {
        customInput.removeAttribute('hidden');
        customInput.value = fmtFull(analyticsCustomTarget);
      } else {
        customInput.setAttribute('hidden', '');
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

// Metric dropdowns inside the modal — change feeds back to the underlying
// page slider/select, dispatches the appropriate event so the main chart
// updates and localStorage saves, then rebuilds the heatmap.
document.addEventListener('change', (e) => {
  if (!e.target || !e.target.classList || !e.target.classList.contains('metric-select')) return;
  const key = e.target.dataset.metricKey;
  const value = parseFloat(e.target.value);
  if (!Number.isFinite(value)) return;
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
  switch (key) {
    case 'initial': fireInput('slider-initial', initialToSlider(value)); break;
    case 'monthly': fireInput('slider-monthly', value); break;
    case 'raise':   fireInput('slider-raise',   value); break;
    case 'rate':    fireInput('slider-rate',    value); break;
    case 'tu':      fireChange('select-tqqq-above',  value); break;
    case 'td':      fireChange('select-tqqq-below',  value); break;
    case 'tw':      fireChange('select-tqqq-window', value); break;
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
    const baselineVal = derived > 0 ? value / derived : 0;
    const stratLabel = STRATEGY_LABELS[analyticsStrategy] || 'Adaptive';
    const baseLabel  = analyticsBaseline === 'custom'
      ? `Target ${fmtFull(analyticsCustomTarget)}`
      : (BASELINE_LABELS[analyticsBaseline] || 'Baseline');
    const maxV = Math.max(value, baselineVal) || 1;
    const w1 = (value / maxV * 100).toFixed(1);
    const w2 = (baselineVal / maxV * 100).toFixed(1);
    const ddStr = Number.isFinite(maxDD) && maxDD > 0 ? '−' + (maxDD * 100).toFixed(1) + '%' : '0.0%';

    // Investment scenario — pulled live from the sliders so the tooltip
    // always reflects the params currently driving the heatmap. Hides any
    // line item that's at zero/default to keep the line short.
    const initial = sliderToInitial(+document.getElementById('slider-initial').value);
    const monthly = +document.getElementById('slider-monthly').value;
    const annualRaise = +document.getElementById('slider-raise').value / 100;
    const scenarioParts = [];
    if (initial > 0) scenarioParts.push(`Initial ${fmtFull(initial)}`);
    if (monthly > 0) {
      let m = `Monthly ${fmtFull(monthly)}`;
      if (annualRaise > 0) m += ` (${(annualRaise * 100).toFixed(annualRaise * 100 % 1 === 0 ? 0 : 1)}%/y raise)`;
      scenarioParts.push(m);
    }
    if (analyticsStrategy === 'adaptive') {
      const tu = document.getElementById('select-tqqq-above').value;
      const td2 = document.getElementById('select-tqqq-below').value;
      const tw = document.getElementById('select-tqqq-window').value;
      scenarioParts.push(`→9sig ×${tu} · →TQQQ ×${td2} · ${tw}y window`);
    }

    tooltip.innerHTML = `
      <div class="tt-period">Invested ${startYear} · ${period}y later · ended ${endYear}</div>
      <div class="tt-scenario">${scenarioParts.join(' &middot; ')}</div>
      <div class="tt-strat">${stratLabel} Final Value</div>
      <div class="tt-bars">
        <div class="tt-bar-row tt-bar-primary">
          <span class="tt-bar-label">${stratLabel}</span>
          <div class="tt-bar-track"><div class="tt-bar-fill" style="width:${w1}%"></div></div>
          <span class="tt-bar-value">(${fmtFull(Math.round(value))})</span>
        </div>
        <div class="tt-bar-row">
          <span class="tt-bar-label">vs ${baseLabel}</span>
          <div class="tt-bar-track"><div class="tt-bar-fill" style="width:${w2}%"></div></div>
          <span class="tt-bar-value">(${fmtFull(Math.round(baselineVal))})</span>
        </div>
      </div>
      <div class="tt-foot">
        <span>Max drawdown</span>
        <span class="tt-dd">${ddStr}</span>
      </div>
    `;
  }

  grid.addEventListener('mousemove', (e) => {
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
  initial: [0, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000],
  monthly: [0, 100, 250, 500, 1000, 2000, 5000, 10000, 25000],
  raise:   [0, 1, 2, 3, 5, 7, 10, 15],
  rate:    [0, 1, 2, 3, 4, 5, 6, 8],
  tu:      [1.0, 1.2, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0, 4.0, 5.0],
  td:      [1.0, 1.1, 1.2, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0],
  tw:      [1, 2, 3, 5, 6, 8, 10, 12, 15, 20, 25, 30],
};

function metricSelect(key, label, current, fmt) {
  const base = METRIC_OPTS[key].slice();
  if (!base.some(v => Math.abs(v - current) < 1e-9)) base.push(current);
  base.sort((a, b) => a - b);
  const optionsHtml = base.map(v =>
    `<option value="${v}"${Math.abs(v - current) < 1e-9 ? ' selected' : ''}>${fmt(v)}</option>`
  ).join('');
  return `<span class="metric">${label} <select class="metric-select" data-metric-key="${key}">${optionsHtml}</select></span>`;
}

function renderAnalyticsMetrics(initial, monthly, annualRaise, rate, tqqqAboveMult, tqqqBelowMult, tqqqWindow, strategy) {
  const m = document.getElementById('analytics-metrics');
  if (!m) return;
  const pct = (x) => (x % 1 === 0 ? x.toFixed(0) : x.toFixed(1)) + '%';
  const items = [];
  // Hide each pill when its value can't influence the result:
  //   - Initial:           hide when 0
  //   - Monthly:           hide when 0 (and the raise pill, since raise scales monthly)
  //   - Annual raise:      hide when 0 OR when monthly = 0 (no contributions to scale)
  //   - Cash interest rate: hide for B&H strategies (no cash held) and when no cash flow
  //                         (monthly = 0 AND initial = 0)
  const usesCash = (strategy === '9sig' || strategy === 'adaptive');
  if (initial > 0)                       items.push(metricSelect('initial', 'Initial', initial, fmtFull));
  if (monthly > 0)                       items.push(metricSelect('monthly', 'Monthly', monthly, fmtFull));
  if (monthly > 0 && annualRaise > 0)    items.push(metricSelect('raise',   'Annual raise', annualRaise * 100, pct));
  if (usesCash && (initial > 0 || monthly > 0)) items.push(metricSelect('rate', 'Cash interest rate', rate * 100, pct));
  if (strategy === 'adaptive') {
    items.push(metricSelect('tu', '→ 9sig', tqqqAboveMult, x => `×${x}`));
    items.push(metricSelect('td', '→ TQQQ', tqqqBelowMult, x => `×${x}`));
    items.push(metricSelect('tw', 'Window', tqqqWindow,   x => `${x}y`));
  }
  m.innerHTML = items.join('');
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
  const rate = +document.getElementById('slider-rate').value / 100;
  const tqqqAboveMult = +document.getElementById('select-tqqq-above').value;
  const tqqqBelowMult = +document.getElementById('select-tqqq-below').value;
  const tqqqWindow    = +document.getElementById('select-tqqq-window').value;
  const switchTo9sig  = tqqqAboveMult * 100;
  const switchToAllIn = tqqqBelowMult > 0 ? 100 / tqqqBelowMult : 100;
  // Cache the adaptive states once — they're identical for every cell.
  const adaptiveStates = computeAdaptiveStates(switchTo9sig, switchToAllIn, tqqqWindow);
  const opts = { switchTo9sig, switchToAllIn, yearsBack: tqqqWindow, adaptiveStates };

  renderAnalyticsMetrics(initial, monthly, annualRaise, rate, tqqqAboveMult, tqqqBelowMult, tqqqWindow, analyticsStrategy);
  const titleEl = document.getElementById('analytics-chart-title');
  if (titleEl) titleEl.textContent = (STRATEGY_LABELS[analyticsStrategy] || 'Adaptive') + ' — Final Value';
  const subEl = document.querySelector('.analytics-chart-sub');
  if (subEl) {
    const bLabel = analyticsBaseline === 'custom'
      ? `Custom Target (${fmtFull(analyticsCustomTarget)})`
      : (BASELINE_LABELS[analyticsBaseline] || 'baseline');
    subEl.innerHTML = `rows: year you started investing &nbsp;·&nbsp; columns: N years later &nbsp;·&nbsp; cell color: log of performance against <strong>${bLabel}</strong> (1× = match, anchored at slate midpoint)`;
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
  for (let p = 1; p <= ANALYTICS_MAX_PERIOD && p <= (maxYear - minYear); p++) periods.push(p);

  // Build the list of valid (startYear, period) cells. The row is the year
  // you started investing; the column is "N years later". Entry anchors at
  // the *last trading day of the previous year* — that's effectively the
  // first close of the starting year, matching what a normal person means by
  // "I invested at the start of 2025". (Previously we used the Q1-end of the
  // starting year, which silently lopped off the first 3 months of returns.)
  // For the earliest year in the dataset (no prior year exists), fall back
  // to the first quarter of the starting year.
  const cells = [];
  for (let sy = maxYear - 1; sy >= minYear; sy--) {
    for (const p of periods) {
      const endYear = sy + p - 1;
      if (endYear > maxYear) continue;
      if (!yearLast.has(endYear)) continue;
      const entryIdx = (sy > minYear && yearLast.has(sy - 1))
        ? yearLast.get(sy - 1)
        : yearFirst.get(sy);
      if (entryIdx == null) continue;
      const exitIdx  = yearLast.get(endYear);
      if (exitIdx - entryIdx < 2) continue;
      cells.push({ year: sy, period: p, entryIdx, exitIdx, value: 0 });
    }
  }
  const lookup = new Map();
  for (const c of cells) lookup.set(c.year + ':' + c.period, c);

  // Render the empty skeleton up-front so cells fill in live as sims complete.
  // data-r / data-c on every cell + corresponding header drives the row+column
  // hover highlight without per-render listener wiring.
  const headerHTML = '<tr><th></th>' + periods.map(p => `<th data-c="${p}">${p}y</th>`).join('') + '</tr>';
  const bodyParts = [];
  for (let sy = maxYear - 1; sy >= minYear; sy--) {
    bodyParts.push(`<tr><th data-r="${sy}">${sy}</th>`);
    for (const p of periods) {
      const c = lookup.get(sy + ':' + p);
      bodyParts.push(c
        ? `<td class="heatmap-cell" data-yp="${sy}:${p}" data-r="${sy}" data-c="${p}"></td>`
        : `<td class="heatmap-cell empty" data-r="${sy}" data-c="${p}"></td>`);
    }
    bodyParts.push('</tr>');
  }
  grid.classList.remove('loading');
  grid.innerHTML = '<table class="heatmap-table"><thead>' + headerHTML + '</thead><tbody>' + bodyParts.join('') + '</tbody></table>';

  const cellRefs = new Map();
  grid.querySelectorAll('td.heatmap-cell[data-yp]').forEach(td => cellRefs.set(td.dataset.yp, td));

  // Show progress
  progEl.removeAttribute('hidden');
  progBar.style.width = '0%';
  progText.textContent = '0 / ' + cells.length;

  // Run simulations, populating each cell's text immediately. Yield + update
  // progress every CHUNK cells. Abort if a newer build started.
  const CHUNK = 30;
  const strat = analyticsStrategy;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const sim = simulate(initial, monthly, rate, c.entryIdx, c.exitIdx, annualRaise, opts);
    c.value = strategyFinalValue(sim, strat);
    // Divisor for the diverging color scale — chosen via the baseline dropdown.
    // Default is "Compounded Cash" (the same line plotted as "Invested
    // Compounded" on the main chart). Other options compare against B&H SPY,
    // QQQ, TQQQ, 9sig, or adaptive.
    const baseline = baselineFinalValue(sim, analyticsBaseline);
    c.derived = baseline > 0 && c.value > 0 ? c.value / baseline : 0;
    c.maxDD = computeMaxDrawdown(strategySeries(sim, strat));
    const td = cellRefs.get(c.year + ':' + c.period);
    if (td) {
      const endYear = c.year + c.period - 1;
      td.innerHTML = `<span class="cell-val">${fmt3sig(c.value)}</span><span class="cell-year">${endYear}</span>`;
      td.dataset.value = String(c.value);
      td.dataset.derived = String(c.derived);
      td.dataset.endYear = String(endYear);
      td.dataset.maxDd = String(c.maxDD);
    }

    if ((i + 1) % CHUNK === 0 || i === cells.length - 1) {
      const pct = ((i + 1) / cells.length) * 100;
      progBar.style.width = pct.toFixed(1) + '%';
      progText.textContent = (i + 1) + ' / ' + cells.length;
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
