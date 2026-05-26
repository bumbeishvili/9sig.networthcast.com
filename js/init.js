// Initialize: load CSV, derive data, set slider max, restore state, render
(async function init() {
  let QQQ_DAILY, TQQQ_DAILY, SPY_DAILY, QQQ5_DAILY;
  try {
    [QQQ_DAILY, TQQQ_DAILY, SPY_DAILY, QQQ5_DAILY] = await Promise.all([
      loadQQQDaily(), loadTQQQDaily(), loadSPYDaily(), loadQQQ5Daily(),
    ]);
  } catch(e) {
    console.error('Failed to load data:', e);
    return;
  }
  daily = buildDaily(QQQ_DAILY, TQQQ_DAILY, SPY_DAILY, QQQ5_DAILY);
  quarterlyData = lastOfPeriod(daily, getQuarter).map(d => [d.date, d.tqqq, d.qqq, d.spy, d._unused, d.qqq5]);
  monthlyData = lastOfPeriod(daily, getMonth).map(d => [d.date, d.tqqq, d.qqq, d.spy, d._unused, d.qqq5]);
  dailyDateToIdx = new Map(daily.map((d, i) => [d.date, i]));
  // Pre-index monthly entries per quarter so simulate()'s hot inner loops
  // become O(2-3) lookups instead of O(monthlyData.length) scans.
  precomputePeriodSeries();
  precomputeMonthlyByQuarter();
  precomputeSMASeries();
  recomputeEarliestQIdx();
  // Build the quarterly envelope cache up front (default). Switching the
  // rebalance period in the UI lazy-builds the cache for that period.
  ensureEnvelopeCacheForPeriod('quarterly');
  envelopeShiftCount = envelopeShiftDays.length;
  shiftedQuarterlyCache = envelopeShiftDays.map(getShiftedQuarterly);
  document.getElementById('envelope-note').textContent =
    `Each ghost line is the same 9sig strategy with rebalance shifted by 1..${ENVELOPE_DAYS_PER_QUARTER} trading days within the quarter — pure rebalance-day sensitivity, same entry/exit dates.`;
  const maxQIdx = quarterlyData.length - 1;
  document.getElementById('slider-exit').value = maxQIdx;
  document.getElementById('slider-entry').value = Math.max(0, maxQIdx - 60); // default span = past 15y (60 quarters)
  window._dualRange.setMax(maxQIdx);

  // Restore saved state: URL params > localStorage > defaults
  const params = new URLSearchParams(window.location.search);
  // A shared link carries the app version it was made with (`v`). Upgrade its
  // params to the current scheme before reading anything, so old links keep
  // resolving correctly. `isSharedLink` (any `v` present) also tells us this
  // is someone else's config — we suppress the "reset saved data" prompt so
  // the recipient can't accidentally wipe + reload away the shared params.
  const isSharedLink = params.get('v') !== null;
  if (typeof migrateSharedLink === 'function') migrateSharedLink(params);
  const urlMap = { i: 'slider-initial', m: 'slider-monthly', a: 'slider-raise', r: 'slider-rate', e: 'slider-entry', x: 'slider-exit' };
  let hasUrlParams = false;
  for (const [key, sliderId] of Object.entries(urlMap)) {
    const val = params.get(key);
    if (val !== null) {
      // URL `r` is always the rate %, regardless of slider-curve format.
      const sliderVal = (sliderId === 'slider-rate') ? rateToSlider(+val) : val;
      document.getElementById(sliderId).value = sliderVal;
      hasUrlParams = true;
    }
  }

  // Buy & Hold underlying
  if (params.get('bu') !== null) { document.getElementById('select-bh-underlying').value = params.get('bu'); hasUrlParams = true; }
  // SMA strategy params
  if (params.get('sa')  !== null) { document.getElementById('select-sma-asset').value       = params.get('sa');  hasUrlParams = true; }
  if (params.get('sw')  !== null) { document.getElementById('select-sma-window').value      = params.get('sw');  hasUrlParams = true; }
  if (params.get('su')  !== null) { document.getElementById('select-sma-underlying').value  = params.get('su');  hasUrlParams = true; }
  if (params.get('seb') !== null) { document.getElementById('select-sma-entry-buf').value   = params.get('seb'); hasUrlParams = true; }
  if (params.get('sxb') !== null) { document.getElementById('select-sma-exit-buf').value    = params.get('sxb'); hasUrlParams = true; }
  if (params.get('sro') !== null) { document.getElementById('select-sma-rsi-oh').value      = params.get('sro'); hasUrlParams = true; }
  if (params.get('src') !== null) { document.getElementById('select-sma-rsi-cool').value    = params.get('src'); hasUrlParams = true; }
  if (params.get('scr') !== null) { document.getElementById('select-sma-cashrate').value    = params.get('scr'); hasUrlParams = true; }
  if (params.get('soa') !== null) { document.getElementById('select-sma-out-asset').value   = params.get('soa'); hasUrlParams = true; }
  if (params.get('sdi') !== null) { document.getElementById('select-sma-dca-in').value      = params.get('sdi'); hasUrlParams = true; }
  if (params.get('sdo') !== null) { document.getElementById('select-sma-dca-to-out').value  = params.get('sdo'); hasUrlParams = true; }
  if (params.get('sbd') !== null) { document.getElementById('select-sma-bg-delev').value    = params.get('sbd'); hasUrlParams = true; }
  if (params.get('sbg') !== null) { document.getElementById('select-sma-bg-gtfo').value     = params.get('sbg'); hasUrlParams = true; }
  // 9sig underlying + signal-line growth
  if (params.get('nu') !== null) { document.getElementById('select-9sig-underlying').value = params.get('nu'); hasUrlParams = true; }
  if (params.get('ng') !== null) { document.getElementById('select-9sig-growth').value     = params.get('ng'); hasUrlParams = true; }
  if (params.get('nc') !== null) { document.getElementById('select-9sig-crashdrop').value  = params.get('nc'); hasUrlParams = true; }
  if (params.get('ncw') !== null){ document.getElementById('select-9sig-crashwin').value   = params.get('ncw'); hasUrlParams = true; }
  if (params.get('ns') !== null) { document.getElementById('select-9sig-spike').value      = params.get('ns'); hasUrlParams = true; }
  if (params.get('np') !== null) { document.getElementById('select-9sig-period').value     = params.get('np'); hasUrlParams = true; }
  if (params.get('nh') !== null) { document.getElementById('select-9sig-cash').value       = params.get('nh'); hasUrlParams = true; }
  if (params.get('nr') !== null) { document.getElementById('select-9sig-cashrate').value   = params.get('nr'); hasUrlParams = true; }
  if (params.get('nbp') !== null){ document.getElementById('select-9sig-buypower').value    = params.get('nbp'); hasUrlParams = true; }
  if (params.get('nd') !== null) { document.getElementById('select-9sig-deploy').checked   = params.get('nd') === '1'; hasUrlParams = true; }
  if (params.get('tc') !== null) { document.getElementById('select-9sig-target-compound').checked = params.get('tc') === '1'; hasUrlParams = true; }
  // Toggles
  if (params.get('l')  !== null) { setLogScale(params.get('l') === '1'); hasUrlParams = true; }
  if (params.get('ev') !== null) { document.getElementById('toggle-envelope').checked    = params.get('ev') === '1'; hasUrlParams = true; }
  // Analytics modal pre-state (modal is opened after render() so the chart exists)
  if (params.get('as')) analyticsStrategy = params.get('as');
  if (params.get('ab')) analyticsBaseline = params.get('ab');
  if (params.get('act')) {
    const v = parseAmount(params.get('act'));
    if (Number.isFinite(v) && v > 0) analyticsCustomTarget = v;
  }
  if (params.get('acp')) {
    const v = parseFloat(params.get('acp'));
    if (Number.isFinite(v)) analyticsCustomGrowthPct = v;
  }

  // Skip the localStorage restore when there's an APP_VERSION mismatch — old
  // state can reference controls/values that no longer exist and poison the
  // UI. The "new version — reset saved data" button (shown below) lets the
  // user wipe + reload to commit the new defaults.
  const skipLS = (typeof _storageVersionMismatch !== 'undefined') && _storageVersionMismatch;
  if (!hasUrlParams && !skipLS) {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY));
      if (saved) {
        SLIDER_IDS.forEach(id => {
          if (saved[id] == null) return;
          // Top pills are canonical — never restore their per-strategy knobs
          // from localStorage (only global investment inputs + date range).
          if (typeof _isStrategyParamId === 'function' && _isStrategyParamId(id)) return;
          const el = document.getElementById(id);
          if (el.type === 'checkbox') {
            el.checked = saved[id] === '1' || saved[id] === true;
            return;
          }
          // localStorage `slider-rate` is the rate %, not the slider position.
          const v = (id === 'slider-rate') ? rateToSlider(+saved[id]) : saved[id];
          el.value = v;
        });
        // 'toggle-envelope' deliberately not restored — alternate runs reset
        // to off on refresh (canonical 9sig view).
        if (saved['toggle-log-scale'] != null) setLogScale(!!saved['toggle-log-scale']);
      }
    } catch(e) {}
  }
  window._dualRange.updateUI();
  // Apply the restored 9sig growth-% to the static "9sig" labels in the
  // analytics modal before first render (e.g. URL ?ng=15 → "15sig").
  if (typeof refresh9sigDisplayLabels === 'function') refresh9sigDisplayLabels();
  if (typeof update9sigCashSpans      === 'function') update9sigCashSpans();
  if (typeof updateDeployAvailability === 'function') updateDeployAvailability();
  // Don't offer the localStorage "reset saved data" prompt when viewing a
  // shared link — clicking it would reload to a clean URL and lose the link.
  if (!isSharedLink && typeof showResetVersionButtonIfNeeded === 'function') showResetVersionButtonIfNeeded();
  // Restore set select values directly (no 'change' dispatch) — refresh the
  // preview-dropdown trigger labels so they show the restored values.
  if (typeof window.refreshPreviewTriggers === 'function') window.refreshPreviewTriggers();
  // Saved strategies carried in a share link (`sc`) — merged in; custom ones
  // are flagged untrusted (their code won't run until the user clicks Run).
  const sc = params.get('sc');
  if (sc && typeof importSharedConfigs === 'function') {
    try { importSharedConfigs(JSON.parse(decodeURIComponent(sc))); } catch (e) {}
  }
  render();

  // Apply post-render shared state: dataset visibility + analytics modal.
  // Precedence: URL `hd` > localStorage `hidden-datasets` > chart defaults.
  // We override the chart's per-dataset `hidden: true` defaults explicitly
  // so a saved "show TQQQ Holding" state survives a refresh.
  const applyHiddenList = (hiddenList) => {
    if (!chart || !Array.isArray(hiddenList)) return;
    const hiddenSet = new Set(hiddenList.map(Number).filter(Number.isFinite));
    chart.data.datasets.forEach((ds, i) => {
      if (ds._isShift || ds._configLine) return; // saved-config visibility comes from config.hidden
      chart.setDatasetVisibility(i, !hiddenSet.has(i));
    });
    // The base envelope band follows the (now-restored) base 9sig visibility.
    if (typeof syncEnvelopeVisibility === 'function') syncEnvelopeVisibility();
    chart.update();
    if (typeof refreshAllLegends === 'function') refreshAllLegends();
  };
  const hd = params.get('hd');
  // `hd=` (empty) is a deliberate "nothing hidden" — distinct from no
  // param at all, which means "fall back to localStorage / defaults".
  if (hd !== null && chart) {
    applyHiddenList(hd === '' ? [] : hd.split(','));
  } else if (chart) {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY));
      if (saved && Array.isArray(saved['hidden-datasets'])) {
        applyHiddenList(saved['hidden-datasets']);
      }
    } catch(e) {}
  }
  if (params.get('am') === '1') {
    // toggleAnalytics() below repopulates both sentence dropdowns from the
    // URL-restored analyticsStrategy / analyticsBaseline, so we only need to
    // mirror the Custom Target / Growth input visibility (refresh doesn't fire
    // the baseline change handler that normally does).
    const customInput = document.getElementById('analytics-baseline-custom-input');
    const pctInput    = document.getElementById('analytics-baseline-pct-input');
    if (customInput) customInput.setAttribute('hidden', '');
    if (pctInput)    pctInput.setAttribute('hidden', '');
    if (analyticsBaseline === 'custom' && customInput) {
      customInput.removeAttribute('hidden');
      customInput.value = fmtFull(analyticsCustomTarget);
    } else if (analyticsBaseline === 'custom-pct' && pctInput) {
      pctInput.removeAttribute('hidden');
      pctInput.value = String(analyticsCustomGrowthPct);
      const pctDisplay = document.getElementById('analytics-baseline-pct-display');
      if (pctDisplay) {
        pctDisplay.removeAttribute('hidden');
        pctDisplay.textContent = (analyticsCustomGrowthPct >= 0 ? '+' : '') + analyticsCustomGrowthPct + '%';
      }
    }
    toggleAnalytics();
  }

  // Reopen the strategy sidebar that was open when the link was shared.
  const sp = params.get('sp');
  if (sp && typeof openPanelByKey === 'function') openPanelByKey(sp);
})();
