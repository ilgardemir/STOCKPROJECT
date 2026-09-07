import math
import unittest

import numpy as np
import pandas as pd

from support import install_yahooquery_stub

install_yahooquery_stub()

import scraperFinal as scraper


class ScraperSafeHelperTests(unittest.TestCase):
    def test_safe_float_rejects_non_finite_and_non_numeric_values(self):
        self.assertEqual(scraper.safe_float("12.5"), 12.5)
        self.assertIsNone(scraper.safe_float(float("nan")))
        self.assertIsNone(scraper.safe_float(float("inf")))
        self.assertIsNone(scraper.safe_float("not a number"))

    def test_safe_int_survives_provider_nan(self):
        self.assertEqual(scraper.safe_int(float("nan")), 0)
        self.assertEqual(scraper.safe_int(None, default=7), 7)
        self.assertEqual(scraper.safe_int("12.9"), 12)

    def test_safe_divide_handles_scalars_and_series(self):
        self.assertEqual(scraper.safe_divide(8, 2), 4)
        self.assertEqual(scraper.safe_divide(8, 0, default=-1), -1)
        self.assertEqual(scraper.safe_divide(math.nan, 2, default=3), 3)
        result = scraper.safe_divide(pd.Series([4.0, 2.0]), pd.Series([2.0, 0.0]), default=-1)
        self.assertEqual(result.tolist(), [2.0, -1.0])
        array = scraper.safe_divide(np.array([3.0, 1.0]), np.array([0.0, 2.0]), default=9)
        self.assertEqual(array.tolist(), [9.0, 0.5])

    def test_safe_fraction_normalizes_percentages_without_changing_ratios(self):
        self.assertEqual(scraper.safe_fraction(25.4, unit="percent"), 0.254)
        self.assertEqual(scraper.safe_fraction(0.254), 0.254)
        self.assertIsNone(scraper.safe_fraction(float("nan")))

    def test_is_valid_rejects_out_of_range_and_non_finite_values(self):
        self.assertTrue(scraper.is_valid(4.2, 0, 5))
        self.assertFalse(scraper.is_valid(8, 0, 5))
        self.assertFalse(scraper.is_valid(float("inf")))


def _daily_frame(rows=300):
    """Deterministic daily OHLCV with a gentle uptrend — no randomness, no network."""
    idx = pd.bdate_range("2024-01-01", periods=rows)
    close = pd.Series([100.0 + i * 0.25 for i in range(rows)], index=idx)
    return pd.DataFrame({
        "Open":   close - 0.40,
        "High":   close + 0.90,
        "Low":    close - 1.10,
        "Close":  close,
        "Volume": pd.Series([1_000_000 + (i % 7) * 50_000 for i in range(rows)], index=idx),
    }, index=idx)


def _intraday_frame(bars=78):
    idx = pd.date_range("2024-05-01 09:30", periods=bars, freq="5min")
    close = pd.Series([200.0 + i * 0.05 for i in range(bars)], index=idx)
    return pd.DataFrame({
        "Open":   close - 0.02,
        "High":   close + 0.08,
        "Low":    close - 0.09,
        "Close":  close,
        "Volume": pd.Series([12_000] * bars, index=idx),
    }, index=idx)


class IntradaySeriesTests(unittest.TestCase):
    def test_bar_dates_carry_a_time_and_stay_unique(self):
        bars = scraper.get_intraday_series(_intraday_frame(), 400)
        self.assertEqual(len(bars), 78)
        self.assertEqual(bars[0]["date"], "2024-05-01 09:30")
        # The chart looks bars up by findIndex on `date`; a date-only key would collide
        # 78 times inside one session and silently anchor Fib handles to the wrong bar.
        self.assertEqual(len(bars), len({b["date"] for b in bars}))

    def test_caps_to_max_bars_keeping_the_most_recent(self):
        bars = scraper.get_intraday_series(_intraday_frame(), 10)
        self.assertEqual(len(bars), 10)
        self.assertEqual(bars[-1]["date"], "2024-05-01 15:55")

    def test_survives_nan_volume_and_drops_incomplete_bars(self):
        frame = _intraday_frame(12)
        frame.loc[frame.index[3], "Volume"] = float("nan")
        frame.loc[frame.index[5], "Close"] = float("nan")
        bars = scraper.get_intraday_series(frame, 400)
        self.assertEqual(len(bars), 11)                      # the NaN close is dropped
        self.assertEqual(bars[3]["volume"], 0)               # the NaN volume is not
        self.assertTrue(all(isinstance(b["volume"], int) for b in bars))

    def test_empty_and_missing_frames_return_an_empty_list(self):
        self.assertEqual(scraper.get_intraday_series(None, 100), [])
        self.assertEqual(scraper.get_intraday_series(pd.DataFrame(), 100), [])
        self.assertEqual(scraper.get_intraday_series(_intraday_frame(), 0), [])


class PriceBarBlockTests(unittest.TestCase):
    def test_block_carries_returns_ten_sessions_and_weekly_closes(self):
        block = scraper.build_price_bar_block(_daily_frame(), None)
        self.assertIn("### 6b. RECENT PRICE BARS", block)
        self.assertIn("Returns:", block)
        for label in ("1D", "1W", "1M", "3M", "6M", "1Y", "YTD"):
            self.assertIn(label + " ", block)
        session_rows = [l for l in block.splitlines() if l.startswith("- ") and "vol " in l]
        self.assertEqual(len(session_rows), 10)
        weekly = [l for l in block.splitlines() if l.startswith("Weekly closes")]
        self.assertEqual(len(weekly), 1)
        self.assertEqual(len(weekly[0].split(":")[1].split(",")), 12)

    def test_never_emits_nan_or_inf_into_the_prompt(self):
        frame = _daily_frame()
        frame.loc[frame.index[-2], "Volume"] = float("nan")
        frame.loc[frame.index[-4], "High"] = float("nan")
        block = scraper.build_price_bar_block(frame, None).lower()
        for token in ("nan", "inf"):
            self.assertNotIn(token, block)

    def test_last_session_line_is_omitted_without_intraday_data(self):
        self.assertNotIn("Latest session", scraper.build_price_bar_block(_daily_frame(), None))
        self.assertNotIn("Latest session", scraper.build_price_bar_block(_daily_frame(), []))

    def test_last_session_line_summarises_only_the_final_day(self):
        bars = scraper.get_intraday_series(_intraday_frame(), 400)
        # A prior session must not bleed into the latest-session high/low.
        stale = [dict(b, date=b["date"].replace("2024-05-01", "2024-04-30"), high=999.0) for b in bars]
        block = scraper.build_price_bar_block(_daily_frame(), stale + bars)
        self.assertIn("Latest session 2024-05-01 (78 5-min bars)", block)
        self.assertNotIn("999.00", block)

    def test_object_dtype_date_index_still_yields_ytd_and_weekly_closes(self):
        """The shape yahooquery actually returns, and the one that shipped broken.

        Dropping the symbol level leaves plain datetime.date keys, so the index is object
        dtype: .year raises and .resample refuses. Both call sites were inside try/except,
        so production silently lost YTD from the returns row and the weekly line entirely,
        while a bdate_range test frame — which already has a DatetimeIndex — passed.
        """
        frame = _daily_frame()
        frame.index = pd.Index([ts.date() for ts in frame.index], dtype=object)
        self.assertEqual(frame.index.dtype, object)          # guard the premise
        block = scraper.build_price_bar_block(frame, None)
        self.assertIn("YTD ", block)
        self.assertIn("Weekly closes", block)
        self.assertNotIn("nan", block.lower())

    def test_string_date_index_is_also_coerced(self):
        frame = _daily_frame()
        frame.index = pd.Index([ts.strftime("%Y-%m-%d") for ts in frame.index], dtype=object)
        block = scraper.build_price_bar_block(frame, None)
        self.assertIn("YTD ", block)
        self.assertIn("Weekly closes", block)

    def test_an_uncoercible_index_drops_only_the_dated_lines(self):
        # The returns row and the session table do not need dates and must survive.
        frame = _daily_frame()
        frame.index = pd.Index([f"row-{i}" for i in range(len(frame))], dtype=object)
        block = scraper.build_price_bar_block(frame, None)
        self.assertIn("Returns:", block)
        self.assertIn("1M ", block)
        self.assertNotIn("nan", block.lower())

    def test_missing_price_history_degrades_instead_of_raising(self):
        self.assertIn("unavailable", scraper.build_price_bar_block(None, None))
        self.assertIn("unavailable", scraper.build_price_bar_block(pd.DataFrame(), None))

    def test_short_history_still_produces_a_block(self):
        block = scraper.build_price_bar_block(_daily_frame(rows=6), None)
        self.assertIn("Returns:", block)
        self.assertIn("1D ", block)
        self.assertNotIn("1Y ", block)     # not enough bars to claim a one-year return
        self.assertNotIn("nan", block.lower())


class InstitutionalBiasTests(unittest.TestCase):
    """
    net_bias must not manufacture a verdict out of a tie.

    The original comparison was `dist >= acc` against a falling OBV, and the tie that
    actually occurs is 0 == 0 — no high-volume day in either direction over 25 sessions,
    i.e. no footprint evidence at all. That returned DISTRIBUTION, which
    classify_market_regime rewards with up to 7 points, which is enough to win outright.
    """

    @staticmethod
    def _frame(closes, volumes=None, opens=None):
        n = len(closes)
        volumes = volumes if volumes is not None else [1_000_000] * n
        opens = opens if opens is not None else [c - 0.01 for c in closes]
        index = pd.date_range("2023-01-02", periods=n, freq="B")
        return pd.DataFrame({
            "Open": opens, "Close": closes,
            "High": [max(o, c) + 0.5 for o, c in zip(opens, closes)],
            "Low": [min(o, c) - 0.5 for o, c in zip(opens, closes)],
            "Volume": volumes,
        }, index=index)

    def test_down_day_share_uses_previous_close_even_when_candles_are_green(self):
        # A gentle drift down on dead-flat volume: OBV slopes down, but no session
        # clears the 1.4x threshold, so acc and dist are both zero. Up-volume share
        # decides instead of the tie.
        closes = [100 - i * 0.05 for i in range(60)]
        out = scraper.analyze_institutional(self._frame(closes))
        self.assertEqual(out["accumulation_days"], 0)
        self.assertEqual(out["distribution_days"], 0)
        self.assertEqual(out["obv_trend"], "FALLING")
        self.assertEqual(out["up_vol_ratio"], 0)
        self.assertEqual(out["net_bias"], "DISTRIBUTION")

    def test_up_volume_share_breaks_the_tie_it_used_to_lose(self):
        # NVDA 2023-01-17 in miniature: 0/0 days, OBV falling, and 68% of volume on up
        # days sitting unread in the same dict as the bearish verdict.
        n = 60
        closes, opens, volumes = [], [], []
        price = 100.0
        for i in range(n):
            up = i % 3 != 0                       # two up sessions per down session
            opens.append(price)
            price += 0.4 if up else -0.9          # net drift down, so OBV still falls
            closes.append(price)
            volumes.append(1_000_000 if up else 300_000)
        out = scraper.analyze_institutional(self._frame(closes, volumes, opens))
        self.assertEqual((out["accumulation_days"], out["distribution_days"]), (0, 0))
        self.assertGreaterEqual(out["up_vol_ratio"], 0.60)
        self.assertEqual(out["net_bias"], "ACCUMULATION")

    def test_real_footprint_evidence_still_produces_a_verdict(self):
        # The fix must not neuter the signal where it is genuinely earned: high-volume
        # down closes with a falling OBV is distribution and should still say so.
        n = 60
        closes, opens, volumes = [], [], []
        price = 100.0
        for i in range(n):
            heavy_down = i >= n - 10 and i % 2 == 0
            opens.append(price)
            price += -3.0 if heavy_down else -0.1
            closes.append(price)
            volumes.append(6_000_000 if heavy_down else 800_000)
        out = scraper.analyze_institutional(self._frame(closes, volumes, opens))
        self.assertGreater(out["distribution_days"], out["accumulation_days"])
        self.assertEqual(out["net_bias"], "DISTRIBUTION")


class RegimeFramingTests(unittest.TestCase):
    def test_prompt_projection_drops_the_percentage_and_keeps_the_scale(self):
        # `confidence` clamps at 92 and 11 of 18 audited replays returned exactly that,
        # so it reads as near-certainty while measuring only the winning bucket's lead.
        # The dashboard keeps it for its meter; no prompt may carry it.
        regime = {"label": "DISTRIBUTION", "confidence": 92, "separation": "wide",
                  "summary": "s", "evidence": [], "conflicts": [], "basis": "b"}
        projected = scraper.regime_for_prompt(regime)
        self.assertNotIn("confidence", projected)
        self.assertEqual(projected["separation"], "wide")
        self.assertEqual(projected["basis"], "b")
        # Non-dict input degrades rather than throwing — this runs inside prompt assembly.
        self.assertEqual(scraper.regime_for_prompt(None), {})

    def test_reversal_shape_is_reported_as_a_conflict(self):
        # Price above all three averages while the averages are still stacked bearishly
        # is the signature of an early reversal. NVDA 2023-01-17 was exactly this shape
        # and the write-up shorted it, citing the regime label.
        # A long decline, then a recovery sharp enough to clear the 200-bar mean but
        # short enough that the 20-bar mean has not yet crossed the 50-bar one. That is
        # exactly the NVDA 2023-01-17 shape: price 17.66 above ma20 15.47, ma50 15.81 and
        # ma200 16.41, with the averages themselves still stacked 20 < 50 < 200.
        closes = [150 - i * 0.30 for i in range(240)]
        base = closes[-1]
        closes += [base + (i + 1) * 6.0 for i in range(5)]
        n = len(closes)
        index = pd.date_range("2023-01-02", periods=n, freq="B")
        hist = pd.DataFrame({
            "Open": closes, "Close": closes,
            "High": [c + 1 for c in closes], "Low": [c - 1 for c in closes],
            "Volume": [1_000_000] * n,
        }, index=index)
        price_action = scraper.analyze_price_action(hist, closes[-1])
        institutional = scraper.analyze_institutional(hist)
        regime = scraper.classify_market_regime(hist, price_action, institutional)
        self.assertIn(regime["separation"], ("wide", "moderate", "narrow"))
        joined = " ".join(regime["conflicts"])
        self.assertIn("reversal", joined.lower())

    def test_a_clean_uptrend_reports_no_conflicts(self):
        n = 260
        closes = [100 + i * 0.5 for i in range(n)]
        index = pd.date_range("2023-01-02", periods=n, freq="B")
        hist = pd.DataFrame({
            "Open": closes, "Close": [c + 0.2 for c in closes],
            "High": [c + 1 for c in closes], "Low": [c - 1 for c in closes],
            "Volume": [1_000_000] * n,
        }, index=index)
        price_action = scraper.analyze_price_action(hist, closes[-1])
        institutional = scraper.analyze_institutional(hist)
        regime = scraper.classify_market_regime(hist, price_action, institutional)
        self.assertEqual(regime["conflicts"], [])


class KeyLevelNoteTests(unittest.TestCase):
    def test_an_empty_level_list_says_why_it_is_empty(self):
        # A stock making new lows has no prior trough beneath it to cluster, so the
        # detector legitimately finds nothing. Shipped as a bare [] that was read as a
        # finding: 3 of 4 audited runs with no supports turned it into a bear point.
        n = 200
        closes = [200 - i * 0.8 for i in range(n)]
        index = pd.date_range("2023-01-02", periods=n, freq="B")
        hist = pd.DataFrame({
            "Open": closes, "Close": closes,
            "High": [c + 1 for c in closes], "Low": [c - 1 for c in closes],
            "Volume": [1_000_000] * n,
        }, index=index)
        _patterns, levels = scraper.detect_chart_patterns(hist, closes[-1])
        self.assertEqual(levels["support"], [])
        self.assertIn("levels_note", levels)
        self.assertIn("not a finding", levels["levels_note"])

    def test_no_note_when_both_sides_resolved(self):
        n = 200
        closes = [100 + 12 * math.sin(i / 9.0) for i in range(n)]
        index = pd.date_range("2023-01-02", periods=n, freq="B")
        hist = pd.DataFrame({
            "Open": closes, "Close": closes,
            "High": [c + 1 for c in closes], "Low": [c - 1 for c in closes],
            "Volume": [1_000_000] * n,
        }, index=index)
        _patterns, levels = scraper.detect_chart_patterns(hist, closes[-1])
        if levels["support"] and levels["resistance"]:
            self.assertNotIn("levels_note", levels)


if __name__ == "__main__":
    unittest.main()
