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
let analyticsBuildEpoch = 0;
let analyticsRefreshTimer = null;

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

// Called from chart.js render() after a parameter change. Debounced so the
// expensive simulation grid only runs after the user stops adjusting.
function refreshAnalytics() {
  if (!isAnalyticsOpen()) return;
  if (analyticsRefreshTimer) clearTimeout(analyticsRefreshTimer);
  analyticsRefreshTimer = setTimeout(buildHeatmap, 300);
}

function renderAnalyticsMetrics(initial, monthly, annualRaise, rate, tqqqAboveMult, tqqqBelowMult, tqqqWindow) {
  const m = document.getElementById('analytics-metrics');
  if (!m) return;
  const pct = (x) => (x * 100 % 1 === 0 ? (x * 100).toFixed(0) : (x * 100).toFixed(1)) + '%';
  m.innerHTML = [
    `<span class="metric">Initial <strong>${fmtFull(initial)}</strong></span>`,
    `<span class="metric">Monthly <strong>${fmtFull(monthly)}</strong></span>`,
    `<span class="metric">Annual raise <strong>${pct(annualRaise)}</strong></span>`,
    `<span class="metric">Cash rate <strong>${pct(rate)}</strong></span>`,
    `<span class="metric">→ 9sig <strong>×${tqqqAboveMult}</strong></span>`,
    `<span class="metric">→ TQQQ <strong>×${tqqqBelowMult}</strong></span>`,
    `<span class="metric">Window <strong>${tqqqWindow}y</strong></span>`,
  ].join('');
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

  renderAnalyticsMetrics(initial, monthly, annualRaise, rate, tqqqAboveMult, tqqqBelowMult, tqqqWindow);
  const titleEl = document.getElementById('analytics-chart-title');
  if (titleEl) titleEl.textContent = (STRATEGY_LABELS[analyticsStrategy] || 'Adaptive') + ' — Final Value';

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
  const headerHTML = '<tr><th></th>' + periods.map(p => `<th>${p}y</th>`).join('') + '</tr>';
  const bodyParts = [];
  for (let sy = maxYear - 1; sy >= minYear; sy--) {
    bodyParts.push(`<tr><th>${sy}</th>`);
    for (const p of periods) {
      const c = lookup.get(sy + ':' + p);
      bodyParts.push(c
        ? `<td class="heatmap-cell" data-yp="${sy}:${p}"></td>`
        : '<td class="heatmap-cell empty"></td>');
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
    // Cash-baseline divisor: same number plotted as "Invested Compounded" on
    // the main chart. Comes from the 9sig log regardless of selected strategy.
    const log = sim.log;
    const baseline = log && log.length ? log[log.length - 1].investedCompounded : 0;
    c.derived = baseline > 0 && c.value > 0 ? c.value / baseline : 0;
    const td = cellRefs.get(c.year + ':' + c.period);
    if (td) td.textContent = fmt3sig(c.value);

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
    // Diverging red → slate → green. Stops match the app's existing red
    // (#f87171, B&H TQQQ) and green (#4ade80, B&H QQQ). Midpoint is a neutral
    // slate (#475569) so middle cells read as "just middle", not red or green.
    let r, g, b;
    if (intensity < 0.5) {
      const u = intensity * 2;
      r = Math.round(248 + (71  - 248) * u);
      g = Math.round(113 + (85  - 113) * u);
      b = Math.round(113 + (105 - 113) * u);
    } else {
      const u = (intensity - 0.5) * 2;
      r = Math.round(71  + (74  - 71)  * u);
      g = Math.round(85  + (222 - 85)  * u);
      b = Math.round(105 + (128 - 105) * u);
    }
    td.style.background = `rgb(${r},${g},${b})`;
    const mult = c.derived > 0 ? c.derived.toFixed(2) + '×' : '—';
    td.title = `Invested ${c.year}, ${c.period}y later (${c.year + c.period - 1}): ${fmtFull(Math.round(c.value))} (${mult} vs cash baseline)`;
  }

  progEl.setAttribute('hidden', '');
}
