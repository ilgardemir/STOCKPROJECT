#!/usr/bin/env python3
"""Fail when the server, engine, and browser screener vocabularies drift."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def balanced_object(source: str, marker: str) -> str:
    start = source.find(marker)
    if start < 0:
        raise ValueError(f"could not find {marker}")
    start = source.find("{", start)
    depth = 0
    quote = None
    escaped = False
    for index in range(start, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in ("'", '"', "`"):
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(f"unterminated object after {marker}")


def js_object_keys(source: str, marker: str) -> set[str]:
    block = balanced_object(source, marker)
    # Properties are intentionally packed several to a line in app.js. Anchor on an
    # object/comma boundary rather than a line boundary so every key is visible.
    pattern = re.compile(r"(?:^|[,{}])\s*(?:['\"]([^'\"]+)['\"]|([A-Za-z_$][\w$]*))\s*:")
    return {quoted or bare for quoted, bare in pattern.findall(block)}


def python_concepts(source: str) -> tuple[set[str], set[str]]:
    tree = ast.parse(source)
    label_node = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "CONCEPT_LABELS" for t in node.targets):
            label_node = node
            break
    if label_node is None:
        raise ValueError("could not find CONCEPT_LABELS")
    labels = set(ast.literal_eval(label_node.value))

    # Score fields are all created before CONCEPT_LABELS. Restrict candidates to known
    # labels so unrelated payload dictionaries cannot mask a missing engine score.
    scored = {"consolidation", "momentum"}  # selected dynamically from windowed fields
    for node in ast.walk(tree):
        if getattr(node, "lineno", label_node.lineno) >= label_node.lineno:
            continue
        if isinstance(node, ast.Dict):
            for key in node.keys:
                if isinstance(key, ast.Constant) and isinstance(key.value, str) and key.value in labels:
                    scored.add(key.value)
        elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            if isinstance(node.slice.value, str) and node.slice.value in labels:
                scored.add(node.slice.value)
    return labels, scored


def difference(label: str, expected: set[str], actual: set[str]) -> list[str]:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    errors = []
    if missing:
        errors.append(f"{label} is missing: {', '.join(missing)}")
    if extra:
        errors.append(f"{label} has extra concepts: {', '.join(extra)}")
    return errors


def main() -> int:
    server_source = (ROOT / "server.js").read_text()
    app_source = (ROOT / "app.js").read_text()
    engine_source = (ROOT / "screener.py").read_text()

    catalog = js_object_keys(server_source, "const SCREENER_CATALOG")
    browser = js_object_keys(app_source, "const SCREEN_CONCEPT_LABELS")
    engine, scored = python_concepts(engine_source)

    errors = []
    errors.extend(difference("screener.py CONCEPT_LABELS", catalog, engine))
    errors.extend(difference("app.js SCREEN_CONCEPT_LABELS", catalog, browser))
    missing_scores = sorted(catalog - scored)
    if missing_scores:
        errors.append("screener.py has no deterministic score for: " + ", ".join(missing_scores))

    if errors:
        print("Concept vocabulary drift detected:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Concept vocabulary aligned: {len(catalog)} concepts across server, engine, and browser")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
