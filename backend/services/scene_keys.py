"""Conditional Cinema scene writes (PR #198 fix rounds 8 and 9, H2; GM r9
decision 2, r12 answer 4).

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
  this reader last read (graph export, canvas snapshot, ``GET /api/graph``,
  its own last write), so an agent that read the scene before the person
  typed in it can't put its older copy back over the typing. A reader that
  never read the scene writes it as it sends it (last writer), as before. A
  write whose scene is the one Nebula has is never refused (nothing would
  change). A refusal is not a read: the CLI prints only the detail, so its
  agent never saw the answer's scene, and a blind resend of the old copy
  must be refused again (fix round 9, L-1).
- A reader is a session, not a name (fix round 9, M-2): a verified agent
  token's chat session (or the token itself), else the name plus the
  ``X-Nebula-Agent-Session`` the MCP server sends, else the name alone.
  A named session's read is also kept under the bare name (fix round 10,
  M-1), and a write is checked against its own session's read when it has
  one, else against the name's: the newest read by any session of that
  name. So an MCP read guards a later ``nebula set`` or PUT that sends no
  session (MCP has no scene write), and a CLI write on top of a fresh MCP
  read is taken. Readers are given as a tuple, own key first
  (``main._scene_readers``).

Reads and writers are kept per canvas (``scope``: the live graph, its
project and canvas epoch), so a node id another canvas uses never matches;
nothing is forgotten on a project switch (fix round 9, M-1: reopening a
project finds its readers' reads where they were). Both are bounded.

Each scene also has a ``sceneRev`` (fix round 9, H-1): a number that grows
every time Nebula is seen holding a different authoring for that node
(across restarts too: it starts from the clock). A canvas that has seen
revision R treats any scene below R as older than what it knows, so a sync
the socket delivers late never rolls the card back.

The keys are only compared, never parsed; a client echoes what Nebula gave it.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import time
import weakref
from collections import OrderedDict
from typing import Any, Mapping, Sequence

RUNTIME_KEYS = ("output", "variations", "selectedVariation")
MAX_READS = 4096
MAX_WRITERS = 1024

# (scope, reader, node id) -> the sceneKey that reader last read there.
_reads: "OrderedDict[tuple[str, str, str], str]" = OrderedDict()
# (scope, node id) -> who last changed its scene's authoring ({"kind", "name"}).
_writers: "OrderedDict[tuple[str, str], dict[str, Any]]" = OrderedDict()
# node id -> (scope, key, revision) Nebula last showed for it.
_revisions: dict[str, tuple[str, str, int]] = {}
# Microseconds since the epoch at start, then +1 a change: above any
# revision an earlier run of Nebula gave (unless it bumped a million a second).
_revision_counter = itertools.count(time.time_ns() // 1000)
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


def revision(scope: str, node_id: str, key: str) -> int:
    """The revision of ``key`` as node ``node_id``'s scene now: the same one
    while Nebula keeps showing that authoring, a higher one as soon as it
    shows another (or the node is another canvas's)."""
    seen = _revisions.get(node_id)
    if seen is not None and seen[0] == scope and seen[1] == key:
        return seen[2]
    rev = next(_revision_counter)
    _revisions[node_id] = (scope, key, rev)
    return rev


def revisions_of(scope: str, keys: Mapping[str, str]) -> dict[str, int]:
    """``revision`` for every scene in ``keys`` (keys_of)."""
    return {node_id: revision(scope, node_id, key) for node_id, key in keys.items()}


def _readers(reader: "str | Sequence[str] | None") -> tuple[str, ...]:
    if not reader:
        return ()
    if isinstance(reader, str):
        return (reader,)
    return tuple(key for key in reader if key)


def note_read(scope: str, reader: "str | Sequence[str] | None", keys: Mapping[str, str]) -> None:
    """A reader read these scenes (``keys`` from keys_of): kept under each
    of its keys (its session's, then its name's)."""
    for name in _readers(reader):
        for node_id, key in keys.items():
            _keep(_reads, (scope, name, node_id), key, MAX_READS)


def last_read(scope: str, reader: "str | Sequence[str] | None", node_id: str) -> str | None:
    """The scene the writer last read there: its own key's read first, else
    the next key's (a session that never read falls back to its name's)."""
    for name in _readers(reader):
        found = _reads.get((scope, name, node_id))
        if found is not None:
            return found
    return None


def note_write(scope: str, node_id: str, actor: Mapping[str, Any] | None, key: str | None,
               reader: "str | Sequence[str] | None") -> None:
    """A write changed the scene's authoring: who, and (for an agent) that
    it now knows this scene, as if it had read it."""
    if actor:
        _keep(_writers, (scope, node_id), dict(actor), MAX_WRITERS)
    if key:
        for name in _readers(reader):
            _keep(_reads, (scope, name, node_id), key, MAX_READS)


def writer(scope: str, node_id: str) -> dict[str, Any] | None:
    found = _writers.get((scope, node_id))
    return dict(found) if found else None


def _keep(book: "OrderedDict[Any, Any]", key: Any, value: Any, limit: int) -> None:
    book.pop(key, None)
    book[key] = value
    while len(book) > limit:
        book.popitem(last=False)


def forget() -> None:
    """Tests: start with no reads, writers or revisions."""
    _reads.clear()
    _writers.clear()
    _revisions.clear()
