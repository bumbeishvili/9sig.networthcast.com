// Slider max is set in init() after data loads

const SLIDER_IDS = ['slider-initial','slider-monthly','slider-raise','slider-rate','slider-entry','slider-exit','slider-envelope-opacity','select-tqqq-above','select-tqqq-below','select-tqqq-window'];
const LS_KEY = '9sig-sliders';

function saveSliders() {
  const vals = {};
  SLIDER_IDS.forEach(id => vals[id] = document.getElementById(id).value);
  vals['toggle-envelope'] = document.getElementById('toggle-envelope').checked;
  vals['toggle-bh-envelope'] = document.getElementById('toggle-bh-envelope').checked;
  vals['toggle-log-scale'] = document.getElementById('toggle-log-scale').checked;
  vals['advanced-open'] = document.getElementById('advanced-section').classList.contains('open');
  vals['adaptive-open'] = document.getElementById('adaptive-section').classList.contains('open');
  try { localStorage.setItem(LS_KEY, JSON.stringify(vals)); } catch(e) {}
}

// Regular sliders (not entry/exit — those are handled by dual-range)
['slider-initial','slider-monthly','slider-raise','slider-rate'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => { saveSliders(); render(); });
});
['select-tqqq-above','select-tqqq-below','select-tqqq-window'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => { saveSliders(); render(); });
});

// Envelope opacity: just retint existing shift datasets, no re-simulation
document.getElementById('slider-envelope-opacity').addEventListener('input', () => {
  const v = +document.getElementById('slider-envelope-opacity').value / 100;
  document.getElementById('disp-envelope-opacity').textContent = 'opacity ' + v.toFixed(2);
  if (chart) {
    const c9 = `rgba(34,211,238,${v})`;
    const cB = `rgba(248,113,113,${v})`;
    for (let i = 0; i < envelopeShiftCount; i++) {
      const ds9 = chart.data.datasets[9 + i];
      if (ds9) ds9.borderColor = c9;
      const dsB = chart.data.datasets[9 + envelopeShiftCount + i];
      if (dsB) dsB.borderColor = cB;
    }
    chart.update('none');
  }
  saveSliders();
});

['toggle-envelope', 'toggle-bh-envelope', 'toggle-log-scale'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    saveSliders();
    render();
  });
});

// In-chart "log" pill mirrors the Logarithmic Y-axis checkbox so the user can
// flip the y-scale without leaving the chart.
const logCheckbox = document.getElementById('toggle-log-scale');
const logPill = document.getElementById('chart-log-toggle');
const syncLogPill = () => logPill.setAttribute('aria-pressed', logCheckbox.checked ? 'true' : 'false');
logPill.addEventListener('click', () => {
  logCheckbox.checked = !logCheckbox.checked;
  logCheckbox.dispatchEvent(new Event('change'));
  syncLogPill();
});
logCheckbox.addEventListener('change', syncLogPill);
syncLogPill();

function toggleAdvanced() {
  const sec = document.getElementById('advanced-section');
  sec.classList.toggle('open');
  const open = sec.classList.contains('open');
  document.getElementById('advanced-toggle').textContent = open ? '− advanced' : '+ advanced';
  saveSliders();
}

function toggleAdaptive() {
  const sec = document.getElementById('adaptive-section');
  sec.classList.toggle('open');
  const open = sec.classList.contains('open');
  document.getElementById('adaptive-toggle').textContent = open ? '− adaptive strategy' : '+ adaptive strategy';
  saveSliders();
}

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

// Share: encode current sliders into URL params
function shareConfig() {
  const params = new URLSearchParams();
  params.set('i', document.getElementById('slider-initial').value);
  params.set('m', document.getElementById('slider-monthly').value);
  params.set('a', document.getElementById('slider-raise').value);
  params.set('r', document.getElementById('slider-rate').value);
  params.set('e', document.getElementById('slider-entry').value);
  params.set('x', document.getElementById('slider-exit').value);

  const url = window.location.origin + window.location.pathname + '?' + params.toString();

  navigator.clipboard.writeText(url).then(() => {
    const toast = document.getElementById('share-toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }).catch(() => {
    // Fallback: prompt
    prompt('Copy this link:', url);
  });
}


