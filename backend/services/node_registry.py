from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "node_definitions.json"


class NodeRegistry:
    """Read-only registry of node definitions loaded from the exported JSON."""

    def __init__(self, path: Path | None = None) -> None:
        p = path or _DATA_PATH
        with open(p) as f:
            self._nodes: dict[str, dict[str, Any]] = json.load(f)

    def get_all(self) -> dict[str, dict[str, Any]]:
        return self._nodes

    def get(self, node_id: str) -> dict[str, Any] | None:
        return self._nodes.get(node_id)

    def get_by_category(self, category: str) -> list[dict[str, Any]]:
        return [n for n in self._nodes.values() if n.get("category") == category]

    def get_categories(self) -> list[str]:
        cats: dict[str, None] = {}
        for n in self._nodes.values():
            cats[n["category"]] = None
        return list(cats.keys())

    def get_nodes_for_key(self, key_name: str) -> list[dict[str, Any]]:
        result = []
        for n in self._nodes.values():
            env = n.get("envKeyName", "")
            if isinstance(env, list):
                if key_name in env:
                    result.append(n)
            elif env == key_name:
                result.append(n)
        return result

    def get_all_key_names(self) -> set[str]:
        keys: set[str] = set()
        for n in self._nodes.values():
            env = n.get("envKeyName", "")
            if isinstance(env, list):
                keys.update(env)
            elif env:
                keys.add(env)
        return keys

    def search(self, query: str) -> list[dict[str, Any]]:
        q = query.lower()
        return [
            n for n in self._nodes.values()
            if q in n["id"].lower() or q in n.get("displayName", "").lower()
        ]
