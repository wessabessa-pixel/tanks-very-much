/* Tanks a lot — Norton Summit rain history, outlook and tanks.
   All statistics are computed here from data/rain.json so they stay in step with the data. */
'use strict';

const CONFIG = {
  capacity: 120000,      // main tanks, litres
  reserve: 10000,        // below the pump intake
  roofM2: 270,
  efficiency: 0.85,
  startTank: 103575,     // estimate at last reading (26 Nov 2026); replaced by live data once connected
  startTankDate: '2026-11-26',
  dailyUse: 470,
  trackerUrl: 'https://script.google.com/macros/s/AKfycbyTfVz7nKoa1Fd7MWiaiA6AyNVx_Ho5-lSXlxIt_2n_HwTHAu5UWD5gOtRBtH5_zsUErQ/exec'
};
const LPM = CONFIG.roofM2 * CONFIG.efficiency; // litres per mm of rain
const DAY = 86400000;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const nf = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const $ = (s, el) => (el || document).querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- stats helpers
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : NaN;
function quantile(a, q) { const s = [...a].sort((x, y) => x - y); if (!s.length) return NaN; const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
const median = a => quantile(a, 0.5);
const pctBelow = (a, v) => Math.round(a.filter(x => x < v).length / a.length * 100);
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function wordFor(p) { return p >= 90 ? 'one of the wettest' : p >= 67 ? 'wetter than usual' : p > 33 ? 'about normal' : p > 10 ? 'drier than usual' : 'one of the driest'; }
function tagFor(p) { return p >= 67 ? 'wet' : p <= 33 ? 'dry' : ''; }

// ---------------------------------------------------------------- data model
let D = null; // derived data

function deriveData(raw) {
  const start = Date.UTC(1889, 0, 1);
  const daily = raw.daily10.map(v => v / 10);
  const n = daily.length;
  const endDate = new Date(start + (n - 1) * DAY);
  const endYear = endDate.getUTCFullYear();
  const lastFull = endYear - 1;
  // per-year 365-day arrays (Feb 29 folded into Feb 28)
  const byYear = {};
  for (let i = 0; i < n; i++) {
    const d = new Date(start + i * DAY), y = d.getUTCFullYear();
    let doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / DAY);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (leap && doy >= 59) doy -= 1; // 29 Feb and after shift back one
    (byYear[y] = byYear[y] || new Array(365).fill(null));
    byYear[y][doy] = (byYear[y][doy] || 0) + daily[i];
  }
  const endDoy = (() => { let doy = Math.floor((Date.UTC(endYear, endDate.getUTCMonth(), endDate.getUTCDate()) - Date.UTC(endYear, 0, 1)) / DAY); const leap = endYear % 4 === 0; if (leap && doy >= 59) doy--; return doy; })();
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const full = years.filter(y => y <= lastFull);
  const annual = {}; full.forEach(y => annual[y] = sum(byYear[y]));
  const monthly = {}; years.forEach(y => monthly[y] = raw.monthly[String(y)]);
  return { raw, daily, start, n, endDate, endYear, endDoy, lastFull, byYear, years, full, annual, monthly,
    EN: new Set(raw.elnino), LN: new Set(raw.lanina), IP: new Set(raw.iodPos), IN: new Set(raw.iodNeg) };
}
const phaseOf = y => D.EN.has(y) ? 'El Niño' : D.LN.has(y) ? 'La Niña' : 'Neutral';
const phaseColor = y => D.EN.has(y) ? 'var(--warm)' : D.LN.has(y) ? 'var(--cool)' : 'var(--neutral)';
const doyToDate = (doy, y) => { const d = new Date(Date.UTC(y || 2025, 0, 1) + doy * DAY); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
const MONTH_OF_DOY = Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * DAY).getUTCMonth() + 1);
function seasonTotal(y, months, uptoDoy) { // months 1..12; optional cut-off day-of-year
  const arr = D.byYear[y]; if (!arr) return null; let t = 0;
  const end = uptoDoy == null ? 364 : Math.min(364, uptoDoy);
  for (let i = 0; i <= end; i++) if (arr[i] != null && months.includes(MONTH_OF_DOY[i])) t += arr[i];
  return t;
}

// ---------------------------------------------------------------- tooltip
const tip = $('#tip');
function showTip(html, x, y) { tip.innerHTML = html; tip.style.left = Math.min(Math.max(x, 125), innerWidth - 125) + 'px'; tip.style.top = Math.max(y, 60) + 'px'; tip.style.opacity = 1; }
function hideTip() { tip.style.opacity = 0; }
document.addEventListener('pointerdown', e => { if (!e.target.closest('svg.chart')) hideTip(); });
function bindTips(svg) {
  const handler = e => { const t = e.target.closest('[data-tip]'); if (t) showTip(t.getAttribute('data-tip'), e.clientX, e.clientY); else hideTip(); };
  svg.addEventListener('pointerdown', handler); svg.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') handler(e); });
  svg.addEventListener('pointerleave', hideTip);
}

// ---------------------------------------------------------------- svg helpers
function yAxis(Y, ticks, W, pl, pr, fmt) {
  return ticks.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${pl - 5}" y="${Y(v) + 3.5}" text-anchor="end">${fmt ? fmt(v) : v}</text>`).join('');
}
function niceTicks(max, count) { const raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw))); const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw); const out = []; for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6)); return out; }
const path = pts => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
function area(top, bottom) { return path(top) + bottom.slice().reverse().map(p => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('') + 'Z'; }

// ================================================================= RAIN: THIS YEAR
function renderThisYear(el) {
  const y = D.endYear, doy = D.endDoy;
  const cum = arr => { const out = []; let t = 0; for (let i = 0; i < 365; i++) { t += arr[i] || 0; out.push(t); } return out; };
  const curves = D.full.map(yy => cum(D.byYear[yy]));
  const nowCum = cum(D.byYear[y]).slice(0, doy + 1);
  const ytdAll = D.full.map(yy => curves[D.full.indexOf(yy)][doy]);
  const ytd = nowCum[doy], p = pctBelow(ytdAll, ytd);
  const rank = ytdAll.filter(v => v > ytd).length + 1;
  const bands = [0.1, 0.25, 0.5, 0.75, 0.9].map(q => Array.from({ length: 365 }, (_, i) => quantile(curves.map(c => c[i]), q)));

  // seasons
  const seasons = [
    { name: 'Autumn', sub: 'Mar–May', months: [3, 4, 5] },
    { name: 'Winter', sub: 'Jun–Aug', months: [6, 7, 8] },
    { name: 'Spring', sub: 'Sep–Nov', months: [9, 10, 11] }
  ].map(s => {
    const firstDoy = Math.floor((Date.UTC(2025, s.months[0] - 1, 1) - Date.UTC(2025, 0, 1)) / DAY);
    if (doy < firstDoy) return null;
    const cut = Math.min(doy, Math.floor((Date.UTC(2025, s.months[2], 0) - Date.UTC(2025, 0, 1)) / DAY));
    const v = seasonTotal(y, s.months, cut), all = D.full.map(yy => seasonTotal(yy, s.months, cut));
    const partial = cut < Math.floor((Date.UTC(2025, s.months[2], 0) - Date.UTC(2025, 0, 1)) / DAY);
    return Object.assign(s, { v, p: pctBelow(all, v), med: median(all), partial });
  }).filter(Boolean);

  // last 30 days
  const l30 = (arr, end) => { let t = 0; for (let i = end - 29; i <= end; i++) t += (i >= 0 ? arr[i] : 0) || 0; return t; };
  const last30 = l30(D.byYear[y], doy), all30 = D.full.map(yy => l30(D.byYear[yy], doy)), p30 = pctBelow(all30, last30);

  // chart
  const W = 340, H = 220, pl = 36, pr = 34, pt = 8, pb = 22;
  const ymax = Math.ceil(Math.max(bands[4][364], nowCum[doy]) / 200) * 200;
  const X = i => pl + i / 364 * (W - pl - pr), Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  const pts = arr => arr.map((v, i) => [X(i), Y(v)]);
  let g = yAxis(Y, niceTicks(ymax, 4), W, pl, pr);
  g += `<path d="${area(pts(bands[4]), pts(bands[0]))}" fill="var(--band)"/>`;
  g += `<path d="${area(pts(bands[3]), pts(bands[1]))}" fill="var(--band2)"/>`;
  g += `<path d="${path(pts(bands[2]))}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  g += `<path d="${path(pts(nowCum))}" fill="none" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  g += `<circle cx="${X(doy)}" cy="${Y(ytd)}" r="4.5" fill="var(--ink)" stroke="var(--card)" stroke-width="2"/>`;
  g += `<text class="lbl" x="${W - pr + 4}" y="${Y(bands[2][364]) + 4}">median</text>`;
  for (let m = 0; m < 12; m += 2) { const i = Math.floor((Date.UTC(2025, m, 1) - Date.UTC(2025, 0, 1)) / DAY); g += `<text x="${X(i)}" y="${H - 6}">${MON[m]}</text>`; }
  // invisible hover columns
  for (let i = 0; i < 365; i += 7) {
    const now = i <= doy ? `<br>${y}: <b>${nf.format(nowCum[i])} mm</b>` : '';
    g += `<rect x="${X(i)}" y="0" width="${(W - pl - pr) / 52 + 0.5}" height="${H - pb}" fill="transparent" data-tip="<b>To ${doyToDate(i)}</b>${now}<br>Typical: ${nf.format(bands[2][i])} mm<br>Middle half of years: ${nf.format(bands[1][i])}–${nf.format(bands[3][i])}"/>`;
  }

  el.innerHTML = `
    <div class="card">
      <div class="big num">${nf.format(ytd)} <small>mm so far in ${y}</small></div>
      <p class="lead">${cap(wordFor(p))}: more rain than <b>${p}%</b> of years by this date <span class="muted">(${ordinal(rank)} wettest of ${ytdAll.length + 1})</span>.</p>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rain building up through ${y} against all years since 1889">${g}</svg></div>
      <div class="legend"><span><i class="line" style="background:var(--ink)"></i>${y}</span><span><i class="line" style="background:var(--ink-3)"></i>Median year</span><span><i style="background:var(--band2)"></i>Middle half of years</span><span><i style="background:var(--band)"></i>8 in 10 years</span></div>
    </div>
    <div class="card">
      <h2>Seasons this year</h2>
      <div class="chips">${seasons.map(s => `<div class="chipcard"><span>${s.name} <span class="tiny">${s.sub}</span></span><b>${nf.format(s.v)}<span class="tiny muted">&nbsp;mm</span></b><span>${s.partial ? 'so far · ' : ''}typical ${nf.format(s.med)}</span><span class="tag ${tagFor(s.p)}">wetter than ${s.p}%</span></div>`).join('')}</div>
      <p class="small muted" style="margin-top:10px">Last 30 days: <b>${nf.format(last30)} mm</b>, wetter than ${p30}% of years for the same 30 days.</p>
    </div>
    <p class="note">Rain for the Norton Summit area: the average of two 5 km SILO grid cells, 1889 to ${doyToDate(doy, y)} ${y}. Each year runs on the 9 am rain day.</p>`;
  bindTips($('svg', el));
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// ================================================================= RAIN: HISTORY
function renderHistory(el) {
  const full = D.full, ann = full.map(y => D.annual[y]);
  const split = 1990, early = full.filter(y => y < split), recent = full.filter(y => y >= split);
  const eMean = mean(early.map(y => D.annual[y])), rMean = mean(recent.map(y => D.annual[y]));
  const med = median(ann);

  // annual bars + 30-year average
  const W = 340, H = 200, pl = 34, pr = 6, pt = 8, pb = 22;
  const ymax = Math.ceil(Math.max(...ann) / 200) * 200, bw = (W - pl - pr) / full.length;
  const X = i => pl + i * bw, Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = yAxis(Y, niceTicks(ymax, 4), W, pl, pr);
  full.forEach((y, i) => {
    const v = D.annual[y], rnk = ann.filter(a => a > v).length + 1;
    g += `<rect x="${X(i) + 0.3}" y="${Y(v)}" width="${Math.max(bw - 0.6, 0.8)}" height="${Y(0) - Y(v)}" fill="${phaseColor(y)}" opacity="${D.EN.has(y) || D.LN.has(y) ? 0.95 : 0.55}" data-tip="<b>${y}</b>: ${nf.format(v)} mm<br>${ordinal(rnk)} wettest of ${full.length}<br>${phaseOf(y)}${D.IP.has(y) ? ' · positive IOD' : D.IN.has(y) ? ' · negative IOD' : ''}"/>`;
  });
  const roll = full.map((y, i) => i < 29 ? null : [X(i) + bw / 2, Y(mean(full.slice(i - 29, i + 1).map(yy => D.annual[yy])))]).filter(Boolean);
  g += `<path d="${path(roll)}" fill="none" stroke="var(--ink)" stroke-width="2.2" stroke-linejoin="round"/>`;
  [1900, 1925, 1950, 1975, 2000, 2025].forEach(y => { const i = full.indexOf(y); if (i >= 0) g += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${y}</text>`; });

  // monthly shift
  const mE = Array.from({ length: 12 }, (_, m) => mean(early.map(y => D.monthly[y][m])));
  const mR = Array.from({ length: 12 }, (_, m) => mean(recent.map(y => D.monthly[y][m])));
  const W2 = 340, H2 = 190, pl2 = 30, pr2 = 4, pt2 = 18, pb2 = 22, ymax2 = Math.ceil(Math.max(...mE, ...mR) / 20) * 20;
  const gw = (W2 - pl2 - pr2) / 12, Y2 = v => pt2 + (1 - v / ymax2) * (H2 - pt2 - pb2);
  let g2 = yAxis(Y2, niceTicks(ymax2, 3), W2, pl2, pr2);
  for (let m = 0; m < 12; m++) {
    const x = pl2 + m * gw, w = (gw - 6) / 2, chg = Math.round((mR[m] / mE[m] - 1) * 100);
    const tipTxt = `<b>${MON[m]}</b><br>1889–1989: ${nf.format(mE[m])} mm<br>1990–${D.lastFull}: ${nf.format(mR[m])} mm<br>${chg > 0 ? '+' : ''}${chg}%`;
    g2 += `<rect x="${x + 2}" y="${Y2(mE[m])}" width="${w}" height="${Y2(0) - Y2(mE[m])}" rx="2" fill="var(--neutral)" opacity=".6" data-tip="${tipTxt}"/>`;
    g2 += `<rect x="${x + 2 + w + 2}" y="${Y2(mR[m])}" width="${w}" height="${Y2(0) - Y2(mR[m])}" rx="2" fill="var(--water)" data-tip="${tipTxt}"/>`;
    if (Math.abs(chg) >= 15) g2 += `<text class="lbl" x="${x + gw / 2}" y="${Y2(Math.max(mE[m], mR[m])) - 4}" text-anchor="middle" style="font-weight:600">${chg > 0 ? '+' : ''}${chg}%</text>`;
    g2 += `<text x="${x + gw / 2}" y="${H2 - 6}" text-anchor="middle">${MON[m][0]}</text>`;
  }

  // insights
  const winter = m => [5, 6, 7, 8].includes(m);
  const wE = sum(mE.filter((_, m) => winter(m))), wR = sum(mR.filter((_, m) => winter(m)));
  const drops = mE.map((e, m) => ({ m, c: (mR[m] / e - 1) * 100 })).filter(o => o.c <= -10).sort((a, b) => a.c - b.c);
  const rdE = mean(early.map(y => D.raw.raindays[y])), rdR = mean(recent.map(y => D.raw.raindays[y]));
  const hvE = mean(early.map(y => D.raw.heavydays[y])), hvR = mean(recent.map(y => D.raw.heavydays[y]));
  // dry runs
  const runs = []; let cur = [];
  full.forEach(y => { if (D.annual[y] < med) cur.push(y); else { if (cur.length >= 3) runs.push(cur); cur = []; } });
  if (cur.length >= 3) runs.push(cur);
  runs.sort((a, b) => b.length - a.length);
  const two = full.slice(1).map(y => ({ y, v: D.annual[y] + D.annual[y - 1] })).sort((a, b) => a.v - b.v);
  const latest2 = two.findIndex(o => o.y === D.lastFull) + 1;
  // memory: after a driest-fifth year, how often was next year below median?
  const q20 = quantile(ann, 0.2), dryYears = full.filter(y => D.annual[y] <= q20 && D.annual[y + 1] != null);
  const nextBelow = Math.round(dryYears.filter(y => D.annual[y + 1] < med).length / dryYears.length * 100);
  const chgAll = Math.round((rMean / eMean - 1) * 100);
  const items = [
    `Since 1990 the average year brings <b>${nf.format(rMean)} mm</b>, against ${nf.format(eMean)} mm from 1889 to 1989 (${chgAll > 0 ? '+' : ''}${chgAll}%). Normal year-to-year swings are about ±${nf.format(quantile(ann, 0.84) - med)} mm, so the shift is real but smaller than ordinary variation.`,
    `Winter (Jun–Sep) has barely changed: ${nf.format(wR)} mm now against ${nf.format(wE)} mm before. The drying is at the edges of the wet season: ${drops.slice(0, 3).map(o => `${MON[o.m]} ${Math.round(o.c)}%`).join(', ')}. The autumn break tends to arrive later and spring finishes earlier, so tanks spend longer waiting for the refill.`,
    `About ${Math.round(rdE - rdR)} fewer rainy days a year (${Math.round(rdR)} now, ${Math.round(rdE)} before). Big falls of 20 mm or more are unchanged (${hvR.toFixed(1)} a year now, ${hvE.toFixed(1)} before). It's the light, drizzly days that have dropped away.`,
    runs.length ? `The longest run of below-median years was <b>${runs[0][0]}–${runs[0][runs[0].length - 1]}</b> (${runs[0].length} years in a row). ${latest2 && latest2 <= 5 ? `${D.lastFull - 1}–${D.lastFull} was the ${ordinal(latest2)} driest two-year stretch on record.` : ''}` : '',
    `A dry year doesn't predict the next one. After the driest fifth of years, the following year was below median ${nextBelow}% of the time, not far off a coin toss.`
  ].filter(Boolean);

  el.innerHTML = `
    <div class="card">
      <h2>Every year since 1889</h2>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual rainfall since 1889, coloured by El Niño and La Niña">${g}</svg></div>
      <div class="legend"><span><i style="background:var(--warm)"></i>El Niño year</span><span><i style="background:var(--cool)"></i>La Niña year</span><span><i style="background:var(--neutral);opacity:.6"></i>Neutral</span><span><i class="line" style="background:var(--ink)"></i>30-year average</span></div>
    </div>
    <div class="card">
      <h2>How the seasons have shifted</h2>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W2} ${H2}" role="img" aria-label="Average rain by month, before and since 1990">${g2}</svg></div>
      <div class="legend"><span><i style="background:var(--neutral);opacity:.6"></i>1889–1989</span><span><i style="background:var(--water)"></i>1990–${D.lastFull}</span></div>
    </div>
    <div class="card"><h2>What the record shows</h2><ul class="insights">${items.map(t => `<li>${t}</li>`).join('')}</ul></div>
    <p class="note">Tap any bar for the details. El Niño and La Niña years follow the Bureau of Meteorology's event list.</p>`;
  $('#view-rain').querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= RAIN: DRIVERS
function renderDrivers(el) {
  const months = [4, 5, 6, 7, 8, 9, 10];
  const refill = y => seasonTotal(y, months);
  const base = D.full.filter(y => y >= 1900), med = median(base.map(refill));
  const base60 = base.filter(y => y >= 1960), med60 = median(base60.map(refill));
  const rows = [
    { label: 'El Niño', ys: base.filter(y => D.EN.has(y)), med, color: 'var(--warm)' },
    { label: 'Neutral', ys: base.filter(y => !D.EN.has(y) && !D.LN.has(y)), med, color: 'var(--neutral)' },
    { label: 'La Niña', ys: base.filter(y => D.LN.has(y)), med, color: 'var(--cool)' },
    { label: 'IOD +', ys: base60.filter(y => D.IP.has(y)), med: med60, color: 'var(--warm)' },
    { label: 'IOD −', ys: base60.filter(y => D.IN.has(y)), med: med60, color: 'var(--cool)' },
    { label: 'Both dry', ys: base60.filter(y => D.EN.has(y) && D.IP.has(y)), med: med60, color: 'var(--warm)' }
  ];
  const y0 = D.endYear, have2026 = D.endDoy >= 303; // Oct complete
  const v2026 = have2026 ? refill(y0) : null;
  const W = 340, rowH = 34, pl = 64, pr = 10, pt = 18, H = pt + rows.length * rowH + 20;
  const xmin = 20, xmax = 200, X = v => pl + (Math.min(Math.max(v, xmin), xmax) - xmin) / (xmax - xmin) * (W - pl - pr);
  let g = '';
  [50, 100, 150, 200].forEach(v => g += `<line x1="${X(v)}" x2="${X(v)}" y1="${pt - 6}" y2="${H - 18}" stroke="${v === 100 ? 'var(--ink-3)' : 'var(--grid)'}" ${v === 100 ? 'stroke-dasharray="3 3"' : ''}/><text x="${X(v)}" y="${H - 5}" text-anchor="middle">${v}%</text>`);
  g += `<text x="${X(100)}" y="${pt - 8}" text-anchor="middle">normal</text>`;
  const summary = [];
  rows.forEach((r, i) => {
    const cy = pt + i * rowH + rowH / 2, vals = r.ys.map(y => ({ y, p: refill(y) / r.med * 100 }));
    g += `<text class="lbl" x="0" y="${cy + 4}">${r.label}</text>`;
    // simple jitter to separate overlapping dots
    vals.sort((a, b) => a.p - b.p).forEach((o, k) => {
      const jit = ((k % 3) - 1) * 6;
      g += `<circle cx="${X(o.p)}" cy="${cy + jit}" r="4" fill="${r.color}" opacity=".75" stroke="var(--card)" stroke-width="1" data-tip="<b>${o.y}</b>: ${Math.round(o.p)}% of normal Apr–Oct rain"/>`;
    });
    const m = median(vals.map(o => o.p));
    g += `<line x1="${X(m)}" x2="${X(m)}" y1="${cy - 12}" y2="${cy + 12}" stroke="var(--ink)" stroke-width="2.5" stroke-linecap="round"/>`;
    if (have2026 && r.ys.includes(y0) === false && ((r.label === 'El Niño' && D.EN.has(y0)) || (r.label === 'IOD +' && D.IP.has(y0)) || (r.label === 'Both dry' && D.EN.has(y0) && D.IP.has(y0)))) {
      g += `<circle cx="${X(v2026 / r.med * 100)}" cy="${cy}" r="6.5" fill="none" stroke="var(--ink)" stroke-width="2" data-tip="<b>${y0}</b>: ${Math.round(v2026 / r.med * 100)}% of normal Apr–Oct rain"/>`;
    }
    const below = Math.round(vals.filter(o => o.p < 100).length / vals.length * 100);
    summary.push({ label: r.label, n: vals.length, m: Math.round(m), below });
  });

  const s = Object.fromEntries(summary.map(o => [o.label, o]));
  const items = [
    `<b>El Niño shifts the odds but doesn't decide them.</b> In El Niño years the April–October refill season typically brings ${s['El Niño'].m}% of normal, and ${s['El Niño'].below}% of them came in below normal. Some, like 1951 and 1963, were very wet.`,
    `<b>The Indian Ocean matters as much.</b> In positive-IOD years the refill season typically brings ${s['IOD +'].m}% of normal; in negative-IOD years, ${s['IOD −'].m}%. When El Niño and a positive IOD coincide, ${s['Both dry'].below}% of years came in below normal.`,
    `<b>La Niña does less here than you'd expect:</b> a typical ${s['La Niña'].m}% of normal over April–October. Its clearest effect is an earlier autumn break.`,
    have2026 ? `<b>${y0}</b> is an El Niño year with a positive IOD, the classic dry combination. Its April–October rain was <b>${Math.round(v2026 / med * 100)}% of normal</b> (ringed on the chart), a reminder that the drivers tilt the odds rather than set the outcome.` : ''
  ].filter(Boolean);

  el.innerHTML = `
    <div class="card">
      <h2>Refill season rain by climate driver</h2>
      <p class="small muted" style="margin-top:-4px">April–October rain as a % of normal. Each dot is a year; the bar marks the typical year.</p>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="April to October rain in El Niño, neutral, La Niña and Indian Ocean Dipole years">${g}</svg></div>
    </div>
    <div class="card"><h2>What it means</h2><ul class="insights">${items.map(t => `<li>${t}</li>`).join('')}</ul></div>
    <p class="note">ENSO years since 1900 and IOD years since 1960 (when reliable ocean data begins), from the Bureau of Meteorology. For the season ahead, see the <a href="https://www.bom.gov.au/climate/outlooks/" target="_blank" rel="noopener">BOM long-range forecast</a>.</p>`;
  bindTips($('svg', el));
}

// ================================================================= OUTLOOK
const outlook = { rate: CONFIG.dailyUse, start: CONFIG.startTank, subset: 'all' };
function histories(subset) {
  const today = new Date(), md = [today.getMonth(), today.getDate()];
  const years = 3, days = 365 * years;
  const out = [];
  for (const y of D.years) {
    if (subset === 'recent' && y < 1990) continue;
    if (subset === 'elnino' && !D.EN.has(y)) continue;
    if (subset === 'iodpos' && !D.IP.has(y)) continue;
    const i0 = Math.round((Date.UTC(y, md[0], md[1]) - D.start) / DAY);
    if (i0 < 0 || i0 + days > D.n) continue;
    out.push({ y, rain: D.daily.slice(i0, i0 + days) });
  }
  return out;
}
function simulate(rain, rate, start, days) {
  let b = start, min = b, minDay = 0, hit = null; const traj = new Float32Array(days);
  for (let i = 0; i < days; i++) {
    b = Math.min(CONFIG.capacity, b - rate + rain[i] * LPM);
    if (b < min) { min = b; minDay = i; }
    if (hit === null && b <= CONFIG.reserve) hit = i;
    traj[i] = Math.max(b, 0);
  }
  return { traj, min, minDay, hit };
}
function reliability(hs, rate, start, days) { return hs.filter(h => simulate(h.rain, rate, start, Math.min(days, h.rain.length)).hit === null).length / hs.length; }

function renderOutlook() {
  const el = $('#view-outlook');
  el.innerHTML = `
    <div class="view-head"><h1>Outlook</h1><span class="sub">your tanks × 137 years of rain</span></div>
    <div class="card controls">
      <div class="slider-row"><label for="o-rate">Daily use</label><input id="o-rate" type="range" min="250" max="800" step="10" value="${outlook.rate}"><output id="o-rate-out"></output></div>
      <div class="slider-row"><label for="o-start">In tanks now</label><input id="o-start" type="range" min="10000" max="120000" step="500" value="${outlook.start}"><output id="o-start-out"></output></div>
      <div class="pills" role="group" aria-label="Which years to replay">
        ${[['all', 'All years'], ['recent', 'Since 1990'], ['elnino', 'After El Niño'], ['iodpos', 'After IOD +']].map(([k, l]) => `<button data-subset="${k}" aria-pressed="${outlook.subset === k}">${l}</button>`).join('')}
      </div>
    </div>
    <div id="o-body"></div>`;
  const upd = () => drawOutlook();
  $('#o-rate').oninput = e => { outlook.rate = +e.target.value; upd(); };
  $('#o-start').oninput = e => { outlook.start = +e.target.value; upd(); };
  el.querySelectorAll('[data-subset]').forEach(b => b.onclick = () => { outlook.subset = b.dataset.subset; el.querySelectorAll('[data-subset]').forEach(x => x.setAttribute('aria-pressed', x === b)); upd(); });
  drawOutlook();
}

function drawOutlook() {
  $('#o-rate-out').textContent = nf.format(outlook.rate) + ' L/day';
  $('#o-start-out').textContent = nf.format(outlook.start) + ' L';
  const hs = histories(outlook.subset), days = 365 * 3;
  const sims = hs.map(h => Object.assign(simulate(h.rain, outlook.rate, outlook.start, days), { y: h.y }));
  const n = sims.length;
  const within = d => sims.filter(s => s.hit !== null && s.hit < d).length;
  const c12 = within(365), c24 = within(730), c36 = within(1095);
  const lows1 = sims.map(s => Math.min(...s.traj.slice(0, 365)));
  const lowDays = sims.map(s => { let mi = 0; for (let i = 1; i < 365; i++) if (s.traj[i] < s.traj[mi]) mi = i; return mi; });
  const lowMonth = (() => { const c = {}; lowDays.forEach(d => { const m = new Date(Date.now() + d * DAY).getMonth(); c[m] = (c[m] || 0) + 1; }); return +Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; })();
  const worst = sims.slice().sort((a, b) => a.min - b.min).slice(0, 3);

  // fan chart (weekly percentiles)
  const W = 340, H = 220, pl = 36, pr = 8, pt = 10, pb = 22;
  const X = i => pl + i / (days - 1) * (W - pl - pr), Y = v => pt + (1 - v / CONFIG.capacity) * (H - pt - pb);
  const idx = []; for (let i = 0; i < days; i += 7) idx.push(i); idx.push(days - 1);
  const q = qq => idx.map(i => [X(i), Y(quantile(sims.map(s => s.traj[i]), qq))]);
  let g = yAxis(Y, [0, 30000, 60000, 90000, 120000], W, pl, pr, v => v / 1000 + 'k');
  g += `<rect x="${pl}" y="${Y(CONFIG.reserve)}" width="${W - pl - pr}" height="${Y(0) - Y(CONFIG.reserve)}" fill="rgba(194,65,12,.12)"/><text x="${pl + 4}" y="${Y(0) - 3}" style="font-size:10px;fill:var(--warn)">pump reserve</text>`;
  g += `<path d="${area(q(0.9), q(0.1))}" fill="var(--band)"/>`;
  g += `<path d="${area(q(0.75), q(0.25))}" fill="var(--band2)"/>`;
  g += `<path d="${path(q(0.5))}" fill="none" stroke="var(--water)" stroke-width="2.5" stroke-linejoin="round"/>`;
  const worstPts = idx.map(i => [X(i), Y(worst[0].traj[i])]);
  g += `<path d="${path(worstPts)}" fill="none" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  const t0 = new Date();
  for (let k = 0; k <= 36; k += 6) {
    const d = new Date(t0.getFullYear(), t0.getMonth() + k, 1), i = Math.round((d - t0) / DAY);
    if (i < 0 || i >= days) continue;
    g += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${MON[d.getMonth()]}${d.getMonth() === 0 || k === 0 ? ' ' + String(d.getFullYear()).slice(2) : ''}</text>`;
  }
  for (let i = 0; i < days; i += 14) {
    const vals = sims.map(s => s.traj[i]);
    g += `<rect x="${X(i)}" y="0" width="${(W - pl - pr) / (days / 14) + 0.5}" height="${H - pb}" fill="transparent" data-tip="<b>${new Date(t0.getTime() + i * DAY).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</b><br>Typical: ${nf.format(quantile(vals, 0.5))} L<br>8 in 10 years: ${nf.format(quantile(vals, 0.1))}–${nf.format(quantile(vals, 0.9))} L"/>`;
  }

  // reliability curve (5 years needs 5-year histories; use 3-year window consistently)
  const rates = []; for (let r = 300; r <= 700; r += 20) rates.push(r);
  const rel = rates.map(r => reliability(hs, r, outlook.start, days) * 100);
  const W2 = 340, H2 = 170, pl2 = 36, pr2 = 8, pt2 = 10, pb2 = 24;
  const X2 = r => pl2 + (r - 300) / 400 * (W2 - pl2 - pr2), Y2 = v => pt2 + (1 - v / 100) * (H2 - pt2 - pb2);
  let g2 = yAxis(Y2, [0, 50, 100], W2, pl2, pr2, v => v + '%');
  g2 += `<path d="${path(rates.map((r, i) => [X2(r), Y2(rel[i])]))}" fill="none" stroke="var(--water)" stroke-width="2.5" stroke-linejoin="round"/>`;
  rates.forEach((r, i) => g2 += `<circle cx="${X2(r)}" cy="${Y2(rel[i])}" r="9" fill="transparent" data-tip="<b>${r} L/day</b><br>Stays clear of the reserve in ${Math.round(rel[i])}% of rain histories over 3 years"/>`);
  const safe = rates.filter((r, i) => rel[i] >= 95).pop();
  if (safe) g2 += `<line x1="${X2(safe)}" x2="${X2(safe)}" y1="${pt2}" y2="${H2 - pb2}" stroke="var(--good)" stroke-dasharray="3 3"/><text x="${X2(safe) - 4}" y="${pt2 + 10}" text-anchor="end" style="fill:var(--good);font-weight:600">${safe} L/day</text>`;
  g2 += `<line x1="${X2(outlook.rate)}" x2="${X2(outlook.rate)}" y1="${pt2}" y2="${H2 - pb2}" stroke="var(--ink)" stroke-width="1.5"/><text x="${X2(outlook.rate) + 4}" y="${H2 - pb2 - 6}" style="fill:var(--ink)">you</text>`;
  [300, 400, 500, 600, 700].forEach(r => g2 += `<text x="${X2(r)}" y="${H2 - 8}" text-anchor="middle">${r}</text>`);

  const pct = c => Math.round(c / n * 100);
  const subsetLabel = { all: `all ${n} years since 1889`, recent: `the ${n} years since 1990`, elnino: `the ${n} El Niño years`, iodpos: `the ${n} positive-IOD years` }[outlook.subset];
  $('#o-body').innerHTML = `
    <div class="card">
      <div class="stat3">
        <div><b>${pct(c12)}%</b><span>chance of hitting the reserve in 12 months</span></div>
        <div><b>${pct(c24)}%</b><span>within 2 years</span></div>
        <div><b>${pct(c36)}%</b><span>within 3 years</span></div>
      </div>
      <p class="lead" style="margin-top:12px">The usual low point is around <b>${MON[lowMonth]}</b>, at about <b>${nf.format(Math.round(median(lows1) / 1000) * 1000)} L</b>. In the worst 1 in 10 years it gets down to ${nf.format(Math.round(quantile(lows1, 0.1) / 1000) * 1000)} L.</p>
    </div>
    <div class="card">
      <h2>Tank level, next 3 years</h2>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Range of tank levels over the next three years">${g}</svg></div>
      <div class="legend"><span><i class="line" style="background:var(--water)"></i>Typical</span><span><i style="background:var(--band2)"></i>Middle half</span><span><i style="background:var(--band)"></i>8 in 10 years</span><span><i class="line" style="background:var(--warn)"></i>Worst: rain from ${worst[0].y}</span></div>
    </div>
    <div class="card">
      <h2>How much can you use?</h2>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W2} ${H2}" role="img" aria-label="Chance of staying clear of the reserve at each daily use">${g2}</svg></div>
      <p class="small" style="margin-top:6px">${safe ? `About <b>${safe} L/day</b> keeps you clear of the pump reserve in 19 of 20 rain histories over the next 3 years.` : 'No steady daily use keeps you clear in 19 of 20 histories from this starting level.'} Using more in summer and less in winter helps, as does a fuller tank going into summer.</p>
    </div>
    <p class="note">Replays your tanks through ${subsetLabel}, starting from today's date each year: ${nf.format(CONFIG.capacity)} L capacity, ${nf.format(LPM)} L caught per mm (${CONFIG.roofM2} m² roof at ${Math.round(CONFIG.efficiency * 100)}%), overflow when full. Odds, not a forecast: past rain doesn't promise future rain, and the drying since 1990 shows up in the "Since 1990" view.</p>`;
  $('#o-body').querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= TANKS (v1 next)
function renderTanks() {
  const key = localStorage.getItem('tal-key');
  $('#view-tanks').innerHTML = `
    <div class="view-head"><h1>Tanks</h1><span class="sub">Norton Summit</span></div>
    <div class="card">
      <div class="big num">${nf.format(Math.round((CONFIG.startTank - CONFIG.reserve) / 100) * 100)} <small>L usable</small></div>
      <p class="lead">At the last reading (${new Date(CONFIG.startTankDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}).</p>
      <p class="small muted">The full tank screens (log a reading, usage, planner) are being rebuilt for this app next. Until then, log readings in the current tracker.</p>
    </div>
    ${key ? `<a class="btn" href="${CONFIG.trackerUrl}?k=${encodeURIComponent(key)}" target="_blank" rel="noopener">Open tank tracker</a>`
          : `<p class="note">Open this app once from your personal tracker link to connect your tanks.</p>`}`;
}

// ================================================================= RAIN view shell
const rainState = { sub: 'year' };
function renderRain() {
  const el = $('#view-rain');
  el.innerHTML = `
    <div class="view-head"><h1>Rain</h1><span class="sub">Norton Summit since 1889</span></div>
    <div class="seg" role="tablist">${[['year', 'This year'], ['history', 'History'], ['drivers', 'Drivers']].map(([k, l]) => `<button role="tab" data-sub="${k}" aria-selected="${rainState.sub === k}">${l}</button>`).join('')}</div>
    <div id="rain-body"></div>`;
  el.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { rainState.sub = b.dataset.sub; renderRain(); scrollTo(0, 0); });
  const body = $('#rain-body');
  ({ year: renderThisYear, history: renderHistory, drivers: renderDrivers })[rainState.sub](body);
}

// ================================================================= tabs + boot
const rendered = {};
function show(tab) {
  document.querySelectorAll('.tabbar [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + tab);
  if (!rendered[tab] && D) { ({ tanks: renderTanks, rain: renderRain, outlook: renderOutlook })[tab](); rendered[tab] = true; }
  hideTip(); scrollTo(0, 0);
  try { localStorage.setItem('tal-tab', tab); } catch (e) {}
  history.replaceState(null, '', '#' + tab);
}
document.querySelectorAll('.tabbar [data-tab]').forEach(b => b.onclick = () => show(b.dataset.tab));

(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('k')) { try { localStorage.setItem('tal-key', params.get('k')); } catch (e) {} history.replaceState(null, '', location.pathname + location.hash); }
  const initial = (location.hash || '').slice(1) || (() => { try { return localStorage.getItem('tal-tab'); } catch (e) { return null; } })() || 'rain';
  document.querySelectorAll('.view').forEach(v => v.innerHTML = '<div class="skeleton">Loading 137 years of rain…</div>');
  const raw = await fetch('data/rain.json', { cache: 'no-cache' }).then(r => r.json());
  D = deriveData(raw);
  show(['tanks', 'rain', 'outlook'].includes(initial) ? initial : 'rain');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
