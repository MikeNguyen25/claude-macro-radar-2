// Nhật ký: version và quay lại, phép thử, postmortem, đánh giá tháng, chất lượng số liệu, sổ dự báo
// (kiểm hash ngay trong trình duyệt) và tải CSV.

import { h, delegate } from '../lib/dom.js';
import { S, byId, fetchJson, saveFile, loadHistory } from '../lib/store.js';
import * as F from '../lib/fmt.js';
import { sha256, canonical } from '../../engine/util.mjs';
import { GROUP_ORDER, groupName, modelName } from './common.js';

const REPO = 'https://github.com/MikeNguyen25/claude-macro-radar-2';
const statusChip = (s) => h`<span class="chip ${s === 'promoted' ? 'strong' : s === 'shadow' ? 'weak' : s === 'rejected' ? 'bad' : 'none'}">${F.EXP_STATUS[s] || s}</span>`;

function versionsCard(c) {
  const vs = c.versions || [];
  return h`<section class="card" aria-labelledby="t-ver"><header><h2 id="t-ver">Version</h2><span class="note">Đang chạy v${c.version}</span></header>
    ${vs.length ? h`<div class="table-wrap"><table><thead><tr><th>Version</th><th>Ngày</th><th>Thay đổi</th></tr></thead>
      <tbody>${vs.map((v) => h`<tr><th scope="row" class="nowrap">${v.version}</th><td class="nowrap">${F.date(v.date)}</td><td>${(v.events || []).map((e) => h`<div>${e.text}</div>`)}</td></tr>`)}</tbody></table></div>` : h`<p class="muted">Chưa có version nào.</p>`}
    <p class="note">Mỗi thay đổi cấu hình hay nhà vô địch tạo một version kèm ảnh chụp cấu hình. Muốn quay lại: mở <a href="${REPO}/actions/workflows/rollback.yml" rel="noopener" target="_blank">workflow rollback</a> trên GitHub, bấm Run workflow và nhập version (ví dụ ${vs[1]?.version || vs[0]?.version || '2.0.0'}). Lần dự báo kế tiếp dùng cấu hình đã quay lại.</p>
  </section>`;
}

function experimentsCard(c) {
  const ex = c.experiments || [];
  return h`<section class="card" aria-labelledby="t-exp"><header><h2 id="t-exp">Phép thử</h2><span class="note">${ex.filter((e) => e.status !== 'proposed').length} đã kiểm định</span></header>
    ${ex.map((e) => h`<details><summary>${e.id} · ${e.title} ${statusChip(e.status)}</summary>
      <p>${e.hypothesis}</p>
      <p class="small">Thay đổi: <span class="mono">${JSON.stringify(e.override)}</span></p>
      ${e.reason ? h`<p class="small">Kết quả${e.testedAt ? ` (${F.date(e.testedAt)})` : ''}: ${e.reason}${F.ok(e.threshold) ? ` · ngưỡng p_better ${F.num(e.threshold, 2)}` : ''}</p>` : h`<p class="small muted">Chờ lần kiểm định Chủ nhật kế tiếp.</p>`}
      ${e.details ? h`<div class="table-wrap"><table><thead><tr><th>Nhóm</th><th>Kỳ</th><th>Mô hình</th><th class="num">BSS</th><th class="num">p_better</th><th>Cải thiện so với hiện hành</th></tr></thead>
        <tbody>${GROUP_ORDER.flatMap((g) => ['1m', '3m'].map((hz) => {
          const d = e.details[g]?.[hz];
          return d ? h`<tr><td>${groupName(g)}</td><td>${F.HZ[hz]}</td><td>${d.model}</td><td class="num">${F.signed(d.skill * 100, 2)}%</td><td class="num">${F.num(d.pBetter, 3)}</td><td>${d.improvesOverBase ? 'có' : 'không'}${d.ok ? h` <b class="up">qua cửa</b>` : ''}</td></tr>` : '';
        }))}</tbody></table></div>` : ''}
    </details>`)}
  </section>`;
}

function postmortemCard(c) {
  const pm = c.postmortems || [];
  return h`<section class="card" aria-labelledby="t-pm"><header><h2 id="t-pm">Dự báo trượt</h2><span class="note">Ra ngoài vùng 80% hoặc sai khi tự tin ≥ 70%</span></header>
    ${pm.length ? h`<div class="table-wrap"><table><thead><tr><th>Dự báo ngày</th><th>Kỳ</th><th>Nguyên nhân</th><th>Tài sản</th></tr></thead>
      <tbody>${pm.slice(0, 20).map((p) => h`<tr><td>${F.date(p.fd)}</td><td>${F.HZ[p.h]}</td><td>${p.causeLabel}</td><td>${(p.assets || []).map((a) => byId(a)?.name || a).join(', ')}</td></tr>`)}</tbody></table></div>`
      : h`<p class="muted">Chưa có dự báo trực tiếp nào trượt (hoặc chưa tới hạn).</p>`}
    <p class="note">Nguyên nhân gắn tự động: lỗi số liệu (QA), chế độ rủi ro đổi giữa kỳ, hoặc mô hình thiếu biến. Hai sự kiện cùng loại trong tháng sinh giả thuyết mới.</p>
  </section>`;
}

function reviewsCard(c) {
  const rv = c.reviews || [];
  if (!rv.length) return '';
  return h`<section class="card" aria-labelledby="t-rv"><header><h2 id="t-rv">Đánh giá tháng</h2></header>
    ${rv.map((r) => h`<details><summary>Tháng ${F.month(`${r.month}-01`)} · v${r.version}</summary>
      <p class="small">Tối ưu tham số: ${r.optimize ? (r.optimize.accepted ? `đổi ${r.optimize.changes.map((x) => `${x.key} ${x.from}→${x.to}`).join(', ')}` : `giữ nguyên (${r.optimize.reason})`) : 'không chạy'}.</p>
      <p class="small">Phép thử: ${(r.experiments || []).map((e) => `${e.id} ${F.EXP_STATUS[e.status] || e.status}`).join('; ') || 'không có'}.</p>
      ${r.next?.length ? h`<p class="small">Giả thuyết tháng tới: ${r.next.join('; ')}.</p>` : ''}
      ${r.qaIssues?.length ? h`<p class="small">Sự cố số liệu: ${r.qaIssues.join('; ')}.</p>` : ''}
    </details>`)}</section>`;
}

function qaCard(c) {
  const qa = c.qa;
  if (!qa) return '';
  return h`<section class="card" aria-labelledby="t-qa"><header><h2 id="t-qa">Chất lượng số liệu</h2><span class="note">Lần cập nhật ${F.vnTime(qa.generated_at)}</span></header>
    ${qa.issues?.length ? h`<ul>${qa.issues.map((x) => h`<li>${x}</li>`)}</ul>` : h`<p>Không có sự cố.</p>`}
    <div class="table-wrap"><table><thead><tr><th>Chuỗi giá</th><th>Phiên mới nhất</th><th>Đối chiếu</th><th class="num">Lệch tối đa</th></tr></thead>
    <tbody>${(qa.assets || []).map((a) => h`<tr><th scope="row">${byId(a.id)?.name || a.id}</th><td>${F.date(a.last)}${a.stale ? h` <b class="down">cũ</b>` : ''}</td>
      <td><span class="chip ${a.check?.status === 'khớp' ? 'strong' : a.check?.status === 'lệch' ? 'bad' : 'none'}">${a.check?.status || '1 nguồn'}</span></td>
      <td class="num">${F.ok(a.check?.max_diff) ? F.num(a.check.max_diff, 2) : '–'}</td></tr>`)}</tbody></table></div></section>`;
}

function ledgerCard(c) {
  const ledger = [...(c.status?.ledger || [])].reverse().slice(0, 60);
  const chk = S.ui.ledgerCheck || {};
  return h`<section class="card" aria-labelledby="t-led"><header><h2 id="t-led">Sổ dự báo</h2><span class="note">${(c.status?.ledger || []).length} ngày</span></header>
    <p class="note">Mỗi ngày một bản ghi bất biến; hash SHA-256 tính trên nội dung. Bấm "Kiểm" để tải bản ghi và tính lại hash ngay trên máy bạn. Bản gốc nằm trong <a href="${REPO}/tree/main/state/forecasts" rel="noopener" target="_blank">repo</a>, lịch sử commit cho biết thời điểm ghi.</p>
    <div class="table-wrap"><table><thead><tr><th>Ngày</th><th>Version</th><th>Hash</th><th>Kiểm</th></tr></thead>
    <tbody>${ledger.map((x) => h`<tr><td>${F.date(x.date)}</td><td>${x.version}</td><td class="mono">${x.hash.slice(0, 16)}…</td>
      <td>${chk[x.date] ? h`<span class="ledger-result ${chk[x.date].ok ? 'up' : 'down'}">${chk[x.date].text}</span>` : h`<button class="btn secondary" type="button" data-action="verify" data-date="${x.date}">Kiểm</button>`}</td></tr>`)}</tbody></table></div>
  </section>`;
}

function downloadsCard() {
  return h`<section class="card" aria-labelledby="t-dl"><header><h2 id="t-dl">Tải số liệu</h2></header>
    <div class="row">
      <button class="btn secondary" type="button" data-action="csv" data-kind="forecast">Dự báo hôm nay (CSV)</button>
      <button class="btn secondary" type="button" data-action="csv" data-kind="oos">Dự báo kiểm định 36 tháng (CSV)</button>
      <button class="btn secondary" type="button" data-action="csv" data-kind="ledger">Danh sách sổ dự báo (CSV)</button>
    </div>
    <p class="small muted" aria-live="polite">${S.ui.dlStatus || ''}</p></section>`;
}

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

async function makeCsv(kind) {
  const c = S.core;
  if (kind === 'forecast') {
    const models = [...new Set(c.live.flatMap((i) => Object.keys(i.p)))];
    return [`macro-radar-du-bao-${c.date}.csv`, toCsv([
      ['ngay', 'tai_san', 'ky_han', 'gia', 'ngay_gia', 'xac_suat_tang', 'mo_hinh_dan', 'm1', 'vung80_thap', 'trung_vi', 'vung80_cao', 'xac_suat_giam_sau', 'nguong_giam_sau', 'huy_hieu', ...models],
      ...c.live.map((i) => [c.date, i.a, i.h, i.px, i.pd, i.pc, i.champ, i.base, i.lo, i.mid, i.hi, i.pt, i.k, i.badge, ...models.map((M) => i.p[M] ?? '')])])];
  }
  if (kind === 'oos') {
    const hist = S.history || await loadHistory();
    if (!hist) throw new Error('chưa tải được lịch sử');
    return [`macro-radar-kiem-dinh-${c.date}.csv`, toCsv([['ky_han', 'cuoi_thang', 'tai_san', 'xac_suat_tang', 'm1', 'tang', 'log_loi_suat', 'q10', 'q50', 'q90'],
      ...['1m', '3m'].flatMap((hz) => (hist.oos[hz] || []).map((r) => [hz, r.d, r.a, r.p, r.m1, r.y, r.ret, ...r.q]))])];
  }
  return [`macro-radar-so-du-bao-${c.date}.csv`, toCsv([['ngay', 'version', 'config', 'hash'], ...(c.status?.ledger || []).map((x) => [x.date, x.version, x.configVersion, x.hash])])];
}

async function download(kind, rerender) {
  try {
    const [name, text] = await makeCsv(kind);
    const saved = await saveFile(name, `﻿${text}`).catch((e) => { throw new Error(e?.code === 'declined' ? 'bạn đã từ chối lưu' : e?.message || e?.code); });
    if (saved) S.ui.dlStatus = `Đã lưu ${name}.`;
    else {
      await navigator.clipboard.writeText(text);
      S.ui.dlStatus = 'Khung xem này không lưu file được; đã sao chép CSV vào bộ nhớ tạm.';
    }
  } catch (e) {
    S.ui.dlStatus = `Không tải được: ${e.message}`;
  }
  rerender();
}

async function verify(date, rerender) {
  S.ui.ledgerCheck = S.ui.ledgerCheck || {};
  try {
    const doc = await fetchJson(`ledger/${date}.json`);
    const { hash, createdAt, ...body } = doc;
    const ok = sha256(canonical(body)) === hash;
    const listed = (S.core.status?.ledger || []).find((x) => x.date === date)?.hash;
    S.ui.ledgerCheck[date] = ok && hash === listed ? { ok: true, text: `khớp (ghi lúc ${F.vnTime(createdAt)})` } : { ok: false, text: ok ? 'hash khác danh sách' : 'hash không khớp nội dung' };
  } catch (e) {
    S.ui.ledgerCheck[date] = { ok: false, text: `chưa có bản ghi trong artifact (${e.message.includes('404') ? 'chưa đăng' : 'lỗi tải'})` };
  }
  rerender();
}

export function render() {
  const c = S.core;
  return h`<div class="grid-2">${versionsCard(c)}${experimentsCard(c)}</div><div class="grid-2">${postmortemCard(c)}${reviewsCard(c) || qaCard(c)}</div>${reviewsCard(c) ? qaCard(c) : ''}${ledgerCard(c)}${downloadsCard()}
    <p class="note">Mô hình: ${['M1', 'M2', 'M3', 'M4', 'M5'].map((M) => `${M} ${modelName(M)}`).join(', ')}.</p>`;
}

export function mount(root, ctx, rerender) {
  delegate(root, 'click', {
    verify: (el) => verify(el.dataset.date, rerender),
    csv: (el) => download(el.dataset.kind, rerender),
  });
}
