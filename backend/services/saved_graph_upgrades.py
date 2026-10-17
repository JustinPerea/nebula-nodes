"""One-time upgrades of params in saved graphs.

``services/retired_nodes.py`` handles values a provider shut down: those fixes
are stateless and run on every path, because a dead value is never right.
This module handles a value whose *meaning* changed. A saved value can't be
told apart from the same value set on purpose later, so each upgrade runs
once per saved graph, and the graph records that it ran (``PARAMS_VERSION``):

- a project in the catalog: ``project["_paramsVersion"]`` (projects/catalog.json;
  ``ProjectStore._read`` upgrades, ``make_project`` starts new projects current);
- the live graph file (state.json): ``"paramsVersion"`` (``CLIGraph.load``
  upgrades, every save writes the current version);
- a graph file being imported: ``"paramsVersion"`` in the .nebula file, which
  the canvas forwards to ``POST /api/graph/import``.

A graph without the marker is version 0, saved before any upgrade existed.

Version 1 (Justin, 2026-10-17): claude-chat nodes on Claude Opus 4.6, Sonnet
4.6, Opus 4.7 or Opus 4.8 with Extended Thinking on, holding Max Tokens 4,096.
4,096 was the only default before 2026-10-16. On those models the toggle now
sends adaptive thinking with no budget, and "thinking tokens count toward
max_tokens, so a long thinking pass can consume the budget before the text
response completes" (platform.claude.com thinking-troubleshooting, fetched
2026-10-16). Their default is now 64,000, so the saved 4,096 becomes 64,000:
the card shows what runs, and a 4,096 typed afterwards is kept.
"""
from __future__ import annotations

from typing import Any, Iterable

PARAMS_VERSION = 1

# Version 1. Frozen here (not read from the definition) so a later default
# change can't change what this upgrade did.
CLAUDE_THINKING_MODELS = frozenset({
    "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-8",
})
OLD_MAX_TOKENS = 4096
UPGRADED_MAX_TOKENS = 64_000


def _is_old_max_tokens(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value == OLD_MAX_TOKENS
    return isinstance(value, str) and value.strip() == str(OLD_MAX_TOKENS)


def upgrade_params(definition_id: Any, params: Any, version: int) -> dict[str, Any] | None:
    """The params a node saved at ``version`` should hold now, or None if unchanged."""
    if version >= 1 or definition_id != "claude-chat" or not isinstance(params, dict):
        return None
    # Same truthiness the handler uses for the toggle.
    if (params.get("model") in CLAUDE_THINKING_MODELS and params.get("extended_thinking")
            and _is_old_max_tokens(params.get("max_tokens"))):
        return {**params, "max_tokens": UPGRADED_MAX_TOKENS}
    return None


def upgrade_flat_nodes(nodes: Iterable[Any], version: int) -> int:
    """Upgrade ``{definitionId, params}`` nodes in place (live graph, run
    recipes, import bodies). Returns how many changed."""
    changed = 0
    for node in nodes:
        if not isinstance(node, dict):
            continue
        upgraded = upgrade_params(node.get("definitionId"), node.get("params"), version)
        if upgraded is not None:
            node["params"] = upgraded
            changed += 1
    return changed


def upgrade_snapshot(snapshot: Any, version: int) -> int:
    """Upgrade a saved canvas snapshot in place: its React Flow nodes
    (``{data: {definitionId, params}}``) and the recipe of every run in its
    history, which a replay sends as saved."""
    if not isinstance(snapshot, dict):
        return 0
    changed = 0
    for node in snapshot.get("nodes") or []:
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict):
            continue
        upgraded = upgrade_params(data.get("definitionId"), data.get("params"), version)
        if upgraded is not None:
            data["params"] = upgraded
            changed += 1
    for record in snapshot.get("runHistory") or []:
        recipe = record.get("snapshot") if isinstance(record, dict) else None
        if isinstance(recipe, dict) and isinstance(recipe.get("nodes"), list):
            changed += upgrade_flat_nodes(recipe["nodes"], version)
    return changed


def stored_version(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def upgrade_project(project: dict[str, Any]) -> int:
    """Bring one catalog project (or trash entry) to ``PARAMS_VERSION``."""
    version = stored_version(project.get("_paramsVersion"))
    if version >= PARAMS_VERSION:
        return 0
    changed = upgrade_snapshot(project.get("snapshot"), version)
    project["_paramsVersion"] = PARAMS_VERSION
    return changed


def upgrade_catalog(catalog: dict[str, Any]) -> int:
    """Upgrade every project and trash entry in a catalog read from disk."""
    changed = 0
    for group in (catalog.get("projects"), catalog.get("trash")):
        if isinstance(group, dict):
            for project in group.values():
                if isinstance(project, dict):
                    changed += upgrade_project(project)
    return changed
