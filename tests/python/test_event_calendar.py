import unittest
from datetime import date

import event_calendar as ec


def companyfacts(rows):
    """Raw SEC companyfacts with one Revenues series of (start, end, filed, form) rows."""
    return {"facts": {"us-gaap": {"Revenues": {"units": {"USD": [
        {"start": start, "end": end, "filed": filed, "form": form, "val": 100.0}
        for start, end, filed, form in rows]}}}}}


# A calendar-quarter filer that files about four weeks after each quarter closes.
QUARTERLY = companyfacts([
    ("2025-01-01", "2025-03-31", "2025-04-25", "10-Q"),
    ("2025-04-01", "2025-06-30", "2025-07-28", "10-Q"),
    ("2025-07-01", "2025-09-30", "2025-10-27", "10-Q"),
    ("2025-10-01", "2025-12-31", "2026-01-29", "10-K"),
])
RESULTS_8K = {"form": "8-K", "filing_date": "2026-04-20", "items": "2.02,9.01"}


class LiveEventRiskTests(unittest.TestCase):
    def test_upcoming_window_is_projected_from_the_issuer_cadence(self):
        risk = ec.live_event_risk(QUARTERLY, date(2026, 3, 1))
        self.assertEqual(risk["pending_period_end"], "2026-03-31")
        self.assertEqual(risk["earnings_window"][0], "2026-04-14")
        self.assertFalse(risk["imminent"])
        self.assertIsNone(risk["results_announced"])
        self.assertNotIn("falls_inside_horizon", risk)

    def test_a_window_inside_three_weeks_is_imminent(self):
        risk = ec.live_event_risk(QUARTERLY, date(2026, 4, 5))
        self.assertTrue(risk["imminent"])
        self.assertIn("IMMINENT", ec.describe_event_risk(risk))

    def test_an_earnings_8k_moves_the_window_to_the_next_quarter(self):
        # Announced 2026-04-20 but the 10-Q is not filed yet, so the SEC facts still show
        # Q1 as outstanding. Without the 8-K this reads as an imminent event that is over.
        today = date(2026, 4, 22)
        self.assertTrue(ec.live_event_risk(QUARTERLY, today)["imminent"])
        risk = ec.live_event_risk(QUARTERLY, today, [RESULTS_8K])
        self.assertEqual(risk["results_announced"],
                         {"period_end": "2026-03-31", "announced": "2026-04-20"})
        self.assertEqual(risk["pending_period_end"], "2026-06-30")
        self.assertEqual(risk["earnings_window"][0], "2026-07-14")
        self.assertFalse(risk["imminent"])
        self.assertIn("were released 2026-04-20", ec.describe_event_risk(risk))

    def test_only_a_results_8k_filed_after_the_period_counts(self):
        today = date(2026, 4, 22)
        other = [{"form": "8-K", "filing_date": "2026-04-20", "items": "5.02"},
                 {"form": "8-K", "filing_date": "2026-03-15", "items": "2.02"},
                 {"form": "8-K", "filing_date": "2026-04-20", "items": "12.02"}]
        self.assertIsNone(ec.live_event_risk(QUARTERLY, today, other)["results_announced"])

    def test_a_fast_filer_window_opens_no_later_than_its_fastest_filing(self):
        # ORCL-shaped: 10-Q eleven days after quarter end. A fixed 14-day floor opened the
        # window after the filing and collapsed it to one day.
        fast = companyfacts([
            ("2025-06-01", "2025-08-31", "2025-09-11", "10-Q"),
            ("2025-09-01", "2025-11-30", "2025-12-11", "10-Q"),
            ("2025-12-01", "2026-02-28", "2026-03-11", "10-Q"),
            ("2025-06-01", "2026-05-31", "2026-06-20", "10-K"),
        ])
        risk = ec.live_event_risk(fast, date(2026, 7, 1))
        start, end = risk["earnings_window"]
        self.assertLess(start, end)
        self.assertLessEqual(start, risk["expected_filing_window"][0])

    def test_a_window_passed_without_a_results_8k_reads_as_overdue(self):
        risk = ec.live_event_risk(QUARTERLY, date(2026, 5, 10))
        self.assertTrue(risk["imminent"])
        self.assertIn("results may land any day", ec.describe_event_risk(risk))

    def test_thin_history_degrades_to_none(self):
        self.assertIsNone(ec.live_event_risk({}, date(2026, 4, 1)))
        self.assertIsNone(ec.live_event_risk(None, date(2026, 4, 1)))
        self.assertIn("not estimable", ec.describe_event_risk(None))


if __name__ == "__main__":
    unittest.main()
