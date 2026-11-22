# BUILD_LOG: macro-radar 2

Mỗi giai đoạn ghi: đã làm, số trước và sau, bằng chứng, việc còn lại.

## G0 Khám phá (22/11/2026), xong

### Công cụ có trong phiên

- **Artifact** (runtime contract 0.2.98):
  - Có capability `db`, `user`, `sample`, `downloads` (và artifact, assets, comments, mcp, room, tts).
  - Trang chạy dưới CSP: không gọi được host khác, chỉ đọc được file của chính artifact và DB.
  - Tải file phải qua `downloads`.
  - `sample` chọn mô hình theo `modelTier` (quick, default, complex).
  - Giới hạn DB chỉ đo được (`db_usage`) sau khi có trang khai báo db, nên để sang G2.
  - `db_write` ghi tối đa 50 doc mỗi lệnh; mỗi doc đã có cần `ifVersion`.
- **Workspace:**
  - Có Python 3.13, Node 22, npm 10.9, Playwright 1.63.
  - Shell chỉ ra được GitHub, PyPI, npm; mọi host số liệu khác bị chặn.
  - WebFetch chỉ mở được link xuất hiện trong kết quả WebSearch, nên không gọi thẳng được API.
  - Kết luận: mọi lệnh gọi số liệu đặt trong GitHub Actions, đúng như spec.
- **GitHub:**
  - Phiên không tạo được repo mới (API bị giới hạn theo repo được gắn), nên Mike tự tạo `claude-macro-radar-2` (công khai).
  - Lúc đầu push bị từ chối; sau khi Mike cấp quyền cho ứng dụng Claude trên GitHub, push và file workflow đều đẩy được.
  - `gh api` gọi được trong phạm vi repo; đọc được log của job.
- **Tác vụ định kỳ:**
  - Tạo được bằng `create_trigger`.
  - Đang có 2 tác vụ cũ: "Macro-radar review" (23:13, app cũ) và "Ý tưởng đầu tư táo bạo" (01:42, đọc DB app cũ).
- **Nhắn Mike:** `SendUserMessage`; tác vụ định kỳ có thông báo đẩy về điện thoại.

### Câu trả lời của Mike

- Một repo công khai.
- Tác vụ chạy lúc 07:40.
- Giữ trang Solana, làm sau khi lõi ổn định.

### Gọi thử nguồn

Script `jobs/probe.py` và workflow `.github/workflows/probe.yml`; kết quả ở `data/probe.json` và `data/probe.md`.

| Lần chạy | Kết quả | Ghi chú |
|---|---|---|
| 1 | hủy sau 12 phút | FRED và Coin Metrics treo tới hết 30 giây mỗi request; Yahoo trả 429; vnstock không còn trên PyPI. Đọc từ log. |
| 2 | 93/101 OK trong 35 giây | Thêm giới hạn thời gian tổng cho mỗi request (45 giây), hạn chót 13 phút, luôn commit kết quả. FRED thử 3 user-agent; thêm Binance data-api, CNBC, ECB EXR, EIA, Pink Sheet, Eastmoney. |
| 3 | 99/108 OK | Thêm IMF SDMX cho Việt Nam, LPR. |
| 4 (cuối) | 98/109 OK trong 29 giây | IMF đọc cấu trúc gọn, thêm IL. |

Số trước và sau: nguồn đã kiểm chứng gọi được từ máy GitHub tăng từ 0 lên 98/109 probe.

### Phát hiện chính

Chi tiết và danh mục chuỗi ở `docs/PLAN.md`, mục 3.

- **FRED** gọi được khi user-agent là curl hoặc tên bot; giả làm trình duyệt thì bị treo.
  - Tham số `vintage_date` của fredgraph không có tác dụng, nên kiểm định theo số công bố lần đầu cần khóa FRED API.
  - CPI Mỹ thiếu tháng 10/2025.
  - Chuỗi chênh lệch lợi suất cao (ICE) chỉ còn từ 11/2023.
  - ISM không có trên FRED.
- **Giá:**
  - Cả 14 tài sản có ít nhất 60 tháng từ nguồn tự động.
  - Nguồn tốt: CNBC (lịch sử ngày cho S&P 500, STI, SET, vàng, Brent, DXY), DNSE (VN-Index từ 07/2000), Coin Metrics và Binance data-api (crypto), Treasury, Cboe, ECB.
  - Không dùng được: Yahoo (429), Stooq (cần khóa), LBMA, set.or.th và IMF DataMapper (403).
- **Trung Quốc:** Eastmoney đủ PMI, CPI, PPI, M2, GDP, sản xuất, bán lẻ, LPR, lợi suất 10 năm.
- **Việt Nam:**
  - Tự động: IMF có tỷ giá, xuất nhập khẩu và dự trữ theo tháng; sản xuất công nghiệp dừng ở 03/2025.
  - IMF không có lãi suất Việt Nam.
  - CPI qua IMF lỗi vì cấu trúc quá lớn; G2 thử lại.
  - World Bank GEM qua API chỉ có số theo năm.

### Tự review diff

- **Đã sửa:**
  - Ở lần chạy đầu, Coin Metrics trả điểm cuối thay cho điểm đầu: mặc định `paging_from` là `end`.
  - Ở lần 3, khóa `series` trong kết quả IMF ghi đè mô tả probe.
  - Bỏ vnstock.
  - Cài akshare riêng để lỗi của một thư viện không làm hỏng thư viện khác.
- **Còn lại** (chấp nhận được cho script khảo sát):
  - `http_get` gán `resp._content` sau khi stream; có ghi chú trong code.
  - Probe thư viện akshare chỉ để ghi nhận; G2 sẽ bỏ vì đã gọi thẳng Eastmoney.

### Việc tiếp theo

G1: kế hoạch ở `docs/PLAN.md`, chờ Mike duyệt.

## G1 Kế hoạch (22/11/2026), xong

Kế hoạch ở `docs/PLAN.md` (bản sao trong Project). Mike cho chạy tiếp các giai đoạn không cần dừng duyệt.

## G2 Số liệu (22/11/2026), xong

- `jobs/update.py`: 16 chuỗi giá (14 tài sản, VIX, DXY), 39 chuỗi vĩ mô, đối chiếu nguồn thứ hai, cách ly điểm nhảy
  |z| ≥ 6, QA (`data/qa/`), nhật ký sửa số (`data/revisions/`). Ghi file chỉ khi nội dung đổi; không xóa điểm cũ.
- Workflow `prices-daily` (07:09, 07:29, 07:52), `macro-daily` (06:37, 18:37), `history` (chạy tay hoặc khi sửa job).
- Ngưỡng đối chiếu Brent 12% vì nguồn chính là hợp đồng tương lai còn FRED là giá giao ngay (trung vị lệch 1,3%, p95 5,5%, tối đa 9,6%).
- Mọi tài sản có ít nhất 60 tháng; SOL từ 10/04/2020. Còn thiếu: CPI, PMI, lãi suất Việt Nam (nhập tay, chỉ hiển thị).

## G3 Engine (22/11/2026), xong

- `src/engine/`: JS thuần, tất định, dùng chung Node và trình duyệt. M0–M5, hiệu chỉnh Platt, vùng 80% (EWMA, Student-t,
  hệ số độ phủ), xác suất giảm sâu với ngưỡng khóa trước, bootstrap khối cho p_better và khoảng tin cậy BSS, Diebold–Mariano.
- Nhà vô địch: p_better ≥ 0,95, tốt hơn M1 ở cả hai nửa giai đoạn của chính nhóm, không kém ở 24 tháng kiểm tra cuối.
- Kiểm định 07/2001–09/2026 (303 tháng), chạy 1,3 giây trên máy GitHub, 2,2 giây ở đây.

| Kỳ | Nhóm | Dẫn | BSS | ECE | Độ phủ 80% | Ứng viên tốt nhất |
|---|---|---|---|---|---|---|
| 1 tháng | Cổ phiếu Mỹ | M1 | 0 | 8,5% | 81,8% | M5 +1,0%, p 0,82 |
| 1 tháng | Đông Nam Á | M1 | 0 | 1,9% | 80,0% | M5 −0,1% |
| 1 tháng | Hàng hóa, tỷ giá, lợi suất | M1 | 0 | 5,7% | 80,1% | M5 +2,0%, p 1,00 (trượt cửa hai nửa hoặc tập kiểm tra) |
| 1 tháng | Việt Nam | M1 | 0 | 8,7% | 79,8% | M2 +3,6%, p 0,945 |
| 1 tháng | Crypto | M1 | 0 | 3,3% | 81,7% | M3 +0,2% |
| 3 tháng | Hàng hóa, tỷ giá, lợi suất | **M5** | **+3,3%**, p 0,994 | 5,2% | 78,9% | |
| 3 tháng | các nhóm khác | M1 | 0 | 7,5–13,6% | 78,8–82,4% | tốt nhất M5 cổ phiếu Mỹ +2,6%, p 0,87 |

- Đạt: độ phủ vùng 80% trong 75–85% ở cả 10 nhóm × kỳ hạn; có một nhóm thắng M1 với p_better ≥ 0,9.
- Chưa đạt: ECE ≤ 3 điểm % chỉ đạt ở Đông Nam Á 1 tháng. ECE lớn là của chính M1 (tần suất lịch sử lệch khi chế độ thị trường đổi).
- IC chéo tài sản quanh 0 hoặc âm: chưa xếp hạng được tài sản.
- Kiểm thử chống nhìn trước tìm ra một rò rỉ: khoảng cách tới trung bình 10 tháng tính cả tháng đang dở khi số liệu dừng giữa
  tháng. Đã sửa: chỉ tính các tháng đã khép.

## G4 Sổ dự báo và tự cải thiện (22/11/2026), xong

- Đổi so với kế hoạch: phần tất định chạy trên GitHub Actions (`node tools/mrc.mjs daily`), trạng thái nằm trong `state/` của repo.
  Lý do: nếu tác vụ Claude giữ trạng thái trong DB, mỗi sáng phải đọc rồi chép lại 50–80 KB JSON, dễ sai số và tốn kém; lịch sử
  git còn là dấu thời gian công khai cho sổ dự báo. Tác vụ 07:40 chỉ thêm lớp AI và ghi 4 doc DB nhỏ (khoảng 22 KB).
- Hằng ngày: sổ dự báo bất biến có hash, chấm dự báo tới hạn theo từng kỳ hạn, điểm tạm 7 ngày, postmortem, hạ ngôi.
  Chủ nhật: tối đa 3 phép thử. Đầu tháng: lên ngôi, tối ưu tham số an toàn, giả thuyết từ postmortem, đánh giá tháng.
- Mỗi thay đổi tăng version (patch hoặc minor) kèm ảnh chụp cấu hình; quay lại bằng workflow `rollback`, đề xuất phép thử bằng `experiment`.
- Mô phỏng 01/08–01/11/2026 trên số liệu thật: chấm 1 tháng, 3 tháng và tạm 7 ngày đúng hạn; quyết định tháng chạy 35 giây.
- Lần chạy thật đầu tiên 22/11/2026: 28 dự báo, hash `a1c854ba…`, 3 phép thử Chủ nhật đều trượt.

## G5 Trang (22/11/2026), xong

- 8 tab tiếng Việt, đóng gói một file `index.html` 99 KB (giới hạn 300 KB) cùng `sandbox-worker.js` 29 KB.
- Số liệu tách `data/bundle.json` (197 KB, nạp trước) và `data/history.json` (424 KB, nạp khi cần); `data/raw.json` (5,3 MB) chỉ
  cho bàn thử cấu hình của chủ sở hữu.
- Capability: db (chỉ chủ sở hữu ghi), user, downloads, sample (nhận định AI chạy tay).
- Kiểm hash sổ dự báo ngay trong trình duyệt; tải CSV qua downloads, không có thì sao chép.

## G6 Kiểm thử, đăng, tác vụ định kỳ (22/11/2026), xong

- 17 kiểm thử Node: tiện ích, nhiễu không lên ngôi, tín hiệu cài sẵn được tìm ra (BSS > 1%, p_better ≥ 0,95), chống nhìn trước
  (ném LookaheadError; cắt số liệu sau T không đổi đặc trưng và điểm vĩ mô tại T), tất định, sổ dự báo, runner.
- E2E Chrome 390 px và 1280 px: 8 trang, không lỗi console, không cuộn ngang, biểu đồ hiện, kiểm hash khớp; tổng quan hiện dưới 2 giây.
- CI (`ci.yml`): kiểm thử, đóng gói, E2E, ảnh chụp màn hình; xanh trên GitHub.
- Artifact "macro-radar 2": https://claude.ai/artifact/CKQ3aPT6sCrKFGACFpngmn (slug 5ba61d5f-a472-4ee1-91f2-614f32dfd699).
  DB có `analyses/2026-11-22` (hash `7db7ad2d…`), `scores/ai`, `public/latest`, `meta/status`.
- Tác vụ "macro-radar 2 · sáng 07:40" (trig_01Lr5o2wGQ6cTHitCgBy733C), tự duyệt, thông báo đẩy.
- Rủi ro đã biết: cron của GitHub ở repo mới có thể trễ nhiều giờ hoặc không chạy; chưa có lần chạy theo lịch nào tính tới 13:45 UTC 22/11.

## G6b Sửa đường đăng của tác vụ tự động (22/11/2026, tối)

- Tự kiểm 2 trong phiên tự động cho thấy: phiên chỉ có công cụ Artifact và ArtifactData (không có publish_files, db_write);
  Artifact publish bắt buộc `file_path` là file trang và trước đó phải Read hết trang; `gh workflow run` bị chặn (GraphQL),
  nhưng công cụ GitHub `actions_run_trigger` chạy được job.
- Lần chạy job theo lệnh hôm 22/11 đỏ vì `write_if_changed` gặp nhật ký sửa số dạng danh sách (`update.py`). Đã sửa (d399020);
  lần chạy lại xanh toàn bộ.
- Trang tách thành `index.html` khoảng 1 KB, `app.js`, `app.css` (bản đóng gói lưu trong `web/`), nên mỗi sáng chỉ phải đọc
  khoảng 20 dòng trước khi đăng. Đã đăng lên artifact (version 1795360561-119d), cùng `analyses/2026-11-22.json` và `data/ai_scores.json`.
- `mrc ai` in sẵn map file đăng (đường dẫn tuyệt đối) và `db_writes.json` cho ArtifactData (mỗi doc gửi bằng `file_path`), nên số
  liệu không đi qua ngữ cảnh; M6 tới hạn được chấm từ file đã đăng sau khi kiểm hash.
- Runbook và prompt tác vụ 07:40 đổi theo các công cụ trên; dự báo hôm nay chưa có thì tác vụ tự chạy job `prices-daily`.
