// Tài sản: biểu đồ giá kèm quạt dự báo, xác suất theo từng mô hình, yếu tố vĩ mô, giảm sâu,
// thành tích kiểm định của chính tài sản và nguồn số liệu.

import { h, raw, $, delegate } from '../lib/dom.js';
import { S, byId, liveOf, histOf, loadHistory } from '../lib/store.js';
import * as F from '../lib/fmt.js';
import { lineChart } from '../lib/charts.js';
import { GROUP_ORDER, groupName, modelName, pbar, hbar, sourceLink, loadingBox, AI_LABEL } from './common.js';

const yfmt = (a) => (v) => (a.kind === 'yield' ? `${F.num(v, 1)}%` : Math.abs(v) >= 100 ? F.num(v, 0) : Math.abs(v) >= 1 ? F.num(v, 1) : F.num(v, 3));

function selector(current) {
  const groups = GROUP_ORDER.map((g) => h`<optgroup label="${groupName(g)}">${S.core.assets.filter((a) => a.group === g && a.forecast)
    .map((a) => h`<option value="${a.id}" ${a.id === current ? raw('selected') : ''}>${a.name}</option>`)}</optgroup>`);
  return h`<label for="asset-sel">Tài sản<select id="asset-sel" data-action="pick">${groups}</select></label>`;
}

function forecastText(a, it) {
  if (!it) return h`<p class="muted">Chưa đủ cơ sở: thiếu số liệu cho kỳ này.</p>`;
  const end = F.dayIso(F.dayNum(it.pd) + F.HZ_DAYS[it.h]);
  return h`<p>Tới ${F.date(end)}: 80% khả năng ${a.kind === 'yield' ? 'lợi suất' : 'giá'} nằm trong <b>${F.price(it.lo, a)} – ${F.price(it.hi, a)}</b>, trung vị ${F.price(it.mid, a)}. Xác suất tăng <b>${F.pct(it.pc)}</b>; tần suất lịch sử ${F.pct(it.base)}.</p>`;
}

function modelTable(a, hz) {
  const it = liveOf(a.id, hz);
  if (!it) return '';
  const sc = S.core.eval[hz]?.groups?.[a.group];
  const live = S.core.liveStats?.[hz]?.[a.group]?.models || {};
  const ai = hz === '1m' ? S.core.ai?.assets?.find((x) => x.id === a.id) : null;
  const rows = Object.entries(it.p).filter(([M]) => M !== 'M0').map(([M, p]) => ({ M, p }));
  if (ai) rows.push({ M: 'M6', p: ai.prob_up });
  const maxAbs = Math.max(0.02, ...rows.map((r) => Math.abs(sc?.models?.[r.M]?.skill ?? 0)));
  return h`<div class="table-wrap"><table>
    <caption class="sr-only">Xác suất tăng sau ${F.HZ[hz]} theo từng mô hình</caption>
    <thead><tr><th>Mô hình</th><th class="num">Xác suất tăng</th><th class="num">So với M1</th><th>Kiểm định: BSS</th><th class="num">p_better</th><th class="num">Trực tiếp</th></tr></thead>
    <tbody>${rows.map(({ M, p }) => {
      const m = sc?.models?.[M];
      const lv = live[M];
      const isChamp = M === it.champ;
      return h`<tr>
        <th scope="row">${M} · ${modelName(M)}${isChamp ? h` <span class="tag">đang dẫn</span>` : ''}${M === 'M6' ? h` <span class="tag">${AI_LABEL}</span>` : ''}</th>
        <td class="num"><b>${F.pct(p, 1)}</b></td>
        <td class="num">${M === 'M1' ? '–' : F.pp(p - it.base)}</td>
        <td>${m ? h`<div class="row nowrap">${hbar(m.skill, maxAbs)}<span class="${m.skill > 0 ? 'up' : m.skill < 0 ? 'down' : ''}">${F.signed(m.skill * 100, 1)}%</span> <span class="muted small">(${F.signed(m.skillLo * 100, 1)}…${F.signed(m.skillHi * 100, 1)})</span></div>` : h`<span class="muted">${M === 'M6' ? 'chấm khi tới hạn' : '–'}</span>`}</td>
        <td class="num">${m && M !== 'M1' ? F.num(m.pBetter, 2) : '–'}</td>
        <td class="num">${lv?.intervals ? h`${F.signed((lv.skill ?? 0) * 100, 1)}% <span class="muted">(${lv.intervals} khoảng)</span>` : h`<span class="muted">chưa tới hạn</span>`}</td>
      </tr>`;
    })}</tbody></table></div>
    <p class="note">BSS là mức giảm sai số Brier so với M1 trên ${sc?.n ?? '–'} dự báo kiểm định của cả nhóm ${groupName(a.group)} (dương là tốt hơn M1; trong ngoặc là khoảng tin cậy 95%). p_better là xác suất bootstrap mô hình tốt hơn M1. "Trực tiếp" chỉ tính dự báo đã ghi sổ và đã tới hạn.</p>`;
}

function contribBlock(it) {
  if (!it?.contrib?.length) return '';
  const maxAbs = Math.max(0.05, ...it.contrib.map((c) => Math.abs(c.value)));
  return h`<div class="stack"><h3>Yếu tố vĩ mô (mô hình M3)</h3>
    <div class="table-wrap"><table><tbody>${[...it.contrib].sort((x, y) => Math.abs(y.value) - Math.abs(x.value)).map((c) => h`<tr>
      <th scope="row">${F.featLabel(c.name)}</th><td style="width:45%">${hbar(c.value, maxAbs)}</td><td class="num ${c.value > 0 ? 'up' : c.value < 0 ? 'down' : ''}">${c.value > 0 ? 'đẩy lên' : c.value < 0 ? 'kéo xuống' : 'trung tính'}</td></tr>`)}</tbody></table></div>
    <p class="note">Đóng góp vào xác suất tăng của M3 (đơn vị log-odds). M3 chỉ là một ứng viên; nó chỉ được dùng khi đã thắng M1 qua các cửa kiểm định.</p></div>`;
}

function tailBlock(a, it) {
  if (!it || !F.ok(it.pt)) return '';
  const thr = a.kind === 'yield' ? `${F.num(it.k * 100, 0)} điểm cơ bản` : F.pct(1 - Math.exp(-it.k), 1);
  return h`<p>Xác suất ${a.kind === 'yield' ? 'lợi suất' : 'giá'} giảm quá <b>${thr}</b> trong ${F.HZ[it.h]}: <b>${F.pct(it.pt)}</b> <span class="muted">(tần suất lịch sử ${F.pct(it.ptBase)}).</span> Ngưỡng chọn để giảm sâu xảy ra khoảng 1/8 số tháng của nhóm.</p>`;
}

function provenance(a) {
  return h`<section class="card" aria-labelledby="t-src"><header><h2 id="t-src">Nguồn số liệu</h2></header>
    <dl class="kv">
      <dt>Nguồn chính</dt><dd>${sourceLink(a.source)}</dd>
      <dt>Đối chiếu</dt><dd>${a.check ? h`${a.check.source || '–'}: <span class="chip ${a.check.status === 'khớp' ? 'strong' : a.check.status === 'lệch' ? 'bad' : 'none'}">${a.check.status}</span> lệch tối đa ${F.num(a.check.max_diff, 2)}${a.kind === 'yield' ? ' điểm %' : '%'}` : 'chưa có nguồn đối chiếu (1 nguồn)'}</dd>
      <dt>Lịch sử</dt><dd>${F.date(a.first)} – ${F.date(a.last)} (${F.num(a.nDaily, 0)} phiên gần nhất gửi kèm trang)</dd>
      <dt>Đoạn nguồn</dt><dd>${(a.segments || []).map((s, i) => h`${i ? '; ' : ''}${s.name} (${F.date(s.from)} – ${F.date(s.to)})`)}</dd>
      <dt>Điểm bị cách ly</dt><dd>${a.quarantine?.length ? a.quarantine.slice(-5).map((q, i) => h`${i ? '; ' : ''}${F.date(q.date)}: ${F.price(q.value, a)} (z ${F.num(q.z, 1)})`) : 'không có'}</dd>
    </dl>
    <p class="note">Điểm nhảy bất thường (|z| ≥ 6) bị cách ly khỏi mô hình trừ khi nguồn đối chiếu xác nhận.</p>
  </section>`;
}

function trackRecord(a) {
  if (!S.history) return loadingBox('Đang tải dự báo kiểm định…');
  const rows = (S.history.oos['1m'] || []).filter((r) => r.a === a.id).slice(-12).reverse();
  if (!rows.length) return h`<p class="muted">Chưa có dự báo kiểm định cho tài sản này.</p>`;
  const all = (S.history.oos['1m'] || []).filter((r) => r.a === a.id);
  const brier = (k) => all.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / all.length;
  const hit = all.filter((r) => (r.p > 0.5) === (r.y === 1)).length;
  return h`<p class="small">36 tháng gần nhất: đúng hướng ${hit}/${all.length}; Brier ${F.num(brier('p'), 3)} so với M1 ${F.num(brier('m1'), 3)} (thấp hơn là tốt hơn).</p>
    <div class="table-wrap"><table><thead><tr><th>Cuối tháng</th><th class="num">Xác suất tăng</th><th class="num">M1</th><th>Kết quả</th><th class="num">Biến động</th><th>Trong vùng 80%</th></tr></thead>
    <tbody>${rows.map((r) => h`<tr><td>${F.month(r.d)}</td><td class="num">${F.pct(r.p)}</td><td class="num muted">${F.pct(r.m1)}</td>
      <td class="${r.y ? 'up' : 'down'}">${r.y ? 'Tăng' : 'Giảm'}</td><td class="num">${a.kind === 'yield' ? `${F.signed(r.ret * 100, 0)} điểm cơ bản` : `${F.signed((Math.exp(r.ret) - 1) * 100, 1)}%`}</td>
      <td>${r.ret >= r.q[0] && r.ret <= r.q[2] ? 'có' : h`<b>không</b>`}</td></tr>`)}</tbody></table></div>`;
}

function chartHtml(a, range, width) {
  const hs = histOf(a.id);
  if (!hs) return S.historyError ? h`<p class="err">Không tải được lịch sử giá: ${S.historyError}</p>` : loadingBox('Đang tải lịch sử giá…');
  const i1 = liveOf(a.id, '1m');
  const i3 = liveOf(a.id, '3m');
  const daily = range !== 'all';
  const d = daily ? hs.d : hs.md;
  const v = daily ? hs.c : hs.mc;
  const x = d.map(F.dayNum);
  const it = i1 || i3;
  const fan = it ? { x0: F.dayNum(it.pd), y0: it.px, h1: i1 && { x: F.dayNum(i1.pd) + 30, lo: i1.lo, mid: i1.mid, hi: i1.hi }, h3: i3 && { x: F.dayNum(i3.pd) + 91, lo: i3.lo, mid: i3.mid, hi: i3.hi } } : null;
  const title = `${a.name}: ${daily ? 'giá theo ngày khoảng 400 phiên gần nhất' : 'giá cuối tháng toàn bộ lịch sử'}, kèm vùng 80% dự báo 1 và 3 tháng`;
  return raw(lineChart({ w: width, h: width < 500 ? 220 : 280, title, series: [{ x, y: v }], fan, yfmt: yfmt(a) }));
}

export function render(ctx) {
  const c = S.core;
  const want = ctx.arg && byId(ctx.arg)?.forecast ? ctx.arg : S.ui.asset || 'btc';
  S.ui.asset = want;
  const a = byId(want);
  if (!a) return h`<p>Không tìm thấy tài sản.</p>`;
  const i1 = liveOf(a.id, '1m');
  const i3 = liveOf(a.id, '3m');
  const it = i1 || i3;
  const range = S.ui.assetRange || '1y';
  return h`<section class="card" aria-labelledby="t-asset">
      <div class="row between">${selector(a.id)}
        <div class="seg" role="group" aria-label="Khoảng thời gian">
          <button type="button" data-action="range" data-range="1y" aria-pressed="${range !== 'all'}">400 phiên</button>
          <button type="button" data-action="range" data-range="all" aria-pressed="${range === 'all'}">Toàn bộ</button></div></div>
      <header><h2 id="t-asset">${a.name}</h2><span class="note">${groupName(a.group)} · ${a.unit}</span></header>
      <p><span class="pbar-val">${F.price(it?.px, a)}</span> <span class="muted">đóng cửa ${F.date(it?.pd)}</span></p>
      <div class="chart" id="price-chart">${chartHtml(a, range, ctx.width - 34)}</div>
      <p class="note">Đường liền: lịch sử. Vùng đậm: 80% khả năng sau 30 ngày; vùng nhạt: sau 91 ngày; nét đứt: trung vị.</p>
    </section>
    <div class="grid-2">
      ${['1m', '3m'].map((hz) => {
        const x = liveOf(a.id, hz);
        const b = c.badges[a.group]?.[hz];
        return h`<section class="card" aria-labelledby="t-h-${hz}"><header><h2 id="t-h-${hz}">Sau ${F.HZ[hz]}</h2>${F.badgeChip(b?.key)}</header>
          ${pbar(x?.pc, x?.base, `Xác suất tăng sau ${F.HZ[hz]}`)}
          ${forecastText(a, x)}${tailBlock(a, x)}
          ${modelTable(a, hz)}</section>`;
      })}
    </div>
    <div class="grid-2">
      <section class="card" aria-labelledby="t-why"><header><h2 id="t-why">Vì sao</h2></header>${contribBlock(i1)}
        ${c.ai?.assets?.find((x) => x.id === a.id) ? (() => {
          const x = c.ai.assets.find((y) => y.id === a.id);
          return h`<div class="callout"><span class="tag">${AI_LABEL}</span> <b>${F.VIEW[x.view]}</b>, ${F.CONF[x.confidence].toLowerCase()}: ${x.why} <a href="#ai">Chi tiết</a></div>`;
        })() : ''}
      </section>
      <section class="card" aria-labelledby="t-track"><header><h2 id="t-track">Thành tích kiểm định 1 tháng</h2></header><div id="track">${trackRecord(a)}</div></section>
    </div>
    ${provenance(a)}`;
}

export function mount(root, ctx) {
  if (!S.history) loadHistory();
  delegate(root, 'change', { pick: (el) => { location.hash = `tai-san-${el.value}`; } });
  delegate(root, 'click', {
    range: (el) => {
      S.ui.assetRange = el.dataset.range;
      for (const b of root.querySelectorAll('[data-action="range"]')) b.setAttribute('aria-pressed', String(b === el));
      const a = byId(S.ui.asset);
      $('#price-chart', root).innerHTML = String(chartHtml(a, S.ui.assetRange, ctx.width - 34));
    },
  });
}
