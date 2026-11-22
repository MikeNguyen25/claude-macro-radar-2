// Định dạng kiểu Việt Nam (dấu phẩy thập phân, dấu chấm hàng nghìn) và nhãn tiếng Việt.

import { h } from './dom.js';

const NF = new Map();
const nf = (d) => {
  if (!NF.has(d)) NF.set(d, new Intl.NumberFormat('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  return NF.get(d);
};
export const ok = (x) => x !== null && x !== undefined && Number.isFinite(x);
export const num = (x, d = 2) => (ok(x) ? nf(d).format(x) : '–');
export const pct = (x, d = 0) => (ok(x) ? `${nf(d).format(x * 100)}%` : '–');
export const signed = (x, d = 1) => (ok(x) ? `${x > 0 ? '+' : x < 0 ? '−' : '±'}${nf(d).format(Math.abs(x))}` : '–');
/** Chênh lệch xác suất, tính bằng điểm phần trăm. */
export const pp = (x, d = 1) => (ok(x) ? `${signed(x * 100, d)} điểm %` : '–');
export const date = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '–');
export const dshort = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '–');
export const month = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '–');

/** Giờ Việt Nam của một mốc ISO UTC. */
export function vnTime(isoZ) {
  if (!isoZ) return '–';
  const d = new Date(new Date(isoZ).getTime() + 7 * 3600e3).toISOString();
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
}
export const vnToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
export const dayNum = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 864e5);
export const dayIso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

export function ago(isoZ) {
  if (!isoZ) return '';
  const m = Math.round((Date.now() - new Date(isoZ).getTime()) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  if (m < 48 * 60) return `${Math.round(m / 60)} giờ trước`;
  return `${Math.round(m / 1440)} ngày trước`;
}

/** Giá theo loại tài sản: lợi suất ghi %, giá lớn bỏ phần lẻ, giá nhỏ giữ 4 chữ số. */
export function price(v, a) {
  if (!ok(v)) return '–';
  if (a?.kind === 'yield') return `${num(v, 2)}%`;
  const x = Math.abs(v);
  return num(v, x >= 1000 ? 0 : x >= 100 ? 1 : x >= 1 ? 2 : 4);
}
/** Thay đổi giá: % với giá, điểm cơ bản với lợi suất. */
export function change(ch, a) {
  if (!ok(ch)) return '–';
  return a?.kind === 'yield' ? `${signed(ch * 100, 0)} điểm cơ bản` : `${signed(ch * 100, 1)}%`;
}

export const HZ = { '1m': '1 tháng', '3m': '3 tháng' };
export const HZ_DAYS = { '1m': 30, '3m': 91 };
export const BADGE = { strong: 'Có cơ sở', weak: 'Ít cơ sở', none: 'Chưa có cơ sở' };
export const REGION = { us: 'Mỹ', cn: 'Trung Quốc', world: 'Thế giới', vn: 'Việt Nam' };
export const FACTOR = {
  growth: 'tăng trưởng', inflation: 'lạm phát', policy: 'lãi suất điều hành', fincond: 'điều kiện tài chính', credit: 'chênh lệch tín dụng',
  usd: 'đô la Mỹ', curve: 'độ dốc lợi suất', money: 'cung tiền', rates: 'lợi suất trái phiếu', fx: 'tỷ giá',
};
const FEAT = {
  r1: 'Biến động 1 tháng', r3: 'Biến động 3 tháng', r12: 'Biến động 12 tháng', dsma: 'Cách đường trung bình 200 phiên', volRatio: 'Biến động ngắn so với dài',
  'risk.vix': 'VIX (độ lo ngại)', 'risk.nfci': 'Điều kiện tài chính Mỹ', 'risk.credit': 'Chênh lệch tín dụng BAA', 'risk.curve': 'Độ dốc 10 năm − 3 tháng',
};
export function featLabel(k) {
  if (FEAT[k]) return FEAT[k];
  const [r, f] = String(k).split('.');
  if (REGION[r] && FACTOR[f]) return `${REGION[r]} · ${FACTOR[f]}`;
  return k;
}
export const VIEW = { tang: 'Nghiêng tăng', giam: 'Nghiêng giảm', trung_lap: 'Trung lập' };
export const CONF = { thap: 'Tự tin thấp', vua: 'Tự tin vừa', cao: 'Tự tin cao' };
export const EXP_STATUS = { proposed: 'Chờ kiểm định', shadow: 'Chạy song song', rejected: 'Trượt', promoted: 'Đã lên ngôi', retired: 'Đã dừng' };

export function badgeChip(key, label) {
  return h`<span class="chip ${key || 'none'}">${label || BADGE[key] || BADGE.none}</span>`;
}

/** Diễn giải z-score bằng lời. */
export function zWord(z) {
  if (!ok(z)) return 'thiếu số liệu';
  if (z >= 1.5) return 'rất cao';
  if (z >= 0.5) return 'cao';
  if (z > -0.5) return 'quanh mức thường';
  if (z > -1.5) return 'thấp';
  return 'rất thấp';
}
