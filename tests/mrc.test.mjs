import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAi, bumpVersion, manualDue, saveState, daily, aiLayer, verifyAnalysisDoc, loadState, statusReport } from '../tools/mrc.mjs';

const live = [
  { a: 'btc', h: '1m', pc: 0.55, champ: 'M1', badge: 'none' },
  { a: 'gold', h: '1m', pc: 0.6, champ: 'M5', badge: 'strong' },
  { a: 'gold', h: '3m', pc: 0.62, champ: 'M5', badge: 'strong' },
];

test('luật AI: kẹp ±10 điểm, độ tự tin, đủ dữ kiện, đủ tài sản', () => {
  const { ai, issues } = validateAi({ headline: 'x', assets: [
    { id: 'btc', prob_up: 0.9, view: 'tang', confidence: 'cao', evidence: ['a 1', 'b 2'] },
    { id: 'gold', prob_up: 63, view: 'tang', confidence: 'cao', evidence: ['a'] },
    { id: 'xyz', prob_up: 0.5 },
  ] }, live);
  const btc = ai.assets.find((x) => x.id === 'btc');
  assert.equal(btc.prob_up, 0.65);
  assert.equal(btc.confidence, 'thap');
  const gold = ai.assets.find((x) => x.id === 'gold');
  assert.equal(gold.prob_up, 0.63, 'nhận cả dạng phần trăm');
  assert.equal(gold.confidence, 'cao', 'nhóm có cơ sở thì giữ độ tự tin');
  assert.ok(issues.some((s) => s.startsWith('gold: evidence')));
  assert.ok(issues.some((s) => s.startsWith('xyz:')));
  assert.equal(validateAi(null, live).ai, null);
});

test('version: patch, minor, rc', () => {
  assert.equal(bumpVersion('2.0.0', 'patch'), '2.0.1');
  assert.equal(bumpVersion('2.0.3', 'minor'), '2.1.0');
  assert.equal(bumpVersion('2.0.0-rc.1', 'minor'), '2.0.0-rc.2');
});

test('chuỗi nhập tay: đến hạn theo ngày công bố', () => {
  const due = manualDue([{ id: 'vn_cpi', d: ['2026-10-01'] }], '2026-11-22');
  assert.ok(!due.some((x) => x.id === 'vn_cpi'), 'CPI tháng 10 đã có');
  assert.ok(due.some((x) => x.id === 'vn_pmi' && x.period === '2026-10'));
  assert.equal(manualDue([], '2026-11-05').find((x) => x.id === 'vn_cpi').period, '2026-09');
});

test('sổ dự báo chỉ thêm: không ghi đè bản ghi đã có bằng nội dung khác', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  saveState(dir, { 'forecasts/2026-01-01': { hash: 'aaa' } });
  assert.deepEqual(saveState(dir, { 'forecasts/2026-01-01': { hash: 'aaa' } }), []);
  assert.throws(() => saveState(dir, { 'forecasts/2026-01-01': { hash: 'bbb' } }), /chỉ thêm/);
});

test('một ngày đầy đủ trên số liệu thật: dự báo, bỏ qua lần hai, lớp AI có hash', { timeout: 120000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  const st = path.join(tmp, 'state');
  const site = path.join(tmp, 'site');
  const r = daily({ data: 'data', state: st, site, today: '2026-11-20' });
  assert.equal(r.items, 28);
  assert.deepEqual(r.missing, []);
  assert.equal(r.version, '2.0.0');
  assert.match(daily({ data: 'data', state: st, site, today: '2026-11-20' }).skipped, /đã có/);
  const S = loadState(st);
  assert.ok(S['forecasts/2026-11-20'] && S['config/current'] && S['models/registry'] && S['versions/2.0.0']);
  assert.equal(statusReport({ state: st, site, today: '2026-11-20' }).forecastReady, true);
  for (const f of ['bundle.json', 'history.json', 'latest.json', 'ai_context.json']) assert.ok(fs.existsSync(path.join(site, f)), f);
  assert.ok(fs.statSync(path.join(site, 'ai_context.json')).size < 30 * 1024, 'ngữ cảnh AI dưới 30 KB');
  const aiFile = path.join(tmp, 'ai.json');
  fs.writeFileSync(aiFile, JSON.stringify({ headline: 'Thử', assets: [{ id: 'btc', prob_up: 0.5, view: 'trung_lap', confidence: 'thap', evidence: ['a', 'b'] }] }));
  const out = path.join(tmp, 'out');
  const res = aiLayer({ data: 'data', state: st, site, out, ai: aiFile });
  const ops = JSON.parse(fs.readFileSync(path.join(out, 'db_ops.json'), 'utf8'));
  const an = ops.find((x) => x.path === 'analyses/2026-11-20');
  assert.ok(an && verifyAnalysisDoc(an.data));
  assert.ok(ops.every((x) => JSON.stringify(x.data).length < 256 * 1024));
  assert.ok(res.message.split('\n').length <= 12);
  assert.ok(fs.existsSync(path.join(out, 'files', 'ledger', '2026-11-20.json')));
});
