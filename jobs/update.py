#!/usr/bin/env python3
"""Cập nhật số liệu cho macro-radar 2 (chạy trong GitHub Actions).

    python jobs/update.py --mode all|prices|macro --out data

Ghi:
  data/prices/<id>.json      giá đóng cửa ngày của tài sản và chỉ báo thị trường
  data/series/<id>.json      chuỗi vĩ mô theo tần suất gốc
  data/catalog.json          danh mục: nguồn, đơn vị, ngày đầu/cuối, độ tươi, đối chiếu
  data/qa/latest.json, data/qa/<D>.json   kết quả QA
  data/revisions/<YYYY-MM>.json           nhật ký số bị nguồn sửa (cũ → mới)

Nguyên tắc: không xóa điểm đã lưu (nguồn chỉ còn một phần lịch sử thì giữ phần cũ);
số bị sửa thì ghi cũ → mới; mỗi điểm truy được nguồn qua `segments`; lỗi của một nguồn
không làm dừng job, chỉ ghi vào QA và giữ số cũ.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests

UA_BROWSER = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
UA_BOT = "macro-radar-2/2.0 (+https://github.com/MikeNguyen25/claude-macro-radar-2)"
NOW = dt.datetime.now(dt.timezone.utc)
TODAY = NOW.date()
CAP_S = 90                     # giây tối đa cho một request
MAX_BYTES = 60_000_000
SCHEMA_VERSION = 1
SAME_INSTR_TOL_PCT = 0.5       # lệch giá tối đa (%) giữa hai nguồn cùng một công cụ
YIELD_TOL_PP = 0.05            # lệch lợi suất tối đa (điểm %) = 5 điểm cơ bản
DIFF_INSTR_LEVEL_TOL_PCT = 3.0  # lệch mức giá tối đa (%) mặc định giữa hai công cụ khác loại
JUMP_Z = 6.0                   # |z| của biến động ngày vượt ngưỡng này thì cách ly
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA_BROWSER, "Accept": "*/*"})


# ======================================================================== HTTP

def get(url: str, params: dict | None = None, headers: dict | None = None,
        cap: float = CAP_S) -> requests.Response:
    """GET có giới hạn thời gian tổng và kích thước; lỗi HTTP ném ngoại lệ."""
    t0 = time.monotonic()
    resp = SESSION.get(url, params=params, headers=headers, stream=True, timeout=(10, 60))
    buf = bytearray()
    try:
        for chunk in resp.iter_content(65536):
            buf.extend(chunk)
            if time.monotonic() - t0 > cap:
                raise TimeoutError(f"quá {cap:.0f} giây: {url[:80]}")
            if len(buf) > MAX_BYTES:
                raise ValueError("phản hồi quá lớn")
    finally:
        resp.close()
    resp._content = bytes(buf)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {re.sub(r'\s+', ' ', resp.text[:160])}")
    return resp


def jget(url: str, params: dict | None = None, headers: dict | None = None, cap: float = CAP_S):
    return get(url, params, headers, cap).json()


def utc_date(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat()


def src(code: str, name: str, url: str) -> dict:
    return {"code": code, "name": name, "url": url}


def fnum(v) -> float | None:
    """Số thực hữu hạn, hoặc None."""
    if v is None:
        return None
    try:
        x = float(str(v).replace(",", "")) if isinstance(v, str) else float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


# ======================================================================== nguồn

def f_fred(sid: str):
    r = get("https://fred.stlouisfed.org/graph/fredgraph.csv", {"id": sid}, {"User-Agent": UA_BOT})
    if r.text.lstrip().startswith("<"):
        raise RuntimeError("FRED trả HTML")
    rows = list(csv.reader(io.StringIO(r.text)))
    pairs = [(row[0][:10], fnum(row[1])) for row in rows[1:] if len(row) > 1 and row[1] not in ("", ".")]
    return pairs, src("fred", f"FRED {sid}", f"https://fred.stlouisfed.org/series/{sid}")


def f_cm(asset: str):
    url = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
    params = {"assets": asset, "metrics": "PriceUSD", "frequency": "1d", "page_size": 2000,
              "paging_from": "start", "start_time": "2009-01-01"}
    pairs: list = []
    while url:
        for attempt in range(3):
            try:
                j = jget(url, params, cap=120)
                break
            except Exception:  # noqa: BLE001 - máy chủ community đôi khi chậm; thử lại
                if attempt == 2:
                    raise
                time.sleep(5 * (attempt + 1))
        pairs += [(x["time"][:10], fnum(x.get("PriceUSD"))) for x in j.get("data", [])]
        url, params = j.get("next_page_url"), None
        if url:
            time.sleep(0.8)
    return pairs, src("cm", f"Coin Metrics {asset.upper()} PriceUSD (đóng cửa ngày UTC)",
                      "https://coverage.coinmetrics.io/asset-metrics/PriceUSD")


def f_binance(symbol: str):
    url = "https://data-api.binance.vision/api/v3/klines"
    now_ms = NOW.timestamp() * 1000
    start, pairs = 0, []
    for _ in range(20):
        j = jget(url, {"symbol": symbol, "interval": "1d", "startTime": start, "limit": 1000})
        if not j:
            break
        pairs += [(utc_date(k[0] / 1000), fnum(k[4])) for k in j if k[6] < now_ms]  # chỉ nến đã đóng
        if len(j) < 1000:
            break
        start = j[-1][0] + 86_400_000
        time.sleep(0.3)
    return pairs, src("binance", f"Binance {symbol} (nến ngày UTC)", f"https://www.binance.com/en/trade/{symbol}")


def f_cnbc(sym: str):
    url = (f"https://ts-api.cnbc.com/harmony/app/bars/{quote(sym, safe='')}/1D/"
           f"19900101000000/{TODAY:%Y%m%d}000000/adjusted/EST5EDT.json")
    bars = (jget(url).get("barData") or {}).get("priceBars") or []
    pairs = []
    for b in bars:
        t = str(b.get("tradeTime") or "")
        if len(t) >= 8:
            pairs.append((f"{t[:4]}-{t[4:6]}-{t[6:8]}", fnum(b.get("close"))))
    return pairs, src("cnbc", f"CNBC {sym}", f"https://www.cnbc.com/quotes/{quote(sym, safe='')}")


def f_tv_style(url: str, params: dict, code: str, name: str, page: str):
    j = jget(url, params)
    pairs = [(utc_date(t + 7 * 3600), fnum(c)) for t, c in zip(j.get("t") or [], j.get("c") or [])]
    return pairs, src(code, name, page)


def f_dnse(symbol: str = "VNINDEX"):
    base = int(dt.datetime(2000, 7, 28, tzinfo=dt.timezone.utc).timestamp())
    return f_tv_style("https://services.entrade.com.vn/chart-api/v2/ohlcs/index",
                      {"from": base, "to": int(NOW.timestamp()), "symbol": symbol, "resolution": "1D"},
                      "dnse", "DNSE (Entrade) VNINDEX", "https://banggia.dnse.com.vn/")


def f_vndirect(symbol: str = "VNINDEX"):
    base = int(dt.datetime(2000, 7, 28, tzinfo=dt.timezone.utc).timestamp())
    return f_tv_style("https://dchart-api.vndirect.com.vn/dchart/history",
                      {"resolution": "D", "symbol": symbol, "from": base, "to": int(NOW.timestamp())},
                      "vndirect", "VNDirect dchart VNINDEX", "https://dstock.vndirect.com.vn/")


def f_treasury_10y():
    pairs = []
    for year in (TODAY.year - 1, TODAY.year):
        url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
               f"daily-treasury-rates.csv/{year}/all")
        r = get(url, {"type": "daily_treasury_yield_curve", "field_tdr_date_value": year, "page": "",
                      "_format": "csv"})
        rows = list(csv.reader(io.StringIO(r.text)))
        i = rows[0].index("10 Yr")
        for row in rows[1:]:
            if len(row) > i and row[i]:
                pairs.append((dt.datetime.strptime(row[0], "%m/%d/%Y").date().isoformat(), fnum(row[i])))
    return pairs, src("treasury", "US Treasury, đường cong lợi suất ngày (10 năm)",
                      "https://home.treasury.gov/resource-center/data-chart-center/interest-rates")


def f_cboe_vix():
    r = get("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv")
    rows = list(csv.reader(io.StringIO(r.text)))
    hdr = [h.strip().upper() for h in rows[0]]
    i = hdr.index("CLOSE")
    pairs = [(dt.datetime.strptime(row[0], "%m/%d/%Y").date().isoformat(), fnum(row[i]))
             for row in rows[1:] if len(row) > i]
    return pairs, src("cboe", "Cboe VIX History", "https://www.cboe.com/tradable_products/vix/vix_historical_data/")


DXY_W = {"EURUSD": -0.576, "USDJPY": 0.136, "GBPUSD": -0.119, "USDCAD": 0.091, "USDSEK": 0.042, "USDCHF": 0.036}


def f_ecb_dxy():
    """DXY tổng hợp từ tỷ giá tham chiếu ECB theo công thức ICE."""
    url = "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CAD+SEK+CHF.EUR.SP00.A"
    r = get(url, {"format": "csvdata", "startPeriod": "1999-01-01"})
    rates: dict[str, dict[str, float]] = {}
    for row in csv.DictReader(io.StringIO(r.text)):
        v = fnum(row.get("OBS_VALUE"))
        if v:
            rates.setdefault(row["TIME_PERIOD"], {})[row["CURRENCY"]] = v
    pairs = []
    for d, x in sorted(rates.items()):
        if len(x) < 6:
            continue
        usd = x["USD"]
        pairs.append((d, 50.14348112 * usd ** DXY_W["EURUSD"] * (x["JPY"] / usd) ** DXY_W["USDJPY"]
                      * (usd / x["GBP"]) ** DXY_W["GBPUSD"] * (x["CAD"] / usd) ** DXY_W["USDCAD"]
                      * (x["SEK"] / usd) ** DXY_W["USDSEK"] * (x["CHF"] / usd) ** DXY_W["USDCHF"]))
    return pairs, src("ecb_dxy", "DXY tính từ tỷ giá tham chiếu ECB", "https://data.ecb.europa.eu/")


def f_currency_api(cur: str):
    j = jget(f"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json")
    v = fnum((j.get("usd") or {}).get(cur))
    if cur == "xau" and v:
        v = 1 / v  # USD cho 1 ounce
    return [(j.get("date"), v)], src("currency_api", f"currency-api USD/{cur.upper()}",
                                     "https://github.com/fawazahmed0/exchange-api")


def f_tradingview(tickers: tuple[str, ...]):
    """Giá đóng cửa mới nhất trên TradingView (chỉ để đối chiếu phiên gần nhất)."""
    last_err = None
    for t in tickers:
        try:
            r = SESSION.post("https://scanner.tradingview.com/global/scan", timeout=20,
                             json={"symbols": {"tickers": [t]}, "columns": ["close", "description"]})
            rows = r.json().get("data") or []
            if r.status_code == 200 and rows and rows[0]["d"][0]:
                return [(None, fnum(rows[0]["d"][0]))], src("tradingview", f"TradingView {t}",
                                                           f"https://www.tradingview.com/symbols/{t.replace(':', '-')}/")
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError(f"TradingView không trả giá: {last_err}")


def f_eastmoney(report: str, field: str, sort_col: str = "REPORT_DATE"):
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    pairs, page = [], 1
    while page <= 40:
        j = jget(url, {"reportName": report, "columns": "ALL", "pageNumber": page, "pageSize": 500,
                       "sortColumns": sort_col, "sortTypes": -1, "source": "WEB", "client": "WEB"},
                 {"Referer": "https://data.eastmoney.com/"})
        res = j.get("result") or {}
        pairs += [((x.get(sort_col) or "")[:10], fnum(x.get(field))) for x in res.get("data") or []]
        if page >= (res.get("pages") or 1):
            break
        page += 1
        time.sleep(0.3)
    return pairs, src("eastmoney", f"Eastmoney {report}.{field}", "https://data.eastmoney.com/cjsj/")


def sdmx_csv_pairs(text: str, filt: dict | None = None) -> list:
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        if filt and any(row.get(k) != v for k, v in filt.items()):
            continue
        tp = row.get("TIME_PERIOD", "")
        m = re.match(r"^(\d{4})-?M?(\d{2})$", tp)
        d = f"{m.group(1)}-{m.group(2)}-01" if m else tp[:10]
        out.append((d, fnum(row.get("OBS_VALUE"))))
    return out


def f_bis(area: str):
    r = get(f"https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.{area}",
            {"format": "csv", "startPeriod": "1990-01"})
    return sdmx_csv_pairs(r.text), src("bis", f"BIS lãi suất điều hành {area}", "https://data.bis.org/topics/CBPOL")


def f_oecd_cli(area: str):
    url = f"https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,/{area}.M.LI...AA...H"
    r = get(url, {"startPeriod": "1990-01", "format": "csvfilewithlabels"})
    return sdmx_csv_pairs(r.text), src("oecd", f"OECD CLI {area}", "https://www.oecd.org/en/data/indicators/composite-leading-indicator-cli.html")


def f_ecb_dfr():
    r = get("https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV", {"format": "csvdata"})
    return sdmx_csv_pairs(r.text), src("ecb", "ECB lãi suất tiền gửi (DFR)", "https://data.ecb.europa.eu/")


def f_imf(flow: str, key: str, agency: str = "IMF.STA"):
    r = get(f"https://api.imf.org/external/sdmx/2.1/data/{agency},{flow}/{key}", {"startPeriod": "1990"},
            {"Accept": "application/vnd.sdmx.data+csv;version=1.0.0"})
    return sdmx_csv_pairs(r.text), src("imf", f"IMF {flow} {key}", "https://data.imf.org/")


# ======================================================================== danh mục

FETCHERS = {
    "fred": f_fred, "cm": f_cm, "binance": f_binance, "cnbc": f_cnbc, "dnse": f_dnse, "vndirect": f_vndirect,
    "treasury10": lambda _: f_treasury_10y(), "cboe_vix": lambda _: f_cboe_vix(), "ecb_dxy": lambda _: f_ecb_dxy(),
    "currency_api": f_currency_api, "tradingview": f_tradingview, "bis": f_bis, "oecd_cli": f_oecd_cli,
    "ecb_dfr": lambda _: f_ecb_dfr(), "imf": lambda a: f_imf(*a),
    "eastmoney": lambda a: f_eastmoney(*a),
}

# Tài sản: id, tên, nhóm, kind, đơn vị, nguồn chính (thử theo thứ tự), nguồn đối chiếu,
# cùng công cụ hay không, múi giờ sàn (giờ so với UTC) và giờ đóng cửa (để bỏ phiên đang chạy).
ASSETS = [
    dict(id="btc", name="BTC", group="crypto", kind="price", unit="USD", primary=[("cm", "btc"), ("binance", "BTCUSDT")],
         check=("binance", "BTCUSDT"), same=False, tol={"level_pct": 1.5}, tz=0, close=24, forecast=True),
    dict(id="eth", name="ETH", group="crypto", kind="price", unit="USD", primary=[("cm", "eth"), ("binance", "ETHUSDT")],
         check=("binance", "ETHUSDT"), same=False, tol={"level_pct": 1.5}, tz=0, close=24, forecast=True),
    dict(id="sol", name="SOL", group="crypto", kind="price", unit="USD", primary=[("cm", "sol"), ("binance", "SOLUSDT")],
         check=("binance", "SOLUSDT"), same=False, tol={"level_pct": 1.5}, tz=0, close=24, forecast=True),
    dict(id="doge", name="DOGE", group="crypto", kind="price", unit="USD", primary=[("cm", "doge"), ("binance", "DOGEUSDT")],
         check=("binance", "DOGEUSDT"), same=False, tol={"level_pct": 1.5}, tz=0, close=24, forecast=True),
    dict(id="trx", name="TRX", group="crypto", kind="price", unit="USD", primary=[("cm", "trx"), ("binance", "TRXUSDT")],
         check=("binance", "TRXUSDT"), same=False, tol={"level_pct": 1.5}, tz=0, close=24, forecast=True),
    dict(id="spx", name="S&P 500", group="us_eq", kind="price", unit="điểm", primary=[("cnbc", ".SPX")],
         check=("fred", "SP500"), same=True, tz=-5, close=16, forecast=True),
    dict(id="ndq", name="Nasdaq Composite", group="us_eq", kind="price", unit="điểm",
         primary=[("fred", "NASDAQCOM")], check=("cnbc", ".IXIC"), same=True, tz=-5, close=16, forecast=True),
    dict(id="sti", name="STI (Singapore)", group="sea", kind="price", unit="điểm", primary=[("cnbc", ".STI")],
         check=("tradingview", ("TVC:STI", "SGX:STI")), same=True, tz=8, close=17, forecast=True),
    dict(id="set", name="SET (Thái Lan)", group="sea", kind="price", unit="điểm", primary=[("cnbc", ".SETI")],
         check=("tradingview", ("SET:SET", "TVC:SET")), same=True, tz=7, close=17, forecast=True),
    dict(id="vni", name="VN-Index", group="vn", kind="price", unit="điểm", primary=[("dnse", "VNINDEX")],
         check=("vndirect", "VNINDEX"), same=True, tz=7, close=15, forecast=True),
    dict(id="gold", name="Vàng", group="cmd_fx", kind="price", unit="USD/oz",
         primary=[("cnbc", "XAU="), ("cnbc", "@GC.1")], check=("binance", "PAXGUSDT"), same=False, tol={"level_pct": 3.0},
         tz=-5, close=17, forecast=True),
    dict(id="brent", name="Dầu Brent", group="cmd_fx", kind="price", unit="USD/thùng",
         primary=[("cnbc", "@LCO.1")], check=("fred", "DCOILBRENTEU"), same=False, tol={"level_pct": 12.0}, tz=-5, close=17,
         forecast=True),
    dict(id="usdvnd", name="USD/VND", group="cmd_fx", kind="price", unit="VND", primary=[("cnbc", "VND=")],
         check=("currency_api", "vnd"), same=False, tol={"level_pct": 1.5}, tz=7, close=17, forecast=True),
    dict(id="ust10y", name="Lợi suất 10 năm Mỹ", group="cmd_fx", kind="yield", unit="%",
         primary=[("fred", "DGS10")], check=("treasury10", None), same=True, tz=-5, close=18, forecast=True),
    dict(id="vix", name="VIX", group="indicator", kind="level", unit="điểm", primary=[("cboe_vix", None)],
         check=("fred", "VIXCLS"), same=True, tz=-5, close=17, forecast=False),
    dict(id="dxy", name="DXY", group="indicator", kind="price", unit="điểm", primary=[("cnbc", ".DXY")],
         check=("ecb_dxy", None), same=False, tol={"level_pct": 1.0}, tz=-5, close=17, forecast=False),
]

# Chuỗi vĩ mô: vùng, nhóm nhân tố, dấu (cùng chiều nhân tố = +1), biến đổi cho mô hình,
# pubLagDays (ngày từ cuối kỳ tới khi công bố, làm tròn lên).
S = lambda **k: k  # noqa: E731
SERIES = [
    # Mỹ
    S(id="us_gdp", name="GDP thực Mỹ", region="us", factor="growth", sign=1, transform="yoy", unit="tỷ USD (2017)",
      freq="Q", lag=32, fetch=("fred", "GDPC1")),
    S(id="us_unrate", name="Tỷ lệ thất nghiệp Mỹ", region="us", factor="growth", sign=-1, transform="chg6", unit="%",
      freq="M", lag=9, fetch=("fred", "UNRATE")),
    S(id="us_payems", name="Việc làm phi nông nghiệp", region="us", factor="growth", sign=1, transform="yoy",
      unit="nghìn người", freq="M", lag=9, fetch=("fred", "PAYEMS")),
    S(id="us_icsa", name="Đơn trợ cấp thất nghiệp lần đầu", region="us", factor="growth", sign=-1,
      transform="yoy", unit="đơn", freq="W", lag=6, fetch=("fred", "ICSA")),
    S(id="us_philly", name="Khảo sát sản xuất Philadelphia Fed", region="us", factor="growth", sign=1,
      transform="level", unit="chỉ số khuếch tán", freq="M", lag=1, fetch=("fred", "GACDFSA066MSFRBPHI")),
    S(id="us_cfnai", name="Chỉ số hoạt động Chicago Fed", region="us", factor="growth", sign=1, transform="level",
      unit="chỉ số", freq="M", lag=28, fetch=("fred", "CFNAI")),
    S(id="us_cli", name="OECD CLI Mỹ", region="us", factor="growth", sign=1, transform="chg6", unit="chỉ số",
      freq="M", lag=40, fetch=("oecd_cli", "USA")),
    S(id="us_cpi", name="CPI Mỹ", region="us", factor="inflation", sign=1, transform="yoy", unit="chỉ số",
      freq="M", lag=15, fetch=("fred", "CPIAUCSL")),
    S(id="us_pce_core", name="PCE lõi Mỹ", region="us", factor="inflation", sign=1, transform="yoy",
      unit="chỉ số", freq="M", lag=32, fetch=("fred", "PCEPILFE")),
    S(id="us_be5y", name="Lạm phát kỳ vọng 5 năm", region="us", factor="inflation", sign=1, transform="level",
      unit="%", freq="D", lag=1, fetch=("fred", "T5YIE")),
    S(id="us_ff", name="Lãi suất Fed (hiệu dụng)", region="us", factor="policy", sign=1, transform="chg6",
      unit="%", freq="D", lag=1, fetch=("fred", "DFF")),
    S(id="us_2y", name="Lợi suất 2 năm Mỹ", region="us", factor="policy", sign=1, transform="chg6", unit="%",
      freq="D", lag=1, fetch=("fred", "DGS2")),
    S(id="us_10y2y", name="Độ dốc 10 năm − 2 năm", region="us", factor="curve", sign=1, transform="level",
      unit="điểm %", freq="D", lag=1, fetch=("fred", "T10Y2Y")),
    S(id="us_10y3m", name="Độ dốc 10 năm − 3 tháng", region="us", factor="curve", sign=1, transform="level",
      unit="điểm %", freq="D", lag=1, fetch=("fred", "T10Y3M")),
    S(id="us_nfci", name="Chỉ số điều kiện tài chính NFCI", region="us", factor="fincond", sign=1,
      transform="level", unit="chỉ số", freq="W", lag=6, fetch=("fred", "NFCI")),
    S(id="us_baa10y", name="Chênh lệch Baa − lợi suất 10 năm", region="us", factor="credit", sign=1,
      transform="level", unit="điểm %", freq="D", lag=1, fetch=("fred", "BAA10Y")),
    S(id="us_usd_broad", name="Chỉ số USD rộng (Fed)", region="us", factor="usd", sign=1, transform="pct6",
      unit="chỉ số", freq="D", lag=1, fetch=("fred", "DTWEXBGS")),
    # Trung Quốc
    S(id="cn_pmi", name="PMI sản xuất NBS", region="cn", factor="growth", sign=1, transform="level50",
      unit="chỉ số", freq="M", lag=1, fetch=("eastmoney", ("RPT_ECONOMY_PMI", "MAKE_INDEX"))),
    S(id="cn_ip", name="Sản xuất công nghiệp TQ (% so cùng kỳ)", region="cn", factor="growth", sign=1,
      transform="level", unit="%", freq="M", lag=17, fetch=("eastmoney", ("RPT_ECONOMY_INDUS_GROW", "BASE_SAME"))),
    S(id="cn_retail", name="Bán lẻ TQ (% so cùng kỳ)", region="cn", factor="growth", sign=1, transform="level",
      unit="%", freq="M", lag=17, fetch=("eastmoney", ("RPT_ECONOMY_TOTAL_RETAIL", "RETAIL_TOTAL_SAME"))),
    S(id="cn_gdp", name="GDP TQ lũy kế (% so cùng kỳ)", region="cn", factor="growth", sign=1, transform="level",
      unit="%", freq="Q", lag=20, period_end="month", fetch=("eastmoney", ("RPT_ECONOMY_GDP", "SUM_SAME"))),
    S(id="cn_cli", name="OECD CLI Trung Quốc", region="cn", factor="growth", sign=1, transform="chg6",
      unit="chỉ số", freq="M", lag=40, fetch=("oecd_cli", "CHN")),
    S(id="cn_cpi", name="CPI TQ (% so cùng kỳ)", region="cn", factor="inflation", sign=1, transform="level",
      unit="%", freq="M", lag=12, fetch=("eastmoney", ("RPT_ECONOMY_CPI", "NATIONAL_SAME"))),
    S(id="cn_ppi", name="PPI TQ (% so cùng kỳ)", region="cn", factor="inflation", sign=1, transform="level",
      unit="%", freq="M", lag=12, fetch=("eastmoney", ("RPT_ECONOMY_PPI", "BASE_SAME"))),
    S(id="cn_m2", name="M2 TQ (% so cùng kỳ)", region="cn", factor="money", sign=1, transform="level", unit="%",
      freq="M", lag=15, fetch=("eastmoney", ("RPT_ECONOMY_CURRENCY_SUPPLY", "BASIC_CURRENCY_SAME"))),
    S(id="cn_lpr1y", name="LPR 1 năm", region="cn", factor="policy", sign=1, transform="chg6", unit="%",
      freq="D", lag=1, fetch=("eastmoney", ("RPTA_WEB_RATE", "LPR1Y", "TRADE_DATE"))),
    S(id="cn_policy", name="Lãi suất điều hành TQ (BIS)", region="cn", factor="policy", sign=1, transform="chg6",
      unit="%", freq="M", lag=35, fetch=("bis", "CN")),
    S(id="cn_10y", name="Lợi suất TPCP TQ 10 năm", region="cn", factor="rates", sign=1, transform="level",
      unit="%", freq="D", lag=1, fetch=("eastmoney", ("RPTA_WEB_TREASURYYIELD", "EMM00166466", "SOLAR_DATE"))),
    S(id="cn_usdcny", name="USD/CNY", region="cn", factor="fx", sign=1, transform="pct6", unit="CNY",
      freq="D", lag=1, fetch=("fred", "DEXCHUS")),
    # Việt Nam
    S(id="vn_exports", name="Xuất khẩu hàng hóa VN (USD)", region="vn", factor="growth", sign=1,
      transform="yoy", unit="USD", freq="M", lag=130, fetch=("imf", ("ITG", "VNM.XG.FOB_USD.M"))),
    S(id="vn_imports", name="Nhập khẩu hàng hóa VN (USD)", region="vn", factor="growth", sign=1,
      transform="yoy", unit="USD", freq="M", lag=130, fetch=("imf", ("ITG", "VNM.MG.CIF_USD.M"))),
    S(id="vn_ip", name="Sản xuất công nghiệp VN (IMF)", region="vn", factor="growth", sign=1, transform="yoy",
      unit="chỉ số", freq="M", lag=60, fetch=("imf", ("PI", "VNM.IND.IX.M"))),
    S(id="vn_fx", name="USD/VND bình quân tháng (IMF)", region="vn", factor="fx", sign=1, transform="pct6",
      unit="VND", freq="M", lag=100, fetch=("imf", ("ER", "VNM.XDC_USD.PA_RT.M"))),
    S(id="vn_reserves", name="Dự trữ ngoại hối VN (trừ vàng)", region="vn", factor="fx", sign=-1,
      transform="pct6", unit="USD", freq="M", lag=100, fetch=("imf", ("IL", "VNM.RXF11FX_REVS.USD.M"))),
    # Thế giới
    S(id="w_cli_g20", name="OECD CLI G20", region="world", factor="growth", sign=1, transform="chg6",
      unit="chỉ số", freq="M", lag=40, fetch=("oecd_cli", "G20")),
    S(id="w_ecb", name="Lãi suất tiền gửi ECB", region="world", factor="policy", sign=1, transform="chg6",
      unit="%", freq="D", lag=1, fetch=("ecb_dfr", None)),
    S(id="w_boj", name="Lãi suất điều hành Nhật (BIS)", region="world", factor="policy", sign=1, transform="chg6",
      unit="%", freq="M", lag=35, fetch=("bis", "JP")),
    S(id="w_th_policy", name="Lãi suất điều hành Thái Lan (BIS)", region="world", factor="policy", sign=1,
      transform="chg6", unit="%", freq="M", lag=35, fetch=("bis", "TH")),
    S(id="w_brent_spot", name="Brent giao ngay (EIA)", region="world", factor="inflation", sign=1, transform="yoy",
      unit="USD/thùng", freq="D", lag=7, fetch=("fred", "DCOILBRENTEU")),
]

UNIT_RANGES = {  # kiểm tra đơn vị: khoảng hợp lý của mức giá
    "btc": (0.01, 5e6), "eth": (0.1, 5e5), "sol": (0.1, 1e5), "doge": (1e-5, 100), "trx": (1e-4, 100),
    "spx": (100, 1e5), "ndq": (50, 1e6), "sti": (300, 2e4), "set": (100, 1e4), "vni": (50, 1e4),
    "gold": (100, 2e4), "brent": (5, 500), "usdvnd": (5000, 1e5), "ust10y": (-1, 25), "vix": (5, 150),
    "dxy": (50, 200),
}
STALE_DAYS = {"crypto": 2, "indicator": 6, "us_eq": 6, "sea": 7, "vn": 10, "cmd_fx": 6}
STALE_BY_FREQ = {"D": 10, "W": 20, "M": 75, "Q": 200}


# ======================================================================== xử lý chuỗi

def clean(pairs: list) -> tuple[list, list, list]:
    """Bỏ None, ngày tương lai và ngày trùng (giữ giá trị sau cùng). Trả (pairs, future, dupes)."""
    seen: dict[str, float] = {}
    future, dupes = [], []
    for d, v in pairs:
        if not d or v is None:
            continue
        d = str(d)[:10]
        if d > (TODAY + dt.timedelta(days=1)).isoformat():
            future.append(d)
            continue
        if d in seen and seen[d] != v:
            dupes.append(d)
        seen[d] = v
    return sorted(seen.items()), future, dupes


def drop_partial(pairs: list, tz: int, close_hour: int) -> list:
    """Bỏ phiên của ngày hôm nay (giờ sàn) nếu sàn chưa đóng cửa."""
    if not pairs:
        return pairs
    local = NOW + dt.timedelta(hours=tz)
    if pairs[-1][0] == local.date().isoformat() and local.hour < close_hour:
        return pairs[:-1]
    return pairs


def load_json(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def merge(old: dict | None, pairs: list, source: dict, rev_log: list, sid: str, key: str = "c") -> tuple[list, list, list]:
    """Hợp nhất số cũ và mới: không xóa điểm cũ; số bị sửa ghi vào rev_log. Trả (dates, values, segments)."""
    old_map: dict[str, float] = {}
    if old:
        old_map = dict(zip(old.get("d", []), old.get(key, [])))
    new_map = dict(pairs)
    for d, v in new_map.items():
        ov = old_map.get(d)
        if ov is not None and abs(ov - v) > 1e-9 * max(1.0, abs(ov)):
            rev_log.append({"id": sid, "date": d, "old": ov, "new": v, "source": source["code"],
                            "detected": NOW.isoformat(timespec="seconds")})
    merged = {**old_map, **new_map}
    dates = sorted(merged)
    # Đoạn nguồn: mỗi nguồn một đoạn [from, to]; điểm thuộc đoạn của nguồn đã cung cấp nó.
    segments = [dict(s) for s in (old or {}).get("segments", [])]
    if new_map:
        nd = sorted(new_map)
        for s in segments:
            if s["code"] == source["code"]:
                s.update(name=source["name"], url=source["url"], **{"from": min(s["from"], nd[0]),
                                                                     "to": max(s["to"], nd[-1])})
                break
        else:
            segments.append({"code": source["code"], "name": source["name"], "url": source["url"],
                             "from": nd[0], "to": nd[-1]})
    return dates, [merged[d] for d in dates], segments


def log_returns(values: list) -> list:
    return [math.log(b / a) for a, b in zip(values, values[1:]) if a and b and a > 0 and b > 0]


def jump_check(dates: list, values: list, kind: str, n_tail: int = 3) -> list:
    """|z| của biến động các điểm cuối so với 3 năm trước đó; trả các điểm vượt JUMP_Z."""
    if len(values) < 300:
        return []
    out = []
    for k in range(1, n_tail + 1):
        i = len(values) - k
        hist = values[max(0, i - 760):i]
        if kind == "price":
            ch = log_returns(hist)
            cur = math.log(values[i] / values[i - 1]) if values[i] > 0 and values[i - 1] > 0 else 0.0
        else:
            ch = [b - a for a, b in zip(hist, hist[1:])]
            cur = values[i] - values[i - 1]
        sd = statistics.pstdev(ch) if len(ch) > 30 else 0
        if sd > 0 and abs(cur / sd) > JUMP_Z:
            out.append({"date": dates[i], "value": values[i], "z": round(cur / sd, 2)})
    return out


def cross_check(dates: list, values: list, check_pairs: list, kind: str, same: bool, tol: dict | None) -> dict:
    """So nguồn chính với nguồn đối chiếu trên các ngày chung trong 30 ngày gần nhất.

    Cùng công cụ: lệch giá ≤ 0,5% (lợi suất ≤ 5 điểm cơ bản). Khác công cụ (tương lai và giao ngay,
    USDT và USD, giờ chốt khác nhau): chỉ so mức giá với ngưỡng riêng của cặp nguồn (tol.level_pct).
    Nguồn đối chiếu chỉ có giá mới nhất, hoặc không có ngày chung, thì so điểm cuối hai bên nếu
    cách nhau ≤ 4 ngày.
    """
    if not dates:
        return {"n": 0, "status": "không có số liệu"}
    pm = dict(zip(dates, values))
    cps = sorted(((d, v) for d, v in check_pairs if v is not None and d), key=lambda x: x[0])
    latest_only = [(None, v) for d, v in check_pairs if d is None and v is not None]
    cutoff = (TODAY - dt.timedelta(days=30)).isoformat()
    common = [(d, pm[d], v) for d, v in cps if d in pm and d >= cutoff]
    mode = "ngày chung"
    if not common:
        last_check = latest_only[-1] if latest_only else (cps[-1] if cps else None)
        if last_check is None:
            return {"n": 0, "status": "không có ngày chung"}
        cd = last_check[0] or dates[-1]
        if abs((dt.date.fromisoformat(cd) - dt.date.fromisoformat(dates[-1])).days) > 4:
            return {"n": 0, "status": "không có ngày chung", "check_last": cd}
        common, mode = [(dates[-1], values[-1], last_check[1])], "điểm mới nhất"
    viol, worst = [], 0.0
    for d, a, b in common:
        if kind == "yield":
            diff, limit = abs(a - b), YIELD_TOL_PP
        else:
            diff = abs(a / b - 1) * 100
            limit = SAME_INSTR_TOL_PCT if same else (tol or {}).get("level_pct", DIFF_INSTR_LEVEL_TOL_PCT)
        worst = max(worst, diff)
        if diff > limit:
            viol.append({"date": d, "primary": a, "check": b})
    return {"n": len(common), "mode": mode, "max_diff": round(worst, 4), "violations": viol[-5:],
            "status": "lệch" if viol else "khớp"}


# ======================================================================== chạy

def fetch(spec):
    kind, arg = spec
    fn = FETCHERS[kind]
    return fn(arg)


def process_asset(a: dict, out_dir: str, rev_log: list) -> dict:
    path = os.path.join(out_dir, "prices", f"{a['id']}.json")
    old = load_json(path)
    qa = {"id": a["id"], "errors": []}
    pairs, source = [], None
    for spec in a["primary"]:
        try:
            p, s = fetch(spec)
            p, future, dupes = clean(p)
            p = drop_partial(p, a["tz"], a["close"]) if a["close"] < 24 else p
            if len(p) >= 250:
                pairs, source = p, s
                qa.update(future=future, dupes=dupes)
                break
            qa["errors"].append(f"{spec}: chỉ có {len(p)} điểm")
        except Exception as e:  # noqa: BLE001
            qa["errors"].append(f"{spec}: {type(e).__name__}: {str(e)[:160]}")
    if source is None and not old:
        qa["status"] = "thiếu"
        return qa
    if source is None:
        source = old.get("source")
        qa["status"] = "giữ số cũ"
    dates, values, segments = merge(old, pairs, source, rev_log, a["id"])
    lo, hi = UNIT_RANGES.get(a["id"], (-1e18, 1e18))
    bad_units = [d for d, v in zip(dates[-60:], values[-60:]) if not (lo <= v <= hi)]
    check = {"status": "không có nguồn đối chiếu"}
    if a.get("check"):
        try:
            cp, cs = fetch(a["check"])
            cp = [(d, v) for d, v in cp if v is not None]
            check = cross_check(dates, values, sorted(cp, key=lambda x: x[0] or "")[-40:], a["kind"],
                                a["same"], a.get("tol"))
            check.update(source=cs)
        except Exception as e:  # noqa: BLE001
            check = {"status": "lỗi nguồn đối chiếu", "error": f"{type(e).__name__}: {str(e)[:160]}"}
    jumps = jump_check(dates, values, "price" if a["kind"] == "price" else "diff")
    if jumps and check.get("status") == "khớp":
        jumps = []  # nguồn đối chiếu xác nhận biến động là thật
    age = (TODAY - dt.date.fromisoformat(dates[-1])).days if dates else None
    doc = {"schemaVersion": SCHEMA_VERSION, "id": a["id"], "name": a["name"], "group": a["group"],
           "kind": a["kind"], "unit": a["unit"], "forecast": a["forecast"], "source": source,
           "segments": segments, "check": check, "updated": NOW.isoformat(timespec="seconds"),
           "quarantine": jumps, "d": dates, "c": values}
    write_if_changed(path, doc, keys_ignore=("updated",))
    qa.update(status=qa.get("status", "ok"), last=dates[-1] if dates else None, age_days=age,
              stale=age is not None and age > STALE_DAYS.get(a["group"], 6), n=len(dates),
              first=dates[0] if dates else None, check=check, quarantine=jumps, bad_units=bad_units[-5:],
              source=source["name"] if source else None)
    return qa


def process_series(s: dict, out_dir: str, rev_log: list) -> dict:
    path = os.path.join(out_dir, "series", f"{s['id']}.json")
    old = load_json(path)
    qa = {"id": s["id"], "errors": []}
    pairs, source = [], None
    try:
        p, source = fetch(s["fetch"])
        pairs, future, dupes = clean(p)
        qa.update(future=future, dupes=dupes)
        if not pairs:
            raise RuntimeError("nguồn không trả điểm nào")
    except Exception as e:  # noqa: BLE001
        qa["errors"].append(f"{type(e).__name__}: {str(e)[:160]}")
        source = None
    if source is None and not old:
        qa["status"] = "thiếu"
        return qa
    if source is None:
        source = old.get("source")
        qa["status"] = "giữ số cũ"
    dates, values, segments = merge(old, pairs, source, rev_log, s["id"], key="v")
    age = (TODAY - dt.date.fromisoformat(dates[-1])).days if dates else None
    meta = {k: s[k] for k in ("id", "name", "region", "factor", "sign", "transform", "unit", "freq")}
    if s.get("period_end"):
        meta["periodEnd"] = s["period_end"]  # kỳ quý ghi theo tháng cuối quý
    doc = {"schemaVersion": SCHEMA_VERSION, **meta, "pubLagDays": s["lag"], "source": source,
           "segments": segments, "updated": NOW.isoformat(timespec="seconds"), "d": dates, "v": values}
    write_if_changed(path, doc, keys_ignore=("updated",))
    limit = STALE_BY_FREQ.get(s["freq"], 75) + s["lag"]
    qa.update(status=qa.get("status", "ok"), last=dates[-1] if dates else None, age_days=age,
              stale=age is not None and age > limit, n=len(dates), first=dates[0] if dates else None,
              source=source["name"] if source else None)
    return qa


def write_if_changed(path: str, doc: dict, keys_ignore=()) -> bool:
    """Chỉ ghi khi nội dung (trừ các khóa bỏ qua) thay đổi, để lịch sử git gọn."""
    old = load_json(path)
    if old is not None:
        a = {k: v for k, v in old.items() if k not in keys_ignore}
        b = {k: v for k, v in doc.items() if k not in keys_ignore}
        if a == b:
            return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Cập nhật số liệu macro-radar 2")
    ap.add_argument("--mode", choices=["all", "prices", "macro"], default="all")
    ap.add_argument("--out", default="data")
    ap.add_argument("--only", default="", help="chỉ xử lý id bắt đầu bằng chuỗi này")
    args = ap.parse_args()
    rev_log: list = []
    assets = [a for a in ASSETS if a["id"].startswith(args.only)] if args.mode in ("all", "prices") else []
    series = [s for s in SERIES if s["id"].startswith(args.only)] if args.mode in ("all", "macro") else []
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=8) as ex:
        qa_assets = list(ex.map(lambda a: process_asset(a, args.out, rev_log), assets))
        qa_series = list(ex.map(lambda s: process_series(s, args.out, rev_log), series))
    # catalog và QA gộp với lần chạy trước (mode prices/macro chỉ cập nhật phần của mình)
    qa_path = os.path.join(args.out, "qa", "latest.json")
    prev = load_json(qa_path) or {}
    qa = {"schemaVersion": SCHEMA_VERSION, "generated_at": NOW.isoformat(timespec="seconds"),
          "mode": args.mode, "duration_s": int(time.monotonic() - t0),
          "assets": qa_assets or prev.get("assets", []), "series": qa_series or prev.get("series", []),
          "revisions": len(rev_log)}
    issues = []
    for q in qa["assets"] + qa["series"]:
        if q.get("status") in ("thiếu", "giữ số cũ") or q.get("errors"):
            issues.append(f"{q['id']}: {q.get('status')} {'; '.join(q.get('errors', []))[:200]}")
        if q.get("stale"):
            issues.append(f"{q['id']}: số cũ {q.get('age_days')} ngày")
        if q.get("quarantine"):
            issues.append(f"{q['id']}: cách ly {len(q['quarantine'])} điểm nhảy bất thường")
        if (q.get("check") or {}).get("status") == "lệch":
            issues.append(f"{q['id']}: lệch nguồn đối chiếu {q['check'].get('max_diff')}")
        if q.get("bad_units"):
            issues.append(f"{q['id']}: giá trị ngoài khoảng hợp lý")
        if q.get("future") or q.get("dupes"):
            issues.append(f"{q['id']}: ngày tương lai hoặc trùng")
    qa["issues"] = issues
    write_if_changed(qa_path, qa, keys_ignore=("generated_at", "duration_s"))
    write_if_changed(os.path.join(args.out, "qa", f"{TODAY.isoformat()}.json"), qa,
                     keys_ignore=("generated_at", "duration_s"))
    if rev_log:
        rpath = os.path.join(args.out, "revisions", f"{TODAY:%Y-%m}.json")
        old = load_json(rpath) or []
        write_if_changed(rpath, old + rev_log[:5000])
    catalog = {"schemaVersion": SCHEMA_VERSION, "assets": [], "series": []}
    for a in ASSETS:
        doc = load_json(os.path.join(args.out, "prices", f"{a['id']}.json"))
        if doc:
            catalog["assets"].append({k: doc.get(k) for k in ("id", "name", "group", "kind", "unit", "forecast",
                                                              "source", "check")}
                                     | {"first": doc["d"][0], "last": doc["d"][-1], "n": len(doc["d"])})
    for s in SERIES:
        doc = load_json(os.path.join(args.out, "series", f"{s['id']}.json"))
        if doc:
            catalog["series"].append({k: doc.get(k) for k in ("id", "name", "region", "factor", "sign",
                                                              "transform", "unit", "freq", "pubLagDays", "source")}
                                     | {"first": doc["d"][0], "last": doc["d"][-1], "n": len(doc["d"])})
    write_if_changed(os.path.join(args.out, "catalog.json"), catalog)
    print(f"Xong trong {qa['duration_s']} giây; {len(issues)} vấn đề; {len(rev_log)} số bị sửa.")
    for line in issues:
        print(" -", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
