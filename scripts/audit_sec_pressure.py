#!/usr/bin/env python3
"""Static guardrails for SEC throttling and per-filing request caps."""

from __future__ import annotations

import ast
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "scraperFinal.py"


def call_name(call: ast.Call) -> str:
    fn = call.func
    if isinstance(fn, ast.Name):
        return fn.id
    if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name):
        return f"{fn.value.id}.{fn.attr}"
    return ""


def string_literals(node: ast.AST):
    for child in ast.walk(node):
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            yield child.value


def sec_request_functions(tree: ast.Module):
    for fn in (node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))):
        contains_sec_url = any("sec.gov" in value.lower() for value in string_literals(fn))
        if fn.name == "_sec_get" or contains_sec_url:
            yield fn


def filing_loop_is_capped(fn: ast.FunctionDef) -> bool:
    for loop in (node for node in ast.walk(fn) if isinstance(node, ast.For)):
        if not isinstance(loop.iter, ast.Name) or loop.iter.id != "filings":
            continue
        has_guard = any(
            isinstance(node, ast.Compare)
            and any(isinstance(part, ast.Name) and part.id == "SEC_MAX_FILING_FETCHES"
                    for part in [node.left, *node.comparators])
            for node in ast.walk(loop)
        )
        has_increment = any(
            isinstance(node, ast.AugAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "detail_fetches"
            for node in ast.walk(loop)
        )
        detail_calls = {
            call_name(node) for node in ast.walk(loop)
            if isinstance(node, ast.Call)
        }
        if has_guard and has_increment and {"parse_8k_items", "analyze_form4"} <= detail_calls:
            return True
    return False


def main() -> int:
    # read_text() without an encoding uses the system codepage; on Windows that is cp1252
    # and the first em dash in the engine kills the audit before it inspects a single call.
    source = SOURCE_PATH.read_text(encoding="utf-8")
    lines = source.splitlines()
    tree = ast.parse(source)
    errors = []
    direct_sec_calls = 0

    for fn in sec_request_functions(tree):
        calls = [node for node in ast.walk(fn) if isinstance(node, ast.Call)]
        request_calls = [call for call in calls if call_name(call) == "requests.get"]
        helper_calls = [call for call in calls if call_name(call) == "_sec_get"]
        if fn.name not in ("_sec_get", "_sec_throttle") and not request_calls and not helper_calls:
            errors.append(f"{fn.name} contains a sec.gov URL but uses neither _sec_get nor a guarded request")
        for call in request_calls:
            direct_sec_calls += 1
            preceding = "\n".join(lines[max(fn.lineno - 1, call.lineno - 8):call.lineno - 1])
            if "_sec_throttle()" not in preceding:
                errors.append(f"requests.get at scraperFinal.py:{call.lineno} is not immediately guarded by _sec_throttle()")

    generate = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "generate_analysis_payload"), None)
    if generate is None or not filing_loop_is_capped(generate):
        errors.append("the per-filing 8-K/Form 4 loop is not visibly capped by SEC_MAX_FILING_FETCHES")

    if errors:
        print("SEC provider-pressure audit failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"SEC pressure audit passed: {direct_sec_calls} direct request sites throttled; filing loop capped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
