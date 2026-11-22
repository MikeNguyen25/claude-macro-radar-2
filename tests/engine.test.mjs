import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine, fitGroupState, LookaheadError, DEFAULT_CONFIG, mergeConfig, prepare } from '../src/engine/index.mjs';
import { assetFeatures, contextAt } from '../src/engine/features.mjs';
import { toDay } from '../src/engine/util.mjs';
import { synthRaw, loadRealRaw } from './helpers.mjs';

test('nhiễu thuần: không mô hình nào được lên ngôi, mọi nhóm dùng M1', () => {
  const run = runEngine(synthRaw({ phi: 0, seed: 7 }), { today: '2026-11-20' });
  for (const [g, hs] of Object.entries(run.champions)) for (const [h, c] of Object.entries(hs)) assert.equal(c.model, 'M1', `${g} ${h} lên ngôi ${c.model} trên nhiễu`);
  for (const it of run.live.items) assert.equal(it.call, 0);
});

test('tín hiệu xu hướng cài sẵn: M2 thắng M1 rõ ràng', () => {
  const run = runEngine(synthRaw({ phi: 0.45, seed: 11 }), { today: '2026-11-20' });
  const sc = run.ev['1m'].groups.us_eq;
  assert.ok(sc.models.M2.skill > 0.01, `BSS của M2 = ${sc.models.M2.skill}`);
  assert.ok(sc.models.M2.pBetter >= 0.95, `p_better của M2 = ${sc.models.M2.pBetter}`);
  assert.notEqual(run.champions.us_eq['1m'].model, 'M1');
});

test('chống nhìn trước: dòng học chưa biết kết quả thì ném LookaheadError', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {});
  const D = toDay('2020-01-31');
  const row = { a: 'x', g: 'us_eq', D: D - 10, out: { '1m': { knownDay: D + 25, up: 1 } }, p1: { '1m': 0.5 } };
  assert.throws(() => fitGroupState('us_eq', '1m', D, [row], [], cfg), LookaheadError);
  const ok = { ...row, D: D - 40, out: { '1m': { knownDay: D - 9, up: 1 } } };
  assert.doesNotThrow(() => fitGroupState('us_eq', '1m', D, [ok], [], cfg));
});

test('chống nhìn trước: cắt số liệu sau ngày T không đổi đặc trưng và điểm vĩ mô tại T', () => {
  const raw = loadRealRaw();
  const T = '2020-03-13';
  const full = prepare(raw);
  const cut = (doc) => {
    if (doc.c) { const k = doc.d.filter((d) => d <= T).length; return { ...doc, d: doc.d.slice(0, k), c: doc.c.slice(0, k), quarantine: (doc.quarantine || []).filter((q) => q.date <= T) }; }
    return doc;
  };
  const truncAssets = prepare({ assets: raw.assets.map(cut), series: raw.series });
  for (const id of ['spx', 'btc', 'vni', 'gold', 'ust10y']) {
    const a = assetFeatures(full.assets.get(id), toDay(T));
    const b = assetFeatures(truncAssets.assets.get(id), toDay(T));
    assert.deepEqual(a, b, `đặc trưng ${id} đổi khi cắt giá sau ${T}`);
  }
  const ctxFull = contextAt(full, toDay(T));
  // cắt mọi điểm vĩ mô công bố sau T: điểm tổng hợp tại T phải giữ nguyên
  const fullSeries = new Map([...full.series.values()].map((s) => [s.id, s]));
  const rawCut = raw.series.map((s) => {
    const p = fullSeries.get(s.id);
    if (!p) return s;
    const keep = s.d.map((d, i) => (p.dates.indexOf(d) >= 0 ? p.avail[p.dates.indexOf(d)] : Infinity) <= toDay(T));
    return { ...s, d: s.d.filter((_, i) => keep[i]), v: s.v.filter((_, i) => keep[i]) };
  });
  const ctxCut = contextAt(prepare({ assets: raw.assets, series: rawCut }), toDay(T));
  assert.deepEqual(ctxCut, ctxFull);
});

test('tất định: hai lần chạy cùng số liệu cho cùng dự báo', () => {
  const raw = synthRaw({ phi: 0.2, seed: 3 });
  const a = runEngine(raw, { today: '2026-11-20' });
  const b = runEngine(raw, { today: '2026-11-20' });
  assert.deepEqual(a.live.items, b.live.items);
  assert.deepEqual(a.cfg.tail, b.cfg.tail);
});
