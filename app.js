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
let DRV = null; // data/drivers.json: event years plus what the climate drivers are doing now

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

// ================================================================= RAIN
// Three things only: how this year's four seasons compared with history, what the next four
// seasons look like, and the weather systems plus the real forecast for Norton Summit.
const SEAS = [
  { key: 'summer', name: 'Summer', sub: 'Dec–Feb', months: [12, 1, 2] },
  { key: 'autumn', name: 'Autumn', sub: 'Mar–May', months: [3, 4, 5] },
  { key: 'winter', name: 'Winter', sub: 'Jun–Aug', months: [6, 7, 8] },
  { key: 'spring', name: 'Spring', sub: 'Sep–Nov', months: [9, 10, 11] }
];
const MSTART = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]; // day-of-year each month starts (365-day year)
const SEAS_DAYS = s => s.months.reduce((t, m) => t + MSTART[m] - MSTART[m - 1], 0);
// A season "instance" is { s, Y }. Summer Y runs from Dec of Y-1 to Feb of Y.
function seasonDaily(s, Y) {
  const out = [];
  s.months.forEach(m => { const arr = D.byYear[s.key === 'summer' && m === 12 ? Y - 1 : Y]; for (let i = MSTART[m - 1]; i < MSTART[m]; i++) out.push(arr ? arr[i] : null); });
  return out;
}
function seasonMm(s, Y, k) { // total of the first k days (all days if k omitted); null if any are missing
  const a = seasonDaily(s, Y).slice(0, k == null ? undefined : k); let t = 0;
  for (const v of a) { if (v == null) return null; t += v; }
  return t;
}
const seasonOf = m => SEAS.find(s => s.months.includes(m));
const nextInst = i => { const n = SEAS.indexOf(i.s); return n === 3 ? { s: SEAS[0], Y: i.Y + 1 } : { s: SEAS[n + 1], Y: i.Y }; };
const prevInst = i => { const n = SEAS.indexOf(i.s); return n === 0 ? { s: SEAS[3], Y: i.Y - 1 } : { s: SEAS[n - 1], Y: i.Y }; };
const instName = i => i.s.key === 'summer' ? `Summer ${String(i.Y - 1).slice(2)}–${String(i.Y).slice(2)}` : `${i.s.name} ${i.Y}`;
const instSub = i => i.s.key === 'summer' ? `Dec ${i.Y - 1} – Feb ${i.Y}` : i.s.sub;
const allLabels = () => { const out = []; for (let Y = 1890; Y <= D.endYear + 1; Y++) out.push(Y); return out; };

// The season we're in now (or the last one, if the current one has barely started) and the three before it.
function lastFourSeasons() {
  const m = D.endDate.getUTCMonth() + 1, s = seasonOf(m);
  let cur = { s, Y: s.key === 'summer' && m === 12 ? D.endYear + 1 : D.endYear };
  const have = i => seasonDaily(i.s, i.Y).findIndex(v => v == null);
  let k = have(cur); if (k < 0) k = SEAS_DAYS(cur.s);
  if (k < 45) { cur = prevInst(cur); k = SEAS_DAYS(cur.s); }
  const out = [Object.assign(cur, { k, partial: k < SEAS_DAYS(cur.s) })];
  for (let j = 0; j < 3; j++) { const p = prevInst(out[0]); out.unshift(Object.assign(p, { k: SEAS_DAYS(p.s), partial: false })); }
  return out;
}

function seasonStats(inst) {
  const v = seasonMm(inst.s, inst.Y, inst.k);
  const hist = allLabels().filter(Y => Y !== inst.Y).map(Y => ({ Y, v: seasonMm(inst.s, Y, inst.k) })).filter(o => o.v != null);
  const vals = hist.map(o => o.v), normal = median(vals), p = pctBelow(vals, v);
  // context: "driest since 2019", "wettest in 12 years", or on record
  let context = 'close to normal';
  const earlier = hist.filter(o => o.Y < inst.Y).sort((a, b) => b.Y - a.Y);
  if (p <= 33 || p >= 67) {
    const dry = p <= 33, beat = earlier.find(o => dry ? o.v <= v : o.v >= v);
    const w = dry ? 'driest' : 'wettest';
    if (!beat) context = `${w} on record`;
    else if (inst.Y - beat.Y >= 4) context = `${w} since ${beat.Y}`;
    else context = dry ? 'drier than most' : 'wetter than most';
  }
  return { v, normal, p, pctOfNormal: Math.round(v / normal * 100), context, n: vals.length + 1 };
}
const seasonWord = p => p >= 90 ? 'Very wet' : p >= 67 ? 'Wet' : p <= 10 ? 'Very dry' : p <= 33 ? 'Dry' : 'Normal';
const seasonTone = p => p >= 90 ? 'wet2' : p >= 67 ? 'wet' : p <= 10 ? 'dry2' : p <= 33 ? 'dry' : '';
const posBar = p => `<div class="posbar" aria-hidden="true"><i style="left:${Math.max(3, Math.min(97, p))}%"></i></div><div class="posends"><span>driest</span><span>wettest</span></div>`;

function seasonsCard() {
  const four = lastFourSeasons().map(i => Object.assign(i, seasonStats(i)));
  const dry = four.filter(o => o.p <= 33).length, wet = four.filter(o => o.p >= 67).length;
  const last = four[3];
  let head = dry >= 3 ? `${['', '', '', 'Three', 'All four'][dry]} of the last four seasons were drier than normal.`
    : wet >= 3 ? `${['', '', '', 'Three', 'All four'][wet]} of the last four seasons were wetter than normal.`
    : dry && wet ? 'A mixed year: some seasons wet, some dry.'
    : dry ? `Mostly normal, with ${dry === 1 ? 'one dry season' : 'two dry seasons'}.` : wet ? `Mostly normal, with ${wet === 1 ? 'one wet season' : 'two wet seasons'}.` : 'A pretty normal year for rain.';
  const tiles = four.map(o => `<div class="sq ${seasonTone(o.p)}" data-tip="<b>${instName(o)}${o.partial ? ' so far' : ''}</b><br>${mm(o.v)}, normal ${mm(o.normal)}<br>Wetter than ${o.p}% of ${o.n} years since 1890">
      <div class="sq-top"><b>${o.s.name}</b><span>${o.s.key === 'summer' ? `${String(o.Y - 1).slice(2)}–${String(o.Y).slice(2)}` : o.Y}${o.partial ? ' · so far' : ''}</span></div>
      <div class="sq-num">${nf.format(o.v)}<small> mm</small></div>
      <div class="sq-word">${seasonWord(o.p)} <span>${o.pctOfNormal}% of normal</span></div>
      ${posBar(o.p)}
      <div class="sq-foot">${cap(o.context)}</div>
    </div>`).join('');
  const rows = four.map(o => [instName(o) + (o.partial ? ' (so far)' : ''), nf.format(o.v), nf.format(o.normal), o.pctOfNormal + '%', o.p + '%']);
  return card({
    q: 'How did this year’s seasons go?', headline: head,
    chart: `<div class="sq-grid">${tiles}</div>`,
    explain: `Each square compares the season with every year since 1890. The dot shows where it sits, from the driest year on the left to the wettest on the right.${last.partial ? ` ${last.s.name} is compared day for day up to ${doyToDate(D.endDoy, D.endYear)}.` : ''}`,
    numbers: table(['Season', 'mm', 'Normal', '% normal', 'Wetter than'], rows, { note: 'Normal = the middle value since 1890. "Wetter than" = the share of past years this season beat.' }),
    numbersLabel: 'See the numbers'
  });
}

// ---------------- the next four seasons: recent climate, nudged by what followed similar years here
function projections() {
  const now = (DRV && DRV.now) || {};
  const set = now.enso === 'El Niño' ? D.EN : now.enso === 'La Niña' ? D.LN : null;
  const eventYear = now.ensoYear || D.endYear;
  const four = lastFourSeasons(); let i = four[3];
  const out = [];
  for (let j = 0; j < 4; j++) {
    i = nextInst(i);
    const s = i.s, Y = i.Y, lag = Y - eventYear;
    const full = allLabels().map(y => ({ y, v: seasonMm(s, y) })).filter(o => o.v != null);
    const medAll = median(full.map(o => o.v));
    const recent = full.filter(o => o.y >= D.endYear - 35).map(o => o.v);
    const rMed = median(recent), rLo = quantile(recent, 0.25), rHi = quantile(recent, 0.75);
    let ratio = 1, chance = 50, an = [];
    if (set) {
      an = [...set].filter(e => e >= 1900 && e !== eventYear).map(e => ({ e, Y: e + lag, v: seasonMm(s, e + lag) })).filter(o => o.v != null);
      const w = an.length / (an.length + 15); // small samples count for less
      ratio = 1 + (median(an.map(o => o.v / medAll)) - 1) * w;
      chance = 50 + (an.filter(o => o.v > medAll).length / an.length * 100 - 50) * w;
    } else {
      const neither = full.filter(o => !D.EN.has(o.y - 1) && !D.LN.has(o.y - 1));
      chance = Math.round(neither.filter(o => o.v > medAll).length / neither.length * 100);
    }
    const bom = now.outlook && now.outlook.season === s.key && now.outlook.year === Y ? now.outlook : null;
    if (bom) chance = (chance + bom.chanceAbove) / 2; // the Bureau's model gets an equal say for the season it covers
    out.push({ i, expect: rMed * ratio, lo: rLo * ratio, hi: rHi * ratio, chance: Math.round(chance), an, medAll, rMed, bom, ratio });
  }
  return out;
}
function outlookCard() {
  const P = projections(), now = (DRV && DRV.now) || {};
  const lean = c => c >= 58 ? ['Leaning wet', 'wet'] : c <= 42 ? ['Leaning dry', 'dry'] : ['Even odds', ''];
  const tiles = P.map(o => { const [w, tone] = lean(o.chance); return `<div class="sq ${tone}">
      <div class="sq-top"><b>${o.i.s.name}</b><span>${o.i.s.key === 'summer' ? `${String(o.i.Y - 1).slice(2)}–${String(o.i.Y).slice(2)}` : o.i.Y}</span></div>
      <div class="sq-num"><span class="tiny muted">about</span> ${nf.format(Math.round(o.expect / 5) * 5)}<small> mm</small></div>
      <div class="sq-word">${w}</div>
      <div class="sq-foot">Likely ${nf.format(Math.round(o.lo / 5) * 5)}–${nf.format(Math.round(o.hi / 5) * 5)} mm<br>${Math.round(o.chance / 10)} in 10 chance of a wetter than normal ${o.i.s.name.toLowerCase()}${o.bom ? '<br><span class="bom">Bureau model: ' + esc(o.bom.text) + '</span>' : ''}</div>
    </div>`; }).join('');
  const wetter = P.filter(o => o.chance >= 58).map(o => o.i.s.name.toLowerCase()), drier = P.filter(o => o.chance <= 42).map(o => o.i.s.name.toLowerCase());
  const join = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0];
  const head = !wetter.length && !drier.length ? 'No strong lean either way for the year ahead.'
    : `${wetter.length ? `${cap(join(wetter))} ${wetter.length > 1 ? 'lean' : 'leans'} wet` : ''}${wetter.length && drier.length ? '; ' : ''}${drier.length ? `${wetter.length ? join(drier) : cap(join(drier))} ${drier.length > 1 ? 'lean' : 'leans'} dry` : ''}. ${P.filter(o => o.chance > 42 && o.chance < 58).length ? 'The rest could go either way.' : ''}`;
  const nAn = P[0].an.length;
  const rows = P.map(o => [instName(o.i), nf.format(o.rMed), (o.ratio >= 1 ? '+' : '−') + Math.abs(Math.round((o.ratio - 1) * 100)) + '%', nf.format(o.expect), o.chance + '%']);
  const anList = P[2] && P[2].an.length ? P[2].an.slice().sort((a, b) => b.e - a.e).slice(0, 8).map(o => `${o.Y} ${Math.round(o.v / P[2].medAll * 100)}%`).join(', ') : '';
  return card({
    q: 'What about the next four seasons?', headline: head,
    chart: `<div class="sq-grid">${tiles}</div>`,
    explain: now.enso ? `We start from the rain of the last 35 years (the climate we have now), then nudge it by what happened here after the ${nAn} other ${now.enso} years since 1900. Seasonal forecasts are about odds, not promises: a wet-leaning season can still come in dry.` : 'Based on the rain of the last 35 years. With no El Niño or La Niña, the odds sit close to even.',
    numbers: table(['Season', 'Recent normal', 'Nudge', 'Projection', 'Chance wetter'], rows,
      { note: `Recent normal = middle value since ${D.endYear - 35}. Nudge = the typical effect in the year after ${now.enso || 'similar'} years, scaled down because there are only ${nAn} of them.${anList ? ` Winter after recent ${now.enso} years: ${anList} of normal.` : ''}${P[0].bom ? ` For ${P[0].i.s.name.toLowerCase()}, the Bureau's ACCESS-S model gets an equal say (issued ${fmtDate(P[0].bom.issued)}).` : ''}` }),
    numbersLabel: 'How the projection works'
  });
}
const fmtDate = s => { const d = new Date(s + 'T00:00'); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); };

// ---------------- the real forecast (Open-Meteo, fetched straight from the phone)
const FC = { data: null, at: 0, err: null };
const FC_URL = 'https://api.open-meteo.com/v1/forecast?latitude=-34.9227&longitude=138.725&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max&timezone=Australia%2FAdelaide&forecast_days=14';
async function loadForecast() {
  if (FC.data && Date.now() - FC.at < 30 * 60000) return;
  try {
    const j = await fetch(FC_URL).then(r => r.json());
    FC.data = j.daily.time.map((t, i) => ({ date: t, mm: j.daily.precipitation_sum[i] || 0, chance: j.daily.precipitation_probability_max[i], max: j.daily.temperature_2m_max[i] }));
    FC.at = Date.now(); FC.err = null;
    try { localStorage.setItem('tal-fc', JSON.stringify({ at: FC.at, data: FC.data })); } catch (e) {}
  } catch (e) {
    FC.err = e.message;
    try { const c = JSON.parse(localStorage.getItem('tal-fc')); if (c) { FC.data = c.data; FC.at = c.at; } } catch (e2) {}
  }
}
function forecastCard() {
  if (!FC.data) return `<div class="card" id="fc-card"><div class="q">Rain forecast for Norton Summit</div><p class="explain">${FC.err ? 'Can’t reach the forecast right now.' : 'Loading the forecast…'}</p></div>`;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Adelaide' });
  const days = FC.data.filter(f => f.date >= today);
  const wk = days.slice(0, 7), wk2 = days.slice(7, 14);
  const t1 = sum(wk.map(f => f.mm)), t2 = sum(wk2.map(f => f.mm));
  const wetDays = wk.filter(f => f.mm >= 1);
  const dname = f => new Date(f.date + 'T00:00').toLocaleDateString('en-AU', { weekday: 'long' });
  const head = t1 < 1 ? 'A dry week ahead.' : wetDays.length === 1 ? `About ${Math.round(t1)} mm this week, nearly all on ${dname(wetDays[0])}.`
    : `About ${Math.round(t1)} mm this week, spread over ${wetDays.length} days.`;
  const tiles = `<div class="fc-row">${wk.map(f => { const dt = new Date(f.date + 'T00:00');
    return `<div class="${f.mm >= 2 ? 'wet' : ''}">${dt.toLocaleDateString('en-AU', { weekday: 'short' })}<b>${f.mm >= 0.5 ? Math.round(f.mm) : '–'}</b>${f.mm >= 0.5 ? 'mm' : '&nbsp;'}<span class="fc-c">${f.chance != null ? f.chance + '%' : ''}</span><span class="fc-t">${Math.round(f.max)}°</span></div>`; }).join('')}</div>`;
  const dec = (D.raw && D.monthly) ? median(D.full.map(y => D.monthly[y][new Date().getMonth()])) : null;
  const age = Math.round((Date.now() - FC.at) / 60000);
  return `<div class="card" id="fc-card">
    <div class="q">Rain forecast for Norton Summit</div>
    <h3 class="answer">${head}</h3>
    ${tiles}
    <p class="explain">Rain in mm, chance of any rain, and the top temperature. The week after looks ${t2 < 1 ? 'dry' : `like about ${Math.round(t2)} mm`}.${dec ? ` A normal ${MON[new Date().getMonth()]} brings ${mm(dec)} in total.` : ''}</p>
    <p class="tiny muted" style="margin:6px 2px 0">Open-Meteo, which blends the Bureau's ACCESS-G with the European and US models. ${FC.err ? `Offline: from ${age < 90 ? age + ' min' : Math.round(age / 60) + ' h'} ago.` : ''}</p>
  </div>`;
}

// ---------------- the big weather systems, in plain words
function driversNowCard() {
  const now = (DRV && DRV.now);
  if (!now) return '';
  // our own numbers: what followed El Niño / positive IOD years here
  const after = (set, s, lag) => { const full = allLabels().map(y => seasonMm(s, y)).filter(v => v != null), m = median(full);
    const v = [...set].filter(e => e >= 1900).map(e => seasonMm(s, e + lag)).filter(x => x != null); return { pct: Math.round(median(v.map(x => x / m * 100))), n: v.length }; };
  const spring = SEAS[3], winter = SEAS[2], summer = SEAS[0];
  const enSpring = after(D.EN, spring, 0), enSummer = after(D.EN, summer, 1), enWinterAfter = after(D.EN, winter, 1);
  const list = (now.items || []).map(it => {
    let ours = '';
    if (it.key === 'enso') ours = `Here, El Niño springs have brought a median ${enSpring.pct}% of normal rain, the following summers ${enSummer.pct}%, and the winter after ${enWinterAfter.pct}%.`;
    if (it.key === 'iod') { const s = after(D.IP, spring, 0); ours = `Here, positive-IOD springs have brought a median ${s.pct}% of normal rain.`; }
    if (it.key === 'thisyear') { const sp = seasonStats(lastFourSeasons()[3]); ours = `This ${lastFourSeasons()[3].s.name.toLowerCase()}: ${sp.pctOfNormal}% of normal so far.`; }
    return `<li><b>${esc(it.name)}</b> <span class="tag ${it.tone || ''}">${esc(it.status)}</span><br>${esc(it.what)}${ours ? ` <span class="muted">${ours}</span>` : ''}</li>`;
  }).join('');
  return card({
    q: 'What are the big weather systems doing?', headline: esc(now.headline),
    chart: `<ul class="insights">${list}</ul>`,
    explain: `<span class="tiny muted">From the Bureau of Meteorology's climate driver update and long-range forecast, ${fmtDate(now.asOf)}. Our numbers are from the Norton Summit rain record since 1900.</span>`
  });
}

function renderRain() {
  const el = $('#view-rain');
  el.innerHTML = `<div class="view-head"><h1>Rain</h1><span class="sub">Norton Summit since 1889</span></div>
    ${seasonsCard()}${outlookCard()}${forecastCard()}${driversNowCard()}
    <p class="note">Rain for the Norton Summit area: the average of two 5 km SILO grid cells, 1889 to ${doyToDate(D.endDoy, D.endYear)} ${D.endYear}, counted on the 9 am rain day.</p>`;
  el.querySelectorAll('.sq[data-tip]').forEach(t => t.onclick = e => showTip(t.dataset.tip, e.clientX, e.clientY));
  if (!FC.data || Date.now() - FC.at > 30 * 60000) loadForecast().then(() => { const c = $('#fc-card'); if (c) c.outerHTML = forecastCard(); });
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
  if (!T.data || T.data.empty || !T.data.totals) return;
  if (!outlook.touched) outlook.rate = seasonRate(T.data.totals.recentRate, new Date().getMonth());
  const TMs = T.data.tanks && T.data.tanks.length ? tankModel(T.data) : null;
  CONFIG.capacity = TMs && TMs.sysCap ? TMs.sysCap : T.data.settings.capacityLitres; CONFIG.reserve = T.data.settings.reserveLitres || 0;
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

// ================================================================= MY TANKS: an estimate for every tank
// Each tank is tracked on its own: rain from its roof, overflow from the tank it sits below, metered use from the
// meter tank, any daily use set for unmetered tanks, water moved between tanks, and the owner's own estimates.
const overflowSrc = t => { const m = /^overflow from (.+)$/i.exec(String(t.fedFrom || '').trim()); return m ? m[1].trim() : null; };
const isRoofFed = t => /^roof/i.test(String(t.fedFrom || '').trim());
function tankList(d) {
  if (d.tanks && d.tanks.length) return d.tanks.map(t => Object.assign({}, t, { capacity: Number(t.capacity) || 0 }));
  if (d.empty) return [];
  return [{ name: 'Main tanks', capacity: d.settings.capacityLitres, fedFrom: 'Roof', roofM2: d.settings.roofAreaM2, meter: true }];
}
function tankModel(d) {
  const tanks = tankList(d), byName = {}; tanks.forEach(t => byName[t.name] = t);
  const eff = Number(d.settings.captureEfficiency) || 0.85, meterT = tanks.find(t => t.meter) || null;
  const sys = new Set(meterT ? [meterT.name] : []); // the supply system: the meter tank and every tank joined to it
  for (let grew = true; grew;) {
    grew = false;
    tanks.forEach(t => {
      if (sys.has(t.name)) return;
      const o = overflowSrc(t), joined = (o && sys.has(o)) || (t.topUpFrom && sys.has(t.topUpFrom)) || tanks.some(u => sys.has(u.name) && (u.topUpFrom === t.name || overflowSrc(u) === t.name));
      if (joined) { sys.add(t.name); grew = true; }
    });
  }
  const lpm = t => (Number(t.roofM2) || 0) * eff || (t.meter && isRoofFed(t) ? d.litresPerMm || 0 : 0);
  const lvl = {}; tanks.forEach(t => lvl[t.name] = null);
  const nowDay = dayNum(d.now.local), baseDay = d.empty ? null : d.settings.baselineDate ? dayNum(d.settings.baselineDate) : d.readings && d.readings[0] ? d.readings[0].day : null;
  const ev = [];
  if (baseDay != null) ev.push({ day: baseDay, k: 'start' });
  (d.rain || []).forEach(r => ev.push({ day: dayNum(r.date) + 1, k: 'rain', mm: Number(r.mm) || 0 }));
  (d.transfers || []).forEach(x => ev.push({ day: dayNum(x.local), k: 'move', x }));
  (d.tankChecks || []).forEach(c => ev.push({ day: dayNum(c.local), k: 'set', c }));
  (d.checks || []).forEach(c => ev.push({ day: c.day, k: 'setAll', c }));
  ev.push({ day: nowDay, k: 'now' });
  const order = { start: 0, set: 1, setAll: 1, move: 2, rain: 3, now: 4 };
  ev.sort((a, b) => a.day - b.day || order[a.k] - order[b.k]);
  const iv = d.intervals || [], lastDay = d.lastReading ? d.lastReading.day : null, recent = d.totals ? d.totals.recentRate || 0 : 0;
  const metered = (a, b) => { // litres through the meter between two moments
    let L = 0;
    iv.forEach(x => { const lo = Math.max(a, x.fromDay), hi = Math.min(b, x.toDay); if (hi > lo && x.perDay) L += (hi - lo) * x.perDay; });
    if (lastDay != null && b > lastDay) L += (b - Math.max(a, lastDay)) * recent;
    return L;
  };
  let spilled = 0;
  const pour = (name, L) => { // add water; what doesn't fit runs on to the tank its overflow feeds
    for (let n = name, g = 0; n && L > 0 && g < 12; g++) {
      if (lvl[n] == null) return;
      const put = Math.min(byName[n].capacity - lvl[n], L); lvl[n] += put; L -= put;
      const next = tanks.find(o => overflowSrc(o) === n); n = next ? next.name : null;
    }
    spilled += Math.max(0, L);
  };
  let prev = null;
  ev.forEach(e => {
    if (prev != null && e.day > prev) {
      if (meterT && lvl[meterT.name] != null) lvl[meterT.name] = Math.max(0, lvl[meterT.name] - metered(prev, e.day));
      tanks.forEach(t => { if (!t.meter && Number(t.usePerDay) > 0 && lvl[t.name] != null) lvl[t.name] = Math.max(0, lvl[t.name] - t.usePerDay * (e.day - prev)); });
    }
    if (e.k === 'start') tanks.forEach(t => { if (sys.has(t.name)) lvl[t.name] = t.capacity; });
    else if (e.k === 'rain') tanks.forEach(t => { if (isRoofFed(t)) pour(t.name, e.mm * lpm(t)); });
    else if (e.k === 'move') { const x = e.x, L = Math.min(Number(x.litres) || 0, lvl[x.from] != null ? lvl[x.from] : Infinity); if (lvl[x.from] != null) lvl[x.from] -= L; if (lvl[x.to] != null) pour(x.to, L); }
    else if (e.k === 'set' && byName[e.c.tank]) lvl[e.c.tank] = Math.max(0, Math.min(byName[e.c.tank].capacity, e.c.litres));
    else if (e.k === 'setAll') { let L = e.c.litres; [...sys].sort((a, b) => (byName[b].meter ? 1 : 0) - (byName[a].meter ? 1 : 0)).forEach(n => { const put = Math.min(byName[n].capacity, L); lvl[n] = put; L -= put; }); }
    prev = prev == null ? e.day : Math.max(prev, e.day);
  });
  const lastSet = {}; (d.tankChecks || []).forEach(c => lastSet[c.tank] = c);
  const out = tanks.map(t => Object.assign(t, { level: lvl[t.name] == null ? null : Math.round(lvl[t.name]), inSystem: sys.has(t.name), lpm: lpm(t), lastSet: lastSet[t.name] || null }));
  const sysT = out.filter(t => t.inSystem), sysKnown = sysT.length > 0 && sysT.every(t => t.level != null);
  return { tanks: out, byName, meterT, sysT, sysKnown, sysTotal: sum(sysT.map(t => t.level || 0)), sysCap: sum(sysT.map(t => t.capacity)), knownTotal: sum(out.filter(t => t.level != null).map(t => t.level)), capTotal: sum(out.map(t => t.capacity)) };
}
function flowText(tanks) {
  const bits = [];
  tanks.forEach(t => { if (isRoofFed(t)) bits.push(`Rain fills <b>${esc(t.name)}</b>${!t.lpm ? ' <span class="warn-txt">(add its roof area)</span>' : ''}`); });
  tanks.forEach(t => { const o = overflowSrc(t); if (o) bits.push(`${esc(o)} overflows into <b>${esc(t.name)}</b>`); });
  tanks.forEach(t => { if (t.topUpFrom) bits.push(`<b>${esc(t.topUpFrom)}</b> tops up ${esc(t.name)}${t.lowMark ? ` when it's below ${nf.format(t.lowMark / 1000)}k` : ''}`); });
  return bits.join(' · ');
}
function miniTank(t, i) {
  const W = 64, H = 78, x = 6, y = 8, w = 52, h = 64, known = t.level != null, f = known ? Math.max(0, Math.min(1, t.level / t.capacity)) : 0, wy = y + h * (1 - f);
  const lm = t.lowMark ? y + h * (1 - Math.min(1, t.lowMark / t.capacity)) : null;
  return `<svg viewBox="0 0 ${W} ${H}" class="mtank" aria-hidden="true"><defs><clipPath id="mt${i}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/></clipPath></defs>
    <g clip-path="url(#mt${i})"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--grid)"/>${known ? `<path d="M${x} ${wy} q ${w / 4} -3 ${w / 2} 0 t ${w / 2} 0 V ${y + h} H ${x} Z" fill="${t.low ? 'var(--warm)' : 'var(--water)'}"/>` : ''}</g>
    ${lm ? `<line x1="${x}" x2="${x + w}" y1="${lm}" y2="${lm}" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="3 2"/>` : ''}
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="none" stroke="var(--ink-3)" stroke-width="1.5"/><rect x="${x + w / 2 - 9}" y="${y - 6}" width="18" height="6" rx="2" fill="var(--ink-3)"/>
    <text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" style="font-size:14px;font-weight:700;fill:${known && f > 0.45 ? '#fff' : 'var(--ink)'}">${known ? Math.round(f * 100) + '%' : '?'}</text></svg>`;
}
function myTanksCard(TM, d, useToday) {
  const tiles = TM.tanks.map((t, i) => {
    const known = t.level != null;
    let tag = '', sub = known ? `${nf.format(Math.round(t.level / 100) * 100)} of ${nf.format(t.capacity)} L` : `${nf.format(t.capacity)} L · tap to set`;
    if (known && t.low) tag = `<span class="tag dry">Top up${t.topUpFrom ? ' from ' + esc(t.topUpFrom) : ''}</span>`;
    else if (known && t.daysToLow != null && t.daysToLow < 60) tag = `<span class="tag">Top up in ~${Math.max(1, Math.round(t.daysToLow))} days</span>`;
    else if (t.meter) tag = '<span class="tag">Water meter</span>';
    return `<button class="tk-tile" data-tank="${esc(t.name)}">${miniTank(t, i)}<span class="tk-txt"><b>${esc(t.name)}</b><span>${sub}</span>${tag}</span></button>`;
  }).join('');
  return `<div class="tk-grid">${tiles}<button class="tk-tile add" id="tk-add"><span class="plus">+</span><span class="tk-txt"><b>Add a tank</b><span>Size and how full</span></span></button></div>
    ${TM.tanks.length ? `<p class="tiny muted" style="margin:8px 2px 0">${flowText(TM.tanks)}${flowText(TM.tanks) ? '. ' : ''}Tap a tank to change its size or say how full it is.</p>` : ''}`;
}
function annotateTanks(TM, R) {
  const m = new Date().getMonth(), use = R ? useByMonth(R)[m] : 0;
  TM.tanks.forEach(t => {
    t.low = t.level != null && t.lowMark != null && t.lowMark > 0 && t.level <= t.lowMark;
    const draw = t.meter ? use : Number(t.usePerDay) || 0;
    t.daysToLow = t.level != null && t.lowMark && draw > 0 && !t.low ? (t.level - t.lowMark) / draw : null;
  });
}

// ---------------- the tank editor: size and how full first; plumbing tucked away
function openTankSheet(name) {
  const d = T.data, TM = tankModel(d), all = tankList(d), t = name ? TM.byName[name] : { name: '', capacity: '', fedFrom: '', level: null };
  const others = all.filter(o => o.name !== name).map(o => o.name);
  const fedOpts = [['', 'Filled by hand / not set'], ['Roof', 'A roof']].concat(others.map(n => [`Overflow from ${n}`, `Overflow from ${n}`]));
  const startPct = t.level != null && t.capacity ? Math.round(t.level / t.capacity * 20) * 5 : 50;
  const wrap = document.createElement('div'); wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="scrim"></div><div class="sheet">
    <h3>${name ? esc(name) : 'Add a tank'}</h3>
    ${name ? '' : `<label class="fl">Name</label><input id="k-name" class="inp" placeholder="e.g. Shed tanks">`}
    <label class="fl">Size (litres)</label><input id="k-cap" class="inp" inputmode="numeric" value="${t.capacity || ''}" placeholder="e.g. 20000">
    <label class="fl">How full is it? <span class="muted">${t.level != null ? `(our estimate: ${Math.round(t.level / t.capacity * 100)}%)` : '(not set yet)'}</span></label>
    <div class="fill-row"><input id="k-pct" type="range" min="0" max="100" step="5" value="${startPct}"><output id="k-out"></output></div>
    <label class="chk"><input type="checkbox" id="k-setlevel" ${name && t.level != null ? '' : 'checked'}> Save this as the tank's level now</label>
    <details class="more"><summary>Where its water comes from</summary>
      <label class="fl">Fed from</label><select id="k-fed" class="inp">${fedOpts.map(([v, l]) => `<option value="${esc(v)}" ${String(t.fedFrom || '').toLowerCase() === v.toLowerCase() ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <div id="k-roofrow"><label class="fl">Roof area feeding it (m²)</label><input id="k-roof" class="inp" inputmode="numeric" value="${t.roofM2 || ''}"></div>
      <div class="row2"><div><label class="fl">Top up from</label><select id="k-from" class="inp"><option value="">Nothing</option>${others.map(n => `<option ${t.topUpFrom === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div><label class="fl">…when below (L)</label><input id="k-low" class="inp" inputmode="numeric" value="${t.lowMark || ''}"></div></div>
      <label class="chk"><input type="checkbox" id="k-meter" ${t.meter ? 'checked' : ''}> The water meter is on this tank</label>
      <div id="k-userow"><label class="fl">Daily use from this tank, if it has no meter (L)</label><input id="k-use" class="inp" inputmode="numeric" value="${t.usePerDay || ''}" placeholder="0"></div>
      ${name ? `<button class="ghost danger" id="k-del" style="margin-top:12px">Remove this tank</button>` : ''}
    </details>
    <div class="row2" style="margin-top:14px"><button class="ghost" data-close>Cancel</button><button class="btn" id="k-save">Save</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('open'));
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 250); };
  wrap.querySelector('.scrim').onclick = close; wrap.querySelector('[data-close]').onclick = close;
  const $w = s => wrap.querySelector(s), num = s => { const v = String($w(s).value).replace(/[,\s]/g, ''); return v === '' ? null : Number(v); };
  const showOut = () => { const cap = num('#k-cap') || 0, p = +$w('#k-pct').value; $w('#k-out').textContent = `${p}%${cap ? ' · ' + nf.format(Math.round(cap * p / 100)) + ' L' : ''}`; };
  const showRows = () => { $w('#k-roofrow').hidden = $w('#k-fed').value !== 'Roof'; $w('#k-userow').hidden = $w('#k-meter').checked; };
  $w('#k-pct').oninput = () => { $w('#k-setlevel').checked = true; showOut(); }; $w('#k-cap').oninput = showOut;
  $w('#k-fed').onchange = showRows; $w('#k-meter').onchange = showRows; showOut(); showRows();
  const persist = async (list, check) => {
    const save = $w('#k-save'); save.disabled = true; save.textContent = 'Saving…';
    try {
      await api('saveTanks', { tanks: list });
      if (check) await api('addTankCheck', check);
      close(); renderTanks(); toast('Saved.');
    } catch (e) { toast(e.message === 'Failed to fetch' ? 'No connection. Try again when you have signal.' : e.message); save.disabled = false; save.textContent = 'Save'; }
  };
  if ($w('#k-del')) $w('#k-del').onclick = () => { if (window.confirm(`Remove ${name}? Its past estimates stay in your sheet.`)) persist(all.filter(o => o.name !== name), null); };
  $w('#k-save').onclick = () => {
    const nm = name || String($w('#k-name').value).trim(), cap = num('#k-cap');
    if (!nm) return toast('Give the tank a name.');
    if (!name && all.some(o => o.name.toLowerCase() === nm.toLowerCase())) return toast('You already have a tank with that name.');
    if (!(cap > 0)) return toast('Enter the tank size in litres.');
    const meter = $w('#k-meter').checked;
    const me = { name: nm, capacity: cap, fedFrom: $w('#k-fed').value, roofM2: $w('#k-fed').value === 'Roof' ? num('#k-roof') : null, lowMark: num('#k-low'), topUpFrom: $w('#k-from').value, usePerDay: meter ? null : num('#k-use'), meter, note: (all.find(o => o.name === name) || {}).note || '' };
    const strip = o => ({ name: o.name, capacity: o.capacity, fedFrom: o.fedFrom || '', roofM2: o.roofM2, lowMark: o.lowMark, topUpFrom: o.topUpFrom || '', usePerDay: o.usePerDay, meter: meter ? false : !!o.meter, note: o.note || '' });
    const list = name ? all.map(o => o.name === name ? me : strip(o)) : all.map(strip).concat([me]);
    if (meter) list.forEach(o => { if (o.name !== nm) o.meter = false; });
    const check = $w('#k-setlevel').checked ? { tank: nm, litres: Math.round(cap * $w('#k-pct').value / 100), note: 'Estimate' } : null;
    persist(list, check);
  };
}
function openTransfer(toName) {
  const d = T.data, TM = tankModel(d), to = TM.byName[toName], from = TM.byName[to.topUpFrom] || TM.tanks.find(t => t.name !== toName);
  if (!from) return toast('Add another tank first.');
  const room = to.level != null ? to.capacity - to.level : to.capacity, avail = from.level != null ? from.level : room;
  const guess = Math.max(0, Math.round(Math.min(room, avail) / 500) * 500);
  const wrap = document.createElement('div'); wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="scrim"></div><div class="sheet"><h3>Top up ${esc(toName)}</h3>
    <p class="small muted">Log water you let across, so both tanks stay right.</p>
    <label class="fl">From</label><select id="x-from" class="inp">${TM.tanks.filter(t => t.name !== toName).map(t => `<option ${t.name === from.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <label class="fl">About how many litres?</label><input id="x-l" class="inp huge" inputmode="numeric" value="${guess || ''}">
    <p class="hint">${to.level != null ? `${esc(toName)} has room for about ${nf.format(Math.round(room / 100) * 100)} L.` : ''}${from.level != null ? ` ${esc(from.name)} has about ${nf.format(Math.round(from.level / 100) * 100)} L.` : ''}</p>
    <div class="row2" style="margin-top:14px"><button class="ghost" data-close>Cancel</button><button class="btn" id="x-save">Save</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('open'));
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 250); };
  wrap.querySelector('.scrim').onclick = close; wrap.querySelector('[data-close]').onclick = close;
  wrap.querySelector('#x-save').onclick = async e => {
    const L = Number(String(wrap.querySelector('#x-l').value).replace(/[,\s]/g, ''));
    if (!(L > 0)) return toast('Enter the litres moved.');
    e.target.disabled = true; e.target.textContent = 'Saving…';
    try { await api('addTransfer', { from: wrap.querySelector('#x-from').value, to: toName, litres: L, note: 'Top-up' }); close(); renderTanks(); toast('Saved.'); }
    catch (err) { toast(err.message === 'Failed to fetch' ? 'No connection. Try again when you have signal.' : err.message); e.target.disabled = false; e.target.textContent = 'Save'; }
  };
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
  const d = T.data, s = d.settings, TM = tankModel(d);
  if (d.empty) return renderTanksSimple(el, d, TM);
  const t = d.totals, now = d.now;
  const nowTank = d.tanks && d.tanks.length && TM.sysKnown ? TM.sysTotal : now.tank;
  const R = seasonRate(t.recentRate, new Date().getMonth()); annotateTanks(TM, R);
  const usable = Math.max(0, nowTank - (s.reserveLitres || 0)), o = tankOutlook(nowTank, R);
  const extra = TM.tanks.filter(x => !x.inSystem && x.level != null), extraL = sum(extra.map(x => x.level));
  const daysNoRain = (() => { const ms = todayMonths(1500), prof = useByMonth(R); let b = usable, i = 0; while (b > 0 && i < 1500) b -= prof[ms[i++]]; return i; })();
  const sinceRead = now.daysSinceReading;
  const verdict = o.low > 40000 ? 'Plenty to get through summer.' : o.low > 20000 ? 'Enough for summer, but it will get tight by autumn.' : 'Tight. Worth cutting back now.';
  const alerts = [];
  if (t.highUse) alerts.push(`Use since the last reading was <b>${nf.format(t.latestRate)} L/day</b>, well above your usual ${nf.format(t.prevRecentRate)}. Check for a leak or a tap left on.`);
  if (sinceRead > 8) alerts.push(`Last meter reading was ${Math.floor(sinceRead)} days ago, so today's figure is an estimate. A fresh reading sharpens everything.`);
  TM.tanks.filter(x => x.low).forEach(x => alerts.push(`<b>${esc(x.name)}</b> is down to about ${nf.format(Math.round(x.level / 100) * 100)} L. Time to top it up${x.topUpFrom ? ' from the ' + esc(x.topUpFrom) : ''}. <button class="linkbtn" data-topup="${esc(x.name)}">Log the top-up</button>`));
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
      <div class="hero-num"><span class="big num">${nf.format(Math.round(usable / 100) * 100)}</span><span class="muted small">litres usable in the main supply${s.reserveLitres ? `, after the ${Math.round(s.reserveLitres / 1000)}k the pump can't reach` : ''}${extraL ? `. Plus about ${nf.format(Math.round(extraL / 100) * 100)} L in ${extra.map(x => esc(x.name)).join(' and ')}.` : '.'}</span></div>
      ${myTanksCard(TM, d)}
      <h3 class="answer" style="margin-top:14px">${verdict}</h3>
      <p class="explain">In a typical year the tanks bottom out around <b>${MON[o.lowMonth]}</b> at about ${nf.format(Math.round(o.low / 1000) * 1000)} L. With no rain at all, it would last about ${daysNoRain} days, with winter use dropping to about ${nf.format(winterUse())} L a day.</p>
      <p class="tiny muted">Last reading ${fmtWhen(d.lastReading.local)} · ${nf.format(d.lastReading.meter)} L on the meter${sinceRead > 0.5 ? ' · today is estimated' : ''}</p>
    </div>
    <button class="btn big-btn" id="t-log">+ Log a meter reading</button>
    ${aheadCard(nowTank)}
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
      <p class="explain">Tank levels are worked out from the meter, the rain and any water you move. Tap a tank above to say how full it really is, and log top-ups so both tanks stay right.</p>
      <div class="row2"><button class="ghost" id="t-rain">Enter rain by hand</button>${TM.tanks.some(x => x.topUpFrom) ? `<button class="ghost" id="t-topup">Log a top-up</button>` : ''}</div>
      ${(d.transfers || []).length ? `<p class="tiny muted" style="margin-top:8px">Last top-up: ${nf.format(d.transfers[d.transfers.length - 1].litres)} L from ${esc(d.transfers[d.transfers.length - 1].from)}, ${fmtWhen(d.transfers[d.transfers.length - 1].local)}.</p>` : ''}
    </div>
    ${d.household === 'Home' || !d.household ? `<p class="note">Your readings live in your private Google Sheet. <a href="https://docs.google.com/spreadsheets/d/1-jxUCdUG4zsni5m9vYbpUEs54PbtBwCKq36Yb_zdKgE/edit" target="_blank" rel="noopener">Open the sheet</a></p>` : ''}`;
  bindTankTiles(el);
  el.querySelectorAll('svg.chart').forEach(bindTips);
  drawAhead(nowTank);
  $('#ah-rate').oninput = e => { outlook.rate = +e.target.value; outlook.touched = true; drawAhead(nowTank); };
  $('#t-log').onclick = () => openForm('reading');
  $('#t-rain').onclick = () => openForm('rain');
  if ($('#t-topup')) $('#t-topup').onclick = () => openTransfer((TM.tanks.find(x => x.topUpFrom) || {}).name);
  el.querySelectorAll('[data-del-reading]').forEach(b => b.onclick = () => confirmDelete('deleteReading', { at: b.dataset.delReading }, `the reading from ${fmtWhen(b.dataset.delReading)}`));
  el.querySelectorAll('[data-del-rain]').forEach(b => b.onclick = () => confirmDelete('deleteRain', { date: b.dataset.delRain }, `the rain entry for ${dayLabel(b.dataset.delRain)}`));
}
function bindTankTiles(el) {
  el.querySelectorAll('[data-tank]').forEach(b => b.onclick = () => openTankSheet(b.dataset.tank));
  el.querySelectorAll('[data-topup]').forEach(b => b.onclick = () => openTransfer(b.dataset.topup));
  if ($('#tk-add')) $('#tk-add').onclick = () => openTankSheet(null);
}
// A household with no water meter yet: tanks tracked from estimates and roof rain alone.
function renderTanksSimple(el, d, TM) {
  annotateTanks(TM, 0);
  const lpm = sum(TM.tanks.filter(isRoofFed).map(x => x.lpm)), fc = (d.forecast && d.forecast.days) || [], fcMm = sum(fc.slice(0, 7).map(f => f.mm || 0));
  const known = TM.tanks.filter(x => x.level != null);
  el.innerHTML = `
    <div class="view-head"><h1>Tanks</h1><span class="sub">Hi ${esc(T.who || '')}</span></div>
    ${T.stale ? `<div class="alert">Offline: showing figures from ${new Date(T.at).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.</div>` : ''}
    ${TM.tanks.filter(x => x.low).map(x => `<div class="alert"><b>${esc(x.name)}</b> is down to about ${nf.format(Math.round(x.level / 100) * 100)} L. <button class="linkbtn" data-topup="${esc(x.name)}">Log a top-up</button></div>`).join('')}
    <div class="card">
      <div class="q">How much water have we got?</div>
      ${TM.tanks.length ? `<div class="hero-num"><span class="big num">${known.length ? nf.format(Math.round(TM.knownTotal / 100) * 100) : '–'}</span><span class="muted small">${known.length ? `litres across ${known.length === TM.tanks.length ? 'your tanks' : known.length + ' of your ' + TM.tanks.length + ' tanks'} (${Math.round(TM.knownTotal / Math.max(1, sum(known.map(x => x.capacity))) * 100)}% full)` : 'Tap a tank to say how full it is'}</span></div>`
        : `<h3 class="answer">Add your tanks to get started.</h3><p class="explain">Give each tank its size and roughly how full it is. If a roof feeds it, add the roof area under "Where its water comes from" and rain will top up the estimate by itself.</p>`}
      ${myTanksCard(TM, d)}
    </div>
    ${fc.length ? card({ q: 'Is rain coming?', headline: fcMm >= 2 ? `About ${fmtMm(fcMm)} forecast this week${lpm ? `, worth roughly ${nf.format(Math.round(fcMm * lpm / 100) * 100)} L` : ''}.` : 'Little rain forecast this week.', chart: fcRow(d), explain: lpm ? '<span class="tiny">Rain is added to roof-fed tanks automatically each morning.</span>' : '<span class="tiny">Add a roof area to a tank and rain will be counted automatically.</span>' }) : ''}
    <p class="note">Estimates go up with rain and reset whenever you say how full a tank is. Have a water meter? Tick "The water meter is on this tank" and the app can track daily use too.</p>`;
  bindTankTiles(el);
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
  const [raw, drv] = await Promise.all([fetch('data/rain.json', { cache: 'no-cache' }).then(r => r.json()), fetch('data/drivers.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => null)]);
  DRV = drv;
  D = deriveData(raw);
  loadCachedTanks();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && keyOf()) refreshTanks(true); });
  show(['tanks', 'rain', 'genie'].includes(initial) ? initial : 'rain');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
