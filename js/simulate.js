
// SMA timing strategy: hold TQQQ while the signal asset (QQQ or SPY) closes
// above its N-day simple moving average; flip to cash (earning the user's
// configured rate) when it closes below. Monthly resolution — checks the
// signal at each monthly TSV entry, matching Meb Faber's 10-month-SMA cadence
// which is the literature analogue. SMA series are precomputed in data.js.
//
// `entryIdx` / `exitIdx` are quarterly indices (same contract as simulate());
// we resolve them to monthly-data positions via a binary scan and emit one
// snapshot per quarter so the result drops straight into the chart pipeline.
//
// `state` per quarter is 'in' (holding TQQQ) or 'out' (cash) at the end of
// that quarter — the SMA strategy panel renders transition dots off this.
// Column index into monthlyData rows for each tradeable asset name.
// monthlyData layout: [date, tqqq, qqq, spy, _unused, qqq5]
const SMA_ASSET_COL = { tqqq: 1, qqq: 2, spy: 3, qqq5: 5 };
// Unleveraged equivalent — used for the bodyguard SMA-distance check.
// (The bodyguard tracks the unleveraged underlying because the leveraged
// version's "% above its own SMA" is structurally larger and useless as a
// gauge of how stretched the underlying market is.)
const SMA_UNLEVERAGED_OF = { tqqq: 'qqq', qqq5: 'qqq', qqq: 'qqq', spy: 'spy' };

function simulateSMA(initial, monthly, annualRate, entryIdx, exitIdx, annualRaise, opts) {
  opts = opts || {};
  const smaAsset  = (opts.smaAsset || 'qqq').toLowerCase();
  const smaWindow = +opts.smaWindow || 200;
  const ulCol     = opts.underlyingCol != null ? +opts.underlyingCol : 1;
  // Hysteresis buffers (% of SMA). Enter only when signal asset closes
  // (1 + entryBuf)% above SMA; exit only when (1 - exitBuf)% below. Default
  // 0/0 = current binary-cross behavior. Set both > 0 to mimic the
  // TradingView "+4 / -3" buffered SMA strategy.
  const entryBuf  = (+opts.entryBufferPct || 0) / 100;
  const exitBuf   = (+opts.exitBufferPct  || 0) / 100;
  // RSI overheat exit: if RSI(10) on the signal asset is above this value,
  // exit to cash even when SMA says "in" — captures the TFTLT idea. 0 = off.
  const rsiOH     = +opts.rsiOverheatThreshold || 0;
  // RSI cool-gate entry: when SMA flips back to "in", DON'T re-enter until
  // RSI(10) is below this value. Filters out buying tops by waiting for a
  // pullback within the uptrend. 0 = off (enter immediately on SMA cross).
  const rsiCool   = +opts.rsiCoolThreshold || 0;
  // What to hold during a SELL ("out") state: cash (canonical) or an
  // unleveraged equity asset (QQQ / SPY). When an asset is picked, monthly
  // contributions during "out" DCA into it instead of sitting idle in cash.
  const outAsset  = (opts.outAsset || 'cash').toLowerCase();
  // DCA ladders (time-based, in months). 0 = instant (current behavior).
  // dcaInMonths gates the cash → underlying ramp on BUY; dcaToOutMonths gates
  // the cash → out-asset ramp on SELL (only meaningful when outAsset != cash).
  // Sells to cash are always instant — only the buy leg of any transition is
  // laddered, matching the canonical "sell immediately, DCA back in" pattern.
  const dcaInMonths    = Math.max(0, +opts.dcaInMonths    || 0);
  const dcaToOutMonths = Math.max(0, +opts.dcaToOutMonths || 0);
  // Bodyguard thresholds (% above unleveraged-underlying SMA). 0 = off.
  // delev: leveraged → unleveraged swap. gtfo: everything → cash. Bodyguard
  // transitions are instant (override DCA) — the whole point is emergency exit.
  const bgDelev = +opts.bgDelevPct || 0;
  const bgGtfo  = +opts.bgGtfoPct  || 0;
  const monthlyRate = annualRate / 12;
  annualRaise = annualRaise || 0;

  const empty = { smaPoints: [], totalContributed: initial };
  if (!smaAtMonthlyByKey || !monthlyData || !quarterlyData) return empty;
  const smaKey    = smaAsset + '_' + smaWindow;
  const smaAtMon  = smaAtMonthlyByKey[smaKey];
  if (!smaAtMon)  return empty;
  const rsiAtMon  = (typeof rsiAtMonthlyByAsset !== 'undefined' && rsiAtMonthlyByAsset) ? rsiAtMonthlyByAsset[smaAsset] : null;

  const startDate = quarterlyData[entryIdx][0];
  const endDate   = quarterlyData[exitIdx][0];
  const assetCol  = smaAsset === 'qqq' ? 2 : 3; // monthlyData = [date, tqqq, qqq, spy, _, qqq5]

  // Underlying asset name (for state-machine target comparisons). Resolve from
  // ulCol so non-default underlyings (QQQ5) get the right unleveraged sibling.
  const ulName = Object.keys(SMA_ASSET_COL).find(k => SMA_ASSET_COL[k] === ulCol) || 'tqqq';
  const unlevName = SMA_UNLEVERAGED_OF[ulName] || 'qqq';
  const unlevCol  = SMA_ASSET_COL[unlevName];
  // Bodyguard SMA — same window as primary, but always on the unleveraged
  // underlying ("% above QQQ-200" is the canonical dot-com gauge, not the
  // leveraged version of it).
  const bgSmaAtMon = (bgDelev > 0 || bgGtfo > 0) ? smaAtMonthlyByKey[unlevName + '_' + smaWindow] : null;

  // First monthly index at-or-after the entry quarter; last at-or-before exit.
  let mStart = 0;
  while (mStart < monthlyData.length && monthlyData[mStart][0] < startDate) mStart++;
  let mEnd = monthlyData.length - 1;
  while (mEnd >= 0 && monthlyData[mEnd][0] > endDate) mEnd--;
  if (mStart > mEnd) return empty;

  // Decide in/out for this period. Layered rules:
  //   1. SMA crossover (with entry/exit hysteresis buffers) — primary regime
  //   2. RSI overheat (rsiOH)   — force exit when over-extended upside
  //   3. RSI cool gate (rsiCool) — block re-entry until pullback completes
  // The two RSI rules are independent: overheat fires when RSI is HIGH,
  // cool-gate fires when RSI is still HIGH (haven't reached the cool zone).
  function evalSignal(state, asset, sma, rsi) {
    if (sma == null || asset <= 0) return state;
    const rsiHot = rsiOH > 0 && rsi != null && rsi >= rsiOH;
    if (state === 'in') {
      if (rsiHot) return 'out';
      return asset < sma * (1 - exitBuf) ? 'out' : 'in';
    }
    // state === 'out' — entry path
    if (rsiHot) return 'out';                          // don't re-enter while overheated
    if (rsiCool > 0 && rsi != null && rsi >= rsiCool) return 'out'; // wait for pullback
    return asset > sma * (1 + entryBuf) ? 'in' : 'out';
  }
  // Bodyguard: returns 'gtfo' / 'delev' / 'normal' based on the unleveraged
  // underlying's % above its own SMA. Both thresholds must be > 0 to fire.
  function evalBodyguard(unlevPrice, unlevSma) {
    if (!unlevSma || unlevSma <= 0 || unlevPrice <= 0) return 'normal';
    const aboveBy = (unlevPrice / unlevSma - 1) * 100;
    if (bgGtfo  > 0 && aboveBy >= bgGtfo)  return 'gtfo';
    if (bgDelev > 0 && aboveBy >= bgDelev) return 'delev';
    return 'normal';
  }
  // Compose primary + bodyguard into a single target asset name. Bodyguard
  // wins (gtfo → cash, delev → unleveraged); else primary decides between the
  // underlying and the out-asset.
  function computeTarget(primary, bg) {
    if (bg === 'gtfo') return 'cash';
    if (primary === 'out') return outAsset;
    if (bg === 'delev') return unlevName;
    return ulName;
  }
  // Initial state: SMA + buffer + RSI on entry month.
  const sm0 = monthlyData[mStart];
  const a0  = sm0[assetCol] || 0;
  const sma0 = smaAtMon[mStart];
  const rsi0 = rsiAtMon ? rsiAtMon[mStart] : null;
  // Seed state ignoring exit-buffer (no prior state to test against — fall
  // back to plain "above SMA?" for the very first read).
  let state  = sma0 == null ? 'in' : (a0 > sma0 ? 'in' : 'out');
  if (state === 'in' && rsiOH > 0 && rsi0 != null && rsi0 >= rsiOH) state = 'out';
  // Initial bodyguard read (same month).
  const bgSma0 = bgSmaAtMon ? bgSmaAtMon[mStart] : null;
  const unlev0 = sm0[unlevCol] || 0;
  let bgState = evalBodyguard(unlev0, bgSma0);

  // Holdings: shares per tradeable asset (tqqq, qqq, spy, qqq5) + cash.
  // Multiple buckets coexist mid-DCA; non-target buckets are sold instantly
  // each month, target bucket is bought via the active DCA ladder.
  const shares = { tqqq: 0, qqq: 0, spy: 0, qqq5: 0 };
  let cash = initial;
  let totalInvested = initial;
  const startYear = parseInt(sm0[0].substring(0, 4));
  let currentMonthly = monthly;
  let lastYear = startYear;

  // Pricing helper — column-zero (no data) returns 0 so callers skip the trade.
  function priceOf(row, asset) {
    const c = SMA_ASSET_COL[asset];
    return (c != null) ? (row[c] || 0) : 0;
  }
  // Initial target asset + initial deployment (instant — there's nothing prior
  // to ramp from).
  let target = computeTarget(state, bgState);
  if (target !== 'cash') {
    const p0 = priceOf(sm0, target);
    if (p0 > 0) { shares[target] = cash / p0; cash = 0; }
  }
  let dcaRemaining = 0; // 0 = no active DCA (target already reached or all-cash)

  const ul0 = sm0[ulCol] || 0;
  function totalAt(row) {
    let v = 0;
    for (const a of Object.keys(shares)) {
      if (shares[a] > 0) v += shares[a] * (priceOf(row, a) || 0);
    }
    return v + cash;
  }
  const smaPoints = [{ date: sm0[0], value: totalAt(sm0), state }];
  // Event-driven transaction log: one row per ACTUAL trade (ENTER / EXIT /
  // DELEV / GTFO / RESUME), not one row per quarter.
  const smaLog = [{
    date: sm0[0],
    state, action: 'START',
    price: ul0, shares: shares.tqqq + shares.qqq5,  // leveraged-side share count
    stockVal: totalAt(sm0) - cash, cash, total: totalAt(sm0),
    invested: initial,
  }];
  const qEnds = new Set();
  for (let qi = entryIdx; qi <= exitIdx; qi++) qEnds.add(quarterlyData[qi][0]);

  // Lazy-seed: if a target asset has no price yet (pre-history), defer until
  // a real price appears. Cash accumulates contributions in the meantime.
  let seeded = (target === 'cash') ? true : (ul0 > 0 && (priceOf(sm0, target) > 0));

  function actionFor(prevTarget, newTarget, primary, bg, prevBg) {
    if (prevTarget === newTarget) return null;
    if (bg === 'gtfo' && prevBg !== 'gtfo') return 'BG-GTFO';
    if (bg === 'delev' && prevBg !== 'delev') return 'BG-DELEV';
    if (prevBg === 'gtfo' || prevBg === 'delev') return 'BG-CLEAR';
    return primary === 'in' ? 'ENTER' : 'EXIT';
  }

  for (let m = mStart + 1; m <= mEnd; m++) {
    const row    = monthlyData[m];
    const mDate  = row[0];
    const ulP    = row[ulCol] || 0;
    const assetP = row[assetCol] || 0;
    const unlevP = row[unlevCol] || 0;
    const sma    = smaAtMon[m];
    const rsi    = rsiAtMon ? rsiAtMon[m] : null;
    const bgSma  = bgSmaAtMon ? bgSmaAtMon[m] : null;

    const yr = parseInt(mDate.substring(0, 4));
    if (yr > lastYear) {
      currentMonthly = monthly * Math.pow(1 + annualRaise, yr - startYear);
      lastYear = yr;
    }

    // Accrue cash interest on whatever cash sits idle for the month.
    if (cash > 0) cash *= (1 + monthlyRate);
    // Contributions always land in cash; the rebalance below redeploys.
    totalInvested += currentMonthly;
    cash += currentMonthly;

    const prevState = state;
    const prevBg    = bgState;
    state   = evalSignal(state, assetP, sma, rsi);
    bgState = evalBodyguard(unlevP, bgSma);
    const prevTarget = target;
    target  = computeTarget(state, bgState);

    if (!seeded) {
      seeded = (target === 'cash') || (priceOf(row, target) > 0);
    }

    // Target changed → instant-sell all non-target stocks → cash. Then arm
    // the DCA ladder for the new direction (instant for sells/bodyguard).
    if (target !== prevTarget) {
      for (const a of Object.keys(shares)) {
        if (a !== target && shares[a] > 0) {
          const p = priceOf(row, a);
          if (p > 0) { cash += shares[a] * p; shares[a] = 0; }
        }
      }
      // Bodyguard transitions are always instant; otherwise the ladder
      // applicable to the new direction.
      const bgChange = (bgState !== 'normal') || (prevBg !== 'normal');
      if (target === 'cash' || bgChange) dcaRemaining = 0;
      else if (target === ulName)        dcaRemaining = dcaInMonths    || 0;
      else                                dcaRemaining = dcaToOutMonths || 0;
    }

    // Deploy from cash → target stock (if any). 0 = instant; N = ramp 1/N of
    // remaining cash each month for N months.
    if (seeded && target !== 'cash' && cash > 0) {
      const p = priceOf(row, target);
      if (p > 0) {
        const fraction = dcaRemaining > 1 ? 1 / dcaRemaining : 1;
        const buy = cash * fraction;
        shares[target] += buy / p;
        cash -= buy;
        if (dcaRemaining > 0) dcaRemaining--;
      }
    }

    const flippedAction = actionFor(prevTarget, target, state, bgState, prevBg);
    if (flippedAction) {
      smaLog.push({
        date: mDate, state, action: flippedAction,
        price: ulP, shares: shares.tqqq + shares.qqq5,
        stockVal: totalAt(row) - cash,
        cash, total: totalAt(row),
        invested: totalInvested,
      });
    }

    if (qEnds.has(mDate)) {
      smaPoints.push({ date: mDate, value: totalAt(row), state });
    }
  }

  return { smaPoints, smaLog, totalContributed: totalInvested };
}

function simulate(initial, monthly, annualRate, entryIdx, exitIdx, annualRaise, opts) {
  // `annualRate` is the rate the STRATEGY's parked cash earns. The Invested
  // Compounded baseline (computed alongside, below) earns `opts.baselineRate`
  // instead, so the strategy and the baseline can use independent rates.
  // Falls back to annualRate when no baselineRate is supplied.
  const monthlyRate = annualRate / 12;
  annualRaise = annualRaise || 0;
  opts = opts || {};
  const baselineMonthlyRate = (opts.baselineRate != null ? +opts.baselineRate : annualRate) / 12;
  // Rebalance period — picks which period-grain dataset the 9sig loop runs
  // on. Defaults to 'quarterly' (existing behavior). For non-quarterly we
  // re-derive entry/exit indices into the period series and rescale the
  // user-facing per-quarter growth rate to per-period.
  const period = opts.rebalancePeriod || 'quarterly';
  const periodData = (typeof periodDataByName !== 'undefined' && periodDataByName && periodDataByName[period]) || null;
  const monthsInPeriod = (typeof monthsInPeriodByName !== 'undefined' && monthsInPeriodByName && monthsInPeriodByName[period]) || null;
  // Default `qData` chain: opts.qData wins (envelope shifts pass shifted data);
  // otherwise use the period-appropriate series; fall back to quarterlyData.
  let qData = opts.qData || periodData || quarterlyData;
  const skipBH = !!opts.skipBH;
  // Signal-line growth rate, applied LITERALLY per rebalance period. The number
  // the user picks IS the per-period growth: "grow the signal line by 9%" with
  // quarterly rebalancing grows it 9% per quarter; with yearly rebalancing it
  // grows 9% per year. Switching the rebalance period therefore changes the
  // strategy's aggressiveness (9%/qtr is ~4× more aggressive than 9%/yr) — by
  // design, so the displayed % always means exactly what it says. (The
  // return-maximizing yearly setting on TQQQ history is ~57–60%/yr; canonical
  // 9Sig is 9%/qtr ≈ 41%/yr.)
  const qGrowth = opts.qGrowth != null ? opts.qGrowth : 0.09;
  // 30-down no-sell rule: skip selling when the underlying is at least this %
  // below its trailing peak. Canonical 9Sig uses 30. Setting to a value past
  // 100 effectively disables the rule (price can't drop more than 100%).
  const crashDropPct  = opts.crashDropPct  != null ? +opts.crashDropPct  : 30;
  const crashFactor   = 1 - crashDropPct / 100;  // 30 → 0.70 (price < 70% of high)
  // How far back to look for the trailing peak, in calendar months. Canonical
  // 9Sig uses 24 (= 2 years). Smaller windows make the rule more reactive
  // (peak is more recent so price more easily clears 70% of it); larger
  // windows make it stricter (rule rarely fires).
  const crashLookbackMonths = opts.crashLookbackMonths != null ? +opts.crashLookbackMonths : 24;
  // Spike-reset trigger: if the underlying gains at least this % in a single
  // quarter (and we're not in the crash zone), hard-reset to a 60% allocation.
  // Canonical is 100 (doubling). 0 disables the rule.
  const spikeTrigPct  = opts.spikeTriggerPct != null ? +opts.spikeTriggerPct : 100;
  const spikeTrigger  = spikeTrigPct > 0 ? spikeTrigPct / 100 : Infinity;
  // Which quarterlyData column holds the price of the leveraged ETF this run
  // trades. Default is column 1 (TQQQ) for backward compat. Column 5 is QQQ5.
  const ulCol         = opts.underlyingCol != null ? opts.underlyingCol : 1;
  // Initial cash fraction (rest goes to the underlying). Default 0.40 matches
  // canonical 9Sig 60/40. Spike-reset target tracks (1 - cashPct) so the
  // reset rebalances back to the same stock weight the user started with.
  const cashPct       = opts.cashPct != null ? +opts.cashPct : 0.4;
  const stockPct      = 1 - cashPct;
  // Fraction of each monthly contribution to deploy immediately into the
  // underlying at the contribution-month's price (rest goes to cash and
  // earns interest until the next rebalance). Default 0 = canonical 9Sig
  // (wait for rebalance). Clamped to [0, 1].
  const contribDeployPct = Math.max(0, Math.min(1, opts.contribDeployPct != null ? +opts.contribDeployPct : 0));
  // Buying-power cap: a BUY never spends more than this fraction of cash, so
  // some dry powder is always kept. Canonical 9Sig keeps 10% (spends 90%).
  const buyThrottle = Math.max(0, Math.min(1, (opts.buyThrottlePct != null ? +opts.buyThrottlePct : 90) / 100));
  // Target-growth base. Default false → each period's target grows from the
  // PREVIOUS HOLDING (target re-anchors to reality each period — no runaway gap
  // when buys are throttled / 30-down fires). Set true to keep compounding the
  // target on its OWN value (the classic canonical-Kelly behaviour — the target
  // ratchets ahead during drawdowns and the strategy buys toward a higher
  // number). Exposed as a checkbox in the 9sig panel so users can compare both.
  const targetFromPrevTarget = !!opts.targetFromPrevTarget;

  // entryIdx / exitIdx are passed as indices into `quarterlyData` (slider
  // position, with the "enter at quarter start" shift already applied by the
  // caller — see chart.js render() — so simulate() does not adjust again).
  // When the rebalance period isn't quarterly we map those to
  // the nearest equivalent indices in the period data — same date span,
  // different grain.
  let _customYearly = false;
  // The "live snapshot" tail: when the chart's exit date is past the last
  // rebalance (always true for yearly unless the user picked an exact 12-month
  // multiple of entry), append a non-rebalancing row at the exit so the line's
  // right edge reflects current shares × current price + current cash. Without
  // this the line goes flat from the last anniversary to today and people
  // mistake intra-period gains for underperformance.
  let _sentinelIdx = -1;
  if (period === 'yearly' && !opts.qData && quarterlyData && monthlyData) {
    // "Yearly" = rebalance every 12 calendar months FROM the chart's entry,
    // NOT at calendar year-ends. So the strategy starts at the chart's first
    // label with $100K and the first rebalance lands exactly a year later —
    // regardless of when in the year you started. Each yearly run gets its
    // own anniversary-based dates instead of every yearly strategy sharing
    // 12-31 boundaries (which made strategies started mid-year visually
    // begin mid-period at a different value than the others).
    const startDate = quarterlyData[entryIdx] && quarterlyData[entryIdx][0];
    const endDate   = quarterlyData[exitIdx]  && quarterlyData[exitIdx][0];
    if (startDate && endDate) {
      const _addYears = (s, n) => {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y + n, m - 1, d)).toISOString().slice(0, 10);
      };
      const _monthlyRowAtOrBefore = (date) => {
        let row = null;
        for (let i = 0; i < monthlyData.length; i++) {
          if (monthlyData[i][0] <= date) row = monthlyData[i]; else break;
        }
        return row;
      };
      const rolling = [];
      let cur = startDate;
      while (cur <= endDate) {
        const row = _monthlyRowAtOrBefore(cur);
        if (row) rolling.push(row);
        cur = _addYears(cur, 1);
      }
      // Append a "live snapshot" sentinel at the chart's actual exit if the
      // last anniversary is earlier. Index recorded so the rebalance loop can
      // skip its sell/buy logic for this row (it's a value snapshot, not a
      // rebalance — shares unchanged, only cash + price change).
      if (rolling.length >= 1) {
        const lastRow = rolling[rolling.length - 1];
        if (endDate > lastRow[0]) {
          const exitRow = _monthlyRowAtOrBefore(endDate);
          if (exitRow && exitRow[0] > lastRow[0]) {
            rolling.push(exitRow);
            _sentinelIdx = rolling.length - 1;
          }
        }
      }
      if (rolling.length >= 2) {
        qData = rolling;
        entryIdx = 0;
        exitIdx = rolling.length - 1;
        _customYearly = true;
      }
    }
  }
  if (!_customYearly && period !== 'quarterly' && quarterlyData && qData !== quarterlyData && periodData) {
    const entryDate = quarterlyData[entryIdx] && quarterlyData[entryIdx][0];
    const exitDate  = quarterlyData[exitIdx]  && quarterlyData[exitIdx][0];
    if (entryDate && exitDate) {
      let e = 0, x = qData.length - 1;
      for (let i = 0; i < qData.length; i++) { if (qData[i][0] <= entryDate) e = i; else break; }
      for (let i = qData.length - 1; i >= 0; i--) { if (qData[i][0] >= exitDate)  x = i; else break; }
      entryIdx = e; exitIdx = x;
    }
  }
  // Fast path for the monthly-contribution slicing. Works whenever qData is
  // the period's canonical (un-shifted) array AND we have a matching
  // monthsInPeriod cache. Envelope-shifted qData falls back to linear scan.
  const fastMonthly = (qData === periodData || (period === 'quarterly' && qData === quarterlyData)) && monthsInPeriod && (period !== 'quarterly' || monthlyByQuarter);
  const monthsLookup = (period === 'quarterly') ? monthlyByQuarter : monthsInPeriod;
  const qSlice = qData.slice(entryIdx, exitIdx + 1);
  if (qSlice.length < 2) return { log: [], bhPoints: [], qqqPoints: [], spyPoints: [], qqq5Points: [], totalContributed: initial };

  // Initial allocation: stockPct in the leveraged ETF, cashPct in cash. The
  // canonical 9Sig is 60/40 (stockPct=0.6, cashPct=0.4) — the user picks via
  // the side-panel dropdown. Cash earns the configured monthly rate.
  let cash = initial * cashPct;
  let tqqqShares = (initial * stockPct) / qSlice[0][ulCol];
  let signalLine = initial * stockPct; // target value starts at initial stock allocation
  // Each new target grows from the PREVIOUS REBALANCE's post-rebalance holding
  // (not from the prior target). If the strategy underperforms — a throttled
  // buy, a crash-zone HOLD, or a spike reset — the target naturally tracks the
  // lower holding instead of ratcheting away on its own formula.
  let prevHolding = initial * stockPct; // = the post-rebalance tqqqVal at qi=0
  let totalInvested = initial;
  let investedCompounded = initial;
  let currentMonthly = monthly;
  const startYear = parseInt(qSlice[0][0].substring(0, 4));

  const log = [];
  // Quarter-end value snapshots for the chart, used ONLY when the rebalance
  // period is coarser than a quarter (i.e. yearly) so a yearly strategy still
  // draws/hovers at quarter resolution. Additive + opt-gated: the rebalance math
  // and `log` are untouched (numerical tests see identical results). Each snapshot
  // is the real portfolio value at a quarter-end (shares × that quarter's price +
  // cash, contributions applied) — not interpolation. Rebalancing still only
  // happens at `period`.
  const sampleQuarterly = !!opts.sampleQuarterly;
  const isQuarterEnd = (d) => { const m = d.substring(5, 7); return m === '03' || m === '06' || m === '09' || m === '12'; };
  const samplePoints = [];
  let prevQDate = qSlice[0][0];
  let crashNoSellCount = 0; // track consecutive 30-down no-sell skips (max 2)

  for (let qi = 0; qi < qSlice.length; qi++) {
    const qDate  = qSlice[qi][0];
    const qPrice = qSlice[qi][ulCol];

    if (qi > 0) {
      // Annual raise: increase monthly contribution at each new year
      const currentYear = parseInt(qDate.substring(0, 4));
      const prevYear = parseInt(prevQDate.substring(0, 4));
      if (currentYear > prevYear) {
        currentMonthly = monthly * Math.pow(1 + annualRaise, currentYear - startYear);
      }

      // Add monthly contributions. Canonical 9Sig sends 100% to cash and waits
      // for the next rebalance — `contribDeployPct` lets the user split each
      // contribution: that fraction is deployed into the underlying at the
      // current month's price, the rest goes to cash (and earns interest).
      // The signal-line bump below still uses full newCashThisQ × 0.5 so the
      // diff math balances out (price-flat case ≈ identical end state; only
      // intra-period price moves separate the two behaviors).
      let newCashThisQ = 0;
      // Helper: apply one month's contribution. When the user opted into
      // immediate deployment, split between an underlying-buy at this
      // month's price and a cash deposit. Fall back to "all cash" if the
      // price is missing (data gap / pre-history) — otherwise the stock
      // half would silently evaporate, since shares can't be bought without
      // a price to divide by.
      const applyContribAtPrice = (mPrice, mDate) => {
        const toStock = currentMonthly * contribDeployPct;
        if (toStock > 0 && mPrice > 0) {
          tqqqShares += toStock / mPrice;
          cash += currentMonthly - toStock;
        } else {
          cash += currentMonthly; // no price → can't buy; entire amount waits in cash
        }
        totalInvested += currentMonthly;
        newCashThisQ += currentMonthly;
        cash *= (1 + monthlyRate);
        investedCompounded *= (1 + baselineMonthlyRate);
        investedCompounded += currentMonthly;
        // Intra-period quarter-end snapshot (the period's own end is recorded
        // post-rebalance below). signalLine is still the prior period's value —
        // correct, since the target only steps at a rebalance.
        if (sampleQuarterly && mDate && mDate < qDate && mPrice > 0 && isQuarterEnd(mDate)) {
          const sv = tqqqShares * mPrice;
          samplePoints.push({ date: mDate, price: mPrice, tqqqVal: sv, cash, total: sv + cash, target: signalLine, invested: totalInvested, investedCompounded });
        }
      };
      if (fastMonthly) {
        const monthsInQ = monthsLookup[entryIdx + qi];
        for (let mi = 0; mi < monthsInQ.length; mi++) {
          applyContribAtPrice(monthlyData[monthsInQ[mi]][ulCol], monthlyData[monthsInQ[mi]][0]);
        }
      } else {
        for (const row of monthlyData) {
          if (row[0] > prevQDate && row[0] <= qDate) applyContribAtPrice(row[ulCol], row[0]);
        }
      }

      let action = '';
      // The sentinel row is a value snapshot at the chart's exit — NOT a
      // rebalance. Skip the signal-grow / sell-buy / spike-reset machinery; the
      // cash that accrued in the contribution loop above and the holding
      // (re-priced at exit below) ARE the live values we want to display.
      if (qi !== _sentinelIdx) {
        // Signal line grows 9% per quarter + 50% of new cash contributions.
        // Default base is the prior period's post-rebalance HOLDING — anchors
        // the target to what the strategy actually held last time, so the gap
        // can't run away on throttled buys / crash holds. The "compound on
        // itself" toggle switches the base to the prior SIGNAL instead (target
        // keeps compounding on its own formula — canonical Kelly).
        const growBase = targetFromPrevTarget ? signalLine : prevHolding;
        signalLine = growBase * (1 + qGrowth) + newCashThisQ * 0.5;

        const currentTqqqValue = tqqqShares * qPrice;
        const diff = currentTqqqValue - signalLine;

        // 30-down no-sell rule: if price < (1-crashDrop)% of the trailing
        // peak, skip the sell — but only up to 2 consecutive quarters, then
        // sell anyway. Lookback window is configurable (24 months = canonical
        // 2-year peak). Date math: convert YYYY-MM to absolute month index,
        // subtract the lookback, recompose into a YYYY-MM-DD string that
        // sorts lexicographically just like the qSlice dates do.
        const _y = parseInt(qDate.substring(0, 4));
        const _m = parseInt(qDate.substring(5, 7));
        const _totalMonths = _y * 12 + (_m - 1) - crashLookbackMonths;
        const _ny = Math.floor(_totalMonths / 12);
        const _nm = (_totalMonths % 12 + 12) % 12 + 1;
        const lookbackThreshold = String(_ny).padStart(4, '0') + '-' + String(_nm).padStart(2, '0') + qDate.substring(7);
        let peak2y = qPrice;
        for (let k = qi; k >= 0; k--) {
          if (qSlice[k][0] < lookbackThreshold) break;
          if (qSlice[k][ulCol] > peak2y) peak2y = qSlice[k][ulCol];
        }
        const inCrashZone = qPrice < peak2y * crashFactor;

        if (diff > 0 && !inCrashZone) {
          // SELL: TQQQ above signal, sell excess to cash
          const sharesToSell = diff / qPrice;
          tqqqShares -= sharesToSell;
          cash += diff;
          action = 'SELL ' + fmt(diff);
          crashNoSellCount = 0;
        } else if (diff > 0 && inCrashZone && crashNoSellCount < 2) {
          // Signal says sell but we're in crash zone and haven't skipped 2 times yet — hold
          crashNoSellCount++;
          action = 'HOLD (30d ' + crashNoSellCount + '/2)';
        } else if (diff > 0 && inCrashZone && crashNoSellCount >= 2) {
          // Crash zone but already skipped 2 consecutive quarters — sell anyway
          const sharesToSell = diff / qPrice;
          tqqqShares -= sharesToSell;
          cash += diff;
          action = 'SELL ' + fmt(diff) + ' (30d expired)';
          crashNoSellCount = 0;
        } else if (diff < 0 && cash > 0) {
          // BUY: TQQQ below signal, buy from cash (90% throttle)
          crashNoSellCount = 0;
          const available = cash * buyThrottle;
          const needed = Math.min(-diff, available);
          if (needed > 0) {
            const sharesToBuy = needed / qPrice;
            tqqqShares += sharesToBuy;
            cash -= needed;
            action = needed < -diff ? 'BUY ' + fmt(needed) + ' (part)' : 'BUY ' + fmt(needed);
          } else {
            action = 'HOLD';
          }
        } else {
          crashNoSellCount = 0;
          action = 'HOLD';
        }

        // Spike reset rule: if TQQQ at least doubled this quarter AND the post-
        // rebalance stock allocation is still 60–100% AND we're not in a 30-down
        // no-sell period, force the stock fund back to a 60% allocation. This
        // is the canonical 9Sig "spike reset" — a hard profit-take when a big
        // upmove leaves the leveraged fund still dominating the portfolio.
        const prevTqqqPrice = qSlice[qi - 1][ulCol];
        const quarterlyTqqqGain = prevTqqqPrice > 0 ? (qPrice - prevTqqqPrice) / prevTqqqPrice : 0;
        const postTqqqVal = tqqqShares * qPrice;
        const postTotal   = postTqqqVal + cash;
        const postAlloc   = postTotal > 0 ? postTqqqVal / postTotal : 0;
        if (quarterlyTqqqGain >= spikeTrigger && postAlloc >= stockPct && postAlloc <= 1.0 && !inCrashZone) {
          const targetTqqqVal = postTotal * stockPct;
          const reduceBy = postTqqqVal - targetTqqqVal;
          tqqqShares = targetTqqqVal / qPrice;
          cash       = postTotal - targetTqqqVal;
          signalLine = targetTqqqVal;
          action = 'RESET ' + fmt(reduceBy) + ' (spike)';
        }
      } else {
        action = 'SNAPSHOT';
      }

      const tqqqVal = tqqqShares * qPrice;
      log.push({ date: qDate, price: qPrice, tqqqVal, cash, total: tqqqVal + cash, action, invested: totalInvested, investedCompounded, target: signalLine });
      // Period-end snapshot (post-rebalance) — keeps the quarter series continuous.
      if (sampleQuarterly) samplePoints.push({ date: qDate, price: qPrice, tqqqVal, cash, total: tqqqVal + cash, target: signalLine, invested: totalInvested, investedCompounded });
      prevHolding = tqqqVal; // next period's target grows from THIS period's holding
    } else {
      // First quarter — just record starting state
      const tqqqVal = tqqqShares * qSlice[0][ulCol];
      log.push({ date: qDate, price: qSlice[0][ulCol], tqqqVal, cash, total: tqqqVal + cash, action: 'START', invested: totalInvested, investedCompounded, target: signalLine });
      if (sampleQuarterly) samplePoints.push({ date: qDate, price: qSlice[0][ulCol], tqqqVal, cash, total: tqqqVal + cash, target: signalLine, invested: totalInvested, investedCompounded });
      prevHolding = tqqqVal;
    }
    prevQDate = qDate;
  }

  if (skipBH) return { log, samplePoints, totalContributed: totalInvested, qqq5Points: [] };

  // Buy & hold for one asset column. Quarterly `points` (unchanged) plus, when
  // sampleQuarterly is on, quarter-end value snapshots so a yearly-grain run can
  // still draw B&H at quarter resolution. `requirePrice` mirrors the SPY/QQQ5
  // guard (skip a period whose period-end price is missing). The share-growth
  // math is identical to the four original loops — samples just observe it.
  function buyHold(col, requirePrice) {
    const points = [], sample = [];
    let shares = qSlice[0][col] ? initial / qSlice[0][col] : 0;
    let prevQ = qSlice[0][0];
    if (sampleQuarterly && qSlice[0][col]) sample.push({ date: qSlice[0][0], value: shares * qSlice[0][col] });
    for (let qi = 0; qi < qSlice.length; qi++) {
      const qDate = qSlice[qi][0];
      const qP = qSlice[qi][col];
      if (qi > 0 && (!requirePrice || qP)) {
        const yr = parseInt(qDate.substring(0, 4));
        const m = monthly * Math.pow(1 + annualRaise, yr - startYear);
        if (fastMonthly) {
          const monthsInQ = monthsLookup[entryIdx + qi];
          for (let k = 0; k < monthsInQ.length; k++) {
            const mp = monthlyData[monthsInQ[k]][col];
            if (requirePrice ? mp : true) shares += m / mp;
            if (sampleQuarterly && mp > 0 && isQuarterEnd(monthlyData[monthsInQ[k]][0])) sample.push({ date: monthlyData[monthsInQ[k]][0], value: shares * mp });
          }
        } else {
          for (const row of monthlyData) {
            if (row[0] > prevQ && row[0] <= qDate) {
              const mp = row[col];
              if (requirePrice ? mp : true) shares += m / mp;
              if (sampleQuarterly && mp > 0 && isQuarterEnd(row[0])) sample.push({ date: row[0], value: shares * mp });
            }
          }
        }
      }
      points.push({ date: qDate, value: qP ? shares * qP : 0, price: qP, shares });
      prevQ = qDate;
    }
    return { points, sample };
  }

  const bh   = buyHold(1, false); // TQQQ (always col 1, regardless of the strategy's underlying)
  const qqq  = buyHold(2, false);
  const spy  = buyHold(3, true);
  const qqq5 = buyHold(5, true);

  return {
    log, samplePoints,
    bhPoints: bh.points, qqqPoints: qqq.points, spyPoints: spy.points, qqq5Points: qqq5.points,
    bhSample: bh.sample, qqqSample: qqq.sample, spySample: spy.sample, qqq5Sample: qqq5.sample,
    totalContributed: totalInvested,
  };
}

