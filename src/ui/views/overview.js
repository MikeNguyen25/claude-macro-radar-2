// Tổng quan: bức tranh hôm nay, xác suất tăng của 14 tài sản, biến động phiên gần nhất, chất lượng số liệu.

import { h } from '../lib/dom.js';
import { S, byId, liveOf } from '../lib/store.js';
import * as F from '../lib/fmt.js';
import { GROUP_ORDER, groupName, pbar, AI_LABEL } from './common.js';

function freshness(c) {
  const today = F.vnToday();
  const vnHour = new Date(Date.now() + 7 * 3600e3).getUTCHours();
  if (c.date === today) return '';
  const late = c.date < today && (vnHour >= 9 || F.dayNum(today) - F.dayNum(c.date) > 1);
  if (!late) return '';
  return h`<div class="callout warn" role="status">Đây là dự báo ngày ${F.date(c.date)}. Bản của hôm nay chưa đăng; xem Nhật ký để biết lần chạy gần nhất.</div>`;
}

function regimeCard(c) {
  const rows = ['us', 'cn', 'world', 'vn'].map((r) => {
    const x = c.regime.regions[r];
    if (!x) return '';
    const arrow = (d) => (F.ok(d) ? (d > 0.05 ? '↑' : d < -0.05 ? '↓' : '→') : '');
    return h`<tr><th scope="row">${x.name}</th><td>${x.label}</td>
      <td class="num">${F.signed(x.growth, 2)} <span class="muted">${arrow(x.dGrowth)}</span></td>
      <td class="num">${F.signed(x.inflation, 2)} <span class="muted">${arrow(x.dInflation)}</span></td></tr>`;
  });
  const risk = c.regime.risk;
  const calls = c.live.filter((i) => i.call !== 0);
  return h`<section class="card" aria-labelledby="t-regime">
    <header><h2 id="t-regime">Bức tranh hôm nay</h2><span class="note">Kịch bản tính từ số liệu đã công bố tới ${F.date(c.regime.asOf)}</span></header>
    <div class="table-wrap"><table>
      <thead><tr><th>Vùng</th><th>Góc phần tư</th><th class="num">Tăng trưởng (z)</th><th class="num">Lạm phát (z)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p>Tâm lý thị trường: <b>${risk.label}</b> <span class="muted">(điểm rủi ro ${F.num(risk.score, 2)}; trên 0,5 là né rủi ro, dưới −0,25 là ưa rủi ro)</span></p>
    ${calls.length
      ? h`<p>Nghiêng có cơ sở: ${calls.map((i, k) => h`${k ? '; ' : ''}<a href="#tai-san-${i.a}">${byId(i.a)?.name}</a> ${F.HZ[i.h]} ${F.pct(i.pc)} tăng`)}.</p>`
      : h`<p class="muted">Chưa tài sản nào có xác suất vừa đủ cơ sở vừa cách 50% từ 5 điểm trở lên.</p>`}
    ${c.ai?.headline ? h`<div class="callout"><span class="tag">${AI_LABEL}</span> ${c.ai.headline} <a href="#ai">Xem nhận định</a></div>` : ''}
  </section>`;
}

function probList(c) {
  const out = [];
  for (const g of GROUP_ORDER) {
    const assets = c.assets.filter((a) => a.group === g && a.forecast);
    if (!assets.length) continue;
    const b1 = c.badges[g]?.['1m'];
    const b3 = c.badges[g]?.['3m'];
    out.push(h`<div class="prob-group"><h3>${groupName(g)}</h3>
      <span class="small muted">1 tháng</span>${F.badgeChip(b1?.key)}<span class="small muted">3 tháng</span>${F.badgeChip(b3?.key)}</div>`);
    for (const a of assets) {
      const i1 = liveOf(a.id, '1m');
      const i3 = liveOf(a.id, '3m');
      if (!i1 && !i3) {
        out.push(h`<div class="prob-row"><div class="c-name"><span class="asset-name">${a.name}</span></div><div class="muted">Chưa đủ cơ sở: thiếu số liệu</div></div>`);
        continue;
      }
      const it = i1 || i3;
      out.push(h`<a class="prob-row" href="#tai-san-${a.id}">
        <div class="c-name"><span class="asset-name">${a.name}</span><span class="asset-sub">${F.dshort(it.pd)}</span></div>
        <div><span class="cell-label">Giá</span>${F.price(it.px, a)}</div>
        <div><span class="cell-label">Tăng sau 1 tháng</span>${pbar(i1?.pc, i1?.base, `${a.name}: xác suất tăng sau 1 tháng`)}</div>
        <div><span class="cell-label">Tăng sau 3 tháng</span><b class="${i3?.pc >= 0.5 ? 'up' : 'down'}">${F.pct(i3?.pc)}</b></div>
        <div><span class="cell-label">Vùng 80% sau 1 tháng</span>${F.price(i1?.lo, a)} – ${F.price(i1?.hi, a)}</div>
        <div><span class="cell-label">Giảm sâu 1 tháng</span>${F.pct(i1?.pt)}</div>
      </a>`);
    }
  }
  return h`<section class="card" aria-labelledby="t-prob">
    <header><h2 id="t-prob">Xác suất tăng</h2><span class="note">Dự báo ngày ${F.date(c.date)} · v${c.version}</span></header>
    <div class="prob-list">
      <div class="prob-head"><span>Tài sản</span><span>Giá</span><span>Tăng sau 1 tháng</span><span>3 tháng</span><span>Vùng giá 80% sau 1 tháng</span><span>Giảm sâu</span></div>
      ${out}
    </div>
    <p class="note">Xác suất đã hiệu chỉnh của mô hình đang dẫn từng nhóm. Vạch đậm trên thanh là tần suất tăng lịch sử (M1). "Chưa có cơ sở" nghĩa là chưa mô hình nào thắng M1 một cách đáng tin, nên con số chính là tần suất lịch sử. "Giảm sâu" là xác suất giảm quá ngưỡng của nhóm trong 30 ngày (ngưỡng ở trang Tài sản).</p>
  </section>`;
}

function movesCard(c) {
  if (!c.moves?.length) return '';
  return h`<section class="card" aria-labelledby="t-moves">
    <header><h2 id="t-moves">Biến động phiên gần nhất</h2><span class="note">Ba biến động lớn nhất so với độ dao động thường ngày của chính tài sản</span></header>
    <div class="table-wrap"><table><tbody>${c.moves.map((m) => {
      const a = byId(m.id);
      return h`<tr><th scope="row"><a href="#tai-san-${m.id}">${m.name}</a></th><td class="num ${m.ch >= 0 ? 'up' : 'down'}">${F.change(m.ch, a)}</td><td class="num muted">${F.num(m.z, 1)} lần độ lệch chuẩn</td><td class="num muted">${F.dshort(m.date)}</td></tr>`;
    })}</tbody></table></div>
  </section>`;
}

function dataCard(c) {
  const issues = [...(c.qa?.issues || []), ...(c.runNotes?.errors || [])];
  const stale = c.series.filter((s) => s.stale).map((s) => s.name);
  return h`<section class="card" aria-labelledby="t-data">
    <header><h2 id="t-data">Chất lượng số liệu</h2><a class="small" href="#nhat-ky">Nhật ký đầy đủ</a></header>
    ${issues.length ? h`<ul>${issues.map((x) => h`<li>${x}</li>`)}</ul>` : h`<p>Không có sự cố trong lần cập nhật gần nhất.</p>`}
    ${stale.length ? h`<p class="note">Chuỗi vĩ mô quá cũ nên không vào mô hình: ${stale.join(', ')}.</p>` : ''}
    <p class="note">Số liệu chạy lúc ${F.vnTime(c.status?.lastRun?.at || c.generatedAt)}${c.publishedAt ? h`, đăng lúc ${F.vnTime(c.publishedAt)}` : ''}.</p>
  </section>`;
}

export function render() {
  const c = S.core;
  return h`${freshness(c)}${regimeCard(c)}${probList(c)}<div class="grid-2">${movesCard(c)}${dataCard(c)}</div>`;
}
