// Mô hình xác suất: logistic ridge có offset (M2–M4), hiệu chỉnh Platt có co về đường chéo.
// Offset = logit(xác suất M1) nên khi không có tín hiệu, mô hình trở về M1.

import { sigmoid, logit } from './util.mjs';

/** Giải hệ đối xứng xác định dương A·x = b bằng Cholesky (A ghi đè). */
function cholSolve(A, b) {
  const n = b.length;
  const L = A.map((r) => r.slice());
  for (let j = 0; j < n; j++) {
    let s = L[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    if (s <= 1e-12) s = 1e-12;
    L[j][j] = Math.sqrt(s);
    for (let i = j + 1; i < n; i++) {
      let t = L[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / L[j][j];
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    let t = b[i];
    for (let k = 0; k < i; k++) t -= L[i][k] * y[k];
    y[i] = t / L[i][i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let t = y[i];
    for (let k = i + 1; k < n; k++) t -= L[k][i] * x[k];
    x[i] = t / L[i][i];
  }
  return x;
}

/**
 * Học logistic ridge có offset: tối thiểu Σ logloss(σ(offset + β0 + xβ), y) + λ/2·‖β‖² (kể cả β0).
 * Đặc trưng được chuẩn hóa theo tập học; giá trị thiếu (NaN) thành 0 sau chuẩn hóa.
 * @param {number[][]} X @param {number[]} y @param {number[]} offset @param {number} lambda
 * @returns {{mu:number[], sd:number[], beta:number[], n:number}}
 */
export function fitLogit(X, y, offset, lambda) {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const mu = new Array(p).fill(0);
  const sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let c = 0; let s = 0; let q = 0;
    for (let i = 0; i < n; i++) { const v = X[i][j]; if (Number.isFinite(v)) { c++; s += v; q += v * v; } }
    if (c > 1) { mu[j] = s / c; sd[j] = Math.sqrt(Math.max(q / c - mu[j] ** 2, 1e-12)); }
  }
  const Z = X.map((r) => [1, ...r.map((v, j) => (Number.isFinite(v) ? (v - mu[j]) / sd[j] : 0))]);
  const k = p + 1;
  let beta = new Array(k).fill(0);
  for (let it = 0; it < 30; it++) {
    const g = beta.map((b) => lambda * b);
    const H = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (__, b) => (a === b ? lambda : 0)));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      let eta = offset[i];
      for (let j = 0; j < k; j++) eta += beta[j] * z[j];
      const pr = sigmoid(eta);
      const r = pr - y[i];
      const w = Math.max(pr * (1 - pr), 1e-9);
      for (let a = 0; a < k; a++) {
        g[a] += r * z[a];
        const wa = w * z[a];
        for (let b = a; b < k; b++) H[a][b] += wa * z[b];
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
    const step = cholSolve(H, g);
    let maxStep = 0;
    beta = beta.map((b, j) => { maxStep = Math.max(maxStep, Math.abs(step[j])); return b - step[j]; });
    if (maxStep < 1e-8) break;
  }
  return { mu, sd, beta, n };
}

/**
 * Dự báo của mô hình logistic.
 * @param {{mu:number[], sd:number[], beta:number[]}} m @param {number[]} x @param {number} offset
 * @returns {number}
 */
export function predictLogit(m, x, offset) {
  let eta = offset + m.beta[0];
  for (let j = 0; j < x.length; j++) {
    const v = Number.isFinite(x[j]) ? (x[j] - m.mu[j]) / m.sd[j] : 0;
    eta += m.beta[j + 1] * v;
  }
  return sigmoid(eta);
}

/**
 * Đóng góp của từng đặc trưng vào logit (β·x chuẩn hóa), để hiển thị "đóng góp của nhân tố".
 * @param {{mu:number[], sd:number[], beta:number[]}} m @param {number[]} x @param {string[]} names
 * @returns {{name:string, value:number}[]}
 */
export function contributions(m, x, names) {
  return names.map((name, j) => ({
    name,
    value: m.beta[j + 1] * (Number.isFinite(x[j]) ? (x[j] - m.mu[j]) / m.sd[j] : 0),
  }));
}

/**
 * Học hiệu chỉnh Platt p' = σ(a·logit(p) + b) có phạt μ·((a−1)² + b²) để co về đường chéo.
 * @param {number[]} p @param {number[]} y @param {number} mu
 * @returns {{a:number, b:number, n:number}}
 */
export function fitPlatt(p, y, mu) {
  let a = 1; let b = 0;
  const L = p.map(logit);
  for (let it = 0; it < 50; it++) {
    let ga = mu * (a - 1); let gb = mu * b;
    let haa = mu; let hab = 0; let hbb = mu;
    for (let i = 0; i < L.length; i++) {
      const q = sigmoid(a * L[i] + b);
      const r = q - y[i];
      const w = Math.max(q * (1 - q), 1e-9);
      ga += r * L[i]; gb += r;
      haa += w * L[i] * L[i]; hab += w * L[i]; hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b, n: p.length };
}

/** Áp dụng hiệu chỉnh Platt. @param {{a:number,b:number}|null} c @param {number} p @returns {number} */
export function applyPlatt(c, p) {
  return c ? sigmoid(c.a * logit(p) + c.b) : p;
}
