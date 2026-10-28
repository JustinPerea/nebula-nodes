"""Conditional Cinema scene writes (PR #198 fix round 8, H2; GM r9 decision 2).

A scene's ``sceneKey`` names its authoring: everything but the shots'
runtime (``output``, ``variations``, ``selectedVariation``, which runs write
and nobody authors). A write that says which scene it built on
(``ifSceneKey``) is refused with 409 ``scene_changed``, the scene Nebula has
now and its key, when the scene changed since, so nobody's edit replaces
another's unasked:

- The person's canvas sends the key of the scene its edits started from on
  every scene save, merges what changed (lib/cinemaSceneMerge) and sends
  again, or asks the person when both changed the same thing.
- An agent's write is held to the same rule (the rule is symmetric): with an
  ``ifSceneKey`` it is checked against that; without one, against the scene
  this agent last read (graph export, canvas snapshot, the node's own
  answer), so an agent that read the scene before the person typed in it
  can't put its older copy back over the typing. An agent that never read
  the scene writes it as it sends it (last writer), as before.

The keys are only compared, never parsed; a client echoes what Nebula gave it.
Reads and writers are kept per canvas (``scope``: the live graph and its
canvas, so a node id another canvas reuses never matches an older read).
"""

from __future__ import annotations

import hashlib
import itertools
import json
import weakref
from typing import Any, Mapping

RUNTIME_KEYS = ("output", "variations", "selectedVariation")

# (scope, agent name, node id) -> the sceneKey that agent last read there.
_reads: dict[tuple[str, str, str], str] = {}
# (scope, node id) -> who last changed its scene's authoring ({"kind", "name"}).
_writers: dict[tuple[str, str], dict[str, Any]] = {}
_graph_tokens: "weakref.WeakKeyDictionary[Any, str]" = weakref.WeakKeyDictionary()
_counter = itertools.count(1)


def graph_token(graph: Any) -> str:
    """A token for this graph object that no other graph gets (never reused,
    unlike id())."""
    try:
        token = _graph_tokens.get(graph)
        if token is None:
            token = f"g{next(_counter)}"
            _graph_tokens[graph] = token
        return token
    except TypeError:
        return f"id{id(graph)}"


def scene_key(scene: Any) -> str | None:
    """The scene's authoring key, or None for anything that isn't a scene."""
    if not isinstance(scene, Mapping):
        return None
    shots = scene.get("shots")
    authored = dict(scene)
    if isinstance(shots, list):
        authored["shots"] = [
            {key: value for key, value in shot.items() if key not in RUNTIME_KEYS} if isinstance(shot, Mapping) else shot
            for shot in shots
        ]
    text = json.dumps(authored, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def node_scene_key(node: Mapping[str, Any] | None) -> str | None:
    if not node or node.get("definitionId") != "cinema-scene":
        return None
    return scene_key((node.get("params") or {}).get("scene"))


def keys_of(nodes: Mapping[str, Mapping[str, Any]]) -> dict[str, str]:
    """Every Cinema scene's key, by node id."""
    out: dict[str, str] = {}
    for node_id, node in nodes.items():
        key = node_scene_key(node)
        if key:
            out[str(node_id)] = key
    return out


def note_read(scope: str, agent: str | None, keys: Mapping[str, str]) -> None:
    """An agent read these scenes (``keys`` from keys_of)."""
    if not agent:
        return
    for node_id, key in keys.items():
        _reads[(scope, agent, node_id)] = key


def last_read(scope: str, agent: str | None, node_id: str) -> str | None:
    return _reads.get((scope, agent, node_id)) if agent else None


def note_write(scope: str, node_id: str, actor: Mapping[str, Any] | None, key: str | None, agent: str | None) -> None:
    """A write changed the scene's authoring: who, and (for an agent) that
    it now knows this scene, as if it had read it."""
    if actor:
        _writers[(scope, node_id)] = dict(actor)
    if agent and key:
        _reads[(scope, agent, node_id)] = key


def writer(scope: str, node_id: str) -> dict[str, Any] | None:
    found = _writers.get((scope, node_id))
    return dict(found) if found else None


def forget() -> None:
    """The canvas was replaced (cleared, imported, another project opened):
    node ids start again, so nothing read or written before names them."""
    _reads.clear()
    _writers.clear()
