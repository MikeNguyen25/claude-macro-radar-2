// Điểm vào của engine: chạy kiểm định, chấm điểm, chọn nhà vô địch, dự báo trực tiếp, kịch bản;
// dựng hợp đồng public/latest và gói dữ liệu hiển thị cho trang.

import { DEFAULT_CONFIG, HORIZONS, GROUP_NAMES, MODEL_NAMES, ENGINE_VERSION, SCHEMA_VERSION, PARAM_SPECS, mergeConfig } from './config.mjs';
import { prepare, seriesAt, zAt } from './data.mjs';
import { buildPanel, runBacktest, evaluate, selectChampions, badgeFor, liveForecast, chooseTailThresholds } from './engine.mjs';
import { regimeReport } from './regime.mjs';
import { liveSkill } from './ledger.mjs';
import { toDay, fromDay, round } from './util.mjs';

export * from './config.mjs';
export { prepare } from './data.mjs';
export { buildPanel, runBacktest, evaluate, selectChampions, badgeFor, liveForecast, chooseTailThresholds, fitGroupState, LookaheadError } from './engine.mjs';
export { optimize } from './optimize.mjs';
export { runExperiment, SEED_EXPERIMENTS, postmortems, hypothesesFromPostmortems, promotionThreshold, promotionsFromCandidates } from './experiments.mjs';
export { forecastDoc, verifyForecastDoc, scoreMatured, scoreProvisional7, updateSummary, emptySummary, liveSkill } from './ledger.mjs';
export { regimeReport } from './regime.mjs';
export { sha256, canonical, toDay, fromDay } from './util.mjs';

/**
 * Chạy engine đầy đủ cho ngày `today`.
 * @param {{assets:object[], series:object[], manual?:object[]}} raw số liệu (file data/ và doc manual/)
 * @param {{today:string, config?:object, champions?:object|null, summary?:object|null, ai?:object|null}} opts
 */
export function runEngine(raw, opts) {
  const t0 = Date.now();
  const cfg = mergeConfig(DEFAULT_CONFIG, opts.config);
  const data = prepare(raw);
  const panel = buildPanel(data, cfg);
  let tailChosen = false;
  if (!cfg.tail || !Object.keys(cfg.tail).length) {
    cfg.tail = chooseTailThresholds(panel, cfg);
    tailChosen = true;
  }
  const bt = runBacktest(data, cfg, panel);
  const ev = evaluate(bt, cfg);
  const initialChampions = selectChampions(ev, cfg.gates.initialPBetter);
  const champions = opts.champions || initialChampions;
  const T = toDay(opts.today);
  const live = liveForecast(data, cfg, panel, bt, T, champions);
  const regime = regimeReport(data, T, panel.cache);
  const badges = {};
  for (const g of data.groups) {
    for (const h of HORIZONS) {
      const champ = champions[g]?.[h.id]?.model || 'M1';
      const lv = opts.summary ? liveSkill(opts.summary, h.id, g, champ) : null;
      (badges[g] ??= {})[h.id] = { ...badgeFor(ev[h.id].groups[g], champ, lv, cfg.gates.badgePBetter), champion: champ, live: lv };
    }
  }
  for (const it of live.items) {
    const b = badges[it.g][it.h];
    it.badge = b.key;
    it.call = b.key === 'strong' && Math.abs(it.pc - 0.5) >= cfg.callMinEdge ? (it.pc > 0.5 ? 1 : -1) : 0;
  }
  return { cfg, data, panel, bt, ev, champions, initialChampions, live, regime, badges, tailChosen, ms: Date.now() - t0 };
}

/** Giải thích từng trường của public/latest bằng tiếng Việt. */
export const LATEST_FIELDS = {
  date: 'Ngày chạy dự báo (giờ Việt Nam).',
  version: 'Version của app khi tạo bản này.',
  champion: 'Mô hình đang dùng làm dự báo chính cho từng nhóm và kỳ hạn (M1 = tần suất tăng lịch sử).',
  'assets[].id': 'Mã tài sản.',
  'assets[].price': 'Giá đóng cửa gần nhất (lợi suất 10 năm Mỹ tính bằng %).',
  'assets[].priceDate': 'Ngày của giá đóng cửa đó.',
  'assets[].prob_up_1m': 'Xác suất đã hiệu chỉnh để giá sau 30 ngày cao hơn hiện tại, theo nhà vô địch (0–1).',
  'assets[].prob_up_3m': 'Như trên, sau 91 ngày.',
  'assets[].base_1m': 'Tần suất tăng lịch sử của chính tài sản (M1) cho kỳ 1 tháng: điểm chuẩn để so.',
  'assets[].base_3m': 'Như trên, kỳ 3 tháng.',
  'assets[].lo_1m': 'Cận dưới vùng giá 80% sau 30 ngày (10% khả năng thấp hơn).',
  'assets[].hi_1m': 'Cận trên vùng giá 80% sau 30 ngày (10% khả năng cao hơn).',
  'assets[].lo_3m': 'Cận dưới vùng giá 80% sau 91 ngày.',
  'assets[].hi_3m': 'Cận trên vùng giá 80% sau 91 ngày.',
  'assets[].prob_tail_1m': 'Xác suất giảm sâu hơn ngưỡng tail_k_1m trong 30 ngày.',
  'assets[].tail_k_1m': 'Ngưỡng giảm sâu (log lợi suất với giá, điểm % với lợi suất); chọn để xảy ra khoảng 12,5% số tháng.',
  'assets[].prob_tail_3m': 'Xác suất giảm sâu hơn ngưỡng tail_k_3m trong 91 ngày.',
  'assets[].badge_1m': 'Độ tin cậy đã kiểm chứng của nhóm: strong = Có cơ sở, weak = Ít cơ sở, none = Chưa có cơ sở.',
  'assets[].call_1m': '1 nghiêng tăng, −1 nghiêng giảm, 0 không nghiêng; chỉ khác 0 khi nhóm có cơ sở và xác suất cách 50% từ 5 điểm trở lên.',
  'assets[].skill_1m': 'BSS của nhà vô địch so với M1 trong kiểm định (dương là tốt hơn), khoảng 95% và p_better.',
  regime: 'Kịch bản vĩ mô: góc phần tư tăng trưởng × lạm phát theo vùng, chế độ rủi ro, dịch chuyển so với 3 tháng trước.',
  ai: 'Nhận định của Claude (M6). Chưa qua các cửa kiểm chứng thì chỉ để tham khảo, không thay dự báo chính.',
};

/**
 * Hợp đồng dữ liệu public/latest cho các tác vụ khác.
 * @param {ReturnType<typeof runEngine>} run @param {{version:string, generatedAt:string, ai?:object|null}} meta
 */
export function buildLatest(run, meta) {
  const by = new Map();
  for (const it of run.live.items) by.set(`${it.a}|${it.h}`, it);
  const assets = [];
  for (const A of run.data.forecastAssets) {
    const i1 = by.get(`${A.id}|1m`);
    const i3 = by.get(`${A.id}|3m`);
    if (!i1 && !i3) { assets.push({ id: A.id, name: A.name, group: A.group, missing: true }); continue; }
    const b1 = run.badges[A.group]['1m'];
    const b3 = run.badges[A.group]['3m'];
    assets.push({
      id: A.id, name: A.name, group: A.group, unit: A.unit, kind: A.kind,
      price: (i1 || i3).px, priceDate: (i1 || i3).pd,
      prob_up_1m: i1?.pc ?? null, prob_up_3m: i3?.pc ?? null, base_1m: i1?.base ?? null, base_3m: i3?.base ?? null,
      lo_1m: i1?.lo ?? null, hi_1m: i1?.hi ?? null, lo_3m: i3?.lo ?? null, hi_3m: i3?.hi ?? null,
      prob_tail_1m: i1?.pt ?? null, prob_tail_3m: i3?.pt ?? null, tail_k_1m: i1?.k ?? null, tail_k_3m: i3?.k ?? null,
      badge_1m: b1.key, badge_3m: b3.key, call_1m: i1?.call ?? 0, call_3m: i3?.call ?? 0,
      champion_1m: b1.champion, champion_3m: b3.champion,
      skill_1m: { bss: b1.skill, pBetter: b1.pBetter }, skill_3m: { bss: b3.skill, pBetter: b3.pBetter },
    });
  }
  const champion = Object.fromEntries(Object.entries(run.champions).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, c]) => [h, c.model]))]));
  return {
    schemaVersion: SCHEMA_VERSION, date: run.live.date, version: meta.version, generatedAt: meta.generatedAt,
    champion, assets,
    regime: { regions: run.regime.regions, risk: run.regime.risk },
    ai: meta.ai || null,
    fields: LATEST_FIELDS,
  };
}

/** Giá theo ngày 400 quan sát cuối và giá cuối tháng toàn bộ (để vẽ). */
function priceHistory(A) {
  const n = A.vals.length;
  const from = Math.max(0, n - 400);
  return {
    d: A.dates.slice(from), c: Array.from(A.vals.slice(from)).map((v) => round(v, 6)),
    md: A.meIdx.map((i) => A.dates[i]), mc: A.meIdx.map((i) => round(A.vals[i], 6)),
  };
}

/**
 * Gói dữ liệu hiển thị cho trang (file data/bundle.json của artifact).
 * @param {ReturnType<typeof runEngine>} run @param {{qa?:object|null, catalog?:object|null, version:string, generatedAt:string}} meta
 */
export function buildBundle(run, meta) {
  const T = toDay(run.live.date);
  const assets = [...run.data.assets.values()].map((A) => ({
    id: A.id, name: A.name, group: A.group, kind: A.kind, unit: A.unit, forecast: A.forecast, source: A.source,
    segments: A.segments, check: A.check ? { status: A.check.status, max_diff: A.check.max_diff, source: A.check.source?.name } : null,
    quarantine: A.quarantine, last: A.dates[A.dates.length - 1], first: A.dates[0], ...priceHistory(A),
  }));
  const series = [...run.data.series.values()].filter((s) => !s.id.startsWith('mkt_')).map((s) => {
    const at = seriesAt(s, T);
    const k = s.raw.length;
    const from = Math.max(0, k - 72);
    return {
      id: s.id, name: s.name, region: s.region, factor: s.factor, sign: s.sign, unit: s.unit, freq: s.freq, transform: s.transform,
      lag: s.lag, source: s.source, manual: s.manual,
      last: { date: s.dates[k - 1], value: round(s.raw[k - 1], 6), x: Number.isFinite(s.x[k - 1]) ? round(s.x[k - 1], 4) : null, avail: fromDay(s.avail[k - 1]) },
      usable: at ? { date: at.date, value: round(at.raw, 6), x: Number.isFinite(at.x) ? round(at.x, 4) : null } : null,
      z: zAt(s, T) === null ? null : round(zAt(s, T), 3),
      stale: !at,
      hist: { d: s.dates.slice(from), v: Array.from(s.raw.slice(from)).map((v) => round(v, 6)), x: Array.from(s.x.slice(from)).map((v) => (Number.isFinite(v) ? round(v, 4) : null)) },
    };
  });
  const oos = {};
  for (const h of HORIZONS) {
    const champ = (g) => run.champions[g]?.[h.id]?.model || 'M1';
    oos[h.id] = run.bt[h.id].recs.filter((r) => r.ready && r.y !== undefined).slice(-60 * 14).map((r) => ({
      a: r.a, d: fromDay(r.D), p: round(r.p[champ(r.g)], 4), m1: round(r.p.M1, 4), y: r.y, ret: round(r.ret, 5),
      q: r.q.map((v) => round(v, 4)) }));
  }
  return {
    schemaVersion: SCHEMA_VERSION, version: meta.version, engineVersion: ENGINE_VERSION, generatedAt: meta.generatedAt,
    date: run.live.date, assets, series, live: run.live.items, missing: run.live.missing,
    regime: run.regime, eval: run.ev, champions: run.champions, badges: run.badges,
    config: { params: run.cfg.params, paramSpecs: PARAM_SPECS, features: run.cfg.features, pool: run.cfg.pool, tail: run.cfg.tail,
      bandMethod: run.cfg.bandMethod, riskBandMultiplier: run.cfg.riskBandMultiplier, testMonths: run.cfg.testMonths,
      refitEvery: run.cfg.refitEvery, gates: run.cfg.gates, configVersion: run.cfg.configVersion },
    names: { groups: GROUP_NAMES, models: MODEL_NAMES }, oos,
    qa: meta.qa || null, catalog: meta.catalog || null, engineMs: run.ms,
  };
}
