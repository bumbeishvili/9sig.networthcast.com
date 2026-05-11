let chart = null;
// Latest rebalance-log data, surfaced inside the 9sig side panel's table.
// Populated on every render(); cleared when there's not enough data to sim.
let _logData = null;

// Build the compact legend chips that sit above the chart. Each chip
// combines an eye-toggle, color dot, dataset name, and (when available)
// the strategy's annualized CAGR. Click toggles dataset visibility, which
// re-renders the legend so the chip's hidden-style stays in sync.
// Main legend order: only the six "primary" strategies. The three 9sig
// supporting lines (TQQQ holding / target / cash) live inside the 9sig
// side-panel instead — see SUB_LEGEND below.
const LEGEND_ORDER = [
  8, // Adaptive
  0, // 9sig
  2, // B&H TQQQ
  3, // B&H QQQ
  4, // B&H SPY
  7, // Invested Compounded
];
// When a strategy chip's "more" is clicked, its panel can show nested
// chips for related sub-series. Currently only 9sig has any.
const SUB_LEGEND = {
  0: [1, 5, 6], // 9sig → TQQQ Holding, TQQQ Target, 9sig Cash
};

// Build legend-chip HTML for a list of dataset indices. Used by both the
// main top-of-chart legend and the strategy side-panel's nested chips.
function buildLegendChipsHtml(indices, opts) {
  if (!chart) return '';
  const includeMore = !(opts && opts.noMore);
  const cagrMap = window._cagrByDatasetIdx || {};
  const metrics = window._strategyMetrics || {};
  const out = [];
  for (const i of indices) {
    const ds = chart.data.datasets[i];
    if (!ds || ds._isShift) continue;
    const isHidden = !chart.isDatasetVisible(i);
    const dotColor = typeof ds.borderColor === 'string' ? ds.borderColor : '#94a3b8';
    const cagr = cagrMap[i];
    const m    = metrics[i];
    // Two-line metrics block: CAGR row on top, max drawdown below. Each
    // row is "label value" so users can tell them apart at a glance.
    // Only rendered for main-strategy chips that have computed metrics.
    let metricsHtml = '';
    if (cagr !== undefined && Number.isFinite(cagr)) {
      const cagrSign = cagr >= 0 ? '+' : '';
      const cagrCls  = cagr >= 0 ? 'positive' : 'negative';
      const cagrStr  = `${cagrSign}${cagr.toFixed(1)}%`;
      let ddRow = '';
      if (m && Number.isFinite(m.maxDD)) {
        const ddStr = m.maxDD > 0 ? `−${m.maxDD.toFixed(1)}%` : '0.0%';
        ddRow = `
          <div class="legend-metric-row">
            <span class="legend-metric-label">DD</span>
            <span class="legend-metric-value negative">${ddStr}</span>
          </div>`;
      }
      metricsHtml = `
        <div class="legend-metrics">
          <div class="legend-metric-row">
            <span class="legend-metric-label">CAGR</span>
            <span class="legend-metric-value ${cagrCls}">${cagrStr}</span>
          </div>
          ${ddRow}
        </div>`;
    }
    const moreBtn = includeMore
      ? `<button type="button" class="legend-more" aria-label="Open details panel" title="Open details panel">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><polyline points="17 9 14 12 17 15"/></svg>
         </button>`
      : '';
    out.push(
      `<div class="legend-chip${isHidden ? ' legend-hidden' : ''}" data-idx="${i}" role="button" tabindex="0" title="Click eye/name to toggle">
        <svg class="legend-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          ${isHidden
            ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
            : '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'}
        </svg>
        <span class="legend-dot" style="background:${dotColor}"></span>
        <span class="legend-name">${ds.label}</span>
        ${metricsHtml}
        ${moreBtn}
      </div>`
    );
  }
  return out.join('');
}

function renderChartLegend() {
  const host = document.getElementById('chart-legend');
  if (!host || !chart) return;
  host.innerHTML = buildLegendChipsHtml(LEGEND_ORDER);
}

let _currentPanelIdx = null;

// Static content shown for specific strategies in their detail panel.
// Currently only 9sig has a content block (rules + rebalance log).
const NINE_SIG_RULES_HTML = `
  <div class="strategy-panel-section-label">9sig Rules</div>
  <div class="strategy-rules">
    &bull; Initial allocation: 60% TQQQ / 40% cash<br>
    &bull; Signal line grows 9% per quarter<br>
    &bull; Above signal &rarr; sell excess to cash<br>
    &bull; Below signal &rarr; buy from cash to reach signal<br>
    &bull; Monthly contributions go 100% to cash; signal line rises by 50% of new cash<br>
    &bull; 90% buying power throttle &mdash; buy signals use at most 90% of cash<br>
    &bull; 30-down no-sell &mdash; skip sell up to 2 consecutive quarters if TQQQ is 30%+ below its 2-year high<br>
    &bull; Spike reset &mdash; if TQQQ doubles in a quarter and stock allocation stays 60&ndash;100% after rebalance, hard-reset to 60% TQQQ
  </div>
`;

function buildLogTableHtml(d) {
  if (!d || !d.log || !d.log.length) return '';
  const rows = d.log.map((l, i) => {
    const ac = l.action.startsWith('SELL') ? 'action-sell' : l.action.startsWith('BUY') ? 'action-buy' : 'action-hold';
    const bhVal  = d.bhPoints[i]  ? d.bhPoints[i].value  : 0;
    const qqqVal = d.qqqPoints[i] ? d.qqqPoints[i].value : 0;
    const spyVal = d.spyPoints[i] ? d.spyPoints[i].value : 0;
    return `<tr>
      <td>${l.date.substring(0,7)}</td>
      <td>${fmtFull(l.invested)}</td>
      <td>${fmtFull(Math.round(l.tqqqVal))}</td>
      <td style="color:#fb923c">${fmtFull(Math.round(l.target))}</td>
      <td>${fmtFull(Math.round(l.cash))}</td>
      <td>${fmtFull(Math.round(l.total))}</td>
      <td style="color:#f87171">${fmtFull(Math.round(bhVal))}</td>
      <td style="color:#4ade80">${fmtFull(Math.round(qqqVal))}</td>
      <td style="color:#f472b6">${fmtFull(Math.round(spyVal))}</td>
      <td class="${ac}">${l.action}</td>
    </tr>`;
  }).join('');
  return `
    <div class="strategy-panel-section-label" style="margin-top:24px">Quarterly Rebalance Log</div>
    <div class="quarter-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Quarter</th>
            <th>Invested</th>
            <th>TQQQ Val</th>
            <th>Target</th>
            <th>Cash</th>
            <th>9sig</th>
            <th>B&H TQQQ</th>
            <th>B&H QQQ</th>
            <th>B&H SPY</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Render the 4-stat grid (CAGR / Start / End / Max DD) for one dataset idx.
// Stats come from window._strategyMetrics, populated each render(). Returns
// an empty string when there are no metrics for the idx.
function renderStatsGrid(idx) {
  const m = (window._strategyMetrics || {})[idx];
  if (!m) return '';
  const cagrSign = m.cagr >= 0 ? '+' : '';
  const cagrCls  = m.cagr >= 0 ? 'positive' : 'negative';
  const cagrStr  = Number.isFinite(m.cagr) ? `${cagrSign}${m.cagr.toFixed(1)}%` : '–';
  const ddStr    = Number.isFinite(m.maxDD) && m.maxDD > 0 ? `−${m.maxDD.toFixed(1)}%` : '0.0%';
  return `
    <div class="strategy-stats">
      <div class="strategy-stat">
        <div class="strategy-stat-label">CAGR</div>
        <div class="strategy-stat-value ${cagrCls}">${cagrStr}</div>
      </div>
      <div class="strategy-stat">
        <div class="strategy-stat-label">Starting Balance</div>
        <div class="strategy-stat-value">${fmtFull(Math.round(m.start))}</div>
      </div>
      <div class="strategy-stat">
        <div class="strategy-stat-label">Ending Balance</div>
        <div class="strategy-stat-value">${fmtFull(Math.round(m.end))}</div>
      </div>
      <div class="strategy-stat">
        <div class="strategy-stat-label">Max Drawdown</div>
        <div class="strategy-stat-value negative">${ddStr}</div>
      </div>
    </div>
  `;
}

// Map of dataset idx → IDs of "live" control blocks that get appended into
// the panel body for that strategy. The actual elements live in a hidden
// host outside the panel so they keep their state/listeners across the
// frequent body re-renders fired by refreshAllLegends().
const PANEL_LIVE_CONTROLS = {
  0: ['envelope-controls'], // 9sig sidebar gets the rebalancing-offset controls
  8: ['adaptive-controls'], // Adaptive sidebar gets the strategy-switch params
};
const ALL_LIVE_CONTROL_IDS = Array.from(
  new Set(Object.values(PANEL_LIVE_CONTROLS).flat())
);

// Move any currently-injected live control nodes back to their hidden
// hosts. Must be called before replacing innerHTML, otherwise the children
// would be discarded along with the body's old contents.
function detachLiveControls() {
  for (const id of ALL_LIVE_CONTROL_IDS) {
    const node = document.getElementById(id);
    if (!node) continue;
    const host = document.getElementById(id + '-host');
    if (host && node.parentNode !== host) host.appendChild(node);
  }
}

function renderStrategyPanelBody(idx) {
  const body = document.getElementById('strategy-panel-body');
  if (!body || !chart) return;
  // Detach hosted controls before clobbering innerHTML.
  detachLiveControls();
  let html = '';
  // Stats grid for the main strategy this panel was opened for.
  // Sub-series chips intentionally have no per-pill stats — measurements
  // belong to the top-level strategy only.
  html += renderStatsGrid(idx);
  const subs = SUB_LEGEND[idx];
  if (subs && subs.length) {
    html += `
      <div class="strategy-panel-section-label">Sub-series</div>
      <div class="legend-chip-group">${buildLegendChipsHtml(subs, { noMore: true })}</div>
    `;
  }
  // 9sig-specific content: rules + quarterly rebalance log.
  if (idx === 0) {
    html += `<div class="strategy-rules-wrap" style="margin-top:24px">${NINE_SIG_RULES_HTML}</div>`;
    html += buildLogTableHtml(_logData);
  }
  body.innerHTML = html;
  // Re-attach live control nodes for this idx (if any). Configuration
  // controls live at the TOP of the panel — above stats/rules/log — so they
  // don't get buried under long content like the rebalance log.
  const liveIds = PANEL_LIVE_CONTROLS[idx];
  if (liveIds) {
    // Reverse so successive prepends preserve the declared order.
    for (const id of [...liveIds].reverse()) {
      const node = document.getElementById(id);
      if (node) body.prepend(node);
    }
  }
}

// Strategy detail side panel — opens when a legend chip's more-button is
// clicked. Title is the strategy name; body shows nested chips for any
// sub-series defined in SUB_LEGEND (e.g. 9sig's TQQQ holding/target/cash).
function openStrategyPanel(idx) {
  const panel = document.getElementById('strategy-panel');
  const title = document.getElementById('strategy-panel-title');
  if (!panel) return;
  const ds = chart && chart.data.datasets[idx];
  if (title && ds) title.textContent = ds.label;
  _currentPanelIdx = idx;
  renderStrategyPanelBody(idx);
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}
function closeStrategyPanel() {
  const panel = document.getElementById('strategy-panel');
  if (!panel) return;
  _currentPanelIdx = null;
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
}

// Re-render whichever legend surface(s) need updating after a visibility
// toggle — main legend always; the side panel's nested chips when open.
function refreshAllLegends() {
  renderChartLegend();
  if (_currentPanelIdx !== null) renderStrategyPanelBody(_currentPanelIdx);
}

// Single delegated click handler — the legend HTML gets replaced on every
// render, so attaching here once on document avoids leaks/duplicate
// listeners while still working after re-renders.
document.addEventListener('click', (e) => {
  // More-button click → open the side panel for this strategy. Check this
  // first so we don't also fire the visibility toggle.
  const moreBtn = e.target.closest('.legend-more');
  if (moreBtn) {
    const chip = moreBtn.closest('.legend-chip[data-idx]');
    if (chip) openStrategyPanel(+chip.dataset.idx);
    return;
  }
  // Side-panel close button or backdrop → close.
  if (e.target.closest('.strategy-panel-close') ||
      e.target.classList.contains('strategy-panel-backdrop')) {
    closeStrategyPanel();
    return;
  }
  // Anywhere else on the chip → toggle dataset visibility.
  const chip = e.target.closest('.legend-chip[data-idx]');
  if (!chip || !chart) return;
  const idx = +chip.dataset.idx;
  if (!Number.isFinite(idx)) return;
  chart.setDatasetVisibility(idx, !chart.isDatasetVisible(idx));
  chart.update();
  refreshAllLegends();
  // Persist so a plain page refresh keeps the same legend visibility mix.
  if (typeof saveSliders === 'function') saveSliders();
});

// Esc closes the side panel too.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const panel = document.getElementById('strategy-panel');
  if (panel && panel.classList.contains('is-open')) closeStrategyPanel();
});

function render() {
  if (!quarterlyData) return; // data not loaded yet
  const initial = sliderToInitial(+document.getElementById('slider-initial').value);
  const monthly = +document.getElementById('slider-monthly').value;
  const annualRaise = +document.getElementById('slider-raise').value / 100;
  const rate = +document.getElementById('slider-rate').value / 100;
  const logScale = document.getElementById('chart-log-toggle').getAttribute('aria-pressed') === 'true';
  const tqqqAboveMult = +document.getElementById('select-tqqq-above').value;  // e.g. 2.0× = TQQQ is 2× of 9sig
  const tqqqBelowMult = +document.getElementById('select-tqqq-below').value;  // e.g. 1.2× = 9sig is 1.2× of TQQQ
  const tqqqWindow    = +document.getElementById('select-tqqq-window').value;
  // Translate to the internal trailing-window ratio (B&H_TQQQ / 9sig × 100).
  // Ratio 100% = parity. Switch to 9sig when ratio ≥ above_mult × 100.
  // Switch to all-in when 1/ratio ≥ below_mult, i.e. ratio ≤ 100 / below_mult.
  const switchTo9sig  = tqqqAboveMult * 100;
  const switchToAllIn = tqqqBelowMult > 0 ? 100 / tqqqBelowMult : 100;
  let entryIdx = +document.getElementById('slider-entry').value;
  let exitIdx = +document.getElementById('slider-exit').value;

  // Clamp to valid range — saved values from a prior dataset may be stale.
  const maxIdx = quarterlyData.length - 1;
  if (!Number.isFinite(entryIdx) || entryIdx < 0) entryIdx = 0;
  if (!Number.isFinite(exitIdx)  || exitIdx  < 0) exitIdx  = maxIdx;
  if (entryIdx > maxIdx) entryIdx = maxIdx;
  if (exitIdx  > maxIdx) exitIdx  = maxIdx;
  if (entryIdx >= exitIdx) {
    exitIdx  = Math.min(entryIdx + 1, maxIdx);
    entryIdx = Math.min(entryIdx, exitIdx - 1);
    if (entryIdx < 0) entryIdx = 0;
  }
  document.getElementById('slider-entry').value = entryIdx;
  document.getElementById('slider-exit').value  = exitIdx;

  document.getElementById('disp-initial').textContent = fmtFull(initial);
  document.getElementById('disp-monthly').textContent = fmtFull(monthly);
  const raiseVal = annualRaise * 100;
  document.getElementById('disp-raise').textContent = (raiseVal % 1 === 0 ? raiseVal.toFixed(0) : raiseVal.toFixed(1)) + '%';
  const rv = (rate * 100);
  document.getElementById('disp-rate').textContent = (rv % 1 === 0 ? rv.toFixed(1) : rv.toFixed(2)) + '%';
  document.getElementById('disp-entry').textContent = qLabel(quarterlyData[entryIdx][0]);
  document.getElementById('disp-exit').textContent = qLabel(quarterlyData[exitIdx][0]);

  const { log, bhPoints, qqqPoints, spyPoints, adaptivePoints, totalContributed } = simulate(initial, monthly, rate, entryIdx, exitIdx, annualRaise, { switchTo9sig, switchToAllIn, yearsBack: tqqqWindow });

  const showEnvelope = document.getElementById('toggle-envelope').checked;
  const opacityVal = +document.getElementById('slider-envelope-opacity').value / 100;
  document.getElementById('disp-envelope-opacity').textContent = 'opacity ' + opacityVal.toFixed(2);
  const envColor = `rgba(34,211,238,${opacityVal})`;
  const shiftResults = showEnvelope
    ? shiftedQuarterlyCache.map(qData => simulate(initial, monthly, rate, entryIdx, exitIdx, annualRaise, { qData, skipBH: true }).log.map(l => l.total))
    : [];

  if (log.length < 1) {
    if (chart) { chart.destroy(); chart = null; }
    _logData = null;
    refreshAllLegends();
    return;
  }

  const finalLog = log[log.length - 1];
  const finalBH = bhPoints[bhPoints.length - 1].value;
  const finalQQQ = qqqPoints[qqqPoints.length - 1].value;
  const finalSPY = spyPoints[spyPoints.length - 1].value;
  const years = log.length > 1 ? (new Date(log[log.length-1].date) - new Date(log[0].date)) / (365.25*86400000) : 1;
  const cagr = (end, start) => years > 0 && start > 0 ? (Math.pow(end / start, 1 / years) - 1) * 100 : 0;
  const finalAdaptive = adaptivePoints[adaptivePoints.length - 1].value;
  const ret9 = cagr(finalLog.total, totalContributed);
  const retBH = cagr(finalBH, totalContributed);
  const retQQQ = cagr(finalQQQ, totalContributed);
  const retSPY = cagr(finalSPY, totalContributed);
  const retInv = cagr(finalLog.investedCompounded, totalContributed);
  const retAdaptive = cagr(finalAdaptive, totalContributed);

  // CAGR per dataset index — used by the compact legend chips below the
  // chart title. Indices match the order datasets are pushed into the chart
  // (see lineNames). Datasets without a CAGR (TQQQ holding line, signal
  // line, cash line, envelope shifts) get just name + eye in their chip.
  window._cagrByDatasetIdx = {
    0: ret9,
    2: retBH,
    3: retQQQ,
    4: retSPY,
    7: retInv,
    8: retAdaptive,
  };

  // Chart
  const labels = log.map(l => l.date);
  const totalD = log.map(l => l.total);
  const tqqqValD = log.map(l => l.tqqqVal);
  const cashD = log.map(l => l.cash);
  const bhD = bhPoints.map(b => b.value);
  const qqqD = qqqPoints.map(q => q.value);
  const spyD = spyPoints.map(s => s.value);
  const invD = log.map(l => l.investedCompounded);
  const targetD = log.map(l => l.target);
  const adaptiveD = adaptivePoints.map(a => a.value);

  // Per-dataset stats shown inside the strategy side panel (CAGR / starting
  // balance / ending balance / max drawdown). Main strategies reuse their
  // money-weighted CAGR (vs total contributed); sub-series fall back to the
  // annualized growth rate of their own balance.
  const seriesByIdx = {
    0: totalD, 1: tqqqValD, 2: bhD, 3: qqqD, 4: spyD,
    5: targetD, 6: cashD, 7: invD, 8: adaptiveD,
  };
  const mainCagrIdx = window._cagrByDatasetIdx;
  window._strategyMetrics = {};
  for (const [idxStr, series] of Object.entries(seriesByIdx)) {
    if (!series || !series.length) continue;
    const i     = +idxStr;
    const start = series[0];
    const end   = series[series.length - 1];
    const cagrVal = mainCagrIdx[i] !== undefined
      ? mainCagrIdx[i]
      : (years > 0 && start > 0 ? (Math.pow(end / start, 1 / years) - 1) * 100 : 0);
    window._strategyMetrics[i] = {
      cagr:  cagrVal,
      start,
      end,
      maxDD: computeMaxDrawdown(series) * 100,
    };
  }
  // Transition markers: dot at every quarter the strategy switched. Cyan for
  // → 9sig, red for → all-in TQQQ, transparent (radius 0) on non-switch quarters.
  // The plugin draws connector + label; keep pointRadius 0 so we don't
  // double-up. Transition dot is rendered by the plugin itself for full
  // control over size/color/layering.
  const adaptivePointRadius = adaptivePoints.map(() => 0);
  // Non-zero hover radius so the adaptive line gets the same point-on-hover
  // affordance as the other strategy lines. The static (non-hover) radius
  // stays 0 so transition markers drawn by the plugin don't get doubled.
  const adaptivePointHoverRadius = adaptivePoints.map(() => 4);
  const adaptivePointBg = adaptivePoints.map(a => a.state === '9sig' ? '#22d3ee' : '#f87171');
  const adaptiveTransitions = adaptivePoints.map((a, i) => {
    if (i === 0) return a.state === '9sig' ? 'to 9sig' : 'to TQQQ';
    if (a.state === adaptivePoints[i-1].state) return null;
    return a.state === '9sig' ? 'to 9sig' : 'to TQQQ';
  });

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = totalD;
    chart.data.datasets[1].data = tqqqValD;
    chart.data.datasets[2].data = bhD;
    chart.data.datasets[3].data = qqqD;
    chart.data.datasets[4].data = spyD;
    chart.data.datasets[5].data = targetD;
    chart.data.datasets[6].data = cashD;
    chart.data.datasets[7].data = invD;
    chart.data.datasets[8].data = adaptiveD;
    chart.data.datasets[8].pointRadius = adaptivePointRadius;
    chart.data.datasets[8].pointHoverRadius = adaptivePointHoverRadius;
    chart.data.datasets[8].pointBackgroundColor = adaptivePointBg;
    chart.data.datasets[8].pointBorderColor = adaptivePointBg;
    chart.data.datasets[8]._transitions = adaptiveTransitions;
    while (chart.data.datasets.length < 9 + envelopeShiftCount) {
      const offset = chart.data.datasets.length - 9;
      chart.data.datasets.push({
        label: '_shift_' + (offset + 1),
        data: [],
        borderColor: envColor,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        pointHitRadius: 0,
        borderWidth: 1,
        order: -1,
        _isShift: true
      });
    }
    for (let i = 0; i < envelopeShiftCount; i++) {
      const ds9 = chart.data.datasets[9 + i];
      ds9.data = showEnvelope ? (shiftResults[i] || []) : [];
      ds9.borderColor = envColor;
      ds9.hidden = !showEnvelope;
    }
    chart.options.scales.y.type = logScale ? 'logarithmic' : 'linear';
    chart.options.scales.y.beginAtZero = !logScale;
    chart.update('none');
  } else {
  const ctx = document.getElementById('mainChart').getContext('2d');

  const lineColors = ['#22d3ee', '#38bdf8', '#f87171', '#4ade80', '#f472b6', '#fb923c', '#fbbf24', 'rgba(226,232,240,0.4)', '#c084fc'];
  const lineNames  = ['9sig', '9sig TQQQ Holding', 'B&H TQQQ', 'B&H QQQ', 'B&H SPY', '9sig TQQQ Target', '9sig Cash', 'Invested Comp.', 'Adaptive'];
  // Match the borderDash on the corresponding chart dataset; null = solid.
  const lineDashes = [null, [2,2], [6,3], [8,4], [6,3], [4,4], null, [3,3], null];

  const externalTooltip = (context) => {
    const { chart: c, tooltip } = context;
    const el = document.getElementById('custom-tooltip');
    if (tooltip.opacity === 0) { el.style.display = 'none'; return; }

    const idx = tooltip.dataPoints?.[0]?.dataIndex;
    if (idx == null) return;

    const ds = c.data.datasets;
    const date = c.data.labels[idx];
    const vals = [ds[0].data[idx], ds[1].data[idx], ds[2].data[idx], ds[3].data[idx], ds[4].data[idx], ds[5].data[idx], ds[6].data[idx], ds[7].data[idx], ds[8].data[idx]];

    const rgba = (col, a) => {
      if (col.startsWith('rgba')) return col.replace(/,\s*[\d.]+\s*\)$/, `,${a})`);
      const m = col.match(/^#([0-9a-f]{6})$/i);
      if (!m) return col;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    const items = lineNames
      .map((n, i) => ({ i, n, v: vals[i] }))
      .filter(({ i, v }) => c.isDatasetVisible(i) && v != null && !Number.isNaN(v))
      .sort((a, b) => b.v - a.v);
    const maxV = Math.max(0, ...items.map(it => it.v));

    const adaptiveTrans = (ds[8] && ds[8]._transitions) ? ds[8]._transitions[idx] : null;
    const rows = items.map(({ i, n, v }) => {
      const pct = maxV > 0 ? Math.max(0, (v / maxV) * 100) : 0;
      const dashAttr = lineDashes[i] ? `stroke-dasharray="${lineDashes[i].join(',')}"` : '';
      const sample = `<svg width="20" height="4" style="flex-shrink:0;overflow:visible">
        <line x1="0" y1="2" x2="20" y2="2" stroke="${lineColors[i]}" stroke-width="2" stroke-linecap="round" ${dashAttr}/>
      </svg>`;
      const transBadge = (i === 8 && adaptiveTrans)
        ? `<span style="margin-left:6px;font-size:10px;color:${adaptiveTrans.includes('9sig') ? '#22d3ee' : '#f87171'};font-weight:600">${adaptiveTrans}</span>`
        : '';
      return `
        <div class="tt-row" style="position:relative">
          <div style="position:absolute;left:0;top:2px;bottom:2px;width:${pct}%;background:${rgba(lineColors[i], 0.20)};border-radius:3px;pointer-events:none"></div>
          <div class="tt-row-left" style="position:relative;z-index:1">
            ${sample}
            <span class="tt-name">${n}</span>${transBadge}
          </div>
          <span class="tt-val" style="position:relative;z-index:1">${fmtFull(Math.round(v))}</span>
        </div>
      `;
    }).join('');

    el.innerHTML = `<div class="tt-date">${qLabel(date)}</div>${rows}`;

    el.style.display = 'block';
    const panelRect = c.canvas.closest('.panel').getBoundingClientRect();
    const canvasRect = c.canvas.getBoundingClientRect();
    let left = tooltip.caretX + canvasRect.left - panelRect.left + 14;
    let top = tooltip.caretY + canvasRect.top - panelRect.top - 40;
    if (left + 240 > panelRect.width) left = tooltip.caretX + canvasRect.left - panelRect.left - 240;
    if (top < 0) top = 10;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  };

  // Plugin: draw end-of-line labels directly on canvas
  const endLabelPlugin = {
    id: 'endLabels',
    afterDraw(c) {
      const { ctx: cx, chartArea: area } = c;
      if (!area) return;
      // On phone-width viewports the end-of-line labels are suppressed —
      // the legend chips above already show name + CAGR + DD, and reclaiming
      // the right margin gives the actual plot a usable width.
      if (window.innerWidth <= 600) return;
      const lastIdx = c.data.labels.length - 1;
      if (lastIdx < 0) return;

      const items = c.data.datasets.map((ds, i) => {
        if (ds._isShift) return null;
        if (!c.isDatasetVisible(i)) return null;
        const meta = c.getDatasetMeta(i);
        const pt = meta.data[lastIdx];
        if (!pt) return null;
        return { y: pt.y, i, color: lineColors[i], name: lineNames[i], val: ds.data[lastIdx] };
      }).filter(Boolean);

      // Sort by y position and de-overlap
      items.sort((a, b) => a.y - b.y);
      const gap = 26;
      // Push down pass
      for (let k = 1; k < items.length; k++) {
        if (items[k].y - items[k - 1].y < gap) {
          items[k].y = items[k - 1].y + gap;
        }
      }
      // Push up pass if overflowing bottom
      for (let k = items.length - 1; k >= 0; k--) {
        const maxY = area.bottom - 5 - (items.length - 1 - k) * gap;
        if (items[k].y > maxY) items[k].y = maxY;
      }
      // Final clamp
      items.forEach(it => {
        if (it.y < area.top + 10) it.y = area.top + 10;
        if (it.y > area.bottom - 5) it.y = area.bottom - 5;
      });

      cx.save();
      const x = area.right + 8;
      items.forEach(it => {
        // Connector line from chart edge to label
        cx.beginPath();
        cx.strokeStyle = it.color;
        cx.lineWidth = 1;
        cx.setLineDash([2, 2]);
        const origMeta = c.getDatasetMeta(it.i);
        const origY = origMeta.data[lastIdx].y;
        cx.moveTo(area.right, origY);
        cx.lineTo(x - 2, it.y);
        cx.stroke();
        cx.setLineDash([]);

        // Small dot at line end
        cx.beginPath();
        cx.arc(area.right, origY, 3, 0, Math.PI * 2);
        cx.fillStyle = it.color;
        cx.fill();

        // Label name
        cx.font = '600 9px "DM Sans", sans-serif';
        cx.fillStyle = it.color;
        cx.globalAlpha = 0.7;
        cx.textBaseline = 'bottom';
        cx.fillText(it.name.toUpperCase(), x, it.y - 1);
        cx.globalAlpha = 1;

        // Value
        cx.font = '500 11px "JetBrains Mono", monospace';
        cx.fillStyle = it.color;
        cx.textBaseline = 'top';
        cx.fillText(fmtFull(Math.round(it.val)), x, it.y + 1);
      });
      cx.restore();
    }
  };

  // d3-style callout annotations on the Adaptive line for each strategy switch.
  // For each transition: dashed-circle marker at the data point, diagonal
  // connector, horizontal underline, then bold "to 9sig" / "to TQQQ" text
  // sitting on the underline. Label is placed via Voronoi-style search:
  // try increasing 45° offsets in both vertical AND horizontal directions
  // (right preferred, left as fallback), checking the full label rect against
  // every visible line sampled across its x-span. Tracks previously-placed
  // label rects so back-to-back transitions don't pile up.
  const adaptiveAnnotationPlugin = {
    id: 'adaptiveAnnotations',
    afterDatasetsDraw(c) {
      const adaptiveIdx = 8;
      if (!c.isDatasetVisible(adaptiveIdx)) return;
      const ds = c.data.datasets[adaptiveIdx];
      const transitions = ds && ds._transitions;
      if (!transitions) return;
      const meta = c.getDatasetMeta(adaptiveIdx);
      const cx = c.ctx;
      const top = c.chartArea.top;
      const bottom = c.chartArea.bottom;
      const left = c.chartArea.left;
      const right = c.chartArea.right;

      const labelHeight  = 14;
      const dotR         = 5;
      const distancesAsc = [32, 44, 58, 74, 92, 112, 134, 160];
      const placed       = [];

      // Pre-compute the visible non-adaptive line metas for sampling y across
      // the label's x-span when checking line overlap.
      const otherMetas = [];
      c.data.datasets.forEach((d, idx) => {
        if (idx === adaptiveIdx || !c.isDatasetVisible(idx)) return;
        const m = c.getDatasetMeta(idx);
        if (m) otherMetas.push(m);
      });

      // Returns true if any visible line crosses the y-band [yTop, yBot]
      // anywhere inside the x-range [xMin, xMax].
      const lineCrossesRect = (xMin, xMax, yTop, yBot) => {
        for (const m of otherMetas) {
          const pts = m.data;
          for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k], b = pts[k + 1];
            if (!a || !b) continue;
            // segment x-range overlap with rect x-range?
            const sxMin = Math.min(a.x, b.x), sxMax = Math.max(a.x, b.x);
            if (sxMax < xMin || sxMin > xMax) continue;
            // clip y-values at the rect's x edges (linear interp)
            const dx = b.x - a.x;
            const t1 = dx === 0 ? 0 : Math.max(0, Math.min(1, (xMin - a.x) / dx));
            const t2 = dx === 0 ? 1 : Math.max(0, Math.min(1, (xMax - a.x) / dx));
            const y1 = a.y + (b.y - a.y) * t1;
            const y2 = a.y + (b.y - a.y) * t2;
            const segYMin = Math.min(y1, y2), segYMax = Math.max(y1, y2);
            if (segYMax >= yTop && segYMin <= yBot) return true;
          }
        }
        return false;
      };

      cx.save();
      transitions.forEach((trans, i) => {
        if (!trans) return;
        const pt = meta.data[i];
        if (!pt) return;
        const isToSig = trans.includes('9sig');
        const color = isToSig ? '#22d3ee' : '#f87171';
        const titleText = trans;            // "to 9sig" or "to TQQQ"
        const preferDir = isToSig ? -1 : 1; // 9sig above, TQQQ below
        // Measure text width once so the placement search uses the actual label rect
        cx.font = 'bold 10px "DM Sans", sans-serif';
        const labelWidth = Math.ceil(cx.measureText(titleText).width) + 10;

        // 45° diagonal: dx = dy at any chosen distance. Try both vertical and
        // horizontal signs. Right-side placement is preferred; left is the
        // fallback when the right side is crowded or near the chart edge.
        const vDirs = [preferDir, -preferDir];
        const hDirs = [1, -1];
        let chosenDx = 0, chosenDy = 0, chosenSide = 1, chosenRect = null;

        outer: for (const dist of distancesAsc) {
          for (const hSign of hDirs) {
            for (const vSign of vDirs) {
              const dx = hSign * dist;
              const dy = vSign * dist;
              const ax = pt.x + dx;             // anchor (kink between diagonal and underline)
              const ay = pt.y + dy;
              // Label rect: text sits ABOVE the underline regardless of direction.
              // For right-side (hSign=+1) the rect extends right from ax; for
              // left-side (hSign=-1) it extends left from ax.
              const lTop = ay - labelHeight - 2;
              const lBot = ay + 2;
              const lLeft = hSign > 0 ? ax : ax - labelWidth;
              const lRight = hSign > 0 ? ax + labelWidth : ax;
              if (lTop < top + 2 || lBot > bottom - 2) continue;
              if (lLeft < left + 2 || lRight > right - 2) continue;
              // overlap with any visible line anywhere across the label's x-range?
              if (lineCrossesRect(lLeft, lRight, lTop, lBot)) continue;
              // overlap with a previously placed label rect?
              let labelClash = false;
              for (const p of placed) {
                if (lLeft < p.x2 && lRight > p.x1 && lTop < p.y2 && lBot > p.y1) {
                  labelClash = true; break;
                }
              }
              if (labelClash) continue;
              chosenDx = dx; chosenDy = dy; chosenSide = hSign;
              chosenRect = { x1: lLeft, y1: lTop, x2: lRight, y2: lBot };
              break outer;
            }
          }
        }
        if (!chosenRect) {
          // fallback: smallest offset in preferred direction, right side
          chosenDx = distancesAsc[0];
          chosenDy = preferDir * distancesAsc[0];
          chosenSide = 1;
        } else {
          placed.push(chosenRect);
        }

        const ax = pt.x + chosenDx;
        const ay = pt.y + chosenDy;

        cx.strokeStyle = color;
        cx.lineWidth = 1;

        // dashed circle marker at the data point
        cx.setLineDash([2, 2]);
        cx.beginPath();
        cx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2);
        cx.stroke();
        cx.setLineDash([]);

        // diagonal connector — start just outside the marker so it doesn't
        // overlap the dashed circle
        const ang = Math.atan2(chosenDy, chosenDx);
        const startX = pt.x + (dotR + 1) * Math.cos(ang);
        const startY = pt.y + (dotR + 1) * Math.sin(ang);
        cx.beginPath();
        cx.moveTo(startX, startY);
        cx.lineTo(ax, ay);
        cx.stroke();

        // horizontal underline supporting the text — extends in the same
        // direction as the label rect
        const underEnd = chosenSide > 0 ? ax + labelWidth - 6 : ax - labelWidth + 6;
        cx.beginPath();
        cx.moveTo(ax, ay);
        cx.lineTo(underEnd, ay);
        cx.stroke();

        // bold text sitting on the underline
        cx.fillStyle = color;
        cx.font = 'bold 10px "DM Sans", sans-serif';
        cx.textBaseline = 'bottom';
        if (chosenSide > 0) {
          cx.textAlign = 'left';
          cx.fillText(titleText, ax + 2, ay - 2);
        } else {
          cx.textAlign = 'right';
          cx.fillText(titleText, ax - 2, ay - 2);
        }
      });
      cx.restore();
    }
  };

  chart = new Chart(ctx, {
    type: 'line',
    plugins: [endLabelPlugin, adaptiveAnnotationPlugin],
    data: {
      labels,
      datasets: [
        {
          label: '9sig',
          data: totalD,
          borderColor: '#22d3ee',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2.5,
          hidden: true
        },
        {
          label: '9sig TQQQ Holding',
          data: tqqqValD,
          borderColor: '#38bdf8',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          borderDash: [2, 2],
          hidden: true
        },
        {
          label: 'B&H TQQQ',
          data: bhD,
          borderColor: '#f87171',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [6, 3]
        },
        {
          label: 'B&H QQQ',
          data: qqqD,
          borderColor: '#4ade80',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [8, 4]
        },
        {
          label: 'B&H SPY',
          data: spyD,
          borderColor: '#f472b6',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [6, 3],
          hidden: true
        },
        {
          label: '9sig TQQQ Target',
          data: targetD,
          borderColor: '#fb923c',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          borderDash: [4, 4],
          hidden: true
        },
        {
          label: '9sig Cash',
          data: cashD,
          borderColor: '#fbbf24',
          backgroundColor: 'rgba(251,191,36,0.05)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          hidden: true
        },
        {
          label: 'Invested Compounded',
          data: invD,
          borderColor: 'rgba(226,232,240,0.25)',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          borderDash: [3, 3]
        },
        {
          label: 'Adaptive',
          data: adaptiveD,
          borderColor: '#c084fc',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: adaptivePointRadius,
          pointHoverRadius: adaptivePointHoverRadius,
          pointBackgroundColor: adaptivePointBg,
          pointBorderColor: adaptivePointBg,
          pointHitRadius: 10,
          borderWidth: 2,
          order: 100,         // highest order in Chart.js → drawn LAST → on top of every other line
          hidden: true,
          _transitions: adaptiveTransitions
        },
        ...Array.from({ length: envelopeShiftCount }, (_, i) => ({
          label: '_shift_' + (i + 1),
          data: showEnvelope ? (shiftResults[i] || []) : [],
          borderColor: envColor,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 0,
          borderWidth: 1,
          order: -1,
          hidden: !showEnvelope,
          _isShift: true
        }))
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      // Reserve space on the right edge for the end-of-line strategy labels.
      // On phone-width viewports the labels are hidden by the endLabels plugin
      // (legend chips above already convey the same info), so we reclaim that
      // space for the actual plot area.
      layout: { padding: { right: window.innerWidth <= 600 ? 8 : 120 } },
      plugins: {
        legend: { display: false }, // replaced with custom #chart-legend chips
        tooltip: {
          enabled: false,
          external: externalTooltip
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { size: 10 },
            maxTicksLimit: 10,
            callback: function(val) {
              const d = this.getLabelForValue(val);
              return d ? d.substring(0, 7) : '';
            }
          },
          grid: { color: 'rgba(30,42,63,0.5)' }
        },
        y: {
          type: logScale ? 'logarithmic' : 'linear',
          beginAtZero: !logScale,
          ticks: {
            color: '#64748b',
            font: { family: 'JetBrains Mono', size: 10 },
            callback: v => fmt(v)
          },
          // On log scale, Chart.js generates a tick at every 1..9 × 10^n which
          // is way too dense. Keep only "nice" ticks (1, 2, 5 × 10^n) so the
          // axis stays readable.
          afterBuildTicks: (scale) => {
            if (document.getElementById('chart-log-toggle').getAttribute('aria-pressed') !== 'true') return;
            scale.ticks = scale.ticks.filter(t => {
              const v = t.value;
              if (v <= 0) return false;
              const exp = Math.floor(Math.log10(v));
              const m = v / Math.pow(10, exp);
              return Math.abs(m - 1) < 0.05 || Math.abs(m - 2) < 0.05 || Math.abs(m - 5) < 0.05;
            });
          },
          grid: { color: 'rgba(30,42,63,0.5)' }
        }
      }
    }
  });
  } // end else (first render)

  // Stash latest data for the 9sig side panel's rebalance log table.
  _logData = { log, bhPoints, qqqPoints, spyPoints };

  // Compact legend chips (eye + name + CAGR) above the chart. Also re-renders
  // the open side panel if any (so its log table stays in sync with sliders).
  refreshAllLegends();

  if (typeof refreshAnalytics === 'function') refreshAnalytics();
}

