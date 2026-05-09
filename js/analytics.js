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

// Pull a baseline value out of a simulate() result for the chosen divisor.
// 'compounded' is the cash-only baseline plotted as "Invested Compounded";
// the others mirror strategyFinalValue.
function baselineFinalValue(sim, key) {
  switch (key) {
    case 'custom':    return analyticsCustomTarget;
    case 'custom-pct': return 0; // handled separately at color time (cell-to-cell comparison)
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
    let baselineVal = derived > 0 ? value / derived : 0;
    const stratLabel = STRATEGY_LABELS[analyticsStrategy] || 'Adaptive';
    let baseLabel;
    if (analyticsBaseline === 'custom') {
      baseLabel = `Target ${fmtFull(analyticsCustomTarget)}`;
    } else if (analyticsBaseline === 'custom-pct') {
      // Pull the previous-period cell's value off the DOM so the tooltip can
      // show the year-over-year threshold (prev × (1 + pct%)).
      const prevPeriod = period - 1;
      let prevValue = +(sliderToInitial(+document.getElementById('slider-initial').value));
      if (prevPeriod > 0) {
        const prevTd = grid.querySelector(`td[data-yp="${startYear}:${prevPeriod}"]`);
        if (prevTd && prevTd.dataset.value) prevValue = +prevTd.dataset.value;
      }
      baselineVal = prevValue * (1 + analyticsCustomGrowthPct / 100);
      const pctTxt = (analyticsCustomGrowthPct % 1 === 0 ? analyticsCustomGrowthPct.toFixed(0) : analyticsCustomGrowthPct.toFixed(1));
      baseLabel = prevPeriod > 0
        ? `+${pctTxt}% from ${prevPeriod}y (${fmtFull(prevValue)})`
        : `+${pctTxt}% from start (${fmtFull(prevValue)})`;
    } else {
      baseLabel = BASELINE_LABELS[analyticsBaseline] || 'Baseline';
    }
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

// Render the rich tooltip (same .tt-* classes as the heatmap grid mode) for
// a spiral-mode bar hover.
function showSpiralTooltip(tooltip, e, d, threshold) {
  const stratLabel = STRATEGY_LABELS[analyticsStrategy] || 'Adaptive';
  const sign       = d.pct >= 0 ? '+' : '';
  const hit        = d.pct >= threshold;
  const tag        = d.partial ? ' (YTD)' : '';
  const startLabel = `Start of ${d.year}`;
  const endLabel   = d.partial ? 'Latest' : `End of ${d.year}`;
  const thrTxt     = (threshold >= 0 ? '+' : '') + threshold + '%';
  // Bars scaled relative to the larger of the two values, like the heatmap
  // tooltip's strategy-vs-baseline pair.
  const maxV = Math.max(d.prevPrice, d.price) || 1;
  const w1   = (d.prevPrice / maxV * 100).toFixed(1);
  const w2   = (d.price     / maxV * 100).toFixed(1);

  tooltip.innerHTML = `
    <div class="tt-period">${stratLabel} &middot; ${d.year}${tag}</div>
    <div class="tt-strat">${sign}${d.pct.toFixed(2)}%</div>
    <div class="tt-bars">
      <div class="tt-bar-row">
        <span class="tt-bar-label">${startLabel}</span>
        <div class="tt-bar-track"><div class="tt-bar-fill" style="width:${w1}%"></div></div>
        <span class="tt-bar-value">(${fmtFull(Math.round(d.prevPrice))})</span>
      </div>
      <div class="tt-bar-row tt-bar-primary">
        <span class="tt-bar-label">${endLabel}</span>
        <div class="tt-bar-track"><div class="tt-bar-fill" style="width:${w2}%"></div></div>
        <span class="tt-bar-value">(${fmtFull(Math.round(d.price))})</span>
      </div>
    </div>
    <div class="tt-foot">
      <span>vs threshold (${thrTxt})</span>
      <span class="tt-dd" style="color:${hit ? '#22c55e' : '#ef4444'}">${hit ? '✓ hit' : '✗ miss'}</span>
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
  '9sig':     'tqqq',
  'adaptive': 'tqqq',
};

// Extract the strategy's quarterly (date, value) pairs from a simulate()
// result. Used by the spiral to get per-year portfolio values.
function strategyDateValues(sim, strat) {
  switch (strat) {
    case '9sig':     return sim.log           ? sim.log.map(l => ({ date: l.date, value: l.total })) : [];
    case 'bh-tqqq':  return sim.bhPoints      || [];
    case 'bh-qqq':   return sim.qqqPoints     || [];
    case 'bh-spy':   return sim.spyPoints     || [];
    case 'adaptive': return sim.adaptivePoints|| [];
    default:         return [];
  }
}

// Cache for the spiral's full-range simulate() result so that dragging the
// percentage slider (which only changes the colour threshold, not the sim
// inputs) doesn't trigger a fresh simulation each frame.
let _spiralSim = null;
let _spiralSimKey = null;

function getSpiralSim(initial, monthly, rate, annualRaise, opts) {
  const key = JSON.stringify({
    initial, monthly, rate, annualRaise,
    s: opts && opts.switchTo9sig,
    a: opts && opts.switchToAllIn,
    w: opts && opts.yearsBack,
  });
  if (_spiralSimKey === key && _spiralSim) return _spiralSim;
  _spiralSim    = simulate(initial, monthly, rate, 0, quarterlyData.length - 1, annualRaise, opts);
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
      .style('cursor', 'crosshair')
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
    let bLabel, modeNote;
    if (analyticsBaseline === 'custom') {
      bLabel = `Custom Target (${fmtFull(analyticsCustomTarget)})`;
      modeNote = 'green = hit the goal, red = below it';
    } else if (analyticsBaseline === 'custom-pct') {
      const pctTxt = (analyticsCustomGrowthPct % 1 === 0 ? analyticsCustomGrowthPct.toFixed(0) : analyticsCustomGrowthPct.toFixed(1));
      bLabel = `+${pctTxt}% per year`;
      modeNote = 'green = grew at least that much from the previous-year cell, red = didn\'t';
    } else {
      bLabel = BASELINE_LABELS[analyticsBaseline] || 'baseline';
      modeNote = '1× = match, anchored at slate midpoint';
    }
    subEl.innerHTML = `rows: year you started investing &nbsp;·&nbsp; columns: N years later &nbsp;·&nbsp; cell color vs <strong>${bLabel}</strong> (${modeNote})`;
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
  for (let p = 1; p <= ANALYTICS_MAX_PERIOD && p <= (maxYear - minYear); p++) periods.push(p);

  // Build the list of valid (startYear, period) cells. The row is the year
  // you started investing; the column is "N years later". Entry anchors at
  // the *last trading day of the previous year* — that's effectively the
  // first close of the starting year, matching what a normal person means by
  // "I invested at the start of 2025". For the earliest year in the dataset
  // (no prior year exists), we fall back to the first quarter of the starting
  // year. We include the latest year (maxYear) even when only partial data
  // exists for it — its row will just show fewer columns / partial-year values.
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
      const exitIdx  = yearLast.get(endYear);
      if (exitIdx - entryIdx < 1) continue; // need at least one quarter of span
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
