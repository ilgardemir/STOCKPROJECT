import json
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from support import install_yahooquery_stub

install_yahooquery_stub()

import screener


FIXTURE_PATH = Path(__file__).parents[1] / "fixtures" / "screener_rows.json"


class ScreenerScoringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = json.loads(FIXTURE_PATH.read_text())

    def test_scale_and_band_score_are_bounded(self):
        self.assertTrue(np.isnan(screener.scale(None, 0, 1)))
        self.assertEqual(screener.scale(-5, 0, 1), 0)
        self.assertEqual(screener.scale(5, 0, 1), 100)
        self.assertEqual(screener.band_score(5, 4, 6, 2, 8), 100)
        self.assertEqual(screener.band_score(9, 4, 6, 2, 8), 0)

    def test_concept_score_uses_profile_selected_windows(self):
        row = self.rows[0]
        self.assertEqual(screener.concept_score(row, "consolidation", {"consolidation_window": 20}), 82)
        self.assertEqual(screener.concept_score(row, "consolidation", {"consolidation_window": 60}), 61)
        self.assertEqual(screener.concept_score(row, "momentum", {"momentum_window": 20}), 90)
        self.assertEqual(screener.concept_score(row, "momentum", {"momentum_window": 252}), 45)
        self.assertIsNone(screener.concept_score(row, "missing", {}))

    def test_weighted_screening_ranks_deterministically(self):
        spec = {
            "concepts": [
                {"id": "quality", "weight": 3},
                {"id": "value", "weight": 1},
            ],
            "settings": {"match_threshold": 20},
            "filters": {},
            "max_results": 10,
        }
        results = screener.screen(self.rows, spec)
        self.assertEqual([row["ticker"] for row in results], ["AAA", "BBB"])
        self.assertGreater(results[0]["match_score"], results[1]["match_score"])

    def test_required_concept_and_hard_filters_remove_non_matches(self):
        spec = {
            "concepts": [{"id": "quality", "weight": 1, "required": True}],
            "settings": {"match_threshold": 70},
            "filters": {"sectors": ["Technology"], "price_min": 20},
            "max_results": 10,
        }
        results = screener.screen(self.rows, spec)
        self.assertEqual([row["ticker"] for row in results], ["AAA"])

    def test_theme_matching_uses_token_boundaries_for_short_terms(self):
        row = self.rows[0]
        score, terms = screener.theme_relevance(row, {"keywords": ["ai", "data center"]})
        self.assertGreater(score, 0)
        self.assertIn("data center", terms)
        self.assertEqual(screener.keyword_count("said retail company", "ai"), 0)

    def test_history_fixture_produces_finite_bounded_technical_scores(self):
        days = 260
        close = np.linspace(100, 150, days) + np.sin(np.arange(days) / 8)
        frame = pd.DataFrame({
            "Open": close - 0.4,
            "High": close + 1.0,
            "Low": close - 1.0,
            "Close": close,
            "Volume": np.linspace(2_000_000, 1_100_000, days),
        })
        features = screener.history_features(frame)
        self.assertIsNotNone(features)
        for concept in ("uptrend", "vcp", "cup_and_handle", "flat_base", "double_bottom", "bull_flag"):
            self.assertIn(concept, features["scores"])
            self.assertTrue(0 <= features["scores"][concept] <= 100)


if __name__ == "__main__":
    unittest.main()
