#!/usr/bin/env python3
"""
Squall v2 — Equity analysis scraper
Sources: yahooquery (market data) · SEC EDGAR (filings) · FMP (optional cross-check)
"""

from yahooquery import Ticker as YQTicker
import requests, json, re, sys, os, math
import pandas as pd
import numpy as np
import warnings
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

TODAY     = datetime.now()
TODAY_STR = TODAY.strftime("%B %d, %Y")
TODAY_ISO = TODAY.strftime("%Y-%m-%d")

# ── CONFIG ─────────────────────────────────────────────────────────────────────
USER_AGENT  = os.getenv("SEC_USER_AGENT", "BasementQuantProject ilgardemir2@gmail.com")
SEC_HEADERS = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate", "Host": "data.sec.gov"}
FMP_API_KEY = os.getenv("FMP_API_KEY", "")   # optional; set to enable FMP cross-checks

# ══════════════════════════════════════════════════════════════════════════════
# 1. UTILITIES
# ══════════════════════════════════════════════════════════════════════════════
def safe_divide(num, denom, default=0.0):
    if isinstance(num, (pd.Series, np.ndarray)) or isinstance(denom, (pd.Series, np.ndarray)):
        with np.errstate(divide="ignore", invalid="ignore"):
            res = num / denom
            if isinstance(res, pd.Series):
                return res.replace([np.inf, -np.inf], np.nan).fillna(default)
            return np.nan_to_num(res, nan=default, posinf=default, neginf=default)
    if denom == 0 or pd.isna(denom) or pd.isna(num): return default
    r = num / denom
    return default if math.isinf(r) or math.isnan(r) else r

def is_valid(val, mn=-1e9, mx=1e9):
    if val is None: return False
    try:
        f = float(val)
        return not math.isnan(f) and not math.isinf(f) and mn <= f <= mx
    except: return False

def safe_float(v):
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except: return None

def fmt(val, t="pct"):
    if val is None: return "N/A"
    try:
        v = float(val)
        if math.isnan(v) or math.isinf(v): return "N/A"
    except: return str(val)
    if t == "pct":   return f"{v:.2%}"
    if t == "ratio": return f"{v:.2f}"
    if t == "usd":
        if abs(v) >= 1e12: return f"${v/1e12:.2f}T"
        if abs(v) >= 1e9:  return f"${v/1e9:.2f}B"
        if abs(v) >= 1e6:  return f"${v/1e6:.2f}M"
        return f"${v:,.2f}"
    return str(val)


# ══════════════════════════════════════════════════════════════════════════════
# 2. YAHOOQUERY WRAPPER
# ══════════════════════════════════════════════════════════════════════════════
class YQData:
    """Defensive wrapper around yahooquery Ticker — handles error strings and missing keys."""

    def __init__(self, symbol: str):
        self.sym    = symbol
        self._yq    = YQTicker(symbol)
        self._cache: dict = {}

    # ── module helpers ────────────────────────────────────────────────────────
    def _mod(self, name: str) -> dict:
        if name in self._cache:
            return self._cache[name]
        try:
            raw = getattr(self._yq, name, None)
            if not isinstance(raw, dict):
                self._cache[name] = {}; return {}
            val = raw.get(self.sym) or raw.get(self.sym.upper()) or {}
            result = val if isinstance(val, dict) else {}
        except:
            result = {}
        self._cache[name] = result
        return result

    @property
    def price_mod(self)      -> dict: return self._mod("price")
    @property
    def asset_profile(self)  -> dict: return self._mod("asset_profile")
    @property
    def financial_data(self) -> dict: return self._mod("financial_data")
    @property
    def key_stats(self)      -> dict: return self._mod("key_stats")
    @property
    def summary_detail(self) -> dict: return self._mod("summary_detail")
    @property
    def calendar_events(self)-> dict: return self._mod("calendar_events")

    def get(self, key: str, *sources) -> any:
        """Try a key across multiple module names, return first non-None hit."""
        for src in sources:
            v = self._mod(src).get(key)
            if v is not None and v != "": return v
        return None

    # ── financial DataFrames ──────────────────────────────────────────────────
    def _financial_df(self, raw) -> pd.DataFrame:
        if not isinstance(raw, pd.DataFrame) or raw.empty:
            return pd.DataFrame()
        df = raw
        if hasattr(df.index, "names") and "symbol" in df.index.names:
            for sym in [self.sym, self.sym.upper()]:
                try:  df = raw.xs(sym, level="symbol"); break
                except KeyError: pass
        # Flatten remaining MultiIndex so rows are individual periods
        if hasattr(df.index, "names") and len(df.index.names) > 1:
            df = df.reset_index()
        elif not isinstance(df.index, pd.RangeIndex):
            df = df.reset_index()
        # Sort most-recent first
        for date_col in ("asOfDate", "date", "endDate"):
            if date_col in df.columns:
                df = df.sort_values(date_col, ascending=False)
                break
        return df

    def income_stmt(self, frequency="a") -> pd.DataFrame:
        try:   return self._financial_df(self._yq.income_statement(frequency=frequency))
        except: return pd.DataFrame()

    def cashflow_stmt(self, frequency="a") -> pd.DataFrame:
        try:   return self._financial_df(self._yq.cash_flow(frequency=frequency))
        except: return pd.DataFrame()

    def balance_sheet_stmt(self, frequency="a") -> pd.DataFrame:
        try:   return self._financial_df(self._yq.balance_sheet(frequency=frequency))
        except: return pd.DataFrame()

    # ── price history ─────────────────────────────────────────────────────────
    def history(self, **kwargs) -> pd.DataFrame:
        try:
            h = self._yq.history(**kwargs)
            if not isinstance(h, pd.DataFrame) or h.empty:
                return pd.DataFrame()
            if hasattr(h.index, "names") and "symbol" in h.index.names:
                for sym in [self.sym, self.sym.upper()]:
                    try:  h = h.xs(sym, level="symbol"); break
                    except KeyError: pass
            # Standardise column names to yfinance convention
            col_map = {"open":"Open","high":"High","low":"Low","close":"Close",
                       "volume":"Volume","dividends":"Dividends","splits":"Stock Splits"}
            h = h.rename(columns=col_map)
            return h
        except:
            return pd.DataFrame()

    # ── earnings history ──────────────────────────────────────────────────────
    def earnings_hist(self) -> pd.DataFrame:
        try:
            raw = self._yq.earnings_history
            if not isinstance(raw, pd.DataFrame) or raw.empty:
                return pd.DataFrame()
            if hasattr(raw.index, "names") and "symbol" in raw.index.names:
                for sym in [self.sym, self.sym.upper()]:
                    try:  raw = raw.xs(sym, level="symbol"); break
                    except KeyError: pass
            return raw.reset_index() if not isinstance(raw.index, pd.RangeIndex) else raw
        except:
            return pd.DataFrame()

    # ── options ───────────────────────────────────────────────────────────────
    def option_data(self, current_price: float) -> dict:
        return _fetch_options_yq(self._yq, self.sym, current_price)


def _stmt_val(df: pd.DataFrame, *cols) -> float | None:
    """Return most-recent non-null value from a financial DataFrame."""
    if df is None or df.empty: return None
    for col in cols:
        if col in df.columns:
            s = df[col].dropna()
            if not s.empty: return safe_float(s.iloc[0])
    return None


def _stmt_series(df: pd.DataFrame, *cols, n=5) -> list:
    """Return up to n most-recent values from a column (most-recent first)."""
    if df is None or df.empty: return []
    for col in cols:
        if col in df.columns:
            s = df[col].dropna()
            if not s.empty: return [safe_float(v) for v in s.head(n).tolist()]
    return []


# ══════════════════════════════════════════════════════════════════════════════
# 3. SEC EDGAR  (unchanged from v1)
# ══════════════════════════════════════════════════════════════════════════════
def get_cik_from_ticker(ticker):
    try:
        r = requests.get("https://www.sec.gov/files/company_tickers.json",
                         headers={"User-Agent": USER_AGENT}, timeout=10)
        r.raise_for_status()
        for val in r.json().values():
            if val["ticker"].lower() == ticker.lower():
                return str(val["cik_str"]).zfill(10)
        return None
    except: return None

def get_company_facts(cik):
    try:
        r = requests.get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
                         headers=SEC_HEADERS, timeout=15)
        r.raise_for_status()
        return r.json()
    except: return None

def get_recent_filings(cik, limit=50):
    try:
        r = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json",
                         headers={"User-Agent": USER_AGENT}, timeout=10)
        r.raise_for_status()
        recent = r.json().get("filings", {}).get("recent", {})
        pdocs  = recent.get("primaryDocument", [])
        return [{"form": recent["form"][i], "filing_date": recent["filingDate"][i],
                 "accession_number": recent["accessionNumber"][i],
                 "primary_document": pdocs[i] if i < len(pdocs) else None}
                for i in range(min(limit, len(recent.get("accessionNumber", []))))]
    except: return []

def extract_mda_text(cik, accession_number):
    try:
        clean_acc = accession_number.replace("-", "")
        url = (f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
               f"{clean_acc}/{accession_number}.txt")
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
        r.raise_for_status()
        match = re.search(
            r"(?:ITEM\s+7\.|ITEM\s+2\.)\s*MANAGEMENT[\s\S]*?DISCUSSION AND ANALYSIS.*?(?=ITEM\s+\d+\.)",
            r.text, re.IGNORECASE)
        if match:
            clean = re.sub(r"<[^>]+>", " ", match.group(0))
            return re.sub(r"\s+", " ", clean).strip()[:3000]
        return "MD&A section not found."
    except: return "Failed to fetch MD&A."

def parse_8k_items(cik, accession_number):
    try:
        clean_acc = accession_number.replace("-", "")
        url = (f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
               f"{clean_acc}/{accession_number}.txt")
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
        items = re.findall(r"ITEM\s+(\d+\.\d+|\d+)\.", r.text, re.IGNORECASE)
        meanings = {
            "1.01":"Material Definitive Agreement","2.01":"Acquisition/Disposition of Assets",
            "2.02":"Results of Operations (Earnings Release)","2.06":"Material Impairment",
            "3.01":"Delisting Notice","4.01":"Change in Accountant",
            "5.02":"Departure/Appointment of Officers or Directors","8.01":"Other Material Events"
        }
        return list(set([meanings.get(i, f"Item {i}") for i in items]))
    except: return []

def analyze_form4(cik, accession_number):
    try:
        clean_acc = accession_number.replace("-", "")
        url = (f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
               f"{clean_acc}/{accession_number}.txt")
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
        codes = re.findall(r"<transactionCode>\s*([PS])\s*</transactionCode>", r.text)
        return {"buys": codes.count("P"), "sells": codes.count("S")}
    except: return {"buys": 0, "sells": 0}

def safe_extract_sec(facts, namespace, concept):
    try:
        if namespace not in facts["facts"] or concept not in facts["facts"][namespace]:
            return None, []
        units    = facts["facts"][namespace][concept]["units"]
        unit_key = "USD" if "USD" in units else (list(units.keys())[0] if units else None)
        if not unit_key: return None, []
        annual = sorted([x for x in units[unit_key] if x.get("form") == "10-K"],
                        key=lambda x: x.get("end", ""), reverse=True)
        if not annual: return None, []
        return annual[0].get("val"), [x.get("val") for x in annual[:5]]
    except: return None, []

def download_latest_filing(cik, filings, ticker, out_dir="/mnt/user-data/outputs"):
    if not filings: return None
    target = next((f for f in filings if f["form"] == "10-K"), None) or filings[0]
    if not target.get("primary_document"):
        return {"form": target["form"], "filing_date": target["filing_date"], "error": "No primary document listed."}
    try:
        acc_nodash = target["accession_number"].replace("-", "")
        url = (f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
               f"{acc_nodash}/{target['primary_document']}")
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
        r.raise_for_status()
        ext = target["primary_document"].split(".")[-1] if "." in target["primary_document"] else "htm"
        safe_form = target["form"].replace(" ", "").replace("/", "-")
        filename  = f"{ticker}_{safe_form}_{target['filing_date']}.{ext}"
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, filename)
        with open(out_path, "wb") as fh: fh.write(r.content)
        return {"form": target["form"], "filing_date": target["filing_date"],
                "accession_number": target["accession_number"], "source_url": url,
                "local_path": out_path, "filename": filename, "size_bytes": len(r.content)}
    except Exception as e:
        return {"form": target["form"], "filing_date": target["filing_date"], "error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
# 4. FINANCIAL MODELING PREP (optional)
# ══════════════════════════════════════════════════════════════════════════════
def fetch_fmp_data(ticker: str) -> dict | None:
    """Fetch TTM metrics + latest annual income from FMP (needs FMP_API_KEY env var)."""
    if not FMP_API_KEY:
        return None
    base = "https://financialmodelingprep.com/api/v3"
    try:
        m  = requests.get(f"{base}/key-metrics-ttm/{ticker}?apikey={FMP_API_KEY}", timeout=6)
        ic = requests.get(f"{base}/income-statement/{ticker}?limit=1&apikey={FMP_API_KEY}", timeout=6)
        cf = requests.get(f"{base}/cash-flow-statement/{ticker}?limit=1&apikey={FMP_API_KEY}", timeout=6)
        metrics = m.json()[0]  if m.status_code == 200 and m.json() else {}
        income  = ic.json()[0] if ic.status_code == 200 and ic.json() else {}
        cashflow= cf.json()[0] if cf.status_code == 200 and cf.json() else {}
        if not metrics and not income:
            return None
        return {"metrics": metrics, "income": income, "cashflow": cashflow}
    except:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# 5. OPTIONS CHAIN
# ══════════════════════════════════════════════════════════════════════════════
def _fetch_options_yq(yq_ticker, ticker_sym: str, current_price: float) -> dict:
    """Fetches the live options chain via yahooquery — 2 near expirations, 3 strikes each."""
    result = {"available_expirations": [], "chains": [], "iv_summary": {}}
    try:
        chain_raw = yq_ticker.option_chain
        if isinstance(chain_raw, str) or not isinstance(chain_raw, pd.DataFrame) or chain_raw.empty:
            return result

        idx = chain_raw.index

        # Collect expiration dates from the index (level 1 of MultiIndex)
        if idx.nlevels >= 2:
            exps_raw = sorted(idx.get_level_values(1).unique())
        elif "expiration" in chain_raw.columns:
            exps_raw = sorted(chain_raw["expiration"].unique())
        else:
            return result

        future_exps = []
        for e in exps_raw:
            try:
                exp_dt = pd.Timestamp(e).to_pydatetime() if not isinstance(e, datetime) else e
                exp_dt = exp_dt.replace(tzinfo=None)
                if exp_dt > TODAY:
                    future_exps.append(exp_dt.strftime("%Y-%m-%d"))
            except: continue

        result["available_expirations"] = future_exps[:8]

        for exp_str in future_exps[:2]:   # Only 2 expirations for token efficiency
            try:
                days_out = (datetime.strptime(exp_str, "%Y-%m-%d") - TODAY).days
                calls_df = puts_df = None

                # Try slicing by (symbol, expiration, optionType)
                for sym_key in [ticker_sym, ticker_sym.upper()]:
                    for exp_key in [exp_str, pd.Timestamp(exp_str)]:
                        for call_label in ["calls", "CALL", "call"]:
                            try:
                                calls_df = chain_raw.xs((sym_key, exp_key, call_label), level=[0,1,2]).reset_index(drop=True)
                                break
                            except: pass
                        for put_label in ["puts", "PUT", "put"]:
                            try:
                                puts_df = chain_raw.xs((sym_key, exp_key, put_label), level=[0,1,2]).reset_index(drop=True)
                                break
                            except: pass
                        if calls_df is not None: break
                    if calls_df is not None: break

                # Fallback: filter by columns if xs failed
                if calls_df is None and "optionType" in chain_raw.columns and "expiration" in chain_raw.columns:
                    mask = chain_raw["expiration"].astype(str).str[:10] == exp_str
                    calls_df = chain_raw[mask & chain_raw["optionType"].str.lower().isin(["calls","call"])].reset_index(drop=True)
                    puts_df  = chain_raw[mask & chain_raw["optionType"].str.lower().isin(["puts","put"])].reset_index(drop=True)

                if calls_df is None or calls_df.empty or "strike" not in calls_df.columns:
                    continue

                calls_df["dist"] = abs(calls_df["strike"] - current_price)
                atm_idx    = calls_df["dist"].idxmin()
                atm_strike = float(calls_df.loc[atm_idx, "strike"])
                otm_calls  = calls_df[calls_df["strike"] >= atm_strike].head(3)
                otm_puts   = puts_df[puts_df["strike"] <= atm_strike].tail(3) if puts_df is not None and not puts_df.empty and "strike" in puts_df.columns else pd.DataFrame()

                def row_to_opt(r):
                    return {"strike": safe_float(r.get("strike")), "bid": safe_float(r.get("bid")),
                            "ask": safe_float(r.get("ask")), "iv": safe_float(r.get("impliedVolatility")),
                            "open_interest": int(r.get("openInterest", 0) or 0),
                            "volume": int(r.get("volume", 0) or 0),
                            "in_the_money": bool(r.get("inTheMoney", False))}

                chain_data = {"expiration": exp_str, "days_to_exp": days_out,
                              "atm_strike": atm_strike,
                              "calls": [row_to_opt(r) for _, r in otm_calls.iterrows()],
                              "puts":  [row_to_opt(r) for _, r in otm_puts.iterrows()]}
                result["chains"].append(chain_data)

                atm_iv = safe_float(calls_df.loc[atm_idx, "impliedVolatility"])
                if atm_iv: result["iv_summary"][exp_str] = atm_iv

            except: continue

    except: pass
    return result


# ══════════════════════════════════════════════════════════════════════════════
# 6. PRICE HISTORY SERIALISER
# ══════════════════════════════════════════════════════════════════════════════
def get_price_history_series(hist: pd.DataFrame, days: int = 1260) -> list:
    """Returns trailing `days` of daily OHLCV (oldest first) for charting."""
    if hist is None or hist.empty: return []
    recent = hist.tail(days)
    out = []
    for idx, row in recent.iterrows():
        dt = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)[:10]
        out.append({"date": dt, "open": safe_float(row.get("Open")),
                    "high": safe_float(row.get("High")), "low": safe_float(row.get("Low")),
                    "close": safe_float(row.get("Close")),
                    "volume": int(row.get("Volume", 0) or 0)})
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 7. CHART PATTERN DETECTION  (logic unchanged from v1)
# ══════════════════════════════════════════════════════════════════════════════
def detect_chart_patterns(hist: pd.DataFrame, current_price: float):
    patterns, key_levels = [], {}
    if hist.empty or len(hist) < 50: return patterns, key_levels

    close  = hist["Close"]; high = hist["High"]; low = hist["Low"]; volume = hist["Volume"]
    ma20   = close.rolling(20).mean(); ma50 = close.rolling(50).mean(); ma200 = close.rolling(200).mean()

    if len(ma50.dropna()) > 30 and len(ma200.dropna()) > 30:
        a50 = ma50.dropna().values; a200 = ma200.dropna().values
        n = min(len(a50), len(a200))
        for i in range(max(1, n-20), n):
            if a50[i] > a200[i] and a50[i-1] <= a200[i-1]:
                patterns.append("GOLDEN CROSS: 50MA crossed above 200MA recently."); break
            if a50[i] < a200[i] and a50[i-1] >= a200[i-1]:
                patterns.append("DEATH CROSS: 50MA crossed below 200MA recently."); break

    bb_mid = close.rolling(20).mean(); bb_std = close.rolling(20).std()
    bb_up  = bb_mid + 2*bb_std;        bb_lo  = bb_mid - 2*bb_std
    bb_w   = safe_divide(bb_up.iloc[-1] - bb_lo.iloc[-1], bb_mid.iloc[-1])
    if current_price >= bb_up.iloc[-1]*0.99:  patterns.append("BB UPPER TOUCH: Price at/above upper Bollinger Band.")
    elif current_price <= bb_lo.iloc[-1]*1.01: patterns.append("BB LOWER TOUCH: Price at/below lower Bollinger Band.")
    if bb_w < 0.05:   patterns.append("BB SQUEEZE: Bands extremely tight — big move imminent.")
    elif bb_w > 0.20: patterns.append("BB EXPANSION: Very wide bands — high volatility regime.")
    key_levels["bb_upper"] = safe_float(bb_up.iloc[-1])
    key_levels["bb_lower"] = safe_float(bb_lo.iloc[-1])
    key_levels["bb_width_pct"] = safe_float(bb_w)

    ema12 = close.ewm(span=12, adjust=False).mean(); ema26 = close.ewm(span=26, adjust=False).mean()
    macd  = ema12 - ema26; sig = macd.ewm(span=9, adjust=False).mean(); hist_m = macd - sig
    mv, sv, hv = safe_float(macd.iloc[-1]), safe_float(sig.iloc[-1]), safe_float(hist_m.iloc[-1])
    if mv and sv:
        if mv > sv and hist_m.iloc[-2] <= sig.iloc[-2]:   patterns.append("MACD BULLISH CROSSOVER: MACD just crossed above signal line.")
        elif mv < sv and hist_m.iloc[-2] >= sig.iloc[-2]: patterns.append("MACD BEARISH CROSSOVER: MACD just crossed below signal line.")
        elif mv > 0 and sv > 0: patterns.append("MACD BULLISH: Both MACD and signal above zero.")
        elif mv < 0 and sv < 0: patterns.append("MACD BEARISH: Both MACD and signal below zero.")
    key_levels["macd"] = mv; key_levels["macd_signal"] = sv; key_levels["macd_hist"] = hv

    lookback = min(252, len(hist)); r = hist.tail(lookback)
    local_highs, local_lows = [], []
    window = 10
    for i in range(window, len(r)-window):
        if r["High"].iloc[i] == r["High"].iloc[i-window:i+window+1].max(): local_highs.append(float(r["High"].iloc[i]))
        if r["Low"].iloc[i]  == r["Low"].iloc[i-window:i+window+1].min():  local_lows.append(float(r["Low"].iloc[i]))

    def cluster(levels, tol=0.01):
        if not levels: return []
        levels = sorted(levels); clusters = []; g = [levels[0]]
        for l in levels[1:]:
            if (l - g[0])/g[0] <= tol: g.append(l)
            else: clusters.append(sum(g)/len(g)); g = [l]
        clusters.append(sum(g)/len(g)); return clusters

    key_levels["resistance"] = sorted([r for r in cluster(local_highs) if r > current_price])[:3]
    key_levels["support"]    = sorted([s for s in cluster(local_lows)  if s < current_price], reverse=True)[:3]

    for r in key_levels["resistance"][:2]:
        if abs(current_price-r)/r < 0.02: patterns.append(f"AT RESISTANCE: Price within 2% of {fmt(r,'usd')}.")
    for s in key_levels["support"][:2]:
        if abs(current_price-s)/s < 0.02: patterns.append(f"AT SUPPORT: Price within 2% of {fmt(s,'usd')}.")

    if len(close) >= 60:
        rc = close.tail(60).values; x = np.arange(len(rc))
        slope, _ = np.polyfit(x, rc, 1)
        sp = slope / rc[0] * 100
        if sp > 0.15: patterns.append(f"STRONG UPTREND: 60-day slope +{sp:.2f}%/day.")
        elif sp > 0.05: patterns.append(f"MILD UPTREND: 60-day slope +{sp:.2f}%/day.")
        elif sp < -0.15: patterns.append(f"STRONG DOWNTREND: 60-day slope {sp:.2f}%/day.")
        elif sp < -0.05: patterns.append(f"MILD DOWNTREND: 60-day slope {sp:.2f}%/day.")
        else: patterns.append(f"SIDEWAYS: 60-day slope flat ({sp:.2f}%/day).")
        key_levels["trend_slope_daily_pct"] = safe_float(sp)

    if len(local_highs) >= 2:
        rh = sorted(local_highs, reverse=True)[:5]
        for i in range(len(rh)-1):
            if abs(rh[i]-rh[i+1])/rh[i] < 0.03 and rh[i] > current_price*1.01:
                patterns.append(f"DOUBLE TOP: Two peaks near {fmt(rh[i],'usd')} — potential reversal."); break
    if len(local_lows) >= 2:
        rl = sorted(local_lows)[:5]
        for i in range(len(rl)-1):
            if abs(rl[i]-rl[i+1])/(rl[i]+0.01) < 0.03 and rl[i] < current_price*0.99:
                patterns.append(f"DOUBLE BOTTOM: Two troughs near {fmt(rl[i],'usd')} — potential support base."); break

    if len(volume) > 20:
        avg_v = volume.tail(20).mean(); last_v = volume.iloc[-1]
        vr    = safe_divide(last_v, avg_v)
        if vr > 2.5:  patterns.append(f"VOLUME SURGE: {vr:.1f}x 20-day avg — possible institutional activity.")
        elif vr < 0.4: patterns.append(f"LOW VOLUME: {vr:.1f}x 20-day avg — weak conviction.")

    if len(close) >= 40:
        l40   = close.tail(40)
        rng_p = (l40.max() - l40.min()) / l40.min()
        if rng_p < 0.08 and close.iloc[-1] > ma50.iloc[-1]:
            patterns.append(f"BASE FORMATION: Tight 40-day range ({rng_p:.1%}) above 50MA — breakout setup.")

    return patterns, key_levels


# ══════════════════════════════════════════════════════════════════════════════
# 8. PRICE ACTION & INSTITUTIONAL FOOTPRINT  (unchanged logic)
# ══════════════════════════════════════════════════════════════════════════════
def find_swings(series, left=5, right=5):
    highs, lows, n = [], [], len(series)
    for i in range(left, n-right):
        win = series[i-left:i+right+1]
        if series[i] == max(win) and list(win).count(series[i]) == 1: highs.append((i, float(series[i])))
        if series[i] == min(win) and list(win).count(series[i]) == 1: lows.append((i, float(series[i])))
    return highs, lows

def analyze_price_action(hist: pd.DataFrame, current_price: float) -> dict:
    out = {"trend":"INSUFFICIENT DATA","trend_basis":"","structure":[],"recent_swing_high":None,
           "recent_swing_low":None,"events":[],"fib":{}}
    if hist is None or hist.empty or len(hist) < 60: return out
    sh = find_swings(hist["High"].values, 8, 8)[0]
    sl = find_swings(hist["Low"].values, 8, 8)[1]
    last_highs = [p for _, p in sh[-4:]]; last_lows  = [p for _, p in sl[-4:]]
    out["recent_swing_high"] = safe_float(last_highs[-1]) if last_highs else None
    out["recent_swing_low"]  = safe_float(last_lows[-1])  if last_lows  else None

    def rising(seq):
        if len(seq) < 2: return None
        half = max(1, len(seq)//2); e, l = seq[:half], seq[half:]
        return (sum(l)/len(l)) > (sum(e)/len(e))*1.005
    def falling(seq):
        if len(seq) < 2: return None
        half = max(1, len(seq)//2); e, l = seq[:half], seq[half:]
        return (sum(l)/len(l)) < (sum(e)/len(e))*0.995

    hh, hl = rising(last_highs), rising(last_lows)
    lh, ll = falling(last_highs), falling(last_lows)
    if hh and hl:   out["trend"] = "UPTREND";   out["trend_basis"] = "HH + HL — bullish structure."
    elif lh and ll: out["trend"] = "DOWNTREND";  out["trend_basis"] = "LH + LL — bearish structure."
    elif (hh and ll) or (lh and hl): out["trend"] = "RANGE / TRANSITION"; out["trend_basis"] = "Mixed swings — consolidation."
    else:           out["trend"] = "RANGE";      out["trend_basis"] = "No directional swing sequence."

    out["structure"] = ([{"type":"swing_high","price":safe_float(p)} for p in last_highs[-3:]] +
                        [{"type":"swing_low", "price":safe_float(p)} for p in last_lows[-3:]])
    if last_highs and current_price > last_highs[-1]*1.001: out["events"].append(f"BOS (bullish): cleared prior swing high at {fmt(last_highs[-1],'usd')}.")
    if last_lows  and current_price < last_lows[-1]*0.999:  out["events"].append(f"BOS (bearish): broke prior swing low at {fmt(last_lows[-1],'usd')}.")
    if out["trend"] == "DOWNTREND" and last_highs and current_price > last_highs[-1]: out["events"].append("CHoCH: first bullish break inside downtrend.")
    if out["trend"] == "UPTREND"   and last_lows  and current_price < last_lows[-1]:  out["events"].append("CHoCH: first bearish break inside uptrend.")

    if out["recent_swing_high"] and out["recent_swing_low"]:
        hi, lo = out["recent_swing_high"], out["recent_swing_low"]
        if hi > lo:
            diff = hi - lo
            out["fib"] = {k: safe_float(hi - diff*r) for k, r in
                          {"0.0":0,"0.236":0.236,"0.382":0.382,"0.5":0.5,"0.618":0.618,"0.786":0.786,"1.0":1.0}.items()}
            out["fib_high"] = safe_float(hi); out["fib_low"] = safe_float(lo)
    return out

def analyze_institutional(hist: pd.DataFrame) -> dict:
    out = {"signals":[],"obv_trend":None,"up_vol_ratio":None,
           "accumulation_days":0,"distribution_days":0,"net_bias":"NEUTRAL"}
    if hist is None or hist.empty or len(hist) < 40: return out
    close = hist["Close"]; vol = hist["Volume"]; ret = close.diff()
    obv   = (np.sign(ret).fillna(0) * vol).cumsum()
    recent_obv = obv.tail(30)
    if len(recent_obv) > 5:
        slope = np.polyfit(np.arange(len(recent_obv)), recent_obv.values, 1)[0]
        out["obv_trend"] = "RISING" if slope > 0 else "FALLING"
    last20 = hist.tail(20)
    up_v = last20.loc[last20["Close"] >= last20["Open"], "Volume"].sum()
    dn_v = last20.loc[last20["Close"] <  last20["Open"], "Volume"].sum()
    if (up_v+dn_v) > 0: out["up_vol_ratio"] = safe_float(up_v/(up_v+dn_v))
    avg_vol  = vol.tail(50).mean()
    rng      = (hist["High"] - hist["Low"]).replace(0, np.nan)
    close_pos= (close - hist["Low"]) / rng
    for i in range(max(0, len(hist)-25), len(hist)):
        if vol.iloc[i] > 1.4*avg_vol:
            if close_pos.iloc[i] > 0.66 and ret.iloc[i] > 0: out["accumulation_days"] += 1
            elif close_pos.iloc[i] < 0.34 and ret.iloc[i] < 0: out["distribution_days"] += 1
    if out["obv_trend"] == "RISING":  out["signals"].append("OBV RISING: cumulative volume flow positive.")
    elif out["obv_trend"] == "FALLING": out["signals"].append("OBV FALLING: cumulative volume flow negative.")
    if is_valid(out["up_vol_ratio"]) and out["up_vol_ratio"] > 0.62: out["signals"].append(f"UP-VOL DOMINANCE: {out['up_vol_ratio']:.0%} of 20D volume on up days.")
    elif is_valid(out["up_vol_ratio"]) and out["up_vol_ratio"] < 0.40: out["signals"].append(f"DOWN-VOL DOMINANCE: {out['up_vol_ratio']:.0%} of 20D volume on up days.")
    if out["accumulation_days"] >= 3: out["signals"].append(f"ACCUMULATION: {out['accumulation_days']} high-vol up-closes in 25 sessions.")
    if out["distribution_days"] >= 3: out["signals"].append(f"DISTRIBUTION: {out['distribution_days']} high-vol down-closes in 25 sessions.")
    acc, dist = out["accumulation_days"], out["distribution_days"]
    if out["obv_trend"] == "RISING"  and acc >= dist: out["net_bias"] = "ACCUMULATION"
    if out["obv_trend"] == "FALLING" and dist >= acc: out["net_bias"] = "DISTRIBUTION"
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 9. INTRADAY DATA
# ══════════════════════════════════════════════════════════════════════════════
def fetch_intraday_data(yqdata: YQData) -> pd.DataFrame:
    for period, interval in [("5d","5m"), ("1mo","15m"), ("1mo","30m")]:
        try:
            h = yqdata.history(period=period, interval=interval)
            if not h.empty and len(h) >= 50:
                h.attrs["interval"] = interval; h.attrs["period"] = period
                return h
        except: continue
    return pd.DataFrame()


# ══════════════════════════════════════════════════════════════════════════════
# 10. MAIN ENGINE
# ══════════════════════════════════════════════════════════════════════════════
def generate_analysis_payload(ticker: str) -> dict:
    def stage(k: int, label: str):
        print(f"STAGE|{k}|7|{label}", file=sys.stderr, flush=True)

    # ── STAGE 1: SEC EDGAR ───────────────────────────────────────────────────
    stage(1, "Querying SEC EDGAR filings")
    cik           = get_cik_from_ticker(ticker)
    sec_available = cik is not None
    facts = None; filings = []; mda_text = "SEC data unavailable."
    sec_rev_val = sec_ni_val = sec_assets_val = sec_liab_val = sec_equity_val = sec_ocf_val = sec_rev_cagr = None
    filing_signals = {"8k_events": [], "insider_buys": 0, "insider_sells": 0, "activist_13d": False}
    company_name = ticker

    if sec_available:
        facts   = get_company_facts(cik)
        filings = get_recent_filings(cik, limit=50)
        company_name = (facts or {}).get("entityName", ticker)

        def sec_val(ns, concept):
            return safe_extract_sec(facts, ns, concept) if facts else (None, [])

        sec_rev_val, sec_rev_hist = sec_val("us-gaap", "Revenues")
        if sec_rev_val is None: sec_rev_val, sec_rev_hist = sec_val("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax")
        sec_ni_val,     _  = sec_val("us-gaap", "NetIncomeLoss")
        sec_assets_val, _  = sec_val("us-gaap", "Assets")
        sec_liab_val,   _  = sec_val("us-gaap", "Liabilities")
        sec_equity_val, _  = sec_val("us-gaap", "StockholdersEquity")
        sec_ocf_val,    _  = sec_val("us-gaap", "NetCashProvidedByUsedInOperatingActivities")

        if len(sec_rev_hist) >= 3 and sec_rev_hist[2] and sec_rev_hist[2] > 0:
            try: sec_rev_cagr = ((sec_rev_hist[0] / sec_rev_hist[2]) ** 0.5) - 1
            except: pass

        latest_10k = next((f["accession_number"] for f in filings if f["form"] == "10-K"), None)
        if latest_10k: mda_text = extract_mda_text(cik, latest_10k)

        cutoff = TODAY - timedelta(days=90)
        for f in filings:
            try:
                if datetime.strptime(f["filing_date"], "%Y-%m-%d") >= cutoff:
                    if f["form"] == "8-K":
                        filing_signals["8k_events"].extend(parse_8k_items(cik, f["accession_number"]))
                    elif f["form"] == "4":
                        tx = analyze_form4(cik, f["accession_number"])
                        filing_signals["insider_buys"]  += tx["buys"]
                        filing_signals["insider_sells"] += tx["sells"]
                    elif f["form"] in ["SC 13D", "SC 13D/A"]:
                        filing_signals["activist_13d"] = True
            except: continue
        filing_signals["8k_events"] = list(set(filing_signals["8k_events"]))

    # ── STAGE 2: Download latest filing ──────────────────────────────────────
    sec_filing_attachment = None
    if sec_available and filings:
        stage(2, "Downloading latest 10-K")
        sec_filing_attachment = download_latest_filing(cik, filings, ticker)

    # ── STAGE 3: Market data via yahooquery ───────────────────────────────────
    stage(3, "Fetching price history & fundamentals")
    yqd = YQData(ticker)

    if not sec_available:
        company_name = yqd.asset_profile.get("longName") or yqd.price_mod.get("longName") or ticker

    hist     = yqd.history(period="5y", interval="1d")
    spy_hist = YQData("SPY").history(period="5y", interval="1d")

    # Validation gate — need at least one live data source
    if not sec_available and (hist is None or hist.empty):
        return {"error": (f"'{ticker}' doesn't look like a valid tradeable ticker. "
                          "No SEC filings and no market data were found."),
                "invalid_ticker": True, "ticker": ticker}

    inc_df = yqd.income_stmt()
    cf_df  = yqd.cashflow_stmt()

    # Unified info dict built from yahooquery modules
    fd  = yqd.financial_data     # margins, targets, ratios
    ks  = yqd.key_stats          # pe, peg, pb, shorts, ev
    sd  = yqd.summary_detail     # market cap, trailing/forward pe
    ap  = yqd.asset_profile      # sector, industry, description
    pm  = yqd.price_mod          # live price, bid/ask, market state

    # ── Current price ─────────────────────────────────────────────────────────
    current_price = safe_float(pm.get("regularMarketPrice"))
    if current_price is None and not hist.empty:
        current_price = safe_float(hist["Close"].iloc[-1])

    # ── STAGE 4: FMP cross-check ──────────────────────────────────────────────
    stage(4, "Fetching FMP verification data")
    fmp      = fetch_fmp_data(ticker)
    fmp_m    = fmp["metrics"]  if fmp else {}
    fmp_inc  = fmp["income"]   if fmp else {}
    fmp_cf   = fmp["cashflow"] if fmp else {}

    # ── STAGE 5: Live quote, options, intraday ─────────────────────────────────
    stage(5, "Live quote, options & intraday")
    live_quote = {
        "fetched_at":     datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "last_price":     safe_float(pm.get("regularMarketPrice")),
        "open":           safe_float(pm.get("regularMarketOpen")),
        "day_high":       safe_float(pm.get("regularMarketDayHigh")),
        "day_low":        safe_float(pm.get("regularMarketDayLow")),
        "previous_close": safe_float(pm.get("regularMarketPreviousClose")),
        "bid":            safe_float(pm.get("bid") or sd.get("bid")),
        "ask":            safe_float(pm.get("ask") or sd.get("ask")),
        "bid_size":       pm.get("bidSize") or sd.get("bidSize"),
        "ask_size":       pm.get("askSize") or sd.get("askSize"),
        "market_state":   pm.get("marketState"),
        "currency":       pm.get("currency"),
        "exchange":       pm.get("exchangeName") or pm.get("exchange"),
        "market_cap":     safe_float(pm.get("marketCap") or sd.get("marketCap")),
        "year_high":      safe_float(pm.get("fiftyTwoWeekHigh") or sd.get("fiftyTwoWeekHigh")),
        "year_low":       safe_float(pm.get("fiftyTwoWeekLow")  or sd.get("fiftyTwoWeekLow")),
        "last_volume":    safe_float(pm.get("regularMarketVolume")),
    }

    intraday_hist = fetch_intraday_data(yqd)
    options_data  = yqd.option_data(current_price or 0) if current_price else {"available_expirations":[],"chains":[],"iv_summary":{}}
    price_history = get_price_history_series(hist, days=1260)   # 5Y for multi-timeframe charts

    # ── STAGE 6: Technicals & pattern detection ────────────────────────────────
    stage(6, "Computing technicals & chart patterns")
    latest = current_price
    prev   = hist["Close"].iloc[-2] if len(hist) > 1 else latest
    daily_change = safe_divide((latest - prev), prev) if latest and prev else 0

    high_52w = hist["High"].tail(252).max() if not hist.empty else None
    low_52w  = hist["Low"].tail(252).min()  if not hist.empty else None
    high_5y  = hist["High"].max()           if not hist.empty else None
    low_5y   = hist["Low"].min()            if not hist.empty else None

    pct_from_52_high = safe_divide((latest - high_52w), high_52w) if latest and high_52w else 0
    pct_from_5y_high = safe_divide((latest - high_5y),  high_5y)  if latest and high_5y  else 0

    ma_50  = hist["Close"].rolling(50).mean().iloc[-1]  if not hist.empty else None
    ma_200 = hist["Close"].rolling(200).mean().iloc[-1] if not hist.empty else None

    rsi_latest = 50.0
    if not hist.empty:
        delta    = hist["Close"].diff()
        gain     = delta.where(delta > 0, 0.0)
        loss     = -delta.where(delta < 0, 0.0)
        avg_gain = gain.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
        rs = safe_divide(avg_gain.iloc[-1], avg_loss.iloc[-1], 1.0)
        rsi_latest = 100 - (100 / (1 + rs))

    avg_volume   = hist["Volume"].rolling(20).mean().iloc[-1] if not hist.empty else 0
    latest_volume= hist["Volume"].iloc[-1]                    if not hist.empty else 0
    volume_ratio = safe_divide(latest_volume, avg_volume) if avg_volume > 0 else 1.0

    cagr = annual_vol = sharpe = max_drawdown = 0.0; beta = np.nan
    rf_rate = 0.045
    if not hist.empty and len(hist) > 200:
        daily_returns = hist["Close"].pct_change().dropna()
        years = len(hist) / 252
        cagr  = ((safe_divide(latest, hist["Close"].iloc[0])) ** (1/years)) - 1 if years > 0 else 0
        annual_vol   = daily_returns.std() * np.sqrt(252)
        cumulative   = (1 + daily_returns).cumprod()
        peak         = cumulative.expanding(min_periods=1).max()
        max_drawdown = safe_divide((cumulative - peak), peak).min()
        try:
            tnx = YQData("^TNX")
            r   = safe_float(tnx.price_mod.get("regularMarketPrice"))
            if r: rf_rate = r / 100
        except: pass
        sharpe = safe_divide((cagr - rf_rate), annual_vol)
        if not spy_hist.empty:
            spy_ret = spy_hist["Close"].pct_change().dropna()
            aligned = pd.DataFrame({"stock": daily_returns, "spy": spy_ret}).dropna()
            if len(aligned) > 30:
                beta = safe_divide(aligned["stock"].cov(aligned["spy"]), aligned["spy"].var())

    spy_vol = spy_hist["Close"].pct_change().dropna().std() * np.sqrt(252) if not spy_hist.empty else np.nan

    chart_patterns, key_levels = detect_chart_patterns(hist, latest or 0)

    # ── STAGE 7: Signals & prompt ──────────────────────────────────────────────
    stage(7, "Computing signals & building AI prompt")
    price_action  = analyze_price_action(hist, latest or 0)
    institutional = analyze_institutional(hist)

    # ── Valuation (yahoo modules with FMP fallback) ────────────────────────────
    pe_trail  = safe_float(sd.get("trailingPE")     or ks.get("trailingPE")     or fmp_m.get("peRatioTTM"))
    pe_fwd    = safe_float(sd.get("forwardPE")      or ks.get("forwardPE"))
    peg       = safe_float(ks.get("pegRatio")       or fmp_m.get("pegRatioTTM"))
    pb        = safe_float(ks.get("priceToBook")    or fmp_m.get("pbRatioTTM"))
    ps        = safe_float(ks.get("priceToSalesTrailingTwelveMonths") or sd.get("priceToSalesTrailingTwelveMonths"))
    ev_ebitda = safe_float(ks.get("enterpriseToEbitda") or fmp_m.get("evToEbitdaTTM") or fmp_m.get("enterpriseValueMultipleTTM"))
    mkt_cap   = safe_float(sd.get("marketCap")      or pm.get("marketCap"))
    ev        = safe_float(ks.get("enterpriseValue") or fmp_m.get("enterpriseValueTTM"))
    fcf       = safe_float(fd.get("freeCashflow"))
    rev_yf    = safe_float(fd.get("totalRevenue"))
    fcf_margin= safe_divide(fcf, rev_yf)  if is_valid(fcf) and is_valid(rev_yf) and rev_yf else None
    fcf_yield = safe_divide(fcf, mkt_cap) if is_valid(fcf) and is_valid(mkt_cap) and mkt_cap else None

    # ── Margins & profitability ────────────────────────────────────────────────
    gross_m = safe_float(fd.get("grossMargins")     or fmp_m.get("grossProfitMarginTTM"))
    op_m    = safe_float(fd.get("operatingMargins") or fmp_m.get("operatingProfitMarginTTM"))
    net_m   = safe_float(fd.get("profitMargins")    or fmp_m.get("netProfitMarginTTM"))
    roe     = safe_float(fd.get("returnOnEquity")   or fmp_m.get("roeTTM"))
    roa     = safe_float(fd.get("returnOnAssets")   or fmp_m.get("roaTTM"))

    # ── Revenue growth from yahooquery income statement ────────────────────────
    rev_1y = rev_3y = rev_5y = None; rev_shrinking = False
    revs = _stmt_series(inc_df, "TotalRevenue", "Revenue", "Total Revenue", n=5)
    if len(revs) >= 2 and revs[0] and revs[1]: rev_1y = safe_divide(revs[0], revs[1]) - 1
    if len(revs) >= 4 and revs[0] and revs[3]: rev_3y = ((safe_divide(revs[0], revs[3])) ** (1/3)) - 1
    if len(revs) >= 5 and revs[0] and revs[4]: rev_5y = ((safe_divide(revs[0], revs[4])) ** (1/4)) - 1
    if rev_3y is not None and rev_3y < 0: rev_shrinking = True

    # ── Financial health ──────────────────────────────────────────────────────
    curr_ratio = safe_float(fd.get("currentRatio") or fmp_m.get("currentRatioTTM"))
    debt_eq    = safe_float(fd.get("debtToEquity") or fmp_m.get("debtToEquityTTM"))
    ocf_val    = _stmt_val(cf_df, "OperatingCashFlow", "Operating Cash Flow")
    ni_val     = _stmt_val(inc_df, "NetIncome", "Net Income")
    earnings_quality = safe_divide(ocf_val, ni_val) if is_valid(ocf_val) and is_valid(ni_val) and ni_val else None

    # ── Sentiment & analyst targets ───────────────────────────────────────────
    short_float = safe_float(ks.get("shortPercentOfFloat") or ks.get("shortPercent"))
    target_mean = safe_float(fd.get("targetMeanPrice"))
    target_high = safe_float(fd.get("targetHighPrice"))
    target_low  = safe_float(fd.get("targetLowPrice"))
    rec_key     = fd.get("recommendationKey", "N/A") or "N/A"
    inst_own    = safe_float(ks.get("heldPercentInstitutions"))
    insider_own = safe_float(ks.get("heldPercentInsiders"))
    next_earnings_raw = (yqd.calendar_events.get("earnings") or {}).get("earningsDate")
    next_earnings = next_earnings_raw[0] if isinstance(next_earnings_raw, list) and next_earnings_raw else next_earnings_raw

    # ── Earnings history ──────────────────────────────────────────────────────
    beats = misses = 0
    recent_earnings = []
    eh = yqd.earnings_hist()
    if not eh.empty:
        for _, row in eh.head(4).iterrows():
            est = safe_float(row.get("epsEstimate"))
            rep = safe_float(row.get("epsActual"))
            if est is not None and rep is not None:
                surprise = safe_divide((rep - est), abs(est)) if est != 0 else 0
                date_val = str(row.get("period",""))[:10] or str(row.get("quarter",""))[:10]
                recent_earnings.append({"date": date_val, "estimate": float(est),
                                        "reported": float(rep), "surprise_pct": float(surprise)})
                if rep > est: beats += 1
                elif rep < est: misses += 1

    # ── Algorithmic flags ─────────────────────────────────────────────────────
    flags, data_warnings = [], []

    if is_valid(pe_trail, -1000, 10000):
        if pe_trail <= 0: data_warnings.append("P/E ≤ 0: unprofitable or large one-time item.")
        elif pe_trail > 500: flags.append(f"EXTREME VALUATION: Trailing P/E {pe_trail:.2f} (>500).")
    if is_valid(peg, -10, 50):
        if peg < 0: flags.append("NEGATIVE PEG: negative earnings growth or anomaly.")
        elif peg > 5: flags.append(f"EXTREME PEG: {peg:.2f} — massive overvaluation or negative growth.")
    if is_valid(debt_eq, 0, 5000) and debt_eq > 500: flags.append(f"EXTREME LEVERAGE: D/E {debt_eq:.2f} (>500).")
    if is_valid(earnings_quality) and ni_val and ni_val > 0 and earnings_quality < 0.5:
        flags.append("RED FLAG: Earnings Quality < 0.5 — cash flow doesn't match profits.")

    if sec_available:
        if sec_ni_val is not None and sec_ni_val < 0: flags.append("NET LOSS (SEC 10-K verified).")
        if sec_rev_cagr is not None and sec_rev_cagr < 0: flags.append(f"DECLINING TOP LINE: 3Y Rev CAGR {sec_rev_cagr:.2%} (SEC).")
        if sec_liab_val and sec_equity_val and sec_equity_val != 0:
            lev = safe_divide(sec_liab_val, sec_equity_val)
            if lev > 2.0: flags.append(f"HIGH LEVERAGE: Liabilities {lev:.1f}x Equity (SEC).")
        if filing_signals["insider_buys"] > filing_signals["insider_sells"] > 0:
            flags.append(f"NET INSIDER BUYING: {filing_signals['insider_buys']}B vs {filing_signals['insider_sells']}S (Form 4, 90D).")
        elif filing_signals["insider_sells"] >= 5 and filing_signals["insider_sells"] > filing_signals["insider_buys"]:
            flags.append(f"HEAVY INSIDER SELLING: {filing_signals['insider_sells']}S vs {filing_signals['insider_buys']}B (90D).")
        if filing_signals["activist_13d"]: flags.append("ACTIVIST ALERT: New 13D — large position building.")

    if is_valid(peg) and rev_3y is not None:
        if peg < 1.0 and rev_shrinking: flags.append(f"FAKE VALUE: PEG {peg:.2f} but 3Y Rev CAGR negative ({rev_3y:.2%}).")
        elif peg < 1.0: flags.append(f"FUNDAMENTAL VALUE: PEG {peg:.2f} (< 1.0).")
        elif peg > 2.0 and rev_3y < 0.05: flags.append(f"EXPENSIVE STABILITY: PEG {peg:.2f} with {rev_3y:.2%} 3Y growth.")

    if latest and ma_50 and ma_200:
        if latest > ma_50 > ma_200:   flags.append("BULLISH ALIGNMENT: Price > 50MA > 200MA.")
        elif latest < ma_50 < ma_200: flags.append("BEARISH ALIGNMENT: Price < 50MA < 200MA.")
        elif latest > ma_50 and latest < ma_200: flags.append("RECOVERY MODE: Price > 50MA but < 200MA.")

    if rsi_latest > 75:    flags.append("EXTREME OVERBOUGHT: RSI > 75.")
    elif rsi_latest >= 65: flags.append("MOMENTUM STRETCH: RSI ≥ 65.")
    elif rsi_latest < 25:  flags.append("EXTREME OVERSOLD: RSI < 25.")

    if daily_change > 0 and volume_ratio < 0.85: flags.append(f"WEAK CONFIRMATION: Up day on {volume_ratio:.2f}x avg vol.")
    if pct_from_5y_high < -0.50: flags.append(f"CYCLE LOWS: {pct_from_5y_high:.1%} from 5Y high.")
    if is_valid(spy_vol) and spy_vol > 0 and (annual_vol/spy_vol) > 2.5:
        flags.append(f"EXTREME RISK: {annual_vol/spy_vol:.1f}x more volatile than SPY.")
    if is_valid(short_float) and short_float > 0.10: flags.append(f"HIGH SHORT INTEREST: {short_float:.1%} of float.")
    if misses >= 3: flags.append(f"EARNINGS: Missed estimates {misses}/4 recent quarters.")
    if beats == 4:  flags.append("EARNINGS: Beat estimates all 4 recent quarters.")

    if price_action.get("trend") in ("UPTREND","DOWNTREND","RANGE / TRANSITION"):
        cls = {"UPTREND":"BULLISH STRUCTURE","DOWNTREND":"BEARISH STRUCTURE",
               "RANGE / TRANSITION":"STRUCTURE TRANSITION"}[price_action["trend"]]
        flags.append(f"{cls}: {price_action['trend_basis']}")
    for ev in price_action.get("events", []): flags.append(ev)
    if institutional.get("net_bias") == "ACCUMULATION":  flags.append("INSTITUTIONAL ACCUMULATION: volume footprint → net buying.")
    elif institutional.get("net_bias") == "DISTRIBUTION": flags.append("INSTITUTIONAL DISTRIBUTION: volume footprint → net selling.")

    # ══════════════════════════════════════════════════════════════════════════
    # BUILD OPTIMISED AI PROMPT  (compact — ~40% fewer input tokens than v1)
    # ══════════════════════════════════════════════════════════════════════════
    biz_sum = ap.get("longBusinessSummary", "")
    biz_sum = (biz_sum[:150] + "…") if biz_sum and len(biz_sum) > 150 else biz_sum

    ai_prompt = f"""TODAY: {TODAY_STR}. Analyze {company_name} ({ticker}). Use only data below; do not invent figures.

### 1. COMPANY
Sector/Industry: {ap.get('sector','N/A')} / {ap.get('industry','N/A')} | Next Earnings: {str(next_earnings) if next_earnings else 'N/A'}
{biz_sum}

### 2. SEC FUNDAMENTALS (Latest 10-K){"" if sec_available else " — ⚠️ UNAVAILABLE"}
Rev/NI/OCF: {fmt(sec_rev_val,'usd')} / {fmt(sec_ni_val,'usd')} / {fmt(sec_ocf_val,'usd')}
Assets/Liabilities/Equity: {fmt(sec_assets_val,'usd')} / {fmt(sec_liab_val,'usd')} / {fmt(sec_equity_val,'usd')}
Rev CAGR 3Y (SEC): {fmt(sec_rev_cagr,'pct')}
"""

    # FMP cross-check (compact block, only if available)
    if fmp:
        fmp_rev_ttm = safe_float(fmp_inc.get("revenue"))
        fmp_ni_ttm  = safe_float(fmp_inc.get("netIncome"))
        fmp_fcf_ttm = safe_float(fmp_cf.get("freeCashFlow"))
        ai_prompt += f"""
### 2b. FMP CROSS-CHECK (TTM)
Rev/NI/FCF: {fmt(fmp_rev_ttm,'usd')} / {fmt(fmp_ni_ttm,'usd')} / {fmt(fmp_fcf_ttm,'usd')}
P/E: {fmt(fmp_m.get('peRatioTTM'),'ratio')} | EV/EBITDA: {fmt(fmp_m.get('evToEbitdaTTM'),'ratio')} | ROE: {fmt(fmp_m.get('roeTTM'),'pct')} | D/E: {fmt(fmp_m.get('debtToEquityTTM'),'ratio')}
"""

    ai_prompt += f"""
### 3. VALUATION
MCap/EV: {fmt(mkt_cap,'usd')} / {fmt(ev,'usd')}
P/E (Trail/Fwd): {fmt(pe_trail,'ratio')} / {fmt(pe_fwd,'ratio')} | PEG: {fmt(peg,'ratio')} | P/B: {fmt(pb,'ratio')} | P/S: {fmt(ps,'ratio')} | EV/EBITDA: {fmt(ev_ebitda,'ratio')}
FCF Yield/FCF Margin: {fmt(fcf_yield,'pct')} / {fmt(fcf_margin,'pct')}

### 4. PROFITABILITY & GROWTH
Margins (Gross/Op/Net): {fmt(gross_m,'pct')} / {fmt(op_m,'pct')} / {fmt(net_m,'pct')} | ROE/ROA: {fmt(roe,'pct')} / {fmt(roa,'pct')}
Rev Growth (1Y/3Y/5Y): {fmt(rev_1y,'pct')} / {fmt(rev_3y,'pct')} / {fmt(rev_5y,'pct')}

### 5. FINANCIAL HEALTH
Current Ratio: {fmt(curr_ratio,'ratio')} | D/E: {fmt(debt_eq,'ratio')} | Earnings Quality (OCF/NI): {fmt(earnings_quality,'ratio')}

### 6. PRICE & MOMENTUM ({TODAY_STR})
Price: {fmt(latest,'usd')} ({fmt(daily_change,'pct')} today) | Bid/Ask: {fmt(live_quote.get('bid'),'usd')}/{fmt(live_quote.get('ask'),'usd')} | Market: {live_quote.get('market_state','N/A')}
52W Range: {fmt(low_52w,'usd')}–{fmt(high_52w,'usd')} ({fmt(pct_from_52_high,'pct')} from high)
MA50/MA200: {fmt(ma_50,'usd')} / {fmt(ma_200,'usd')} | BB: {fmt(key_levels.get('bb_upper'),'usd')}↑ / {fmt(key_levels.get('bb_lower'),'usd')}↓
RSI(14): {fmt(rsi_latest,'ratio')} | MACD/Signal: {fmt(key_levels.get('macd'),'ratio')}/{fmt(key_levels.get('macd_signal'),'ratio')}
5Y CAGR/MaxDD/Sharpe/Beta/AnnVol: {fmt(cagr,'pct')} / {fmt(max_drawdown,'pct')} / {fmt(sharpe,'ratio')} / {fmt(beta,'ratio')} / {fmt(annual_vol,'pct')}
Volume: {fmt(volume_ratio,'ratio')}x 20D avg

### 7. KEY LEVELS
Resistance: {', '.join([fmt(r,'usd') for r in key_levels.get('resistance',[])]) or 'N/A'}
Support: {', '.join([fmt(s,'usd') for s in key_levels.get('support',[])]) or 'N/A'}

### 8. CHART PATTERNS
"""
    for p in (chart_patterns or ["None detected."]): ai_prompt += f"- {p}\n"

    ai_prompt += f"""
### 9. SENTIMENT
Analyst Targets (Mean/Hi/Lo): {fmt(target_mean,'usd')} / {fmt(target_high,'usd')} / {fmt(target_low,'usd')} | Consensus: {rec_key.replace('-',' ').title()}
Inst/Insider/Short: {fmt(inst_own,'pct')} / {fmt(insider_own,'pct')} / {fmt(short_float,'pct')}

### 10. EARNINGS (Last 4Q)
"""
    if recent_earnings:
        for e in recent_earnings:
            ai_prompt += f"- {e['date']}: Est ${e['estimate']:.2f} | Rep ${e['reported']:.2f} | {fmt(e['surprise_pct'],'pct')} surprise\n"
    else:
        ai_prompt += "- No earnings data.\n"

    if sec_available:
        ai_prompt += f"""
### 11. SEC SIGNALS (Last 90D)
8-K: {', '.join(filing_signals['8k_events']) if filing_signals['8k_events'] else 'None'} | Form 4: {filing_signals['insider_buys']}B/{filing_signals['insider_sells']}S | Activist 13D: {'YES' if filing_signals['activist_13d'] else 'No'}
"""

    ai_prompt += "\n### 12. ALGORITHMIC SIGNALS\n"
    for f in (flags or ["NEUTRAL: No strong signals."]): ai_prompt += f"- {f}\n"

    ai_prompt += f"""
### 12b. PRICE STRUCTURE & INSTITUTIONAL FOOTPRINT
Trend: {price_action.get('trend','N/A')} — {price_action.get('trend_basis','')}
Swing H/L: {fmt(price_action.get('recent_swing_high'),'usd')} / {fmt(price_action.get('recent_swing_low'),'usd')} | Events: {'; '.join(price_action.get('events',[])) or 'None'}
"""
    if price_action.get("fib"):
        ai_prompt += "Fib: " + " | ".join(f"{k}={fmt(v,'usd')}" for k,v in price_action["fib"].items()) + "\n"

    ai_prompt += f"OBV: {institutional.get('obv_trend','N/A')} | Up-Vol%: {fmt(institutional.get('up_vol_ratio'),'pct')} | Acc/Dist days: {institutional.get('accumulation_days',0)}/{institutional.get('distribution_days',0)} | Bias: {institutional.get('net_bias','NEUTRAL')}\n"
    for s in institutional.get("signals",[]): ai_prompt += f"- {s}\n"

    if data_warnings:
        ai_prompt += "\n### DATA QUALITY\n"
        for w in data_warnings: ai_prompt += f"- {w}\n"

    # Options (compact — 2 expirations, 3 strikes each)
    if options_data["chains"]:
        ai_prompt += f"\n### 13. OPTIONS CHAIN ({TODAY_STR}) — do not invent strikes or expirations\n"
        ai_prompt += f"Available expirations: {', '.join(options_data['available_expirations'])}\n"
        for chain in options_data["chains"]:
            ai_prompt += f"\nExpiry {chain['expiration']} ({chain['days_to_exp']}d) | ATM {fmt(chain['atm_strike'],'usd')}\n"
            ai_prompt += "CALLS: " + " | ".join(
                f"{fmt(c['strike'],'usd')} bid/ask {fmt(c['bid'],'usd')}/{fmt(c['ask'],'usd')} IV {fmt(c['iv'],'pct')} OI {c['open_interest']:,}"
                + (" [ITM]" if c['in_the_money'] else "")
                for c in chain["calls"]) + "\n"
            ai_prompt += "PUTS:  " + " | ".join(
                f"{fmt(p['strike'],'usd')} bid/ask {fmt(p['bid'],'usd')}/{fmt(p['ask'],'usd')} IV {fmt(p['iv'],'pct')} OI {p['open_interest']:,}"
                + (" [ITM]" if p['in_the_money'] else "")
                for p in chain["puts"]) + "\n"
    else:
        ai_prompt += "\n### 13. OPTIONS — unavailable for this ticker.\n"

    if sec_available and mda_text and "unavailable" not in mda_text and "Failed" not in mda_text:
        ai_prompt += f"\n### 14. MD&A EXCERPT (Latest 10-K, ~500 chars)\n{mda_text[:500]}…\n"

    ai_prompt += f"""
---
### INSTRUCTIONS ({TODAY_STR})
You are writing a thorough equity analysis for an investor who sees every raw figure in a live dashboard beside your text. Do NOT restate metrics, rebuild tables, or list numbers for their own sake — interpret them. Cite a specific figure only when it anchors a judgment ("trading at 34x forward earnings against ~12% growth, the multiple is pricing in flawless execution"). Think carefully before writing; reason through the valuation, the balance sheet, sentiment/positioning, and the technical structure, and how the pieces corroborate or contradict each other.

Write these sections with markdown ## headers. Aim for depth and specificity over length — roughly 900–1300 words total. No preamble, no restating the prompt.

## Verdict
Lead with one rating from this exact scale: **Strong Buy**, **Buy**, **Hold**, **Sell**, or **Strong Sell** — bold it. This is the TL;DR; make it earn that role. Follow with the core reason in one or two sentences, a defined risk/reward, and the single price level or event that would invalidate the call.

## Valuation & Quality
Is the current multiple justified by growth, margins, and returns on capital? Weigh P/E and PEG against the growth rate, FCF yield against the balance sheet, and EV/EBITDA against the sector. Where SEC, FMP, and Yahoo disagree on a number, say which you trust and why a discrepancy matters.

## Fundamentals & Financial Health
Read the trajectory, not the snapshot: margin direction, revenue growth durability, earnings quality (OCF vs net income), leverage, and liquidity. Flag anything in the SEC fundamentals or MD&A that changes the thesis.

## Sentiment & Positioning
Does analyst consensus (target mean/high/low, rating) agree with your own read, or are they pricing in something you'd push back on? What does the balance of institutional, insider, and short-interest ownership imply about conviction or crowding? Connect the recent earnings-surprise track record (§earnings history) to how much credibility forward estimates deserve.

## Price Action & Institutional Footprint
Classify the trend from §12b (UPTREND=HH+HL, DOWNTREND=LH+LL, else RANGE). Tie swing levels, Fibonacci zones, and the OBV/accumulation-distribution footprint into one narrative about who is in control. Name the level a buyer defends and the level where the structure breaks. Validate or dismiss the algorithmic signals — call out any that mislead.

## Catalysts & Risks
The 2–3 catalysts that could re-rate the stock (earnings, 8-K events, insider activity, sentiment shifts) and the 2–3 risks that would break the bull case. Be specific to this company, not generic.

## Trade Idea
One actionable options structure using ONLY strikes/expirations from §13: strike, expiry, premium (bid/ask midpoint), breakeven, max loss, and the thesis it expresses. If nothing in §13 sets up cleanly, say so and explain why in one sentence.
"""

    return {
        "ticker":            ticker,
        "cik":               cik,
        "company_name":      company_name,
        "today":             TODAY_STR,
        "sec_available":     sec_available,
        "fmp_available":     fmp is not None,
        "raw_data": {
            "valuation":        {"pe_trailing": safe_float(pe_trail), "pe_forward": safe_float(pe_fwd),
                                 "peg_ratio": safe_float(peg), "price_to_book": safe_float(pb),
                                 "price_to_sales": safe_float(ps), "ev_ebitda": safe_float(ev_ebitda),
                                 "fcf_yield": safe_float(fcf_yield)},
            "profitability":    {"gross_margin": safe_float(gross_m), "operating_margin": safe_float(op_m),
                                 "net_margin": safe_float(net_m), "roe": safe_float(roe),
                                 "roa": safe_float(roa), "fcf_margin": safe_float(fcf_margin)},
            "financial_health": {"current_ratio": safe_float(curr_ratio), "debt_to_equity": safe_float(debt_eq),
                                 "earnings_quality": safe_float(earnings_quality)},
            "sec_fundamentals": {"revenue": safe_float(sec_rev_val), "net_income": safe_float(sec_ni_val),
                                 "assets": safe_float(sec_assets_val), "liabilities": safe_float(sec_liab_val),
                                 "equity": safe_float(sec_equity_val), "ocf": safe_float(sec_ocf_val),
                                 "rev_cagr_3y": safe_float(sec_rev_cagr)},
            "technicals":       {"current_price": safe_float(latest), "daily_change": safe_float(daily_change),
                                 "high_52w": safe_float(high_52w), "low_52w": safe_float(low_52w),
                                 "pct_from_52_high": safe_float(pct_from_52_high),
                                 "ma_50": safe_float(ma_50), "ma_200": safe_float(ma_200),
                                 "rsi_14": safe_float(rsi_latest), "volume_ratio": safe_float(volume_ratio),
                                 "macd": safe_float(key_levels.get("macd")),
                                 "macd_signal": safe_float(key_levels.get("macd_signal")),
                                 "bb_upper": safe_float(key_levels.get("bb_upper")),
                                 "bb_lower": safe_float(key_levels.get("bb_lower"))},
            "risk_return":      {"cagr": safe_float(cagr), "max_drawdown": safe_float(max_drawdown),
                                 "sharpe": safe_float(sharpe), "annual_volatility": safe_float(annual_vol),
                                 "beta": safe_float(beta)},
            "sentiment":        {"target_mean": safe_float(target_mean), "target_high": safe_float(target_high),
                                 "target_low": safe_float(target_low), "rec_key": rec_key,
                                 "inst_ownership": safe_float(inst_own), "short_percent": safe_float(short_float)},
            "earnings_surprises": recent_earnings,
            "key_levels":       {k: ([safe_float(x) for x in v] if isinstance(v, list) else safe_float(v))
                                 for k, v in key_levels.items()}
        },
        "chart_patterns":    chart_patterns,
        "filing_activity":   filing_signals,
        "options_data":      options_data,
        "mda_excerpt":       mda_text,
        "live_quote":        live_quote,
        # price_history contains 5Y of OHLCV data (oldest first).
        # Frontend: use all bars and filter by selected timeframe (1W/1M/3M/6M/1Y/2Y/5Y).
        # Backward-compat alias: price_history_1y still present (last 252 bars).
        "price_history":     price_history,
        "price_history_1y":  price_history[-252:] if len(price_history) >= 252 else price_history,
        "sec_filing":        sec_filing_attachment,
        "price_action":      price_action,
        "institutional":     institutional,
        "algorithmic_signals": flags,
        "ai_prompt":         ai_prompt,
    }


# ══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    t = sys.argv[1].upper() if len(sys.argv) > 1 else "AAPL"
    try:
        print(json.dumps(generate_analysis_payload(t), indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e), "ticker": t}))
