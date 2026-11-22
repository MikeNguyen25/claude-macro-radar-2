// Kiểm thử đầu-cuối: phục vụ dist/ bằng máy chủ tĩnh, mở bằng Chrome ở 390 px và 1280 px, đi qua 8 trang,
// bắt lỗi console, kiểm CSS đã áp dụng, biểu đồ, hash sổ dự báo, và trang không cuộn ngang.
// Chạy hai dạng trang: nguyên bản, và dạng bị công cụ đăng của phiên tự động bọc trong khung riêng.
//   node tests/e2e/ui.e2e.mjs [--shots test-results]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const DIST = path.resolve('dist');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

// Khung mà công cụ Artifact của phiên tự động thêm quanh trang khi đăng (chép từ trang đã đăng ngày 22/11/2026).
const WRAP_HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><style>:root{color-scheme:light}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n';
const WRAP_TAIL = '\n</body></html>';

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = decodeURIComponent(u.pathname);
  const f = path.join(DIST, url === '/' ? 'index.html' : url);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  if (url === '/' && u.searchParams.has('wrap')) { res.end(WRAP_HEAD + fs.readFileSync(f, 'utf8') + WRAP_TAIL); return; }
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const ROUTES = ['tong-quan', 'tai-san', 'vi-mo', 'kich-ban', 'do-tin-cay', 'ai', 'phuong-phap', 'nhat-ky'];
const failures = [];
const fail = (msg) => { failures.push(msg); console.error(`✗ ${msg}`); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  for (const vp of [{ width: 390, height: 844, wrap: false }, { width: 1280, height: 900, wrap: false }, { width: 390, height: 844, wrap: true }]) {
    const tag = `${vp.width}px${vp.wrap ? ' (trang bị bọc)' : ''}`;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'vi-VN' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const t0 = Date.now();
    await page.goto(`${base}${vp.wrap ? '?wrap=1' : ''}#tong-quan`);
    await page.waitForSelector('.prob-row', { timeout: 15000 });
    const loadMs = Date.now() - t0;
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() !== '', null, { timeout: 5000 })
      .catch(() => fail(`${tag}: CSS của trang không được áp dụng`));
    const rows = await page.locator('.prob-row').count();
    if (rows < 14) fail(`${tag}: tổng quan chỉ có ${rows} dòng tài sản`);
    if (loadMs > 2000) fail(`${tag}: tổng quan hiện sau ${loadMs} ms (mục tiêu < 2000)`);
    for (const r of ROUTES) {
      await page.evaluate((h) => { location.hash = h; }, r);
      await page.waitForFunction((h) => document.querySelector(`nav a[data-route="${h}"]`)?.getAttribute('aria-current') === 'page', r);
      await page.waitForSelector('main h2', { timeout: 10000 });
      if (r === 'tai-san') await page.waitForSelector('#price-chart svg path.ln', { timeout: 15000 }).catch(() => fail(`${tag}: biểu đồ giá không hiện`));
      const bad = await page.locator('main .callout.bad').count();
      if (bad) fail(`${tag}: trang ${r} có hộp lỗi`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 2) fail(`${tag}: trang ${r} cuộn ngang ${overflow}px`);
      if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `${vp.width}${vp.wrap ? "-boc" : ""}-${r}.png`), fullPage: true }); }
    }
    await page.evaluate(() => { location.hash = 'nhat-ky'; });
    const btn = page.locator('button[data-action="verify"]').first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForSelector('.ledger-result', { timeout: 10000 });
      const txt = await page.locator('.ledger-result').first().textContent();
      if (!/khớp/.test(txt) || /không/.test(txt)) fail(`${tag}: kiểm hash sổ dự báo: ${txt}`);
    } else fail(`${tag}: không có nút kiểm sổ dự báo`);
    await page.evaluate(() => { location.hash = 'tai-san-ust10y'; });
    await page.waitForSelector('#price-chart svg path.ln', { timeout: 10000 }).catch(() => fail(`${tag}: biểu đồ lợi suất không hiện`));
    await page.click('#theme-btn');
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (theme !== 'light') fail(`${tag}: nút giao diện không đổi sang sáng (${theme})`);
    if (errors.length) fail(`${tag}: lỗi console: ${errors.slice(0, 3).join(' | ')}`);
    console.log(`✓ ${tag}: ${rows} tài sản, tải ${loadMs} ms, ${ROUTES.length} trang`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.error(`${failures.length} lỗi`); process.exit(1); }
console.log('E2E: đạt');
