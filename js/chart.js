let chart = null;

function render() {
  if (!quarterlyData) return; // data not loaded yet
  const initial = sliderToInitial(+document.getElementById('slider-initial').value);
  const monthly = +document.getElementById('slider-monthly').value;
  const annualRaise = +document.getElementById('slider-raise').value / 100;
  const rate = +document.getElementById('slider-rate').value / 100;
  const logScale = document.getElementById('toggle-log-scale').checked;
  const tqqqAboveMult = +document.getElementById('select-tqqq-above').value;  // e.g. 2.0× = TQQQ is 2× of 9sig
  const tqqqBelowMult = +document.getElementById('select-tqqq-below').value;  // e.g. 1.2× = 9sig is 1.2× of TQQQ
  const tqqqWindow    = +document.getElementById('select-tqqq-window').value;
  // Translate to the internal trailing-window ratio (B&H_TQQQ / 9sig × 100).
  // Ratio 100% = parity. Switch to 9sig when ratio ≥ above_mult × 100.
  // Switch to all-in when 1/ratio ≥ below_mult, i.e. ratio ≤ 100 / below_mult.
  const switchTo9sig  = tqqqAboveMult * 100;
  const switchToAllIn = tqqqBelowMult > 0 ? 100 / tqqqBelowMult : 100;
  let entryIdx = +document.getElementById('slider-entry').value;
  let exitIdx = +document.getElementById('slider-exit').value;

  // Clamp to valid range — saved values from a prior dataset may be stale.
  const maxIdx = quarterlyData.length - 1;
  if (!Number.isFinite(entryIdx) || entryIdx < 0) entryIdx = 0;
  if (!Number.isFinite(exitIdx)  || exitIdx  < 0) exitIdx  = maxIdx;
  if (entryIdx > maxIdx) entryIdx = maxIdx;
  if (exitIdx  > maxIdx) exitIdx  = maxIdx;
  if (entryIdx >= exitIdx) {
    exitIdx  = Math.min(entryIdx + 1, maxIdx);
    entryIdx = Math.min(entryIdx, exitIdx - 1);
    if (entryIdx < 0) entryIdx = 0;
  }
  document.getElementById('slider-entry').value = entryIdx;
  document.getElementById('slider-exit').value  = exitIdx;

  document.getElementById('disp-initial').textContent = fmtFull(initial);
  document.getElementById('disp-monthly').textContent = fmtFull(monthly);
  const raiseVal = annualRaise * 100;
  document.getElementById('disp-raise').textContent = (raiseVal % 1 === 0 ? raiseVal.toFixed(0) : raiseVal.toFixed(1)) + '%';
  const rv = (rate * 100);
  document.getElementById('disp-rate').textContent = (rv % 1 === 0 ? rv.toFixed(1) : rv.toFixed(2)) + '%';
  document.getElementById('disp-entry').textContent = qLabel(quarterlyData[entryIdx][0]);
  document.getElementById('disp-exit').textContent = qLabel(quarterlyData[exitIdx][0]);

  const { log, bhPoints, qqqPoints, spyPoints, adaptivePoints, totalContributed } = simulate(initial, monthly, rate, entryIdx, exitIdx, annualRaise, { switchTo9sig, switchToAllIn, yearsBack: tqqqWindow });

  const showEnvelope = document.getElementById('toggle-envelope').checked;
  const showBhEnvelope = document.getElementById('toggle-bh-envelope').checked;
  const opacityVal = +document.getElementById('slider-envelope-opacity').value / 100;
  document.getElementById('disp-envelope-opacity').textContent = 'opacity ' + opacityVal.toFixed(2);
  const envColor = `rgba(34,211,238,${opacityVal})`;
  const envColorBh = `rgba(248,113,113,${opacityVal})`;
  const shiftResults = showEnvelope
    ? shiftedQuarterlyCache.map(qData => simulate(initial, monthly, rate, entryIdx, exitIdx, annualRaise, { qData, skipBH: true }).log.map(l => l.total))
    : [];
  const bhShiftResults = showBhEnvelope
    ? shiftedQuarterlyCache.map(qData => simulateBhTqqq(initial, monthly, annualRaise, entryIdx, exitIdx, qData))
    : [];

  if (log.length < 1) {
    document.getElementById('stats-grid').innerHTML = '<div class="stat-card" style="grid-column:span 2"><div class="stat-label">Select a wider period</div></div>';
    if (chart) { chart.destroy(); chart = null; }
    document.getElementById('log-body').innerHTML = '';
    return;
  }

  const finalLog = log[log.length - 1];
  const finalBH = bhPoints[bhPoints.length - 1].value;
  const finalQQQ = qqqPoints[qqqPoints.length - 1].value;
  const finalSPY = spyPoints[spyPoints.length - 1].value;
  const years = log.length > 1 ? (new Date(log[log.length-1].date) - new Date(log[0].date)) / (365.25*86400000) : 1;
  const cagr = (end, start) => years > 0 && start > 0 ? (Math.pow(end / start, 1 / years) - 1) * 100 : 0;
  const finalAdaptive = adaptivePoints[adaptivePoints.length - 1].value;
  const ret9 = cagr(finalLog.total, totalContributed);
  const retBH = cagr(finalBH, totalContributed);
  const retQQQ = cagr(finalQQQ, totalContributed);
  const retSPY = cagr(finalSPY, totalContributed);
  const retInv = cagr(finalLog.investedCompounded, totalContributed);
  const retAdaptive = cagr(finalAdaptive, totalContributed);

  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">9sig Annualized</div>
      <div class="stat-value ${ret9 >= 0 ? 'positive' : 'negative'}">${ret9 >= 0 ? '+' : ''}${ret9.toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Adaptive Annualized</div>
      <div class="stat-value ${retAdaptive >= 0 ? 'positive' : 'negative'}">${retAdaptive >= 0 ? '+' : ''}${retAdaptive.toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">B&H TQQQ Annualized</div>
      <div class="stat-value ${retBH >= 0 ? 'positive' : 'negative'}">${retBH >= 0 ? '+' : ''}${retBH.toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">B&H QQQ Annualized</div>
      <div class="stat-value ${retQQQ >= 0 ? 'positive' : 'negative'}">${retQQQ >= 0 ? '+' : ''}${retQQQ.toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">B&H SPY Annualized</div>
      <div class="stat-value ${retSPY >= 0 ? 'positive' : 'negative'}">${retSPY >= 0 ? '+' : ''}${retSPY.toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Invested Compounded Annualized</div>
      <div class="stat-value ${retInv >= 0 ? 'positive' : 'negative'}">${retInv >= 0 ? '+' : ''}${retInv.toFixed(1)}%</div>
    </div>
  `;

  // Chart
  const labels = log.map(l => l.date);
  const totalD = log.map(l => l.total);
  const tqqqValD = log.map(l => l.tqqqVal);
  const cashD = log.map(l => l.cash);
  const bhD = bhPoints.map(b => b.value);
  const qqqD = qqqPoints.map(q => q.value);
  const spyD = spyPoints.map(s => s.value);
  const invD = log.map(l => l.investedCompounded);
  const targetD = log.map(l => l.target);
  const adaptiveD = adaptivePoints.map(a => a.value);
  // Transition markers: dot at every quarter the strategy switched. Cyan for
  // → 9sig, red for → all-in TQQQ, transparent (radius 0) on non-switch quarters.
  // The plugin draws connector + label; keep pointRadius 0 so we don't
  // double-up. Transition dot is rendered by the plugin itself for full
  // control over size/color/layering.
  const adaptivePointRadius = adaptivePoints.map(() => 0);
  const adaptivePointHoverRadius = adaptivePoints.map(() => 0);
  const adaptivePointBg = adaptivePoints.map(a => a.state === '9sig' ? '#22d3ee' : '#f87171');
  const adaptiveTransitions = adaptivePoints.map((a, i) => {
    if (i === 0) return a.state === '9sig' ? 'to 9sig' : 'to TQQQ';
    if (a.state === adaptivePoints[i-1].state) return null;
    return a.state === '9sig' ? 'to 9sig' : 'to TQQQ';
  });

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = totalD;
    chart.data.datasets[1].data = tqqqValD;
    chart.data.datasets[2].data = bhD;
    chart.data.datasets[3].data = qqqD;
    chart.data.datasets[4].data = spyD;
    chart.data.datasets[5].data = targetD;
    chart.data.datasets[6].data = cashD;
    chart.data.datasets[7].data = invD;
    chart.data.datasets[8].data = adaptiveD;
    chart.data.datasets[8].pointRadius = adaptivePointRadius;
    chart.data.datasets[8].pointHoverRadius = adaptivePointHoverRadius;
    chart.data.datasets[8].pointBackgroundColor = adaptivePointBg;
    chart.data.datasets[8].pointBorderColor = adaptivePointBg;
    chart.data.datasets[8]._transitions = adaptiveTransitions;
    while (chart.data.datasets.length < 9 + envelopeShiftCount * 2) {
      const offset = chart.data.datasets.length - 9;
      const isBh = offset >= envelopeShiftCount;
      chart.data.datasets.push({
        label: (isBh ? '_bhshift_' : '_shift_') + ((offset % envelopeShiftCount) + 1),
        data: [],
        borderColor: isBh ? envColorBh : envColor,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        pointHitRadius: 0,
        borderWidth: 1,
        order: -1,
        _isShift: true
      });
    }
    for (let i = 0; i < envelopeShiftCount; i++) {
      const ds9 = chart.data.datasets[9 + i];
      ds9.data = showEnvelope ? (shiftResults[i] || []) : [];
      ds9.borderColor = envColor;
      ds9.hidden = !showEnvelope;
      const dsB = chart.data.datasets[9 + envelopeShiftCount + i];
      dsB.data = showBhEnvelope ? (bhShiftResults[i] || []) : [];
      dsB.borderColor = envColorBh;
      dsB.hidden = !showBhEnvelope;
    }
    chart.options.scales.y.type = logScale ? 'logarithmic' : 'linear';
    chart.options.scales.y.beginAtZero = !logScale;
    chart.update('none');
  } else {
  const ctx = document.getElementById('mainChart').getContext('2d');

  const lineColors = ['#22d3ee', '#38bdf8', '#f87171', '#4ade80', '#f472b6', '#fb923c', '#fbbf24', 'rgba(226,232,240,0.4)', '#c084fc'];
  const lineNames  = ['9sig Total', '9sig TQQQ Holding', 'B&H TQQQ', 'B&H QQQ', 'B&H SPY', '9sig TQQQ Target', '9sig Cash', 'Invested Comp.', 'Adaptive'];
  // Match the borderDash on the corresponding chart dataset; null = solid.
  const lineDashes = [null, [2,2], [6,3], [8,4], [6,3], [4,4], null, [3,3], null];

  const externalTooltip = (context) => {
    const { chart: c, tooltip } = context;
    const el = document.getElementById('custom-tooltip');
    if (tooltip.opacity === 0) { el.style.display = 'none'; return; }

    const idx = tooltip.dataPoints?.[0]?.dataIndex;
    if (idx == null) return;

    const ds = c.data.datasets;
    const date = c.data.labels[idx];
    const vals = [ds[0].data[idx], ds[1].data[idx], ds[2].data[idx], ds[3].data[idx], ds[4].data[idx], ds[5].data[idx], ds[6].data[idx], ds[7].data[idx], ds[8].data[idx]];

    const rgba = (col, a) => {
      if (col.startsWith('rgba')) return col.replace(/,\s*[\d.]+\s*\)$/, `,${a})`);
      const m = col.match(/^#([0-9a-f]{6})$/i);
      if (!m) return col;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    const items = lineNames
      .map((n, i) => ({ i, n, v: vals[i] }))
      .filter(({ i, v }) => c.isDatasetVisible(i) && v != null && !Number.isNaN(v))
      .sort((a, b) => b.v - a.v);
    const maxV = Math.max(0, ...items.map(it => it.v));

    const adaptiveTrans = (ds[8] && ds[8]._transitions) ? ds[8]._transitions[idx] : null;
    const rows = items.map(({ i, n, v }) => {
      const pct = maxV > 0 ? Math.max(0, (v / maxV) * 100) : 0;
      const dashAttr = lineDashes[i] ? `stroke-dasharray="${lineDashes[i].join(',')}"` : '';
      const sample = `<svg width="20" height="4" style="flex-shrink:0;overflow:visible">
        <line x1="0" y1="2" x2="20" y2="2" stroke="${lineColors[i]}" stroke-width="2" stroke-linecap="round" ${dashAttr}/>
      </svg>`;
      const transBadge = (i === 8 && adaptiveTrans)
        ? `<span style="margin-left:6px;font-size:10px;color:${adaptiveTrans.includes('9sig') ? '#22d3ee' : '#f87171'};font-weight:600">${adaptiveTrans}</span>`
        : '';
      return `
        <div class="tt-row" style="position:relative">
          <div style="position:absolute;left:0;top:2px;bottom:2px;width:${pct}%;background:${rgba(lineColors[i], 0.20)};border-radius:3px;pointer-events:none"></div>
          <div class="tt-row-left" style="position:relative;z-index:1">
            ${sample}
            <span class="tt-name">${n}</span>${transBadge}
          </div>
          <span class="tt-val" style="position:relative;z-index:1">${fmtFull(Math.round(v))}</span>
        </div>
      `;
    }).join('');

    el.innerHTML = `<div class="tt-date">${qLabel(date)}</div>${rows}`;

    el.style.display = 'block';
    const panelRect = c.canvas.closest('.panel').getBoundingClientRect();
    const canvasRect = c.canvas.getBoundingClientRect();
    let left = tooltip.caretX + canvasRect.left - panelRect.left + 14;
    let top = tooltip.caretY + canvasRect.top - panelRect.top - 40;
    if (left + 240 > panelRect.width) left = tooltip.caretX + canvasRect.left - panelRect.left - 240;
    if (top < 0) top = 10;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  };

  // Plugin: draw end-of-line labels directly on canvas
  const endLabelPlugin = {
    id: 'endLabels',
    afterDraw(c) {
      const { ctx: cx, chartArea: area } = c;
      if (!area) return;
      const lastIdx = c.data.labels.length - 1;
      if (lastIdx < 0) return;

      const items = c.data.datasets.map((ds, i) => {
        if (ds._isShift) return null;
        if (!c.isDatasetVisible(i)) return null;
        const meta = c.getDatasetMeta(i);
        const pt = meta.data[lastIdx];
        if (!pt) return null;
        return { y: pt.y, i, color: lineColors[i], name: lineNames[i], val: ds.data[lastIdx] };
      }).filter(Boolean);

      // Sort by y position and de-overlap
      items.sort((a, b) => a.y - b.y);
      const gap = 26;
      // Push down pass
      for (let k = 1; k < items.length; k++) {
        if (items[k].y - items[k - 1].y < gap) {
          items[k].y = items[k - 1].y + gap;
        }
      }
      // Push up pass if overflowing bottom
      for (let k = items.length - 1; k >= 0; k--) {
        const maxY = area.bottom - 5 - (items.length - 1 - k) * gap;
        if (items[k].y > maxY) items[k].y = maxY;
      }
      // Final clamp
      items.forEach(it => {
        if (it.y < area.top + 10) it.y = area.top + 10;
        if (it.y > area.bottom - 5) it.y = area.bottom - 5;
      });

      cx.save();
      const x = area.right + 8;
      items.forEach(it => {
        // Connector line from chart edge to label
        cx.beginPath();
        cx.strokeStyle = it.color;
        cx.lineWidth = 1;
        cx.setLineDash([2, 2]);
        const origMeta = c.getDatasetMeta(it.i);
        const origY = origMeta.data[lastIdx].y;
        cx.moveTo(area.right, origY);
        cx.lineTo(x - 2, it.y);
        cx.stroke();
        cx.setLineDash([]);

        // Small dot at line end
        cx.beginPath();
        cx.arc(area.right, origY, 3, 0, Math.PI * 2);
        cx.fillStyle = it.color;
        cx.fill();

        // Label name
        cx.font = '600 9px "DM Sans", sans-serif';
        cx.fillStyle = it.color;
        cx.globalAlpha = 0.7;
        cx.textBaseline = 'bottom';
        cx.fillText(it.name.toUpperCase(), x, it.y - 1);
        cx.globalAlpha = 1;

        // Value
        cx.font = '500 11px "JetBrains Mono", monospace';
        cx.fillStyle = it.color;
        cx.textBaseline = 'top';
        cx.fillText(fmtFull(Math.round(it.val)), x, it.y + 1);
      });
      cx.restore();
    }
  };

  // d3-style callout annotations on the Adaptive line for each strategy switch.
  // For each transition: dashed-circle marker at the data point, diagonal
  // connector, horizontal underline, then bold "to 9sig" / "to TQQQ" text
  // sitting on the underline. Label is placed via Voronoi-style search:
  // try increasing 45° offsets in both vertical AND horizontal directions
  // (right preferred, left as fallback), checking the full label rect against
  // every visible line sampled across its x-span. Tracks previously-placed
  // label rects so back-to-back transitions don't pile up.
  const adaptiveAnnotationPlugin = {
    id: 'adaptiveAnnotations',
    afterDatasetsDraw(c) {
      const adaptiveIdx = 8;
      if (!c.isDatasetVisible(adaptiveIdx)) return;
      const ds = c.data.datasets[adaptiveIdx];
      const transitions = ds && ds._transitions;
      if (!transitions) return;
      const meta = c.getDatasetMeta(adaptiveIdx);
      const cx = c.ctx;
      const top = c.chartArea.top;
      const bottom = c.chartArea.bottom;
      const left = c.chartArea.left;
      const right = c.chartArea.right;

      const labelHeight  = 14;
      const dotR         = 5;
      const distancesAsc = [32, 44, 58, 74, 92, 112, 134, 160];
      const placed       = [];

      // Pre-compute the visible non-adaptive line metas for sampling y across
      // the label's x-span when checking line overlap.
      const otherMetas = [];
      c.data.datasets.forEach((d, idx) => {
        if (idx === adaptiveIdx || !c.isDatasetVisible(idx)) return;
        const m = c.getDatasetMeta(idx);
        if (m) otherMetas.push(m);
      });

      // Returns true if any visible line crosses the y-band [yTop, yBot]
      // anywhere inside the x-range [xMin, xMax].
      const lineCrossesRect = (xMin, xMax, yTop, yBot) => {
        for (const m of otherMetas) {
          const pts = m.data;
          for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k], b = pts[k + 1];
            if (!a || !b) continue;
            // segment x-range overlap with rect x-range?
            const sxMin = Math.min(a.x, b.x), sxMax = Math.max(a.x, b.x);
            if (sxMax < xMin || sxMin > xMax) continue;
            // clip y-values at the rect's x edges (linear interp)
            const dx = b.x - a.x;
            const t1 = dx === 0 ? 0 : Math.max(0, Math.min(1, (xMin - a.x) / dx));
            const t2 = dx === 0 ? 1 : Math.max(0, Math.min(1, (xMax - a.x) / dx));
            const y1 = a.y + (b.y - a.y) * t1;
            const y2 = a.y + (b.y - a.y) * t2;
            const segYMin = Math.min(y1, y2), segYMax = Math.max(y1, y2);
            if (segYMax >= yTop && segYMin <= yBot) return true;
          }
        }
        return false;
      };

      cx.save();
      transitions.forEach((trans, i) => {
        if (!trans) return;
        const pt = meta.data[i];
        if (!pt) return;
        const isToSig = trans.includes('9sig');
        const color = isToSig ? '#22d3ee' : '#f87171';
        const titleText = trans;            // "to 9sig" or "to TQQQ"
        const preferDir = isToSig ? -1 : 1; // 9sig above, TQQQ below
        // Measure text width once so the placement search uses the actual label rect
        cx.font = 'bold 10px "DM Sans", sans-serif';
        const labelWidth = Math.ceil(cx.measureText(titleText).width) + 10;

        // 45° diagonal: dx = dy at any chosen distance. Try both vertical and
        // horizontal signs. Right-side placement is preferred; left is the
        // fallback when the right side is crowded or near the chart edge.
        const vDirs = [preferDir, -preferDir];
        const hDirs = [1, -1];
        let chosenDx = 0, chosenDy = 0, chosenSide = 1, chosenRect = null;

        outer: for (const dist of distancesAsc) {
          for (const hSign of hDirs) {
            for (const vSign of vDirs) {
              const dx = hSign * dist;
              const dy = vSign * dist;
              const ax = pt.x + dx;             // anchor (kink between diagonal and underline)
              const ay = pt.y + dy;
              // Label rect: text sits ABOVE the underline regardless of direction.
              // For right-side (hSign=+1) the rect extends right from ax; for
              // left-side (hSign=-1) it extends left from ax.
              const lTop = ay - labelHeight - 2;
              const lBot = ay + 2;
              const lLeft = hSign > 0 ? ax : ax - labelWidth;
              const lRight = hSign > 0 ? ax + labelWidth : ax;
              if (lTop < top + 2 || lBot > bottom - 2) continue;
              if (lLeft < left + 2 || lRight > right - 2) continue;
              // overlap with any visible line anywhere across the label's x-range?
              if (lineCrossesRect(lLeft, lRight, lTop, lBot)) continue;
              // overlap with a previously placed label rect?
              let labelClash = false;
              for (const p of placed) {
                if (lLeft < p.x2 && lRight > p.x1 && lTop < p.y2 && lBot > p.y1) {
                  labelClash = true; break;
                }
              }
              if (labelClash) continue;
              chosenDx = dx; chosenDy = dy; chosenSide = hSign;
              chosenRect = { x1: lLeft, y1: lTop, x2: lRight, y2: lBot };
              break outer;
            }
          }
        }
        if (!chosenRect) {
          // fallback: smallest offset in preferred direction, right side
          chosenDx = distancesAsc[0];
          chosenDy = preferDir * distancesAsc[0];
          chosenSide = 1;
        } else {
          placed.push(chosenRect);
        }

        const ax = pt.x + chosenDx;
        const ay = pt.y + chosenDy;

        cx.strokeStyle = color;
        cx.lineWidth = 1;

        // dashed circle marker at the data point
        cx.setLineDash([2, 2]);
        cx.beginPath();
        cx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2);
        cx.stroke();
        cx.setLineDash([]);

        // diagonal connector — start just outside the marker so it doesn't
        // overlap the dashed circle
        const ang = Math.atan2(chosenDy, chosenDx);
        const startX = pt.x + (dotR + 1) * Math.cos(ang);
        const startY = pt.y + (dotR + 1) * Math.sin(ang);
        cx.beginPath();
        cx.moveTo(startX, startY);
        cx.lineTo(ax, ay);
        cx.stroke();

        // horizontal underline supporting the text — extends in the same
        // direction as the label rect
        const underEnd = chosenSide > 0 ? ax + labelWidth - 6 : ax - labelWidth + 6;
        cx.beginPath();
        cx.moveTo(ax, ay);
        cx.lineTo(underEnd, ay);
        cx.stroke();

        // bold text sitting on the underline
        cx.fillStyle = color;
        cx.font = 'bold 10px "DM Sans", sans-serif';
        cx.textBaseline = 'bottom';
        if (chosenSide > 0) {
          cx.textAlign = 'left';
          cx.fillText(titleText, ax + 2, ay - 2);
        } else {
          cx.textAlign = 'right';
          cx.fillText(titleText, ax - 2, ay - 2);
        }
      });
      cx.restore();
    }
  };

  chart = new Chart(ctx, {
    type: 'line',
    plugins: [endLabelPlugin, adaptiveAnnotationPlugin],
    data: {
      labels,
      datasets: [
        {
          label: '9sig Total',
          data: totalD,
          borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.07)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2.5
        },
        {
          label: '9sig TQQQ Holding',
          data: tqqqValD,
          borderColor: '#38bdf8',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          borderDash: [2, 2],
          hidden: true
        },
        {
          label: 'B&H TQQQ',
          data: bhD,
          borderColor: '#f87171',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [6, 3]
        },
        {
          label: 'B&H QQQ',
          data: qqqD,
          borderColor: '#4ade80',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [8, 4],
          hidden: true
        },
        {
          label: 'B&H SPY',
          data: spyD,
          borderColor: '#f472b6',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          borderDash: [6, 3]
        },
        {
          label: '9sig TQQQ Target',
          data: targetD,
          borderColor: '#fb923c',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          borderDash: [4, 4],
          hidden: true
        },
        {
          label: '9sig Cash',
          data: cashD,
          borderColor: '#fbbf24',
          backgroundColor: 'rgba(251,191,36,0.05)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          hidden: true
        },
        {
          label: 'Invested Compounded',
          data: invD,
          borderColor: 'rgba(226,232,240,0.25)',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 1.5,
          borderDash: [3, 3]
        },
        {
          label: 'Adaptive',
          data: adaptiveD,
          borderColor: '#c084fc',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: adaptivePointRadius,
          pointHoverRadius: adaptivePointHoverRadius,
          pointBackgroundColor: adaptivePointBg,
          pointBorderColor: adaptivePointBg,
          pointHitRadius: 10,
          borderWidth: 2,
          order: 100,         // highest order in Chart.js → drawn LAST → on top of every other line
          _transitions: adaptiveTransitions
        },
        ...Array.from({ length: envelopeShiftCount }, (_, i) => ({
          label: '_shift_' + (i + 1),
          data: showEnvelope ? (shiftResults[i] || []) : [],
          borderColor: envColor,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 0,
          borderWidth: 1,
          order: -1,
          hidden: !showEnvelope,
          _isShift: true
        })),
        ...Array.from({ length: envelopeShiftCount }, (_, i) => ({
          label: '_bhshift_' + (i + 1),
          data: showBhEnvelope ? (bhShiftResults[i] || []) : [],
          borderColor: envColorBh,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 0,
          borderWidth: 1,
          order: -1,
          hidden: !showBhEnvelope,
          _isShift: true
        }))
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { right: 120 } },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#94a3b8',
            font: { family: 'DM Sans', size: 11 },
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 16,
            boxWidth: 8,
            boxHeight: 8,
            filter: (item, data) => !data.datasets[item.datasetIndex]._isShift
          }
        },
        tooltip: {
          enabled: false,
          external: externalTooltip
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { size: 10 },
            maxTicksLimit: 10,
            callback: function(val) {
              const d = this.getLabelForValue(val);
              return d ? d.substring(0, 7) : '';
            }
          },
          grid: { color: 'rgba(30,42,63,0.5)' }
        },
        y: {
          type: logScale ? 'logarithmic' : 'linear',
          beginAtZero: !logScale,
          ticks: {
            color: '#64748b',
            font: { family: 'JetBrains Mono', size: 10 },
            callback: v => fmt(v)
          },
          // On log scale, Chart.js generates a tick at every 1..9 × 10^n which
          // is way too dense. Keep only "nice" ticks (1, 2, 5 × 10^n) so the
          // axis stays readable.
          afterBuildTicks: (scale) => {
            if (!document.getElementById('toggle-log-scale').checked) return;
            scale.ticks = scale.ticks.filter(t => {
              const v = t.value;
              if (v <= 0) return false;
              const exp = Math.floor(Math.log10(v));
              const m = v / Math.pow(10, exp);
              return Math.abs(m - 1) < 0.05 || Math.abs(m - 2) < 0.05 || Math.abs(m - 5) < 0.05;
            });
          },
          grid: { color: 'rgba(30,42,63,0.5)' }
        }
      }
    }
  });
  } // end else (first render)

  // Table
  document.getElementById('log-body').innerHTML = log.map((l, i) => {
    const ac = l.action.startsWith('SELL') ? 'action-sell' : l.action.startsWith('BUY') ? 'action-buy' : 'action-hold';
    const bhVal = bhPoints[i] ? bhPoints[i].value : 0;
    const qqqVal = qqqPoints[i] ? qqqPoints[i].value : 0;
    const spyVal = spyPoints[i] ? spyPoints[i].value : 0;
    return `<tr>
      <td>${l.date.substring(0,7)}</td>
      <td>${fmtFull(l.invested)}</td>
      <td>${fmtFull(Math.round(l.tqqqVal))}</td>
      <td style="color:#fb923c">${fmtFull(Math.round(l.target))}</td>
      <td>${fmtFull(Math.round(l.cash))}</td>
      <td>${fmtFull(Math.round(l.total))}</td>
      <td style="color:#f87171">${fmtFull(Math.round(bhVal))}</td>
      <td style="color:#4ade80">${fmtFull(Math.round(qqqVal))}</td>
      <td style="color:#f472b6">${fmtFull(Math.round(spyVal))}</td>
      <td class="${ac}">${l.action}</td>
    </tr>`;
  }).join('');

  if (typeof refreshAnalytics === 'function') refreshAnalytics();
}

