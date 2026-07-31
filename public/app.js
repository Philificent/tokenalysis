/* Tokenalysis dashboard */
'use strict';

/* ---------- duotone theme system ----------
   Each theme is two hues; every data color is derived by rotating the
   Glacier palette by the primary-hue delta. CSS reads the same hues from
   :root[data-theme] custom properties, so charts and chrome stay in sync. */
const THEMES = { glacier: [199, 252], nebula: [265, 318], verdant: [152, 200], ember: [22, 302] };
const THEME_KEY = 'tokenalysis-theme';

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return THEMES[t] ? t : 'glacier';
}

function hslHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function palette() {
  const [ha, hb] = THEMES[currentTheme()];
  const dh = ha - 199;
  return {
    input: hslHex(ha, 100, 68),
    output: hslHex(hb, 94, 79),
    cacheWrite: hslHex(32 + dh, 100, 74),
    cacheRead: hslHex(162 + dh, 71, 65),
    accent: hslHex(ha, 100, 77),
    model: [
      hslHex(ha, 100, 77), hslHex(hb, 94, 79), hslHex(162 + dh, 71, 65), hslHex(32 + dh, 100, 74),
      hslHex(0 + dh, 100, 76), hslHex(187 + dh, 74, 65), hslHex(339 + dh, 89, 81), hslHex(80 + dh, 76, 69),
    ],
    grid: `hsla(${216 + dh}, 100%, 79%, 0.055)`,
    axis: `hsla(${216 + dh}, 100%, 79%, 0.14)`,
    tooltipBorder: `hsla(${ha}, 100%, 77%, 0.28)`,
  };
}

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let booted = false; // first paint gets the entrance choreography, refreshes stay still

/* ---------- date range ----------
   Everything below the headline cards is scoped to one half-open [from, to)
   window, resolved here in the browser's local time so the server never has to
   guess a timezone. "All time" sends from=0 — that's how the API tells
   "everything" apart from "no window given". */
const RANGE_KEY = 'tokenalysis-range';
const DAY_MS = 86400000;
const PRESET_DAYS = { today: 1, '7d': 7, '30d': 30, '365d': 365 };

let range = { preset: '30d', from: null, to: null };   // from/to only used by 'custom'

/* Calendar arithmetic, not millisecond arithmetic: a DST day is 23 or 25 hours
   long and subtracting 86400000 lands on the wrong date twice a year. */
function dayStart(daysBack = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

function nextDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function prevDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
}

function parseDayInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}

function toDayInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The active selection as concrete epoch-ms bounds; `to: null` means "through now". */
function resolvedRange() {
  if (range.preset === 'all') return { from: 0, to: null };
  if (range.preset === 'custom') return { from: range.from, to: range.to };
  return { from: dayStart((PRESET_DAYS[range.preset] || 30) - 1), to: null };
}

function rangeQuery() {
  const { from, to } = resolvedRange();
  return to === null ? `from=${from}` : `from=${from}&to=${to}`;
}

/** A day or two of data is unreadable as a single bar, so short windows go hourly. */
function rangeBucket() {
  const { from, to } = resolvedRange();
  return (to === null ? Date.now() : to) - from <= 2 * DAY_MS ? 'hour' : 'day';
}

function rangeNote() {
  if (range.preset === 'all') return 'every recorded request';
  const { from, to } = resolvedRange();
  const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const a = fmt(from);
  const b = fmt(to === null ? Date.now() : prevDay(to));
  return a === b ? a : `${a} \u2013 ${b}`;
}

function persistRange() {
  try { localStorage.setItem(RANGE_KEY, JSON.stringify(range)); } catch (e) { /* private mode: won't persist */ }
}

function restoreRange() {
  try {
    const s = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
    if (!s) return;
    const ok = PRESET_DAYS[s.preset] || s.preset === 'all'
      || (s.preset === 'custom' && s.from > 0 && s.to > s.from);
    if (ok) range = { preset: s.preset, from: s.from ?? null, to: s.to ?? null };
  } catch (e) { /* corrupt entry: keep the default window */ }
}

/* `seedDates` fills the two pickers from the stored window. That only happens when
   we open custom mode or reload from storage: doing it on every sync would fight the
   user, since a start date later than the current end swaps the pair and the field
   would snap back to a date they didn't choose. The note reports the effective
   window, so the swap is still visible without rewriting their input. */
function syncRangeUi({ seedDates = false } = {}) {
  for (const btn of document.querySelectorAll('#range-presets button')) {
    btn.classList.toggle('active', btn.dataset.range === range.preset);
  }
  const custom = document.getElementById('custom-range');
  custom.hidden = range.preset !== 'custom';
  if (range.preset === 'custom') {
    const a = document.getElementById('range-from');
    const b = document.getElementById('range-to');
    if (seedDates || !a.value) a.value = toDayInput(range.from);
    if (seedDates || !b.value) b.value = toDayInput(prevDay(range.to));  // stored end is exclusive
  }
  document.getElementById('range-note').textContent = rangeNote();
  for (const card of document.querySelectorAll('#cards .card[data-range]')) {
    const on = card.dataset.range === range.preset;
    card.classList.toggle('picked', on);
    card.setAttribute('aria-pressed', String(on));
  }
}

function setRange(preset) {
  // opening the custom pickers should never leave a half-set window on screen:
  // seed them from whatever we were already showing
  if (preset === 'custom' && (range.from === null || range.to === null)) {
    const prev = resolvedRange();
    range.from = prev.from || dayStart(29);
    range.to = prev.to === null ? nextDay(dayStart()) : prev.to;
  }
  range.preset = preset;
  recentLimit = recentSize;   // a new window starts at page one
  persistRange();
  syncRangeUi({ seedDates: true });
  refresh().catch(() => {});
}

function applyCustomRange() {
  const a = parseDayInput(document.getElementById('range-from').value);
  const b = parseDayInput(document.getElementById('range-to').value);
  if (a === null || b === null) return;      // half-filled: wait for the other date
  range = { preset: 'custom', from: Math.min(a, b), to: nextDay(Math.max(a, b)) };
  recentLimit = recentSize;
  persistRange();
  syncRangeUi();
  refresh().catch(() => {});
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function fmtUsd(v) {
  if (v === null || v === undefined) return '\u2014';
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(5);
  return '$' + v.toFixed(2);
}

function fmtTok(v) {
  if (v === null || v === undefined) return '\u2014';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* Slow-in / slow-out number tween (timing + exaggeration: costs sweep up from 0
   on first load, then glide between values on refresh). */
const prevCost = new Map();
function tweenCost(el, from, to) {
  if (REDUCED_MOTION || from === to || to === null || to === undefined) {
    el.textContent = fmtUsd(to);
    return;
  }
  const t0 = performance.now();
  const dur = booted ? 600 : 1100;
  (function tick(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 4); // easeOutQuart
    el.textContent = fmtUsd(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

/* ---------- headline cards ---------- */

function renderCards(summary) {
  // each card doubles as the range preset for everything below it
  const periods = [
    ['Today', summary.today, 'today'],
    ['This week', summary.week, '7d'],
    ['This month', summary.month, '30d'],
    ['All time', summary.all_time, 'all'],
  ];
  const el = document.getElementById('cards');
  el.innerHTML = periods.map(([label, p, preset], i) => {
    const totalTok = (p.input_tokens || 0) + (p.output_tokens || 0)
      + (p.cache_creation_tokens || 0) + (p.cache_read_tokens || 0);
    const unpriced = p.unpriced_requests
      ? `<span class="badge err" title="requests with usage but no known price">${p.unpriced_requests} unpriced</span>`
      : '';
    const on = preset === range.preset;
    return `<div class="card glass${booted ? '' : ' reveal'}${on ? ' picked' : ''}" style="--d:${i * 0.09}s"
      data-range="${preset}" role="button" tabindex="0" aria-pressed="${on}"
      title="Scope everything below to ${esc(label.toLowerCase())}">
      <h3>${label}</h3>
      <div class="cost" data-label="${label}">${fmtUsd(p.cost_total)}</div>
      <div class="toks">${fmtTok(totalTok)} tokens &middot; ${p.requests} requests ${unpriced}</div>
      <div class="split">
        <span><i class="dot in"></i>in ${fmtTok(p.input_tokens)} (${fmtUsd(p.cost_input)})</span>
        <span><i class="dot out"></i>out ${fmtTok(p.output_tokens)} (${fmtUsd(p.cost_output)})</span>
        <span><i class="dot cw"></i>cache write ${fmtTok(p.cache_creation_tokens)} (${fmtUsd(p.cost_cache_write)})</span>
        <span><i class="dot cr"></i>cache read ${fmtTok(p.cache_read_tokens)} (${fmtUsd(p.cost_cache_read)})</span>
      </div>
    </div>`;
  }).join('');

  for (const costEl of el.querySelectorAll('.cost')) {
    const label = costEl.dataset.label;
    const target = periods.find(([l]) => l === label)[1].cost_total;
    if (typeof target === 'number') {
      tweenCost(costEl, prevCost.get(label) ?? 0, target);
      prevCost.set(label, target);
    }
  }

  for (const card of el.querySelectorAll('.card[data-range]')) {
    card.addEventListener('click', () => setRange(card.dataset.range));
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      setRange(card.dataset.range);
    });
  }

  const age = document.getElementById('pricing-age');
  age.textContent = summary.pricing_snapshot_at
    ? `prices as of ${new Date(summary.pricing_snapshot_at).toLocaleDateString()}`
    : 'no pricing snapshot yet';
}

/* ---------- time series chart ---------- */

let chart = null;
let chartMode = 'class';
let chartStyle = 'bar'; // bar | area | line

/* Glowing points that brighten as the cursor approaches, dim as it leaves. */
const chartCursor = { x: -1e4, y: -1e4, active: false };
const GLOW_RADIUS = 150;
const proximityGlow = {
  id: 'proximityGlow',
  afterEvent(c, args) {
    const e = args.event;
    if (e.type === 'mousemove') {
      chartCursor.x = e.x; chartCursor.y = e.y; chartCursor.active = true;
      args.changed = true;
    } else if (e.type === 'mouseout') {
      chartCursor.active = false;
      args.changed = true;
    }
  },
  afterDatasetsDraw(c) {
    if (!chartCursor.active || REDUCED_MOTION) return;
    const { ctx } = c;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const meta of c.getSortedVisibleDatasetMetas()) {
      const color = c.data.datasets[meta.index].glowColor || palette().accent;
      for (const elem of meta.data) {
        const pos = elem.getProps(['x', 'y'], true);
        const dx = pos.x - chartCursor.x, dy = pos.y - chartCursor.y;
        const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / GLOW_RADIUS);
        if (near <= 0.01) continue;
        const glow = near * near; // slow-in: bloom accelerates as you close in
        const r = 3 + glow * 9;
        const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r * 3);
        g.addColorStop(0, hexToRgba(color, 0.85 * glow));
        g.addColorStop(0.4, hexToRgba(color, 0.28 * glow));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 3, 0, Math.PI * 2);
        ctx.fill();
        // bright core
        ctx.fillStyle = hexToRgba('#ffffff', 0.9 * glow);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 1.2 + glow * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  },
};

/* Translucent vertical gradient bound to the chart area. */
function verticalFade(color, top, bottom) {
  return (context) => {
    const { ctx, chartArea } = context.chart;
    if (!chartArea) return hexToRgba(color, top);
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, hexToRgba(color, top));
    g.addColorStop(1, hexToRgba(color, bottom));
    return g;
  };
}

function styleDataset(label, data, color) {
  const base = { label, data, glowColor: color };
  if (chartStyle === 'bar') {
    return {
      ...base,
      backgroundColor: verticalFade(color, 0.75, 0.18),
      borderColor: hexToRgba(color, 0.95),
      borderWidth: { top: 1.5, left: 1, right: 1, bottom: 0 },
      borderRadius: 6,
      borderSkipped: false,
      maxBarThickness: 42,
    };
  }
  if (chartStyle === 'area') {
    return {
      ...base,
      fill: true,
      backgroundColor: verticalFade(color, 0.38, 0.02),
      borderColor: hexToRgba(color, 0.9),
      borderWidth: 2,
      tension: 0.42,               // arcs: costs flow, they don't zig-zag
      pointRadius: 2,              // faint ember so sparse/single-day data stays visible
      pointBackgroundColor: hexToRgba(color, 0.55),
      pointBorderWidth: 0,
      pointHitRadius: 14,
    };
  }
  return {
    ...base,
    fill: false,
    borderColor: hexToRgba(color, 0.9),
    borderWidth: 2,
    tension: 0.35,
    pointRadius: 2.5,
    pointBackgroundColor: hexToRgba(color, 0.9),
    pointBorderColor: 'rgba(255,255,255,0.6)',
    pointBorderWidth: 0.5,
    pointHitRadius: 14,
  };
}

async function renderChart(animate) {
  const data = await getJson(`/api/stats/timeseries?${rangeQuery()}&bucket=${rangeBucket()}&group=${chartMode}`);
  const ctx = document.getElementById('timeseries');
  const pal = palette();
  const hourly = data.bucket === 'hour';
  const lbl = (key) => (hourly ? key.slice(11) : key);   // 'YYYY-MM-DD HH:00' -> 'HH:00'
  const title = document.getElementById('ts-title');
  if (title) title.textContent = hourly ? 'Cost by hour' : 'Cost by day';
  let labels, datasets;

  if (data.group === 'class') {
    labels = data.rows.map((r) => lbl(r.day));
    datasets = [
      styleDataset('Input', data.rows.map((r) => r.cost_input), pal.input),
      styleDataset('Output', data.rows.map((r) => r.cost_output), pal.output),
      styleDataset('Cache write', data.rows.map((r) => r.cost_cache_write), pal.cacheWrite),
      styleDataset('Cache read', data.rows.map((r) => r.cost_cache_read), pal.cacheRead),
    ];
  } else {
    const keys = [...new Set(data.rows.map((r) => r.day))];
    const models = [...new Set(data.rows.map((r) => r.model))];
    const lookup = new Map(data.rows.map((r) => [`${r.day}|${r.model}`, r.cost_total]));
    labels = keys.map(lbl);
    datasets = models.map((m, i) =>
      styleDataset(m, keys.map((d) => lookup.get(`${d}|${m}`) || 0), pal.model[i % pal.model.length]));
  }

  const stacked = chartStyle !== 'line';
  const type = chartStyle === 'bar' ? 'bar' : 'line';

  if (chart && !animate) {
    // background refresh: swap data in place, no re-entrance theatrics
    chart.data.labels = labels;
    chart.data.datasets = datasets;
    chart.update('none');
    return;
  }
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type,
    data: { labels, datasets },
    plugins: [proximityGlow],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      animation: REDUCED_MOTION ? false : {
        duration: 850,
        easing: 'easeOutQuart', // slow out
        delay: (c) => (c.type === 'data' && c.mode === 'default')
          ? c.dataIndex * 22 + c.datasetIndex * 110   // staggered entrance
          : 0,
      },
      scales: {
        x: {
          stacked,
          ticks: { color: '#7b89a8', font: { family: 'Outfit', size: 11 } },
          grid: { color: pal.grid },
          border: { color: pal.axis },
        },
        y: {
          stacked,
          ticks: { color: '#7b89a8', font: { family: 'Outfit', size: 11 }, callback: (v) => '$' + v },
          grid: { color: pal.grid },
          border: { display: false },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#cfd9ec', usePointStyle: true, pointStyle: 'circle',
            boxWidth: 7, boxHeight: 7, padding: 16, font: { family: 'Outfit', size: 12 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(9, 15, 32, 0.88)',
          borderColor: pal.tooltipBorder,
          borderWidth: 1,
          cornerRadius: 12,
          padding: 12,
          titleColor: '#eaf0fb',
          bodyColor: '#aeb9d3',
          titleFont: { family: 'Outfit', weight: '600' },
          bodyFont: { family: 'Outfit' },
          boxPadding: 5,
          usePointStyle: true,
          callbacks: {
            label: (item) => ` ${item.dataset.label}: ${fmtUsd(item.parsed.y)}`,
          },
        },
      },
    },
  });
}

/* ---------- tables ---------- */

function rowReveal(i) {
  return booted ? '' : ` class="reveal-row" style="--d:${Math.min(i * 0.045, 0.6)}s"`;
}

function ratioBar(ratio) {
  if (ratio === null || ratio === undefined) return '\u2014';
  const pct = (ratio * 100).toFixed(1);
  return `<span class="ratio" title="${pct}% of prompt tokens served from cache">
    <i style="width:${Math.min(100, ratio * 100)}%"></i></span>${pct}%`;
}

function renderModelTable(data) {
  const t = document.getElementById('tbl-model');
  if (!data.rows.length) { t.innerHTML = '<tr><td class="empty">No requests recorded yet.</td></tr>'; return; }
  t.innerHTML = `<tr><th>Model</th><th>Provider</th><th>Reqs</th><th>In</th><th>Out</th>
      <th>Cache W</th><th>Cache R</th><th>Cache hit</th><th>Cost</th></tr>` +
    data.rows.map((r, i) => `<tr${rowReveal(i)}>
      <td>${esc(r.model)}</td><td><span class="badge">${esc(r.provider)}</span></td>
      <td>${r.requests}</td>
      <td>${fmtTok(r.input_tokens)}</td><td>${fmtTok(r.output_tokens)}</td>
      <td>${fmtTok(r.cache_creation_tokens)}</td><td>${fmtTok(r.cache_read_tokens)}</td>
      <td>${ratioBar(r.cache_hit_ratio)}</td>
      <td>${fmtUsd(r.cost_total)}</td>
    </tr>`).join('');
}

/* Per-model breakdown for an expanded tool row (fetched lazily on click).
   The set survives re-renders so an open row re-opens after a 30s refresh. */
const expandedTools = new Set();

function toolDetailHtml(rows) {
  if (!rows.length) return '<div class="tool-detail-wrap"><div class="sub-empty">No model breakdown available.</div></div>';
  return `<div class="tool-detail-wrap"><table>
    <thead><tr><th>Model</th><th>Calls</th><th>Reqs</th><th>In</th><th>Out</th>
      <th>Cache W</th><th>Cache R</th><th>Cost</th></tr></thead>
    <tbody>${rows.map((m) => `<tr>
      <td>${esc(m.model)}</td><td>${m.calls}</td><td>${m.requests}</td>
      <td>${fmtTok(m.input_tokens)}</td><td>${fmtTok(m.output_tokens)}</td>
      <td>${fmtTok(m.cache_creation_tokens)}</td><td>${fmtTok(m.cache_read_tokens)}</td>
      <td>${fmtUsd(m.cost_total)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

async function expandToolRow(row) {
  const tool = row.dataset.tool;
  row.classList.add('expanded');
  expandedTools.add(tool);
  const detail = document.createElement('tr');
  detail.className = 'tool-detail';
  detail.innerHTML = '<td colspan="5"><div class="tool-detail-wrap"><div class="sub-empty">Loading\u2026</div></div></td>';
  row.after(detail);
  try {
    const data = await getJson(`/api/stats/by-tool-model?tool=${encodeURIComponent(tool)}&${rangeQuery()}`);
    detail.firstChild.innerHTML = toolDetailHtml(data.rows);
  } catch (e) {
    detail.firstChild.innerHTML = '<div class="tool-detail-wrap"><div class="sub-empty">Failed to load breakdown.</div></div>';
  }
}

function collapseToolRow(row) {
  row.classList.remove('expanded');
  expandedTools.delete(row.dataset.tool);
  const next = row.nextElementSibling;
  if (next && next.classList.contains('tool-detail')) next.remove();
}

function renderToolTable(data) {
  const t = document.getElementById('tbl-tool');
  if (!data.rows.length) { t.innerHTML = '<tr><td class="empty">No tool calls recorded yet.</td></tr>'; expandedTools.clear(); return; }
  const offered = new Map(data.offered.map((o) => [o.tool_name, o.offered_in_requests]));

  // Group MCP tools under their server; native tools in a flat group.
  const groups = new Map();
  for (const r of data.rows) {
    const key = r.is_mcp ? `MCP: ${r.mcp_server}` : 'Native / harness tools';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let html = `<tr><th>Tool</th><th>Calls</th><th>Requests</th><th>Offered in</th><th>Involved cost</th></tr>`;
  let i = 0;
  for (const [group, rows] of groups) {
    html += `<tr class="mcp-group"><td colspan="5">${esc(group)}</td></tr>`;
    for (const r of rows) {
      const display = r.is_mcp ? r.tool_name.replace(`mcp__${r.mcp_server}__`, '') : r.tool_name;
      const rev = booted ? '' : ' reveal-row';
      html += `<tr class="clickable tool-row${rev}" style="--d:${Math.min(i++ * 0.045, 0.6)}s" data-tool="${esc(r.tool_name)}" title="Click for per-model breakdown">
        <td><span class="caret"></span>${esc(display)} ${r.is_mcp ? '<span class="badge mcp">mcp</span>' : ''}</td>
        <td>${r.calls}</td><td>${r.requests}</td>
        <td>${offered.get(r.tool_name) || '\u2014'}</td>
        <td>${fmtUsd(r.involved_cost)}</td>
      </tr>`;
    }
  }
  t.innerHTML = html;

  // wire click-to-expand, and re-open any rows that were open before this render
  const present = new Set();
  t.querySelectorAll('tr.tool-row').forEach((row) => {
    present.add(row.dataset.tool);
    row.addEventListener('click', () => {
      if (row.classList.contains('expanded')) collapseToolRow(row);
      else expandToolRow(row);
    });
    if (expandedTools.has(row.dataset.tool)) expandToolRow(row);
  });
  for (const tn of [...expandedTools]) if (!present.has(tn)) expandedTools.delete(tn);
}

function renderClientTable(data) {
  const t = document.getElementById('tbl-client');
  if (!data.rows.length) { t.innerHTML = '<tr><td class="empty">No requests recorded yet.</td></tr>'; return; }
  t.innerHTML = `<tr><th>Client</th><th>Reqs</th><th>In</th><th>Out</th><th>Cache W</th><th>Cache R</th><th>Cost</th></tr>` +
    data.rows.map((r, i) => `<tr${rowReveal(i)}>
      <td title="${esc(r.client)}">${esc(String(r.client).slice(0, 60))}</td>
      <td>${r.requests}</td>
      <td>${fmtTok(r.input_tokens)}</td><td>${fmtTok(r.output_tokens)}</td>
      <td>${fmtTok(r.cache_creation_tokens)}</td><td>${fmtTok(r.cache_read_tokens)}</td>
      <td>${fmtUsd(r.cost_total)}</td>
    </tr>`).join('');
}

/* Recent requests: the page size is user-picked (25/50/100) and remembered;
   "load more" then walks forward one page at a time. */
const RECENT_SIZE_KEY = 'tokenalysis-recent-size';
const RECENT_SIZES = [25, 50, 100];
let recentSize = 50;
let recentLimit = recentSize;

function restoreRecentSize() {
  try {
    const saved = Number(localStorage.getItem(RECENT_SIZE_KEY));
    if (RECENT_SIZES.includes(saved)) recentSize = saved;
  } catch (e) { /* private mode: page size just won't persist */ }
  recentLimit = recentSize;
}

function renderRecentTable(data) {
  const t = document.getElementById('tbl-recent');
  const bar = document.getElementById('recent-more');
  const btn = document.getElementById('recent-more-btn');
  if (!data.rows.length) {
    t.innerHTML = '<tr><td class="empty">No requests in this range.</td></tr>';
    if (bar) bar.hidden = true;
    return;
  }
  t.innerHTML = `<tr><th>Time</th><th>Provider</th><th>Model</th><th>Status</th><th>In</th><th>Out</th>
      <th>Cache W</th><th>Cache R</th><th>Cost</th><th>Latency</th></tr>` +
    data.rows.map((r, i) => `<tr class="clickable${booted ? '' : ' reveal-row'}" style="--d:${Math.min(i * 0.035, 0.5)}s" data-id="${r.id}">
      <td>${fmtTime(r.ts)}</td>
      <td><span class="badge">${esc(r.provider)}</span></td>
      <td>${esc(r.model || '(unknown)')} ${r.parse_error ? '<span class="badge err">parse err</span>' : ''}</td>
      <td>${r.status}</td>
      <td>${fmtTok(r.input_tokens)}</td><td>${fmtTok(r.output_tokens)}</td>
      <td>${fmtTok(r.cache_creation_tokens)}</td><td>${fmtTok(r.cache_read_tokens)}</td>
      <td>${fmtUsd(r.cost_total)}</td>
      <td>${r.latency_ms}ms</td>
    </tr>`).join('');
  t.querySelectorAll('tr.clickable').forEach((row) => {
    row.addEventListener('click', () => openDrill(row.dataset.id));
  });

  const total = data.total ?? data.rows.length;
  const shown = data.rows.length;
  // hold whatever depth is on screen so background refreshes don't collapse it
  recentLimit = Math.max(recentSize, shown);
  if (bar) {
    bar.hidden = false;
    btn.hidden = shown >= total;
    document.getElementById('recent-shown').textContent = shown;
    document.getElementById('recent-total').textContent = total;
  }
}

async function fetchRecent(limit) {
  return getJson(`/api/stats/recent?${rangeQuery()}&limit=${limit}`);
}

async function loadMoreRecent() {
  const btn = document.getElementById('recent-more-btn');
  btn.disabled = true;
  try {
    renderRecentTable(await fetchRecent(recentLimit + recentSize));
  } finally {
    btn.disabled = false;
  }
}

async function setRecentSize(n) {
  recentSize = n;
  recentLimit = n;
  try { localStorage.setItem(RECENT_SIZE_KEY, String(n)); } catch (e) { /* private mode */ }
  renderRecentTable(await fetchRecent(recentLimit));
}

async function openDrill(id) {
  const data = await getJson(`/api/stats/request/${id}`);
  document.getElementById('drill-id').textContent = `#${id}`;
  const r = data.request;
  const tools = data.tool_calls.length
    ? data.tool_calls.map((tc) =>
        `<li>${esc(tc.tool_name)} \u00d7${tc.call_count} ${tc.is_mcp ? `<span class="badge mcp">${esc(tc.mcp_server)}</span>` : ''}</li>`
      ).join('')
    : '<li class="muted">none</li>';
  const offeredCount = data.tools_offered.length;
  const offered = offeredCount
    ? data.tools_offered.map((o) => esc(o.tool_name)).join(', ')
    : '<span class="muted">none</span>';
  document.getElementById('drill-body').innerHTML = `
    <table>
      <tr><td>Time</td><td>${fmtTime(r.ts)}</td></tr>
      <tr><td>Provider / model</td><td>${esc(r.provider)} / ${esc(r.model || '?')}</td></tr>
      <tr><td>Client</td><td>${esc(r.client || '?')}</td></tr>
      <tr><td>Status / stream / latency</td><td>${r.status} / ${r.stream ? 'yes' : 'no'} / ${r.latency_ms}ms</td></tr>
      <tr><td>Input tokens</td><td>${fmtTok(r.input_tokens)} (${fmtUsd(r.cost_input)})</td></tr>
      <tr><td>Output tokens</td><td>${fmtTok(r.output_tokens)} (${fmtUsd(r.cost_output)})</td></tr>
      <tr><td>Cache write tokens</td><td>${fmtTok(r.cache_creation_tokens)} (${fmtUsd(r.cost_cache_write)})</td></tr>
      <tr><td>Cache read tokens</td><td>${fmtTok(r.cache_read_tokens)} (${fmtUsd(r.cost_cache_read)})</td></tr>
      <tr><td>Total cost</td><td><b>${fmtUsd(r.cost_total)}</b></td></tr>
    </table>
    <h4>Tools called</h4><ul>${tools}</ul>
    <details class="tools-offered">
      <summary>Tools offered (${offeredCount})</summary>
      <p>${offered}</p>
    </details>`;
  document.getElementById('drill').classList.add('open');
}

async function renderWarnings() {
  const data = await getJson('/api/stats/warnings');
  const el = document.getElementById('warnings');
  if (data.rows.length) {
    el.style.display = 'block';
    el.innerHTML = data.rows.slice(0, 3)
      .map((w) => `${fmtTime(w.ts)} [${w.level}] ${esc(w.message)}`).join('<br>');
  }
}

/* ---------- boot ---------- */

async function refresh() {
  const q = rangeQuery();
  const [summary, byModel, byTool, byClient, recent] = await Promise.all([
    getJson('/api/stats/summary'),          // the cards report their own fixed periods
    getJson(`/api/stats/by-model?${q}`),
    getJson(`/api/stats/by-tool?${q}`),
    getJson(`/api/stats/by-client?${q}`),
    fetchRecent(recentLimit),
  ]);
  renderCards(summary);
  syncRangeUi();
  renderModelTable(byModel);
  renderToolTable(byTool);
  renderClientTable(byClient);
  renderRecentTable(recent);
  await renderChart(!booted);
  await renderWarnings();
  lastRefreshAt = Date.now();
  booted = true;
}

function bindGroup(ids, onPick) {
  for (const id of ids) {
    document.getElementById(id).addEventListener('click', (e) => {
      ids.forEach((other) => document.getElementById(other).classList.remove('active'));
      e.currentTarget.classList.add('active');
      onPick(id);
    });
  }
}

bindGroup(['btn-class', 'btn-model'], (id) => {
  chartMode = id === 'btn-class' ? 'class' : 'model';
  renderChart(true);
});
bindGroup(['style-bar', 'style-area', 'style-line'], (id) => {
  chartStyle = id.replace('style-', '');
  renderChart(true);
});

/* ---------- theme picker ---------- */

function applyTheme(name, { render = true } = {}) {
  if (!THEMES[name]) name = 'glacier';
  if (name === 'glacier') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = name;
  try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* private mode: theme just won't persist */ }
  for (const btn of document.querySelectorAll('.theme-pick .swatch')) {
    btn.classList.toggle('active', btn.dataset.themePick === name);
  }
  window.dispatchEvent(new CustomEvent('tokenalysis-theme', { detail: { hues: THEMES[name] } }));
  if (render) renderChart(true); // re-tint datasets; chart canvas can't read CSS vars
}

for (const btn of document.querySelectorAll('.theme-pick .swatch')) {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themePick));
}
applyTheme(currentTheme(), { render: false }); // sync swatch ring with pre-paint theme

document.getElementById('drill').addEventListener('click', (e) => {
  if (e.target.id === 'drill') e.target.classList.remove('open');
});
document.getElementById('recent-more-btn').addEventListener('click', () => loadMoreRecent().catch(() => {}));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('drill').classList.remove('open');
});

/* ---------- date range bar ---------- */

restoreRange();
restoreRecentSize();
for (const btn of document.querySelectorAll('#range-presets button')) {
  btn.addEventListener('click', () => setRange(btn.dataset.range));
}
document.getElementById('range-apply').addEventListener('click', applyCustomRange);
for (const id of ['range-from', 'range-to']) {
  document.getElementById(id).addEventListener('change', applyCustomRange);
}
syncRangeUi({ seedDates: true });   // first paint: the pickers start empty

const recentSizeSel = document.getElementById('recent-size');
recentSizeSel.value = String(recentSize);
recentSizeSel.addEventListener('change', () => setRecentSize(Number(recentSizeSel.value)).catch(() => {}));

/* Once an entrance finishes, drop the animation class so the fill-mode
   transform can't fight the live tilt/hover transforms. */
document.addEventListener('animationend', (e) => {
  if (e.target.classList) {
    e.target.classList.remove('reveal');
    e.target.classList.remove('reveal-row');
  }
});

/* ---------- refresh cadence ----------
   A buried tab gets nothing: no polling, no repaints, no needless SQL. Coming
   back refreshes straight away if the numbers went stale while we were away,
   and each scheduled poll waits for an idle slice so it can't land in the
   middle of a scroll or an entrance animation. */

const POLL_MS = 30000;
let pollTimer = 0;
let lastRefreshAt = 0;

const whenIdle = window.requestIdleCallback
  ? (fn) => window.requestIdleCallback(fn, { timeout: 3000 })
  : (fn) => setTimeout(fn, 0);

function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(() => {
    whenIdle(() => refresh().catch(() => {}).finally(schedulePoll));
  }, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    return;
  }
  if (Date.now() - lastRefreshAt >= POLL_MS) refresh().catch(() => {});
  schedulePoll();
});

refresh()
  .catch((err) => {
    document.getElementById('cards').innerHTML =
      `<div class="card glass"><h3>Error</h3><div>${esc(err.message)}</div></div>`;
  })
  .finally(schedulePoll);
