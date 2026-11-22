import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256, canonical, normCdf, normInv, tCdf, tInv, quantile } from '../src/engine/util.mjs';

test('sha256 khớp vector chuẩn và node:crypto (kể cả tiếng Việt)', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  for (const s of ['Xác suất tăng 55%', 'a'.repeat(1000), '{"k":[1,2,3]}', 'đ'.repeat(77)]) {
    assert.equal(sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('canonical sắp khóa ổn định, không phụ thuộc thứ tự', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.equal(canonical({ x: 1, y: { q: 2, p: 3 } }), canonical({ y: { p: 3, q: 2 }, x: 1 }));
});

test('phân phối chuẩn và Student-t: hàm ngược khớp', () => {
  for (const x of [-2.5, -1, 0, 0.3, 1.7]) assert.ok(Math.abs(normInv(normCdf(x)) - x) < 1e-6);
  for (const v of [3, 5, 30]) for (const x of [-2, -0.5, 0.8, 2.2]) assert.ok(Math.abs(tInv(tCdf(x, v), v) - x) < 1e-4);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
});

test('quantile nội suy tuyến tính', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.9), 5);
});
