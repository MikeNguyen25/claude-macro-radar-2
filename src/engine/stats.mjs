// Thống kê so sánh mô hình: bootstrap khối theo tháng, độ chắc tốt hơn (p_better), Diebold–Mariano.

import { rng, quantile, normCdf } from './util.mjs';

/**
 * Bootstrap khối so hai chuỗi điểm theo tháng (tổng Brier mỗi tháng của mô hình và của mốc).
 * @param {number[]} lossModel tổng loss mỗi tháng của mô hình
 * @param {number[]} lossRef tổng loss mỗi tháng của mốc (cùng tháng, cùng số dự báo)
 * @param {number} block độ dài khối (tháng)
 * @param {number} B số lần lặp
 * @param {number} seed
 * @returns {{skill:number, lo:number, hi:number, pBetter:number}} skill = 1 − Σmodel/Σref (BSS)
 */
export function blockBootstrapSkill(lossModel, lossRef, block, B, seed) {
  const T = lossModel.length;
  const sm = lossModel.reduce((s, v) => s + v, 0);
  const sr = lossRef.reduce((s, v) => s + v, 0);
  const skill = sr > 0 ? 1 - sm / sr : 0;
  if (T < 4) return { skill, lo: NaN, hi: NaN, pBetter: NaN };
  const L = Math.max(1, Math.min(block, T));
  const r = rng(seed);
  const skills = new Array(B);
  let better = 0;
  for (let b = 0; b < B; b++) {
    let am = 0; let ar = 0; let filled = 0;
    while (filled < T) {
      const start = Math.floor(r() * (T - L + 1));
      for (let k = 0; k < L && filled < T; k++, filled++) { am += lossModel[start + k]; ar += lossRef[start + k]; }
    }
    skills[b] = ar > 0 ? 1 - am / ar : 0;
    if (am < ar) better++;
  }
  return { skill, lo: quantile(skills, 0.025), hi: quantile(skills, 0.975), pBetter: better / B };
}

/**
 * Kiểm định Diebold–Mariano với sai số HAC Newey–West.
 * @param {number[]} d chênh loss mỗi tháng (mốc − mô hình; dương là mô hình tốt hơn)
 * @param {number} lag độ trễ (h − 1)
 * @returns {{stat:number, p:number}}
 */
export function dieboldMariano(d, lag) {
  const T = d.length;
  if (T < 8) return { stat: NaN, p: NaN };
  const m = d.reduce((s, v) => s + v, 0) / T;
  const gamma = (k) => {
    let s = 0;
    for (let t = k; t < T; t++) s += (d[t] - m) * (d[t - k] - m);
    return s / T;
  };
  let v = gamma(0);
  for (let k = 1; k <= lag; k++) v += 2 * (1 - k / (lag + 1)) * gamma(k);
  if (!(v > 0)) return { stat: NaN, p: NaN };
  const stat = m / Math.sqrt(v / T);
  return { stat, p: 2 * (1 - normCdf(Math.abs(stat))) };
}
