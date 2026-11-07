#!/usr/bin/env python3
"""Write backend/tests/fixtures/not_ready_reasons.json: every not-ready
reason the registry gives, for one node and for several, on the card and the
bar and in the Agent Log.

node_readiness.instance_missing_reason over:

- every registry node, at its defaults and on each of its routes and an
  unknown one, with no key set and with each route's own keys alone, the
  Krea plan signed out;
- every case of backend/tests/fixtures/route_cases.json (the registry's and
  the fixture's route-table nodes, with the params, keys and connected
  inputs that stop a route: a setting it can't take, a hidden stop, too many
  inputs, a key only another route has, one that needs its key);
- a node whose key Settings doesn't store (not_set_up).

No registry route table sets a size or retired rule today, so no row
carries those clauses; backend/tests/test_idol_round17_log.py pins both
with a fixture route (review 16 of PR #203, copy NIT-1).

Each distinct reason (person_line NOT_READY_PREDICATES filled in) once,
with its kind, the node it came from, the line the proposal bar shows for
one node, and the Agent Log's forms (the run-again ending in the action
sentence's end slot; review 15 of PR #203, copy LOW-2, sockets-tests LOW-1).
frontend/tests/lib/idolRound15.test.tsx merges every one of them through
canvasProposals.notReadyShown, for one node and for two, and
backend/tests/test_idol_round15.py checks this file is current, that every
kind in person_line.NOT_READY_PREDICATES appears in it (review 16, tests
LOW-1), and that every line starts with the node's quoted name (review 14
of PR #203, copy MEDIUM-1 and LOW-1).

Usage:
  backend/.venv/bin/python scripts/generate-not-ready-reasons.py          # rewrite
  backend/.venv/bin/python scripts/generate-not-ready-reasons.py --check  # exit 1 if stale
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
DEFINITIONS = BACKEND / "data" / "node_definitions.json"
ROUTE_CASES = BACKEND / "tests" / "fixtures" / "route_cases.json"
OUT = BACKEND / "tests" / "fixtures" / "not_ready_reasons.json"

# A node whose key Settings doesn't store: no key phrase, so not_set_up.
NOT_SET_UP = {"id": "fixture-not-set-up", "displayName": "Fixture Unlisted", "category": "image",
              "envKeyName": "FIXTURE_UNLISTED_KEY", "inputPorts": [], "outputPorts": [], "params": []}


def _keys(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    return [str(key) for key in value] if isinstance(value, list) else []


def _read(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def build() -> str:
    sys.path.insert(0, str(BACKEND))
    from services.node_readiness import instance_missing_reason
    from services import node_route

    definitions = _read(DEFINITIONS)
    cases = _read(ROUTE_CASES)
    every = {**definitions, **cases["definitions"], NOT_SET_UP["id"]: NOT_SET_UP}
    # (node id, params, keys, connected inputs) to ask, in order.
    default_today = cases["defaultToday"]
    asks: list[tuple[str, dict, list[str], object, str]] = []
    for node_id, definition in sorted(definitions.items()):
        variants: list[dict[str, str]] = [{}]
        if definition.get("routes"):
            variants += [{"_provider": str(route.get("id"))} for route in definition["routes"]]
            variants.append({"_provider": "not-a-route"})
        # No key set, then each route's own keys alone: a route whose key is
        # set is named as the switch ("… or switch to fal.ai"), and a stop
        # names the routes that need their key ("…, or add your Black Forest
        # Labs API key in Settings and switch to Black Forest Labs."). A
        # missing-key line names another route only when its key is set (GM,
        # PR #203 r33 item 4).
        key_sets: list[list[str]] = [[]] + [list(_keys(route.get("keys"))) for route in definition.get("routes") or []]
        for params in variants:
            for keys in key_sets:
                asks.append((node_id, params, keys, (), default_today))
    for case in cases["cases"]:
        if node_route.has_routes(every[case["nodeId"]]):
            asks.append((case["nodeId"], case["params"], sorted(case["apiKeys"]),
                         case.get("wiredCounts") or case.get("wired", ()), case.get("today", default_today)))
    asks.append((NOT_SET_UP["id"], {}, [], (), default_today))

    today = node_route._today
    seen: dict[str, dict[str, str]] = {}
    try:
        for node_id, params, keys, wired, on in asks:
            definition = every[node_id]
            node_route._today = lambda on=on: on  # the cases' clock, so retired routes read as pinned
            reason = instance_missing_reason(definition, params, keys, False, every, wired)
            if reason is None or reason.view() is None or reason.one in seen:
                continue
            name = str(definition.get("displayName") or node_id)
            seen[reason.one] = {"kind": str(reason.kind), "node": node_id, "name": name, "one": reason.one,
                                "many": reason.many, "line": reason.line(f"“{name}”"),
                                "logOne": reason.again[0], "logMany": reason.again[1]}
    finally:
        node_route._today = today
    table = {
        "about": ("Generated by scripts/generate-not-ready-reasons.py (do not edit): every distinct "
                  "node_readiness.instance_missing_reason over the registry (no key set, and each route's own "
                  "keys alone), every route_cases.json case, and a node whose key Settings doesn't store; "
                  "logOne and logMany are the Agent Log's forms."),
        "reasons": list(seen.values()),
    }
    return json.dumps(table, indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    text = build()
    if "--check" in sys.argv[1:]:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(f"{OUT.relative_to(ROOT)} is stale; run scripts/generate-not-ready-reasons.py", file=sys.stderr)
            return 1
        print(f"{OUT.relative_to(ROOT)} is current")
        return 0
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
