# macro-radar 2

Radar vĩ mô và dự báo xác suất cho 14 tài sản (BTC, ETH, SOL, DOGE, TRX, S&P 500, Nasdaq, STI, SET,
VN-Index, vàng, Brent, USD/VND, lợi suất 10 năm Mỹ), kỳ 1 và 3 tháng. Mỗi dự báo ghi một lần vào sổ
bất biến và được chấm trung thực so với tần suất lịch sử (M1). Công cụ tham khảo, không khuyến nghị mua bán.

## Luồng hằng ngày

| Giờ (VN) | Ở đâu | Việc |
|---|---|---|
| 06:37 | GitHub Actions `macro-daily` | số liệu vĩ mô vào `data/series/` |
| 07:09 (dự phòng 07:29, 07:52) | GitHub Actions `prices-daily` | giá vào `data/prices/`; rồi `node tools/mrc.mjs daily`: chấm dự báo tới hạn, phép thử (Chủ nhật), quyết định tháng (lần chạy đầu tháng), ghi `state/forecasts/<ngày>.json` (hash SHA-256) và `site/` |
| 07:40 | tác vụ định kỳ của Claude | dự báo hôm nay chưa có thì chạy job `prices-daily`; đọc `site/ai_context.json`, viết nhận định AI (M6), `node tools/mrc.mjs ai`, đăng trang (`web/`) và số liệu lên artifact, ghi vài doc DB nhỏ, nhắn Mike |

Sổ dự báo nằm trong `state/forecasts/`; lịch sử commit của repo là dấu thời gian. Nhận định AI nằm
trong DB của artifact (`analyses/<ngày>`) và file `analyses/<ngày>.json` của artifact, có hash; 30 ngày sau
runner kiểm hash rồi mới chấm. Quay lại version cũ: workflow `rollback`. Đề xuất phép thử: workflow `experiment`.

## Thư mục

- `jobs/update.py`: lấy số liệu, đối chiếu nguồn, cách ly điểm bất thường, QA.
- `src/engine/`: engine thuần JavaScript, tất định, dùng chung cho Node và trình duyệt.
- `src/ui/`: trang (8 tab tiếng Việt). `npm run web` đóng gói vào `web/` (`index.html` khoảng 1 KB, `app.js`, `app.css`,
  `sandbox-worker.js`); tác vụ 07:40 đăng lại trang từ `web/` mỗi sáng, CI kiểm `web/` khớp mã nguồn. Sửa giao diện thì
  chạy `npm run web` rồi commit cả `web/`.
- `tools/mrc.mjs`: runner (daily, ai, status, manual, rollback, propose, raw); `tools/runbook-daily.md`: các bước của tác vụ 07:40.
- `state/`: cấu hình, nhà vô địch, sổ dự báo, điểm, phép thử, version. `site/`: file cho trang.
- `tests/`: kiểm thử đơn vị, tổng hợp (nhiễu không được lên ngôi, tín hiệu cài sẵn được tìm ra), chống nhìn trước, tất định, E2E.

## Chạy cục bộ

```
npm ci
npm test
node tools/mrc.mjs daily --data data --state /tmp/st --site /tmp/site --today 2026-11-20
node build.mjs --preview /tmp/site --state /tmp/st && node tests/e2e/ui.e2e.mjs
```
