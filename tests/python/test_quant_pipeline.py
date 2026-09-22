"""Regression coverage for the audit, with external providers replaced by fixtures."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import pandas as pd
from support import install_yahooquery_stub
install_yahooquery_stub()
import scraperFinal as scraper
import screener
from quant_utils import wilder_rsi


def history(n=300):
    c = 100 * np.cumprod(1 + np.resize([.01, -.006, .003, -.002], n))
    return pd.DataFrame(dict(Open=c-.2,High=c+1,Low=c-1,Close=c,adjclose=c*.9,
                             Volume=np.full(n, 1e6)),index=pd.bdate_range('2024-01-01',periods=n))


def statement(**fields):
    return pd.DataFrame([dict(asOfDate=f'{year}-12-31',periodType='12M',currencyCode='USD',
                             **{k:v*1.1**(year-2022) for k,v in fields.items()}) for year in (2025,2024,2023,2022)])


class YahooFixture:
    def __init__(self, symbol): self.symbol=symbol
    asset_profile = dict(longName='Fixture',sector='Technology',industry='Software')
    price_mod = dict(regularMarketPrice=999,marketCap=2e12,currency='USD')
    financial_data = dict(freeCashflow=100e9,totalRevenue=400e9,financialCurrency='USD',debtToEquity=125,currentRatio=0)
    key_stats = dict(shortPercentOfFloat=0,pegRatio=-.5)
    summary_detail = {}
    calendar_events = {}
    earnings_trend = {'trend':[{'period':'+1q','endDate':'2026-09-30','epsTrend':{'current':2.2,'30daysAgo':2.0},'epsRevisions':{'upLast30days':3}}]}
    def history(self, **kwargs):
        frame=history()
        if self.symbol=='^IRX': frame['Close']=5
        return frame
    def income_stmt(self): return statement(TotalRevenue=300e9,NetIncome=60e9)
    def cashflow_stmt(self): return statement(OperatingCashFlow=90e9)
    def earnings_hist(self): return pd.DataFrame([dict(quarter='2025-12-31',epsEstimate=0,epsActual=1)])
    def option_data(self, _price): return dict(chains=[],available_expirations=[],iv_summary={})


class PipelineRegressionTests(unittest.TestCase):
    def test_complete_analyzer_payload_preserves_units_dates_and_missing_values(self):
        with patch.object(scraper,'YQData',YahooFixture), patch.object(scraper,'resolve_query',return_value=('AAA',None)), \
             patch.object(scraper,'get_cik_from_ticker',return_value=None), \
             patch.object(scraper,'fetch_finnhub_bundle',return_value={}), \
             patch.object(scraper,'fetch_fmp_data',return_value=None), \
             patch.object(scraper,'fetch_intraday_data',return_value={}), contextlib.redirect_stderr(io.StringIO()):
            payload=scraper.generate_analysis_payload('AAA')
        json.dumps(payload,allow_nan=False)
        raw=payload['raw_data']
        self.assertEqual(raw['valuation']['fcf_yield'],.05)
        self.assertEqual(raw['profitability']['fcf_margin'],.25)
        self.assertAlmostEqual(raw['financial_health']['earnings_quality'],1.5)
        self.assertEqual(raw['financial_health']['debt_to_equity'],1.25)
        self.assertEqual(raw['financial_health']['current_ratio'],0)
        self.assertIsNone(raw['earnings_surprises'][0]['surprise_pct'])
        self.assertAlmostEqual(raw['risk_return']['cagr'], (history().adjclose.iloc[-1]/history().adjclose.iloc[0])**(365.25/(history().index[-1]-history().index[0]).days)-1)
        self.assertAlmostEqual(raw['technicals']['rsi_14'],wilder_rsi(history().Close).iloc[-1])
        self.assertAlmostEqual(payload['yahoo_evidence']['estimate_trends'][0]['eps_revision_30d_fraction'],.1)
        self.assertNotIn('FUNDAMENTAL VALUE',payload['ai_prompt'])
        # The Trade Idea section used to demand "one actionable options structure using
        # ONLY strikes/expirations from §13", and §13 carries the two nearest expirations.
        # That made every recommendation expire inside a month regardless of the visitor's
        # MySquall holding period, which defaults to one-to-three years. The section must
        # name a holding period and must not mandate options on its own.
        idea=payload['ai_prompt'].split('## Trade Idea')[1]
        self.assertIn('holding period',idea)
        self.assertIn('shares trade',idea)
        self.assertIn('unverified quote timestamps',idea)
        self.assertNotIn('One actionable options structure',idea)

    def test_annual_statement_matching_excludes_ttm_and_currency_mismatch(self):
        inc=statement(TotalRevenue=100,NetIncome=10)
        cash=statement(OperatingCashFlow=15)
        inc=pd.concat([pd.DataFrame([dict(asOfDate='2026-06-30',periodType='TTM',currencyCode='USD',TotalRevenue=999,NetIncome=999)]),inc])
        self.assertEqual(scraper.statement_rows(inc,'TotalRevenue')[0]['end'],'2025-12-31')
        self.assertEqual(scraper.matched_cash_income(cash,inc)[2],'2025-12-31')
        cash['currencyCode']='EUR'
        self.assertEqual(scraper.matched_cash_income(cash,inc),(None,None,None))

    def test_short_history_never_claims_year_return_or_200_day_average(self):
        row=screener.history_features(history(65))
        self.assertIsNone(row['return_1y']);self.assertIsNone(row['ma200'])
        self.assertIsNone(row['max_drawdown_1y']);self.assertIsNone(row['scores']['momentum_long'])
        self.assertAlmostEqual(row['rsi14'],wilder_rsi(history(65).Close).iloc[-1])
        json.dumps(row,allow_nan=False)

    def test_missing_and_negative_ratios_cannot_pass_as_value(self):
        for value in (None,-5,0): self.assertTrue(np.isnan(screener.valuation_score(value,40,10)))
        self.assertTrue(np.isnan(screener.debt_score(-10,300,20)))
        self.assertEqual(screener.debt_score(0,300,20),100)
        self.assertEqual(screener.screen([{'scores':{}}],{'concepts':[{'id':'value','required':True}]}),[])

    def test_cache_hit_ranks_only_the_requested_universe(self):
        rows={t:dict(ticker=t,return_60d=r,return_1y=r,scores=dict(uptrend=80,momentum_medium=80,accumulation=80,relative_strength=1)) for t,r in [('AAA',.1),('BBB',.2),('CCC',.3)]}
        with patch.object(screener,'read_cache',return_value=(rows,dict.fromkeys(rows,1))), contextlib.redirect_stderr(io.StringIO()):
            result,cached=screener.build_universe(['BBB','CCC'],{})
        self.assertTrue(cached)
        self.assertEqual([r['scores']['relative_strength'] for r in result],[50,100])
        self.assertEqual(rows['AAA']['scores']['relative_strength'],1)

    def test_build_universe_serializes_missing_fundamentals_and_reranks_merged_rows(self):
        cached={'BBB':dict(ticker='BBB',return_60d=0,return_1y=0,scores=dict(uptrend=50,momentum_medium=50,accumulation=50))}
        with tempfile.TemporaryDirectory() as tmp, patch.object(screener,'CACHE_PATH',Path(tmp)/'cache.json'), \
             patch.object(screener,'read_cache',return_value=(cached,{'BBB':1})), \
             patch.object(screener,'get_history',return_value={'AAA':history()}), \
             patch.object(screener,'get_symbol_modules',return_value={}), contextlib.redirect_stderr(io.StringIO()):
            rows,_=screener.build_universe(['AAA','BBB'],{})
            json.dumps(rows,allow_nan=False)
            self.assertTrue((Path(tmp)/'cache.json').exists())
        self.assertEqual(len(rows),2)
        self.assertIsNone(rows[0]['scores']['value'])
        self.assertEqual(rows[0]['scores']['relative_strength'],100)

    def test_macd_does_not_report_a_new_cross_on_an_existing_uptrend(self):
        frame=history(300)
        frame['Close']=np.arange(100.,400.)
        patterns,_=scraper.detect_chart_patterns(frame,399)
        self.assertFalse(any('MACD' in p and 'CROSSOVER' in p for p in patterns))

    def test_recent_golden_cross_compares_same_dates(self):
        c=np.r_[np.linspace(200,100,220),np.linspace(100,200,40)]
        frame=pd.DataFrame(dict(Open=c,High=c+1,Low=c-1,Close=c,Volume=1e6))
        patterns,_=scraper.detect_chart_patterns(frame,200)
        self.assertTrue(any('GOLDEN CROSS' in p for p in patterns))

    def test_earnings_adapter_uses_yahooquery_property_and_sorts_quarters(self):
        obj=object.__new__(scraper.YQData);obj.sym='AAA'
        class Provider:
            earning_history=pd.DataFrame(dict(quarter=['2024-09-30','2025-03-31'],epsActual=[1,2]))
        obj._yq=Provider()
        self.assertEqual(obj.earnings_hist().iloc[0].epsActual,2)

    def test_options_use_sorted_near_strikes_and_preserve_unknown_volume(self):
        from datetime import datetime
        from types import SimpleNamespace
        rows=[]
        for kind in ('calls','puts'):
            for strike in (120,90,100,110,80):
                rows.append(dict(symbol='AAA',expiration=pd.Timestamp('2026-09-18'),optionType=kind,
                                 strike=strike,bid=1.,ask=2.,lastPrice=1.5,impliedVolatility=.3,
                                 openInterest=10,volume=None))
        provider=SimpleNamespace(option_chain=pd.DataFrame(rows).set_index(['symbol','expiration','optionType']))
        with patch.object(scraper,'TODAY',datetime(2026,9,6,19,30)):
            result=scraper._fetch_options_yq(provider,'AAA',100)
        chain=result['chains'][0]
        self.assertEqual(chain['days_to_exp'],12)
        self.assertEqual([o['strike'] for o in chain['calls']],[100,110,120])
        self.assertEqual([o['strike'] for o in chain['puts']],[80,90,100])
        self.assertIsNone(chain['calls'][0]['volume'])
        self.assertEqual(chain['all_strikes_summary']['put_call_oi_ratio'],1)
