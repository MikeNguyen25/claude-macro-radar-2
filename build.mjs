// Đóng gói trang: một file dist/index.html (JS, CSS nhúng sẵn, dưới 300 KB) và dist/sandbox-worker.js
// (engine chạy trong tiến trình nền cho bàn thử cấu hình).
//   node build.mjs                                  chỉ đóng gói
//   node build.mjs --preview site --state state     kèm số liệu để xem thử cục bộ và chạy E2E

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const MAX_INDEX_BYTES = 300 * 1024;
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, minify: true, format: 'iife', target: ['es2020', 'safari15'], legalComments: 'none', charset: 'utf8', write: false, logLevel: 'warning' };
const js = (await esbuild.build({ ...common, entryPoints: ['src/ui/main.js'] })).outputFiles[0].text;
const worker = (await esbuild.build({ ...common, entryPoints: ['src/ui/worker.js'] })).outputFiles[0].text;
const css = (await esbuild.transform(fs.readFileSync('src/ui/styles.css', 'utf8'), { loader: 'css', minify: true })).code;
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Radar vĩ mô và dự báo xác suất cho 14 tài sản, kèm sổ dự báo bất biến và chấm điểm trung thực so với tần suất lịch sử.">
<meta name="generator" content="macro-radar ${version}">
<title>macro-radar 2</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Ccircle cx=%228%22 cy=%228%22 r=%227%22 fill=%22%230b6b61%22/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>${css}</style>
</head>
<body>
<noscript><p style="padding:16px">Trang cần JavaScript để hiển thị dự báo.</p></noscript>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'sandbox-worker.js'), worker);
const size = fs.statSync(path.join(out, 'index.html')).size;
const res = { index: size, worker: worker.length, css: css.length, js: js.length };

const site = opt('preview');
if (site) {
  fs.mkdirSync(path.join(out, 'data'), { recursive: true });
  for (const f of ['bundle.json', 'history.json', 'latest.json']) if (fs.existsSync(path.join(site, f))) fs.copyFileSync(path.join(site, f), path.join(out, 'data', f));
  const stateDir = opt('state');
  if (stateDir && fs.existsSync(path.join(stateDir, 'forecasts'))) {
    fs.mkdirSync(path.join(out, 'ledger'), { recursive: true });
    for (const f of fs.readdirSync(path.join(stateDir, 'forecasts'))) fs.copyFileSync(path.join(stateDir, 'forecasts', f), path.join(out, 'ledger', f));
  }
  if (fs.existsSync('data/prices')) execFileSync(process.execPath, ['tools/mrc.mjs', 'raw', '--data', 'data', '--out', path.join(out, 'data', 'raw.json')]);
  res.preview = site;
}
console.log(JSON.stringify(res));
if (size > MAX_INDEX_BYTES) {
  console.error(`index.html ${size} byte vượt giới hạn ${MAX_INDEX_BYTES}`);
  process.exit(1);
}
