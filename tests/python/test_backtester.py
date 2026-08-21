import json
import unittest
from datetime import date

import numpy as np
import pandas as pd

from support import install_yahooquery_stub

install_yahooquery_stub()

import backtester


class HistoricalAnalyzerTests(unittest.TestCase):
    def test_forward_outcomes_enter_after_the_cutoff(self):
        index = pd.date_range("2024-01-01", periods=150, freq="B")
        close = np.arange(100.0, 250.0)
        frame = pd.DataFrame({"open": close - 0.5, "high": close + 1, "low": close - 1,
                              "close": close, "volume": 1_000_000}, index=index)
        cutoff = index[10].date()
        result = backtester.forward_outcomes(frame, cutoff)
        self.assertEqual(result["effective_as_of"], index[10].date().isoformat())
        self.assertEqual(result["entry_date"], index[11].date().isoformat())
        self.assertAlmostEqual(result["entry_price"], close[11] - 0.5)
        expected = close[31] / (close[11] - 0.5) - 1
        self.assertAlmostEqual(result["returns"]["1m"], expected)

    def test_sec_fact_series_rejects_facts_filed_after_cutoff(self):
        payload = {"facts": {"us-gaap": {"Assets": {"label": "Assets", "units": {"USD": [
            {"val": 100, "end": "2022-12-31", "filed": "2023-02-01", "form": "10-K", "fy": 2022, "fp": "FY"},
            {"val": 999, "end": "2023-03-31", "filed": "2023-05-01", "form": "10-Q", "fy": 2023, "fp": "Q1"},
            {"val": 777, "end": "2023-03-31", "filed": "2023-04-01", "form": "8-K", "fy": 2023, "fp": "Q1"},
        ]}}}}}
        fact = backtester.fact_series(payload, ["Assets"], "USD", date(2023, 3, 15))
        self.assertEqual(fact["series"][0]["value"], 100)
        self.assertEqual(fact["series"][0]["filed"], "2023-02-01")

    def test_ai_prompt_contains_snapshot_but_no_realized_outcomes(self):
        snapshot = {"ticker": "AAA", "as_of": "2023-03-15", "technical": {"metrics": {"price": 10}}}
        prompt = backtester.build_ai_prompt(snapshot)
        self.assertIn('"ticker":"AAA"', prompt)
        self.assertNotIn("forward_returns", prompt)
        self.assertNotIn("excess_returns", prompt)
        json.dumps(snapshot, allow_nan=False)

    def test_sealed_bars_contain_only_post_cutoff_sessions(self):
        index = pd.date_range("2024-01-01", periods=40, freq="B")
        close = np.arange(100.0, 140.0)
        stock = pd.DataFrame({"open": close - 0.5, "high": close + 1, "low": close - 1,
                              "close": close, "volume": 1_000_000}, index=index)
        spy = pd.DataFrame({"open": close * 2, "high": close * 2, "low": close * 2,
                            "close": close * 2, "volume": 5_000}, index=index)
        cutoff = index[9].date()

        bars = backtester.sealed_bars(stock, spy, cutoff)

        self.assertEqual(bars["dates"][0], index[10].date().isoformat())
        self.assertTrue(all(d > cutoff.isoformat() for d in bars["dates"]))
        self.assertEqual(len(bars["dates"]), 30)
        self.assertEqual(len(bars["open"]), len(bars["dates"]))
        self.assertEqual(len(bars["spyClose"]), len(bars["dates"]))
        self.assertAlmostEqual(bars["open"][0], close[10] - 0.5)
        self.assertAlmostEqual(bars["spyClose"][0], close[10] * 2)

    def test_sealed_bars_are_capped_and_survive_a_missing_benchmark(self):
        index = pd.date_range("2024-01-01", periods=200, freq="B")
        close = np.arange(100.0, 300.0)
        stock = pd.DataFrame({"open": close, "high": close, "low": close,
                              "close": close, "volume": 1}, index=index)
        cutoff = index[0].date()

        bars = backtester.sealed_bars(stock, pd.DataFrame(), cutoff, max_sessions=126)

        self.assertEqual(len(bars["dates"]), 126)
        # A missing benchmark must not shorten or misalign the stock series.
        self.assertEqual(len(bars["spyClose"]), 126)
        self.assertTrue(all(v is None for v in bars["spyClose"]))

    def test_adjusted_frame_scales_ohlc_by_the_adjustment_ratio(self):
        index = pd.date_range("2023-01-02", periods=3, freq="B")
        frame = pd.DataFrame({
            "open": [100.0, 102.0, 104.0], "high": [101.0, 103.0, 105.0],
            "low": [99.0, 101.0, 103.0], "close": [100.0, 102.0, 104.0],
            "adjclose": [50.0, 51.0, 52.0], "volume": [1000, 1000, 1000],
        }, index=index)

        adjusted = backtester.adjusted_frame(frame)

        # every bar halves, because adjclose is half of close throughout
        self.assertAlmostEqual(adjusted["close"].iloc[0], 50.0)
        self.assertAlmostEqual(adjusted["open"].iloc[1], 51.0)
        self.assertAlmostEqual(adjusted["high"].iloc[2], 52.5)
        # volume is never scaled
        self.assertEqual(adjusted["volume"].iloc[0], 1000)

    def test_adjusted_frame_falls_back_to_raw_without_adjclose(self):
        index = pd.date_range("2023-01-02", periods=2, freq="B")
        frame = pd.DataFrame({"open": [10.0, 11.0], "high": [10.5, 11.5],
                              "low": [9.5, 10.5], "close": [10.0, 11.0],
                              "volume": [5, 5]}, index=index)
        adjusted = backtester.adjusted_frame(frame)
        self.assertAlmostEqual(adjusted["close"].iloc[1], 11.0)


if __name__ == "__main__":
    unittest.main()
