#!/usr/bin/env python3
"""Gọi thử các nguồn số liệu ứng viên cho macro-radar 2 (giai đoạn G0, dùng lại ở G2).

Mỗi probe gọi một nguồn một hoặc vài lần rồi ghi lại: mã HTTP, thời gian phản hồi,
số quan sát, ngày đầu, ngày cuối, giá trị cuối, tần suất suy ra, độ cũ và lỗi nếu có.
Script không dừng giữa chừng: lỗi của từng probe được bắt và ghi vào kết quả.

Cách chạy:
    python jobs/probe.py --out data            # chạy tất cả
    python jobs/probe.py --out data --only px  # chỉ các probe có id bắt đầu bằng "px"
    python jobs/probe.py --list                # in danh sách probe

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
TIMEOUT_S = 30                 # giây chờ tối đa cho mỗi request
DEFAULT_DELAY_S = 0.3          # giây nghỉ giữa hai request tới cùng host
HOST_DELAY_S = {               # host có giới hạn tần suất chặt hơn
    "api.coingecko.com": 2.5,
    "community-api.coinmetrics.io": 0.7,
    "query1.finance.yahoo.com": 0.8,
    "query2.finance.yahoo.com": 0.8,
}
LIB_TIMEOUT_S = 300            # giây chờ tối đa cho mỗi probe thư viện (subprocess)
MAX_WORKERS = 12               # số host gọi song song
NOW = dt.datetime.now(dt.timezone.utc)
TODAY = NOW.date()
VNINDEX_BASE_TS = int(dt.datetime(2000, 7, 28, tzinfo=dt.timezone.utc).timestamp())
VN_UTC_OFFSET_S = 7 * 3600     # giờ Việt Nam = UTC+7

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept": "*/*",
                        "Accept-Language": "en-US,en;q=0.9"})


# ---------------------------------------------------------------- tiện ích

def http_get(url: str, params: dict | None = None, headers: dict | None = None,
             timeout: float = TIMEOUT_S) -> tuple[requests.Response, int]:
    """GET có đo thời gian (ms). Lỗi mạng được ném ra cho run_one ghi lại."""
    t0 = time.monotonic()
    resp = SESSION.get(url, params=params, headers=headers, timeout=timeout)
    return resp, int((time.monotonic() - t0) * 1000)


def as_json(resp: requests.Response):
    """Trả JSON đã parse, hoặc None nếu phản hồi không phải JSON."""
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
    """Tìm khóa đầu tiên có chứa một trong các chuỗi cands (không phân biệt hoa thường)."""
    return next((k for k in row if any(c.lower() in k.lower() for c in cands)), None)


# ---------------------------------------------------------------- FRED

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv"


def fred_rows(sid: str, extra: dict | None = None):
    """Tải CSV của một chuỗi FRED; trả (resp, ms, rows hoặc None nếu không phải CSV)."""
    resp, ms = http_get(FRED_CSV, {"id": sid, **(extra or {})})
    head = resp.text.splitlines()[0] if resp.text else ""
    if resp.status_code != 200 or "," not in head or "<" in head:
        return resp, ms, None
    return resp, ms, list(csv.reader(io.StringIO(resp.text)))


def p_fred(sid: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms, rows = fred_rows(sid)
        if rows is None:
            return fail(resp, ms, "FRED không trả CSV")
        pairs, missing = [], []
        for row in rows[1:]:
            if len(row) < 2:
                continue
            if row[1].strip() in ("", "."):
                missing.append(row[0][:10])
            else:
                pairs.append((row[0][:10], row[1]))
        out = {"ok": bool(pairs), "status": resp.status_code, "ms": ms,
               "header": ",".join(rows[0])[:60]}
        out.update(summarize(pairs))
        cutoff = (TODAY - dt.timedelta(days=730)).isoformat()
        recent = [d for d in missing if d >= cutoff]
        if recent:
            out["missing_recent_count"] = len(recent)
            out["missing_recent"] = recent[-12:]
        return out
    return run


def p_fred_vintage() -> dict:
    """PAYEMS như công bố ngày 2020-02-10: kiểm tra FRED có trả số theo vintage không cần khóa API."""
    vint = "2020-02-10"
    resp, ms, rows = fred_rows("PAYEMS", {"vintage_date": vint, "revision_date": vint})
    if rows is None:
        return fail(resp, ms, "không lấy được vintage")
    vmap = {r[0][:10]: r[1] for r in rows[1:] if len(r) > 1 and r[1] not in ("", ".")}
    time.sleep(DEFAULT_DELAY_S)
    _, _, rows2 = fred_rows("PAYEMS")
    cmap = {r[0][:10]: r[1] for r in (rows2 or [])[1:] if len(r) > 1 and r[1] not in ("", ".")}
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


def p_coinmetrics(asset: str) -> Callable[[], dict]:
    def run() -> dict:
        last_err: dict = {"ok": False, "error": "không thử được"}
        for metric in ("PriceUSD", "ReferenceRateUSD"):
            q = {"assets": asset, "metrics": metric, "frequency": "1d", "page_size": 1}
            r1, ms1 = http_get(CM_URL, q)
            j1 = as_json(r1) or {}
            if r1.status_code != 200 or not j1.get("data"):
                last_err = fail(r1, ms1, f"{metric}: không có dữ liệu")
                time.sleep(HOST_DELAY_S["community-api.coinmetrics.io"])
                continue
            time.sleep(HOST_DELAY_S["community-api.coinmetrics.io"])
            r2, ms2 = http_get(CM_URL, {**q, "paging_from": "end"})
            j2 = as_json(r2) or {}
            if not j2.get("data"):
                return fail(r2, ms2, f"{metric}: không đọc được điểm cuối")
            first, last = j1["data"][0]["time"][:10], j2["data"][0]["time"][:10]
            d0, d1 = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
            return {"ok": True, "status": r2.status_code, "ms": ms1 + ms2, "metric": metric,
                    "n": (d1 - d0).days + 1, "first": first, "last": last,
                    "last_value": float(j2["data"][0][metric]), "freq": "D",
                    "span_years": round((d1 - d0).days / 365.25, 1),
                    "age_days": (TODAY - d1).days, "note": "n = số ngày từ đầu tới cuối"}
        return last_err
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


def p_cg_chart(cid: str, days: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get(f"{CG}/coins/{cid}/market_chart",
                            {"vs_currency": "usd", "days": days, "interval": "daily"})
        j = as_json(resp)
        if resp.status_code != 200 or not isinstance(j, dict) or "prices" not in j:
            return fail(resp, ms, f"market_chart days={days} lỗi")
        out = {"ok": True, "status": resp.status_code, "ms": ms, "days_param": days}
        out.update(summarize([(utc_date(t / 1000), p) for t, p in j["prices"]]))
        return out
    return run


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


def p_binance(host: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get(f"https://{host}/api/v3/klines",
                            {"symbol": "BTCUSDT", "interval": "1d", "limit": 5})
        j = as_json(resp)
        if resp.status_code != 200 or not isinstance(j, list):
            return fail(resp, ms, "Binance bị chặn hoặc lỗi")
        out = {"ok": True, "status": resp.status_code, "ms": ms}
        out.update(summarize([(utc_date(r[0] / 1000), r[4]) for r in j]))
        return out
    return run


# ---------------------------------------------------------------- Yahoo, Stooq

YH_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"


def yahoo_chart(sym: str, rng: str, interval: str):
    """Trả (resp, ms, result hoặc None, error hoặc None) của Yahoo chart API v8."""
    resp, ms = http_get(YH_CHART + quote(sym, safe=""), {"range": rng, "interval": interval})
    j = as_json(resp)
    chart = (j or {}).get("chart") or {} if isinstance(j, dict) else {}
    if resp.status_code != 200 or chart.get("error") or not chart.get("result"):
        return resp, ms, None, chart.get("error") or snippet(resp.text, 120)
    return resp, ms, chart["result"][0], None


def yahoo_pairs(res: dict) -> list:
    """Cặp (ngày theo giờ sàn, giá đóng cửa) từ một result của Yahoo."""
    off = (res.get("meta") or {}).get("gmtoffset") or 0
    ts = res.get("timestamp") or []
    closes = (((res.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
    return [(utc_date(t + off), c) for t, c in zip(ts, closes)]


def p_yahoo(sym: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms, res, err = yahoo_chart(sym, "max", "1mo")
        if res is None:
            return fail(resp, ms, f"Yahoo lỗi: {err}"[:200])
        meta = res.get("meta") or {}
        monthly = summarize(yahoo_pairs(res))
        out = {"ok": monthly.get("n", 0) > 0, "status": resp.status_code, "ms": ms,
               "currency": meta.get("currency"), "exchange_tz": meta.get("exchangeTimezoneName"),
               "first_trade": utc_date(meta["firstTradeDate"]) if meta.get("firstTradeDate") else None,
               "monthly_n": monthly.get("n"), "first": monthly.get("first"),
               "span_years": monthly.get("span_years")}
        time.sleep(HOST_DELAY_S["query1.finance.yahoo.com"])
        _, _, res2, err2 = yahoo_chart(sym, "1mo", "1d")
        if res2 is not None:
            daily = summarize(yahoo_pairs(res2))
            out.update(last=daily.get("last"), last_value=daily.get("last_value"),
                       age_days=daily.get("age_days"), freq="D")
        else:
            out["daily_error"] = str(err2)[:160]
        return out
    return run


def p_yahoo_search(q: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get("https://query2.finance.yahoo.com/v1/finance/search",
                            {"q": q, "quotesCount": 10, "newsCount": 0})
        j = as_json(resp)
        if resp.status_code != 200 or not isinstance(j, dict):
            return fail(resp, ms, "Yahoo search lỗi")
        quotes = [{"symbol": x.get("symbol"), "name": (x.get("shortname") or x.get("longname") or "")[:50],
                   "exchange": x.get("exchange"), "type": x.get("quoteType")} for x in j.get("quotes", [])]
        return {"ok": bool(quotes), "status": resp.status_code, "ms": ms, "quotes": quotes}
    return run


def p_stooq(sym: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get("https://stooq.com/q/d/l/", {"s": sym, "i": "m"})
        if not resp.text.startswith("Date,"):
            return fail(resp, ms, "Stooq không trả CSV (có thể cần apikey)")
        rows = list(csv.reader(io.StringIO(resp.text)))
        idx = rows[0].index("Close")
        out = {"ok": True, "status": resp.status_code, "ms": ms}
        out.update(summarize([(r[0], r[idx]) for r in rows[1:] if len(r) > idx]))
        return out
    return run


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


def p_tcbs() -> dict:
    resp, ms = http_get("https://apipubaws.tcbs.com.vn/stock-insight/v2/stock/bars-long-term",
                        {"resolution": "D", "ticker": "VNINDEX", "type": "index",
                         "to": int(NOW.timestamp()), "countBack": 7000})
    j = as_json(resp)
    data = j.get("data") if isinstance(j, dict) else None
    if resp.status_code != 200 or not data:
        return fail(resp, ms, "TCBS: không có data")
    out = {"ok": True, "status": resp.status_code, "ms": ms}
    out.update(summarize([((x.get("tradingDate") or "")[:10], x.get("close")) for x in data]))
    return out


CAFEF = "https://s.cafef.vn/Ajax/PageNew/DataHistory/"


def p_cafef(endpoint: str, label: str) -> Callable[[], dict]:
    """cafef phân trang: lấy dòng mới nhất (trang 1) và dòng cũ nhất (trang cuối, cỡ trang 1)."""
    def run() -> dict:
        base = {"Symbol": "VNINDEX", "StartDate": "", "EndDate": ""}
        resp, ms = http_get(CAFEF + endpoint, {**base, "PageIndex": 1, "PageSize": 1})
        j = as_json(resp)
        data = j.get("Data") if isinstance(j, dict) else None
        rows = (data or {}).get("Data") if isinstance(data, dict) else None
        if resp.status_code != 200 or not rows:
            return fail(resp, ms, f"cafef {label}: không có Data")
        total = int(data.get("TotalCount") or 0)
        latest = rows[0]
        dkey = find_key(latest, "ngay", "date")
        ckey = find_key(latest, "giadongcua", "dongcua", "close")
        out = {"ok": True, "status": resp.status_code, "ms": ms, "n": total,
               "fields": list(latest.keys())[:16],
               "latest_row": json.dumps(latest, ensure_ascii=False)[:300]}
        if dkey:
            out["last"] = parse_date(str(latest[dkey]), "%d/%m/%Y")
            out["age_days"] = (TODAY - dt.date.fromisoformat(out["last"])).days
        if ckey:
            out["last_value"] = latest[ckey]
        if total > 1 and dkey:
            time.sleep(DEFAULT_DELAY_S)
            resp2, _ = http_get(CAFEF + endpoint, {**base, "PageIndex": total, "PageSize": 1})
            j2 = as_json(resp2) or {}
            rows2 = ((j2.get("Data") or {}).get("Data") or []) if isinstance(j2, dict) else []
            if rows2 and dkey in rows2[0]:
                out["first"] = parse_date(str(rows2[0][dkey]), "%d/%m/%Y")
        return out
    return run


def p_set_web() -> dict:
    resp, ms = http_get("https://www.set.or.th/api/set/index/SET/chart-quotation",
                        {"period": "1Y", "accumulated": "false"})
    j = as_json(resp)
    if resp.status_code != 200 or j is None:
        return fail(resp, ms, "set.or.th API lỗi")
    return {"ok": True, "status": resp.status_code, "ms": ms, "snippet": snippet(resp.text)}


# ---------------------------------------------------------------- vàng, tỷ giá, lợi suất, VIX

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


def p_fawaz(tag: str) -> Callable[[], dict]:
    def run() -> dict:
        resp, ms = http_get(f"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{tag}/v1/currencies/usd.json")
        j = as_json(resp) or {}
        vnd = (j.get("usd") or {}).get("vnd") if isinstance(j, dict) else None
        if not vnd:
            return fail(resp, ms, "không có vnd")
        return {"ok": True, "status": resp.status_code, "ms": ms, "last": j.get("date"), "last_value": vnd}
    return run


def p_treasury() -> dict:
    y = TODAY.year
    url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
           f"daily-treasury-rates.csv/{y}/all")
    resp, ms = http_get(url, {"type": "daily_treasury_yield_curve", "field_tdr_date_value": y,
                              "page": "", "_format": "csv"})
    rows = list(csv.reader(io.StringIO(resp.text))) if resp.status_code == 200 else []
    if not rows or "10 Yr" not in rows[0]:
        return fail(resp, ms, "Treasury CSV lỗi")
    i = rows[0].index("10 Yr")
    out = {"ok": True, "status": resp.status_code, "ms": ms, "note": f"chỉ năm {y} mỗi lần gọi"}
    out.update(summarize([(parse_date(r[0], "%m/%d/%Y"), r[i]) for r in rows[1:] if len(r) > i and r[i]]))
    return out


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


# ---------------------------------------------------------------- tổ chức quốc tế

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
        statuses, msg = [], ""
        for extra in ({"frequency": "M"}, {}):
            resp, ms = http_get(url, {"source": 15, "format": "json", "per_page": 20000, **extra})
            statuses.append(resp.status_code)
            j = as_json(resp)
            if isinstance(j, list) and len(j) > 1 and j[1]:
                pairs = [(wb_date(x.get("date", "")), x.get("value")) for x in j[1]]
                out = {"ok": True, "status": resp.status_code, "ms": ms, "params": extra,
                       "sample_date": j[1][0].get("date")}
                out.update(summarize([(d, v) for d, v in pairs if d]))
                if out.get("n"):
                    return out
            msg = snippet(json.dumps(j[0]) if isinstance(j, list) and j else resp.text)
            time.sleep(DEFAULT_DELAY_S)
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
    resp, ms = http_get("https://api.imf.org/external/sdmx/2.1/dataflow",
                        headers={"Accept": "application/xml"})
    ids = re.findall(r'<(?:\w+:)?Dataflow\b[^>]*\bid="([^"]+)"', resp.text or "")
    out = {"ok": resp.status_code == 200 and bool(ids), "status": resp.status_code, "ms": ms,
           "n": len(ids), "ids_sample": ids[:60]}
    if not ids:
        out["snippet"] = snippet(resp.text)
    return out


def p_bis_cbpol(areas: str) -> Callable[[], dict]:
    def run() -> dict:
        urls = [f"https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.{areas}",
                f"https://stats.bis.org/api/v1/data/WS_CBPOL/M.{areas}/all"]
        last_fail: dict = {"ok": False}
        for url in urls:
            resp, ms = http_get(url, {"format": "csv", "startPeriod": "1990-01"})
            if resp.status_code == 200 and "TIME_PERIOD" in resp.text[:3000]:
                per = defaultdict(list)
                for r in csv.DictReader(io.StringIO(resp.text)):
                    tp = r.get("TIME_PERIOD", "")
                    per[r.get("REF_AREA", "?")].append((tp + "-01" if len(tp) == 7 else tp, r.get("OBS_VALUE")))
                return {"ok": True, "status": 200, "ms": ms, "url_used": url,
                        "areas": {a: summarize(p) for a, p in per.items()}}
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
    per = defaultdict(list)
    for r in csv.DictReader(io.StringIO(resp.text)):
        tp = r.get("TIME_PERIOD", "")
        per[r.get("REF_AREA", "?")].append((tp + "-01" if len(tp) == 7 else tp, r.get("OBS_VALUE")))
    return {"ok": True, "status": 200, "ms": ms, "areas": {a: summarize(p) for a, p in per.items()}}


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


def p_eastmoney(report: str) -> Callable[[], dict]:
    def run() -> dict:
        params = {"reportName": report, "columns": "ALL", "pageNumber": 1, "pageSize": 500,
                  "sortColumns": "REPORT_DATE", "sortTypes": -1, "source": "WEB", "client": "WEB"}
        resp, ms = http_get(EASTMONEY, params, headers={"Referer": "https://data.eastmoney.com/"})
        j = as_json(resp) or {}
        res = (j.get("result") or {}) if isinstance(j, dict) else {}
        data = res.get("data") or []
        if resp.status_code != 200 or not data:
            return fail(resp, ms, f"Eastmoney {report}: {j.get('message') if isinstance(j, dict) else ''}")
        dates = sorted((x.get("REPORT_DATE") or "")[:10] for x in data if x.get("REPORT_DATE"))
        row = data[0]
        return {"ok": True, "status": resp.status_code, "ms": ms, "n": res.get("count"),
                "first_on_page": dates[0] if dates else None, "last": dates[-1] if dates else None,
                "age_days": (TODAY - dt.date.fromisoformat(dates[-1])).days if dates else None,
                "fields": list(row.keys())[:16],
                "latest_row": json.dumps({k: row[k] for k in list(row)[:10]}, ensure_ascii=False)[:300]}
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

VNSTOCK_CODE = r'''
import json, datetime as dt, sys
out = {}
start, end = "2000-01-01", dt.date.today().isoformat()
def summ(df):
    import pandas as pd
    cols = list(df.columns)
    tcol = next((c for c in cols if str(c).lower() in ("time", "date", "tradingdate")), cols[0])
    ccol = next((c for c in cols if str(c).lower() == "close"), cols[-1])
    d = pd.to_datetime(df[tcol])
    return {"n": int(len(df)), "first": str(d.min().date()), "last": str(d.max().date()),
            "last_value": float(df[ccol].iloc[-1]), "columns": [str(c) for c in cols][:10]}
try:
    import vnstock
    out["version"] = getattr(vnstock, "__version__", "?")
except Exception as e:
    out["import_error"] = repr(e)[:300]
    print("__JSON__" + json.dumps(out)); sys.exit(0)
attempts = [
    ("Quote(VCI)", lambda: vnstock.Quote(source="VCI", symbol="VNINDEX").history(start=start, end=end, interval="1D")),
    ("Quote(KBS)", lambda: vnstock.Quote(source="KBS", symbol="VNINDEX").history(start=start, end=end, interval="1D")),
    ("Quote(TCBS)", lambda: vnstock.Quote(source="TCBS", symbol="VNINDEX").history(start=start, end=end, interval="1D")),
    ("Market.index.ohlcv", lambda: vnstock.Market().index.ohlcv(symbol="VNINDEX", start=start, end=end)),
]
for label, fn in attempts:
    try:
        out[label] = summ(fn())
    except Exception as e:
        out[label] = {"error": repr(e)[:300]}
print("__JSON__" + json.dumps(out, default=str))
'''

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
    return {"n": int(len(df)), "columns": [str(c) for c in df.columns][:10],
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
    "macro_china_gdp": lambda: ak.macro_china_gdp(),
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
            return {"ok": False, "ms": ms, "error": f"{label}: không có kết quả",
                    "stderr": snippet(cp.stderr, 400)}
        res = json.loads(line[len("__JSON__"):])
        ok = any(isinstance(v, dict) and v.get("n") for v in res.values())
        return {"ok": ok, "ms": ms, "lib": res}
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
    # (pid, mã FRED, mô tả)
    ("us.gdp_real", "GDPC1", "GDP thực Mỹ"),
    ("us.gdp_growth", "A191RL1Q225SBEA", "Tăng trưởng GDP thực Mỹ (năm hóa)"),
    ("us.unrate", "UNRATE", "Thất nghiệp Mỹ"),
    ("us.payems", "PAYEMS", "Việc làm phi nông nghiệp"),
    ("us.icsa", "ICSA", "Đơn trợ cấp thất nghiệp lần đầu"),
    ("us.cpi", "CPIAUCSL", "CPI Mỹ"),
    ("us.core_cpi", "CPILFESL", "CPI lõi Mỹ"),
    ("us.core_pce", "PCEPILFE", "PCE lõi"),
    ("us.be5y", "T5YIE", "Lạm phát kỳ vọng 5 năm"),
    ("us.fedfunds", "FEDFUNDS", "Lãi suất Fed (tháng)"),
    ("us.dff", "DFF", "Lãi suất Fed (ngày)"),
    ("us.dgs3mo", "DGS3MO", "Lợi suất 3 tháng"),
    ("us.dgs2", "DGS2", "Lợi suất 2 năm"),
    ("us.dgs10", "DGS10", "Lợi suất 10 năm"),
    ("us.t10y2y", "T10Y2Y", "Độ dốc 10 năm − 2 năm"),
    ("us.t10y3m", "T10Y3M", "Độ dốc 10 năm − 3 tháng"),
    ("us.nfci", "NFCI", "Chỉ số điều kiện tài chính NFCI"),
    ("us.hy_oas", "BAMLH0A0HYM2", "Chênh lệch tín dụng lợi suất cao (ICE)"),
    ("us.baa10y", "BAA10Y", "Chênh lệch Baa − 10 năm (Moody's)"),
    ("us.vix_fred", "VIXCLS", "VIX"),
    ("us.usd_broad", "DTWEXBGS", "Chỉ số USD rộng (Fed)"),
    ("us.indpro", "INDPRO", "Sản xuất công nghiệp Mỹ"),
    ("us.pmi_philly", "GACDFSA066MSFRBPHI", "Khảo sát sản xuất Philadelphia Fed"),
    ("us.pmi_empire", "GACDINA066MNFRBNY", "Khảo sát sản xuất Empire State"),
    ("us.cfnai", "CFNAI", "Chỉ số hoạt động Chicago Fed"),
    ("us.bci_oecd", "BSCICP03USM665S", "Niềm tin kinh doanh Mỹ (OECD)"),
    ("us.ism_napm", "NAPM", "ISM PMI (đã gỡ khỏi FRED năm 2016)"),
    ("px.spx_fred", "SP500", "S&P 500 (FRED, 10 năm)"),
    ("px.nasdaq_fred", "NASDAQCOM", "Nasdaq Composite (FRED)"),
    ("px.brent_fred", "DCOILBRENTEU", "Dầu Brent (EIA qua FRED)"),
    ("px.gold_fred", "GOLDAMGBD228NLBM", "Vàng LBMA trên FRED (đã ngừng)"),
    ("cn.usdcny_fred", "DEXCHUS", "USD/CNY (Fed H.10)"),
    ("cn.cpi_oecd_fred", "CHNCPIALLMINMEI", "CPI Trung Quốc (OECD qua FRED)"),
    ("cn.bci_oecd_fred", "BSCICP03CNM665S", "Niềm tin kinh doanh Trung Quốc (OECD)"),
    ("cn.cli_oecd_fred", "CHNLOLITONOSTSAM", "CLI Trung Quốc (OECD qua FRED)"),
    ("cn.m2_fred", "MYAGM2CNM189N", "M2 Trung Quốc (IMF qua FRED)"),
    ("world.ecb_dfr_fred", "ECBDFR", "Lãi suất tiền gửi ECB"),
    ("world.jp_call_fred", "IRSTCI01JPM156N", "Lãi suất qua đêm Nhật (OECD)"),
    ("world.jp_10y_fred", "IRLTLT01JPM156N", "Lợi suất 10 năm Nhật (OECD)"),
]

YAHOO_SYMBOLS = [
    ("px.spx_yahoo", "^GSPC", "S&P 500"),
    ("px.nasdaq_yahoo", "^IXIC", "Nasdaq Composite"),
    ("px.sti_yahoo", "^STI", "STI Singapore"),
    ("px.set_yahoo", "^SET.BK", "SET Thái Lan"),
    ("px.gold_yahoo", "GC=F", "Vàng (hợp đồng tương lai COMEX)"),
    ("px.brent_yahoo", "BZ=F", "Dầu Brent (hợp đồng tương lai)"),
    ("px.usdvnd_yahoo", "VND=X", "USD/VND"),
    ("px.ust10y_yahoo", "^TNX", "Lợi suất 10 năm Mỹ (CBOE TNX)"),
    ("px.dxy_yahoo", "DX-Y.NYB", "DXY"),
    ("px.vix_yahoo", "^VIX", "VIX"),
]

COINS = [("btc", "BTC", "XBTUSD"), ("eth", "ETH", "ETHUSD"), ("sol", "SOL", "SOLUSD"),
         ("doge", "DOGE", "XDGUSD"), ("trx", "TRX", "TRXUSD")]

GEM = [
    ("vn.stock_gem", "VNM", "DSTKMKTXN", "VN-Index theo tháng (World Bank GEM)"),
    ("vn.cpi_gem", "VNM", "CPTOTSAXNZGY", "CPI Việt Nam % so cùng kỳ (GEM)"),
    ("vn.ip_gem", "VNM", "IPTOTSAKD", "Sản xuất công nghiệp Việt Nam (GEM)"),
    ("vn.exports_gem", "VNM", "DXGSRMRCHSACD", "Xuất khẩu hàng hóa Việt Nam (GEM)"),
    ("vn.fx_gem", "VNM", "DPANUSSPB", "Tỷ giá VND/USD bình quân tháng (GEM)"),
    ("px.set_gem", "THA", "DSTKMKTXN", "SET theo tháng (GEM)"),
    ("px.sti_gem", "SGP", "DSTKMKTXN", "STI theo tháng (GEM)"),
    ("cn.ip_gem", "CHN", "IPTOTSAKD", "Sản xuất công nghiệp Trung Quốc (GEM)"),
]

DBN_QUERIES = [
    ("meta.dbn_cn_pmi", "China PMI"),
    ("meta.dbn_cn_lpr", "China loan prime rate"),
    ("meta.dbn_cn_10y", "China government bond yield 10 year"),
    ("meta.dbn_vn_ip", "Viet Nam industrial production"),
    ("meta.dbn_vn_cpi", "Viet Nam consumer price index"),
    ("meta.dbn_vn_rate", "Viet Nam interest rate"),
    ("meta.dbn_global_pmi", "global manufacturing PMI"),
]

EASTMONEY_REPORTS = [
    ("cn.pmi_em", "RPT_ECONOMY_PMI", "PMI sản xuất NBS (Eastmoney)"),
    ("cn.cpi_em", "RPT_ECONOMY_CPI", "CPI Trung Quốc (Eastmoney)"),
    ("cn.ppi_em", "RPT_ECONOMY_PPI", "PPI Trung Quốc (Eastmoney)"),
    ("cn.m2_em", "RPT_ECONOMY_CURRENCY_SUPPLY", "M2 Trung Quốc (Eastmoney)"),
    ("cn.gdp_em", "RPT_ECONOMY_GDP", "GDP Trung Quốc (Eastmoney)"),
    ("cn.ip_em", "RPT_ECONOMY_INDUS_GROW", "Sản xuất công nghiệp TQ (Eastmoney)"),
    ("cn.retail_em", "RPT_ECONOMY_TOTAL_RETAIL", "Bán lẻ Trung Quốc (Eastmoney)"),
]

SITES = [
    ("site.nso_vn", "https://www.nso.gov.vn/", "Cục Thống kê Việt Nam"),
    ("site.sbv", "https://www.sbv.gov.vn/", "Ngân hàng Nhà nước"),
    ("site.hsx", "https://www.hsx.vn/", "HOSE"),
    ("site.hnx", "https://hnx.vn/", "HNX (lợi suất TPCP)"),
    ("site.nbs_en", "https://www.stats.gov.cn/english/", "NBS Trung Quốc"),
    ("site.chinamoney", "https://www.chinamoney.com.cn/english/", "ChinaMoney (LPR)"),
    ("site.spglobal_pmi", "https://www.pmi.spglobal.com/", "S&P Global PMI"),
    ("site.wgb_vn10y", "https://www.worldgovernmentbonds.com/bond-historical-data/vietnam/10-years/",
     "Lợi suất TPCP Việt Nam 10 năm"),
    ("site.investing_vn10y",
     "https://www.investing.com/rates-bonds/vietnam-10-year-bond-yield-historical-data", "Investing.com"),
]


def build_probes() -> list[Probe]:
    """Danh mục đầy đủ các probe, theo thứ tự hiển thị."""
    ps: list[Probe] = []
    for pid, sid, desc in FRED_SERIES:
        ps.append(Probe(pid, desc, f"FRED {sid}", "fred.stlouisfed.org", p_fred(sid)))
    ps.append(Probe("us.fred_vintage", "PAYEMS theo vintage 2020-02-10 (ALFRED)", "FRED vintage",
                    "fred.stlouisfed.org", p_fred_vintage))
    for code, name, kpair in COINS:
        ps.append(Probe(f"px.{code}_cm", f"{name} đóng cửa ngày UTC", "Coin Metrics community",
                        "community-api.coinmetrics.io", p_coinmetrics(code)))
        ps.append(Probe(f"px.{code}_kraken", f"{name}/USD nến ngày", "Kraken", "api.kraken.com", p_kraken(kpair)))
    ps.append(Probe("px.crypto_cg_simple", "Giá hiện tại 5 coin", "CoinGecko keyless", "api.coingecko.com", p_cg_simple))
    ps.append(Probe("px.btc_cg_max", "BTC lịch sử days=max", "CoinGecko keyless", "api.coingecko.com",
                    p_cg_chart("bitcoin", "max")))
    ps.append(Probe("px.sol_cg_365", "SOL 365 ngày", "CoinGecko keyless", "api.coingecko.com",
                    p_cg_chart("solana", "365")))
    ps.append(Probe("px.btc_binance", "BTC/USDT nến ngày", "Binance api", "api.binance.com",
                    p_binance("api.binance.com")))
    ps.append(Probe("px.btc_binance_vision", "BTC/USDT nến ngày", "Binance data-api.binance.vision",
                    "data-api.binance.vision", p_binance("data-api.binance.vision")))
    for pid, sym, desc in YAHOO_SYMBOLS:
        ps.append(Probe(pid, desc, f"Yahoo {sym}", "query1.finance.yahoo.com", p_yahoo(sym)))
    ps.append(Probe("meta.yahoo_search_vni", "Tìm mã VN-Index trên Yahoo", "Yahoo search",
                    "query2.finance.yahoo.com", p_yahoo_search("VNINDEX")))
    ps.append(Probe("px.spx_stooq", "S&P 500 theo tháng", "Stooq", "stooq.com", p_stooq("^spx")))
    ps.append(Probe("px.vnindex_vndirect", "VN-Index ngày", "VNDirect dchart", "dchart-api.vndirect.com.vn",
                    p_vndirect))
    ps.append(Probe("px.vnindex_dnse", "VN-Index ngày", "DNSE (Entrade)", "services.entrade.com.vn", p_dnse))
    ps.append(Probe("px.vnindex_tcbs", "VN-Index ngày", "TCBS", "apipubaws.tcbs.com.vn", p_tcbs))
    ps.append(Probe("px.vnindex_cafef", "VN-Index ngày", "cafef", "s.cafef.vn",
                    p_cafef("PriceHistory.ashx", "giá")))
    ps.append(Probe("vn.foreign_cafef", "Khối ngoại mua bán ròng", "cafef", "s.cafef.vn",
                    p_cafef("GDKhoiNgoai.ashx", "khối ngoại")))
    ps.append(Probe("px.set_setweb", "SET 1 năm", "set.or.th API", "www.set.or.th", p_set_web))
    ps.append(Probe("px.gold_lbma_pm", "Vàng LBMA PM (USD)", "LBMA", "prices.lbma.org.uk", p_lbma("gold_pm")))
    ps.append(Probe("px.gold_lbma_am", "Vàng LBMA AM (USD)", "LBMA", "prices.lbma.org.uk", p_lbma("gold_am")))
    ps.append(Probe("px.usdvnd_vcb", "USD/VND Vietcombank", "Vietcombank XML", "portal.vietcombank.com.vn", p_vcb))
    ps.append(Probe("px.usdvnd_erapi", "USD/VND", "open.er-api.com", "open.er-api.com", p_erapi))
    ps.append(Probe("px.usdvnd_fawaz", "USD/VND mới nhất", "fawazahmed0 currency-api", "cdn.jsdelivr.net",
                    p_fawaz("latest")))
    ps.append(Probe("px.usdvnd_fawaz_2024", "USD/VND ngày 2024-03-06", "fawazahmed0 currency-api",
                    "cdn.jsdelivr.net", p_fawaz("2024-03-06")))
    ps.append(Probe("px.ust10y_treasury", "Lợi suất 10 năm Mỹ", "US Treasury CSV", "home.treasury.gov", p_treasury))
    ps.append(Probe("px.vix_cboe", "VIX", "Cboe CSV", "cdn.cboe.com", p_cboe_vix))
    for pid, iso3, code, desc in GEM:
        ps.append(Probe(pid, desc, f"World Bank GEM {code}", "api.worldbank.org", p_wb_gem(iso3, code)))
    ps.append(Probe("meta.dbn_providers", "Danh sách nhà cung cấp", "DBnomics", "api.db.nomics.world", p_dbn_providers))
    for pid, q in DBN_QUERIES:
        ps.append(Probe(pid, f"Tìm: {q}", "DBnomics search", "api.db.nomics.world", p_dbn_search(q)))
    ps.append(Probe("world.imf_weo", "Dự báo tăng trưởng thế giới (WEO)", "IMF DataMapper", "www.imf.org",
                    p_imf_datamapper))
    ps.append(Probe("meta.imf_sdmx", "Danh sách dataflow", "IMF SDMX 2.1 mới", "api.imf.org", p_imf_sdmx))
    ps.append(Probe("world.policy_bis", "Lãi suất điều hành US, EA, JP, CN, TH", "BIS WS_CBPOL", "stats.bis.org",
                    p_bis_cbpol("US+XM+JP+CN+TH")))
    ps.append(Probe("vn.policy_bis", "Lãi suất điều hành Việt Nam", "BIS WS_CBPOL", "stats.bis.org",
                    p_bis_cbpol("VN")))
    ps.append(Probe("world.cli_oecd", "CLI Mỹ, Trung Quốc, G20", "OECD SDMX", "sdmx.oecd.org", p_oecd_cli))
    ps.append(Probe("world.ecb_dfr_ecb", "Lãi suất tiền gửi ECB", "ECB Data API", "data-api.ecb.europa.eu",
                    p_ecb_dfr))
    for pid, rep, desc in EASTMONEY_REPORTS:
        ps.append(Probe(pid, desc, f"Eastmoney {rep}", "datacenter-web.eastmoney.com", p_eastmoney(rep)))
    for pid, url, desc in SITES:
        ps.append(Probe(pid, desc, url.split("/")[2], url.split("/")[2], p_status(url)))
    ps.append(Probe("lib.vnstock", "VN-Index qua thư viện vnstock", "vnstock (pip)", "lib:vnstock",
                    p_lib(VNSTOCK_CODE, "vnstock")))
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
    print(f"[{flag}] {p.pid:26s} {rec.get('first') or '':10s} → {rec.get('last') or '':10s} "
          f"{(rec.get('error') or '')[:90]}", flush=True)
    return rec


def run_all(probes: list[Probe]) -> list[dict]:
    """Chạy song song theo host, tuần tự trong cùng host (lịch sự với nguồn)."""
    groups: dict[str, list[Probe]] = defaultdict(list)
    for p in probes:
        groups[p.host].append(p)
    order = {p.pid: i for i, p in enumerate(probes)}

    def run_group(plist: list[Probe]) -> list[dict]:
        out = []
        for i, p in enumerate(plist):
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
        "runner": {"python": platform.python_version(), "platform": platform.platform(),
                   "github_run_id": os.environ.get("GITHUB_RUN_ID"), "runner_os": os.environ.get("RUNNER_OS")},
        "summary": {"total": len(results), "ok": sum(1 for r in results if r.get("ok"))},
    }
    with open(os.path.join(out_dir, "probe.json"), "w", encoding="utf-8") as f:
        json.dump({**meta, "results": results}, f, ensure_ascii=False, indent=1, default=str)
    lines = [
        "# Kết quả gọi thử nguồn số liệu", "",
        f"Chạy lúc {meta['generated_at']} trên {meta['runner']['runner_os'] or 'máy cục bộ'}; "
        f"thành công {meta['summary']['ok']}/{meta['summary']['total']} probe. "
        "Chi tiết đầy đủ trong `probe.json`.", "",
        "| id | chuỗi | nguồn | kết quả | từ | đến | n | tần suất | cũ (ngày) | ghi chú |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        note = r.get("error") or r.get("note") or ""
        lines.append("| " + " | ".join(cell(x) for x in (
            r["id"], r["series"], r["source"], "OK" if r.get("ok") else "LỖI", r.get("first"), r.get("last"),
            r.get("n"), r.get("freq"), r.get("age_days"), str(note)[:90])) + " |")
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
            print(f"{p.pid:28s} {p.source:34s} {p.series}")
        print(f"{len(probes)} probe")
        return 0
    meta = write_outputs(run_all(probes), args.out)
    print(f"Xong: {meta['summary']['ok']}/{meta['summary']['total']} probe thành công.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
