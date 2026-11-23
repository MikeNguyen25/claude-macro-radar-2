# Kết quả gọi thử nguồn số liệu

Chạy lúc 2026-11-23T02:48:47Z trên Linux trong 85 giây; thành công 98/109 probe. Chi tiết đầy đủ trong `probe.json`.

| id | chuỗi | nguồn | kết quả | HTTP | từ | đến | n | tần suất | cũ (ngày) | ghi chú |
|---|---|---|---|---|---|---|---|---|---|---|
| meta.fred_ua_curl | fredgraph.csv với UA curl | FRED | OK | 200 | 1948-01-01 | 2026-10-01 | 945 | M | 53 |  |
| meta.fred_ua_bot | fredgraph.csv với UA bot | FRED | OK | 200 | 1948-01-01 | 2026-10-01 | 945 | M | 53 |  |
| meta.fred_ua_browser | fredgraph.csv với UA browser | FRED | LỖI |  |  |  |  |  |  | ReadTimeout: HTTPSConnectionPool(host='fred.stlouisfed.org', port=443): Read timed out. (r |
| us.gdp_real | GDP thực Mỹ | FRED GDPC1 | OK | 200 | 1947-01-01 | 2026-07-01 | 319 | Q | 145 |  |
| us.unrate | Thất nghiệp Mỹ | FRED UNRATE | OK | 200 | 1948-01-01 | 2026-10-01 | 945 | M | 53 |  |
| us.payems | Việc làm phi nông nghiệp | FRED PAYEMS | OK | 200 | 1939-01-01 | 2026-10-01 | 1054 | M | 53 |  |
| us.icsa | Đơn trợ cấp thất nghiệp lần đầu | FRED ICSA | OK | 200 | 1967-01-07 | 2026-11-14 | 3124 | W | 9 |  |
| us.cpi | CPI Mỹ | FRED CPIAUCSL | OK | 200 | 1947-01-01 | 2026-10-01 | 957 | M | 53 |  |
| us.core_pce | PCE lõi | FRED PCEPILFE | OK | 200 | 1959-01-01 | 2026-09-01 | 813 | M | 83 |  |
| us.be5y | Lạm phát kỳ vọng 5 năm | FRED T5YIE | OK | 200 | 2003-01-02 | 2026-11-20 | 5976 | D | 3 |  |
| us.dff | Lãi suất Fed (ngày) | FRED DFF | OK | 200 | 1954-07-01 | 2026-11-19 | 26440 | D | 4 |  |
| us.dgs2 | Lợi suất 2 năm | FRED DGS2 | OK | 200 | 1976-06-01 | 2026-11-19 | 12614 | D | 4 |  |
| us.dgs10 | Lợi suất 10 năm | FRED DGS10 | OK | 200 | 1962-01-02 | 2026-11-19 | 16206 | D | 4 |  |
| us.t10y2y | Độ dốc 10 năm − 2 năm | FRED T10Y2Y | OK | 200 | 1976-06-01 | 2026-11-20 | 12615 | D | 3 |  |
| us.t10y3m | Độ dốc 10 năm − 3 tháng | FRED T10Y3M | OK | 200 | 1982-01-04 | 2026-11-20 | 11224 | D | 3 |  |
| us.nfci | Chỉ số điều kiện tài chính NFCI | FRED NFCI | OK | 200 | 1971-01-08 | 2026-11-13 | 2915 | W | 10 |  |
| us.hy_oas | Chênh lệch tín dụng lợi suất cao (ICE) | FRED BAMLH0A0HYM2 | OK | 200 | 2023-11-21 | 2026-11-19 | 786 | D | 4 |  |
| us.baa10y | Chênh lệch Baa − 10 năm (Moody's) | FRED BAA10Y | OK | 200 | 1986-01-02 | 2026-11-19 | 10221 | D | 4 |  |
| us.usd_broad | Chỉ số USD rộng (Fed) | FRED DTWEXBGS | OK | 200 | 2006-01-02 | 2026-11-13 | 5231 | D | 10 |  |
| us.pmi_philly | Khảo sát sản xuất Philadelphia Fed | FRED GACDFSA066MSFRBPHI | OK | 200 | 1968-05-01 | 2026-11-01 | 703 | M | 22 |  |
| us.cfnai | Chỉ số hoạt động Chicago Fed | FRED CFNAI | OK | 200 | 1967-03-01 | 2026-09-01 | 715 | M | 83 |  |
| us.bci_oecd | Niềm tin kinh doanh Mỹ (OECD) | FRED BSCICP03USM665S | OK | 200 | 1950-01-01 | 2024-01-01 | 889 | M | 1057 |  |
| px.nasdaq_fred | Nasdaq Composite (FRED) | FRED NASDAQCOM | OK | 200 | 1971-02-05 | 2026-11-19 | 14067 | D | 4 |  |
| px.spx_fred | S&P 500 (FRED, 10 năm) | FRED SP500 | OK | 200 | 2016-11-21 | 2026-11-19 | 2513 | D | 4 |  |
| px.brent_fred | Dầu Brent (EIA qua FRED) | FRED DCOILBRENTEU | OK | 200 | 1987-05-20 | 2026-11-17 | 9132 | D | 6 |  |
| cn.usdcny_fred | USD/CNY (Fed H.10) | FRED DEXCHUS | OK | 200 | 1981-01-02 | 2026-11-13 | 11449 | D | 10 |  |
| cn.cpi_oecd_fred | CPI Trung Quốc (OECD qua FRED) | FRED CHNCPIALLMINMEI | OK | 200 | 1993-01-01 | 2025-04-01 | 388 | M | 601 |  |
| world.jp_call_fred | Lãi suất qua đêm Nhật (OECD) | FRED IRSTCI01JPM156N | OK | 200 | 1985-07-01 | 2026-10-01 | 496 | M | 53 |  |
| us.fred_vintage | PAYEMS theo vintage 2020-02-10 | FRED vintage | OK | 200 |  |  |  |  |  |  |
| meta.fred_api_nokey | FRED API không khóa (kiểm tra máy chủ) | FRED API | OK | 400 |  |  |  |  |  | mã 400 = API trả lời, chỉ thiếu api_key |
| px.btc_binance | BTC nến ngày UTC | Binance data-api.binance.vision | OK | 200 | 2017-08-17 | 2026-11-22 | 3385 | D | 1 | nến ngày UTC; n = số ngày |
| px.eth_binance | ETH nến ngày UTC | Binance data-api.binance.vision | OK | 200 | 2017-08-17 | 2026-11-22 | 3385 | D | 1 | nến ngày UTC; n = số ngày |
| px.sol_binance | SOL nến ngày UTC | Binance data-api.binance.vision | OK | 200 | 2020-08-11 | 2026-11-22 | 2295 | D | 1 | nến ngày UTC; n = số ngày |
| px.doge_binance | DOGE nến ngày UTC | Binance data-api.binance.vision | OK | 200 | 2019-07-05 | 2026-11-22 | 2698 | D | 1 | nến ngày UTC; n = số ngày |
| px.trx_binance | TRX nến ngày UTC | Binance data-api.binance.vision | OK | 200 | 2018-06-11 | 2026-11-22 | 3087 | D | 1 | nến ngày UTC; n = số ngày |
| px.paxg_binance | PAXG (token vàng) nến ngày UTC | Binance data-api.binance.vision | OK | 200 | 2020-08-28 | 2026-11-22 | 2278 | D | 1 | nến ngày UTC; n = số ngày |
| px.btc_cm | BTC đóng cửa ngày UTC | Coin Metrics community | OK | 200 | 2010-07-18 | 2026-11-22 | 5972 | D | 1 | n = số ngày từ đầu tới cuối |
| px.sol_cm | SOL đóng cửa ngày UTC | Coin Metrics community | OK | 200 | 2020-04-10 | 2026-11-22 | 2418 | D | 1 | n = số ngày từ đầu tới cuối |
| px.trx_cm | TRX đóng cửa ngày UTC | Coin Metrics community | OK | 200 | 2018-06-25 | 2026-11-22 | 3073 | D | 1 | n = số ngày từ đầu tới cuối |
| px.btc_kraken | BTC/USD nến ngày | Kraken | OK | 200 | 2024-12-03 | 2026-11-23 | 721 | D | 0 | chỉ 720 nến gần nhất; nến cuối là ngày đang chạy |
| px.crypto_cg_simple | Giá hiện tại 5 coin | CoinGecko keyless | OK | 200 |  | 2026-11-23 |  |  |  |  |
| px.spx_yahoo | S&P 500 theo tháng | Yahoo ^GSPC | LỖI | 429 |  |  |  |  |  | Yahoo lỗi: Too Many Requests |
| px.spx_stooq | S&P 500 theo tháng | Stooq | LỖI | 200 |  |  |  |  |  | Stooq không trả CSV (cần apikey) |
| px.cnbc_quote | Giá hiện tại STI, SET, SPX, Nasdaq, DXY, Brent, vàng, VND, UST10Y | CNBC quote | OK | 200 |  |  |  |  |  | chỉ có giá hiện tại |
| px.cnbc_bars_sti | STI ngày | CNBC bars .STI | OK | 200 | 1999-08-31 | 2026-11-20 | 6864 | D | 3 |  |
| px.cnbc_bars_seti | SET ngày | CNBC bars .SETI | OK | 200 | 1990-01-02 | 2026-11-20 | 9012 | D | 3 |  |
| px.cnbc_bars_spx | S&P 500 ngày | CNBC bars .SPX | OK | 200 | 1990-01-02 | 2026-11-20 | 9292 | D | 3 |  |
| px.cnbc_bars_lco_1 | Brent ngày | CNBC bars @LCO.1 | OK | 200 | 1990-10-09 | 2026-11-20 | 9234 | D | 3 |  |
| px.cnbc_bars_gc_1 | Vàng ngày | CNBC bars @GC.1 | OK | 200 | 1990-01-02 | 2026-11-20 | 9303 | D | 3 |  |
| px.cnbc_bars_dxy | DXY ngày | CNBC bars .DXY | OK | 200 | 1990-01-01 | 2026-11-22 | 9693 | D | 1 |  |
| px.vnindex_dnse | VN-Index ngày | DNSE (Entrade) | OK | 200 | 2000-07-28 | 2026-11-20 | 6369 | D | 3 |  |
| px.vnindex_vndirect | VN-Index ngày | VNDirect dchart | OK | 200 | 2017-08-24 | 2026-11-23 | 2308 | D | 0 |  |
| vn.foreign_cafef | Khối ngoại mua bán ròng | cafef | OK | 200 | 2026-11-20 | 2026-11-20 | 99574 |  | 3 |  |
| px.set_setweb | SET 1 năm | set.or.th API | LỖI | 403 |  |  |  |  |  | set.or.th API lỗi |
| px.commodity_pink | Vàng, Brent theo tháng | World Bank Pink Sheet | OK | 200 | 1960-01-01 | 2024-12-01 |  | M |  |  |
| px.brent_eia | Brent ngày | EIA .xls | OK | 200 |  |  |  |  |  | Brent ngày từ EIA (file .xls, cần xlrd để đọc) |
| px.gold_lbma_pm | Vàng LBMA PM (USD) | LBMA | LỖI | 403 |  |  |  |  |  | LBMA không trả JSON |
| px.gold_fawaz | Vàng (XAU) mới nhất | fawazahmed0 currency-api | OK | 200 |  | 2026-11-22 |  |  |  | 1 USD đổi ra ounce vàng |
| px.gold_fawaz_2024 | Vàng (XAU) ngày 2024-03-06 | fawazahmed0 currency-api | OK | 200 |  | 2024-03-06 |  |  |  | 1 USD đổi ra ounce vàng |
| px.usdvnd_vcb | USD/VND Vietcombank | Vietcombank XML | OK | 200 |  | 11/23/2026 9:43:43 AM |  |  |  | chỉ có tỷ giá hiện tại |
| px.usdvnd_erapi | USD/VND | open.er-api.com | OK | 200 |  | Mon, 23 Nov 2026 00:02:32 +0000 |  |  |  | chỉ có tỷ giá mới nhất |
| px.usdvnd_fawaz | USD/VND mới nhất | fawazahmed0 currency-api | OK | 200 |  | 2026-11-22 |  |  |  | 1 USD đổi ra VND |
| px.usdvnd_fawaz_2024 | USD/VND ngày 2024-03-06 | fawazahmed0 currency-api | OK | 200 |  | 2024-03-06 |  |  |  | 1 USD đổi ra VND |
| px.ust10y_treasury | Lợi suất 10 năm Mỹ năm nay | US Treasury CSV | OK | 200 | 2026-01-02 | 2026-11-20 | 223 | D | 3 | mỗi lần gọi một năm (2026) |
| px.ust10y_treasury_1990 | Lợi suất 10 năm Mỹ năm 1990 | US Treasury CSV | OK | 200 | 1990-01-02 | 1990-12-31 | 250 | D | 13111 | mỗi lần gọi một năm (1990) |
| px.vix_cboe | VIX | Cboe CSV | OK | 200 | 1990-01-02 | 2026-11-20 | 9321 | D | 3 |  |
| px.dxy_ecb | 6 tỷ giá trong rổ DXY | ECB EXR | OK | 200 | 1999-01-04 | 2026-11-20 | 7141 | D | 3 | đủ 6 đồng tiền thì tính được DXY tổng hợp |
| vn.stock_gem | VN-Index theo tháng (World Bank GEM) | World Bank GEM DSTKMKTXN | OK | 200 | 2000-01-01 | 2026-01-01 | 27 | A | 326 |  |
| vn.cpi_gem | CPI Việt Nam % so cùng kỳ (GEM) | World Bank GEM CPTOTSAXNZGY | OK | 200 | 1996-01-01 | 2026-01-01 | 31 | A | 326 |  |
| vn.ip_gem | Sản xuất công nghiệp Việt Nam (GEM) | World Bank GEM IPTOTSAKD | OK | 200 | 2008-01-01 | 2025-01-01 | 18 | A | 691 |  |
| vn.exports_gem | Xuất khẩu hàng hóa Việt Nam (GEM) | World Bank GEM DXGSRMRCHSACD | OK | 200 | 1991-01-01 | 2025-01-01 | 35 | A | 691 |  |
| vn.fx_gem | Tỷ giá VND/USD bình quân (GEM) | World Bank GEM DPANUSSPB | OK | 200 | 1987-01-01 | 2026-01-01 | 40 | A | 326 |  |
| px.set_gem | SET theo tháng (GEM) | World Bank GEM DSTKMKTXN | OK | 200 | 1995-01-01 | 2026-01-01 | 32 | A | 326 |  |
| px.sti_gem | STI theo tháng (GEM) | World Bank GEM DSTKMKTXN | OK | 200 | 1990-01-01 | 2026-01-01 | 37 | A | 326 |  |
| cn.ip_gem | Sản xuất công nghiệp Trung Quốc (GEM) | World Bank GEM IPTOTSAKD | OK | 200 | 1997-01-01 | 2025-01-01 | 29 | A | 691 |  |
| meta.dbn_providers | Danh sách nhà cung cấp | DBnomics | OK | 200 |  |  | 94 |  |  |  |
| meta.dbn_cn_pmi | Tìm: China PMI | DBnomics search | OK | 200 |  |  |  |  |  |  |
| meta.dbn_vn_ip | Tìm: Viet Nam industrial production | DBnomics search | OK | 200 |  |  |  |  |  |  |
| meta.dbn_vn_cpi | Tìm: Viet Nam consumer price index | DBnomics search | OK | 200 |  |  |  |  |  |  |
| meta.dbn_vn_rate | Tìm: Viet Nam interest rate | DBnomics search | OK | 200 |  |  |  |  |  |  |
| meta.dbn_vn_bond | Tìm: Viet Nam government bond yield | DBnomics search | LỖI | 200 |  |  |  |  |  | DBnomics search không có kết quả |
| world.imf_weo | Dự báo tăng trưởng thế giới (WEO) | IMF DataMapper | LỖI | 403 |  |  |  |  |  | IMF DataMapper không trả số |
| meta.imf_sdmx | Danh sách dataflow | IMF SDMX 2.1 mới | OK | 200 |  |  | 233 |  |  |  |
| vn.cpi_imf | CPI Việt Nam (IMF) | IMF SDMX CPI | LỖI |  |  |  |  |  |  | ValueError: phản hồi quá 40 MB |
| vn.fx_imf | Tỷ giá VND (IMF) | IMF SDMX ER | OK | 200 | 1990-01-01 | 2026-08-01 |  | M | 114 |  |
| vn.rates_imf | Lãi suất Việt Nam (IMF MFS) | IMF SDMX MFS_IR | LỖI | 200 |  |  |  |  |  | IMF MFS_IR: không có chuỗi nào cho VNM |
| vn.markets_imf | Giá thị trường tài chính Việt Nam (IMF MFS) | IMF SDMX MFS_FMP | LỖI | 200 |  |  |  |  |  | IMF MFS_FMP: không có chuỗi nào cho VNM |
| vn.ip_imf | Chỉ số sản xuất Việt Nam (IMF) | IMF SDMX PI | OK | 200 | 2008-01-01 | 2025-03-01 |  | M | 632 |  |
| vn.trade_imf | Thương mại hàng hóa Việt Nam (IMF) | IMF SDMX ITG | OK | 200 | 2006-01-01 | 2026-07-01 |  | M | 145 |  |
| vn.liquidity_imf | Thanh khoản quốc tế, dự trữ Việt Nam (IMF) | IMF SDMX IL | OK | 200 | 1990-01-01 | 2026-10-01 |  | M | 53 |  |
| world.policy_bis | Lãi suất điều hành US, EA, JP, CN, TH | BIS WS_CBPOL | OK | 200 |  |  |  |  |  |  |
| world.cli_oecd | CLI Mỹ, Trung Quốc, G20 | OECD SDMX | OK | 200 |  |  |  |  |  |  |
| world.ecb_dfr | Lãi suất tiền gửi ECB | ECB Data API | OK | 200 | 1999-01-01 | 2026-11-23 | 10189 | D | 0 |  |
| cn.pmi_em | PMI sản xuất NBS (Eastmoney) | Eastmoney RPT_ECONOMY_PMI | OK | 200 | 2008-01-01 | 2026-10-01 | 226 |  | 53 |  |
| cn.cpi_em | CPI Trung Quốc (Eastmoney) | Eastmoney RPT_ECONOMY_CPI | OK | 200 | 2008-01-01 | 2026-10-01 | 226 |  | 53 |  |
| cn.ppi_em | PPI Trung Quốc (Eastmoney) | Eastmoney RPT_ECONOMY_PPI | OK | 200 | 2006-01-01 | 2026-10-01 | 250 |  | 53 |  |
| cn.m2_em | M2 Trung Quốc (Eastmoney) | Eastmoney RPT_ECONOMY_CURRENCY_SUPPLY | OK | 200 | 2008-01-01 | 2026-10-01 | 226 |  | 53 |  |
| cn.gdp_em | GDP Trung Quốc (Eastmoney) | Eastmoney RPT_ECONOMY_GDP | OK | 200 | 2006-03-01 | 2026-09-01 | 83 |  | 83 |  |
| cn.ip_em | Sản xuất công nghiệp TQ (Eastmoney) | Eastmoney RPT_ECONOMY_INDUS_GROW | OK | 200 | 2008-02-01 | 2026-10-01 | 207 |  | 53 |  |
| cn.retail_em | Bán lẻ Trung Quốc (Eastmoney) | Eastmoney RPT_ECONOMY_TOTAL_RETAIL | OK | 200 | 2008-01-01 | 2026-10-01 | 211 |  | 53 |  |
| cn.bond10y_em | Lợi suất TPCP Trung Quốc, Mỹ (Eastmoney) | Eastmoney RPTA_WEB_TREASURYYIELD | OK | 200 |  | 2026-11-20 | 9393 |  | 3 |  |
| cn.lpr_em | LPR 1 năm, 5 năm (Eastmoney) | Eastmoney RPTA_WEB_RATE | OK | 200 |  | 2026-11-20 | 1578 |  | 3 |  |
| site.nso_vn | Cục Thống kê Việt Nam | www.nso.gov.vn | OK | 200 |  |  |  |  |  |  |
| site.sbv | Ngân hàng Nhà nước | www.sbv.gov.vn | OK | 200 |  |  |  |  |  |  |
| site.hnx | HNX (lợi suất TPCP) | hnx.vn | LỖI |  |  |  |  |  |  | SSLError: HTTPSConnectionPool(host='hnx.vn', port=443): Max retries exceeded with url: / ( |
| site.spglobal_pmi | S&P Global PMI | www.pmi.spglobal.com | OK | 200 |  |  |  |  |  |  |
| site.wgb_vn10y | Lợi suất TPCP Việt Nam 10 năm | www.worldgovernmentbonds.com | OK | 200 |  |  |  |  |  |  |
| site.eia_brent_html | EIA Brent (bảng HTML) | www.eia.gov | OK | 200 |  |  |  |  |  |  |
| lib.akshare | Vĩ mô Trung Quốc qua thư viện akshare | akshare (pip) | OK |  |  |  |  |  |  |  |
