// Mảnh giao diện dùng chung giữa các trang.

import { h, raw } from '../lib/dom.js';
import { S } from '../lib/store.js';
import * as F from '../lib/fmt.js';

export const GROUP_ORDER = ['crypto', 'us_eq', 'sea', 'vn', 'cmd_fx'];
export const groupName = (g) => S.core?.names.groups[g] || g;
export const modelName = (M) => {
  if (String(M).startsWith('X:')) { const [, exp, m] = M.split(':'); return `${m} theo ${exp} (song song)`; }
  return S.core?.names.models[M] || M;
};

/** Thanh xác suất tăng: phần xanh là xác suất tăng, vạch đậm là tần suất lịch sử M1. */
export function pbar(p, base, label) {
  if (!F.ok(p)) return h`<span class="muted">–</span>`;
  const w = Math.max(0, Math.min(100, p * 100));
  const b = F.ok(base) ? Math.max(0, Math.min(100, base * 100)) : null;
  return h`<div class="pbar" role="img" aria-label="${label || 'Xác suất tăng'} ${F.pct(p)}${b !== null ? `, tần suất lịch sử ${F.pct(base)}` : ''}">
    <div class="pbar-top"><span class="pbar-val ${p >= 0.5 ? 'up' : 'down'}">${F.pct(p)}</span>${b !== null && Math.abs(p - base) >= 0.005 ? h`<span class="delta">${F.pp(p - base)} so với M1</span>` : b !== null ? h`<span class="delta">bằng M1</span>` : ''}</div>
    <div class="pbar-track"><div class="pbar-fill" style="width:${w.toFixed(1)}%"></div><div class="pbar-mid"></div>${b !== null ? raw(`<div class="pbar-base" style="left:calc(${b.toFixed(1)}% - 1px)"></div>`) : ''}</div>
  </div>`;
}

/** Thanh ngang có dấu (cho BSS, đóng góp). */
export function hbar(v, maxAbs) {
  if (!F.ok(v) || !(maxAbs > 0)) return h`<div class="hbar"></div>`;
  const half = Math.min(50, (Math.abs(v) / maxAbs) * 50);
  const left = v >= 0 ? 50 : 50 - half;
  return h`<div class="hbar" aria-hidden="true"><i style="left:50%"></i><span class="${v < 0 ? 'neg' : ''}" style="left:${left.toFixed(1)}%;width:${half.toFixed(1)}%"></span></div>`;
}

export function sourceLink(src) {
  if (!src) return '';
  return src.url ? h`<a href="${src.url}" rel="noopener" target="_blank">${src.name}</a>` : h`${src.name}`;
}

/** Nhãn AI dùng thống nhất ở mọi nơi. */
export const AI_LABEL = 'AI · chưa kiểm chứng';

export function loadingBox(msg = 'Đang tải…') {
  return h`<div class="loading" role="status">${msg}</div>`;
}

/** Tóm tắt kiểm định của nhà vô địch nhóm g, kỳ h. */
export function champStats(g, hz) {
  const sc = S.core.eval[hz]?.groups?.[g];
  const champ = S.core.badges[g]?.[hz]?.champion || 'M1';
  return { sc, champ, m: sc?.models?.[champ], badge: S.core.badges[g]?.[hz] };
}

export const KIND_UNIT = (a) => (a.kind === 'yield' ? '%' : a.unit);
