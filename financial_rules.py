"""Shared applicability and quote rules. No network or inferred missing values."""
import math

# Yahoo files every financial company under the sector "Financial Services", so the
# sector cannot separate a bank from an exchange: classifying on it marked V, MA, SPGI,
# MCO, CME and ICE as banks and blanked their margin, FCF and quality scores. The
# industry is the discriminator — only balance-sheet lenders, underwriters and
# broker-dealers are "financial". Insurance brokers, exchanges, data vendors and asset
# managers are fee businesses whose industrial ratios mean what they say.
FINANCIAL_INDUSTRY_TERMS = ("bank", "insurance", "capital markets", "mortgage finance",
                            "financial conglomerates", "credit services")
OPERATING_INDUSTRY_TERMS = ("insurance brokers",)
# "Credit Services" mixes card lenders (AXP, COF, SYF) with payment networks that carry
# no loan book. Yahoo offers nothing finer, so the networks are named.
PAYMENT_NETWORKS = frozenset({"V", "MA", "PYPL"})


def business_model(sector, industry, ticker=None):
    industry_text = (industry or "").lower()
    if "reit" in industry_text or ("reit" in (sector or "").lower()):
        return "reit"
    if industry_text:
        if any(term in industry_text for term in OPERATING_INDUSTRY_TERMS):
            return "operating"
        if "credit services" in industry_text and (ticker or "").upper() in PAYMENT_NETWORKS:
            return "operating"
        if any(term in industry_text for term in FINANCIAL_INDUSTRY_TERMS):
            return "financial"
        return "operating"
    # No industry: the sector is all there is. Suppressing ratios is the safer error
    # than scoring a bank's current ratio as if it were a manufacturer's.
    sector_text = (sector or "").lower()
    if any(term in sector_text for term in ("financial services", "financials", "bank", "insurance")):
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
