// Kịch bản vĩ mô: góc phần tư tăng trưởng × lạm phát theo vùng, chế độ rủi ro, dịch chuyển 3 tháng.

import { contextAt } from './features.mjs';
import { fromDay, monthEndDay, round } from './util.mjs';

/** Tên vùng. */
export const REGION_NAMES = { us: 'Mỹ', cn: 'Trung Quốc', vn: 'Việt Nam', world: 'Thế giới' };

/** Nhãn góc phần tư. */
export const QUADRANTS = {
  goldilocks: 'Tăng trưởng tốt, lạm phát hạ',
  overheat: 'Tăng trưởng nóng, lạm phát lên',
  stagflation: 'Tăng trưởng yếu, lạm phát lên',
  slowdown: 'Tăng trưởng yếu, lạm phát hạ',
};

/** Ngưỡng điểm rủi ro: trên mức này là "tắt rủi ro", dưới mức kia là "bật rủi ro". */
export const RISK_OFF_Z = 0.5;
export const RISK_ON_Z = -0.25;

/** @param {number|null} g @param {number|null} i @returns {string|null} */
export function quadrant(g, i) {
  if (g === null || i === null) return null;
  if (g >= 0) return i < 0 ? 'goldilocks' : 'overheat';
  return i >= 0 ? 'stagflation' : 'slowdown';
}

/**
 * Kịch bản tại ngày T và 91 ngày trước; lịch sử theo tháng 36 tháng gần nhất.
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {number} T @param {Map} [cache]
 */
export function regimeReport(data, T, cache) {
  const at = (day) => contextAt(data, day, cache);
  const now = at(T);
  const ago = at(T - 91);
  const regions = {};
  for (const r of Object.keys(REGION_NAMES)) {
    const g = now.macro[`${r}.growth`];
    const i = now.macro[`${r}.inflation`];
    const g3 = ago.macro[`${r}.growth`];
    const i3 = ago.macro[`${r}.inflation`];
    const q = quadrant(g, i);
    regions[r] = {
      name: REGION_NAMES[r], growth: g === null ? null : round(g, 3), inflation: i === null ? null : round(i, 3),
      growth3m: g3 === null ? null : round(g3, 3), inflation3m: i3 === null ? null : round(i3, 3),
      dGrowth: g !== null && g3 !== null ? round(g - g3, 3) : null, dInflation: i !== null && i3 !== null ? round(i - i3, 3) : null,
      quadrant: q, label: q ? QUADRANTS[q] : 'Thiếu số liệu để xếp góc phần tư',
      policy: now.macro[`${r}.policy`] === undefined || now.macro[`${r}.policy`] === null ? null : round(now.macro[`${r}.policy`], 3),
    };
  }
  const riskParts = ['risk.vix', 'risk.nfci', 'risk.credit'].map((k) => now.risk[k]).filter((v) => v !== null);
  const score = riskParts.length ? riskParts.reduce((a, b) => a + b, 0) / riskParts.length : null;
  const state = score === null ? null : score > RISK_OFF_Z ? 'off' : score < RISK_ON_Z ? 'on' : 'neutral';
  const history = [];
  for (let k = 35; k >= 0; k--) {
    let day = T;
    for (let j = 0; j < k; j++) day = monthEndDay(day) - 31 < 0 ? day : monthEndDay(day - 31);
    const c = at(day);
    history.push({ date: fromDay(day), ...Object.fromEntries(Object.keys(REGION_NAMES).flatMap((r) => [
      [`${r}.g`, c.macro[`${r}.growth`] === null ? null : round(c.macro[`${r}.growth`], 3)],
      [`${r}.i`, c.macro[`${r}.inflation`] === null ? null : round(c.macro[`${r}.inflation`], 3)]])) });
  }
  return {
    asOf: fromDay(T), regions,
    risk: { score: score === null ? null : round(score, 3), state,
      label: state === 'off' ? 'Tắt rủi ro' : state === 'on' ? 'Bật rủi ro' : state === 'neutral' ? 'Trung tính' : 'Thiếu số liệu',
      parts: Object.fromEntries(Object.entries(now.risk).map(([k, v]) => [k, v === null ? null : round(v, 3)])) },
    macro: Object.fromEntries(Object.entries(now.macro).map(([k, v]) => [k, v === null ? null : round(v, 3)])),
    history,
  };
}
