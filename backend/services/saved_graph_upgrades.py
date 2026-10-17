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
  the canvas forwards to ``POST /api/graph/import``;
- a stale tab's canvas saved as a recovered copy: ``"paramsVersion"`` in the
  ``POST /api/projects/recover`` body, the version the tab's canvas was loaded
  at (a body without it came from a bundle older than the marker: version 0);
- Create drafts kept in the browser: ``paramsVersion`` in the localStorage
  payload (frontend/src/store/createDraftStore.ts, rule mirrored in
  frontend/src/lib/savedParamsUpgrades.ts);
- a style preset: ``"paramsVersion"`` in its file (services/preset_store.py;
  not the preset's ``version``, which counts edits). Reads upgrade a copy
  without writing, every write stores the upgraded params stamped current, and
  ``POST /api/presets`` takes the body's ``paramsVersion`` (missing = 0: main's
  Create posts without it), ``PUT`` the same (missing = current: no bundle
  sends PUT).

Order with ``services/retired_nodes.py``: the live graph's load, an import and
a preset read move retired and folded nodes onto the node they became first,
and these upgrades see the result. A stored project is upgraded when the
catalog is read and migrated when it opens, so the other way round. Version 1
and the Krea FLUX fold touch different nodes, so the order changes nothing
today; a later rule for a node that is retired or folded must match it under
both ids.

Run records are never rewritten: each one is what that run sent. The canvas
stamps each new record with the version it was sent at (``paramsVersion`` on
the record, outside its snapshot so recipe hashes don't change; a record
without it predates the stamp: version 0) and upgrades a copy of the recipe
when it is used again: replays, Create's "Reuse settings" and Paper freshness
(``upgradeRunSnapshot`` in frontend/src/lib/savedParamsUpgrades.ts). The
backend only stores records, so it keeps the stamp as sent.

A browser tab whose canvas loaded before an upgrade can't be upgraded in
place: its values may have been set in that tab, and its bundle has the old
rules. It is treated as stale instead (round 2, item 3):

- the bundle sends ``X-Nebula-Params-Version`` on every request; a request
  with a lower or higher version, or with none when it carries the canvas's
  ``X-Nebula-Workspace-Revision`` or comes from a browser (``Origin`` or
  ``Sec-Fetch-Site``: an old tab can be on the canvas with no project
  context), gets 409 ``params_outdated`` on every route that stores or runs
  params (``project_workspace_fence`` and ``_params_outdated`` in main.py;
  recovery stays open). Agents, the CLI, MCP and scripts send none of these
  headers and pass as sent;
- a boot that finds the catalog or state.json saved before ``PARAMS_VERSION``
  gives the workspace a new revision and writes both files at once
  (``ProjectStore.advance_params_version``), so tabs from before the restart
  stop merging graph syncs and stop saving;
- ``paramsVersion`` is in graphSync, ``GET /api/projects`` and the project
  create and open replies, and a bundle that sees another version (a backend
  that sends none predates the gate: version 0) stops saving and running,
  saves its unsaved work as a recovered copy, and reloads when the backend is
  newer (frontend/src/store/projectStore.ts).

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
    # A hand-edited file can hold any JSON here; only a model id string is
    # one of the four (a list or dict would make the set lookup raise).
    model = params.get("model")
    # Same truthiness the handler uses for the toggle.
    if (isinstance(model, str) and model in CLAUDE_THINKING_MODELS and params.get("extended_thinking")
            and _is_old_max_tokens(params.get("max_tokens"))):
        return {**params, "max_tokens": UPGRADED_MAX_TOKENS}
    return None


def upgrade_flat_nodes(nodes: Iterable[Any], version: int) -> int:
    """Upgrade ``{definitionId, params}`` nodes in place (live graph, import
    bodies). Returns how many changed."""
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
    (``{data: {definitionId, params}}``) and its Create draft
    (``{modelId, params}``), which Generate in Create sends as saved.

    Run records (``runHistory``) are left alone. Each one is what that run
    sent (main sent 4,096), and a Paper run keeps a hash of its recipe
    (runHistory.ts ``recipeRevision``), so rewriting one would record a
    request that never happened. The canvas upgrades a copy instead, by the
    record's ``paramsVersion`` stamp, when the record is replayed or reused
    (``upgradeRunSnapshot`` in frontend/src/lib/savedParamsUpgrades.ts): a
    replay of a version-0 record that sent 4,096 sends 64,000."""
    if not isinstance(snapshot, dict):
        return 0
    changed = 0
    nodes = snapshot.get("nodes")
    for node in nodes if isinstance(nodes, list) else []:
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict):
            continue
        upgraded = upgrade_params(data.get("definitionId"), data.get("params"), version)
        if upgraded is not None:
            data["params"] = upgraded
            changed += 1
    draft = snapshot.get("createDraft")
    if isinstance(draft, dict):
        # The Create model id is the node definition id (createModels.ts).
        upgraded = upgrade_params(draft.get("modelId"), draft.get("params"), version)
        if upgraded is not None:
            draft["params"] = upgraded
            changed += 1
    return changed


def request_version(body: dict[str, Any], missing: int | None) -> int | None:
    """``body["paramsVersion"]`` from a request, or ``missing`` without the key.
    Raises ValueError unless it is a non-negative integer."""
    if "paramsVersion" not in body:
        return missing
    version = body["paramsVersion"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        raise ValueError("paramsVersion must be a non-negative integer")
    return version


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


def catalog_params_behind(catalog: dict[str, Any]) -> bool:
    """Whether a catalog read from disk (not yet upgraded) holds a project or
    trash entry saved before ``PARAMS_VERSION``."""
    return any(
        isinstance(project, dict) and stored_version(project.get("_paramsVersion")) < PARAMS_VERSION
        for group in (catalog.get("projects"), catalog.get("trash")) if isinstance(group, dict)
        for project in group.values()
    )


def upgrade_catalog(catalog: dict[str, Any]) -> int:
    """Upgrade every project and trash entry in a catalog read from disk."""
    changed = 0
    for group in (catalog.get("projects"), catalog.get("trash")):
        if isinstance(group, dict):
            for project in group.values():
                if isinstance(project, dict):
                    changed += upgrade_project(project)
    return changed
