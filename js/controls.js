// Slider max is set in init() after data loads

const SLIDER_IDS = ['slider-initial','slider-monthly','slider-raise','slider-rate','slider-entry','slider-exit','select-bh-underlying','select-sma-asset','select-sma-window','select-sma-underlying','select-9sig-underlying','select-9sig-growth','select-9sig-crashdrop','select-9sig-crashwin','select-9sig-spike','select-9sig-period','select-9sig-cash','select-9sig-cashrate','select-9sig-buypower','select-9sig-deploy','select-9sig-target-compound','select-sma-cashrate','select-sma-entry-buf','select-sma-exit-buf','select-sma-rsi-oh','select-sma-rsi-cool','select-sma-out-asset','select-sma-dca-in','select-sma-dca-to-out','select-sma-bg-delev','select-sma-bg-gtfo'];
const LS_KEY = '9sig-sliders';
// Bump APP_VERSION whenever a backwards-incompatible change ships (a control
// id is renamed, a default flips, a strategy is dropped). On mismatch we
// reveal a "new version — reset saved data" button in the header instead of
// nuking storage silently; the user clicks it when they're ready to load
// the new defaults. If they've never visited before (no stored version),
// we just record the current one without prompting.
const APP_VERSION = 15; // bumped when SMA gained out-asset, DCA-in/out ladders, and bodyguard rules
// NOTE: when you change any js/*.js or styles.css, also bump the matching ?v=
// cache-bust query on the <script>/<link> tags in index.html (keep it equal to
// APP_VERSION) so returning browsers fetch the new files instead of stale cache.
const LS_VERSION_KEY = '9sig-app-version';
// '9sig-saved-configs' holds user-saved strategies (saved-configs.js). Base
// line-colour overrides and the alternate-runs toggle are session-only, so the
// top pills stay canonical across refreshes. Cleared on a version reset.
const LS_KEYS = [LS_KEY, '9sig-saved-configs'];

// The top legend pills are canonical reference strategies (9sig, SMA 200,
// Buy & Hold, Invested Compounded). We do NOT persist their per-strategy knobs
// — on reload they always return to canonical defaults; customizations live in
// saved strategies instead. These ids (the union of saved-configs' per-type
// param lists) are skipped on both save and restore.
function _isStrategyParamId(id) {
  if (typeof CONFIG_PARAM_IDS === 'undefined') return false;
  for (const k in CONFIG_PARAM_IDS) {
    if (CONFIG_PARAM_IDS[k].indexOf(id) !== -1) return true;
  }
  return false;
}
let _storageVersionMismatch = false;
(function detectStorageVersion() {
  try {
    const stored = localStorage.getItem(LS_VERSION_KEY);
    if (stored == null) {
      // First-time visitor — no warning, just stamp the current version.
      localStorage.setItem(LS_VERSION_KEY, String(APP_VERSION));
    } else if (stored !== String(APP_VERSION)) {
      _storageVersionMismatch = true;
    }
  } catch (e) {}
})();
function showResetVersionButtonIfNeeded() {
  if (!_storageVersionMismatch) return;
  const btn = document.getElementById('reset-version-btn');
  if (btn) btn.hidden = false;
}

// === Shared-link versioning =============================================
// Ordered list of shared-link migrations. Each entry upgrades the params of
// a link stamped with version `from` toward the current APP_VERSION. When
// someone opens an older link, migrateSharedLink() runs every applicable
// step in order so the link keeps resolving to the same configuration (or an
// intentional redirect target) even after the param scheme changes.
//
// To add one: append { from: <oldVersion>, migrate(params) { ... } } and
// mutate `params` (a URLSearchParams) in place — rename keys, remap values,
// set defaults for newly-required params, or rewrite to a canonical link.
const LINK_MIGRATIONS = [
  // Template (no migrations needed yet — v1..v9 only added/removed controls,
  // which best-effort param reading already tolerates):
  // { from: 9, migrate(p) { if (p.has('old')) { p.set('new', p.get('old')); p.delete('old'); } } },
];

// Upgrade a shared link's params from the version it was stamped with up to
// the current APP_VERSION. Mutates `params` in place; returns true if it
// changed anything. A link with no `v` is treated as version 0 (legacy,
// pre-versioning).
function migrateSharedLink(params) {
  let linkV = parseInt(params.get('v'), 10);
  if (!Number.isFinite(linkV)) linkV = 0;
  if (linkV >= APP_VERSION) return false;
  let changed = false;
  for (const step of LINK_MIGRATIONS) {
    if (step.from >= linkV && step.from < APP_VERSION) { step.migrate(params); changed = true; }
  }
  params.set('v', String(APP_VERSION));
  return changed;
}
function resetStorageForNewVersion() {
  // Hide the button right away so the click reads as confirmed even if the
  // navigation below takes a beat. Without this the button sits visible
  // until the reload paints, which looks like nothing happened.
  const btn = document.getElementById('reset-version-btn');
  if (btn) btn.hidden = true;
  try {
    for (const k of LS_KEYS) localStorage.removeItem(k);
    localStorage.setItem(LS_VERSION_KEY, String(APP_VERSION));
  } catch (e) {}
  // Reload with a clean URL. `location.replace()` (not `href = pathname`)
  // because assigning the same URL is a no-op when there's no ?query to
  // strip — replace() always navigates and also removes the stale entry
  // from history so back-button can't bounce the user to the pre-reset URL.
  window.location.replace(window.location.pathname);
}

function saveSliders() {
  const vals = {};
  SLIDER_IDS.forEach(id => {
    // Canonical top pills: don't persist per-strategy knobs (see above).
    if (_isStrategyParamId(id)) return;
    const el = document.getElementById(id);
    // Checkboxes store as '1'/'0' (the .value property of a checkbox is the
    // form-submission value, not the checked state).
    let v = (el.type === 'checkbox') ? (el.checked ? '1' : '0') : el.value;
    // Persist the rate as its actual percentage value rather than the raw
    // slider position — keeps storage stable across slider-curve changes and
    // backward-compatible with the old linear slider (which also stored %).
    if (id === 'slider-rate') v = String(sliderToRate(+v));
    vals[id] = v;
  });
  // 'toggle-envelope' (alternate runs) is intentionally NOT persisted — it's a
  // canonical 9sig view option that resets to off on refresh.
  vals['toggle-log-scale'] =
    document.getElementById('chart-log-toggle').getAttribute('aria-pressed') === 'true';
  // Per-line visibility (legend-chip eye toggles). Persisted so a plain page
  // refresh restores the same hidden/visible mix the user left things in.
  if (typeof chart !== 'undefined' && chart) {
    const hidden = [];
    chart.data.datasets.forEach((ds, i) => {
      if (ds._isShift || ds._configLine) return; // saved-config visibility lives in its own store
      if (!chart.isDatasetVisible(i)) hidden.push(i);
    });
    vals['hidden-datasets'] = hidden;
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(vals)); } catch(e) {}
}

// Regular sliders (not entry/exit — those are handled by dual-range)
['slider-initial','slider-monthly','slider-raise','slider-rate'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    // Snap the cash-rate slider to 0.5% increments. The slider itself runs
    // 0-1000 on a quadratic curve, so we round the *rate* (not the slider
    // position) and write back the slider position that matches.
    if (id === 'slider-rate') {
      const el = document.getElementById('slider-rate');
      const snappedRate = Math.round(sliderToRate(+el.value) * 2) / 2;
      const snappedPos  = rateToSlider(snappedRate);
      if (snappedPos !== +el.value) el.value = String(snappedPos);
    }
    if (id === 'slider-monthly') updateDeployAvailability();
    saveSliders();
    render();
  });
});
['select-bh-underlying','select-sma-asset','select-sma-window','select-sma-underlying','select-9sig-underlying','select-9sig-growth','select-9sig-crashdrop','select-9sig-crashwin','select-9sig-spike','select-9sig-period','select-9sig-cash','select-9sig-cashrate','select-9sig-buypower','select-9sig-deploy','select-9sig-target-compound','select-sma-cashrate','select-sma-entry-buf','select-sma-exit-buf','select-sma-rsi-oh','select-sma-rsi-cool','select-sma-out-asset','select-sma-dca-in','select-sma-dca-to-out','select-sma-bg-delev','select-sma-bg-gtfo'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => {
    saveSliders();
    // Any 9sig knob change can flip the strategy name between "9sig" (all
    // defaults) and "sig" (tweaked), so refresh the display labels for the
    // whole 9sig group, not just growth.
    if (id.startsWith('select-9sig-') && typeof refresh9sigDisplayLabels === 'function') {
      refresh9sigDisplayLabels();
    }
    if (id === 'select-9sig-cash') update9sigCashSpans();
    render();
  });
});

// Update the inline "(100−x)%" stock-share and spike-reset-target spans
// when the user picks a different initial cash %.
function update9sigCashSpans() {
  const cashP = +((document.getElementById('select-9sig-cash') || {}).value) || 0;
  const stockP = 100 - cashP;
  const a = document.getElementById('9sig-stock-pct');
  const b = document.getElementById('9sig-spike-target');
  if (a) a.textContent = stockP + '%';
  if (b) b.textContent = stockP + '%';
}

// The "Deploy 50% of each contribution" toggle only does anything when there
// ARE monthly contributions to split. With $0 monthly it's a no-op, which
// reads as "the checkbox is broken" — so disable + dim it (and surface a
// hint) whenever monthly is 0.
function updateDeployAvailability() {
  const monthly = +((document.getElementById('slider-monthly') || {}).value) || 0;
  const cb = document.getElementById('select-9sig-deploy');
  if (!cb) return;
  const hasMonthly = monthly > 0;
  cb.disabled = !hasMonthly;
  const wrap = cb.closest('label');
  if (wrap) {
    wrap.style.opacity = hasMonthly ? '' : '0.45';
    wrap.style.cursor  = hasMonthly ? 'pointer' : 'not-allowed';
    wrap.title = hasMonthly ? '' : 'Set a Monthly Contribution above $0 — this only splits new contributions, not the initial amount.';
  }
}

// Position info-icon tooltips with position:fixed (anchored to the icon
// via JS-set CSS vars) so they escape any overflow:auto ancestor — the
// strategy-panel-body would otherwise clip a tooltip near its top edge
// and the tooltip would appear hidden behind the panel header. We also
// clamp the horizontal anchor by the tooltip's worst-case half-width so
// it can't spill past either viewport edge.
function positionInfoTip(e) {
  const icon = e.target.closest && e.target.closest('.info-icon[data-tip]');
  if (!icon) return;
  const r = icon.getBoundingClientRect();
  const HALF_W = 120; // half of the tooltip's CSS max-width (240px)
  const PAD    = 8;
  const minCx  = HALF_W + PAD;
  const maxCx  = window.innerWidth - HALF_W - PAD;
  let cx = r.left + r.width / 2;
  if (maxCx > minCx) cx = Math.max(minCx, Math.min(maxCx, cx));
  icon.style.setProperty('--tip-left', cx + 'px');
  icon.style.setProperty('--tip-top',  (r.top - 6) + 'px');
}
document.addEventListener('mouseover', positionInfoTip);
document.addEventListener('focusin',   positionInfoTip);

document.getElementById('toggle-envelope').addEventListener('change', (e) => {
  // "Show alternate runs" is per-strategy: write the flag for whichever strategy
  // is currently open (main session flag, or the open saved strategy's config).
  if (typeof setCurrentEnvelopeFlag === 'function') setCurrentEnvelopeFlag(e.target.checked);
  saveSliders();
  render();
});

// Draggable resize handle on the strategy panel — like a code-editor split.
// Width persists in its own localStorage key (separate from LS_KEY so it
// survives version resets — it's a harmless UI preference). Clamped so the
// panel can't get uselessly narrow or eat the whole viewport.
const PANEL_WIDTH_KEY = '9sig-panel-width';
const PANEL_MIN_W = 280;
const panelMaxW = () => Math.min(900, Math.round(window.innerWidth * 0.92));
function applyPanelWidth(w) {
  const content = document.querySelector('.strategy-panel-content');
  if (!content) return;
  const clamped = Math.max(PANEL_MIN_W, Math.min(panelMaxW(), w));
  content.style.width = clamped + 'px';
}
(function initPanelResizer() {
  const resizer = document.getElementById('strategy-panel-resizer');
  const content = document.querySelector('.strategy-panel-content');
  if (!resizer || !content) return;
  // Restore a saved width on load.
  try {
    const saved = parseFloat(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved)) applyPanelWidth(saved);
  } catch (e) {}

  let startX = 0, startW = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const w = startW + (e.clientX - startX);
    applyPanelWidth(w);
    e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    content.classList.remove('is-resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(parseInt(content.style.width, 10) || 360)); } catch (e) {}
  };
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = content.getBoundingClientRect().width;
    content.classList.add('is-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
  // Keep within bounds if the window shrinks.
  window.addEventListener('resize', () => {
    if (content.style.width) applyPanelWidth(parseInt(content.style.width, 10) || 360);
  });
})();

// In-chart "log" pill is the sole source-of-truth for the logarithmic
// Y-axis state — its aria-pressed attribute holds the boolean.
const logPill = document.getElementById('chart-log-toggle');
const isLogScale = () => logPill.getAttribute('aria-pressed') === 'true';
const setLogScale = (on) => logPill.setAttribute('aria-pressed', on ? 'true' : 'false');
logPill.addEventListener('click', () => {
  setLogScale(!isLogScale());
  saveSliders();
  render();
});


// Dual-range slider for period
(function initDualRange() {
  const container = document.getElementById('period-range');
  const fill = container.querySelector('.fill');
  const thumbs = container.querySelectorAll('.thumb');
  const entryThumb = thumbs[0];
  const exitThumb = thumbs[1];
  const entryInput = document.getElementById('slider-entry');
  const exitInput = document.getElementById('slider-exit');
  let maxVal = 108; // updated in init()

  function getMax() { return maxVal; }
  function setMax(v) { maxVal = v; updateUI(); }

  function valToPercent(v) { return (v / getMax()) * 100; }
  function percentToVal(p) { return Math.round(Math.min(Math.max(p, 0), 100) / 100 * getMax()); }

  function updateUI() {
    const e = +entryInput.value, x = +exitInput.value;
    const ep = valToPercent(e), xp = valToPercent(x);
    entryThumb.style.left = ep + '%';
    exitThumb.style.left = xp + '%';
    fill.style.left = ep + '%';
    fill.style.width = (xp - ep) + '%';
  }

  function onChanged() {
    saveSliders();
    render();
  }

  // Thumb dragging
  function startThumbDrag(thumb, isEntry) {
    return function(e) {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      function onMove(ev) {
        const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
        const pct = ((clientX - rect.left) / rect.width) * 100;
        let val = percentToVal(pct);
        if (isEntry) {
          val = Math.min(val, +exitInput.value - 1);
          val = Math.max(val, 0);
          entryInput.value = val;
        } else {
          val = Math.max(val, +entryInput.value + 1);
          val = Math.min(val, getMax());
          exitInput.value = val;
        }
        updateUI();
        onChanged();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    };
  }

  entryThumb.addEventListener('mousedown', startThumbDrag(entryThumb, true));
  entryThumb.addEventListener('touchstart', startThumbDrag(entryThumb, true), { passive: false });
  exitThumb.addEventListener('mousedown', startThumbDrag(exitThumb, false));
  exitThumb.addEventListener('touchstart', startThumbDrag(exitThumb, false), { passive: false });

  // Fill bar dragging (moves both thumbs together)
  fill.addEventListener('mousedown', startFillDrag);
  fill.addEventListener('touchstart', startFillDrag, { passive: false });

  function startFillDrag(e) {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const startX = e.touches ? e.touches[0].clientX : e.clientX;
    const startEntry = +entryInput.value;
    const startExit = +exitInput.value;
    const span = startExit - startEntry;

    function onMove(ev) {
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const dx = clientX - startX;
      const dVal = Math.round((dx / rect.width) * getMax());
      let newEntry = startEntry + dVal;
      let newExit = startExit + dVal;
      if (newEntry < 0) { newEntry = 0; newExit = span; }
      if (newExit > getMax()) { newExit = getMax(); newEntry = getMax() - span; }
      entryInput.value = newEntry;
      exitInput.value = newExit;
      updateUI();
      onChanged();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }

  // Click on track to jump nearest thumb
  container.querySelector('.track').addEventListener('click', function(e) {
    const rect = container.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const val = percentToVal(pct);
    const entry = +entryInput.value, exit = +exitInput.value;
    if (Math.abs(val - entry) < Math.abs(val - exit)) {
      entryInput.value = Math.min(val, exit - 1);
    } else {
      exitInput.value = Math.max(val, entry + 1);
    }
    updateUI();
    onChanged();
  });

  // Shift the entire range by `dir` quarters; returns true if it actually
  // moved, false at boundary (used to auto-stop the play buttons).
  function step(dir) {
    const newEntry = +entryInput.value + dir;
    const newExit = +exitInput.value + dir;
    if (newEntry < 0 || newExit > getMax()) return false;
    entryInput.value = newEntry;
    exitInput.value = newExit;
    updateUI();
    onChanged();
    return true;
  }

  // Keyboard: arrow keys move the whole range when container is focused
  container.setAttribute('tabindex', '0');
  container.style.outline = 'none';
  container.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
  });

  // Focus container when any part is interacted with
  container.addEventListener('mousedown', () => container.focus());

  // Play buttons: clicking toggles auto-advance in that direction. Clicking
  // the active button again stops; clicking the opposite button switches
  // direction. Auto-stops when the range hits a boundary.
  const playLeft = document.getElementById('period-play-left');
  const playRight = document.getElementById('period-play-right');
  const PLAY_INTERVAL_MS = 750;
  let playTimer = null;
  let playDir = 0;

  const ICON_LEFT = '◀', ICON_RIGHT = '▶', ICON_STOP = '■';

  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    playDir = 0;
    playLeft.setAttribute('aria-pressed', 'false');
    playRight.setAttribute('aria-pressed', 'false');
    playLeft.textContent = ICON_LEFT;
    playRight.textContent = ICON_RIGHT;
  }
  function startPlay(dir) {
    stopPlay();
    playDir = dir;
    const btn = dir < 0 ? playLeft : playRight;
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = ICON_STOP;
    if (!step(dir)) { stopPlay(); return; } // immediate first step, halt if at boundary
    playTimer = setInterval(() => { if (!step(dir)) stopPlay(); }, PLAY_INTERVAL_MS);
  }
  playLeft.addEventListener('click', () => playDir === -1 ? stopPlay() : startPlay(-1));
  playRight.addEventListener('click', () => playDir === 1 ? stopPlay() : startPlay(1));

  // Expose for init()
  window._dualRange = { updateUI, setMax, step, stopPlay };
})();

// Share: encode the full UI state into URL params so the receiver lands on
// the exact same view. Includes sliders, strategy params, toggles, envelope
// opacity, dataset visibility (per-line legend toggles), and the analytics
// modal state (open + selected strategy + selected baseline).
function shareConfig() {
  const get = (id) => document.getElementById(id);
  const params = new URLSearchParams();

  // Stamp the app version the link was created with. On load, migrateSharedLink()
  // (see init.js) can detect an older `v` and upgrade/redirect the params so the
  // link keeps producing the same result even after the param scheme changes.
  params.set('v', String(APP_VERSION));

  // Core sliders (existing keys — keep stable so old links keep working)
  params.set('i', get('slider-initial').value);
  params.set('m', get('slider-monthly').value);
  params.set('a', get('slider-raise').value);
  // Share the rate as percent (matches old-format share URLs and is stable
  // across slider-curve changes).
  params.set('r', String(sliderToRate(+get('slider-rate').value)));
  params.set('e', get('slider-entry').value);
  params.set('x', get('slider-exit').value);

  // Buy & Hold consolidated chip — which underlying it tracks.
  if (get('select-bh-underlying')) params.set('bu', get('select-bh-underlying').value);

  // SMA strategy params (signal asset + window + underlying + buffers/RSI/dip-ladder)
  if (get('select-sma-asset'))       params.set('sa',  get('select-sma-asset').value);
  if (get('select-sma-window'))      params.set('sw',  get('select-sma-window').value);
  if (get('select-sma-underlying'))  params.set('su',  get('select-sma-underlying').value);
  if (get('select-sma-entry-buf'))   params.set('seb', get('select-sma-entry-buf').value);
  if (get('select-sma-exit-buf'))    params.set('sxb', get('select-sma-exit-buf').value);
  if (get('select-sma-rsi-oh'))      params.set('sro', get('select-sma-rsi-oh').value);
  if (get('select-sma-rsi-cool'))    params.set('src', get('select-sma-rsi-cool').value);
  if (get('select-sma-cashrate'))    params.set('scr', get('select-sma-cashrate').value);
  if (get('select-sma-out-asset'))   params.set('soa', get('select-sma-out-asset').value);
  if (get('select-sma-dca-in'))      params.set('sdi', get('select-sma-dca-in').value);
  if (get('select-sma-dca-to-out'))  params.set('sdo', get('select-sma-dca-to-out').value);
  if (get('select-sma-bg-delev'))    params.set('sbd', get('select-sma-bg-delev').value);
  if (get('select-sma-bg-gtfo'))     params.set('sbg', get('select-sma-bg-gtfo').value);

  // 9sig: underlying + signal-line growth + rule customization
  if (get('select-9sig-underlying')) params.set('nu', get('select-9sig-underlying').value);
  if (get('select-9sig-growth'))     params.set('ng', get('select-9sig-growth').value);
  if (get('select-9sig-crashdrop'))  params.set('nc', get('select-9sig-crashdrop').value);
  if (get('select-9sig-crashwin'))   params.set('ncw', get('select-9sig-crashwin').value);
  if (get('select-9sig-spike'))      params.set('ns', get('select-9sig-spike').value);
  if (get('select-9sig-period'))     params.set('np', get('select-9sig-period').value);
  if (get('select-9sig-cash'))       params.set('nh', get('select-9sig-cash').value);
  if (get('select-9sig-cashrate'))   params.set('nr', get('select-9sig-cashrate').value);
  if (get('select-9sig-buypower'))   params.set('nbp', get('select-9sig-buypower').value);
  if (get('select-9sig-deploy'))     params.set('nd', get('select-9sig-deploy').checked ? '1' : '0');
  if (get('select-9sig-target-compound')) params.set('tc', get('select-9sig-target-compound').checked ? '1' : '0');

  // Toggles
  params.set('l',
    document.getElementById('chart-log-toggle').getAttribute('aria-pressed') === 'true' ? '1' : '0');
  params.set('ev', get('toggle-envelope').checked    ? '1' : '0');

  // Dataset visibility — captures per-line legend toggles. Always set, even
  // if empty, so the URL is fully authoritative. Recipient code treats `hd=`
  // (empty) as "nothing hidden" and skips the localStorage fallback.
  if (typeof chart !== 'undefined' && chart) {
    const hidden = [];
    chart.data.datasets.forEach((ds, i) => {
      if (ds._isShift || ds._configLine) return; // ignore envelope-shift + saved-config datasets
      if (!chart.isDatasetVisible(i)) hidden.push(i);
    });
    params.set('hd', hidden.join(','));
  }

  // Open strategy sidebar (which chip's detail panel is showing), by stable key.
  if (typeof getOpenPanelKey === 'function') {
    const pk = getOpenPanelKey();
    if (pk) params.set('sp', pk);
  }

  // Saved strategies, including custom ones (code + description). SECURITY: shared
  // custom code is never trusted on arrival — it's flagged `untrusted` and ALWAYS
  // executed inside a locked-down Web Worker sandbox (no DOM, storage, cookies, or
  // network), so running someone else's strategy can't harm the recipient.
  if (typeof getSavedConfigs === 'function') {
    const cfgs = getSavedConfigs();
    if (cfgs && cfgs.length) {
      const lean = cfgs.map(c => {
        const o = { type: c.type, name: c.name, params: c.params || {}, color: c.color, hidden: !!c.hidden };
        if (c.type === 'custom') { o.code = c.code || ''; o.desc = c.desc || ''; }
        return o;
      });
      try { params.set('sc', encodeURIComponent(JSON.stringify(lean))); } catch (e) {}
    }
  }

  // Analytics modal state
  if (typeof isAnalyticsOpen === 'function' && isAnalyticsOpen()) {
    params.set('am', '1');
  }
  if (typeof analyticsStrategy !== 'undefined' && analyticsStrategy && analyticsStrategy !== '9sig') {
    params.set('as', analyticsStrategy);
  }
  if (typeof analyticsBaseline !== 'undefined' && analyticsBaseline && analyticsBaseline !== 'compounded') {
    params.set('ab', analyticsBaseline);
    // For 'custom' also share the dollar target; for 'custom-pct' share the
    // growth percentage. Otherwise the receiver falls back to defaults.
    if (analyticsBaseline === 'custom' && typeof analyticsCustomTarget === 'number' && analyticsCustomTarget > 0) {
      params.set('act', String(Math.round(analyticsCustomTarget)));
    }
    if (analyticsBaseline === 'custom-pct' && typeof analyticsCustomGrowthPct === 'number') {
      params.set('acp', String(analyticsCustomGrowthPct));
    }
  }

  const url = window.location.origin + window.location.pathname + '?' + params.toString();

  navigator.clipboard.writeText(url).then(() => {
    const toast = document.getElementById('share-toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }).catch(() => {
    prompt('Copy this link:', url);
  });
}


