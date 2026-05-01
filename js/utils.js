
function qLabel(dateStr) {
  const y = dateStr.substring(0, 4);
  const m = parseInt(dateStr.substring(5, 7));
  const q = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
  return q + ' ' + y;
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

