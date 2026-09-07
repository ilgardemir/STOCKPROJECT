"""Numerical conventions shared by the live, screening and historical engines.

Pure calculations only: no provider calls and no silent substitution of missing data.
"""
import math
import numpy as np
import pandas as pd


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError, OverflowError):
        return None


def first_number(*values):
    return next((v for value in values if (v := number(value)) is not None), None)


def positive_ratio(numerator, denominator):
    n, d = number(numerator), number(denominator)
    return number(n / d) if n is not None and d is not None and d > 0 else None


def percent_fraction(value):
    value = number(value)
    return value / 100 if value is not None else None


def wilder_rsi(close, period=14):
    """Wilder seed = first n changes; subsequent averages use alpha=1/n.

    Restart warm-up after a missing price. Flat windows are neutral (50),
    rising-only windows are 100, falling-only windows are 0.
    """
    close = pd.to_numeric(close, errors="coerce")
    result = pd.Series(np.nan, index=close.index, dtype=float)
    prior = None
    gains, losses = [], []
    avg_gain = avg_loss = None
    for i, raw in enumerate(close):
        value = number(raw)
        if value is None or value <= 0:
            prior = None; gains = []; losses = []; avg_gain = avg_loss = None
            continue
        if prior is None:
            prior = value
            continue
        change = value - prior; prior = value
        gain, loss = max(change, 0), max(-change, 0)
        if avg_gain is None:
            gains.append(gain); losses.append(loss)
            if len(gains) < period:
                continue
            avg_gain, avg_loss = sum(gains) / period, sum(losses) / period
        else:
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
        result.iloc[i] = (50.0 if avg_gain == avg_loss == 0 else 100.0 if avg_loss == 0
                          else 100 - 100 / (1 + avg_gain / avg_loss))
    return result


def annual_cagr(rows, years):
    """Rows are dated annual observations. Missing fiscal years do not shrink the window."""
    valid = {}
    for row in rows:
        date = pd.to_datetime(row.get("end"), errors="coerce")
        value = number(row.get("val"))
        if pd.notna(date) and value is not None:
            valid[date] = value
    if not valid:
        return None
    latest = max(valid)
    # Calendar tolerance permits 52/53-week fiscal calendars, not another fiscal year.
    candidates = [d for d in valid if abs((latest - d).days - years * 365.25) <= 35]
    if not candidates:
        return None
    start = min(candidates, key=lambda d: abs((latest - d).days - years * 365.25))
    first, last = valid[start], valid[latest]
    if first <= 0 or last < 0:
        return None
    elapsed = (latest - start).days / 365.25
    return number((last / first) ** (1 / elapsed) - 1)


def adjusted_close(frame):
    """Yahoo already provides adjclose. Do not silently call raw prices total returns."""
    if frame is None or frame.empty:
        return pd.Series(dtype=float)
    cols = {str(c).lower().replace(' ', ''): c for c in frame.columns}
    col = cols.get('adjclose')
    if col is None:
        return pd.Series(dtype=float)
    values = pd.to_numeric(frame[col], errors='coerce')
    values = values.where(values > 0).replace([np.inf, -np.inf], np.nan)
    values.index = pd.to_datetime(values.index, errors='coerce', utc=True).normalize()
    return values[~values.index.isna()].groupby(level=0).last().sort_index()


def risk_statistics(prices, benchmark=None, bill_yields=None):
    """Adjusted daily returns, sample SD, initial wealth included in drawdown.

    bill_yields is a dated annual quoted-yield fraction, lagged before use. Sharpe
    uses yield/252 as an explicitly approximate cash return, not a bond total return.
    """
    out = dict(cagr=None, max_drawdown=None, sharpe=None, annual_volatility=None,
               beta=None, period_start=None, period_end=None, observations=0,
               price_basis='dividend-adjusted close',
               sharpe_basis='Lagged 13-week Treasury bill quoted yield / 252 cash-return approximation')
    if prices is None or prices.empty:
        return out
    prices = prices.sort_index()
    valid = prices.dropna()
    if len(valid) < 2:
        return out
    out.update(period_start=str(valid.index[0].date()), period_end=str(valid.index[-1].date()), observations=len(valid))
    years = (valid.index[-1] - valid.index[0]).days / 365.25
    out['cagr'] = number((valid.iloc[-1] / valid.iloc[0]) ** (1 / years) - 1) if years >= 1 else None
    out['max_drawdown'] = number((valid / valid.cummax() - 1).min())
    returns = prices.pct_change(fill_method=None).replace([np.inf, -np.inf], np.nan).dropna()
    if len(returns) >= 20:
        out['annual_volatility'] = number(returns.std(ddof=1) * np.sqrt(252))
        if bill_yields is not None and not bill_yields.empty:
            rates = bill_yields.copy()
            rates.index = pd.to_datetime(rates.index, errors='coerce', utc=True).normalize()
            rates = rates[~rates.index.isna()].groupby(level=0).last().sort_index()
            rates = pd.to_numeric(rates, errors='coerce').where(lambda x: x > -1)
            # Use only yields observable before each return interval; never backfill.
            rates = rates.reindex(prices.index, method='ffill', tolerance=pd.Timedelta(days=7))
            rates = rates.shift(1).reindex(returns.index)
            excess = (returns - rates / 252).dropna()
            if len(excess) >= max(20, .9 * len(returns)) and excess.std(ddof=1) > 0:
                out['sharpe'] = number(excess.mean() / excess.std(ddof=1) * np.sqrt(252))
    if benchmark is not None and not benchmark.empty:
        pair = pd.concat([returns.rename('stock'), benchmark.pct_change(fill_method=None).rename('market')],axis=1, sort=True).dropna()
        if len(pair) >= 30 and pair.market.var(ddof=1) > 0:
            out['beta'] = number(pair.stock.cov(pair.market) / pair.market.var(ddof=1))
    return out


def return_windows(prices, benchmark=None):
    """Complete session windows only; beta uses matched dates within each window."""
    result = []
    for sessions in (20, 60, 252):
        window = prices.tail(sessions + 1)
        row = dict(sessions=sessions, observations=len(window), return_fraction=None,
                   volatility=None, downside_deviation=None, beta=None, start=None, end=None)
        if len(window) == sessions + 1 and window.notna().all():
            stats = risk_statistics(window, benchmark)
            daily = window.pct_change(fill_method=None).dropna()
            row.update(return_fraction=number(window.iloc[-1] / window.iloc[0] - 1),
                       volatility=stats['annual_volatility'], beta=stats['beta'],
                       downside_deviation=number(np.sqrt(np.mean(np.minimum(daily, 0) ** 2) * 252)),
                       start=stats['period_start'], end=stats['period_end'])
        result.append(row)
    return result
