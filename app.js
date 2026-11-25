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

// ================================================================= shared card layout
// Every card: a plain-language answer first, a line of why, the chart, then the numbers on request.
function card({ q, headline, explain, chart, legend, numbers, numbersLabel }) {
  return `<div class="card">
    ${q ? `<div class="q">${q}</div>` : ''}
    ${headline ? `<h3 class="answer">${headline}</h3>` : ''}
    ${explain ? `<p class="explain">${explain}</p>` : ''}
    ${chart ? `<div class="chart-wrap">${chart}</div>` : ''}
    ${legend ? `<div class="legend">${legend}</div>` : ''}
    ${numbers ? `<details><summary>${numbersLabel || 'See the numbers'}</summary>${numbers}</details>` : ''}
  </div>`;
}
function table(head, rows, opts) {
  opts = opts || {};
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h, i) => `<th${i ? ' class="r"' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr${r.hl ? ' class="hl"' : ''}>${(r.cells || r).map((c, i) => `<td${i ? ' class="r"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${opts.note ? `<p class="tiny muted" style="margin:6px 2px 0">${opts.note}</p>` : ''}`;
}
const pctTxt = v => (v > 0 ? '+' : '') + Math.round(v) + '%';
const mm = v => nf.format(v) + ' mm';

// ================================================================= RAIN: THIS YEAR
function renderThisYear(el) {
  const y = D.endYear, doy = D.endDoy;
  const cum = arr => { const out = []; let t = 0; for (let i = 0; i < 365; i++) { t += arr[i] || 0; out.push(t); } return out; };
  const curves = D.full.map(yy => cum(D.byYear[yy]));
  const nowCum = cum(D.byYear[y]).slice(0, doy + 1);
  const ytdAll = curves.map(c => c[doy]);
  const ytd = nowCum[doy], p = pctBelow(ytdAll, ytd);
  const rank = ytdAll.filter(v => v > ytd).length + 1;
  const bands = [0.1, 0.25, 0.5, 0.75, 0.9].map(q => Array.from({ length: 365 }, (_, i) => quantile(curves.map(c => c[i]), q)));

  const seasons = [
    { name: 'Autumn', sub: 'Mar–May', months: [3, 4, 5] },
    { name: 'Winter', sub: 'Jun–Aug', months: [6, 7, 8] },
    { name: 'Spring', sub: 'Sep–Nov', months: [9, 10, 11] },
    { name: 'Summer', sub: 'Dec–Feb', months: [12] }
  ].map(s => {
    const firstDoy = Math.floor((Date.UTC(2025, s.months[0] - 1, 1) - Date.UTC(2025, 0, 1)) / DAY);
    const lastDoy = Math.floor((Date.UTC(2025, s.months[s.months.length - 1], 0) - Date.UTC(2025, 0, 1)) / DAY);
    if (doy < firstDoy) return null;
    const cut = Math.min(doy, lastDoy);
    const v = seasonTotal(y, s.months, cut), all = D.full.map(yy => seasonTotal(yy, s.months, cut));
    return Object.assign(s, { v, p: pctBelow(all, v), med: median(all), partial: cut < lastDoy });
  }).filter(Boolean);

  // plain-language headline built from the data
  const yearWord = p >= 67 ? 'a wet year' : p <= 33 ? 'a dry year' : 'about a normal year';
  const standout = seasons.filter(s => !s.partial).sort((a, b) => Math.abs(b.p - 50) - Math.abs(a.p - 50))[0];
  const latest = seasons[seasons.length - 1];
  let headline = `${y} has been ${yearWord} so far`;
  if (standout && Math.abs(standout.p - 50) >= 25) headline += `, mostly thanks to ${standout.p >= 50 ? 'a very wet' : 'a very dry'} ${standout.name.toLowerCase()}`;
  if (latest.partial && Math.abs(latest.p - 50) >= 20 && (latest.p >= 50) !== (p >= 50)) headline += `, but ${latest.name.toLowerCase()} has turned ${latest.p >= 50 ? 'wet' : 'dry'}`;
  headline += '.';
  const explain = `By ${doyToDate(doy, y)} a typical year has brought <b>${mm(bands[2][doy])}</b>. This year it's <b>${mm(ytd)}</b>, more than ${p}% of years by the same date (${ordinal(rank)} wettest of ${ytdAll.length + 1}).`;

  // chart
  const W = 340, H = 210, pl = 36, pr = 36, pt = 8, pb = 22;
  const ymax = Math.ceil(Math.max(bands[4][364], ytd) / 200) * 200;
  const X = i => pl + i / 364 * (W - pl - pr), Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  const pts = arr => arr.map((v, i) => [X(i), Y(v)]);
  let g = yAxis(Y, niceTicks(ymax, 4), W, pl, pr);
  g += `<path d="${area(pts(bands[4]), pts(bands[0]))}" fill="var(--band)"/><path d="${area(pts(bands[3]), pts(bands[1]))}" fill="var(--band2)"/>`;
  g += `<path d="${path(pts(bands[2]))}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  g += `<path d="${path(pts(nowCum))}" fill="none" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  g += `<circle cx="${X(doy)}" cy="${Y(ytd)}" r="4.5" fill="var(--ink)" stroke="var(--card)" stroke-width="2"/>`;
  g += `<text class="lbl" x="${W - pr + 4}" y="${Y(bands[2][364]) + 4}">typical</text>`;
  for (let m = 0; m < 12; m += 2) { const i = Math.floor((Date.UTC(2025, m, 1) - Date.UTC(2025, 0, 1)) / DAY); g += `<text x="${X(i)}" y="${H - 6}">${MON[m]}</text>`; }
  for (let i = 0; i < 365; i += 7) {
    const now = i <= doy ? `<br>${y}: <b>${mm(nowCum[i])}</b>` : '';
    g += `<rect x="${X(i)}" y="0" width="${(W - pl - pr) / 52 + 0.5}" height="${H - pb}" fill="transparent" data-tip="<b>By ${doyToDate(i)}</b>${now}<br>Typical year: ${mm(bands[2][i])}<br>Middle half of years: ${nf.format(bands[1][i])}–${nf.format(bands[3][i])} mm"/>`;
  }

  // numbers: month by month
  const mNow = D.monthly[y], lastM = new Date(Date.UTC(2025, 0, 1) + doy * DAY).getUTCMonth();
  const monthRows = [];
  for (let m = 0; m <= lastM; m++) {
    const all = D.full.map(yy => D.monthly[yy][m]), v = mNow[m], pp = pctBelow(all, v);
    monthRows.push([MON[m] + (m === lastM ? ' (so far)' : ''), nf.format(v), nf.format(median(all)), m === lastM ? '–' : `<span class="tag ${tagFor(pp)}">${pp >= 67 ? 'wet' : pp <= 33 ? 'dry' : 'normal'}</span>`]);
  }

  el.innerHTML =
    card({
      q: 'How is this year going?', headline, explain,
      chart: `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rain building up through ${y} against all years since 1889">${g}</svg>`,
      legend: `<span><i class="line" style="background:var(--ink)"></i>${y}</span><span><i class="line" style="background:var(--ink-3)"></i>Typical year</span><span><i style="background:var(--band2)"></i>Middle half of years</span><span><i style="background:var(--band)"></i>8 in 10 years</span>`,
      numbers: table(['Month', `${y} mm`, 'Typical mm', ''], monthRows, { note: 'Typical = the median month since 1889. Wet or dry = in the wettest or driest third of years for that month.' }),
      numbersLabel: 'See each month'
    }) +
    card({
      q: 'Season by season',
      headline: seasons.map(s => `${s.name} ${s.partial ? '(so far) ' : ''}was ${s.p >= 67 ? 'wet' : s.p <= 33 ? 'dry' : 'about normal'}`).join(', ') + '.',
      chart: `<div class="chips">${seasons.filter(s => s.name !== 'Summer').map(s => `<div class="chipcard"><span>${s.name} <span class="tiny">${s.sub}</span></span><b>${nf.format(s.v)}<span class="tiny muted">&nbsp;mm</span></b><span>${s.partial ? 'so far · ' : ''}typical ${nf.format(s.med)}</span><span class="tag ${tagFor(s.p)}">wetter than ${s.p}%</span></div>`).join('')}</div>`,
      explain: `"Wetter than 93%" means only 7 in every 100 years since 1889 had more rain in that season.`
    }) +
    `<p class="note">Rain for the Norton Summit area: the average of two 5 km SILO grid cells, 1889 to ${doyToDate(doy, y)} ${y}, counted on the 9 am rain day.</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= RAIN: HISTORY (patterns)
function renderHistory(el) {
  const full = D.full, ann = full.map(y => D.annual[y]);
  const split = 1990, early = full.filter(y => y < split), recent = full.filter(y => y >= split);
  const eMean = mean(early.map(y => D.annual[y])), rMean = mean(recent.map(y => D.annual[y]));
  const med = median(ann), swing = quantile(ann, 0.84) - med;
  const chgAll = (rMean / eMean - 1) * 100;

  // --- 1. annual bars
  const W = 340, H = 190, pl = 34, pr = 6, pt = 8, pb = 22;
  const ymax = Math.ceil(Math.max(...ann) / 200) * 200, bw = (W - pl - pr) / full.length;
  const X = i => pl + i * bw, Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = yAxis(Y, niceTicks(ymax, 4), W, pl, pr);
  full.forEach((y, i) => {
    const v = D.annual[y], rnk = ann.filter(a => a > v).length + 1;
    g += `<rect x="${X(i) + 0.3}" y="${Y(v)}" width="${Math.max(bw - 0.6, 0.8)}" height="${Y(0) - Y(v)}" fill="${phaseColor(y)}" opacity="${D.EN.has(y) || D.LN.has(y) ? 0.95 : 0.55}" data-tip="<b>${y}</b>: ${mm(v)}<br>${ordinal(rnk)} wettest of ${full.length}<br>${phaseOf(y)}${D.IP.has(y) ? ' · positive IOD' : D.IN.has(y) ? ' · negative IOD' : ''}"/>`;
  });
  const roll = full.map((y, i) => i < 29 ? null : [X(i) + bw / 2, Y(mean(full.slice(i - 29, i + 1).map(yy => D.annual[yy])))]).filter(Boolean);
  g += `<path d="${path(roll)}" fill="none" stroke="var(--ink)" stroke-width="2.2" stroke-linejoin="round"/>`;
  [1900, 1925, 1950, 1975, 2000, 2025].forEach(y => { const i = full.indexOf(y); if (i >= 0) g += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${y}</text>`; });
  const decades = []; for (let d = 1890; d <= D.lastFull; d += 10) { const ys = full.filter(y => y >= d && y < d + 10); if (ys.length) decades.push(ys); }
  const decRows = decades.map(ys => {
    const vals = ys.map(y => D.annual[y]), wet = ys[vals.indexOf(Math.max(...vals))], dry = ys[vals.indexOf(Math.min(...vals))];
    return { hl: ys[0] >= 2020, cells: [`${ys[0] - ys[0] % 10}s${ys.length < 10 ? ` <span class="tiny muted">(${ys.length} yrs)</span>` : ''}`, nf.format(mean(vals)), `${wet} <span class="tiny muted">${nf.format(D.annual[wet])}</span>`, `${dry} <span class="tiny muted">${nf.format(D.annual[dry])}</span>`] };
  });
  const q1 = card({
    q: 'Is Norton Summit getting drier?',
    headline: chgAll <= -4 ? 'A little, yes. But it\'s a nudge, not a collapse.' : chgAll >= 4 ? 'If anything it\'s a little wetter.' : 'Not much has changed overall.',
    explain: `Since 1990 a typical year brings about <b>${mm(rMean)}</b>, ${Math.abs(Math.round(chgAll))}% ${chgAll < 0 ? 'less' : 'more'} than the ${mm(eMean)} of 1889–1989. Ordinary year-to-year swings are bigger than that: most years land within about ±${nf.format(swing)} mm of normal. The black line (a 30-year average) shows the slow drift.`,
    chart: `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual rainfall since 1889">${g}</svg>`,
    legend: `<span><i style="background:var(--warm)"></i>El Niño year</span><span><i style="background:var(--cool)"></i>La Niña year</span><span><i style="background:var(--neutral);opacity:.6"></i>Neither</span><span><i class="line" style="background:var(--ink)"></i>30-year average</span>`,
    numbers: table(['Decade', 'Avg mm', 'Wettest', 'Driest'], decRows),
    numbersLabel: 'See each decade'
  });

  // --- 2. monthly shift
  const mE = Array.from({ length: 12 }, (_, m) => mean(early.map(y => D.monthly[y][m])));
  const mR = Array.from({ length: 12 }, (_, m) => mean(recent.map(y => D.monthly[y][m])));
  const W2 = 340, H2 = 180, pl2 = 30, pr2 = 4, pt2 = 18, pb2 = 22, ymax2 = Math.ceil(Math.max(...mE, ...mR) / 20) * 20;
  const gw = (W2 - pl2 - pr2) / 12, Y2 = v => pt2 + (1 - v / ymax2) * (H2 - pt2 - pb2);
  let g2 = yAxis(Y2, niceTicks(ymax2, 3), W2, pl2, pr2);
  for (let m = 0; m < 12; m++) {
    const x = pl2 + m * gw, w = (gw - 6) / 2, chg = (mR[m] / mE[m] - 1) * 100;
    const tipTxt = `<b>${MON[m]}</b><br>1889–1989: ${mm(mE[m])}<br>1990–${D.lastFull}: ${mm(mR[m])}<br>${pctTxt(chg)}`;
    g2 += `<rect x="${x + 2}" y="${Y2(mE[m])}" width="${w}" height="${Y2(0) - Y2(mE[m])}" rx="2" fill="var(--neutral)" opacity=".6" data-tip="${tipTxt}"/>`;
    g2 += `<rect x="${x + 4 + w}" y="${Y2(mR[m])}" width="${w}" height="${Y2(0) - Y2(mR[m])}" rx="2" fill="var(--water)" data-tip="${tipTxt}"/>`;
    if (Math.abs(chg) >= 15) g2 += `<text class="lbl" x="${x + gw / 2}" y="${Y2(Math.max(mE[m], mR[m])) - 4}" text-anchor="middle" style="font-weight:600">${pctTxt(chg)}</text>`;
    g2 += `<text x="${x + gw / 2}" y="${H2 - 6}" text-anchor="middle">${MON[m][0]}</text>`;
  }
  const winterIdx = [5, 6, 7, 8], wE = sum(winterIdx.map(m => mE[m])), wR = sum(winterIdx.map(m => mR[m]));
  const drops = mE.map((e, m) => ({ m, c: (mR[m] / e - 1) * 100 })).filter(o => o.c <= -10).sort((a, b) => a.c - b.c);
  const q2 = card({
    q: 'Which part of the year has changed?',
    headline: 'The wet season starts later and finishes earlier. Winter itself is as wet as ever.',
    explain: `${drops.slice(0, 3).map(o => `${MON[o.m]} is down ${Math.abs(Math.round(o.c))}%`).join(', ')} since 1990, while June to September is ${Math.abs(Math.round((wR / wE - 1) * 100)) <= 3 ? 'unchanged' : pctTxt((wR / wE - 1) * 100)}. For tanks, that means a longer wait in autumn before they start refilling, and an earlier start to the summer drawdown.`,
    chart: `<svg class="chart" viewBox="0 0 ${W2} ${H2}" role="img" aria-label="Average rain by month before and since 1990">${g2}</svg>`,
    legend: `<span><i style="background:var(--neutral);opacity:.6"></i>1889–1989</span><span><i style="background:var(--water)"></i>1990–${D.lastFull}</span>`,
    numbers: table(['Month', '1889–1989', `1990–${String(D.lastFull).slice(2)}`, 'Change'], mE.map((e, m) => ({ hl: Math.abs(mR[m] / e - 1) >= 0.15, cells: [MON[m], nf.format(e), nf.format(mR[m]), pctTxt((mR[m] / e - 1) * 100)] })), { note: 'Average monthly rain in mm. Highlighted rows changed by 15% or more.' }),
    numbersLabel: 'See each month'
  });

  // --- 3. rain days
  const rd = y => D.raw.raindays[y], hv = y => D.raw.heavydays[y];
  const W3 = 340, H3 = 150, pl3 = 30, pr3 = 6, pt3 = 8, pb3 = 22;
  const rdVals = full.map(rd), ymax3 = Math.ceil(Math.max(...rdVals) / 20) * 20, ymin3 = Math.floor(Math.min(...rdVals) / 20) * 20;
  const X3 = i => pl3 + i / (full.length - 1) * (W3 - pl3 - pr3), Y3 = v => pt3 + (1 - (v - ymin3) / (ymax3 - ymin3)) * (H3 - pt3 - pb3);
  let g3 = '';
  for (let v = ymin3; v <= ymax3; v += 20) g3 += `<line x1="${pl3}" x2="${W3 - pr3}" y1="${Y3(v)}" y2="${Y3(v)}" stroke="var(--grid)"/><text x="${pl3 - 5}" y="${Y3(v) + 3.5}" text-anchor="end">${v}</text>`;
  full.forEach((y, i) => g3 += `<circle cx="${X3(i)}" cy="${Y3(rd(y))}" r="2.2" fill="var(--water)" opacity=".45" data-tip="<b>${y}</b>: ${rd(y)} days with 1 mm or more<br>${hv(y)} days with 20 mm or more"/>`);
  const roll3 = full.map((y, i) => i < 14 ? null : [X3(i), Y3(mean(full.slice(i - 14, i + 1).map(rd)))]).filter(Boolean);
  g3 += `<path d="${path(roll3)}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>`;
  [1900, 1950, 2000].forEach(y => g3 += `<text x="${X3(full.indexOf(y))}" y="${H3 - 6}" text-anchor="middle">${y}</text>`);
  const rdE = mean(early.map(rd)), rdR = mean(recent.map(rd)), hvE = mean(early.map(hv)), hvR = mean(recent.map(hv));
  const perDay = ys => sum(ys.map(y => D.annual[y])) / sum(ys.map(rd));
  const q3 = card({
    q: 'Is the rain falling differently?',
    headline: 'Fewer drizzly days, but the big soaking falls are holding up.',
    explain: `Norton Summit now gets about <b>${Math.round(rdR)} rainy days a year</b>, down from ${Math.round(rdE)}. Days with 20 mm or more, the ones that really fill tanks, are unchanged at about ${hvR.toFixed(1)} a year. Most of the loss is light rain that barely reaches the gutters anyway.`,
    chart: `<svg class="chart" viewBox="0 0 ${W3} ${H3}" role="img" aria-label="Rainy days per year since 1889">${g3}</svg>`,
    legend: `<span><i style="background:var(--water);opacity:.5;border-radius:50%"></i>Rainy days that year</span><span><i class="line" style="background:var(--ink)"></i>15-year average</span>`,
    numbers: table(['Per year', '1889–1989', `1990–${String(D.lastFull).slice(2)}`], [
      ['Rainy days (1 mm+)', Math.round(rdE), Math.round(rdR)],
      ['Big falls (20 mm+)', hvE.toFixed(1), hvR.toFixed(1)],
      ['Average fall on a rainy day', perDay(early).toFixed(1) + ' mm', perDay(recent).toFixed(1) + ' mm']
    ])
  });

  // --- 4. dry runs (decade grid)
  const cell = 24, gap = 3, cols = 10, rows = Math.ceil((D.lastFull - 1880 + 1) / 10);
  const W4 = 48 + cols * (cell + gap), H4 = rows * (cell + gap) + 4;
  let g4 = '';
  for (let r = 0; r < rows; r++) {
    const dec = 1880 + r * 10;
    g4 += `<text x="0" y="${r * (cell + gap) + cell / 2 + 4}">${dec}s</text>`;
    for (let c = 0; c < cols; c++) {
      const y = dec + c; if (y < 1889 || y > D.lastFull) continue;
      const v = D.annual[y], rel = (v / med - 1) * 100, dry = v < med;
      const op = Math.min(1, 0.25 + Math.abs(rel) / 45);
      g4 += `<rect x="${48 + c * (cell + gap)}" y="${r * (cell + gap)}" width="${cell}" height="${cell}" rx="4" fill="${dry ? 'var(--warm)' : 'var(--cool)'}" opacity="${op.toFixed(2)}" data-tip="<b>${y}</b>: ${mm(v)} (${pctTxt(rel)} vs typical)"/>`;
    }
  }
  const runs = []; let cur = [];
  full.forEach(y => { if (D.annual[y] < med) cur.push(y); else { if (cur.length >= 3) runs.push(cur.slice()); cur = []; } });
  if (cur.length >= 3) runs.push(cur);
  runs.sort((a, b) => b.length - a.length || a[0] - b[0]);
  const stretch = k => full.slice(k - 1).map((y, i) => ({ y0: full[i], y1: y, v: sum(full.slice(i, i + k).map(yy => D.annual[yy])) / k })).sort((a, b) => a.v - b.v);
  const s2 = stretch(2), s3 = stretch(3);
  const q4 = card({
    q: 'How bad do dry spells get?',
    headline: `The longest dry run on record is a recent one: ${runs[0][0]}–${runs[0][runs[0].length - 1]}.`,
    explain: `Each square is a year: orange was below typical, blue above, and stronger colour means further from typical. Dry years tend to come in clumps of 3 or 4, and ${runs[0].length} below-typical years in a row is the record. ${s2.findIndex(o => o.y1 === D.lastFull) >= 0 && s2.findIndex(o => o.y1 === D.lastFull) < 5 ? `${D.lastFull - 1}–${D.lastFull} was the ${ordinal(s2.findIndex(o => o.y1 === D.lastFull) + 1)} driest pair of years since 1889.` : ''}`,
    chart: `<svg class="chart" viewBox="0 0 ${W4} ${H4}" role="img" aria-label="Every year since 1889 as wetter or drier than typical" style="max-width:${W4 * 1.15}px">${g4}</svg>`,
    legend: `<span><i style="background:var(--warm)"></i>Drier than typical</span><span><i style="background:var(--cool)"></i>Wetter than typical</span>`,
    numbers: table(['Dry run', 'Years', 'Avg mm'], runs.map(r => ({ hl: r[r.length - 1] >= 2000, cells: [`${r[0]}–${r[r.length - 1]}`, r.length, nf.format(mean(r.map(y => D.annual[y])))] })), { note: `Runs of 3+ years below the typical ${mm(med)}. Driest 3-year stretches: ${s3.slice(0, 3).map(o => `${o.y0}–${o.y1} (${nf.format(o.v)} mm/yr)`).join(', ')}.` }),
    numbersLabel: 'See every dry run'
  });

  // --- 5. memory
  const q20 = quantile(ann, 0.2), q80 = quantile(ann, 0.8);
  const after = (cond, test) => { const ys = full.filter(y => cond(D.annual[y]) && D.annual[y + 1] != null); return { n: ys.length, p: Math.round(ys.filter(y => test(D.annual[y + 1])).length / ys.length * 100) }; };
  const aDry = after(v => v <= q20, v => v < med), aWet = after(v => v >= q80, v => v > med), aDryDry = after(v => v <= q20, v => v <= q20);
  const q5 = card({
    q: 'Does a dry year mean another one is coming?',
    headline: 'No. Each year starts more or less fresh.',
    explain: `After the driest fifth of years, the next year was below typical ${aDry.p}% of the time, close to a coin toss. A run of dry years is bad luck stacking up rather than a pattern that locks in, which is also why no one can reliably call next year from this one.`,
    numbers: table(['After a…', 'Next year…', 'How often'], [
      ['very dry year', 'below typical', aDry.p + '%'],
      ['very dry year', 'very dry again', aDryDry.p + '%'],
      ['very wet year', 'above typical', aWet.p + '%']
    ], { note: `"Very dry" and "very wet" = driest and wettest fifth of years (below ${mm(q20)} or above ${mm(q80)}). By chance alone you'd expect about 50%, 20% and 50%.` })
  });

  el.innerHTML = q1 + q2 + q3 + q4 + q5 + `<p class="note">Tap any bar, dot or square for its numbers. El Niño and La Niña years follow the Bureau of Meteorology's event list.</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= RAIN: DRIVERS
function renderDrivers(el) {
  const months = [4, 5, 6, 7, 8, 9, 10];
  const refill = y => seasonTotal(y, months);
  const base = D.full.filter(y => y >= 1900), med = median(base.map(refill));
  const base60 = base.filter(y => y >= 1960), med60 = median(base60.map(refill));
  const rows = [
    { label: 'El Niño', ys: base.filter(y => D.EN.has(y)), med, color: 'var(--warm)' },
    { label: 'Neither', ys: base.filter(y => !D.EN.has(y) && !D.LN.has(y)), med, color: 'var(--neutral)' },
    { label: 'La Niña', ys: base.filter(y => D.LN.has(y)), med, color: 'var(--cool)' },
    { label: 'IOD +', ys: base60.filter(y => D.IP.has(y)), med: med60, color: 'var(--warm)' },
    { label: 'IOD −', ys: base60.filter(y => D.IN.has(y)), med: med60, color: 'var(--cool)' },
    { label: 'Both dry', ys: base60.filter(y => D.EN.has(y) && D.IP.has(y)), med: med60, color: 'var(--warm)' }
  ];
  const y0 = D.endYear, have = D.endDoy >= 303, v0 = have ? refill(y0) : null;
  const W = 340, rowH = 34, pl = 64, pr = 10, pt = 18, H = pt + rows.length * rowH + 20;
  const xmin = 20, xmax = 200, X = v => pl + (Math.min(Math.max(v, xmin), xmax) - xmin) / (xmax - xmin) * (W - pl - pr);
  let g = '';
  [50, 100, 150, 200].forEach(v => g += `<line x1="${X(v)}" x2="${X(v)}" y1="${pt - 6}" y2="${H - 18}" stroke="${v === 100 ? 'var(--ink-3)' : 'var(--grid)'}" ${v === 100 ? 'stroke-dasharray="3 3"' : ''}/><text x="${X(v)}" y="${H - 5}" text-anchor="middle">${v}%</text>`);
  g += `<text x="${X(100)}" y="${pt - 8}" text-anchor="middle">typical</text>`;
  const stats = {};
  rows.forEach((r, i) => {
    const cy = pt + i * rowH + rowH / 2, vals = r.ys.map(y => ({ y, p: refill(y) / r.med * 100 }));
    g += `<text class="lbl" x="0" y="${cy + 4}">${r.label}</text>`;
    vals.sort((a, b) => a.p - b.p).forEach((o, k) => g += `<circle cx="${X(o.p)}" cy="${cy + ((k % 3) - 1) * 6}" r="4" fill="${r.color}" opacity=".75" stroke="var(--card)" stroke-width="1" data-tip="<b>${o.y}</b>: ${Math.round(o.p)}% of typical Apr–Oct rain"/>`);
    const m = median(vals.map(o => o.p));
    g += `<line x1="${X(m)}" x2="${X(m)}" y1="${cy - 12}" y2="${cy + 12}" stroke="var(--ink)" stroke-width="2.5" stroke-linecap="round"/>`;
    const applies = (r.label === 'El Niño' && D.EN.has(y0)) || (r.label === 'IOD +' && D.IP.has(y0)) || (r.label === 'Both dry' && D.EN.has(y0) && D.IP.has(y0)) || (r.label === 'La Niña' && D.LN.has(y0)) || (r.label === 'IOD −' && D.IN.has(y0));
    if (have && applies) g += `<circle cx="${X(v0 / r.med * 100)}" cy="${cy}" r="6.5" fill="none" stroke="var(--ink)" stroke-width="2" data-tip="<b>${y0}</b>: ${Math.round(v0 / r.med * 100)}% of typical Apr–Oct rain"/>`;
    const sorted = vals.slice().sort((a, b) => b.p - a.p);
    stats[r.label] = { n: vals.length, m: Math.round(m), below: Math.round(vals.filter(o => o.p < 100).length / vals.length * 100),
      vdry: Math.round(vals.filter(o => o.p < 75).length / vals.length * 100), wettest: sorted[0], driest: sorted[sorted.length - 1] };
  });
  const s = stats;
  const tbl = table(['Years that were…', 'Typical', 'Below typical', 'Very dry*'], rows.map(r => ({ hl: (r.label === 'El Niño' && D.EN.has(y0)) || (r.label === 'IOD +' && D.IP.has(y0)) || (r.label === 'Both dry' && D.EN.has(y0) && D.IP.has(y0)),
    cells: [`${r.label} <span class="tiny muted">(${s[r.label].n})</span>`, s[r.label].m + '%', s[r.label].below + '%', s[r.label].vdry + '%'] })),
    { note: `* Very dry = less than 75% of typical April–October rain. In a "Neither" year that happens ${s['Neither'].vdry}% of the time. Highlighted rows apply to ${y0}. ENSO since 1900, IOD since 1960.` });

  // summers after
  const d2 = D.full.filter(y => y >= 1900 && y < D.lastFull);
  const summer = y => (D.monthly[y][11] || 0) + D.monthly[y + 1][0] + D.monthly[y + 1][1] + D.monthly[y + 1][2];
  const sMed = median(d2.map(summer)), sAfter = set => Math.round(median(d2.filter(y => set(y)).map(summer)) / sMed * 100);

  el.innerHTML =
    `<div class="card">
      <div class="q">What are these drivers?</div>
      <p class="explain" style="margin-top:2px"><b>El Niño</b> is when the Pacific Ocean warms near the equator and pulls rain-making weather away from Australia. <b>La Niña</b> is the reverse. The <b>Indian Ocean Dipole (IOD)</b> is the same idea on our western side: in its positive phase the water near Australia cools and less moisture reaches us; negative is the reverse. Both matter most from autumn to spring, when our tanks refill.</p>
    </div>` +
    card({
      q: 'Do they actually change our rain?',
      headline: 'They tilt the odds, especially toward a dry refill season, but they don\'t decide it.',
      explain: `In El Niño years the April–October refill season typically brings <b>${s['El Niño'].m}%</b> of normal, and ${s['El Niño'].below}% came in below typical. The Indian Ocean matters just as much: ${s['IOD +'].m}% in positive-IOD years, ${s['IOD −'].m}% in negative ones. La Niña does surprisingly little here (${s['La Niña'].m}%). Even with both dry signals together, ${100 - s['Both dry'].below}% of years still came in above typical.`,
      chart: `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="April to October rain by climate driver">${g}</svg>`,
      legend: `<span>Each dot is a year · the bar is the typical year${have ? ` · the ring is ${y0}` : ''}</span>`,
      numbers: tbl
    }) +
    (have ? card({
      q: `What about ${y0}?`,
      headline: `${y0} had the classic dry setup and got a wet winter anyway.`,
      explain: `${y0} is an El Niño year with a positive IOD. Its April–October rain was <b>${Math.round(v0 / med * 100)}% of typical</b>. That's not a contradiction, just the odds at work: in past years with the same setup, about ${100 - s['Both dry'].below}% still ended up above typical.`
    }) : '') +
    card({
      q: 'And the summer after?',
      headline: 'The drivers say little about summer rain here.',
      explain: `Summers (Dec–Mar) after an El Niño year typically brought ${sAfter(y => D.EN.has(y))}% of normal; after La Niña, ${sAfter(y => D.LN.has(y))}%. Summer rain at Norton Summit is small and patchy either way, so tank planning should assume a normal dry summer.`
    }) +
    `<p class="note">Driver years from the Bureau of Meteorology. For the season ahead, see the <a href="https://www.bom.gov.au/climate/outlooks/" target="_blank" rel="noopener">BOM long-range forecast</a>.</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= RAIN: EXPLORE (all the data, usefully)
const exploreState = { year: null };
function renderExplore(el) {
  const yrs = D.years.slice().reverse();
  const y = exploreState.year || D.endYear;
  const full = D.full, ann = full.map(yy => D.annual[yy]);
  const isPartial = y > D.lastFull;
  const total = isPartial ? sum(D.monthly[y]) : D.annual[y];
  const rank = isPartial ? null : ann.filter(a => a > total).length + 1;
  const medM = Array.from({ length: 12 }, (_, m) => median(full.map(yy => D.monthly[yy][m])));
  const p10 = Array.from({ length: 12 }, (_, m) => quantile(full.map(yy => D.monthly[yy][m]), 0.1));
  const p90 = Array.from({ length: 12 }, (_, m) => quantile(full.map(yy => D.monthly[yy][m]), 0.9));
  const lastM = isPartial ? new Date(Date.UTC(2025, 0, 1) + D.endDoy * DAY).getUTCMonth() : 11;

  // monthly chart with typical range
  const W = 340, H = 190, pl = 30, pr = 4, pt = 10, pb = 22;
  const ymax = Math.ceil(Math.max(...D.monthly[y], ...p90) / 50) * 50, gw = (W - pl - pr) / 12, Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = yAxis(Y, niceTicks(ymax, 3), W, pl, pr);
  for (let m = 0; m < 12; m++) {
    const x = pl + m * gw + 3, w = gw - 6, v = D.monthly[y][m];
    g += `<rect x="${x - 1}" y="${Y(p90[m])}" width="${w + 2}" height="${Y(p10[m]) - Y(p90[m])}" rx="3" fill="var(--band)"/>`;
    if (m <= lastM) g += `<rect x="${x + 3}" y="${Y(v)}" width="${w - 6}" height="${Y(0) - Y(v)}" rx="2" fill="${phaseColor(y)}" data-tip="<b>${MON[m]} ${y}</b>: ${mm(v)}<br>Typical: ${mm(medM[m])}<br>8 in 10 years: ${nf.format(p10[m])}–${nf.format(p90[m])} mm"/>`;
    g += `<line x1="${x - 1}" x2="${x + w + 1}" y1="${Y(medM[m])}" y2="${Y(medM[m])}" stroke="var(--ink)" stroke-width="1.5"/>`;
    g += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${MON[m][0]}</text>`;
  }

  // records
  const top = (arr, k, desc) => arr.slice().sort((a, b) => desc ? b.v - a.v : a.v - b.v).slice(0, k);
  const yearsArr = full.map(yy => ({ k: String(yy), v: D.annual[yy] }));
  const monthsArr = []; full.forEach(yy => D.monthly[yy].forEach((v, m) => monthsArr.push({ k: `${MON[m]} ${yy}`, v })));
  const daysArr = []; for (let i = 0; i < D.n; i++) if (D.daily[i] >= 60) { const d = new Date(D.start + i * DAY); daysArr.push({ k: `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`, v: D.daily[i] }); }
  const recRows = (arr) => arr.map((o, i) => [`${i + 1}. ${o.k}`, nf.format(o.v)]);

  const word = isPartial ? null : (() => { const p = pctBelow(ann, total); return p >= 90 ? 'one of the wettest years on record' : p >= 67 ? 'a wet year' : p > 33 ? 'about a normal year' : p > 10 ? 'a dry year' : 'one of the driest years on record'; })();
  const drivers = [D.EN.has(y) ? 'El Niño' : D.LN.has(y) ? 'La Niña' : null, D.IP.has(y) ? 'positive IOD' : D.IN.has(y) ? 'negative IOD' : null].filter(Boolean);

  el.innerHTML = `
    <div class="card">
      <div class="q">Look up any year</div>
      <select id="ex-year" class="select">${yrs.map(yy => `<option value="${yy}" ${yy === y ? 'selected' : ''}>${yy}${yy === D.endYear ? ' (so far)' : ''}</option>`).join('')}</select>
      <h3 class="answer" style="margin-top:12px">${isPartial ? `${y} so far: ${mm(total)}` : `${y} was ${word}: ${mm(total)}`}</h3>
      <p class="explain">${isPartial ? 'See "This year" for how it compares by date. ' : `${ordinal(rank)} wettest of ${full.length} years. `}${drivers.length ? `It was ${drivers.join(' and ')} year.`.replace(/^It was (E|I)/, 'It was an $1') : 'Neither El Niño nor La Niña.'}</p>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly rain in ${y} against the typical range">${g}</svg></div>
      <div class="legend"><span><i style="background:${phaseColor(y)}"></i>${y}</span><span><i class="line" style="background:var(--ink)"></i>Typical month</span><span><i style="background:var(--band)"></i>8 in 10 years</span></div>
      <details><summary>See ${y} month by month</summary>${table(['Month', 'mm', 'Typical', 'vs typical'], D.monthly[y].slice(0, lastM + 1).map((v, m) => [MON[m], nf.format(v), nf.format(medM[m]), medM[m] ? pctTxt((v / medM[m] - 1) * 100) : '–']))}</details>
    </div>
    <div class="card">
      <div class="q">Records since 1889</div>
      <div class="rec-grid">
        <div><h4>Wettest years</h4>${table(['', 'mm'], recRows(top(yearsArr, 5, true)))}</div>
        <div><h4>Driest years</h4>${table(['', 'mm'], recRows(top(yearsArr, 5, false)))}</div>
        <div><h4>Wettest months</h4>${table(['', 'mm'], recRows(top(monthsArr, 5, true)))}</div>
        <div><h4>Wettest days</h4>${table(['', 'mm'], recRows(top(daysArr, 5, true)))}</div>
      </div>
    </div>
    <div class="card">
      <div class="q">Take the data with you</div>
      <p class="explain">Every year and month since 1889 as a spreadsheet-ready file, with El Niño, La Niña and IOD flags.</p>
      <button class="btn" id="ex-dl">Download yearly and monthly rain (CSV)</button>
    </div>`;
  $('#ex-year').onchange = e => { exploreState.year = +e.target.value; renderExplore(el); };
  $('#ex-dl').onclick = () => {
    const lines = ['year,' + MON.join(',') + ',total,enso,iod'];
    D.years.forEach(yy => lines.push([yy, ...D.monthly[yy].map(v => v.toFixed(1)), sum(D.monthly[yy]).toFixed(1), D.EN.has(yy) ? 'El Nino' : D.LN.has(yy) ? 'La Nina' : '', D.IP.has(yy) ? 'positive' : D.IN.has(yy) ? 'negative' : ''].join(',')));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'norton-summit-rain-1889-' + D.endYear + '.csv'; a.click();
  };
  el.querySelectorAll('svg.chart').forEach(bindTips);
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
  const safeNow = c12 === 0, verdict = safeNow ? (pct(c36) <= 10 ? 'You\'re in good shape.' : 'You\'re fine for the next year; the risk builds after that.') : (pct(c12) <= 10 ? 'Mostly fine, with a small risk within a year.' : 'There\'s a real risk of running low within a year.');
  $('#o-body').innerHTML = `
    <div class="card">
      <div class="q">Will we run out?</div>
      <h3 class="answer">${verdict}</h3>
      <p class="explain">We replayed your tanks through ${subsetLabel}, starting from today with ${nf.format(outlook.start)} L and using ${nf.format(outlook.rate)} L a day. ${c12 === 0 ? 'In none of them did you reach the pump reserve within 12 months.' : `In ${c12} of ${n} you reached the pump reserve within 12 months.`} Over three years, ${c36 === 0 ? 'none did' : `${c36} in ${n} did (about 1 in ${Math.max(1, Math.round(n / c36))})`}.</p>
      <div class="stat3" style="margin-top:12px">
        <div><b>${pct(c12)}%</b><span>chance of hitting the reserve in 12 months</span></div>
        <div><b>${pct(c24)}%</b><span>within 2 years</span></div>
        <div><b>${pct(c36)}%</b><span>within 3 years</span></div>
      </div>
      <p class="lead" style="margin-top:12px">The usual low point is around <b>${MON[lowMonth]}</b>, at about <b>${nf.format(Math.round(median(lows1) / 1000) * 1000)} L</b>. In the worst 1 in 10 years it gets down to ${nf.format(Math.round(quantile(lows1, 0.1) / 1000) * 1000)} L.</p>
    </div>
    <div class="card">
      <div class="q">What will the tanks look like?</div>
      <h3 class="answer">Down through summer, lowest around ${MON[lowMonth]}, then winter refills them.</h3>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Range of tank levels over the next three years">${g}</svg></div>
      <div class="legend"><span><i class="line" style="background:var(--water)"></i>Typical</span><span><i style="background:var(--band2)"></i>Middle half</span><span><i style="background:var(--band)"></i>8 in 10 years</span><span><i class="line" style="background:var(--warn)"></i>Worst: rain from ${worst[0].y}</span></div>
    </div>
    <div class="card">
      <div class="q">How much can we use?</div>
      <h3 class="answer">${safe ? `About ${safe} L a day is the safe steady amount.` : 'Less than you are now.'}</h3>
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
    <div class="seg" role="tablist">${[['year', 'This year'], ['history', 'Patterns'], ['drivers', 'Drivers'], ['explore', 'Explore']].map(([k, l]) => `<button role="tab" data-sub="${k}" aria-selected="${rainState.sub === k}">${l}</button>`).join('')}</div>
    <div id="rain-body"></div>`;
  el.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { rainState.sub = b.dataset.sub; renderRain(); scrollTo(0, 0); });
  const body = $('#rain-body');
  ({ year: renderThisYear, history: renderHistory, drivers: renderDrivers, explore: renderExplore })[rainState.sub](body);
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
