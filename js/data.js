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

async function loadTQQQDaily() {
  const resp = await fetch('data/synthetic-tqqq.tsv?v=baked');
  return parseDataFile(await resp.text());
}

async function loadSPYDaily() {
  const resp = await fetch('data/spy.tsv?v=baked');
  return parseDataFile(await resp.text());
}

// Merge daily TSVs by date. The TQQQ TSV already contains synthesized pre-2010
// rows (baked by update_data.py), so this is a straight join — no synthesis here.
function buildDaily(qqqDaily, tqqqDaily, spyDaily) {
  const tqqqMap = new Map(tqqqDaily.map(d => [d[0], d[1]]));
  const spyMap = new Map(spyDaily.map(d => [d[0], d[1]]));
  const result = [];
  for (const [date, qqqPrice] of qqqDaily) {
    const tqqqPrice = tqqqMap.get(date);
    if (tqqqPrice != null) {
      result.push({ date, qqq: qqqPrice, tqqq: tqqqPrice, spy: spyMap.get(date) || 0 });
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

let quarterlyData, monthlyData; // populated by init()
let dailyDateToIdx; // populated by init()
let shiftedQuarterlyCache = []; // populated by init() — array of qData arrays, indexed [shift-1]
let envelopeShiftCount = 0; // populated by init()

function computeMaxShift() {
  if (!quarterlyData || quarterlyData.length < 2) return 0;
  let minLen = Infinity;
  for (let i = 1; i < quarterlyData.length; i++) {
    const a = dailyDateToIdx.get(quarterlyData[i - 1][0]);
    const b = dailyDateToIdx.get(quarterlyData[i][0]);
    if (a != null && b != null) minLen = Math.min(minLen, b - a);
  }
  return Number.isFinite(minLen) ? Math.max(1, minLen - 1) : 0;
}

function getShiftedQuarterly(dayShift) {
  return quarterlyData.map(q => {
    const naturalIdx = dailyDateToIdx.get(q[0]);
    if (naturalIdx == null) return q;
    const shiftedIdx = Math.max(0, naturalIdx - dayShift);
    const d = daily[shiftedIdx];
    return [d.date, d.tqqq, d.qqq, d.spy];
  });
}
