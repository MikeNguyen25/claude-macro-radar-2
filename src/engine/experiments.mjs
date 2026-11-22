// Phép thử: giả thuyết = bản ghi đè cấu hình. Kiểm định đầy đủ, so với M1 và nhà vô địch hiện hành,
// qua cửa thì chuyển shadow, trượt thì rejected kèm lý do. Postmortem dự báo trượt lớn.

import { HORIZONS, CANDIDATES, mergeConfig } from './config.mjs';
import { runBacktest, evaluate } from './engine.mjs';
import { toDay, fromDay, round } from './util.mjs';

/** Giả thuyết ban đầu (status proposed). */
export const SEED_EXPERIMENTS = [
  { id: 'exp-001', title: 'Xu hướng chỉ dùng 3 và 12 tháng', hypothesis: 'Biến động 1 tháng gây nhiễu; bỏ r1 khỏi M2 làm M2 tốt hơn.',
    override: { features: { M2: ['r3', 'r12', 'dsma'] } } },
  { id: 'exp-002', title: 'Vĩ mô thêm độ dốc lợi suất', hypothesis: 'Độ dốc 10 năm − 3 tháng (us.curve) báo trước rủi ro cho cổ phiếu Mỹ và crypto.',
    override: { features: { M3: { us_eq: ['us.growth', 'us.inflation', 'us.policy', 'us.fincond', 'us.credit', 'us.curve'], crypto: ['us.fincond', 'us.policy', 'us.usd', 'us.curve'] } } } },
  { id: 'exp-003', title: 'Vùng giá bootstrap phần dư', hypothesis: 'Phân phối thực nghiệm của sai số chuẩn hóa cho độ phủ 80% sát hơn Student-t.',
    override: { bandMethod: 'bootstrap' } },
  { id: 'exp-004', title: 'Vùng giá nở theo VIX', hypothesis: 'Khi VIX cao hơn bình thường, độ rộng vùng giá cần tăng thêm.',
    override: { riskBandMultiplier: 0.1 } },
  { id: 'exp-005', title: 'Tổ hợp tin M1 ít hơn', hypothesis: 'Giảm tỷ trọng tối thiểu của M1 trong M5 từ 50% xuống 30%.',
    override: { params: { ensembleShrink: 0.3 } } },
  { id: 'exp-006', title: 'Việt Nam dùng xuất khẩu', hypothesis: 'Tăng trưởng xuất khẩu Việt Nam (vn.growth) giúp dự báo VN-Index.',
    override: { features: { M3: { vn: ['world.growth', 'cn.growth', 'us.fincond', 'us.usd', 'vn.fx', 'vn.growth'] } } } },
];

/**
 * Ngưỡng p_better theo số phép thử đã chạy.
 * @param {object} cfg @param {number} trials
 * @returns {number}
 */
export function promotionThreshold(cfg, trials) {
  return trials >= cfg.gates.trialsThreshold ? cfg.gates.pBetterHigh : cfg.gates.pBetterLow;
}

/**
 * Kiểm định một giả thuyết ở kỳ 1 tháng. Qua cửa ở nhóm g nếu một mô hình M của cấu hình mới:
 * (a) có p_better ≥ ngưỡng so với M1; (b) tốt hơn chính M ở cấu hình hiện hành ở cả hai nửa giai
 * đoạn (cải thiện do thay đổi, không phải do mô hình vốn đã tốt); (c) tốt hơn nhà vô địch hiện hành
 * ở cả hai nửa; (d) không kém M1 ở tập kiểm tra.
 * @param {ReturnType<import('./data.mjs').prepare>} data @param {object} cfg
 * @param {ReturnType<import('./engine.mjs').buildPanel>} panel
 * @param {{id:string, override:object}} exp @param {object} champions
 * @param {object} baseEval đánh giá của cấu hình hiện hành @param {number} trials
 */
export function runExperiment(data, cfg, panel, exp, champions, baseEval, trials) {
  const thr = promotionThreshold(cfg, trials);
  const cand = mergeConfig(cfg, exp.override);
  const ev = evaluate(runBacktest(data, cand, panel), cand);
  const passed = [];
  const details = {};
  const better = (a, b) => a.halves.every((x, i) => x && b?.halves?.[i] && x.brier < b.halves[i].brier);
  for (const h of HORIZONS) {
    for (const [g, sc] of Object.entries(ev[h.id].groups)) {
      if (!sc) continue;
      const champ = champions?.[g]?.[h.id]?.model || 'M1';
      const baseG = baseEval[h.id].groups[g];
      const rows = CANDIDATES.map((M) => {
        const s = sc.models[M];
        const improves = better(s, baseG?.models[M]);
        const beatsChamp = better(s, baseG?.models[champ]);
        const ok = h.id === '1m' && s.pBetter >= thr && improves && beatsChamp && s.test && s.test.brier <= s.test.ref;
        return { M, s, improves, beatsChamp, ok };
      }).sort((a, b) => Number(b.ok) - Number(a.ok) || b.s.skill - a.s.skill);
      const best = rows[0];
      (details[g] ??= {})[h.id] = { model: best.M, skill: best.s.skill, pBetter: best.s.pBetter, improvesOverBase: best.improves,
        champion: champ, championSkill: baseG?.models[champ]?.skill ?? 0, ece: best.s.ece, coverage: sc.coverage, ok: best.ok };
      if (best.ok) passed.push({ g, h: h.id, model: best.M });
    }
  }
  return {
    status: passed.length ? 'shadow' : 'rejected', threshold: thr, passed, details,
    reason: passed.length ? `qua cửa kiểm định ở ${passed.map((p) => `${p.g} (${p.model})`).join(', ')}`
      : `không nhóm nào vừa đạt p_better ≥ ${thr} so với M1, vừa tốt hơn chính mô hình đó ở cấu hình hiện hành và tốt hơn nhà vô địch ở cả hai nửa giai đoạn`,
  };
}

/**
 * Xét lên ngôi cho ứng viên sẵn có (M2–M5) đủ ba cửa: kiểm định (p_better ≥ ngưỡng so với M1, tốt
 * hơn nhà vô địch ở cả hai nửa, không kém M1 ở tập kiểm tra); trực tiếp (≥ liveIntervals khoảng không
 * trùng, không kém nhà vô địch); ECE không tăng quá 1 điểm %, độ phủ vùng 80% trong 70–90%.
 * @param {object} ev đánh giá kiểm định @param {object} registry @param {(h:string,g:string,M:string)=>object} live
 * @param {object} cfg @param {number} trials
 * @returns {{g:string, h:string, from:string, to:string, reason:string}[]}
 */
export function promotionsFromCandidates(ev, registry, live, cfg, trials) {
  const thr = promotionThreshold(cfg, trials);
  const out = [];
  for (const h of HORIZONS) {
    for (const [g, sc] of Object.entries(ev[h.id].groups)) {
      if (!sc) continue;
      const champ = registry.champion?.[g]?.[h.id] || 'M1';
      const c = sc.models[champ];
      const lc = live(h.id, g, champ);
      for (const M of CANDIDATES.filter((x) => x !== champ).sort((a, b) => sc.models[b].skill - sc.models[a].skill)) {
        const s = sc.models[M];
        const lm = live(h.id, g, M);
        const backtestOk = s.pBetter >= thr && s.halves.every((x, i) => x && c.halves[i] && x.brier < c.halves[i].brier) && s.test && s.test.brier <= s.test.ref;
        const liveOk = lm.intervals >= cfg.gates.liveIntervals && lm.skill !== null && (lc.skill === null || lm.skill >= lc.skill);
        const qualityOk = s.ece - c.ece <= cfg.gates.eceMaxIncrease && sc.coverage >= cfg.gates.coverage[0] && sc.coverage <= cfg.gates.coverage[1];
        if (backtestOk && liveOk && qualityOk) {
          out.push({ g, h: h.id, from: champ, to: M, reason: `kiểm định p_better ${s.pBetter}; trực tiếp ${lm.intervals} khoảng, BSS ${lm.skill}; ECE ${s.ece}; độ phủ ${sc.coverage}` });
          break;
        }
      }
    }
  }
  return out;
}

/** Loại nguyên nhân của dự báo trượt. */
export const MISS_CAUSES = {
  data: 'Lỗi số liệu',
  event: 'Sự kiện bất ngờ',
  regime: 'Đổi chế độ thị trường',
  missing: 'Mô hình thiếu biến',
};

/**
 * Gom dự báo trượt lớn (giá ra ngoài vùng 80%, hoặc xác suất ≥ 70% mà sai hướng) thành postmortem.
 * Nhiều tài sản trượt trong cùng một ngày dự báo và kỳ hạn chỉ tính là một sự kiện.
 * @param {object[]} scored kết quả scoreMatured @param {{qaFlags:Set<string>, riskAt:(iso:string)=>string|null}} ctx
 * @returns {object[]}
 */
export function postmortems(scored, ctx) {
  const by = new Map();
  for (const x of scored) {
    const champ = x.models[x.champ] || x.models.M1;
    const p = champ?.p ?? 0.5;
    const wrongConfident = (p >= 0.7 && x.y === 0) || (p <= 0.3 && x.y === 1);
    if (x.inBand && !wrongConfident) continue;
    const key = `${x.fd}-${x.h}`;
    (by.get(key) || by.set(key, []).get(key)).push({ ...x, p, wrongConfident });
  }
  const out = [];
  for (const [key, xs] of by) {
    const [fd, h] = [xs[0].fd, xs[0].h];
    const H = HORIZONS.find((z) => z.id === h).days;
    const end = fromDay(toDay(fd) + H);
    let cause = 'missing';
    if (xs.some((x) => ctx.qaFlags?.has(x.a))) cause = 'data';
    else if (xs.some((x) => Math.abs(x.ret) > 3 * Math.max(Math.abs(x.q[2] - x.q[1]), 1e-9) / 1.28)) cause = 'event';
    else if (ctx.riskAt && ctx.riskAt(fd) !== ctx.riskAt(end)) cause = 'regime';
    out.push({
      id: key, fd, h, end, cause, causeLabel: MISS_CAUSES[cause], assets: xs.map((x) => x.a),
      evidence: xs.map((x) => ({ a: x.a, p: round(x.p, 3), y: x.y, ret: x.ret, band: x.q.map((v) => round(v, 4)), outside: !x.inBand })),
      lesson: cause === 'missing' ? 'Đề xuất giả thuyết: thêm biến giải thích cho nhóm của các tài sản trên.' : null,
    });
  }
  return out;
}

/**
 * Gom postmortem của tháng thành giả thuyết mới (status proposed) theo loại nguyên nhân.
 * @param {object[]} pms @param {string} month YYYY-MM @param {object[]} existing
 * @returns {object[]}
 */
export function hypothesesFromPostmortems(pms, month, existing) {
  const ids = new Set(existing.map((e) => e.id));
  const out = [];
  const missing = pms.filter((p) => p.cause === 'missing');
  if (missing.length >= 2) {
    const id = `exp-pm-${month}-tail`;
    if (!ids.has(id)) out.push({ id, title: `Rủi ro đuôi từ postmortem ${month}`, status: 'proposed',
      hypothesis: `${missing.length} sự kiện trượt không do số liệu hay sự kiện bất ngờ; thử vùng giá nở theo VIX mạnh hơn.`,
      override: { riskBandMultiplier: 0.2 } });
  }
  const regime = pms.filter((p) => p.cause === 'regime');
  if (regime.length >= 2) {
    const id = `exp-pm-${month}-regime`;
    if (!ids.has(id)) out.push({ id, title: `Đổi chế độ từ postmortem ${month}`, status: 'proposed',
      hypothesis: `${regime.length} sự kiện trượt khi chế độ rủi ro đổi; thử tổ hợp nhạy hơn với log score gần đây.`,
      override: { params: { ensembleEta: 1.5 } } });
  }
  return out;
}
