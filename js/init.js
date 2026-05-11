// Initialize: load CSV, derive data, set slider max, restore state, render
(async function init() {
  let QQQ_DAILY, TQQQ_DAILY, SPY_DAILY;
  try {
    [QQQ_DAILY, TQQQ_DAILY, SPY_DAILY] = await Promise.all([loadQQQDaily(), loadTQQQDaily(), loadSPYDaily()]);
  } catch(e) {
    console.error('Failed to load data:', e);
    return;
  }
  daily = buildDaily(QQQ_DAILY, TQQQ_DAILY, SPY_DAILY);
  quarterlyData = lastOfPeriod(daily, getQuarter).map(d => [d.date, d.tqqq, d.qqq, d.spy]);
  monthlyData = lastOfPeriod(daily, getMonth).map(d => [d.date, d.tqqq, d.qqq, d.spy]);
  dailyDateToIdx = new Map(daily.map((d, i) => [d.date, i]));
  // Pre-index monthly entries per quarter so simulate()'s hot inner loops
  // become O(2-3) lookups instead of O(monthlyData.length) scans.
  precomputeMonthlyByQuarter();
  envelopeShiftDays  = buildEnvelopeShifts();
  envelopeShiftCount = envelopeShiftDays.length;
  shiftedQuarterlyCache = envelopeShiftDays.map(getShiftedQuarterly);
  document.getElementById('envelope-note').textContent =
    `Each ghost line is the same 9sig strategy with rebalance shifted to a different day — ${ENVELOPE_DAYS_PER_QUARTER} within-quarter shifts plus ${ENVELOPE_QUARTER_OFFSETS} quarter-spaced offsets.`;
  const maxQIdx = quarterlyData.length - 1;
  document.getElementById('slider-exit').value = maxQIdx;
  document.getElementById('slider-entry').value = Math.max(0, maxQIdx - 60); // default span = past 15y (60 quarters)
  window._dualRange.setMax(maxQIdx);

  // Populate adaptive-strategy dropdowns. 1.0× to 5.0× in 0.1 steps for the
  // multipliers; 1–30 years for the lookback window.
  const selAbove  = document.getElementById('select-tqqq-above');
  const selBelow  = document.getElementById('select-tqqq-below');
  const selWindow = document.getElementById('select-tqqq-window');
  for (let v = 1; v <= 50; v++) {
    const x = (v / 10).toFixed(1);
    selAbove.insertAdjacentHTML('beforeend', `<option value="${x}">${x}</option>`);
    selBelow.insertAdjacentHTML('beforeend', `<option value="${x}">${x}</option>`);
  }
  selAbove.value = '1.5';
  selBelow.value = '1.0';
  for (let y = 1; y <= 30; y++) {
    selWindow.insertAdjacentHTML('beforeend', `<option value="${y}">${y}</option>`);
  }
  selWindow.value = '6';
  // Restore saved state: URL params > localStorage > defaults
  const params = new URLSearchParams(window.location.search);
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

  // Adaptive strategy params
  if (params.get('tu') !== null) { document.getElementById('select-tqqq-above').value = params.get('tu'); hasUrlParams = true; }
  if (params.get('td') !== null) { document.getElementById('select-tqqq-below').value = params.get('td'); hasUrlParams = true; }
  if (params.get('tw') !== null) { document.getElementById('select-tqqq-window').value = params.get('tw'); hasUrlParams = true; }
  // Toggles + envelope opacity
  if (params.get('l')  !== null) { setLogScale(params.get('l') === '1'); hasUrlParams = true; }
  if (params.get('ev') !== null) { document.getElementById('toggle-envelope').checked    = params.get('ev') === '1'; hasUrlParams = true; }
  if (params.get('eo') !== null) { document.getElementById('slider-envelope-opacity').value = params.get('eo'); hasUrlParams = true; }
  // Section open/closed
  if (params.get('vo') === '1') {
    document.getElementById('advanced-section').classList.add('open');
    document.getElementById('advanced-toggle').textContent = '− advanced';
  }
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

  if (!hasUrlParams) {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY));
      if (saved) {
        SLIDER_IDS.forEach(id => {
          if (saved[id] == null) return;
          // localStorage `slider-rate` is the rate %, not the slider position.
          const v = (id === 'slider-rate') ? rateToSlider(+saved[id]) : saved[id];
          document.getElementById(id).value = v;
        });
        if (saved['toggle-envelope'] != null) document.getElementById('toggle-envelope').checked = !!saved['toggle-envelope'];
        if (saved['toggle-log-scale'] != null) setLogScale(!!saved['toggle-log-scale']);
        const advancedSaved = saved['advanced-open'];
        const wantOpen = advancedSaved === true
          || (advancedSaved == null && (
                +saved['slider-raise'] > 0
                || (saved['slider-rate'] != null && +saved['slider-rate'] !== 4)
              ));
        if (wantOpen) {
          document.getElementById('advanced-section').classList.add('open');
          document.getElementById('advanced-toggle').textContent = '− advanced';
        }
      }
    } catch(e) {}
  }
  document.getElementById('disp-envelope-opacity').textContent =
    'opacity ' + (+document.getElementById('slider-envelope-opacity').value / 100).toFixed(2);
  window._dualRange.updateUI();
  render();

  // Apply post-render shared state: dataset visibility + analytics modal.
  // Precedence: URL `hd` > localStorage `hidden-datasets` > chart defaults.
  // We override the chart's per-dataset `hidden: true` defaults explicitly
  // so a saved "show TQQQ Holding" state survives a refresh.
  const applyHiddenList = (hiddenList) => {
    if (!chart || !Array.isArray(hiddenList)) return;
    const hiddenSet = new Set(hiddenList.map(Number).filter(Number.isFinite));
    chart.data.datasets.forEach((ds, i) => {
      if (ds._isShift) return;
      chart.setDatasetVisibility(i, !hiddenSet.has(i));
    });
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
    // Sync the strategy pill UI to the URL-restored strategy before opening
    document.querySelectorAll('#analytics-strategy-options button').forEach(b => {
      b.classList.toggle('active', b.dataset.strat === analyticsStrategy);
    });
    const baselineSelect = document.getElementById('analytics-baseline');
    if (baselineSelect) baselineSelect.value = analyticsBaseline;
    // The dropdown's change handler is what normally toggles the custom-input
    // fields — but setting `.value` programmatically doesn't fire change.
    // Mirror its visibility manually here when restoring from a URL.
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
})();
