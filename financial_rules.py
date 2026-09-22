"""Shared applicability and quote rules. No network or inferred missing values."""
import math


def business_model(sector, industry):
    text = f"{sector or ''} {industry or ''}".lower()
    if "reit" in text:
        return "reit"
    if any(term in text for term in ("bank", "insurance", "financial services", "financials")):
        return "financial"
    return "operating"


def valid_quote(bid, ask):
    try:
        bid, ask = float(bid), float(ask)
        if math.isfinite(bid) and math.isfinite(ask) and 0 < bid <= ask:
            return bid, ask
    except (TypeError, ValueError, OverflowError):
        pass
    return None, None


def quote_evidence(bid, ask):
    bid, ask = valid_quote(bid, ask)
    # Providers expose last-trade dates, not the timestamp of this bid/ask pair.
    # A structurally valid quote is therefore indicative, never executable evidence.
    return {"bid": bid, "ask": ask,
            "midpoint": (bid + ask) / 2 if bid is not None else None,
            "relative_spread": (ask - bid) / ((bid + ask) / 2) if bid is not None else None,
            "quote_status": "indicative_timestamp_unavailable" if bid is not None else "unavailable",
            "bid_ask_time": None}
