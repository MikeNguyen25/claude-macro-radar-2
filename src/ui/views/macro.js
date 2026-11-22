// Vĩ mô: điểm tổng hợp theo vùng × yếu tố, từng chuỗi với kỳ, ngày công bố, độ lệch chuẩn và nguồn.

import { h, raw } from '../lib/dom.js';
import { S, seriesHist, loadHistory, dbList, emit } from '../lib/store.js';
import { manualDue } from '../../engine/manual.mjs';
import * as F from '../lib/fmt.js';
import { sparkline } from '../lib/charts.js';
import { sourceLink } from './common.js';

const REGIONS = ['us', 'cn', 'world', 'vn'];
const FACTORS = ['growth', 'inflation', 'policy', 'fincond', 'credit', 'usd', 'curve', 'fx'];
const TRANSFORM = { level: 'mức', level50: 'mức − 50', yoy: '% so cùng kỳ', chg6: 'thay đổi 6 tháng', pct6: '% thay đổi 6 tháng' };
const FREQ = { D: 'ngày', W: 'tuần', M: 'tháng', Q: 'quý' };

function zCell(z) {
  if (!F.ok(z)) return h`<td class="num muted">–</td>`;
  const cls = z >= 0.5 ? 'up' : z <= -0.5 ? 'down' : '';
  return h`<td class="num"><b class="${cls}">${F.signed(z, 2)}</b> <span class="muted small">${F.zWord(z)}</span></td>`;
}

function compositeTable(c) {
  const m = c.regime.macro;
  const rows = FACTORS.filter((f) => REGIONS.some((r) => `${r}.${f}` in m));
  return h`<section class="card" aria-labelledby="t-comp"><header><h2 id="t-comp">Điểm tổng hợp</h2><span class="note">Trung bình z của các chuỗi cùng yếu tố, đã đổi dấu để dương nghĩa là mạnh hơn hoặc cao hơn</span></header>
    <div class="table-wrap"><table><thead><tr><th>Yếu tố</th>${REGIONS.map((r) => h`<th class="num">${F.REGION[r]}</th>`)}</tr></thead>
    <tbody>${rows.map((f) => h`<tr><th scope="row">${F.FACTOR[f][0].toUpperCase()}${F.FACTOR[f].slice(1)}</th>${REGIONS.map((r) => zCell(m[`${r}.${f}`] ?? null))}</tr>`)}</tbody></table></div>
    <p class="note">z so với lịch sử mở rộng dần của chính chuỗi (không dùng số liệu tương lai), chặn trong ±4. Chuỗi chỉ được tính sau ngày công bố (độ trễ công bố riêng từng chuỗi).</p>
  </section>`;
}

function seriesTable(c, region) {
  const list = c.series.filter((s) => s.region === region);
  if (!list.length) return '';
  return h`<section class="card" aria-labelledby="t-s-${region}"><header><h2 id="t-s-${region}">${F.REGION[region]}</h2><span class="note">${list.length} chuỗi</span></header>
    <div class="table-wrap"><table><thead><tr><th>Chuỗi</th><th class="num">Giá trị</th><th>Kỳ</th><th>Công bố</th><th class="num">z</th><th>24 kỳ gần nhất</th><th>Nguồn</th></tr></thead>
    <tbody>${list.map((s) => {
      const hist = seriesHist(s.id);
      const v = hist ? hist.v.slice(-24) : [];
      return h`<tr>
        <th scope="row">${s.name}<div class="small muted">${F.FACTOR[s.factor] || s.factor} · ${FREQ[s.freq] || s.freq} · ${TRANSFORM[s.transform] || s.transform}${s.stale ? h` · <b class="down">quá cũ, không dùng</b>` : ''}</div></th>
        <td class="num">${F.num(s.last.value, Math.abs(s.last.value) >= 1000 ? 0 : 2)} <span class="muted small">${s.unit}</span></td>
        <td class="nowrap">${s.freq === 'D' || s.freq === 'W' ? F.date(s.last.date) : F.month(s.last.date)}</td>
        <td class="nowrap">${F.date(s.last.avail)}</td>
        <td class="num">${F.signed(s.z, 2)}</td>
        <td>${hist ? raw(sparkline(v)) : h`<span class="muted small">…</span>`}</td>
        <td class="small">${sourceLink(s.source)}</td></tr>`;
    })}</tbody></table></div></section>`;
}

function manualCard(c) {
  // số nhập tay nằm trong DB của artifact; khung xem không mở được DB thì dùng bản đi kèm bundle
  const docs = S.ui.manualDocs;
  const have = docs ? docs.map((m) => ({ id: m.id, name: m.name, unit: m.unit, last: m.d?.length ? { date: m.d[m.d.length - 1], value: m.v[m.v.length - 1], confidence: m.src?.[m.src.length - 1]?.confidence, sources: m.src?.[m.src.length - 1]?.sources || [] } : null })) : c.manual || [];
  const due = manualDue(docs || [], F.vnToday());
  if (!have.length && !due.length) return '';
  return h`<section class="card" aria-labelledby="t-manual"><header><h2 id="t-manual">Việt Nam: số đọc từ thông cáo</h2><span class="note">Chỉ hiển thị, chưa vào mô hình cho tới khi đủ 36 tháng</span></header>
    ${have.length ? h`<div class="table-wrap"><table><thead><tr><th>Chuỗi</th><th class="num">Giá trị</th><th>Kỳ</th><th>Độ tin</th><th>Nguồn</th></tr></thead><tbody>${have.map((m) => h`<tr>
      <th scope="row">${m.name}</th><td class="num">${m.last ? F.num(m.last.value, 2) : '–'} <span class="muted small">${m.unit}</span></td><td>${m.last ? F.month(m.last.date) : '–'}</td>
      <td>${m.last?.confidence || '–'}</td><td class="small">${(m.last?.sources || []).map((s, i) => h`${i ? '; ' : ''}${sourceLink(s)}`)}</td></tr>`)}</tbody></table></div>` : ''}
    ${due.length ? h`<p class="note">Chờ số: ${due.map((d, i) => h`${i ? '; ' : ''}${d.name} kỳ ${F.month(`${d.period}-01`)}`)}.</p>` : ''}
  </section>`;
}

export function render() {
  const c = S.core;
  return h`${compositeTable(c)}${REGIONS.map((r) => seriesTable(c, r))}${manualCard(c)}`;
}

export function mount() {
  if (!S.history) loadHistory();
  if (S.capsReady && S.caps.db && !S.ui.manualDocs && !S.ui.manualLoading) {
    S.ui.manualLoading = true;
    dbList('manual', { limit: 20 }).then((d) => { S.ui.manualDocs = d || []; }).catch(() => { S.ui.manualDocs = []; }).finally(emit);
  }
}
