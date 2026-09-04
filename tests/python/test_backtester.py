import json
import unittest
from datetime import date
from unittest import mock

import numpy as np
import pandas as pd

from support import install_yahooquery_stub

install_yahooquery_stub()

import backtester


class HistoricalAnalyzerTests(unittest.TestCase):
    def setUp(self):
        # The submissions fetch is memoized per process so two callers cost one
        # request; tests must not inherit each other's entry.
        backtester._SUBMISSIONS_CACHE.clear()

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

    def test_fact_series_records_the_unit_it_actually_used(self):
        payload = {"facts": {"us-gaap": {"Revenues": {"label": "Revenues", "units": {"CAD": [
            {"val": 500, "end": "2022-12-31", "filed": "2023-02-01", "form": "10-K"},
        ]}}}}}
        fact = backtester.fact_series(payload, ["Revenues"], "USD", date(2023, 3, 15))
        # The requested unit was USD but only CAD exists; the row must not claim USD.
        self.assertEqual(fact["series"][0]["unit"], "CAD")

    def test_company_identity_does_not_stamp_a_post_cutoff_rename(self):
        # entityName is today's name. A snapshot dated before a rename must not carry it.
        name = backtester.company_identity("AAA", {"entityName": "Renamed Holdings"},
                                           filings=[{"form": "10-K", "filed": "2019-02-01",
                                                     "entity_name": "Original Corp"}])
        self.assertEqual(name, "Original Corp")
        # With no dated evidence, fall back to the ticker rather than the current name.
        # The SEC ticker directory is today's data too, so it is patched out here rather
        # than reached over the network; the production fall-through order is unchanged.
        with mock.patch.object(backtester.scraper, "_load_sec_tickers", return_value=[]):
            self.assertEqual(backtester.company_identity("AAA", {"entityName": "Renamed"}, filings=[]), "AAA")

    def test_fact_series_prefers_the_concept_carrying_the_freshest_data(self):
        """
        Filers migrate XBRL tags mid-life and leave the retired one populated with
        stale rows. Taking the first concept with ANY eligible data froze NVDA's
        revenue at FY2022 while its gross profit tracked FY2024 -- measured on live
        SEC data, a 165% gross margin and a 111% net margin, computed with total
        confidence from two different fiscal years.
        """
        payload = {"facts": {"us-gaap": {
            "Retired": {"label": "Retired", "units": {"USD": [
                {"val": 10, "start": "2021-01-01", "end": "2021-12-31",
                 "filed": "2022-02-01", "form": "10-K"}]}},
            "Current": {"label": "Current", "units": {"USD": [
                {"val": 40, "start": "2022-01-01", "end": "2022-12-31",
                 "filed": "2023-02-01", "form": "10-K"}]}},
        }}}
        fact = backtester.fact_series(payload, ["Retired", "Current"], "USD", date(2023, 3, 15))
        self.assertEqual(fact["concept"], "Current")
        self.assertEqual(fact["series"][0]["value"], 40)

    def test_fact_series_keeps_concept_order_when_both_are_equally_fresh(self):
        # Freshness decides; the caller's ordering is still the tie-break, so the
        # preferred (usually more precise) tag wins when both are up to date.
        rows = [{"val": 1, "start": "2022-01-01", "end": "2022-12-31",
                 "filed": "2023-02-01", "form": "10-K"}]
        payload = {"facts": {"us-gaap": {
            "Preferred": {"label": "Preferred", "units": {"USD": list(rows)}},
            "Fallback": {"label": "Fallback", "units": {"USD": list(rows)}},
        }}}
        fact = backtester.fact_series(payload, ["Preferred", "Fallback"], "USD", date(2023, 3, 15))
        self.assertEqual(fact["concept"], "Preferred")

    def test_fact_series_finds_concepts_in_the_dei_taxonomy(self):
        # EntityCommonStockSharesOutstanding is a dei concept, not a us-gaap one, so
        # the shares_outstanding fallback could never match: a filer that tags only
        # dei got no share count, and with it no market cap, P/S, P/B, EV/EBITDA or
        # FCF yield -- silently, with the fallback sitting right there in FACTS.
        payload = {"facts": {"dei": {"EntityCommonStockSharesOutstanding": {
            "label": "Shares", "units": {"shares": [
                {"val": 50, "end": "2022-12-31", "filed": "2023-02-01", "form": "10-K"}]}}}}}
        fact = backtester.fact_series(payload, ["CommonStockSharesOutstanding",
                                               "EntityCommonStockSharesOutstanding"],
                                      "shares", date(2023, 3, 15))
        self.assertEqual(fact["series"][0]["value"], 50)

    def test_company_identity_reads_former_names_when_no_filing_survives(self):
        """
        SEC's `recent` filing list only reaches back so far. Measured live: for META
        at 2019-02-01 every row in it postdates the cutoff, so `filings` is empty,
        the filing-stamped name never gets a chance, and the fall-through returns
        today's "Meta Platforms, Inc." -- the exact leak Task 12 exists to stop.
        """
        submissions = {"name": "Meta Platforms, Inc.", "formerNames": [
            {"name": "Facebook Inc", "from": "2012-01-30T00:00:00.000Z",
             "to": "2021-10-28T00:00:00.000Z"}]}
        with mock.patch.object(backtester.scraper, "_load_sec_tickers",
                               return_value=[{"ticker": "META", "title": "Meta Platforms, Inc."}]):
            name = backtester.company_identity(
                "META", {"entityName": "Meta Platforms, Inc."}, filings=[],
                submissions=submissions, as_of=date(2019, 2, 1))
        self.assertEqual(name, "Facebook Inc")

    def test_submissions_are_fetched_once_for_both_readers(self):
        # Filings and the name both need this document. Two fetches would double the
        # per-run SEC pressure for one document that has not changed in between.
        with mock.patch.object(backtester.scraper, "_sec_get",
                               return_value={"name": "X"}) as fetch:
            backtester.sec_submissions("0000000001")
            backtester.point_in_time_filings("0000000001", date(2020, 1, 1))
        self.assertEqual(fetch.call_count, 1)

    def test_entity_name_at_reads_the_dated_former_name_records(self):
        submissions = {"name": "Meta Platforms, Inc.", "formerNames": [
            {"name": "Facebook Inc", "from": "2012-01-30T00:00:00.000Z", "to": "2021-10-28T00:00:00.000Z"},
        ]}
        self.assertEqual(backtester.entity_name_at(submissions, "2019-02-01"), "Facebook Inc")
        # After the last former-name window closed, the current name is the right one.
        self.assertEqual(backtester.entity_name_at(submissions, "2023-02-01"), "Meta Platforms, Inc.")
        # Before any record exists there is no dated evidence, so say nothing.
        self.assertIsNone(backtester.entity_name_at(submissions, "2010-01-01"))
        # A filer SEC has never seen renamed carries its one name at any date.
        self.assertEqual(backtester.entity_name_at({"name": "Apple Inc."}, "2010-01-01"), "Apple Inc.")

    def test_point_in_time_filings_stamp_the_name_in_force_when_filed(self):
        # Without this, company_identity's `filings` argument reads a key no row has
        # ever carried: the loop falls through on every real run, forever, silently.
        submissions = {
            "name": "Renamed Holdings",
            "formerNames": [{"name": "Original Corp", "from": "2000-01-01T00:00:00.000Z",
                             "to": "2020-06-30T00:00:00.000Z"}],
            "filings": {"recent": {
                "form": ["10-K", "10-K"],
                "filingDate": ["2021-02-01", "2019-02-01"],
                "reportDate": ["2020-12-31", "2018-12-31"],
                "accessionNumber": ["0001", "0002"],
                "primaryDocument": ["a.htm", "b.htm"],
            }},
        }
        with mock.patch.object(backtester.scraper, "_sec_get", return_value=submissions):
            rows = backtester.point_in_time_filings("0000000001", date(2019, 6, 1))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["filed"], "2019-02-01")
        self.assertEqual(rows[0]["entity_name"], "Original Corp")

    def _fact(self, rows):
        return {"concept": "Revenues", "label": "Revenues", "series": rows}

    @staticmethod
    def _flow_row(value, start, end, filed=None, form="10-Q"):
        return {"value": value, "period_start": start, "period_end": end,
                "filed": filed or end, "form": form}

    def test_ttm_sums_four_discrete_quarters(self):
        rows = [
            self._flow_row(40, "2022-10-01", "2022-12-31", "2023-02-01"),
            self._flow_row(30, "2022-07-01", "2022-09-30", "2022-11-01"),
            self._flow_row(20, "2022-04-01", "2022-06-30", "2022-08-01"),
            self._flow_row(10, "2022-01-01", "2022-03-31", "2022-05-01"),
        ]
        result = backtester.ttm_value(self._fact(rows))
        self.assertEqual(result["value"], 100)
        self.assertEqual(result["basis"], "quarters")
        self.assertEqual(result["period_end"], "2022-12-31")

    def test_ttm_refuses_four_quarters_that_do_not_abut(self):
        # Four Q1 rows from four different years are four quarter-length spans and
        # nothing else. Summing them is a four-year total wearing a TTM label.
        rows = [self._flow_row(v, f"{y}-01-01", f"{y}-03-31", f"{y}-05-01")
                for v, y in ((40, 2022), (30, 2021), (20, 2020), (10, 2019))]
        self.assertIsNone(backtester.ttm_value(self._fact(rows)))

    def test_ttm_rolls_a_year_to_date_period_forward_off_the_prior_year(self):
        # The case that actually dominates: 10-Q cash-flow rows are cumulative from
        # the fiscal year start, so no discrete quarter is ever reported. The roll
        # forward is prior FY + current YTD - prior-year YTD, and it must beat the
        # annual fallback, which here is a full quarter staler.
        rows = [
            self._flow_row(60, "2022-01-01", "2022-09-30", "2022-11-01"),
            self._flow_row(100, "2021-01-01", "2021-12-31", "2022-02-01", form="10-K"),
            self._flow_row(55, "2021-01-01", "2021-09-30", "2021-11-01"),
        ]
        result = backtester.ttm_value(self._fact(rows))
        self.assertEqual(result["value"], 105)
        self.assertEqual(result["basis"], "derived")
        self.assertEqual(result["period_end"], "2022-09-30")

    def test_ttm_falls_back_to_the_latest_annual_figure(self):
        # A full year plus a YTD stub of the SAME year cannot be rolled forward --
        # there is no prior annual to roll off -- and the full year is also the
        # fresher period, so the annual figure is the answer.
        rows = [
            self._flow_row(100, "2022-01-01", "2022-12-31", "2023-02-01", form="10-K"),
            self._flow_row(60, "2022-01-01", "2022-09-30", "2022-11-01"),
        ]
        result = backtester.ttm_value(self._fact(rows))
        self.assertEqual(result["value"], 100)
        self.assertEqual(result["basis"], "annual")
        self.assertEqual(result["period_end"], "2022-12-31")

    def test_ttm_refuses_when_nothing_usable_exists(self):
        self.assertIsNone(backtester.ttm_value(None))
        self.assertIsNone(backtester.ttm_value(self._fact([])))
        self.assertIsNone(backtester.ttm_value(self._fact([
            self._flow_row(5, None, "2022-12-31", "2023-02-01"),
        ])))

    def test_point_in_time_value_takes_the_latest_instant(self):
        fact = self._fact([
            {"value": 500.0, "period_end": "2022-12-31", "filed": "2023-02-01", "form": "10-K"},
            {"value": 400.0, "period_end": "2021-12-31", "filed": "2022-02-01", "form": "10-K"},
        ])
        self.assertEqual(backtester.point_in_time_value(fact),
                         {"value": 500.0, "period_end": "2022-12-31"})
        self.assertIsNone(backtester.point_in_time_value(None))
        self.assertIsNone(backtester.point_in_time_value(self._fact([])))

    @staticmethod
    def _flow_fact(value, end, start):
        return {"concept": "X", "series": [
            {"value": value, "period_start": start, "period_end": end,
             "filed": end, "form": "10-K"}]}

    @staticmethod
    def _instant_fact(value, end):
        return {"concept": "X", "series": [
            {"value": value, "period_end": end, "filed": end, "form": "10-K"}]}

    def _valuation_facts(self):
        return {
            "revenue": self._flow_fact(1000.0, "2022-12-31", "2022-01-01"),
            "net_income": self._flow_fact(100.0, "2022-12-31", "2022-01-01"),
            "diluted_eps": self._flow_fact(2.0, "2022-12-31", "2022-01-01"),
            "equity": self._instant_fact(500.0, "2022-12-31"),
            "shares_outstanding": self._instant_fact(50.0, "2022-12-31"),
        }

    def test_valuation_prices_off_the_split_adjusted_close(self):
        block = backtester.valuation_block(self._valuation_facts(), split_adjusted_price=40.0)

        self.assertAlmostEqual(block["valuation"]["pe"], 20.0)          # 40 / 2
        self.assertAlmostEqual(block["valuation"]["ps"], 2.0)           # 40*50 / 1000
        self.assertAlmostEqual(block["valuation"]["pb"], 4.0)           # 40*50 / 500
        self.assertAlmostEqual(block["fundamentals"]["net_margin"], 0.1)
        self.assertEqual(block["valuation"]["ttm_basis"], "annual")

    def test_valuation_never_claims_a_price_basis_it_does_not_have(self):
        """
        The plan asserted price_basis == "as-reported close at the cutoff". No such
        price exists anywhere in this pipeline: Yahoo's unadjusted close is already
        split-adjusted, so every price-derived ratio here is divided by whatever
        split factor lands between the cutoff and today. Shipping the plan's string
        would have put that claim into the AI prompt as prose.
        """
        block = backtester.valuation_block(self._valuation_facts(), split_adjusted_price=40.0)
        valuation = block["valuation"]

        self.assertNotIn("as-reported close at the cutoff", valuation["price_basis"])
        self.assertIn("no as-reported close", valuation["price_basis"])
        # Machine-readable, not only prose: a reader that never parses English still
        # learns the level is untrustworthy.
        self.assertFalse(valuation["per_share_ratios_reliable"])
        self.assertIn("split", valuation["basis_caveat"].lower())
        # The caveat has to name the fields it applies to, or it is decoration.
        for key in ("pe", "ps", "pb", "market_cap"):
            self.assertIn(key, valuation["basis_caveat"])

    def test_fundamentals_survive_a_missing_price(self):
        # Margins, ROE and leverage need no price at all, so they are the one part of
        # this block that is exactly right. Dropping them with the valuation, as the
        # plan's early return did, throws away the only trustworthy half.
        facts = self._valuation_facts()
        block = backtester.valuation_block(facts, split_adjusted_price=None)

        self.assertNotIn("valuation", block)
        self.assertAlmostEqual(block["fundamentals"]["net_margin"], 0.1)
        self.assertAlmostEqual(block["fundamentals"]["roe"], 0.2)

    def test_valuation_is_omitted_without_a_price(self):
        self.assertEqual(backtester.valuation_block({"revenue": None}, split_adjusted_price=None), {})

    def test_gross_margin_falls_back_to_revenue_less_cost_of_revenue(self):
        # Plenty of filers never tag GrossProfit. Without this the concept is fetched,
        # shipped in the prompt, and used by nothing.
        facts = self._valuation_facts()
        facts["cost_of_revenue"] = self._flow_fact(600.0, "2022-12-31", "2022-01-01")
        block = backtester.valuation_block(facts, split_adjusted_price=40.0)
        self.assertAlmostEqual(block["fundamentals"]["gross_margin"], 0.4)

    def test_valuation_block_serializes_under_the_payload_rules(self):
        facts = self._valuation_facts()
        facts["equity"] = self._instant_fact(0.0, "2022-12-31")   # roe and pb divide by zero
        block = backtester.valuation_block(facts, split_adjusted_price=40.0)
        self.assertNotIn("pb", block["valuation"])
        self.assertNotIn("roe", block["fundamentals"])
        json.dumps(block, allow_nan=False)

    def test_prompt_blocks_carry_the_derived_valuation_to_the_model(self):
        # PROMPT_BLOCKS is an allowlist: a snapshot key absent from it silently never
        # reaches the model, with nothing anywhere to say so.
        prompt = backtester.build_ai_prompt({
            "ticker": "AAA", "as_of": "2023-03-15",
            "valuation": {"pe": 20.0}, "fundamentals": {"net_margin": 0.1},
        })
        self.assertIn('"valuation"', prompt)
        self.assertIn('"fundamentals"', prompt)
        self.assertIn("20.0", prompt)

    def test_ai_prompt_excludes_realized_outcomes_and_raw_bars(self):
        snapshot = {
            "ticker": "AAA", "as_of": "2023-03-15",
            "technical": {"metrics": {"price": 10}},
            "price_history": [{"d": "2023-03-14", "o": 9.5, "h": 10.1, "l": 9.4, "c": 10.0, "v": 100}],
            "market_regime": {"regime": "TRENDING"},
        }
        outcomes = {
            "entry_price": 123.456789, "returns": {"1m": 0.077712345},
            "benchmark_returns": {"1m": 0.011198765}, "max_drawdown_6m": -0.198765,
            "bars": {"dates": ["2023-03-16"], "close": [124.5]},
        }
        prompt = backtester.build_ai_prompt(snapshot)

        # Every realized number must be absent, not merely a key name we happen to avoid.
        for value in ("123.456789", "0.077712345", "0.011198765", "-0.198765", "124.5"):
            self.assertNotIn(value, prompt, f"{value} leaked into the AI prompt")
        # The raw bar array is for the chart, not the prompt.
        self.assertNotIn('"price_history"', prompt)
        self.assertNotIn("9.4", prompt)
        # The derived reads must survive the projection.
        self.assertIn("TRENDING", prompt)
        self.assertIn("AAA", prompt)
        self.assertIn("You must choose LONG or SHORT", prompt)
        self.assertIn("entry at the next session open", prompt)
        self.assertIn("MySquall preferences", prompt)
        # Sanity: the fixture is realistic enough that a naive dump WOULD have leaked.
        self.assertIn("123.456789", json.dumps({**snapshot, **outcomes}))

    def test_price_history_stops_at_the_cutoff(self):
        index = pd.date_range("2024-01-01", periods=30, freq="B")
        close = np.arange(50.0, 80.0)
        frame = pd.DataFrame({"open": close, "high": close + 1, "low": close - 1,
                              "close": close, "volume": 1000}, index=index)
        cutoff = index[20].date()
        before, _ = backtester.split_at_date(frame, cutoff)

        bars = backtester.price_history_rows(before, limit=252)

        self.assertEqual(bars[-1]["d"], cutoff.isoformat())
        self.assertTrue(all(row["d"] <= cutoff.isoformat() for row in bars))
        self.assertEqual(len(bars), 21)

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


class EventRiskTests(unittest.TestCase):
    """
    When the next results land, reconstructed from the issuer's own filing history.

    Exists because the 18-run audit found the model trading blind through scheduled
    events: 1 of 18 analyses mentioned an upcoming report, while the five cases with
    results due inside three weeks averaged -15.1% over the following month.
    """

    @staticmethod
    def _series(pairs):
        return [{"value": 1000.0 + i, "unit": "USD", "period_end": end,
                 "period_start": None, "filed": filed, "form": "10-Q",
                 "fiscal_year": 2024, "fiscal_period": "Q1"}
                for i, (end, filed) in enumerate(pairs)]

    @classmethod
    def _facts(cls, pairs, name="revenue"):
        """pairs: [(period_end, filed), ...] newest first, as fact_series emits them."""
        return {name: {"concept": "Revenues", "label": "Revenues",
                       "series": cls._series(pairs)}}

    def test_cover_page_dates_never_define_the_cadence(self):
        # shares_outstanding resolves to the dei cover-page fact, whose period_end is the
        # cover date rather than the quarter end — TSLA reported 2021-10-21 against a
        # quarter that closed 2021-09-30. Unioned in, that sorted last and became the
        # anchor, and its ~21-day offsets interleaved with the real quarter ends to
        # produce spurious ~70-day spacings: the measured cadence came out 72 instead of
        # 91, and the estimate landed six days BEFORE the cutoff.
        facts = self._facts([
            ("2021-09-30", "2021-10-25"), ("2021-06-30", "2021-07-27"),
            ("2021-03-31", "2021-04-28"), ("2020-12-31", "2021-02-08"),
        ])
        facts["shares_outstanding"] = {
            "concept": "EntityCommonStockSharesOutstanding", "label": "Shares",
            "series": self._series([
                ("2021-10-21", "2021-10-25"), ("2021-07-22", "2021-07-27"),
                ("2021-04-21", "2021-04-28"), ("2021-02-01", "2021-04-30"),
            ])}
        out = backtester.event_risk(facts, date(2022, 1, 14))
        self.assertEqual(out["last_reported_period_end"], "2021-09-30")
        self.assertGreaterEqual(out["reporting_cadence_days"], 85)
        self.assertLessEqual(out["reporting_cadence_days"], 95)
        self.assertEqual(out["pending_period_end"], "2021-12-31")
        # TSLA announced Q4 2021 on 2022-01-26; the window has to contain it.
        low, high = out["earnings_window"]
        self.assertLessEqual(date.fromisoformat(low), date(2022, 1, 26))
        self.assertGreaterEqual(date.fromisoformat(high), date(2022, 1, 26))

    def test_days_out_is_never_negative(self):
        # A negative "days until" reads as nonsense to a model. An already-open window
        # says so in its own field instead of through a sign.
        out = backtester.event_risk(self._facts([
            ("2024-06-30", "2024-07-05"), ("2024-03-31", "2024-04-05"),
            ("2023-12-31", "2024-01-05"), ("2023-09-30", "2023-10-05"),
        ]), date(2024, 11, 20))
        self.assertGreaterEqual(out["days_until_earnings_window_opens"], 0)
        self.assertGreaterEqual(out["days_until_earnings_window_closes"], 0)
        self.assertTrue(out["earnings_window_already_open"])

    def test_anchors_on_the_quarter_that_ended_but_has_not_been_filed(self):
        # INTC at 2024-07-15: last FILED covers the quarter ended 2024-03-30, but the
        # quarter ending ~2024-06-29 is already over and outstanding. Anchoring on the
        # filed one projects a full quarter late and misses the event entirely — INTC
        # reported on 2024-08-01 and fell 40% inside the month.
        out = backtester.event_risk(self._facts([
            ("2024-03-30", "2024-04-26"), ("2023-12-30", "2024-01-26"),
            ("2023-09-30", "2023-10-27"), ("2023-07-01", "2023-07-28"),
            ("2023-04-01", "2023-04-28"),
        ]), date(2024, 7, 15))
        self.assertIsNotNone(out)
        pending = date.fromisoformat(out["pending_period_end"])
        # The pending period must be the one after the last reported, not two after.
        self.assertGreater(pending, date(2024, 3, 30))
        self.assertLess(pending, date(2024, 7, 15))
        self.assertTrue(out["pending_period_already_ended"])
        # INTC reported on 2024-08-01 and fell 40% inside the month, so the window has to
        # open close enough to matter to a one-month hold.
        self.assertLess(out["days_until_earnings_window_opens"], 30)
        self.assertTrue(out["falls_inside_horizon"]["1m"])
        self.assertTrue(out["falls_inside_horizon"]["3m"])

    def test_a_report_two_days_out_is_flagged_inside_every_horizon(self):
        # UNH at 2025-04-15 reported on 2025-04-17 and lost 53% inside the month. The
        # model went long into it without mentioning the date.
        out = backtester.event_risk(self._facts([
            ("2024-12-31", "2025-02-27"), ("2024-09-30", "2024-11-04"),
            ("2024-06-30", "2024-08-02"), ("2024-03-31", "2024-05-03"),
            ("2023-12-31", "2024-02-28"),
        ]), date(2025, 4, 15))
        self.assertIsNotNone(out)
        self.assertEqual(out["pending_period_end"][:7], "2025-03")
        self.assertTrue(all(out["falls_inside_horizon"].values()))
        # UNH announced on 2025-04-17, two days after this cutoff, and lost 53% inside
        # the month. The window must contain that date — this is the case the whole block
        # exists for.
        low, high = out["earnings_window"]
        self.assertLessEqual(date.fromisoformat(low), date(2025, 4, 17))
        self.assertGreaterEqual(date.fromisoformat(high), date(2025, 4, 17))

    def test_the_window_never_opens_before_the_period_it_reports_on(self):
        # No filer announces a completed quarter inside two weeks of its close, so a fast
        # filer must not produce a window opening on or before the period end itself.
        out = backtester.event_risk(self._facts([
            ("2024-09-30", "2024-10-02"), ("2024-06-30", "2024-07-02"),
            ("2024-03-31", "2024-04-02"), ("2023-12-31", "2024-01-03"),
        ]), date(2024, 11, 1))
        self.assertGreater(date.fromisoformat(out["earnings_window"][0]),
                           date.fromisoformat(out["pending_period_end"]))
        # The window is ordered, never inverted.
        self.assertLessEqual(date.fromisoformat(out["earnings_window"][0]),
                             date.fromisoformat(out["earnings_window"][1]))

    def test_annual_period_ends_do_not_stretch_the_cadence(self):
        # A quarterly reporter also emits annual period ends, so the raw gap set mixes
        # ~91 with ~365. Taking the median across all of them would push the next report
        # months away and silently disarm the whole block.
        out = backtester.event_risk(self._facts([
            ("2024-09-30", "2024-10-28"), ("2024-06-30", "2024-07-29"),
            ("2024-03-31", "2024-04-29"), ("2023-12-31", "2024-02-20"),
            ("2023-09-30", "2023-10-28"), ("2023-06-30", "2023-07-29"),
        ]), date(2024, 11, 15))
        self.assertLessEqual(out["reporting_cadence_days"], 120)
        self.assertGreaterEqual(out["reporting_cadence_days"], 60)

    def test_degrades_to_none_rather_than_guessing(self):
        self.assertIsNone(backtester.event_risk({}, date(2024, 1, 1)))
        self.assertIsNone(backtester.event_risk(None, date(2024, 1, 1)))
        # One period cannot establish a cadence.
        self.assertIsNone(backtester.event_risk(
            self._facts([("2024-03-31", "2024-04-28")]), date(2024, 7, 1)))
        # A row whose filed date precedes its period end is malformed and is dropped;
        # dropping every row leaves nothing to reason from.
        self.assertIsNone(backtester.event_risk(
            self._facts([("2024-03-31", "2024-01-01"), ("2023-12-31", "2023-01-01")]),
            date(2024, 7, 1)))

    def test_the_block_serializes_under_the_engine_s_own_json_rules(self):
        out = backtester.event_risk(self._facts([
            ("2024-09-30", "2024-10-28"), ("2024-06-30", "2024-07-29"),
            ("2024-03-31", "2024-04-29"),
        ]), date(2024, 11, 15))
        json.dumps(out, allow_nan=False)


class PromptProjectionTests(unittest.TestCase):
    def test_sec_facts_are_trimmed_for_the_prompt_but_not_the_snapshot(self):
        # sec_facts measured 29,000-30,300 characters of a ~37,600 character prompt:
        # 77-80% of everything the model read, to produce two lines of YoY growth.
        series = [{"value": float(i), "unit": "USD", "period_end": f"2024-0{(i % 9) + 1}-30",
                   "period_start": "2024-01-01", "filed": f"2024-0{(i % 9) + 1}-30",
                   "form": "10-Q", "fiscal_year": 2024, "fiscal_period": "Q1"}
                  for i in range(10)]
        facts = {"revenue": {"concept": "Revenues", "label": "Revenues", "series": series}}
        trimmed = backtester.facts_for_prompt(facts)
        self.assertEqual(len(trimmed["revenue"]["series"]),
                         backtester.PROMPT_FACT_PERIODS)
        # The newest row keeps its full shape; the rest shed constants inferable from
        # period_end.
        self.assertIn("fiscal_year", trimmed["revenue"]["series"][0])
        for row in trimmed["revenue"]["series"][1:]:
            for dropped in backtester.PROMPT_FACT_DROP:
                self.assertNotIn(dropped, row)
        # The source dict is untouched — the dashboard still discloses all ten periods.
        self.assertEqual(len(facts["revenue"]["series"]), 10)

    def test_the_prompt_carries_event_risk_and_never_a_confidence_percentage(self):
        snapshot = {
            "ticker": "TST", "as_of": "2024-06-03", "effective_market_date": "2024-05-31",
            "technical": {"metrics": {}, "scores": {}},
            "market_regime": {"label": "DISTRIBUTION", "confidence": 92,
                              "separation": "wide", "summary": "s", "evidence": [],
                              "conflicts": ["c"], "basis": "b"},
            "event_risk": {"release_estimate": "2024-06-20"},
            "sec_facts": {},
        }
        prompt = backtester.build_ai_prompt(snapshot)
        self.assertIn("event_risk", prompt)
        self.assertIn("2024-06-20", prompt)
        self.assertIn("separation", prompt)
        # The clamped score margin must not reach the model as a percentage.
        self.assertNotIn('"confidence"', prompt)
        # ...while the snapshot the dashboard renders still has it.
        self.assertEqual(snapshot["market_regime"]["confidence"], 92)

    def test_event_risk_is_a_prompt_block(self):
        # A block absent from PROMPT_BLOCKS is computed, shipped to the browser, and
        # never seen by the model — silently, with nothing raising.
        self.assertIn("event_risk", backtester.PROMPT_BLOCKS)


if __name__ == "__main__":
    unittest.main()
