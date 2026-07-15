#!/usr/bin/env python3
"""S&P 500 natural-language screener engine.

stdin: {"tickers": [...], "names": {...}, "spec": {...}}
stdout: one JSON payload. Progress is written to stderr as STAGE lines.
"""
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from yahooquery import Ticker

CACHE_PATH = Path(os.getenv("SCREENER_CACHE_PATH", "/tmp/squall-sp500-screen-cache.json"))
CACHE_TTL = int(os.getenv("SCREENER_CACHE_TTL", "1800"))
TEST_LIMIT = int(os.getenv("SCREENER_LIMIT", "0"))
STAGES = 5


def stage(n, label):
    print(f"STAGE|{n}|{STAGES}|{label}", file=sys.stderr, flush=True)


def finite(v, default=None):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, finite(v, lo)))


def scale(v, bad, good):
    v = finite(v)
    if v is None or bad == good:
        return 50.0
    return clamp((v - bad) / (good - bad) * 100.0)


def get_symbol_modules(tickers):
    out = {t: {} for t in tickers}
    for start in range(0, len(tickers), 75):
        batch = tickers[start:start + 75]
        try:
            tq = Ticker(batch, asynchronous=True, max_workers=10, timeout=20)
            modules = {
                "price": tq.price,
                "summary": tq.summary_detail,
                "stats": tq.key_stats,
                "financial": tq.financial_data,
                "profile": tq.asset_profile,
            }
            for kind, data in modules.items():
                if not isinstance(data, dict):
                    continue
                for symbol, values in data.items():
                    if symbol in out and isinstance(values, dict):
                        out[symbol][kind] = values
        except Exception as exc:
            print(f"WARN|modules|{start}|{type(exc).__name__}", file=sys.stderr, flush=True)
    return out


def get_history(tickers):
    frames = {}
    def load_batch(batch, label, retry=True):
        try:
            hist = Ticker(batch, asynchronous=True, max_workers=12, timeout=25).history(period="1y", interval="1d")
            if not isinstance(hist, pd.DataFrame) or hist.empty:
                return
            if isinstance(hist.index, pd.MultiIndex):
                for symbol in batch:
                    try:
                        part = hist.xs(symbol, level=0).copy()
                        if len(part) >= 65:
                            frames[symbol] = part
                    except (KeyError, ValueError):
                        pass
            elif len(batch) == 1 and len(hist) >= 65:
                frames[batch[0]] = hist.copy()
        except Exception as exc:
            print(f"WARN|history|{label}|{type(exc).__name__}", file=sys.stderr, flush=True)
            # Yahoo occasionally drops an entire large batch. Smaller retries recover
            # most symbols without making the normal path hundreds of requests.
            if retry and len(batch) > 10:
                for offset in range(0, len(batch), 10):
                    load_batch(batch[offset:offset + 10], f"{label}+{offset}", retry=False)
    for start in range(0, len(tickers), 50):
        load_batch(tickers[start:start + 50], start)
    return frames


def history_features(df):
    cols = {str(c).lower(): c for c in df.columns}
    needed = [cols.get(k) for k in ("open", "high", "low", "close", "volume")]
    if any(c is None for c in needed):
        return None
    o, h, l, c, vol = (pd.to_numeric(df[x], errors="coerce") for x in needed)
    clean = pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": vol}).dropna(subset=["close", "high", "low"])
    if len(clean) < 65:
        return None
    c, h, l, vol = clean.close, clean.high, clean.low, clean.volume.fillna(0)
    last = finite(c.iloc[-1])
    if not last or last <= 0:
        return None

    prev = c.shift(1)
    tr = pd.concat([(h - l).abs(), (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    atr14 = finite(tr.tail(14).mean() / last)
    atr60 = finite(tr.tail(60).mean() / last)
    ret = lambda n: finite(last / c.iloc[-min(n + 1, len(c))] - 1, 0)
    rng = lambda n: finite((h.tail(n).max() - l.tail(n).min()) / last)
    width15, width30, width60 = rng(15), rng(30), rng(60)
    ma20, ma50, ma200 = (finite(c.tail(min(n, len(c))).mean()) for n in (20, 50, 200))
    high252 = finite(h.tail(252).max())
    low252 = finite(l.tail(252).min())
    vol20 = finite(vol.tail(20).mean(), 0)
    vol60 = finite(vol.tail(60).mean(), 0)
    volume_ratio = finite(vol.iloc[-1] / vol20) if vol20 else None
    dryup = finite(vol20 / vol60) if vol60 else None
    signed = np.sign(c.diff().fillna(0)) * vol
    obv = signed.cumsum()
    obv_slope = finite(np.polyfit(np.arange(min(30, len(obv))), obv.tail(30).values, 1)[0])
    obv_norm = finite(obv_slope / max(vol20, 1)) if obv_slope is not None else None
    up_vol = finite(vol.where(c.diff() > 0, 0).tail(20).sum() / max(vol.tail(20).sum(), 1))
    daily = c.pct_change().dropna()
    volatility = finite(daily.tail(60).std() * math.sqrt(252))
    rolling_peak = c.cummax()
    max_drawdown = finite((c / rolling_peak - 1).tail(252).min())
    prior20 = finite(h.iloc[-21:-1].max()) if len(h) >= 21 else finite(h.iloc[:-1].max())

    contraction_short = np.mean([
        scale(width15, 0.18, 0.04), scale(finite(atr14 / atr60) if atr60 else None, 1.15, 0.65),
        scale(dryup, 1.15, 0.60), scale(finite(last / high252 - 1) if high252 else None, -0.30, -0.02)
    ])
    contraction_long = np.mean([
        scale(width60, 0.38, 0.10), scale(width30, 0.26, 0.07),
        scale(finite(atr14 / atr60) if atr60 else None, 1.15, 0.65), scale(dryup, 1.15, 0.60)
    ])
    vcp = np.mean([
        100 if width15 is not None and width30 is not None and width60 is not None and width15 < width30 < width60 else 20,
        scale(finite(width15 / width60) if width60 else None, 0.85, 0.30), scale(dryup, 1.10, 0.55),
        scale(finite(last / high252 - 1) if high252 else None, -0.25, -0.02)
    ])
    trend = np.mean([
        100 if ma20 and ma50 and ma200 and last > ma20 > ma50 > ma200 else 45 if ma50 and ma200 and last > ma50 > ma200 else 10,
        scale(ret(60), -0.12, 0.28), scale(ret(252), -0.20, 0.50)
    ])
    accumulation = np.mean([scale(up_vol, 0.38, 0.68), scale(obv_norm, -1.5, 1.5), scale(ret(20), -0.08, 0.12)])
    breakout = np.mean([
        scale(finite(last / prior20 - 1) if prior20 else None, -0.06, 0.04),
        scale(volume_ratio, 0.70, 2.0), scale(ret(20), -0.05, 0.18), trend
    ])
    low_vol = np.mean([scale(volatility, 0.55, 0.14), scale(max_drawdown, -0.40, -0.08), scale(atr14, 0.045, 0.012)])

    return {
        "price": last, "return_20d": ret(20), "return_60d": ret(60), "return_1y": ret(252),
        "range_15d": width15, "range_30d": width30, "range_60d": width60,
        "atr_pct": atr14, "atr_contraction": finite(atr14 / atr60) if atr60 else None,
        "volume": finite(vol.iloc[-1]), "avg_volume_20d": vol20, "volume_ratio": volume_ratio,
        "volume_dryup": dryup, "up_volume_ratio": up_vol, "volatility": volatility,
        "max_drawdown_1y": max_drawdown, "distance_52w_high": finite(last / high252 - 1) if high252 else None,
        "distance_52w_low": finite(last / low252 - 1) if low252 else None,
        "ma20": ma20, "ma50": ma50, "ma200": ma200,
        "scores": {
            "consolidation_short": round(clamp(contraction_short), 1),
            "consolidation_long": round(clamp(contraction_long), 1),
            "volatility_contraction": round(clamp(vcp), 1),
            "uptrend": round(clamp(trend), 1), "accumulation": round(clamp(accumulation), 1),
            "breakout": round(clamp(breakout), 1), "momentum": round(clamp(np.mean([trend, scale(ret(20), -0.08, 0.18)])), 1),
            "near_highs": round(scale(finite(last / high252 - 1) if high252 else None, -0.30, 0), 1),
            "low_volatility": round(clamp(low_vol), 1), "oversold": round(scale(ret(20), 0.08, -0.18), 1)
        }
    }


def build_universe(tickers, names):
    if TEST_LIMIT:
        tickers = tickers[:TEST_LIMIT]
    cached = None
    try:
        if CACHE_PATH.exists() and time.time() - CACHE_PATH.stat().st_mtime < CACHE_TTL:
            cached = json.loads(CACHE_PATH.read_text())
            cached_symbols = {r.get("ticker") for r in cached.get("rows", [])}
            if set(tickers).issubset(cached_symbols):
                stage(2, "Using fresh S&P 500 market cache")
                return [r for r in cached["rows"] if r.get("ticker") in set(tickers)], True
    except Exception:
        pass

    stage(1, f"Loading one year of prices for {len(tickers)} S&P stocks")
    histories = get_history(tickers)
    stage(2, "Loading sectors, valuation, and company statistics")
    modules = get_symbol_modules(tickers)
    rows = []
    for ticker in tickers:
        feat = history_features(histories.get(ticker)) if ticker in histories else None
        if not feat:
            continue
        m = modules.get(ticker, {})
        price, summary, stats, financial, profile = (m.get(x, {}) for x in ("price", "summary", "stats", "financial", "profile"))
        feat.update({
            "ticker": ticker, "name": names.get(ticker) or price.get("longName") or price.get("shortName") or ticker,
            "sector": profile.get("sector") or "Unknown", "industry": profile.get("industry") or "Unknown",
            "market_cap": finite(price.get("marketCap")),
            "pe": finite(summary.get("trailingPE")), "forward_pe": finite(summary.get("forwardPE")),
            "dividend_yield": finite(summary.get("dividendYield")),
            "revenue_growth": finite(financial.get("revenueGrowth")), "earnings_growth": finite(financial.get("earningsGrowth")),
            "profit_margin": finite(financial.get("profitMargins")), "debt_to_equity": finite(financial.get("debtToEquity")),
            "beta": finite(stats.get("beta")),
        })
        feat["scores"].update({
            "value": round(np.mean([scale(feat["pe"], 40, 10), scale(feat["forward_pe"], 35, 9)]), 1),
            "growth": round(np.mean([scale(feat["revenue_growth"], -0.05, 0.30), scale(feat["earnings_growth"], -0.10, 0.40)]), 1),
            "quality": round(np.mean([scale(feat["profit_margin"], -0.02, 0.30), scale(feat["debt_to_equity"], 250, 20)]), 1),
            "income": round(scale(feat["dividend_yield"], 0, 0.05), 1),
        })
        rows.append(feat)
    try:
        CACHE_PATH.write_text(json.dumps({"created_at": time.time(), "rows": rows}, separators=(",", ":")))
    except Exception:
        pass
    return rows, False


CONCEPT_LABELS = {
    "consolidation": "Consolidation", "volatility_contraction": "Volatility contraction", "uptrend": "Uptrend",
    "accumulation": "Institutional accumulation", "breakout": "Breakout quality", "momentum": "Momentum",
    "near_highs": "Near 52-week highs", "low_volatility": "Lower volatility", "oversold": "Oversold pullback",
    "value": "Value", "growth": "Growth", "quality": "Business quality", "income": "Income"
}


def concept_score(row, concept, settings):
    if concept == "consolidation":
        window = int(settings.get("consolidation_window", 30))
        return row["scores"]["consolidation_short" if window <= 30 else "consolidation_long"]
    return finite(row.get("scores", {}).get(concept), 50)


def passes_filters(row, filters):
    sector = str(filters.get("sector") or "").lower().strip()
    if sector and sector not in str(row.get("sector", "")).lower() and sector not in str(row.get("industry", "")).lower():
        return False
    checks = [
        ("market_cap_min", lambda v: row.get("market_cap") is not None and row["market_cap"] >= v),
        ("market_cap_max", lambda v: row.get("market_cap") is not None and row["market_cap"] <= v),
        ("price_min", lambda v: row["price"] >= v), ("price_max", lambda v: row["price"] <= v),
        ("pe_max", lambda v: row.get("pe") is not None and row["pe"] <= v),
        ("volume_min", lambda v: row.get("avg_volume_20d") is not None and row["avg_volume_20d"] >= v),
        ("dividend_yield_min", lambda v: row.get("dividend_yield") is not None and row["dividend_yield"] >= v),
    ]
    for key, fn in checks:
        val = finite(filters.get(key))
        if val is not None and not fn(val):
            return False
    return True


def fmt_pct(v):
    return "N/A" if v is None else f"{v:+.1%}"


def explain(row, concepts, settings):
    reasons = []
    for c in sorted(concepts, key=lambda x: concept_score(row, x["id"], settings) * x.get("weight", 1), reverse=True)[:3]:
        cid = c["id"]
        if cid == "consolidation": reasons.append(f"{CONCEPT_LABELS[cid]}: {row['range_30d']:.1%} 30-day range with ATR {row['atr_contraction']:.2f}× its 60-day norm")
        elif cid == "volatility_contraction": reasons.append(f"Volatility contraction: 15/60-day range ratio {row['range_15d']/max(row['range_60d'], .0001):.2f} and volume {row['volume_dryup']:.2f}× normal")
        elif cid == "near_highs": reasons.append(f"Near highs: {fmt_pct(row['distance_52w_high'])} from its 52-week high")
        elif cid in ("uptrend", "momentum"): reasons.append(f"Trend: 20-day {fmt_pct(row['return_20d'])}, 60-day {fmt_pct(row['return_60d'])}")
        elif cid == "accumulation": reasons.append(f"Accumulation: {row['up_volume_ratio']:.0%} of recent volume occurred on up days")
        elif cid == "breakout": reasons.append(f"Breakout quality: volume is {row['volume_ratio']:.2f}× its 20-day average")
        elif cid == "low_volatility": reasons.append(f"Risk: {row['volatility']:.0%} annualized volatility and {fmt_pct(row['max_drawdown_1y'])} max drawdown")
        elif cid == "value": reasons.append(f"Valuation: {row['pe']:.1f}× trailing earnings" if row.get("pe") else "Valuation data was limited")
        elif cid == "growth": reasons.append(f"Growth: revenue {fmt_pct(row.get('revenue_growth'))}, earnings {fmt_pct(row.get('earnings_growth'))}")
        elif cid == "quality": reasons.append(f"Quality: {fmt_pct(row.get('profit_margin'))} profit margin")
        elif cid == "income": reasons.append(f"Income: {fmt_pct(row.get('dividend_yield'))} dividend yield")
        elif cid == "oversold": reasons.append(f"Pullback: 20-day return {fmt_pct(row['return_20d'])}")
    return reasons


def screen(rows, spec):
    concepts = spec.get("concepts") or [{"id": "quality", "weight": 1}]
    settings = spec.get("settings") or {}
    filters = spec.get("filters") or {}
    threshold = clamp(settings.get("match_threshold", 48), 20, 85)
    ranked = []
    for row in rows:
        if not passes_filters(row, filters):
            continue
        scores = [(c, concept_score(row, c.get("id"), settings)) for c in concepts if c.get("id") in CONCEPT_LABELS]
        if not scores:
            continue
        total_weight = sum(max(.1, finite(c.get("weight"), 1)) for c, _ in scores)
        score = sum(s * max(.1, finite(c.get("weight"), 1)) for c, s in scores) / total_weight
        must = [s for c, s in scores if c.get("required")]
        if score < threshold or (must and min(must) < max(30, threshold - 12)):
            continue
        result = {k: row.get(k) for k in ("ticker", "name", "sector", "industry", "price", "market_cap", "pe", "return_20d", "return_60d", "distance_52w_high", "volume_ratio", "volatility")}
        result.update({"match_score": round(score, 1), "concept_scores": {c["id"]: round(s, 1) for c, s in scores}, "reasons": explain(row, concepts, settings)})
        ranked.append(result)
    ranked.sort(key=lambda x: x["match_score"], reverse=True)
    return ranked[:int(clamp(spec.get("max_results", 20), 5, 50))]


def main():
    payload = json.load(sys.stdin)
    tickers = [str(t).upper() for t in payload.get("tickers", []) if t]
    names = payload.get("names") or {}
    spec = payload.get("spec") or {}
    stage(0, "Reading the S&P 500 universe")
    rows, cached = build_universe(tickers, names)
    stage(3, "Scoring fuzzy concepts with deterministic rules")
    results = screen(rows, spec)
    stage(4, "Explaining why each company matched")
    output = {
        "universe": "S&P 500", "universe_requested": len(tickers), "universe_scored": len(rows),
        "cache_hit": cached, "spec": spec, "results": results,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "definitions_version": 1
    }
    stage(5, f"Found {len(results)} matching stocks")
    json.dump(output, sys.stdout, separators=(",", ":"), allow_nan=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        json.dump({"error": str(exc)}, sys.stdout)
        sys.exit(1)
