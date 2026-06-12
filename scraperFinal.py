import yfinance as yf
import requests
import json
import re
import sys
import os
import math
import pandas as pd
import numpy as np
import warnings
from datetime import datetime, timedelta

warnings.filterwarnings('ignore')

TODAY      = datetime.now()
TODAY_STR  = TODAY.strftime('%B %d, %Y')
TODAY_ISO  = TODAY.strftime('%Y-%m-%d')

# ==========================================
# ⚠️  SET YOUR EMAIL (SEC requires this)
# ==========================================
USER_AGENT  = "BasementQuantProject ilgardemir2@gmail.com"
SEC_HEADERS = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate", "Host": "data.sec.gov"}

# ==========================================
# 1. UTILITIES
# ==========================================
def safe_divide(num, denom, default=0.0):
    if isinstance(num, (pd.Series, np.ndarray)) or isinstance(denom, (pd.Series, np.ndarray)):
        with np.errstate(divide='ignore', invalid='ignore'):
            res = num / denom
            if isinstance(res, pd.Series):
                return res.replace([np.inf, -np.inf], np.nan).fillna(default)
            return np.nan_to_num(res, nan=default, posinf=default, neginf=default)
    if denom == 0 or pd.isna(denom) or pd.isna(num): return default
    result = num / denom
    return default if math.isinf(result) or math.isnan(result) else result

def is_valid(val, min_val=-1e9, max_val=1e9):
    if val is None: return False
    try:
        f = float(val)
        return not math.isnan(f) and not math.isinf(f) and min_val <= f <= max_val
    except: return False

def get_risk_free_rate():
    try:
        rate = yf.Ticker("^TNX").info.get('previousClose', 40.0) / 1000
        return rate if is_valid(rate, 0, 0.20) else 0.045
    except: return 0.045

def safe_get_financial(df, row_name, col_idx=0):
    try:
        if df is None or df.empty or row_name not in df.index: return None
        val = df.loc[row_name].dropna()
        return float(val.iloc[col_idx]) if not val.empty else None
    except: return None

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

# ==========================================
# 2. SEC EDGAR
# ==========================================
def get_cik_from_ticker(ticker):
    try:
        r = requests.get("https://www.sec.gov/files/company_tickers.json",
                         headers={"User-Agent": USER_AGENT}, timeout=10)
        r.raise_for_status()
        for val in r.json().values():
            if val['ticker'].lower() == ticker.lower():
                return str(val['cik_str']).zfill(10)
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
        recent = r.json().get('filings', {}).get('recent', {})
        primary_docs = recent.get('primaryDocument', [])
        return [{'form': recent['form'][i], 'filing_date': recent['filingDate'][i],
                 'accession_number': recent['accessionNumber'][i],
                 'primary_document': primary_docs[i] if i < len(primary_docs) else None}
                for i in range(min(limit, len(recent.get('accessionNumber', []))))]
    except: return []

def extract_mda_text(cik, accession_number):
    try:
        clean_acc = accession_number.replace("-", "")
        url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{clean_acc}/{accession_number}.txt"
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
        r.raise_for_status()
        match = re.search(
            r'(?:ITEM\s+7\.|ITEM\s+2\.)\s*MANAGEMENT[\s\S]*?DISCUSSION AND ANALYSIS.*?(?=ITEM\s+\d+\.)',
            r.text, re.IGNORECASE)
        if match:
            clean = re.sub(r'<[^>]+>', ' ', match.group(0))
            return re.sub(r'\s+', ' ', clean).strip()[:3000]
        return "MD&A section not found."
    except: return "Failed to fetch MD&A."

def parse_8k_items(cik, accession_number):
    try:
        clean_acc = accession_number.replace("-", "")
        url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{clean_acc}/{accession_number}.txt"
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
        items = re.findall(r'ITEM\s+(\d+\.\d+|\d+)\.', r.text, re.IGNORECASE)
        meanings = {'1.01':'Material Definitive Agreement','2.01':'Acquisition/Disposition of Assets',
                    '2.02':'Results of Operations (Earnings Release)','2.06':'Material Impairment',
                    '3.01':'Delisting Notice','4.01':'Change in Accountant',
                    '5.02':'Departure/Appointment of Officers or Directors','8.01':'Other Material Events'}
        return list(set([meanings.get(i, f'Item {i}') for i in items]))
    except: return []

def analyze_form4(cik, accession_number):
    try:
        clean_acc = accession_number.replace("-", "")
        url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{clean_acc}/{accession_number}.txt"
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
        codes = re.findall(r'<transactionCode>\s*([PS])\s*</transactionCode>', r.text)
        return {'buys': codes.count('P'), 'sells': codes.count('S')}
    except: return {'buys': 0, 'sells': 0}

def safe_extract_sec(facts, namespace, concept):
    try:
        if namespace not in facts['facts'] or concept not in facts['facts'][namespace]:
            return None, []
        units = facts['facts'][namespace][concept]['units']
        unit_key = 'USD' if 'USD' in units else (list(units.keys())[0] if units else None)
        if not unit_key: return None, []
        annual = sorted([x for x in units[unit_key] if x.get('form') == '10-K'],
                        key=lambda x: x.get('end', ''), reverse=True)
        if not annual: return None, []
        return annual[0].get('val'), [x.get('val') for x in annual[:5]]
    except: return None, []

def download_latest_filing(cik, filings, ticker, out_dir="/mnt/user-data/outputs"):
    """
    Downloads the primary document of the most recent 10-K on file.
    If no 10-K is present, falls back to the single most recent filing of any type.
    A single lightweight GET request is made — gentle on SEC's servers.
    """
    if not filings:
        return None

    target = next((f for f in filings if f['form'] == '10-K'), None)
    if not target:
        target = filings[0]

    if not target.get('primary_document'):
        return {'form': target['form'], 'filing_date': target['filing_date'], 'error': 'No primary document listed.'}

    try:
        acc_nodash = target['accession_number'].replace('-', '')
        url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nodash}/{target['primary_document']}"
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
        r.raise_for_status()

        ext = target['primary_document'].split('.')[-1] if '.' in target['primary_document'] else 'htm'
        safe_form = target['form'].replace(' ', '').replace('/', '-')
        filename = f"{ticker}_{safe_form}_{target['filing_date']}.{ext}"

        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, filename)
        with open(out_path, 'wb') as fh:
            fh.write(r.content)

        return {
            'form': target['form'],
            'filing_date': target['filing_date'],
            'accession_number': target['accession_number'],
            'source_url': url,
            'local_path': out_path,
            'filename': filename,
            'size_bytes': len(r.content)
        }
    except Exception as e:
        return {'form': target['form'], 'filing_date': target['filing_date'], 'error': str(e)}

# ==========================================
# 3. OPTIONS CHAIN (Live — Future Dates Only)
# ==========================================
def fetch_options_chain(stock, current_price):
    """Fetches real options data with only future expiration dates."""
    result = {'available_expirations': [], 'chains': [], 'iv_summary': {}}
    try:
        all_expirations = stock.options  # tuple of date strings like '2026-07-18'
        if not all_expirations:
            return result

        # Filter to FUTURE expirations only
        future_exps = [e for e in all_expirations
                       if datetime.strptime(e, '%Y-%m-%d') > TODAY]

        if not future_exps:
            return result

        result['available_expirations'] = future_exps[:8]  # show up to 8

        # Fetch chains for next 4 expirations
        for exp_date in future_exps[:4]:
            try:
                chain = stock.option_chain(exp_date)
                calls = chain.calls
                puts  = chain.puts
                days_out = (datetime.strptime(exp_date, '%Y-%m-%d') - TODAY).days

                if calls.empty: continue

                # Find ATM strike (closest to current price)
                calls['dist'] = abs(calls['strike'] - current_price)
                puts['dist']  = abs(puts['strike']  - current_price)
                atm_idx_c = calls['dist'].idxmin()
                atm_idx_p = puts['dist'].idxmin()

                # Get ATM and nearest OTM options
                atm_strike = float(calls.loc[atm_idx_c, 'strike'])

                # Select a window of strikes around ATM
                otm_calls = calls[calls['strike'] >= atm_strike].head(5)
                otm_puts  = puts[puts['strike']  <= atm_strike].tail(5)

                chain_data = {
                    'expiration':   exp_date,
                    'days_to_exp':  days_out,
                    'atm_strike':   atm_strike,
                    'calls': [],
                    'puts':  []
                }

                for _, row in otm_calls.iterrows():
                    chain_data['calls'].append({
                        'strike':          safe_float(row.get('strike')),
                        'last':            safe_float(row.get('lastPrice')),
                        'bid':             safe_float(row.get('bid')),
                        'ask':             safe_float(row.get('ask')),
                        'iv':              safe_float(row.get('impliedVolatility')),
                        'open_interest':   int(row.get('openInterest', 0) or 0),
                        'volume':          int(row.get('volume', 0) or 0),
                        'in_the_money':    bool(row.get('inTheMoney', False))
                    })

                for _, row in otm_puts.iterrows():
                    chain_data['puts'].append({
                        'strike':          safe_float(row.get('strike')),
                        'last':            safe_float(row.get('lastPrice')),
                        'bid':             safe_float(row.get('bid')),
                        'ask':             safe_float(row.get('ask')),
                        'iv':              safe_float(row.get('impliedVolatility')),
                        'open_interest':   int(row.get('openInterest', 0) or 0),
                        'volume':          int(row.get('volume', 0) or 0),
                        'in_the_money':    bool(row.get('inTheMoney', False))
                    })

                result['chains'].append(chain_data)

                # IV summary from ATM call
                atm_iv = safe_float(calls.loc[atm_idx_c, 'impliedVolatility'])
                if atm_iv:
                    result['iv_summary'][exp_date] = atm_iv

            except Exception:
                continue

    except Exception:
        pass

    return result

# ==========================================
# 3b. REAL-TIME / INTRADAY DATA
# ==========================================
def fetch_intraday_data(stock):
    """
    Fetches recent intraday bars — enough resolution and lookback for
    pattern detection across a typical multi-day trading window.
    Tries 5-minute bars over the last 5 trading days first (yfinance's
    practical limit for that interval), falling back to coarser bars
    if the ticker has limited intraday history.
    """
    for period, interval in [("5d", "5m"), ("1mo", "15m"), ("1mo", "30m")]:
        try:
            intraday = stock.history(period=period, interval=interval)
            if not intraday.empty and len(intraday) >= 50:
                intraday.attrs['interval'] = interval
                intraday.attrs['period'] = period
                return intraday
        except Exception:
            continue
    return pd.DataFrame()

def get_live_quote(stock, info):
    """Best-effort real-time quote snapshot (delayed per Yahoo's feed, but the freshest available)."""
    quote = {"fetched_at": datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    try:
        fi = stock.fast_info
        quote.update({
            "last_price":     safe_float(fi.get('lastPrice')),
            "previous_close": safe_float(fi.get('previousClose')),
            "open":           safe_float(fi.get('open')),
            "day_high":       safe_float(fi.get('dayHigh')),
            "day_low":        safe_float(fi.get('dayLow')),
            "last_volume":    safe_float(fi.get('lastVolume')),
            "market_cap":     safe_float(fi.get('marketCap')),
            "year_high":      safe_float(fi.get('yearHigh')),
            "year_low":       safe_float(fi.get('yearLow')),
            "currency":       fi.get('currency'),
            "exchange":       fi.get('exchange'),
        })
    except Exception:
        pass
    quote["bid"]            = safe_float(info.get('bid'))
    quote["ask"]            = safe_float(info.get('ask'))
    quote["bid_size"]       = info.get('bidSize')
    quote["ask_size"]       = info.get('askSize')
    quote["market_state"]   = info.get('marketState')
    return quote

def get_price_history_series(hist, days=252):
    """Returns the trailing `days` of daily OHLCV (oldest first) for charting downstream."""
    if hist is None or hist.empty:
        return []
    recent = hist.tail(days)
    series = []
    for idx, row in recent.iterrows():
        series.append({
            "date":   idx.strftime('%Y-%m-%d'),
            "open":   safe_float(row.get('Open')),
            "high":   safe_float(row.get('High')),
            "low":    safe_float(row.get('Low')),
            "close":  safe_float(row.get('Close')),
            "volume": int(row.get('Volume', 0) or 0)
        })
    return series

# ==========================================
# 4. CHART PATTERN DETECTION
# ==========================================
def detect_chart_patterns(hist, current_price):
    """Detects common chart patterns algorithmically from price history."""
    patterns   = []
    key_levels = {}

    if hist.empty or len(hist) < 50:
        return patterns, key_levels

    close  = hist['Close']
    high   = hist['High']
    low    = hist['Low']
    volume = hist['Volume']

    # ── MOVING AVERAGES ───────────────────────────────────────────────────────
    ma20  = close.rolling(20).mean()
    ma50  = close.rolling(50).mean()
    ma200 = close.rolling(200).mean()

    # Golden / Death Cross (recent crossover within last 30 days)
    if len(ma50.dropna()) > 30 and len(ma200.dropna()) > 30:
        ma50_arr  = ma50.dropna().values
        ma200_arr = ma200.dropna().values
        n = min(len(ma50_arr), len(ma200_arr))
        if n >= 30:
            recent_cross_window = 20
            for i in range(max(1, n - recent_cross_window), n):
                if ma50_arr[i] > ma200_arr[i] and ma50_arr[i-1] <= ma200_arr[i-1]:
                    patterns.append("GOLDEN CROSS: 50MA crossed above 200MA recently — strong bullish signal.")
                    break
                if ma50_arr[i] < ma200_arr[i] and ma50_arr[i-1] >= ma200_arr[i-1]:
                    patterns.append("DEATH CROSS: 50MA crossed below 200MA recently — strong bearish signal.")
                    break

    # ── BOLLINGER BANDS ───────────────────────────────────────────────────────
    bb_mid  = close.rolling(20).mean()
    bb_std  = close.rolling(20).std()
    bb_up   = bb_mid + 2 * bb_std
    bb_low  = bb_mid - 2 * bb_std
    bb_width = safe_divide((bb_up.iloc[-1] - bb_low.iloc[-1]), bb_mid.iloc[-1])

    if current_price >= bb_up.iloc[-1] * 0.99:
        patterns.append(f"BB UPPER TOUCH: Price at/above upper Bollinger Band — overbought or strong breakout.")
    elif current_price <= bb_low.iloc[-1] * 1.01:
        patterns.append(f"BB LOWER TOUCH: Price at/below lower Bollinger Band — oversold or breakdown.")

    if bb_width < 0.05:
        patterns.append("BB SQUEEZE: Bollinger Bands extremely tight — major move imminent, direction unknown.")
    elif bb_width > 0.20:
        patterns.append("BB EXPANSION: Bollinger Bands very wide — high volatility regime.")

    key_levels['bb_upper'] = safe_float(bb_up.iloc[-1])
    key_levels['bb_lower'] = safe_float(bb_low.iloc[-1])
    key_levels['bb_width_pct'] = safe_float(bb_width)

    # ── MACD ──────────────────────────────────────────────────────────────────
    ema12  = close.ewm(span=12, adjust=False).mean()
    ema26  = close.ewm(span=26, adjust=False).mean()
    macd   = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    hist_m = macd - signal

    macd_val   = safe_float(macd.iloc[-1])
    signal_val = safe_float(signal.iloc[-1])
    hist_val   = safe_float(hist_m.iloc[-1])

    if macd_val and signal_val:
        if macd_val > signal_val and hist_m.iloc[-2] <= signal.iloc[-2]:
            patterns.append("MACD BULLISH CROSSOVER: MACD just crossed above signal line.")
        elif macd_val < signal_val and hist_m.iloc[-2] >= signal.iloc[-2]:
            patterns.append("MACD BEARISH CROSSOVER: MACD just crossed below signal line.")
        elif macd_val > 0 and signal_val > 0:
            patterns.append("MACD BULLISH: Both MACD and signal above zero.")
        elif macd_val < 0 and signal_val < 0:
            patterns.append("MACD BEARISH: Both MACD and signal below zero.")

    key_levels['macd']        = macd_val
    key_levels['macd_signal'] = signal_val
    key_levels['macd_hist']   = hist_val

    # ── SUPPORT & RESISTANCE (Pivot-based) ───────────────────────────────────
    # Use rolling local highs/lows over last 252 trading days
    lookback = min(252, len(hist))
    recent   = hist.tail(lookback)
    r_high   = recent['High']
    r_low    = recent['Low']

    # Find swing highs/lows using a 10-period window
    window = 10
    local_highs = []
    local_lows  = []
    for i in range(window, len(recent) - window):
        if r_high.iloc[i] == r_high.iloc[i-window:i+window+1].max():
            local_highs.append(float(r_high.iloc[i]))
        if r_low.iloc[i] == r_low.iloc[i-window:i+window+1].min():
            local_lows.append(float(r_low.iloc[i]))

    # Cluster nearby levels (within 1%)
    def cluster_levels(levels, tolerance=0.01):
        if not levels: return []
        levels = sorted(levels)
        clusters = []
        group = [levels[0]]
        for l in levels[1:]:
            if (l - group[0]) / group[0] <= tolerance:
                group.append(l)
            else:
                clusters.append(sum(group) / len(group))
                group = [l]
        clusters.append(sum(group) / len(group))
        return clusters

    resistance_levels = [r for r in cluster_levels(local_highs) if r > current_price]
    support_levels    = [s for s in cluster_levels(local_lows)  if s < current_price]

    key_levels['resistance'] = sorted(resistance_levels)[:3]
    key_levels['support']    = sorted(support_levels, reverse=True)[:3]

    # Annotate if price is near a key level
    for r in key_levels['resistance'][:2]:
        if abs(current_price - r) / r < 0.02:
            patterns.append(f"AT RESISTANCE: Price within 2% of resistance at {fmt(r, 'usd')}.")

    for s in key_levels['support'][:2]:
        if abs(current_price - s) / s < 0.02:
            patterns.append(f"AT SUPPORT: Price within 2% of support at {fmt(s, 'usd')}.")

    # ── TREND CHANNEL ─────────────────────────────────────────────────────────
    # Fit a linear trend to last 60 days
    if len(close) >= 60:
        recent60 = close.tail(60).values
        x = np.arange(len(recent60))
        slope, intercept = np.polyfit(x, recent60, 1)
        slope_pct = slope / recent60[0] * 100  # daily % slope

        if slope_pct > 0.15:
            patterns.append(f"STRONG UPTREND: 60-day trend slope is +{slope_pct:.2f}%/day.")
        elif slope_pct > 0.05:
            patterns.append(f"MILD UPTREND: 60-day trend slope is +{slope_pct:.2f}%/day.")
        elif slope_pct < -0.15:
            patterns.append(f"STRONG DOWNTREND: 60-day trend slope is {slope_pct:.2f}%/day.")
        elif slope_pct < -0.05:
            patterns.append(f"MILD DOWNTREND: 60-day trend slope is {slope_pct:.2f}%/day.")
        else:
            patterns.append(f"SIDEWAYS CONSOLIDATION: 60-day price trend is flat ({slope_pct:.2f}%/day).")

        key_levels['trend_slope_daily_pct'] = safe_float(slope_pct)

    # ── DOUBLE TOP / DOUBLE BOTTOM ────────────────────────────────────────────
    if len(local_highs) >= 2:
        # Two recent highs within 3% of each other above current price
        recent_highs = sorted(local_highs, reverse=True)[:5]
        for i in range(len(recent_highs) - 1):
            if abs(recent_highs[i] - recent_highs[i+1]) / recent_highs[i] < 0.03:
                if recent_highs[i] > current_price * 1.01:
                    patterns.append(f"DOUBLE TOP: Two peaks near {fmt(recent_highs[i], 'usd')} — potential reversal zone.")
                    break

    if len(local_lows) >= 2:
        recent_lows = sorted(local_lows)[:5]
        for i in range(len(recent_lows) - 1):
            if abs(recent_lows[i] - recent_lows[i+1]) / (recent_lows[i] + 0.01) < 0.03:
                if recent_lows[i] < current_price * 0.99:
                    patterns.append(f"DOUBLE BOTTOM: Two troughs near {fmt(recent_lows[i], 'usd')} — potential support base.")
                    break

    # ── VOLUME SURGE ──────────────────────────────────────────────────────────
    if len(volume) > 20:
        avg_vol = volume.tail(20).mean()
        last_vol = volume.iloc[-1]
        vol_ratio = safe_divide(last_vol, avg_vol)
        if vol_ratio > 2.5:
            patterns.append(f"VOLUME SURGE: Today's volume is {vol_ratio:.1f}x the 20-day average — institutional activity.")
        elif vol_ratio < 0.4:
            patterns.append(f"LOW VOLUME: Today's volume is only {vol_ratio:.1f}x average — lack of conviction.")

    # ── BASE FORMATION ────────────────────────────────────────────────────────
    if len(close) >= 40:
        last_40 = close.tail(40)
        range_pct = (last_40.max() - last_40.min()) / last_40.min()
        if range_pct < 0.08 and close.iloc[-1] > ma50.iloc[-1]:
            patterns.append(f"BASE FORMATION: Tight 40-day range ({range_pct:.1%}) above 50MA — potential breakout setup.")

    return patterns, key_levels

# ==========================================
# 5. MAIN ENGINE
# ==========================================
def generate_analysis_payload(ticker):
    print(f"[1/5] Today is {TODAY_STR}. Querying SEC EDGAR for {ticker}...", file=sys.stderr)

    # ── SEC DATA ──────────────────────────────────────────────────────────────
    cik           = get_cik_from_ticker(ticker)
    sec_available = cik is not None
    facts, filings, mda_text = None, [], "SEC data unavailable."
    sec_rev_val = sec_ni_val = sec_assets_val = sec_liab_val = sec_equity_val = sec_ocf_val = sec_rev_cagr = None
    filing_signals = {'8k_events': [], 'insider_buys': 0, 'insider_sells': 0, 'activist_13d': False}

    if sec_available:
        facts   = get_company_facts(cik)
        filings = get_recent_filings(cik, limit=50)

        sec_rev_val,  sec_rev_hist = safe_extract_sec(facts, 'us-gaap', 'Revenues') if facts else (None, [])
        if sec_rev_val is None:
            sec_rev_val, sec_rev_hist = safe_extract_sec(facts, 'us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax') if facts else (None, [])
        sec_ni_val,    _ = safe_extract_sec(facts, 'us-gaap', 'NetIncomeLoss')      if facts else (None, [])
        sec_assets_val,_ = safe_extract_sec(facts, 'us-gaap', 'Assets')             if facts else (None, [])
        sec_liab_val,  _ = safe_extract_sec(facts, 'us-gaap', 'Liabilities')        if facts else (None, [])
        sec_equity_val,_ = safe_extract_sec(facts, 'us-gaap', 'StockholdersEquity') if facts else (None, [])
        sec_ocf_val,   _ = safe_extract_sec(facts, 'us-gaap', 'NetCashProvidedByUsedInOperatingActivities') if facts else (None, [])

        if len(sec_rev_hist) >= 3 and sec_rev_hist[2] and sec_rev_hist[2] > 0:
            try: sec_rev_cagr = ((sec_rev_hist[0] / sec_rev_hist[2]) ** (1/2)) - 1
            except: pass

        company_name = facts.get('entityName', ticker) if facts else ticker

        latest_10k = next((f['accession_number'] for f in filings if f['form'] == '10-K'), None)
        if latest_10k:
            mda_text = extract_mda_text(cik, latest_10k)

        cutoff = TODAY - timedelta(days=90)
        for f in filings:
            try:
                if datetime.strptime(f['filing_date'], '%Y-%m-%d') >= cutoff:
                    if f['form'] == '8-K':
                        filing_signals['8k_events'].extend(parse_8k_items(cik, f['accession_number']))
                    elif f['form'] == '4':
                        tx = analyze_form4(cik, f['accession_number'])
                        filing_signals['insider_buys']  += tx['buys']
                        filing_signals['insider_sells'] += tx['sells']
                    elif f['form'] in ['SC 13D', 'SC 13D/A']:
                        filing_signals['activist_13d'] = True
            except: continue
        filing_signals['8k_events'] = list(set(filing_signals['8k_events']))

    # ── SEC FILING ATTACHMENT ────────────────────────────────────────────────
    sec_filing_attachment = None
    if sec_available and filings:
        print(f"[2/8] Downloading latest 10-K filing for attachment...", file=sys.stderr)
        sec_filing_attachment = download_latest_filing(cik, filings, ticker)

    # ── YAHOO FINANCE ─────────────────────────────────────────────────────────
    print(f"[3/8] Fetching Yahoo Finance data...", file=sys.stderr)
    try:
        stock = yf.Ticker(ticker)
        info  = stock.info or {}
    except:
        info  = {}
        stock = None

    if not sec_available:
        company_name = info.get('shortName', ticker)

    try: hist = stock.history(period="5y") if stock else pd.DataFrame()
    except: hist = pd.DataFrame()

    try: spy = yf.Ticker("SPY").history(period="5y")
    except: spy = pd.DataFrame()

    try: fin_df = stock.financials if stock else None
    except: fin_df = None

    try: cf_df = stock.cashflow if stock else None
    except: cf_df = None

    try: earnings_dates = stock.earnings_dates if stock else None
    except: earnings_dates = None

    # Current price — prefer fast_info for freshness
    try:
        current_price = stock.fast_info['lastPrice']
    except:
        current_price = hist['Close'].iloc[-1] if not hist.empty else None

    # ── REAL-TIME QUOTE & INTRADAY DATA ───────────────────────────────────────
    print(f"[4/8] Fetching live quote and intraday bars...", file=sys.stderr)
    live_quote   = get_live_quote(stock, info) if stock else {"fetched_at": datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    intraday_hist = fetch_intraday_data(stock) if stock else pd.DataFrame()

    # ── 1-YEAR DAILY PRICE HISTORY (for charting) ─────────────────────────────
    price_history_1y = get_price_history_series(hist, days=252)

    # ── VALUATION ─────────────────────────────────────────────────────────────
    pe_trail  = info.get('trailingPE')
    pe_fwd    = info.get('forwardPE')
    peg       = info.get('pegRatio')
    pb        = info.get('priceToBook')
    ps        = info.get('priceToSalesTrailing12Months')
    ev_ebitda = info.get('enterpriseToEbitda')
    mkt_cap   = info.get('marketCap')
    fcf       = info.get('freeCashflow')
    rev_yf    = info.get('totalRevenue')
    fcf_margin = safe_divide(fcf, rev_yf)    if is_valid(fcf) and is_valid(rev_yf) and rev_yf != 0 else None
    fcf_yield  = safe_divide(fcf, mkt_cap)   if is_valid(fcf) and is_valid(mkt_cap) and mkt_cap != 0 else None

    # ── MARGINS & PROFITABILITY ───────────────────────────────────────────────
    gross_m = info.get('grossMargins')
    op_m    = info.get('operatingMargins')
    net_m   = info.get('profitMargins')
    roe     = info.get('returnOnEquity')
    roa     = info.get('returnOnAssets')

    # ── REVENUE GROWTH ────────────────────────────────────────────────────────
    rev_1y = rev_3y = rev_5y = None
    rev_shrinking = False
    if fin_df is not None and not fin_df.empty and 'Total Revenue' in fin_df.index:
        revs = fin_df.loc['Total Revenue'].dropna()
        if len(revs) >= 2: rev_1y = safe_divide(revs.iloc[0], revs.iloc[1], 0) - 1
        if len(revs) >= 4:
            rev_3y = ((safe_divide(revs.iloc[0], revs.iloc[3], 0)) ** (1/3)) - 1
            if rev_3y < 0: rev_shrinking = True
        if len(revs) >= 5: rev_5y = ((safe_divide(revs.iloc[0], revs.iloc[4], 0)) ** (1/4)) - 1

    # ── FINANCIAL HEALTH ──────────────────────────────────────────────────────
    curr_ratio = info.get('currentRatio')
    debt_eq    = info.get('debtToEquity')
    ocf_yf     = safe_get_financial(cf_df, 'Operating Cash Flow')
    ni_yf      = safe_get_financial(fin_df, 'Net Income')
    earnings_quality = safe_divide(ocf_yf, ni_yf) if is_valid(ocf_yf) and is_valid(ni_yf) and ni_yf != 0 else None

    # ── PRICE & TECHNICALS ────────────────────────────────────────────────────
    latest = current_price
    prev   = hist['Close'].iloc[-2] if len(hist) > 1 else latest
    daily_change = safe_divide((latest - prev), prev) if latest and prev else 0

    high_52w = hist['High'].tail(252).max() if not hist.empty else None
    low_52w  = hist['Low'].tail(252).min()  if not hist.empty else None
    high_5y  = hist['High'].max()           if not hist.empty else None
    low_5y   = hist['Low'].min()            if not hist.empty else None

    pct_from_52_high = safe_divide((latest - high_52w), high_52w) if latest and high_52w else 0
    pct_from_5y_high = safe_divide((latest - high_5y),  high_5y)  if latest and high_5y  else 0

    ma_50  = hist['Close'].rolling(50).mean().iloc[-1]  if not hist.empty else None
    ma_200 = hist['Close'].rolling(200).mean().iloc[-1] if not hist.empty else None

    # RSI
    rsi_latest = 50.0
    if not hist.empty:
        delta    = hist['Close'].diff()
        gain     = delta.where(delta > 0, 0.0)
        loss     = -delta.where(delta < 0, 0.0)
        avg_gain = gain.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
        rs = safe_divide(avg_gain.iloc[-1], avg_loss.iloc[-1], 1.0)
        rsi_latest = 100 - (100 / (1 + rs))

    # Volume
    avg_volume    = hist['Volume'].rolling(20).mean().iloc[-1] if not hist.empty else 0
    latest_volume = hist['Volume'].iloc[-1]                    if not hist.empty else 0
    volume_ratio  = safe_divide(latest_volume, avg_volume) if avg_volume > 0 else 1.0

    # CAGR, Volatility, Sharpe, Max Drawdown, Beta
    cagr = annual_vol = sharpe = max_drawdown = 0.0
    beta = np.nan
    if not hist.empty and len(hist) > 200:
        daily_returns = hist['Close'].pct_change().dropna()
        years = len(hist) / 252
        cagr  = ((safe_divide(latest, hist['Close'].iloc[0])) ** (1 / years)) - 1 if years > 0 else 0
        annual_vol = daily_returns.std() * np.sqrt(252)
        cumulative = (1 + daily_returns).cumprod()
        peak       = cumulative.expanding(min_periods=1).max()
        max_drawdown = safe_divide((cumulative - peak), peak).min()
        rf_rate = get_risk_free_rate()
        sharpe  = safe_divide((cagr - rf_rate), annual_vol)
        if not spy.empty:
            spy_returns = spy['Close'].pct_change().dropna()
            aligned = pd.DataFrame({'stock': daily_returns, 'spy': spy_returns}).dropna()
            if len(aligned) > 30:
                beta = safe_divide(aligned['stock'].cov(aligned['spy']), aligned['spy'].var())

    spy_vol = spy['Close'].pct_change().dropna().std() * np.sqrt(252) if not spy.empty else np.nan

    # ── SENTIMENT & EARNINGS ──────────────────────────────────────────────────
    short_float = info.get('shortPercentOfFloat')
    target_mean = info.get('targetMeanPrice')
    target_high = info.get('targetHighPrice')
    target_low  = info.get('targetLowPrice')
    rec_key     = info.get('recommendationKey', 'N/A')
    inst_own    = info.get('heldPercentInstitutions')
    insider_own = info.get('heldPercentInsiders')
    next_earnings = info.get('earningsDate') or info.get('earningsTimestamp')

    beats, misses = 0, 0
    recent_earnings = []
    if earnings_dates is not None and not earnings_dates.empty:
        for idx, row in earnings_dates.head(4).iterrows():
            est = row.get('EPS Estimate')
            rep = row.get('Reported EPS')
            if pd.notna(est) and pd.notna(rep):
                surprise = safe_divide((rep - est), abs(est)) if est != 0 else 0
                recent_earnings.append({
                    "date": str(idx.date()) if hasattr(idx, 'date') else str(idx),
                    "estimate": float(est), "reported": float(rep),
                    "surprise_pct": float(surprise)
                })
                if rep > est: beats += 1
                elif rep < est: misses += 1

    # ── OPTIONS CHAIN ─────────────────────────────────────────────────────────
    print(f"[3/5] Fetching live options chain...", file=sys.stderr)
    options_data = fetch_options_chain(stock, latest or 0) if stock and latest else {'available_expirations': [], 'chains': [], 'iv_summary': {}}

    # ── CHART PATTERNS ────────────────────────────────────────────────────────
    print(f"[4/5] Detecting chart patterns...", file=sys.stderr)
    chart_patterns, key_levels = detect_chart_patterns(hist, latest or 0)

    # ── ALGORITHMIC FLAGS ─────────────────────────────────────────────────────
    print(f"[5/5] Generating signals...", file=sys.stderr)
    flags         = []
    data_warnings = []

    if is_valid(pe_trail, -1000, 10000):
        if pe_trail <= 0:    data_warnings.append("P/E <= 0: Company unprofitable or large one-time items.")
        elif pe_trail > 500: flags.append(f"EXTREME VALUATION: Trailing P/E is {pe_trail:.2f} (>500).")
    if is_valid(peg, -10, 50):
        if peg < 0:   flags.append("NEGATIVE PEG: Earnings growth is negative or anomalous.")
        elif peg > 5: flags.append(f"EXTREME PEG: {peg:.2f} — massive overvaluation or negative growth.")
    if is_valid(debt_eq, 0, 5000) and debt_eq > 500:
        flags.append(f"EXTREME LEVERAGE: Debt/Equity is {debt_eq:.2f} (>500).")
    if is_valid(earnings_quality) and ni_yf and ni_yf > 0 and earnings_quality < 0.5:
        flags.append("RED FLAG: Earnings Quality < 0.5 — cash flow doesn't match reported profits.")

    if sec_available:
        if sec_ni_val is not None and sec_ni_val < 0:
            flags.append("NET LOSS: Company reported a net loss in the latest 10-K (SEC verified).")
        if sec_rev_cagr is not None and sec_rev_cagr < 0:
            flags.append(f"DECLINING TOP LINE: 3Y Revenue CAGR is {sec_rev_cagr:.2%} (SEC verified).")
        if sec_liab_val and sec_equity_val and sec_equity_val != 0:
            lev = safe_divide(sec_liab_val, sec_equity_val)
            if lev > 2.0: flags.append(f"HIGH LEVERAGE: Liabilities are {lev:.1f}x Equity (SEC verified).")
        if filing_signals['insider_buys'] > filing_signals['insider_sells'] > 0:
            flags.append(f"NET INSIDER BUYING: {filing_signals['insider_buys']} purchases vs {filing_signals['insider_sells']} sales (Form 4, 90D).")
        elif filing_signals['insider_sells'] >= 5 and filing_signals['insider_sells'] > filing_signals['insider_buys']:
            flags.append(f"HEAVY INSIDER SELLING: {filing_signals['insider_sells']} sales vs {filing_signals['insider_buys']} purchases (Form 4, 90D).")
        if filing_signals['activist_13d']:
            flags.append("ACTIVIST ALERT: New 13D filing — large position being established.")

    if is_valid(peg) and rev_3y is not None:
        if peg < 1.0 and rev_shrinking:
            flags.append(f"FAKE VALUE: PEG is {peg:.2f} but 3Y Revenue CAGR is negative ({rev_3y:.2%}).")
        elif peg < 1.0:
            flags.append(f"FUNDAMENTAL VALUE: PEG Ratio is {peg:.2f} (< 1.0).")
        elif peg > 2.0 and rev_3y < 0.05:
            flags.append(f"EXPENSIVE STABILITY: PEG {peg:.2f} with only {rev_3y:.2%} 3Y growth.")

    if latest and ma_50 and ma_200:
        if latest > ma_50 > ma_200:   flags.append("BULLISH ALIGNMENT: Price > 50MA > 200MA.")
        elif latest < ma_50 < ma_200: flags.append("BEARISH ALIGNMENT: Price < 50MA < 200MA.")
        elif latest > ma_50 and latest < ma_200: flags.append("RECOVERY MODE: Price > 50MA but < 200MA.")

    if rsi_latest > 75:    flags.append("EXTREME OVERBOUGHT: RSI > 75.")
    elif rsi_latest >= 65: flags.append("MOMENTUM STRETCH: RSI >= 65.")
    elif rsi_latest < 25:  flags.append("EXTREME OVERSOLD: RSI < 25.")

    if daily_change > 0 and volume_ratio < 0.85:
        flags.append(f"WEAK CONFIRMATION: Rising price on {volume_ratio:.2f}x average volume.")
    if pct_from_5y_high < -0.50:
        flags.append(f"CYCLE LOWS: Trading {pct_from_5y_high:.1%} below 5-year high.")
    if is_valid(spy_vol) and spy_vol > 0 and (annual_vol / spy_vol) > 2.5:
        flags.append(f"EXTREME IDIOSYNCRATIC RISK: {annual_vol/spy_vol:.1f}x more volatile than SPY.")
    if is_valid(short_float) and short_float > 0.10:
        flags.append(f"HIGH SHORT INTEREST: {short_float:.1%} of float shorted.")
    if misses >= 3: flags.append(f"EARNINGS: Missed estimates {misses}/4 recent quarters.")
    if beats == 4:  flags.append("EARNINGS: Beat estimates all 4 recent quarters.")

    # ── BUILD AI PROMPT ───────────────────────────────────────────────────────
    ai_prompt = f"""⚠️ TODAY'S DATE: {TODAY_STR}. All data below was fetched live on this date. Every expiration date, price level, and recommendation must be evaluated relative to {TODAY_STR}. Do NOT reference any options expiration that has already passed. Do NOT invent strikes, expirations, or prices not listed below.

You are an expert quantitative financial analyst. Analyze **{company_name} ({ticker})** using the data below.

### 1. COMPANY PROFILE
- **Sector / Industry**: {info.get('sector','N/A')} / {info.get('industry','N/A')}
- **Business Summary**: {info.get('longBusinessSummary','N/A')[:500]}...
- **Next Earnings Date**: {str(next_earnings) if next_earnings else 'N/A'}

### 2. SEC-VERIFIED FUNDAMENTALS (Latest 10-K)
- **Revenue**: {fmt(sec_rev_val,'usd')} | **Net Income**: {fmt(sec_ni_val,'usd')}
- **Total Assets**: {fmt(sec_assets_val,'usd')} | **Total Liabilities**: {fmt(sec_liab_val,'usd')} | **Equity**: {fmt(sec_equity_val,'usd')}
- **Operating Cash Flow**: {fmt(sec_ocf_val,'usd')}
- **Revenue CAGR (3Y, SEC)**: {fmt(sec_rev_cagr,'pct')}
{"- ⚠️ SEC data unavailable." if not sec_available else ""}

### 3. VALUATION
- **Market Cap / EV**: {fmt(mkt_cap,'usd')} / {fmt(info.get('enterpriseValue'),'usd')}
- **P/E (Trailing / Forward) / PEG**: {fmt(pe_trail,'ratio')} / {fmt(pe_fwd,'ratio')} / {fmt(peg,'ratio')}
- **Price/Book / Price/Sales / EV/EBITDA**: {fmt(pb,'ratio')} / {fmt(ps,'ratio')} / {fmt(ev_ebitda,'ratio')}
- **FCF Yield / FCF Margin**: {fmt(fcf_yield,'pct')} / {fmt(fcf_margin,'pct')}

### 4. PROFITABILITY & GROWTH
- **Gross / Operating / Net Margin**: {fmt(gross_m,'pct')} / {fmt(op_m,'pct')} / {fmt(net_m,'pct')}
- **ROE / ROA**: {fmt(roe,'pct')} / {fmt(roa,'pct')}
- **Revenue Growth (1Y / 3Y CAGR / 5Y CAGR)**: {fmt(rev_1y,'pct')} / {fmt(rev_3y,'pct')} / {fmt(rev_5y,'pct')}

### 5. FINANCIAL HEALTH
- **Current Ratio / Debt/Equity**: {fmt(curr_ratio,'ratio')} / {fmt(debt_eq,'ratio')}
- **Earnings Quality (OCF/NI)**: {fmt(earnings_quality,'ratio')}

### 6. PRICE, RISK & MOMENTUM (as of {TODAY_STR})
- **Current Price**: {fmt(latest,'usd')} ({fmt(daily_change,'pct')} today)
- **52-Week Range**: {fmt(low_52w,'usd')} — {fmt(high_52w,'usd')} ({fmt(pct_from_52_high,'pct')} from 52W high)
- **5-Year Range**: {fmt(low_5y,'usd')} — {fmt(high_5y,'usd')} ({fmt(pct_from_5y_high,'pct')} from 5Y high)
- **50-Day / 200-Day MA**: {fmt(ma_50,'usd')} / {fmt(ma_200,'usd')}
- **Bollinger Upper / Lower**: {fmt(key_levels.get('bb_upper'),'usd')} / {fmt(key_levels.get('bb_lower'),'usd')} (width: {fmt(key_levels.get('bb_width_pct'),'pct')})
- **MACD / Signal / Histogram**: {fmt(key_levels.get('macd'),'ratio')} / {fmt(key_levels.get('macd_signal'),'ratio')} / {fmt(key_levels.get('macd_hist'),'ratio')}
- **RSI (14)**: {fmt(rsi_latest,'ratio')}
- **5Y CAGR / Max Drawdown**: {fmt(cagr,'pct')} / {fmt(max_drawdown,'pct')}
- **Sharpe Ratio / Beta**: {fmt(sharpe,'ratio')} / {fmt(beta,'ratio')}
- **Volume Ratio**: {fmt(volume_ratio,'ratio')}x 20-day avg

### 7. KEY PRICE LEVELS
- **Resistance levels**: {', '.join([fmt(r,'usd') for r in key_levels.get('resistance',[])]) or 'N/A'}
- **Support levels**: {', '.join([fmt(s,'usd') for s in key_levels.get('support',[])]) or 'N/A'}

### 8. CHART PATTERNS DETECTED (as of {TODAY_STR})
"""
    if chart_patterns:
        for p in chart_patterns: ai_prompt += f"- {p}\n"
    else:
        ai_prompt += "- No strong patterns detected.\n"

    ai_prompt += f"""
### 9. SENTIMENT & OWNERSHIP
- **Analyst Price Target (Mean / High / Low)**: {fmt(target_mean,'usd')} / {fmt(target_high,'usd')} / {fmt(target_low,'usd')}
- **Consensus**: {rec_key.replace('-',' ').title()}
- **Institutional / Insider Ownership**: {fmt(inst_own,'pct')} / {fmt(insider_own,'pct')}
- **Short Interest**: {fmt(short_float,'pct')}

### 10. RECENT EARNINGS SURPRISES
"""
    if recent_earnings:
        for e in recent_earnings:
            ai_prompt += f"- {e['date']}: Est ${e['estimate']:.2f} | Rep ${e['reported']:.2f} | Surprise {fmt(e['surprise_pct'],'pct')}\n"
    else:
        ai_prompt += "- No earnings data available.\n"

    if sec_available:
        ai_prompt += f"""
### 11. SEC FILING SIGNALS (Last 90 Days)
- **8-K Events**: {', '.join(filing_signals['8k_events']) if filing_signals['8k_events'] else 'None'}
- **Insider Trading (Form 4)**: {filing_signals['insider_buys']} Buys | {filing_signals['insider_sells']} Sells
- **Activist (13D)**: {'YES' if filing_signals['activist_13d'] else 'No'}
"""

    ai_prompt += f"\n### 12. ALGORITHMIC SIGNALS\n"
    for flag in (flags or ["NEUTRAL: No strong signals."]): ai_prompt += f"- {flag}\n"

    if data_warnings:
        ai_prompt += "\n### DATA QUALITY NOTES\n"
        for w in data_warnings: ai_prompt += f"- {w}\n"

    # Options chain section
    if options_data['chains']:
        ai_prompt += f"""
### 13. LIVE OPTIONS CHAIN (Fetched {TODAY_STR})
⚠️ Only use the strikes and expirations listed below. Do NOT invent any others.
Available expirations (future only): {', '.join(options_data['available_expirations'])}
"""
        for chain in options_data['chains']:
            ai_prompt += f"\n**Expiry: {chain['expiration']} ({chain['days_to_exp']} days out) | ATM Strike: {fmt(chain['atm_strike'],'usd')}**\n"
            ai_prompt += "CALLS:\n"
            for c in chain['calls']:
                ai_prompt += (f"  Strike {fmt(c['strike'],'usd')} | Bid/Ask {fmt(c['bid'],'usd')}/{fmt(c['ask'],'usd')} "
                              f"| IV {fmt(c['iv'],'pct')} | OI {c['open_interest']:,} | Vol {c['volume']:,}"
                              f"{' [ITM]' if c['in_the_money'] else ''}\n")
            ai_prompt += "PUTS:\n"
            for p in chain['puts']:
                ai_prompt += (f"  Strike {fmt(p['strike'],'usd')} | Bid/Ask {fmt(p['bid'],'usd')}/{fmt(p['ask'],'usd')} "
                              f"| IV {fmt(p['iv'],'pct')} | OI {p['open_interest']:,} | Vol {p['volume']:,}"
                              f"{' [ITM]' if p['in_the_money'] else ''}\n")
    else:
        ai_prompt += "\n### 13. OPTIONS DATA\n- Options chain unavailable for this ticker.\n"

    if sec_available and mda_text and "unavailable" not in mda_text and "Failed" not in mda_text:
        ai_prompt += f"\n### 14. MD&A EXCERPT (Latest 10-K)\n\"{mda_text}\"\n"

    ai_prompt += f"""
---
### ANALYSIS INSTRUCTIONS
Today is {TODAY_STR}. Use this throughout your response.

1. **Options**: Only reference strikes and expirations from Section 13. If asked about calls/puts, give specific strike + expiry from the live data, estimated premium (bid/ask midpoint), breakeven, and max loss.
2. **Chart Patterns**: Interpret the detected patterns in Section 8 as a cohesive picture. What is the chart setup telling you?
3. **Cross-Reference SEC vs Yahoo**: Prefer SEC data for fundamentals. Flag any discrepancies.
4. **Validate Signals**: Do the algorithmic flags hold up? Call out misleading ones.
5. **MD&A Consistency**: Is management's narrative in line with the numbers?
6. **Verdict**: Undervalued / Fairly Valued / Overvalued — with a defined risk/reward.
7. **Format**: Clear headings, bullets, bold key figures. Be direct and analytical.
"""

    # ── FINAL PAYLOAD ─────────────────────────────────────────────────────────
    return {
        "ticker":            ticker,
        "cik":               cik,
        "company_name":      company_name,
        "today":             TODAY_STR,
        "sec_available":     sec_available,
        "raw_data": {
            "valuation":       {"pe_trailing": safe_float(pe_trail), "pe_forward": safe_float(pe_fwd),
                                "peg_ratio": safe_float(peg), "price_to_book": safe_float(pb),
                                "price_to_sales": safe_float(ps), "ev_ebitda": safe_float(ev_ebitda),
                                "fcf_yield": safe_float(fcf_yield)},
            "profitability":   {"gross_margin": safe_float(gross_m), "operating_margin": safe_float(op_m),
                                "net_margin": safe_float(net_m), "roe": safe_float(roe),
                                "roa": safe_float(roa), "fcf_margin": safe_float(fcf_margin)},
            "financial_health":{"current_ratio": safe_float(curr_ratio), "debt_to_equity": safe_float(debt_eq),
                                 "earnings_quality": safe_float(earnings_quality)},
            "sec_fundamentals":{"revenue": safe_float(sec_rev_val), "net_income": safe_float(sec_ni_val),
                                 "assets": safe_float(sec_assets_val), "liabilities": safe_float(sec_liab_val),
                                 "equity": safe_float(sec_equity_val), "ocf": safe_float(sec_ocf_val),
                                 "rev_cagr_3y": safe_float(sec_rev_cagr)},
            "technicals":      {"current_price": safe_float(latest), "daily_change": safe_float(daily_change),
                                 "high_52w": safe_float(high_52w), "low_52w": safe_float(low_52w),
                                 "pct_from_52_high": safe_float(pct_from_52_high),
                                 "ma_50": safe_float(ma_50), "ma_200": safe_float(ma_200),
                                 "rsi_14": safe_float(rsi_latest), "volume_ratio": safe_float(volume_ratio),
                                 "macd": safe_float(key_levels.get('macd')),
                                 "macd_signal": safe_float(key_levels.get('macd_signal')),
                                 "bb_upper": safe_float(key_levels.get('bb_upper')),
                                 "bb_lower": safe_float(key_levels.get('bb_lower'))},
            "risk_return":     {"cagr": safe_float(cagr), "max_drawdown": safe_float(max_drawdown),
                                 "sharpe": safe_float(sharpe), "annual_volatility": safe_float(annual_vol),
                                 "beta": safe_float(beta)},
            "sentiment":       {"target_mean": safe_float(target_mean), "target_high": safe_float(target_high),
                                 "target_low": safe_float(target_low), "rec_key": rec_key,
                                 "inst_ownership": safe_float(inst_own), "short_percent": safe_float(short_float)},
            "earnings_surprises": recent_earnings,
            "key_levels":     {k: ([safe_float(x) for x in v] if isinstance(v, list) else safe_float(v))
                               for k, v in key_levels.items()}
        },
        "chart_patterns":    chart_patterns,
        "filing_activity":   filing_signals,
        "options_data":      options_data,
        "mda_excerpt":       mda_text,
        "algorithmic_signals": flags,
        "ai_prompt":         ai_prompt
    }

# ==========================================
# 6. ENTRY POINT
# ==========================================
if __name__ == "__main__":
    target_ticker = sys.argv[1].upper() if len(sys.argv) > 1 else "AAPL"
    try:
        result = generate_analysis_payload(target_ticker)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e), "ticker": target_ticker}))