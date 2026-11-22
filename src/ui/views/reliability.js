// Độ tin cậy: kiểm định (BSS, p_better, ECE, độ phủ vùng 80%, giảm sâu) theo nhóm và kỳ hạn, biểu đồ
// hiệu chỉnh, kết quả trực tiếp từ sổ dự báo và các dự báo vừa tới hạn.

import { h, raw, delegate } from '../lib/dom.js';
import { S, byId } from '../lib/store.js';
import * as F from '../lib/fmt.js';
import { reliabilityChart } from '../lib/charts.js';
import { GROUP_ORDER, groupName, modelName, hbar } from './common.js';

const TARGET = { ece: 0.03, cov: [0.75, 0.85], pBetter: 0.9 };
const mark = (ok) => (ok ? h`<span class="up" title="đạt">✓</span>` : h`<span class="down" title="chưa đạt">✗</span>`);

function targetsCard(c) {
  const anySkill = GROUP_ORDER.some((g) => ['1m', '3m'].some((hz) => c.badges[g]?.[hz]?.key === 'strong'));
  let eceOk = 0; let covOk = 0; let n = 0;
  for (const hz of ['1m', '3m']) for (const g of GROUP_ORDER) {
    const sc = c.eval[hz]?.groups?.[g];
    if (!sc) continue;
    n++;
    const champ = c.badges[g]?.[hz]?.champion || 'M1';
    if (sc.models[champ].ece <= TARGET.ece) eceOk++;
    if (sc.coverage >= TARGET.cov[0] && sc.coverage <= TARGET.cov[1]) covOk++;
  }
  return h`<section class="card" aria-labelledby="t-tg"><header><h2 id="t-tg">Mục tiêu chất lượng</h2><span class="note">Kiểm định ${F.date(c.eval['1m'].period?.from)} – ${F.date(c.eval['1m'].period?.to)}, ${c.eval['1m'].period?.months ?? '–'} tháng</span></header>
    <ul class="stack" style="padding-left:18px;margin:0">
      <li>${mark(eceOk === n)} Sai lệch hiệu chỉnh (ECE) của mô hình đang dẫn ≤ 3 điểm %: đạt ${eceOk}/${n} nhóm × kỳ hạn.</li>
      <li>${mark(covOk === n)} Độ phủ vùng 80% trong 75–85%: đạt ${covOk}/${n}.</li>
      <li>${mark(anySkill)} Có ít nhất một nhóm thắng M1 với p_better ≥ 0,9: ${anySkill ? 'có' : 'chưa có kỹ năng ở nhóm nào'}.</li>
    </ul>
    <p class="note">BSS (Brier skill score) = 1 − Brier của mô hình / Brier của M1. Dương là dự báo tốt hơn tần suất lịch sử. p_better là xác suất (bootstrap theo khối tháng) mô hình tốt hơn M1. Nhà vô địch phải đạt p_better ≥ 0,95, tốt hơn M1 ở cả hai nửa giai đoạn và không kém ở 24 tháng kiểm tra cuối.</p>
  </section>`;
}

function groupTable(c, hz) {
  return h`<section class="card" aria-labelledby="t-gt-${hz}"><header><h2 id="t-gt-${hz}">Kỳ ${F.HZ[hz]}</h2></header>
    <div class="table-wrap"><table><thead><tr><th>Nhóm</th><th>Đang dẫn</th><th class="num">BSS (khoảng 95%)</th><th class="num">p_better</th><th class="num">ECE</th><th class="num">Độ phủ 80%</th><th class="num">Giảm sâu: BSS</th><th>Huy hiệu</th></tr></thead>
    <tbody>${GROUP_ORDER.map((g) => {
      const sc = c.eval[hz]?.groups?.[g];
      if (!sc) return '';
      const b = c.badges[g]?.[hz];
      const champ = b?.champion || 'M1';
      const m = sc.models[champ];
      const best = ['M2', 'M3', 'M4', 'M5'].map((M) => [M, sc.models[M]]).sort((x, y) => y[1].skill - x[1].skill)[0];
      return h`<tr><th scope="row">${groupName(g)} <span class="muted small">(${sc.n})</span></th>
        <td>${champ}${champ === 'M1' ? h`<div class="small muted">ứng viên tốt nhất ${best[0]}: ${F.signed(best[1].skill * 100, 1)}%, p ${F.num(best[1].pBetter, 2)}</div>` : ''}</td>
        <td class="num">${champ === 'M1' ? '0' : h`${F.signed(m.skill * 100, 1)}% <span class="muted small">(${F.signed(m.skillLo * 100, 1)}…${F.signed(m.skillHi * 100, 1)})</span>`}</td>
        <td class="num">${champ === 'M1' ? '–' : F.num(m.pBetter, 3)}</td>
        <td class="num">${F.pct(m.ece, 1)} ${mark(m.ece <= TARGET.ece)}</td>
        <td class="num">${F.pct(sc.coverage, 1)} ${mark(sc.coverage >= TARGET.cov[0] && sc.coverage <= TARGET.cov[1])}</td>
        <td class="num">${sc.tail ? h`<span class="${sc.tail.skill > 0 ? 'up' : 'down'}">${F.signed(sc.tail.skill * 100, 1)}%</span>` : '–'}</td>
        <td>${F.badgeChip(b?.key)}</td></tr>`;
    })}</tbody></table></div></section>`;
}

function detailCard(c, width) {
  const g = S.ui.relGroup || 'cmd_fx';
  const hz = S.ui.relH || '3m';
  const sc = c.eval[hz]?.groups?.[g];
  if (!sc) return '';
  const champ = c.badges[g]?.[hz]?.champion || 'M1';
  const models = ['M1', 'M2', 'M3', 'M4', 'M5'];
  const maxAbs = Math.max(0.01, ...models.flatMap((M) => [Math.abs(sc.models[M].skillHi), Math.abs(sc.models[M].skillLo)]));
  return h`<section class="card" aria-labelledby="t-det"><header><h2 id="t-det">Chi tiết theo nhóm</h2>
      <div class="row"><label for="rel-g" class="sr-only">Nhóm</label><select id="rel-g" data-action="relg">${GROUP_ORDER.map((x) => h`<option value="${x}" ${x === g ? raw('selected') : ''}>${groupName(x)}</option>`)}</select>
      <div class="seg" role="group" aria-label="Kỳ hạn">${['1m', '3m'].map((x) => h`<button type="button" data-action="relh" data-h="${x}" aria-pressed="${x === hz}">${F.HZ[x]}</button>`)}</div></div></header>
    <div class="grid-2">
      <div class="stack"><h3>Hiệu chỉnh của ${champ}</h3><div class="chart">${raw(reliabilityChart(sc.models[champ].calib || [], Math.min(width - 40, 360), `Biểu đồ hiệu chỉnh ${groupName(g)} ${F.HZ[hz]}`))}</div>
        <p class="note">Điểm nằm trên đường chéo là hiệu chỉnh tốt: dự báo 60% thì khoảng 60% số lần xảy ra. Điểm to là nhóm xác suất có nhiều dự báo.</p></div>
      <div class="stack"><h3>So với M1</h3>
        <div class="table-wrap"><table><thead><tr><th>Mô hình</th><th>BSS</th><th class="num">p_better</th><th class="num">Tỷ lệ đúng hướng</th><th class="num">24 tháng cuối</th></tr></thead>
        <tbody>${models.map((M) => {
          const m = sc.models[M];
          return h`<tr><th scope="row">${M} · ${modelName(M)}${M === champ ? h` <span class="tag">đang dẫn</span>` : ''}</th>
            <td><div class="row nowrap">${hbar(m.skill, maxAbs)}<span>${F.signed(m.skill * 100, 1)}%</span></div></td>
            <td class="num">${M === 'M1' ? '–' : F.num(m.pBetter, 3)}</td><td class="num">${F.pct(m.hit)}</td>
            <td class="num">${m.test ? h`${F.signed(m.test.skill * 100, 1)}%` : '–'}</td></tr>`;
        })}</tbody></table></div>
        <p class="note">Tỷ lệ tăng thực tế của nhóm trong kiểm định: ${F.pct(sc.upRate)}. "24 tháng cuối" là BSS ở tập kiểm tra cuối, phần chưa dùng để chọn.</p>
      </div>
    </div></section>`;
}

function liveCard(c) {
  const ls = c.liveStats || {};
  const iv1 = c.summaryInfo?.intervals?.['1m'] || [];
  const rows = [];
  for (const hz of ['1m', '3m']) for (const g of GROUP_ORDER) {
    const x = ls[hz]?.[g];
    if (!x) continue;
    const m = x.models[x.champion];
    const p7 = x.p7;
    rows.push(h`<tr><th scope="row">${groupName(g)}</th><td>${F.HZ[hz]}</td><td>${x.champion}</td>
      <td class="num">${m?.intervals ? h`${F.signed((m.skill ?? 0) * 100, 1)}% <span class="muted small">(${m.intervals} khoảng, p ${F.num(m.pBetter, 2)})</span>` : h`<span class="muted">chưa tới hạn</span>`}</td>
      <td class="num">${x.band?.n ? h`${F.pct(x.band.inBand / x.band.n)} <span class="muted small">(${x.band.n})</span>` : '–'}</td>
      <td class="num">${p7?.[x.champion]?.[1] ? h`${F.num(p7[x.champion][0] / p7[x.champion][1], 3)} / ${F.num(p7.M1[0] / p7.M1[1], 3)}` : '–'}</td></tr>`);
  }
  return h`<section class="card" aria-labelledby="t-live"><header><h2 id="t-live">Kết quả trực tiếp (sổ dự báo)</h2><span class="note">${iv1.length ? `${iv1.length} khoảng 1 tháng không trùng nhau` : 'Chưa khoảng nào tới hạn'}</span></header>
    <div class="table-wrap"><table><thead><tr><th>Nhóm</th><th>Kỳ</th><th>Đang dẫn</th><th class="num">BSS trực tiếp</th><th class="num">Trong vùng 80%</th><th class="num">Brier tạm 7 ngày (dẫn / M1)</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Mỗi ngày ghi một dự báo bất biến (có hash). Kỹ năng trực tiếp chỉ đếm các khoảng không trùng nhau: hai dự báo cách nhau dưới một kỳ hạn dùng chung thông tin nên không tính là hai bằng chứng. Điểm tạm 7 ngày quy xác suất về 7 ngày để có tín hiệu sớm, không dùng để quyết định.</p>
  </section>`;
}

function recentCard(c) {
  const rs = (c.recentScores || []).flatMap((x) => x.matured).filter((m) => m.h === '1m').slice(0, 28);
  if (!rs.length) return '';
  return h`<section class="card" aria-labelledby="t-rec"><header><h2 id="t-rec">Dự báo vừa tới hạn</h2></header>
    <div class="table-wrap"><table><thead><tr><th>Ngày dự báo</th><th>Tài sản</th><th class="num">Xác suất tăng</th><th class="num">M1</th><th>Kết quả</th><th>Trong vùng 80%</th></tr></thead>
    <tbody>${rs.map((m) => h`<tr><td>${F.date(m.fd)}</td><td>${byId(m.a)?.name || m.a}</td><td class="num">${F.pct(m.p)}</td><td class="num muted">${F.pct(m.m1)}</td>
      <td class="${m.y ? 'up' : 'down'}">${m.y ? 'Tăng' : 'Giảm'}</td><td>${m.inBand ? 'có' : h`<b>không</b>`}</td></tr>`)}</tbody></table></div></section>`;
}

function icCard(c) {
  const ic = c.eval['1m']?.ic || {};
  return h`<p class="note">Tương quan thứ hạng giữa các tài sản mỗi tháng (IC, kỳ 1 tháng): ${Object.entries(ic).map(([M, v], i) => `${i ? '; ' : ''}${M} ${F.signed(v, 3)}`).join('')}. IC quanh 0 nghĩa là mô hình chưa xếp hạng được tài sản nào sẽ tốt hơn tài sản nào.</p>`;
}

export function render(ctx) {
  const c = S.core;
  return h`${targetsCard(c)}${groupTable(c, '1m')}${groupTable(c, '3m')}${detailCard(c, ctx.width)}${liveCard(c)}${recentCard(c)}<section class="card">${icCard(c)}</section>`;
}

export function mount(root, ctx, rerender) {
  delegate(root, 'change', { relg: (el) => { S.ui.relGroup = el.value; rerender(); } });
  delegate(root, 'click', { relh: (el) => { S.ui.relH = el.dataset.h; rerender(); } });
}
