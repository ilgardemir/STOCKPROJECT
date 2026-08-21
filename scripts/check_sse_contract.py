#!/usr/bin/env python3
"""Fail when a backtest SSE event is sent but never listened for (or vice versa).

CLAUDE.md calls the SSE event names a contract between server.js and the front end,
but nothing enforced it. Renaming one side is silent: the browser simply stops
updating, with no error anywhere.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Any quote style and any identifier character. Narrower patterns fail OPEN: an
# event written with single quotes, or named with a digit, matches on NEITHER
# side, so the two sets stay equal and the check reports success while the
# contract is broken. A checker whose failure mode is a silent pass is worse
# than no checker. Backtick is included so a template literal with no
# interpolation is still seen; one WITH interpolation is unmatchable by regex
# and is caught instead by MIN_EVENTS below.
_NAME = r'(backtest_[A-Za-z0-9_]+)'
SENT = re.compile(r'send\(\s*["\'`]' + _NAME + r'["\'`]')
HEARD = re.compile(r'addEventListener\(\s*["\'`]' + _NAME + r'["\'`]')

# Set equality is also satisfied when both sides are empty, so the count is
# floored. Raise this when events are added; never lower it to make a run pass.
MIN_EVENTS = 11


def main() -> int:
    server = (ROOT / "server.js").read_text(encoding="utf-8")
    client = (ROOT / "backtester.js").read_text(encoding="utf-8")

    sent = set(SENT.findall(server))
    heard = set(HEARD.findall(client))

    if len(sent) < MIN_EVENTS:
        print(
            f"check_sse_contract: found only {len(sent)} backtest_* sends in server.js, "
            f"expected at least {MIN_EVENTS}. Either events were removed (raise or lower "
            f"MIN_EVENTS deliberately) or a send is written in a form SENT cannot match, "
            f"in which case this check is silently not checking it.",
            file=sys.stderr,
        )
        return 1

    unheard = sorted(sent - heard)
    unsent = sorted(heard - sent)

    for name in unheard:
        print(f"server.js sends '{name}' but backtester.js never listens for it", file=sys.stderr)
    for name in unsent:
        print(f"backtester.js listens for '{name}' but server.js never sends it", file=sys.stderr)

    if unheard or unsent:
        return 1
    print(f"ok - {len(sent)} backtest SSE events matched on both sides")
    return 0


if __name__ == "__main__":
    sys.exit(main())
