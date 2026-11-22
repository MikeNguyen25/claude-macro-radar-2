// Số liệu tổng hợp cho kiểm thử: bước ngẫu nhiên tất định (mulberry32), có thể cài tín hiệu xu hướng.

import fs from 'node:fs';
import path from 'node:path';

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Giá ngày làm việc từ 1999-01-04 tới `end`. phi > 0 cài tự tương quan của lợi suất tháng (tín hiệu xu hướng).
 */
export function synthAsset(id, group, seed, { phi = 0, vol = 0.055, end = '2026-11-20', start = '1999-01-04' } = {}) {
  const r = rng(seed);
  const d = [];
  const c = [];
  let px = 100;
  let prevM = 0;
  let curM = 0;
  let month = null;
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 864e5) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const m = iso(t).slice(0, 7);
    if (m !== month) { prevM = curM; curM = phi * prevM + vol * gauss(r); month = m; }
    px *= Math.exp(curM / 21 + 0.004 * gauss(r));
    d.push(iso(t));
    c.push(Math.round(px * 1e4) / 1e4);
  }
  return { schemaVersion: 1, id, name: id.toUpperCase(), group, kind: 'price', unit: 'điểm', forecast: true, source: { code: 'synth', name: 'tổng hợp', url: '' },
    segments: [{ code: 'synth', name: 'tổng hợp', url: '', from: d[0], to: d[d.length - 1] }], check: null, quarantine: [], d, c };
}

/** Chuỗi vĩ mô tháng nhiễu trắng (không mang thông tin). */
export function synthSeries(id, region, factor, seed, { end = '2026-10-01', start = '1995-01-01' } = {}) {
  const r = rng(seed);
  const d = [];
  const v = [];
  let x = 0;
  for (let y = +start.slice(0, 4), m = +start.slice(5, 7); `${y}-${String(m).padStart(2, '0')}-01` <= end; m === 12 ? (y++, m = 1) : m++) {
    x = 0.8 * x + gauss(r);
    d.push(`${y}-${String(m).padStart(2, '0')}-01`);
    v.push(Math.round(x * 1e4) / 1e4);
  }
  return { schemaVersion: 1, id, name: id, region, factor, sign: 1, transform: 'level', unit: 'z', freq: 'M', pubLagDays: 20, source: { code: 'synth', name: 'tổng hợp', url: '' }, d, v };
}

export function synthRaw({ phi = 0, seed = 1 } = {}) {
  const assets = [
    synthAsset('aaa', 'us_eq', seed + 1, { phi }), synthAsset('bbb', 'us_eq', seed + 2, { phi }),
    synthAsset('ccc', 'cmd_fx', seed + 3, { phi }), synthAsset('ddd', 'cmd_fx', seed + 4, { phi }),
  ];
  const series = [['us_g', 'us', 'growth'], ['us_i', 'us', 'inflation'], ['us_p', 'us', 'policy'], ['us_f', 'us', 'fincond'], ['us_c', 'us', 'credit'], ['us_u', 'us', 'usd'], ['w_g', 'world', 'growth']]
    .map(([id, rg, f], k) => synthSeries(id, rg, f, seed * 100 + k));
  return { assets, series };
}

export function loadRealRaw(dir = 'data') {
  const read = (sub) => fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, sub, f), 'utf8')));
  return { assets: read('prices'), series: read('series') };
}
