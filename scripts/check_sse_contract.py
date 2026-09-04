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
QUOTED = re.compile(r'["\'`]' + _NAME + r'["\'`]')
# The event name is not always the literal first token. Two of the eleven are chosen by a
# ternary inside the call — send(kind === "reasoning" ? "backtest_ai_thinking" : ...) —
# and a pattern anchored to `send(` immediately followed by a quote matched NEITHER, so
# backtest_ai_thinking and backtest_ai_delta went unchecked while the run reported green.
# MIN_EVENTS is what caught it; this is what makes the check see them.
#
# Deliberately line-scoped and greedy rather than precise: every quoted backtest_* literal
# on a line containing `send(` counts as sent. A stray mention in a trailing comment would
# be a false positive, which fails LOUD and gets fixed. The alternative — a tighter pattern
# that misses a real send — fails silent, which is the whole failure mode this file exists
# to prevent.
SEND_LINE = re.compile(r'\bsend\(')
HEARD = re.compile(r'addEventListener\(\s*["\'`]' + _NAME + r'["\'`]')


def sent_events(server: str) -> set[str]:
    found: set[str] = set()
    for line in server.splitlines():
        if SEND_LINE.search(line):
            found.update(QUOTED.findall(line))
    return found

# Set equality is also satisfied when both sides are empty, so the count is
# floored. Raise this when events are added; never lower it to make a run pass.
MIN_EVENTS = 11


def main() -> int:
    server = (ROOT / "server.js").read_text(encoding="utf-8")
    client = (ROOT / "backtester.js").read_text(encoding="utf-8")

    sent = sent_events(server)
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
