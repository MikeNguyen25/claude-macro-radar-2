// AI: nhận định của Claude (M6) hôm nay, thành tích trực tiếp so với M1, lịch sử nhận định và nút
// chạy tay cho chủ sở hữu (dùng hạn mức Claude của người xem).

import { h, raw, delegate, $ } from '../lib/dom.js';
import { S, byId, dbList, dbSet, emit } from '../lib/store.js';
import * as F from '../lib/fmt.js';
import { validateAi, analysisDoc } from '../../engine/ai.mjs';
import { GROUP_ORDER, groupName, AI_LABEL } from './common.js';

function assetCard(x) {
  const a = byId(x.id);
  const d = x.prob_up - x.champion_prob;
  return h`<article class="ai-asset" aria-label="${a?.name || x.id}">
    <div class="row between"><h3><a href="#tai-san-${x.id}">${a?.name || x.id}</a></h3><span class="small">${F.VIEW[x.view] || x.view} · ${F.CONF[x.confidence] || x.confidence}</span></div>
    <p><b class="${x.prob_up >= 0.5 ? 'up' : 'down'}">${F.pct(x.prob_up)}</b> tăng sau 30 ngày <span class="muted">(mô hình ${x.champion || ''} ${F.pct(x.champion_prob)}; ${Math.abs(d) < 0.005 ? 'bằng mô hình' : F.pp(d)})</span></p>
    ${x.why ? h`<p>${x.why}</p>` : ''}
    <dl class="kv">${x.bull ? h`<dt>Nếu tăng</dt><dd>${x.bull}</dd>` : ''}${x.bear ? h`<dt>Nếu giảm</dt><dd>${x.bear}</dd>` : ''}${x.vs_model ? h`<dt>So với mô hình</dt><dd>${x.vs_model}</dd>` : ''}</dl>
    ${x.evidence?.length ? h`<ul class="small">${x.evidence.map((e) => h`<li>${e}</li>`)}</ul>` : ''}
  </article>`;
}

function analysisBlock(ai, { title, note }) {
  const assets = [...(ai.assets || [])].sort((p, q) => Math.abs(q.prob_up - q.champion_prob) - Math.abs(p.prob_up - p.champion_prob));
  return h`<section class="card" aria-label="${title}">
    <header><h2>${title}</h2><span class="tag">${AI_LABEL}</span></header>
    ${note ? h`<p class="note">${note}</p>` : ''}
    <p class="quote"><b>${ai.headline}</b></p>
    ${ai.regime?.title ? h`<div class="callout"><b>${ai.regime.title}.</b> ${ai.regime.explain}</div>` : ''}
    ${ai.regions?.length ? h`<dl class="kv">${ai.regions.map((r) => h`<dt>${F.REGION[r.id] || r.id}</dt><dd>${r.view}</dd>`)}</dl>` : ''}
    <div class="grid-3">${assets.map(assetCard)}</div>
    ${ai.risks?.length ? h`<div><h3>Rủi ro</h3><ul>${ai.risks.map((x) => h`<li>${x}</li>`)}</ul></div>` : ''}
    ${ai.watch?.length ? h`<div><h3>Cần theo dõi</h3><ul>${ai.watch.map((x) => h`<li>${x}</li>`)}</ul></div>` : ''}
    ${ai.validation?.length ? h`<details><summary>Runner đã điều chỉnh ${ai.validation.length} chỗ cho đúng luật</summary><ul class="small">${ai.validation.map((x) => h`<li>${x}</li>`)}</ul></details>` : ''}
  </section>`;
}

function trackCard(c) {
  const live = c.aiScores?.live;
  return h`<section class="card" aria-labelledby="t-aitrack"><header><h2 id="t-aitrack">Thành tích của AI (M6)</h2>${live ? F.badgeChip(live.all?.badge?.key, live.all?.badge?.label) : ''}</header>
    <p>AI chỉ được nhích xác suất tối đa ±10 điểm % quanh mô hình đang dẫn, phải dẫn 2–4 dữ kiện có số và ngày, và chỉ được tự tin cao khi nhóm đã có cơ sở. Nhận định được chấm như một mô hình (M6) khi tới hạn 30 ngày.</p>
    ${live ? h`<div class="table-wrap"><table><thead><tr><th>Nhóm</th><th class="num">Khoảng đã chấm</th><th class="num">BSS so với M1</th><th class="num">p_better</th><th>Huy hiệu</th></tr></thead>
      <tbody>${[...GROUP_ORDER, 'all'].map((g) => {
        const x = live[g];
        if (!x) return '';
        return h`<tr><th scope="row">${g === 'all' ? 'Tất cả' : groupName(g)}</th><td class="num">${x.intervals}</td><td class="num">${x.skill === null ? '–' : `${F.signed(x.skill * 100, 1)}%`}</td>
          <td class="num">${x.pBetter === null ? '–' : F.num(x.pBetter, 2)}</td><td>${F.badgeChip(x.badge?.key, x.badge?.label)}</td></tr>`;
      })}</tbody></table></div>` : h`<p class="muted">Chưa có nhận định nào tới hạn.</p>`}
    <p class="note">Cần ít nhất 3 khoảng 30 ngày không trùng nhau mới bắt đầu xét kỹ năng.</p>
  </section>`;
}

function historyCard() {
  const st = S.ui.aiHistory;
  let body;
  if (!S.capsReady) body = h`<p class="muted">Đang kết nối…</p>`;
  else if (!S.caps.db) body = h`<p class="muted">Lịch sử nhận định nằm trong cơ sở dữ liệu của artifact; khung xem này không mở được nó.</p>`;
  else if (!st) body = h`<p class="muted">Đang tải…</p>`;
  else if (st.error) body = h`<p class="err">${st.error}</p>`;
  else if (!st.items.length) body = h`<p class="muted">Chưa có nhận định nào được lưu.</p>`;
  else {
    body = h`${st.items.map((x) => h`<details><summary>${F.date(x.date)}${x.source && x.source !== 'tác vụ định kỳ' ? h` <span class="tag">${x.source}</span>` : ''} · ${x.headline}</summary>
      <div class="table-wrap"><table><tbody>${(x.assets || []).map((y) => h`<tr><th scope="row">${byId(y.id)?.name || y.id}</th><td class="num">${F.pct(y.prob_up)}</td><td class="num muted">${F.pct(y.champion_prob)}</td><td>${F.VIEW[y.view] || ''}</td></tr>`)}</tbody></table></div>
      <p class="small mono">hash ${String(x.hash || '').slice(0, 16)}…</p></details>`)}`;
  }
  return h`<section class="card" aria-labelledby="t-aihist"><header><h2 id="t-aihist">Lịch sử nhận định</h2><span class="note">30 bản gần nhất</span></header>${body}</section>`;
}

function ownerCard(c) {
  if (!S.owner) return '';
  const run = S.aiRun;
  const can = !!S.caps.sample && c.aiContext;
  return h`<section class="card" aria-labelledby="t-airun"><header><h2 id="t-airun">Chạy nhận định ngay</h2><span class="tag">chỉ chủ sở hữu</span></header>
    <p class="note">Gửi ngữ cảnh của bản dự báo ngày ${F.date(c.date)} (khoảng ${Math.round(JSON.stringify(c.aiContext || {}).length / 1024)} KB) cho Claude. Dùng hạn mức Claude của bạn; không tìm tin mới trên web; kết quả không vào sổ dự báo và không được chấm.</p>
    <div class="row"><button class="btn" type="button" data-action="ai-run" ${!can || run?.busy ? raw('disabled') : ''}>${run?.busy ? 'Đang chạy…' : 'Phân tích AI'}</button>
      ${run?.busy ? h`<button class="btn secondary" type="button" data-action="ai-stop">Dừng</button>` : ''}
      ${run?.result && !run.saved && S.caps.db ? h`<button class="btn secondary" type="button" data-action="ai-save">Lưu vào lịch sử</button>` : ''}
      ${run?.saved ? h`<span class="small up">Đã lưu.</span>` : ''}</div>
    ${!S.caps.sample ? h`<p class="muted small">Khung xem này không gọi được Claude.</p>` : ''}
    <div id="ai-run-out" aria-live="polite">${run?.status ? h`<p class="small muted">${run.status}</p>` : ''}${run?.error ? h`<p class="err">${run.error}</p>` : ''}</div>
  </section>${run?.result ? analysisBlock({ ...run.result.ai, validation: run.result.issues }, { title: 'Nhận định vừa chạy', note: `Chạy tay lúc ${F.vnTime(run.at)} trên bản dự báo ${F.date(c.date)}.` }) : ''}`;
}

const ERR = {
  not_granted: 'Bạn chưa cho phép artifact gọi Claude.', sampling_disabled: 'Claude không dùng được cho tài khoản này.', rate_limited: 'Đã chạm giới hạn, thử lại sau ít phút.',
  invalid_json: 'Claude trả lời không đúng định dạng JSON. Thử lại.', prompt_too_large: 'Ngữ cảnh quá lớn.', cancelled: 'Đã dừng.', session_expired: 'Cần đăng nhập lại.',
};

function prompt(ctx) {
  const ins = ctx.instructions;
  return `Bạn viết nhận định vĩ mô ngắn cho một nhà đầu tư cá nhân người Việt đọc trên điện thoại. ${ins.language}
Bạn không tra cứu được web: chỉ dùng số liệu trong NGỮ CẢNH bên dưới và ghi rõ ngày, nguồn của từng dữ kiện.
Luật:
- ${ins.rules.join('\n- ')}
- Nhận định đủ ${ctx.assets.length} tài sản trong ngữ cảnh.
Trả lời chỉ bằng một object JSON theo schema: ${ins.schema}

NGỮ CẢNH (macro-radar 2, ngày ${ctx.date}):
${JSON.stringify({ ...ctx, instructions: undefined })}`;
}

async function runAi(rerender) {
  const c = S.core;
  const ctl = new AbortController();
  S.aiRun = { busy: true, status: 'Đang chờ Claude (thường 20–90 giây; lần đầu sẽ hỏi bạn cho phép)…', ctl, at: new Date().toISOString() };
  rerender();
  try {
    const out = await S.caps.sample.json(prompt(c.aiContext), {
      modelTier: 'complex', signal: ctl.signal, cache: false,
      onText: ({ text }) => { const el = $('#ai-run-out'); if (el) el.innerHTML = String(h`<p class="small muted">Đang nhận: ${text.length} ký tự…</p>`); },
    });
    const v = validateAi(out, c.live);
    S.aiRun = { busy: false, result: v, at: S.aiRun.at, status: `Xong. Runner điều chỉnh ${v.issues.length} chỗ.` };
  } catch (e) {
    S.aiRun = { busy: false, error: ERR[e?.code] || `Lỗi: ${e?.message || e}`, at: S.aiRun?.at };
  }
  rerender();
}

async function saveAi(rerender) {
  const c = S.core;
  const r = S.aiRun;
  const stamp = new Date(new Date(r.at).getTime() + 7 * 3600e3).toISOString().slice(11, 16).replace(':', '');
  const ledgerHash = c.status?.ledger?.find((x) => x.date === c.date)?.hash || null;
  const doc = analysisDoc(r.result.ai, r.result.issues, { date: c.date, version: c.version, forecastHash: ledgerHash, createdAt: r.at, source: 'chạy tay từ trang' });
  try {
    await dbSet(`analyses/${c.date}-tay-${stamp}`, doc);
    S.aiRun = { ...r, saved: true };
    S.ui.aiHistory = null;
    loadAiHistory();
  } catch (e) {
    S.aiRun = { ...r, error: `Không lưu được: ${e?.message || e?.code || e}` };
  }
  rerender();
}

function loadAiHistory() {
  if (!S.caps.db || S.ui.aiHistoryLoading) return;
  S.ui.aiHistoryLoading = true;
  dbList('analyses', { orderBy: 'date', dir: 'desc', limit: 30 })
    .then((items) => { S.ui.aiHistory = { items: items || [] }; })
    .catch((e) => { S.ui.aiHistory = { error: `Không đọc được lịch sử: ${e?.message || e?.code || e}` }; })
    .finally(() => { S.ui.aiHistoryLoading = false; emit(); });
}

export function render() {
  const c = S.core;
  const today = c.ai
    ? analysisBlock(c.ai, { title: `Nhận định ngày ${F.date(c.ai.date)}`, note: `Viết lúc ${F.vnTime(c.ai.createdAt)} từ bản dự báo cùng ngày; có hash ${String(c.ai.hash).slice(0, 12)}… trong cơ sở dữ liệu.` })
    : h`<section class="card"><h2>Nhận định hôm nay</h2><p class="muted">Chưa có nhận định AI cho bản dự báo ngày ${F.date(c.date)}.</p></section>`;
  return h`${today}${ownerCard(c)}<div class="grid-2">${trackCard(c)}${historyCard()}</div>`;
}

export function mount(root, ctx, rerender) {
  if (S.capsReady && S.caps.db && !S.ui.aiHistory) loadAiHistory();
  delegate(root, 'click', {
    'ai-run': () => runAi(rerender),
    'ai-stop': () => S.aiRun?.ctl?.abort(),
    'ai-save': () => saveAi(rerender),
  });
}
