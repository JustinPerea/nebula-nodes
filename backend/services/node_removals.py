"""Which delete of which node a removal record undoes (second review, 2026-10-23).

GM - Design, item 1: "Make undo complete." Every node delete makes a removal
record ({id: "rm_...", nodeId, projectId, definitionId, pins, proposals},
main._remove_side_effects), and the restore that brings the node back names
it. Node ids are not unique over time: an import or a clear starts CLIGraph's
counter at n1 again, a restore may put any id back, and every project has its
own n1. So a record is bound to exactly one delete of exactly one node, and
nothing matches one by the bare node id:

- ``mint`` keeps what each removal id was minted for (the node id, its
  project and its model), so a restore can tell a record that really undoes
  this node's delete from a stale or forged one (``verdict``);
- ``lineage`` names which node sits under an id: a node keeps its lineage
  through any number of deletes and the undos that bring it back, and a node
  anything else put there (a plain add after a clear or an import, a restore
  with no record of its own) gets a new one. A proposal remembers the lineage
  of each node it reads, so a later delete of another node under the same id
  doesn't tag it;
- ``restored`` remembers, per node a restore brought back, the removal it
  consumed. The next delete of that same node names it (``replaces``), and
  only the records with that id are renewed to the new one (the canvas's
  stacked steps, an agent's kept edit). A node an import, a clear or a plain
  add put under the id has consumed nothing, so its delete replaces nothing.

Memory only, like the undo book and canvas proposals: after a restart a
record is checked against what persists (a pin's ``detachedBy``,
``detachedFrom`` and ``detachedDefinition``), and a delete of a node that
came back before the restart replaces only what a pin there proves.
"""
from __future__ import annotations

import secrets
from collections import OrderedDict
from typing import Any, Mapping

MAX_MINTED = 4096


def new_removal_id() -> str:
    return "rm_" + secrets.token_hex(8)


class RemovalLedger:
    def __init__(self) -> None:
        # removal id -> {nodeId, projectId, definitionId}, oldest first.
        self._minted: OrderedDict[str, dict[str, Any]] = OrderedDict()
        # (project id, node id) -> the removal id the restore that brought it back consumed.
        self._restored: dict[tuple[str | None, str], str] = {}
        # (project id, node id) -> its lineage, when it isn't the generation's own (``lineage``).
        self._lineage: dict[tuple[str | None, str], str] = {}
        # project id -> how many times its ids started again (a clear, an import).
        self._generation: dict[str | None, int] = {}

    def lineage(self, project_id: str | None, node_id: str) -> str:
        """Which node is under ``node_id`` now. A node an add put there since
        the project's ids last started again is "g<generation>": ids come
        from a counter, so within one generation an id names one node unless
        a restore put another there, which records its own."""
        return self._lineage.get((project_id, node_id)) or f"g{self._generation.get(project_id, 0)}"

    def mint(self, *, node_id: str, project_id: str | None, definition_id: str) -> dict[str, Any]:
        """A new removal of ``node_id``: the start of its record. It names the
        removal it supersedes (``replaces``) when a restore brought this very
        node back by consuming one."""
        removal = new_removal_id()
        while removal in self._minted:  # vanishingly unlikely
            removal = new_removal_id()
        self._minted[removal] = {"nodeId": node_id, "projectId": project_id, "definitionId": definition_id,
                                 "lineage": self.lineage(project_id, node_id)}
        self._lineage.pop((project_id, node_id), None)
        while len(self._minted) > MAX_MINTED:
            self._minted.popitem(last=False)
        record: dict[str, Any] = {"id": removal, "nodeId": node_id, "projectId": project_id,
                                  "definitionId": definition_id}
        replaces = self._restored.pop((project_id, node_id), None)
        if replaces:
            record["replaces"] = replaces
        return record

    def verdict(self, record: Mapping[str, Any], *, project_id: str | None, definition_id: str) -> bool | None:
        """Whether ``record`` undoes the delete of the node a restore brought
        back now (in ``project_id``, as ``definition_id``): True when this
        backend minted it for exactly that, False when it minted it for
        anything else, None when it doesn't know the id (a restart, a made-up id)."""
        minted = self._minted.get(str(record.get("id") or ""))
        if minted is None:
            return None
        return (minted["nodeId"] == record.get("nodeId") and minted["projectId"] == project_id
                and minted["definitionId"] == definition_id)

    def restored(self, project_id: str | None, node_id: str, removal: str | None) -> None:
        """A restore put ``node_id`` back, undoing ``removal`` (None: as no
        delete's undo, so its next delete replaces nothing)."""
        if removal:
            self._restored[(project_id, node_id)] = removal
        else:
            self._restored.pop((project_id, node_id), None)
        minted = self._minted.get(removal or "")
        # The node that delete took, back again; anything else is a node of its own.
        self._lineage[(project_id, node_id)] = (minted["lineage"] if minted is not None
                                                else "u" + secrets.token_hex(8))

    def forget_project(self, project_id: str | None) -> None:
        """A clear or an import put new nodes under the project's ids: none of
        them is a node a restore brought back."""
        for key in [key for key in self._restored if key[0] == project_id]:
            self._restored.pop(key, None)
        for key in [key for key in self._lineage if key[0] == project_id]:
            self._lineage.pop(key, None)
        self._generation[project_id] = self._generation.get(project_id, 0) + 1
