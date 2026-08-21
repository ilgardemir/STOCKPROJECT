#!/usr/bin/env python3
"""Point-in-time technical backscreener.

stdin: {tickers, names, memberships, universe_id, universe_label, spec, as_of}
stdout: one JSON payload. Progress and diagnostics are written to stderr.

Signals are calculated only from adjusted OHLCV bars dated on or before ``as_of``.
Outcomes begin at the next available session's open, which prevents the close used by
the signal from also being used as an impossible same-close entry.
"""
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time
import traceback

import numpy as np
import pandas as pd
from yahooquery import Ticker

import screener


CACHE_VERSION = 2  # invalidate v1's forward-drawdown calculation
CACHE_PATH = Path(os.getenv("BACKSCREEN_CACHE_PATH", "/tmp/squall-backscreen-cache.json"))
CACHE_TTL = int(os.getenv("BACKSCREEN_CACHE_TTL", "21600"))
TEST_LIMIT = int(os.getenv("BACKSCREEN_LIMIT", os.getenv("SCREENER_LIMIT", "0")))
HORIZONS = {"1m": 21, "3m": 63, "6m": 126}


def progress(percent, label):
    print(f"PROGRESS|{int(screener.clamp(percent))}|{label}", file=sys.stderr, flush=True)


def parse_as_of(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise ValueError("as_of must be a real date in YYYY-MM-DD format")


def dated_frame(df):
    """Return a chronologically sorted frame with a timezone-naive DatetimeIndex."""
    if not isinstance(df, pd.DataFrame) or df.empty:
        return pd.DataFrame()
    out = df.copy()
    try:
        idx = pd.to_datetime(out.index)
        if getattr(idx, "tz", None) is not None:
            idx = idx.tz_localize(None)
        out.index = idx.normalize()
    except (TypeError, ValueError):
        return pd.DataFrame()
    return out[~out.index.duplicated(keep="last")].sort_index()


def split_at_date(df, as_of):
    """Separate information available at the cutoff from strictly future bars."""
    clean = dated_frame(df)
    cutoff = pd.Timestamp(as_of)
    return clean.loc[clean.index <= cutoff], clean.loc[clean.index > cutoff]


def forward_outcomes(df, as_of):
    """Calculate executable next-open forward returns without leaking future bars."""
    before, after = split_at_date(df, as_of)
    if before.empty or after.empty:
        return {
            "effective_as_of": before.index[-1].date().isoformat() if not before.empty else None,
            "entry_date": None, "entry_price": None, "returns": {}, "exit_dates": {},
            "max_drawdown_6m": None,
        }
    cols = {str(c).lower(): c for c in after.columns}
    close_col = cols.get("close")
    open_col = cols.get("open")
    if close_col is None:
        return {"effective_as_of": before.index[-1].date().isoformat(), "entry_date": None,
                "entry_price": None, "returns": {}, "exit_dates": {}, "max_drawdown_6m": None}
    closes = pd.to_numeric(after[close_col], errors="coerce")
    opens = pd.to_numeric(after[open_col], errors="coerce") if open_col is not None else closes
    entry = screener.finite(opens.iloc[0]) or screener.finite(closes.iloc[0])
    if not entry or entry <= 0:
        return {"effective_as_of": before.index[-1].date().isoformat(), "entry_date": None,
                "entry_price": None, "returns": {}, "exit_dates": {}, "max_drawdown_6m": None}
    returns, exit_dates = {}, {}
    for label, sessions in HORIZONS.items():
        if len(closes) < sessions:
            returns[label] = None
            exit_dates[label] = None
            continue
        exit_price = screener.finite(closes.iloc[sessions - 1])
        returns[label] = screener.finite(exit_price / entry - 1) if exit_price else None
        exit_dates[label] = closes.index[sessions - 1].date().isoformat()
    # Include the entry price as the initial peak so a path that only rises reports
    # 0% drawdown rather than a misleading positive "drawdown".
    path_prices = pd.Series([entry] + closes.iloc[:min(len(closes), HORIZONS["6m"])].tolist(), dtype=float)
    drawdown_path = path_prices / path_prices.cummax() - 1
    drawdown = screener.finite(drawdown_path.min()) if len(drawdown_path) else None
    return {
        "effective_as_of": before.index[-1].date().isoformat(),
        "entry_date": after.index[0].date().isoformat(), "entry_price": entry,
        "returns": returns, "exit_dates": exit_dates, "max_drawdown_6m": drawdown,
    }


def extract_frames(history, symbols):
    frames = {}
    if not isinstance(history, pd.DataFrame) or history.empty:
        return frames
    if isinstance(history.index, pd.MultiIndex):
        for symbol in symbols:
            try:
                part = history.xs(symbol, level=0).copy()
                if not part.empty:
                    frames[symbol] = part
            except (KeyError, ValueError):
                pass
    elif len(symbols) == 1:
        frames[symbols[0]] = history.copy()
    return frames


def get_historical_prices(tickers, as_of):
    """Fetch one bounded window for signals and outcomes, in provider-friendly batches."""
    frames = {}
    start = as_of - timedelta(days=550)
    end = min(date.today(), as_of + timedelta(days=210)) + timedelta(days=1)

    def load_batch(batch, label, retry=True):
        try:
            history = Ticker(batch, asynchronous=True, max_workers=12, timeout=25).history(
                start=start.isoformat(), end=end.isoformat(), interval="1d", adj_ohlc=True
            )
            frames.update(extract_frames(history, batch))
        except Exception as exc:
            throttled = screener.note_failure(exc)
            print(f"WARN|backhistory|{label}|{type(exc).__name__}|{'429' if throttled else 'error'}",
                  file=sys.stderr, flush=True)
            if throttled:
                time.sleep(screener.THROTTLE_BACKOFF)
                return
            if retry and len(batch) > 10:
                for offset in range(0, len(batch), 10):
                    if not screener.take_retry_budget():
                        break
                    load_batch(batch[offset:offset + 10], f"{label}+{offset}", retry=False)

    starts = list(range(0, len(tickers), 50))
    for completed, offset in enumerate(starts, 1):
        load_batch(tickers[offset:offset + 50], offset)
        progress(14 + 54 * completed / max(1, len(starts)),
                 f"Loading historical prices · batch {completed} of {len(starts)}")
    return frames


def technical_row(ticker, name, memberships, frame, as_of):
    before, _ = split_at_date(frame, as_of)
    features = screener.history_features(before)
    if not features:
        return None
    outcomes = forward_outcomes(frame, as_of)
    features.update({
        "ticker": ticker, "name": name or ticker, "sector": "", "industry": "",
        "indexes": memberships or [], "market_cap": None, "pe": None,
        "avg_dollar_volume": screener.finite(features.get("price", 0) * features.get("avg_volume_20d", 0)),
        "as_of": outcomes.get("effective_as_of"), "outcomes": outcomes,
    })
    scores = features["scores"]
    scores.update({
        "squeeze": round(float(np.mean([scores["volatility_contraction"], scores["volume_dryup"], scores["consolidation_short"]])), 1),
        "bullish_pullback": round(float(np.mean([scores["uptrend"], scores["pullback_to_ma"], screener.scale(features.get("rsi14"), 72, 43)])), 1),
        "mean_reversion": round(float(np.mean([scores["oversold"], scores["trend_stability"], scores["recovery"]])), 1),
        "turnaround": round(float(np.mean([scores["recovery"], scores["momentum_short"], screener.scale(features.get("distance_52w_high"), -.10, -.55)])), 1),
    })
    return features


def add_universe_relative_scores(rows):
    valid = [r for r in rows if r.get("return_60d") is not None and r.get("return_1y") is not None]
    if not valid:
        return
    ranks60 = pd.Series([r["return_60d"] for r in valid]).rank(pct=True).tolist()
    ranks1y = pd.Series([r["return_1y"] for r in valid]).rank(pct=True).tolist()
    for row, rank60, rank1y in zip(valid, ranks60, ranks1y):
        scores = row["scores"]
        scores["relative_strength"] = round((rank60 * .55 + rank1y * .45) * 100, 1)
        scores["technical_strength"] = round(float(np.mean([
            scores["uptrend"], scores["momentum_medium"],
            scores["relative_strength"], scores["accumulation"],
        ])), 1)


def read_cache(as_of):
    try:
        cached = json.loads(CACHE_PATH.read_text())
        if cached.get("version") != CACHE_VERSION or cached.get("as_of") != as_of.isoformat():
            return {}, set(), None
        if time.time() - screener.finite(cached.get("created_at"), 0) >= CACHE_TTL:
            return {}, set(), None
        rows = {r["ticker"]: r for r in cached.get("rows", []) if isinstance(r, dict) and r.get("ticker")}
        return rows, set(cached.get("covered") or []), cached.get("benchmark")
    except Exception:
        return {}, set(), None


def write_cache(as_of, rows, covered, benchmark):
    try:
        payload = json.dumps({
            "version": CACHE_VERSION, "as_of": as_of.isoformat(), "created_at": time.time(),
            "rows": list(rows.values()), "covered": sorted(covered), "benchmark": benchmark,
        }, separators=(",", ":"), allow_nan=False)
        tmp = Path(str(CACHE_PATH) + ".tmp")
        tmp.write_text(payload)
        os.replace(tmp, CACHE_PATH)
    except Exception:
        pass


def build_snapshot(tickers, names, memberships, as_of):
    rows_by_ticker, covered, benchmark = read_cache(as_of)
    missing = [ticker for ticker in tickers if ticker not in covered]
    need_spy = benchmark is None
    if not missing and not need_spy:
        progress(78, "Using the point-in-time replay cache")
        return [rows_by_ticker[t] for t in tickers if t in rows_by_ticker], benchmark, True

    requested = missing + (["SPY"] if need_spy and "SPY" not in missing else [])
    progress(12, f"Loading the price record around {as_of.isoformat()}")
    histories = get_historical_prices(requested, as_of)
    progress(72, "Freezing every signal at the selected date")
    for ticker in missing:
        frame = histories.get(ticker)
        if frame is not None:
            row = technical_row(ticker, names.get(ticker), memberships.get(ticker), frame, as_of)
            if row:
                rows_by_ticker[ticker] = row
        covered.add(ticker)
    if need_spy and histories.get("SPY") is not None:
        benchmark = forward_outcomes(histories["SPY"], as_of)
    add_universe_relative_scores(list(rows_by_ticker.values()))
    write_cache(as_of, rows_by_ticker, covered, benchmark)
    return [rows_by_ticker[t] for t in tickers if t in rows_by_ticker], benchmark, False


def attach_outcomes(results, rows, benchmark):
    by_ticker = {row["ticker"]: row for row in rows}
    benchmark_returns = (benchmark or {}).get("returns") or {}
    for result in results:
        outcomes = by_ticker.get(result.get("ticker"), {}).get("outcomes") or {}
        forward = outcomes.get("returns") or {}
        result.update({
            "as_of": outcomes.get("effective_as_of"), "entry_date": outcomes.get("entry_date"),
            "entry_price": outcomes.get("entry_price"), "forward_returns": forward,
            "exit_dates": outcomes.get("exit_dates") or {},
            "max_drawdown_6m": outcomes.get("max_drawdown_6m"),
            "excess_returns": {
                label: (screener.finite(forward.get(label)) - screener.finite(benchmark_returns.get(label))
                        if screener.finite(forward.get(label)) is not None and screener.finite(benchmark_returns.get(label)) is not None else None)
                for label in HORIZONS
            },
        })
    return results


def summarize(results, benchmark):
    summary = {}
    benchmark_returns = (benchmark or {}).get("returns") or {}
    for label in HORIZONS:
        values = [screener.finite(r.get("forward_returns", {}).get(label)) for r in results]
        values = [v for v in values if v is not None]
        excess = [screener.finite(r.get("excess_returns", {}).get(label)) for r in results]
        excess = [v for v in excess if v is not None]
        summary[label] = {
            "count": len(values),
            "average_return": screener.finite(np.mean(values)) if values else None,
            "median_return": screener.finite(np.median(values)) if values else None,
            "win_rate": screener.finite(np.mean([v > 0 for v in values])) if values else None,
            "beat_spy_rate": screener.finite(np.mean([v > 0 for v in excess])) if excess else None,
            "spy_return": screener.finite(benchmark_returns.get(label)),
        }
    return summary


def main():
    payload = json.load(sys.stdin)
    tickers = [str(t).upper() for t in payload.get("tickers", []) if t]
    if TEST_LIMIT:
        tickers = tickers[:TEST_LIMIT]
    names = payload.get("names") or {}
    memberships = payload.get("memberships") or {}
    universe_label = str(payload.get("universe_label") or "Selected market universe")
    universe_id = str(payload.get("universe_id") or "combined")
    spec = payload.get("spec") or {}
    as_of = parse_as_of(payload.get("as_of"))

    progress(8, f"Preparing a point-in-time replay for {universe_label}")
    rows, benchmark, cached = build_snapshot(tickers, names, memberships, as_of)
    for row in rows:
        row["universe_label"] = universe_label
    progress(86, "Scoring only information available at the cutoff")
    results = attach_outcomes(screener.screen(rows, spec), rows, benchmark)
    progress(93, "Calculating forward returns and SPY comparisons")
    output = {
        "mode": "historical", "as_of": as_of.isoformat(),
        "universe": universe_label, "universe_id": universe_id,
        "universe_requested": len(tickers), "universe_scored": len(rows),
        "cache_hit": cached, "spec": spec, "results": results,
        "summary": summarize(results, benchmark), "benchmark": benchmark,
        "throttled": screener._throttled,
        "methodology": {
            "signal_cutoff": "Split-adjusted daily OHLCV dated on or before the selected date",
            "entry": "Next available session open, displayed on a split-adjusted basis",
            "horizons": HORIZONS,
            "universe_bias": "Uses today's stored index constituents; delisted and removed historical members are absent",
        },
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    progress(96, f"Historical replay complete · {len(results)} matches")
    sys.stdout.write(json.dumps(output, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        sys.stdout.write(json.dumps({
            "error": f"The historical screening engine failed ({type(exc).__name__}: {exc})."
        }))
        sys.exit(1)
