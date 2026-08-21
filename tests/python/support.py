"""Offline import helpers for the data-engine unit tests."""

import sys
import types


def install_yahooquery_stub():
    """Let pure helpers import without installing or contacting yahooquery."""
    if "yahooquery" in sys.modules:
        return
    try:
        __import__("yahooquery")
        return
    except ModuleNotFoundError:
        module = types.ModuleType("yahooquery")

        class OfflineTicker:
            def __init__(self, *_args, **_kwargs):
                raise AssertionError("unit tests must not contact Yahoo")

        module.Ticker = OfflineTicker
        sys.modules["yahooquery"] = module
