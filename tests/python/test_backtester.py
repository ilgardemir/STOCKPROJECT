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

        adjusted, ok = backtester.adjusted_frame(frame)

        self.assertTrue(ok)
        # every bar halves, because adjclose is half of close throughout
        self.assertAlmostEqual(adjusted["close"].iloc[0], 50.0)
        self.assertAlmostEqual(adjusted["open"].iloc[1], 51.0)
        self.assertAlmostEqual(adjusted["high"].iloc[2], 52.5)
        self.assertAlmostEqual(adjusted["low"].iloc[1], 50.5)
        # volume is never scaled
        self.assertEqual(adjusted["volume"].iloc[0], 1000)
        # the caller's frame is untouched
        self.assertAlmostEqual(frame["close"].iloc[0], 100.0)

    def test_adjusted_frame_falls_back_to_raw_without_adjclose(self):
        index = pd.date_range("2023-01-02", periods=2, freq="B")
        frame = pd.DataFrame({"open": [10.0, 11.0], "high": [10.5, 11.5],
                              "low": [9.5, 10.5], "close": [10.0, 11.0],
                              "volume": [5, 5]}, index=index)
        adjusted, ok = backtester.adjusted_frame(frame)
        self.assertAlmostEqual(adjusted["close"].iloc[1], 11.0)
        # The fall-through must be reported. It used to be indistinguishable from a
        # successful adjustment, which let a raw frame reach the returns calculation.
        self.assertFalse(ok)

    def test_adjusted_frame_reports_an_adjclose_column_that_is_all_null(self):
        # A column that exists but is entirely null is the same no-op as a missing
        # one, and the column lookup cannot tell the difference.
        index = pd.date_range("2023-01-02", periods=2, freq="B")
        frame = pd.DataFrame({"open": [10.0, 11.0], "high": [10.5, 11.5],
                              "low": [9.5, 10.5], "close": [10.0, 11.0],
                              "adjclose": [float("nan"), float("nan")],
                              "volume": [5, 5]}, index=index)
        adjusted, ok = backtester.adjusted_frame(frame)
        self.assertFalse(ok)
        self.assertAlmostEqual(adjusted["close"].iloc[1], 11.0)

    def test_adjusted_frame_carries_the_factor_across_a_null_bar(self):
        # A single null adjclose must not become ratio 1.0, which would drop one raw
        # bar into an adjusted series - a 10x spike that becomes the 52-week high.
        index = pd.date_range("2023-01-02", periods=3, freq="B")
        frame = pd.DataFrame({
            "open": [100.0, 100.0, 100.0], "high": [100.0, 100.0, 100.0],
            "low": [100.0, 100.0, 100.0], "close": [100.0, 100.0, 100.0],
            "adjclose": [10.0, float("nan"), 10.0], "volume": [1, 1, 1],
        }, index=index)
        adjusted, ok = backtester.adjusted_frame(frame)
        self.assertTrue(ok)
        self.assertAlmostEqual(adjusted["close"].iloc[1], 10.0)

    def test_a_split_inside_the_window_breaks_raw_returns_but_not_adjusted(self):
        """
        The regression the whole task exists for, and the one case the other tests
        cannot express: a ratio that STEPS partway through the window. When the
        ratio is constant it cancels out of every return, so a constant-ratio
        fixture cannot tell a working implementation from one that collapses the
        ratio to a scalar. Here a 10:1 split lands on bar 11.
        """
        index = pd.date_range("2024-01-01", periods=32, freq="B")
        # Pre-split the stock prints ~900; post-split it prints ~95. adjclose is
        # stated on today's basis throughout, so the ratio steps 0.1 -> 1.0.
        close = [900.0] * 11 + [95.0] * 21
        adjclose = [90.0] * 11 + [95.0] * 21
        frame = pd.DataFrame({"open": close, "high": close, "low": close,
                              "close": close, "adjclose": adjclose,
                              "volume": [1] * 32}, index=index)
        # Cutoff on bar 0, so entry is bar 1 (still pre-split at 900) and the 1m
        # exit is bar 21 (post-split at 95). The split has to straddle the entry;
        # putting the cutoff after it would make both bases agree and prove nothing.
        cutoff = index[0].date()

        raw = backtester.forward_outcomes(frame, cutoff)
        adjusted, ok = backtester.adjusted_frame(frame)
        adj = backtester.forward_outcomes(adjusted, cutoff)

        self.assertTrue(ok)
        # Raw: entry at the pre-split 900 open, measured against a post-split 95.
        self.assertAlmostEqual(raw["returns"]["1m"], 95.0 / 900.0 - 1, places=6)
        self.assertLess(raw["returns"]["1m"], -0.85)
        # Adjusted: entry at 90, measured against 95. The real move.
        self.assertAlmostEqual(adj["returns"]["1m"], 95.0 / 90.0 - 1, places=6)
        self.assertGreater(adj["returns"]["1m"], 0.0)

    @staticmethod
    def _wavy_frame(periods=260, start="2023-01-02", base=100.0, rise=100.0, wave=5.0):
        """A rising tape with real swings.

        A straight line has no interior local maximum, so find_swings returns nothing
        and analyze_price_action reports RANGE no matter how hard the line climbs. The
        sine term is what makes the fixture express a trend the swing engines can see.
        """
        index = pd.date_range(start, periods=periods, freq="B")
        close = base + np.linspace(0.0, rise, periods) + wave * np.sin(np.arange(periods) / 6.0)
        return pd.DataFrame({"open": close - 0.4, "high": close + 1.0, "low": close - 1.0,
                             "close": close, "volume": 1_000_000}, index=index)

    def test_scraper_frame_renames_columns_for_the_analyzer_engines(self):
        frame = self._wavy_frame(periods=5)
        out = backtester.scraper_frame(frame)
        for column in ("Open", "High", "Low", "Close", "Volume"):
            self.assertIn(column, out.columns)
        self.assertNotIn("close", out.columns)
        # the caller's frame is untouched
        self.assertIn("close", frame.columns)

    def test_derived_signals_produce_the_four_analyzer_blocks(self):
        frame = self._wavy_frame()
        signals = backtester.derived_signals(frame, float(frame["close"].iloc[-1]))

        self.assertIn("chart_patterns", signals)
        self.assertIn("key_levels", signals)
        self.assertEqual(signals["price_action"]["trend"], "UPTREND")
        self.assertIn("TRENDING", signals["market_regime"]["label"])
        self.assertIn("net_bias", signals["institutional"])
        # The blocks land in the snapshot, which is serialized with allow_nan=False.
        json.dumps(signals, allow_nan=False)

    def test_derived_signals_degrade_one_engine_without_losing_the_others(self):
        # No volume column: the two volume-reading engines must fail alone rather than
        # take the run, or the two that only need price, down with them.
        frame = self._wavy_frame().drop(columns=["volume"])
        signals = backtester.derived_signals(frame, float(frame["close"].iloc[-1]))

        self.assertNotIn("chart_patterns", signals)
        self.assertNotIn("institutional", signals)
        self.assertNotIn("market_regime", signals)
        self.assertEqual(signals["price_action"]["trend"], "UPTREND")

    @staticmethod
    def _tape(periods=300, base=100.0, rise=30.0, seed=7):
        rng = np.random.default_rng(seed)
        index = pd.date_range("2023-01-02", periods=periods, freq="B")
        close = base + np.linspace(0.0, rise, periods) + rng.normal(0, base * 0.01, periods)
        return pd.DataFrame({"open": close - 0.2, "high": close + 0.8, "low": close - 0.8,
                             "close": close, "volume": 1_000_000}, index=index)

    def test_relative_context_measures_the_stock_against_the_tape(self):
        stock = self._tape(base=100.0, rise=30.0, seed=7)     # roughly +30%
        spy = self._tape(base=400.0, rise=40.0, seed=11)      # roughly +10%

        rel = backtester.relative_context(stock, spy)

        closes, spy_closes = stock["close"], spy["close"]
        expected = ((closes.iloc[-1] / closes.iloc[-253] - 1)
                    - (spy_closes.iloc[-1] / spy_closes.iloc[-253] - 1))
        self.assertAlmostEqual(rel["rs_1y"], expected, places=9)
        self.assertGreater(rel["rs_1y"], 0.0)
        self.assertAlmostEqual(rel["spy_return_1y"], spy_closes.iloc[-1] / spy_closes.iloc[-253] - 1, places=9)
        self.assertLessEqual(rel["spy_drawdown_1y"], 0.0)
        self.assertGreaterEqual(rel["correlation_1y"], -1.0)
        self.assertLessEqual(rel["correlation_1y"], 1.0)
        self.assertIsNotNone(rel["beta_1y"])
        for key in ("rs_1m", "rs_3m", "rs_6m"):
            self.assertIsNotNone(rel[key])
        # classify_market_regime returns its verdict under "label", not "regime".
        # Reading the wrong key here fails silently: spy_regime just never appears.
        self.assertTrue(rel["spy_regime"])
        # The block lands in the snapshot, which is serialized with allow_nan=False.
        json.dumps(rel, allow_nan=False)

    def test_relative_context_needs_both_legs_and_enough_overlap(self):
        stock = self._tape()
        self.assertEqual(backtester.relative_context(stock, pd.DataFrame()), {})
        self.assertEqual(backtester.relative_context(stock, None), {})
        self.assertEqual(backtester.relative_context(pd.DataFrame(), stock), {})
        # Under 65 aligned sessions there is not enough tape to say anything.
        short = self._tape(periods=64)
        self.assertEqual(backtester.relative_context(short, self._tape(periods=64, seed=11)), {})


if __name__ == "__main__":
    unittest.main()
