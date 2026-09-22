import unittest
from financial_rules import business_model, quote_evidence
from support import install_yahooquery_stub
install_yahooquery_stub()
import screener


class FinancialRulesTests(unittest.TestCase):
    def test_quotes_reject_zero_crossed_and_nonfinite_pairs(self):
        for bid, ask in [(0, 0), (2, 1), (1, None), (float('nan'), 2)]:
            self.assertIsNone(quote_evidence(bid, ask)['midpoint'])
        valid = quote_evidence(1, 2)
        self.assertEqual(valid['midpoint'], 1.5)
        self.assertEqual(valid['quote_status'], 'indicative_timestamp_unavailable')

    def test_banks_do_not_get_industrial_quality_scores(self):
        bank = screener.apply_financial_model(dict(sector='Financial Services', industry='Banks',
            pe=12, price_to_book=1.2, return_on_equity=.15, return_on_assets=.01,
            scores=dict(quality=100, balance_sheet=100)))
        self.assertIsNone(bank['scores']['quality'])
        self.assertIsNotNone(bank['scores']['value'])
        coverage = {}
        self.assertEqual(screener.screen([bank], {'concepts':[{'id':'quality'}]}, coverage), [])
        self.assertEqual(coverage['not_applicable'], 1)
        self.assertEqual(coverage['failed_criteria'], 0)

    def test_missing_data_is_not_a_failed_criterion(self):
        coverage = {}
        screener.screen([{'scores': {'value': None}}], {'concepts':[{'id':'value'}]}, coverage)
        self.assertEqual(coverage['missing_data'], 1)
        self.assertEqual(coverage['evaluated'], 0)

    def test_peer_ranks_are_sector_specific_and_stable_on_cache_reuse(self):
        rows = [dict(sector='Technology', scores={'value': s}) for s in (20, 40, 60)]
        rows += [dict(sector='Utilities', scores={'value': 99})]
        screener.rank_universe(rows)
        self.assertEqual([r['scores']['value'] for r in rows], [0, 50, 100, None])
        screener.rank_universe(rows)
        self.assertEqual([r['scores']['value'] for r in rows], [0, 50, 100, None])

    def test_reits_require_ffo_and_negative_payout_cannot_score_as_safe(self):
        self.assertEqual(business_model('Real Estate', 'REIT - Retail'), 'reit')
        row = screener.apply_financial_model(dict(sector='Technology', payout_ratio=-.2, scores={'income':100}))
        self.assertIsNone(row['scores']['income'])
