// Thước đo chấm điểm dự báo xác suất và phân vị.

import { clip } from './util.mjs';

/** Brier của một dự báo. @param {number} p @param {0|1} y @returns {number} */
export function brier(p, y) {
  return (p - y) ** 2;
}

/** Log score (càng cao càng tốt), p kẹp trong [1e-6, 1 − 1e-6]. @param {number} p @param {0|1} y @returns {number} */
export function logScore(p, y) {
  const q = clip(p, 1e-6, 1 - 1e-6);
  return y ? Math.log(q) : Math.log(1 - q);
}

/**
 * Bảng hiệu chỉnh 10 nhóm và ECE (sai lệch hiệu chỉnh bình quân có trọng số).
 * @param {number[]} ps @param {number[]} ys @param {number} [bins=10]
 * @returns {{ece:number, table:{lo:number, hi:number, n:number, meanP:number|null, freq:number|null}[]}}
 */
export function calibration(ps, ys, bins = 10) {
  const table = Array.from({ length: bins }, (_, k) => ({ lo: k / bins, hi: (k + 1) / bins, n: 0, sp: 0, sy: 0 }));
  ps.forEach((p, i) => {
    const k = Math.min(bins - 1, Math.floor(p * bins));
    table[k].n++; table[k].sp += p; table[k].sy += ys[i];
  });
  let ece = 0;
  const N = ps.length || 1;
  const out = table.map((t) => {
    if (t.n) ece += (t.n / N) * Math.abs(t.sp / t.n - t.sy / t.n);
    return { lo: t.lo, hi: t.hi, n: t.n, meanP: t.n ? t.sp / t.n : null, freq: t.n ? t.sy / t.n : null };
  });
  return { ece, table: out };
}

/** Pinball loss của phân vị q ở mức tau. @param {number} q @param {number} tau @param {number} y @returns {number} */
export function pinball(q, tau, y) {
  return y >= q ? tau * (y - q) : (1 - tau) * (q - y);
}

/**
 * Hệ số tương quan hạng Spearman (xử lý hạng bằng nhau bằng hạng trung bình).
 * @param {number[]} a @param {number[]} b
 * @returns {number}
 */
export function spearman(a, b) {
  const rank = (xs) => {
    const idx = xs.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a); const rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * Xác suất quy về 7 ngày để chấm tạm: P₇ = Φ(Φ⁻¹(P)·√(7/H)).
 * @param {number} p @param {number} H số ngày của kỳ hạn
 * @param {(x:number)=>number} normCdf @param {(p:number)=>number} normInv
 * @returns {number}
 */
export function p7(p, H, normCdf, normInv) {
  return normCdf(normInv(p) * Math.sqrt(7 / H));
}
