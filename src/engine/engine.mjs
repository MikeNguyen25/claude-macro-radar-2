// Lõi kiểm định và dự báo: bảng dữ liệu theo tháng, kiểm định cuốn chiếu (chỉ dùng số đã công bố
// và kết quả đã biết tại từng mốc), mô hình M0–M5, hiệu chỉnh, vùng giá, xác suất giảm sâu,
// chấm điểm theo nhóm, chọn nhà vô địch và dự báo trực tiếp tại một ngày.

import { HORIZONS, CANDIDATES, BACKTEST_MODELS, BADGES } from './config.mjs';
import { toDay, fromDay, monthEndDay, logit, clip, quantile, round } from './util.mjs';
import { assetFeatures, outcome, contextAt, featureVector } from './features.mjs';
import { fitLogit, predictLogit, fitPlatt, applyPlatt, contributions } from './models.mjs';
import { bandAt, tailProb, coverageFactor } from './bands.mjs';
import { brier, logScore, calibration, pinball, spearman } from './scoring.mjs';
import { blockBootstrapSkill, dieboldMariano } from './stats.mjs';

/** Lỗi khi phát hiện dữ liệu tương lai lọt vào tập học. */
export class LookaheadError extends Error {}

/**
 * Mốc cuối tháng từ ngày bắt đầu tới tháng cuối có số liệu giá.
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {string} startIso
 * @returns {number[]}
 */
export function monthGrid(data, startIso) {
  let last = 0;
  for (const A of data.forecastAssets) last = Math.max(last, A.days[A.days.length - 1]);
  const out = [];
  for (let d = monthEndDay(toDay(startIso)); d <= last; d = monthEndDay(d + 1)) out.push(d);
  return out;
}

/**
 * Bảng dữ liệu: mỗi dòng là một tài sản tại một mốc cuối tháng, gồm đặc trưng, bối cảnh vĩ mô
 * và kết quả sau 1 và 3 tháng (null nếu chưa biết).
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {object} cfg
 */
export function buildPanel(data, cfg) {
  const months = monthGrid(data, cfg.backtestStart);
  const cache = new Map();
  const rows = [];
  months.forEach((D, m) => {
    const ctx = contextAt(data, D, cache);
    for (const A of data.forecastAssets) {
      const f = assetFeatures(A, D);
      if (!f) continue;
      const out = {};
      for (const h of HORIZONS) out[h.id] = outcome(A, D, h.days);
      rows.push({ a: A.id, g: A.group, kind: A.kind, D, m, f, macro: ctx.macro, risk: ctx.risk, out, p1: {}, t1: {} });
    }
  });
  return { months, rows, cache };
}

/** Khóa ngưỡng giảm sâu: theo nhóm nếu gộp, theo tài sản nếu không. */
function tailKey(cfg, row) {
  return cfg.pool[row.g] === false ? row.a : row.g;
}

/**
 * Chọn ngưỡng giảm sâu để sự kiện xảy ra khoảng `tailTargetFreq` số tháng của nhóm (hoặc tài sản).
 * Làm tròn 0,5% với giá, 0,05 điểm % với lợi suất.
 * @param {ReturnType<typeof buildPanel>} panel @param {object} cfg
 * @returns {Record<string, Record<string, number>>}
 */
export function chooseTailThresholds(panel, cfg) {
  const by = {};
  for (const r of panel.rows) {
    for (const h of HORIZONS) {
      const o = r.out[h.id];
      if (!o) continue;
      const key = tailKey(cfg, r);
      ((by[key] ??= {})[h.id] ??= { rets: [], kind: r.kind }).rets.push(o.ret);
    }
  }
  const out = {};
  for (const [key, hs] of Object.entries(by)) {
    out[key] = {};
    for (const [hid, { rets, kind }] of Object.entries(hs)) {
      const q = -quantile(rets, cfg.tailTargetFreq);
      const step = kind === 'yield' ? 0.05 : 0.005;
      out[key][hid] = round(Math.max(step, Math.round(q / step) * step), 4);
    }
  }
  return out;
}

/** Danh sách đặc trưng của mô hình M cho nhóm g. */
function featureNames(cfg, M, g) {
  const f = cfg.features[M];
  return Array.isArray(f) ? f : f[g] || [];
}

/** Bộ đếm cho M1: số kỳ tăng và số kỳ giảm sâu đã biết theo tài sản và nhóm. */
function newCounts() {
  return { asset: new Map(), group: new Map() };
}

function addCount(counts, row, h, k) {
  const o = row.out[h];
  const tail = k !== undefined && o.ret < -k ? 1 : 0;
  for (const [map, key] of [[counts.asset, row.a], [counts.group, row.g]]) {
    const c = map.get(key) || { up: 0, n: 0, tail: 0 };
    c.up += o.up; c.n += 1; c.tail += tail;
    map.set(key, c);
  }
}

/** Xác suất M1 và tần suất giảm sâu nền tại thời điểm hiện hành của bộ đếm. */
function m1Prob(counts, row, cfg) {
  const a = counts.asset.get(row.a) || { up: 0, n: 0, tail: 0 };
  const pooled = cfg.pool[row.g] !== false;
  const g = pooled ? counts.group.get(row.g) || { up: 0, n: 0, tail: 0 } : a;
  const prior = cfg.params.m1Prior;
  const pg = (g.up + 1) / (g.n + 2);
  const tg = (g.tail + 1) / (g.n + 8);
  return {
    p: (a.up + prior * pg) / (a.n + prior),
    t: (a.tail + prior * tg) / (a.n + prior),
    n: a.n,
  };
}

/**
 * Học trạng thái của một nhóm tại ngày D: mô hình M2–M4, hiệu chỉnh Platt, trọng số M5,
 * hệ số phủ của vùng giá. Chỉ dùng dòng và dự báo có ngày biết kết quả ≤ D.
 */
export function fitGroupState(g, h, D, knownRows, pastRecs, cfg) {
  const H = HORIZONS.find((x) => x.id === h).days;
  for (const r of knownRows) {
    // Kết quả của dòng học phải nằm hẳn trước mốc học: ngày mục tiêu D_r + H ≤ D và đã biết.
    if (r.D + H > D || !r.out[h] || r.out[h].knownDay > D) {
      throw new LookaheadError(`dòng học ${r.a} ${fromDay(r.D)} (kỳ hạn ${h}) chưa có kết quả tại ${fromDay(D)}`);
    }
  }
  const P = cfg.params;
  const st = { g, h, D, models: {}, calib: {}, weights: null, cov: 1, zHist: null, ready: false, nKnown: knownRows.length };
  const pooled = cfg.pool[g] !== false;
  const lambdas = { M2: P.lambdaM2, M3: P.lambdaM3, M4: P.lambdaM4 };
  for (const M of ['M2', 'M3', 'M4']) {
    const names = featureNames(cfg, M, g);
    if (!names.length) continue;
    const fit = (rows) => (rows.length >= cfg.minTrainRows
      ? fitLogit(rows.map((r) => featureVector(names, r)), rows.map((r) => r.out[h].up), rows.map((r) => logit(r.p1[h])), lambdas[M])
      : null);
    if (pooled) st.models[M] = fit(knownRows);
    else {
      st.models[M] = {};
      for (const a of new Set(knownRows.map((r) => r.a))) st.models[M][a] = fit(knownRows.filter((r) => r.a === a));
    }
  }
  const scored = pastRecs.filter((r) => r.knownDay <= D && r.y !== undefined);
  for (const M of ['M2', 'M3', 'M4', 'M5']) {
    if (scored.length >= cfg.calibMinRows) st.calib[M] = fitPlatt(scored.map((r) => r.raw[M]), scored.map((r) => r.y), P.plattPrior);
  }
  const recent = scored.filter((r) => r.D > D - 31 * cfg.ensembleWindow);
  if (recent.length >= cfg.calibMinRows) {
    const S = {};
    for (const M of ['M1', 'M2', 'M3', 'M4']) S[M] = recent.reduce((s, r) => s + logScore(r.p[M], r.y), 0) / new Set(recent.map((r) => r.a)).size;
    const mx = Math.max(...Object.values(S));
    const w = Object.fromEntries(Object.entries(S).map(([M, s]) => [M, Math.exp(P.ensembleEta * (s - mx))]));
    const tot = Object.values(w).reduce((a, b) => a + b, 0);
    st.weights = Object.fromEntries(Object.entries(w).map(([M, v]) => [M, v / tot]));
  }
  st.cov = coverageFactor(scored, P.tDof, cfg.coverageClip, cfg.coverageTarget);
  const z = scored.map((r) => (r.ret - r.mu) / r.sigH).filter(Number.isFinite);
  st.zHist = z.length >= 60 ? z : null;
  const hasModel = (M) => (pooled ? !!st.models[M] : Object.values(st.models[M] || {}).some(Boolean));
  st.ready = hasModel('M2') && Object.keys(st.calib).length > 0;
  return st;
}

/** Dự báo một dòng với trạng thái nhóm. */
function predictRow(row, h, st, m1, data, cfg) {
  const P = cfg.params;
  const [lo, hi] = cfg.probClip;
  const p1 = clip(m1.p, lo, hi);
  const raw = { M1: p1 };
  const p = { M0: 0.5, M1: p1 };
  const pooled = cfg.pool[row.g] !== false;
  for (const M of ['M2', 'M3', 'M4']) {
    const model = st && (pooled ? st.models[M] : st.models[M]?.[row.a]);
    raw[M] = model ? predictLogit(model, featureVector(featureNames(cfg, M, row.g), row), logit(p1)) : p1;
    p[M] = clip(applyPlatt(st?.calib[M], raw[M]), lo, hi);
  }
  const w = st?.weights || { M1: 0.25, M2: 0.25, M3: 0.25, M4: 0.25 };
  raw.M5 = P.ensembleShrink * p1 + (1 - P.ensembleShrink) * (w.M1 * p.M1 + w.M2 * p.M2 + w.M3 * p.M3 + w.M4 * p.M4);
  p.M5 = clip(applyPlatt(st?.calib.M5, raw.M5), lo, hi);
  const A = data.assets.get(row.a);
  const H = HORIZONS.find((x) => x.id === h).days;
  const band = bandAt(A, row.f, H, P, { cov: st?.cov ?? 1, zHist: st?.zHist, riskZ: row.risk['risk.vix'],
    riskMult: cfg.riskBandMultiplier, method: cfg.bandMethod });
  const k = cfg.tail[tailKey(cfg, row)]?.[h];
  let pt = null;
  if (k !== undefined) pt = clip(P.tailMix * tailProb(band, k) + (1 - P.tailMix) * m1.t, ...cfg.tailClip);
  return { p, raw, band, pt, ptBase: m1.t, k };
}

/**
 * Kiểm định cuốn chiếu cho mọi kỳ hạn. Mỗi mốc tháng D: cập nhật kết quả đã biết, học lại theo
 * lịch, dự báo mọi tài sản. Không dùng kết quả có ngày biết > D.
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {object} cfg
 * @param {ReturnType<typeof buildPanel>} [panel]
 * @returns {Record<string, {recs: object[], states: Record<string, object>}>}
 */
export function runBacktest(data, cfg, panel = buildPanel(data, cfg)) {
  const res = {};
  const byMonth = new Map();
  for (const r of panel.rows) (byMonth.get(r.m) || byMonth.set(r.m, []).get(r.m)).push(r);
  for (const h of HORIZONS) {
    const queue = panel.rows.filter((r) => r.out[h.id]).sort((a, b) => a.out[h.id].knownDay - b.out[h.id].knownDay);
    let qi = 0;
    const counts = newCounts();
    const known = new Map();
    const recsByGroup = new Map();
    const recs = [];
    let states = {};
    panel.months.forEach((D, mi) => {
      while (qi < queue.length && queue[qi].out[h.id].knownDay <= D) {
        const r = queue[qi++];
        addCount(counts, r, h.id, cfg.tail[tailKey(cfg, r)]?.[h.id]);
        (known.get(r.g) || known.set(r.g, []).get(r.g)).push(r);
      }
      if (mi % cfg.refitEvery === 0) {
        states = {};
        for (const g of data.groups) states[g] = fitGroupState(g, h.id, D, known.get(g) || [], recsByGroup.get(g) || [], cfg);
      }
      for (const row of byMonth.get(mi) || []) {
        const m1 = m1Prob(counts, row, cfg);
        row.p1[h.id] = clip(m1.p, ...cfg.probClip);
        const st = states[row.g];
        const pr = predictRow(row, h.id, st, m1, data, cfg);
        const o = row.out[h.id];
        const rec = { a: row.a, g: row.g, D: row.D, m: mi, p: pr.p, raw: pr.raw, mu: pr.band.mu, sigH: pr.band.sigH,
          q: [pr.band.q10, pr.band.q50, pr.band.q90], pt: pr.pt, ptBase: pr.ptBase, k: pr.k,
          ready: !!st?.ready, bull: row.f.r12 > 0, vixHigh: (row.risk['risk.vix'] ?? 0) > 0.5,
          y: o ? o.up : undefined, ret: o ? o.ret : undefined, knownDay: o ? o.knownDay : Infinity };
        recs.push(rec);
        (recsByGroup.get(row.g) || recsByGroup.set(row.g, []).get(row.g)).push(rec);
      }
    });
    res[h.id] = { recs, states };
  }
  return res;
}

/** Tổng loss theo tháng của một tập dự báo, cho bootstrap. */
function monthlyLoss(recs, M, months) {
  const idx = new Map(months.map((m, i) => [m, i]));
  const out = new Array(months.length).fill(0);
  for (const r of recs) out[idx.get(r.m)] += brier(r.p[M], r.y);
  return out;
}

/** Chấm điểm một tập dự báo (một nhóm hoặc tất cả) ở một kỳ hạn. */
function scoreScope(recs, hMonths, cfg, testMonths, halves) {
  if (!recs.length) return null;
  const months = [...new Set(recs.map((r) => r.m))].sort((a, b) => a - b);
  const ys = recs.map((r) => r.y);
  const refLoss = monthlyLoss(recs, 'M1', months);
  const models = {};
  for (const M of BACKTEST_MODELS) {
    const ps = recs.map((r) => r.p[M]);
    const b = recs.reduce((s, r) => s + brier(r.p[M], r.y), 0) / recs.length;
    const ls = recs.reduce((s, r) => s + logScore(r.p[M], r.y), 0) / recs.length;
    const cal = calibration(ps, ys);
    const hit = recs.filter((r) => (r.p[M] > 0.5) === (r.y === 1)).length / recs.length;
    const sharp = ps.reduce((s, p) => s + Math.abs(p - 0.5), 0) / ps.length;
    const loss = monthlyLoss(recs, M, months);
    const bs = M === 'M1' ? { skill: 0, lo: 0, hi: 0, pBetter: 0.5 }
      : blockBootstrapSkill(loss, refLoss, hMonths, cfg.bootstrap.B, cfg.bootstrap.seed);
    const dm = M === 'M1' ? { stat: 0, p: 1 } : dieboldMariano(refLoss.map((v, i) => v - loss[i]), hMonths - 1);
    const part = (set) => {
      const rr = recs.filter((r) => set.has(r.m));
      if (!rr.length) return null;
      const bm = rr.reduce((s, r) => s + brier(r.p[M], r.y), 0) / rr.length;
      const br = rr.reduce((s, r) => s + brier(r.p.M1, r.y), 0) / rr.length;
      return { n: rr.length, brier: round(bm, 5), ref: round(br, 5), skill: round(br > 0 ? 1 - bm / br : 0, 5) };
    };
    models[M] = {
      n: recs.length, brier: round(b, 5), logScore: round(ls, 5), ece: round(cal.ece, 4), hit: round(hit, 4),
      sharp: round(sharp, 4), skill: round(bs.skill, 5), skillLo: round(bs.lo, 5), skillHi: round(bs.hi, 5),
      pBetter: round(bs.pBetter, 4), dm: { stat: round(dm.stat, 3), p: round(dm.p, 4) },
      test: part(testMonths), halves: [part(halves[0]), part(halves[1])],
      calib: cal.table.map((t) => ({ lo: t.lo, n: t.n, p: t.meanP === null ? null : round(t.meanP, 4), f: t.freq === null ? null : round(t.freq, 4) })),
    };
  }
  const inBand = recs.filter((r) => r.ret >= r.q[0] && r.ret <= r.q[2]).length / recs.length;
  const pin = recs.reduce((s, r) => s + pinball(r.q[0], 0.1, r.ret) + pinball(r.q[1], 0.5, r.ret) + pinball(r.q[2], 0.9, r.ret), 0) / (3 * recs.length);
  const tr = recs.filter((r) => r.pt !== null && r.k !== undefined);
  let tail = null;
  if (tr.length) {
    const ev = tr.map((r) => (r.ret < -r.k ? 1 : 0));
    const bm = tr.reduce((s, r, i) => s + brier(r.pt, ev[i]), 0) / tr.length;
    const bb = tr.reduce((s, r, i) => s + brier(r.ptBase, ev[i]), 0) / tr.length;
    tail = { n: tr.length, freq: round(ev.reduce((a, b) => a + b, 0) / tr.length, 4), brier: round(bm, 5), base: round(bb, 5), skill: round(bb > 0 ? 1 - bm / bb : 0, 5) };
  }
  const reg = {};
  for (const [key, fn] of [['bull', (r) => r.bull], ['bear', (r) => !r.bull], ['vixHigh', (r) => r.vixHigh], ['vixLow', (r) => !r.vixHigh]]) {
    const rr = recs.filter(fn);
    if (rr.length < 12) continue;
    reg[key] = Object.fromEntries(CANDIDATES.concat('M1').map((M) => {
      const bm = rr.reduce((s, r) => s + brier(r.p[M], r.y), 0) / rr.length;
      const br = rr.reduce((s, r) => s + brier(r.p.M1, r.y), 0) / rr.length;
      return [M, { n: rr.length, brier: round(bm, 5), skill: round(br > 0 ? 1 - bm / br : 0, 5) }];
    }));
  }
  return { n: recs.length, months: months.length, upRate: round(ys.reduce((a, b) => a + b, 0) / ys.length, 4),
    models, coverage: round(inBand, 4), pinball: round(pin, 6), tail, regimes: reg };
}

/**
 * Chấm điểm kết quả kiểm định theo kỳ hạn, nhóm và toàn bộ; kèm IC Spearman theo tháng.
 * Chỉ dùng dự báo đã có kết quả và đã có mô hình được học (ready).
 * @param {ReturnType<typeof runBacktest>} bt @param {object} cfg
 */
export function evaluate(bt, cfg) {
  const out = {};
  for (const h of HORIZONS) {
    const recs = bt[h.id].recs.filter((r) => r.y !== undefined && r.ready);
    const months = [...new Set(recs.map((r) => r.m))].sort((a, b) => a - b);
    const testMonths = new Set(months.slice(-cfg.testMonths));
    const halfAt = Math.floor(months.length / 2);
    const halves = [new Set(months.slice(0, halfAt)), new Set(months.slice(halfAt))];
    const groups = {};
    for (const g of [...new Set(recs.map((r) => r.g))]) groups[g] = scoreScope(recs.filter((r) => r.g === g), h.months, cfg, testMonths, halves);
    const all = scoreScope(recs, h.months, cfg, testMonths, halves);
    const ic = {};
    for (const M of CANDIDATES.concat('M1')) {
      const vals = [];
      for (const m of months) {
        const rr = recs.filter((r) => r.m === m);
        if (rr.length >= 5) vals.push(spearman(rr.map((r) => r.p[M]), rr.map((r) => r.ret)));
      }
      ic[M] = vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 4) : null;
    }
    out[h.id] = {
      groups, all, ic,
      period: months.length ? { from: fromDay(bt[h.id].recs.find((r) => r.m === months[0]).D), to: fromDay(bt[h.id].recs.find((r) => r.m === months[months.length - 1]).D), months: months.length } : null,
    };
  }
  return out;
}

/**
 * Chọn nhà vô địch cho từng nhóm và kỳ hạn: ứng viên phải có p_better ≥ ngưỡng so với M1, tốt hơn
 * M1 ở cả hai nửa giai đoạn và không kém ở tập kiểm tra; nhiều ứng viên qua thì lấy BSS cao nhất.
 * Không ai qua thì M1.
 * @param {ReturnType<typeof evaluate>} ev @param {number} threshold
 * @returns {Record<string, Record<string, {model:string, reason:string}>>}
 */
export function selectChampions(ev, threshold) {
  const out = {};
  for (const h of HORIZONS) {
    for (const [g, sc] of Object.entries(ev[h.id].groups)) {
      if (!sc) continue;
      const pass = CANDIDATES.filter((M) => {
        const s = sc.models[M];
        return s.pBetter >= threshold && s.halves.every((x) => x && x.brier < x.ref) && s.test && s.test.brier <= s.test.ref;
      }).sort((a, b) => sc.models[b].skill - sc.models[a].skill);
      (out[g] ??= {})[h.id] = pass.length
        ? { model: pass[0], reason: `p_better ${sc.models[pass[0]].pBetter} ≥ ${threshold}, tốt hơn M1 ở cả hai nửa và tập kiểm tra` }
        : { model: 'M1', reason: `không ứng viên nào đạt p_better ≥ ${threshold} và tốt hơn M1 ở cả hai nửa` };
    }
  }
  return out;
}

/**
 * Huy hiệu độ tin cậy của nhóm theo nhà vô địch hiện hành (kiểm định và, khi đủ, trực tiếp).
 * @param {object} sc điểm nhóm ở một kỳ hạn @param {string} champion @param {object|null} live
 * @param {number} pThr ngưỡng p_better
 * @returns {{key:'strong'|'weak'|'none', label:string, skill:number, pBetter:number}}
 */
export function badgeFor(sc, champion, live, pThr) {
  const s = sc?.models?.[champion];
  if (!s || champion === 'M1') return { key: 'none', label: BADGES.none, skill: 0, pBetter: s?.pBetter ?? 0.5 };
  let key = s.skill > 0 && s.pBetter >= pThr ? 'strong' : s.skill > 0 ? 'weak' : 'none';
  if (key === 'strong' && live && live.intervals >= 6 && !(live.skill > 0)) key = 'weak';
  return { key, label: BADGES[key], skill: s.skill, pBetter: s.pBetter };
}

/**
 * Dự báo trực tiếp tại ngày T: học lại mọi nhóm với dòng đã biết kết quả tới T, dùng hiệu chỉnh
 * và trọng số học từ dự báo kiểm định đã biết kết quả tới T.
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {object} cfg
 * @param {ReturnType<typeof buildPanel>} panel @param {ReturnType<typeof runBacktest>} bt
 * @param {number} T ngày dự báo
 * @param {Record<string, Record<string, {model:string}>>} champions
 */
export function liveForecast(data, cfg, panel, bt, T, champions) {
  const ctx = contextAt(data, T, panel.cache);
  const items = [];
  const missing = [];
  for (const h of HORIZONS) {
    const counts = newCounts();
    const known = new Map();
    for (const r of panel.rows) {
      const o = r.out[h.id];
      if (!o || o.knownDay > T) continue;
      addCount(counts, r, h.id, cfg.tail[tailKey(cfg, r)]?.[h.id]);
      (known.get(r.g) || known.set(r.g, []).get(r.g)).push(r);
    }
    const states = {};
    for (const g of data.groups) {
      const past = bt[h.id].recs.filter((r) => r.g === g);
      states[g] = fitGroupState(g, h.id, T, known.get(g) || [], past, cfg);
    }
    for (const A of data.forecastAssets) {
      const f = assetFeatures(A, T);
      if (!f) {
        if (h.id === '1m') missing.push({ a: A.id, reason: 'giá cũ hơn 7 ngày hoặc thiếu lịch sử' });
        continue;
      }
      const row = { a: A.id, g: A.group, kind: A.kind, D: T, f, macro: ctx.macro, risk: ctx.risk, p1: {} };
      const m1 = m1Prob(counts, row, cfg);
      const pr = predictRow(row, h.id, states[A.group], m1, data, cfg);
      const champ = champions?.[A.group]?.[h.id]?.model || 'M1';
      const toLevel = (q) => (A.kind === 'price' ? f.px * Math.exp(q) : f.px + q);
      const st = states[A.group];
      const m3model = cfg.pool[A.group] !== false ? st.models.M3 : st.models.M3?.[A.id];
      const names = featureNames(cfg, 'M3', A.group);
      items.push({
        a: A.id, g: A.group, h: h.id, px: f.px, pd: f.pxDate, p: Object.fromEntries(Object.entries(pr.p).map(([k, v]) => [k, round(v, 4)])),
        champ, pc: round(pr.p[champ], 4), base: round(clip(m1.p, ...cfg.probClip), 4),
        q: [round(pr.band.q10, 5), round(pr.band.q50, 5), round(pr.band.q90, 5)],
        lo: round(toLevel(pr.band.q10), 6), mid: round(toLevel(pr.band.q50), 6), hi: round(toLevel(pr.band.q90), 6),
        pt: pr.pt === null ? null : round(pr.pt, 4), ptBase: round(pr.ptBase, 4), k: pr.k ?? null,
        contrib: m3model ? contributions(m3model, featureVector(names, row), names).map((c) => ({ name: c.name, value: round(c.value, 4) })) : [],
      });
    }
  }
  return { date: fromDay(T), items, missing, context: ctx };
}
