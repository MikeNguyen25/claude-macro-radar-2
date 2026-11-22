// Chuẩn hóa số liệu đầu vào cho engine: giá theo ngày, chuỗi vĩ mô theo kỳ, ngày công bố,
// biến đổi (yoy, thay đổi 6 tháng...), z-score cửa sổ mở rộng và điểm tổng hợp theo nhân tố.
// Mọi giá trị dùng tại ngày D chỉ lấy điểm có ngày công bố ≤ D (chống nhìn trước).

import { toDay, monthEndDay, addMonthsIso, bisectRight, clip } from './util.mjs';

/** Số ngày tối đa một chuỗi được coi là còn hiệu lực sau ngày công bố, theo tần suất. */
export const MAX_STALE_DAYS = { D: 30, W: 45, M: 120, Q: 250 };
/** Số quan sát tối thiểu để tính z-score. */
export const MIN_Z_OBS = 24;
/** |z| bị kẹp trong ±Z_CLIP. */
export const Z_CLIP = 4;

/**
 * @typedef {object} Asset
 * @property {string} id
 * @property {string} name
 * @property {string} group
 * @property {'price'|'yield'|'level'} kind
 * @property {string[]} dates
 * @property {Int32Array} days
 * @property {Float64Array} vals
 * @property {Float64Array} ret   biến động mỗi quan sát (log với giá, hiệu số với lợi suất)
 * @property {number[]} meIdx     chỉ số quan sát cuối mỗi tháng
 */

/**
 * Chuẩn bị một tài sản từ file data/prices/<id>.json; bỏ điểm bị cách ly và giá không hợp lệ.
 * @param {object} doc
 * @returns {Asset}
 */
export function prepAsset(doc) {
  const quarantined = new Set((doc.quarantine || []).map((q) => q.date));
  const dates = [];
  const vals = [];
  for (let i = 0; i < doc.d.length; i++) {
    const v = doc.c[i];
    if (quarantined.has(doc.d[i]) || !Number.isFinite(v)) continue;
    if (doc.kind === 'price' && v <= 0) continue;
    dates.push(doc.d[i]);
    vals.push(v);
  }
  const days = Int32Array.from(dates, toDay);
  const v = Float64Array.from(vals);
  const ret = new Float64Array(v.length).fill(NaN);
  for (let i = 1; i < v.length; i++) ret[i] = doc.kind === 'price' ? Math.log(v[i] / v[i - 1]) : v[i] - v[i - 1];
  const meIdx = [];
  for (let i = 0; i < days.length; i++) {
    if (i === days.length - 1 || monthEndDay(days[i]) !== monthEndDay(days[i + 1])) meIdx.push(i);
  }
  return {
    id: doc.id, name: doc.name, group: doc.group, kind: doc.kind, unit: doc.unit, forecast: !!doc.forecast,
    source: doc.source, segments: doc.segments || [], check: doc.check || null, quarantine: doc.quarantine || [],
    dates, days, vals: v, ret, meIdx, ewma: new Map(),
  };
}

/** Ngày cuối kỳ (số ngày) của một điểm chuỗi theo tần suất. */
function periodEnd(iso, freq, periodEndRule) {
  const day = toDay(iso);
  if (freq === 'M') return monthEndDay(day);
  if (freq === 'Q') return periodEndRule === 'month' ? monthEndDay(day) : monthEndDay(toDay(addMonthsIso(iso.slice(0, 8) + '01', 2)));
  return day; // D, W: ngày của điểm là ngày kết thúc kỳ
}

/** Chỉ số điểm cách điểm i khoảng `back` ngày (sai số tol), hoặc -1. */
function backIndex(pdays, i, back, tol) {
  const target = pdays[i] - back;
  const j = bisectRight(pdays, target + tol) - 1;
  return j >= 0 && j < i && pdays[j] >= target - tol ? j : -1;
}

const TOL = { D: 5, W: 4, M: 5, Q: 6 };

/**
 * Biến đổi giá trị chuỗi cho mô hình.
 * @param {Float64Array} v @param {Int32Array} pdays @param {string} transform @param {string} freq
 * @returns {Float64Array}
 */
export function transformSeries(v, pdays, transform, freq) {
  const n = v.length;
  const x = new Float64Array(n).fill(NaN);
  const tol = TOL[freq] ?? 5;
  for (let i = 0; i < n; i++) {
    if (transform === 'level') { x[i] = v[i]; continue; }
    if (transform === 'level50') { x[i] = v[i] - 50; continue; }
    const back = transform === 'yoy' ? (freq === 'W' ? 364 : 365) : 182;
    const j = backIndex(pdays, i, back, tol);
    if (j < 0) continue;
    if (transform === 'chg6') x[i] = v[i] - v[j];
    else if (v[j] > 0 && v[i] > 0) x[i] = (v[i] / v[j] - 1) * 100; // yoy, pct6
  }
  return x;
}

/**
 * @typedef {object} Series
 * @property {string} id
 * @property {string} region
 * @property {string} factor
 * @property {number} sign
 * @property {Int32Array} avail  ngày công bố (số ngày) của từng điểm
 * @property {Float64Array} x    giá trị đã biến đổi
 */

/**
 * Chuẩn bị chuỗi vĩ mô; tính ngày công bố = cuối kỳ + pubLagDays; tổng tích lũy để tính z nhanh.
 * @param {object} doc
 * @returns {Series}
 */
export function prepSeries(doc) {
  const n = doc.d.length;
  const pdays = new Int32Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pdays[i] = periodEnd(doc.d[i], doc.freq, doc.periodEnd);
    v[i] = Number.isFinite(doc.v[i]) ? doc.v[i] : NaN;
  }
  const lag = doc.pubLagDays ?? 1;
  const avail = Int32Array.from(pdays, (p) => p + lag);
  const x = transformSeries(v, pdays, doc.transform, doc.freq);
  const cnt = new Float64Array(n);
  const sum = new Float64Array(n);
  const sq = new Float64Array(n);
  const lastValid = new Int32Array(n).fill(-1);
  let c = 0; let s = 0; let q = 0; let lv = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(x[i])) { c++; s += x[i]; q += x[i] * x[i]; lv = i; }
    cnt[i] = c; sum[i] = s; sq[i] = q; lastValid[i] = lv;
  }
  return {
    id: doc.id, name: doc.name, region: doc.region, factor: doc.factor, sign: doc.sign ?? 1,
    transform: doc.transform, unit: doc.unit, freq: doc.freq, lag, source: doc.source, manual: !!doc.manual,
    dates: doc.d, raw: v, pdays, avail, x, cnt, sum, sq, lastValid,
  };
}

/**
 * Điểm mới nhất đã công bố tại ngày `day` (còn hiệu lực theo tần suất), hoặc null.
 * @param {Series} s @param {number} day
 * @returns {{i:number, x:number, raw:number, date:string, availDay:number}|null}
 */
export function seriesAt(s, day) {
  const k = bisectRight(s.avail, day) - 1;
  if (k < 0) return null;
  const i = s.lastValid[k];
  if (i < 0 || day - s.avail[i] > (MAX_STALE_DAYS[s.freq] ?? 120)) return null;
  return { i, x: s.x[i], raw: s.raw[i], date: s.dates[i], availDay: s.avail[i] };
}

/**
 * z-score cửa sổ mở rộng của giá trị đã công bố tại ngày `day`, có dấu theo nhân tố, hoặc null.
 * @param {Series} s @param {number} day
 * @returns {number|null}
 */
export function zAt(s, day) {
  const at = seriesAt(s, day);
  if (!at) return null;
  const c = s.cnt[at.i];
  if (c < MIN_Z_OBS) return null;
  const m = s.sum[at.i] / c;
  const sd = Math.sqrt(Math.max(s.sq[at.i] / c - m * m, 0));
  if (!(sd > 0)) return null;
  return clip((at.x - m) / sd, -Z_CLIP, Z_CLIP);
}

/**
 * Chuỗi giả từ giá thị trường (VIX, DXY) để dùng trong điểm tổng hợp.
 * @param {Asset} a @param {object} meta {id, region, factor, sign, transform}
 * @returns {Series}
 */
export function seriesFromAsset(a, meta) {
  return prepSeries({ ...meta, name: a.name, unit: a.unit, freq: 'D', pubLagDays: 1, source: a.source,
    d: a.dates, v: Array.from(a.vals) });
}

/**
 * Chuẩn bị toàn bộ số liệu.
 * @param {{assets: object[], series: object[], manual?: object[]}} raw
 * @returns {{assets: Map<string, Asset>, series: Map<string, Series>, forecastAssets: Asset[], groups: string[]}}
 */
export function prepare(raw) {
  const assets = new Map();
  for (const doc of raw.assets || []) if (doc && doc.d && doc.d.length) assets.set(doc.id, prepAsset(doc));
  const series = new Map();
  for (const doc of [...(raw.series || []), ...(raw.manual || [])]) {
    if (doc && doc.d && doc.d.length) series.set(doc.id, prepSeries(doc));
  }
  const vix = assets.get('vix');
  if (vix) series.set('mkt_vix', seriesFromAsset(vix, { id: 'mkt_vix', region: 'us', factor: 'risk', sign: 1, transform: 'level' }));
  const dxy = assets.get('dxy');
  if (dxy) series.set('mkt_dxy', seriesFromAsset(dxy, { id: 'mkt_dxy', region: 'us', factor: 'usd', sign: 1, transform: 'pct6' }));
  const forecastAssets = [...assets.values()].filter((a) => a.forecast);
  const groups = [...new Set(forecastAssets.map((a) => a.group))];
  return { assets, series, forecastAssets, groups };
}

/**
 * Điểm tổng hợp của một nhân tố trong một vùng tại ngày `day`: trung bình z có dấu của các chuỗi.
 * Chuỗi nhập tay chưa đủ 36 điểm thì không dùng.
 * @param {ReturnType<typeof prepare>} data @param {string} region @param {string} factor @param {number} day
 * @returns {{value:number|null, parts:{id:string, z:number}[]}}
 */
export function compositeAt(data, region, factor, day) {
  const parts = [];
  for (const s of data.series.values()) {
    if (s.region !== region || s.factor !== factor) continue;
    if (s.manual && s.cnt[s.cnt.length - 1] < 36) continue;
    const z = zAt(s, day);
    if (z !== null) parts.push({ id: s.id, z: s.sign * z });
  }
  if (!parts.length) return { value: null, parts };
  return { value: parts.reduce((t, p) => t + p.z, 0) / parts.length, parts };
}
