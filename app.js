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
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const dayNum = str => { const p = String(str).split(/[- :T]/).map(Number); return Date.UTC(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0, p[5] || 0) / DAY; };
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
    explain: `${drops.slice(0, 3).map(o => `${MON[o.m]} is down ${Math.abs(Math.round(o.c))}%`).join(', ')} since 1990, while June to September is ${Math.abs(Math.round((wR / wE - 1) * 100)) <= 3 ? 'unchanged' : pctTxt((wR / wE - 1) * 100)}. For tanks, that means a longer wait in autumn before they start refilling. We also get about ${Math.round(rdE - rdR)} fewer rainy days a year, but the big soaking falls that fill tanks are holding up.`,
    chart: `<svg class="chart" viewBox="0 0 ${W2} ${H2}" role="img" aria-label="Average rain by month before and since 1990">${g2}</svg>`,
    legend: `<span><i style="background:var(--neutral);opacity:.6"></i>1889–1989</span><span><i style="background:var(--water)"></i>1990–${D.lastFull}</span>`,
    numbers: table(['Month', '1889–1989', `1990–${String(D.lastFull).slice(2)}`, 'Change'], mE.map((e, m) => ({ hl: Math.abs(mR[m] / e - 1) >= 0.15, cells: [MON[m], nf.format(e), nf.format(mR[m]), pctTxt((mR[m] / e - 1) * 100)] })).concat([
      { cells: ['<b>Rainy days a year</b>', Math.round(rdE), Math.round(rdR), pctTxt((rdR / rdE - 1) * 100)] },
      { cells: ['<b>Falls of 20 mm+ a year</b>', hvE.toFixed(1), hvR.toFixed(1), pctTxt((hvR / hvE - 1) * 100)] }]), { note: 'Average monthly rain in mm. Highlighted rows changed by 15% or more.' }),
    numbersLabel: 'See each month'
  });

  // --- 4. dry runs (decade grid)
  // --- 5. memory
  const q20 = quantile(ann, 0.2), q80 = quantile(ann, 0.8);
  const after = (cond, test) => { const ys = full.filter(y => cond(D.annual[y]) && D.annual[y + 1] != null); return { n: ys.length, p: Math.round(ys.filter(y => test(D.annual[y + 1])).length / ys.length * 100) }; };
  const aDry = after(v => v <= q20, v => v < med), aWet = after(v => v >= q80, v => v > med), aDryDry = after(v => v <= q20, v => v <= q20);
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
    explain: `Each square is a year: orange was below typical, blue above, and stronger colour means further from typical. Dry years tend to come in clumps of 3 or 4, and ${runs[0].length} in a row is the record. That's bad luck stacking up rather than a pattern locking in: after a very dry year, the next was below typical ${aDry.p}% of the time, close to a coin toss. ${s2.findIndex(o => o.y1 === D.lastFull) >= 0 && s2.findIndex(o => o.y1 === D.lastFull) < 5 ? `${D.lastFull - 1}–${D.lastFull} was the ${ordinal(s2.findIndex(o => o.y1 === D.lastFull) + 1)} driest pair of years since 1889.` : ''}`,
    chart: `<svg class="chart" viewBox="0 0 ${W4} ${H4}" role="img" aria-label="Every year since 1889 as wetter or drier than typical" style="max-width:${W4 * 1.15}px">${g4}</svg>`,
    legend: `<span><i style="background:var(--warm)"></i>Drier than typical</span><span><i style="background:var(--cool)"></i>Wetter than typical</span>`,
    numbers: table(['Dry run', 'Years', 'Avg mm'], runs.map(r => ({ hl: r[r.length - 1] >= 2000, cells: [`${r[0]}–${r[r.length - 1]}`, r.length, nf.format(mean(r.map(y => D.annual[y])))] })), { note: `Runs of 3+ years below the typical ${mm(med)}. Driest 3-year stretches: ${s3.slice(0, 3).map(o => `${o.y0}–${o.y1} (${nf.format(o.v)} mm/yr)`).join(', ')}.` }),
    numbersLabel: 'See every dry run'
  });

  el.innerHTML = q1 + q2 + driversCard() + q4 + `<p class="note">Tap any bar, dot or square for its numbers. El Niño and La Niña years follow the Bureau of Meteorology's event list.</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= RAIN: DRIVERS
function driversCard() {
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

  return card({
    q: 'Do El Niño and the Indian Ocean matter?',
    headline: 'They tilt the odds toward a dry refill season, but they don\'t decide it.',
    explain: `<b>El Niño</b> (a warm Pacific) and a <b>positive Indian Ocean Dipole</b> (cool water off our north-west) both pull rain-making weather away from us; La Niña and a negative IOD do the reverse. In El Niño years April–October typically brings <b>${s['El Niño'].m}%</b> of normal, and ${s['El Niño'].below}% came in below typical. The Indian Ocean matters as much: ${s['IOD +'].m}% in positive years, ${s['IOD −'].m}% in negative ones. La Niña does surprisingly little here (${s['La Niña'].m}%).${have ? ` ${y0} had both dry signals and still got <b>${Math.round(v0 / med * 100)}%</b> of typical: the odds, not destiny.` : ''}`,
    chart: `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="April to October rain by climate driver">${g}</svg>`,
    legend: `<span>Each dot is a year · the bar is the typical year${have ? ` · the ring is ${y0}` : ''}</span>`,
    numbers: tbl
  });
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

// ================================================================= TANKS: what's ahead (replaces the Outlook tab)
const outlook = { rate: CONFIG.dailyUse, touched: false };
function histories(subset) {
  const today = new Date(), md = [today.getMonth(), today.getDate()], days = 365 * 3, out = [];
  for (const y of D.years) {
    if (subset === 'recent' && y < 1990) continue;
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
function syncOutlookFromTanks() {
  if (!T.data) return;
  if (!outlook.touched) outlook.rate = Math.round(T.data.totals.recentRate / 10) * 10;
  CONFIG.capacity = T.data.settings.capacityLitres; CONFIG.reserve = T.data.settings.reserveLitres;
}

function aheadCard(start) {
  return `<div class="card" id="t-ahead">
    <div class="q">What's ahead for the tanks?</div>
    <div id="ah-answer"></div>
    <div class="slider-row" style="margin:6px 0 4px"><label for="ah-rate">If we use</label><input id="ah-rate" type="range" min="250" max="800" step="10" value="${outlook.rate}"><output id="ah-out"></output></div>
    <div class="chart-wrap" id="ah-chart"></div>
    <div class="legend"><span><i class="line" style="background:var(--water)"></i>Typical year</span><span><i style="background:var(--band2)"></i>Middle half</span><span><i style="background:var(--band)"></i>8 in 10 years</span><span><i class="line" style="background:var(--warn)"></i>Worst on record</span></div>
    <details><summary>See the odds</summary><div id="ah-table"></div></details>
  </div>`;
}
function drawAhead(start) {
  const rate = outlook.rate, hs = histories('all'), days = 365 * 3;
  $('#ah-out').textContent = nf.format(rate) + ' L/day';
  const sims = hs.map(h => Object.assign(simulate(h.rain, rate, start, days), { y: h.y })), n = sims.length;
  const within = d => sims.filter(s => s.hit !== null && s.hit < d).length;
  const c12 = within(365), c36 = within(1095);
  const lows = sims.map(s => Math.min(...s.traj.slice(0, 365)));
  const worst = sims.slice().sort((a, b) => a.min - b.min)[0];
  const safe = (() => { let lo = 200, hi = 800; for (let i = 0; i < 9; i++) { const mid = (lo + hi) / 2; if (reliability(hs, mid, start, days) >= 0.95) lo = mid; else hi = mid; } return Math.floor(lo / 10) * 10; })();
  const head = c12 === 0 && c36 / n <= 0.05 ? 'No trouble in sight at this rate.' : c12 === 0 ? 'Fine for the next year; the risk builds after that.' : c12 / n <= 0.1 ? 'Mostly fine, with a small chance of running low within a year.' : 'A real chance of running low within a year at this rate.';
  $('#ah-answer').innerHTML = `<h3 class="answer">${head}</h3>
    <p class="explain">We ran your tanks through every year of rain since 1889, starting today. At ${nf.format(rate)} L a day, ${c12 === 0 ? 'none' : `${c12} of ${n}`} reached the pump reserve within a year, and ${c36 === 0 ? 'none' : `about 1 in ${Math.max(1, Math.round(n / c36))}`} within three. About <b>${safe} L a day</b> stays safe in 19 of 20.</p>`;
  const W = 340, H = 190, pl = 34, pr = 8, pt = 8, pb = 22;
  const X = i => pl + i / (days - 1) * (W - pl - pr), Y = v => pt + (1 - v / CONFIG.capacity) * (H - pt - pb);
  const idx = []; for (let i = 0; i < days; i += 7) idx.push(i); idx.push(days - 1);
  const q = qq => idx.map(i => [X(i), Y(quantile(sims.map(s => s.traj[i]), qq))]);
  let g = yAxis(Y, [0, 40000, 80000, 120000], W, pl, pr, v => v / 1000 + 'k');
  g += `<rect x="${pl}" y="${Y(CONFIG.reserve)}" width="${W - pl - pr}" height="${Y(0) - Y(CONFIG.reserve)}" fill="rgba(194,65,12,.12)"/><text x="${pl + 4}" y="${Y(0) - 3}" style="font-size:10px;fill:var(--warn)">pump reserve</text>`;
  g += `<path d="${area(q(0.9), q(0.1))}" fill="var(--band)"/><path d="${area(q(0.75), q(0.25))}" fill="var(--band2)"/>`;
  g += `<path d="${path(q(0.5))}" fill="none" stroke="var(--water)" stroke-width="2.5" stroke-linejoin="round"/>`;
  g += `<path d="${path(idx.map(i => [X(i), Y(worst.traj[i])]))}" fill="none" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  const t0 = new Date();
  for (let k = 0; k <= 36; k += 6) { const d = new Date(t0.getFullYear(), t0.getMonth() + k, 1), i = Math.round((d - t0) / DAY); if (i >= 0 && i < days) g += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${MON[d.getMonth()]}${d.getMonth() < 6 && k ? " '" + String(d.getFullYear()).slice(2) : ''}</text>`; }
  for (let i = 0; i < days; i += 14) { const v = sims.map(s => s.traj[i]); g += `<rect x="${X(i)}" y="0" width="${(W - pl - pr) / (days / 14) + 0.5}" height="${H - pb}" fill="transparent" data-tip="<b>${new Date(t0.getTime() + i * DAY).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</b><br>Typical: ${nf.format(quantile(v, 0.5))} L<br>8 in 10 years: ${nf.format(quantile(v, 0.1))}–${nf.format(quantile(v, 0.9))} L"/>`; }
  $('#ah-chart').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Range of tank levels over the next three years">${g}</svg>`;
  bindTips($('#ah-chart svg'));
  const pc = c => Math.round(c / n * 100) + '%';
  $('#ah-table').innerHTML = table(['At ' + nf.format(rate) + ' L/day', ''], [
    ['Chance of reaching the pump reserve within 6 months', pc(within(182))],
    ['… within 12 months', pc(c12)], ['… within 2 years', pc(within(730))], ['… within 3 years', pc(c36)],
    ['Typical low point in the next year', nf.format(Math.round(median(lows) / 1000) * 1000) + ' L'],
    ['Low point in the worst 1 in 10 years', nf.format(Math.round(quantile(lows, 0.1) / 1000) * 1000) + ' L'],
    ['Worst rain on record for this start date', `${worst.y}–${String(worst.y + 3).slice(2)}`],
    ['Safe steady use (19 in 20 runs)', safe + ' L/day']
  ], { note: `Every year since 1889 replayed from today's date: ${nf.format(CONFIG.capacity)} L tanks, ${nf.format(LPM)} L caught per mm, overflow when full. Odds, not a forecast; the Genie tab shows how a drying climate shifts them.` });
}

// ================================================================= RAIN GENIE 🧞 (up to 50 years ahead)
// Method: real past years (1950–latest) are re-dealt at random into the future, rescaled so their
// seasons match the 1986–2005 baseline, then shifted by the projected seasonal change for that year.
// Projected change: Goyder Institute SA Climate Ready, Adelaide & Mount Lofty Ranges, 15 CMIP5 models,
// % change in seasonal rain vs 1986–2005 (mean, 10th, 90th percentile of the models).
const PROJ = {
  base: 1996, years: [2030, 2050, 2070, 2090],
  medium: { DJF: [[-7.5, -19.3, 3.0], [-6.6, -20.5, 4.8], [-9.0, -18.1, 4.9], [-9.4, -22.7, 1.7]],
            MAM: [[-3.8, -12.3, 5.9], [-3.9, -11.2, 9.3], [-7.3, -16.7, 3.9], [-7.7, -14.8, -0.7]],
            JJA: [[-2.7, -9.5, 3.1], [-5.3, -12.0, 1.2], [-6.0, -13.6, 3.6], [-5.7, -10.9, 2.4]],
            SON: [[-8.8, -16.9, 0.8], [-12.9, -21.7, -6.6], [-16.7, -26.4, -9.0], [-17.8, -24.4, -11.5]] },
  high:   { DJF: [[-4.4, -12.6, 7.6], [-10.8, -22.8, -5.7], [-13.8, -26.8, -0.9], [-19.9, -33.0, -6.6]],
            MAM: [[-4.7, -16.6, 3.2], [-6.0, -16.6, 5.4], [-14.6, -28.7, -0.6], [-17.9, -34.6, -2.7]],
            JJA: [[-5.1, -10.6, -1.1], [-6.3, -13.9, -0.2], [-11.2, -20.8, -2.6], [-15.6, -27.3, -6.9]],
            SON: [[-12.1, -19.2, -5.1], [-17.1, -28.5, -7.5], [-24.4, -38.6, -13.4], [-31.7, -49.8, -21.4]] }
};
const SEASON_OF_MONTH = ['DJF', 'DJF', 'MAM', 'MAM', 'MAM', 'JJA', 'JJA', 'JJA', 'SON', 'SON', 'SON', 'DJF'];
function projChange(scen, season, year, z) { // % change for a given year and model draw z (normal score)
  if (scen === 'recent') return 0;
  const rows = PROJ[scen][season], xs = [PROJ.base].concat(PROJ.years), pts = [[0, 0, 0]].concat(rows);
  const y = Math.min(Math.max(year, PROJ.base), 2090);
  let i = 0; while (i < xs.length - 2 && y > xs[i + 1]) i++;
  const f = (y - xs[i]) / (xs[i + 1] - xs[i]), lerp = k => pts[i][k] + f * (pts[i + 1][k] - pts[i][k]);
  const m = lerp(0), lo = lerp(1), hi = lerp(2);
  return m + z * (z >= 0 ? (hi - m) : (m - lo)) / 1.2816;
}
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function normal(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const G = { cache: {}, scen: 'medium', year: 2050 };
function genieModel(scen) {
  if (G.cache[scen]) return G.cache[scen];
  const pool = D.full.filter(y => y >= 1950 && y <= D.lastFull);
  // rescale the pool so each season averages what 1986–2005 did
  const seasonTot = (ys, s) => mean(ys.map(y => D.monthly[y].reduce((t, v, m) => t + (SEASON_OF_MONTH[m] === s ? v : 0), 0)));
  const base = scen === 'recent' ? D.full.filter(y => y > D.lastFull - 20) : D.full.filter(y => y >= 1986 && y <= 2005), adj = {};
  ['DJF', 'MAM', 'JJA', 'SON'].forEach(s => adj[s] = seasonTot(base, s) / seasonTot(pool, s));
  const N = 400, Y0 = D.endYear + 1, Y1 = D.endYear + 50, r = rng(scen === 'high' ? 7 : scen === 'recent' ? 11 : 3);
  const paths = [];
  for (let p = 0; p < N; p++) {
    const z = Math.max(-2.2, Math.min(2.2, normal(r))), yrs = [];
    for (let y = Y0; y <= Y1; y++) {
      const src = pool[Math.floor(r() * pool.length)];
      const fac = {}; ['DJF', 'MAM', 'JJA', 'SON'].forEach(s => fac[s] = adj[s] * (1 + projChange(scen, s, y, z) / 100));
      yrs.push({ y, src, fac, total: D.monthly[src].reduce((t, v, m) => t + v * fac[SEASON_OF_MONTH[m]], 0) });
    }
    paths.push({ z, yrs });
  }
  const baseMean = mean(base.map(y => D.annual[y]));
  const m = { scen, paths, pool, adj, Y0, Y1, baseMean, longMean: mean(D.full.map(y => D.annual[y])) };
  G.cache[scen] = m; return m;
}
// daily rain for one future water-year (Dec–Nov) built from a source year with seasonal factors
function waterYearDaily(src, fac) {
  const out = new Float32Array(365), i0 = Math.round((Date.UTC(src - 1, 11, 1) - D.start) / DAY);
  for (let i = 0; i < 365; i++) { const v = D.daily[i0 + i] || 0, mo = new Date(D.start + (i0 + i) * DAY).getUTCMonth(); out[i] = v * fac[SEASON_OF_MONTH[mo]]; }
  return out;
}
function safeUse(model, centreYear, startTank) { // steady L/day that stays clear of the reserve in 19 of 20 three-year runs
  const r = rng(4242), runs = []; // same years for every decade, so differences are the climate shift alone
  model.paths.forEach(p => {
    const seq = new Float32Array(365 * 3);
    for (let k = 0; k < 3; k++) {
      const src = model.pool[Math.floor(r() * model.pool.length)];
      if (src - 1 < 1889) { k--; continue; }
      const fac = {}; ['DJF', 'MAM', 'JJA', 'SON'].forEach(s => fac[s] = model.adj[s] * (1 + projChange(model.scen, s, centreYear, p.z) / 100));
      seq.set(waterYearDaily(src, fac), k * 365);
    }
    runs.push(seq);
  });
  const ok = rate => runs.filter(seq => simulate(seq, rate, startTank, seq.length).hit === null).length / runs.length;
  let lo = 200, hi = 800;
  for (let i = 0; i < 9; i++) { const mid = (lo + hi) / 2; if (ok(mid) >= 0.95) lo = mid; else hi = mid; }
  return Math.floor(lo / 10) * 10;
}

function renderGenie() {
  const el = $('#view-genie');
  const m = genieModel(G.scen), Y = G.year;
  const yrsIdx = y => y - m.Y0;
  // typical year around Y: median over paths of the 20-year mean centred on Y (clipped to the horizon)
  const win = y => { const a = Math.max(m.Y0, y - 10), b = Math.min(m.Y1, y + 9); return [a, b]; };
  const pathMean = (p, a, b) => mean(p.yrs.slice(yrsIdx(a), yrsIdx(b) + 1).map(o => o.total));
  const [a, b] = win(Y), means = m.paths.map(p => pathMean(p, a, b));
  const typ = median(means), typLo = quantile(means, 0.1), typHi = quantile(means, 0.9);
  const chgBase = (typ / m.baseMean - 1) * 100, chgLong = (typ / m.longMean - 1) * 100;
  const dryLine = quantile(D.full.map(y => D.annual[y]), 0.1); // driest 1 in 10 of the past
  const singleYears = m.paths.map(p => p.yrs[yrsIdx(Math.min(Y, m.Y1))].total);
  const pDry = singleYears.filter(v => v <= dryLine).length / singleYears.length;
  const seasonsAt = ['SON', 'JJA', 'MAM', 'DJF'].map(s => ({ s, c: projChange(G.scen, s, Y, 0), lo: projChange(G.scen, s, Y, -1.2816), hi: projChange(G.scen, s, Y, 1.2816) }));
  const sName = { DJF: 'summer', MAM: 'autumn', JJA: 'winter', SON: 'spring' };
  const recent20 = mean(D.full.filter(y => y > D.lastFull - 20).map(y => D.annual[y]));
  const recentChg = (recent20 / m.baseMean - 1) * 100;
  const scenWord = { medium: 'if the world keeps cutting emissions at a moderate pace', high: 'if emissions stay high', recent: 'if the last 20 years turn out to be the new normal' }[G.scen];
  const vsRecent = (typ / recent20 - 1) * 100;

  // chart: past annual totals + 20-yr average, then the future band to Y1
  const W = 340, H = 220, pl = 34, pr = 8, pt = 10, pb = 22, x0 = 1950, x1 = m.Y1;
  const X = y => pl + (y - x0) / (x1 - x0) * (W - pl - pr), ymax = 1300, Yv = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = yAxis(Yv, [0, 400, 800, 1200], W, pl, pr);
  D.full.filter(y => y >= x0).forEach(y => g += `<rect x="${X(y) - 0.9}" y="${Yv(D.annual[y])}" width="1.8" height="${Yv(0) - Yv(D.annual[y])}" fill="var(--neutral)" opacity=".55" data-tip="<b>${y}</b>: ${mm(D.annual[y])}"/>`);
  const pastAvg = []; for (let y = x0 + 9; y <= D.lastFull; y++) pastAvg.push([X(y), Yv(mean(D.full.filter(yy => yy > y - 20 && yy <= y).map(yy => D.annual[yy])))]);
  g += `<path d="${path(pastAvg)}" fill="none" stroke="var(--ink)" stroke-width="2.2"/>`;
  const fut = [], single = [];
  for (let y = m.Y0; y <= m.Y1; y++) {
    const [aa, bb] = win(y), ms = m.paths.map(p => pathMean(p, aa, bb)), ss = m.paths.map(p => p.yrs[yrsIdx(y)].total);
    fut.push({ y, lo: quantile(ms, 0.1), md: median(ms), hi: quantile(ms, 0.9) });
    single.push({ y, lo: quantile(ss, 0.1), hi: quantile(ss, 0.9) });
  }
  g += `<path d="${area(single.map(o => [X(o.y), Yv(o.hi)]), single.map(o => [X(o.y), Yv(o.lo)]))}" fill="var(--band)"/>`;
  g += `<path d="${area(fut.map(o => [X(o.y), Yv(o.hi)]), fut.map(o => [X(o.y), Yv(o.lo)]))}" fill="var(--band2)"/>`;
  g += `<path d="${path(fut.map(o => [X(o.y), Yv(o.md)]))}" fill="none" stroke="var(--water)" stroke-width="2.5" stroke-dasharray="5 3"/>`;
  g += `<line x1="${X(Y)}" x2="${X(Y)}" y1="${pt}" y2="${H - pb}" stroke="var(--ink)" stroke-width="1.2"/><circle cx="${X(Y)}" cy="${Yv(typ)}" r="5" fill="var(--water)" stroke="var(--card)" stroke-width="2"/>`;
  g += `<line x1="${X(D.endYear)}" x2="${X(D.endYear)}" y1="${pt}" y2="${H - pb}" stroke="var(--ink-3)" stroke-dasharray="2 3"/><text x="${X(D.endYear) + 3}" y="${pt + 9}">now</text>`;
  [1950, 1975, 2000, 2025, 2050, 2075].forEach(y => { if (y <= x1) g += `<text x="${X(y)}" y="${H - 6}" text-anchor="middle">${y}</text>`; });
  fut.forEach((o, i) => { if (i % 2 === 0) g += `<rect x="${X(o.y) - 3}" y="0" width="6.5" height="${H - pb}" fill="transparent" data-tip="<b>Around ${o.y}</b><br>Typical year: ${mm(o.md)}<br>Likely range of the average: ${nf.format(o.lo)}–${nf.format(o.hi)} mm<br>Single years: ${nf.format(single[i].lo)}–${nf.format(single[i].hi)} mm (8 in 10)"/>`; });

  el.innerHTML = `
    <div class="view-head"><h1>Rain Genie <span aria-hidden="true">🧞</span></h1><span class="sub">Norton Summit to ${m.Y1}</span></div>
    <div class="card genie">
      <div class="q">Ask the genie</div>
      <div class="pills" role="group" aria-label="When">${[[D.endYear + 10, 'In 10 years'], [2050, '2050'], [D.endYear + 25, 'In 25 years'], [m.Y1, 'In 50 years']].map(([y, l]) => `<button data-gy="${y}" aria-pressed="${Y === y}">${l}</button>`).join('')}</div>
      <div class="slider-row" style="margin-top:10px"><label for="g-year">Year</label><input id="g-year" type="range" min="${m.Y0 + 4}" max="${m.Y1}" step="1" value="${Y}"><output>${Y}</output></div>
      <div class="seg" style="margin:10px 0 0">${[['medium', 'Moderate'], ['high', 'High emissions'], ['recent', 'Like last 20 yrs']].map(([k2, l]) => `<button data-gs="${k2}" aria-selected="${G.scen === k2}">${l}</button>`).join('')}</div>
    </div>
    <div class="card">
      <div class="q">What will rain look like around ${Y}?</div>
      <h3 class="answer">A typical year brings about ${nf.format(Math.round(typ / 10) * 10)} mm${G.scen === 'recent' ? '' : `, roughly ${Math.abs(Math.round(chgBase))}% less than 1986–2005`}.</h3>
      <p class="explain">That's ${scenWord}. ${G.scen === 'recent' ? `This assumes no further drying, but no recovery either.` : `Compared with what we've actually had over the last 20 years (${mm(recent20)}), that's ${Math.abs(vsRecent) < 3 ? 'about the same' : `${Math.abs(Math.round(vsRecent))}% ${vsRecent > 0 ? 'wetter' : 'drier'}`}${vsRecent > 3 ? ': the recent past has run drier than the models expected, so also check "Like the last 20 years"' : ''}. The models' range for the typical year is ${nf.format(typLo)}–${nf.format(typHi)} mm.`} ${G.scen === 'recent' ? '' : `The biggest change is in <b>${sName[seasonsAt[0].s]}</b> (${pctTxt(seasonsAt[0].c)}); ${sName[seasonsAt[1].s]} changes ${pctTxt(seasonsAt[1].c)}. `}Individual years will still swing a lot: a really dry year, the kind that used to come 1 year in 10, becomes about <b>${pDry >= 0.15 ? `1 in ${Math.max(2, Math.round(1 / pDry))}` : '1 in 10 still'}</b>.</p>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual rain since 1950 and the projected range to ${m.Y1}">${g}</svg></div>
      <div class="legend"><span><i style="background:var(--neutral);opacity:.6"></i>Past years</span><span><i class="line" style="background:var(--ink)"></i>20-year average</span><span><i class="line" style="background:var(--water)"></i>Projected typical year</span><span><i style="background:var(--band2)"></i>Model range</span><span><i style="background:var(--band)"></i>Single years (8 in 10)</span></div>
      ${G.scen === 'recent' ? '' : `<details><summary>Season by season around ${Y}</summary>`}${table(['Season', 'Change', 'Models range'], seasonsAt.map(o => [cap(sName[o.s]), pctTxt(o.c), `${pctTxt(o.lo)} to ${pctTxt(o.hi)}`]), { note: 'Change in average rain compared with 1986–2005. Range = 10th to 90th percentile of 15 climate models.' })}${G.scen === 'recent' ? '' : '</details>'}
    </div>
    <div class="card" id="g-tanks">
      <div class="q">Will our tanks still cope?</div>
      <h3 class="answer">Working it out…</h3>
    </div>
    <div class="card">
      <div class="q">How sure is the genie?</div>
      <h3 class="answer">Sure about the direction, much less sure about the size.</h3>
      <p class="explain">Almost every climate model has southern Australia drying in spring, and the region's projections agree. How much depends on emissions and on which model you trust, which is why there's a range.</p>
      <p class="explain">The last 20 years have averaged <b>${mm(recent20)}</b>, ${Math.abs(Math.round(recentChg))}% ${recentChg < 0 ? 'below' : 'above'} the 1986–2005 baseline. That's already as dry as the models expect for the ${recentChg <= -12 ? '2060s–70s' : recentChg <= -7 ? '2040s–50s' : '2030s'}. Part of that is natural swing: 1986–2005 was a wetter-than-usual stretch, and the Millennium drought sits inside the last 20 years. But it means these projections are not alarmist; if anything, the recent past has run drier.</p>
      <p class="explain">The genie can't tell you whether 2031 will be wet. Year-to-year luck still matters more than the trend for any single year. What it shows is the odds shifting.</p>
    </div>
    <p class="note">How it works: real Norton Summit years since 1950 are dealt at random into the future 400 times, rescaled to the 1986–2005 climate, then adjusted by the projected change for each season and year. Projections: Goyder Institute "SA Climate Ready" downscaled projections for the Adelaide and Mount Lofty Ranges region (15 CMIP5 climate models; moderate = RCP4.5, high = RCP8.5).</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
  el.querySelectorAll('[data-gy]').forEach(bt => bt.onclick = () => { G.year = +bt.dataset.gy; renderGenie(); });
  el.querySelectorAll('[data-gs]').forEach(bt => bt.onclick = () => { G.scen = bt.dataset.gs; renderGenie(); });
  const sl = $('#g-year'); sl.oninput = () => { sl.nextElementSibling.textContent = sl.value; }; sl.onchange = () => { G.year = +sl.value; renderGenie(); };
  // tanks by decade, computed after paint
  setTimeout(() => {
    const key = 'tanks-' + G.scen + (T.data ? '-live' : '');
    if (!G.cache[key]) {
      const start = T.data ? Math.max(60000, T.data.now.tank) : 110000, decades = [D.endYear + 1, 2035, 2045, 2055, 2065, 2075].filter(y => y <= m.Y1);
      G.cache[key] = decades.map(y => ({ y, safe: safeUse(m, y, start) }));
    }
    const rows = G.cache[key], use = T.data ? Math.round(T.data.totals.recentRate) : CONFIG.dailyUse;
    const nowSafe = rows[0].safe, atY = rows.reduce((best, r) => Math.abs(r.y - Y) < Math.abs(best.y - Y) ? r : best, rows[0]);
    const Wb = 340, Hb = 170, plb = 34, prb = 8, ptb = 14, pbb = 22, bw = (Wb - plb - prb) / rows.length;
    const ymaxb = 600, Yb = v => ptb + (1 - v / ymaxb) * (Hb - ptb - pbb);
    let gb = yAxis(Yb, [0, 200, 400, 600], Wb, plb, prb);
    rows.forEach((r, i) => {
      const x = plb + i * bw + 6, w = bw - 12;
      gb += `<rect x="${x}" y="${Yb(r.safe)}" width="${w}" height="${Yb(0) - Yb(r.safe)}" rx="4" fill="var(--water)" opacity="${r.y === atY.y ? 1 : .55}" data-tip="<b>${i ? `${r.y - 5}s` : 'Next few years'}</b><br>About ${r.safe} L/day keeps you clear of the pump reserve in 19 of 20 runs"/>`;
      gb += `<text class="lbl" x="${x + w / 2}" y="${Yb(r.safe) - 4}" text-anchor="middle" style="font-weight:600">${r.safe}</text>`;
      gb += `<text x="${x + w / 2}" y="${Hb - 6}" text-anchor="middle">${i ? `${r.y - 5}s` : 'Next few yrs'}</text>`;
    });
    gb += `<line x1="${plb}" x2="${Wb - prb}" y1="${Yb(use)}" y2="${Yb(use)}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${plb + 2}" y="${Yb(use) - 4}" style="fill:var(--ink);font-weight:600">you now: ${use}</text>`;
    const drop = nowSafe - atY.safe;
    $('#g-tanks').innerHTML = `
      <div class="q">Will our tanks still cope?</div>
      <h3 class="answer">${drop <= 15 ? `Yes, with little change to how much you can use.` : `Yes, if daily use comes down by about ${Math.round(drop / 10) * 10} L by the ${atY.y - 5}s.`}</h3>
      <p class="explain">Same 120,000 L tanks and 270 m² roof. Over the next few years about <b>${nowSafe} L a day</b> is safe year in, year out (staying clear of the pump reserve in 19 of 20 three-year runs). Around ${Y} that becomes about <b>${atY.safe} L</b>. ${drop <= 15 ? 'Why so little change? Your tanks fill and overflow most winters, so a drier climate mostly trims water that would have spilled anyway. ' : ''}More roof area or another tank would push these numbers back up.</p>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${Wb} ${Hb}" role="img" aria-label="Safe daily use by decade">${gb}</svg></div>
      <details><summary>Safe daily use by decade</summary>${table(['Decade', 'Safe L/day', 'Change'], rows.map((r, i) => ({ hl: r.y === atY.y, cells: [i ? `${r.y - 5}s` : 'Next few years', r.safe, i ? pctTxt((r.safe / nowSafe - 1) * 100) : '–'] })), { note: `Each run starts on 1 December with ${T.data ? 'today\'s tank level' : '110,000 L'} and uses years since 1950 adjusted to each decade's climate, so "next few years" can differ a little from the Tanks tab, which replays every year since 1889 unadjusted.` })}</details>`;
    $('#g-tanks').querySelectorAll('svg.chart').forEach(bindTips);
  }, 30);
}

// ================================================================= TANKS (live, via Apps Script)
const API = CONFIG.trackerUrl;
const T = { data: null, who: null, at: null, stale: false, busy: false };
const keyOf = () => { try { return localStorage.getItem('tal-key') || new URLSearchParams(location.search).get('k'); } catch (e) { return new URLSearchParams(location.search).get('k'); } };
// Keep the key in the address too: a home-screen app opens from the address it was added at, and has its own storage.
function setKey(k) { try { localStorage.setItem('tal-key', k); } catch (e) {} history.replaceState(null, '', location.pathname + '?k=' + encodeURIComponent(k) + location.hash); }

async function api(action, payload) {
  const k = keyOf(); if (!k) throw new Error('Not connected');
  const res = action === 'dashboard'
    ? await fetch(`${API}?api=dashboard&k=${encodeURIComponent(k)}&t=${Date.now()}`, { credentials: 'omit', redirect: 'follow' })
    : await fetch(API, { method: 'POST', credentials: 'omit', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ k, action }, payload || {})) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'Something went wrong');
  T.data = j.data; T.who = j.who; T.at = Date.now(); T.stale = false;
  try { localStorage.setItem('tal-dash', JSON.stringify({ data: j.data, who: j.who, at: T.at })); } catch (e) {}
  syncOutlookFromTanks();
  return j.data;
}
function loadCachedTanks() {
  try { const c = JSON.parse(localStorage.getItem('tal-dash') || 'null'); if (c) { T.data = c.data; T.who = c.who; T.at = c.at; T.stale = true; syncOutlookFromTanks(); } } catch (e) {}
}

const fmtWhen = local => { const p = local.split(/[- :]/).map(Number), d = new Date(p[0], p[1] - 1, p[2], p[3], p[4]); return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(' ', ''); };
const dayLabel = date => new Date(date + 'T00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });

function tankSvg(level, s) {
  const W = 120, H = 150, x = 14, y = 16, w = 92, h = 124, f = Math.max(0, Math.min(1, level / s.capacityLitres)), r = s.reserveLitres / s.capacityLitres;
  const wy = y + h * (1 - f);
  return `<svg viewBox="0 0 ${W} ${H}" class="tank" role="img" aria-label="${nf.format(level)} of ${nf.format(s.capacityLitres)} litres">
    <defs><clipPath id="tk"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/></clipPath>
      <pattern id="rsv" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-3)" stroke-width="2" opacity=".5"/></pattern></defs>
    <g clip-path="url(#tk)">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--grid)"/>
      <path d="M${x} ${wy} q ${w / 4} -5 ${w / 2} 0 t ${w / 2} 0 V ${y + h} H ${x} Z" fill="var(--water)"/>
      <rect x="${x}" y="${y + h * (1 - r)}" width="${w}" height="${h * r}" fill="url(#rsv)"/>
    </g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="none" stroke="var(--ink-3)" stroke-width="2"/>
    <rect x="${x + w / 2 - 14}" y="${y - 9}" width="28" height="9" rx="3" fill="var(--ink-3)"/>
    <text x="${x + w / 2}" y="${Math.min(wy + 22, y + h - 24)}" text-anchor="middle" style="fill:#fff;font-size:17px;font-weight:700">${Math.round(f * 100)}%</text>
  </svg>`;
}

function tankOutlook(start, rate) { // one-year replay through all years, for the plain-language lines
  const hs = histories('all'), sims = hs.map(h => simulate(h.rain, rate, start, 365));
  const lows = sims.map(s => s.min), lowDays = sims.map(s => s.minDay);
  const c = {}; lowDays.forEach(d => { const m = new Date(Date.now() + d * DAY).getMonth(); c[m] = (c[m] || 0) + 1; });
  const rates = []; for (let r = 300; r <= 700; r += 10) rates.push(r);
  const hs3 = histories('all'), safe = rates.filter(r => reliability(hs3, r, start, 365 * 3) >= 0.95).pop();
  return { low: median(lows), low10: quantile(lows, 0.1), lowMonth: +Object.entries(c).sort((a, b) => b[1] - a[1])[0][0], hit12: sims.filter(s => s.hit !== null).length, n: sims.length, safe };
}

function renderTanks() {
  const el = $('#view-tanks');
  if (!keyOf()) {
    el.innerHTML = `<div class="view-head"><h1>Tanks</h1></div>
      <div class="card"><div class="q">Not connected yet</div><h3 class="answer">Paste your personal link to connect your tanks.</h3>
      <p class="explain">It's the link ending in <b>?k=</b> and your key. You only need to do this once on this phone.</p>
      <input class="inp" id="k-in" placeholder="Paste link or key" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn" id="k-go" style="margin-top:10px">Connect</button><p class="hint" id="k-err"></p></div>`;
    $('#k-go').onclick = () => {
      const v = ($('#k-in').value || '').trim();
      const m = v.match(/[?&]k=([A-Za-z0-9_-]+)/) || v.match(/^([A-Za-z0-9_-]{8,})$/);
      if (!m) { $('#k-err').textContent = "That doesn't look like your link. It should end in ?k= and your key."; return; }
      setKey(m[1]); renderTanks(); refreshTanks(true);
    };
    return;
  }
  if (!T.data) { loadCachedTanks(); }
  if (!T.data) {
    if (T.error) {
      el.innerHTML = `<div class="view-head"><h1>Tanks</h1></div><div class="card"><div class="q">Couldn't reach your tanks</div>
        <h3 class="answer">${T.error === 'Failed to fetch' ? 'No connection right now.' : esc(T.error)}</h3>
        <p class="explain">Your readings are safe in your Google Sheet. Try again when you have signal.</p><button class="btn" id="t-retry">Try again</button></div>`;
      $('#t-retry').onclick = () => { T.error = null; el.innerHTML = '<div class="skeleton">Fetching your tanks…</div>'; refreshTanks(); };
      return;
    }
    el.innerHTML = '<div class="skeleton">Fetching your tanks…</div>'; if (!T.busy) refreshTanks(); return;
  }
  const d = T.data, s = d.settings, t = d.totals, now = d.now;
  const usable = Math.max(0, now.tank - s.reserveLitres);
  const o = tankOutlook(now.tank, t.recentRate);
  const daysNoRain = Math.floor(usable / t.recentRate);
  const sinceRead = now.daysSinceReading;
  const verdict = o.low > 40000 ? 'Plenty to get through summer.' : o.low > 20000 ? 'Enough for summer, but it will get tight by autumn.' : 'Tight. Worth cutting back now.';
  const alerts = [];
  if (t.highUse) alerts.push(`Use since the last reading was <b>${nf.format(t.latestRate)} L/day</b>, well above your usual ${nf.format(t.prevRecentRate)}. Check for a leak or a tap left on.`);
  if (sinceRead > 8) alerts.push(`Last meter reading was ${Math.floor(sinceRead)} days ago, so today's figure is an estimate. A fresh reading sharpens everything.`);
  if (T.stale) alerts.push(`Offline: showing figures from ${new Date(T.at).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`);

  // usage chart
  const iv = d.intervals.slice(-12), W = 340, H = 170, pl = 32, pr = 6, pt = 10, pb = 22;
  const ymax = Math.max(800, Math.ceil(Math.max(...iv.map(i => i.perDay)) / 200) * 200);
  const x0 = iv[0].fromDay, x1 = iv[iv.length - 1].toDay, X = v => pl + (v - x0) / (x1 - x0) * (W - pl - pr), Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = yAxis(Y, niceTicks(ymax, 4), W, pl, pr);
  iv.forEach((i, n) => {
    const xa = X(i.fromDay) + 1, xb = X(i.toDay) - 1, y = Y(i.perDay), hot = t.highUse && n === iv.length - 1;
    g += `<rect x="${xa}" y="${y}" width="${Math.max(2, xb - xa)}" height="${Y(0) - y}" rx="3" fill="${hot ? 'var(--warn)' : 'var(--water)'}" opacity="${o.safe && i.perDay > o.safe ? 1 : .6}" data-tip="<b>${dayLabel(i.from.slice(0, 10))} – ${dayLabel(i.to.slice(0, 10))}</b><br>${nf.format(i.perDay)} L/day · ${nf.format(i.litres)} L${i.note ? '<br>' + esc(i.note) : ''}"/>`;
  });
  if (o.safe) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(o.safe)}" y2="${Y(o.safe)}" stroke="var(--good)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W - pr}" y="${Y(o.safe) - 4}" text-anchor="end" style="fill:var(--good);font-weight:600">safe ${o.safe}</text>`;
  const months = {}; iv.forEach(i => { const m = i.from.slice(0, 7); if (!months[m]) months[m] = X(dayNum(m + '-01')); });
  Object.entries(months).forEach(([m, x]) => { if (x >= pl) g += `<text x="${x}" y="${H - 6}">${MON[+m.slice(5) - 1]}</text>`; });

  // rain lines
  const rainSince = d.rain.filter(r => r.date > d.lastReading.local.slice(0, 10));
  const lastRain = d.rain.filter(r => r.mm >= 1).slice(-1)[0];
  const fc = (d.forecast && d.forecast.days) || [], fcMm = sum(fc.map(f => f.mm || 0)), fcBig = fc.filter(f => (f.mm || 0) >= 2);
  const monthKey = now.local.slice(0, 7), monthMm = sum(d.rain.filter(r => r.date.slice(0, 7) === monthKey).map(r => r.mm));
  const rainHead = fcBig.length ? `${fmtMm(fcMm)} forecast in the next week, worth about ${nf.format(fcMm * d.litresPerMm)} L.` : `Little rain forecast in the next week.`;
  const rainExplain = `${lastRain ? `The last useful rain was ${dayLabel(lastRain.date)} (${fmtMm(lastRain.mm)}, about ${nf.format(lastRain.litres)} L into the tanks). ` : ''}${MON[+monthKey.slice(5) - 1]} so far: ${fmtMm(monthMm)}. Since tracking began the roof has caught <b>${nf.format(t.captured)} L</b>. Every 1 mm on the roof is about ${nf.format(d.litresPerMm)} L.`;

  el.innerHTML = `
    <div class="view-head"><h1>Tanks</h1><span class="sub">Hi ${esc(T.who || '')}</span></div>
    ${alerts.map(a => `<div class="alert">${a}</div>`).join('')}
    <div class="card">
      <div class="q">How much water have we got?</div>
      <div class="hero-row">${tankSvg(now.tank, s)}
        <div><div class="big num">${nf.format(Math.round(usable / 100) * 100)}</div><div class="muted small">litres usable now</div>
        <p class="small" style="margin-top:8px">${nf.format(now.tank)} L in the tanks, less the ${(Math.round(s.reserveLitres / 1000) + 'k')} the pump can't reach.</p></div>
      </div>
      <h3 class="answer" style="margin-top:12px">${verdict}</h3>
      <p class="explain">In a typical year the tanks bottom out around <b>${MON[o.lowMonth]}</b> at about ${nf.format(Math.round(o.low / 1000) * 1000)} L. With no rain at all, ${daysNoRain} days at your recent ${nf.format(t.recentRate)} L a day.</p>
      <p class="tiny muted">Last reading ${fmtWhen(d.lastReading.local)} · ${nf.format(d.lastReading.meter)} L on the meter${sinceRead > 0.5 ? ' · today is estimated' : ''}</p>
    </div>
    <button class="btn big-btn" id="t-log">+ Log a meter reading</button>
    ${aheadCard(now.tank)}
    ${card({
      q: 'Are we using too much?',
      headline: o.safe ? (t.recentRate > o.safe + 15 ? `A little. You're using ${nf.format(t.recentRate)} L a day; the rain reliably supports about ${o.safe}.` : `No. ${nf.format(t.recentRate)} L a day is within what the roof can reliably supply (about ${o.safe}).`) : `Lately ${nf.format(t.recentRate)} L a day.`,
      explain: `"Reliably" means staying clear of the pump reserve in 19 of 20 rain histories over three years. Each bar is the daily average between two readings; ${t.latestRate > t.prevRecentRate * 1.1 ? 'the latest period was higher than usual.' : 'recent periods are steady.'} Since September: ${nf.format(t.overallRate)} L a day.`,
      chart: `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Litres per day between readings">${g}</svg>`,
      numbers: `${table(['Reading', 'Meter L', 'L/day', ''], d.readings.slice().reverse().map((r, i, arr) => {
        const ivv = d.intervals.find(x => x.to === r.local);
        return [`${fmtWhen(r.local)}<br><span class="tiny muted">${esc(r.by || '')}${r.note ? ' · ' + esc(r.note) : ''}</span>`, nf.format(r.meter), ivv ? nf.format(ivv.perDay) : '–', i === arr.length - 1 ? '' : `<button class="x" data-del-reading="${r.local}" aria-label="Delete reading">✕</button>`];
      }))}`,
      numbersLabel: `All ${d.readings.length} readings`
    })}
    ${card({
      q: 'Is rain topping them up?',
      headline: rainHead,
      explain: rainExplain + (d.rainStatus ? ` <span class="tiny">Rain is logged automatically each morning from ${esc(d.rainStatus.source || 'SILO')}.</span>` : ''),
      chart: rainStrip(d),
      numbers: table(['Day', 'mm', 'Litres', 'Source'], d.rain.slice().reverse().slice(0, 40).map(r => [dayLabel(r.date), r.mm, nf.format(r.litres), `<span class="tiny muted">${esc(shortSrc(r.source))}</span><button class="x" data-del-rain="${r.date}" aria-label="Delete rain entry">✕</button>`])),
      numbersLabel: 'Rain log'
    })}
    <div class="card">
      <div class="q">Keep the numbers honest</div>
      <p class="explain">The meter measures what you use, not what's in the tank, so the level is an estimate. If your own gauge disagrees with the rain, or you dip the tanks, record it here and the model corrects itself.</p>
      <div class="row2"><button class="ghost" id="t-rain">Enter rain by hand</button><button class="ghost" id="t-check">Record tank level</button></div>
      ${d.checks.length ? `<p class="tiny muted" style="margin-top:8px">Last check: ${nf.format(d.checks[d.checks.length - 1].litres)} L.</p>` : ''}
    </div>
    <p class="note">Your readings live in your private Google Sheet. <a href="https://docs.google.com/spreadsheets/d/1-jxUCdUG4zsni5m9vYbpUEs54PbtBwCKq36Yb_zdKgE/edit" target="_blank" rel="noopener">Open the sheet</a></p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
  drawAhead(now.tank);
  $('#ah-rate').oninput = e => { outlook.rate = +e.target.value; outlook.touched = true; drawAhead(now.tank); };
  $('#t-log').onclick = () => openForm('reading');
  $('#t-rain').onclick = () => openForm('rain');
  $('#t-check').onclick = () => openForm('check');
  el.querySelectorAll('[data-del-reading]').forEach(b => b.onclick = () => confirmDelete('deleteReading', { at: b.dataset.delReading }, `the reading from ${fmtWhen(b.dataset.delReading)}`));
  el.querySelectorAll('[data-del-rain]').forEach(b => b.onclick = () => confirmDelete('deleteRain', { date: b.dataset.delRain }, `the rain entry for ${dayLabel(b.dataset.delRain)}`));
}
const shortSrc = s => /SILO/.test(s) ? 'SILO' : /Open-Meteo/.test(s) ? 'estimate' : /Willy|BOM/.test(s) ? 'BOM' : s;
const fmtMm = v => (Math.round(v * 10) / 10) + ' mm';

function rainStrip(d) {
  const today = Math.floor(d.now.day), start = today - 20, end = today + 7, obs = {}, fc = {};
  d.rain.forEach(r => obs[Math.floor(dayNum(r.date))] = r);
  ((d.forecast && d.forecast.days) || []).forEach(f => fc[Math.floor(dayNum(f.date))] = f);
  const W = 340, H = 120, pl = 26, pr = 4, pt = 8, pb = 20, n = end - start + 1, bw = (W - pl - pr) / n;
  let ymax = 5; for (let i = start; i <= end; i++) ymax = Math.max(ymax, (obs[i] && obs[i].mm) || (i >= today && fc[i] && fc[i].mm) || 0);
  ymax = Math.ceil(ymax / 5) * 5;
  const Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = yAxis(Y, [0, ymax], W, pl, pr);
  g += `<defs><pattern id="hatch2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--water-soft)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--water)" stroke-width="1.5"/></pattern></defs>`;
  for (let i = start; i <= end; i++) {
    const isFc = i >= today && !obs[i], v = isFc ? ((fc[i] && fc[i].mm) || 0) : ((obs[i] && obs[i].mm) || 0), x = pl + (i - start) * bw + 1, w = bw - 2;
    if (v > 0) g += `<rect x="${x}" y="${Y(v)}" width="${w}" height="${Y(0) - Y(v)}" rx="2" fill="${isFc ? 'url(#hatch2)' : 'var(--water)'}"/>`;
    const lab = new Date(Date.UTC(1970, 0, 1) + i * DAY);
    g += `<rect x="${x - 1}" y="0" width="${bw}" height="${H}" fill="transparent" data-tip="<b>${lab.getUTCDate()} ${MON[lab.getUTCMonth()]}</b><br>${isFc ? `Forecast ${fmtMm(v)}${fc[i] && fc[i].chance != null ? ` · ${fc[i].chance}% chance` : ''}` : v ? `${fmtMm(v)} · ${nf.format(v * d.litresPerMm)} L caught` : 'No rain'}"/>`;
    if ((i - start) % 7 === 0) g += `<text x="${x + w / 2}" y="${H - 5}" text-anchor="middle">${lab.getUTCDate()} ${MON[lab.getUTCMonth()]}</text>`;
  }
  const tx = pl + (today - start) * bw;
  g += `<line x1="${tx}" x2="${tx}" y1="${pt}" y2="${H - pb}" stroke="var(--ink-3)" stroke-dasharray="2 3"/><text x="${tx + 3}" y="${pt + 8}">forecast →</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rain over the last three weeks and the week ahead">${g}</svg>`;
}

async function refreshTanks(quiet) {
  if (T.busy) return; T.busy = true;
  try { await api('dashboard'); T.error = null; } catch (e) { T.error = e.message; if (!quiet && T.data) toast(e.message === 'Failed to fetch' ? 'Offline: showing saved figures.' : e.message); T.stale = !!T.data; }
  T.busy = false;
  if (!$('#view-tanks').hidden || !rendered.tanks) renderTanks();
}

// ---------------- forms (bottom sheets)
function openForm(kind) {
  const d = T.data, nowLocal = (() => { const n = new Date(), p = v => String(v).padStart(2, '0'); return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}`; })();
  const forms = {
    reading: `<h3>Log a meter reading</h3>
      <label class="fl">Meter reading <span class="muted">(litres, or m³ like 36.48)</span></label>
      <input id="f-meter" class="inp huge" inputmode="decimal" autocomplete="off" placeholder="${nf.format(d.lastReading.meter)}">
      <div class="hint" id="f-hint">Last: ${nf.format(d.lastReading.meter)} L, ${fmtWhen(d.lastReading.local)}.</div>
      <label class="fl">Note <span class="muted">(optional)</span></label><input id="f-note" class="inp" placeholder="e.g. watered the new beds">
      <label class="fl">Read at</label><input id="f-when" class="inp" type="datetime-local" value="${nowLocal}">`,
    rain: `<h3>Enter rain by hand</h3><p class="small muted">For when your own gauge disagrees. It replaces the automatic figure for that day.</p>
      <div class="row2"><div><label class="fl">Date</label><input id="f-date" class="inp" type="date" value="${nowLocal.slice(0, 10)}"></div>
      <div><label class="fl">Rain (mm)</label><input id="f-mm" class="inp" inputmode="decimal"></div></div>
      <label class="fl">Note <span class="muted">(optional)</span></label><input id="f-note" class="inp">`,
    check: `<h3>Record tank level</h3><p class="small muted">If you measure the main tanks (dipstick or gauge), enter the total. The estimate resets to it.</p>
      <label class="fl">Water in main tanks (litres)</label><input id="f-litres" class="inp huge" inputmode="numeric">
      <label class="fl">How you measured <span class="muted">(optional)</span></label><input id="f-note" class="inp">`
  };
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="scrim"></div><div class="sheet">${forms[kind]}<div class="row2" style="margin-top:14px"><button class="ghost" data-close>Cancel</button><button class="btn" id="f-save">Save</button></div></div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 250); };
  wrap.querySelector('.scrim').onclick = close; wrap.querySelector('[data-close]').onclick = close;
  const save = wrap.querySelector('#f-save');
  if (kind === 'reading') {
    const inp = wrap.querySelector('#f-meter'), hint = wrap.querySelector('#f-hint');
    setTimeout(() => inp.focus(), 280);
    save.disabled = true;
    inp.oninput = () => {
      const l = parseMeter(inp.value); hint.className = 'hint';
      if (!inp.value) { hint.textContent = `Last: ${nf.format(d.lastReading.meter)} L.`; save.disabled = true; return; }
      if (l === null) { hint.textContent = 'Numbers only, please.'; hint.className = 'hint bad'; save.disabled = true; return; }
      const used = l - d.lastReading.meter, days = (Date.now() - new Date(d.lastReading.local.replace(' ', 'T')).getTime()) / DAY;
      if (used < 0) { hint.textContent = `That's lower than the last reading (${nf.format(d.lastReading.meter)} L). Check the dial.`; hint.className = 'hint bad'; save.disabled = true; return; }
      const per = days > 0.5 ? used / days : null;
      hint.textContent = `= ${nf.format(l)} L · ${nf.format(used)} L since last time${per ? ` (${nf.format(per)} L/day)` : ''}`;
      if (per && per > Math.max(1500, d.totals.recentRate * 3)) { hint.textContent += '. That looks very high: check the dial?'; hint.className = 'hint bad'; }
      save.disabled = false;
    };
  }
  save.onclick = async () => {
    save.disabled = true; save.textContent = 'Saving…';
    try {
      if (kind === 'reading') await api('addReading', { litres: parseMeter(wrap.querySelector('#f-meter').value), note: wrap.querySelector('#f-note').value, when: wrap.querySelector('#f-when').value });
      if (kind === 'rain') await api('setRain', { date: wrap.querySelector('#f-date').value, mm: +wrap.querySelector('#f-mm').value, note: wrap.querySelector('#f-note').value });
      if (kind === 'check') await api('addTankCheck', { litres: +String(wrap.querySelector('#f-litres').value).replace(/[,\s]/g, ''), note: wrap.querySelector('#f-note').value });
      close(); renderTanks();
      if (kind === 'reading') { const iv = T.data.intervals[T.data.intervals.length - 1]; toast(`Saved. ${nf.format(iv.litres)} L since last time, ${nf.format(iv.perDay)} L a day.`); }
      else toast('Saved.');
    } catch (e) { toast(e.message === 'Failed to fetch' ? 'No connection. Try again when you have signal.' : e.message); save.disabled = false; save.textContent = 'Save'; }
  };
}
function parseMeter(raw) { const v = Number(String(raw).replace(/[,\s]/g, '')); if (!(v > 0)) return null; return v < 5000 ? Math.round(v * 1000) : Math.round(v); }
async function confirmDelete(action, payload, what) {
  if (!window.confirm(`Delete ${what}?`)) return;
  try { await api(action, payload); renderTanks(); toast('Deleted.'); } catch (e) { toast(e.message); }
}
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => t.style.opacity = 0, 2800);
}

// ================================================================= RAIN view shell
const rainState = { sub: 'year' };
function renderRain() {
  const el = $('#view-rain');
  el.innerHTML = `
    <div class="view-head"><h1>Rain</h1><span class="sub">Norton Summit since 1889</span></div>
    <div class="seg" role="tablist">${[['year', 'This year'], ['history', 'Patterns'], ['explore', 'Explore']].map(([k, l]) => `<button role="tab" data-sub="${k}" aria-selected="${rainState.sub === k}">${l}</button>`).join('')}</div>
    <div id="rain-body"></div>`;
  el.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { rainState.sub = b.dataset.sub; renderRain(); scrollTo(0, 0); });
  const body = $('#rain-body');
  ({ year: renderThisYear, history: renderHistory, explore: renderExplore })[rainState.sub](body);
}

// ================================================================= tabs + boot
const rendered = {};
function show(tab) {
  document.querySelectorAll('.tabbar [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + tab);
  if (!rendered[tab] && D) { ({ tanks: renderTanks, rain: renderRain, genie: renderGenie })[tab](); rendered[tab] = true; }
  hideTip(); scrollTo(0, 0);
  if (tab === 'tanks' && keyOf() && (!T.at || Date.now() - T.at > 60000)) refreshTanks(true);
  try { localStorage.setItem('tal-tab', tab); } catch (e) {}
  history.replaceState(null, '', location.pathname + location.search + '#' + tab);
}
document.querySelectorAll('.tabbar [data-tab]').forEach(b => b.onclick = () => show(b.dataset.tab));

(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('k')) setKey(params.get('k')); else if (keyOf()) setKey(keyOf());
  const initial = (location.hash || '').slice(1) || (() => { try { return localStorage.getItem('tal-tab'); } catch (e) { return null; } })() || (keyOf() ? 'tanks' : 'rain');
  document.querySelectorAll('.view').forEach(v => v.innerHTML = '<div class="skeleton">Loading 137 years of rain…</div>');
  const raw = await fetch('data/rain.json', { cache: 'no-cache' }).then(r => r.json());
  D = deriveData(raw);
  loadCachedTanks();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && keyOf()) refreshTanks(true); });
  show(['tanks', 'rain', 'genie'].includes(initial) ? initial : 'rain');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
