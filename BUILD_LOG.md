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
