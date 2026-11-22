# Runbook tác vụ 07:40 (macro-radar 2)

Tác vụ chạy mỗi sáng 07:40 giờ Việt Nam, trong một phiên mới. Phần tất định (giá, dự báo, sổ dự báo, chấm
điểm, phép thử, quyết định tháng) do GitHub Actions làm và nằm trong repo. Tác vụ chỉ: viết nhận định AI (M6),
chấm M6, đăng file lên artifact, ghi vài doc DB và nhắn Mike.

- Repo (công khai): https://github.com/MikeNguyen25/claude-macro-radar-2
- Artifact "macro-radar 2": URL https://claude.ai/artifact/CKQ3aPT6sCrKFGACFpngmn (slug 5ba61d5f-a472-4ee1-91f2-614f32dfd699)
- Không bịa số. Không khuyến nghị mua bán. Việc ngoài các bước dưới đây thì không làm, ghi vào tin nhắn để Mike quyết.
- Không sửa `state/` và không chạy `mrc.mjs daily`: sổ dự báo chỉ do GitHub Actions ghi.
- Mọi lệnh chạy từ thư mục làm việc của phiên (`pwd`), dùng các thư mục con `mr/`, `mr-db/`, `mr-out/`.

## Công cụ (đã kiểm trong phiên tự động ngày 22/11/2026)

- **Artifact**: `{action: "read", url}` lưu trang ra file và cho biết đường dẫn (muốn đăng phải Read hết file đó);
  `{action: "read", url, paths: [...]}` tải file đã đăng về thư mục nháp của artifact (không truyền `out_dir`, vì lưu
  ngoài thư mục ấy phải hỏi Mike); `{action: "list", scope: "files", url}`; `{action: "publish", url, file_path, files}`:
  bắt buộc `file_path` là file HTML của trang; `files` là map `{"đường/dẫn/đăng": "file nguồn"}`; file không nhắc tới được giữ.
- **ArtifactData**: `{action: "get", url, collection, doc_id}` trả cả version; `{action: "list", url, collection}`;
  `{action: "batch", url, writes: [{op, collection, doc_id, file_path, if_version}]}`: doc đã có bắt buộc `if_version`;
  `file_path` gửi doc từ file JSON, không phải chép nội dung.
- **GitHub**: chạy job bằng `mcp__github__actions_run_trigger` với `{method: "run_workflow", owner: "MikeNguyen25",
  repo: "claude-macro-radar-2", workflow_id: "prices-daily.yml", ref: "main"}`; không có công cụ đó thì
  `gh api -X POST repos/MikeNguyen25/claude-macro-radar-2/actions/workflows/prices-daily.yml/dispatches -f ref=main`.
  `gh workflow run` không dùng được (GraphQL bị chặn).
- **WebSearch**: nạp bằng ToolSearch `select:WebSearch`. **SendUserMessage**: nhắn Mike.
- Phiên có công cụ tên khác (db_get, db_write, publish_files, list_files) thì dùng thao tác tương đương.

## 1. Lấy code, số liệu và trạng thái

```bash
rm -rf mr mr-db mr-out && mkdir -p mr-db mr-out
git clone -q --depth 1 https://github.com/MikeNguyen25/claude-macro-radar-2 mr
node mr/tools/mrc.mjs status --state mr/state --site mr/site
```

- `forecastReady` true và `siteDate` là hôm nay thì sang bước 2.
- Chưa có: chạy job `prices-daily` bằng công cụ GitHub ở trên (lịch của GitHub ở repo mới hay trễ). Rồi cứ 3 phút
  `git -C mr pull -q` và chạy lại `status`, tối đa 8 lần. Vẫn chưa có thì nhắn Mike "Job dự báo GitHub hôm nay chưa xong",
  kèm `lastRun` của `status` và https://github.com/MikeNguyen25/claude-macro-radar-2/actions, rồi dừng.

## 2. Đọc trạng thái trong artifact

1. ArtifactData get `analyses/<hôm nay>`: đã có thì đây là lần chạy lại trong ngày (nhận định đã ghi là bất biến).
   Nhắn Mike một dòng "Hôm nay đã chạy xong lúc <createdAt>" rồi dừng.
2. ArtifactData get `public/latest`, `meta/status`, `scores/ai`. Ghi version của doc nào có tồn tại vào
   `mr-db/versions.json`, ví dụ `{"public/latest": 2, "meta/status": 2, "scores/ai": 2}`.
3. Artifact read với `url` và `paths: ["data/ai_scores.json", "analyses/<aiDue>.json"]`, không truyền `out_dir`
   (`aiDue` lấy từ kết quả `status`, là ngày hôm nay trừ 30; `aiDue` null thì chỉ tải `data/ai_scores.json`).
   Kết quả cho biết nơi lưu từng file, dạng `<thư mục>/data/ai_scores.json`: `<thư mục>` là giá trị `--prev` ở bước 4.
   File chưa có thì bỏ qua (không có file nào thì bỏ `--prev`). Runner tự kiểm hash nhận định trước khi chấm M6.

## 3. Viết nhận định AI

Đọc `mr/site/ai_context.json` (luật và schema trong khóa `instructions`). Tìm tin trong phiên: 4–6 lượt WebSearch
(chứng khoán Mỹ, Fed và lợi suất, crypto, dầu và vàng, VN-Index và tỷ giá, Trung Quốc). Rồi viết `mr-out/analysis.json`
cho đủ 14 tài sản:

- `prob_up` trong ±10 điểm % quanh `champion_prob`; không có dữ kiện mới thì để bằng `champion_prob`.
- `confidence` là `"thap"` khi `badge_1m` khác `strong`.
- `evidence`: 2–4 dữ kiện, mỗi dữ kiện có số, ngày và tên nguồn đã thấy trong phiên. Không đủ thì ghi ít hơn, không bịa.
- Tiếng Việt, ngắn gọn; không khuyến nghị mua bán.

## 4. Chạy lớp AI

```bash
node mr/tools/mrc.mjs ai --data mr/data --state mr/state --site mr/site --out mr-out \
  --ai mr-out/analysis.json --versions mr-db/versions.json --prev "<thư mục của bước 2.3>" > mr-out/result.json
```

`mr-out/result.json` có `page` (file trang, trong `mr/web/`), `files` (map đường dẫn đăng → file nguồn tuyệt đối: số liệu
hôm nay, mã giao diện, Chủ nhật thêm `data/raw.json`), `dbWrites` và `message`. `aiIssues` liệt kê chỗ runner đã kẹp hay
sửa; `notes` ghi việc chấm M6. Không cần chạy lại.

## 5. Đăng file lên artifact

1. Artifact read `url` (không `path`, không `paths`): công cụ lưu trang ra file. Read hết file đó (trang chỉ khoảng
   20 dòng; `app.js` và `app.css` là file riêng, không cần đọc).
2. Artifact publish với `url`, `file_path` là `page` của bước 4 (khi `page` null: file trang vừa lưu ở bước 5.1) và
   `files` là đúng map `files` của bước 4.
3. Artifact list `scope: "files"` với `url`: `data/bundle.json` và `ledger/<hôm nay>.json` phải có mặt.

## 6. Ghi DB

ArtifactData batch với `url` và `writes` là nội dung `mr-out/db_writes.json` (mỗi lệnh đã có `file_path`, không chép số liệu).
Bị từ chối vì version: get lại doc đó, sửa `mr-db/versions.json`, chạy lại bước 4 rồi bước 6 (không đăng lại file).

## 7. Số Việt Nam đọc từ thông cáo (chỉ ngày 3–12 hằng tháng)

ArtifactData list `manual`. Chuỗi nào chưa có kỳ tháng trước (CPI và lạm phát cơ bản: Cục Thống kê, khoảng ngày 6; PMI:
S&P Global, khoảng ngày 3; lãi suất tái cấp vốn: NHNN) thì tìm tối đa 2 lượt mỗi chuỗi. Thấy số:

```bash
node mr/tools/mrc.mjs manual --id vn_cpi --period YYYY-MM --value 3,21 --src1 "Tên nguồn|url" [--src2 "Tên nguồn 2|url"] [--doc mr-db/manual_vn_cpi.json] --out mr-out
```

(`--doc` là doc đang có, lưu dạng `{"version": n, "data": {...}}`.) Rồi ArtifactData batch với `writes` trong
`mr-out/manual_<id>.writes.json`. Hai nguồn lệch nhau thì không ghi, nêu trong tin nhắn.

## 8. Nhắn Mike

Gửi nguyên văn `message` của bước 4 (tối đa 12 dòng) bằng SendUserMessage và kết thúc phiên bằng chính nội dung ấy.
Bước nào lỗi thì vẫn nhắn, thêm một dòng nêu bước lỗi và lý do. Không tự sửa cấu hình, không xóa doc, không đụng tác vụ
định kỳ khác.

## Ghi chú

- Chủ nhật: GitHub Actions chạy phép thử; kết quả có trong tin nhắn và tab Nhật ký.
- Lần chạy đầu tháng: GitHub Actions ra quyết định tháng (lên ngôi, tối ưu tham số, đánh giá tháng).
- Quay lại version cũ: workflow `rollback` trên GitHub. Đề xuất phép thử: workflow `experiment`.
