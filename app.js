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
  dailyUse: 470,        // spring–summer (irrigation season) use, L/day
  winterUse: 300,       // winter use with the irrigation off; overridden by Settings.winterDailyLitres
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
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + nf.format(Math.abs(v));

// Decade bars rising above or falling below the long-run average: one bar per decade, so a slow
// trend reads at a glance instead of hiding in 130 noisy yearly bars. Used by Patterns and the Genie.
function decadeChart({ items, avg, futureLabel }) {
  const W = 340, H = 208, pl = 4, pr = 4, pt = 20, pb = 36;
  const ds = items.flatMap(o => [o.v - avg, (o.lo != null ? o.lo : o.v) - avg, (o.hi != null ? o.hi : o.v) - avg]);
  const top = Math.ceil(Math.max(60, ...ds) / 50) * 50, bot = Math.floor(Math.min(-60, ...ds) / 50) * 50;
  const Y = d => pt + (top - d) / (top - bot) * (H - pt - pb);
  const bw = (W - pl - pr) / items.length;
  let g = '';
  const fi = items.findIndex(o => o.future);
  if (fi > 0) {
    const fx = pl + fi * bw;
    g += `<rect x="${fx}" y="${pt - 16}" width="${W - pr - fx}" height="${H - pb - pt + 16}" fill="var(--bg)" rx="6"/>`;
    g += `<text x="${fx + 5}" y="${pt - 5}" style="font-weight:600">${futureLabel || 'projected'}</text>`;
  }
  g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--ink-3)" stroke-width="1.2"/>`;
  items.forEach((o, i) => {
    const d = o.v - avg, x = pl + i * bw + 3, w = bw - 6, cx = x + w / 2;
    const y1 = Y(Math.max(d, 0)), y2 = Y(Math.min(d, 0));
    g += `<rect x="${x}" y="${y1}" width="${w}" height="${Math.max(2, y2 - y1)}" rx="3" fill="${d >= 0 ? 'var(--cool)' : 'var(--warm)'}" opacity="${o.future ? (o.hl ? .75 : .45) : (o.hl ? 1 : .85)}"${o.hl ? ' stroke="var(--ink)" stroke-width="1.5"' : ''}/>`;
    let labY = d >= 0 ? y1 - 4 : y2 + 11;
    if (o.lo != null) {
      const a = Y(o.hi - avg), b = Y(o.lo - avg);
      g += `<line x1="${cx}" x2="${cx}" y1="${a}" y2="${b}" stroke="var(--ink-3)" stroke-width="1" opacity=".7"/><line x1="${cx - 3}" x2="${cx + 3}" y1="${a}" y2="${a}" stroke="var(--ink-3)" stroke-width="1"/><line x1="${cx - 3}" x2="${cx + 3}" y1="${b}" y2="${b}" stroke="var(--ink-3)" stroke-width="1"/>`;
      labY = d >= 0 ? Math.min(y1, a) - 4 : Math.max(y2, b) + 11;
    }
    g += `<text x="${cx}" y="${labY}" text-anchor="middle" style="font-size:9.5px;fill:var(--ink-2);font-weight:${o.hl ? 700 : 500}">${signed(Math.round(d / 5) * 5)}</text>`;
    if (o.showLabel || o.hl) g += `<text x="${cx}" y="${H - 8}" text-anchor="middle" style="${o.hl ? 'fill:var(--ink);font-weight:650' : ''}">${o.label}</text>`;
    g += `<rect x="${x - 3}" y="0" width="${bw}" height="${H}" fill="transparent" data-tip="${o.tip}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average rain per decade compared with the long-run average">${g}</svg>`;
}
const decadeLegend = (avg, extra) => `<span><i style="background:var(--cool)"></i>Wetter than the ${nf.format(avg)} mm average</span><span><i style="background:var(--warm)"></i>Drier</span>${extra || ''}`;

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
  const explain = `By ${doyToDate(doy, y)} a typical year has brought <b>${mm(bands[2][doy])}</b>. This year: <b>${mm(ytd)}</b>, ${ordinal(rank)} wettest of ${ytdAll.length + 1} years.`;

  // chart: this year's running total against a typical year and the normal range (middle half of years)
  const W = 340, H = 210, pl = 36, pr = 52, pt = 8, pb = 22;
  const ymax = Math.ceil(Math.max(bands[3][364], ytd) / 200) * 200 + 100;
  const X = i => pl + i / 364 * (W - pl - pr), Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  const pts = arr => arr.map((v, i) => [X(i), Y(v)]);
  let g = yAxis(Y, niceTicks(ymax, 4), W, pl, pr);
  g += `<path d="${area(pts(bands[3]), pts(bands[1]))}" fill="var(--band)"/>`;
  g += `<path d="${path(pts(bands[2]))}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  g += `<path d="${path(pts(nowCum))}" fill="none" stroke="var(--water)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
  g += `<circle cx="${X(doy)}" cy="${Y(ytd)}" r="5" fill="var(--water)" stroke="var(--card)" stroke-width="2"/>`;
  g += `<text x="${X(doy) - 6}" y="${Y(ytd) - 9}" text-anchor="end" style="fill:var(--water);font-weight:700;font-size:12px">${y}: ${nf.format(ytd)}</text>`;
  g += `<text class="lbl" x="${W - pr + 4}" y="${Y(bands[2][364]) + 4}">typical</text><text class="lbl" x="${W - pr + 4}" y="${Y(bands[2][364]) + 17}">${nf.format(bands[2][364])}</text>`;
  for (let m = 0; m < 12; m += 2) { const i = Math.floor((Date.UTC(2025, m, 1) - Date.UTC(2025, 0, 1)) / DAY); g += `<text x="${X(i)}" y="${H - 6}">${MON[m]}</text>`; }
  for (let i = 0; i < 365; i += 7) {
    const now = i <= doy ? `<br>${y}: <b>${mm(nowCum[i])}</b>` : '';
    g += `<rect x="${X(i)}" y="0" width="${(W - pl - pr) / 52 + 0.5}" height="${H - pb}" fill="transparent" data-tip="<b>By ${doyToDate(i)}</b>${now}<br>Typical year: ${mm(bands[2][i])}<br>Normal range: ${nf.format(bands[1][i])}–${nf.format(bands[3][i])} mm"/>`;
  }

  // numbers: month by month
  const mNow = D.monthly[y], lastM = new Date(Date.UTC(2025, 0, 1) + doy * DAY).getUTCMonth();
  const monthRows = [];
  for (let m = 0; m <= lastM; m++) {
    const all = D.full.map(yy => D.monthly[yy][m]), v = mNow[m], pp = pctBelow(all, v);
    monthRows.push([MON[m] + (m === lastM ? ' (so far)' : ''), nf.format(v), nf.format(median(all)), m === lastM ? '–' : `<span class="tag ${tagFor(pp)}">${pp >= 67 ? 'wet' : pp <= 33 ? 'dry' : 'normal'}</span>`]);
  }
  const sWord = s => s.p >= 90 ? 'very wet' : s.p >= 67 ? 'wet' : s.p <= 10 ? 'very dry' : s.p <= 33 ? 'dry' : 'normal';

  el.innerHTML =
    card({
      q: 'How is this year going?', headline, explain,
      chart: `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rain building up through ${y} against a typical year">${g}</svg>`,
      legend: `<span><i class="line" style="background:var(--water)"></i>${y} so far</span><span><i class="line" style="background:var(--ink-3)"></i>Typical year</span><span><i style="background:var(--band)"></i>Normal range (middle half of years)</span>`,
      numbers: table(['Month', `${y} mm`, 'Typical mm', ''], monthRows, { note: 'Typical = the middle value for that month since 1889. Wet or dry = in the wettest or driest third of years.' }),
      numbersLabel: 'See each month'
    }) +
    card({
      q: 'Season by season',
      headline: seasons.filter(s => s.name !== 'Summer').map(s => `${s.name}${s.partial ? ' (so far)' : ''} ${s.partial ? 'is' : 'was'} ${sWord(s)}`).join(', ').replace(/, ([^,]*)$/, ' and $1') + '.',
      chart: `<div class="chips">${seasons.filter(s => s.name !== 'Summer').map(s => `<div class="chipcard"><span>${s.name}${s.partial ? ' so far' : ''}</span><b>${nf.format(s.v)}<span class="tiny muted">&nbsp;mm</span></b><span>typical ${nf.format(s.med)}</span><span class="tag ${tagFor(s.p)}">${sWord(s)}</span></div>`).join('')}</div>`
    }) +
    `<p class="note">Rain for the Norton Summit area: the average of two 5 km SILO grid cells, 1889 to ${doyToDate(doy, y)} ${y}, counted on the 9 am rain day.</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= RAIN: PATTERNS
function renderHistory(el) {
  const full = D.full, ann = full.map(y => D.annual[y]);
  const split = 1990, early = full.filter(y => y < split), recent = full.filter(y => y >= split);
  const eMean = mean(early.map(y => D.annual[y])), rMean = mean(recent.map(y => D.annual[y]));
  const avg = mean(ann), med = median(ann), swing = quantile(ann, 0.84) - med;
  const chgAll = (rMean / eMean - 1) * 100;

  // --- 1. decades above / below the long-run average
  const decades = []; for (let d = 1890; d <= D.lastFull; d += 10) { const ys = full.filter(y => y >= d && y < d + 10); if (ys.length) decades.push({ d, ys }); }
  const items = decades.map(({ d, ys }, i) => {
    const v = mean(ys.map(y => D.annual[y])), vals = ys.map(y => D.annual[y]);
    const wet = ys[vals.indexOf(Math.max(...vals))], dry = ys[vals.indexOf(Math.min(...vals))];
    return { label: `${d}s`, v, showLabel: i % 2 === 0 && i < decades.length - 2, hl: d === decades[decades.length - 1].d,
      tip: `<b>${d}s${ys.length < 10 ? ` (${ys.length} years so far)` : ''}</b><br>Average ${mm(v)} a year (${signed(Math.round(v - avg))} mm)<br>Wettest ${wet}: ${nf.format(D.annual[wet])} · driest ${dry}: ${nf.format(D.annual[dry])}` };
  });
  const drierDecs = decades.filter(o => o.d >= 1990 && mean(o.ys.map(y => D.annual[y])) < avg).length, recentDecs = decades.filter(o => o.d >= 1990).length;
  const decRows = decades.map(({ d, ys }) => {
    const vals = ys.map(y => D.annual[y]), wet = ys[vals.indexOf(Math.max(...vals))], dry = ys[vals.indexOf(Math.min(...vals))];
    return { hl: d >= 2020, cells: [`${d}s${ys.length < 10 ? ` <span class="tiny muted">(${ys.length} yrs)</span>` : ''}`, nf.format(mean(vals)), `${wet} <span class="tiny muted">${nf.format(D.annual[wet])}</span>`, `${dry} <span class="tiny muted">${nf.format(D.annual[dry])}</span>`] };
  });
  const q1 = card({
    q: 'Is Norton Summit getting drier?',
    headline: chgAll <= -4 ? 'A little drier since 1990. A nudge, not a collapse.' : chgAll >= 4 ? 'If anything it\'s a little wetter.' : 'Not much has changed overall.',
    explain: `Each bar is a decade, above or below the long-run average of <b>${mm(avg)}</b> a year. ${drierDecs} of the ${recentDecs} decades since 1990 came in below it. A typical year now brings about <b>${mm(rMean)}</b>, ${Math.abs(Math.round(chgAll))}% ${chgAll < 0 ? 'less' : 'more'} than before 1990. Single years swing far more than that, often ${nf.format(Math.round(swing / 10) * 10)} mm either way.`,
    chart: decadeChart({ items, avg }),
    legend: decadeLegend(avg, `<span>Numbers: mm a year above or below</span>`),
    numbers: table(['Decade', 'Avg mm', 'Wettest', 'Driest'], decRows),
    numbersLabel: 'See each decade'
  });

  // --- 2. which seasons changed (tiles, no chart)
  const rd = y => D.raw.raindays[y], hv = y => D.raw.heavydays[y];
  const mE = Array.from({ length: 12 }, (_, m) => mean(early.map(y => D.monthly[y][m])));
  const mR = Array.from({ length: 12 }, (_, m) => mean(recent.map(y => D.monthly[y][m])));
  const seas = [['Autumn', 'Mar–May', [2, 3, 4]], ['Winter', 'Jun–Aug', [5, 6, 7]], ['Spring', 'Sep–Nov', [8, 9, 10]], ['Summer', 'Dec–Feb', [11, 0, 1]]]
    .map(([n, sub, ms]) => { const e = sum(ms.map(m => mE[m])), r = sum(ms.map(m => mR[m])); return { n, sub, e, r, c: (r / e - 1) * 100 }; });
  const word = c => c <= -12 ? 'drier' : c <= -5 ? 'a bit drier' : c >= 12 ? 'wetter' : c >= 5 ? 'a bit wetter' : 'about the same';
  const groups = {}; seas.forEach(s => (groups[word(s.c)] = groups[word(s.c)] || []).push(s.n.toLowerCase()));
  const join = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0];
  const order = ['drier', 'a bit drier', 'wetter', 'a bit wetter'];
  const seasonHead = order.filter(w => groups[w]).map(w => `${join(groups[w])} ${groups[w].length > 1 ? 'are' : 'is'} ${w}`).join('; ').replace(/^./, c => c.toUpperCase()) + '.' + (groups['about the same'] ? ` ${cap(join(groups['about the same']))} ${groups['about the same'].length > 1 ? 'are' : 'is'} as wet as ever.` : '');
  const drops = mE.map((e, m) => ({ m, c: (mR[m] / e - 1) * 100 })).filter(o => o.c <= -15).sort((a, b) => a.c - b.c);
  const rdE = mean(early.map(rd)), rdR = mean(recent.map(rd)), hvE = mean(early.map(hv)), hvR = mean(recent.map(hv));
  const q2 = card({
    q: 'Which part of the year has changed?',
    headline: seasonHead,
    chart: `<div class="chips four">${seas.map(s => `<div class="chipcard"><span>${s.n} <span class="tiny">${s.sub}</span></span><b>${Math.abs(s.c) < 3 ? 'same' : pctTxt(s.c).replace('-', '−')}</b><span class="tag ${s.c <= -5 ? 'dry' : s.c >= 5 ? 'wet' : ''}">${word(s.c)}</span></div>`).join('')}</div>`,
    explain: `Since 1990 compared with before. ${drops.length ? `The biggest drops are ${drops.slice(0, 3).map(o => `${MON[o.m]} (${pctTxt(o.c)})`).join(', ')}, so the tanks wait longer to start refilling. ` : ''}We get about ${Math.round(rdE - rdR)} fewer rainy days a year, but the big soaking falls that fill tanks are ${Math.abs(hvR / hvE - 1) < 0.1 ? 'as common as ever' : hvR < hvE ? 'a little less common' : 'a little more common'}.`,
    numbers: table(['Month', '1889–1989', `1990–${String(D.lastFull).slice(2)}`, 'Change'], mE.map((e, m) => ({ hl: Math.abs(mR[m] / e - 1) >= 0.15, cells: [MON[m], nf.format(e), nf.format(mR[m]), pctTxt((mR[m] / e - 1) * 100)] })).concat([
      { cells: ['<b>Rainy days a year</b>', Math.round(rdE), Math.round(rdR), pctTxt((rdR / rdE - 1) * 100)] },
      { cells: ['<b>Falls of 20 mm+ a year</b>', hvE.toFixed(1), hvR.toFixed(1), pctTxt((hvR / hvE - 1) * 100)] }]), { note: 'Average monthly rain in mm. Highlighted rows changed by 15% or more.' }),
    numbersLabel: 'See each month'
  });

  // --- 3. dry spells (a list, no chart)
  const q20 = quantile(ann, 0.2);
  const after = (cond, test) => { const ys = full.filter(y => cond(D.annual[y]) && D.annual[y + 1] != null); return Math.round(ys.filter(y => test(D.annual[y + 1])).length / ys.length * 100); };
  const aDry = after(v => v <= q20, v => v < med);
  const runs = []; let cur = [];
  full.forEach(y => { if (D.annual[y] < med) cur.push(y); else { if (cur.length >= 3) runs.push(cur.slice()); cur = []; } });
  if (cur.length >= 3) runs.push(cur);
  runs.sort((a, b) => b.length - a.length || a[0] - b[0]);
  const stretch = k => full.slice(k - 1).map((y, i) => ({ y0: full[i], y1: y, v: sum(full.slice(i, i + k).map(yy => D.annual[yy])) / k })).sort((a, b) => a.v - b.v);
  const s2 = stretch(2), s3 = stretch(3), lastPair = s2.findIndex(o => o.y1 === D.lastFull);
  const runRow = r => ({ hl: r[r.length - 1] >= 2000, cells: [`${r[0]}–${r[r.length - 1]}`, `${r.length} years`, nf.format(mean(r.map(y => D.annual[y]))) + ' mm'] });
  const q4 = card({
    q: 'How bad do dry spells get?',
    headline: `The longest run of below-average years is a recent one: ${runs[0][0]}–${runs[0][runs[0].length - 1]}.`,
    explain: `Dry years usually come in clumps of 3 or 4. ${runs[0].length} in a row is the record. A very dry year doesn't make the next one dry: it happened ${aDry}% of the time, close to a coin toss.${lastPair >= 0 && lastPair < 5 ? ` ${D.lastFull - 1}–${D.lastFull} was the ${ordinal(lastPair + 1)} driest pair of years since 1889.` : ''}`,
    chart: table(['Longest dry runs', '', 'Avg a year'], runs.slice(0, 4).map(runRow)),
    numbers: table(['Dry run', 'Years', 'Avg mm'], runs.map(r => ({ hl: r[r.length - 1] >= 2000, cells: [`${r[0]}–${r[r.length - 1]}`, r.length, nf.format(mean(r.map(y => D.annual[y])))] })), { note: `Runs of 3+ years below the typical ${mm(med)}. Driest 3-year stretches: ${s3.slice(0, 3).map(o => `${o.y0}–${o.y1} (${nf.format(o.v)} mm/yr)`).join(', ')}.` }),
    numbersLabel: 'See every dry run'
  });

  el.innerHTML = q1 + q2 + driversCard() + q4 + `<p class="note">Tap a bar for its numbers. El Niño and La Niña years follow the Bureau of Meteorology's event list.</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
}

// ================================================================= RAIN: EL NIÑO AND THE INDIAN OCEAN (a short list, no chart)
function driversCard() {
  const months = [4, 5, 6, 7, 8, 9, 10];
  const refill = y => seasonTotal(y, months);
  const base = D.full.filter(y => y >= 1900), med = median(base.map(refill));
  const base60 = base.filter(y => y >= 1960), med60 = median(base60.map(refill));
  const y0 = D.endYear, have = D.endDoy >= 303, v0 = have ? refill(y0) : null;
  const rows = [
    { label: 'El Niño', what: 'warm Pacific', ys: base.filter(y => D.EN.has(y)), med, on: D.EN.has(y0) },
    { label: 'Positive Indian Ocean Dipole', what: 'cool water off our north-west', ys: base60.filter(y => D.IP.has(y)), med: med60, on: D.IP.has(y0) },
    { label: 'Both at once', what: '', ys: base60.filter(y => D.EN.has(y) && D.IP.has(y)), med: med60, on: D.EN.has(y0) && D.IP.has(y0) },
    { label: 'La Niña', what: 'cool Pacific', ys: base.filter(y => D.LN.has(y)), med, on: D.LN.has(y0) },
    { label: 'Negative Indian Ocean Dipole', what: '', ys: base60.filter(y => D.IN.has(y)), med: med60, on: D.IN.has(y0) },
    { label: 'Neither', what: '', ys: base.filter(y => !D.EN.has(y) && !D.LN.has(y)), med, on: false }
  ].map(r => { const p = r.ys.map(y => refill(y) / r.med * 100); return Object.assign(r, { n: p.length, m: Math.round(median(p)), below: Math.round(p.filter(v => v < 100).length / p.length * 100), vdry: Math.round(p.filter(v => v < 75).length / p.length * 100) }); });
  const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
  const oneIn = p => p >= 70 ? `${Math.round(p / 10)} in 10` : p >= 45 ? 'about half' : `${Math.round(p / 10)} in 10`;
  const list = rows.slice(0, 5).map(r => `<li><b>${r.label}</b>${r.what ? ` <span class="muted">(${r.what})</span>` : ''}: usually <b>${r.m}%</b> of normal April–October rain${r.m < 100 ? `; ${oneIn(r.below)} come in below normal` : r.m > 105 ? '' : ', so it barely matters'}.${r.on ? ` <span class="tag dry">${y0}</span>` : ''}</li>`).join('');
  const tbl = table(['Years that were…', 'Typical', 'Below typical', 'Very dry*'], rows.map(r => ({ hl: r.on, cells: [`${r.label} <span class="tiny muted">(${r.n})</span>`, r.m + '%', r.below + '%', r.vdry + '%'] })),
    { note: `Refill season = April to October. * Very dry = under 75% of typical. In a "Neither" year that happens ${byLabel['Neither'].vdry}% of the time. Highlighted rows apply to ${y0}. El Niño since 1900, Indian Ocean since 1960.` });
  return card({
    q: 'Do El Niño and the Indian Ocean matter?',
    headline: 'They tilt the odds toward a dry April–October, but they don\'t decide it.',
    chart: `<ul class="insights">${list}</ul>`,
    explain: `${have ? `${y0} had both dry signals and still brought <b>${Math.round(v0 / med * 100)}%</b> of a normal refill season. ` : ''}In an ordinary year, about half come in below normal.`,
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
  const ymax = Math.ceil(Math.max(...D.monthly[y], ...medM) * 1.1 / 50) * 50, gw = (W - pl - pr) / 12, Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = yAxis(Y, niceTicks(ymax, 3), W, pl, pr);
  for (let m = 0; m < 12; m++) {
    const x = pl + m * gw + 3, w = gw - 6, v = D.monthly[y][m];
    if (m <= lastM) g += `<rect x="${x + 3}" y="${Y(v)}" width="${w - 6}" height="${Y(0) - Y(v)}" rx="2" fill="var(--water)" data-tip="<b>${MON[m]} ${y}</b>: ${mm(v)}<br>Typical: ${mm(medM[m])}<br>8 in 10 years: ${nf.format(p10[m])}–${nf.format(p90[m])} mm"/>`;
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
      <p class="explain">${isPartial ? '' : `${ordinal(rank)} wettest of ${full.length} years. `}${drivers.length ? `It was ${drivers.join(' and ')} year.`.replace(/^It was (E|I)/, 'It was an $1') : 'Neither El Niño nor La Niña.'}</p>
      <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly rain in ${y} against the typical range">${g}</svg></div>
      <div class="legend"><span><i style="background:var(--water)"></i>${y}</span><span><i class="line" style="background:var(--ink)"></i>Typical month</span></div>
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
// Seasonal use: irrigation runs through spring and summer, a little in autumn, and is off in winter.
// rate = the spring–summer L/day; winter uses the Settings figure; autumn sits halfway between.
const USE_W = [1, 1, 0.5, 0.5, 0.5, 0, 0, 0, 1, 1, 1, 1];
const winterUse = () => { const v = Number(T.data && T.data.settings && T.data.settings.winterDailyLitres); return v > 0 ? v : CONFIG.winterUse; };
function useByMonth(rate) { const w = Math.min(winterUse(), rate); return USE_W.map(k => w + k * (rate - w)); }
function seasonRate(recent, month) { // spring–summer rate implied by a rate measured in a given month
  const w = Math.min(winterUse(), recent), k = USE_W[month];
  return k ? Math.round((w + (recent - w) / k) / 10) * 10 : Math.max(Math.round(recent / 10) * 10, CONFIG.dailyUse);
}
const MCACHE = {};
function monthsFrom(startMs, days) { // month (0–11) of each day from a start date
  const key = Math.floor(startMs / DAY) + ':' + days;
  if (!MCACHE[key]) { const a = new Uint8Array(days); for (let i = 0; i < days; i++) a[i] = new Date(startMs + i * DAY).getMonth(); MCACHE[key] = a; }
  return MCACHE[key];
}
const todayMonths = days => monthsFrom(new Date(new Date().toDateString()).getTime(), days);
const WATER_YEAR_MONTHS = (() => { const a = new Uint8Array(365 * 3); for (let i = 0; i < a.length; i++) a[i] = new Date(Date.UTC(2024, 11, 1) + (i % 365) * DAY).getUTCMonth(); return a; })();
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
function simulate(rain, rate, start, days, months) {
  let b = start, min = b, minDay = 0, hit = null; const traj = new Float32Array(days), prof = useByMonth(rate);
  months = months || todayMonths(days);
  for (let i = 0; i < days; i++) {
    b = Math.min(CONFIG.capacity, b - prof[months[i]] + rain[i] * LPM);
    if (b < min) { min = b; minDay = i; }
    if (hit === null && b <= CONFIG.reserve) hit = i;
    traj[i] = Math.max(b, 0);
  }
  return { traj, min, minDay, hit };
}
function reliability(hs, rate, start, days) { return hs.filter(h => simulate(h.rain, rate, start, Math.min(days, h.rain.length)).hit === null).length / hs.length; }
function syncOutlookFromTanks() {
  if (!T.data) return;
  if (!outlook.touched) outlook.rate = seasonRate(T.data.totals.recentRate, new Date().getMonth());
  CONFIG.capacity = T.data.settings.capacityLitres; CONFIG.reserve = T.data.settings.reserveLitres;
}

function aheadCard(start) {
  return `<div class="card" id="t-ahead">
    <div class="q">What's ahead for the tanks?</div>
    <div id="ah-answer"></div>
    <div class="slider-row" style="margin:6px 0 4px"><label for="ah-rate">Spring–summer use</label><input id="ah-rate" type="range" min="250" max="1000" step="10" value="${outlook.rate}"><output id="ah-out"></output></div>
    <div class="chart-wrap" id="ah-chart"></div>
    <div class="legend"><span><i class="line" style="background:var(--water)"></i>Typical year</span><span><i style="background:var(--band)"></i>8 in 10 years</span><span><i style="background:rgba(194,65,12,.25)"></i>Pump can't reach</span></div>
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
  const safe = (() => { let lo = 200, hi = 1100; for (let i = 0; i < 9; i++) { const mid = (lo + hi) / 2; if (reliability(hs, mid, start, days) >= 0.95) lo = mid; else hi = mid; } return Math.floor(lo / 10) * 10; })();
  const head = c12 === 0 && c36 / n <= 0.05 ? 'No trouble in sight at this rate.' : c12 === 0 ? 'Fine for the next year; the risk builds after that.' : c12 / n <= 0.1 ? 'Mostly fine, with a small chance of running low within a year.' : 'A real chance of running low within a year at this rate.';
  $('#ah-answer').innerHTML = `<h3 class="answer">${head}</h3>
    <p class="explain">We replayed every year of rain since 1889 from today, using ${nf.format(rate)} L a day in spring and summer, ${nf.format(Math.min(winterUse(), rate))} in winter and halfway between in autumn. The tanks ran low ${c12 === 0 ? 'in none of them within a year' : `in ${c12} of ${n} within a year`}${c36 === 0 ? '' : `, and about 1 in ${Math.max(1, Math.round(n / c36))} within three years`}. Drag to try other amounts. <b>${safe} L a day</b> through spring and summer is safe in 19 of 20.</p>`;
  const W = 340, H = 190, pl = 34, pr = 8, pt = 8, pb = 22;
  const X = i => pl + i / (days - 1) * (W - pl - pr), Y = v => pt + (1 - v / CONFIG.capacity) * (H - pt - pb);
  const idx = []; for (let i = 0; i < days; i += 7) idx.push(i); idx.push(days - 1);
  const q = qq => idx.map(i => [X(i), Y(quantile(sims.map(s => s.traj[i]), qq))]);
  let g = yAxis(Y, [0, 40000, 80000, 120000], W, pl, pr, v => v / 1000 + 'k');
  g += `<rect x="${pl}" y="${Y(CONFIG.reserve)}" width="${W - pl - pr}" height="${Y(0) - Y(CONFIG.reserve)}" fill="rgba(194,65,12,.16)"/>`;
  g += `<path d="${area(q(0.9), q(0.1))}" fill="var(--band)"/>`;
  g += `<path d="${path(q(0.5))}" fill="none" stroke="var(--water)" stroke-width="3" stroke-linejoin="round"/>`;
  const med1 = idx.filter(i => i < 365).map(i => ({ i, v: quantile(sims.map(s => s.traj[i]), 0.5) })).sort((a, b) => a.v - b.v)[0];
  g += `<circle cx="${X(med1.i)}" cy="${Y(med1.v)}" r="4.5" fill="var(--water)" stroke="var(--card)" stroke-width="2"/><text x="${X(med1.i)}" y="${Y(med1.v) + 17}" text-anchor="middle" style="fill:var(--ink);font-weight:600;font-size:11px">typical low</text>`;
  g += `<circle cx="${X(0)}" cy="${Y(start)}" r="4.5" fill="var(--ink)" stroke="var(--card)" stroke-width="2"/><text x="${X(0) + 7}" y="${Y(start) - 7}" style="fill:var(--ink);font-weight:600;font-size:11px">today</text>`;
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
    ['Safe spring–summer use (19 in 20 runs)', safe + ' L/day'], ['Winter use assumed', nf.format(Math.min(winterUse(), rate)) + ' L/day']
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
  const ok = rate => runs.filter(seq => simulate(seq, rate, startTank, seq.length, WATER_YEAR_MONTHS).hit === null).length / runs.length;
  let lo = 200, hi = 1100;
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
  const vsRecent = (typ / recent20 - 1) * 100, chgAll = (typ / m.longMean - 1) * 100;

  // chart: decade bars against the long-run average, past then projected (same style as Patterns)
  const avg = m.longMean, items = [];
  for (let d = 1950; d < 2030; d += 10) {
    const ys = D.full.filter(y => y >= d && y < d + 10); if (!ys.length) continue;
    const v = mean(ys.map(y => D.annual[y]));
    items.push({ label: `${d}s`, v, showLabel: d % 20 === 10, tip: `<b>${d}s${ys.length < 10 ? ` (${ys.length} years so far)` : ''}</b><br>Actual: ${mm(v)} a year` });
  }
  for (let d = 2030; d <= m.Y1; d += 10) {
    const a2 = Math.max(m.Y0, d), b2 = Math.min(m.Y1, d + 9), ms = m.paths.map(p => pathMean(p, a2, b2));
    const v = median(ms), lo = quantile(ms, 0.1), hi = quantile(ms, 0.9), on = Y >= d && Y < d + 10;
    items.push({ label: `${d}s`, v, lo, hi, future: true, hl: on, showLabel: d % 20 === 10 || on, tip: `<b>${d}s</b><br>Typical: ${mm(v)} a year<br>Likely range: ${nf.format(lo)}–${nf.format(hi)} mm` });
  }
  items.forEach((o, i) => { if (o.hl) { if (items[i - 1]) items[i - 1].showLabel = false; if (items[i + 1]) items[i + 1].showLabel = false; } });
  const chartSvg = decadeChart({ items, avg, futureLabel: 'the genie\'s view' });

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
      <h3 class="answer">A typical year brings about ${nf.format(Math.round(typ / 10) * 10)} mm${G.scen === 'recent' ? '' : `, about ${Math.abs(Math.round(chgAll))}% ${chgAll < 0 ? 'less' : 'more'} than the long-run average`}.</h3>
      <p class="explain">That's ${scenWord}. ${G.scen === 'recent' ? 'No further drying, but no recovery either.' : `The last 20 years averaged ${mm(recent20)}, so that's ${Math.abs(vsRecent) < 3 ? 'about the same as now' : `${Math.abs(Math.round(vsRecent))}% ${vsRecent > 0 ? 'wetter' : 'drier'} than now`}. Spring dries the most (${pctTxt(projChange(G.scen, 'SON', Y, 0))}).`} A really dry year, once 1 in 10, becomes <b>${pDry >= 0.15 ? `about 1 in ${Math.max(2, Math.round(1 / pDry))}` : 'still about 1 in 10'}</b>.</p>
      <div class="chart-wrap">${chartSvg}</div>
      <div class="legend">${decadeLegend(avg, '<span>Lines: the likely range</span>')}</div>
      <details><summary>Season by season around ${Y}</summary>${table(['Season', 'Change', 'Models range'], seasonsAt.map(o => [cap(sName[o.s]), pctTxt(o.c), `${pctTxt(o.lo)} to ${pctTxt(o.hi)}`]), { note: 'Change in average rain compared with 1986–2005. Range = 10th to 90th percentile of 15 climate models.' })}</details>
    </div>
    <div class="card" id="g-tanks">
      <div class="q">Will our tanks still cope?</div>
      <h3 class="answer">Working it out…</h3>
    </div>
    <div class="card">
      <div class="q">How sure is the genie?</div>
      <h3 class="answer">Sure it's getting drier, less sure by how much.</h3>
      <p class="explain">Nearly every climate model dries southern Australia, especially in spring. How much depends on emissions and on the model, which is why each bar has a range.</p>
      <p class="explain">The last 20 years (${mm(recent20)}) have already been as dry as the models expect for the ${recentChg <= -12 ? '2060s' : recentChg <= -7 ? '2040s' : '2030s'}. Some of that is natural swing, so try "Like last 20 yrs" as a tougher test.</p>
      <p class="explain">It can't tell you whether next year will be wet. Luck still matters more than the trend for any one year.</p>
    </div>
    <p class="note">How it works: real Norton Summit years since 1950 are dealt at random into the future 400 times, rescaled to the 1986–2005 climate, then adjusted by the projected change for each season and year. Projections: Goyder Institute "SA Climate Ready" downscaled projections for the Adelaide and Mount Lofty Ranges region (15 CMIP5 climate models; moderate = RCP4.5, high = RCP8.5).</p>`;
  el.querySelectorAll('svg.chart').forEach(bindTips);
  el.querySelectorAll('[data-gy]').forEach(bt => bt.onclick = () => { G.year = +bt.dataset.gy; renderGenie(); });
  el.querySelectorAll('[data-gs]').forEach(bt => bt.onclick = () => { G.scen = bt.dataset.gs; renderGenie(); });
  const sl = $('#g-year'); sl.oninput = () => { sl.nextElementSibling.textContent = sl.value; }; sl.onchange = () => { G.year = +sl.value; renderGenie(); };
  // tanks by decade, computed after paint
  setTimeout(() => {
    const key = 'tanks-' + G.scen + (T.data ? '-live' : '') + '-w' + winterUse();
    if (!G.cache[key]) {
      const start = T.data ? Math.max(60000, T.data.now.tank) : 110000, decades = [D.endYear + 1, 2035, 2045, 2055, 2065, 2075].filter(y => y <= m.Y1);
      G.cache[key] = decades.map(y => ({ y, safe: safeUse(m, y, start) }));
    }
    const rows = G.cache[key], use = T.data ? seasonRate(T.data.totals.recentRate, new Date().getMonth()) : CONFIG.dailyUse;
    const nowSafe = rows[0].safe, atY = rows.slice(1).find(r => Y >= r.y - 5 && Y < r.y + 5) || rows.reduce((best, r) => Math.abs(r.y - Y) < Math.abs(best.y - Y) ? r : best, rows[0]);
    const drop = nowSafe - atY.safe;
    const decLabel = r => r.y === rows[0].y ? 'next few years' : `the ${r.y - 5}s`;
    $('#g-tanks').innerHTML = `
      <div class="q">Will our tanks still cope?</div>
      <h3 class="answer">${drop <= 25 ? 'Yes, with little change to how much you can use.' : `Yes, if daily use comes down by about ${Math.round(drop / 10) * 10} L by ${decLabel(atY)}.`}</h3>
      <div class="pair"><div><span>Safe now</span><b>${nowSafe}</b><span>L a day, spring–summer</span></div><div class="arrow">→</div><div><span>In ${decLabel(atY)}</span><b>${atY.safe}</b><span>L a day, spring–summer</span></div></div>
      <p class="explain">You're using about ${nf.format(use)} L a day in spring and summer, and about ${nf.format(winterUse())} in winter. ${drop <= 25 ? 'It barely moves because the tanks overflow most winters, so a drier climate mostly trims water that would have spilled anyway.' : 'More roof or another tank would push this back up.'}</p>
      <details><summary>Safe daily use by decade</summary>${table(['Decade', 'Safe L/day', 'Change'], rows.map((r, i) => ({ hl: r.y === atY.y, cells: [i ? `${r.y - 5}s` : 'Next few years', r.safe, i ? pctTxt((r.safe / nowSafe - 1) * 100) : '–'] })), { note: `Safe = the spring–summer daily use (winter ${nf.format(winterUse())} L, autumn halfway) that stays above what the pump can reach in 19 of 20 three-year runs, with your ${nf.format(CONFIG.capacity)} L tanks and ${CONFIG.roofM2} m² roof. Uses years since 1950 adjusted to each decade's climate, so it can differ a little from the Tanks tab.` })}</details>`;
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
  const rates = []; for (let r = 300; r <= 1000; r += 10) rates.push(r);
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
  const R = seasonRate(t.recentRate, new Date().getMonth()), o = tankOutlook(now.tank, R);
  const daysNoRain = (() => { const ms = todayMonths(1500), prof = useByMonth(R); let b = usable, i = 0; while (b > 0 && i < 1500) b -= prof[ms[i++]]; return i; })();
  const sinceRead = now.daysSinceReading;
  const verdict = o.low > 40000 ? 'Plenty to get through summer.' : o.low > 20000 ? 'Enough for summer, but it will get tight by autumn.' : 'Tight. Worth cutting back now.';
  const alerts = [];
  if (t.highUse) alerts.push(`Use since the last reading was <b>${nf.format(t.latestRate)} L/day</b>, well above your usual ${nf.format(t.prevRecentRate)}. Check for a leak or a tap left on.`);
  if (sinceRead > 8) alerts.push(`Last meter reading was ${Math.floor(sinceRead)} days ago, so today's figure is an estimate. A fresh reading sharpens everything.`);
  if (T.stale) alerts.push(`Offline: showing figures from ${new Date(T.at).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`);

  // rain lines
  const rainSince = d.rain.filter(r => r.date > d.lastReading.local.slice(0, 10));
  const lastRain = d.rain.filter(r => r.mm >= 1).slice(-1)[0];
  const fc = (d.forecast && d.forecast.days) || [], fcMm = sum(fc.map(f => f.mm || 0)), fcBig = fc.filter(f => (f.mm || 0) >= 2);
  const monthKey = now.local.slice(0, 7), monthMm = sum(d.rain.filter(r => r.date.slice(0, 7) === monthKey).map(r => r.mm));
  const rainHead = fcBig.length ? `About ${fmtMm(fcMm)} forecast this week, worth roughly ${nf.format(Math.round(fcMm * d.litresPerMm / 100) * 100)} L.` : `Little rain forecast this week.`;
  const rainExplain = `${lastRain ? `Last rain: ${dayLabel(lastRain.date)}, ${fmtMm(lastRain.mm)} (about ${nf.format(lastRain.litres)} L). ` : ''}${MON[+monthKey.slice(5) - 1]} so far: ${fmtMm(monthMm)}. Each 1 mm on the roof is about ${nf.format(d.litresPerMm)} L.`;

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
      <p class="explain">In a typical year the tanks bottom out around <b>${MON[o.lowMonth]}</b> at about ${nf.format(Math.round(o.low / 1000) * 1000)} L. With no rain at all, it would last about ${daysNoRain} days, with winter use dropping to about ${nf.format(winterUse())} L a day.</p>
      <p class="tiny muted">Last reading ${fmtWhen(d.lastReading.local)} · ${nf.format(d.lastReading.meter)} L on the meter${sinceRead > 0.5 ? ' · today is estimated' : ''}</p>
    </div>
    <button class="btn big-btn" id="t-log">+ Log a meter reading</button>
    ${aheadCard(now.tank)}
    ${card({
      q: 'Are we using too much?',
      headline: o.safe ? (R > o.safe + 15 ? `A little. Through spring and summer the rain reliably supports about ${o.safe} L a day.` : `No. You're within what the roof can reliably supply.`) : `Lately ${nf.format(t.recentRate)} L a day.`,
      chart: `<div class="stat3"><div><b>${nf.format(t.recentRate)}</b><span>L/day lately</span></div><div><b>${nf.format(winterUse())}</b><span>L/day in winter</span></div><div><b style="color:var(--good)">${o.safe || '–'}</b><span>L/day is safe in spring–summer</span></div></div>`,
      explain: `<span class="small">Irrigation makes spring and summer the thirsty months. Winter is about ${nf.format(winterUse())} L a day, autumn in between. "Safe" keeps the tanks above what the pump can reach in 19 of 20 runs of past weather. ${t.latestRate > t.prevRecentRate * 1.1 ? 'The latest period was higher than usual.' : 'Use has been steady.'} You can change the winter figure in the Settings tab of your sheet.</span>`,
      numbers: `${table(['Reading', 'Meter L', 'L/day', ''], d.readings.slice().reverse().map((r, i, arr) => {
        const ivv = d.intervals.find(x => x.to === r.local);
        return [`${fmtWhen(r.local)}<br><span class="tiny muted">${esc(r.by || '')}${r.note ? ' · ' + esc(r.note) : ''}</span>`, nf.format(r.meter), ivv ? nf.format(ivv.perDay) : '–', i === arr.length - 1 ? '' : `<button class="x" data-del-reading="${r.local}" aria-label="Delete reading">✕</button>`];
      }))}`,
      numbersLabel: `All ${d.readings.length} readings`
    })}
    ${card({
      q: 'Is rain topping them up?',
      headline: rainHead,
      chart: fcRow(d),
      explain: rainExplain + ` <span class="tiny">Rain is logged automatically each morning.</span>`,
      numbers: table(['Day', 'mm', 'Litres', 'Source'], d.rain.slice().reverse().slice(0, 40).map(r => [dayLabel(r.date), r.mm, nf.format(r.litres), `<span class="tiny muted">${esc(shortSrc(r.source))}</span><button class="x" data-del-rain="${r.date}" aria-label="Delete rain entry">✕</button>`])),
      numbersLabel: 'Rain log'
    })}
    <div class="card">
      <div class="q">Keep the numbers honest</div>
      <p class="explain">The tank level is worked out from the meter and the rain. If you measure the tanks or your rain gauge disagrees, enter it here and the numbers correct themselves.</p>
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

function fcRow(d) { // the week ahead as seven small tiles
  const days = ((d.forecast && d.forecast.days) || []).filter(f => f.date >= d.now.local.slice(0, 10)).slice(0, 7);
  if (!days.length) return '';
  return `<div class="fc-row">${days.map(f => { const v = f.mm || 0, dt = new Date(f.date + 'T00:00');
    return `<div class="${v >= 2 ? 'wet' : ''}">${dt.toLocaleDateString('en-AU', { weekday: 'short' })}<b>${v >= 0.5 ? Math.round(v) : '–'}</b>${v >= 0.5 ? 'mm' : '&nbsp;'}</div>`; }).join('')}</div>`;
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
