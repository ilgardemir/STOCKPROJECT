import unittest
import numpy as np
import pandas as pd
from quant_utils import annual_cagr, wilder_rsi, risk_statistics, positive_ratio, first_number

class QuantConventionTests(unittest.TestCase):
    def test_rsi_edges_and_warmup(self):
        for values, expected in [(range(100,130),100),(range(130,100,-1),0),([100]*30,50)]:
            result=wilder_rsi(pd.Series(values))
            self.assertTrue(result.iloc[:14].isna().all())
            self.assertEqual(result.iloc[-1],expected)
        self.assertTrue(wilder_rsi(pd.Series([100]*12)).isna().all())

    def test_wilder_reference_seed(self):
        values=[44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00]
        rsi=wilder_rsi(pd.Series(values))
        self.assertAlmostEqual(rsi.iloc[14],70.464135,places=5)
        self.assertAlmostEqual(rsi.iloc[15],66.249619,places=5)

    def test_growth_requires_real_periods(self):
        rows=[{'end':'2025-12-31','val':133.1},{'end':'2024-12-31','val':121},{'end':'2023-12-31','val':110},{'end':'2022-12-31','val':100}]
        self.assertAlmostEqual(annual_cagr(rows,3),.1,places=3)
        self.assertIsNone(annual_cagr(rows,5))
        self.assertIsNone(annual_cagr(rows[:3],3))

    def test_large_values_zero_and_bad_denominators(self):
        self.assertEqual(positive_ratio(100e9,2e12),.05)
        self.assertEqual(first_number(None,0,9),0)
        self.assertIsNone(positive_ratio(10,-1))
        self.assertIsNone(positive_ratio(10,0))

    def test_drawdown_includes_initial_peak(self):
        prices=pd.Series([100.,50.,60.],index=pd.date_range('2024-01-01',periods=3,tz='UTC'))
        self.assertEqual(risk_statistics(prices)['max_drawdown'],-.5)
        self.assertIsNone(risk_statistics(prices)['cagr'])

    def test_sharpe_uses_arithmetic_excess_returns_and_lagged_rates(self):
        dates=pd.bdate_range('2023-01-01',periods=270,tz='UTC')
        r=np.tile([.01,-.007,.004,-.002,.003],54)[:269]
        prices=pd.Series(np.r_[100,100*np.cumprod(1+r)],index=dates)
        yields=pd.Series(.05,index=dates); yields.iloc[-1]=.99
        result=risk_statistics(prices,prices,yields)
        excess=r-.05/252
        self.assertAlmostEqual(result['sharpe'],excess.mean()/excess.std(ddof=1)*np.sqrt(252))
        self.assertAlmostEqual(result['beta'],1)
        self.assertIsNone(risk_statistics(prices)['sharpe'])
