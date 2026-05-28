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
  0,  // 9sig
  8,  // SMA
  2,  // Buy & Hold — dataset 2's label + data swap based on
      // #select-bh-underlying (TQQQ / QQQ / SPY / QQQ5).
  7,  // Invested Compounded
];
// Datasets 3 (B&H QQQ), 4 (B&H SPY), 9 (B&H QQQ5), 10 (B&H QLD), 11 (B&H SSO),
// and 12 (B&H SPXL) stay in the chart structure so dataset indices don't shift,
// but their chips are hidden — the consolidated dataset 2 chip serves as the
// single B&H entry, with the underlying picked via the sidebar selector.
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
  const cashP  = +((document.getElementById('select-9sig-cash') || {}).value) || 0;
  const stockP = 100 - cashP;
  const bp     = +((document.getElementById('select-9sig-buypower') || {}).value) || 90;

  const crashRule = cd >= 100
    ? `<span style="color:var(--text-muted)">(30-down protection: off at ${cd}%)</span>`
    : `When ${ul} is more than <b>${cd}%</b> below its 2-year high, <b>skip selling for up to two quarters in a row</b> — don't dump in a crash. After two skips, sell anyway.`;
  const spikeRule = sp <= 0
    ? `<span style="color:var(--text-muted)">(Spike-reset: off)</span>`
    : `If ${ul} <b>gains more than ${sp}% in a single quarter</b> and you still hold ≥${stockP}% in it, hard-rebalance back to ${stockP}/${cashP} — lock in the windfall.`;

  return `
    <div class="strategy-panel-section-label">${name} explained</div>
    <div class="strategy-rules">
      <div style="margin-bottom:10px;color:var(--text)">
        <b>The idea:</b> each quarter, ${ul} should grow by ${g}%. If it grew faster, sell the excess to cash. If slower, buy more with cash. That's it.
      </div>

      <div style="margin-top:14px;font-weight:600;color:var(--text)">How it actually works</div>
      <div style="margin-top:6px">
        <b>1. Start.</b> Put ${stockP}% of your money in ${ul}, ${cashP}% in cash. Write down the value of the ${ul} side — that's your <b>target</b>.
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
        &bull; <b>${bp}% buying power.</b> A buy never spends more than ${bp}% of your cash${bp < 100 ? ' — you keep some dry powder' : ''}.
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

// Event-driven log table for the SMA strategy. Shows one row per actual
// trade (ENTER / EXIT) — not one row per quarter — because SMA only does
// something when the signal flips. Most quarters would just be noise.
function buildSmaLogTableHtml(smaLog) {
  if (!smaLog || smaLog.length === 0) return '';
  // The leveraged ETF the SMA strategy holds when "in" (TQQQ / QQQ5).
  const ulName = ((document.getElementById('select-sma-underlying') || {}).value || 'tqqq').toUpperCase();
  const rows = smaLog.map(l => {
    const ac = l.action === 'EXIT'  ? 'action-sell'
             : l.action === 'ENTER' ? 'action-buy'
             : 'action-hold';
    return `<tr>
      <td>${fmtLogDate(l.date)}</td>
      <td class="${ac}">${l.action}</td>
      <td>${l.state.toUpperCase()}</td>
      <td>${fmtLogPrice(l.price)}</td>
      <td>${fmtLogShares(l.shares)}</td>
      <td>${fmtFull(Math.round(l.stockVal))}</td>
      <td>${fmtFull(Math.round(l.cash))}</td>
      <td>${fmtFull(Math.round(l.total))}</td>
      <td>${fmtFull(l.invested)}</td>
    </tr>`;
  }).join('');
  return `
    <div class="strategy-panel-section-label" style="margin-top:24px">SMA Transaction Log</div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">
      One row per actual trade. ${smaLog.length} event${smaLog.length===1?'':'s'} over this window.
    </div>
    <div class="quarter-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Action</th>
            <th>State</th>
            <th>${ulName} Price</th>
            <th>${ulName} Shares</th>
            <th>Stock Val</th>
            <th>Cash</th>
            <th>Total</th>
            <th>Invested</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Per-share price formatter — synthetic prices span tiny (1938) to large.
function fmtLogPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return '–';
  if (p >= 1000) return '$' + p.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (p >= 1)    return '$' + p.toFixed(2);
  if (p >= 0.01) return '$' + p.toFixed(4);
  return '$' + p.toPrecision(2);
}
// Share-count formatter (a quantity, not dollars — no $).
function fmtLogShares(n) {
  if (!Number.isFinite(n)) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (n >= 1)   return n.toFixed(2);
  return n.toFixed(4);
}

// Tooltip shown on a log's last (current-period) row. That period hasn't
// closed yet, so its values are the latest daily snapshot and move until the
// period ends.
const LOG_LATEST_TIP = "Latest reading, and this period hasn't closed yet. The price is a snapshot taken only a couple of hours into the trading day, so it can move a lot over the remaining ~6 hours and may not match the actual close. It refreshes with each next day's data.";
function latestBadge(isLast) {
  return isLast ? ` <span class="info-icon" tabindex="0" data-tip="${LOG_LATEST_TIP}">ⓘ</span>` : '';
}

// Per-period "new money in" for a log: first period = the initial lump sum,
// later periods = the contributions that landed during that period (derived
// from the running cumulative `invested`). All strategies share the same
// contribution schedule, so this is computed once from the 9sig log.
function newMoneyPerPeriod(log) {
  return log.map((l, i) => (i === 0 ? l.invested : l.invested - log[i - 1].invested));
}

// Generic per-period log for strategies without a bespoke table (Buy & Hold,
// Invested Compounded). Columns: Date · Type · New $ · Value. `typeFor(i, nm)`
// returns the row's Type label; `valueAt(i)` the portfolio value that period.
function buildSimpleLogTableHtml(title, log, valueAt, typeFor) {
  if (!log || !log.length) return '';
  const nm = newMoneyPerPeriod(log);
  const last = log.length - 1;
  const rows = log.map((l, i) => `<tr${i === last ? ' class="log-latest"' : ''}>
      <td>${fmtLogDate(l.date)}</td>
      <td>${typeFor(i, nm[i])}${latestBadge(i === last)}</td>
      <td>${nm[i] > 0 ? fmtFull(Math.round(nm[i])) : '—'}</td>
      <td>${fmtFull(Math.round(valueAt(i)))}</td>
    </tr>`).join('');
  return `
    <div class="strategy-panel-section-label" style="margin-top:24px">${title}</div>
    <div class="quarter-table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>New $</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Buy & Hold log. Columns: Date · Type · New $ · {UL} Price · {UL} Shares ·
// Value. `series` is the selected underlying's point array (carries price +
// shares per period). With no contributions the intermediate rows are just
// the price path, so we collapse to the buy (first) and latest (last) rows.
function buildBuyHoldLogTableHtml(title, log, series, ulName) {
  if (!log || !log.length || !series || !series.length) return '';
  const nm = newMoneyPerPeriod(log);
  const n = log.length;
  const last = n - 1;
  const hasContrib = nm.some((m, i) => i > 0 && m > 0);
  const indices = hasContrib ? log.map((_, i) => i) : (n > 1 ? [0, last] : [0]);
  const rows = indices.map(i => {
    const s = series[i] || {};
    const type = i === 0 ? 'Initial buy'
               : hasContrib ? (nm[i] > 0 ? 'Monthly investment' : 'Hold')
               : 'Latest';
    return `<tr${i === last ? ' class="log-latest"' : ''}>
      <td>${fmtLogDate(log[i].date)}</td>
      <td>${type}${latestBadge(i === last)}</td>
      <td>${nm[i] > 0 ? fmtFull(Math.round(nm[i])) : '—'}</td>
      <td>${fmtLogPrice(s.price)}</td>
      <td>${fmtLogShares(s.shares)}</td>
      <td>${fmtFull(Math.round(s.value || 0))}</td>
    </tr>`;
  }).join('');
  return `
    <div class="strategy-panel-section-label" style="margin-top:24px">${title}</div>
    <div class="quarter-table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>New $</th><th>${ulName} Price</th><th>${ulName} Shares</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildLogTableHtml(d) {
  if (!d || !d.log || !d.log.length) return '';
  // Column names follow whichever underlying the 9sig run trades (TQQQ / QQQ5).
  const ulName = ((document.getElementById('select-9sig-underlying') || {}).value || 'tqqq').toUpperCase();
  const nm = newMoneyPerPeriod(d.log);
  const fmtPrice = fmtLogPrice;
  const fmtShares = fmtLogShares;
  const lastIdx = d.log.length - 1;
  const rows = d.log.map((l, i) => {
    const ac = l.action.startsWith('SELL') ? 'action-sell' : l.action.startsWith('BUY') ? 'action-buy' : 'action-hold';
    const shares = l.price > 0 ? l.tqqqVal / l.price : 0;
    const type = i === 0 ? 'Initial' : 'Rebalance';
    return `<tr${i === lastIdx ? ' class="log-latest"' : ''}>
      <td>${fmtLogDate(l.date)}</td>
      <td>${type}${latestBadge(i === lastIdx)}</td>
      <td>${nm[i] > 0 ? fmtFull(Math.round(nm[i])) : '—'}</td>
      <td>${fmtPrice(l.price)}</td>
      <td>${fmtShares(shares)}</td>
      <td>${fmtFull(Math.round(l.tqqqVal))}</td>
      <td style="color:#fb923c">${fmtFull(Math.round(l.target))}</td>
      <td>${fmtFull(Math.round(l.cash))}</td>
      <td>${fmtFull(Math.round(l.total))}</td>
      <td class="${ac} log-action">${l.action}</td>
    </tr>`;
  }).join('');
  return `
    <div class="strategy-panel-section-label" style="margin-top:24px">Rebalance Log</div>
    <div class="quarter-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>New $</th>
            <th>${ulName} Price</th>
            <th>${ulName} Shares</th>
            <th>${ulName} Val</th>
            <th>Target</th>
            <th>Cash</th>
            <th>Total Portfolio</th>
            <th class="log-action">Action</th>
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
  let m = (window._strategyMetrics || {})[idx];
  // When a saved strategy is open for editing, the panel describes THAT strategy,
  // not the canonical base line — show its own metrics instead. (The top legend
  // chip keeps reading _strategyMetrics, so it still shows the canonical base.)
  const ecid = window._editingConfigId;
  if (ecid && typeof getSavedConfigs === 'function') {
    const cfg = getSavedConfigs().find(c => c.id === ecid);
    if (cfg && cfg.type !== 'custom' && PANEL_IDX_BY_KEY[cfg.type] === idx) {
      const cm = (window._configMetrics || {})[ecid];
      if (cm) m = { cagr: cm.cagr, start: cm.start, end: cm.end, maxDD: cm.maxDD };
    }
  }
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
  0: ['9sig-controls', 'what-if-controls'],  // 9sig sidebar: strategy knobs + "what if" experiments (envelope + deploy)
  2: ['bh-controls'],                        // Buy & Hold sidebar: underlying selector (consolidated chip)
  7: ['invested-controls'],                  // Invested Compounded sidebar: the cash interest-rate slider
  8: ['sma-controls'],                       // SMA sidebar: asset + window + underlying selectors
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

// While a range input that lives INSIDE the panel is being dragged, its
// continuous `input` events fire render() → refreshAllLegends() → this
// function, which would detach + re-prepend the control mid-drag and break
// the drag. Suppress the rebuild during the drag; a final rebuild runs on
// release (see the mouseup/touchend handlers below).
let _suppressPanelRebuild = false;
function _onPanelControlDragStart(e) {
  const t = e.target;
  if (t && t.closest && t.closest('.strategy-panel-content')
      && t.matches && t.matches('input[type="range"]')) {
    _suppressPanelRebuild = true;
  }
}
function _onPanelControlDragEnd() {
  if (!_suppressPanelRebuild) return;
  _suppressPanelRebuild = false;
  if (_currentPanelIdx !== null) renderStrategyPanelBody(_currentPanelIdx);
}
document.addEventListener('mousedown', _onPanelControlDragStart);
document.addEventListener('mouseup', _onPanelControlDragEnd);
document.addEventListener('touchstart', _onPanelControlDragStart, { passive: true });
document.addEventListener('touchend', _onPanelControlDragEnd);

function renderStrategyPanelBody(idx) {
  const body = document.getElementById('strategy-panel-body');
  if (!body || !chart) return;
  // Don't clobber the panel while a slider inside it is being dragged.
  if (_suppressPanelRebuild) return;
  // Snapshot every live-control <select> value before the DOM moves below.
  // Re-inserting a <select> reverts it to its `selected`-attribute default
  // in some browsers, which would silently undo the user's last pick (the
  // chart already rendered with the new value, but the select + its preview
  // trigger would snap back). We restore the snapshot after re-attaching.
  const _selSnap = [];
  for (const id of ALL_LIVE_CONTROL_IDS) {
    const node = document.getElementById(id);
    if (node) node.querySelectorAll('select').forEach(s => _selSnap.push([s, s.value]));
  }
  // Preserve scroll position across the innerHTML rebuild — otherwise toggling
  // a sub-series chip (or any re-render) snaps the sidebar back to the top.
  const _scrollTop = body.scrollTop;
  // Detach hosted controls before clobbering innerHTML.
  detachLiveControls();
  let html = '';
  // Line-color picker + save/update bar for saved strategies (saved-configs.js).
  // Appear right under the live controls (which get prepended below).
  if (PANEL_KEY_BY_IDX[idx] != null) {
    if (typeof buildColorPickerHtml === 'function') html += buildColorPickerHtml(PANEL_KEY_BY_IDX[idx]);
    if (typeof buildPanelSaveBarHtml === 'function') html += buildPanelSaveBarHtml(PANEL_KEY_BY_IDX[idx]);
  }
  // Sub-series chips (9sig's Holding/Target/Cash). When editing a SAVED 9sig the
  // chips toggle THAT strategy's own breakdown lines (per-strategy, persistent —
  // see buildConfigSubChipsHtml); otherwise they toggle the main's datasets 1/5/6.
  const subs = SUB_LEGEND[idx];
  const editingSavedOfType = window._editingConfigId && typeof getSavedConfigs === 'function'
    && getSavedConfigs().find(c => c.id === window._editingConfigId && c.type === PANEL_KEY_BY_IDX[idx]);
  if (subs && subs.length) {
    const chipsHtml = editingSavedOfType && typeof buildConfigSubChipsHtml === 'function'
      ? buildConfigSubChipsHtml(editingSavedOfType)
      : buildLegendChipsHtml(subs, { noMore: true });
    html += `
      <div class="strategy-panel-section-label">Sub-series</div>
      <div class="legend-chip-group">${chipsHtml}</div>
    `;
  }
  html += renderStatsGrid(idx);
  // 9sig-specific content: log first, then the "explained" rules block
  // (rules are reference material; the live log is what the user usually
  // wants to scan after tweaking the controls).
  if (idx === 0) {
    html += buildLogTableHtml(_logData);
    html += `<div class="strategy-rules-wrap" style="margin-top:24px">${buildNineSigRulesHtml()}</div>`;
  }
  // Buy & Hold (idx 2): per-period log of the selected underlying's value.
  // No rebalancing — Type is "Monthly investment" when a contribution lands,
  // else "Hold".
  if (idx === 2 && _logData && _logData.log) {
    const bhKey = ((document.getElementById('select-bh-underlying') || {}).value) || 'tqqq';
    const bhSeries = bhKey === 'qqq'  ? _logData.qqqPoints
                   : bhKey === 'spy'  ? _logData.spyPoints
                   : bhKey === 'qld'  ? _logData.qldPoints
                   : bhKey === 'qqq5' ? _logData.qqq5Points
                   : bhKey === 'sso'  ? _logData.ssoPoints
                   : bhKey === 'spxl' ? _logData.spxlPoints
                   :                    _logData.bhPoints;
    html += buildBuyHoldLogTableHtml('Buy & Hold Log', _logData.log, bhSeries, bhKey.toUpperCase());
  }
  // Invested Compounded (idx 7): contributions parked in interest-bearing cash.
  if (idx === 7 && _logData && _logData.log) {
    html += buildSimpleLogTableHtml('Invested Compounded Log', _logData.log,
      (i) => _logData.log[i].investedCompounded,
      (i, m) => i === 0 ? 'Initial' : (m > 0 ? 'Monthly investment' : 'Interest'));
  }
  // SMA-specific content: event-driven transaction log.
  if (idx === 8 && _logData && _logData.smaLog) {
    html += buildSmaLogTableHtml(_logData.smaLog);
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
  // Restore any <select> values the DOM moves reverted.
  for (const [s, v] of _selSnap) { if (s.value !== v) s.value = v; }
  // The "Show alternate runs" checkbox reflects the CURRENT strategy's own flag
  // (main session flag, or the open saved strategy's cfg.showEnvelope).
  if (idx === 0) {
    const envCb = document.getElementById('toggle-envelope');
    if (envCb && typeof currentEnvelopeFlag === 'function') envCb.checked = currentEnvelopeFlag();
  }
  // Preview-dropdown trigger labels read the (now-correct) select values.
  if (typeof window.refreshPreviewTriggers === 'function') window.refreshPreviewTriggers();
  // Restore the pre-rebuild scroll position.
  body.scrollTop = _scrollTop;
}

// Strategy detail side panel — opens when a legend chip's more-button is
// clicked. Title is the strategy name; body shows nested chips for any
// sub-series defined in SUB_LEGEND (e.g. 9sig's TQQQ holding/target/cash).
function openStrategyPanel(idx) {
  const panel = document.getElementById('strategy-panel');
  const title = document.getElementById('strategy-panel-title');
  if (!panel) return;
  window._openCustomCfgId = null; // a base panel is opening, not a custom one
  const ds = chart && chart.data.datasets[idx];
  if (title && ds) title.textContent = ds.label;
  _currentPanelIdx = idx;
  renderStrategyPanelBody(idx);
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}
// Open the custom-strategy editor panel (code + generated controls + log).
function openCustomPanel(cfgId) {
  const panel = document.getElementById('strategy-panel');
  if (!panel) return;
  _currentPanelIdx = null;
  window._openCustomCfgId = cfgId;
  window._editingConfigId = cfgId;
  const cfg = (typeof getSavedConfigs === 'function') ? getSavedConfigs().find(c => c.id === cfgId) : null;
  const title = document.getElementById('strategy-panel-title');
  if (title && cfg) title.textContent = cfg.name;
  if (typeof renderCustomPanelBody === 'function') renderCustomPanelBody(cfgId);
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}
function closeStrategyPanel() {
  const panel = document.getElementById('strategy-panel');
  if (!panel) return;
  // Closing the panel means nothing is being edited — so the base lines must go
  // back to their fixed canonical state. Reset whichever base type's knobs were
  // loaded in the sidebar (a saved strategy left its params there) so the base
  // line doesn't keep showing those edits once the panel is gone.
  const openKey = getOpenPanelKey();
  if (openKey && typeof resetBaseControlsToCanonical === 'function') resetBaseControlsToCanonical(openKey);
  window._editingConfigId = null;
  window._pendingConfigName = null;
  window._openCustomCfgId = null;
  _currentPanelIdx = null;
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  if (openKey && typeof render === 'function') render();
}
// Gated close: when a BASE panel has edits that differ from canonical defaults,
// closing would silently reset them — so warn first. Editing a saved strategy
// auto-syncs live, so no warning is needed there.
function attemptCloseStrategyPanel() {
  const key = getOpenPanelKey();
  const editingSaved = window._editingConfigId
    && typeof getSavedConfigs === 'function'
    && getSavedConfigs().some(c => c.id === window._editingConfigId && c.type === key);
  const dirty = key && !editingSaved
    && typeof captureParams === 'function'
    && typeof captureDefaultParams === 'function'
    && typeof paramsEqual === 'function'
    && !paramsEqual(captureParams(key), captureDefaultParams(key), key);
  if (!dirty) { closeStrategyPanel(); return; }
  showUnsavedDialog(key,
    () => { if (typeof saveConfigFromType === 'function') saveConfigFromType(key); closeStrategyPanel(); },
    () => closeStrategyPanel());
}

// Stable keys for the openable strategy panels, so a share link can capture
// which sidebar was open without depending on dataset indices (which shift
// between versions). Used by shareConfig (controls.js) + restore (init.js).
const PANEL_KEY_BY_IDX = { 0: '9sig', 2: 'bh', 7: 'invested', 8: 'sma' };
const PANEL_IDX_BY_KEY = { '9sig': 0, 'bh': 2, 'invested': 7, 'sma': 8 };
function getOpenPanelKey() {
  return (_currentPanelIdx != null) ? (PANEL_KEY_BY_IDX[_currentPanelIdx] || null) : null;
}
function openPanelByKey(key) {
  const idx = PANEL_IDX_BY_KEY[key];
  if (idx != null) openStrategyPanel(idx);
}

// Re-render whichever legend surface(s) need updating after a visibility
// toggle — main legend always; the side panel's nested chips when open.
function refreshAllLegends() {
  renderChartLegend();
  if (_currentPanelIdx !== null) renderStrategyPanelBody(_currentPanelIdx);
  if (window._openCustomCfgId && typeof renderCustomPanelBody === 'function') renderCustomPanelBody(window._openCustomCfgId);
  if (typeof renderSavedConfigPills === 'function') renderSavedConfigPills();
}

// The envelope "alternate runs" belong to the base 9sig line (dataset 0):
// show its ghost band only when the envelope toggle is on AND the base 9sig
// line itself is visible — otherwise the band floats with no owning line.
// (Saved-strategy ghost bands carry a _configId and are managed per-strategy
// in saved-configs.js, so they're skipped here.)
// "Show alternate runs" is a PER-STRATEGY setting. The base (main 9sig) envelope
// has its own session flag (window._mainEnvelopeOn); each saved 9sig stores its
// own cfg.showEnvelope. A strategy's envelope shows whenever its own flag is on
// and its line is visible — independent of the panel being open and of every other
// strategy. (Saved strategies draw theirs via computeConfigGhosts.)
// The x-axis date grain is the FINEST rebalance period among the 9sig strategies
// that will actually be drawn — the main 9sig (if its line is visible) plus every
// visible saved 9sig. Coarser strategies step-resample onto it without losing
// detail, and (crucially) it doesn't flip when the main resets on save/close.
// `livePeriod` is the edited strategy's own period (the main line uses it when the
// main is the one being drawn; otherwise the main is canonical/hidden).
const _PERIOD_RANK = { weekly: 0, monthly: 1, quarterly: 2, yearly: 3 };
function _finerPeriod(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (_PERIOD_RANK[a] ?? 2) <= (_PERIOD_RANK[b] ?? 2) ? a : b;
}
function chartDisplayPeriod(livePeriod) {
  let p = null;
  // Main 9sig line: its period is the live (draft) period when we're editing the
  // main, or canonical quarterly when a saved strategy is being edited.
  const mainVisible = chart ? chart.isDatasetVisible(0) : false;
  if (mainVisible) p = window._editingConfigId ? 'quarterly' : livePeriod;
  if (typeof getSavedConfigs === 'function') {
    for (const c of getSavedConfigs()) {
      if (c.type === '9sig' && !c.hidden) {
        p = _finerPeriod(p, (c.params && c.params['select-9sig-period']) || 'quarterly');
      }
    }
  }
  // Floor the x-axis at QUARTERLY: a yearly strategy is still drawn (and
  // hovered) at quarter resolution — its quarter-end values come from the sim's
  // sampleQuarterly snapshots. Go finer than a quarter only when a finer
  // strategy (monthly / weekly) is actually visible.
  return _finerPeriod(p || livePeriod || 'quarterly', 'quarterly');
}
// The chart's minimum plottable value is 1. Values below 1 (e.g. a strategy fully
// out of cash → Cash = 0) are raised to 1 so they always render: on a log axis 0
// can't be plotted (log of 0 is undefined) and the line would vanish; 1 keeps it
// continuous at the very bottom ("simulate zero"). Real gaps (null) are left alone.
const CHART_MIN = 1;
function clampChartMin(chart) {
  if (!chart || !chart.data) return;
  for (const ds of chart.data.datasets) {
    const d = ds.data;
    if (!d) continue;
    for (let i = 0; i < d.length; i++) {
      if (typeof d[i] === 'number' && d[i] < CHART_MIN) d[i] = CHART_MIN;
    }
  }
}
function syncEnvelopeVisibility() {
  if (!chart) return;
  const baseVisible = chart.isDatasetVisible(0);
  const show = !!window._mainEnvelopeOn && baseVisible;
  chart.data.datasets.forEach((ds, i) => {
    if (ds._isShift && !ds._configId) chart.setDatasetVisibility(i, show);
  });
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
    // Opening a base strategy's sidebar means we're editing the live config,
    // not a saved one — clear the saved-config edit target + any pending name.
    window._editingConfigId = null;
    window._pendingConfigName = null;
    if (chip) {
      const idx = +chip.dataset.idx;
      // "Open sig tqqq" = start from a clean canonical copy: reset this type's
      // knob controls so the base line doesn't inherit a saved strategy's params
      // that may still be loaded in the sidebar from a previous edit.
      const key = PANEL_KEY_BY_IDX[idx];
      if (key && typeof resetBaseControlsToCanonical === 'function') resetBaseControlsToCanonical(key);
      // The main strategy may have been auto-hidden by a previous save — re-show
      // it so you're not editing an invisible line.
      if (key && typeof setBaseStrategyVisibility === 'function') setBaseStrategyVisibility(key, true);
      openStrategyPanel(idx);
      if (typeof render === 'function') render();
    }
    return;
  }
  // Side-panel close button → close. Clicking the backdrop does NOT close
  // the panel: the user can keep tweaking strategy knobs in the sidebar and
  // see the chart update behind it without losing the panel each time they
  // click on the chart area. Use the × button or Esc to dismiss.
  if (e.target.closest('.strategy-panel-close')) {
    attemptCloseStrategyPanel();
    return;
  }
  // Anywhere else on the chip → toggle dataset visibility.
  const chip = e.target.closest('.legend-chip[data-idx]');
  if (!chip || !chart) return;
  const idx = +chip.dataset.idx;
  if (!Number.isFinite(idx)) return;
  const nextVisible = !chart.isDatasetVisible(idx);
  chart.setDatasetVisibility(idx, nextVisible);
  // Re-showing the MAIN strategy resets it to its defaults — it's a fixed
  // canonical reference, not a place edits persist. Skip when a saved strategy of
  // this type is being edited (the base is already frozen canonical and its
  // controls belong to that saved strategy, so resetting would corrupt it).
  let forceRender = false;
  const baseKey = PANEL_KEY_BY_IDX[idx];
  if (nextVisible && baseKey != null) {
    const editingSavedOfType = window._editingConfigId
      && typeof getSavedConfigs === 'function'
      && getSavedConfigs().some(c => c.id === window._editingConfigId && c.type === baseKey);
    if (!editingSavedOfType && typeof resetBaseControlsToCanonical === 'function') {
      resetBaseControlsToCanonical(baseKey);
      forceRender = true;
    }
  }
  // When the user hides a parent chip, cascade-hide its sub-series too —
  // otherwise the orphaned Holding/Target/Cash lines would stay on the
  // chart with no parent line to anchor them. Showing the parent does NOT
  // auto-reveal sub-series (they're hidden by default and toggled via the
  // side panel).
  if (!nextVisible) {
    const subs = SUB_LEGEND[idx];
    if (subs) for (const sIdx of subs) chart.setDatasetVisibility(sIdx, false);
  }
  // The base 9sig's envelope band ("alternate runs") follows its line's
  // visibility — hide it when 9sig is hidden, restore it when shown.
  if (idx === 0) syncEnvelopeVisibility();
  // The main 9sig's visibility changes which strategies the x-axis grain is
  // computed from (chartDisplayPeriod), so the chart must be fully recomputed.
  if (idx === 0) forceRender = true;
  // If we're going to render() anyway, do NOT also run an animated chart.update()
  // first: when the label count changes (e.g. 17↔62) the in-flight animated
  // update fights render()'s update('none') and leaves stale, looped line paths
  // ("going back in time"). Persist + render once, cleanly.
  if (forceRender) {
    if (typeof saveSliders === 'function') saveSliders();
    render();
    return;
  }
  chart.update();
  refreshAllLegends();
  // Persist so a plain page refresh keeps the same legend visibility mix.
  if (typeof saveSliders === 'function') saveSliders();
  // If the just-toggled dataset has a limited history (e.g. SMA),
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
  if (panel && panel.classList.contains('is-open')) attemptCloseStrategyPanel();
});

function render() {
  if (!quarterlyData) return; // data not loaded yet
  // Live-edit: mirror sidebar changes into the open saved strategy before the
  // config lines are computed, so its line/label track the dropdowns instantly.
  if (typeof syncEditingConfig === 'function') syncEditingConfig();
  // The chart's x-axis grain must not flip when the main strategy resets on save.
  // Capture the EDITED strategy's period now (controls, before the freeze swaps
  // them to canonical); chartPeriod() below picks the finest grain among visible
  // 9sig strategies so the axis stays stable and represents them all.
  const _livePeriod = ((document.getElementById('select-9sig-period') || {}).value) || 'quarterly';
  // …then freeze the base line of the edited type to its canonical defaults so
  // the fixed top pill doesn't track the controls (which now belong to the saved
  // strategy). Restored just before the panel/legends are rebuilt below.
  if (typeof freezeBaseForEditing === 'function') freezeBaseForEditing();
  const initial = sliderToInitial(+document.getElementById('slider-initial').value);
  const monthly = sliderToMonthly(+document.getElementById('slider-monthly').value);
  const annualRaise = +document.getElementById('slider-raise').value / 100;
  // `rate` is the Invested Compounded baseline rate (the slider in that
  // sidebar). 9sig and SMA each have their own parked-cash rate now.
  const rate = sliderToRate(+document.getElementById('slider-rate').value) / 100;
  const nineSigCashRate = (+((document.getElementById('select-9sig-cashrate') || {}).value) || 0) / 100;
  const smaCashRate     = (+((document.getElementById('select-sma-cashrate')  || {}).value) || 0) / 100;
  const logScale = document.getElementById('chart-log-toggle').getAttribute('aria-pressed') === 'true';
  let entryIdx = +document.getElementById('slider-entry').value;
  let exitIdx = +document.getElementById('slider-exit').value;

  // Clamp to valid range — saved values from a prior dataset may be stale.
  const maxIdx = quarterlyData.length - 1;
  if (!Number.isFinite(entryIdx) || entryIdx < 0) entryIdx = 0;
  if (!Number.isFinite(exitIdx)  || exitIdx  < 0) exitIdx  = maxIdx;
  if (entryIdx > maxIdx) entryIdx = maxIdx;
  if (exitIdx  > maxIdx) exitIdx  = maxIdx;

  // Strategy-aware floor: if a limited-history series is visible, bump the
  // entry forward so the chart doesn't show "$0 until first data point" for
  // that line.
  const floorIdx = (typeof effectiveEntryMinQIdx === 'function') ? effectiveEntryMinQIdx() : 0;
  if (entryIdx < floorIdx) entryIdx = floorIdx;

  if (entryIdx >= exitIdx) {
    exitIdx  = Math.min(entryIdx + 1, maxIdx);
    entryIdx = Math.min(entryIdx, exitIdx - 1);
    if (entryIdx < 0) entryIdx = 0;
  }
  document.getElementById('slider-entry').value = entryIdx;
  document.getElementById('slider-exit').value  = exitIdx;
  // "Enter at quarter start" shift: the slider pick maps to a quarter's LAST
  // trading day in quarterlyData; we want deployment to happen at the END of
  // the prior quarter (= effective START of the chosen quarter) so the picked
  // quarter actually runs through the strategy. Applied once here and passed
  // to every sim (main + envelope + SMA) so all return arrays stay aligned to
  // the same x-axis. The unshifted `entryIdx` is kept for the display label.
  const simEntryIdx = entryIdx > 0 ? entryIdx - 1 : entryIdx;
  // Update the dual-range UI in case clamping moved the entry handle.
  if (window._dualRange && typeof window._dualRange.updateUI === 'function') {
    window._dualRange.updateUI();
  }

  document.getElementById('disp-initial').textContent = fmtFull(initial);
  document.getElementById('disp-monthly').textContent = fmtFull(monthly);
  // Annual increase is now a dropdown that shows its own value — no separate display.
  const _dispRaise = document.getElementById('disp-raise');
  if (_dispRaise) { const raiseVal = annualRaise * 100; _dispRaise.textContent = (raiseVal % 1 === 0 ? raiseVal.toFixed(0) : raiseVal.toFixed(1)) + '%'; }
  const rv = (rate * 100);
  // Rate is always 0.5%-snapped (see sliderToRate), so 1 decimal place is enough.
  document.getElementById('disp-rate').textContent = rv.toFixed(1) + '%';
  document.getElementById('disp-entry').textContent = qLabel(quarterlyData[entryIdx][0]);
  document.getElementById('disp-exit').textContent = qLabel(quarterlyData[exitIdx][0]);

  // Per-strategy underlying + 9sig signal-growth from their side-panel selects.
  // SMA has its own selector because its only relationship to the leveraged
  // ETF is "hold it or not".
  // Column index in quarterlyData: 1=TQQQ, 4=QLD, 5=QQQ5, 6=SSO, 7=SPXL.
  const ulSel = (id) => {
    const v = (document.getElementById(id) || {}).value;
    return v === 'qqq5' ? 5 : v === 'qld' ? 4 : v === 'sso' ? 6 : v === 'spxl' ? 7 : 1;
  };
  const sigUlCol = ulSel('select-9sig-underlying');
  const smaUlCol = ulSel('select-sma-underlying');
  const qGrowth  = +((document.getElementById('select-9sig-growth') || {}).value) / 100 || 0.09;
  const crashDropPct  = +((document.getElementById('select-9sig-crashdrop') || {}).value);
  const crashLookbackMonths = +((document.getElementById('select-9sig-crashwin') || {}).value) || 24;
  const spikeTrigPct  = +((document.getElementById('select-9sig-spike')     || {}).value);
  // Two distinct periods, deliberately decoupled for correctness:
  //   • mainPeriod  — the period the MAIN 9sig line is actually SIMULATED at:
  //     its own live period (or canonical quarterly while a saved config is
  //     being edited). This must NOT depend on what else is visible, or the main
  //     line + its metrics would be computed at the wrong rebalance frequency.
  //   • displayGrain — the FINEST rebalance period among the visible 9sig lines.
  //     Used only for the shared x-axis so no visible strategy loses detail; a
  //     coarser line is step-resampled onto it (identity when the grains match).
  const mainPeriod   = window._editingConfigId ? 'quarterly' : _livePeriod;
  const displayGrain = chartDisplayPeriod(_livePeriod);
  const cashPct = (+((document.getElementById('select-9sig-cash') || {}).value) || 0) / 100;
  // Checkbox: ticked → deploy half of each contribution into stock immediately
  // at the month's price, rest waits for rebalance. Off → canonical 9sig.
  const contribDeployPct = ((document.getElementById('select-9sig-deploy') || {}).checked) ? 0.5 : 0;
  const targetFromPrevTarget = !!((document.getElementById('select-9sig-target-compound') || {}).checked);
  const buyThrottlePct = (+((document.getElementById('select-9sig-buypower') || {}).value) || 90);

  const sigOpts = {
    qGrowth,
    underlyingCol: sigUlCol,
    crashDropPct:   Number.isFinite(crashDropPct) ? crashDropPct : 30,
    crashLookbackMonths,
    spikeTriggerPct: Number.isFinite(spikeTrigPct) ? spikeTrigPct : 100,
    rebalancePeriod: mainPeriod,
    cashPct,
    contribDeployPct,
    targetFromPrevTarget,
    buyThrottlePct,
    // A yearly run is coarser than the quarterly x-axis floor → ask the sim for
    // quarter-end value snapshots so the line/hover have quarter resolution.
    sampleQuarterly: mainPeriod === 'yearly',
    // Invested Compounded baseline (computed inside this sim) uses the global
    // rate; the 9sig parked cash uses its own rate (passed as the 3rd arg).
    baselineRate: rate,
  };
  const { log, bhPoints, qqqPoints, spyPoints, qldPoints, qqq5Points, ssoPoints, spxlPoints, totalContributed,
          samplePoints, bhSample, qqqSample, spySample, qldSample, qqq5Sample, ssoSample, spxlSample } = simulate(initial, monthly, nineSigCashRate, simEntryIdx, exitIdx, annualRaise, sigOpts);
  // For each line, the points fed to the chart: the quarter-end snapshots when
  // the run is coarser than the axis (yearly), else the rebalance-grain points.
  const pick = (samp, pts) => (samp && samp.length) ? samp : pts;
  const sigPts = pick(samplePoints, log);
  const bhPtsD = pick(bhSample, bhPoints);
  const qqqPtsD = pick(qqqSample, qqqPoints);
  const spyPtsD = pick(spySample, spyPoints);
  const qldPtsD = pick(qldSample, qldPoints);
  const qqq5PtsD = pick(qqq5Sample, qqq5Points);
  const ssoPtsD = pick(ssoSample, ssoPoints);
  const spxlPtsD = pick(spxlSample, spxlPoints);

  // Shared x-axis. When the display grain matches the main's own period (the
  // common case) the labels ARE the main log's dates and every series maps 1:1
  // (byte-identical to before). When a finer-period strategy is visible, the
  // axis dates come from a dates-only sim at the finer grain and each line is
  // step-resampled onto them — so lines stay aligned without ever changing the
  // period a strategy is computed at.
  const sameGrain = (displayGrain === mainPeriod);
  const labels = sameGrain
    ? log.map(l => l.date)
    : simulate(initial, monthly, nineSigCashRate, simEntryIdx, exitIdx, annualRaise,
        Object.assign({}, sigOpts, { rebalancePeriod: displayGrain, skipBH: true, sampleQuarterly: false })).log.map(l => l.date);
  const onLabels = (arr, valOf) => sameGrain
    ? arr.map(valOf)
    : resampleByDate((arr || []).map(a => ({ date: a.date, value: valOf(a) })), labels);

  // SMA timing strategy: same entry/exit window, same contributions, just
  // a different in/out rule. Independent of 9sig's quarterly rebalance —
  // it lives off the precomputed SMA-at-monthly map keyed by asset+window.
  const smaAsset  = (document.getElementById('select-sma-asset')  || {}).value || 'qqq';
  const smaWindow = +((document.getElementById('select-sma-window') || {}).value) || 200;
  const smaOpts = {
    smaAsset, smaWindow, underlyingCol: smaUlCol,
    entryBufferPct:       +((document.getElementById('select-sma-entry-buf') || {}).value) || 0,
    exitBufferPct:        +((document.getElementById('select-sma-exit-buf')  || {}).value) || 0,
    rsiOverheatThreshold: +((document.getElementById('select-sma-rsi-oh')   || {}).value) || 0,
    rsiCoolThreshold:     +((document.getElementById('select-sma-rsi-cool') || {}).value) || 0,
    outAsset:       ((document.getElementById('select-sma-out-asset') || {}).value) || 'cash',
    dcaInMonths:    +((document.getElementById('select-sma-dca-in')      || {}).value) || 0,
    dcaToOutMonths: +((document.getElementById('select-sma-dca-to-out')  || {}).value) || 0,
    bgDelevPct:     +((document.getElementById('select-sma-bg-delev')    || {}).value) || 0,
    bgGtfoPct:      +((document.getElementById('select-sma-bg-gtfo')     || {}).value) || 0,
  };
  const { smaPoints, smaLog } = simulateSMA(initial, monthly, smaCashRate, simEntryIdx, exitIdx, annualRaise, smaOpts);

  // The base envelope is the MAIN 9sig line's own alternate runs, gated by its own
  // session flag — independent of any saved strategy's envelope. Visibility is
  // further gated on the main line being visible (syncEnvelopeVisibility).
  const showBaseEnvelope = !!window._mainEnvelopeOn;
  // Envelope ghost-line opacity — fixed default after the user-facing slider
  // was removed; 0.12 reads as "clearly visible cluster, doesn't drown out
  // the main strategy line".
  const opacityVal = 0.12;
  // The envelope band belongs to the base 9sig line, so it follows that line's
  // colour (override or default), faded down.
  const _nineSigColor = (window._lineColorOverrides && window._lineColorOverrides['9sig']) || '#22d3ee';
  const envColor = (typeof fadeColor === 'function') ? fadeColor(_nineSigColor, opacityVal) : `rgba(34,211,238,${opacityVal})`;
  // Each ghost line is the same 9sig strategy with rebalance shifted to a
  // different day — must inherit ALL the user's 9sig knobs (signal-line
  // growth %, underlying, 30-down drop, spike trigger), otherwise the
  // ghosts wouldn't track the user's current strategy.
  // Look up (or lazily build) the shifted-data cache for the current
  // rebalance period. The cache is keyed by period; a yearly switch builds
  // a fresh 100-entry cache the first time and reuses it on subsequent
  // renders. envelopeShiftDays must match the period as well.
  if (showBaseEnvelope) {
    ensureEnvelopeCacheForPeriod(mainPeriod);
  }
  // Envelope ghosts are the MAIN line's alternate runs → simulated at mainPeriod,
  // then step-resampled onto the shared x-axis (labels, built below) so they
  // align even when the grain is finer than the main's period.
  const _rawShiftSims = showBaseEnvelope
    ? shiftedQuarterlyCache.map(qData => simulate(initial, monthly, nineSigCashRate, simEntryIdx, exitIdx, annualRaise, {
        qData,
        skipBH: true,
        qGrowth,
        underlyingCol: sigUlCol,
        crashDropPct:   Number.isFinite(crashDropPct) ? crashDropPct : 30,
        crashLookbackMonths,
        spikeTriggerPct: Number.isFinite(spikeTrigPct) ? spikeTrigPct : 100,
        rebalancePeriod: mainPeriod,
        sampleQuarterly: mainPeriod === 'yearly',
        cashPct,
        contribDeployPct,
        targetFromPrevTarget,
        buyThrottlePct,
      }))
    : [];
  const shiftResults = _rawShiftSims.map(s => onLabels(pick(s.samplePoints, s.log), l => l.total));

  if (log.length < 1) {
    if (chart) { chart.destroy(); chart = null; }
    _logData = null;
    if (typeof restoreBaseAfterEditing === 'function') restoreBaseAfterEditing();
    refreshAllLegends();
    return;
  }

  const finalLog = log[log.length - 1];
  const finalBH = bhPoints[bhPoints.length - 1].value;
  const finalQQQ = qqqPoints[qqqPoints.length - 1].value;
  const finalSPY = spyPoints[spyPoints.length - 1].value;
  const finalQLD  = qldPoints  && qldPoints.length  ? qldPoints[qldPoints.length - 1].value   : 0;
  const finalQQQ5 = qqq5Points && qqq5Points.length ? qqq5Points[qqq5Points.length - 1].value : 0;
  const finalSSO  = ssoPoints  && ssoPoints.length  ? ssoPoints[ssoPoints.length - 1].value   : 0;
  const finalSPXL = spxlPoints && spxlPoints.length ? spxlPoints[spxlPoints.length - 1].value : 0;
  const finalSMA  = smaPoints  && smaPoints.length  ? smaPoints[smaPoints.length - 1].value   : 0;
  const years = log.length > 1 ? (new Date(log[log.length-1].date) - new Date(log[0].date)) / (365.25*86400000) : 1;
  // Simple end/start growth — kept for the sub-series fallback (their CAGR is the
  // annualized growth of their own balance, not a contribution-based return).
  const cagr = (end, start) => years > 0 && start > 0 ? (Math.pow(end / start, 1 / years) - 1) * 100 : 0;
  // #2 Money-weighted (IRR) return for the headline strategies: weights each
  // contributed dollar by how long it was invested, instead of pretending the
  // whole `totalContributed` was deposited on day one. Same contribution
  // schedule for every strategy — only the final value differs.
  const _mw = (finalValue) => moneyWeightedCAGR(
    initial, monthly, annualRaise, log[0].date, finalLog.date,
    years, finalValue, (typeof monthlyData !== 'undefined' ? monthlyData : null), totalContributed);
  const ret9 = _mw(finalLog.total);
  const retBH = _mw(finalBH);
  const retQQQ = _mw(finalQQQ);
  const retSPY = _mw(finalSPY);
  const retQLD  = _mw(finalQLD);
  const retQQQ5 = _mw(finalQQQ5);
  const retSSO  = _mw(finalSSO);
  const retSPXL = _mw(finalSPXL);
  const retSMA  = _mw(finalSMA);
  const retInv = _mw(finalLog.investedCompounded);

  // Consolidated Buy & Hold chip (dataset 2) — picks one of the four B&H
  // series based on #select-bh-underlying. We swap the dataset's data + CAGR
  // here so the legend chip and chart line reflect the user's choice without
  // requiring any new dataset indices.
  const bhKey = ((document.getElementById('select-bh-underlying') || {}).value) || 'tqqq';
  // Legend chip / chart line / panel header all read this single label —
  // "Buy & Hold" is intentionally generic (the active underlying is visible
  // via the sidebar selector itself).
  const bhPicked =
    bhKey === 'qqq'  ? { series: qqqPoints,         ret: retQQQ }  :
    bhKey === 'spy'  ? { series: spyPoints,         ret: retSPY }  :
    bhKey === 'qld'  ? { series: qldPoints || [],   ret: retQLD }  :
    bhKey === 'qqq5' ? { series: qqq5Points || [],  ret: retQQQ5 } :
    bhKey === 'sso'  ? { series: ssoPoints || [],   ret: retSSO }  :
    bhKey === 'spxl' ? { series: spxlPoints || [],  ret: retSPXL } :
                       { series: bhPoints,          ret: retBH }   ;

  // Static, plain strategy labels — they don't encode (or change with) the
  // chosen parameters. The active underlying / window / rate are visible via the
  // sidebar selectors instead.
  const LBL_9SIG = '9sig';
  const LBL_SMA  = 'SMA';
  // Buy & Hold spells out the underlying it's actually holding (default TQQQ →
  // "Buy & Hold TQQQ"; follows #select-bh-underlying when switched).
  const LBL_BH   = 'Buy & Hold ' + bhKey.toUpperCase();
  const LBL_INV  = 'Invested Compounded';
  bhPicked.label = LBL_BH;

  // CAGR per dataset index. Dataset 2 reads from whichever B&H series the
  // user selected (consolidated chip — see bhKey / bhPicked above).
  window._cagrByDatasetIdx = {
    0: ret9,
    2: bhPicked.ret,
    7: retInv,
    8: retSMA,
  };

  // Chart. Series come from the display points (quarter snapshots for a yearly
  // run, else rebalance-grain), step-resampled onto the shared x-axis.
  const totalD = onLabels(sigPts, l => l.total);
  const tqqqValD = onLabels(sigPts, l => l.tqqqVal);
  const cashD = onLabels(sigPts, l => l.cash);
  const bhD = onLabels(bhPtsD, b => b.value);
  const qqqD = onLabels(qqqPtsD, q => q.value);
  const spyD = onLabels(spyPtsD, s => s.value);
  const qldD = onLabels(qldPtsD, p => p.value);
  const qqq5D = onLabels(qqq5PtsD, p => p.value);
  const ssoD = onLabels(ssoPtsD, p => p.value);
  const spxlD = onLabels(spxlPtsD, p => p.value);
  // smaPoints are snapshotted at quarter-ends, but the chart x-axis follows
  // the 9sig rebalancePeriod grain (labels). Step-resample onto labels so the
  // SMA line aligns and its endpoint matches the stats/preview, which read
  // smaPoints[last]. For each label date take the latest smaPoint at-or-before
  // it; if labels start before the first smaPoint, hold the first value.
  let _smaJ = 0;
  const smaAligned = labels.map(d => {
    if (!smaPoints || !smaPoints.length) return null;
    while (_smaJ + 1 < smaPoints.length && smaPoints[_smaJ + 1].date <= d) _smaJ++;
    return smaPoints[_smaJ];
  });
  const smaD  = smaAligned.map(p => p ? p.value : null);
  const smaStates = smaAligned.map(p => p ? p.state : null);
  const invD = onLabels(sigPts, l => l.investedCompounded);
  const targetD = onLabels(sigPts, l => l.target);
  // Data fed into the consolidated B&H slot (dataset 2) — display points for the
  // selected underlying (quarter snapshots for a yearly run, else rebalance grain).
  const bhActiveD = onLabels(
    bhKey === 'qqq' ? qqqPtsD : bhKey === 'spy' ? spyPtsD : bhKey === 'qld' ? qldPtsD : bhKey === 'qqq5' ? qqq5PtsD : bhKey === 'sso' ? ssoPtsD : bhKey === 'spxl' ? spxlPtsD : bhPtsD,
    p => p.value);

  // Per-dataset stats shown inside the strategy side panel (CAGR / starting
  // balance / ending balance / max drawdown). Main strategies reuse their
  // money-weighted CAGR (vs total contributed); sub-series fall back to the
  // annualized growth rate of their own balance.
  const seriesByIdx = {
    0: totalD, 1: tqqqValD, 2: bhActiveD,
    5: targetD, 6: cashD, 7: invD, 8: smaD,
  };
  const mainCagrIdx = window._cagrByDatasetIdx;
  // #3 Daily-sampled drawdown: revalue each holding at every daily close
  // (between rebalances shares & cash are constant) so an intra-period crash
  // counts. Reconstruct "control points" per dataset from the sims that produced
  // them. Step series (Target/Cash) and the deterministic Invested baseline
  // keep their rebalance-grain drawdown — they don't move between rebalances.
  const dailyRows = (typeof daily !== 'undefined' && daily) ? daily : null;
  const UL_KEY = { 1: 'tqqq', 2: 'qqq', 3: 'spy', 4: 'qld', 5: 'qqq5', 6: 'sso', 7: 'spxl' };
  const sigKey = UL_KEY[sigUlCol] || 'tqqq';
  const bhKeyName = bhKey === 'qqq' ? 'qqq' : bhKey === 'spy' ? 'spy' : bhKey === 'qld' ? 'qld' : bhKey === 'qqq5' ? 'qqq5' : bhKey === 'sso' ? 'sso' : bhKey === 'spxl' ? 'spxl' : 'tqqq';
  const dailyDDByIdx = {};
  if (dailyRows) {
    const sigCtl = log.map(l => ({ date: l.date, shares: l.price > 0 ? l.tqqqVal / l.price : 0, cash: l.cash }));
    dailyDDByIdx[0] = computeDailyMaxDrawdown(sigCtl, dailyRows, sigKey) * 100;
    dailyDDByIdx[1] = computeDailyMaxDrawdown(
      log.map(l => ({ date: l.date, shares: l.price > 0 ? l.tqqqVal / l.price : 0, cash: 0 })), dailyRows, sigKey) * 100;
    if (bhPicked.series && bhPicked.series.length && bhPicked.series[0].shares != null) {
      dailyDDByIdx[2] = computeDailyMaxDrawdown(
        bhPicked.series.map(pt => ({ date: pt.date, shares: pt.shares, cash: 0 })), dailyRows, bhKeyName) * 100;
    }
    if (smaLog && smaLog.length) {
      dailyDDByIdx[8] = computeDailyMaxDrawdown(
        smaLog.map(r => ({ date: r.date, shares: r.shares, cash: r.cash })), dailyRows, UL_KEY[smaUlCol] || 'qqq') * 100;
    }
  }
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
      maxDD: dailyDDByIdx[i] !== undefined ? dailyDDByIdx[i] : computeMaxDrawdown(series) * 100,
    };
  }
  // Shared context for saved-config lines (saved-configs.js). They reuse the
  // global initial/monthly/date-range; only their own strategy knobs are frozen.
  const cfgCtx = { initial, monthly, annualRaise, simEntryIdx, exitIdx, labels, years, totalContributed };
  if (chart) {
    // Strip saved-config datasets up front so the envelope length math below
    // (which assumes datasets end at the envelope block) stays correct.
    if (typeof removeConfigDatasets === 'function') removeConfigDatasets(chart);
    chart.data.labels = labels;
    // Strategy labels are static plain names (no parameter encoding).
    chart.data.datasets[0].label = LBL_9SIG;
    chart.data.datasets[1].label = '9sig Holding';
    chart.data.datasets[2].label = LBL_BH; // consolidated B&H chip
    chart.data.datasets[5].label = '9sig Target';
    chart.data.datasets[6].label = '9sig Cash';
    chart.data.datasets[7].label = LBL_INV;
    chart.data.datasets[8].label = LBL_SMA;
    chart.data.datasets[0].data = totalD;
    chart.data.datasets[1].data = tqqqValD;
    chart.data.datasets[2].data = bhActiveD;
    // Datasets 3 (B&H QQQ), 4 (B&H SPY), 9 (B&H QQQ5), 10 (B&H QLD) are kept
    // zeroed and hidden — dataset 2 above serves as the consolidated B&H slot now.
    chart.data.datasets[3].data = []; chart.data.datasets[3].hidden = true;
    chart.data.datasets[4].data = []; chart.data.datasets[4].hidden = true;
    chart.data.datasets[5].data = targetD;
    chart.data.datasets[6].data = cashD;
    chart.data.datasets[7].data = invD;
    chart.data.datasets[8].data = smaD;
    chart.data.datasets[8]._smaStates = smaStates;
    chart.data.datasets[9].data = []; chart.data.datasets[9].hidden = true;
    chart.data.datasets[10].data = []; chart.data.datasets[10].hidden = true;
    chart.data.datasets[11].data = []; chart.data.datasets[11].hidden = true;
    chart.data.datasets[12].data = []; chart.data.datasets[12].hidden = true;
    while (chart.data.datasets.length < 13 + envelopeShiftCount) {
      const offset = chart.data.datasets.length - 13;
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
      const ds9 = chart.data.datasets[13 + i];
      ds9.data = showBaseEnvelope ? (shiftResults[i] || []) : [];
      ds9.borderColor = envColor;
      ds9.hidden = !showBaseEnvelope;
    }
    if (typeof appendConfigDatasets === 'function') appendConfigDatasets(chart, cfgCtx);
    if (typeof applyBaseColorOverrides === 'function') applyBaseColorOverrides(chart);
    if (typeof applyNineSigFamily === 'function') applyNineSigFamily(chart);
    syncEnvelopeVisibility();
    chart.options.scales.y.type = logScale ? 'logarithmic' : 'linear';
    chart.options.scales.y.beginAtZero = !logScale;
    // Linear is anchored at 0; the log axis auto-scales (dynamic min). Values below
    // 1 are raised to 1 (clampChartMin) so zeros still plot on log instead of being
    // dropped (log of 0 is undefined) — the dynamic min then includes them.
    chart.options.scales.y.min = logScale ? undefined : 0;
    clampChartMin(chart);
    chart.update('none');
  } else {
  const ctx = document.getElementById('mainChart').getContext('2d');

  // Hue map (indices renumbered after Adaptive removal):
  //   0  9sig          cyan       #22d3ee
  //   1  9sig Holding  sky-blue   #38bdf8
  //   2  B&H TQQQ      red        #f87171
  //   3  B&H QQQ       green      #4ade80
  //   4  B&H SPY       pink       #f472b6
  //   5  9sig Target   orange     #fb923c
  //   6  9sig Cash     amber      #fbbf24
  //   7  Invested Comp gray
  //   8  SMA           chartreuse #a3e635
  //   9  B&H QQQ5      indigo     #6366f1
  //  10  B&H QLD       cyan       #06b6d4
  //  11  B&H SSO       purple     #c084fc
  //  12  B&H SPXL      rose       #f43f5e
  const lineColors = ['#22d3ee', '#38bdf8', '#f87171', '#4ade80', '#f472b6', '#fb923c', '#fbbf24', 'rgba(226,232,240,0.4)', '#a3e635', '#6366f1', '#06b6d4', '#c084fc', '#f43f5e'];
  const lineNames  = [LBL_9SIG, '9sig Holding', LBL_BH, 'B&H QQQ', 'B&H SPY', '9sig Target', '9sig Cash', LBL_INV, LBL_SMA, 'B&H QQQ5', 'B&H QLD', 'B&H SSO', 'B&H SPXL'];
  // Match the borderDash on the corresponding chart dataset; null = solid.
  //   2 B&H TQQQ   [6,3]       medium dash
  //   3 B&H QQQ    [8,4]       long dash
  //   4 B&H SPY    [2,5]       sparse dots
  //   9 B&H QQQ5   [5,2,2,2]   dash-dot
  //  10 B&H QLD    [5,2,2,2]   dash-dot
  //  11 B&H SSO    [5,2,2,2]   dash-dot
  //  12 B&H SPXL   [5,2,2,2]   dash-dot
  const lineDashes = [null, [2,2], [6,3], [8,4], [2,5], [4,4], null, [3,3], null, [5,2,2,2], [5,2,2,2], [5,2,2,2], [5,2,2,2]];

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

    const rgba = (col, a) => {
      if (col.startsWith('rgba')) return col.replace(/,\s*[\d.]+\s*\)$/, `,${a})`);
      const m = col.match(/^#([0-9a-f]{6})$/i);
      if (!m) return col;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    // Iterate every real dataset (skip the envelope `_shift_*` ghosts). Prefer
    // each dataset's live borderColor/borderDash so colour overrides + the
    // shared 9sig-family colour show up here; fall back to the init arrays.
    const colorFor = (i) => (typeof ds[i].borderColor === 'string' ? ds[i].borderColor : null) || lineColors[i] || '#94a3b8';
    const dashFor  = (i) => ds[i].borderDash || lineDashes[i] || null;
    const items = ds
      .map((d, i) => ({ i, n: d.label, v: d.data ? d.data[idx] : null, col: colorFor(i), dash: dashFor(i) }))
      .filter(({ i, v }) => !ds[i]._isShift && c.isDatasetVisible(i) && v != null && !Number.isNaN(v))
      .sort((a, b) => b.v - a.v);
    const maxV = Math.max(0, ...items.map(it => it.v));

    const rows = items.map(({ n, v, col, dash }) => {
      const pct = maxV > 0 ? Math.max(0, (v / maxV) * 100) : 0;
      const dashAttr = dash ? `stroke-dasharray="${dash.join(',')}"` : '';
      const sample = `<svg width="20" height="4" style="flex-shrink:0;overflow:visible">
        <line x1="0" y1="2" x2="20" y2="2" stroke="${col}" stroke-width="2" stroke-linecap="round" ${dashAttr}/>
      </svg>`;
      return `
        <div class="tt-row" style="position:relative">
          <div style="position:absolute;left:0;top:2px;bottom:2px;width:${pct}%;background:${rgba(col, 0.20)};border-radius:3px;pointer-events:none"></div>
          <div class="tt-row-left" style="position:relative;z-index:1">
            ${sample}
            <span class="tt-name">${n}</span>
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
        // Prefer the live dataset label + borderColor so dynamic names
        // ("15sig", "SMA 150"), colour overrides, and the shared 9sig-family
        // colour all show without a chart rebuild. Fall back to the init arrays.
        const color = (typeof ds.borderColor === 'string' ? ds.borderColor : null) || lineColors[i] || '#94a3b8';
        return { y: pt.y, i, color, name: ds.label || lineNames[i], val: ds.data[lastIdx] };
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

  chart = new Chart(ctx, {
    type: 'line',
    plugins: [endLabelPlugin],
    data: {
      labels,
      datasets: [
        {
          label: LBL_9SIG,
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
          label: '9sig Holding',
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
          // Consolidated Buy & Hold slot — label + data swap based on
          // #select-bh-underlying. Default = TQQQ.
          label: bhPicked.label,
          data: bhActiveD,
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
          data: [],
          borderColor: '#4ade80',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [8, 4],
          hidden: true
        },
        {
          label: 'B&H SPY',
          data: [],
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
          label: '9sig Target',
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
          label: LBL_INV,
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
          label: LBL_SMA,
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
          data: [],
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
        {
          label: 'B&H QLD',
          data: [],
          borderColor: '#06b6d4',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [5, 2, 2, 2],
          hidden: true,
        },
        {
          label: 'B&H SSO',
          data: [],
          borderColor: '#c084fc',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [5, 2, 2, 2],
          hidden: true,
        },
        {
          label: 'B&H SPXL',
          data: [],
          borderColor: '#f43f5e',
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
          data: showBaseEnvelope ? (shiftResults[i] || []) : [],
          borderColor: envColor,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 0,
          borderWidth: 1,
          order: -1,
          hidden: !showBaseEnvelope,
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
          min: logScale ? undefined : 0, // linear anchored at 0; log auto-scales
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
  if (typeof appendConfigDatasets === 'function') appendConfigDatasets(chart, cfgCtx);
  if (typeof applyBaseColorOverrides === 'function') applyBaseColorOverrides(chart);
  if (typeof applyNineSigFamily === 'function') applyNineSigFamily(chart);
  syncEnvelopeVisibility();
  clampChartMin(chart);
  chart.update('none');
  } // end else (first render)

  // Stash latest data for the side-panel log tables. Normally this is the
  // canonical base simulation; but when a saved strategy is open for editing the
  // panel describes THAT strategy, so swap in its (separately computed) sim.
  _logData = { log, bhPoints, qqqPoints, spyPoints, qldPoints, qqq5Points, ssoPoints, spxlPoints, smaLog };
  if (window._editingConfigId && window._editingConfigSim) {
    const cs = window._editingConfigSim;
    _logData = {
      log:        cs.log        || log,
      bhPoints:   cs.bhPoints   || bhPoints,
      qqqPoints:  cs.qqqPoints  || qqqPoints,
      spyPoints:  cs.spyPoints  || spyPoints,
      qldPoints:  cs.qldPoints  || qldPoints,
      qqq5Points: cs.qqq5Points || qqq5Points,
      ssoPoints:  cs.ssoPoints  || ssoPoints,
      spxlPoints: cs.spxlPoints || spxlPoints,
      smaLog:     cs.smaLog     || smaLog,
    };
  }

  // Base line is drawn — put the user's in-progress edits back on the controls
  // before the sidebar/legends rebuild from them (so the panel shows the edits,
  // not the canonical values we briefly swapped in for the base simulation).
  if (typeof restoreBaseAfterEditing === 'function') restoreBaseAfterEditing();
  // disp-rate is computed early (during the brief base-sim freeze it can read the
  // canonical rate); re-sync it to the slider's restored value so the Invested
  // panel's % label always matches its slider — even while editing that config.
  const _drEl = document.getElementById('disp-rate');
  if (_drEl) { const _rr = sliderToRate(+document.getElementById('slider-rate').value); _drEl.textContent = _rr.toFixed(1) + '%'; }

  // Compact legend chips (eye + name + CAGR) above the chart. Also re-renders
  // the open side panel if any (so its log table stays in sync with sliders).
  refreshAllLegends();

  if (typeof refreshAnalytics === 'function') refreshAnalytics();
}
