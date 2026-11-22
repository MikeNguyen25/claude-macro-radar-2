// Kịch bản: góc phần tư tăng trưởng × lạm phát, chế độ rủi ro, diễn biến 12 tháng và cách mô hình
// làm việc trong từng chế độ thị trường.

import { h, raw } from '../lib/dom.js';
import { S } from '../lib/store.js';
import * as F from '../lib/fmt.js';
import { quadrantChart } from '../lib/charts.js';
import { GROUP_ORDER, groupName } from './common.js';

const Q_SHORT = { goldilocks: 'Lý tưởng', overheat: 'Nóng', stagflation: 'Đình lạm', slowdown: 'Chậm lại' };
const quad = (g, i) => (!F.ok(g) || !F.ok(i) ? null : g >= 0 ? (i < 0 ? 'goldilocks' : 'overheat') : i >= 0 ? 'stagflation' : 'slowdown');

function riskCard(c) {
  const r = c.regime.risk;
  const pos = F.ok(r.score) ? Math.max(0, Math.min(100, ((r.score + 2) / 4) * 100)) : null;
  const parts = Object.entries(r.parts || {});
  return h`<section class="card" aria-labelledby="t-risk"><header><h2 id="t-risk">Chế độ rủi ro</h2><span class="chip ${r.state === 'off' ? 'bad' : r.state === 'on' ? 'strong' : 'none'}">${r.label}</span></header>
    <p>Điểm rủi ro <b>${F.num(r.score, 2)}</b>: trung bình z của VIX, điều kiện tài chính Mỹ và chênh lệch tín dụng. Trên 0,5 là né rủi ro; dưới −0,25 là ưa rủi ro.</p>
    ${pos !== null ? raw(`<div class="pbar-track" role="img" aria-label="Điểm rủi ro ${F.num(r.score, 2)} trên thang từ −2 đến 2" style="background:linear-gradient(90deg,var(--up) 0 ${((1.75) / 4) * 100}%,var(--sunken) 0 ${(2.5 / 4) * 100}%,var(--down) 0)"><div class="pbar-base" style="left:calc(${pos.toFixed(1)}% - 1px)"></div></div>`) : ''}
    <div class="row between small muted"><span>−2 ưa rủi ro</span><span>0</span><span>+2 né rủi ro</span></div>
    <div class="table-wrap"><table><tbody>${parts.map(([k, v]) => h`<tr><th scope="row">${F.featLabel(k)}</th><td class="num">${F.signed(v, 2)}</td><td class="muted">${F.zWord(v)}</td></tr>`)}</tbody></table></div>
  </section>`;
}

function quadrantCard(c, width) {
  const pts = ['us', 'cn', 'world', 'vn'].map((r) => {
    const x = c.regime.regions[r];
    return { label: x.name, g: x.growth, i: x.inflation, g3: x.growth3m, i3: x.inflation3m };
  });
  const missing = pts.filter((p) => !F.ok(p.g) || !F.ok(p.i)).map((p) => p.label);
  return h`<section class="card" aria-labelledby="t-quad"><header><h2 id="t-quad">Tăng trưởng và lạm phát</h2><span class="note">Trục dọc: lạm phát (z). Điểm rỗng: 3 tháng trước</span></header>
    <div class="chart">${raw(quadrantChart(pts, Math.min(width - 34, 520), 'Góc phần tư tăng trưởng và lạm phát theo vùng, so với 3 tháng trước'))}</div>
    <ul class="stack" style="padding-left:18px;margin:0">${['us', 'cn', 'world', 'vn'].map((r) => {
      const x = c.regime.regions[r];
      return h`<li><b>${x.name}:</b> ${x.label}${F.ok(x.dGrowth) ? h`; so với 3 tháng trước tăng trưởng ${F.signed(x.dGrowth, 2)}, lạm phát ${F.signed(x.dInflation, 2)}` : ''}${F.ok(x.policy) ? h`; lãi suất điều hành ${F.zWord(x.policy)} (z ${F.signed(x.policy, 2)})` : ''}.</li>`;
    })}</ul>
    ${missing.length ? h`<p class="note">Thiếu số liệu để xếp: ${missing.join(', ')} (Việt Nam chưa có chuỗi lạm phát tự động đủ dài).</p>` : ''}
  </section>`;
}

function historyCard(c) {
  const hist = (c.regime.history || []).slice(-12);
  return h`<section class="card" aria-labelledby="t-rh"><header><h2 id="t-rh">12 tháng gần nhất</h2></header>
    <div class="table-wrap"><table><thead><tr><th>Cuối tháng</th>${['us', 'cn', 'world', 'vn'].map((r) => h`<th>${F.REGION[r]}</th>`)}</tr></thead>
    <tbody>${hist.map((x) => h`<tr><td>${F.month(x.date)}</td>${['us', 'cn', 'world', 'vn'].map((r) => {
      const q = quad(x[`${r}.g`], x[`${r}.i`]);
      return h`<td>${q ? Q_SHORT[q] : h`<span class="muted">–</span>`}</td>`;
    })}</tr>`)}</tbody></table></div>
    <p class="note">Nóng: tăng trưởng và lạm phát cùng trên mức thường. Lý tưởng: tăng trưởng trên, lạm phát dưới. Đình lạm: tăng trưởng dưới, lạm phát trên. Chậm lại: cả hai dưới.</p>
  </section>`;
}

function regimePerf(c) {
  const rows = [];
  for (const g of GROUP_ORDER) {
    const sc = c.eval['1m']?.groups?.[g];
    if (!sc?.regimes) continue;
    const champ = c.badges[g]?.['1m']?.champion || 'M1';
    const best = (reg) => {
      const r = sc.regimes[reg];
      if (!r) return null;
      return Object.entries(r).filter(([M]) => M !== 'M1').sort((a, b) => b[1].skill - a[1].skill)[0];
    };
    rows.push(h`<tr><th scope="row">${groupName(g)}</th>${['bull', 'bear', 'vixHigh'].map((reg) => {
      const b = best(reg);
      const n = sc.regimes[reg]?.M1?.n;
      return h`<td>${b ? h`${b[0]} <span class="${b[1].skill > 0 ? 'up' : 'down'}">${F.signed(b[1].skill * 100, 1)}%</span> <span class="muted small">(${n})</span>` : '–'}</td>`;
    })}<td>${champ}</td></tr>`);
  }
  return h`<section class="card" aria-labelledby="t-rp"><header><h2 id="t-rp">Mô hình nào tốt hơn M1 trong từng chế độ</h2><span class="note">Kỳ 1 tháng, kiểm định</span></header>
    <div class="table-wrap"><table><thead><tr><th>Nhóm</th><th>Thị trường lên</th><th>Thị trường xuống</th><th>VIX cao</th><th>Đang dẫn</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Mỗi ô là mô hình có BSS cao nhất so với M1 trong chế độ đó (số trong ngoặc là số dự báo). Kết quả theo chế độ chỉ để tham khảo, không dùng để chọn nhà vô địch.</p>
  </section>`;
}

export function render(ctx) {
  const c = S.core;
  return h`<div class="grid-2">${quadrantCard(c, ctx.width >= 900 ? ctx.width / 2 : ctx.width)}${riskCard(c)}</div><div class="grid-2">${historyCard(c)}${regimePerf(c)}</div>`;
}
