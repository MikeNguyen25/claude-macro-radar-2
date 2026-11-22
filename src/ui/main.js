// Khung trang: đầu trang, điều hướng theo #hash, giao diện sáng/tối, nạp số liệu rồi vẽ trang đang mở.

import { h, $, $$ } from './lib/dom.js';
import { S, loadCore, initCaps, onChange } from './lib/store.js';
import * as F from './lib/fmt.js';
import * as overview from './views/overview.js';
import * as assets from './views/assets.js';
import * as macro from './views/macro.js';
import * as scenario from './views/scenario.js';
import * as reliability from './views/reliability.js';
import * as ai from './views/ai.js';
import * as method from './views/method.js';
import * as log from './views/log.js';

const ROUTES = [
  ['tong-quan', 'Tổng quan', overview], ['tai-san', 'Tài sản', assets], ['vi-mo', 'Vĩ mô', macro], ['kich-ban', 'Kịch bản', scenario],
  ['do-tin-cay', 'Độ tin cậy', reliability], ['ai', 'AI', ai], ['phuong-phap', 'Phương pháp', method], ['nhat-ky', 'Nhật ký', log],
];

function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('tai-san-')) return { id: 'tai-san', arg: hash.slice(8) };
  return { id: ROUTES.some((r) => r[0] === hash) ? hash : 'tong-quan', arg: null };
}

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* không lưu được thì thôi */ } } };
const THEMES = ['', 'light', 'dark'];
const THEME_LABEL = { '': 'Tự động', light: 'Sáng', dark: 'Tối' };
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  const b = $('#theme-btn');
  if (b) { b.textContent = THEME_LABEL[t]; b.setAttribute('aria-label', `Giao diện: ${THEME_LABEL[t]}. Bấm để đổi`); }
}

function shell() {
  document.body.innerHTML = String(h`<a class="sr-only" href="#main">Bỏ qua điều hướng</a>
  <header class="top">
    <div class="top-row">
      <div class="brand"><h1>macro-radar <b>2</b></h1><span class="run-line" id="run-line">Đang tải…</span></div>
      <button class="icon-btn" id="theme-btn" type="button">Tự động</button>
    </div>
    <nav class="tabs" aria-label="Các trang"><ul>${ROUTES.map(([id, label]) => h`<li><a href="#${id}" data-route="${id}">${label}</a></li>`)}</ul></nav>
  </header>
  <main id="main" tabindex="-1"></main>
  <footer><p>Công cụ tham khảo cá nhân, không phải khuyến nghị mua bán. Mỗi con số có nguồn và ngày; số thiếu được ghi "Chưa đủ cơ sở".</p>
    <p id="foot-line"></p></footer>`);
  applyTheme(store.get('mr2-theme') || '');
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || '';
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    store.set('mr2-theme', next);
    applyTheme(next);
  });
}

function headerLine() {
  const c = S.core;
  const el = $('#run-line');
  if (!c) { el.textContent = S.error ? 'Lỗi tải số liệu' : 'Đang tải…'; return; }
  el.textContent = `Dự báo ${F.date(c.date)} · v${c.version}${S.owner ? ' · chủ sở hữu' : ''}`;
  $('#foot-line').textContent = `Engine ${c.engineVersion} · số liệu tạo lúc ${F.vnTime(c.generatedAt)}${c.publishedAt ? ` · đăng lúc ${F.vnTime(c.publishedAt)}` : ''}`;
}

/** Vẽ trang đang mở. keepScroll: vẽ lại tại chỗ (dữ liệu mới về) thay vì sang trang. */
function render(keepScroll = false) {
  const main = $('#main');
  const r = route();
  for (const a of $$('nav.tabs a')) {
    if (a.dataset.route === r.id) { a.setAttribute('aria-current', 'page'); if (!keepScroll) a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } else a.removeAttribute('aria-current');
  }
  headerLine();
  const y = window.scrollY;
  if (S.error) { main.innerHTML = String(h`<div class="callout bad" role="alert">${S.error}</div>`); return; }
  if (!S.core) { main.innerHTML = String(h`<div class="loading" role="status">Đang tải số liệu…</div>`); return; }
  const view = ROUTES.find((x) => x[0] === r.id)[2];
  const ctx = { arg: r.arg, width: Math.min(main.clientWidth || window.innerWidth, 1180) - 32 };
  // thay vùng nội dung bằng phần tử mới để bỏ mọi sự kiện cũ
  const fresh = main.cloneNode(false);
  try {
    fresh.innerHTML = String(view.render(ctx));
  } catch (e) {
    console.error(e);
    fresh.innerHTML = String(h`<div class="callout bad" role="alert">Trang này gặp lỗi khi vẽ: ${e.message}</div>`);
  }
  main.replaceWith(fresh);
  if (view.mount) view.mount(fresh, ctx, () => render(true));
  document.title = `macro-radar 2 · ${ROUTES.find((x) => x[0] === r.id)[1]}`;
  if (keepScroll) window.scrollTo(0, y);
}

function boot() {
  shell();
  render();
  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
    $('#main')?.focus({ preventScroll: true });
  });
  let rt;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - lastW) < 40) return;
    clearTimeout(rt);
    rt = setTimeout(() => { lastW = window.innerWidth; render(true); }, 200);
  });
  let pending = false;
  onChange(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(true); });
  });
  loadCore();
  initCaps();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
