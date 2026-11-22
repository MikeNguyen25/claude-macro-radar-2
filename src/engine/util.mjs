// Tiện ích thuần cho engine: ngày, thống kê, phân phối, băm, số ngẫu nhiên có seed.
// Không DOM, không mạng, không biến toàn cục có trạng thái. Chạy được trong trình duyệt và Node.

/** Số mili giây của một ngày. */
export const DAY_MS = 86_400_000;

/**
 * Ngày ISO 'YYYY-MM-DD' → số ngày kể từ 1970-01-01 (UTC).
 * @param {string} iso
 * @returns {number}
 */
export function toDay(iso) {
  return Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS);
}

/**
 * Số ngày kể từ 1970-01-01 → ngày ISO.
 * @param {number} day
 * @returns {string}
 */
export function fromDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Ngày cuối tháng (số ngày) của ngày đã cho.
 * @param {number} day
 * @returns {number}
 */
export function monthEndDay(day) {
  const d = new Date(day * DAY_MS);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / DAY_MS);
}

/**
 * Cộng số tháng vào ngày ISO đầu tháng ('YYYY-MM-01'), trả ngày ISO đầu tháng.
 * @param {string} iso
 * @param {number} k
 * @returns {string}
 */
export function addMonthsIso(iso, k) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1 + k, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Chỉ số phần tử đầu tiên > x trong mảng tăng dần (bisect right).
 * @param {ArrayLike<number>} arr
 * @param {number} x
 * @returns {number}
 */
export function bisectRight(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** @param {number[]} xs @returns {number} trung bình, NaN nếu rỗng */
export function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** @param {number[]} xs @returns {number} độ lệch chuẩn tổng thể */
export function std(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / xs.length);
}

/**
 * Phân vị (nội suy tuyến tính) của mảng.
 * @param {number[]} xs
 * @param {number} q trong [0, 1]
 * @returns {number}
 */
export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < s.length ? s[i] * (1 - f) + s[i + 1] * f : s[i];
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} */
export function clip(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** @param {number} p @returns {number} logit, p được kẹp trong (1e-9, 1 − 1e-9) */
export function logit(p) {
  const q = clip(p, 1e-9, 1 - 1e-9);
  return Math.log(q / (1 - q));
}

/** @param {number} z @returns {number} */
export function sigmoid(z) {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/**
 * Làm tròn tới d chữ số thập phân.
 * @param {number} x @param {number} [d=4]
 * @returns {number}
 */
export function round(x, d = 4) {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

// ------------------------------------------------------------------ phân phối

/** erfc (Numerical Recipes, sai số < 1.2e-7). @param {number} x @returns {number} */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Hàm phân phối chuẩn tắc Φ. @param {number} x @returns {number} */
export function normCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/**
 * Nghịch đảo Φ (thuật toán Acklam, thêm một bước Newton).
 * @param {number} p trong (0, 1)
 * @returns {number}
 */
export function normInv(p) {
  const q = clip(p, 1e-12, 1 - 1e-12);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x;
  if (q < pl) {
    const r = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  } else if (q <= 1 - pl) {
    const r = q - 0.5;
    const s = r * r;
    x = (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
  } else {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    x = -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  const e = normCdf(x) - q;
  return x - e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
}

/** ln Γ(x) (Lanczos). @param {number} x @returns {number} */
function logGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const gi of g) ser += gi / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Phân số liên tục cho hàm beta không đầy đủ. */
function betacf(a, b, x) {
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Hàm beta không đầy đủ chuẩn hóa I_x(a, b). */
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

/**
 * Hàm phân phối Student-t.
 * @param {number} t @param {number} nu bậc tự do
 * @returns {number}
 */
export function tCdf(t, nu) {
  const x = nu / (nu + t * t);
  const tail = 0.5 * ibeta(x, nu / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

const T_INV_CACHE = new Map();

/**
 * Nghịch đảo hàm phân phối Student-t (chia đôi khoảng, có bộ nhớ đệm).
 * @param {number} p trong (0, 1) @param {number} nu
 * @returns {number}
 */
export function tInv(p, nu) {
  const key = `${p}|${nu}`;
  if (T_INV_CACHE.has(key)) return T_INV_CACHE.get(key);
  let lo = -200;
  let hi = 200;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, nu) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  const v = (lo + hi) / 2;
  T_INV_CACHE.set(key, v);
  return v;
}

// ------------------------------------------------------------------ số ngẫu nhiên, băm

/**
 * Bộ sinh số giả ngẫu nhiên mulberry32 (tất định theo seed).
 * @param {number} seed
 * @returns {() => number} trả số trong [0, 1)
 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * JSON với khóa sắp xếp (để băm ổn định).
 * @param {unknown} v
 * @returns {string}
 */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * SHA-256 thuần JS của chuỗi (UTF-8), trả hex.
 * @param {string} str
 * @returns {string}
 */
export function sha256(str) {
  const bytes = new TextEncoder().encode(str);
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
    0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 4, bits >>> 0);
  dv.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
}
