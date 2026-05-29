/*
 * End-to-end UI suite for the Strategies Simulator (Playwright + Chromium).
 *
 * The user-facing interaction space is small ("up to ~6 actions"), so this suite
 * drives the REAL UI through every flow we care about and asserts on the real
 * Chart.js datasets / saved-config state. Run it after any change.
 *
 *   1. start a static server in the repo root:   python3 -m http.server 8753
 *   2. node tests/suite.cjs                       (BASE=http://host:port to override)
 *
 * Uses the globally-installed playwright (npm i -g playwright).
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  const path = require('path');
  const root = require('child_process').execSync('npm root -g').toString().trim();
  ({ chromium } = require(path.join(root, 'playwright')));
}

const BASE = process.env.BASE || 'http://localhost:8753';
const results = [];
let pass = true;
const ck = (name, cond, extra) => {
  if (!cond) { pass = false; results.push('  FAIL  ' + name + (extra ? '   ' + extra : '')); }
  else results.push('  ok    ' + name);
};
const section = (t) => results.push('\n— ' + t + ' —');

// ---- helpers ------------------------------------------------------------
const setSel = async (page, id, v) => {
  await page.click(`.pdrop:has(#${id}) .pdrop-trigger`);
  await page.waitForSelector(`.pdrop-popup .pdrop-row[data-value="${v}"]`);
  await page.click(`.pdrop-popup .pdrop-row[data-value="${v}"]`);
  await page.waitForTimeout(150);
};
const fresh = async (page) => {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chart-legend .legend-chip', { timeout: 15000 });
  await page.waitForTimeout(250);
};
const openMain = async (page) => {
  await page.click('.legend-chip[data-idx="0"] .legend-more');
  await page.waitForSelector('#strategy-panel.is-open');
  await page.waitForTimeout(150);
};
const closePanel = async (page) => { await page.click('.strategy-panel-close').catch(() => {}); await page.waitForTimeout(150); };
const mainLast = (page) => page.evaluate(() => {
  const c = window.Chart.getChart(document.getElementById('mainChart'));
  const a = c.data.datasets[0].data;
  for (let i = a.length - 1; i >= 0; i--) if (typeof a[i] === 'number') return Math.round(a[i]);
  return null;
});
const labelsLen = (page) => page.evaluate(() => window.Chart.getChart(document.getElementById('mainChart')).data.labels.length);
const ghosts = (page) => page.evaluate(() => {
  const c = window.Chart.getChart(document.getElementById('mainChart'));
  const vis = c.data.datasets.map((d, i) => ({ d, i })).filter(o => o.d._isShift && c.isDatasetVisible(o.i));
  return { base: vis.filter(o => !o.d._configId).length, cfgIds: [...new Set(vis.filter(o => o.d._configId).map(o => o.d._configId))] };
});
const lengthIntegrity = (page) => page.evaluate(() => {
  const c = window.Chart.getChart(document.getElementById('mainChart'));
  const L = c.data.labels.length;
  return c.data.datasets.map((d, i) => ({ i, vis: c.isDatasetVisible(i), dl: (d.data || []).length, ml: (c.getDatasetMeta(i).data || []).length }))
    .filter(r => r.vis && (r.dl !== L || r.ml !== L));
});

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1500, height: 950 });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  // ===== 1. naming + base edit + save flow =====
  section('save / edit a 9sig strategy');
  await fresh(page);
  const names = await page.evaluate(() => [...document.querySelectorAll('#chart-legend .legend-name')].map(n => n.textContent));
  ck('legend names are static', JSON.stringify(names) === JSON.stringify(['9sig', 'SMA', 'Buy & Hold TQQQ', 'Invested Compounded']), JSON.stringify(names));
  await openMain(page);
  const def = await mainLast(page);
  await setSel(page, 'select-9sig-growth', '20');
  const edited = await mainLast(page);
  ck('editing the main line reacts live', edited !== def, `def=${def} edited=${edited}`);
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  const s = await page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById('mainChart'));
    const saved = c.data.datasets.find(d => d._configLine && !d._isShift);
    const last = a => { for (let i = a.length - 1; i >= 0; i--) if (typeof a[i] === 'number') return Math.round(a[i]); };
    return { pills: document.querySelectorAll('.saved-config-pill').length, editingId: window._editingConfigId, cfgId: getSavedConfigs()[0] && getSavedConfigs()[0].id,
      noBtn: !document.querySelector('[data-sc-savenew]'), mainHidden: !c.isDatasetVisible(0),
      sColor: saved && saved.borderColor, mColor: c.data.datasets[0].borderColor, sLast: last(saved.data), name: getSavedConfigs()[0] && getSavedConfigs()[0].name };
  });
  ck('save creates exactly one strategy', s.pills === 1, 'pills=' + s.pills);
  ck('after save we edit the copy', s.editingId === s.cfgId);
  ck('saved strategy has no "Save as" button (no fork)', s.noBtn);
  ck('main strategy line hidden after save', s.mainHidden);
  ck('copy inherits the main color', s.sColor === s.mColor, `${s.sColor} vs ${s.mColor}`);
  ck('copy keeps the edit', s.sLast === edited, `saved=${s.sLast} edited=${edited}`);
  ck('plain type-label name "9sig"', s.name === '9sig', s.name);

  // ===== 2. color picker: swatch applies + closes =====
  section('color picker');
  await page.click('#line-color-trigger'); await page.waitForTimeout(120);
  await page.click('#line-color-pop .lc-swatch[data-color="#ff0000"]'); await page.waitForTimeout(200);
  const col = await page.evaluate(() => ({ popHidden: (document.getElementById('line-color-pop') || {}).hidden !== false, cfg: getSavedConfigs()[0] && getSavedConfigs()[0].color }));
  ck('swatch click applies the color', col.cfg === '#ff0000', JSON.stringify(col));
  ck('swatch click closes the popup', col.popHidden === true);

  // ===== 3. editing the copy auto-saves (no fork) =====
  section('edit a saved strategy in place');
  await setSel(page, 'select-9sig-growth', '25');
  const e2 = await page.evaluate(() => ({ pills: document.querySelectorAll('.saved-config-pill').length, g: getSavedConfigs()[0] && getSavedConfigs()[0].params['select-9sig-growth'] }));
  ck('editing the copy modifies itself (no new strategy)', e2.pills === 1 && e2.g === '25', JSON.stringify(e2));

  // ===== 4. re-open main resets to default =====
  section('main strategy resets to default');
  await closePanel(page);
  await openMain(page);
  ck('re-open main → growth control back to 9', (await page.evaluate(() => document.getElementById('select-9sig-growth').value)) === '9');
  ck('re-open main line back to default value', (await mainLast(page)) === def, `got=${await mainLast(page)} def=${def}`);

  // ===== 5. manual rename =====
  section('manual rename');
  await closePanel(page);
  await page.click('.saved-config-pill .sc-edit'); await page.waitForTimeout(200);
  await page.evaluate(() => { const t = document.getElementById('strategy-panel-title'); t.focus(); t.textContent = 'My Strategy'; t.blur(); });
  await page.waitForTimeout(200);
  ck('rename sticks', (await page.evaluate(() => getSavedConfigs()[0] && getSavedConfigs()[0].name)) === 'My Strategy');

  // ===== 6. other types + multi + delete + persistence =====
  section('SMA save / multi / delete / persistence');
  await fresh(page);
  await page.click('.legend-chip[data-idx="8"] .legend-more'); await page.waitForSelector('#strategy-panel.is-open'); await page.waitForTimeout(150);
  await page.click('[data-sc-savenew="sma"]'); await page.waitForTimeout(250);
  const sma = await page.evaluate(() => { const c = getSavedConfigs()[0]; return { name: c && c.name, color: c && c.color, type: c && c.type }; });
  ck('SMA save → name "SMA", chartreuse color, type sma', sma.name === 'SMA' && sma.color === '#a3e635' && sma.type === 'sma', JSON.stringify(sma));
  await closePanel(page);
  await openMain(page);
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  ck('two strategies coexist', (await page.evaluate(() => getSavedConfigs().length)) === 2);
  await closePanel(page);
  await page.click('.saved-config-pill .sc-delete'); await page.waitForTimeout(150);
  await page.click('[data-sc-confirm]'); await page.waitForTimeout(200);
  ck('delete removes one', (await page.evaluate(() => getSavedConfigs().length)) === 1);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#chart-legend .legend-chip'); await page.waitForTimeout(300);
  ck('saved strategies persist across reload', (await page.evaluate(() => getSavedConfigs().length)) === 1);

  // ===== 7. rebalance-period axis stability + toggle integrity =====
  section('period axis stability + no toggle loop');
  await fresh(page);
  await openMain(page);
  await setSel(page, 'select-9sig-period', 'yearly');
  // A yearly strategy now renders at the QUARTERLY floor (62 quarterly points),
  // so you can hover and read each quarter's value — it's no longer 17 yearly points.
  ck('draft yearly renders at quarterly floor → 62 labels', (await labelsLen(page)) === 62, 'labels=' + await labelsLen(page));
  // Prove the quarter points are REAL sampled values (price moves each quarter),
  // not a yearly value stepped across 4 quarters. Distinct values should far
  // exceed the ~15 years (a stepped line would have ≈ one value per year).
  const yDistinct = await page.evaluate(() => {
    const d = window.Chart.getChart(document.getElementById('mainChart')).data.datasets[0].data.filter(v => typeof v === 'number');
    return { n: d.length, distinct: new Set(d.map(v => Math.round(v))).size };
  });
  ck('yearly line shows real per-quarter values (not stepped per year)', yDistinct.distinct > 30, JSON.stringify(yDistinct));
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  ck('save keeps 62 labels (no flip)', (await labelsLen(page)) === 62);
  await closePanel(page);
  ck('close keeps 62 labels (no flip)', (await labelsLen(page)) === 62);
  await page.click('.legend-chip[data-idx="0"]'); await page.waitForTimeout(250);
  ck('activate main keeps 62 labels', (await labelsLen(page)) === 62);
  await page.click('.legend-chip[data-idx="0"]'); await page.waitForTimeout(250);
  ck('deactivate main keeps 62 labels (yearly saved at quarterly floor)', (await labelsLen(page)) === 62);
  await page.click('.legend-chip[data-idx="0"]'); await page.waitForTimeout(300);
  ck('reactivate main keeps 62 labels', (await labelsLen(page)) === 62);
  ck('no data/meta length mismatch after toggles (no "back in time" loop)', (await lengthIntegrity(page)).length === 0, JSON.stringify(await lengthIntegrity(page)));

  // ===== 8. per-strategy envelope =====
  section('per-strategy "show alternate runs"');
  await fresh(page);
  await openMain(page); await setSel(page, 'select-9sig-growth', '15');
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  const X = await page.evaluate(() => window._editingConfigId);
  await page.click('#toggle-envelope'); await page.waitForTimeout(300);
  let g = await ghosts(page);
  ck('envelope shows only the edited strategy', g.base === 0 && g.cfgIds.length === 1 && g.cfgIds[0] === X, JSON.stringify(g));
  await closePanel(page);
  g = await ghosts(page);
  ck('envelope stays on close, no main envelope', g.base === 0 && g.cfgIds.length === 1 && g.cfgIds[0] === X, JSON.stringify(g));
  // second strategy, envelope off → only X still
  await openMain(page); await setSel(page, 'select-9sig-growth', '20');
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  const Y = await page.evaluate(() => window._editingConfigId);
  g = await ghosts(page);
  ck('new strategy (env off) doesn\'t add an envelope', g.base === 0 && g.cfgIds.length === 1 && g.cfgIds[0] === X, JSON.stringify(g) + ' Y=' + Y);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#chart-legend .legend-chip'); await page.waitForTimeout(400);
  g = await ghosts(page);
  ck('envelope flag persists across reload (still only X)', g.base === 0 && g.cfgIds.length === 1 && g.cfgIds[0] === X, JSON.stringify(g));

  // ===== 9. per-strategy sub-series for a changed 9sig (persist on close) =====
  section('sub-series for a changed 9sig');
  await fresh(page);
  await openMain(page);
  await setSel(page, 'select-9sig-growth', '15');
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250); // editing the saved copy
  const cid = await page.evaluate(() => window._editingConfigId);
  ck('panel shows per-config sub-series chips', (await page.evaluate(() => document.querySelectorAll('#strategy-panel-body .cfg-sub-chip').length)) === 3);
  // enable Holding + Cash for the changed strategy
  await page.click('#strategy-panel-body .cfg-sub-chip[data-config-sub="holding"]'); await page.waitForTimeout(200);
  await page.click('#strategy-panel-body .cfg-sub-chip[data-config-sub="cash"]'); await page.waitForTimeout(200);
  const readSubs = (cidArg) => page.evaluate((id) => {
    const c = window.Chart.getChart(document.getElementById('mainChart'));
    const last = a => { for (let i = a.length - 1; i >= 0; i--) if (typeof a[i] === 'number') return a[i]; };
    const subs = {};
    c.data.datasets.forEach((d, i) => { if (d._configId === id && d._configSub) subs[d._configSub] = { last: last(d.data), color: d.borderColor, vis: c.isDatasetVisible(i) }; });
    const total = c.data.datasets.find(d => d._configLine && !d._isShift && !d._configSub && d._configId === id);
    return { subs, total: total ? last(total.data) : null, cfgColor: getSavedConfigs().find(x => x.id === id).color };
  }, cidArg);
  const sOpen = await readSubs(cid);
  ck('Holding + Cash sub-series appear for the changed strategy', !!(sOpen.subs.holding && sOpen.subs.cash && sOpen.subs.holding.vis && sOpen.subs.cash.vis), JSON.stringify(sOpen.subs));
  ck('sub-series colored as the changed strategy', sOpen.subs.holding && sOpen.subs.holding.color === sOpen.cfgColor, JSON.stringify(sOpen.subs.holding) + ' cfg=' + sOpen.cfgColor);
  ck('sub-series are the changed strategy (Holding+Cash = its total)',
    Math.abs((sOpen.subs.holding.last + sOpen.subs.cash.last) - sOpen.total) < Math.max(1, sOpen.total * 0.002),
    `H+C=${Math.round(sOpen.subs.holding.last + sOpen.subs.cash.last)} total=${Math.round(sOpen.total)}`);
  // CLOSE the sidebar — sub-series must STAY as the changed strategy's (not flip to original)
  await closePanel(page);
  const sClosed = await readSubs(cid);
  ck('after close: sub-series still present + visible', !!(sClosed.subs.holding && sClosed.subs.cash && sClosed.subs.holding.vis), JSON.stringify(sClosed.subs));
  ck('after close: sub-series STILL the changed strategy (no flip to original)',
    Math.abs((sClosed.subs.holding.last + sClosed.subs.cash.last) - sClosed.total) < Math.max(1, sClosed.total * 0.002),
    `H+C=${Math.round((sClosed.subs.holding.last + sClosed.subs.cash.last))} total=${Math.round(sClosed.total)}`);
  ck('after close: main shared sub-series (1/5/6) are not showing config data', (await page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById('mainChart'));
    return !c.isDatasetVisible(1) && !c.isDatasetVisible(5) && !c.isDatasetVisible(6);
  })) === true);
  // Linear is anchored at 0; the log axis auto-scales (dynamic min). Values below
  // 1 are raised to 1 so zeros still plot on log, and the dynamic min includes them.
  ck('linear y-axis is anchored at 0', (await page.evaluate(() => window.Chart.getChart(document.getElementById('mainChart')).scales.y.min)) === 0);
  await page.click('#chart-log-toggle'); await page.waitForTimeout(300);
  ck('log y-axis is dynamic (auto min > 0, includes all visible data)', (await page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById('mainChart'));
    let smallest = Infinity;
    c.data.datasets.forEach((d, i) => { if (c.isDatasetVisible(i)) (d.data || []).forEach(v => { if (typeof v === 'number' && v < smallest) smallest = v; }); });
    return c.scales.y.min > 0 && c.scales.y.min <= smallest;
  })) === true);
  ck('no visible value drops below 1 on log', (await page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById('mainChart'));
    return c.data.datasets.every((d, i) => !c.isDatasetVisible(i) || (d.data || []).every(v => typeof v !== 'number' || v >= 1));
  })) === true);
  ck('clampChartMin raises a 0 value to 1 (zeros plot on log)', (await page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById('mainChart'));
    c.data.datasets[0].data[0] = 0; clampChartMin(c);
    return c.data.datasets[0].data[0];
  })) === 1);
  await page.click('#chart-log-toggle'); await page.waitForTimeout(300); // back to linear
  ck('linear y-axis back to 0 after toggling log off', (await page.evaluate(() => window.Chart.getChart(document.getElementById('mainChart')).scales.y.min)) === 0);

  // ===== 10. custom strategy: main 9sig resets after save =====
  section('custom strategy save resets the main 9sig');
  await fresh(page);
  await openMain(page);
  const cDef = await mainLast(page);
  await setSel(page, 'select-9sig-growth', '30');
  const cEdited = await mainLast(page);
  ck('main edited before custom (sanity)', cEdited !== cDef);
  // create + apply a custom strategy while the 9sig draft (growth 30) is loaded
  await page.evaluate(() => document.getElementById('new-custom-strategy').click());
  await page.waitForSelector('#custom-builder-modal', { timeout: 4000 });
  await page.click('[data-builder-complete]'); await page.waitForTimeout(150);
  const code = '{ name: "T", params: [], run(data,p){ var log=[],v=p.initial; for(var i=p.startIdx;i<=p.endIdx;i++){ v=v*1.001; log.push({date:data.dates[i],value:v,price:data.tqqq[i],contributed:0,action:"hold"}); } return {log:log}; } }';
  await page.fill('#builder-code', code);
  await page.click('[data-builder-apply]'); await page.waitForTimeout(800);
  const cust = await page.evaluate(() => {
    const cfgs = getSavedConfigs();
    return { count: cfgs.length, hasCustom: cfgs.some(c => c.type === 'custom') };
  });
  ck('custom strategy created', cust.hasCustom && cust.count === 1, JSON.stringify(cust));
  ck('main 9sig resets to default after saving custom', (await mainLast(page)) === cDef, `got=${await mainLast(page)} def=${cDef} edited=${cEdited}`);

  // ===== 11. analytics heatmap: saved strategies on both sides =====
  section('heatmap lists built-in + saved strategies, divided');
  await fresh(page);
  // Two parameter strategies + one code strategy (each save needs its panel open).
  await page.click('.legend-chip[data-idx="8"] .legend-more'); await page.waitForSelector('#strategy-panel.is-open'); await page.waitForTimeout(150);
  await page.click('[data-sc-savenew="sma"]'); await page.waitForTimeout(250);
  await closePanel(page);
  await openMain(page);
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  await closePanel(page);
  await openMain(page);
  await page.evaluate(() => document.getElementById('new-custom-strategy').click());
  await page.waitForSelector('#custom-builder-modal', { timeout: 4000 });
  await page.click('[data-builder-complete]'); await page.waitForTimeout(150);
  const hmCode = '{ name:"Half", params:[], run(data,p){ var out=[],sh=0,cash=p.initial,seed=false; for(var i=p.startIdx;i<=p.endIdx;i++){ var px=data.tqqq[i]; if(px>0){ if(!seed){ sh=(p.initial*0.5)/px; cash=p.initial*0.5; seed=true; } out.push({date:data.dates[i],value:sh*px+cash}); } } return out; } }';
  await page.fill('#builder-code', hmCode);
  await page.click('[data-builder-apply]'); await page.waitForTimeout(800);
  const cfgIds = await page.evaluate(() => getSavedConfigs().map(c => ({ id: c.id, type: c.type })));
  ck('three saved strategies exist (9sig, sma, custom)', cfgIds.length === 3 && cfgIds.some(c => c.type === 'custom'), JSON.stringify(cfgIds));

  // Wait until a heatmap build finishes (all cells filled + progress hidden).
  const waitHeatmap = async () => {
    await page.waitForFunction(() => {
      const prog = document.getElementById('analytics-progress');
      const tds = document.querySelectorAll('#analytics-heatmap td.heatmap-cell[data-yp]');
      if (!tds.length) return false;
      let filled = 0; tds.forEach(td => { if (td.dataset.value != null) filled++; });
      return filled === tds.length && prog && prog.hasAttribute('hidden');
    }, { timeout: 60000 });
  };
  await page.click('#analytics-toggle');
  await page.waitForSelector('#analytics-modal:not([hidden])');
  await waitHeatmap();

  const pickers = await page.evaluate(() => {
    const stratSel = document.getElementById('analytics-strategy');
    const baseSel  = document.getElementById('analytics-baseline');
    const sentence = (document.getElementById('analytics-sentence') || {}).textContent || '';
    // The "Visualize" dropdown always exposes every built-in, regardless of
    // main-chart visibility — analytics runs its own sims and lets the user
    // compare any pair without un-hiding chart lines first.
    const stratStrategiesGroup = stratSel.querySelector('optgroup[label="Strategies"]');
    const builtinOpts = stratStrategiesGroup ? [...stratStrategiesGroup.querySelectorAll('option')].map(o => o.value) : [];
    // Default builtins: 9sig, the active B&H (TQQQ by default), SMA — the
    // three main-chart chips. The B&H entry tracks the chip's selector, so it
    // becomes B&H QLD/SSO/SPXL/QQQ/SPY/QQQ5 if the user picks a different
    // underlying. Compounded Cash + custom targets live in the baseline
    // dropdown only.
    const EXPECTED_BUILTINS = ['9sig', 'bh-tqqq', 'sma'];
    const builtinAllPresent = EXPECTED_BUILTINS.every(k => builtinOpts.includes(k));
    const noneMissingDespiteHidden = builtinOpts.length === EXPECTED_BUILTINS.length;
    const stratSavedGroup = stratSel.querySelector('optgroup[label="Saved"]');
    const baseSavedGroup  = baseSel.querySelector('optgroup[label="Saved"]');
    const baseCustomGroup = baseSel.querySelector('optgroup[label="Custom"]');
    const sentEl = document.getElementById('analytics-sentence');
    const investInSentence = ['initial', 'monthly', 'raise'].every(k => !!sentEl.querySelector(`.metric-select[data-metric-key="${k}"]`));
    return {
      sentenceOk: /Visualize/.test(sentence) && /vs performance of/.test(sentence) && /entry amount of/.test(sentence) && /monthly investment of/.test(sentence) && /increasing yearly by/.test(sentence),
      investInSentence,
      noSavedLabel: !document.querySelector('.analytics-strat-sep'),
      builtinAllPresent, noneMissingDespiteHidden, builtinOpts,
      stratSavedOpts: stratSavedGroup ? stratSavedGroup.querySelectorAll('option').length : 0,
      baseGroups: [...baseSel.querySelectorAll('optgroup')].map(g => g.label),
      baseSavedOpts: baseSavedGroup ? baseSavedGroup.querySelectorAll('option').length : 0,
      hasCustomTarget: !!(baseCustomGroup && [...baseCustomGroup.querySelectorAll('option')].some(o => o.value === 'custom')),
      hasCustomPct:    !!(baseCustomGroup && [...baseCustomGroup.querySelectorAll('option')].some(o => o.value === 'custom-pct')),
    };
  });
  ck('header reads as a sentence (Visualize … vs … with entry/monthly/raise)', pickers.sentenceOk, JSON.stringify(pickers));
  ck('investment dropdowns (initial/monthly/raise) are inline in the sentence', pickers.investInSentence);
  ck('the "SAVED" divider chip is gone', pickers.noSavedLabel);
  ck('Visualize dropdown lists every built-in (regardless of chart visibility)', pickers.builtinAllPresent, JSON.stringify(pickers.builtinOpts));
  ck('Visualize dropdown has no extra builtins', pickers.noneMissingDespiteHidden, JSON.stringify(pickers.builtinOpts));
  ck('Visualize dropdown lists 3 saved strategies', pickers.stratSavedOpts === 3, 'saved=' + pickers.stratSavedOpts);
  ck('comparison dropdown: Baseline / Strategies / Saved / Custom optgroups', pickers.baseGroups.join(',') === 'Baseline,Strategies,Saved,Custom', pickers.baseGroups.join(','));
  ck('comparison dropdown: 3 saved options', pickers.baseSavedOpts === 3, 'savedOpts=' + pickers.baseSavedOpts);
  ck('comparison dropdown keeps Custom Target + Custom Growth', pickers.hasCustomTarget && pickers.hasCustomPct);

  // Saved 9sig as the strategy (via the dropdown), saved SMA as the baseline.
  const sig9 = cfgIds.find(c => c.type === '9sig').id;
  const smaId = cfgIds.find(c => c.type === 'sma').id;
  const customId = cfgIds.find(c => c.type === 'custom').id;
  const pickStrategy = (id) => page.evaluate((cid) => { const s = document.getElementById('analytics-strategy'); s.value = 'cfg:' + cid; s.dispatchEvent(new Event('change', { bubbles: true })); }, id);
  await pickStrategy(sig9);
  await page.waitForTimeout(50);
  await page.evaluate((id) => { const s = document.getElementById('analytics-baseline'); s.value = 'cfg:' + id; s.dispatchEvent(new Event('change', { bubbles: true })); }, smaId);
  await waitHeatmap();
  const paramGrid = await page.evaluate((id) => {
    const tds = [...document.querySelectorAll('#analytics-heatmap td.heatmap-cell[data-yp]')];
    const sel = document.getElementById('analytics-strategy');
    const groups = [...document.querySelectorAll('#analytics-metrics .ap-group')];
    return {
      selectedSaved: sel && sel.value === 'cfg:' + id,
      paramGroups: groups.length, // strategy + comparison (no Investment group)
      noInvestmentGroup: !groups.some(g => /^Investment/i.test(g.querySelector('.ap-label') ? g.querySelector('.ap-label').textContent : '')),
      stratHasParamDropdowns: groups.some(g => /parameters/.test(g.querySelector('.ap-label') ? g.querySelector('.ap-label').textContent : '') && g.querySelector('select.cfg-metric-select')),
      allPositive: tds.length > 0 && tds.every(td => +td.dataset.value > 0),
      anyColored: tds.some(td => /^rgb/.test(td.style.background)),
    };
  }, sig9);
  ck('Visualize dropdown selects the saved 9sig', paramGrid.selectedSaved, JSON.stringify(paramGrid));
  ck('two param groups (strategy + comparison), no Investment group', paramGrid.paramGroups === 2 && paramGrid.noInvestmentGroup, 'groups=' + paramGrid.paramGroups);
  ck('saved strategy shows its own editable param dropdowns', paramGrid.stratHasParamDropdowns, JSON.stringify(paramGrid));
  ck('saved 9sig ÷ saved SMA: all cells positive + colored', paramGrid.allPositive && paramGrid.anyColored, JSON.stringify(paramGrid));

  // CODE strategy — runs through the sandboxed worker per row.
  await pickStrategy(customId);
  await waitHeatmap();
  const codeGrid = await page.evaluate(() => {
    const tds = [...document.querySelectorAll('#analytics-heatmap td.heatmap-cell[data-yp]')];
    return { n: tds.length, allPositive: tds.length > 0 && tds.every(td => +td.dataset.value > 0) };
  });
  ck('saved CODE strategy renders the full grid (worker)', codeGrid.allPositive, JSON.stringify(codeGrid));

  // Metric pills: clicking the pill (not just the value) opens the dropdown.
  const pillOpens = await page.evaluate(() => {
    const pill = [...document.querySelectorAll('.analytics-metrics .metric')].find(p => p.querySelector('select'));
    if (!pill) return { ok: false, why: 'no metric pill' };
    const sel = pill.querySelector('select');
    let opened = false;
    sel.showPicker = () => { opened = true; }; // stub: assert the pill click reaches showPicker
    pill.click(); // click the pill body (not the <select> directly)
    return { ok: opened };
  });
  ck('metric pill opens its dropdown when the whole pill is clicked', pillOpens.ok, JSON.stringify(pillOpens));

  await page.evaluate(() => toggleAnalytics()); // close modal (button sits behind the overlay)
  await page.waitForTimeout(150);

  // ===== 12. saved strategies: drag handle + reorder =====
  section('saved strategies: drag handle + reorder');
  await fresh(page);
  await page.click('.legend-chip[data-idx="8"] .legend-more'); await page.waitForSelector('#strategy-panel.is-open'); await page.waitForTimeout(150);
  await page.click('[data-sc-savenew="sma"]'); await page.waitForTimeout(250);
  await closePanel(page);
  await openMain(page);
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  await closePanel(page);
  const order0 = await page.evaluate(() => getSavedConfigs().map(c => c.id));
  const handles = await page.evaluate(() => {
    const pills = [...document.querySelectorAll('.saved-config-pill')];
    return { n: pills.length, allDraggable: pills.length > 0 && pills.every(p => p.getAttribute('draggable') === 'true' && !!p.querySelector('.sc-drag')) };
  });
  ck('each saved pill is draggable + has a grip handle under the eye', handles.n === 2 && handles.allDraggable, JSON.stringify(handles));
  await page.evaluate((order) => reorderSavedConfigs(order.slice().reverse()), order0);
  await page.waitForTimeout(150);
  const order1 = await page.evaluate(() => getSavedConfigs().map(c => c.id));
  ck('reorder commits the new order', JSON.stringify(order1) === JSON.stringify(order0.slice().reverse()), JSON.stringify({ order0, order1 }));
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#chart-legend .legend-chip'); await page.waitForTimeout(250);
  const order2 = await page.evaluate(() => getSavedConfigs().map(c => c.id));
  ck('reorder persists across reload', JSON.stringify(order2) === JSON.stringify(order1), JSON.stringify({ order1, order2 }));

  // ===== 13. main line computed at its OWN period (not the finest visible) =====
  section('main line stays at its own period when a finer saved strategy is visible');
  await fresh(page);
  await page.click('.legend-chip[data-idx="0"]'); await page.waitForTimeout(250); // show main (quarterly default)
  const vAlone = await mainLast(page);
  const labelsAlone = await labelsLen(page);
  // Save a WEEKLY 9sig (finer than the main's quarterly); main resets to default + hides.
  await openMain(page);
  await setSel(page, 'select-9sig-period', 'weekly');
  await page.click('[data-sc-savenew="9sig"]'); await page.waitForTimeout(250);
  await closePanel(page);
  await page.click('.legend-chip[data-idx="0"]'); await page.waitForTimeout(300); // re-show main (quarterly default)
  const vWithWeekly = await mainLast(page);
  const labelsWeekly = await labelsLen(page);
  ck('axis switched to the finer (weekly) grain', labelsWeekly > labelsAlone * 2, `alone=${labelsAlone} weekly=${labelsWeekly}`);
  ck('main 9sig final value unchanged by the visible weekly strategy (computed at its own quarterly period)', vAlone === vWithWeekly, `alone=${vAlone} withWeekly=${vWithWeekly}`);
  ck('no data/meta length mismatch with mixed-period strategies', (await lengthIntegrity(page)).length === 0, JSON.stringify(await lengthIntegrity(page)));

  // ===== 14. share-link strategies: not auto-saved, banner "Save" persists =====
  section('share-link strategies: not auto-saved, banner "Save" persists them');
  await fresh(page);
  const sc = [{ type: '9sig', name: 'Shared 9sig', params: { 'select-9sig-growth': '12' }, color: '#e879f9' }];
  await page.goto(BASE + '/index.html?v=35&sc=' + encodeURIComponent(JSON.stringify(sc)), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chart-legend .legend-chip', { timeout: 15000 });
  await page.waitForTimeout(400);
  const afterLoad = await page.evaluate(() => ({
    total: getSavedConfigs().length,
    transientCount: getSavedConfigs().filter(c => c._transient).length,
    hasBanner: !!document.querySelector('.shared-strategies-banner'),
    hasSaveBtn: !!document.getElementById('save-shared-strategies'),
    ls: JSON.parse(localStorage.getItem('9sig-saved-configs') || 'null'),
  }));
  ck('shared strategy renders on the chart', afterLoad.total === 1, JSON.stringify(afterLoad));
  ck('shared strategy is transient (NOT written to localStorage)', afterLoad.transientCount === 1 && afterLoad.ls === null, JSON.stringify(afterLoad));
  ck('banner + Save button appear', afterLoad.hasBanner && afterLoad.hasSaveBtn);

  await page.click('#save-shared-strategies'); await page.waitForTimeout(250);
  const afterSave = await page.evaluate(() => ({
    transientCount: getSavedConfigs().filter(c => c._transient).length,
    hasBanner: !!document.querySelector('.shared-strategies-banner'),
    ls: JSON.parse(localStorage.getItem('9sig-saved-configs') || 'null'),
  }));
  ck('after Save: no transient configs left', afterSave.transientCount === 0, JSON.stringify(afterSave));
  ck('after Save: banner is gone', !afterSave.hasBanner);
  ck('after Save: strategy is now in localStorage', afterSave.ls && afterSave.ls.length === 1, JSON.stringify(afterSave));

  // Reload WITHOUT ?sc= — saved strategy still persists locally.
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chart-legend .legend-chip', { timeout: 15000 });
  await page.waitForTimeout(300);
  const afterReload = await page.evaluate(() => ({ total: getSavedConfigs().length, banner: !!document.querySelector('.shared-strategies-banner') }));
  ck('reload (no ?sc=): saved strategy persists, no banner', afterReload.total === 1 && !afterReload.banner, JSON.stringify(afterReload));

  // And the "discard" path: a fresh load with ?sc= but the user doesn't click Save → reload without ?sc → strategy gone.
  await fresh(page);
  await page.goto(BASE + '/index.html?v=35&sc=' + encodeURIComponent(JSON.stringify(sc)), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chart-legend .legend-chip', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chart-legend .legend-chip', { timeout: 15000 });
  await page.waitForTimeout(300);
  const afterDiscard = await page.evaluate(() => getSavedConfigs().length);
  ck('without clicking Save, reload without ?sc= drops the shared strategy', afterDiscard === 0, 'count=' + afterDiscard);

  // ===== unsaved-changes warning when closing a dirty base panel =====
  section('unsaved-changes warning on close');
  await fresh(page);
  await openMain(page);
  // Clean close: no edits → close goes through immediately, no dialog.
  await page.click('.strategy-panel-close'); await page.waitForTimeout(150);
  ck('clean base close: no dialog, panel closes', await page.evaluate(() =>
    !document.getElementById('sc-unsaved-modal') && !document.querySelector('#strategy-panel.is-open')));
  // Dirty close: edit a knob, click × → dialog appears, panel stays open.
  await openMain(page);
  await setSel(page, 'select-9sig-growth', '20');
  await page.click('.strategy-panel-close'); await page.waitForTimeout(200);
  ck('dirty base close: dialog appears, panel stays open', await page.evaluate(() =>
    !!document.getElementById('sc-unsaved-modal') && !!document.querySelector('#strategy-panel.is-open')));
  // Esc dismisses the dialog (no Cancel button) → panel still open, edit preserved.
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  ck('Esc dismisses dialog: panel open, edit kept', await page.evaluate(() =>
    !document.getElementById('sc-unsaved-modal')
    && !!document.querySelector('#strategy-panel.is-open')
    && document.getElementById('select-9sig-growth').value === '20'));
  // Discard: dialog gone, panel closed, no new saved strategy, control reset.
  await page.click('.strategy-panel-close'); await page.waitForTimeout(150);
  await page.click('[data-sc-unsaved-discard]'); await page.waitForTimeout(200);
  ck('discard: panel closed, control reset, no saved strategy created',
    (await page.evaluate(() => ({
      modal: !!document.getElementById('sc-unsaved-modal'),
      open: !!document.querySelector('#strategy-panel.is-open'),
      growth: document.getElementById('select-9sig-growth').value,
      n: getSavedConfigs().length,
    }))).modal === false && (await page.evaluate(() => !document.querySelector('#strategy-panel.is-open') && document.getElementById('select-9sig-growth').value === '9' && getSavedConfigs().length === 0)));
  // Save: dialog click "Save as strategy" → persists the edit, closes panel.
  await openMain(page);
  await setSel(page, 'select-9sig-growth', '15');
  await page.click('.strategy-panel-close'); await page.waitForTimeout(150);
  await page.click('[data-sc-unsaved-save]'); await page.waitForTimeout(300);
  ck('save: panel closed, saved strategy persists with the edit',
    await page.evaluate(() =>
      !document.querySelector('#strategy-panel.is-open')
      && getSavedConfigs().length === 1
      && getSavedConfigs()[0].params['select-9sig-growth'] === '15'));
  // Editing a saved strategy auto-saves live → no warning on close.
  await page.click('.saved-config-pill .sc-edit'); await page.waitForTimeout(200);
  await setSel(page, 'select-9sig-growth', '25');
  await page.click('.strategy-panel-close'); await page.waitForTimeout(150);
  ck('saved-strategy close: no dialog (auto-saves live)', await page.evaluate(() =>
    !document.getElementById('sc-unsaved-modal') && !document.querySelector('#strategy-panel.is-open')));
  // Esc on dirty base panel also triggers the dialog.
  await fresh(page);
  await openMain(page);
  await setSel(page, 'select-9sig-growth', '12');
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ck('Esc on dirty base panel: dialog appears', await page.evaluate(() =>
    !!document.getElementById('sc-unsaved-modal') && !!document.querySelector('#strategy-panel.is-open')));
  // Esc again closes the dialog (not the panel).
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  ck('Esc on dialog: closes dialog, panel stays open', await page.evaluate(() =>
    !document.getElementById('sc-unsaved-modal') && !!document.querySelector('#strategy-panel.is-open')));

  await browser.close();

  // ---- report ----
  console.log(results.join('\n'));
  console.log('\nJS errors: ' + (errs.length ? '\n  ' + errs.join('\n  ') : 'none'));
  const ok = pass && errs.length === 0;
  console.log('\n' + (ok ? '===== ALL PASS =====' : '===== FAILURES ====='));
  process.exit(ok ? 0 : 1);
}
run().catch(e => { console.error(e); process.exit(1); });
