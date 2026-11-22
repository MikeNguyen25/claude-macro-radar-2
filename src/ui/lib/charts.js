// Biểu đồ SVG vẽ đúng kích thước khung (1 đơn vị = 1 px) để chữ không co trên điện thoại.

import { esc } from './dom.js';
import { dayIso, num, pct } from './fmt.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const minOf = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);

/** Vạch chia "đẹp" cho trục số. */
export function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) { const d = Math.abs(lo) * 0.05 || 1; lo -= d; hi += d; }
  const raw = (hi - lo) / Math.max(1, n);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const e = raw / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(Number(t.toFixed(12)));
  return { ticks, step };
}

/** Vạch chia trục thời gian (số ngày kể từ 1970): đầu năm, đầu quý hoặc đầu tháng. */
function timeTicks(x0, x1, maxTicks) {
  const span = x1 - x0;
  const stepMonths = span > 365 * 12 ? 60 : span > 365 * 6 ? 24 : span > 365 * 3 ? 12 : span > 400 ? 6 : span > 200 ? 3 : span > 90 ? 2 : 1;
  const d0 = new Date(x0 * 864e5);
  let y = d0.getUTCFullYear();
  let m = d0.getUTCMonth() + 1;
  const out = [];
  for (let k = 0; k < 400 && out.length < maxTicks * 3; k++) {
    if (m > 12) { m -= 12; y += 1; }
    const t = Math.round(Date.UTC(y, m - 1, 1) / 864e5);
    if (t > x1) break;
    const monthIndex = y * 12 + (m - 1);
    if (t >= x0 && monthIndex % stepMonths === 0) out.push(t);
    m += 1;
  }
  const k = Math.ceil(out.length / Math.max(1, maxTicks));
  const kept = k > 1 ? out.filter((_, i) => i % k === 0) : out;
  const label = (t) => { const iso = dayIso(t); return stepMonths >= 12 ? iso.slice(0, 4) : `${iso.slice(5, 7)}/${iso.slice(2, 4)}`; };
  return kept.map((t) => ({ t, label: label(t) }));
}

const path = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

/**
 * Biểu đồ đường theo thời gian, có thể kèm quạt dự báo (vùng 80% kỳ 1 và 3 tháng).
 * @param {{w:number, h?:number, title:string, series:{x:number[], y:number[], cls?:string}[],
 *   fan?:{x0:number, y0:number, h1?:{x:number, lo:number, mid:number, hi:number}, h3?:{x:number, lo:number, mid:number, hi:number}},
 *   yfmt?:(v:number)=>string, refY?:number}} o
 */
export function lineChart(o) {
  const w = Math.max(260, Math.round(o.w));
  const H = o.h || 220;
  const xs = [];
  const ys = [];
  for (const s of o.series) for (let i = 0; i < s.x.length; i++) if (finite(s.y[i])) { xs.push(s.x[i]); ys.push(s.y[i]); }
  const f = o.fan;
  if (f) for (const p of [f.h1, f.h3]) if (p) { xs.push(p.x); ys.push(p.lo, p.hi); }
  if (!xs.length) return `<svg viewBox="0 0 ${w} 60" role="img" aria-label="${esc(o.title)}"><text x="0" y="30">Chưa có số liệu</text></svg>`;
  const x0 = minOf(xs);
  const x1 = maxOf(xs);
  const ylo = minOf(ys);
  const yhi = maxOf(ys);
  const pad = (yhi - ylo) * 0.06 || Math.abs(yhi) * 0.02 || 1;
  const { ticks } = niceTicks(ylo - pad, yhi + pad, H < 180 ? 3 : 5);
  const ymin = Math.min(ticks[0], ylo - pad);
  const ymax = Math.max(ticks[ticks.length - 1], yhi + pad);
  const yfmt = o.yfmt || ((v) => num(v, 0));
  const labelW = Math.max(28, ...ticks.map((t) => yfmt(t).length * 6.4)) + 8;
  const m = { l: labelW, r: 12, t: 10, b: 24 };
  const X = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (w - m.l - m.r);
  const Y = (y) => m.t + (1 - (y - ymin) / (ymax - ymin || 1)) * (H - m.t - m.b);
  let s = `<svg viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" role="img" aria-label="${esc(o.title)}"><title>${esc(o.title)}</title>`;
  for (const t of ticks) {
    if (t < ymin || t > ymax) continue;
    s += `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/>`;
    s += `<text x="${m.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${esc(yfmt(t))}</text>`;
  }
  if (finite(o.refY) && o.refY >= ymin && o.refY <= ymax) s += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${Y(o.refY)}" y2="${Y(o.refY)}"/>`;
  for (const t of timeTicks(x0, x1, Math.max(2, Math.floor((w - m.l) / 70)))) {
    s += `<text x="${X(t.t).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(t.label)}</text>`;
    s += `<line class="grid" x1="${X(t.t).toFixed(1)}" x2="${X(t.t).toFixed(1)}" y1="${m.t}" y2="${H - m.b}"/>`;
  }
  s += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  if (f) {
    const P0 = [X(f.x0), Y(f.y0)];
    if (f.h3) {
      const a = f.h1 || f.h3;
      const pts = f.h1 ? [P0, [X(a.x), Y(a.hi)], [X(f.h3.x), Y(f.h3.hi)], [X(f.h3.x), Y(f.h3.lo)], [X(a.x), Y(a.lo)]] : [P0, [X(f.h3.x), Y(f.h3.hi)], [X(f.h3.x), Y(f.h3.lo)]];
      s += `<path class="band3" d="${path(pts)}Z"/>`;
    }
    if (f.h1) s += `<path class="band1" d="${path([P0, [X(f.h1.x), Y(f.h1.hi)], [X(f.h1.x), Y(f.h1.lo)]])}Z"/>`;
    const mids = [P0];
    if (f.h1) mids.push([X(f.h1.x), Y(f.h1.mid)]);
    if (f.h3) mids.push([X(f.h3.x), Y(f.h3.mid)]);
    s += `<path class="mid" d="${path(mids)}"/>`;
  }
  for (const se of o.series) {
    const pts = [];
    for (let i = 0; i < se.x.length; i++) if (finite(se.y[i])) pts.push([X(se.x[i]), Y(se.y[i])]);
    if (pts.length) s += `<path class="ln ${se.cls || ''}" d="${path(pts)}"/>`;
  }
  const main = o.series[0];
  if (main && main.x.length) {
    const i = main.x.length - 1;
    if (finite(main.y[i])) s += `<circle class="dot" cx="${X(main.x[i]).toFixed(1)}" cy="${Y(main.y[i]).toFixed(1)}" r="3.5"/>`;
  }
  return `${s}</svg>`;
}

/** Đường nhỏ trong bảng. */
export function sparkline(vals, w = 96, h = 26) {
  const v = vals.filter(finite);
  if (v.length < 2) return '';
  const lo = minOf(v);
  const hi = maxOf(v);
  const pts = v.map((y, i) => [1 + (i / (v.length - 1)) * (w - 4), 2 + (1 - (y - lo) / (hi - lo || 1)) * (h - 4)]);
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${path(pts)}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2"/></svg>`;
}

/** Biểu đồ hiệu chỉnh: xác suất dự báo trung bình (ngang) so với tần suất thực (dọc) theo nhóm xác suất. */
export function reliabilityChart(bins, size, title) {
  const w = Math.max(220, Math.min(380, Math.round(size)));
  const H = w;
  const used = bins.filter((b) => b.n >= 5 && finite(b.p) && finite(b.f));
  if (!used.length) return '<p class="note">Chưa đủ dự báo để vẽ.</p>';
  const vals = used.flatMap((b) => [b.p, b.f]);
  const lo = Math.max(0, Math.floor((minOf(vals) - 0.02) * 10) / 10);
  const hi = Math.min(1, Math.ceil((maxOf(vals) + 0.02) * 10) / 10);
  const m = { l: 40, r: 10, t: 10, b: 34 };
  const X = (x) => m.l + ((x - lo) / (hi - lo)) * (w - m.l - m.r);
  const Y = (y) => m.t + (1 - (y - lo) / (hi - lo)) * (H - m.t - m.b);
  const nMax = Math.max(...used.map((b) => b.n));
  let s = `<svg viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>`;
  for (let t = lo; t <= hi + 1e-9; t += 0.1) {
    const tt = Number(t.toFixed(2));
    s += `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${Y(tt)}" y2="${Y(tt)}"/><text x="${m.l - 5}" y="${Y(tt) + 4}" text-anchor="end">${pct(tt)}</text>`;
    s += `<line class="grid" x1="${X(tt)}" x2="${X(tt)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(tt)}" y="${H - m.b + 15}" text-anchor="middle">${pct(tt)}</text>`;
  }
  s += `<line class="diag" x1="${X(lo)}" y1="${Y(lo)}" x2="${X(hi)}" y2="${Y(hi)}"/>`;
  s += `<text x="${(m.l + w - m.r) / 2}" y="${H - 3}" text-anchor="middle">Xác suất dự báo</text>`;
  for (const b of used) {
    const r = 3 + 7 * Math.sqrt(b.n / nMax);
    s += `<circle class="dot" cx="${X(b.p).toFixed(1)}" cy="${Y(b.f).toFixed(1)}" r="${r.toFixed(1)}" opacity="0.8"><title>${esc(`Dự báo trung bình ${pct(b.p)}; xảy ra ${pct(b.f)}; ${b.n} dự báo`)}</title></circle>`;
  }
  return `${s}</svg>`;
}

/** Góc phần tư tăng trưởng × lạm phát; điểm rỗng là 3 tháng trước, mũi tên chỉ hướng dịch chuyển. */
export function quadrantChart(pts, size, title) {
  const w = Math.max(260, Math.min(520, Math.round(size)));
  const H = Math.round(w * 0.8);
  const vals = pts.flatMap((p) => [p.g, p.i, p.g3, p.i3]).filter(finite).map(Math.abs);
  const L = Math.max(1, Math.ceil((Math.max(0, ...vals) + 0.2) * 2) / 2);
  const m = { l: 34, r: 12, t: 12, b: 30 };
  const X = (x) => m.l + ((x + L) / (2 * L)) * (w - m.l - m.r);
  const Y = (y) => m.t + (1 - (y + L) / (2 * L)) * (H - m.t - m.b);
  let s = `<svg viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>`;
  s += `<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8Z" fill="currentColor"/></marker></defs>`;
  for (let t = -L; t <= L + 1e-9; t += L >= 2 ? 1 : 0.5) {
    s += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(t)}" y="${H - m.b + 14}" text-anchor="middle">${num(t, L >= 2 ? 0 : 1)}</text>`;
    s += `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${m.l - 5}" y="${Y(t) + 4}" text-anchor="end">${num(t, L >= 2 ? 0 : 1)}</text>`;
  }
  s += `<line class="axis" x1="${X(0)}" x2="${X(0)}" y1="${m.t}" y2="${H - m.b}"/><line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
  const corner = (x, y, anchor, text) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-weight="600">${esc(text)}</text>`;
  s += corner(w - m.r - 4, m.t + 12, 'end', 'Nóng') + corner(m.l + 4, m.t + 12, 'start', 'Đình lạm');
  s += corner(m.l + 4, H - m.b - 6, 'start', 'Chậm lại') + corner(w - m.r - 4, H - m.b - 6, 'end', 'Lý tưởng');
  s += `<text x="${(m.l + w - m.r) / 2}" y="${H - 2}" text-anchor="middle">Tăng trưởng (z) →</text>`;
  for (const p of pts) {
    if (!finite(p.g) || !finite(p.i)) continue;
    if (finite(p.g3) && finite(p.i3)) {
      s += `<circle class="dot hollow" cx="${X(p.g3).toFixed(1)}" cy="${Y(p.i3).toFixed(1)}" r="4"/>`;
      s += `<line class="arrow" style="color:var(--muted)" marker-end="url(#arr)" x1="${X(p.g3).toFixed(1)}" y1="${Y(p.i3).toFixed(1)}" x2="${X(p.g).toFixed(1)}" y2="${Y(p.i).toFixed(1)}"/>`;
    }
    s += `<circle class="dot" cx="${X(p.g).toFixed(1)}" cy="${Y(p.i).toFixed(1)}" r="5.5"><title>${esc(`${p.label}: tăng trưởng ${num(p.g, 2)}, lạm phát ${num(p.i, 2)}`)}</title></circle>`;
    s += `<text class="lbl" x="${(X(p.g) + 8).toFixed(1)}" y="${(Y(p.i) - 7).toFixed(1)}">${esc(p.label)}</text>`;
  }
  return `${s}</svg>`;
}
