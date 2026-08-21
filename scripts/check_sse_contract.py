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

SENT = re.compile(r'send\(\s*"(backtest_[a-z_]+)"')
HEARD = re.compile(r'addEventListener\(\s*"(backtest_[a-z_]+)"')


def main() -> int:
    server = (ROOT / "server.js").read_text(encoding="utf-8")
    client = (ROOT / "backtester.js").read_text(encoding="utf-8")

    sent = set(SENT.findall(server))
    heard = set(HEARD.findall(client))

    if not sent:
        print("check_sse_contract: found no backtest_* sends in server.js", file=sys.stderr)
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
