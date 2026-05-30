
function qLabel(dateStr) {
  const y = dateStr.substring(0, 4);
  const m = parseInt(dateStr.substring(5, 7));
  const q = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
  return q + ' ' + y;
}

// "YYYY-MM-DD" → "1 Oct 26" — short human date used in the rebalance log.
// We add ONE calendar day before formatting so each row reads as the
// period it kicks off (rebalances happen on the last trading day of one
// period, "30 Sep 26" close, but they set up the next period — labeling
// them "1 Oct 26" matches user intuition that Q4 starts in October, not
// in late September). Works the same way for weekly/monthly/yearly: end
// of one period → "first day of the next".
const _LOG_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtLogDate(dateStr) {
  if (!dateStr || dateStr.length < 10) return dateStr || '';
  // UTC-anchored to avoid DST quirks shifting the day.
  const dt = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return dateStr;
  dt.setUTCDate(dt.getUTCDate() + 1);
  const d = dt.getUTCDate();
  const m = dt.getUTCMonth();
  const y = String(dt.getUTCFullYear()).slice(2);
  return `${d} ${_LOG_MONTHS[m]} ${y}`;
}

// Display name for the 9sig strategy. The canonical 9sig (quarterly, 9%
// The 9sig strategy's display name is always the static label "9sig" — it no
// longer changes to "sig" when the parameters are tweaked. (Names are not
// derived from parameters anywhere; saved strategies are renameable instead.)
function nineSigName() {
  return '9sig';
}

// Logarithmic slider for initial investment: slider 0-1000 maps to $0-$100M
// slider 0 = $0, slider 1-1000 = log scale from $100 to $100M
function sliderToInitial(s) {
  if (s <= 0) return 0;
  // Map 1-1000 to log($100) - log($100M) = 2 - 8
  const minLog = 2, maxLog = 8; // 10^2=100, 10^8=100M
  const logVal = minLog + (s / 1000) * (maxLog - minLog);
  const raw = Math.pow(10, logVal);
  // Round: $100 under $10K, $1K under $100K, $10K under $1M, $100K under $10M, $1M above
  if (raw < 10000) return Math.round(raw / 100) * 100;
  if (raw < 100000) return Math.round(raw / 1000) * 1000;
  if (raw < 1000000) return Math.round(raw / 10000) * 10000;
  if (raw < 10000000) return Math.round(raw / 100000) * 100000;
  return Math.round(raw / 1000000) * 1000000;
}

function initialToSlider(v) {
  if (v <= 0) return 0;
  const minLog = 2, maxLog = 8;
  const logVal = Math.log10(Math.max(v, 100));
  return Math.round(((logVal - minLog) / (maxLog - minLog)) * 1000);
}

// Logarithmic slider for monthly contribution: slider 0 maps to $0, and
// slider 1-1000 maps to $50-$1M with contribution-friendly rounding.
const MONTHLY_MIN = 50;
const MONTHLY_MAX = 1000000;
const MONTHLY_MIN_LOG = Math.log10(MONTHLY_MIN);
const MONTHLY_MAX_LOG = Math.log10(MONTHLY_MAX);

function sliderToMonthly(s) {
  if (s <= 0) return 0;
  const clamped = Math.max(1, Math.min(1000, s));
  const norm = (clamped - 1) / 999;
  const raw = Math.pow(10, MONTHLY_MIN_LOG + norm * (MONTHLY_MAX_LOG - MONTHLY_MIN_LOG));
  if (raw < 1500) return Math.round(raw / 50) * 50;
  if (raw < 10000) return Math.round(raw / 100) * 100;
  if (raw < 100000) return Math.round(raw / 1000) * 1000;
  if (raw < 1000000) return Math.round(raw / 10000) * 10000;
  return MONTHLY_MAX;
}

function monthlyToSlider(v) {
  if (v <= 0) return 0;
  const clamped = Math.max(MONTHLY_MIN, Math.min(MONTHLY_MAX, v));
  const norm = (Math.log10(clamped) - MONTHLY_MIN_LOG) / (MONTHLY_MAX_LOG - MONTHLY_MIN_LOG);
  return Math.max(1, Math.min(1000, Math.round(1 + norm * 999)));
}

// Quadratic-curve mapping for the cash-interest-rate slider: slider position
// 0–1000 maps to rate 0–100 %. The squared curve packs fine resolution into
// the realistic 0–10 % range (where most users live) while the upper third
// of the slider sweeps quickly through extreme rates — "moves faster at the
// end" per the design intent.
//   slider 200  ≈  4 %
//   slider 500  =  25 %
//   slider 707  ≈  50 %
//   slider 1000 = 100 %
function sliderToRate(s) {
  if (s <= 0) return 0;
  const norm = Math.max(0, Math.min(1, s / 1000));
  // Snap to 0.5% increments at the function boundary so every consumer
  // (chart, analytics, share URL, displayed value) sees the same clean
  // value — without this, the integer slider position round-trips back
  // through the quadratic curve as a fractional rate like 5.52%.
  return Math.round(norm * norm * 100 * 2) / 2;
}
function rateToSlider(r) {
  if (r <= 0) return 0;
  const norm = Math.sqrt(Math.max(0, Math.min(100, r)) / 100);
  return Math.round(norm * 1000);
}

function fmt(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const sig4 = v => (v >= 100 ? v.toFixed(1) : v >= 10 ? v.toFixed(2) : v.toFixed(3));
  if (abs >= 1e12) return sign + '$' + sig4(abs / 1e12) + 'T';
  if (abs >= 1e9)  return sign + '$' + sig4(abs / 1e9)  + 'B';
  if (abs >= 1e6)  return sign + '$' + sig4(abs / 1e6)  + 'M';
  if (abs >= 1e3)  return sign + '$' + sig4(abs / 1e3)  + 'K';
  return sign + '$' + Math.round(abs);
}

function fmtFull(n) {
  return fmt(n);
}

// Pre-render small letter-badge canvases for the Adaptive transition markers:
// "9" on a cyan circle when switching to 9sig, "T" on a red circle when
// switching to all-in TQQQ. Chart.js accepts a HTMLCanvasElement as pointStyle.
function makeLetterBadge(letter, color) {
  const dpr = window.devicePixelRatio || 1;
  const size = 22;
  const c = document.createElement('canvas');
  c.width = size * dpr;
  c.height = size * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  // filled circle background
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  // letter on top — chart-bg color for contrast
  ctx.fillStyle = '#0a0e17';
  ctx.font = 'bold 13px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, size / 2, size / 2 + 1);
  return c;
}
const switchIcon9sig = makeLetterBadge('9', '#22d3ee');
const switchIconTqqq = makeLetterBadge('T', '#f87171');
