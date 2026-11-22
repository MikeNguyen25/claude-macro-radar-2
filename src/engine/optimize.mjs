// Tối ưu tham số an toàn: tối đa 6 thay đổi; mỗi tham số nhích ≤ 15%, luôn trong ½–2 lần mặc định
// và khoảng cứng, không đảo dấu; Brier tập học giảm ≥ 0,002 (vùng giá: pinball giảm ≥ 0,2%);
// tập kiểm tra không xấu đi; cả bộ thay đổi tốt hơn bộ cũ với p_better ≥ 0,8.

import { PARAM_SPECS, HORIZONS, mergeConfig } from './config.mjs';
import { runBacktest } from './engine.mjs';
import { brier, pinball } from './scoring.mjs';
import { blockBootstrapSkill } from './stats.mjs';
import { round } from './util.mjs';

/** Tham số và loại mục tiêu dùng để chấm. M1 là điểm chuẩn nên không tối ưu. */
const TUNABLE = {
  lambdaM2: 'prob', lambdaM3: 'prob', lambdaM4: 'prob', plattPrior: 'prob', ensembleEta: 'prob', ensembleShrink: 'prob',
  ewmaLambda: 'band', tDof: 'band', driftShrink: 'band', tailMix: 'tail',
};
/** Mức giảm tương đối tối thiểu của pinball/Brier giảm sâu khi chấm tham số vùng giá và giảm sâu. */
const MIN_REL_GAIN = 0.002;

/** Loss theo tháng (tập học hoặc kiểm tra) của một kết quả kiểm định cho loại mục tiêu. */
function lossByMonth(bt, kind, months) {
  const by = new Map(months.map((m) => [m, 0]));
  for (const h of HORIZONS) {
    for (const r of bt[h.id].recs) {
      if (r.y === undefined || !r.ready || !by.has(r.m)) continue;
      let l = 0;
      if (kind === 'prob') l = ['M2', 'M3', 'M4', 'M5'].reduce((s, M) => s + brier(r.p[M], r.y), 0) / 4;
      else if (kind === 'band') l = pinball(r.q[0], 0.1, r.ret) + pinball(r.q[1], 0.5, r.ret) + pinball(r.q[2], 0.9, r.ret);
      else if (r.pt !== null && r.k !== undefined) l = brier(r.pt, r.ret < -r.k ? 1 : 0);
      by.set(r.m, by.get(r.m) + l);
    }
  }
  return months.map((m) => by.get(m));
}

function countByMonth(bt, months) {
  const by = new Map(months.map((m) => [m, 0]));
  for (const h of HORIZONS) for (const r of bt[h.id].recs) if (r.y !== undefined && r.ready && by.has(r.m)) by.set(r.m, by.get(r.m) + 1);
  return months.map((m) => by.get(m));
}

/**
 * Chạy tối ưu an toàn trên bảng dữ liệu đã dựng.
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {object} cfg
 * @param {ReturnType<import('./engine.mjs').buildPanel>} panel
 * @param {{onProgress?:(msg:string)=>void}} [opts]
 * @returns {{accepted:boolean, changes:{key:string, from:number, to:number, gain:number}[], tried:object[],
 *   pBetter:number|null, config:object, reason:string}}
 */
export function optimize(data, cfg, panel, opts = {}) {
  const g = cfg.gates;
  const base = runBacktest(data, cfg, panel);
  const months = [...new Set(base['1m'].recs.filter((r) => r.y !== undefined && r.ready).map((r) => r.m))].sort((a, b) => a - b);
  const test = months.slice(-cfg.testMonths);
  const train = months.slice(0, -cfg.testMonths);
  const n = countByMonth(base, train);
  const N = n.reduce((a, b) => a + b, 0) || 1;
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / N;
  const tried = [];
  const changes = [];
  let cur = cfg;
  let curBt = base;
  for (const spec of PARAM_SPECS) {
    const kind = TUNABLE[spec.key];
    if (!kind || changes.length >= g.optimizeMaxChanges) continue;
    const v0 = cur.params[spec.key];
    const lo = Math.max(spec.hard[0], spec.def / 2);
    const hi = Math.min(spec.hard[1], spec.def * 2);
    let best = null;
    for (const dir of [1 + g.optimizeStep, 1 - g.optimizeStep]) {
      const v = Math.min(hi, Math.max(lo, v0 * dir));
      if (v === v0 || Math.sign(v) !== Math.sign(v0)) continue;
      const cand = mergeConfig(cur, { params: { [spec.key]: v } });
      const bt = runBacktest(data, cand, panel);
      const trainNew = mean(lossByMonth(bt, kind, train));
      const trainOld = mean(lossByMonth(curBt, kind, train));
      const testNew = lossByMonth(bt, kind, test).reduce((a, b) => a + b, 0);
      const testOld = lossByMonth(curBt, kind, test).reduce((a, b) => a + b, 0);
      const gain = trainOld - trainNew;
      const ok = (kind === 'prob' ? gain >= g.optimizeMinGain : gain >= MIN_REL_GAIN * trainOld) && testNew <= testOld;
      tried.push({ key: spec.key, from: v0, to: round(v, 6), kind, trainOld: round(trainOld, 6), trainNew: round(trainNew, 6),
        testOld: round(testOld, 6), testNew: round(testNew, 6), ok });
      opts.onProgress?.(`${spec.key}: ${v0} → ${round(v, 4)} ${ok ? 'đạt' : 'không đạt'}`);
      if (ok && (!best || gain > best.gain)) best = { v, gain, bt, cand };
    }
    if (best) {
      changes.push({ key: spec.key, from: v0, to: round(best.v, 6), gain: round(best.gain, 6) });
      cur = best.cand;
      curBt = best.bt;
    }
  }
  if (!changes.length) return { accepted: false, changes, tried, pBetter: null, config: cfg, reason: 'không tham số nào đạt điều kiện' };
  const lossOld = lossByMonth(base, 'prob', months).map((v, i) => v + lossByMonth(base, 'tail', months)[i]);
  const lossNew = lossByMonth(curBt, 'prob', months).map((v, i) => v + lossByMonth(curBt, 'tail', months)[i]);
  const bs = blockBootstrapSkill(lossNew, lossOld, 3, cfg.bootstrap.B, cfg.bootstrap.seed);
  const accepted = bs.pBetter >= g.optimizePBetter;
  return { accepted, changes, tried, pBetter: round(bs.pBetter, 4), config: accepted ? cur : cfg,
    reason: accepted ? `bộ thay đổi tốt hơn bộ cũ với p_better ${round(bs.pBetter, 3)}` : `p_better ${round(bs.pBetter, 3)} < ${g.optimizePBetter}` };
}
