#!/usr/bin/env python3
"""
Build a cases file for scripts/compare_exit_policies.js.

Downloads real pre/post-cutoff bars for a set of (ticker, date) pairs and writes the
same `bars` shape backtester.sealed_bars produces, so the comparison harness drives the
shipped simulator over real data rather than a fixture.

    python3 scripts/fetch_backtest_cases.py cases.json

This is a research tool, not part of the app or the test suite. It hits Yahoo directly,
so keep the case list short and do not run it in a loop — the deployment IP's standing
with Yahoo is the thing the whole screener depends on.
"""
import json
import sys

import pandas as pd
from yahooquery import Ticker

# A deliberately mixed set: winners, losers, high and low volatility, and the six
# cutoffs named in the /ilgar audit so results stay comparable to earlier measurements.
CASES = [
    ("NVDA", "2023-01-17"), ("AMD", "2025-04-07"), ("META", "2022-02-15"),
    ("WMT", "2025-01-15"), ("INTC", "2024-07-15"), ("UNH", "2025-04-15"),
    ("AAPL", "2023-06-15"), ("MSFT", "2022-09-15"), ("TSLA", "2023-04-20"),
    ("JPM", "2024-02-15"), ("KO", "2023-10-10"), ("XOM", "2024-05-01"),
    ("AMZN", "2022-11-10"), ("GOOGL", "2023-02-01"), ("NFLX", "2024-01-10"),
    ("BA", "2024-03-01"), ("PFE", "2023-08-01"), ("CRM", "2024-08-15"),
]
HORIZON_6M = 126


def atr_pct_of(frame):
    """Matches screener.history_features: a DAILY true range as a fraction of price."""
    close, high, low = frame["close"], frame["high"], frame["low"]
    prev = close.shift(1)
    true_range = pd.concat(
        [(high - low).abs(), (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return float(true_range.tail(14).mean() / float(close.iloc[-1]))


def frame_for(symbol):
    history = Ticker(symbol, asynchronous=False).history(period="10y", interval="1d")
    if isinstance(history.index, pd.MultiIndex):
        history = history.xs(symbol, level=0)
    history.index = pd.to_datetime([str(x)[:10] for x in history.index])
    return history.sort_index()


def column(frame, name):
    for col in frame.columns:
        if str(col).lower() == name:
            return col
    return None


def series(frame, name, digits=4):
    col = column(frame, name)
    if col is None:
        return [None] * len(frame)
    out = []
    for value in frame[col]:
        out.append(None if pd.isna(value) else round(float(value), digits))
    return out


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "cases.json"
    spy = frame_for("SPY")
    cache, out = {}, []
    for symbol, as_of in CASES:
        try:
            if symbol not in cache:
                cache[symbol] = frame_for(symbol)
            frame = cache[symbol]
            cutoff = pd.Timestamp(as_of)
            before = frame.loc[frame.index <= cutoff]
            after = frame.loc[frame.index > cutoff].iloc[:HORIZON_6M]
            if len(before) < 65 or len(after) < 20:
                print(f"skip {symbol} {as_of}: insufficient history", file=sys.stderr)
                continue
            spy_after = spy.loc[spy.index > cutoff].iloc[:HORIZON_6M].reindex(after.index)
            out.append({
                "ticker": symbol,
                "as_of": as_of,
                "atr_pct": atr_pct_of(before),
                "return_20d": float(before["close"].iloc[-1] / before["close"].iloc[-21] - 1),
                "return_60d": float(before["close"].iloc[-1] / before["close"].iloc[-61] - 1),
                "bars": {
                    "dates": [d.date().isoformat() for d in after.index],
                    "open": series(after, "open"),
                    "close": series(after, "close"),
                    "volume": series(after, "volume", 0),
                    "spyOpen": series(spy_after, "open"),
                    "spyClose": series(spy_after, "close"),
                },
            })
            print(f"ok {symbol} {as_of} atr={out[-1]['atr_pct']:.4f}", file=sys.stderr)
        except Exception as error:  # research tool: one bad symbol must not end the run
            print(f"fail {symbol} {as_of}: {error}", file=sys.stderr)

    with open(target, "w", encoding="utf-8") as handle:
        json.dump(out, handle)
    print(f"wrote {len(out)} cases to {target}", file=sys.stderr)


if __name__ == "__main__":
    main()
