"""
Reporting-calendar reconstruction shared by the live analyzer and the historical replay.

Everything here reads SEC companyfacts rows filtered to a cutoff date, so it is
point-in-time by construction: the replay passes its historical cutoff, the live
analyzer passes today. No calendar is fetched and no network call is made. It lives
outside backtester.py because backtester imports scraperFinal, so the scraper could not
import it back without a cycle.
"""
from datetime import date, datetime, timedelta
import math


def finite(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


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


def _median(values):
    ordered = sorted(values)
    if not ordered:
        return None
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


# Concepts whose period_end is a true fiscal period end, in preference order. Exactly one
# of them defines the reporting rhythm — never the union.
#
# `shares_outstanding` is deliberately absent and is the reason this list exists. It
# resolves to the dei cover-page fact EntityCommonStockSharesOutstanding, whose period_end
# is the cover date rather than the quarter end: TSLA reported 2021-10-21 against a quarter
# that closed 2021-09-30. Unioned in, that cover date sorted last and became the anchor,
# and its ~21-day offsets interleaved with the real quarter ends to produce spurious
# ~70-day spacings that dragged the measured cadence from 91 days down to 72.
CADENCE_CONCEPTS = ("revenue", "net_income", "operating_income", "operating_cash_flow",
                    "assets", "equity", "current_assets")

# The earliest a filer can realistically close and announce a completed quarter. The only
# figure in event_risk not taken from the issuer's own history.
EARNINGS_FLOOR_DAYS = 14

# How soon the results window has to open before it dominates the trade rather than
# merely occurring during it.
#
# `falls_inside_horizon` cannot carry this, because at 3m it is TRUE BY CONSTRUCTION: the
# test is `days_to_open <= sessions * 1.45`, 63 sessions is 91.35 days, and a quarterly
# filer reports every ~91. Measured over the 13 completed live replays it was true 13/13
# at 3m and 6m. The prompt then asked the model to "shorten the horizon to close before
# it, or state that you are accepting a gap your stop cannot cover" — an instruction whose
# condition always fires, offering one remedy that is an action and one that is an
# admission of unmanaged risk. The model took the action every time: 13 of 13 replays
# chose 1m against a 3m ceiling it was free to use.
#
# Three weeks is not a round number chosen here — it is the cohort the halving rule in
# ensureBacktestPosition was actually measured on. In the original 18-run audit the five
# cutoffs with results due inside three weeks averaged -15.1% over the following month
# against +1.4% for the other thirteen. That evidence is about an IMMINENT report, so this
# is the flag both the sizing rule and the prompt should read. A quarterly report inside a
# 3-month hold is unavoidable and normal, and says nothing about the trade.
EARNINGS_IMMINENT_DAYS = 21

# Past this, a period-end-to-filed gap is a restated comparative rather than an original
# filing. SEC deadlines are 40 days for an accelerated filer's 10-Q and 60 for its 10-K,
# and 90 covers a non-accelerated one; 120 leaves room without admitting a year-late row.
LAG_CEILING_DAYS = 120


# How far ahead of its filing a company may announce, for fast filers only.
ANNOUNCE_LEAD_DAYS = 7


def _window_open_days(low_lag):
    """
    Days after period end at which the results window opens.

    EARNINGS_FLOOR_DAYS yields for a fast filer, because an announcement can never come
    after the filing that carries the same numbers. ORCL files its 10-Q about eleven days
    after quarter end with a median lag equal to its fastest, so a 14-day floor opened
    the window after the filing and collapsed it to one day, missing the release two days
    earlier. The window opens a week ahead of the fastest filing instead. Any issuer whose
    fastest filing is three weeks or more out is unaffected.
    """
    return max(1, min(EARNINGS_FLOOR_DAYS, int(low_lag) - ANNOUNCE_LEAD_DAYS))


def _is_month_end(day):
    return (day + timedelta(days=1)).day == 1


def _snap_period_end(projected, observed_ends):
    """
    Pull a day-count projection back onto the issuer's actual period-end calendar.

    Adding a 91- or 92-day cadence to a quarter end drifts: 2024-12-31 + 92 lands on
    2025-04-02, two days past the 2025-03-31 quarter it is meant to name, and the error
    compounds on every further step. For a calendar-quarter filer — recognisable because
    its period ends all sit on the last day of a month — the nearest month end is the
    right answer and is never more than a few days away.

    A 4-4-5 filer (INTC ending 2024-06-29, NVDA 2022-10-30) has period ends that are NOT
    month ends, and for those the raw cadence is already accurate to the day, because
    52 weeks is exactly what their calendar advances by. So the snap is applied only when
    the issuer's own history says it is a month-end filer.
    """
    month_end_count = sum(1 for day in observed_ends if _is_month_end(day))
    if month_end_count < max(2, len(observed_ends) * 0.75):
        return projected
    # Nearest month end to the projection: either the end of its own month, or the end of
    # the month before it.
    end_of_month = (projected.replace(day=1) + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    end_of_prev = projected.replace(day=1) - timedelta(days=1)
    return min((end_of_prev, end_of_month), key=lambda day: abs((day - projected).days))


def event_risk(facts, as_of):
    """
    When this issuer's next results land, estimated from its OWN filing history.

    This breaks no seal. Every input is a (period_end, filed) pair from a filing already
    dated on or before the cutoff; nothing dated later is consulted and no calendar is
    fetched. What it reconstructs is the issuer's reporting rhythm, which was as knowable
    on the cutoff date as any price on the chart.

    It exists because the 18-run audit found the model trading blind through scheduled
    events. One of eighteen analyses mentioned an upcoming report at all, while the five
    cases with results due inside three weeks of the cutoff averaged -15.1% over the
    following month against +1.4% for the other thirteen. UNH 2025-04-15 reported two
    days after its cutoff and fell 53% inside the holding window; INTC 2024-07-15 was
    eleven days out and fell 40%. The model was long into four of the five.

    The anchor is the most recent fiscal period that has ENDED but has NOT yet been
    reported, which is precisely the pending release — not the last one filed. INTC at
    2024-07-15 had last filed for the quarter ended 2024-03-30, but the quarter ending
    2024-06-29 was already over and outstanding; anchoring on the filed one would have
    projected the report a full quarter too late and missed the event entirely.

    A window rather than a date. The periodic filing is what these rows measure, and
    `expected_filing_window` brackets it from this issuer's own spread of lags. The
    results announcement is a different event that lands at or before that filing, by an
    interval that varies far too much between issuers to assume: TSLA files within days
    of announcing while UNH announces about three weeks ahead of filing, so
    `earnings_window` spans from the earliest a quarter can realistically be reported to
    this issuer's typical filing date, and says so.
    """
    by_end, ends = None, None
    for concept in CADENCE_CONCEPTS:
        fact = (facts or {}).get(concept)
        if not fact:
            continue
        # One filed date per period end, earliest wins: a quarter end contributes both a
        # discrete-quarter and a year-to-date row, and a prior year's balance is re-filed
        # as a comparative in every later report. Counting either again would weight that
        # period twice and stretch the measured lag.
        candidate = {}
        for row in fact.get("series") or []:
            end, filed = _parse_day(row.get("period_end")), _parse_day(row.get("filed"))
            if end and filed and filed >= end:
                if end not in candidate or filed < candidate[end]:
                    candidate[end] = filed
        if len(candidate) < 3:
            continue
        sorted_ends = sorted(candidate)
        spacing = [(sorted_ends[i] - sorted_ends[i - 1]).days for i in range(1, len(sorted_ends))]
        # The concept has to actually look like a quarterly reporter before its dates are
        # trusted to define the rhythm. `depreciation` for TSLA stops in 2018 and would
        # otherwise contribute a two-and-a-half-year gap.
        if not any(60 <= gap <= 120 for gap in spacing):
            continue
        by_end, ends = candidate, sorted_ends
        break
    if not ends:
        return None

    # Only lags a genuine ORIGINAL filing can have. "Earliest filed wins" above does not
    # catch every comparative, because fact_series keeps a bounded number of rows: once an
    # old period end's original row falls off that window, the only row left for it is the
    # restated comparative carried in a later report, and its lag is a full year. TSLA at
    # 2021-11 measured a 390-day high that way, which widened the reported filing window
    # to 2022-01-27 through 2023-01-25 — a year wide and useless on the page.
    #
    # The threshold is structural rather than tuned: an accelerated filer has 40 days for
    # a 10-Q and 60 for a 10-K, and even a non-accelerated one is inside 90. Anything past
    # LAG_CEILING_DAYS is a comparative by construction, not a slow filer.
    lags = [lag for lag in ((by_end[end] - end).days for end in ends)
            if lag <= LAG_CEILING_DAYS]
    if not lags:
        return None
    median_lag = _median(lags)
    ordered_lags = sorted(lags)
    low_lag = ordered_lags[0]
    high_lag = ordered_lags[-1]

    gaps = [(ends[i] - ends[i - 1]).days for i in range(1, len(ends))]
    # Quarterly reporters also emit annual period ends, so the gap set mixes ~91 with
    # ~273 and ~365. The quarterly cadence is what the next report follows, so gaps that
    # are obviously multi-period are dropped before taking the median.
    quarterly_gaps = [gap for gap in gaps if 60 <= gap <= 120] or gaps
    cadence = int(round(_median(quarterly_gaps) or 91))

    # Walk forward to the first period end that is still unreported. Normally one step.
    next_end = _snap_period_end(ends[-1] + timedelta(days=cadence), ends)
    for _ in range(8):
        if next_end not in by_end:
            break
        next_end = _snap_period_end(next_end + timedelta(days=cadence), ends)

    filing_low = next_end + timedelta(days=int(low_lag))
    filing_high = next_end + timedelta(days=int(high_lag))
    filing_typical = next_end + timedelta(days=int(round(median_lag)))

    # The earnings event is a WINDOW, and both of its edges are derived rather than
    # assumed. An earlier version subtracted a flat 21 days from the filing estimate to
    # guess the announcement date, which is not something these rows can measure and was
    # simply wrong at both ends: TSLA files its 10-Q within days of announcing, so the
    # guess landed three weeks early, while UNH announces roughly three weeks before it
    # files, so no single offset fits both. The window instead runs from the earliest a
    # company can realistically close and report a quarter to the date this issuer's own
    # history says the filing lands.
    #
    # EARNINGS_FLOOR_DAYS is the one number here not taken from the issuer: no filer
    # announces a completed quarter inside two weeks of its close. Checked against the
    # audit's worst cases, the window contains the real event in each — TSLA
    # 2022-01-14 -> [01-14, 01-27] against an actual 01-26, UNH 2025-04-15 ->
    # [04-14, 05-05] against an actual 04-17, INTC 2024-07-15 -> [07-13, 07-26] against
    # an actual 08-01, which it brackets to within a week.
    #
    window_open = next_end + timedelta(days=_window_open_days(low_lag))
    window_close = max(filing_typical, window_open)
    days_to_open = (window_open - as_of).days
    days_to_close = (window_close - as_of).days
    return {
        "last_reported_period_end": ends[-1].isoformat(),
        "last_reported_filed": by_end[ends[-1]].isoformat(),
        "pending_period_end": next_end.isoformat(),
        "pending_period_already_ended": next_end <= as_of,
        "observed_filing_lag_days": {"low": int(low_lag), "median": int(round(median_lag)),
                                     "high": int(high_lag)},
        "reporting_cadence_days": cadence,
        "expected_filing": filing_typical.isoformat(),
        "expected_filing_window": [filing_low.isoformat(), filing_high.isoformat()],
        "earnings_window": [window_open.isoformat(), window_close.isoformat()],
        # Negative would read as nonsense to a model ("due -6 days from now"), so an
        # already-open window says so in its own field rather than through a sign.
        "earnings_window_already_open": days_to_open <= 0,
        "days_until_earnings_window_opens": max(0, days_to_open),
        "days_until_earnings_window_closes": max(0, days_to_close),
        # A session is about 1.45 calendar days, so this asks whether the window OPENS
        # before the horizon ends — an event that lands mid-hold is the one that matters.
        #
        # Read this for SIZING, never for choosing a term: at 3m and 6m it is true for
        # essentially every quarterly filer (63 * 1.45 = 91.35 days against a ~91-day
        # cadence), so it cannot discriminate between horizons. `imminent` is the flag
        # that carries information, and it is the only one the prompt is shown.
        "falls_inside_horizon": {label: days_to_open <= sessions * 1.45
                                 for label, sessions in HORIZONS.items()},
        "imminent": days_to_open <= EARNINGS_IMMINENT_DAYS,
        "basis": ("Reconstructed from this issuer's own filing history: the median lag from "
                  "period end to filing date, applied to the next period end on the cadence its "
                  "own past period ends establish. No calendar and no post-cutoff data was "
                  "consulted, so this was as knowable on the cutoff date as any price here. It "
                  "is a WINDOW, not a date — the results announcement lands somewhere between "
                  "the earliest a quarter can realistically be reported and this issuer's "
                  "typical filing date. Treat it as accurate to within a week or two and never "
                  "to the day."),
    }


LIVE_BASIS = ("Estimated from this issuer's own SEC filing history: its reporting cadence and "
              "its usual lag from period end to filing. This is not a confirmed date from the "
              "company. The results announcement lands somewhere inside the window; treat it as "
              "accurate to within a week or two and never to the day.")


def _released_after(filings, period_end):
    """Earliest 8-K Item 2.02 (Results of Operations) filed after `period_end`, or None."""
    dates = [str(f.get("filing_date") or "") for f in filings or ()
             if str(f.get("form") or "").startswith("8-K")
             and "2.02" in str(f.get("items") or "").split(",")
             and str(f.get("filing_date") or "") > period_end]
    return min(dates) if dates else None


def live_event_risk(companyfacts, today, filings=()):
    """
    The next results window for the live analyzer, as of `today`.

    event_risk alone is right for a replay and wrong for roughly three weeks after every
    live earnings release. It treats a quarter as outstanding until its 10-Q/10-K is
    FILED, and issuers announce well before they file (UNH about three weeks ahead). Live,
    that window is exactly when people look a stock up, and it would be flagged "results
    imminent" for an event that has already happened. An 8-K carrying Item 2.02 closes
    the gap: once one is filed after the pending period ended, those results are out and
    the next window is one cadence further on. The items list arrives in the single SEC
    submissions call the scraper already makes, so this costs no request.
    """
    facts = {name: fact for name in CADENCE_CONCEPTS
             if (fact := fact_series(companyfacts, *FACTS[name], today)) is not None}
    risk = event_risk(facts, today)
    if not risk:
        return None
    # Keyed to the replay's 1m/3m/6m holding periods, which mean nothing here.
    risk.pop("falls_inside_horizon", None)
    risk["basis"] = LIVE_BASIS
    risk["results_announced"] = None

    released = _released_after(filings, risk["pending_period_end"])
    if released:
        announced_end = _parse_day(risk["pending_period_end"])
        observed = [_parse_day(risk["last_reported_period_end"]), announced_end]
        next_end = _snap_period_end(announced_end + timedelta(days=risk["reporting_cadence_days"]), observed)
        lag = risk["observed_filing_lag_days"]
        window_open = next_end + timedelta(days=_window_open_days(lag["low"]))
        window_close = max(next_end + timedelta(days=lag["median"]), window_open)
        days_to_open, days_to_close = (window_open - today).days, (window_close - today).days
        risk.update({
            "results_announced": {"period_end": risk["pending_period_end"], "announced": released},
            "pending_period_end": next_end.isoformat(),
            "pending_period_already_ended": next_end <= today,
            "expected_filing": (next_end + timedelta(days=lag["median"])).isoformat(),
            "expected_filing_window": [(next_end + timedelta(days=lag["low"])).isoformat(),
                                       (next_end + timedelta(days=lag["high"])).isoformat()],
            "earnings_window": [window_open.isoformat(), window_close.isoformat()],
            "earnings_window_already_open": days_to_open <= 0,
            "days_until_earnings_window_opens": max(0, days_to_open),
            "days_until_earnings_window_closes": max(0, days_to_close),
            "imminent": days_to_open <= EARNINGS_IMMINENT_DAYS,
        })
    return risk


def describe_event_risk(risk):
    """One prompt line. The engine decides `imminent`; the model is handed the verdict."""
    if not risk:
        return "Next results: not estimable from SEC filing history."
    start, end = risk["earnings_window"]
    parts = []
    if risk.get("results_announced"):
        r = risk["results_announced"]
        parts.append(f"Results for the period ended {r['period_end']} were released {r['announced']} (8-K Item 2.02).")
    timing = ("past this issuer's usual reporting date with no results 8-K found yet, so results may land any day"
              if risk["earnings_window_already_open"] and risk["days_until_earnings_window_closes"] == 0
              else "window is open now" if risk["earnings_window_already_open"]
              else f"window opens in {risk['days_until_earnings_window_opens']} days")
    parts.append(f"Next results for the period ending {risk['pending_period_end']}: estimated window "
                 f"{start} to {end}; {timing}.")
    parts.append("IMMINENT: within three weeks." if risk["imminent"] else "Not imminent.")
    parts.append("Estimated from the issuer's own filing cadence, not a confirmed date.")
    return " ".join(parts)
