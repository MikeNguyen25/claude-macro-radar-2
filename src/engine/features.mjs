// Đặc trưng tại ngày D (chỉ dùng số đã có tới D) và kết quả sau H ngày.

import { bisectRight, monthEndDay } from './util.mjs';
import { compositeAt, zAt } from './data.mjs';

/** Số quan sát tối thiểu trước D để tính đặc trưng giá. */
export const MIN_HISTORY_OBS = 260;
/** Giá cuối cùng phải cách D không quá số ngày này. */
export const MAX_PRICE_AGE_DAYS = 7;

/** Độ lệch chuẩn của biến động trong khoảng chỉ số [from, to]. */
function rangeStd(ret, from, to) {
  let n = 0; let s = 0; let q = 0;
  for (let i = Math.max(1, from); i <= to; i++) {
    const r = ret[i];
    if (Number.isFinite(r)) { n++; s += r; q += r * r; }
  }
  if (n < 20) return NaN;
  const m = s / n;
  return Math.sqrt(Math.max(q / n - m * m, 0));
}

/** Trung bình biến động trong khoảng chỉ số. */
function rangeMean(ret, from, to) {
  let n = 0; let s = 0;
  for (let i = Math.max(1, from); i <= to; i++) if (Number.isFinite(ret[i])) { n++; s += ret[i]; }
  return n ? s / n : 0;
}

/**
 * Chỉ số quan sát cuối cùng có ngày ≤ day.
 * @param {import('./data.mjs').Asset} A @param {number} day
 * @returns {number}
 */
export function idxAt(A, day) {
  return bisectRight(A.days, day) - 1;
}

/**
 * Đặc trưng giá của tài sản tại ngày D. Biến động chuẩn hóa theo độ biến động mỗi quan sát.
 * @param {import('./data.mjs').Asset} A @param {number} day
 * @returns {null|{i:number, px:number, pxDate:string, r1:number, r3:number, r12:number, dsma:number,
 *   volRatio:number, sObs:number, muObs:number, obsPerDay:number}}
 */
export function assetFeatures(A, day) {
  const i = idxAt(A, day);
  if (i < MIN_HISTORY_OBS || day - A.days[i] > MAX_PRICE_AGE_DAYS) return null;
  const px = A.vals[i];
  const isPrice = A.kind === 'price';
  const chg = (j) => (isPrice ? Math.log(px / A.vals[j]) : px - A.vals[j]);
  const sObs = rangeStd(A.ret, i - 251, i);
  if (!(sObs > 0)) return null;
  const jYear = idxAt(A, day - 365);
  const obsPerDay = Math.max((i - jYear) / 365, 1 / 7);
  const scaled = (k) => {
    const j = idxAt(A, day - k);
    if (j < 0 || j >= i) return 0;
    return chg(j) / (sObs * Math.sqrt(Math.max(i - j, 1)));
  };
  // giá so với trung bình 10 điểm cuối tháng gần nhất đã khép (tháng hiện tại chưa hết thì không tính,
  // kể cả khi số liệu dừng giữa tháng: như vậy kết quả không phụ thuộc số liệu sau ngày D)
  const me = A.meIdx;
  let k = bisectRight(me, i) - 1;
  while (k >= 0 && monthEndDay(A.days[me[k]]) > day) k--;
  let dsma = 0;
  if (k >= 9) {
    let s = 0;
    for (let t = k - 9; t <= k; t++) s += A.vals[me[t]];
    const sma = s / 10;
    const raw = isPrice ? Math.log(px / sma) : px - sma;
    dsma = raw / (sObs * Math.sqrt(105));
  }
  const s63 = rangeStd(A.ret, i - 62, i);
  const s756 = rangeStd(A.ret, i - 755, i);
  return {
    i, px, pxDate: A.dates[i],
    r1: scaled(30), r3: scaled(91), r12: scaled(365), dsma,
    volRatio: s63 > 0 && s756 > 0 ? Math.log(s63 / s756) : 0,
    sObs, muObs: isPrice ? rangeMean(A.ret, i - 755, i) : 0, obsPerDay,
  };
}

/**
 * Kết quả sau H ngày tính từ D: biến động (log với giá, hiệu số với lợi suất), tăng hay không,
 * và ngày biết kết quả. Null nếu chưa có số đủ sau D + H.
 * @param {import('./data.mjs').Asset} A @param {number} day @param {number} H
 * @returns {null|{ret:number, up:0|1, knownDay:number, px0:number, px1:number, date1:string}}
 */
export function outcome(A, day, H) {
  const i0 = idxAt(A, day);
  const target = day + H;
  if (i0 < 0 || A.days[A.days.length - 1] < target) return null;
  const i1 = idxAt(A, target);
  if (i1 <= i0 || target - A.days[i1] > MAX_PRICE_AGE_DAYS) return null;
  const ret = A.kind === 'price' ? Math.log(A.vals[i1] / A.vals[i0]) : A.vals[i1] - A.vals[i0];
  return { ret, up: ret > 0 ? 1 : 0, knownDay: Math.max(target, A.days[i1]) + 1, px0: A.vals[i0], px1: A.vals[i1], date1: A.dates[i1] };
}

/** Các khóa điểm tổng hợp dùng trong mô hình và kịch bản. */
export const MACRO_KEYS = [
  'us.growth', 'us.inflation', 'us.policy', 'us.fincond', 'us.credit', 'us.usd', 'us.curve',
  'cn.growth', 'cn.inflation', 'cn.policy', 'vn.growth', 'vn.fx', 'vn.inflation',
  'world.growth', 'world.policy', 'world.inflation',
];

/** Chuỗi dùng cho đặc trưng chế độ rủi ro. */
export const RISK_SERIES = { 'risk.vix': 'mkt_vix', 'risk.nfci': 'us_nfci', 'risk.credit': 'us_baa10y', 'risk.curve': 'us_10y3m' };

/**
 * Điểm tổng hợp vĩ mô và z của chuỗi rủi ro tại ngày D (có bộ nhớ đệm theo ngày).
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {number} day @param {Map} [cache]
 * @returns {{macro: Record<string, number|null>, risk: Record<string, number|null>}}
 */
export function contextAt(data, day, cache) {
  if (cache && cache.has(day)) return cache.get(day);
  const macro = {};
  for (const key of MACRO_KEYS) {
    const [region, factor] = key.split('.');
    macro[key] = compositeAt(data, region, factor, day).value;
  }
  const risk = {};
  for (const [key, sid] of Object.entries(RISK_SERIES)) {
    const s = data.series.get(sid);
    risk[key] = s ? zAt(s, day) : null;
  }
  const ctx = { macro, risk };
  if (cache) cache.set(day, ctx);
  return ctx;
}

/**
 * Véc-tơ đặc trưng theo danh sách tên; thiếu số thì NaN (mô hình thay bằng trung bình tập học).
 * @param {string[]} names @param {{f:object, macro:object, risk:object}} row
 * @returns {number[]}
 */
export function featureVector(names, row) {
  return names.map((n) => {
    const v = n.startsWith('risk.') ? row.risk[n] : n.includes('.') ? row.macro[n] : row.f[n];
    return v === null || v === undefined ? NaN : v;
  });
}
