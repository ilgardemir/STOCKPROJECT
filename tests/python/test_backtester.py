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


if __name__ == "__main__":
    unittest.main()
