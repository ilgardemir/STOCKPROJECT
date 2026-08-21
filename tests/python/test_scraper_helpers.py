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
        self.assertEqual(scraper.safe_fraction(25.4), 0.254)
        self.assertEqual(scraper.safe_fraction(0.254), 0.254)
        self.assertIsNone(scraper.safe_fraction(float("nan")))

    def test_is_valid_rejects_out_of_range_and_non_finite_values(self):
        self.assertTrue(scraper.is_valid(4.2, 0, 5))
        self.assertFalse(scraper.is_valid(8, 0, 5))
        self.assertFalse(scraper.is_valid(float("inf")))


if __name__ == "__main__":
    unittest.main()
