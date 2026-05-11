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
  8,  // Adaptive
  0,  // 9sig
  10, // SMA
  2,  // B&H TQQQ
  11, // B&H QQQ5
  9,  // B&H SOXL
  3,  // B&H QQQ
  4,  // B&H SPY
  7,  // Invested Compounded
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

// Strategy rules panel for 9sig — recomputed each time it's rendered so it
// reflects the user's current underlying, growth %, 30-down threshold, and
// spike-reset trigger. Plain-English version designed so a non-technical
// reader can follow it without referencing the original Jason Kelly book.
function buildNineSigRulesHtml() {
  const ul   = ((document.getElementById('select-9sig-underlying') || {}).value || 'tqqq').toUpperCase();
  const g    = +((document.getElementById('select-9sig-growth')    || {}).value) || 9;
  const name = (typeof nineSigName === 'function') ? nineSigName() : (g + 'sig');
  const cd   = +((document.getElementById('select-9sig-crashdrop') || {}).value) || 30;
  const sp   = +((document.getElementById('select-9sig-spike')     || {}).value);

  const crashRule = cd >= 100
    ? `<span style="color:var(--text-muted)">(30-down protection: off at ${cd}%)</span>`
    : `When ${ul} is more than <b>${cd}%</b> below its 2-year high, <b>skip selling for up to two quarters in a row</b> — don't dump in a crash. After two skips, sell anyway.`;
  const spikeRule = sp <= 0
    ? `<span style="color:var(--text-muted)">(Spike-reset: off)</span>`
    : `If ${ul} <b>gains more than ${sp}% in a single quarter</b> and you still hold ≥60% in it, hard-rebalance back to 60/40 — lock in the windfall.`;

  return `
    <div class="strategy-panel-section-label">${name} explained</div>
    <div class="strategy-rules">
      <div style="margin-bottom:10px;color:var(--text)">
        <b>The idea:</b> each quarter, ${ul} should grow by ${g}%. If it grew faster, sell the excess to cash. If slower, buy more with cash. That's it.
      </div>

      <div style="margin-top:14px;font-weight:600;color:var(--text)">How it actually works</div>
      <div style="margin-top:6px">
        <b>1. Start.</b> Put 60% of your money in ${ul}, 40% in cash. Write down the value of the ${ul} side — that's your <b>target</b>.
      </div>
      <div style="margin-top:6px">
        <b>2. Every quarter, before deciding anything:</b>
        <ul style="margin:4px 0 0 18px;padding:0">
          <li>Grow the target by <b>${g}%</b>.</li>
          <li>If you added new cash this quarter (monthly contributions), raise the target by <b>half</b> of that new cash too.</li>
        </ul>
      </div>
      <div style="margin-top:6px">
        <b>3. Now check ${ul} against the target:</b>
        <ul style="margin:4px 0 0 18px;padding:0">
          <li><b>${ul} worth more than target?</b> Sell the excess back to cash.</li>
          <li><b>${ul} worth less than target?</b> Buy more from cash to close the gap.</li>
          <li><b>Equal?</b> Hold.</li>
        </ul>
      </div>

      <div style="margin-top:14px;font-weight:600;color:var(--text)">Safety rails</div>
      <div style="margin-top:6px">
        &bull; <b>90% buying power.</b> A buy never spends more than 90% of your cash — you keep some dry powder.
      </div>
      <div style="margin-top:6px">
        &bull; <b>30-down no-sell.</b> ${crashRule}
      </div>
      <div style="margin-top:6px">
        &bull; <b>Spike reset.</b> ${spikeRule}
      </div>

      <div style="margin-top:14px;font-size:11px;color:var(--text-muted);line-height:1.5">
        Monthly contributions always go straight to cash (never directly into ${ul}) — the quarterly rebalance is what moves money into stock. The target rising by half of new cash keeps it honest: half of every dollar you add is "expected" to flow into ${ul} eventually.
      </div>
    </div>
  `;
}

function buildLogTableHtml(d) {
  if (!d || !d.log || !d.log.length) return '';
  const rows = d.log.map((l, i) => {
    const ac = l.action.startsWith('SELL') ? 'action-sell' : l.action.startsWith('BUY') ? 'action-buy' : 'action-hold';
    const bhVal   = d.bhPoints[i]   ? d.bhPoints[i].value   : 0;
    const qqqVal  = d.qqqPoints[i]  ? d.qqqPoints[i].value  : 0;
    const spyVal  = d.spyPoints[i]  ? d.spyPoints[i].value  : 0;
    const soxlVal = d.soxlPoints && d.soxlPoints[i] ? d.soxlPoints[i].value : 0;
    const qqq5Val = d.qqq5Points && d.qqq5Points[i] ? d.qqq5Points[i].value : 0;
    return `<tr>
      <td>${l.date.substring(0,7)}</td>
      <td>${fmtFull(l.invested)}</td>
      <td>${fmtFull(Math.round(l.tqqqVal))}</td>
      <td style="color:#fb923c">${fmtFull(Math.round(l.target))}</td>
      <td>${fmtFull(Math.round(l.cash))}</td>
      <td>${fmtFull(Math.round(l.total))}</td>
      <td style="color:#f87171">${fmtFull(Math.round(bhVal))}</td>
      <td style="color:#6366f1">${fmtFull(Math.round(qqq5Val))}</td>
      <td style="color:#14b8a6">${fmtFull(Math.round(soxlVal))}</td>
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
            <th>${(typeof nineSigName === 'function') ? nineSigName() : '9sig'}</th>
            <th>B&H TQQQ</th>
            <th>B&H QQQ5</th>
            <th>B&H SOXL</th>
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
  0:  ['9sig-controls', 'envelope-controls'], // 9sig sidebar: underlying + signal-growth + rebalancing-offset
  8:  ['adaptive-controls'],                  // Adaptive sidebar: strategy-switch params (underlying inherits from 9sig)
  10: ['sma-controls'],                       // SMA sidebar: asset + window + underlying selectors
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
    html += `<div class="strategy-rules-wrap" style="margin-top:24px">${buildNineSigRulesHtml()}</div>`;
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
  // If the just-toggled dataset has a limited history (e.g. SOXL/SMA),
  // re-render so the date-range floor recomputes and the slider snaps
  // forward if it was sitting before the new floor.
  if (typeof DATASET_IDX_TO_STRATEGY_KEY !== 'undefined') {
    const stratKey = DATASET_IDX_TO_STRATEGY_KEY[idx];
    const e = (stratKey != null && typeof earliestQIdxOf === 'function') ? earliestQIdxOf(stratKey) : 0;
    if (e > 0) render();
  }
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
  const rate = sliderToRate(+document.getElementById('slider-rate').value) / 100;
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

  // Strategy-aware floor: if a limited-history series is visible (e.g.
  // SOXL only starts 1994), bump the entry forward so the chart doesn't
  // show "$0 until first data point" for that line.
  const floorIdx = (typeof effectiveEntryMinQIdx === 'function') ? effectiveEntryMinQIdx() : 0;
  if (entryIdx < floorIdx) entryIdx = floorIdx;

  if (entryIdx >= exitIdx) {
    exitIdx  = Math.min(entryIdx + 1, maxIdx);
    entryIdx = Math.min(entryIdx, exitIdx - 1);
    if (entryIdx < 0) entryIdx = 0;
  }
  document.getElementById('slider-entry').value = entryIdx;
  document.getElementById('slider-exit').value  = exitIdx;
  // Update the dual-range UI in case clamping moved the entry handle.
  if (window._dualRange && typeof window._dualRange.updateUI === 'function') {
    window._dualRange.updateUI();
  }

  document.getElementById('disp-initial').textContent = fmtFull(initial);
  document.getElementById('disp-monthly').textContent = fmtFull(monthly);
  const raiseVal = annualRaise * 100;
  document.getElementById('disp-raise').textContent = (raiseVal % 1 === 0 ? raiseVal.toFixed(0) : raiseVal.toFixed(1)) + '%';
  const rv = (rate * 100);
  // Rate is always 0.5%-snapped (see sliderToRate), so 1 decimal place is enough.
  document.getElementById('disp-rate').textContent = rv.toFixed(1) + '%';
  document.getElementById('disp-entry').textContent = qLabel(quarterlyData[entryIdx][0]);
  document.getElementById('disp-exit').textContent = qLabel(quarterlyData[exitIdx][0]);

  // Per-strategy underlying + 9sig signal-growth from their side-panel selects.
  // 9sig and Adaptive share one selector (Adaptive is a 9sig vs. all-in mode
  // switch — coupling them keeps the comparison meaningful). SMA has its own
  // because its only relationship to the leveraged ETF is "hold it or not".
  // Column index in quarterlyData: 1=TQQQ, 4=SOXL, 5=QQQ5.
  const ulSel = (id) => {
    const v = (document.getElementById(id) || {}).value;
    return v === 'qqq5' ? 5 : (v === 'soxl' ? 4 : 1);
  };
  const sigUlCol = ulSel('select-9sig-underlying');
  const smaUlCol = ulSel('select-sma-underlying');
  const qGrowth  = +((document.getElementById('select-9sig-growth') || {}).value) / 100 || 0.09;
  const crashDropPct  = +((document.getElementById('select-9sig-crashdrop') || {}).value);
  const spikeTrigPct  = +((document.getElementById('select-9sig-spike')     || {}).value);

  const { log, bhPoints, qqqPoints, spyPoints, soxlPoints, qqq5Points, adaptivePoints, totalContributed } = simulate(initial, monthly, rate, entryIdx, exitIdx, annualRaise, {
    switchTo9sig, switchToAllIn, yearsBack: tqqqWindow,
    qGrowth,
    underlyingCol: sigUlCol,
    crashDropPct:   Number.isFinite(crashDropPct) ? crashDropPct : 30,
    spikeTriggerPct: Number.isFinite(spikeTrigPct) ? spikeTrigPct : 100,
  });

  // SMA timing strategy: same entry/exit window, same contributions, just
  // a different in/out rule. Independent of 9sig's quarterly rebalance —
  // it lives off the precomputed SMA-at-monthly map keyed by asset+window.
  const smaAsset  = (document.getElementById('select-sma-asset')  || {}).value || 'qqq';
  const smaWindow = +((document.getElementById('select-sma-window') || {}).value) || 200;
  const { smaPoints } = simulateSMA(initial, monthly, rate, entryIdx, exitIdx, annualRaise, { smaAsset, smaWindow, underlyingCol: smaUlCol });

  const showEnvelope = document.getElementById('toggle-envelope').checked;
  const opacityVal = +document.getElementById('slider-envelope-opacity').value / 100;
  document.getElementById('disp-envelope-opacity').textContent = 'opacity ' + opacityVal.toFixed(2);
  const envColor = `rgba(34,211,238,${opacityVal})`;
  // Each ghost line is the same 9sig strategy with rebalance shifted to a
  // different day — must inherit ALL the user's 9sig knobs (signal-line
  // growth %, underlying, 30-down drop, spike trigger), otherwise the
  // ghosts wouldn't track the user's current strategy.
  const shiftResults = showEnvelope
    ? shiftedQuarterlyCache.map(qData => simulate(initial, monthly, rate, entryIdx, exitIdx, annualRaise, {
        qData,
        skipBH: true,
        qGrowth,
        underlyingCol: sigUlCol,
        crashDropPct:   Number.isFinite(crashDropPct) ? crashDropPct : 30,
        spikeTriggerPct: Number.isFinite(spikeTrigPct) ? spikeTrigPct : 100,
      }).log.map(l => l.total))
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
  const finalSOXL = soxlPoints && soxlPoints.length ? soxlPoints[soxlPoints.length - 1].value : 0;
  const finalQQQ5 = qqq5Points && qqq5Points.length ? qqq5Points[qqq5Points.length - 1].value : 0;
  const finalSMA  = smaPoints  && smaPoints.length  ? smaPoints[smaPoints.length - 1].value   : 0;
  const years = log.length > 1 ? (new Date(log[log.length-1].date) - new Date(log[0].date)) / (365.25*86400000) : 1;
  const cagr = (end, start) => years > 0 && start > 0 ? (Math.pow(end / start, 1 / years) - 1) * 100 : 0;
  const finalAdaptive = adaptivePoints[adaptivePoints.length - 1].value;
  const ret9 = cagr(finalLog.total, totalContributed);
  const retBH = cagr(finalBH, totalContributed);
  const retQQQ = cagr(finalQQQ, totalContributed);
  const retSPY = cagr(finalSPY, totalContributed);
  const retSOXL = cagr(finalSOXL, totalContributed);
  const retQQQ5 = cagr(finalQQQ5, totalContributed);
  const retSMA  = cagr(finalSMA,  totalContributed);
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
    8:  retAdaptive,
    9:  retSOXL,
    10: retSMA,
    11: retQQQ5,
  };

  // Chart
  const labels = log.map(l => l.date);
  const totalD = log.map(l => l.total);
  const tqqqValD = log.map(l => l.tqqqVal);
  const cashD = log.map(l => l.cash);
  const bhD = bhPoints.map(b => b.value);
  const qqqD = qqqPoints.map(q => q.value);
  const spyD = spyPoints.map(s => s.value);
  const soxlD = soxlPoints ? soxlPoints.map(s => s.value) : [];
  const qqq5D = qqq5Points ? qqq5Points.map(p => p.value) : [];
  const smaD  = smaPoints  ? smaPoints.map(p => p.value)  : [];
  const smaStates = smaPoints ? smaPoints.map(p => p.state) : [];
  const invD = log.map(l => l.investedCompounded);
  const targetD = log.map(l => l.target);
  const adaptiveD = adaptivePoints.map(a => a.value);

  // Per-dataset stats shown inside the strategy side panel (CAGR / starting
  // balance / ending balance / max drawdown). Main strategies reuse their
  // money-weighted CAGR (vs total contributed); sub-series fall back to the
  // annualized growth rate of their own balance.
  const seriesByIdx = {
    0: totalD, 1: tqqqValD, 2: bhD, 3: qqqD, 4: spyD,
    5: targetD, 6: cashD, 7: invD, 8: adaptiveD, 9: soxlD, 10: smaD, 11: qqq5D,
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
  const _adaptToSigLabel = 'to ' + ((typeof nineSigName === 'function') ? nineSigName() : '9sig');
  const _adaptToAllInLabel = 'to ' + (
    ((document.getElementById('select-9sig-underlying') || {}).value || 'tqqq').toUpperCase()
  );
  const adaptiveTransitions = adaptivePoints.map((a, i) => {
    if (i === 0) return a.state === '9sig' ? _adaptToSigLabel : _adaptToAllInLabel;
    if (a.state === adaptivePoints[i-1].state) return null;
    return a.state === '9sig' ? _adaptToSigLabel : _adaptToAllInLabel;
  });

  if (chart) {
    chart.data.labels = labels;
    // Dataset labels with "9sig" prefix are live — recompute from current
    // signal-growth selector so the legend chip + tooltip auto-rename when
    // the user picks a different growth %.
    const _nsName = (typeof nineSigName === 'function') ? nineSigName() : '9sig';
    chart.data.datasets[0].label = _nsName;
    chart.data.datasets[1].label = _nsName + ' Holding';
    chart.data.datasets[5].label = _nsName + ' Target';
    chart.data.datasets[6].label = _nsName + ' Cash';
    chart.data.datasets[10].label = `SMA ${(document.getElementById('select-sma-window') || {}).value || 200}`;
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
    chart.data.datasets[9].data = soxlD;
    chart.data.datasets[10].data = smaD;
    chart.data.datasets[10]._smaStates = smaStates;
    chart.data.datasets[11].data = qqq5D;
    while (chart.data.datasets.length < 12 + envelopeShiftCount) {
      const offset = chart.data.datasets.length - 12;
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
      const ds9 = chart.data.datasets[12 + i];
      ds9.data = showEnvelope ? (shiftResults[i] || []) : [];
      ds9.borderColor = envColor;
      ds9.hidden = !showEnvelope;
    }
    chart.options.scales.y.type = logScale ? 'logarithmic' : 'linear';
    chart.options.scales.y.beginAtZero = !logScale;
    chart.update('none');
  } else {
  const ctx = document.getElementById('mainChart').getContext('2d');

  // Hue map (kept here so it's easy to retune later):
  //   0  9sig          cyan       #22d3ee
  //   1  9sig Holding  sky-blue   #38bdf8  (related to 9sig, lighter)
  //   2  B&H TQQQ      red        #f87171
  //   3  B&H QQQ       green      #4ade80
  //   4  B&H SPY       pink       #f472b6
  //   5  9sig Target   orange     #fb923c
  //   6  9sig Cash     amber      #fbbf24
  //   7  Invested Comp gray
  //   8  Adaptive      purple     #c084fc
  //   9  B&H SOXL      teal       #14b8a6  (was #a78bfa — clashed with Adaptive)
  //  10  SMA           chartreuse #a3e635  (was #facc15 — clashed with Cash)
  //  11  B&H QQQ5      indigo     #6366f1  (was #fb7185 — clashed with TQQQ red)
  const lineColors = ['#22d3ee', '#38bdf8', '#f87171', '#4ade80', '#f472b6', '#fb923c', '#fbbf24', 'rgba(226,232,240,0.4)', '#c084fc', '#14b8a6', '#a3e635', '#6366f1'];
  const smaWinForLabel = +((document.getElementById('select-sma-window') || {}).value) || 200;
  const _initNsName = (typeof nineSigName === 'function') ? nineSigName() : '9sig';
  const lineNames  = [_initNsName, _initNsName + ' Holding', 'B&H TQQQ', 'B&H QQQ', 'B&H SPY', _initNsName + ' Target', _initNsName + ' Cash', 'Invested Comp.', 'Adaptive (WIP)', 'B&H SOXL', `SMA ${smaWinForLabel}`, 'B&H QQQ5'];
  // Match the borderDash on the corresponding chart dataset; null = solid.
  // Every B&H series gets a visually distinct dash pattern so you can tell
  // them apart at a glance even when they overlap.
  //   2 B&H TQQQ   [6,3]       medium dash
  //   3 B&H QQQ    [8,4]       long dash
  //   4 B&H SPY    [2,5]       sparse dots
  //   9 B&H SOXL   [12,4]      extra-long dash
  //  11 B&H QQQ5   [5,2,2,2]   dash-dot
  const lineDashes = [null, [2,2], [6,3], [8,4], [2,5], [4,4], null, [3,3], null, [12,4], null, [5,2,2,2]];

  // Touch / coarse-pointer detection — once at chart creation time. On those
  // devices Chart.js's tap-to-show tooltip is followed by an immediate
  // opacity=0 dismissal as soon as the finger lifts, so we make the tooltip
  // sticky and require an explicit close (× button or tap outside) instead.
  const isTouchChart = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  let chartTooltipPinned = false;

  const externalTooltip = (context) => {
    const { chart: c, tooltip } = context;
    const el = document.getElementById('custom-tooltip');
    if (tooltip.opacity === 0) {
      if (isTouchChart && chartTooltipPinned) return; // stay open until dismissed
      el.style.display = 'none';
      return;
    }
    if (isTouchChart) chartTooltipPinned = true;

    const idx = tooltip.dataPoints?.[0]?.dataIndex;
    if (idx == null) return;

    const ds = c.data.datasets;
    const date = c.data.labels[idx];
    const vals = [ds[0].data[idx], ds[1].data[idx], ds[2].data[idx], ds[3].data[idx], ds[4].data[idx], ds[5].data[idx], ds[6].data[idx], ds[7].data[idx], ds[8].data[idx], ds[9] ? ds[9].data[idx] : null, ds[10] ? ds[10].data[idx] : null, ds[11] ? ds[11].data[idx] : null];

    const rgba = (col, a) => {
      if (col.startsWith('rgba')) return col.replace(/,\s*[\d.]+\s*\)$/, `,${a})`);
      const m = col.match(/^#([0-9a-f]{6})$/i);
      if (!m) return col;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    // Read names from the live datasets so dynamic labels (e.g. "15sig")
    // reflect the current selector state, not the chart-init snapshot.
    // Cap at lineNames.length so envelope-shift datasets (`_shift_*`) stay
    // out of the tooltip just like before.
    const items = lineNames
      .map((_, i) => ({ i, n: (ds[i] && ds[i].label) || lineNames[i], v: vals[i] }))
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
        ? `<span style="margin-left:6px;font-size:10px;color:${adaptiveTrans.endsWith('sig') ? '#22d3ee' : '#f87171'};font-weight:600">${adaptiveTrans}</span>`
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

    el.innerHTML = `<button class="tt-close" type="button" aria-label="Close" data-tt-close>&times;</button><div class="tt-date">${qLabel(date)}</div>${rows}`;

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

  // Wire the tooltip's close button and outside-tap dismissal once. The
  // tooltip element is stable so we can attach listeners here at chart
  // creation time rather than on every render.
  const ttEl = document.getElementById('custom-tooltip');
  const dismissChartTooltip = () => {
    chartTooltipPinned = false;
    if (ttEl) ttEl.style.display = 'none';
  };
  if (ttEl && !ttEl._closeWired) {
    ttEl._closeWired = true;
    ttEl.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-tt-close]')) {
        dismissChartTooltip();
      }
    });
    if (isTouchChart) {
      document.addEventListener('click', (e) => {
        if (!chartTooltipPinned) return;
        if (e.target.closest('#custom-tooltip')) return;
        if (e.target.closest('#mainChart'))      return;
        dismissChartTooltip();
      });
    }
  }

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
        // Prefer the live dataset label so dynamic names ("15sig", "SMA 150")
        // update without a chart rebuild. Fall back to the chart-init snapshot.
        return { y: pt.y, i, color: lineColors[i], name: ds.label || lineNames[i], val: ds.data[lastIdx] };
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
        const isToSig = trans.endsWith('sig');
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
          label: _initNsName,
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
          label: _initNsName + ' Holding',
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
          borderDash: [2, 5],
          hidden: true
        },
        {
          label: _initNsName + ' Target',
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
          label: _initNsName + ' Cash',
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
          label: 'Adaptive (WIP)',
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
        {
          label: 'B&H SOXL',
          data: soxlD,
          borderColor: '#14b8a6',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [12, 4],
          hidden: true
        },
        {
          label: `SMA ${smaWinForLabel}`,
          data: smaD,
          borderColor: '#a3e635',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          hidden: true,
          _smaStates: smaStates
        },
        {
          label: 'B&H QQQ5',
          data: qqq5D,
          borderColor: '#6366f1',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [5, 2, 2, 2],
          hidden: true,
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
  _logData = { log, bhPoints, qqqPoints, spyPoints, soxlPoints, qqq5Points };

  // Compact legend chips (eye + name + CAGR) above the chart. Also re-renders
  // the open side panel if any (so its log table stays in sync with sliders).
  refreshAllLegends();

  if (typeof refreshAnalytics === 'function') refreshAnalytics();
}

