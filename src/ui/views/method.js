// Phương pháp: cách đọc, số liệu, mô hình, cách chấm và chọn, vòng tự cải thiện, cấu hình hiện hành,
// danh mục nguồn và bàn thử cấu hình (chủ sở hữu; chạy engine ngay trong trình duyệt).

import { h, raw, delegate, $ } from '../lib/dom.js';
import { S, emit } from '../lib/store.js';
import * as F from '../lib/fmt.js';
import { GROUP_ORDER, groupName, modelName, sourceLink } from './common.js';

const REPO = 'https://github.com/MikeNguyen25/claude-macro-radar-2';
const MODELS = [
  ['M0', 'Tung đồng xu: luôn 50%. Mốc dưới cùng.'],
  ['M1', 'Tần suất tăng lịch sử của chính tài sản, co về tỷ lệ của nhóm. Điểm chuẩn mọi mô hình phải thắng.'],
  ['M2', 'Xu hướng: hồi quy logistic có phạt trên biến động 1, 3, 12 tháng và khoảng cách tới trung bình 200 phiên.'],
  ['M3', 'Vĩ mô gọn: hồi quy logistic trên 4–6 điểm vĩ mô tổng hợp chọn trước cho từng nhóm.'],
  ['M4', 'Chế độ rủi ro: VIX, điều kiện tài chính, chênh lệch tín dụng, độ dốc lợi suất và tỷ lệ biến động.'],
  ['M5', 'Tổ hợp: trọng số theo log score quá khứ, luôn giữ tối thiểu một phần M1.'],
  ['M6', 'AI (Claude): đọc ngữ cảnh và tin tức, chỉ được nhích ±10 điểm % quanh mô hình đang dẫn; chấm như một mô hình.'],
];

function explain() {
  return h`<section class="card" aria-labelledby="t-read"><header><h2 id="t-read">Cách đọc</h2></header>
    <ul class="stack" style="padding-left:18px;margin:0">
      <li><b>Xác suất tăng</b>: khả năng giá sau 30 ngày (hoặc 91 ngày) cao hơn hôm nay, đã hiệu chỉnh để "60%" nghĩa là khoảng 60% số lần như thế giá tăng thật. Lợi suất 10 năm Mỹ: tăng nghĩa là lợi suất tăng.</li>
      <li><b>Vùng 80%</b>: 8/10 lần giá cuối kỳ nằm trong vùng này; 1/10 lần thấp hơn, 1/10 lần cao hơn.</li>
      <li><b>Giảm sâu</b>: xác suất giảm quá ngưỡng của nhóm, ngưỡng chọn để xảy ra khoảng 1/8 số tháng và đã khóa trước khi kiểm định.</li>
      <li><b>Huy hiệu</b>: Có cơ sở (thắng M1 với p_better ≥ 0,9 và BSS dương), Ít cơ sở (BSS dương nhưng chưa chắc), Chưa có cơ sở (dùng tần suất lịch sử).</li>
      <li><b>Nghiêng</b> chỉ được nêu khi nhóm có cơ sở và xác suất cách 50% từ 5 điểm trở lên. Công cụ tham khảo, không khuyến nghị mua bán.</li>
    </ul></section>`;
}

function dataSection() {
  return h`<details><summary>Số liệu và chống nhìn trước</summary>
    <ul style="padding-left:18px">
      <li>Job GitHub Actions lấy giá mỗi sáng (07:09, 07:29, 07:52 giờ Việt Nam) và số liệu vĩ mô hai lần mỗi ngày, ghi file JSON vào repo công khai; mỗi điểm có nguồn, đường dẫn và ngày.</li>
      <li>Mỗi chuỗi vĩ mô có độ trễ công bố riêng (pubLagDays): kiểm định và dự báo chỉ dùng số đã công bố tại ngày đó. Engine ném lỗi LookaheadError nếu một dòng học có kết quả chưa biết.</li>
      <li>Giá được đối chiếu với nguồn thứ hai; điểm nhảy bất thường bị cách ly trừ khi nguồn đối chiếu xác nhận. Không có số thì ghi "Chưa đủ cơ sở", không tự điền.</li>
      <li>Số Việt Nam chưa có API (CPI, PMI, lãi suất NHNN) được đọc từ thông cáo, ghi rõ 1 hay 2 nguồn, và chỉ hiển thị cho tới khi đủ 36 tháng.</li>
    </ul></details>`;
}

function modelsSection() {
  return h`<details><summary>Mô hình M0–M6</summary><div class="table-wrap"><table><tbody>${MODELS.map(([M, d]) => h`<tr><th scope="row">${M} · ${modelName(M)}</th><td>${d}</td></tr>`)}</tbody></table></div>
    <p class="note">Mỗi mô hình có số tham số không quá 1/20 số tháng độc lập của nhóm. Xác suất được hiệu chỉnh bằng Platt có kéo về đường chéo, kẹp trong 5–95%. Vùng giá dùng biến động EWMA nhân căn thời gian và phân phối Student-t, nhân thêm hệ số để độ phủ quá khứ đúng 80%.</p></details>`;
}

function scoringSection() {
  return h`<details><summary>Chấm điểm, chọn nhà vô địch và tự cải thiện</summary>
    <ul style="padding-left:18px">
      <li>Kiểm định theo mốc cuối tháng từ 2000, học lại mỗi 3 tháng chỉ với dữ liệu đã biết. Điểm: Brier, log score, ECE, độ phủ vùng 80%, pinball, Brier của giảm sâu.</li>
      <li>p_better và khoảng tin cậy của BSS tính bằng bootstrap theo khối tháng (2.000 lần), kèm kiểm định Diebold–Mariano.</li>
      <li>Nhà vô địch: p_better ≥ 0,95 so với M1, tốt hơn ở cả hai nửa giai đoạn, không kém ở 24 tháng kiểm tra cuối. Không ai qua thì M1.</li>
      <li><b>Hằng ngày</b>: ghi sổ dự báo bất biến (hash SHA-256, lịch sử git có dấu thời gian), chấm dự báo tới hạn, hạ ngôi nếu nhà vô địch kém M1 trong 6 khoảng trực tiếp gần nhất.</li>
      <li><b>Hằng tuần (Chủ nhật)</b>: kiểm định tối đa 3 giả thuyết; ngưỡng p_better 0,9, lên 0,95 khi đã thử từ 20 giả thuyết. Qua cửa thì chạy song song (shadow) trong sổ.</li>
      <li><b>Hằng tháng</b>: lên ngôi khi đủ 3 khoảng trực tiếp không kém nhà vô địch, ECE không tăng quá 1 điểm %, độ phủ 70–90%; tối ưu tham số an toàn (tối đa 6 tham số, mỗi lần nhích ≤ 15%); viết đánh giá tháng; mỗi thay đổi tăng version và có thể quay lại.</li>
    </ul></details>`;
}

function configSection(c) {
  const cf = c.config;
  return h`<details><summary>Cấu hình hiện hành (config v${cf.configVersion ?? '–'})</summary>
    <div class="table-wrap"><table><thead><tr><th>Tham số</th><th class="num">Giá trị</th><th class="num">Mặc định</th><th class="num">Khoảng cứng</th></tr></thead>
    <tbody>${cf.paramSpecs.map((p) => h`<tr><th scope="row">${p.label}</th><td class="num">${F.num(cf.params[p.key], 3)}</td><td class="num muted">${F.num(p.def, 3)}</td><td class="num muted">${F.num(p.hard[0], 2)} – ${F.num(p.hard[1], 2)}</td></tr>`)}</tbody></table></div>
    <h4>Biến của từng mô hình</h4>
    <div class="table-wrap"><table><tbody>
      <tr><th scope="row">M2</th><td>${cf.features.M2.map(F.featLabel).join(', ')}</td></tr>
      ${GROUP_ORDER.map((g) => h`<tr><th scope="row">M3 · ${groupName(g)}</th><td>${(cf.features.M3[g] || []).map(F.featLabel).join(', ')}</td></tr>`)}
      <tr><th scope="row">M4</th><td>${cf.features.M4.map(F.featLabel).join(', ')}</td></tr></tbody></table></div>
    <h4>Ngưỡng giảm sâu (đã khóa)</h4>
    <p class="small">${Object.entries(cf.tail || {}).map(([k, v], i) => `${i ? '; ' : ''}${groupName(k) || k}: 1 tháng ${F.num(v['1m'], 3)}, 3 tháng ${F.num(v['3m'], 3)}`).join('')} (log lợi suất; lợi suất 10 năm tính bằng điểm %).</p>
    <p class="note">Vùng giá: ${cf.bandMethod === 't' ? 'Student-t' : cf.bandMethod}; hệ số nở theo VIX ${F.num(cf.riskBandMultiplier, 2)}. Học lại mỗi ${cf.refitEvery} tháng; tập kiểm tra ${cf.testMonths} tháng cuối.</p>
  </details>`;
}

function catalogSection(c) {
  const cat = c.catalog;
  if (!cat) return '';
  return h`<details><summary>Danh mục nguồn (${cat.assets.length} chuỗi giá, ${cat.series.length} chuỗi vĩ mô)</summary>
    <div class="table-wrap"><table><thead><tr><th>Chuỗi</th><th>Nguồn chính</th><th>Đối chiếu</th><th>Từ</th></tr></thead>
    <tbody>${cat.assets.map((a) => h`<tr><th scope="row">${a.name}</th><td class="small">${sourceLink(a.source)}</td><td class="small">${a.check?.source ? sourceLink(a.check.source) : '–'}</td><td class="nowrap">${F.date(a.first)}</td></tr>`)}
      ${cat.series.map((s) => h`<tr><th scope="row">${s.name}</th><td class="small">${sourceLink(s.source)}</td><td class="small muted">trễ công bố ${s.pubLagDays} ngày</td><td class="nowrap">${F.date(s.first)}</td></tr>`)}</tbody></table></div>
    <p class="note">Mã nguồn và số liệu: <a href="${REPO}" rel="noopener" target="_blank">${REPO.replace('https://', '')}</a>.</p>
  </details>`;
}

// ---- bàn thử cấu hình

function sandboxCard(c) {
  if (!S.owner) return '';
  const sb = S.sandbox || {};
  const cf = c.config;
  const specs = cf.paramSpecs.filter((p) => p.key !== 'm1Prior');
  const val = (k) => sb.form?.[k] ?? cf.params[k];
  return h`<section class="card" aria-labelledby="t-sb"><header><h2 id="t-sb">Bàn thử cấu hình</h2><span class="tag">chỉ chủ sở hữu</span></header>
    <p class="note">Chạy lại toàn bộ kiểm định ngay trong trình duyệt với cấu hình hiện hành và cấu hình bạn chỉnh, trên cùng bộ số liệu thô (tải khoảng 5 MB, mất 10–40 giây). Không thay đổi gì của hệ thống; muốn áp dụng thì gửi thành phép thử để đi qua các cửa kiểm định.</p>
    <form id="sb-form" class="grid-3">
      ${specs.map((p) => h`<label for="sb-${p.key}">${p.label}<input id="sb-${p.key}" name="${p.key}" type="number" step="any" min="${p.hard[0]}" max="${p.hard[1]}" value="${val(p.key)}"></label>`)}
      <label for="sb-band">Cách tính vùng giá<select id="sb-band" name="bandMethod">${['t', 'bootstrap'].map((m) => h`<option value="${m}" ${(sb.form?.bandMethod ?? cf.bandMethod) === m ? raw('selected') : ''}>${m === 't' ? 'Student-t' : 'Bootstrap phần dư'}</option>`)}</select></label>
      <label for="sb-risk">Vùng giá nở theo VIX (0–0,5)<input id="sb-risk" name="riskBandMultiplier" type="number" step="0.05" min="0" max="0.5" value="${sb.form?.riskBandMultiplier ?? cf.riskBandMultiplier}"></label>
    </form>
    <div class="row"><button class="btn" type="button" data-action="sb-run" ${sb.busy ? raw('disabled') : ''}>${sb.busy ? 'Đang chạy…' : 'Chạy thử'}</button>
      ${sb.result ? h`<button class="btn secondary" type="button" data-action="sb-copy">Sao chép đề xuất</button>` : ''}
      <span class="small muted" aria-live="polite" id="sb-status">${sb.status || ''}</span></div>
    ${sb.error ? h`<p class="err">${sb.error}</p>` : ''}
    ${sb.result ? sandboxResult(sb) : ''}
  </section>`;
}

function sandboxResult(sb) {
  const r = sb.result;
  const rows = [];
  for (const hz of ['1m', '3m']) for (const g of GROUP_ORDER) {
    const a = r.current[hz]?.[g];
    const b = r.candidate[hz]?.[g];
    if (!a || !b) continue;
    const d = b.best.skill - a.best.skill;
    rows.push(h`<tr><th scope="row">${groupName(g)}</th><td>${F.HZ[hz]}</td>
      <td class="num">${a.best.M} ${F.signed(a.best.skill * 100, 2)}%</td><td class="num">${b.best.M} ${F.signed(b.best.skill * 100, 2)}%</td>
      <td class="num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${F.signed(d * 100, 2)}</td>
      <td class="num">${a.champion} → ${b.champion}</td><td class="num">${F.pct(a.coverage, 1)} → ${F.pct(b.coverage, 1)}</td></tr>`);
  }
  return h`<div class="table-wrap"><table><thead><tr><th>Nhóm</th><th>Kỳ</th><th class="num">Ứng viên tốt nhất (hiện hành)</th><th class="num">Ứng viên tốt nhất (thử)</th><th class="num">Chênh BSS (điểm %)</th><th class="num">Nhà vô địch</th><th class="num">Độ phủ 80%</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Thay đổi: <span class="mono">${JSON.stringify(r.override)}</span>. Chạy ${F.num(r.ms / 1000, 1)} giây. Kết quả này dùng toàn bộ giai đoạn kiểm định nên lạc quan hơn kiểm định chính thức; để áp dụng, bấm "Sao chép đề xuất" rồi dán vào workflow <a href="${REPO}/actions/workflows/experiment.yml" rel="noopener" target="_blank">experiment</a> trên GitHub (Run workflow). Phép thử sẽ được kiểm định vào Chủ nhật kế tiếp.</p>`;
}

function readForm(c) {
  const form = $('#sb-form');
  const cf = c.config;
  const params = {};
  const out = {};
  for (const p of cf.paramSpecs) {
    const el = form.elements[p.key];
    if (!el) continue;
    const v = Number(el.value);
    if (!Number.isFinite(v)) continue;
    const clamped = Math.min(p.hard[1], Math.max(p.hard[0], v));
    if (Math.abs(clamped - cf.params[p.key]) > 1e-12) params[p.key] = clamped;
  }
  if (Object.keys(params).length) out.params = params;
  const band = form.elements.bandMethod.value;
  if (band !== cf.bandMethod) out.bandMethod = band;
  const rb = Math.min(0.5, Math.max(0, Number(form.elements.riskBandMultiplier.value) || 0));
  if (Math.abs(rb - cf.riskBandMultiplier) > 1e-12) out.riskBandMultiplier = rb;
  const formVals = Object.fromEntries([...form.elements].filter((e) => e.name).map((e) => [e.name, e.value]));
  return { override: out, formVals };
}

function runSandbox(c, rerender) {
  const { override, formVals } = readForm(c);
  if (!Object.keys(override).length) {
    S.sandbox = { ...S.sandbox, form: formVals, error: 'Chưa thay đổi gì so với cấu hình hiện hành.' };
    rerender();
    return;
  }
  let worker;
  try { worker = new Worker('sandbox-worker.js'); } catch (e) {
    S.sandbox = { form: formVals, error: `Trình duyệt không chạy được tiến trình nền: ${e.message}` };
    rerender();
    return;
  }
  S.sandbox = { form: formVals, busy: true, status: 'Đang khởi động…' };
  rerender();
  const cf = c.config;
  const base = { params: cf.params, features: cf.features, pool: cf.pool, tail: cf.tail, bandMethod: cf.bandMethod, riskBandMultiplier: cf.riskBandMultiplier, gates: cf.gates, testMonths: cf.testMonths, refitEvery: cf.refitEvery };
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'progress') { const el = $('#sb-status'); if (el) el.textContent = m.text; S.sandbox.status = m.text; return; }
    worker.terminate();
    S.sandbox = m.type === 'result' ? { form: formVals, result: { ...m.result, override } } : { form: formVals, error: `Lỗi khi chạy: ${m.error}` };
    emit();
  };
  worker.onerror = (e) => { worker.terminate(); S.sandbox = { form: formVals, error: `Lỗi tiến trình nền: ${e.message || 'không rõ'}` }; emit(); };
  worker.postMessage({ type: 'run', base, override, today: c.date });
}

async function copyOverride(rerender) {
  const r = S.sandbox?.result;
  if (!r) return;
  const text = JSON.stringify(r.override);
  try {
    await navigator.clipboard.writeText(text);
    S.sandbox.status = 'Đã sao chép. Dán vào ô override của workflow experiment.';
  } catch {
    S.sandbox.status = `Không sao chép được; chép tay: ${text}`;
  }
  rerender();
}

export function render() {
  const c = S.core;
  return h`${explain()}<section class="card stack" aria-label="Chi tiết phương pháp">${dataSection()}${modelsSection()}${scoringSection()}${configSection(c)}${catalogSection(c)}</section>${sandboxCard(c)}`;
}

export function mount(root, ctx, rerender) {
  root.addEventListener('submit', (e) => e.preventDefault());
  delegate(root, 'click', {
    'sb-run': () => runSandbox(S.core, rerender),
    'sb-copy': () => copyOverride(rerender),
  });
}
