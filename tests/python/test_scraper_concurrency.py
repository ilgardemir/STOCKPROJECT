"""The scraper's parallel fetches must not change the SEC request rate or the Yahoo data shape."""
import threading
import time
import unittest
from unittest.mock import patch
from support import install_yahooquery_stub
install_yahooquery_stub()
import scraperFinal as scraper


class SecThrottleTests(unittest.TestCase):
    def test_concurrent_callers_keep_request_starts_spaced(self):
        # SEC_WORKERS threads share one per-process budget. Without the slot reservation,
        # every waiting thread sees the same last-request time and they all fire together.
        interval, starts, lock = 0.05, [], threading.Lock()
        def call():
            scraper._sec_throttle()
            with lock:
                starts.append(time.monotonic())
        with patch.object(scraper, "SEC_MIN_INTERVAL", interval), \
             patch.object(scraper, "_sec_last_request", time.monotonic()):
            threads = [threading.Thread(target=call) for _ in range(6)]
            for t in threads: t.start()
            for t in threads: t.join()
        starts.sort()
        gaps = [b - a for a, b in zip(starts, starts[1:])]
        self.assertEqual(len(starts), 6)
        self.assertGreaterEqual(min(gaps), interval * 0.8, gaps)


class YahooModuleBatchTests(unittest.TestCase):
    def make(self, payload):
        obj = object.__new__(scraper.YQData)
        obj.sym, obj._cache = "AAA", {}
        class Provider:
            calls = []
            def get_modules(self, modules):
                Provider.calls.append(list(modules)); return payload
        obj._yq = Provider()
        return obj, Provider

    def test_one_request_fills_every_property_and_earnings_history(self):
        obj, provider = self.make({"AAA": {
            "price": {"regularMarketPrice": 10}, "assetProfile": {"sector": "Technology"},
            "financialData": {"totalRevenue": 5}, "defaultKeyStatistics": {"pegRatio": 1.5},
            "summaryDetail": {"trailingPE": 20}, "calendarEvents": {"earnings": {}},
            "earningsTrend": {"trend": []},
            "earningsHistory": {"history": [{"quarter": "2024-09-30", "epsActual": 1},
                                            {"quarter": "2025-03-31", "epsActual": 2}]}}})
        obj.prefetch_modules()
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(obj.price_mod["regularMarketPrice"], 10)
        self.assertEqual(obj.asset_profile["sector"], "Technology")
        self.assertEqual(obj.key_stats["pegRatio"], 1.5)
        self.assertEqual(obj.summary_detail["trailingPE"], 20)
        self.assertEqual(obj.earnings_trend, {"trend": []})
        self.assertEqual(obj.earnings_hist().iloc[0].epsActual, 2)   # newest quarter first

    def test_missing_module_degrades_to_empty_and_failed_batch_caches_nothing(self):
        obj, _ = self.make({"AAA": {"price": {"regularMarketPrice": 10}}})
        obj.prefetch_modules()
        self.assertEqual(obj.financial_data, {})
        self.assertTrue(obj.earnings_hist().empty)
        failed, _ = self.make({"AAA": "Quote not found for symbol: AAA"})
        failed.prefetch_modules()
        self.assertEqual(failed._cache, {})   # each property falls back to its own request


if __name__ == "__main__":
    unittest.main()
