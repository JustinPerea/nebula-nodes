"""Plans for `nebula propose` and `nebula apply`: one body shape, two routes.

A plan adds nodes (with +refs), wires them, and changes params on existing
nodes. `propose` sends it to the person (POST /api/canvas/proposals) and may
ask for runs; `apply` edits the canvas directly (POST /api/graph/apply, the
MCP server's edit_canvas) and may also rename, move, remove and unwire, but
never runs anything. So one file of nodes, edges and params works with both.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Keys only `nebula apply` sends (a proposal can't do these).
APPLY_ONLY = ("rename", "move", "remove", "unwire")


class BuildError(ValueError):
    """A builder flag or plan file the CLI can't turn into a body."""


def _flatten(items: list) -> list[str]:
    out: list[str] = []
    for item in items or []:
        if isinstance(item, list):
            out.extend(item)
        else:
            out.append(item)
    return out


def _endpoint(text: str, flag: str) -> tuple[str, str]:
    """`n4:image` or `+up:image` → ("n4", "image")."""
    node, sep, port = (text or "").partition(":")
    if not sep or not node or not port:
        raise BuildError(f"{flag} needs node:port (e.g. n4:image or +up:image), got '{text}'")
    return node, port


def _wire(pair: list[str], flag: str) -> dict[str, str]:
    if len(pair) != 2:
        raise BuildError(f"{flag} takes two arguments: SRC:port DST:port")
    source, source_handle = _endpoint(pair[0], flag)
    target, target_handle = _endpoint(pair[1], flag)
    return {"source": source, "sourceHandle": source_handle, "target": target, "targetHandle": target_handle}


def _point(coords: str, flag: str, item: str) -> dict[str, float]:
    x, comma, y = coords.partition(",")
    if not comma:
        raise BuildError(f"{flag} needs REF=x,y, got '{item}'")
    try:
        return {"x": float(x), "y": float(y)}
    except ValueError as exc:
        raise BuildError(f"{flag} needs numbers, got '{coords}'") from exc


def _existing_or_new(ref: str, nodes: dict[str, Any], flag: str, item: str) -> str:
    if ref.startswith("+") and ref not in nodes:
        raise BuildError(f"{flag} names {ref}, which no --add created ('{item}')")
    if not ref:
        raise BuildError(f"{flag} needs a node id (n4) or a +ref from --add, got '{item}'")
    return ref


def build_body(
    *,
    note: str | None = None,
    add: list[str] | None = None,
    param: list | None = None,
    set_params: list[str] | None = None,
    wire: list[list[str]] | None = None,
    run: list[str] | None = None,
    at: list[str] | None = None,
    rename: list[str] | None = None,
    move: list[str] | None = None,
    remove: list[str] | None = None,
    unwire: list[list[str]] | None = None,
) -> dict[str, Any]:
    """Turn builder flags into a plan body. Values stay strings; the backend coerces them."""
    nodes: dict[str, dict[str, Any]] = {}
    for item in add or []:
        ref, sep, definition_id = item.partition("=")
        if not sep or not ref.startswith("+") or not definition_id:
            raise BuildError(f"--add needs +ref=definitionId (e.g. +up=topaz-image-upscale), got '{item}'")
        if ref in nodes:
            raise BuildError(f"--add uses {ref} twice")
        nodes[ref] = {"ref": ref, "definitionId": definition_id, "params": {}}
    for item in _flatten(param or []):
        target, sep, value = item.partition("=")
        ref, dot, key = target.partition(".")
        if not sep or not dot or not key:
            raise BuildError(f"--param needs +ref.key=value (e.g. +up.upscale_factor=2), got '{item}'")
        if ref not in nodes:
            raise BuildError(f"--param names {ref}, which no --add created")
        nodes[ref]["params"][key] = value
    for item in at or []:
        ref, sep, coords = item.partition("=")
        if not sep or ref not in nodes:
            raise BuildError(f"--at needs +ref=x,y for a node from --add, got '{item}'")
        nodes[ref]["position"] = _point(coords, "--at", item)

    changes: dict[str, dict[str, Any]] = {}
    for item in set_params or []:
        target, sep, value = item.partition("=")
        node_id, dot, key = target.partition(".")
        if not sep or not dot or not key or node_id.startswith("+"):
            raise BuildError(f"--set needs nX.key=value for an existing node (e.g. n4.prompt=warmer), got '{item}'")
        changes.setdefault(node_id, {})[key] = value

    edges = [_wire(pair, "--wire") for pair in wire or []]

    renames: dict[str, str] = {}
    for item in rename or []:
        ref, sep, name = item.partition("=")
        if not sep:
            raise BuildError(f"--rename needs REF=name (e.g. n4=\"Hero shot\"; an empty name restores the model's), got '{item}'")
        renames[_existing_or_new(ref, nodes, "--rename", item)] = name
    moves: dict[str, dict[str, float]] = {}
    for item in move or []:
        ref, sep, coords = item.partition("=")
        if not sep:
            raise BuildError(f"--move needs REF=x,y (e.g. n4=400,120), got '{item}'")
        moves[_existing_or_new(ref, nodes, "--move", item)] = _point(coords, "--move", item)
    removals: list[str] = []
    for node_id in remove or []:
        if not node_id or node_id.startswith("+"):
            raise BuildError(f"--remove takes an existing node id (n4), got '{node_id}'")
        removals.append(node_id)
    unwires = [_wire(pair, "--unwire") for pair in unwire or []]

    body: dict[str, Any] = {"note": note or ""}
    if nodes:
        body["nodes"] = [
            {key: value for key, value in node.items() if key != "params" or value}
            for node in nodes.values()
        ]
    if edges:
        body["edges"] = edges
    if changes:
        body["params"] = [{"nodeId": node_id, "params": params} for node_id, params in changes.items()]
    if run:
        body["run"] = list(run)
    if renames:
        body["rename"] = renames
    if moves:
        body["move"] = moves
    if removals:
        body["remove"] = removals
    if unwires:
        body["unwire"] = unwires
    return body


def read_plan(source: str) -> dict[str, Any]:
    """A plan file's JSON object; `-` reads standard input."""
    try:
        text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        body = json.loads(text)
    except (OSError, ValueError) as exc:
        raise BuildError(f"can't read {'standard input' if source == '-' else source}: {exc}") from exc
    if not isinstance(body, dict):
        raise BuildError(f"{'standard input' if source == '-' else source} must hold a JSON object")
    return body


def body_from_args(args: argparse.Namespace, *, command: str) -> dict[str, Any]:
    """The body for `nebula propose` or `nebula apply`, from --file or the builder flags."""
    flags = {
        "add": args.add, "param": _flatten(args.param), "set_params": args.set_params, "wire": args.wire,
        "at": args.at,
        **({"run": args.run} if command == "propose" else {
            "rename": args.rename, "move": args.move, "remove": args.remove, "unwire": args.unwire}),
    }
    if args.file:
        if any(flags.values()):
            raise BuildError("use --file or the builder flags, not both")
        body = read_plan(args.file)
        if args.note:
            body["note"] = args.note
    elif command == "propose" and not args.note:
        raise BuildError("--note is required: one line telling the person what this does")
    else:
        body = build_body(note=args.note, **flags)
    if command == "apply":
        if "run" in body:
            raise BuildError("apply never runs anything: send the same plan to `nebula propose` so the person "
                             "runs it, or apply it without `run` and then `nebula run <node id>`")
        if not body.get("note"):
            body.pop("note", None)
    else:
        extra = [key for key in APPLY_ONLY if key in body]
        if extra:
            raise BuildError(f"a proposal can't {extra[0]}; `nebula apply` edits the canvas directly "
                             f"(rename, move, remove, unwire)")
    return body


__all__ = ["APPLY_ONLY", "BuildError", "body_from_args", "build_body", "read_plan"]
