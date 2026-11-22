import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastDoc, verifyForecastDoc, updateSummary, liveSkill, scoreMatured, prepare } from '../src/engine/index.mjs';
import { toDay } from '../src/engine/util.mjs';
import { synthAsset } from './helpers.mjs';

const live = { date: '2026-01-05', items: [{ a: 'aaa', g: 'us_eq', h: '1m', px: 100, pd: '2026-01-02', p: { M0: 0.5, M1: 0.6, M2: 0.55 }, champ: 'M1', q: [-0.1, 0, 0.1], pt: 0.1, ptBase: 0.12, k: 0.08, base: 0.6 }] };

test('sổ dự báo: hash kiểm được, sửa một số là lộ', () => {
  const doc = forecastDoc(live, { configVersion: 1, version: '2.0.0', createdAt: '2026-01-05T00:10:00Z' });
  assert.ok(verifyForecastDoc(doc));
  const bad = structuredClone(doc);
  bad.items[0].m.M1 = 0.61;
  assert.equal(verifyForecastDoc(bad), false);
  const later = { ...doc, createdAt: '2027-01-01T00:00:00Z' };
  assert.ok(verifyForecastDoc(later), 'createdAt không nằm trong hash');
});

test('chấm điểm: dùng giá đóng cửa gần nhất tại ngày tới hạn, mỗi dự báo chỉ cộng một lần', () => {
  const A = synthAsset('aaa', 'us_eq', 5, { start: '2025-01-01', end: '2026-03-01' });
  const data = prepare({ assets: [A], series: [] });
  const i0 = A.d.indexOf('2026-01-02');
  const doc = forecastDoc({ ...live, items: [{ ...live.items[0], px: A.c[i0] }] }, { configVersion: 1, version: '2.0.0', createdAt: 'x' });
  const { scored } = scoreMatured([doc], data, toDay('2026-02-10'));
  assert.equal(scored.length, 1);
  const target = A.d.filter((d) => d <= '2026-02-04').pop();
  assert.equal(scored[0].d1, target);
  const s1 = updateSummary(null, scored, [], '2026-02-10');
  const s2 = updateSummary(s1, scored, [], '2026-02-11');
  assert.equal(s2.cum['1m|us_eq'].models.M1[2], 1, 'không cộng trùng');
  assert.equal(s2.intervals['1m'].length, 1);
});

test('kỹ năng trực tiếp: mô hình tốt hơn M1 ở mọi khoảng thì BSS dương, p_better cao', () => {
  const s = { intervals: { '1m': Array.from({ length: 8 }, (_, k) => ({ fd: `2026-${String(k + 1).padStart(2, '0')}-01`, g: { us_eq: { M1: [2.0, 8], M2: [1.6, 8] } } })) } };
  const lv = liveSkill(s, '1m', 'us_eq', 'M2');
  assert.equal(lv.intervals, 8);
  assert.ok(lv.skill > 0.15);
  assert.ok(lv.pBetter > 0.99);
  assert.deepEqual(liveSkill(s, '3m', 'us_eq', 'M2'), { intervals: 0, skill: null, pBetter: null });
});
