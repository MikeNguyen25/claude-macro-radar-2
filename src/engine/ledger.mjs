// Sổ dự báo bất biến (forecasts/<D>, có hash), chấm điểm khi tới hạn, điểm tạm P₇, điểm cộng dồn
// và kỹ năng trực tiếp trên các khoảng không trùng nhau.

import { HORIZONS, SCHEMA_VERSION, ENGINE_VERSION } from './config.mjs';
import { sha256, canonical, toDay, fromDay, normCdf, normInv, round, rng } from './util.mjs';
import { idxAt, MAX_PRICE_AGE_DAYS } from './features.mjs';
import { brier, logScore, p7 } from './scoring.mjs';

/** Số ngày sau ngày đáo hạn mà dự báo chưa chấm được thì bỏ (thiếu giá). */
export const SCORE_GIVE_UP_DAYS = 10;

/**
 * Tạo doc sổ dự báo của ngày từ kết quả dự báo trực tiếp; hash tính trên toàn bộ nội dung trừ
 * createdAt và hash.
 * @param {{date:string, items:object[]}} live
 * @param {{configVersion:number, version:string, createdAt:string, ai?:object|null, shadow?:object[]}} meta
 * @returns {object}
 */
export function forecastDoc(live, meta) {
  const items = live.items.map((it) => ({ a: it.a, g: it.g, h: it.h, px: it.px, pd: it.pd, m: it.p, champ: it.champ,
    q: it.q, pt: it.pt, ptBase: it.ptBase, k: it.k, base: it.base }));
  const body = { schemaVersion: SCHEMA_VERSION, date: live.date, engineVersion: ENGINE_VERSION,
    appVersion: meta.version, configVersion: meta.configVersion, items, ai: meta.ai || null, shadow: meta.shadow || [] };
  return { ...body, createdAt: meta.createdAt, hash: sha256(canonical(body)) };
}

/** Kiểm tra hash của doc sổ dự báo. @param {object} doc @returns {boolean} */
export function verifyForecastDoc(doc) {
  const { hash, createdAt, ...body } = doc;
  return sha256(canonical(body)) === hash;
}

/**
 * Chấm các dự báo đã tới hạn trong các doc. Trả dự báo đã chấm và dự báo còn chờ (giá chưa về).
 * @param {object[]} docs @param {ReturnType<import('./data.mjs').prepare>} data @param {number} T
 */
export function scoreMatured(docs, data, T) {
  const scored = [];
  const waiting = [];
  for (const doc of docs) {
    const Df = toDay(doc.date);
    for (const it of doc.items) {
      const H = HORIZONS.find((h) => h.id === it.h).days;
      const target = Df + H;
      if (T < target) continue;
      const A = data.assets.get(it.a);
      const i1 = A ? idxAt(A, target) : -1;
      if (!A || A.days[A.days.length - 1] < target || i1 < 0 || target - A.days[i1] > MAX_PRICE_AGE_DAYS) {
        if (T <= target + SCORE_GIVE_UP_DAYS) waiting.push({ fd: doc.date, a: it.a, h: it.h });
        continue;
      }
      const px1 = A.vals[i1];
      const ret = A.kind === 'price' ? Math.log(px1 / it.px) : px1 - it.px;
      const y = ret > 0 ? 1 : 0;
      const models = {};
      for (const [m, p] of Object.entries(it.m)) if (Number.isFinite(p)) models[m] = { p, b: round(brier(p, y), 6), l: round(logScore(p, y), 6) };
      const tail = it.k === null || it.k === undefined ? null : ret < -it.k ? 1 : 0;
      scored.push({ fd: doc.date, a: it.a, g: it.g, h: it.h, champ: it.champ, px: it.px, px1, d1: A.dates[i1],
        ret: round(ret, 6), y, models, inBand: ret >= it.q[0] && ret <= it.q[2], q: it.q, tail,
        ptB: tail === null || it.pt === null ? null : round(brier(it.pt, tail), 6),
        ptBaseB: tail === null || it.ptBase === null ? null : round(brier(it.ptBase, tail), 6) });
    }
  }
  return { scored, waiting };
}

/**
 * Điểm tạm sau 7 ngày: quy xác suất về 7 ngày, P₇ = Φ(Φ⁻¹(P)·√(7/H)), so với biến động 7 ngày.
 * @param {object} doc @param {ReturnType<import('./data.mjs').prepare>} data
 */
export function scoreProvisional7(doc, data) {
  const out = [];
  const Df = toDay(doc.date);
  for (const it of doc.items) {
    const A = data.assets.get(it.a);
    if (!A || A.days[A.days.length - 1] < Df + 7) continue;
    const i1 = idxAt(A, Df + 7);
    if (i1 < 0) continue;
    const ret = A.kind === 'price' ? Math.log(A.vals[i1] / it.px) : A.vals[i1] - it.px;
    const y = ret > 0 ? 1 : 0;
    const H = HORIZONS.find((h) => h.id === it.h).days;
    const models = {};
    for (const [m, p] of Object.entries(it.m)) {
      if (!Number.isFinite(p)) continue;
      const q = p7(p, H, normCdf, normInv);
      models[m] = { p7: round(q, 4), b: round(brier(q, y), 6) };
    }
    out.push({ fd: doc.date, a: it.a, g: it.g, h: it.h, ret7: round(ret, 6), y, models });
  }
  return out;
}

/** Tóm tắt rỗng. */
export function emptySummary() {
  return { schemaVersion: SCHEMA_VERSION, cum: {}, intervals: {}, p7: {}, done: {}, lastInterval: {}, updated: null };
}

/**
 * Cập nhật điểm cộng dồn: tổng Brier, log score, số dự báo theo kỳ hạn|nhóm|mô hình; các khoảng
 * không trùng nhau (chọn tham lam: ngày dự báo cách ngày đã chọn trước ≥ H ngày); điểm tạm P₇.
 * Mỗi dự báo chỉ được cộng một lần (khóa ngày|tài sản|kỳ hạn).
 * @param {object|null} summary @param {object[]} scored @param {object[]} p7s @param {string} today
 * @returns {object}
 */
export function updateSummary(summary, scored, p7s, today) {
  const s = summary ? structuredClone(summary) : emptySummary();
  const newByFd = new Map();
  for (const x of scored) {
    const key = `${x.fd}|${x.a}|${x.h}`;
    if (s.done[key]) continue;
    s.done[key] = 1;
    const ck = `${x.h}|${x.g}`;
    const c = (s.cum[ck] ??= { models: {}, band: [0, 0], tail: [0, 0, 0] });
    for (const [m, v] of Object.entries(x.models)) {
      const t = (c.models[m] ??= [0, 0, 0]);
      t[0] += v.b; t[1] += v.l; t[2] += 1;
    }
    c.band[0] += x.inBand ? 1 : 0; c.band[1] += 1;
    if (x.ptB !== null) { c.tail[0] += x.ptB; c.tail[1] += x.ptBaseB; c.tail[2] += 1; }
    const nk = `${x.h}|${x.fd}`;
    (newByFd.get(nk) || newByFd.set(nk, []).get(nk)).push(x);
  }
  const sortedKeys = [...newByFd.keys()].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]));
  for (const nk of sortedKeys) {
    const [h, fd] = nk.split('|');
    const H = HORIZONS.find((x) => x.id === h).days;
    const last = s.lastInterval[h];
    if (last && toDay(fd) < toDay(last) + H) continue;
    s.lastInterval[h] = fd;
    const byG = {};
    for (const x of newByFd.get(nk)) {
      const gg = (byG[x.g] ??= {});
      for (const [m, v] of Object.entries(x.models)) { const t = (gg[m] ??= [0, 0]); t[0] += v.b; t[1] += 1; }
    }
    (s.intervals[h] ??= []).push({ fd, g: byG });
  }
  for (const x of p7s) {
    const key = `p7|${x.fd}|${x.a}|${x.h}`;
    if (s.done[key]) continue;
    s.done[key] = 1;
    const ck = `${x.h}|${x.g}`;
    const c = (s.p7[ck] ??= {});
    for (const [m, v] of Object.entries(x.models)) { const t = (c[m] ??= [0, 0]); t[0] += v.b; t[1] += 1; }
  }
  // Dọn khóa đã chấm: chỉ cần giữ trong cửa sổ có thể chấm lại (tới hạn + SCORE_GIVE_UP_DAYS + 2 ngày),
  // để doc luôn nhỏ (giới hạn 256 KiB mỗi doc).
  const T = toDay(today);
  for (const k of Object.keys(s.done)) {
    const parts = k.split('|');
    const isP7 = parts[0] === 'p7';
    const fd = isP7 ? parts[1] : parts[0];
    const h = isP7 ? null : parts[2];
    const H = isP7 ? 7 : HORIZONS.find((x) => x.id === h)?.days ?? 91;
    if (toDay(fd) + H + SCORE_GIVE_UP_DAYS + 2 < T) delete s.done[k];
  }
  s.updated = today;
  return s;
}

/**
 * Kỹ năng trực tiếp của mô hình so với M1 trên các khoảng không trùng nhau (có thể chỉ lấy n khoảng cuối).
 * @param {object} summary @param {string} h @param {string|null} g nhóm, null = mọi nhóm
 * @param {string} model @param {number} [lastN]
 * @returns {{intervals:number, skill:number|null, pBetter:number|null}}
 */
export function liveSkill(summary, h, g, model, lastN) {
  let iv = (summary?.intervals?.[h] || []).filter((x) => (g ? x.g[g] : true));
  if (lastN) iv = iv.slice(-lastN);
  const lm = []; const lr = [];
  for (const x of iv) {
    let bm = 0; let br = 0; let n = 0;
    for (const [gg, ms] of Object.entries(x.g)) {
      if (g && gg !== g) continue;
      if (!ms[model] || !ms.M1) continue;
      bm += ms[model][0]; br += ms.M1[0]; n += ms.M1[1];
    }
    if (n) { lm.push(bm); lr.push(br); }
  }
  if (!lm.length) return { intervals: 0, skill: null, pBetter: null };
  const sm = lm.reduce((a, b) => a + b, 0);
  const sr = lr.reduce((a, b) => a + b, 0);
  let better = 0;
  const r = rng(7);
  const B = 2000;
  for (let b = 0; b < B; b++) {
    let am = 0; let ar = 0;
    for (let k = 0; k < lm.length; k++) { const j = Math.floor(r() * lm.length); am += lm[j]; ar += lr[j]; }
    if (am < ar) better++;
  }
  return { intervals: lm.length, skill: sr > 0 ? round(1 - sm / sr, 5) : null, pBetter: round(better / B, 4) };
}
