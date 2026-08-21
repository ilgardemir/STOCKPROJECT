import unittest
from datetime import date
import json
from pathlib import Path
import tempfile

import numpy as np
import pandas as pd

from support import install_yahooquery_stub

install_yahooquery_stub()

import backscreener


def price_frame(days=420, start="2022-01-03"):
    index = pd.bdate_range(start, periods=days)
    close = np.linspace(80, 140, days) + np.sin(np.arange(days) / 7)
    return pd.DataFrame({
        "open": close - .35,
        "high": close + 1,
        "low": close - 1,
        "close": close,
        "volume": np.linspace(2_000_000, 1_200_000, days),
    }, index=index)


class PointInTimeBackscreenerTests(unittest.TestCase):
    def test_split_at_date_never_includes_future_bars(self):
        frame = price_frame()
        cutoff = frame.index[260].date()
        before, after = backscreener.split_at_date(frame, cutoff)
        self.assertLessEqual(before.index.max().date(), cutoff)
        self.assertGreater(after.index.min().date(), cutoff)
        self.assertEqual(len(before) + len(after), len(frame))

    def test_forward_returns_enter_at_next_session_open(self):
        frame = price_frame()
        cutoff_index = 260
        cutoff = frame.index[cutoff_index].date()
        outcome = backscreener.forward_outcomes(frame, cutoff)
        expected_entry = frame.iloc[cutoff_index + 1]["open"]
        expected_exit = frame.iloc[cutoff_index + 21]["close"]
        self.assertEqual(outcome["entry_date"], frame.index[cutoff_index + 1].date().isoformat())
        self.assertAlmostEqual(outcome["entry_price"], expected_entry)
        self.assertAlmostEqual(outcome["returns"]["1m"], expected_exit / expected_entry - 1)
        self.assertLessEqual(outcome["max_drawdown_6m"], 0)

    def test_future_prices_cannot_change_the_signal_score(self):
        original = price_frame()
        cutoff = original.index[260].date()
        altered = original.copy()
        future = altered.index > pd.Timestamp(cutoff)
        altered.loc[future, ["open", "high", "low", "close"]] = (
            altered.loc[future, ["open", "high", "low", "close"]]
            .mul(np.linspace(1, 4, future.sum()), axis=0)
        )
        first = backscreener.technical_row("AAA", "Alpha", ["S&P 500"], original, cutoff)
        second = backscreener.technical_row("AAA", "Alpha", ["S&P 500"], altered, cutoff)
        self.assertEqual(first["scores"], second["scores"])
        self.assertNotEqual(first["outcomes"]["returns"]["1m"], second["outcomes"]["returns"]["1m"])

    def test_recent_cutoff_reports_incomplete_long_horizons(self):
        frame = price_frame(days=300)
        cutoff = frame.index[270].date()
        outcome = backscreener.forward_outcomes(frame, cutoff)
        self.assertIsNotNone(outcome["returns"]["1m"])
        self.assertIsNone(outcome["returns"]["3m"])
        self.assertIsNone(outcome["returns"]["6m"])

    def test_parse_as_of_rejects_impossible_dates(self):
        self.assertEqual(backscreener.parse_as_of("2024-02-29"), date(2024, 2, 29))
        with self.assertRaises(ValueError):
            backscreener.parse_as_of("2024-02-30")

    def test_cache_for_another_date_returns_a_mutable_coverage_set(self):
        original_path = backscreener.CACHE_PATH
        try:
            with tempfile.TemporaryDirectory() as directory:
                backscreener.CACHE_PATH = Path(directory) / "cache.json"
                backscreener.CACHE_PATH.write_text(json.dumps({
                    "version": backscreener.CACHE_VERSION,
                    "as_of": "2022-01-03",
                    "created_at": 9999999999,
                    "rows": [], "covered": [],
                }))
                _, covered, _ = backscreener.read_cache(date(2023, 1, 3))
                covered.add("AAPL")
                self.assertEqual(covered, {"AAPL"})
        finally:
            backscreener.CACHE_PATH = original_path


if __name__ == "__main__":
    unittest.main()
