#!/usr/bin/env python3
"""Multi-index natural-language stock screener engine.

stdin: {"tickers": [...], "names": {...}, "memberships": {...}, "spec": {...}}
stdout: one JSON payload. Progress is written to stderr as PROGRESS lines.
"""
import json
import math
import os
import re
import sys
import time
import traceback
from pathlib import Path

from quant_utils import wilder_rsi
from financial_rules import business_model
import numpy as np
import pandas as pd
from yahooquery import Ticker

CACHE_PATH = Path(os.getenv("SCREENER_CACHE_PATH", "/tmp/squall-sp500-screen-cache.json"))
CACHE_TTL = int(os.getenv("SCREENER_CACHE_TTL", "1800"))
TEST_LIMIT = int(os.getenv("SCREENER_LIMIT", "0"))
STAGES = 5
CACHE_VERSION = 10  # confirmed upstream coverage; empty Yahoo responses never poison the cache

# Missing bank capital/credit and REIT FFO data must not be replaced with industrial ratios.
MODEL_UNSUPPORTED = {
    "financial": {"balance_sheet", "cash_generation", "quality", "high_margin", "cash_rich", "low_debt", "fcf_yield", "capital_efficiency", "dividend_quality", "profitable_growth", "garp", "quality_value", "steady_compounder", "defensive_quality", "speculative_growth"},
    "reit": {"value", "profitability", "quality", "high_margin", "cash_generation", "fcf_yield", "capital_efficiency", "income", "dividend_quality", "profitable_growth", "garp", "quality_value", "steady_compounder", "defensive_quality", "speculative_growth"}
}


def apply_financial_model(row):
    model = business_model(row.get("sector"), row.get("industry"), row.get("ticker"))
    row["financial_model"] = model
    row["unsupported_concepts"] = sorted(MODEL_UNSUPPORTED.get(model, set()))
    if model == "financial":
        row["scores"]["value"] = finite(blend([valuation_score(row.get("pe"), 40, 10), valuation_score(row.get("price_to_book"), 5, .7)]))
        row["scores"]["profitability"] = finite(blend([scale(row.get("return_on_equity"), 0, .20), scale(row.get("return_on_assets"), 0, .02)]))
    for key in row["unsupported_concepts"]:
        row["scores"][key] = None
    # Negative earnings must not make a negative payout ratio look exceptionally safe.
    if row.get("payout_ratio") is not None and row["payout_ratio"] < 0:
        row["scores"]["income"] = row["scores"]["dividend_quality"] = None
    row["fundamental_basis"] = "Heuristic component scales, compared only within the same sector/business model; not fair value or a forecast. Financial firms lack capital/credit tests; REITs lack FFO/AFFO."
    return row

# ── Upstream backpressure ─────────────────────────────────────────────────────
# A cold run pulls ~600 symbols twice (history + modules), which is by far the
# densest burst this app makes. The retry tiers below exist because Yahoo sometimes
# drops a whole batch — but the most common REASON it drops a batch is that it is
# already rate limiting us. Fanning a failed batch of 50 out into 50 single requests
# therefore answers throttling by roughly doubling the request count, which deepens
# the throttling: a feedback loop straight into an IP block.
#
# So fan-out is gated three ways: it never runs on a throttle signature, it stops
# entirely for the rest of the run once any throttle signal is seen, and it draws
# from a fixed per-run budget so even a run of ordinary failures cannot multiply its
# own footprint without bound.
THROTTLE_RE = re.compile(r"429|too\s*many\s*requests|rate.?limit|throttl|forbidden|unauthorized", re.I)
RETRY_BUDGET = int(os.getenv("SCREENER_RETRY_BUDGET", "60"))
THROTTLE_BACKOFF = float(os.getenv("SCREENER_THROTTLE_BACKOFF", "5.0"))

_throttled = False        # sticky for the run once Yahoo signals backpressure
_retry_budget_left = RETRY_BUDGET


class EmptyHistoryResponse(RuntimeError):
    """Yahoo completed the request but supplied no usable history rows."""


class HistoryResult(dict):
    """Price frames plus the symbols the upstream response actually accounted for."""

    def __init__(self):
        super().__init__()
        self.confirmed = set()


def looks_throttled(exc):
    """Yahoo surfaces rate limiting as assorted exception types; match on the text."""
    return bool(THROTTLE_RE.search(f"{type(exc).__name__} {exc}"))


def note_failure(exc):
    """Record a batch failure and report whether fan-out is still permitted."""
    global _throttled
    if looks_throttled(exc):
        _throttled = True
    return _throttled


def take_retry_budget():
    global _retry_budget_left
    if _retry_budget_left <= 0:
        return False
    _retry_budget_left -= 1
    return True


def stage(n, label):
    print(f"STAGE|{n}|{STAGES}|{label}", file=sys.stderr, flush=True)


def progress(percent, label):
    print(f"PROGRESS|{int(clamp(percent))}|{label}", file=sys.stderr, flush=True)


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
        return float("nan")
    return clamp((v - bad) / (good - bad) * 100.0)


def band_score(v, ideal_low, ideal_high, outer_low, outer_high):
    """Score a value highest inside an accepted band and taper to zero outside it."""
    v = finite(v)
    if v is None:
        return float("nan")
    if v <= outer_low or v >= outer_high:
        return 0.0
    if ideal_low <= v <= ideal_high:
        return 100.0
    if v < ideal_low:
        return scale(v, outer_low, ideal_low)
    return scale(v, outer_high, ideal_high)


def blend(values):
    """A composite requires evidence for every component; no neutral imputation."""
    values = [finite(v) for v in values]
    return float("nan") if not values or any(v is None for v in values) else sum(values) / len(values)


def score_bound(value):
    return clamp(value) if finite(value) is not None else float("nan")


def valuation_score(value, bad, good):
    value = finite(value)
    return scale(value if value is not None and value > 0 else None, bad, good)


def debt_score(value, bad, good):
    value = finite(value)
    return scale(value if value is not None and value >= 0 else None, bad, good)


def cup_handle_fit(close, volume, trend_score):
    """Return a deterministic cup-with-handle shape score and its best-fit measurements.

    This is a candidate detector, not a declaration that a subjective chart pattern
    exists. It looks for a 1-6 month rounded base, comparable left/right lips, and a
    shorter, shallower handle in the upper portion of the cup.
    """
    best = {"score": 0.0, "cup_depth": None, "handle_depth": None, "pivot": None}
    last = finite(close.iloc[-1])
    if last is None:
        return best
    for cup_len in (60, 90, 120, 150):
        for handle_len in (5, 10, 15, 20):
            if len(close) < cup_len + handle_len + 25:
                continue
            cup = close.iloc[-(cup_len + handle_len):-handle_len]
            handle = close.iloc[-handle_len:]
            cup_vol = volume.iloc[-(cup_len + handle_len):-handle_len]
            handle_vol = volume.iloc[-handle_len:]
            edge = max(4, min(10, cup_len // 10))
            left_lip = finite(cup.iloc[:edge].mean())
            right_lip = finite(cup.iloc[-edge:].mean())
            bottom = finite(cup.min())
            if not left_lip or not right_lip or not bottom:
                continue
            lip = (left_lip + right_lip) / 2
            depth = finite((lip - bottom) / lip)
            if depth is None or depth <= 0:
                continue
            bottom_pos = int(np.argmin(cup.values)) / max(1, len(cup) - 1)
            symmetry = abs(left_lip - right_lip) / lip
            middle = finite(cup.iloc[cup_len // 3:cup_len * 2 // 3].mean())
            shoulders = finite(pd.concat([cup.iloc[:cup_len // 5], cup.iloc[-cup_len // 5:]]).mean())
            rounded = scale(finite((shoulders - middle) / lip) if shoulders and middle else None, 0, max(.04, depth * .55))
            handle_low = finite(handle.min())
            handle_depth = finite((right_lip - handle_low) / right_lip) if handle_low else None
            handle_ratio = finite(handle_depth / depth) if depth and handle_depth is not None else None
            upper_half = scale(finite((handle_low - bottom) / max(lip - bottom, .0001)) if handle_low else None, .45, .82)
            volume_ratio = finite(handle_vol.mean() / cup_vol.mean()) if finite(cup_vol.mean(), 0) else None
            pivot = max(left_lip, right_lip)
            pivot_distance = finite(last / pivot - 1) if pivot else None
            score = blend([
                band_score(depth, .12, .33, .06, .48),
                scale(symmetry, .16, .015),
                scale(abs(bottom_pos - .5), .42, .05),
                rounded,
                band_score(handle_ratio, .05, .33, 0, .65),
                upper_half,
                scale(volume_ratio, 1.2, .65),
                scale(abs(pivot_distance) if pivot_distance is not None else None, .18, 0),
                trend_score,
            ])
            if score > best["score"]:
                best = {
                    "score": round(score_bound(score), 1), "cup_depth": depth,
                    "handle_depth": handle_depth, "pivot": pivot,
                    "cup_days": cup_len, "handle_days": handle_len
                }
    return best


def double_bottom_fit(close, trend_score):
    """Score a W-shaped base with two similar lows and a defined midpoint pivot."""
    values = close.tail(min(140, len(close))).to_numpy(dtype=float)
    if len(values) < 70:
        return {"score": 0.0, "low_similarity": None, "pivot": None}
    candidates = []
    for i in range(5, len(values) - 5):
        if values[i] == np.nanmin(values[i - 5:i + 6]):
            candidates.append(i)
    best = {"score": 0.0, "low_similarity": None, "pivot": None}
    for a in candidates:
        for b in candidates:
            separation = b - a
            if separation < 15 or separation > 75:
                continue
            first, second = values[a], values[b]
            midpoint = float(np.nanmax(values[a:b + 1]))
            if min(first, second) <= 0 or midpoint <= 0:
                continue
            similarity = abs(first - second) / max(first, second)
            rebound = (midpoint - min(first, second)) / midpoint
            latest = values[-1]
            pivot_distance = latest / midpoint - 1
            score = blend([
                scale(similarity, .10, .01),
                band_score(rebound, .10, .32, .05, .50),
                scale(abs(pivot_distance), .20, 0),
                scale(b / len(values), .45, .82),
                trend_score,
            ])
            if score > best["score"]:
                best = {"score": round(score_bound(score), 1), "low_similarity": similarity, "pivot": midpoint}
    return best


def get_symbol_modules(tickers):
    out = {t: {} for t in tickers}
    starts = list(range(0, len(tickers), 75))
    for completed, start in enumerate(starts, 1):
        batch = tickers[start:start + 75]
        # History runs first, so a throttle signal from that phase is already known
        # here. Spacing the remaining batches is the cheapest way to stop the second
        # half of a run from finishing the job the first half started.
        if _throttled:
            time.sleep(THROTTLE_BACKOFF)
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
            throttled = note_failure(exc)
            print(f"WARN|modules|{start}|{type(exc).__name__}|{'429' if throttled else 'error'}",
                  file=sys.stderr, flush=True)
        progress(58 + 26 * completed / max(1, len(starts)), f"Loading company data · batch {completed} of {len(starts)}")
    return out


def probe_history(symbol):
    """
    One-shot diagnostic for a run where no history came back at all. yahooquery drops
    every symbol whose chart request errored, so the batch surfaces only as an empty
    frame and Yahoo's actual reply (429 text, crumb error, ...) is lost. Asking for one
    symbol through both the async and sync paths records what Yahoo said and whether
    concurrency is what it objects to. Two small requests, once per failed run.
    """
    out = []
    for mode, kwargs in (("async", {"asynchronous": True, "max_workers": 12}), ("sync", {})):
        try:
            data = Ticker([symbol], timeout=15, **kwargs)._get_data("chart", {"range": "5d", "interval": "1d"})
            reply = data.get(symbol) if isinstance(data, dict) else data
            if isinstance(reply, dict) and "timestamp" in reply:
                out.append(f"{mode}=ok:{len(reply['timestamp'])}bars")
            else:
                text = re.sub(r"\s+", " ", repr(reply))[:160]
                out.append(f"{mode}={text}")
        except Exception as exc:
            out.append(f"{mode}={type(exc).__name__}:{str(exc)[:160]}")
    return f"{symbol} " + " | ".join(out)


def get_history(tickers):
    frames = HistoryResult()
    def load_batch(batch, label, retry=True):
        try:
            hist = Ticker(batch, asynchronous=True, max_workers=12, timeout=25).history(period="2y", interval="1d", adj_ohlc=True)
            if not isinstance(hist, pd.DataFrame) or hist.empty:
                raise EmptyHistoryResponse("Yahoo returned an empty history response")
            if isinstance(hist.index, pd.MultiIndex):
                answered = {str(symbol).upper() for symbol in hist.index.get_level_values(0).unique()}
                frames.confirmed.update(symbol for symbol in batch if symbol.upper() in answered)
                for symbol in batch:
                    try:
                        part = hist.xs(symbol, level=0).copy()
                        if len(part) >= 65:
                            frames[symbol] = part
                    except (KeyError, ValueError):
                        pass
            elif len(batch) == 1:
                frames.confirmed.add(batch[0])
                if len(hist) >= 65:
                    frames[batch[0]] = hist.copy()
        except Exception as exc:
            throttled = note_failure(exc)
            # The |429 marker is what makes this line machine-readable upstream: the
            # server counts throttle signals separately from ordinary failures.
            print(f"WARN|history|{label}|{type(exc).__name__}|{'429' if throttled else 'error'}",
                  file=sys.stderr, flush=True)
            if throttled:
                # Back off and take the loss for these symbols. Retrying here is what
                # turns a throttle into a block; the partial result still gets cached
                # and merged, so coverage recovers on a later run instead.
                time.sleep(THROTTLE_BACKOFF)
                return
            # Genuine transient failure — recover in tiers, but only on borrowed budget.
            if retry and len(batch) > 10:
                for offset in range(0, len(batch), 10):
                    if not take_retry_budget():
                        break
                    load_batch(batch[offset:offset + 10], f"{label}+{offset}", retry=False)
            elif retry and len(batch) > 1:
                for offset, symbol in enumerate(batch):
                    if not take_retry_budget():
                        break
                    load_batch([symbol], f"{label}.{offset}", retry=False)
    starts = list(range(0, len(tickers), 50))
    for completed, start in enumerate(starts, 1):
        load_batch(tickers[start:start + 50], start)
        progress(12 + 44 * completed / max(1, len(starts)), f"Loading price history · batch {completed} of {len(starts)}")
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
    ret = lambda n: finite(last / c.iloc[-n - 1] - 1) if len(c) > n else None
    rng = lambda n: finite((h.tail(n).max() - l.tail(n).min()) / last)
    width15, width30, width60 = rng(15), rng(30), rng(60)
    ma20, ma50, ma200 = (finite(c.tail(n).mean()) if len(c) >= n else None for n in (20, 50, 200))
    ma50_series = c.rolling(50).mean()
    above_ma50 = finite((c.tail(60) > ma50_series.tail(60)).mean()) if len(c) >= 109 else None
    distance_ma20 = finite(last / ma20 - 1) if ma20 else None
    distance_ma50 = finite(last / ma50 - 1) if ma50 else None
    high252 = finite(h.tail(252).max()) if len(h) >= 252 else None
    low252 = finite(l.tail(252).min()) if len(l) >= 252 else None
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
    rsi14 = finite(wilder_rsi(c).iloc[-1])
    positive_days = finite((daily.tail(60) > 0).mean())
    window = c.tail(253)
    max_drawdown = finite((window / window.cummax() - 1).min()) if len(c) >= 253 else None
    prior20 = finite(h.iloc[-21:-1].max()) if len(h) >= 21 else finite(h.iloc[:-1].max())

    contraction_short = blend([
        scale(width15, 0.18, 0.04), scale(finite(atr14 / atr60) if atr60 else None, 1.15, 0.65),
        scale(dryup, 1.15, 0.60), scale(finite(last / high252 - 1) if high252 else None, -0.30, -0.02)
    ])
    contraction_long = blend([
        scale(width60, 0.38, 0.10), scale(width30, 0.26, 0.07),
        scale(finite(atr14 / atr60) if atr60 else None, 1.15, 0.65), scale(dryup, 1.15, 0.60)
    ])
    vcp = blend([
        100 if width15 is not None and width30 is not None and width60 is not None and width15 < width30 < width60 else 20,
        scale(finite(width15 / width60) if width60 else None, 0.85, 0.30), scale(dryup, 1.10, 0.55),
        scale(finite(last / high252 - 1) if high252 else None, -0.25, -0.02)
    ])
    trend = blend([
        100 if ma20 and ma50 and ma200 and last > ma20 > ma50 > ma200 else 45 if ma50 and ma200 and last > ma50 > ma200 else 10,
        scale(ret(60), -0.12, 0.28), scale(ret(252), -0.20, 0.50)
    ])
    contraction_count = sum([
        bool(width30 and width60 and width30 < width60 * .86),
        bool(width15 and width30 and width15 < width30 * .80),
        bool(atr14 and atr60 and atr14 < atr60 * .85),
    ])
    vcp_pattern = blend([
        scale(contraction_count, 0, 3), scale(finite(width15 / width60) if width60 else None, .75, .25),
        scale(dryup, 1.15, .55), scale(finite(atr14 / atr60) if atr60 else None, 1.10, .60),
        scale(finite(last / high252 - 1) if high252 else None, -.28, -.02), trend
    ])
    cup_fit = cup_handle_fit(c, vol, trend)
    double_fit = double_bottom_fit(c, trend)
    flat_base = blend([
        band_score(width60, .05, .16, .025, .25), scale(width30, .22, .06),
        scale(dryup, 1.15, .62), scale(finite(last / high252 - 1) if high252 else None, -.20, -.015),
        trend
    ])
    prior_flag_price = finite(c.iloc[-31]) if len(c) >= 31 else None
    flag_peak = finite(c.iloc[-11:-4].max()) if len(c) >= 31 else None
    flag_impulse = finite(flag_peak / prior_flag_price - 1) if prior_flag_price and flag_peak else None
    flag_pullback = finite(last / flag_peak - 1) if flag_peak else None
    flag_range = rng(10)
    flag_volume = finite(vol.tail(10).mean() / vol.iloc[-30:-10].mean()) if finite(vol.iloc[-30:-10].mean(), 0) else None
    bull_flag = blend([
        band_score(flag_impulse, .10, .40, .04, .70), band_score(flag_pullback, -.12, -.01, -.22, .04),
        scale(flag_range, .18, .04), scale(flag_volume, 1.25, .62), trend
    ])
    accumulation = blend([scale(up_vol, 0.38, 0.68), scale(obv_norm, -1.5, 1.5), scale(ret(20), -0.08, 0.12)])
    breakout = blend([
        scale(finite(last / prior20 - 1) if prior20 else None, -0.06, 0.04),
        scale(volume_ratio, 0.70, 2.0), scale(ret(20), -0.05, 0.18), trend
    ])
    low_vol = blend([scale(volatility, 0.55, 0.14), scale(max_drawdown, -0.40, -0.08), scale(atr14, 0.045, 0.012)])
    pullback = blend([trend, scale(abs(distance_ma20) if distance_ma20 is not None else None, 0.12, 0), scale(abs(distance_ma50) if distance_ma50 is not None else None, 0.18, 0)])
    golden = blend([100 if ma50 and ma200 and ma50 > ma200 else 10, scale(finite(ma50 / ma200 - 1) if ma50 and ma200 else None, -0.08, 0.12), scale(distance_ma50, -0.12, 0.18)])
    recovery = blend([scale(ret(20), -0.10, 0.16), scale(finite(last / high252 - 1) if high252 else None, -0.55, -0.10), scale(distance_ma20, -0.10, 0.10)])
    stable = blend([scale(above_ma50, 0.30, 0.90), scale(max_drawdown, -0.40, -0.08), scale(volatility, 0.55, 0.16)])
    efficient = blend([scale(ret(60), -0.12, 0.30), scale(finite(ret(60) / volatility) if volatility else None, -0.3, 1.2)])
    momentum_short = blend([scale(ret(10), -.08, .15), scale(ret(20), -.10, .24), scale(rsi14, 35, 70)])
    momentum_medium = blend([trend, scale(ret(60), -.12, .30), scale(positive_days, .38, .62)])
    momentum_long = blend([scale(ret(126), -.18, .40), scale(ret(252), -.25, .65), stable])

    result = {
        "price": last, "return_5d": ret(5), "return_20d": ret(20), "return_60d": ret(60),
        "return_126d": ret(126), "return_1y": ret(252), "rsi14": rsi14, "positive_days_60d": positive_days,
        "range_15d": width15, "range_30d": width30, "range_60d": width60,
        "atr_pct": atr14, "atr_contraction": finite(atr14 / atr60) if atr60 else None,
        "avg_dollar_volume": finite((c * vol).tail(20).mean()),
        "volume": finite(vol.iloc[-1]), "avg_volume_20d": vol20, "volume_ratio": volume_ratio,
        "volume_dryup": dryup, "up_volume_ratio": up_vol, "volatility": volatility,
        "max_drawdown_1y": max_drawdown, "distance_52w_high": finite(last / high252 - 1) if high252 else None,
        "distance_52w_low": finite(last / low252 - 1) if low252 else None,
        "ma20": ma20, "ma50": ma50, "ma200": ma200, "distance_ma20": distance_ma20,
        "distance_ma50": distance_ma50, "above_ma50": above_ma50, "obv_norm": obv_norm,
        "vcp_contractions": contraction_count, "cup_depth": cup_fit.get("cup_depth"),
        "handle_depth": cup_fit.get("handle_depth"), "cup_pivot": cup_fit.get("pivot"),
        "cup_days": cup_fit.get("cup_days"), "handle_days": cup_fit.get("handle_days"),
        "double_bottom_similarity": double_fit.get("low_similarity"), "double_bottom_pivot": double_fit.get("pivot"),
        "bull_flag_impulse": flag_impulse, "bull_flag_pullback": flag_pullback,
        "scores": {
            "consolidation_short": round(score_bound(contraction_short), 1),
            "consolidation_long": round(score_bound(contraction_long), 1),
            "volatility_contraction": round(score_bound(vcp), 1),
            "uptrend": round(score_bound(trend), 1), "accumulation": round(score_bound(accumulation), 1),
            "breakout": round(score_bound(breakout), 1), "momentum": round(score_bound(momentum_medium), 1),
            "momentum_short": round(score_bound(momentum_short), 1), "momentum_medium": round(score_bound(momentum_medium), 1),
            "momentum_long": round(score_bound(momentum_long), 1),
            "near_highs": round(scale(finite(last / high252 - 1) if high252 else None, -0.30, 0), 1),
            "low_volatility": round(score_bound(low_vol), 1), "high_volatility": round(score_bound(100-low_vol), 1),
            "oversold": round(blend([scale(ret(20), 0.08, -0.18), scale(distance_ma20, .08, -.15)]), 1),
            "downtrend": round(score_bound(100-trend), 1), "distribution": round(score_bound(100-accumulation), 1),
            "recovery": round(score_bound(recovery), 1), "pullback_to_ma": round(score_bound(pullback), 1),
            "golden_cross": round(score_bound(golden), 1), "volume_surge": round(scale(volume_ratio, .6, 2.2), 1),
            "volume_dryup": round(blend([scale(dryup, 1.2, .55), contraction_short]), 1),
            "trend_stability": round(score_bound(stable), 1), "risk_adjusted_momentum": round(score_bound(efficient), 1),
            "vcp": round(score_bound(vcp_pattern), 1), "cup_and_handle": cup_fit["score"],
            "flat_base": round(score_bound(flat_base), 1), "double_bottom": double_fit["score"],
            "bull_flag": round(score_bound(bull_flag), 1)
        }
    }
    result["scores"] = {k: finite(v) for k, v in result["scores"].items()}
    return result


def read_cache():
    """
    Load the cache as (rows_by_ticker, covered) keeping only entries still inside the
    TTL. Freshness is judged per entry rather than by the file's mtime because the
    write path merges: a file rewritten a moment ago can carry rows fetched much
    earlier, and an mtime check would keep renewing them forever.

    `covered` is every ticker accounted for by a non-empty upstream response, which
    is deliberately a superset of the tickers that produced rows. This still records
    a new listing with under 65 sessions when Yahoo actually returned it, but never
    turns a total provider outage into a fresh, empty universe.
    """
    try:
        if not CACHE_PATH.exists():
            return {}, {}
        cached = json.loads(CACHE_PATH.read_text())
        if cached.get("version") != CACHE_VERSION:
            return {}, {}
        now = time.time()
        covered = {t: ts for t, ts in (cached.get("covered") or {}).items()
                   if now - finite(ts, 0) < CACHE_TTL}
        rows = {r["ticker"]: r for r in cached.get("rows") or []
                if isinstance(r, dict) and r.get("ticker") in covered}
        return rows, covered
    except Exception:
        return {}, {}


def rank_universe(rows):
    # Recomputed on the selected universe, including cache hits. Do not repeatedly rank
    # ranks: preserve the original composites. Fewer than 3 peers is not a comparison.
    fundamental = ("value", "growth", "profitability", "high_margin", "balance_sheet", "cash_generation", "quality", "income", "capital_efficiency", "dividend_quality")
    for key in fundamental:
        groups = {}
        for row in rows:
            base = row.setdefault("fundamental_base", {})
            if key not in base:
                base[key] = finite(row["scores"].get(key))
            row["scores"][key] = None
            group = (row.get("sector", "Unknown"), row.get("financial_model", "operating"))
            if base[key] is not None and group[0] != "Unknown":
                groups.setdefault(group, []).append(row)
        for peers in groups.values():
            if len(peers) < 3:
                continue
            for row in peers:
                value = row["fundamental_base"][key]
                below = sum(p["fundamental_base"][key] < value for p in peers)
                ties = sum(p["fundamental_base"][key] == value for p in peers)
                row["scores"][key] = round(100 * (below + (ties - 1) / 2) / (len(peers) - 1), 1)
                row.setdefault("peer_counts", {})[key] = len(peers)
    for row in rows:
        s = row["scores"]
        for key, parts in {"profitable_growth": ["growth", "profitability", "cash_generation"], "garp": ["growth", "value", "quality"], "quality_value": ["value", "quality", "cash_generation"], "steady_compounder": ["trend_stability", "risk_adjusted_momentum", "quality", "low_volatility"], "defensive_quality": ["low_volatility", "balance_sheet", "quality", "income"]}.items():
            s[key] = finite(blend([s.get(p) for p in parts]))
        if "speculative_growth" in s:
            profitability = finite(s.get("profitability"))
            s["speculative_growth"] = finite(blend([s.get("growth"), s.get("high_volatility"), None if profitability is None else 100-profitability, s.get("momentum_short")]))
    for row in rows:
        row["scores"]["relative_strength"] = None
        row["scores"]["technical_strength"] = None
    valid = [r for r in rows if r.get("return_60d") is not None and r.get("return_1y") is not None]
    if valid:
        ret60 = pd.Series([r["return_60d"] for r in valid]).rank(pct=True).tolist()
        ret1y = pd.Series([r["return_1y"] for r in valid]).rank(pct=True).tolist()
        for row, p60, p1y in zip(valid, ret60, ret1y):
            row["scores"]["relative_strength"] = round((p60*.55 + p1y*.45)*100, 1)
            row["scores"]["technical_strength"] = finite(round(blend([
                row["scores"]["uptrend"], row["scores"]["momentum_medium"],
                row["scores"]["relative_strength"], row["scores"]["accumulation"]
            ]), 1))
    return rows


def build_universe(tickers, names):
    if TEST_LIMIT:
        tickers = tickers[:TEST_LIMIT]
    cached_rows, cached_covered = read_cache()
    if set(tickers).issubset(set(cached_covered)):
        stage(2, "Using fresh market-data cache")
        progress(84, "Using current cached market data")
        return rank_universe([cached_rows[t] for t in tickers if t in cached_rows]), True

    pending = [ticker for ticker in tickers if ticker not in cached_covered]
    stage(1, f"Loading price history for complete one-year windows for {len(pending)} companies")
    progress(12, f"Loading price history for complete one-year windows for {len(pending)} companies")
    histories = get_history(pending)
    confirmed = set(getattr(histories, "confirmed", set(histories)))
    if pending and not histories and not cached_rows:
        probe = probe_history(pending[0])
        print(f"WARN|history-probe|{probe}", file=sys.stderr, flush=True)
        raise RuntimeError(f"The market-data provider returned no price history. Try the screen again shortly. [probe: {probe}]")
    stage(2, "Loading sectors, valuation, and company statistics")
    progress(58, "Loading sectors, valuation, and company statistics")
    # A company without a usable price frame cannot produce a row, so requesting five
    # company modules for all 500 names after a thin history response only compounds
    # provider pressure without improving coverage.
    modules = get_symbol_modules(list(histories))
    rows = []
    for ticker in pending:
        feat = history_features(histories.get(ticker)) if ticker in histories else None
        if not feat:
            continue
        m = modules.get(ticker, {})
        price, summary, stats, financial, profile = (m.get(x, {}) for x in ("price", "summary", "stats", "financial", "profile"))
        feat.update({
            "ticker": ticker, "name": names.get(ticker) or price.get("longName") or price.get("shortName") or ticker,
            "sector": profile.get("sector") or "Unknown", "industry": profile.get("industry") or "Unknown",
            # Business description (already fetched via asset_profile) — used for
            # deterministic theme keyword matching. Truncated to bound cache size.
            "business_summary": (str(profile.get("longBusinessSummary") or "")[:2400]),
            "market_cap": finite(price.get("marketCap")),
            "pe": finite(summary.get("trailingPE")), "forward_pe": finite(summary.get("forwardPE")),
            "price_to_sales": finite(summary.get("priceToSalesTrailing12Months")), "payout_ratio": finite(summary.get("payoutRatio")),
            "dividend_yield": finite(summary.get("dividendYield")),
            "revenue_growth": finite(financial.get("revenueGrowth")), "earnings_growth": finite(financial.get("earningsGrowth")),
            "profit_margin": finite(financial.get("profitMargins")), "operating_margin": finite(financial.get("operatingMargins")),
            "gross_margin": finite(financial.get("grossMargins")), "return_on_equity": finite(financial.get("returnOnEquity")),
            "return_on_assets": finite(financial.get("returnOnAssets")),
            "debt_to_equity": finite(financial.get("debtToEquity")), "current_ratio": finite(financial.get("currentRatio")),
            "free_cash_flow": finite(financial.get("freeCashflow")), "total_cash": finite(financial.get("totalCash")),
            "total_debt": finite(financial.get("totalDebt")), "target_price": finite(financial.get("targetMeanPrice")),
            "recommendation_mean": finite(financial.get("recommendationMean")), "beta": finite(stats.get("beta")),
            "short_interest": finite(stats.get("shortPercentOfFloat")),
            "price_to_book": finite(stats.get("priceToBook")), "peg_ratio": finite(stats.get("pegRatio")),
            "enterprise_to_ebitda": finite(stats.get("enterpriseToEbitda")),
            "institutional_ownership": finite(stats.get("heldPercentInstitutions")), "insider_ownership": finite(stats.get("heldPercentInsiders")),
        })
        same_currency = bool(financial.get("financialCurrency") and financial.get("financialCurrency") == price.get("currency"))
        net_cash_ratio = finite((feat["total_cash"] - feat["total_debt"]) / feat["market_cap"]) if same_currency and feat["market_cap"] and feat["total_cash"] is not None and feat["total_debt"] is not None else None
        fcf_yield = finite(feat["free_cash_flow"] / feat["market_cap"]) if same_currency and feat["market_cap"] and feat["free_cash_flow"] is not None else None
        analyst_upside = finite(feat["target_price"] / feat["price"] - 1) if feat["target_price"] and feat["price"] else None
        avg_dollar_volume = feat.get("avg_dollar_volume")
        feat.update({"net_cash_ratio":net_cash_ratio, "fcf_yield":fcf_yield, "analyst_upside":analyst_upside,
                     "avg_dollar_volume":avg_dollar_volume})
        if feat.get("beta") is not None:
            low_volatility = blend([feat["scores"]["low_volatility"], scale(feat["beta"], 1.8, .55)])
            feat["scores"]["low_volatility"] = round(score_bound(low_volatility), 1)
            feat["scores"]["high_volatility"] = round(score_bound(100-low_volatility), 1)
        feat["scores"].update({
            "value": round(blend([valuation_score(feat["pe"], 40, 10), valuation_score(feat["forward_pe"], 35, 9), valuation_score(feat["price_to_book"], 10, 1.5), valuation_score(feat["price_to_sales"], 12, 1.5), valuation_score(feat["enterprise_to_ebitda"], 25, 7)]), 1),
            "growth": round(blend([scale(feat["revenue_growth"], -0.05, 0.30), scale(feat["earnings_growth"], -0.10, 0.40)]), 1),
            "profitability": round(blend([scale(feat["profit_margin"], -0.02, .30), scale(feat["operating_margin"], 0, .35), scale(feat["gross_margin"], .10, .70), scale(feat["return_on_equity"], 0, .35)]), 1),
            "high_margin": round(blend([scale(feat["profit_margin"], 0, .35), scale(feat["operating_margin"], 0, .40), scale(feat["gross_margin"], .15, .75)]), 1),
            "balance_sheet": round(blend([debt_score(feat["debt_to_equity"], 300, 20), scale(feat["current_ratio"], .6, 2.5), scale(net_cash_ratio, -.35, .20)]), 1),
            "cash_generation": round(blend([scale(fcf_yield, -.02, .10), scale(feat["profit_margin"], 0, .30)]), 1),
            "quality": round(blend([scale(feat["profit_margin"], -0.02, 0.30), scale(feat["return_on_equity"], 0, .35), debt_score(feat["debt_to_equity"], 250, 20), scale(fcf_yield, -.02, .10)]), 1),
            "income": round(blend([scale(feat["dividend_yield"], 0, 0.05), scale(feat["payout_ratio"], 1.2, .35)]), 1),
            "analyst_upside": round(blend([scale(analyst_upside, -.15, .35), scale(feat["recommendation_mean"], 3.5, 1.5)]), 1),
            "insider_ownership": round(scale(feat["insider_ownership"], 0, .15), 1),
            "institutional_ownership": round(scale(feat["institutional_ownership"], .25, .95), 1),
            "mega_cap": round(scale(feat["market_cap"], 10e9, 200e9), 1),
            "smaller_cap": round(scale(feat["market_cap"], 100e9, 8e9), 1),
            "revenue_growth": round(scale(feat["revenue_growth"], -.05, .35), 1),
            "earnings_growth": round(scale(feat["earnings_growth"], -.15, .50), 1),
            "high_roe": round(scale(feat["return_on_equity"], 0, .40), 1),
            "fcf_yield": round(scale(fcf_yield, -.02, .12), 1),
            "cash_rich": round(blend([scale(net_cash_ratio, -.35, .25), scale(feat["current_ratio"], .6, 3)]), 1),
            "low_debt": round(blend([debt_score(feat["debt_to_equity"], 300, 10), scale(net_cash_ratio, -.40, .20)]), 1),
            "capital_efficiency": round(blend([scale(feat["return_on_equity"], 0, .40), scale(feat["operating_margin"], 0, .35), scale(fcf_yield, -.02, .10)]), 1),
            "dividend_quality": round(blend([scale(feat["dividend_yield"], 0, .05), scale(feat["payout_ratio"], 1.1, .30), scale(feat["profit_margin"], 0, .28), debt_score(feat["debt_to_equity"], 250, 20)]), 1),
            "liquidity": round(blend([scale(avg_dollar_volume, 5e6, 500e6), scale(feat["avg_volume_20d"], 100_000, 8_000_000), scale(feat["market_cap"], 5e9, 150e9)]), 1),
            "options_liquidity_proxy": round(blend([scale(avg_dollar_volume, 10e6, 750e6), scale(feat["avg_volume_20d"], 250_000, 12_000_000), scale(feat["market_cap"], 8e9, 250e9)]), 1),
            "low_beta": round(blend([scale(feat["beta"], 1.8, .55), feat["scores"]["low_volatility"]]), 1),
            "high_beta": round(blend([scale(feat["beta"], .65, 2.0), feat["scores"]["high_volatility"]]), 1),
            "high_short_interest": round(scale(feat["short_interest"], .01, .20), 1),
        })
        s = feat["scores"]
        s.update({
            "profitable_growth": round(blend([s["growth"], s["profitability"], s["cash_generation"]]), 1),
            "garp": round(blend([s["growth"], s["value"], s["quality"]]), 1),
            "quality_value": round(blend([s["value"], s["quality"], s["cash_generation"]]), 1),
            "steady_compounder": round(blend([s["trend_stability"], s["risk_adjusted_momentum"], s["quality"], s["low_volatility"]]), 1),
            "defensive_quality": round(blend([s["low_volatility"], s["balance_sheet"], s["quality"], s["income"]]), 1),
            "speculative_growth": round(blend([s["growth"], s["high_volatility"], 100-s["profitability"], s["momentum_short"]]), 1),
            "squeeze": round(blend([s["volatility_contraction"], s["volume_dryup"], s["consolidation_short"]]), 1),
            "bullish_pullback": round(blend([s["uptrend"], s["pullback_to_ma"], scale(feat["rsi14"], 72, 43)]), 1),
            "mean_reversion": round(blend([s["oversold"], s["trend_stability"], s["recovery"]]), 1),
            "turnaround": round(blend([s["recovery"], s["momentum_short"], scale(feat["distance_52w_high"], -.10, -.55)]), 1),
            "short_squeeze_setup": round(blend([s["high_short_interest"], s["volume_surge"], s["momentum_short"]]), 1),
        })
        feat["scores"] = {k: finite(v) for k, v in feat["scores"].items()}
        rows.append(apply_financial_model(feat))
    # Merge rather than replace. A throttled run now returns fewer symbols by design,
    # and overwriting would drop coverage a previous run already paid Yahoo for — which
    # would fail the issubset check next time and trigger exactly the full cold pull this
    # is all meant to avoid. Merging lets coverage accumulate across runs, with per-entry
    # timestamps so nothing outlives the TTL.
    now = time.time()
    merged_rows = dict(cached_rows)
    merged_rows.update({r["ticker"]: r for r in rows if r.get("ticker")})
    merged_covered = dict(cached_covered)
    # Only upstream-confirmed symbols are fresh. The old attempted-ticker behavior
    # cached a total provider outage as complete coverage: 518 covered, zero rows.
    merged_covered.update({ticker: now for ticker in confirmed})
    try:
        # allow_nan=False so a NaN can never reach the cache. The default would write a
        # bare NaN, json.loads would happily read it back, and the poisoned rows would
        # then fail the stdout encode on every screen for the full TTL. Failing the write
        # is caught below and simply means no cache this round.
        payload = json.dumps({"version": CACHE_VERSION, "created_at": now,
                              "rows": list(merged_rows.values()), "covered": merged_covered},
                             separators=(",", ":"), allow_nan=False)
        # temp+rename: a screen killed by SQUALL_SCREENER_TIMEOUT_MS mid-write would
        # otherwise leave truncated JSON that every later run has to fail to parse.
        tmp = Path(str(CACHE_PATH) + ".tmp")
        tmp.write_text(payload)
        os.replace(tmp, CACHE_PATH)
    except Exception:
        pass
    # Serve from the merged view, not just this run's rows: a symbol a previous run
    # already fetched is still valid data we have paid for, and on a throttled run it
    # is the difference between a usable screen and a thin one.
    return rank_universe([merged_rows[t] for t in tickers if t in merged_rows]), False


CONCEPT_LABELS = {
    "consolidation": "Consolidation", "volatility_contraction": "Volatility contraction", "uptrend": "Uptrend",
    "vcp":"Volatility contraction pattern (VCP)", "cup_and_handle":"Cup with handle",
    "flat_base":"Flat base", "double_bottom":"Double bottom", "bull_flag":"Bull flag",
    "downtrend":"Downtrend", "accumulation": "Institutional accumulation", "distribution":"Distribution",
    "breakout": "Breakout quality", "momentum": "Momentum", "relative_strength":"Relative strength",
    "risk_adjusted_momentum":"Efficient momentum", "near_highs": "Near 52-week highs", "oversold": "Oversold pullback",
    "recovery":"Early recovery", "pullback_to_ma":"Pullback to support", "golden_cross":"Golden-cross structure",
    "volume_surge":"Unusual volume", "volume_dryup":"Quiet volume", "low_volatility": "Lower volatility",
    "high_volatility":"Higher volatility", "trend_stability":"Stable trend", "value": "Value", "growth": "Growth",
    "profitability":"Profitability", "quality": "Business quality", "balance_sheet":"Balance-sheet strength",
    "cash_generation":"Cash generation", "high_margin":"High margins", "income": "Income",
    "analyst_upside":"Analyst-implied upside", "insider_ownership":"Insider ownership",
    "institutional_ownership":"Institutional ownership", "mega_cap":"Mega-cap scale", "smaller_cap":"Smaller companies",
    "profitable_growth":"Profitable growth", "garp":"Growth at a reasonable price",
    "quality_value":"Quality value", "steady_compounder":"Steady compounder", "defensive_quality":"Defensive quality",
    "speculative_growth":"Speculative growth", "revenue_growth":"Revenue growth", "earnings_growth":"Earnings growth",
    "high_roe":"High return on equity", "fcf_yield":"Free-cash-flow yield", "cash_rich":"Cash-rich balance sheet",
    "low_debt":"Low debt", "capital_efficiency":"Capital efficiency", "dividend_quality":"Dividend quality",
    "liquidity":"Trading liquidity", "options_liquidity_proxy":"Options-liquidity proxy", "low_beta":"Low beta",
    "high_beta":"High beta", "high_short_interest":"High short interest", "squeeze":"Coiled-spring setup",
    "bullish_pullback":"Healthy pullback", "mean_reversion":"Mean-reversion setup", "turnaround":"Turnaround",
    "technical_strength":"Technical strength", "short_squeeze_setup":"Short-squeeze setup"
}
PATTERN_CONCEPTS = {"vcp", "cup_and_handle", "flat_base", "double_bottom", "bull_flag"}


def qualifies_pattern(row, pattern):
    """Apply structural minimums before a subjective chart pattern can match."""
    score = finite(row.get("scores", {}).get(pattern), 0)
    uptrend = finite(row.get("scores", {}).get("uptrend"), 0)
    if pattern == "vcp":
        return score >= 60 and uptrend >= 50 and finite(row.get("vcp_contractions"), 0) >= 2
    if pattern == "cup_and_handle":
        cup = finite(row.get("cup_depth"))
        handle = finite(row.get("handle_depth"))
        pivot = finite(row.get("cup_pivot"))
        price = finite(row.get("price"))
        pivot_distance = finite(price / pivot - 1) if price and pivot else None
        return bool(
            score >= 65 and uptrend >= 50 and cup is not None and .12 <= cup <= .35 and
            handle is not None and .01 <= handle <= min(.15, cup / 3) and
            pivot_distance is not None and -.10 <= pivot_distance <= .06
        )
    if pattern == "flat_base":
        width = finite(row.get("range_60d"))
        near_high = finite(row.get("distance_52w_high"))
        return bool(score >= 65 and uptrend >= 50 and width is not None and .04 <= width <= .20 and
                    near_high is not None and near_high >= -.20)
    if pattern == "double_bottom":
        similarity = finite(row.get("double_bottom_similarity"))
        return bool(score >= 65 and similarity is not None and similarity <= .10)
    if pattern == "bull_flag":
        impulse = finite(row.get("bull_flag_impulse"))
        pullback = finite(row.get("bull_flag_pullback"))
        return bool(score >= 65 and uptrend >= 50 and impulse is not None and .08 <= impulse <= .55 and
                    pullback is not None and -.20 <= pullback <= .02)
    return False


def concept_score(row, concept, settings):
    if concept == "consolidation":
        window = int(settings.get("consolidation_window", 30))
        return finite(row.get("scores", {}).get("consolidation_short" if window <= 30 else "consolidation_long"))
    if concept == "momentum":
        window = int(settings.get("momentum_window", 60))
        key = "momentum_short" if window <= 20 else "momentum_medium" if window <= 60 else "momentum_long"
        return finite(row.get("scores", {}).get(key))
    return finite(row.get("scores", {}).get(concept))


def passes_filters(row, filters):
    haystack = f"{row.get('sector', '')} {row.get('industry', '')}".lower()
    sectors = filters.get("sectors") or ([filters.get("sector")] if filters.get("sector") else [])
    sectors = [str(s).lower().strip() for s in sectors if str(s).strip()]
    excluded = [str(s).lower().strip() for s in (filters.get("exclude_sectors") or []) if str(s).strip()]
    if sectors and not any(sector in haystack for sector in sectors):
        return False
    if excluded and any(sector in haystack for sector in excluded):
        return False
    checks = [
        ("market_cap_min", lambda v: row.get("market_cap") is not None and row["market_cap"] >= v),
        ("market_cap_max", lambda v: row.get("market_cap") is not None and row["market_cap"] <= v),
        ("price_min", lambda v: row["price"] >= v), ("price_max", lambda v: row["price"] <= v),
        ("pe_max", lambda v: row.get("pe") is not None and 0 < row["pe"] <= v),
        ("forward_pe_max", lambda v: row.get("forward_pe") is not None and 0 < row["forward_pe"] <= v),
        ("volume_min", lambda v: row.get("avg_volume_20d") is not None and row["avg_volume_20d"] >= v),
        ("avg_dollar_volume_min", lambda v: row.get("avg_dollar_volume") is not None and row["avg_dollar_volume"] >= v),
        ("dividend_yield_min", lambda v: row.get("dividend_yield") is not None and row["dividend_yield"] >= v),
        ("revenue_growth_min", lambda v: row.get("revenue_growth") is not None and row["revenue_growth"] >= v),
        ("earnings_growth_min", lambda v: row.get("earnings_growth") is not None and row["earnings_growth"] >= v),
        ("profit_margin_min", lambda v: row.get("profit_margin") is not None and row["profit_margin"] >= v),
        ("current_ratio_min", lambda v: row.get("current_ratio") is not None and row["current_ratio"] >= v),
        ("beta_min", lambda v: row.get("beta") is not None and row["beta"] >= v),
        ("beta_max", lambda v: row.get("beta") is not None and row["beta"] <= v),
        ("short_interest_min", lambda v: row.get("short_interest") is not None and row["short_interest"] >= v),
    ]
    for key, fn in checks:
        val = finite(filters.get(key))
        if val is not None and not fn(val):
            return False
    return True


def fmt_pct(v):
    return "N/A" if v is None else f"{v:+.1%}"


def fmt_num(v, suffix="", digits=1):
    return "N/A" if v is None else f"{v:.{digits}f}{suffix}"


def explain(row, concepts, settings):
    reasons = []
    for c in sorted(concepts, key=lambda x: finite(concept_score(row, x["id"], settings), 0) * x.get("weight", 1), reverse=True)[:6]:
        cid = c["id"]
        window = int(settings.get("consolidation_window", 30))
        range_value = row.get("range_60d") if window == 60 else row.get("range_30d") if window == 30 else row.get("range_15d")
        if cid == "consolidation": reasons.append(f"Consolidation: {fmt_pct(range_value)} {window}-day range and ATR {fmt_num(row.get('atr_contraction'), '×', 2)} its 60-day norm")
        elif cid == "volatility_contraction": reasons.append(f"Volatility contraction: 15/60-day range ratio {fmt_num(finite(row.get('range_15d'))/max(finite(row.get('range_60d'), .0001), .0001) if row.get('range_15d') is not None else None, '', 2)} and volume {fmt_num(row.get('volume_dryup'), '×', 2)} normal")
        elif cid == "vcp": reasons.append(f"VCP candidate: {int(finite(row.get('vcp_contractions'), 0))} measurable contractions, with recent volume at {fmt_num(row.get('volume_dryup'), '×', 2)} its 60-day average")
        elif cid == "cup_and_handle": reasons.append(f"Cup-with-handle candidate: {fmt_pct(row.get('cup_depth'))} cup depth, {fmt_pct(row.get('handle_depth'))} handle depth, and an estimated ${fmt_num(row.get('cup_pivot'), '', 2)} pivot")
        elif cid == "flat_base": reasons.append(f"Flat-base candidate: {fmt_pct(row.get('range_60d'))} 60-day range, {fmt_pct(row.get('distance_52w_high'))} from its yearly high")
        elif cid == "double_bottom": reasons.append(f"Double-bottom candidate: lows differ by {fmt_pct(row.get('double_bottom_similarity'))}; estimated midpoint pivot ${fmt_num(row.get('double_bottom_pivot'), '', 2)}")
        elif cid == "bull_flag": reasons.append(f"Bull-flag candidate: prior advance {fmt_pct(row.get('bull_flag_impulse'))}, followed by a {fmt_pct(row.get('bull_flag_pullback'))} pullback")
        elif cid == "near_highs": reasons.append(f"Near highs: {fmt_pct(row['distance_52w_high'])} from its 52-week high")
        elif cid in ("uptrend", "downtrend", "momentum", "risk_adjusted_momentum", "technical_strength"): reasons.append(f"Trend: 20-day {fmt_pct(row['return_20d'])}, 60-day {fmt_pct(row['return_60d'])}")
        elif cid == "relative_strength": reasons.append(f"Relative strength: {fmt_num(row.get('scores',{}).get(cid), '/100', 0)} versus {row.get('universe_label') or 'the selected universe'}")
        elif cid == "accumulation": reasons.append(f"Accumulation: {row['up_volume_ratio']:.0%} of recent volume occurred on up days")
        elif cid == "distribution": reasons.append(f"Distribution: {(1-row['up_volume_ratio']):.0%} of recent volume occurred on flat or down days")
        elif cid == "breakout": reasons.append(f"Breakout quality: volume is {row['volume_ratio']:.2f}× its 20-day average")
        elif cid in ("low_volatility", "high_volatility", "trend_stability", "low_beta", "high_beta", "steady_compounder", "defensive_quality"): reasons.append(f"Risk: {fmt_pct(row.get('volatility'))} annualized volatility, {fmt_num(row.get('beta'), ' beta', 2)}, and {fmt_pct(row.get('max_drawdown_1y'))} max drawdown")
        elif cid in ("volume_surge", "volume_dryup"): reasons.append(f"Volume: today is {fmt_num(row.get('volume_ratio'), '×', 2)} the 20-day average; recent average is {fmt_num(row.get('volume_dryup'), '×', 2)} the 60-day norm")
        elif cid == "pullback_to_ma": reasons.append(f"Support proximity: {fmt_pct(row.get('distance_ma20'))} from MA20 and {fmt_pct(row.get('distance_ma50'))} from MA50")
        elif cid == "golden_cross": reasons.append(f"Moving averages: MA50 {fmt_num(row.get('ma50'), '', 2)} versus MA200 {fmt_num(row.get('ma200'), '', 2)}")
        elif cid == "recovery": reasons.append(f"Recovery: 20-day {fmt_pct(row.get('return_20d'))} while still {fmt_pct(row.get('distance_52w_high'))} from the yearly high")
        elif cid == "value": reasons.append(f"Valuation: {row['pe']:.1f}× trailing earnings" if row.get("pe") else "Valuation data was limited")
        elif cid in ("growth", "revenue_growth", "earnings_growth", "profitable_growth", "speculative_growth", "garp"): reasons.append(f"Growth: revenue {fmt_pct(row.get('revenue_growth'))}, earnings {fmt_pct(row.get('earnings_growth'))}")
        elif cid in ("quality", "profitability", "high_margin", "capital_efficiency", "quality_value"): reasons.append(f"Profitability: {fmt_pct(row.get('profit_margin'))} net, {fmt_pct(row.get('operating_margin'))} operating margin, and {fmt_pct(row.get('return_on_equity'))} ROE")
        elif cid in ("balance_sheet", "cash_rich", "low_debt"): reasons.append(f"Balance sheet: debt/equity {fmt_num(row.get('debt_to_equity'), '', 0)}, current ratio {fmt_num(row.get('current_ratio'), '×', 2)}")
        elif cid in ("cash_generation", "fcf_yield"): reasons.append(f"Cash generation: free-cash-flow yield {fmt_pct(row.get('fcf_yield'))}")
        elif cid in ("income", "dividend_quality"): reasons.append(f"Income: {fmt_pct(row.get('dividend_yield'))} dividend yield")
        elif cid in ("liquidity", "options_liquidity_proxy"): reasons.append(f"Liquidity proxy: ${fmt_num(finite(row.get('avg_dollar_volume'), 0)/1e6, 'M', 1)} average daily dollar volume")
        elif cid in ("high_short_interest", "short_squeeze_setup"): reasons.append(f"Short interest: {fmt_pct(row.get('short_interest'))} of float; volume is {fmt_num(row.get('volume_ratio'), '×', 2)} normal")
        elif cid in ("squeeze", "bullish_pullback", "mean_reversion", "turnaround"): reasons.append(f"Setup: RSI {fmt_num(row.get('rsi14'), '', 0)}, 20-day return {fmt_pct(row.get('return_20d'))}, volume {fmt_num(row.get('volume_ratio'), '×', 2)} normal")
        elif cid == "analyst_upside": reasons.append(f"Analyst consensus: {fmt_pct(row.get('analyst_upside'))} implied upside (estimate, not fact)")
        elif cid == "insider_ownership": reasons.append(f"Ownership: insiders report holding {fmt_pct(row.get('insider_ownership'))}")
        elif cid == "institutional_ownership": reasons.append(f"Ownership: institutions report holding {fmt_pct(row.get('institutional_ownership'))}")
        elif cid in ("mega_cap", "smaller_cap"): reasons.append(f"Company size: market capitalization ${fmt_num(finite(row.get('market_cap'),0)/1e9, 'B', 1)}")
        elif cid == "oversold": reasons.append(f"Pullback: 20-day return {fmt_pct(row['return_20d'])}")
    return list(dict.fromkeys(reasons))[:3]


def keyword_count(text, keyword):
    """Count literal theme phrases while preventing short-token false matches."""
    phrase = str(keyword or "").lower().strip()
    if len(phrase) < 2:
        return 0
    if " " not in phrase and len(phrase) <= 4:
        return len(re.findall(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text))
    return text.count(phrase)


def theme_relevance(row, theme):
    """Score named-theme evidence across identity and business-description fields."""
    keywords = theme.get("keywords") or []
    if not keywords:
        return None, []
    fields = {
        "name": str(row.get("name") or "").lower(),
        "industry": str(row.get("industry") or "").lower(),
        "sector": str(row.get("sector") or "").lower(),
        "description": str(row.get("business_summary") or "").lower(),
    }
    combined = " ".join(fields.values())
    if any(keyword_count(combined, term) for term in (theme.get("exclude_keywords") or [])):
        return 0.0, []
    matched, score = [], 0.0
    for keyword in keywords:
        hits = {field: keyword_count(text, keyword) for field, text in fields.items()}
        if not any(hits.values()):
            continue
        matched.append(str(keyword))
        specificity = min(10, max(0, len(str(keyword)) - 3))
        score += 22 + specificity
        if hits["name"]: score += 15
        if hits["industry"]: score += 12
        if hits["sector"]: score += 6
        score += min(8, max(0, hits["description"] - 1) * 2)
    matched.sort(key=len, reverse=True)
    return round(score_bound(score), 1), matched[:4]


def screen(rows, spec, coverage=None):
    coverage = coverage if coverage is not None else {}
    coverage.update(evaluated=0, missing_data=0, not_applicable=0, failed_filters=0, failed_criteria=0, matched=0)
    concepts = spec.get("concepts") or [{"id": "quality", "weight": 1}]
    settings = spec.get("settings") or {}
    filters = spec.get("filters") or {}
    theme = spec.get("theme") or {}
    theme_keywords = theme.get("keywords") if isinstance(theme, dict) else None
    threshold = clamp(settings.get("match_threshold", 48), 20, 85)
    ranked = []
    for row in rows:
        requested = {c.get("id") for c in concepts}
        if requested.intersection(row.get("unsupported_concepts", [])):
            coverage["not_applicable"] += 1
            continue
        numeric_filters = {"market_cap_min":"market_cap", "market_cap_max":"market_cap", "price_min":"price", "price_max":"price", "pe_max":"pe", "forward_pe_max":"forward_pe", "volume_min":"avg_volume_20d", "avg_dollar_volume_min":"avg_dollar_volume", "dividend_yield_min":"dividend_yield", "revenue_growth_min":"revenue_growth", "earnings_growth_min":"earnings_growth", "profit_margin_min":"profit_margin", "current_ratio_min":"current_ratio", "beta_min":"beta", "beta_max":"beta", "short_interest_min":"short_interest"}
        scores = [(c, concept_score(row, c.get("id"), settings)) for c in concepts if c.get("id") in CONCEPT_LABELS]
        if (not scores or any(s is None for _, s in scores) or
                any(finite(filters.get(k)) is not None and finite(row.get(field)) is None for k, field in numeric_filters.items()) or
                (theme_keywords and not row.get("business_summary"))):
            coverage["missing_data"] += 1
            continue
        coverage["evaluated"] += 1
        if not passes_filters(row, filters):
            coverage["failed_filters"] += 1
            continue

        # Theme gate: when a theme is requested, a company must visibly match it
        # in its business description (or it's dropped — we don't guess). This is
        # what keeps a respiratory-device maker out of an "AI stocks" screen.
        theme_val, theme_terms = None, []
        if theme_keywords:
            theme_val, theme_terms = theme_relevance(row, theme)
            if theme_val is None or theme_val < clamp(theme.get("min_score", 24), 15, 80):
                coverage["failed_criteria"] += 1
                continue

        scores = [(c, concept_score(row, c.get("id"), settings)) for c in concepts if c.get("id") in CONCEPT_LABELS]
        if not scores or any(s is None for _, s in scores):
            continue
        total_weight = sum(max(.1, finite(c.get("weight"), 1)) for c, _ in scores)
        concept_blend = sum(s * max(.1, finite(c.get("weight"), 1)) for c, s in scores) / total_weight

        # With a theme, it drives ranking (concepts refine within the theme);
        # without one, the concept blend is the whole score, as before.
        score = 0.55 * theme_val + 0.45 * concept_blend if theme_val is not None else concept_blend

        must = [s for c, s in scores if c.get("required")]
        requested_ids = {c.get("id") for c, _ in scores}
        requested_patterns = requested_ids & PATTERN_CONCEPTS
        required_patterns = {c.get("id") for c, _ in scores if c.get("required")} & PATTERN_CONCEPTS
        if (score < threshold or
                (must and min(must) < max(30, threshold - 12)) or
                (requested_patterns and not any(qualifies_pattern(row, p) for p in requested_patterns)) or
                (required_patterns and not all(qualifies_pattern(row, p) for p in required_patterns))):
            coverage["failed_criteria"] += 1
            continue

        result = {k: row.get(k) for k in (
            "ticker", "name", "sector", "industry", "indexes", "price", "market_cap", "pe",
            "return_20d", "return_60d", "distance_52w_high", "volume_ratio", "volatility",
            "avg_dollar_volume"
        )}
        reasons = explain(row, concepts, settings)
        if row.get("fundamental_basis"):
            reasons.insert(0, row["fundamental_basis"])
        if theme_terms:
            reasons = [f"{theme.get('label', 'Theme')} evidence: {', '.join(theme_terms)} appears in its company identity or business description"] + reasons
        result.update({"match_score": round(score, 1), "concept_scores": {c["id"]: round(s, 1) for c, s in scores}, "reasons": reasons[:4]})
        if theme_val is not None:
            result["theme_score"] = theme_val
            result["theme_terms"] = theme_terms
        ranked.append(result)
        coverage["matched"] += 1
    ranked.sort(key=lambda x: x["match_score"], reverse=True)
    return ranked[:int(clamp(spec.get("max_results", 20), 5, 50))]


def main():
    payload = json.load(sys.stdin)
    tickers = [str(t).upper() for t in payload.get("tickers", []) if t]
    names = payload.get("names") or {}
    memberships = payload.get("memberships") or {}
    universe_label = str(payload.get("universe_label") or "Selected market universe")
    universe_id = str(payload.get("universe_id") or "combined")
    spec = payload.get("spec") or {}
    stage(0, f"Preparing {universe_label}")
    progress(8, f"Preparing {universe_label}")
    rows, cached = build_universe(tickers, names)
    for row in rows:
        row["indexes"] = memberships.get(row.get("ticker"), [])
        row["universe_label"] = universe_label
    stage(3, "Scoring fuzzy concepts with deterministic rules")
    progress(88, "Scoring each company against the measurable criteria")
    coverage = {}
    results = screen(rows, spec, coverage)
    stage(4, "Explaining why each company matched")
    progress(94, "Preparing evidence for the strongest matches")
    output = {
        "universe": universe_label, "universe_id": universe_id,
        "universe_requested": len(tickers), "universe_scored": len(rows),
        "cache_hit": cached, "spec": spec, "results": results,
        "coverage": coverage,
        # Honest when coverage is thin: universe_scored below universe_requested with
        # throttled set means Yahoo pushed back and we deliberately did not retry.
        "throttled": _throttled,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "definitions_version": 4
    }
    stage(5, f"Found {len(results)} matching stocks")
    progress(95, f"Screening calculations complete · {len(results)} matches")
    # Serialize fully BEFORE writing a byte. json.dump streams into the file object, so a
    # value it cannot encode (allow_nan=False rejects NaN/Infinity) raised partway through
    # -- leaving half an object on stdout, after which the handler below appended its own
    # JSON and produced a stream nothing could parse. Building the string first means a
    # serialization failure surfaces as a clean error instead of a corrupt payload.
    sys.stdout.write(json.dumps(output, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # This string is rendered verbatim in the UI, so a bare library message reads as
        # gibberish with no stated cause. Keep the detail, but name what failed. The
        # traceback goes to stderr, which the server tails into its error detail.
        traceback.print_exc(file=sys.stderr)
        sys.stdout.write(json.dumps({
            "error": f"The screening engine failed ({type(exc).__name__}: {exc})."
        }))
        sys.exit(1)
