// Vùng giá 80%: độ biến động EWMA × √(số quan sát trong kỳ hạn), phân phối Student-t (hoặc
// bootstrap phần dư chuẩn hóa), nhân hệ số phủ học từ quá khứ để độ phủ gần 80%.

import { tInv, tCdf, quantile } from './util.mjs';

/**
 * Phương sai EWMA theo từng quan sát (có bộ nhớ đệm theo λ trong đối tượng tài sản).
 * @param {import('./data.mjs').Asset} A @param {number} lambda
 * @returns {Float64Array}
 */
export function ewmaVar(A, lambda) {
  if (A.ewma.has(lambda)) return A.ewma.get(lambda);
  const n = A.ret.length;
  const out = new Float64Array(n).fill(NaN);
  let c = 0; let s = 0; let q = 0;
  for (let i = 1; i < n && c < 60; i++) if (Number.isFinite(A.ret[i])) { c++; s += A.ret[i]; q += A.ret[i] ** 2; }
  let v = c > 1 ? Math.max(q / c - (s / c) ** 2, 1e-12) : 1e-4;
  for (let i = 1; i < n; i++) {
    const r = A.ret[i];
    if (Number.isFinite(r)) v = lambda * v + (1 - lambda) * r * r;
    out[i] = v;
  }
  A.ewma.set(lambda, out);
  return out;
}

/**
 * Phân phối kết quả sau H ngày tại dòng có đặc trưng f.
 * @param {import('./data.mjs').Asset} A
 * @param {{i:number, muObs:number, obsPerDay:number}} f
 * @param {number} H số ngày
 * @param {object} params tham số engine (ewmaLambda, tDof, driftShrink)
 * @param {{cov?:number, zHist?:number[]|null, riskZ?:number|null, riskMult?:number, method?:string}} opt
 * @returns {{mu:number, sigH:number, scale:number, nu:number, q10:number, q50:number, q90:number, method:string, zHist:number[]|null}}
 */
export function bandAt(A, f, H, params, opt = {}) {
  const v = ewmaVar(A, params.ewmaLambda)[f.i];
  const sigH = Math.sqrt(Math.max(v, 1e-14) * f.obsPerDay * H);
  const mu = A.kind === 'price' ? params.driftShrink * f.muObs * f.obsPerDay * H : 0;
  const nu = params.tDof;
  const adj = Math.sqrt((nu - 2) / nu);
  let mult = opt.cov ?? 1;
  if (opt.riskMult && Number.isFinite(opt.riskZ)) mult *= Math.exp(opt.riskMult * opt.riskZ);
  const scale = mult * sigH * adj;
  if (opt.method === 'bootstrap' && opt.zHist && opt.zHist.length >= 60) {
    return { mu, sigH, scale, nu, method: 'bootstrap', zHist: opt.zHist,
      q10: mu + sigH * quantile(opt.zHist, 0.1), q50: mu + sigH * quantile(opt.zHist, 0.5), q90: mu + sigH * quantile(opt.zHist, 0.9) };
  }
  return { mu, sigH, scale, nu, method: 't', zHist: null, q10: mu + scale * tInv(0.1, nu), q50: mu, q90: mu + scale * tInv(0.9, nu) };
}

/**
 * Xác suất kết quả thấp hơn −k theo phân phối của vùng giá.
 * @param {ReturnType<typeof bandAt>} b @param {number} k
 * @returns {number}
 */
export function tailProb(b, k) {
  if (b.method === 'bootstrap') {
    const thr = (-k - b.mu) / b.sigH;
    return (b.zHist.filter((z) => z < thr).length + 0.5) / (b.zHist.length + 1);
  }
  return tCdf((-k - b.mu) / b.scale, b.nu);
}

/**
 * Hệ số phủ: tỷ lệ giữa phân vị 80% của |sai số chuẩn hóa| trong quá khứ và phân vị lý thuyết.
 * @param {{ret:number, mu:number, sigH:number}[]} past
 * @param {number} nu @param {[number, number]} clipRange @param {number} target độ phủ mục tiêu (0,8)
 * @returns {number}
 */
export function coverageFactor(past, nu, clipRange, target = 0.8) {
  if (past.length < 36) return 1;
  const adj = Math.sqrt((nu - 2) / nu);
  const z = past.map((r) => Math.abs(r.ret - r.mu) / (r.sigH * adj));
  const c = quantile(z, target) / tInv(0.5 + target / 2, nu);
  return Math.min(clipRange[1], Math.max(clipRange[0], c));
}
