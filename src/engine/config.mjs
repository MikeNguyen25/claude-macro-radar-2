// Cấu hình mặc định, hằng số và giới hạn tham số của engine. Mọi hằng số có tên và đơn vị.

/** Version engine (theo version app). */
export const ENGINE_VERSION = '2.0.0';
/** Version schema của doc DB và file dữ liệu. */
export const SCHEMA_VERSION = 1;

/** Kỳ hạn dự báo: id và số ngày lịch. */
export const HORIZONS = [
  { id: '1m', days: 30, months: 1, label: '1 tháng' },
  { id: '3m', days: 91, months: 3, label: '3 tháng' },
];

/** Nhóm tài sản và tên tiếng Việt. */
export const GROUP_NAMES = {
  crypto: 'Crypto',
  us_eq: 'Cổ phiếu Mỹ',
  sea: 'Đông Nam Á',
  vn: 'Việt Nam',
  cmd_fx: 'Hàng hóa, tỷ giá, lợi suất',
};

/** Mô hình và mô tả ngắn. */
export const MODEL_NAMES = {
  M0: 'Tung đồng xu',
  M1: 'Tần suất lịch sử',
  M2: 'Xu hướng',
  M3: 'Vĩ mô gọn',
  M4: 'Chế độ rủi ro',
  M5: 'Tổ hợp',
  M6: 'AI (Claude)',
};

/** Mô hình được kiểm định (M6 chỉ có ở sổ trực tiếp). */
export const BACKTEST_MODELS = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'];
/** Ứng viên nhà vô địch. */
export const CANDIDATES = ['M2', 'M3', 'M4', 'M5'];

/** Huy hiệu độ tin cậy. */
export const BADGES = {
  strong: 'Có cơ sở',
  weak: 'Ít cơ sở',
  none: 'Chưa có cơ sở',
};

/**
 * Giới hạn tham số tối ưu: mặc định, khoảng cứng. Bộ tối ưu còn giữ trong ½–2 lần mặc định,
 * bước nhích ≤ 15% và không đảo dấu.
 */
export const PARAM_SPECS = [
  { key: 'm1Prior', def: 12, hard: [3, 48], label: 'M1: độ co về tỷ lệ nhóm (tháng)' },
  { key: 'lambdaM2', def: 5, hard: [0.5, 50], label: 'M2: phạt ridge' },
  { key: 'lambdaM3', def: 10, hard: [0.5, 100], label: 'M3: phạt ridge' },
  { key: 'lambdaM4', def: 10, hard: [0.5, 100], label: 'M4: phạt ridge' },
  { key: 'plattPrior', def: 5, hard: [0.5, 50], label: 'Hiệu chỉnh Platt: độ co về đường chéo' },
  { key: 'ewmaLambda', def: 0.94, hard: [0.85, 0.99], label: 'Vùng giá: hệ số EWMA (ngày)' },
  { key: 'tDof', def: 5, hard: [3, 30], label: 'Vùng giá: bậc tự do Student-t' },
  { key: 'driftShrink', def: 0.5, hard: [0, 1], label: 'Vùng giá: tỷ lệ giữ xu hướng trung bình' },
  { key: 'ensembleEta', def: 1, hard: [0.1, 5], label: 'M5: độ nhạy trọng số theo log score' },
  { key: 'ensembleShrink', def: 0.5, hard: [0.25, 1], label: 'M5: tỷ trọng tối thiểu của M1' },
  { key: 'tailMix', def: 0.5, hard: [0, 1], label: 'Xác suất giảm sâu: tỷ trọng phần phân phối' },
];

/** Cấu hình mặc định (bản 1). */
export const DEFAULT_CONFIG = {
  configVersion: 1,
  backtestStart: '2000-01-31',
  testMonths: 24,          // số mốc tháng cuối làm tập kiểm tra
  minTrainRows: 36,        // số dòng đã biết kết quả tối thiểu để học mô hình
  calibMinRows: 36,        // số dự báo ngoài mẫu tối thiểu để hiệu chỉnh Platt
  refitEvery: 3,           // học lại mỗi 3 tháng trong kiểm định
  ensembleWindow: 36,      // số tháng gần nhất dùng để tính trọng số M5
  probClip: [0.05, 0.95],  // giới hạn xác suất
  tailClip: [0.01, 0.99],
  coverageTarget: 0.8,     // vùng giá 80%
  coverageClip: [0.7, 1.6],
  callMinEdge: 0.05,       // call ≠ 0 khi |p − 50%| ≥ 5 điểm và nhóm có kỹ năng
  params: Object.fromEntries(PARAM_SPECS.map((p) => [p.key, p.def])),
  features: {
    M2: ['r1', 'r3', 'r12', 'dsma'],
    M3: {
      crypto: ['us.fincond', 'us.policy', 'us.usd', 'us.credit'],
      us_eq: ['us.growth', 'us.inflation', 'us.policy', 'us.fincond', 'us.credit', 'us.usd'],
      sea: ['world.growth', 'cn.growth', 'us.fincond', 'us.usd', 'us.policy'],
      vn: ['world.growth', 'cn.growth', 'us.fincond', 'us.usd', 'vn.fx'],
      cmd_fx: ['us.growth', 'us.inflation', 'us.policy', 'us.usd', 'world.growth'],
    },
    M4: ['risk.vix', 'risk.nfci', 'risk.credit', 'risk.curve', 'volRatio'],
  },
  pool: { crypto: true, us_eq: true, sea: true, vn: true, cmd_fx: false },
  bandMethod: 't',         // 't' (Student-t) hoặc 'bootstrap' (phần dư chuẩn hóa)
  riskBandMultiplier: 0,   // độ rộng vùng × exp(k · z VIX); 0 = tắt
  tail: {},                // ngưỡng giảm sâu theo nhóm và kỳ hạn, khóa ở G2: { group: { '1m': k, '3m': k } }
  tailTargetFreq: 0.125,   // tần suất mục tiêu khi chọn ngưỡng (10–15%)
  gates: {
    initialPBetter: 0.95,
    pBetterLow: 0.9,        // dưới 20 phép thử
    pBetterHigh: 0.95,      // từ 20 phép thử
    trialsThreshold: 20,
    liveIntervals: 3,
    eceMaxIncrease: 0.01,
    coverage: [0.7, 0.9],
    demoteIntervals: 6,
    demoteConfidence: 0.9,
    badgePBetter: 0.9,
    optimizeMinGain: 0.002,
    optimizePBetter: 0.8,
    optimizeMaxChanges: 6,
    optimizeStep: 0.15,
  },
  bootstrap: { B: 2000, seed: 20261122 },
};

/**
 * Gộp cấu hình (sâu) với bản ghi đè.
 * @param {object} base @param {object} [over]
 * @returns {object}
 */
export function mergeConfig(base, over) {
  if (!over) return structuredClone(base);
  const out = structuredClone(base);
  const rec = (t, o) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) rec(t[k], v);
      else t[k] = structuredClone(v);
    }
  };
  rec(out, over);
  return out;
}
