// Parse "M/D/YYYY HH:MM:SS" -> "YYYY-MM-DD", auto-detect delimiter (tab or comma)
function parseDataFile(text) {
  const lines = text.trim().split(/\r?\n/).slice(1);
  const sep = lines[0].includes('\t') ? '\t' : ',';
  return lines.map(line => {
    const [dateStr, close] = line.split(sep);
    const parts = dateStr.split(' ')[0].split('/');
    const m = parts[0].padStart(2, '0');
    const d = parts[1].padStart(2, '0');
    const y = parts[2];
    return [y + '-' + m + '-' + d, parseFloat(close)];
  });
}

async function loadQQQDaily() {
  const resp = await fetch('data/synthetic-qqq.tsv?v=baked');
  return parseDataFile(await resp.text());
}

async function loadQLDDaily() {
  const resp = await fetch('data/synthetic-qld.tsv?v=baked');
  return parseDataFile(await resp.text());
}

async function loadTQQQDaily() {
  const resp = await fetch('data/synthetic-tqqq.tsv?v=baked');
  return parseDataFile(await resp.text());
}

async function loadSPYDaily() {
  const resp = await fetch('data/spy.tsv?v=baked');
  return parseDataFile(await resp.text());
}

async function loadSSODaily() {
  const resp = await fetch('data/synthetic-sso.tsv?v=baked');
  return parseDataFile(await resp.text());
}

async function loadSPXLDaily() {
  const resp = await fetch('data/synthetic-spxl.tsv?v=baked');
  return parseDataFile(await resp.text());
}

async function loadQQQ5Daily() {
  const resp = await fetch('data/synthetic-qqq5.tsv?v=baked');
  return parseDataFile(await resp.text());
}

// Merge daily TSVs by date. The synthetic TSVs already contain synthesized
// pre-inception rows (baked by update_data.py), so this is a straight join —
// no synthesis here. monthlyData column layout:
//   [date, tqqq, qqq, spy, qld, qqq5, sso, spxl]   (cols 0..7)
function buildDaily(qqqDaily, tqqqDaily, spyDaily, qqq5Daily, qldDaily, ssoDaily, spxlDaily) {
  const tqqqMap = new Map(tqqqDaily.map(d => [d[0], d[1]]));
  const spyMap  = new Map(spyDaily.map(d => [d[0], d[1]]));
  const qqq5Map = qqq5Daily ? new Map(qqq5Daily.map(d => [d[0], d[1]])) : null;
  const qldMap  = qldDaily  ? new Map(qldDaily.map(d  => [d[0], d[1]])) : null;
  const ssoMap  = ssoDaily  ? new Map(ssoDaily.map(d  => [d[0], d[1]])) : null;
  const spxlMap = spxlDaily ? new Map(spxlDaily.map(d => [d[0], d[1]])) : null;
  const result = [];
  for (const [date, qqqPrice] of qqqDaily) {
    const tqqqPrice = tqqqMap.get(date);
    if (tqqqPrice != null) {
      result.push({
        date,
        qqq:  qqqPrice,
        tqqq: tqqqPrice,
        spy:  spyMap.get(date) || 0,
        qld:  qldMap  ? (qldMap.get(date)  || 0) : 0,
        qqq5: qqq5Map ? (qqq5Map.get(date) || 0) : 0,
        sso:  ssoMap  ? (ssoMap.get(date)  || 0) : 0,
        spxl: spxlMap ? (spxlMap.get(date) || 0) : 0,
      });
    }
  }
  return result;
}

let daily; // populated by init()

// === Derive quarterly and monthly from daily ===
function lastOfPeriod(daily, periodFn) {
  const groups = {};
  daily.forEach(d => {
    const key = periodFn(d.date);
    groups[key] = d; // last one wins
  });
  return Object.values(groups);
}

function getQuarter(dateStr) {
  const m = parseInt(dateStr.substring(5, 7));
  const q = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
  return dateStr.substring(0, 4) + '-' + q;
}

function getMonth(dateStr) {
  return dateStr.substring(0, 7);
}

function getYear(dateStr) {
  return dateStr.substring(0, 4);
}

// ISO week key for a YYYY-MM-DD date string. Used to bucket daily entries
// into trading-week groups so weekly rebalancing has stable period boundaries.
function getWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  // Adjust to nearest Thursday (ISO week algorithm) then read year+week.
  const day = (d.getUTCDay() + 6) % 7;          // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d - firstThursday) / 86400000;
  const week = 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

// Period-name → trading days per period. Used both for envelope-shift sizing
// (how many "rebalance-day-of-period" variants to render) and for the simulate
// loop's per-period growth-rate scaling.
const PERIOD_DAYS = { weekly: 5, monthly: 21, quarterly: 63, yearly: 252 };

let quarterlyData, monthlyData; // populated by init()
// Built on demand by precomputePeriodSeries() — same shape as quarterlyData
// (one row per period, last trading-day price in that period).
let weeklyData = null, yearlyData = null;
let periodDataByName = null;     // { weekly, monthly, quarterly, yearly }
let monthsInPeriodByName = null; // { period: [ [monthly indices], ... ] }
let dailyDateToIdx; // populated by init()
// monthlyByQuarter[qi] = indices into monthlyData whose date falls in
// (quarterlyData[qi-1].date, quarterlyData[qi].date]. Replaces simulate()'s
// hot per-quarter scan of all of monthlyData with an O(1) lookup of the 2-3
// monthly entries that actually matter for that quarter. Computed once after
// data load. Only used when simulate runs against the default quarterlyData;
// envelope-shifted runs fall back to the linear scan.
let monthlyByQuarter = null;

// Build periodData (one entry per period, last trading day in that period)
// for the named period. Mirrors the existing monthlyData / quarterlyData
// shape — same columns, same date format. Called once after `daily` loads.
function buildPeriodData(periodFn) {
  return lastOfPeriod(daily, periodFn).map(d => [d.date, d.tqqq, d.qqq, d.spy, d.qld, d.qqq5, d.sso, d.spxl]);
}

// Build the months-in-period index for the given periodData. monthsInPeriod[i]
// is the list of monthlyData indices whose date falls in
// (periodData[i-1].date, periodData[i].date]. Same semantics as the existing
// monthlyByQuarter cache — drives the contribution loop in simulate().
function buildMonthsInPeriod(periodData) {
  if (!periodData || !monthlyData) return null;
  const out = new Array(periodData.length);
  out[0] = [];
  let mIdx = 0;
  while (mIdx < monthlyData.length && monthlyData[mIdx][0] <= periodData[0][0]) mIdx++;
  for (let pi = 1; pi < periodData.length; pi++) {
    const cur = periodData[pi][0];
    const list = [];
    while (mIdx < monthlyData.length && monthlyData[mIdx][0] <= cur) {
      list.push(mIdx);
      mIdx++;
    }
    out[pi] = list;
  }
  return out;
}

function precomputePeriodSeries() {
  if (!daily || !monthlyData) return;
  weeklyData    = buildPeriodData(getWeek);
  yearlyData    = buildPeriodData(getYear);
  periodDataByName = {
    weekly:    weeklyData,
    monthly:   monthlyData,
    quarterly: quarterlyData,
    yearly:    yearlyData,
  };
  monthsInPeriodByName = {
    weekly:    buildMonthsInPeriod(weeklyData),
    monthly:   buildMonthsInPeriod(monthlyData),
    quarterly: null, // set after precomputeMonthlyByQuarter
    yearly:    buildMonthsInPeriod(yearlyData),
  };
}

function precomputeMonthlyByQuarter() {
  if (!quarterlyData || !monthlyData) { monthlyByQuarter = null; return; }
  const out = new Array(quarterlyData.length);
  out[0] = [];
  let mIdx = 0;
  // Skip months at-or-before the first quarter (they don't belong to any window).
  while (mIdx < monthlyData.length && monthlyData[mIdx][0] <= quarterlyData[0][0]) mIdx++;
  for (let qi = 1; qi < quarterlyData.length; qi++) {
    const curDate = quarterlyData[qi][0];
    const list = [];
    while (mIdx < monthlyData.length && monthlyData[mIdx][0] <= curDate) {
      list.push(mIdx);
      mIdx++;
    }
    out[qi] = list;
  }
  monthlyByQuarter = out;
  if (monthsInPeriodByName) monthsInPeriodByName.quarterly = out;
}
let shiftedQuarterlyCache = []; // current cache for whichever rebalance period is active
let envelopeShiftDays    = []; // populated by init() — trading-day shift for each cache slot
let envelopeShiftCount   = 0;  // populated by init() — = envelopeShiftDays.length
// Per-period memo so switching weekly → yearly → quarterly doesn't rebuild
// shifted-data cache each time. Build is O(N_shifts × N_periods).
let _envelopeCacheByPeriod = {};
let _currentEnvelopePeriod = null;

function ensureEnvelopeCacheForPeriod(period) {
  period = period || 'quarterly';
  if (_currentEnvelopePeriod === period && _envelopeCacheByPeriod[period]) {
    return;
  }
  if (!_envelopeCacheByPeriod[period]) {
    const shifts = buildEnvelopeShifts(period);
    const cache  = shifts.map(s => getShiftedPeriodData(period, s));
    _envelopeCacheByPeriod[period] = { shifts, cache };
  }
  const entry = _envelopeCacheByPeriod[period];
  envelopeShiftDays     = entry.shifts;
  envelopeShiftCount    = entry.shifts.length;
  shiftedQuarterlyCache = entry.cache;
  _currentEnvelopePeriod = period;
}

// One trading-quarter is roughly 63 trading days (5 days × 13 weeks, holidays
// notwithstanding). Used to space the coarse "quarter-offset" envelope lines.
const ENVELOPE_DAYS_PER_QUARTER = 63;            // legacy default (preserved for chart code that hardcoded it)
const ENVELOPE_MAX_GHOSTS       = 60;            // density cap — sample evenly if a period has more trading days than this

// Build the list of trading-day shifts the envelope renders for the given
// rebalance period. Each shift rolls every period-end check back by N
// trading days, so the envelope shows "what if I rebalanced N days earlier
// within each period" for N from 1 to ~one full period. We deliberately do
// NOT include cross-period shifts (e.g. for quarterly, shifts of 126/189/...
// days that effectively start the strategy in a different era).
//
// For periods with more days than ENVELOPE_MAX_GHOSTS, we sample evenly so
// rendering stays under 100 lines (e.g. yearly = 252 trading days → 100
// ghosts, ~every 2-3 days).
function buildEnvelopeShifts(period) {
  const days = PERIOD_DAYS[period] || ENVELOPE_DAYS_PER_QUARTER;
  const shifts = [];
  if (days <= ENVELOPE_MAX_GHOSTS) {
    for (let d = 1; d <= days; d++) shifts.push(d);
  } else {
    // Even sampling. Always include 1 and `days` for the endpoints.
    const step = days / ENVELOPE_MAX_GHOSTS;
    for (let i = 0; i < ENVELOPE_MAX_GHOSTS; i++) {
      shifts.push(Math.max(1, Math.round(1 + i * step)));
    }
  }
  return shifts;
}

function getShiftedQuarterly(dayShift) {
  return getShiftedPeriodData('quarterly', dayShift);
}

// Period-aware shifted data: same logic as getShiftedQuarterly but parameterized
// by the rebalance period. Each row's date is mapped to the daily entry N
// trading days earlier in time, so the envelope's "rebalance N days earlier"
// semantics work across weekly / monthly / quarterly / yearly.
function getShiftedPeriodData(period, dayShift) {
  const src = (periodDataByName && periodDataByName[period]) || quarterlyData;
  if (!src) return [];
  return src.map(p => {
    const naturalIdx = dailyDateToIdx.get(p[0]);
    if (naturalIdx == null) return p;
    const shiftedIdx = Math.max(0, naturalIdx - dayShift);
    const d = daily[shiftedIdx];
    return [d.date, d.tqqq, d.qqq, d.spy, d.qld, d.qqq5, d.sso, d.spxl];
  });
}

// Build a custom qData array for an envelope-ghost sim. Every ghost STARTS at
// the canonical entry date with the same $10K allocation (anchoring the chart
// visually), then rebalances every `period_days` trading days starting at
// `entry + dayOffset`. Different ghosts pick different `dayOffset` values
// across 1..period_days, so the envelope shows "what if the strategy
// rebalanced on a different day OF THE PERIOD" — i.e. rebalance-day
// sensitivity. dayOffset=period_days collapses to the canonical schedule.
//
// Why not the older getShiftedPeriodData approach (shift every row's date
// AND price back by N days): for periods longer than ~1 quarter, those shifts
// effectively move the strategy's entry date backwards, so the sim runs for
// the shifted window BEFORE the chart's first label and the ghost line shows
// up far above $10K at the chart's leftmost x. This date-anchored builder
// keeps every ghost's first data point at the canonical entry with $10K.
function buildEnvelopeQData(period, dayOffset, entryDate, exitDate) {
  if (!daily || !dailyDateToIdx) return [];
  const entryDailyIdx = dailyDateToIdx.get(entryDate);
  if (entryDailyIdx == null) return [];
  const periodDays = PERIOD_DAYS[period] || 63;
  const entryD = daily[entryDailyIdx];
  const rowFor = (d) => [d.date, d.tqqq, d.qqq, d.spy, d.qld, d.qqq5, d.sso, d.spxl];
  const result = [rowFor(entryD)];
  let dailyIdx = entryDailyIdx + Math.max(1, dayOffset);
  while (dailyIdx < daily.length) {
    const d = daily[dailyIdx];
    if (exitDate && d.date > exitDate) break;
    result.push(rowFor(d));
    dailyIdx += periodDays;
  }
  return result;
}

// === Simple Moving Average precomputation ===
// Used by the SMA timing strategy: at each rebalance check, compare the
// signal asset's close to its N-day SMA on the same day. If above → hold
// TQQQ; if below → move to cash (cash bucket accrues the configured rate).
//
// We precompute the full daily SMA series for every (asset, window) pair
// the UI exposes, then sample at each monthly-data entry so the strategy
// loop is an O(months) walk with no per-step recomputation. The heatmap
// runs many simulations so this matters.
const SMA_WINDOWS = [100, 150, 200, 250];
const SMA_ASSETS  = ['qqq', 'spy'];
const RSI_WINDOW  = 10; // fixed; Reddit's TFTLT default. Could be exposed if needed.
let smaAtMonthlyByKey = null; // { 'qqq_200': [sma per monthlyData entry, or null] }
let rsiAtMonthlyByAsset = null; // { 'qqq': [RSI(10) per monthlyData entry, or null] }

function rollingSMA(values, window) {
  const out = new Array(values.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v > 0) { sum += v; count++; }
    if (i >= window) {
      const drop = values[i - window];
      if (drop > 0) { sum -= drop; count--; }
    }
    out[i] = count === window ? sum / window : null;
  }
  return out;
}

// Wilder-smoothed RSI. Returns array of RSI values per daily index, null
// until enough history accumulates. Default window 10 trading days — matches
// the "TFTLT" Reddit strategy's overheat threshold convention.
function rollingRSI(values, window) {
  const out = new Array(values.length).fill(null);
  if (values.length < window + 1) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= window; i++) {
    const d = values[i] - values[i-1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / window;
  let avgLoss = lossSum / window;
  out[window] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = window + 1; i < values.length; i++) {
    const d = values[i] - values[i-1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    // Wilder's smoothing: prior average × (window-1) + new value, all over window.
    avgGain = (avgGain * (window - 1) + g) / window;
    avgLoss = (avgLoss * (window - 1) + l) / window;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function precomputeSMASeries() {
  smaAtMonthlyByKey = {};
  rsiAtMonthlyByAsset = {};
  if (!daily || !monthlyData || !dailyDateToIdx) return;
  const seriesByAsset = {
    qqq: daily.map(d => d.qqq),
    spy: daily.map(d => d.spy),
  };
  for (const asset of SMA_ASSETS) {
    const dailyVals = seriesByAsset[asset];
    for (const w of SMA_WINDOWS) {
      const dailySMA = rollingSMA(dailyVals, w);
      // Map each monthlyData entry's date → SMA value on that day. Stored
      // as a parallel array so simulateSMA can index by monthly position.
      smaAtMonthlyByKey[asset + '_' + w] = monthlyData.map(([date]) => {
        const idx = dailyDateToIdx.get(date);
        return idx != null ? dailySMA[idx] : null;
      });
    }
    // RSI(10) at each monthly entry — same indexing scheme as SMA.
    const dailyRSI = rollingRSI(dailyVals, RSI_WINDOW);
    rsiAtMonthlyByAsset[asset] = monthlyData.map(([date]) => {
      const idx = dailyDateToIdx.get(date);
      return idx != null ? dailyRSI[idx] : null;
    });
  }
}
