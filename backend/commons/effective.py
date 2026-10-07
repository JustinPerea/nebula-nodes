"""Effective values: analysis + corrections applied in order (§6.4).

Renders and borrowings never read these live; a borrowing stores the value
it took (§6.4 last bullet, PLAN EV4).
"""
from __future__ import annotations

import copy
from typing import Any


def get_path(fields: dict, path: str) -> Any:
    node: Any = fields
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def apply_op(fields: dict, path: str, op: str, value: Any) -> None:
    parts = path.split(".")
    node = fields
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    leaf = parts[-1]
    if op == "set":
        node[leaf] = value
    elif op == "add":
        items = list(node.get(leaf) or [])
        if value not in items:
            items.append(value)
        node[leaf] = items
    elif op == "remove":
        node[leaf] = [item for item in (node.get(leaf) or []) if item != value]
    else:
        raise ValueError(f"unknown op {op!r}")


def _leaf_paths(fields: dict, prefix: str = "") -> list[str]:
    out = []
    for key, val in fields.items():
        path = f"{prefix}{key}"
        if isinstance(val, dict) and "value" in val:
            out.append(f"{path}.value")
        elif isinstance(val, dict):
            out.extend(_leaf_paths(val, f"{path}."))
        else:
            out.append(path)
    return out


def effective(store, asset_id: str) -> dict:
    from commons import records  # local import: records imports effective for search reindex

    asset = store.get_asset(asset_id)
    if asset is None:
        raise KeyError(asset_id)
    measured = dict(asset.get("measurements") or {})
    measured.pop("code_version", None)
    fields: dict = copy.deepcopy(measured)
    sources = {path: "code" for path in _leaf_paths(measured)}
    for key in measured:
        sources[key] = "code"

    analysis = records.latest_analysis(store, asset_id)
    if analysis is not None:
        model_fields = copy.deepcopy(analysis["fields"] or {})
        fields.update(model_fields)
        tag = f"model:{analysis['model_id']}"
        for path in _leaf_paths(model_fields):
            sources[path] = tag
        for key in model_fields:
            sources.setdefault(key, tag)

    corrected: list[str] = []
    for corr in records.list_corrections(store, asset_id):
        apply_op(fields, corr["field_path"], corr["op"], corr["value"])
        sources[corr["field_path"]] = "corrected"
        if corr["actor"].startswith("human:") and corr["field_path"] not in corrected:
            corrected.append(corr["field_path"])

    return {"fields": fields, "sources": sources, "analysis": analysis, "corrected_paths": corrected,
            "stale": False}
