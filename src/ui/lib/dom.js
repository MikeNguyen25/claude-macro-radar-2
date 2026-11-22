// Mẫu HTML có tự thoát ký tự: mọi giá trị chèn vào đều được thoát, trừ giá trị bọc raw() hoặc tạo bởi h``.

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s) => new Raw(String(s ?? ''));

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}

/** Mẫu HTML: h`<p>${text}</p>` thoát text; mảng được nối. */
export function h(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += val(vals[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Gắn sự kiện theo data-action trong một vùng: handlers = { tên: (el, ev) => ... }. */
export function delegate(root, type, handlers) {
  root.addEventListener(type, (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.action];
    if (fn) fn(el, ev);
  });
}

/** Lỗi mạng hoặc dữ liệu: hiện lời nhắn ngắn, không văng lỗi ra ngoài. */
export function errorBox(msg) {
  return h`<div class="callout bad" role="alert">${msg}</div>`;
}
