#!/usr/bin/env python3
"""Gọi thử các nguồn số liệu ứng viên cho macro-radar 2 (giai đoạn G0, dùng lại ở G2).

Mỗi probe gọi một nguồn một hoặc vài lần rồi ghi lại: mã HTTP, thời gian phản hồi,
số quan sát, ngày đầu, ngày cuối, giá trị cuối, tần suất suy ra, độ cũ và lỗi nếu có.
Script không dừng giữa chừng: lỗi của từng probe được bắt và ghi vào kết quả. Mỗi
request có giới hạn thời gian tổng; cả lần chạy có hạn chót, probe chưa kịp chạy
được ghi là "bỏ qua".

Cách chạy:
    python jobs/probe.py --out data            # chạy tất cả
    python jobs/probe.py --out data --only px  # chỉ các probe có id bắt đầu bằng "px"
    python jobs/probe.py --list                # in danh sách probe

Biến môi trường tùy chọn: FRED_API_KEY (dùng API chính thức của FRED thay cho fredgraph.csv).
Đầu ra: <out>/probe.json (đầy đủ) và <out>/probe.md (bảng tóm tắt tiếng Việt).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import platform
import re
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable
from urllib.parse import quote

import requests

USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
CONNECT_TIMEOUT_S = 10         # giây chờ kết nối
READ_TIMEOUT_S = 20            # giây chờ tối đa giữa hai gói dữ liệu
TOTAL_CAP_S = 45               # giây tối đa cho cả một request, kể cả tải nội dung
MAX_BYTES = 40_000_000         # byte tối đa cho một phản hồi
RUN_DEADLINE_S = 13 * 60       # giây; probe chưa bắt đầu khi quá hạn thì ghi "bỏ qua"
DEFAULT_DELAY_S = 0.3          # giây nghỉ giữa hai request tới cùng host
HOST_DELAY_S = {               # host có giới hạn tần suất chặt hơn
    "api.coingecko.com": 2.5,
    "community-api.coinmetrics.io": 0.7,
}
LIB_TIMEOUT_S = 300            # giây tối đa cho probe thư viện (subprocess)
MAX_WORKERS = 12               # số host gọi song song
START = time.monotonic()
NOW = dt.datetime.now(dt.timezone.utc)
TODAY = NOW.date()
VNINDEX_BASE_TS = int(dt.datetime(2000, 7, 28, tzinfo=dt.timezone.utc).timestamp())
VN_UTC_OFFSET_S = 7 * 3600     # giờ Việt Nam = UTC+7
FRED_API_KEY = os.environ.get("FRED_API_KEY", "").strip()

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept": "*/*",
                        "Accept-Language": "en-US,en;q=0.9"})


# ---------------------------------------------------------------- tiện ích

def http_get(url: str, params: dict | None = None, headers: dict | None = None,
             read_timeout: float = READ_TIMEOUT_S, cap: float = TOTAL_CAP_S) -> tuple[requests.Response, int]:
    """GET có giới hạn thời gian tổng `cap` giây và kích thước MAX_BYTES; trả (response, ms)."""
    t0 = time.monotonic()
    resp = SESSION.get(url, params=params, headers=headers, stream=True,
                       timeout=(CONNECT_TIMEOUT_S, read_timeout))
    buf = bytearray()
    try:
        for chunk in resp.iter_content(chunk_size=65536):
            buf.extend(chunk)
            if time.monotonic() - t0 > cap:
                raise TimeoutError(f"quá {cap:.0f} giây khi tải nội dung")
            if len(buf) > MAX_BYTES:
                raise ValueError("phản hồi quá 40 MB")
    finally:
        resp.close()
    resp._content = bytes(buf)  # để .text và .json() đọc được sau khi đã stream
    return resp, int((time.monotonic() - t0) * 1000)


def as_json(resp: requests.Response):
    """JSON đã parse, hoặc None nếu phản hồi không phải JSON."""
    try:
        return resp.json()
    except ValueError:
        return None


def snippet(text: str | None, n: int = 240) -> str:
    """Rút gọn văn bản về một dòng, tối đa n ký tự."""
    return re.sub(r"\s+", " ", text or "").strip()[:n]


def utc_date(ts: float) -> str:
    """Unix giây → ngày ISO theo UTC."""
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat()


def parse_date(s: str, fmt: str) -> str:
    """Chuỗi ngày theo định dạng fmt → ngày ISO."""
    return dt.datetime.strptime(s.strip(), fmt).date().isoformat()


def infer_freq(dates: list[dt.date]) -> str:
    """Suy tần suất từ trung vị khoảng cách giữa 200 quan sát cuối."""
    tail = dates[-201:]
    gaps = sorted((b - a).days for a, b in zip(tail, tail[1:]))
    if not gaps:
        return "?"
    med = gaps[len(gaps) // 2]
    if med <= 4:
        return "D"
    if med <= 8:
        return "W"
    if med <= 35:
        return "M"
    if med <= 100:
        return "Q"
    return "A"


def summarize(pairs) -> dict:
    """Tóm tắt chuỗi [(ngày ISO, giá trị)]: n, ngày đầu/cuối, giá trị cuối, tần suất, số năm, độ cũ."""
    clean: dict[str, float] = {}
    for d, v in pairs:
        if not d or v is None:
            continue
        try:
            fv = float(str(v).replace(",", "")) if isinstance(v, str) else float(v)
        except (TypeError, ValueError):
            continue
        if fv != fv:  # NaN
            continue
        clean[str(d)[:10]] = fv
    if not clean:
        return {"n": 0}
    keys = sorted(clean)
    dates = [dt.date.fromisoformat(k) for k in keys]
    return {
        "n": len(keys), "first": keys[0], "last": keys[-1], "last_value": clean[keys[-1]],
        "freq": infer_freq(dates),
        "span_years": round((dates[-1] - dates[0]).days / 365.25, 1),
        "age_days": (TODAY - dates[-1]).days,
    }


def fail(resp: requests.Response | None, ms: int | None, msg: str) -> dict:
    """Bản ghi lỗi chuẩn, kèm mã HTTP và đoạn đầu phản hồi."""
    out: dict = {"ok": False, "error": msg}
    if resp is not None:
        out.update(status=resp.status_code, ms=ms,
                   content_type=resp.headers.get("content-type", "")[:60],
                   snippet=snippet(resp.text))
    return out


def find_key(row: dict, *cands: str) -> str | None:
    """Khóa đầu tiên có chứa một trong các chuỗi cands (không phân biệt hoa thường)."""
    return next((k for k in row if any(c.lower() in k.lower() for c in cands)), None)


def per_area_csv(text: str, area_col: str) -> dict:
    """CSV SDMX (TIME_PERIOD, OBS_VALUE) → tóm tắt theo từng giá trị của cột area_col."""
    per = defaultdict(list)
    for r in csv.DictReader(io.StringIO(text)):
        tp = r.get("TIME_PERIOD", "")
        per[r.get(area_col, "?")].append((tp + "-01" if len(tp) == 7 else tp, r.get("OBS_VALUE")))
    return {a: summarize(p) for a, p in per.items()}


# ---------------------------------------------------------------- FRED

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv"
FRED_API = "https://api.stlouisfed.org/fred/series/observations"
FRED_UAS = [
    ("curl", "curl/8.5.0"),
    ("bot", "macro-radar-2/0.1 (+https://github.com/MikeNguyen25/claude-macro-radar-2)"),
    ("browser", USER_AGENT),
]
FRED_STATE: dict = {"ua": None}  # UA đầu tiên được fredgraph trả lời; probe biến thể ghi vào


def fred_csv(sid: str, ua: str, extra: dict | None = None, cap: float = TOTAL_CAP_S):
    """CSV một chuỗi FRED; trả (resp, ms, rows hoặc None)."""
    resp, ms = http_get(FRED_CSV, {"id": sid, **(extra or {})}, headers={"User-Agent": ua},
                        read_timeout=15, cap=cap)
    head = resp.text.splitlines()[0] if resp.text else ""
    if resp.status_code != 200 or "," not in head or "<" in head:
        return resp, ms, None
    return resp, ms, list(csv.reader(io.StringIO(resp.text)))


def fred_pairs(rows: list) -> tuple[list, list]:
    """Tách cặp (ngày, giá trị) và danh sách ngày thiếu số ('.' hoặc rỗng)."""
    pairs, missing = [], []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        if row[1].strip() in ("", "."):
            missing.append(row[0][:10])
        else:
            pairs.append((row[0][:10], row[1]))
    return pairs, missing


def with_missing(out: dict, missing: list) -> dict:
    """Ghi các ngày thiếu số trong 2 năm gần nhất (để QA biết lỗ hổng)."""
    cutoff = (TODAY - dt.timedelta(days=730)).isoformat()
    recent = [d for d in missing if d >= cutoff]
    if recent:
        out["missing_recent_count"] = len(recent)
        out["missing_recent"] = recent[-12:]
    return out


def p_fred_ua(label: str, ua: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms, rows = fred_csv("UNRATE", ua, cap=25)
        if rows is None:
            return fail(resp, ms, f"fredgraph với UA {label} không trả CSV")
        if FRED_STATE["ua"] is None:
            FRED_STATE["ua"] = ua
        pairs, _ = fred_pairs(rows)
        out = {"ok": True, "status": resp.status_code, "ms": ms, "ua": label}
        out.update(summarize(pairs))
        return out
    return run


def p_fred_api_nokey() -> dict:
    resp, ms = http_get(FRED_API, {"series_id": "UNRATE", "file_type": "json"}, read_timeout=12, cap=20)
    return {"ok": resp.status_code in (200, 400), "status": resp.status_code, "ms": ms,
            "snippet": snippet(resp.text, 160), "note": "mã 400 = API trả lời, chỉ thiếu api_key"}


def fred_via_api(sid: str) -> dict:
    resp, ms = http_get(FRED_API, {"series_id": sid, "api_key": FRED_API_KEY, "file_type": "json"})
    j = as_json(resp) or {}
    obs = j.get("observations") if isinstance(j, dict) else None
    if resp.status_code != 200 or not obs:
        return fail(resp, ms, "FRED API lỗi")
    pairs = [(o["date"], o["value"]) for o in obs if o.get("value") not in (None, ".")]
    missing = [o["date"] for o in obs if o.get("value") == "."]
    out = {"ok": bool(pairs), "status": resp.status_code, "ms": ms, "via": "api"}
    out.update(summarize(pairs))
    return with_missing(out, missing)


def p_fred(sid: str) -> Callable[[], dict]:
    def run() -> dict:
        if FRED_API_KEY:
            return fred_via_api(sid)
        ua = FRED_STATE["ua"]
        if ua is None:
            return {"ok": False, "error": "bỏ qua: fredgraph không trả lời máy GitHub với mọi UA đã thử"}
        resp, ms, rows = fred_csv(sid, ua)
        if rows is None:
            return fail(resp, ms, "FRED không trả CSV")
        pairs, missing = fred_pairs(rows)
        out = {"ok": bool(pairs), "status": resp.status_code, "ms": ms, "header": ",".join(rows[0])[:60]}
        out.update(summarize(pairs))
        return with_missing(out, missing)
    return run


def p_fred_vintage() -> dict:
    """PAYEMS như công bố ngày 2020-02-10: FRED có trả số theo vintage mà không cần khóa API không."""
    ua = FRED_STATE["ua"]
    if ua is None:
        return {"ok": False, "error": "bỏ qua: fredgraph không trả lời máy GitHub"}
    vint = "2020-02-10"
    resp, ms, rows = fred_csv("PAYEMS", ua, {"vintage_date": vint, "revision_date": vint})
    if rows is None:
        return fail(resp, ms, "không lấy được vintage")
    vmap = dict(fred_pairs(rows)[0])
    time.sleep(DEFAULT_DELAY_S)
    _, _, rows2 = fred_csv("PAYEMS", ua)
    cmap = dict(fred_pairs(rows2)[0]) if rows2 else {}
    last_v = max(vmap) if vmap else None
    month = "2019-12-01"
    out = {"ok": bool(vmap), "status": resp.status_code, "ms": ms, "vintage_date": vint,
           "vintage_last_obs": last_v, "value_2019_12_vintage": vmap.get(month),
           "value_2019_12_current": cmap.get(month)}
    out["vintage_works"] = bool(last_v and last_v <= "2020-01-01"
                                and out["value_2019_12_vintage"] != out["value_2019_12_current"])
    return out


# ---------------------------------------------------------------- crypto

CM_URL = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
CG = "https://api.coingecko.com/api/v3"
CG_IDS = ["bitcoin", "ethereum", "solana", "dogecoin", "tron"]
BINANCE_VISION = "https://data-api.binance.vision/api/v3/klines"


def p_coinmetrics(asset: str) -> Callable[[], dict]:
    def run() -> dict:
        base = {"assets": asset, "metrics": "PriceUSD", "frequency": "1d", "page_size": 1}
        r1, ms1 = http_get(CM_URL, {**base, "paging_from": "start", "start_time": "2009-01-01"},
                           read_timeout=50, cap=60)
        j1 = as_json(r1) or {}
        if r1.status_code != 200 or not j1.get("data"):
            return fail(r1, ms1, "PriceUSD: không có điểm đầu")
        time.sleep(HOST_DELAY_S["community-api.coinmetrics.io"])
        r2, ms2 = http_get(CM_URL, {**base, "paging_from": "end",
                                    "start_time": (TODAY - dt.timedelta(days=10)).isoformat()},
                           read_timeout=50, cap=60)
        j2 = as_json(r2) or {}
        if not j2.get("data"):
            return fail(r2, ms2, "PriceUSD: không có điểm cuối")
        first, last = j1["data"][0]["time"][:10], j2["data"][0]["time"][:10]
        d0, d1 = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
        return {"ok": True, "status": r2.status_code, "ms": ms1 + ms2, "first": first, "last": last,
                "last_value": float(j2["data"][0]["PriceUSD"]), "n": (d1 - d0).days + 1, "freq": "D",
                "span_years": round((d1 - d0).days / 365.25, 1), "age_days": (TODAY - d1).days,
                "note": "n = số ngày từ đầu tới cuối"}
    return run


def p_binance_vision(symbol: str) -> Callable[[], dict]:
    """Nến ngày UTC của Binance qua data-api.binance.vision: nến đầu tiên và nến đã đóng gần nhất."""
    def run() -> dict:
        r1, ms1 = http_get(BINANCE_VISION, {"symbol": symbol, "interval": "1d", "startTime": 0, "limit": 1})
        j1 = as_json(r1)
        if r1.status_code != 200 or not isinstance(j1, list) or not j1:
            return fail(r1, ms1, "Binance vision lỗi")
        time.sleep(DEFAULT_DELAY_S)
        r2, ms2 = http_get(BINANCE_VISION, {"symbol": symbol, "interval": "1d", "limit": 3})
        j2 = as_json(r2)
        if not isinstance(j2, list) or len(j2) < 2:
            return fail(r2, ms2, "Binance vision: thiếu nến gần nhất")
        closed = j2[-2]  # nến cuối cùng là ngày đang chạy
        first, last = utc_date(j1[0][0] / 1000), utc_date(closed[0] / 1000)
        d0, d1 = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
        return {"ok": True, "status": r2.status_code, "ms": ms1 + ms2, "first": first, "last": last,
                "last_value": float(closed[4]), "n": (d1 - d0).days + 1, "freq": "D",
                "span_years": round((d1 - d0).days / 365.25, 1), "age_days": (TODAY - d1).days,
                "note": "nến ngày UTC; n = số ngày"}
    return run


def p_cg_simple() -> dict:
    resp, ms = http_get(f"{CG}/simple/price", {"ids": ",".join(CG_IDS), "vs_currencies": "usd",
                                               "include_last_updated_at": "true"})
    j = as_json(resp)
    if resp.status_code != 200 or not isinstance(j, dict) or not j:
        return fail(resp, ms, "simple/price lỗi")
    vals = {k: (v or {}).get("usd") for k, v in j.items()}
    upd = max(((v or {}).get("last_updated_at") or 0) for v in j.values())
    return {"ok": all(vals.get(i) for i in CG_IDS), "status": resp.status_code, "ms": ms,
            "values": vals, "last": utc_date(upd) if upd else None}


def p_kraken(pair: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get("https://api.kraken.com/0/public/OHLC", {"pair": pair, "interval": 1440})
        j = as_json(resp)
        if not isinstance(j, dict) or j.get("error") or not j.get("result"):
            return fail(resp, ms, f"Kraken: {j.get('error') if isinstance(j, dict) else 'không phải JSON'}")
        key = next(k for k in j["result"] if k != "last")
        out = {"ok": True, "status": resp.status_code, "ms": ms, "pair_key": key,
               "note": "chỉ 720 nến gần nhất; nến cuối là ngày đang chạy"}
        out.update(summarize([(utc_date(int(r[0])), r[4]) for r in j["result"][key]]))
        return out
    return run


# ---------------------------------------------------------------- chỉ số, hàng hóa, tỷ giá

YH_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"
CNBC_QUOTE = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
CNBC_SYMS = [".STI", ".SETI", ".SPX", ".IXIC", ".DXY", "@LCO.1", "@GC.1", "VND=", "US10Y"]
PINK_SHEET = ("https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/"
              "related/CMO-Historical-Data-Monthly.xlsx")


def p_yahoo(sym: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get(YH_CHART + quote(sym, safe=""), {"range": "max", "interval": "1mo"})
        j = as_json(resp)
        chart = ((j or {}).get("chart") or {}) if isinstance(j, dict) else {}
        res = (chart.get("result") or [None])[0]
        if resp.status_code != 200 or not res:
            return fail(resp, ms, f"Yahoo lỗi: {chart.get('error') or snippet(resp.text, 80)}"[:200])
        off = (res.get("meta") or {}).get("gmtoffset") or 0
        closes = (((res.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
        out = {"ok": True, "status": resp.status_code, "ms": ms}
        out.update(summarize([(utc_date(t + off), c) for t, c in zip(res.get("timestamp") or [], closes)]))
        return out
    return run


def p_stooq(sym: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get("https://stooq.com/q/d/l/", {"s": sym, "i": "m"})
        if not resp.text.startswith("Date,"):
            return fail(resp, ms, "Stooq không trả CSV (cần apikey)")
        rows = list(csv.reader(io.StringIO(resp.text)))
        idx = rows[0].index("Close")
        out = {"ok": True, "status": resp.status_code, "ms": ms}
        out.update(summarize([(r[0], r[idx]) for r in rows[1:] if len(r) > idx]))
        return out
    return run


def p_cnbc_quote() -> dict:
    params = {"symbols": "|".join(CNBC_SYMS), "requestMethod": "itv", "noform": "1", "partnerId": "2",
              "fund": "1", "exthrs": "1", "output": "json", "events": "1"}
    resp, ms = http_get(CNBC_QUOTE, params)
    j = as_json(resp)
    fq = (((j or {}).get("FormattedQuoteResult") or {}).get("FormattedQuote")) if isinstance(j, dict) else None
    if resp.status_code != 200 or not fq:
        return fail(resp, ms, "CNBC quote lỗi")
    quotes = {q.get("symbol"): {"last": q.get("last"), "time": q.get("last_time"),
                                "name": (q.get("name") or "")[:40]} for q in fq}
    return {"ok": True, "status": resp.status_code, "ms": ms, "quotes": quotes,
            "note": "chỉ có giá hiện tại"}


def p_cnbc_bars(sym: str) -> Callable[[], dict]:
    def run() -> dict:
        url = (f"https://ts-api.cnbc.com/harmony/app/bars/{quote(sym, safe='')}/1D/"
               f"19900101000000/{TODAY:%Y%m%d}000000/adjusted/EST5EDT.json")
        resp, ms = http_get(url, cap=60)
        j = as_json(resp)
        bars = (((j or {}).get("barData") or {}).get("priceBars") or []) if isinstance(j, dict) else []
        if resp.status_code != 200 or not bars:
            return fail(resp, ms, f"CNBC bars {sym} lỗi")
        pairs = []
        for b in bars:
            t = str(b.get("tradeTime") or "")
            pairs.append((f"{t[:4]}-{t[4:6]}-{t[6:8]}" if len(t) >= 8 else None, b.get("close")))
        out = {"ok": True, "status": resp.status_code, "ms": ms}
        out.update(summarize(pairs))
        return out
    return run


def p_pink_sheet() -> dict:
    """World Bank Pink Sheet (giá hàng hóa theo tháng): tải file và đọc cột Brent, Gold nếu có openpyxl."""
    resp, ms = http_get(PINK_SHEET, cap=90)
    if resp.status_code != 200 or resp.content[:2] != b"PK":
        return fail(resp, ms, "Pink Sheet không tải được")
    out: dict = {"ok": True, "status": resp.status_code, "ms": ms, "bytes": len(resp.content)}
    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(resp.content), read_only=True, data_only=True)
        rows = list(wb["Monthly Prices"].iter_rows(values_only=True))
        hdr_i = next(i for i, r in enumerate(rows[:15])
                     if r and any(isinstance(c, str) and "Brent" in c for c in r))
        hdr = rows[hdr_i]

        def mdate(v) -> str | None:
            m = re.match(r"(\d{4})M(\d{2})", str(v or ""))
            return f"{m.group(1)}-{m.group(2)}-01" if m else None

        for name, key in (("brent", "Brent"), ("gold", "Gold")):
            j = next(k for k, c in enumerate(hdr) if isinstance(c, str) and key in c)
            out[name] = summarize([(mdate(r[0]), r[j]) for r in rows[hdr_i + 1:]
                                   if r and mdate(r[0]) and isinstance(r[j], (int, float))])
        out.update(first=out["gold"].get("first"), last=out["gold"].get("last"), freq="M")
    except Exception as e:  # noqa: BLE001
        out["parse_error"] = f"{type(e).__name__}: {e}"[:200]
    return out


def p_eia_xls() -> dict:
    resp, ms = http_get("https://www.eia.gov/dnav/pet/hist_xls/RBRTEd.xls", cap=60)
    ok = resp.status_code == 200 and len(resp.content) > 10_000
    return {"ok": ok, "status": resp.status_code, "ms": ms, "bytes": len(resp.content),
            "content_type": resp.headers.get("content-type", "")[:60],
            "note": "Brent ngày từ EIA (file .xls, cần xlrd để đọc)"}


def p_lbma(kind: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get(f"https://prices.lbma.org.uk/json/{kind}.json")
        j = as_json(resp)
        if resp.status_code != 200 or not isinstance(j, list):
            return fail(resp, ms, "LBMA không trả JSON")
        out = {"ok": True, "status": resp.status_code, "ms": ms}
        out.update(summarize([(x.get("d"), ((x.get("v") or [None])[0] or None)) for x in j]))
        return out
    return run


def p_vcb() -> dict:
    resp, ms = http_get("https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx")
    tag = re.search(r'<Exrate[^>]*CurrencyCode="USD"[^>]*>', resp.text or "")
    if resp.status_code != 200 or not tag:
        return fail(resp, ms, "Vietcombank XML lỗi")
    attrs = dict(re.findall(r'(\w+)="([^"]*)"', tag.group(0)))
    stamp = re.search(r"<DateTime>(.*?)</DateTime>", resp.text)
    return {"ok": True, "status": resp.status_code, "ms": ms, "last": stamp.group(1) if stamp else None,
            "last_value": attrs.get("Sell"), "buy": attrs.get("Buy"), "transfer": attrs.get("Transfer"),
            "note": "chỉ có tỷ giá hiện tại"}


def p_erapi() -> dict:
    resp, ms = http_get("https://open.er-api.com/v6/latest/USD")
    j = as_json(resp) or {}
    vnd = (j.get("rates") or {}).get("VND") if isinstance(j, dict) else None
    if not vnd:
        return fail(resp, ms, "không có VND")
    return {"ok": True, "status": resp.status_code, "ms": ms, "last_value": vnd,
            "last": j.get("time_last_update_utc"), "note": "chỉ có tỷ giá mới nhất"}


def p_fawaz(tag: str, cur: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get(f"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{tag}/v1/currencies/usd.json")
        j = as_json(resp) or {}
        val = (j.get("usd") or {}).get(cur) if isinstance(j, dict) else None
        if not val:
            return fail(resp, ms, f"không có {cur}")
        return {"ok": True, "status": resp.status_code, "ms": ms, "last": j.get("date"), "last_value": val,
                "note": "1 USD đổi ra" + (" ounce vàng" if cur == "xau" else " VND")}
    return run


def p_treasury(year: int) -> Callable[[], dict]:
    def run() -> dict:
        url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
               f"daily-treasury-rates.csv/{year}/all")
        resp, ms = http_get(url, {"type": "daily_treasury_yield_curve", "field_tdr_date_value": year,
                                  "page": "", "_format": "csv"})
        rows = list(csv.reader(io.StringIO(resp.text))) if resp.status_code == 200 else []
        if not rows or "10 Yr" not in rows[0]:
            return fail(resp, ms, "Treasury CSV lỗi")
        i = rows[0].index("10 Yr")
        out = {"ok": True, "status": resp.status_code, "ms": ms, "note": f"mỗi lần gọi một năm ({year})"}
        out.update(summarize([(parse_date(r[0], "%m/%d/%Y"), r[i]) for r in rows[1:] if len(r) > i and r[i]]))
        return out
    return run


def p_cboe_vix() -> dict:
    resp, ms = http_get("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv")
    rows = list(csv.reader(io.StringIO(resp.text))) if resp.status_code == 200 else []
    hdr = [h.strip().upper() for h in rows[0]] if rows else []
    if "CLOSE" not in hdr:
        return fail(resp, ms, "Cboe CSV lỗi")
    i = hdr.index("CLOSE")
    out = {"ok": True, "status": resp.status_code, "ms": ms}
    out.update(summarize([(parse_date(r[0], "%m/%d/%Y"), r[i]) for r in rows[1:] if len(r) > i]))
    return out


def p_ecb_exr() -> dict:
    """Tỷ giá tham chiếu ECB của 6 đồng tiền trong rổ DXY (để tính DXY tổng hợp)."""
    url = "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CAD+SEK+CHF.EUR.SP00.A"
    resp, ms = http_get(url, {"format": "csvdata", "startPeriod": "1999-01-01"}, cap=90)
    if resp.status_code != 200 or "TIME_PERIOD" not in resp.text[:3000]:
        return fail(resp, ms, "ECB EXR lỗi")
    cur = per_area_csv(resp.text, "CURRENCY")
    usd = cur.get("USD", {})
    return {"ok": len(cur) == 6, "status": 200, "ms": ms, "currencies": cur, "first": usd.get("first"),
            "last": usd.get("last"), "n": usd.get("n"), "freq": usd.get("freq"), "age_days": usd.get("age_days"),
            "note": "đủ 6 đồng tiền thì tính được DXY tổng hợp"}


# ---------------------------------------------------------------- Việt Nam, Đông Nam Á

def tv_style(url: str, params: dict, label: str) -> dict:
    """Nguồn kiểu TradingView: JSON có mảng t (giây) và c (đóng cửa); ngày theo giờ Việt Nam."""
    resp, ms = http_get(url, params)
    j = as_json(resp)
    if resp.status_code != 200 or not isinstance(j, dict) or not j.get("t"):
        return fail(resp, ms, f"{label}: không có mảng t/c")
    out = {"ok": True, "status": resp.status_code, "ms": ms}
    out.update(summarize([(utc_date(t + VN_UTC_OFFSET_S), c) for t, c in zip(j["t"], j.get("c", []))]))
    return out


def p_vndirect() -> dict:
    return tv_style("https://dchart-api.vndirect.com.vn/dchart/history",
                    {"resolution": "D", "symbol": "VNINDEX", "from": VNINDEX_BASE_TS,
                     "to": int(NOW.timestamp())}, "VNDirect")


def p_dnse() -> dict:
    return tv_style("https://services.entrade.com.vn/chart-api/v2/ohlcs/index",
                    {"from": VNINDEX_BASE_TS, "to": int(NOW.timestamp()), "symbol": "VNINDEX",
                     "resolution": "1D"}, "DNSE")


CAFEF = "https://s.cafef.vn/Ajax/PageNew/DataHistory/"


def p_cafef(endpoint: str, label: str) -> Callable[[], dict]:
    """cafef phân trang: dòng mới nhất (trang 1) và dòng cũ nhất (trang cuối, cỡ trang 1)."""
    def run() -> dict:
        base = {"Symbol": "VNINDEX", "StartDate": "", "EndDate": ""}
        resp, ms = http_get(CAFEF + endpoint, {**base, "PageIndex": 1, "PageSize": 1})
        j = as_json(resp)
        data = j.get("Data") if isinstance(j, dict) else None
        rows = data.get("Data") if isinstance(data, dict) else None
        if resp.status_code != 200 or not rows:
            return fail(resp, ms, f"cafef {label}: không có Data")
        total = int(data.get("TotalCount") or 0)
        latest = rows[0]
        dkey = find_key(latest, "ngay", "date")
        out = {"ok": True, "status": resp.status_code, "ms": ms, "n": total,
               "fields": list(latest.keys())[:16],
               "latest_row": json.dumps(latest, ensure_ascii=False)[:300]}
        if dkey:
            out["last"] = parse_date(str(latest[dkey]), "%d/%m/%Y")
            out["age_days"] = (TODAY - dt.date.fromisoformat(out["last"])).days
        if total > 1 and dkey:
            time.sleep(DEFAULT_DELAY_S)
            resp2, _ = http_get(CAFEF + endpoint, {**base, "PageIndex": total, "PageSize": 1})
            j2 = as_json(resp2)
            rows2 = ((j2.get("Data") or {}).get("Data") or []) if isinstance(j2, dict) else []
            if rows2 and dkey in rows2[0]:
                out["first"] = parse_date(str(rows2[0][dkey]), "%d/%m/%Y")
        return out
    return run


def p_set_web() -> dict:
    resp, ms = http_get("https://www.set.or.th/api/set/index/SET/chart-quotation",
                        {"period": "1Y", "accumulated": "false"})
    if resp.status_code != 200 or as_json(resp) is None:
        return fail(resp, ms, "set.or.th API lỗi")
    return {"ok": True, "status": resp.status_code, "ms": ms, "snippet": snippet(resp.text)}


# ---------------------------------------------------------------- tổ chức quốc tế, Trung Quốc

WB_DATE = re.compile(r"^(\d{4})(?:M(\d{2})|Q(\d))?$")


def wb_date(s: str) -> str | None:
    """'2026M09' → '2026-09-01'; '2026Q3' → '2026-07-01'; '2026' → '2026-01-01'."""
    m = WB_DATE.match(s or "")
    if not m:
        return None
    y, mo, q = m.groups()
    if mo:
        return f"{y}-{mo}-01"
    if q:
        return f"{y}-{(int(q) - 1) * 3 + 1:02d}-01"
    return f"{y}-01-01"


def p_wb_gem(iso3: str, code: str) -> Callable[[], dict]:
    def run() -> dict:
        url = f"https://api.worldbank.org/v2/country/{iso3}/indicator/{code}"
        statuses, msg, best = [], "", None
        for extra in ({"frequency": "M"}, {"frequency": "Q"}, {}):
            resp, ms = http_get(url, {"source": 15, "format": "json", "per_page": 20000, **extra})
            statuses.append(resp.status_code)
            j = as_json(resp)
            if isinstance(j, list) and len(j) > 1 and j[1]:
                pairs = [(wb_date(x.get("date", "")), x.get("value")) for x in j[1]]
                out = {"ok": True, "status": resp.status_code, "ms": ms, "params": extra,
                       "sample_date": j[1][0].get("date")}
                out.update(summarize([(d, v) for d, v in pairs if d]))
                if out.get("n") and out.get("freq") in ("M", "Q"):
                    return out
                best = best or out
            else:
                msg = snippet(json.dumps(j[0]) if isinstance(j, list) and j else resp.text)
            time.sleep(DEFAULT_DELAY_S)
        if best:
            return best
        return {"ok": False, "status": statuses, "error": "World Bank GEM không trả số liệu", "snippet": msg}
    return run


def p_dbn_providers() -> dict:
    resp, ms = http_get("https://api.db.nomics.world/v22/providers")
    j = as_json(resp) or {}
    docs = ((j.get("providers") or {}).get("docs") or []) if isinstance(j, dict) else []
    codes = sorted(d.get("code") for d in docs if d.get("code"))
    want = ["NBS", "PBOC", "IMF", "BIS", "OECD", "WB", "ECB", "BOJ", "ISM", "Eurostat", "FED", "ADB", "GSO", "SBV"]
    if not codes:
        return fail(resp, ms, "DBnomics providers lỗi")
    return {"ok": True, "status": resp.status_code, "ms": ms, "n": len(codes),
            "present": {w: (w in codes) for w in want}, "codes": codes}


def p_dbn_search(q: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get("https://api.db.nomics.world/v22/search", {"q": q, "limit": 8})
        j = as_json(resp) or {}
        docs = ((j.get("results") or {}).get("docs") or []) if isinstance(j, dict) else []
        hits = [{"provider": d.get("provider_code"), "dataset": d.get("code"),
                 "name": (d.get("name") or "")[:70], "nb_series": d.get("nb_series"),
                 "nb_matching": d.get("nb_matching_series"),
                 "indexed_at": (d.get("indexed_at") or "")[:10]} for d in docs]
        if not hits:
            return fail(resp, ms, "DBnomics search không có kết quả")
        return {"ok": True, "status": resp.status_code, "ms": ms, "hits": hits}
    return run


def p_imf_datamapper() -> dict:
    resp, ms = http_get("https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/WEOWORLD")
    j = as_json(resp) or {}
    vals = ((((j.get("values") or {}).get("NGDP_RPCH") or {}).get("WEOWORLD")) or {}) if isinstance(j, dict) else {}
    if not vals:
        return fail(resp, ms, "IMF DataMapper không trả số")
    years = sorted(vals)
    keep = {k: vals[k] for k in years if str(TODAY.year - 1) <= k <= str(TODAY.year + 1)}
    return {"ok": True, "status": resp.status_code, "ms": ms, "first": years[0], "last": years[-1],
            "values": keep, "freq": "A"}


def p_imf_sdmx() -> dict:
    resp, ms = http_get("https://api.imf.org/external/sdmx/2.1/dataflow", headers={"Accept": "application/xml"})
    ids = re.findall(r'<(?:\w+:)?Dataflow\b[^>]*\bid="([^"]+)"', resp.text or "")
    out = {"ok": resp.status_code == 200 and bool(ids), "status": resp.status_code, "ms": ms,
           "n": len(ids), "ids_sample": ids[:80]}
    if not ids:
        out["snippet"] = snippet(resp.text)
    return out


IMF21 = "https://api.imf.org/external/sdmx/2.1"
IMF_COUNTRY_DIMS = ("COUNTRY", "REF_AREA", "JURISDICTION")


def norm_period(tp: str) -> str | None:
    """Kỳ SDMX ('2026-M09', '2026-09', '2026-Q3', '2026', '2026-09-30') → ngày ISO đầu kỳ."""
    tp = (tp or "").strip()
    for pat, fn in (
        (r"^(\d{4})-?M(\d{2})$", lambda m: f"{m[1]}-{m[2]}-01"),
        (r"^(\d{4})-(\d{2})$", lambda m: f"{m[1]}-{m[2]}-01"),
        (r"^(\d{4})-?Q(\d)$", lambda m: f"{m[1]}-{(int(m[2]) - 1) * 3 + 1:02d}-01"),
        (r"^(\d{4})$", lambda m: f"{m[1]}-01-01"),
        (r"^(\d{4}-\d{2}-\d{2})", lambda m: m[1]),
    ):
        m = re.match(pat, tp)
        if m:
            return fn(m)
    return None


def p_imf_country(flow: str, iso3: str = "VNM", agency: str = "IMF.STA") -> Callable[[], dict]:
    """Đọc cấu trúc một dataflow IMF mới rồi lấy mọi chuỗi của một nước (SDMX 2.1)."""
    def run() -> dict:
        # Bước 1: dataflow (không kèm tham chiếu) để biết DSD; bước 2: DSD không kèm codelist (nhỏ).
        rf, msf = http_get(f"{IMF21}/dataflow/{agency}/{flow}/latest", {"references": "none"},
                           headers={"Accept": "application/xml"}, cap=60)
        ref = re.search(r"<(?:\w+:)?Structure\b[^>]*>\s*<(?:\w+:)?Ref\b([^>]*)/?>", rf.text or "", re.S)
        ra = dict(re.findall(r'(\w+)="([^"]*)"', ref.group(1))) if ref else {}
        if not ra.get("id"):
            return fail(rf, msf, f"IMF {flow}: không thấy DSD trong dataflow")
        time.sleep(DEFAULT_DELAY_S)
        r0, ms0 = http_get(f"{IMF21}/datastructure/{ra.get('agencyID', agency)}/{ra['id']}/"
                           f"{ra.get('version', 'latest')}", {"references": "none"},
                           headers={"Accept": "application/xml"}, cap=60)
        dims: list[tuple[int, str]] = []
        for tag in re.findall(r"<(?:\w+:)?Dimension\b[^>]*>", r0.text or ""):
            a = dict(re.findall(r'(\w+)="([^"]*)"', tag))
            if a.get("id") and a["id"] not in [d for _, d in dims]:
                dims.append((int(a.get("position") or len(dims) + 1), a["id"]))
        order = [d for _, d in sorted(dims)]
        if not order:
            return fail(r0, ms0, f"IMF {flow}: không đọc được cấu trúc")
        key = ".".join(iso3 if d in IMF_COUNTRY_DIMS else "" for d in order)
        time.sleep(DEFAULT_DELAY_S)
        r1, ms1 = http_get(f"{IMF21}/data/{agency},{flow}/{key}", {"startPeriod": "1990"},
                           headers={"Accept": "application/vnd.sdmx.data+csv;version=1.0.0"}, cap=90)
        series: dict[str, list] = defaultdict(list)
        text = r1.text or ""
        if r1.status_code == 200 and "TIME_PERIOD" in text[:5000] and "<" not in text[:5]:
            for row in csv.DictReader(io.StringIO(text)):
                skey = ".".join(row.get(d, "") for d in order)
                series[skey].append((norm_period(row.get("TIME_PERIOD", "")), row.get("OBS_VALUE")))
        else:
            for attrs, body in re.findall(r"<(?:\w+:)?Series\b([^>]*)>(.*?)</(?:\w+:)?Series>", text, re.S):
                a = dict(re.findall(r'(\w+)="([^"]*)"', attrs))
                skey = ".".join(a.get(d, "") for d in order)
                for obs in re.findall(r"<(?:\w+:)?Obs\b([^>]*)/?>", body):
                    o = dict(re.findall(r'(\w+)="([^"]*)"', obs))
                    series[skey].append((norm_period(o.get("TIME_PERIOD", "")), o.get("OBS_VALUE")))
        summ = {k: summarize(v) for k, v in series.items()}
        summ = {k: s for k, s in summ.items() if s.get("n")}
        if not summ:
            out = fail(r1, ms1, f"IMF {flow}: không có chuỗi nào cho {iso3}")
            out.update(dims=order, key=key, dsd=ra.get("id"))
            return out
        top = sorted(summ.items(), key=lambda kv: (kv[1].get("freq") != "M", -(kv[1].get("n") or 0)))[:25]
        monthly = [s for s in summ.values() if s.get("freq") == "M"]
        best = max(monthly or list(summ.values()), key=lambda s: s.get("n") or 0)
        return {"ok": True, "status": r1.status_code, "ms": msf + ms0 + ms1, "dims": order, "key": key,
                "dsd": ra.get("id"), "n_series": len(summ), "n_monthly": len(monthly), "found": dict(top),
                "first": best.get("first"), "last": best.get("last"), "freq": best.get("freq"),
                "age_days": best.get("age_days")}
    return run


def p_bis_cbpol(areas: str) -> Callable[[], dict]:
    def run() -> dict:
        urls = [f"https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.{areas}",
                f"https://stats.bis.org/api/v1/data/WS_CBPOL/M.{areas}/all"]
        last_fail: dict = {"ok": False}
        for url in urls:
            resp, ms = http_get(url, {"format": "csv", "startPeriod": "1990-01"})
            if resp.status_code == 200 and "TIME_PERIOD" in resp.text[:3000]:
                return {"ok": True, "status": 200, "ms": ms, "url_used": url,
                        "areas": per_area_csv(resp.text, "REF_AREA")}
            last_fail = fail(resp, ms, "BIS không trả CSV")
            time.sleep(DEFAULT_DELAY_S)
        return last_fail
    return run


def p_oecd_cli() -> dict:
    url = ("https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,/"
           "USA+CHN+G20.M.LI...AA...H")
    resp, ms = http_get(url, {"startPeriod": "1990-01", "format": "csvfilewithlabels"})
    if resp.status_code != 200 or "TIME_PERIOD" not in resp.text[:5000]:
        return fail(resp, ms, "OECD CLI lỗi")
    return {"ok": True, "status": 200, "ms": ms, "areas": per_area_csv(resp.text, "REF_AREA")}


def p_ecb_dfr() -> dict:
    last_fail: dict = {"ok": False}
    for key in ("D.U2.EUR.4F.KR.DFR.LEV", "B.U2.EUR.4F.KR.DFR.LEV"):
        resp, ms = http_get(f"https://data-api.ecb.europa.eu/service/data/FM/{key}", {"format": "csvdata"})
        if resp.status_code == 200 and "TIME_PERIOD" in resp.text[:3000]:
            rows = list(csv.DictReader(io.StringIO(resp.text)))
            out = {"ok": True, "status": 200, "ms": ms, "key": key}
            out.update(summarize([(r.get("TIME_PERIOD"), r.get("OBS_VALUE")) for r in rows]))
            return out
        last_fail = fail(resp, ms, f"ECB {key} lỗi")
        time.sleep(DEFAULT_DELAY_S)
    return last_fail


EASTMONEY = "https://datacenter-web.eastmoney.com/api/data/v1/get"


def p_eastmoney(report: str, sort_col: str = "REPORT_DATE") -> Callable[[], dict]:
    def run() -> dict:
        params = {"reportName": report, "columns": "ALL", "pageNumber": 1, "pageSize": 500,
                  "sortColumns": sort_col, "sortTypes": -1, "source": "WEB", "client": "WEB"}
        resp, ms = http_get(EASTMONEY, params, headers={"Referer": "https://data.eastmoney.com/"})
        j = as_json(resp) or {}
        res = (j.get("result") or {}) if isinstance(j, dict) else {}
        data = res.get("data") or []
        if resp.status_code != 200 or not data:
            return fail(resp, ms, f"Eastmoney {report}: {j.get('message') if isinstance(j, dict) else ''}")
        dates = sorted((x.get(sort_col) or "")[:10] for x in data if x.get(sort_col))
        pages = res.get("pages")
        row = data[0]
        return {"ok": True, "status": resp.status_code, "ms": ms, "n": res.get("count"), "pages": pages,
                "first_on_page": dates[0] if dates else None, "last": dates[-1] if dates else None,
                "first": dates[0] if dates and pages == 1 else None,
                "age_days": (TODAY - dt.date.fromisoformat(dates[-1])).days if dates else None,
                "fields": list(row.keys())[:20],
                "latest_row": json.dumps({k: row[k] for k in list(row)[:12]}, ensure_ascii=False)[:400]}
    return run


def p_status(url: str) -> Callable[[], dict]:
    """Chỉ kiểm tra trang có mở được từ máy chạy job hay không."""
    def run() -> dict:
        resp, ms = http_get(url)
        m = re.search(r"<title[^>]*>(.*?)</title>", resp.text or "", re.S | re.I)
        return {"ok": resp.status_code == 200, "status": resp.status_code, "ms": ms,
                "final_url": resp.url[:120], "title": snippet(m.group(1), 100) if m else None,
                "bytes": len(resp.content)}
    return run


# ---------------------------------------------------------------- thư viện (subprocess)

AKSHARE_CODE = r'''
import json, datetime as dt, sys
out = {}
try:
    import akshare as ak
    out["version"] = getattr(ak, "__version__", "?")
except Exception as e:
    out["import_error"] = repr(e)[:300]
    print("__JSON__" + json.dumps(out)); sys.exit(0)
today = dt.date.today()
def summ(df):
    return {"n": int(len(df)), "columns": [str(c) for c in df.columns][:12],
            "head": json.dumps(df.head(1).to_dict("records"), ensure_ascii=False, default=str)[:300],
            "tail": json.dumps(df.tail(1).to_dict("records"), ensure_ascii=False, default=str)[:300]}
tests = {
    "macro_china_pmi": lambda: ak.macro_china_pmi(),
    "macro_china_cpi_monthly": lambda: ak.macro_china_cpi_monthly(),
    "macro_china_ppi_yearly": lambda: ak.macro_china_ppi_yearly(),
    "macro_china_lpr": lambda: ak.macro_china_lpr(),
    "macro_china_m2_yearly": lambda: ak.macro_china_m2_yearly(),
    "macro_china_industrial_production_yoy": lambda: ak.macro_china_industrial_production_yoy(),
    "macro_china_consumer_goods_retail": lambda: ak.macro_china_consumer_goods_retail(),
    "macro_china_exports_yoy": lambda: ak.macro_china_exports_yoy(),
    "bond_china_yield": lambda: ak.bond_china_yield(start_date=(today - dt.timedelta(days=300)).strftime("%Y%m%d"),
                                                    end_date=today.strftime("%Y%m%d")),
    "bond_zh_us_rate": lambda: ak.bond_zh_us_rate(start_date="19901219"),
}
for name, fn in tests.items():
    try:
        out[name] = summ(fn())
    except Exception as e:
        out[name] = {"error": repr(e)[:300]}
print("__JSON__" + json.dumps(out, ensure_ascii=False, default=str))
'''


def p_lib(code: str, label: str) -> Callable[[], dict]:
    """Chạy đoạn mã thử thư viện trong tiến trình riêng, có giới hạn thời gian."""
    def run() -> dict:
        t0 = time.monotonic()
        try:
            cp = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                                timeout=LIB_TIMEOUT_S, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"{label}: quá {LIB_TIMEOUT_S} giây"}
        ms = int((time.monotonic() - t0) * 1000)
        line = next((ln for ln in reversed(cp.stdout.splitlines()) if ln.startswith("__JSON__")), None)
        if not line:
            return {"ok": False, "ms": ms, "error": f"{label}: không có kết quả", "stderr": snippet(cp.stderr, 400)}
        res = json.loads(line[len("__JSON__"):])
        ok = any(isinstance(v, dict) and v.get("n") for v in res.values())
        return {"ok": ok, "ms": ms, "lib": res, "error": res.get("import_error")}
    return run


# ---------------------------------------------------------------- danh mục probe

@dataclass(frozen=True)
class Probe:
    """Một lần gọi thử. pid có tiền tố nhóm: us, vn, cn, world, px, meta, site, lib."""
    pid: str
    series: str
    source: str
    host: str
    fn: Callable[[], dict]


FRED_SERIES = [
    ("us.gdp_real", "GDPC1", "GDP thực Mỹ"),
    ("us.unrate", "UNRATE", "Thất nghiệp Mỹ"),
    ("us.payems", "PAYEMS", "Việc làm phi nông nghiệp"),
    ("us.icsa", "ICSA", "Đơn trợ cấp thất nghiệp lần đầu"),
    ("us.cpi", "CPIAUCSL", "CPI Mỹ"),
    ("us.core_pce", "PCEPILFE", "PCE lõi"),
    ("us.be5y", "T5YIE", "Lạm phát kỳ vọng 5 năm"),
    ("us.dff", "DFF", "Lãi suất Fed (ngày)"),
    ("us.dgs2", "DGS2", "Lợi suất 2 năm"),
    ("us.dgs10", "DGS10", "Lợi suất 10 năm"),
    ("us.t10y2y", "T10Y2Y", "Độ dốc 10 năm − 2 năm"),
    ("us.t10y3m", "T10Y3M", "Độ dốc 10 năm − 3 tháng"),
    ("us.nfci", "NFCI", "Chỉ số điều kiện tài chính NFCI"),
    ("us.hy_oas", "BAMLH0A0HYM2", "Chênh lệch tín dụng lợi suất cao (ICE)"),
    ("us.baa10y", "BAA10Y", "Chênh lệch Baa − 10 năm (Moody's)"),
    ("us.usd_broad", "DTWEXBGS", "Chỉ số USD rộng (Fed)"),
    ("us.pmi_philly", "GACDFSA066MSFRBPHI", "Khảo sát sản xuất Philadelphia Fed"),
    ("us.cfnai", "CFNAI", "Chỉ số hoạt động Chicago Fed"),
    ("us.bci_oecd", "BSCICP03USM665S", "Niềm tin kinh doanh Mỹ (OECD)"),
    ("px.nasdaq_fred", "NASDAQCOM", "Nasdaq Composite (FRED)"),
    ("px.spx_fred", "SP500", "S&P 500 (FRED, 10 năm)"),
    ("px.brent_fred", "DCOILBRENTEU", "Dầu Brent (EIA qua FRED)"),
    ("cn.usdcny_fred", "DEXCHUS", "USD/CNY (Fed H.10)"),
    ("cn.cpi_oecd_fred", "CHNCPIALLMINMEI", "CPI Trung Quốc (OECD qua FRED)"),
    ("world.jp_call_fred", "IRSTCI01JPM156N", "Lãi suất qua đêm Nhật (OECD)"),
]

COINS = [("btc", "BTC", "BTCUSDT"), ("eth", "ETH", "ETHUSDT"), ("sol", "SOL", "SOLUSDT"),
         ("doge", "DOGE", "DOGEUSDT"), ("trx", "TRX", "TRXUSDT")]

GEM = [
    ("vn.stock_gem", "VNM", "DSTKMKTXN", "VN-Index theo tháng (World Bank GEM)"),
    ("vn.cpi_gem", "VNM", "CPTOTSAXNZGY", "CPI Việt Nam % so cùng kỳ (GEM)"),
    ("vn.ip_gem", "VNM", "IPTOTSAKD", "Sản xuất công nghiệp Việt Nam (GEM)"),
    ("vn.exports_gem", "VNM", "DXGSRMRCHSACD", "Xuất khẩu hàng hóa Việt Nam (GEM)"),
    ("vn.fx_gem", "VNM", "DPANUSSPB", "Tỷ giá VND/USD bình quân (GEM)"),
    ("px.set_gem", "THA", "DSTKMKTXN", "SET theo tháng (GEM)"),
    ("px.sti_gem", "SGP", "DSTKMKTXN", "STI theo tháng (GEM)"),
    ("cn.ip_gem", "CHN", "IPTOTSAKD", "Sản xuất công nghiệp Trung Quốc (GEM)"),
]

DBN_QUERIES = [
    ("meta.dbn_cn_pmi", "China PMI"),
    ("meta.dbn_vn_ip", "Viet Nam industrial production"),
    ("meta.dbn_vn_cpi", "Viet Nam consumer price index"),
    ("meta.dbn_vn_rate", "Viet Nam interest rate"),
    ("meta.dbn_vn_bond", "Viet Nam government bond yield"),
]

EASTMONEY_REPORTS = [
    ("cn.pmi_em", "RPT_ECONOMY_PMI", "REPORT_DATE", "PMI sản xuất NBS (Eastmoney)"),
    ("cn.cpi_em", "RPT_ECONOMY_CPI", "REPORT_DATE", "CPI Trung Quốc (Eastmoney)"),
    ("cn.ppi_em", "RPT_ECONOMY_PPI", "REPORT_DATE", "PPI Trung Quốc (Eastmoney)"),
    ("cn.m2_em", "RPT_ECONOMY_CURRENCY_SUPPLY", "REPORT_DATE", "M2 Trung Quốc (Eastmoney)"),
    ("cn.gdp_em", "RPT_ECONOMY_GDP", "REPORT_DATE", "GDP Trung Quốc (Eastmoney)"),
    ("cn.ip_em", "RPT_ECONOMY_INDUS_GROW", "REPORT_DATE", "Sản xuất công nghiệp TQ (Eastmoney)"),
    ("cn.retail_em", "RPT_ECONOMY_TOTAL_RETAIL", "REPORT_DATE", "Bán lẻ Trung Quốc (Eastmoney)"),
    ("cn.bond10y_em", "RPTA_WEB_TREASURYYIELD", "SOLAR_DATE", "Lợi suất TPCP Trung Quốc, Mỹ (Eastmoney)"),
    ("cn.lpr_em", "RPTA_WEB_RATE", "TRADE_DATE", "LPR 1 năm, 5 năm (Eastmoney)"),
]

IMF_FLOWS = [
    ("vn.cpi_imf", "CPI", "CPI Việt Nam (IMF)"),
    ("vn.fx_imf", "ER", "Tỷ giá VND (IMF)"),
    ("vn.rates_imf", "MFS_IR", "Lãi suất Việt Nam (IMF MFS)"),
    ("vn.markets_imf", "MFS_FMP", "Giá thị trường tài chính Việt Nam (IMF MFS)"),
    ("vn.ip_imf", "PI", "Chỉ số sản xuất Việt Nam (IMF)"),
    ("vn.trade_imf", "ITG", "Thương mại hàng hóa Việt Nam (IMF)"),
    ("vn.liquidity_imf", "IL", "Thanh khoản quốc tế, dự trữ Việt Nam (IMF)"),
]

SITES = [
    ("site.nso_vn", "https://www.nso.gov.vn/", "Cục Thống kê Việt Nam"),
    ("site.sbv", "https://www.sbv.gov.vn/", "Ngân hàng Nhà nước"),
    ("site.hnx", "https://hnx.vn/", "HNX (lợi suất TPCP)"),
    ("site.spglobal_pmi", "https://www.pmi.spglobal.com/", "S&P Global PMI"),
    ("site.wgb_vn10y", "https://www.worldgovernmentbonds.com/bond-historical-data/vietnam/10-years/",
     "Lợi suất TPCP Việt Nam 10 năm"),
    ("site.eia_brent_html", "https://www.eia.gov/dnav/pet/hist/RBRTEd.htm", "EIA Brent (bảng HTML)"),
]


def build_probes() -> list[Probe]:
    """Danh mục đầy đủ các probe, theo thứ tự hiển thị."""
    ps: list[Probe] = []
    fh = "fred.stlouisfed.org"
    for label, ua in FRED_UAS:  # chạy trước danh sách FRED, cùng hàng đợi host
        ps.append(Probe(f"meta.fred_ua_{label}", f"fredgraph.csv với UA {label}", "FRED", fh, p_fred_ua(label, ua)))
    for pid, sid, desc in FRED_SERIES:
        ps.append(Probe(pid, desc, f"FRED {sid}", fh, p_fred(sid)))
    ps.append(Probe("us.fred_vintage", "PAYEMS theo vintage 2020-02-10", "FRED vintage", fh, p_fred_vintage))
    ps.append(Probe("meta.fred_api_nokey", "FRED API không khóa (kiểm tra máy chủ)", "FRED API",
                    "api.stlouisfed.org", p_fred_api_nokey))
    for code, name, sym in COINS:
        ps.append(Probe(f"px.{code}_binance", f"{name} nến ngày UTC", "Binance data-api.binance.vision",
                        "data-api.binance.vision", p_binance_vision(sym)))
    ps.append(Probe("px.paxg_binance", "PAXG (token vàng) nến ngày UTC", "Binance data-api.binance.vision",
                    "data-api.binance.vision", p_binance_vision("PAXGUSDT")))
    for code, name in (("btc", "BTC"), ("sol", "SOL"), ("trx", "TRX")):
        ps.append(Probe(f"px.{code}_cm", f"{name} đóng cửa ngày UTC", "Coin Metrics community",
                        "community-api.coinmetrics.io", p_coinmetrics(code)))
    ps.append(Probe("px.btc_kraken", "BTC/USD nến ngày", "Kraken", "api.kraken.com", p_kraken("XBTUSD")))
    ps.append(Probe("px.crypto_cg_simple", "Giá hiện tại 5 coin", "CoinGecko keyless", "api.coingecko.com",
                    p_cg_simple))
    ps.append(Probe("px.spx_yahoo", "S&P 500 theo tháng", "Yahoo ^GSPC", "query1.finance.yahoo.com",
                    p_yahoo("^GSPC")))
    ps.append(Probe("px.spx_stooq", "S&P 500 theo tháng", "Stooq", "stooq.com", p_stooq("^spx")))
    ps.append(Probe("px.cnbc_quote", "Giá hiện tại STI, SET, SPX, Nasdaq, DXY, Brent, vàng, VND, UST10Y",
                    "CNBC quote", "quote.cnbc.com", p_cnbc_quote))
    for sym, desc in ((".STI", "STI ngày"), (".SETI", "SET ngày"), (".SPX", "S&P 500 ngày"),
                      ("@LCO.1", "Brent ngày"), ("@GC.1", "Vàng ngày"), (".DXY", "DXY ngày")):
        ps.append(Probe(f"px.cnbc_bars_{sym.strip('.@').replace('.', '_').lower()}", desc, f"CNBC bars {sym}",
                        "ts-api.cnbc.com", p_cnbc_bars(sym)))
    ps.append(Probe("px.vnindex_dnse", "VN-Index ngày", "DNSE (Entrade)", "services.entrade.com.vn", p_dnse))
    ps.append(Probe("px.vnindex_vndirect", "VN-Index ngày", "VNDirect dchart", "dchart-api.vndirect.com.vn",
                    p_vndirect))
    ps.append(Probe("vn.foreign_cafef", "Khối ngoại mua bán ròng", "cafef", "s.cafef.vn",
                    p_cafef("GDKhoiNgoai.ashx", "khối ngoại")))
    ps.append(Probe("px.set_setweb", "SET 1 năm", "set.or.th API", "www.set.or.th", p_set_web))
    ps.append(Probe("px.commodity_pink", "Vàng, Brent theo tháng", "World Bank Pink Sheet", "thedocs.worldbank.org",
                    p_pink_sheet))
    ps.append(Probe("px.brent_eia", "Brent ngày", "EIA .xls", "www.eia.gov", p_eia_xls))
    ps.append(Probe("px.gold_lbma_pm", "Vàng LBMA PM (USD)", "LBMA", "prices.lbma.org.uk", p_lbma("gold_pm")))
    ps.append(Probe("px.gold_fawaz", "Vàng (XAU) mới nhất", "fawazahmed0 currency-api", "cdn.jsdelivr.net",
                    p_fawaz("latest", "xau")))
    ps.append(Probe("px.gold_fawaz_2024", "Vàng (XAU) ngày 2024-03-06", "fawazahmed0 currency-api",
                    "cdn.jsdelivr.net", p_fawaz("2024-03-06", "xau")))
    ps.append(Probe("px.usdvnd_vcb", "USD/VND Vietcombank", "Vietcombank XML", "portal.vietcombank.com.vn", p_vcb))
    ps.append(Probe("px.usdvnd_erapi", "USD/VND", "open.er-api.com", "open.er-api.com", p_erapi))
    ps.append(Probe("px.usdvnd_fawaz", "USD/VND mới nhất", "fawazahmed0 currency-api", "cdn.jsdelivr.net",
                    p_fawaz("latest", "vnd")))
    ps.append(Probe("px.usdvnd_fawaz_2024", "USD/VND ngày 2024-03-06", "fawazahmed0 currency-api",
                    "cdn.jsdelivr.net", p_fawaz("2024-03-06", "vnd")))
    ps.append(Probe("px.ust10y_treasury", "Lợi suất 10 năm Mỹ năm nay", "US Treasury CSV", "home.treasury.gov",
                    p_treasury(TODAY.year)))
    ps.append(Probe("px.ust10y_treasury_1990", "Lợi suất 10 năm Mỹ năm 1990", "US Treasury CSV",
                    "home.treasury.gov", p_treasury(1990)))
    ps.append(Probe("px.vix_cboe", "VIX", "Cboe CSV", "cdn.cboe.com", p_cboe_vix))
    ps.append(Probe("px.dxy_ecb", "6 tỷ giá trong rổ DXY", "ECB EXR", "data-api.ecb.europa.eu", p_ecb_exr))
    for pid, iso3, code, desc in GEM:
        ps.append(Probe(pid, desc, f"World Bank GEM {code}", "api.worldbank.org", p_wb_gem(iso3, code)))
    ps.append(Probe("meta.dbn_providers", "Danh sách nhà cung cấp", "DBnomics", "api.db.nomics.world", p_dbn_providers))
    for pid, q in DBN_QUERIES:
        ps.append(Probe(pid, f"Tìm: {q}", "DBnomics search", "api.db.nomics.world", p_dbn_search(q)))
    ps.append(Probe("world.imf_weo", "Dự báo tăng trưởng thế giới (WEO)", "IMF DataMapper", "www.imf.org",
                    p_imf_datamapper))
    ps.append(Probe("meta.imf_sdmx", "Danh sách dataflow", "IMF SDMX 2.1 mới", "api.imf.org", p_imf_sdmx))
    for pid, flow, desc in IMF_FLOWS:
        ps.append(Probe(pid, desc, f"IMF SDMX {flow}", "api.imf.org", p_imf_country(flow)))
    ps.append(Probe("world.policy_bis", "Lãi suất điều hành US, EA, JP, CN, TH", "BIS WS_CBPOL", "stats.bis.org",
                    p_bis_cbpol("US+XM+JP+CN+TH")))
    ps.append(Probe("world.cli_oecd", "CLI Mỹ, Trung Quốc, G20", "OECD SDMX", "sdmx.oecd.org", p_oecd_cli))
    ps.append(Probe("world.ecb_dfr", "Lãi suất tiền gửi ECB", "ECB Data API", "data-api.ecb.europa.eu", p_ecb_dfr))
    for pid, rep, sort_col, desc in EASTMONEY_REPORTS:
        ps.append(Probe(pid, desc, f"Eastmoney {rep}", "datacenter-web.eastmoney.com", p_eastmoney(rep, sort_col)))
    for pid, url, desc in SITES:
        host = url.split("/")[2]
        ps.append(Probe(pid, desc, host, host, p_status(url)))
    ps.append(Probe("lib.akshare", "Vĩ mô Trung Quốc qua thư viện akshare", "akshare (pip)", "lib:akshare",
                    p_lib(AKSHARE_CODE, "akshare")))
    return ps


# ---------------------------------------------------------------- chạy và ghi kết quả

def run_one(p: Probe) -> dict:
    """Chạy một probe; mọi ngoại lệ thành bản ghi lỗi."""
    t0 = time.monotonic()
    try:
        fields = p.fn()
    except Exception as e:  # noqa: BLE001 - ghi lại mọi lỗi, không dừng job
        fields = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    rec = {"id": p.pid, "group": p.pid.split(".")[0], "series": p.series, "source": p.source, "host": p.host}
    rec.update(fields)
    rec["ms_total"] = int((time.monotonic() - t0) * 1000)
    flag = "OK " if rec.get("ok") else "ERR"
    print(f"[{flag}] {p.pid:28s} {rec.get('first') or '':10s} → {str(rec.get('last') or ''):10s} "
          f"{str(rec.get('error') or '')[:90]}", flush=True)
    return rec


def skipped(p: Probe) -> dict:
    return {"id": p.pid, "group": p.pid.split(".")[0], "series": p.series, "source": p.source, "host": p.host,
            "ok": False, "error": f"bỏ qua: hết hạn chót {RUN_DEADLINE_S // 60} phút của lần chạy"}


def run_all(probes: list[Probe]) -> list[dict]:
    """Chạy song song theo host, tuần tự trong cùng host (lịch sự với nguồn)."""
    groups: dict[str, list[Probe]] = defaultdict(list)
    for p in probes:
        groups[p.host].append(p)
    order = {p.pid: i for i, p in enumerate(probes)}

    def run_group(plist: list[Probe]) -> list[dict]:
        out = []
        for i, p in enumerate(plist):
            if time.monotonic() - START > RUN_DEADLINE_S:
                out.append(skipped(p))
                continue
            if i:
                time.sleep(HOST_DELAY_S.get(p.host, DEFAULT_DELAY_S))
            out.append(run_one(p))
        return out

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        for chunk in ex.map(run_group, groups.values()):
            results.extend(chunk)
    results.sort(key=lambda r: order[r["id"]])
    return results


def cell(v) -> str:
    return "" if v is None else str(v).replace("|", "/").replace("\n", " ")


def write_outputs(results: list[dict], out_dir: str) -> dict:
    """Ghi probe.json (đầy đủ) và probe.md (bảng tóm tắt)."""
    os.makedirs(out_dir, exist_ok=True)
    meta = {
        "schema": "probe/1",
        "generated_at": NOW.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "duration_s": int(time.monotonic() - START),
        "runner": {"python": platform.python_version(), "platform": platform.platform(),
                   "github_run_id": os.environ.get("GITHUB_RUN_ID"), "runner_os": os.environ.get("RUNNER_OS"),
                   "fred_api_key": bool(FRED_API_KEY)},
        "summary": {"total": len(results), "ok": sum(1 for r in results if r.get("ok"))},
    }
    with open(os.path.join(out_dir, "probe.json"), "w", encoding="utf-8") as f:
        json.dump({**meta, "results": results}, f, ensure_ascii=False, indent=1, default=str)
    lines = [
        "# Kết quả gọi thử nguồn số liệu", "",
        f"Chạy lúc {meta['generated_at']} trên {meta['runner']['runner_os'] or 'máy cục bộ'} "
        f"trong {meta['duration_s']} giây; thành công {meta['summary']['ok']}/{meta['summary']['total']} probe. "
        "Chi tiết đầy đủ trong `probe.json`.", "",
        "| id | chuỗi | nguồn | kết quả | HTTP | từ | đến | n | tần suất | cũ (ngày) | ghi chú |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        note = r.get("error") or r.get("note") or ""
        lines.append("| " + " | ".join(cell(x) for x in (
            r["id"], r["series"], r["source"], "OK" if r.get("ok") else "LỖI", r.get("status"),
            r.get("first"), r.get("last"), r.get("n"), r.get("freq"), r.get("age_days"), str(note)[:90])) + " |")
    with open(os.path.join(out_dir, "probe.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(description="Gọi thử các nguồn số liệu cho macro-radar 2")
    ap.add_argument("--out", default="data", help="thư mục ghi probe.json và probe.md")
    ap.add_argument("--only", default="", help="chỉ chạy probe có id bắt đầu bằng chuỗi này")
    ap.add_argument("--list", action="store_true", help="in danh sách probe rồi thoát")
    args = ap.parse_args()
    probes = [p for p in build_probes() if p.pid.startswith(args.only)]
    if args.list:
        for p in probes:
            print(f"{p.pid:30s} {p.source:34s} {p.series}")
        print(f"{len(probes)} probe")
        return 0
    meta = write_outputs(run_all(probes), args.out)
    print(f"Xong: {meta['summary']['ok']}/{meta['summary']['total']} probe thành công "
          f"trong {meta['duration_s']} giây.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
