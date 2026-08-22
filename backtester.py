#!/usr/bin/env python3
"""Point-in-time single-stock analyzer backtester.

stdin: {"query": "AAPL", "as_of": "2023-03-15"}
stdout: one JSON payload. Progress and diagnostics go to stderr only.

The AI prompt is built exclusively from the snapshot. Forward outcomes remain in a
separate top-level object so the Node server can withhold them until the AI finishes.
"""
from datetime import date, datetime, timedelta, timezone
import json
import math
import sys
import traceback

import pandas as pd
from yahooquery import Ticker

import scraperFinal as scraper
import screener


HORIZONS = {"1m": 21, "3m": 63, "6m": 126}
FORMS = {"10-K", "10-K/A", "10-Q", "10-Q/A"}
FACTS = {
    "revenue": (["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], "USD"),
    "net_income": (["NetIncomeLoss", "ProfitLoss"], "USD"),
    "operating_income": (["OperatingIncomeLoss"], "USD"),
    "operating_cash_flow": (["NetCashProvidedByUsedInOperatingActivities"], "USD"),
    "assets": (["Assets"], "USD"),
    "liabilities": (["Liabilities"], "USD"),
    "equity": (["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "USD"),
    "cash": (["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], "USD"),
    "diluted_eps": (["EarningsPerShareDiluted"], "USD/shares"),
    "shares_outstanding": (["CommonStockSharesOutstanding", "EntityCommonStockSharesOutstanding"], "shares"),
    "gross_profit": (["GrossProfit"], "USD"),
    "cost_of_revenue": (["CostOfRevenue", "CostOfGoodsAndServicesSold"], "USD"),
    "current_assets": (["AssetsCurrent"], "USD"),
    "current_liabilities": (["LiabilitiesCurrent"], "USD"),
    "long_term_debt": (["LongTermDebtNoncurrent", "LongTermDebt"], "USD"),
    "short_term_debt": (["DebtCurrent", "ShortTermBorrowings"], "USD"),
    "depreciation": (["DepreciationDepletionAndAmortization", "DepreciationAndAmortization"], "USD"),
    "capex": (["PaymentsToAcquirePropertyPlantAndEquipment"], "USD"),
}


def progress(percent, label):
    print(f"PROGRESS|{int(max(0, min(100, percent)))}|{label}", file=sys.stderr, flush=True)


def finite(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def parse_as_of(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise ValueError("as_of must be a real date in YYYY-MM-DD format")


def dated_frame(frame):
    if not isinstance(frame, pd.DataFrame) or frame.empty:
        return pd.DataFrame()
    out = frame.copy()
    try:
        index = pd.to_datetime(out.index)
        if getattr(index, "tz", None) is not None:
            index = index.tz_localize(None)
        out.index = index.normalize()
    except (TypeError, ValueError):
        return pd.DataFrame()
    return out[~out.index.duplicated(keep="last")].sort_index()


def adjusted_frame(frame):
    """
    Split- and dividend-adjusted OHLC derived from the adjclose/close ratio.

    We adjust here rather than asking yahooquery for adj_ohlc=True so that the
    adjustment is ours to inspect and to report on. Adjusted drives returns and
    technicals: the factors cancel in any ratio, so returns are unaffected by
    post-cutoff events.

    WHAT THIS DOES NOT GIVE YOU (measured, 2026-08-22): Yahoo's `close` is ALREADY
    split-adjusted, so close/adjclose captures DIVIDENDS ONLY. NVDA at 2024-05-01
    returns 83.04 from the unadjusted column against a real traded close of ~830 —
    the June-2024 10:1 split is baked into both. There is therefore no as-reported
    price anywhere in this source, and valuation against as-reported XBRL per-share
    figures needs a different one. Do not reintroduce a field implying otherwise.

    Returns (frame, adjusted) so the caller can tell a real adjustment from a
    fall-through. Silence here is dangerous in a way the old code was not: with
    adj_ohlc=True a missing adjclose surfaced as an exception out of yahooquery, and
    fetch_history turned that into a WARN and a retry. Deriving the basis ourselves,
    the same condition degrades to "returned the raw frame and said nothing" — and a
    raw frame spanning a split reports a ~-90% return that nothing would question.
    """
    if not isinstance(frame, pd.DataFrame) or frame.empty:
        return pd.DataFrame(), False
    out = frame.copy()
    close_col, adj_col = _column(out, "close"), _column(out, "adjclose")
    if close_col is None or adj_col is None:
        print("WARN|backtest_basis|no_adjclose_column", file=sys.stderr, flush=True)
        return out, False
    ratio = pd.to_numeric(out[adj_col], errors="coerce") / pd.to_numeric(out[close_col], errors="coerce")
    ratio = ratio.replace([float("inf"), float("-inf")], float("nan"))
    # A column that exists but is entirely null is the same no-op as a missing one,
    # and _column cannot see the difference. Yahoo does return null adjclose for a
    # symbol in a batch response, so this is reachable, not defensive padding.
    if not ratio.notna().any():
        print("WARN|backtest_basis|adjclose_all_null", file=sys.stderr, flush=True)
        return out, False
    # Carry the neighbouring factor across a gap rather than substituting 1.0. The
    # adjustment factor is piecewise-constant and only steps at a split or dividend,
    # so a neighbour is right in every case; 1.0 is a raw bar dropped into an adjusted
    # series, i.e. a single 10x spike that becomes the 52-week high and poisons every
    # range, ATR and drawdown feature computed from it.
    ratio = ratio.ffill().bfill().fillna(1.0)
    for name in ("open", "high", "low", "close"):
        col = _column(out, name)
        if col is not None:
            out[col] = pd.to_numeric(out[col], errors="coerce") * ratio
    return out, True


def extract_frames(history, symbols):
    frames = {}
    if not isinstance(history, pd.DataFrame) or history.empty:
        return frames
    if isinstance(history.index, pd.MultiIndex):
        for symbol in symbols:
            try:
                part = history.xs(symbol, level=0).copy()
                if not part.empty:
                    frames[symbol] = dated_frame(part)
            except (KeyError, ValueError):
                pass
    elif len(symbols) == 1:
        frames[symbols[0]] = dated_frame(history)
    return frames


def fetch_history(symbols, as_of):
    start = as_of - timedelta(days=550)
    end = min(date.today(), as_of + timedelta(days=210)) + timedelta(days=1)
    unique = list(dict.fromkeys(symbols))
    try:
        history = Ticker(unique, asynchronous=True, max_workers=2, timeout=25).history(
            start=start.isoformat(), end=end.isoformat(), interval="1d"
        )
        frames = extract_frames(history, unique)
    except Exception as exc:
        print(f"WARN|backtest_history|batch|{type(exc).__name__}", file=sys.stderr, flush=True)
        frames = {}
    for symbol in unique:
        if symbol in frames:
            continue
        try:
            history = Ticker(symbol, timeout=25).history(
                start=start.isoformat(), end=end.isoformat(), interval="1d"
            )
            frames.update(extract_frames(history, [symbol]))
        except Exception as exc:
            print(f"WARN|backtest_history|{symbol}|{type(exc).__name__}", file=sys.stderr, flush=True)
    return frames


def split_at_date(frame, as_of):
    clean = dated_frame(frame)
    cutoff = pd.Timestamp(as_of)
    return clean.loc[clean.index <= cutoff], clean.loc[clean.index > cutoff]


def forward_outcomes(frame, as_of):
    before, after = split_at_date(frame, as_of)
    effective = before.index[-1].date().isoformat() if not before.empty else None
    empty = {"effective_as_of": effective, "entry_date": None, "entry_price": None,
             "returns": {}, "exit_dates": {}, "max_drawdown_6m": None}
    if before.empty or after.empty:
        return empty
    cols = {str(col).lower(): col for col in after.columns}
    close_col, open_col = cols.get("close"), cols.get("open")
    if close_col is None:
        return empty
    closes = pd.to_numeric(after[close_col], errors="coerce").dropna()
    opens = pd.to_numeric(after[open_col], errors="coerce") if open_col is not None else closes
    if closes.empty:
        return empty
    entry = finite(opens.loc[closes.index[0]]) if closes.index[0] in opens.index else None
    entry = entry or finite(closes.iloc[0])
    if not entry or entry <= 0:
        return empty
    returns, exits = {}, {}
    for label, sessions in HORIZONS.items():
        if len(closes) < sessions:
            returns[label], exits[label] = None, None
            continue
        price = finite(closes.iloc[sessions - 1])
        returns[label] = finite(price / entry - 1) if price else None
        exits[label] = closes.index[sessions - 1].date().isoformat()
    path = pd.Series([entry] + closes.iloc[:min(len(closes), HORIZONS["6m"])].tolist(), dtype=float)
    drawdown = finite((path / path.cummax() - 1).min()) if not path.empty else None
    return {"effective_as_of": effective, "entry_date": closes.index[0].date().isoformat(),
            "entry_price": entry, "returns": returns, "exit_dates": exits,
            "max_drawdown_6m": drawdown}


# yahooquery has shipped this column under more than one spelling, and the cost of a
# miss is not an error but a silent fall-through to the raw price basis.
_COLUMN_ALIASES = {"adjclose": ("adjclose", "adj_close", "adjusted_close", "adj close")}


def _column(frame, name):
    wanted = _COLUMN_ALIASES.get(name, (name,))
    for col in frame.columns:
        if str(col).lower() in wanted:
            return col
    return None


def sealed_bars(stock_frame, spy_frame, as_of, max_sessions=None):
    """
    The post-cutoff window the Node simulation replays the model's call over.

    Kept in `outcomes` rather than `snapshot` so the server's existing seal covers it:
    these bars are the future and must never reach either model call. SPY is aligned to
    the stock's session dates and padded with None where it has no bar, so the two
    series stay index-aligned for the front end without silently shortening either.
    """
    limit = max_sessions or HORIZONS["6m"]
    _, after = split_at_date(stock_frame, as_of)
    if after.empty:
        return {"dates": [], "open": [], "close": [], "spyOpen": [], "spyClose": []}
    after = after.iloc[:limit]

    open_col, close_col = _column(after, "open"), _column(after, "close")
    if close_col is None:
        return {"dates": [], "open": [], "close": [], "spyOpen": [], "spyClose": []}

    spy_after = pd.DataFrame()
    if isinstance(spy_frame, pd.DataFrame) and not spy_frame.empty:
        _, spy_after = split_at_date(spy_frame, as_of)
    spy_open_col = _column(spy_after, "open") if not spy_after.empty else None
    spy_close_col = _column(spy_after, "close") if not spy_after.empty else None

    def rounded(value):
        number = finite(value)
        return None if number is None else round(number, 4)

    dates, opens, closes, spy_opens, spy_closes = [], [], [], [], []
    for stamp, row in after.iterrows():
        dates.append(stamp.date().isoformat())
        closes.append(rounded(row[close_col]))
        opens.append(rounded(row[open_col]) if open_col is not None else rounded(row[close_col]))
        if spy_close_col is not None and stamp in spy_after.index:
            spy_row = spy_after.loc[stamp]
            spy_closes.append(rounded(spy_row[spy_close_col]))
            spy_opens.append(rounded(spy_row[spy_open_col]) if spy_open_col is not None
                             else rounded(spy_row[spy_close_col]))
        else:
            spy_closes.append(None)
            spy_opens.append(None)

    return {"dates": dates, "open": opens, "close": closes,
            "spyOpen": spy_opens, "spyClose": spy_closes}


# 10 rather than the plan's 8. A quarter-end typically contributes two rows (the
# discrete quarter and the year-to-date period), so 8 stops one row short of the
# prior-year comparative the year-to-date roll forward in ttm_value needs.
def fact_series(companyfacts, concepts, unit, as_of, limit=10):
    """
    The most recent rows for the best-tagged of `concepts`, as known at the cutoff.

    "Best" is the concept carrying the FRESHEST data, not the first that carries any.
    Filers migrate XBRL tags mid-life and leave the retired one populated: NVDA stopped
    tagging RevenueFromContractWithCustomerExcludingAssessedTax after FY2022 and moved
    to Revenues, so first-match froze revenue at FY2022 while gross profit tracked
    FY2024 -- a 165% gross margin from two different fiscal years. Concept order is
    still the tie-break, so the preferred tag wins whenever both are up to date.
    """
    cutoff = as_of.isoformat()
    best = None
    for rank, concept in enumerate(concepts):
        # dei as well as us-gaap: EntityCommonStockSharesOutstanding lives in dei, so
        # a us-gaap-only lookup made that fallback permanently unreachable.
        taxonomies = (companyfacts or {}).get("facts") or {}
        fact = (taxonomies.get("us-gaap") or {}).get(concept) or (taxonomies.get("dei") or {}).get(concept)
        units = (fact or {}).get("units") or {}
        # Record the unit actually read, not the one asked for. Falling back to an
        # arbitrary unit while still stamping the requested one renders a CAD filer
        # with a dollar sign and hands the model a currency error it cannot see.
        used_unit = unit if unit in units else (next(iter(units)) if units else None)
        rows = units.get(used_unit) or []
        eligible = []
        for row in rows:
            if row.get("form") not in FORMS or not row.get("filed") or not row.get("end"):
                continue
            if row["filed"] > cutoff or row["end"] > cutoff or finite(row.get("val")) is None:
                continue
            eligible.append({
                "value": finite(row["val"]), "unit": used_unit, "period_end": row["end"],
                "period_start": row.get("start"), "filed": row["filed"],
                "form": row.get("form"), "fiscal_year": row.get("fy"), "fiscal_period": row.get("fp"),
            })
        if not eligible:
            continue
        eligible.sort(key=lambda row: (row["filed"], row["period_end"], row.get("period_start") or ""), reverse=True)
        latest_by_period = {}
        for row in eligible:
            key = (row["period_start"], row["period_end"])
            latest_by_period.setdefault(key, row)
        series = sorted(latest_by_period.values(), key=lambda row: (row["period_end"], row["filed"]), reverse=True)[:limit]
        key = (series[0]["period_end"], -rank)
        if best is None or key > best[0]:
            best = (key, {"concept": concept, "label": fact.get("label") or concept,
                          "series": series})
    return best[1] if best else None


def _parse_day(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _period(row):
    """(start, end, span_days) for a flow row, or None if it carries no usable period."""
    start, end = _parse_day(row.get("period_start")), _parse_day(row.get("period_end"))
    if start is None or end is None:
        return None
    return start, end, (end - start).days


def _four_contiguous_quarters(quarters):
    """Sum the four most recent discrete quarters, but only if they abut."""
    by_end = {}
    for row in sorted(quarters, key=lambda r: r["end"], reverse=True):
        by_end.setdefault(row["end"], row)
    chosen = [by_end[end] for end in sorted(by_end, reverse=True)[:4]]
    if len(chosen) < 4:
        return None
    # Four quarter-length spans are not a trailing year unless they are consecutive:
    # four consecutive Q1 rows are four quarter spans and a four-year total.
    if not 330 <= (chosen[0]["end"] - chosen[-1]["start"]).days <= 400:
        return None
    return {"value": sum(row["value"] for row in chosen), "basis": "quarters",
            "period_end": chosen[0]["end"].isoformat()}


def _rolled_forward_ttm(partials, annuals):
    """
    Prior full year + current year-to-date - prior-year year-to-date.

    The case that dominates in practice: 10-Q cash-flow and comprehensive-income rows
    are cumulative from the fiscal year start, so a filer can go years without ever
    tagging a discrete quarter. Without this, every such concept falls back to an
    annual figure up to four quarters stale.
    """
    if not partials or not annuals:
        return None
    current = max(partials, key=lambda row: (row["end"], row["span"]))
    year_start_eve = current["start"] - timedelta(days=1)
    prior_year = next((row for row in annuals
                       if abs((row["end"] - year_start_eve).days) <= 5), None)
    if prior_year is None:
        return None
    target_end = current["end"] - timedelta(days=365)
    prior = next((row for row in partials
                  if abs((row["end"] - target_end).days) <= 20
                  and abs(row["span"] - current["span"]) <= 20), None)
    if prior is None:
        return None
    return {"value": prior_year["value"] + current["value"] - prior["value"],
            "basis": "derived", "period_end": current["end"].isoformat()}


# Preference when two aggregations end on the same day. Freshness wins first; this
# only breaks the tie.
_TTM_PREFERENCE = {"quarters": 0, "derived": 1, "annual": 2}


def ttm_value(fact):
    """
    Trailing twelve months from a fact series, or None.

    XBRL rows are not comparable as they arrive: 10-K rows carry full-year spans,
    10-Q rows carry quarter spans, and plenty of filers report year-to-date rather
    than discrete quarters. Summing them blind double-counts. Prefer four abutting
    discrete quarters, then a year-to-date roll forward, then the latest annual
    figure, and refuse otherwise -- a silently wrong multiple is worse than a
    missing one. Among those, the one covering the most recent period wins.
    """
    quarters, annuals, partials = [], [], []
    for row in (fact or {}).get("series") or []:
        period, value = _period(row), finite(row.get("value"))
        if period is None or value is None:
            continue
        start, end, span = period
        entry = {"value": value, "start": start, "end": end, "span": span}
        if 350 <= span <= 380:
            annuals.append(entry)
        elif 20 <= span < 350:
            partials.append(entry)
            if 80 <= span <= 100:
                quarters.append(entry)

    candidates = [candidate for candidate in
                  (_four_contiguous_quarters(quarters), _rolled_forward_ttm(partials, annuals))
                  if candidate]
    if annuals:
        latest = max(annuals, key=lambda row: row["end"])
        candidates.append({"value": latest["value"], "basis": "annual",
                           "period_end": latest["end"].isoformat()})
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c["period_end"], -_TTM_PREFERENCE[c["basis"]]), reverse=True)
    return candidates[0]


def point_in_time_value(fact):
    """Latest instantaneous value (balance-sheet items carry no period span)."""
    for row in (fact or {}).get("series") or []:
        value = finite(row.get("value"))
        if value is not None:
            return {"value": value, "period_end": row.get("period_end")}
    return None


def point_in_time_facts(companyfacts, as_of):
    return {name: result for name, (concepts, unit) in FACTS.items()
            if (result := fact_series(companyfacts, concepts, unit, as_of)) is not None}


_SUBMISSIONS_CACHE = {}


def sec_submissions(cik):
    """
    SEC's submissions document for a CIK, fetched at most once per process.

    Both the filing list and the point-in-time company name read it. Fetching twice
    would double this engine's SEC pressure for one document that cannot change
    between the two reads.
    """
    if not cik:
        return None
    if cik not in _SUBMISSIONS_CACHE:
        _SUBMISSIONS_CACHE[cik] = scraper._sec_get(
            f"https://data.sec.gov/submissions/CIK{cik}.json", "backtest_submissions",
            timeout=10, as_json=True)
    return _SUBMISSIONS_CACHE[cik]


def entity_name_at(submissions, when):
    """
    The registrant's name on `when`, from SEC's dated `formerNames` records, or None.

    This is the only genuinely historical name source available: `entityName` in
    companyfacts and `title` in the ticker directory are both today's name, so a
    company renamed after the cutoff (Facebook to Meta) would stamp a post-cutoff
    fact onto a frozen snapshot. Returns None rather than guessing when the date
    predates every record SEC holds.
    """
    stamp = str(when)[:10]
    formers = [f for f in ((submissions or {}).get("formerNames") or []) if f.get("name")]
    latest_close = ""
    for former in formers:
        start, end = str(former.get("from") or "")[:10], str(former.get("to") or "")[:10]
        if (not start or start <= stamp) and (not end or stamp <= end):
            return former["name"]
        latest_close = max(latest_close, end)
    current = (submissions or {}).get("name") or None
    # Past the last former-name window (or never renamed) the current name IS the
    # point-in-time name. Before the first one, we have no dated evidence at all.
    if current and (not formers or stamp > latest_close):
        return current
    return None


def point_in_time_filings(cik, as_of, limit=10):
    if not cik:
        return []
    payload = sec_submissions(cik)
    recent = ((payload or {}).get("filings") or {}).get("recent") or {}
    fields = ["form", "filingDate", "reportDate", "accessionNumber", "primaryDocument"]
    size = min((len(recent.get(field) or []) for field in fields), default=0)
    rows = []
    useful_forms = {"10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A", "4", "13D", "13D/A", "13G", "13G/A"}
    form4_count = 0
    for index in range(size):
        filed = recent["filingDate"][index]
        form = recent["form"][index]
        if filed > as_of.isoformat() or form not in useful_forms:
            continue
        if form == "4":
            if form4_count >= 2:
                continue
            form4_count += 1
        rows.append({
            "form": form, "filed": filed,
            "report_date": recent["reportDate"][index],
            "accession_number": recent["accessionNumber"][index],
            "primary_document": recent["primaryDocument"][index],
            # The name the registrant filed under, so company_identity has dated
            # evidence to read instead of today's entityName.
            "entity_name": entity_name_at(payload, filed),
        })
        if len(rows) >= limit:
            break
    return rows


def company_identity(ticker, companyfacts, filings=None, submissions=None, as_of=None):
    """
    The company's name AS OF the cutoff.

    companyfacts["entityName"] is today's name, so a company renamed after the cutoff
    (Facebook to Meta) would stamp a post-cutoff fact onto a frozen snapshot. Prefer a
    name carried on a filing known by the cutoff, then SEC's dated formerNames records
    directly -- `filings` comes from the submissions `recent` list, which only reaches
    back so far, and is empty for any cutoff older than that window. Fall back to the
    ticker rather than to a name we know is anachronistic.
    """
    for filing in filings or []:
        name = filing.get("entity_name")
        if name:
            return name
    if submissions is not None and as_of is not None:
        name = entity_name_at(submissions, as_of.isoformat() if hasattr(as_of, "isoformat") else as_of)
        if name:
            return name
    for row in scraper._load_sec_tickers():
        if str(row.get("ticker", "")).upper().replace(".", "-") == ticker:
            return row.get("title") or ticker
    return ticker


def technical_snapshot(before):
    features = screener.history_features(before)
    if not features:
        raise ValueError("Not enough price history existed by the selected date (at least 65 sessions are required).")
    keep = [
        "price", "return_5d", "return_20d", "return_60d", "return_126d", "return_1y",
        "rsi14", "range_15d", "range_30d", "range_60d", "atr_pct", "volume",
        "avg_volume_20d", "volume_ratio", "volume_dryup", "up_volume_ratio", "volatility",
        "max_drawdown_1y", "distance_52w_high", "distance_52w_low", "ma20", "ma50", "ma200",
        "distance_ma20", "distance_ma50", "vcp_contractions", "cup_depth", "handle_depth",
        "cup_pivot", "double_bottom_pivot", "bull_flag_impulse", "bull_flag_pullback",
    ]
    return {"metrics": {key: features.get(key) for key in keep}, "scores": features.get("scores") or {}}


# Matches the col_map in scraperFinal.YQData.history — the analyzer's signal engines
# all expect yfinance-convention capitalised columns.
SCRAPER_COLUMNS = {"open": "Open", "high": "High", "low": "Low",
                   "close": "Close", "volume": "Volume"}


def scraper_frame(frame):
    out = frame.copy()
    renames = {}
    for lower, upper in SCRAPER_COLUMNS.items():
        col = _column(out, lower)
        if col is not None:
            renames[col] = upper
    return out.rename(columns=renames)


def derived_signals(before, price):
    """
    The analyzer's four signal engines applied to pre-cutoff bars only.

    All four are pure functions of a price frame, so they reconstruct honestly at any
    cutoff. Each is wrapped independently: one engine choking on an odd frame must
    degrade its own block, not lose the other three or fail the run.
    """
    if not isinstance(before, pd.DataFrame) or before.empty:
        return {}
    hist = scraper_frame(before)
    out = {}

    def attempt(name, fn):
        try:
            return fn()
        except Exception as exc:
            print(f"WARN|backtest_signal|{name}|{type(exc).__name__}", file=sys.stderr, flush=True)
            return None

    patterns = attempt("chart_patterns", lambda: scraper.detect_chart_patterns(hist, price or 0))
    if patterns is not None:
        out["chart_patterns"], out["key_levels"] = patterns

    price_action = attempt("price_action", lambda: scraper.analyze_price_action(hist, price or 0))
    if price_action is not None:
        out["price_action"] = price_action

    institutional = attempt("institutional", lambda: scraper.analyze_institutional(hist))
    if institutional is not None:
        out["institutional"] = institutional

    if price_action is not None and institutional is not None:
        regime = attempt("market_regime",
                         lambda: scraper.classify_market_regime(hist, price_action, institutional))
        if regime is not None:
            out["market_regime"] = regime

    return out


RS_WINDOWS = {"rs_1m": 21, "rs_3m": 63, "rs_6m": 126, "rs_1y": 252}


def relative_context(before, spy_before):
    """
    Where the stock sat against the tape at the cutoff.

    SPY bars were already downloaded to score outcomes and were otherwise discarded.
    Relative strength here is stock_return - spy_return over the same window, so a
    positive number means the stock outran the index over that stretch.
    """
    if not isinstance(before, pd.DataFrame) or before.empty:
        return {}
    if not isinstance(spy_before, pd.DataFrame) or spy_before.empty:
        return {}
    stock_col, spy_col = _column(before, "close"), _column(spy_before, "close")
    if stock_col is None or spy_col is None:
        return {}

    stock = pd.to_numeric(before[stock_col], errors="coerce").dropna()
    spy = pd.to_numeric(spy_before[spy_col], errors="coerce").dropna()
    aligned = pd.DataFrame({"stock": stock, "spy": spy}).dropna()
    if len(aligned) < 65:
        return {}

    out = {}
    returns = aligned.pct_change().dropna()
    if len(returns) > 30:
        variance = finite(returns["spy"].var())
        if variance:
            out["beta_1y"] = finite(returns["stock"].cov(returns["spy"]) / variance)
        out["correlation_1y"] = finite(returns["stock"].corr(returns["spy"]))

    def window_return(series, sessions):
        if len(series) < 2:
            return None
        start = series.iloc[-min(sessions + 1, len(series))]
        end = series.iloc[-1]
        return finite(end / start - 1) if start else None

    for key, sessions in RS_WINDOWS.items():
        stock_ret = window_return(aligned["stock"], sessions)
        spy_ret = window_return(aligned["spy"], sessions)
        out[key] = finite(stock_ret - spy_ret) if stock_ret is not None and spy_ret is not None else None

    out["spy_return_1y"] = window_return(aligned["spy"], 252)
    cumulative = (1 + returns["spy"]).cumprod()
    out["spy_drawdown_1y"] = finite((cumulative / cumulative.cummax() - 1).min())

    spy_signals = derived_signals(spy_before, finite(spy.iloc[-1]))
    # classify_market_regime returns its verdict under "label". The plan called for
    # "regime", which is not a key that function has ever set: the lookup would have
    # returned None on every run and spy_regime would simply never have appeared,
    # with no warning and no failing test.
    regime = (spy_signals.get("market_regime") or {}).get("label")
    if regime:
        out["spy_regime"] = regime
    return out


def price_history_rows(before, limit=252):
    """Pre-cutoff daily bars for the chart. Rounded — six decimals of a close is noise."""
    if before is None or before.empty:
        return []
    frame = before.iloc[-limit:]
    cols = {name: _column(frame, name) for name in ("open", "high", "low", "close", "volume")}
    if cols["close"] is None:
        return []
    rows = []
    for stamp, row in frame.iterrows():
        close = finite(row[cols["close"]])
        if close is None:
            continue

        def at(name, default=None):
            col = cols[name]
            value = finite(row[col]) if col is not None else None
            return round(value, 4) if value is not None else default

        rows.append({"d": stamp.date().isoformat(), "o": at("open", round(close, 4)),
                     "h": at("high", round(close, 4)), "l": at("low", round(close, 4)),
                     "c": round(close, 4), "v": at("volume", 0)})
    return rows


# Every price-derived ratio below is divided by whatever cumulative split factor lands
# between the cutoff and today, because the only price this pipeline has is stated on
# today's share basis (see adjusted_frame). That factor is post-cutoff information by
# construction -- a split that has not happened yet leaves no trace in pre-cutoff data --
# so it cannot be recovered without breaking the seal, and it is not guessed at here.
# The caveat travels inside the block so it cannot be separated from the numbers.
BASIS_CAVEAT = (
    "UNRELIABLE IN LEVEL. pe, ps, pb, ev_ebitda, fcf_yield, market_cap and "
    "enterprise_value are computed from a split-adjusted price stated on TODAY's share "
    "basis against as-reported filing figures stated on the cutoff's basis. A stock "
    "split between this date and today divides every one of them by the split ratio, so "
    "a later 10:1 split makes them read ten times too cheap. Whether such a split "
    "happened is not knowable from data dated on or before the cutoff, so this is not "
    "corrected. Do not compare these levels against remembered multiples or call the "
    "stock cheap on them. The margins, returns and ratios in `fundamentals` use no "
    "price at all and are exact."
)
PRICE_BASIS_NOTE = (
    "Split-adjusted close at the cutoff, on the current share basis. This pipeline has "
    "no as-reported close: the unadjusted column from the price source is itself already "
    "split-adjusted."
)


def valuation_block(facts, split_adjusted_price):
    """
    Multiples and margins as they stood at the cutoff.

    Two halves with very different standing. `fundamentals` is built from filing figures
    alone -- margins, ROE, leverage, liquidity -- and is exactly right, so it is emitted
    whether or not a price exists. `valuation` needs a price, and the only price
    available is on the wrong share basis (see BASIS_CAVEAT), so it ships with the
    caveat attached rather than as a bare number the model would read as fact.
    """
    ttm = {name: ttm_value(facts.get(name)) for name in
           ("revenue", "net_income", "operating_income", "operating_cash_flow",
            "diluted_eps", "gross_profit", "cost_of_revenue", "depreciation", "capex")}
    instant = {name: point_in_time_value(facts.get(name)) for name in
               ("equity", "assets", "liabilities", "cash", "shares_outstanding",
                "current_assets", "current_liabilities", "long_term_debt", "short_term_debt")}

    def flow(name):
        return (ttm.get(name) or {}).get("value")

    def level(name):
        return (instant.get(name) or {}).get("value")

    def ratio(numerator, denominator):
        return finite(numerator / denominator) if numerator is not None and denominator else None

    revenue, net_income, eps = flow("revenue"), flow("net_income"), flow("diluted_eps")
    equity, cash = level("equity"), level("cash")
    # Plenty of filers never tag GrossProfit, so fall back to the subtraction they did tag.
    gross_profit = flow("gross_profit")
    if gross_profit is None and revenue is not None and flow("cost_of_revenue") is not None:
        gross_profit = revenue - flow("cost_of_revenue")
    debt_parts = [v for v in (level("long_term_debt"), level("short_term_debt")) if v is not None]
    debt = sum(debt_parts) if debt_parts else None
    ebitda = None
    if flow("operating_income") is not None and flow("depreciation") is not None:
        ebitda = flow("operating_income") + flow("depreciation")
    fcf = None
    if flow("operating_cash_flow") is not None and flow("capex") is not None:
        fcf = flow("operating_cash_flow") - flow("capex")

    fundamentals = {
        "gross_margin": ratio(gross_profit, revenue),
        "operating_margin": ratio(flow("operating_income"), revenue),
        "net_margin": ratio(net_income, revenue),
        "roe": ratio(net_income, equity),
        "current_ratio": ratio(level("current_assets"), level("current_liabilities")),
        "debt_to_equity": ratio(debt, equity),
        "free_cash_flow_ttm": finite(fcf),
        "ttm_basis": (ttm.get("revenue") or {}).get("basis"),
        "ttm_period_end": (ttm.get("revenue") or {}).get("period_end"),
    }

    valuation = {}
    price = finite(split_adjusted_price)
    if price and price > 0:
        shares = level("shares_outstanding")
        market_cap = price * shares if shares else None
        enterprise = market_cap + (debt or 0) - (cash or 0) if market_cap else None
        valuation = {k: v for k, v in {
            "pe": ratio(price, eps),
            "ps": ratio(market_cap, revenue),
            "pb": ratio(market_cap, equity),
            "ev_ebitda": ratio(enterprise, ebitda),
            "fcf_yield": ratio(fcf, market_cap),
            "market_cap": finite(market_cap),
            "enterprise_value": finite(enterprise),
            "ttm_basis": (ttm.get("revenue") or {}).get("basis"),
        }.items() if v is not None}
        if valuation:
            valuation["price_basis"] = PRICE_BASIS_NOTE
            valuation["per_share_ratios_reliable"] = False
            valuation["basis_caveat"] = BASIS_CAVEAT

    fundamentals = {k: v for k, v in fundamentals.items() if v is not None}
    # ttm_basis/ttm_period_end only describe other numbers; alone they are not a block.
    if not any(key not in ("ttm_basis", "ttm_period_end") for key in fundamentals):
        fundamentals = {}
    return {name: block for name, block in
            (("valuation", valuation), ("fundamentals", fundamentals)) if block}


# Blocks the model reasons from. price_history is deliberately absent: 252 bars of raw
# OHLCV would bury the analysis in numbers the derived blocks already summarise, and the
# bars exist for the chart. Anything not named here never reaches the model.
PROMPT_BLOCKS = (
    "ticker", "company_name", "as_of", "effective_market_date", "price_basis",
    "technical", "chart_patterns", "key_levels", "price_action", "institutional",
    "market_regime", "relative", "valuation", "fundamentals",
    "sec_facts", "filings_known_by_cutoff", "availability", "data_sources",
)


def build_ai_prompt(snapshot):
    projection = {key: snapshot[key] for key in PROMPT_BLOCKS if key in snapshot}
    return "\n".join([
        f"You are performing a historical stock analysis as if today were {snapshot['as_of']}.",
        "Use only the frozen snapshot below. Do not use or imply knowledge of any later price, filing, news, product event, macro event, or outcome.",
        "The snapshot intentionally contains no forward returns. Historical news, options flow, analyst estimates, and historical index membership are unavailable; say so instead of filling gaps from memory.",
        "Write a concise but substantive report with: setup at the cutoff, technical condition, fundamentals known by then, bull case, bear case, decision/watch conditions, and a confidence/data-limitations note.",
        "Treat chart-pattern scores as candidate detectors rather than facts. This is research, not individualized financial advice.",
        "\n--- FROZEN POINT-IN-TIME SNAPSHOT ---",
        json.dumps(projection, separators=(",", ":"), allow_nan=False),
    ])


def main():
    job = json.load(sys.stdin)
    as_of = parse_as_of(job.get("as_of"))
    progress(5, "Resolving the company")
    ticker, error = scraper.resolve_query(str(job.get("query") or ""))
    if error:
        raise ValueError(error)

    progress(15, f"Loading {ticker} and SPY price history")
    frames = fetch_history([ticker, "SPY"], as_of)
    if ticker not in frames:
        raise ValueError(f"No historical market data was returned for {ticker}.")
    # Two bases from one download: adjusted drives returns, technicals and the replay
    # bars; raw is the as-reported level valuation must be built from.
    raw_before, _ = split_at_date(frames[ticker], as_of)
    adjusted, stock_adjusted_ok = adjusted_frame(frames[ticker])
    spy_adjusted, spy_adjusted_ok = adjusted_frame(frames.get("SPY", pd.DataFrame()))
    before, _ = split_at_date(adjusted, as_of)
    if before.empty:
        raise ValueError(f"No market session was available for {ticker} on or before {as_of.isoformat()}.")
    # One leg adjusted and the other not makes excess_returns a subtraction across two
    # different bases — total return minus price return at best, and off by a split
    # factor at worst. The flags reach the payload; this makes it greppable in the logs.
    if stock_adjusted_ok != spy_adjusted_ok:
        print(f"WARN|backtest_basis|mixed|{ticker}={stock_adjusted_ok}|SPY={spy_adjusted_ok}",
              file=sys.stderr, flush=True)
    # As-reported price at the cutoff, for anything compared against XBRL per-share figures.
    split_adj_close_col = _column(raw_before, "close")
    split_adj_close_at_cutoff = finite(raw_before[split_adj_close_col].iloc[-1]) if split_adj_close_col is not None and not raw_before.empty else None

    progress(48, "Calculating signals using pre-cutoff bars only")
    technical = technical_snapshot(before)
    signals = derived_signals(before, (technical.get("metrics") or {}).get("price"))
    # spy_adjusted is already the adjusted SPY frame from above; re-deriving it here
    # would re-run the adjustment and, since Task 7, discard the adjusted_ok flag.
    spy_before, _ = split_at_date(spy_adjusted, as_of)
    relative = relative_context(before, spy_before)
    # Both of these MUST be adjusted: a post-cutoff split in a raw frame would report a
    # 10:1 splitter's realized return as roughly -90% and raise nothing.
    stock_outcome = forward_outcomes(adjusted, as_of)
    benchmark_outcome = forward_outcomes(spy_adjusted, as_of)

    progress(62, "Reconstructing SEC facts known at the cutoff")
    cik = scraper.get_cik_from_ticker(ticker)
    companyfacts = scraper.get_company_facts(cik) if cik else None
    facts = point_in_time_facts(companyfacts, as_of) if companyfacts else {}
    filings = point_in_time_filings(cik, as_of) if cik else []
    # Priced off the only close this pipeline has. valuation_block states plainly what
    # that basis is and does not pretend the per-share ratios are trustworthy in level.
    derived = valuation_block(facts, split_adj_close_at_cutoff)
    effective = before.index[-1].date().isoformat()
    snapshot = {
        "ticker": ticker,
        "company_name": company_identity(ticker, companyfacts, filings,
                                         submissions=sec_submissions(cik), as_of=as_of),
        "as_of": as_of.isoformat(), "effective_market_date": effective,
        # Describes what was actually done, not what was intended. Claiming an
        # adjusted basis while silently serving raw bars would put a false statement
        # into ai_prompt, which is the one place a wrong claim becomes user-visible
        # prose rather than a number someone can sanity-check.
        "price_basis": (
            "Split- and dividend-adjusted daily OHLCV. NOTE: prices are stated on the "
            "CURRENT share basis, so a split after this date has already been applied "
            "and these levels may never have traded. Do not compute a per-share ratio "
            "against as-reported filing figures."
            if stock_adjusted_ok else
            "Split-adjusted, NOT dividend-adjusted daily OHLCV — the dividend-adjusted "
            "basis was unavailable, so returns spanning a dividend may be understated."
        ),
        # Measured, not assumed: Yahoo's `close` is ALREADY split-adjusted, so
        # close/adjclose captures dividends only. Verified live — NVDA 2024-05-01
        # returns 83.04 here against a real traded close of ~830, i.e. the June-2024
        # 10:1 split is baked into both columns. There is therefore NO as-reported
        # price available from this source; naming this field as if there were is how
        # a wrong P/E gets computed with confidence. valuation_block prices off this
        # and says so; there is no other source that does not break the seal.
        "split_adjusted_close": split_adj_close_at_cutoff,
        "technical": technical,
        **signals,
        "relative": relative,
        **derived,
        "price_history": price_history_rows(before),
        "sec_facts": facts, "filings_known_by_cutoff": filings,
        "availability": {
            "market_history": True, "sec_facts": bool(facts), "sec_filings": bool(filings),
            # Surfaced because a fall-through to the raw basis is otherwise invisible:
            # every downstream number stays plausible and nothing raises.
            "adjusted_price_basis": bool(stock_adjusted_ok),
            "benchmark_adjusted_price_basis": bool(spy_adjusted_ok),
            "chart_patterns": "chart_patterns" in signals,
            "price_action": "price_action" in signals,
            "market_regime": "market_regime" in signals,
            "relative": bool(relative),
            "valuation": "valuation" in derived,
            "fundamentals": "fundamentals" in derived,
            # Not a data-availability question but a correctness one, and the two read
            # the same way to anything consuming this block: there is no price basis on
            # which the per-share multiples are trustworthy in level. See BASIS_CAVEAT.
            "as_reported_price_basis": False,
            "historical_news": False, "historical_options_flow": False,
            "historical_analyst_estimates": False, "historical_index_membership": False,
        },
        "data_sources": {"market_history": "Yahoo Finance via yahooquery",
                         "filings": "SEC EDGAR" if cik else "Unavailable",
                         "company_name": "Best available at the cutoff; SEC name records are not fully historical"},
    }
    benchmark_returns = benchmark_outcome.get("returns") or {}
    stock_returns = stock_outcome.get("returns") or {}
    outcomes = {
        **stock_outcome,
        "benchmark": "SPY",
        "benchmark_returns": benchmark_returns,
        "excess_returns": {
            label: (stock_returns.get(label) - benchmark_returns.get(label)
                    if stock_returns.get(label) is not None and benchmark_returns.get(label) is not None else None)
            for label in HORIZONS
        },
        # The window the Node simulation replays the model's call over. Sealed by the
        # server until AI generation ends, exactly like every other key in this object.
        "bars": sealed_bars(adjusted, spy_adjusted, as_of),
    }
    progress(88, "Sealing the future outcomes away from the AI prompt")
    output = {
        "mode": "historical_analyzer", "snapshot": snapshot, "outcomes": outcomes,
        "ai_prompt": build_ai_prompt(snapshot),
        "methodology": {
            "signal_cutoff": "Only adjusted daily bars dated on or before the selected date",
            "entry": "Next available session open after the cutoff, on a split-adjusted basis",
            "horizons_sessions": HORIZONS,
            "future_data_isolation": "Forward outcomes are excluded from ai_prompt and withheld by the server until AI generation ends",
        },
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    progress(96, "Historical snapshot complete")
    sys.stdout.write(json.dumps(output, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        sys.stdout.write(json.dumps({"error": f"Historical analysis failed ({type(exc).__name__}: {exc})."}))
        sys.exit(1)
