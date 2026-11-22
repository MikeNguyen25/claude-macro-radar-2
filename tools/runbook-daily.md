# Runbook tác vụ 07:40 (macro-radar 2)

Tác vụ chạy mỗi sáng 07:40 giờ Việt Nam, trong một phiên mới. Phần tất định (giá, dự báo, sổ dự báo, chấm
điểm, phép thử, quyết định tháng) đã do GitHub Actions làm lúc 07:09–07:52 và nằm trong repo. Tác vụ chỉ:
viết nhận định AI (M6), chấm M6, đăng file lên artifact, ghi vài doc DB nhỏ và nhắn Mike.

- Repo (công khai): https://github.com/MikeNguyen25/claude-macro-radar-2
- Artifact "macro-radar 2": slug `5ba61d5f-a472-4ee1-91f2-614f32dfd699` (https://claude.ai/artifact/CKQ3aPT6sCrKFGACFpngmn)
- Không bịa số. Không khuyến nghị mua bán. Việc ngoài các bước dưới đây thì hỏi Mike trước.
- Không sửa `state/` và không chạy `mrc.mjs daily`: sổ dự báo chỉ do GitHub Actions ghi.
- Mọi lệnh chạy từ thư mục làm việc của phiên (`pwd`), dùng các thư mục con `mr/`, `mr-db/`, `mr-out/`.
  Công cụ cần đường dẫn tuyệt đối thì ghép `$(pwd)` với đường dẫn tương đối.

## 1. Lấy code, số liệu và trạng thái

```bash
rm -rf mr mr-db mr-out && mkdir -p mr-db mr-out
git clone -q --depth 1 https://github.com/MikeNguyen25/claude-macro-radar-2 mr
node mr/tools/mrc.mjs status --state mr/state --site mr/site
```

- `forecastReady` là true và `siteDate` là hôm nay thì sang bước 2.
- Chưa có: `sleep 240`, rồi `git -C mr pull -q` và chạy lại `status`; tối đa 6 lần (tới khoảng 08:05).
  Vẫn chưa có thì nhắn Mike: "Job dự báo GitHub hôm nay chưa xong", kèm `lastRun` của `status` và đường dẫn
  https://github.com/MikeNguyen25/claude-macro-radar-2/actions, rồi dừng.

## 2. Đọc doc DB (slug ở trên)

Dùng `db_get`; doc chưa có thì bỏ qua. Công cụ có tên khác (ví dụ ArtifactData) thì dùng thao tác đọc tương đương.

0. `analyses/<hôm nay>` đã có thì đây là lần chạy lại trong ngày: nhận định AI đã ghi là bất biến. Bỏ qua bước 3–7,
   chỉ nhắn Mike một dòng "Hôm nay đã chạy xong lúc <createdAt của doc đó>" rồi dừng.

1. `public/latest`, `meta/status`, `scores/ai`: ghi version của từng doc có tồn tại vào `mr-db/versions.json`,
   ví dụ `{"public/latest": 3, "meta/status": 3, "scores/ai": 3}`.
2. Ghi phần data của `scores/ai` vào `mr-db/scores_ai.json`, nguyên văn.
3. Nếu `status` có `aiDue` (ngày hôm nay trừ 30): `db_get analyses/<aiDue>`. Có doc thì ghi `mr-db/ai_due.json` dạng
   `{"date": "<aiDue>", "hash": "<hash>", "probs": {"btc": 0.55, ...}}`, lấy `prob_up` của từng phần tử `assets`.

## 3. Viết nhận định AI

Đọc `mr/site/ai_context.json` (luật và schema trong khóa `instructions`). Tìm tin trong phiên: 4–6 lượt
WebSearch (chứng khoán Mỹ, Fed và lợi suất, crypto, dầu và vàng, VN-Index và tỷ giá, Trung Quốc); mở trang khi
cần số cụ thể. Rồi viết `mr-out/analysis.json` cho đủ 14 tài sản:

- `prob_up` trong ±10 điểm % quanh `champion_prob`; không có dữ kiện mới thì để bằng `champion_prob`.
- `confidence` là `"thap"` khi `badge_1m` khác `strong`.
- `evidence`: 2–4 dữ kiện, mỗi dữ kiện có số, ngày và tên nguồn đã thấy trong phiên. Không đủ thì ghi ít hơn, không bịa.
- Tiếng Việt, ngắn gọn; không khuyến nghị mua bán.

## 4. Chạy lớp AI

```bash
ARGS="--ai mr-out/analysis.json --versions mr-db/versions.json"
[ -f mr-db/scores_ai.json ] && ARGS="$ARGS --aiscores mr-db/scores_ai.json"
[ -f mr-db/ai_due.json ] && ARGS="$ARGS --due mr-db/ai_due.json"
node mr/tools/mrc.mjs ai --data mr/data --state mr/state --site mr/site --out mr-out $ARGS
# Chủ nhật: thêm số liệu thô cho bàn thử cấu hình
[ "$(TZ=Asia/Ho_Chi_Minh date +%u)" = 7 ] && node mr/tools/mrc.mjs raw --data mr/data --out mr-out/files/data/raw.json
```

`aiIssues` liệt kê chỗ runner đã kẹp hay sửa; không cần chạy lại.

## 5. Đăng file lên artifact

`list_files` với slug ở trên để lấy version hiện tại, rồi `publish_files` (mode `patch`, `base_version` = version đó).
Mỗi file: `as` là đường dẫn bên dưới `mr-out/files/`, `path` là `$(pwd)/mr-out/files/<as>`:

- `data/bundle.json`, `data/history.json`, `data/latest.json`, `ledger/<hôm nay>.json`; Chủ nhật thêm `data/raw.json`.

## 6. Ghi DB

Đọc `mr-out/db_ops.json` và gửi đúng các lệnh đó bằng một lần `db_write`, giữ nguyên `path`, `ifVersion` và `data`
(chép nguyên văn: doc `analyses/<ngày>` có hash). Bị từ chối vì version: `db_get` lại doc đó, sửa `mr-db/versions.json`,
chạy lại bước 4 rồi bước 6 (bước 5 đã xong thì không đăng lại).

## 7. Số Việt Nam đọc từ thông cáo (chỉ ngày 3–12 hằng tháng)

`db_list manual`. Chuỗi nào chưa có kỳ tháng trước (CPI và lạm phát cơ bản: Cục Thống kê, khoảng ngày 6; PMI: S&P Global,
khoảng ngày 3; lãi suất tái cấp vốn: NHNN) thì tìm tối đa 2 lượt mỗi chuỗi. Thấy số thì:

```bash
node mr/tools/mrc.mjs manual --id vn_cpi --period YYYY-MM --value 3,21 --src1 "Tên nguồn|url" [--src2 "Tên nguồn 2|url"] [--doc mr-db/manual_vn_cpi.json] --out mr-out
```

(`--doc` là doc đang có, lưu dạng `{"version": n, "data": {...}}`.) Rồi `db_write` lệnh trong `mr-out/manual_<id>.json`.
Hai nguồn lệch nhau thì không ghi, nêu trong tin nhắn.

## 8. Nhắn Mike

Gửi nguyên văn `mr-out/message.txt` (tối đa 12 dòng) bằng SendUserMessage nếu có công cụ đó, và kết thúc phiên bằng chính
nội dung ấy. Bước nào lỗi thì vẫn nhắn: thêm một dòng nêu bước lỗi và lý do. Không tự sửa cấu hình, không xóa doc,
không đụng tác vụ định kỳ khác.

## Ghi chú

- Chủ nhật: GitHub Actions đã chạy phép thử; kết quả có trong tin nhắn và tab Nhật ký.
- Lần chạy đầu tháng: GitHub Actions đã ra quyết định tháng (lên ngôi, tối ưu tham số, đánh giá tháng).
- Quay lại version cũ: workflow `rollback` trên GitHub. Đề xuất phép thử: workflow `experiment`.
