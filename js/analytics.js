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
let analyticsBuildEpoch = 0;
let analyticsRefreshTimer = null;

const BASELINE_LABELS = {
  'compounded': 'Compounded Cash',
  'bh-spy':     'B&H SPY',
  'bh-qqq':     'B&H QQQ',
  'adaptive':   'Adaptive',
  '9sig':       '9sig',
  'bh-tqqq':    'B&H TQQQ',
};

// Pull a baseline value out of a simulate() result for the chosen divisor.
// 'compounded' is the cash-only baseline plotted as "Invested Compounded";
// the others mirror strategyFinalValue.
function baselineFinalValue(sim, key) {
  switch (key) {
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
    buildHeatmap();
  }
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
    const baselineVal = derived > 0 ? value / derived : 0;
    const stratLabel = STRATEGY_LABELS[analyticsStrategy] || 'Adaptive';
    const baseLabel  = BASELINE_LABELS[analyticsBaseline] || 'Baseline';
    const maxV = Math.max(value, baselineVal) || 1;
    const w1 = (value / maxV * 100).toFixed(1);
    const w2 = (baselineVal / maxV * 100).toFixed(1);
    tooltip.innerHTML = `
      <div class="tt-period">Invested ${startYear} · ${period}y later · ended ${endYear}</div>
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

function renderAnalyticsMetrics(initial, monthly, annualRaise, rate, tqqqAboveMult, tqqqBelowMult, tqqqWindow, strategy) {
  const m = document.getElementById('analytics-metrics');
  if (!m) return;
  const pct = (x) => (x * 100 % 1 === 0 ? (x * 100).toFixed(0) : (x * 100).toFixed(1)) + '%';
  const items = [
    `<span class="metric">Initial <strong>${fmtFull(initial)}</strong></span>`,
  ];
  // Monthly + the two contribution-related metrics (raise / cash rate) only
  // make sense when there are actual monthly contributions. With monthly = 0
  // the raise is a no-op and the cash flow that earns the rate doesn't exist
  // beyond the initial allocation, so we hide all three together.
  if (monthly > 0) {
    items.push(`<span class="metric">Monthly <strong>${fmtFull(monthly)}</strong></span>`);
    items.push(`<span class="metric">Annual raise <strong>${pct(annualRaise)}</strong></span>`);
    items.push(`<span class="metric">Cash interest rate <strong>${pct(rate)}</strong></span>`);
  }
  if (strategy === 'adaptive') {
    items.push(`<span class="metric">→ 9sig <strong>×${tqqqAboveMult}</strong></span>`);
    items.push(`<span class="metric">→ TQQQ <strong>×${tqqqBelowMult}</strong></span>`);
    items.push(`<span class="metric">Window <strong>${tqqqWindow}y</strong></span>`);
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
    const bLabel = BASELINE_LABELS[analyticsBaseline] || 'baseline';
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
  // you started investing; the column is "N years later". A cell exists iff
  // startYear + period - 1 falls within the available data range.
  const cells = [];
  for (let sy = maxYear - 1; sy >= minYear; sy--) {
    for (const p of periods) {
      const endYear = sy + p - 1;
      if (endYear > maxYear) continue;
      if (!yearFirst.has(sy) || !yearLast.has(endYear)) continue;
      const entryIdx = yearFirst.get(sy);
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
    const td = cellRefs.get(c.year + ':' + c.period);
    if (td) {
      const endYear = c.year + c.period - 1;
      td.innerHTML = `<span class="cell-val">${fmt3sig(c.value)}</span><span class="cell-year">${endYear}</span>`;
      td.dataset.value = String(c.value);
      td.dataset.derived = String(c.derived);
      td.dataset.endYear = String(endYear);
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
    // Diverging palette: red-500 (#ef4444) → slate-600 (#475569) → green-500
    // (#22c55e). Pre-apply a sqrt-based curve so small deviations from the
    // 0.5 midpoint produce strong visible color shifts — "slight red" and
    // "slight green" cells are now clearly distinguishable from each other
    // and from the neutral midpoint.
    const delta = intensity - 0.5;
    const curvedDelta = Math.sign(delta) * Math.pow(Math.abs(delta) * 2, 0.5) * 0.5;
    const t = 0.5 + curvedDelta;
    let r, g, b;
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
    td.style.background = `rgb(${r},${g},${b})`;
  }

  progEl.setAttribute('hidden', '');
}
