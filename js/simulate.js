
function simulateBhTqqq(initial, monthly, annualRaise, entryIdx, exitIdx, qData) {
  qData = qData || quarterlyData;
  const qSlice = qData.slice(entryIdx, exitIdx + 1);
  if (qSlice.length < 1) return [];
  const startYear = parseInt(qSlice[0][0].substring(0, 4));
  let bhShares = initial / qSlice[0][1];
  let bhPrevQ = qSlice[0][0];
  const points = [];
  for (let qi = 0; qi < qSlice.length; qi++) {
    const [qDate, qPrice] = qSlice[qi];
    if (qi > 0) {
      const yr = parseInt(qDate.substring(0, 4));
      const bhMonthly = monthly * Math.pow(1 + annualRaise, yr - startYear);
      for (const [mDate, mPrice] of monthlyData) {
        if (mDate > bhPrevQ && mDate <= qDate) {
          bhShares += bhMonthly / mPrice;
        }
      }
    }
    points.push(bhShares * qPrice);
    bhPrevQ = qDate;
  }
  return points;
}
// Compute trailing "$1 invested N years ago" B&H-TQQQ ÷ simplified-9sig ratio (×100)
// at the given index in quarterlyData. Returns null if there isn't enough history.
function trailingShadowRatio(globalIdx, yearsBack) {
  const back = yearsBack * 4;
  if (globalIdx < back) return null;
  const start = globalIdx - back;
  const startPrice = quarterlyData[start][1];
  const endPrice = quarterlyData[globalIdx][1];
  if (!startPrice || !endPrice) return null;
  const bhValue = endPrice / startPrice;

  let cash = 0.3;
  let shares = 0.7 / startPrice;
  let signal = 0.7;
  for (let t = start + 1; t <= globalIdx; t++) {
    const p = quarterlyData[t][1];
    signal *= 1.09;
    const tqqqVal = shares * p;
    const diff = tqqqVal - signal;
    if (diff > 0) {
      shares -= diff / p;
      cash += diff;
    } else if (diff < 0 && cash > 0) {
      const buy = Math.min(-diff, cash * 0.9);
      shares += buy / p;
      cash -= buy;
    }
    const newVal = shares * p;
    if (newVal < signal) signal = newVal;
  }
  const sigValue = shares * endPrice + cash;
  if (sigValue <= 0) return null;
  return (bhValue / sigValue) * 100;
}

// Calendar-anchored adaptive state machine — runs from quarterlyData[0] forward
// regardless of the user's entry/exit, so the strategy at any given calendar
// quarter is deterministic (depends only on the threshold sliders, not on the
// simulation window). Returns ['all-in' | '9sig'] aligned to quarterlyData.
function computeAdaptiveStates(switchTo9sigPct, switchToAllInPct, yearsBack) {
  const states = new Array(quarterlyData.length);
  let state = 'all-in';
  for (let i = 0; i < quarterlyData.length; i++) {
    const ratio = trailingShadowRatio(i, yearsBack);
    if (ratio != null) {
      if (state === 'all-in' && ratio >= switchTo9sigPct) state = '9sig';
      else if (state === '9sig' && ratio <= switchToAllInPct) state = 'all-in';
    }
    states[i] = state;
  }
  return states;
}

function simulate(initial, monthly, annualRate, entryIdx, exitIdx, annualRaise, opts) {
  const monthlyRate = annualRate / 12;
  const qGrowth = 0.09; // 9% quarterly signal line growth
  annualRaise = annualRaise || 0;
  opts = opts || {};
  const qData = opts.qData || quarterlyData;
  const skipBH = !!opts.skipBH;
  const switchTo9sig  = opts.switchTo9sig  != null ? opts.switchTo9sig  : 200;
  const switchToAllIn = opts.switchToAllIn != null ? opts.switchToAllIn : 100;
  const yearsBack     = opts.yearsBack     != null ? opts.yearsBack     : 10;

  const qSlice = qData.slice(entryIdx, exitIdx + 1);
  if (qSlice.length < 2) return { log: [], bhPoints: [], qqqPoints: [], totalContributed: initial };

  // Initial 70/30 allocation: 70% TQQQ, 30% cash/bond
  let cash = initial * 0.3;
  let tqqqShares = (initial * 0.7) / qSlice[0][1];
  let signalLine = initial * 0.7; // target TQQQ value starts at initial TQQQ allocation
  let totalInvested = initial;
  let investedCompounded = initial;
  let currentMonthly = monthly;
  const startYear = parseInt(qSlice[0][0].substring(0, 4));

  const log = [];
  let prevQDate = qSlice[0][0];
  let crashNoSellCount = 0; // track consecutive 30-down no-sell skips (max 2)

  for (let qi = 0; qi < qSlice.length; qi++) {
    const [qDate, qPrice] = qSlice[qi];

    if (qi > 0) {
      // Annual raise: increase monthly contribution at each new year
      const currentYear = parseInt(qDate.substring(0, 4));
      const prevYear = parseInt(prevQDate.substring(0, 4));
      if (currentYear > prevYear) {
        currentMonthly = monthly * Math.pow(1 + annualRaise, currentYear - startYear);
      }

      // Add monthly contributions: 100% goes to cash, signal line rises by 50% of new cash
      let newCashThisQ = 0;
      for (const [mDate] of monthlyData) {
        if (mDate > prevQDate && mDate <= qDate) {
          cash += currentMonthly;
          totalInvested += currentMonthly;
          newCashThisQ += currentMonthly;
          // Apply monthly interest on cash
          cash *= (1 + monthlyRate);
          // Compound invested baseline
          investedCompounded *= (1 + monthlyRate);
          investedCompounded += currentMonthly;
        }
      }

      // Signal line grows 9% per quarter + 50% of new cash contributions
      signalLine = signalLine * (1 + qGrowth) + newCashThisQ * 0.5;

      const currentTqqqValue = tqqqShares * qPrice;
      const diff = currentTqqqValue - signalLine;
      let action = '';

      // 30-down no-sell rule: if TQQQ price < 70% of 2-year high, skip sell
      // but only up to 2 consecutive quarters, then sell anyway
      const twoYearsAgo = (parseInt(qDate.substring(0, 4)) - 2) + qDate.substring(4);
      let peak2y = qPrice;
      for (let k = qi; k >= 0; k--) {
        if (qSlice[k][0] < twoYearsAgo) break;
        if (qSlice[k][1] > peak2y) peak2y = qSlice[k][1];
      }
      const inCrashZone = qPrice < peak2y * 0.7;

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
        const available = cash * 0.9;
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

      const tqqqVal = tqqqShares * qPrice;
      // Reset signal line to actual TQQQ value after rebalancing if we couldn't close the gap
      if (tqqqVal < signalLine) signalLine = tqqqVal;
      log.push({ date: qDate, price: qPrice, tqqqVal, cash, total: tqqqVal + cash, action, invested: totalInvested, investedCompounded, target: signalLine });
    } else {
      // First quarter — just record starting state
      const tqqqVal = tqqqShares * qSlice[0][1];
      log.push({ date: qDate, price: qSlice[0][1], tqqqVal, cash, total: tqqqVal + cash, action: 'START', invested: totalInvested, investedCompounded, target: signalLine });
    }
    prevQDate = qDate;
  }

  if (skipBH) return { log, totalContributed: totalInvested };

  // Buy & hold TQQQ
  let bhShares = initial / qSlice[0][1];
  let bhPrevQ = qSlice[0][0];
  const bhPoints = [];

  for (let qi = 0; qi < qSlice.length; qi++) {
    const [qDate, qPrice] = qSlice[qi];
    if (qi > 0) {
      const yr = parseInt(qDate.substring(0, 4));
      const bhMonthly = monthly * Math.pow(1 + annualRaise, yr - startYear);
      for (const [mDate, mPrice] of monthlyData) {
        if (mDate > bhPrevQ && mDate <= qDate) {
          bhShares += bhMonthly / mPrice;
        }
      }
    }
    bhPoints.push({ date: qDate, value: bhShares * qPrice });
    bhPrevQ = qDate;
  }

  // Buy & hold QQQ
  let qqqShares = initial / qSlice[0][2];
  let qqqPrevQ = qSlice[0][0];
  const qqqPoints = [];

  for (let qi = 0; qi < qSlice.length; qi++) {
    const [qDate, , qqqPrice] = qSlice[qi];
    if (qi > 0) {
      const yr = parseInt(qDate.substring(0, 4));
      const qqqMonthly = monthly * Math.pow(1 + annualRaise, yr - startYear);
      for (const [mDate, , mQqqPrice] of monthlyData) {
        if (mDate > qqqPrevQ && mDate <= qDate) {
          qqqShares += qqqMonthly / mQqqPrice;
        }
      }
    }
    qqqPoints.push({ date: qDate, value: qqqShares * qqqPrice });
    qqqPrevQ = qDate;
  }

  // Buy & hold SPY
  let spyShares = qSlice[0][3] ? initial / qSlice[0][3] : 0;
  let spyPrevQ = qSlice[0][0];
  const spyPoints = [];

  for (let qi = 0; qi < qSlice.length; qi++) {
    const [qDate, , , spyPrice] = qSlice[qi];
    if (qi > 0 && spyPrice) {
      const yr = parseInt(qDate.substring(0, 4));
      const spyMonthly = monthly * Math.pow(1 + annualRaise, yr - startYear);
      for (const [mDate, , , mSpyPrice] of monthlyData) {
        if (mDate > spyPrevQ && mDate <= qDate && mSpyPrice) {
          spyShares += spyMonthly / mSpyPrice;
        }
      }
    }
    spyPoints.push({ date: qDate, value: spyPrice ? spyShares * spyPrice : 0 });
    spyPrevQ = qDate;
  }

  // Adaptive: state machine is calendar-anchored — determined by trailing-10y
  // ratio of $1-invested-10y-ago B&H TQQQ vs simplified 9sig, evaluated against
  // the global timeline. So entering at 1995 vs 2010 doesn't change *when* the
  // strategy switches — only what portfolio you've accumulated by then.
  // Callers running many sims with the same strategy params can pass a
  // pre-computed `opts.adaptiveStates` to skip this recomputation.
  const adaptiveStates = opts.adaptiveStates || computeAdaptiveStates(switchTo9sig, switchToAllIn, yearsBack);
  let aState = adaptiveStates[entryIdx];
  let aCash, aShares, aSignal;
  if (aState === '9sig') {
    aCash   = initial * 0.3;
    aShares = (initial * 0.7) / qSlice[0][1];
    aSignal = initial * 0.7;
  } else {
    aCash   = 0;
    aShares = initial / qSlice[0][1];
    aSignal = 0;
  }
  let aPrevQ = qSlice[0][0];
  let aCrashCount = 0;  // mirror of main 9sig's crashNoSellCount for the 30-down rule
  const adaptivePoints = [];

  for (let qi = 0; qi < qSlice.length; qi++) {
    const [qDate, qPrice] = qSlice[qi];
    let aNewCashThisQ = 0;
    if (qi > 0) {
      const yr = parseInt(qDate.substring(0, 4));
      const aMonthly = monthly * Math.pow(1 + annualRaise, yr - startYear);
      for (const [mDate, mPrice] of monthlyData) {
        if (mDate > aPrevQ && mDate <= qDate) {
          if (aState === 'all-in') {
            aShares += aMonthly / mPrice;
          } else {
            aCash += aMonthly;
            aCash *= (1 + monthlyRate);
            aNewCashThisQ += aMonthly;
          }
        }
      }

      const newState = adaptiveStates[entryIdx + qi];
      if (newState !== aState) {
        if (newState === '9sig') {
          const tv = aShares * qPrice;
          aCash = tv * 0.3;
          aShares = (tv * 0.7) / qPrice;
          aSignal = tv * 0.7;
        } else {
          aShares += aCash / qPrice;
          aCash = 0;
          aSignal = 0;
        }
        aCrashCount = 0;
        aState = newState;
      }

      if (aState === '9sig') {
        aSignal = aSignal * (1 + qGrowth) + aNewCashThisQ * 0.5;
        const tv = aShares * qPrice;
        const diff = tv - aSignal;

        // 30-down no-sell rule — same as main 9sig leg
        const twoYearsAgoA = (parseInt(qDate.substring(0, 4)) - 2) + qDate.substring(4);
        let peak2yA = qPrice;
        for (let k = qi; k >= 0; k--) {
          if (qSlice[k][0] < twoYearsAgoA) break;
          if (qSlice[k][1] > peak2yA) peak2yA = qSlice[k][1];
        }
        const inCrashZoneA = qPrice < peak2yA * 0.7;

        if (diff > 0 && !inCrashZoneA) {
          aShares -= diff / qPrice;
          aCash += diff;
          aCrashCount = 0;
        } else if (diff > 0 && inCrashZoneA && aCrashCount < 2) {
          aCrashCount++;
        } else if (diff > 0 && inCrashZoneA && aCrashCount >= 2) {
          aShares -= diff / qPrice;
          aCash += diff;
          aCrashCount = 0;
        } else if (diff < 0 && aCash > 0) {
          aCrashCount = 0;
          const buy = Math.min(-diff, aCash * 0.9);
          aShares += buy / qPrice;
          aCash -= buy;
        } else {
          aCrashCount = 0;
        }
        const ntv = aShares * qPrice;
        if (ntv < aSignal) aSignal = ntv;
      }
    }
    adaptivePoints.push({ date: qDate, value: aShares * qPrice + aCash, state: aState });
    aPrevQ = qDate;
  }

  return { log, bhPoints, qqqPoints, spyPoints, adaptivePoints, totalContributed: totalInvested };
}

