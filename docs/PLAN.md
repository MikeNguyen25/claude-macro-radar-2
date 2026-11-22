# macro-radar 2: kế hoạch G1 (chờ Mike duyệt)

Ngày lập: 22/11/2026. Repo: `MikeNguyen25/claude-macro-radar-2` (công khai). Bằng chứng nguồn: `data/probe.md` và `data/probe.json`, lần gọi thử 22/11/2026 lúc 09:28 UTC từ máy GitHub Actions: 98/109 probe thành công trong 29 giây.

## 0. Tóm tắt

- **Giá:** cả 14 tài sản đều có nguồn tự động với ít nhất 60 tháng lịch sử, nên cả 14 đều dự báo được. Lịch sử ngắn nhất là SOL, từ 04/2020 (79 tháng). Cập nhật giá không cần WebSearch.
- **Vĩ mô Mỹ:** FRED đủ, không cần khóa API, miễn là không giả làm trình duyệt (giả làm trình duyệt thì bị treo).
- **Vĩ mô Trung Quốc:** Eastmoney đủ, có lịch sử theo tháng từ 2006–2008.
- **Vĩ mô Việt Nam (chỗ yếu nhất):**
  - Tự động: VN-Index theo ngày từ 2000; tỷ giá, xuất nhập khẩu, dự trữ theo tháng từ IMF.
  - Phải đọc thông cáo: CPI, PMI, lãi suất, lợi suất trái phiếu 10 năm.
- **Kiến trúc:** job GitHub Actions ghi file JSON vào repo. Tác vụ 07:40 chạy engine bằng Node, ghi DB (sổ dự báo, điểm, trạng thái, `public/latest`) và đăng file dữ liệu kèm artifact. Trang đọc cả DB lẫn file.
- **Mô hình:** M0–M6 như spec. M1 (tần suất tăng lịch sử) là điểm chuẩn, và là nhà vô địch cho tới khi có ứng viên qua cửa.
- **Cần anh quyết:** 4 điểm ở mục 1.

## 1. Cần anh quyết

1. **Số liệu lớn để ở file đi kèm artifact, không để trong DB.** Spec 4.6 đặt `series` và `prices` trong DB. Tôi đề xuất:
   - Lịch sử giá, chuỗi vĩ mô và kết quả kiểm định nằm trong các file `data/*.json` đăng cùng artifact.
   - DB giữ sổ dự báo, điểm, mô hình, config, phép thử, nhận định AI, QA, version, `public/latest` và danh mục chuỗi (`series/catalog`).

   Lý do:
   - Mỗi lần ghi DB, nội dung phải đi qua ngữ cảnh của Claude. Mỗi doc đã có phải đọc lại để lấy version. Lịch sử khoảng 3 MB sẽ thành hàng trăm lệnh ghi, tốn và dễ lỗi.
   - `publish_files` đăng file từ đĩa, không đi qua ngữ cảnh.
   - Trang chỉ đọc được file của chính nó và DB, vì CSP chặn mọi host khác, kể cả GitHub.

   Đề xuất: đồng ý.
2. **CNBC làm nguồn chính** cho S&P 500, STI, SET, vàng, Brent và DXY. Đây là API không chính thức, có lịch sử ngày từ 1990 (STI từ 1999).
   - Đối chiếu: S&P 500 với FRED; DXY với chỉ số tự tính từ 6 tỷ giá ECB; Brent với giá giao ngay EIA qua FRED; vàng với PAXG trên Binance và XAU của currency-api.
   - STI và SET chưa có nguồn đối chiếu độc lập. G2 sẽ thử TradingView. Nếu không được, có hai cách: gắn nhãn "1 nguồn", hoặc anh lấy khóa Stooq miễn phí (nhập captcha một lần) rồi lưu vào GitHub Secrets.

   Đề xuất: đồng ý, thử TradingView trước.
3. **Định nghĩa tài sản:**
   - Vàng: giá giao ngay XAU/USD nếu CNBC có lịch sử `XAU=` (G2 kiểm tra); nếu không thì dùng hợp đồng tương lai COMEX kỳ hạn gần, nối các lần chuyển kỳ hạn.
   - Brent: hợp đồng tương lai ICE kỳ hạn gần, có số mới mỗi sáng.
   - Lợi suất 10 năm Mỹ: "tăng" nghĩa là lợi suất tăng; vùng giá tính bằng điểm cơ bản.
   - So hai nguồn khác loại (tương lai và giao ngay, USDT và USD): so biến động trong ngày (lệch ≤ 0,5 điểm %) và mức giá (lệch ≤ 3%), không áp ngưỡng 0,5% cho mức giá.
4. **Ngưỡng giảm sâu (`prob_tail`):** chọn sao cho sự kiện xảy ra khoảng 10–15% số tháng của mỗi nhóm. Ngưỡng tính ở G2 ngay khi nạp xong lịch sử, trước mọi kiểm định mô hình, rồi khóa lại trong config và versions. Đề xuất: đồng ý.

Để anh biết trước: hai tác vụ định kỳ cũ vẫn đang chạy, "Macro-radar review" lúc 23:13 và "Ý tưởng đầu tư táo bạo" lúc 01:42 (tác vụ này đọc DB của app cũ). Đến G6 tôi sẽ xin phép tắt tác vụ cũ và chuyển tác vụ "Ý tưởng" sang đọc `public/latest` mới.

## 2. Kiến trúc

```
GitHub Actions (repo công khai)
  prices-daily  00:17 UTC (07:17 VN), chạy lại 00:47 UTC nếu thiếu
  macro-daily   23:37 UTC (06:37 VN) và 11:37 UTC
  history       chạy tay khi thêm chuỗi
  probe         Chủ nhật, theo dõi sức khỏe nguồn
  ci            mỗi lần push: test, build, E2E, kiểm kích thước
        │ ghi data/*.json (mỗi điểm có source, url, ngày) và data/qa/
        ▼ raw.githubusercontent.com
Tác vụ định kỳ 07:40 VN (phiên mới, làm theo runbook)
  1. tải data/*.json; đọc vài doc DB cần thiết vào thư mục dump
  2. node tools/mrc.mjs --dump <dir> --today D [--optimize] [--experiments] [--monthly]
  3. Claude viết nhận định AI (M6) từ ai_context.json (< 30 KB)
  4. ghi DB (chỉ doc thay đổi); đăng file dữ liệu lên artifact (publish_files)
  5. gửi Mike tối đa 12 dòng
        ▼
Artifact "macro-radar 2" (riêng tư)
  index.html (< 300 KB, JS/CSS inline, không CDN)
  data/*.json (lịch sử, kiểm định, tóm tắt sổ dự báo)
  tools/ (mrc.mjs, engine.mjs, runbook ngày/tuần/tháng)
  capability: db, user (nút chỉ chủ sở hữu), sample (Phân tích AI), downloads (CSV)
```

- **Engine:** JS thuần, tất định, dùng chung cho trình duyệt và Node (`dist/tools/engine.mjs`). `build.mjs` đóng gói bằng esbuild. CI đỏ thì không publish.
- **Khi DB trả null** (người xem chưa đăng nhập, quá 10 giây): trang vẫn hiện số liệu từ file và ghi rõ phần nào thiếu.
- **Job giá trễ:** tác vụ 07:40 chờ tối đa 15 phút. Nếu vẫn chưa có giá phiên gần nhất, tác vụ chạy với số cũ và ghi rõ trong tin nhắn.
- **Cấu trúc repo** theo spec 4.1: `src/engine`, `src/ui`, `tests`, `tools`, `jobs`, `.github/workflows`, `build.mjs`.

## 3. Danh mục chuỗi và nguồn đã gọi thử

Ngày trong ngoặc là quan sát đầu tiên mà máy GitHub lấy được.

### 3.1 Giá 14 tài sản dự báo

| Tài sản | Nguồn chính | Đối chiếu | Ghi chú |
|---|---|---|---|
| BTC | Coin Metrics PriceUSD (07/2010) | Binance (08/2017), Kraken, CoinGecko | đóng cửa ngày UTC |
| ETH | Coin Metrics (G2 xác nhận ngày đầu) | Binance (08/2017), Kraken | |
| SOL | Coin Metrics (04/2020) | Binance (08/2020), Kraken | 79 tháng |
| DOGE | Coin Metrics (G2 xác nhận) | Binance (07/2019), Kraken | |
| TRX | Coin Metrics (06/2018) | Binance (06/2018), Kraken | |
| S&P 500 | CNBC .SPX (01/1990) | FRED SP500 (chỉ 10 năm) | |
| Nasdaq Composite | FRED NASDAQCOM (02/1971) | CNBC .IXIC | |
| STI | CNBC .STI (08/1999) | chưa có: thử TradingView | |
| SET | CNBC .SETI (01/1990) | chưa có: thử TradingView | set.or.th trả 403 |
| VN-Index | DNSE (07/2000, đủ từ ngày gốc) | VNDirect (08/2017) | |
| Vàng | CNBC (01/1990) | PAXG Binance (08/2020), currency-api XAU (03/2024) | LBMA trả 403 |
| Dầu Brent | CNBC @LCO.1 (10/1990) | FRED DCOILBRENTEU (05/1987, trễ ~5 ngày) | |
| USD/VND | CNBC VND= (giá hiện tại; G2 thử lịch sử), IMF ER theo tháng (1990, trễ ~3 tháng) | currency-api (03/2024), Vietcombank | |
| Lợi suất 10 năm Mỹ | FRED DGS10 (01/1962) | US Treasury CSV (từ 1990) | |

Hiển thị, không dự báo: VIX (Cboe CSV từ 1990, đối chiếu FRED) và DXY (CNBC từ 1990, đối chiếu chỉ số tính từ tỷ giá ECB từ 1999).

Không dùng được từ máy GitHub:
- Yahoo Finance: trả 429.
- Stooq: từ năm 2026 cần khóa.
- LBMA, set.or.th, IMF DataMapper: trả 403.
- API chính của Binance: chặn theo vùng, nên dùng data-api.binance.vision.
- CoinGecko: gói miễn phí chỉ có 365 ngày lịch sử.
- TCBS và trang giá của cafef: không trả dữ liệu.
- vnstock: đã gỡ khỏi PyPI.

### 3.2 Vĩ mô Mỹ (FRED, không cần khóa)

| Nhóm | Chuỗi (bắt đầu) |
|---|---|
| Tăng trưởng | GDP thực GDPC1 (quý, 1947); thất nghiệp UNRATE (1948); việc làm PAYEMS (1939); trợ cấp lần đầu ICSA (tuần, 1967); Philly Fed (1968); CFNAI (1967); OECD CLI Mỹ (1990) |
| Lạm phát | CPI CPIAUCSL (1947; **thiếu 10/2025** do chính phủ đóng cửa); PCE lõi (1959); lạm phát kỳ vọng 5 năm T5YIE (2003) |
| Chính sách, lợi suất | Fed DFF (1954); DGS2 (1976); DGS10 (1962); độ dốc 10−2 năm (1976) và 10 năm−3 tháng (1982) |
| Điều kiện tài chính | NFCI (tuần, 1971); VIX (1990) |
| Tín dụng | BAA10Y (1986) **thay cho chênh lệch lợi suất cao**: chuỗi ICE trên FRED chỉ còn 3 năm (từ 11/2023) |
| USD | DXY (CNBC); USD rộng DTWEXBGS (2006) |

ISM PMI: không có nguồn tự động hợp lệ. FRED gỡ dữ liệu ISM từ 2016, và ISM cấm phân phối lại. Thay vào đó dùng Philly Fed, CFNAI và OECD CLI. Số ISM chỉ hiển thị khi đọc từ thông cáo, không lưu vào repo công khai.

### 3.3 Trung Quốc

- Eastmoney: PMI sản xuất NBS (01/2008), CPI (2008), PPI (2006), M2 (2008), GDP quý (2006), sản xuất công nghiệp (02/2008), bán lẻ (2008), LPR 1 và 5 năm (theo ngày), lợi suất trái phiếu chính phủ 10 năm (theo ngày, khoảng 9.400 quan sát).
- FRED: USD/CNY DEXCHUS (theo ngày, 1981).
- BIS: lãi suất điều hành (01/1996).
- OECD: CLI Trung Quốc (05/1992).

### 3.4 Việt Nam

- **Tự động:**
  - VN-Index: DNSE, theo ngày từ 07/2000.
  - Tỷ giá USD/VND: IMF ER, theo tháng từ 1990 tới 08/2026.
  - Xuất và nhập khẩu: IMF ITG, theo tháng từ 2006 tới 07/2026.
  - Dự trữ ngoại hối: IMF IL, theo tháng từ 1995.
  - Sản xuất công nghiệp: IMF PI, theo tháng từ 2008, nhưng đã dừng ở 03/2025.
- **Đọc thông cáo** (2 nguồn khớp thì dùng, 1 nguồn thì gắn nhãn "1 nguồn"):
  - Cục Thống kê (nso.gov.vn), báo cáo đầu tháng sau: CPI, lạm phát cơ bản, sản xuất công nghiệp, xuất khẩu, GDP quý.
  - S&P Global: PMI.
  - Ngân hàng Nhà nước (sbv.gov.vn): lãi suất điều hành, lãi suất liên ngân hàng qua đêm, tỷ giá trung tâm.
  - worldgovernmentbonds.com: lợi suất trái phiếu chính phủ 10 năm. Trang HNX lỗi chứng chỉ SSL.
- **Khối ngoại HOSE:** cafef trả số theo từng mã, G2 sẽ cộng dồn theo ngày.
- **Hệ quả:** chuỗi Việt Nam chưa đủ 36 tháng tự động thì chỉ hiển thị, không vào mô hình (spec 4.2). VN-Index vẫn dự báo được; phần vĩ mô của nó dùng biến toàn cầu, Mỹ, Trung Quốc, cùng tỷ giá và xuất khẩu Việt Nam.

### 3.5 Thế giới

- PMI toàn cầu: không có nguồn miễn phí, dùng OECD CLI G20 (1990) thay thế.
- Lãi suất điều hành: ECB qua ECB API (theo ngày, 1999); Nhật, Mỹ, Trung Quốc, Thái Lan qua BIS (theo tháng).
- Dự báo tăng trưởng thế giới: lấy từ WEO trên cổng dữ liệu mới của IMF ở G2.

### 3.6 Độ trễ công bố (pubLagDays)

Mỗi chuỗi có `pubLagDays` theo lịch công bố chính thức. G2 xác minh từng chuỗi trước khi kiểm định, luôn làm tròn lên. Giá trị đề xuất:
- Mỹ: CPI 15 ngày, PCE 32, việc làm 9, GDP 32, ICSA 6, NFCI 6, chuỗi ngày của FRED 1.
- Trung Quốc: PMI 1, CPI và PPI 12.
- Việt Nam: CPI 7.
- IMF: ER 100, ITG 130.

Kiểm định theo số công bố lần đầu (ALFRED) cần khóa FRED API miễn phí. Việc này thuộc backlog mục 2, nên 2.0.0 chưa cần.

## 4. Lưu trữ

### 4.1 File (repo `data/`, đăng kèm artifact)

| File | Nội dung |
|---|---|
| `data/prices/<asset>.json` | mảng ngày, giá đóng cửa và mã nguồn từng điểm; nguồn đối chiếu; QA |
| `data/series/<id>.json` | chuỗi vĩ mô theo kỳ, kèm ngày công bố, nguồn, url, đơn vị, `pubLagDays` |
| `data/qa/<D>.json` | kết quả QA của job |
| `data/probe.json` | phản hồi của từng nguồn |
| artifact `data/bundle-*.json` | gói gọn cho trang: lịch sử giá, chuỗi, kiểm định, tóm tắt sổ dự báo |

### 4.2 DB (`schemaVersion: 1`, chỉ thêm trường mới, có migration chạy lại được)

| Doc | Nội dung |
|---|---|
| `config/current`, `config/v<N>` | tham số hiện hành và bản lưu từng version để quay lại |
| `models/registry` | champion, challenger, shadow, retired; ngày lên/xuống; lý do |
| `forecasts/<D>` | **bất biến**: mọi mô hình × tài sản × kỳ hạn, kèm hash SHA-256 nội dung |
| `scores/<D>`, `scores/summary` | điểm của dự báo vừa tới hạn; điểm cộng dồn và số khoảng không trùng nhau |
| `experiments/<id>` | giả thuyết, cấu hình, trạng thái (proposed, running, shadow, rejected, promoted), kết quả, lý do |
| `analyses/<D>` | nhận định AI theo cấu trúc JSON ở mục 4.5 của spec |
| `reviews/monthly-<YYYY-MM>`, `reviews/weekly-<YYYY-Www>` | đánh giá tháng, tuần |
| `qa/<D>`, `postmortems/<id>`, `versions/<semver>` | sự cố số liệu, dự báo trượt, nhật ký version |
| `series/catalog`, `meta/status` | danh mục chuỗi (nguồn, đơn vị, độ tươi); trạng thái lần chạy |
| `public/latest` | hợp đồng dữ liệu cho tác vụ khác, theo spec 4.6, kèm `fields` giải thích bằng tiếng Việt |

- Ước lượng: `forecasts/<D>` khoảng 15 KB, khoảng 5,5 MB mỗi năm.
- Đầu G2 tôi tạo một artifact riêng tư tạm để đo giới hạn DB bằng `db_usage`. Nếu sát giới hạn: chia doc theo tháng và chuyển phần lịch sử sang file.

## 5. Mô hình

**Khung:**
- Kiểm định trên mốc cuối mỗi tháng; dự báo trực tiếp mỗi ngày.
- Kỳ hạn 1 tháng = 30 ngày lịch, 3 tháng = 91 ngày.
- Biến mục tiêu:
  - Tăng: lợi suất log > 0. Riêng lợi suất 10 năm Mỹ, tăng là mức lợi suất tăng.
  - Phân vị q10, q50, q90 của lợi suất log, quy ra vùng giá.
  - Giảm sâu: lợi suất < −k của nhóm.

| Mô hình | Nội dung | Số tham số mỗi nhóm |
|---|---|---|
| M0 | tung đồng xu, 50% | 0 |
| M1 | tần suất tăng của chính tài sản (cửa sổ mở rộng), co về tỷ lệ của nhóm: p = (k + a·p_nhóm)/(n + a), a = 12 tháng cố định | 0 học |
| M2 | xu hướng: lợi suất 1, 3, 12 tháng và giá so với trung bình 10 tháng; logistic ridge, hệ số chung trong nhóm | 5 |
| M3 | vĩ mô gọn: 6 điểm tổng hợp chuẩn hóa (tăng trưởng, lạm phát, chính sách, điều kiện tài chính, tín dụng, USD) theo vùng; logistic ridge; học cuốn chiếu | ≤ 6 |
| M4 | chế độ rủi ro: VIX, NFCI, độ dốc lợi suất, BAA10Y, biến động thực; dùng cho `prob_tail` và độ rộng vùng giá | ≤ 5 |
| M5 | tổ hợp: trọng số theo log score ngoài mẫu, co về M1 (M1 chiếm ít nhất 50% lúc đầu) | 1–2 |
| M6 | AI: xác suất Claude đưa ra, lệch tối đa 10 điểm % so với nhà vô địch, kèm 2–4 dữ kiện có số và ngày | không |

- **Hiệu chỉnh chung:** Platt cuốn chiếu, cần tối thiểu 36 tháng ngoài mẫu; chưa đủ thì co về tần suất lịch sử. Xác suất kỳ 1 tháng giới hạn trong 5–95%.
- **Vùng giá:** độ biến động EWMA (λ = 0,94 theo ngày) nhân √H, phân phối Student-t với ν = 5, hoặc bootstrap phần dư chuẩn hóa nếu kiểm định cho kết quả tốt hơn. Độ phủ kiểm riêng cho crypto và cổ phiếu.
- **Kịch bản vĩ mô:**
  - Mỗi vùng (Mỹ, Trung Quốc, Việt Nam, thế giới) có điểm tăng trưởng và lạm phát, xếp vào góc phần tư.
  - Chế độ rủi ro bật hay tắt.
  - Đo dịch chuyển so với 3 tháng trước.
  - Kịch bản chỉ thành biến của mô hình khi qua kiểm định.
- **Kỷ luật độ phức tạp:** số tham số ≤ số tháng độc lập / 20. Ví dụ:
  - Crypto, nếu chỉ dùng số liệu từ 2017: khoảng 110 tháng, tối đa 5 tham số.
  - VN-Index từ 2000: khoảng 315 tháng, tối đa 15.
  - Mô hình dùng vĩ mô Trung Quốc hay Việt Nam chỉ có số từ 2008: khoảng 215 tháng, tối đa 10.
- **Nhà vô địch đầu tiên (G4):** p_better ≥ 0,95 so với M1 và tốt hơn ở cả hai nửa giai đoạn. Nếu không ứng viên nào qua, M1 làm nhà vô địch, app ghi rõ. Các ứng viên còn lại chạy shadow ngay từ đầu.

## 6. Kiểm định và chấm điểm

- **Cuốn chiếu**, cửa sổ mở rộng, tôn trọng `pubLagDays`; chừa khoảng trống h tháng giữa học và kiểm.
- **Bootstrap** khối theo tháng, độ dài khối h, 2.000 lần lặp, seed cố định. Diebold–Mariano với sai số HAC Newey–West, độ trễ h−1.
- **Chia giai đoạn:**
  - Tập kiểm tra: 24 mốc tháng cuối cùng đã có kết quả.
  - Hai nửa: chia đôi toàn bộ giai đoạn ngoài mẫu.
- **Thước đo:**
  - Chính: Brier, log score, BSS so với M1.
  - Phụ: ECE 10 nhóm, độ nét, độ phủ vùng 80%, pinball loss, tỷ lệ đúng hướng, IC Spearman.
  - Báo cáo theo nhóm, theo tài sản và theo chế độ thị trường.
- **Sổ dự báo trực tiếp:**
  - Đếm số khoảng không trùng nhau; dưới 6 khoảng thì chỉ ghi nhận, không kết luận.
  - Điểm tạm sau 7 ngày: P₇ = Φ(Φ⁻¹(P)·√(7/H)).
- **Nhật ký phép thử:**
  - Ghi mọi cấu hình đã thử, kể cả bị loại.
  - Cửa lên ngôi: p_better ≥ 0,90 khi dưới 20 phép thử, ≥ 0,95 khi từ 20 phép thử trở lên.

## 7. Kế hoạch test (CI chạy mỗi lần push)

| Loại | Nội dung |
|---|---|
| Unit | Brier, log score, BSS, ECE, pinball, bootstrap khối, DM, Platt, phân vị, P₇; so với giá trị tính tay |
| Tổng hợp | chuỗi ngẫu nhiên → khoảng 95% của BSS chứa 0 và không mô hình nào qua cửa; chuỗi cài tín hiệu → mô hình phù hợp tìm ra và qua cửa |
| Chống nhìn trước | chèn số tương lai vào tập học → engine báo lỗi (mỗi giá trị đặc trưng kèm ngày công bố ≤ T) |
| Tái lập | cùng dữ liệu và seed → kết quả JSON trùng từng byte (so hash) |
| Dữ liệu | QA bắt được số nhảy (\|z\| > 6), số cũ, sai đơn vị, ngày tương lai, ngày trùng, hai nguồn lệch |
| Hồi quy | ảnh chụp số liệu kiểm định trên bộ dữ liệu mẫu; đổi giao diện không làm đổi kết quả |
| E2E (Playwright) | trang tải không lỗi console, cả 8 tab có nội dung, chạy được khi db/sample trả null; ảnh chụp 390 px và 1280 px |
| Ngân sách | index.html < 300 KB; kiểm định đầy đủ < 10 giây trong Node; tab Tổng quan vẽ < 200 ms |

## 8. Rủi ro và cách lui

| Rủi ro | Cách lui |
|---|---|
| CNBC đổi hoặc chặn API | lịch sử đã lưu trong repo nên không mất; số mới lấy từ FRED (S&P, Nasdaq, Brent), Binance PAXG (vàng), ECB (DXY), Stooq (nếu có khóa) |
| FRED chặn máy GitHub | khóa FRED API miễn phí (anh đăng ký, lưu vào GitHub Secrets) |
| Coin Metrics đổi gói (đã thuộc Talos) | Binance data-api, Kraken |
| Nguồn Việt Nam thiếu hoặc lệch | chỉ hiển thị, nhãn "1 nguồn", không vào mô hình |
| Cron GitHub trễ | chạy lại lúc 00:47 UTC; tác vụ chờ tối đa 15 phút rồi chạy với số cũ và báo rõ |
| Giới hạn DB | chia doc theo tháng; chuyển thêm sang file |
| Mẫu nhỏ, không có kỹ năng | app ghi "Chưa đủ cơ sở"; M1 làm nhà vô địch (kết quả trung thực, chấp nhận được) |
| Tác vụ hằng ngày tốn hoặc chậm | runner làm hết phần tính; Claude chỉ đọc tóm tắt < 30 KB; tách tác vụ nếu một lần chạy quá 30 phút |
| Thay đổi làm xấu dự báo | mọi thay đổi config hay mô hình đều có version; `node tools/mrc.mjs --rollback <version>` quay lại bằng một lệnh |

## 9. Lộ trình

| Giai đoạn | Việc chính | Ước tính |
|---|---|---|
| G2 Số liệu | job prices-daily, macro-daily, history; schema file; QA; nạp lịch sử; xác minh `pubLagDays`; khóa ngưỡng giảm sâu; artifact tạm để đo DB | 1–2 phiên |
| G3 Engine và đo lường | đặc trưng, kịch bản, M0–M1, kiểm định, chấm điểm, sổ dự báo, experiments; test tổng hợp xanh | 2 phiên |
| G4 Mô hình | M2–M5; chọn nhà vô địch đầu tiên; shadow | 1–2 phiên |
| G5 Giao diện và AI | 8 tab, Phân tích AI, E2E, publish riêng tư | 2 phiên |
| G6 Chạy thử | runbook, prompt tác vụ (xin phép trước khi tạo), ≥ 3 ngày liên tiếp không lỗi | ≥ 3 ngày |
| G7 Phát hành 2.0.0 | versions/2.0.0, changelog, gửi link, prompt và mô tả `public/latest` | 1 phiên |

App là công cụ tham khảo, không khuyến nghị mua bán.
