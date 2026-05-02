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
  envelopeShiftCount = computeMaxShift();
  shiftedQuarterlyCache = [];
  for (let s = 1; s <= envelopeShiftCount; s++) {
    shiftedQuarterlyCache.push(getShiftedQuarterly(s));
  }
  document.getElementById('envelope-note').textContent =
    `Each ghost line is the same 9sig run with rebalance shifted N trading days earlier (1–${envelopeShiftCount}).`;
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
  selBelow.value = '1.2';
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
    if (val !== null) { document.getElementById(sliderId).value = val; hasUrlParams = true; }
  }

  // Adaptive strategy params
  if (params.get('tu') !== null) { document.getElementById('select-tqqq-above').value = params.get('tu'); hasUrlParams = true; }
  if (params.get('td') !== null) { document.getElementById('select-tqqq-below').value = params.get('td'); hasUrlParams = true; }
  if (params.get('tw') !== null) { document.getElementById('select-tqqq-window').value = params.get('tw'); hasUrlParams = true; }
  // Toggles + envelope opacity
  if (params.get('l')  !== null) { document.getElementById('toggle-log-scale').checked   = params.get('l')  === '1'; hasUrlParams = true; }
  if (params.get('ev') !== null) { document.getElementById('toggle-envelope').checked    = params.get('ev') === '1'; hasUrlParams = true; }
  if (params.get('bv') !== null) { document.getElementById('toggle-bh-envelope').checked = params.get('bv') === '1'; hasUrlParams = true; }
  if (params.get('eo') !== null) { document.getElementById('slider-envelope-opacity').value = params.get('eo'); hasUrlParams = true; }
  // Section open/closed
  if (params.get('vo') === '1') {
    document.getElementById('advanced-section').classList.add('open');
    document.getElementById('advanced-toggle').textContent = '− advanced';
  }
  if (params.get('ao') === '1') {
    document.getElementById('adaptive-section').classList.add('open');
    document.getElementById('adaptive-toggle').textContent = '− adaptive strategy';
  }
  // Analytics modal pre-state (modal is opened after render() so the chart exists)
  if (params.get('as')) analyticsStrategy = params.get('as');
  if (params.get('ab')) analyticsBaseline = params.get('ab');

  if (!hasUrlParams) {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY));
      if (saved) {
        SLIDER_IDS.forEach(id => { if (saved[id] != null) document.getElementById(id).value = saved[id]; });
        if (saved['toggle-envelope'] != null) document.getElementById('toggle-envelope').checked = !!saved['toggle-envelope'];
        if (saved['toggle-bh-envelope'] != null) document.getElementById('toggle-bh-envelope').checked = !!saved['toggle-bh-envelope'];
        if (saved['toggle-log-scale'] != null) document.getElementById('toggle-log-scale').checked = !!saved['toggle-log-scale'];
        const advancedSaved = saved['advanced-open'];
        const wantOpen = advancedSaved === true
          || (advancedSaved == null && (
                saved['toggle-envelope'] === true
                || saved['toggle-bh-envelope'] === true
                || +saved['slider-raise'] > 0
                || (saved['slider-rate'] != null && +saved['slider-rate'] !== 4)
              ));
        if (wantOpen) {
          document.getElementById('advanced-section').classList.add('open');
          document.getElementById('advanced-toggle').textContent = '− advanced';
        }
        if (saved['adaptive-open'] === true) {
          document.getElementById('adaptive-section').classList.add('open');
          document.getElementById('adaptive-toggle').textContent = '− adaptive strategy';
        }
      }
    } catch(e) {}
  }
  document.getElementById('disp-envelope-opacity').textContent =
    'opacity ' + (+document.getElementById('slider-envelope-opacity').value / 100).toFixed(2);
  window._dualRange.updateUI();
  syncLogPill();
  render();

  // Apply post-render shared state: dataset visibility + analytics modal.
  const hd = params.get('hd');
  if (hd && chart) {
    hd.split(',').map(Number).forEach(i => {
      if (Number.isFinite(i)) chart.setDatasetVisibility(i, false);
    });
    chart.update();
  }
  if (params.get('am') === '1') {
    // Sync the strategy pill UI to the URL-restored strategy before opening
    document.querySelectorAll('#analytics-strategy-options button').forEach(b => {
      b.classList.toggle('active', b.dataset.strat === analyticsStrategy);
    });
    const baselineSelect = document.getElementById('analytics-baseline');
    if (baselineSelect) baselineSelect.value = analyticsBaseline;
    toggleAnalytics();
  }
})();
