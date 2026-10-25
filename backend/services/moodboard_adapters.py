"""Moodboard adapters: how each node takes a wired Nebula moodboard.

Moodboard canvas plan section 5.7 (decisions A1 to A5, B1 to B4); contract 07
section 1.16. A node's ``moodboard`` input port is declared in the node
definitions like any port. *How* the node takes a board lives here, in one
table, not in the definitions (the TS and JSON registries drift, two video
targets carry JSON-only fixes, and generated Krea nodes are never edited by
hand; ``model_pricing.json`` is the precedent):

- ``data/moodboard_adapters.json``: hand-written entries, each with its
  ``sources``, ``checked`` date and ``unconfirmed`` list, plus the census of
  generators still waiting for a port (rule 12 below).
- ``data/moodboard_adapters_krea.json``: written by
  ``scripts/sync-krea-catalog.py`` from Krea's catalog (``generatedBy``),
  never edited by hand.

An id in both files is refused. One entry (plan section 5.7.2)::

    "<nodeId>": {
      "channel": "weighted-style" | "style-object" | "refs" | "role-slots" | "views"
                 | "texture-style" | "music" | "text-only",
      "default": "images" | "text" | "never",        # A1, for entries that take images
      "handler": "reads-board",                       # Krea 2 until PR15
      "slots": [{"port": "images", "max": 16, "roles"?: {...}, "sharesLimitWith"?: ["style_images"]}],
      "needsWired"?: ["images"],    # must be wired first: the board never supplies image 1
      "never": ["mask", ...],       # frames, edit targets, views, identity, non-image Any ports
      "exclusive"?: [...],          # wiring one means no board references (per route via byRoute)
      "textSlot": {"port": "prompt"} | {"param": "texture_prompt"},
      "textUnless"?: "texture_image",
      "text": "brief" | "music-direction",
      "negativeField"?: "auto",
      "paletteParam"?: {"param": "colors", "format": "recraft-rgb"},
      "weight": {"mode": "native", "field": "strength", "range": [0, 1], "normalize": "sum-to-strength",
                 "precision": 0.0001, "schema": {"source": "krea-catalog", "endpoints": [...], "field": ...}}
              | {"mode": "at-creation", "field": "image_weights", "normalize": "sum-to-one"}
              | {"mode": "global", "param": "image_prompt_strength", "range": [0, 1], "source": "person"}
              | {"mode": "select", "normalize": "rank"},
      "order": "weight",
      "syntax": "Image {n}" | "plain" | null, "syntaxReason"?: "...",
      "limits"?: {...}, "requires"?: {...}, "collage"?: false,
      "costPerRef"?: "priced" | "free" | "plus" | "unknown",
      "byModel"?: {"model=gen4_image": {...}}, "byRoute"?: {"fal": {...}},
      "sources": [{"url" | "code": ..., "quote"?: ..., "checked"?: ...}], "checked": "2026-10-20",
      "unconfirmed"?: [...], "reason"?: "..."
    }

``slots[].sharesLimitWith`` (not in the plan's sketch) names wired ports that
count against the slot's ``max`` because the handler sends them in the same
request field: Krea 2's ``style_images`` and ``image_style_references`` both
become Krea's ``image_style_references`` (``handlers/krea.py``). A
``weight.schema`` names the vendor schema Nebula records for a native range
(rule 13): today the pinned Krea catalog.

:func:`table_problems` is the A5 contract (plan section 5.7.10), mirrored by
``scripts/check-node-contracts.mjs``; ``tests/test_moodboard_adapters.py``
runs both. Rules 10 (the generated file) and 11 (maker routes that refuse a
start image with references, run with HTTP mocked) live in that test.

PR13 builds the table and dispatch steps 1, 2 and 8: ``apply_to_generator``
resolves the entry for the node, its params and route, sends today's text
fold through it and drops the Moodboard port unless the entry's handler
reads the board. Every other step (images, the switch, text slots that are
params, music direction, negatives from the route, palette, exclusive,
needsWired, the face policy) is PR14's; their fields are accepted and
validated here so the vocabulary is defined once, and nothing reads them yet.
"""
from __future__ import annotations

import copy
import datetime
import json
import re
from pathlib import Path
from typing import Any, Iterable, Mapping

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
REPO_ROOT = DATA_DIR.parent.parent
ADAPTERS_PATH = DATA_DIR / "moodboard_adapters.json"
KREA_ADAPTERS_PATH = DATA_DIR / "moodboard_adapters_krea.json"
KREA_CATALOG_PATH = DATA_DIR / "krea_gateway_models.json"
NODE_DEFINITIONS_PATH = DATA_DIR / "node_definitions.json"
GENERATED_BY = "scripts/sync-krea-catalog.py"

BOARD_PORT = "moodboard"
CHANNELS = ("weighted-style", "style-object", "refs", "role-slots", "views", "texture-style", "music", "text-only")
DEFAULTS = ("images", "text", "never")
HANDLERS = ("reads-board",)
TEXTS = ("brief", "music-direction")
# Q21 b: which form of the board's weights each mode needs (section 5.7.4).
WEIGHT_NORMALIZE = {"native": "sum-to-strength", "at-creation": "sum-to-one", "select": "rank", "global": None}
COST_PER_REF = ("priced", "free", "plus", "unknown")
FACE_POLICIES = ("block", "warn", "allow")
LIMIT_FIELDS = {"maxEdge", "minEdge", "maxBytes", "requestBytes", "formats", "face"}
CLASSIFIED_TYPES = ("Image", "Any")
# Rule 5: a port whose id or label says one of these is a frame.
FRAME_WORDS = ("first", "last", "start", "end", "tail", "frame", "frames", "keyframe", "keyframes")
CENSUS_CATEGORIES = ("image-gen", "video-gen", "audio-gen")
_SYNTAX = re.compile(r"^(plain|[^{}]*\{n\}[^{}]*)$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PENDING = re.compile(r"^PR\d+[a-z]?$")

ENTRY_FIELDS = {
    "channel", "default", "handler", "slots", "needsWired", "never", "exclusive", "textSlot", "textUnless", "text",
    "negativeField", "paletteParam", "weight", "order", "syntax", "syntaxReason", "limits", "requires", "collage",
    "costPerRef", "byModel", "byRoute", "sources", "checked", "unconfirmed", "reason",
}
SLOT_FIELDS = {"port", "max", "roles", "sharesLimitWith"}
WEIGHT_FIELDS = {"mode", "field", "param", "range", "normalize", "precision", "schema", "source"}
# What a text-only entry has no use for; a byModel or byRoute override that
# makes an entry text-only drops them (resolve_entry).
IMAGE_FIELDS = ("default", "handler", "slots", "needsWired", "exclusive", "weight", "order", "syntax",
                "syntaxReason", "limits", "requires", "collage", "costPerRef")

MISSING_ENTRY_NOTE = "This node has no moodboard adapter entry, so the board went as text only."


# -- loading ---------------------------------------------------------------------------------------------

def _read(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
        raise ValueError(f"{path.name} must be an object with an entries object")
    return data


def load_table(path: Path = ADAPTERS_PATH, krea_path: Path = KREA_ADAPTERS_PATH) -> dict[str, Any]:
    """Both tables as one: ``{"entries": {...}, "census": {...}, "generated": [ids]}``.
    Entries are sorted by node id. An id in both files is a ValueError."""
    hand = _read(path)
    krea = _read(krea_path) if krea_path.exists() else {"entries": {}}
    both = sorted(set(hand["entries"]) & set(krea["entries"]))
    if both:
        raise ValueError(f"{both[0]} is in both {path.name} and {krea_path.name}; the generated file owns "
                         "Krea catalog nodes and the hand-written one the rest")
    entries = {**hand["entries"], **krea["entries"]}
    census = hand.get("census") if isinstance(hand.get("census"), dict) else {}
    return {"entries": dict(sorted(entries.items())), "census": census, "generated": sorted(krea["entries"])}


_cache: dict[str, Any] = {"key": None, "table": None}


def table() -> dict[str, Any]:
    """The table, read again when either file changes (an entry update needs
    no restart, as with prices)."""
    key = tuple(p.stat().st_mtime_ns if p.exists() else None for p in (ADAPTERS_PATH, KREA_ADAPTERS_PATH))
    if _cache["key"] != key:
        _cache["table"] = load_table()
        _cache["key"] = key
    return _cache["table"]


def public_table() -> dict[str, Any]:
    """What ``GET /api/moodboard/adapters`` serves: the entries, unresolved
    (the frontend resolves ``byModel``/``byRoute`` as :func:`resolve_entry`)."""
    return {"entries": copy.deepcopy(table()["entries"])}


_definitions_cache: dict[str, Any] = {"key": None, "definitions": None}


def _definitions() -> dict[str, Any]:
    key = NODE_DEFINITIONS_PATH.stat().st_mtime_ns
    if _definitions_cache["key"] != key:
        _definitions_cache["definitions"] = json.loads(NODE_DEFINITIONS_PATH.read_text(encoding="utf-8"))
        _definitions_cache["key"] = key
    return _definitions_cache["definitions"]


# -- resolving -------------------------------------------------------------------------------------------

def _matches(key: str, params: Mapping[str, Any]) -> bool:
    param, _, value = key.partition("=")
    have = params.get(param)
    if isinstance(have, bool):
        have = "true" if have else "false"
    return have is not None and str(have) == value


def resolve_entry(entry: Mapping[str, Any], params: Mapping[str, Any] | None, route: str | None) -> dict[str, Any]:
    """``entry`` for a run with these (effective) params on ``route``:
    ``byModel`` overrides whose ``param=value`` holds, then the ``byRoute``
    override for the route, each replacing the fields it names. A result that
    is text-only drops the image fields, and its former slots become never."""
    values = params or {}
    out = {key: copy.deepcopy(value) for key, value in entry.items() if key not in ("byModel", "byRoute")}
    for key, override in (entry.get("byModel") or {}).items():
        if isinstance(override, Mapping) and _matches(str(key), values):
            out.update(copy.deepcopy(dict(override)))
    by_route = entry.get("byRoute") or {}
    if route is not None and isinstance(by_route.get(route), Mapping):
        out.update(copy.deepcopy(dict(by_route[route])))
    if out.get("channel") == "text-only":
        # The board never fills what were the slots.
        slots = [slot.get("port") for slot in out.get("slots") or [] if isinstance(slot, Mapping)]
        never = list(out.get("never") or [])
        out_never = [*never, *(port for port in slots if isinstance(port, str) and port not in never)]
        for key in IMAGE_FIELDS:
            out.pop(key, None)
        if out_never:
            out["never"] = out_never
    return out


def resolve(node_id: str, params: Mapping[str, Any] | None, route: str | None = None, *,
            definition: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    """The entry for ``node_id`` with these params on ``route`` (None: no
    entry). Unset params read as their defaults, as a run reads them."""
    entry = table()["entries"].get(node_id)
    if entry is None:
        return None
    from services import node_route

    definition = definition if definition is not None else _definitions().get(node_id)
    values = node_route.effective_values(definition, params) if isinstance(definition, Mapping) else dict(params or {})
    return resolve_entry(entry, values, route)


def run_route(definition: Mapping[str, Any] | None, params: Mapping[str, Any] | None, inputs: Mapping[str, Any],
              api_keys: Mapping[str, Any] | None) -> str | None:
    """The route id a run of this node takes, for ``byRoute``: as the
    dual-route handler and the cache key pick it (a Krea-only setting that
    arrives by wire keeps the run on the copy). None for a node with one
    route, without keys, or when no route can run it."""
    if not isinstance(definition, Mapping) or api_keys is None:
        return None
    from services import node_route

    if not (node_route.has_routes(definition) or node_route.is_multi_route(definition)):
        return None
    routed = node_route.with_wired_blockers(definition, params, node_route.filled_ports(inputs))
    route = node_route.select_route(definition, routed, api_keys)
    if route.kind in (node_route.UNSET, node_route.LOCAL):
        return None
    return route.route_id or route.provider


# -- what agents read (describe_node, `nebula info`) -----------------------------------------------------

TEXT_LINE = "This model takes the brief as text."
NO_ENTRY_NOTE = "This node has no moodboard adapter entry, so a connected board goes as text only."
# Table bookkeeping an agent has no use for; byModel and byRoute come back as `variants`.
_INTERNAL_FIELDS = ("sources", "checked", "byModel", "byRoute")


def card_line(entry: Mapping[str, Any] | None, definition: Mapping[str, Any] | None) -> str:
    """What the board does on this node, as the card's Moodboard line says it
    (lib/moodboardAdapters.ts adapterLine; plan section 5.7.8)."""
    if not entry or entry.get("channel") == "text-only":
        return TEXT_LINE
    slots = [slot for slot in entry.get("slots") or [] if isinstance(slot, Mapping)]
    if entry.get("default") == "images" and slots:
        slot = slots[0]
        ports = (definition or {}).get("inputPorts") or []
        label = next((port.get("label") for port in ports
                      if isinstance(port, Mapping) and port.get("id") == slot.get("port") and port.get("label")),
                     slot.get("port"))
        return f"Board images: on · up to {slot.get('max')} to {label}"
    return "Board images: off · the brief goes as text"


def _plain(entry: Mapping[str, Any], definition: Mapping[str, Any]) -> dict[str, Any]:
    """A resolved entry in the fields an agent reads: no sources or dates,
    each slot with its port's label, the weight without its vendor schema."""
    labels = {str(port.get("id")): port.get("label") for port in definition.get("inputPorts") or []
              if isinstance(port, Mapping)}
    out = {key: copy.deepcopy(value) for key, value in entry.items() if key not in _INTERNAL_FIELDS}
    if isinstance(out.get("slots"), list):
        out["slots"] = [{"port": slot.get("port"), "label": labels.get(str(slot.get("port"))) or slot.get("port"),
                         **{key: value for key, value in slot.items() if key != "port"}}
                        if isinstance(slot, Mapping) else slot for slot in out["slots"]]
    if isinstance(out.get("weight"), Mapping):
        out["weight"] = {key: value for key, value in out["weight"].items() if key != "schema"}
    return out


class _Wired:
    value = "moodboard"  # a filled Moodboard port, for run_route's wired blockers


def describe(definition: Mapping[str, Any] | None, api_keys: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """What a wired Nebula moodboard does on this node type, for agents
    (describe_node's ``moodboardAdapter``, ``nebula info``): the entry resolved
    at the defaults on the route a run takes here with these keys (as the card
    resolves it once a board is wired), its card ``line``, the ``route`` when
    the node has more than one, and ``variants``: each ``byModel`` value or
    ``byRoute`` route that changes it, with the fields it changes (null =
    dropped) and its line. None for a node without a Moodboard port."""
    if board_port(definition) is None:
        return None
    assert definition is not None
    node_id = str(definition.get("id") or "")
    entry = table()["entries"].get(node_id)
    if entry is None:
        return {"line": TEXT_LINE, "channel": None, "note": NO_ENTRY_NOTE}
    wired = {BOARD_PORT: _Wired()}
    route = run_route(definition, {}, wired, api_keys or {})
    base = _plain(resolve(node_id, {}, route, definition=definition) or {}, definition)
    out: dict[str, Any] = {"line": card_line(base, definition), **base}
    if route is not None:
        out["route"] = route

    def variant(when: dict[str, str], resolved: Mapping[str, Any]) -> dict[str, Any] | None:
        plain = _plain(resolved, definition)
        changed = {key: plain.get(key) for key in sorted(set(plain) | set(base)) if plain.get(key) != base.get(key)}
        return {"when": when, "line": card_line(plain, definition), **changed} if changed else None

    variants = []
    for key in (entry.get("byModel") or {}):
        param, _, value = str(key).partition("=")
        # A value can move the run to another route (a maker rule that keeps
        # it on the copy): resolved on the route that run takes, as it runs.
        moved = run_route(definition, {param: value}, wired, api_keys or {})
        found = variant({param: value}, resolve(node_id, {param: value}, moved, definition=definition) or {})
        if found and moved != route:
            found["route"] = moved
        if found:
            variants.append(found)
    for route_id in (entry.get("byRoute") or {}):
        if route_id != route:
            found = variant({"route": str(route_id)}, resolve(node_id, {}, str(route_id), definition=definition) or {})
            if found:
                variants.append(found)
    if variants:
        out["variants"] = variants
    return out


# -- the contract (plan section 5.7.10) ------------------------------------------------------------------

def frame_word(port_id: str, label: str = "") -> str | None:
    """The frame word in a port's id or label (rule 5), or None."""
    words: list[str] = []
    for text in (port_id, label):
        spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", str(text or ""))
        words.extend(word.lower() for word in re.split(r"[^A-Za-z0-9]+", spaced) if word)
    return next((word for word in words if word in FRAME_WORDS), None)


def board_port(definition: Mapping[str, Any] | None) -> Mapping[str, Any] | None:
    if not isinstance(definition, Mapping):
        return None
    return next((port for port in definition.get("inputPorts") or []
                 if isinstance(port, Mapping) and port.get("id") == BOARD_PORT), None)


def _param_keys(definition: Mapping[str, Any]) -> set[str]:
    from services import node_route

    return {str(param.get("key")) for param in node_route.all_param_definitions(definition)}


def census_nodes(definitions: Mapping[str, Any], categories: Iterable[str] = CENSUS_CATEGORIES) -> list[str]:
    """Rule 12's census: every image, video and audio generator with a prompt
    port or param (in any param group or route)."""
    wanted = set(categories)
    out = []
    for node_id, definition in definitions.items():
        if not isinstance(definition, Mapping) or definition.get("category") not in wanted:
            continue
        ports = {port.get("id") for port in definition.get("inputPorts") or [] if isinstance(port, Mapping)}
        if "prompt" in ports or "prompt" in _param_keys(definition):
            out.append(node_id)
    return sorted(out)


def _number(value: Any) -> str:
    return f"{value:g}" if isinstance(value, (int, float)) and not isinstance(value, bool) else repr(value)


def _range_text(values: Any) -> str:
    return "[" + ", ".join(_number(value) for value in values) + "]" if isinstance(values, (list, tuple)) else repr(values)


def _is_date(value: Any) -> bool:
    if not isinstance(value, str) or not _DATE.match(value):
        return False
    try:
        return datetime.date.fromisoformat(value) <= datetime.date.today()
    except ValueError:
        return False


def _catalog_model(catalog: Mapping[str, Any] | None, endpoint: str) -> Mapping[str, Any] | None:
    for model in ((catalog or {}).get("models") or {}).values():
        if isinstance(model, Mapping) and model.get("endpoint") == endpoint:
            return model
    return None


def _item_schema(model: Mapping[str, Any] | None, field: str) -> Mapping[str, Any]:
    properties = ((model or {}).get("requestSchema") or {}).get("properties") or {}
    items = (properties.get(field) or {}).get("items") if isinstance(properties.get(field), Mapping) else None
    return items if isinstance(items, Mapping) else {}


def _source_problems(source: Any) -> list[str]:
    if not isinstance(source, Mapping):
        return [f"source {source!r} must be an object"]
    out = []
    url, code = source.get("url"), source.get("code")
    if isinstance(code, str) and code and url is None:
        path = code.split(":", 1)[0]
        if not (REPO_ROOT / path).is_file():
            out.append(f"source {code} names no file in the repo")
    elif not (isinstance(url, str) and url.startswith("https://") and code is None):
        out.append(f"source {url or code} must be an https URL or a repo path")
    if "quote" in source and not (isinstance(source["quote"], str) and source["quote"].strip()):
        out.append(f"source {url or code} has an empty quote")
    if "checked" in source and not _is_date(source["checked"]):
        out.append(f"source {url or code} checked must be a date (YYYY-MM-DD)")
    extra = set(source) - {"url", "code", "quote", "checked"}
    if extra:
        out.append(f"source {url or code} has unknown fields {', '.join(sorted(extra))}")
    return out


def _ports(definition: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {str(port.get("id")): port for port in definition.get("inputPorts") or [] if isinstance(port, Mapping)}


def _names(value: Any) -> list[str] | None:
    if value is None:
        return []
    if isinstance(value, list) and all(isinstance(item, str) and item for item in value):
        return value
    return None


def _variant_problems(node_id: str, entry: Mapping[str, Any], definition: Mapping[str, Any],
                      catalog: Mapping[str, Any] | None, fixtures: bool) -> list[str]:
    """Rules 3 to 8 and 13 for one resolved variant of an entry."""
    out: list[str] = []
    ports = _ports(definition)
    params = _param_keys(definition)
    channel = entry.get("channel")
    if channel not in CHANNELS:
        out.append(f"channel must be one of {', '.join(CHANNELS)} (has {channel!r})")
    text_only = channel == "text-only"
    if text_only or entry.get("default") == "never":
        if not (isinstance(entry.get("reason"), str) and entry["reason"].strip()):
            out.append("a text-only entry needs a reason" if text_only else "default never needs a reason")

    # Where the text goes, and what.
    text_slot = entry.get("textSlot")
    if not (isinstance(text_slot, Mapping) and len(text_slot) == 1
            and isinstance(text_slot.get("port") or text_slot.get("param"), str)):
        out.append("textSlot must be {port} or {param}")
    elif "port" in text_slot and text_slot["port"] not in ports:
        out.append(f"textSlot names no input port {text_slot['port']}")
    elif "param" in text_slot and text_slot["param"] not in params:
        out.append(f"textSlot names no param {text_slot['param']}")
    if entry.get("text") not in TEXTS:
        out.append(f"text must be one of {', '.join(TEXTS)}")
    if "textUnless" in entry and entry["textUnless"] not in ports:
        out.append(f"textUnless names no input port {entry['textUnless']}")
    if "negativeField" in entry and entry["negativeField"] != "auto":
        out.append("negativeField must be auto (resolved from the active route's params)")
    palette = entry.get("paletteParam")
    if palette is not None and not (isinstance(palette, Mapping) and palette.get("param") in params
                                    and isinstance(palette.get("format"), str)):
        out.append("paletteParam must be {param, format} naming a param of the node")

    # Rule 3: named ports are real, and a port is a slot or never, not both.
    slots = entry.get("slots")
    slot_ports: list[str] = []
    if slots is not None and not isinstance(slots, list):
        out.append("slots must be a list")
        slots = []
    for slot in slots or []:
        if not isinstance(slot, Mapping) or not isinstance(slot.get("port"), str):
            out.append("each slot needs a port")
            continue
        port_id = slot["port"]
        slot_ports.append(port_id)
        if port_id not in ports:
            out.append(f"slots names no input port {port_id}")
        extra = set(slot) - SLOT_FIELDS
        if extra:
            out.append(f"slot {port_id} has unknown fields {', '.join(sorted(extra))}")
        limit = slot.get("max")
        if not (isinstance(limit, int) and not isinstance(limit, bool) and limit >= 1):
            out.append(f"slot {port_id} needs a max of at least 1")
        else:
            # Rule 6: within the port and every route.
            port_max = (ports.get(port_id) or {}).get("maxConnections")
            if isinstance(port_max, int) and limit > port_max:
                out.append(f"slot {port_id} takes up to {limit}, more than the port's {port_max}")
            for route in definition.get("routes") or []:
                route_max = ((((route or {}).get("rules") or {}).get("ports") or {}).get(port_id) or {}).get("max")
                if isinstance(route_max, int) and limit > route_max:
                    out.append(f"slot {port_id} takes up to {limit}, more than the {route.get('id')} route's "
                               f"{route_max}")
        shares = _names(slot.get("sharesLimitWith"))
        if shares is None:
            out.append(f"slot {port_id} sharesLimitWith must be a list of ports")
        for other in shares or []:
            if other not in ports:
                out.append(f"slot {port_id} sharesLimitWith names no input port {other}")
        roles = slot.get("roles")
        if roles is not None and not (isinstance(roles, Mapping) and all(
                isinstance(count, int) and count >= 0 for count in roles.values())):
            out.append(f"slot {port_id} roles must map each role to a count")
    lists: dict[str, list[str]] = {}
    for field in ("never", "needsWired", "exclusive"):
        names = _names(entry.get(field))
        if names is None:
            out.append(f"{field} must be a list of input ports")
            names = []
        lists[field] = names
        for port_id in names:
            if port_id not in ports:
                out.append(f"{field} names no input port {port_id}")
    never, needs_wired = set(lists["never"]), set(lists["needsWired"])
    for port_id in sorted(set(slot_ports) & never):
        out.append(f"{port_id} is in both slots and never")
    for port_id in sorted(never & needs_wired):
        out.append(f"{port_id} is in both never and needsWired")

    # Rule 4: every Image or Any input is classified. Rule 5: frames are never.
    classified = set(slot_ports) | never | needs_wired
    for port_id, port in ports.items():
        if port_id == BOARD_PORT:
            continue
        if port.get("dataType") in CLASSIFIED_TYPES and port_id not in classified:
            out.append(f"input port {port_id} ({port.get('dataType')}) isn't classified in slots, never or "
                       "needsWired")
    for port_id in [*slot_ports, *sorted(needs_wired - set(slot_ports))]:
        word = frame_word(port_id, str((ports.get(port_id) or {}).get("label") or ""))
        if word and port_id in ports:
            out.append(f"{port_id} reads as a frame ({word}), so it must be in never")

    # Rule 7, and what an entry that takes images needs.
    if text_only:
        if slot_ports:
            out.append("a text-only entry takes no slots")
    else:
        if entry.get("default") not in DEFAULTS:
            out.append("needs a default (images, text or never)")
        if channel == "views":
            if slot_ports:
                out.append("a views entry takes no slots")
        elif not slot_ports and isinstance(slots, list):
            out.append("needs slots")
        if slot_ports and channel != "views":
            if "weight" not in entry:
                out.append("needs a weight")
            if "syntax" not in entry:
                out.append("needs a syntax (or null with a syntaxReason)")
        if "handler" in entry and entry["handler"] not in HANDLERS:
            out.append(f"handler must be one of {', '.join(HANDLERS)}")
        if entry.get("default") == "images" and "costPerRef" not in entry:
            out.append("default images needs a costPerRef")
    if "costPerRef" in entry and entry["costPerRef"] not in COST_PER_REF:
        out.append(f"costPerRef must be one of {', '.join(COST_PER_REF)}")
    if "syntax" in entry:
        syntax = entry["syntax"]
        if syntax is None:
            if not (isinstance(entry.get("syntaxReason"), str) and entry["syntaxReason"].strip()):
                out.append("syntax null needs a syntaxReason")
        elif not (isinstance(syntax, str) and _SYNTAX.match(syntax)):
            out.append(f"syntax must be plain, null or a pattern with {{n}} (has {syntax!r})")
    if "order" in entry and entry["order"] != "weight":
        out.append("order must be weight")
    limits = entry.get("limits")
    if limits is not None:
        if not isinstance(limits, Mapping) or set(limits) - LIMIT_FIELDS:
            out.append(f"limits takes only {', '.join(sorted(LIMIT_FIELDS))}")
        elif "face" in limits and limits["face"] not in FACE_POLICIES:
            out.append(f"limits.face must be one of {', '.join(FACE_POLICIES)}")
    if "requires" in entry and not isinstance(entry["requires"], Mapping):
        out.append("requires must be an object")

    # Rule 8: a collage goes into one single-image slot that isn't a target.
    if "collage" in entry:
        if not isinstance(entry["collage"], bool):
            out.append("collage must be true or false")
        elif entry["collage"]:
            if len(slots or []) != 1 or (slots[0] or {}).get("max") != 1:
                out.append("collage needs a single slot with max 1")
            for port_id in slot_ports:
                if port_id in needs_wired:
                    out.append(f"collage can't go on an edit target ({port_id})")

    # Rule 13: the weight form the node needs (Q21 b).
    weight = entry.get("weight")
    if weight is not None:
        out.extend(_weight_problems(weight, ports, params, catalog, fixtures))
    # Rule 13: a Krea catalog field whose items require a strength is native.
    model = ((catalog or {}).get("models") or {}).get(node_id)
    for port_id in slot_ports:
        required = _item_schema(model, port_id).get("required") or []
        if "strength" in required and (weight or {}).get("mode") != "native":
            out.append(f"{port_id} items require a strength on Krea, so the weight must be native")
    return out


def _weight_problems(weight: Any, ports: Mapping[str, Any], params: set[str], catalog: Mapping[str, Any] | None,
                     fixtures: bool) -> list[str]:
    if not isinstance(weight, Mapping):
        return ["weight must be an object"]
    out: list[str] = []
    extra = set(weight) - WEIGHT_FIELDS
    if extra:
        out.append(f"weight has unknown fields {', '.join(sorted(extra))}")
    mode, normalize = weight.get("mode"), weight.get("normalize")
    if mode not in WEIGHT_NORMALIZE:
        return [*out, f"weight mode must be one of {', '.join(WEIGHT_NORMALIZE)}"]
    wanted = WEIGHT_NORMALIZE[mode]
    if normalize == "none":
        if not fixtures:
            out.append("weight normalize none is for test fixtures only")
        elif mode != "native":
            out.append("weight normalize none is for native weights only")
    elif wanted is None:
        if normalize is not None:
            out.append(f"weight mode {mode} takes no normalize (the strength stays the person's)")
    elif normalize != wanted:
        out.append(f"weight mode {mode} needs normalize {wanted} (has {normalize})")
    if mode in ("native", "global"):
        bounds = weight.get("range")
        if not (isinstance(bounds, list) and len(bounds) == 2
                and all(isinstance(b, (int, float)) and not isinstance(b, bool) for b in bounds)
                and bounds[0] < bounds[1]):
            out.append("weight range must be [low, high]")
            bounds = None
    if mode == "native":
        if not isinstance(weight.get("field"), str):
            out.append("a native weight names its field (strength)")
        precision = weight.get("precision")
        if precision is not None and not (isinstance(precision, (int, float)) and 0 < precision < 1):
            out.append("weight precision must be between 0 and 1")
        schema = weight.get("schema")
        if not isinstance(schema, Mapping):
            out.append("a native weight names the vendor schema its range comes from")
        elif schema.get("source") != "krea-catalog" or not isinstance(schema.get("endpoints"), list) \
                or not schema["endpoints"] or not isinstance(schema.get("field"), str):
            out.append("weight schema must be {source: krea-catalog, endpoints, field}")
        elif bounds is not None:
            for endpoint in schema["endpoints"]:
                model = _catalog_model(catalog, endpoint)
                if model is None:
                    out.append(f"weight schema names no Krea catalog endpoint {endpoint}")
                    continue
                item = (_item_schema(model, schema["field"]).get("properties") or {}).get(weight.get("field")) or {}
                vendor = [item.get("minimum"), item.get("maximum")]
                if vendor != list(bounds):
                    out.append(f"weight range {_range_text(bounds)} isn't the vendor's {_range_text(vendor)} "
                               f"({schema['field']}[].{weight.get('field')} on {endpoint})")
                    break
    elif mode == "at-creation":
        if not isinstance(weight.get("field"), str):
            out.append("an at-creation weight names its field (image_weights)")
    elif mode == "global":
        if weight.get("param") not in params:
            out.append("a global weight names the node's strength param")
        if weight.get("source") != "person":
            out.append("a global weight's source is person: Nebula never writes it")
    return out


def entry_problems(node_id: str, entry: Any, definition: Mapping[str, Any], catalog: Mapping[str, Any] | None = None,
                   *, fixtures: bool = False) -> list[str]:
    """Every problem with one entry, each starting with the node id."""
    if not isinstance(entry, Mapping):
        return [f"{node_id}: entry must be an object"]
    out: list[str] = []
    for field in sorted(set(entry) - ENTRY_FIELDS):
        out.append(f"unknown field {field}")
    if entry.get("channel") == "text-only":
        for field in IMAGE_FIELDS:
            if field in entry:
                out.append(f"a text-only entry takes no {field}")
    # Rule 9: dated, sourced, and what isn't sourced is listed.
    if not _is_date(entry.get("checked")):
        out.append(f"checked must be a date (YYYY-MM-DD), not {entry.get('checked')!r}")
    sources = entry.get("sources")
    if not isinstance(sources, list) or not sources:
        out.append("needs at least one source")
    else:
        for source in sources:
            out.extend(_source_problems(source))
    unconfirmed = entry.get("unconfirmed")
    if unconfirmed is not None and not (isinstance(unconfirmed, list) and all(
            isinstance(item, str) and item.strip() for item in unconfirmed)):
        out.append("unconfirmed must be a list of what no source says")

    # Rule 6: byModel keys are real enum values, byRoute keys real routes.
    from services import node_route

    by_model = entry.get("byModel") or {}
    by_route = entry.get("byRoute") or {}
    if not isinstance(by_model, Mapping) or not isinstance(by_route, Mapping):
        return [f"{node_id}: {problem}" for problem in [*out, "byModel and byRoute must be objects"]]
    for key, override in by_model.items():
        param_key, _, value = str(key).partition("=")
        param = node_route.param_definition(definition, param_key)
        options = [str(option.get("value")) for option in (param or {}).get("options") or []]
        if param is None or not value or value not in options:
            out.append(f"byModel {key} isn't a value of {param_key}")
        if not isinstance(override, Mapping) or {"byModel", "byRoute"} & set(override):
            out.append(f"byModel {key} must be an object of entry fields")
    route_ids = [str(route.get("id")) for route in node_route.routes_of(definition)]
    for key, override in by_route.items():
        if key not in route_ids:
            out.append(f"byRoute {key} isn't one of its routes ({', '.join(route_ids)})")
        if not isinstance(override, Mapping) or {"byModel", "byRoute"} & set(override):
            out.append(f"byRoute {key} must be an object of entry fields")

    base = _variant_problems(node_id, resolve_entry(entry, {}, None), definition, catalog, fixtures)
    out.extend(base)
    seen = set(base)
    combos: list[tuple[str, dict[str, Any], str | None]] = []
    for key in by_model:
        param_key, _, value = str(key).partition("=")
        combos.append((f"byModel {key}", {param_key: value}, None))
    for key in by_route:
        combos.append((f"byRoute {key}", {}, str(key)))
        for model_key in by_model:
            param_key, _, value = str(model_key).partition("=")
            combos.append((f"byModel {model_key}, byRoute {key}", {param_key: value}, str(key)))
    for label, values, route in combos:
        for problem in _variant_problems(node_id, resolve_entry(entry, values, route), definition, catalog, fixtures):
            if problem not in seen:
                seen.add(problem)
                out.append(f"({label}) {problem}")
    return [f"{node_id}: {problem}" for problem in out]


def census_problems(table_: Mapping[str, Any], definitions: Mapping[str, Any]) -> list[str]:
    """Rule 12: every census node has a Moodboard port, or is listed."""
    census = table_.get("census") if isinstance(table_.get("census"), Mapping) else {}
    excluded = census.get("excluded") if isinstance(census.get("excluded"), Mapping) else {}
    pending = census.get("pending") if isinstance(census.get("pending"), Mapping) else {}
    categories = census.get("categories") or CENSUS_CATEGORIES
    out: list[str] = []
    if list(categories) != list(CENSUS_CATEGORIES):
        out.append(f"census: categories must be {', '.join(CENSUS_CATEGORIES)} (PR16, PR17 and PR18 extend the "
                   "lists, not the categories)")
    nodes = set(census_nodes(definitions, categories))
    for node_id in sorted(nodes):
        has_port = board_port(definitions[node_id]) is not None
        if has_port:
            if node_id in pending:
                out.append(f"{node_id}: has a Moodboard port, so it can't be listed as pending")
            if node_id in excluded:
                out.append(f"{node_id}: has a Moodboard port, so it can't be listed as excluded")
        elif node_id not in pending and node_id not in excluded:
            out.append(f"{node_id}: takes a prompt but has no Moodboard port, and isn't listed as excluded or "
                       "pending (census, plan section 5.7.10 rule 12)")
    for node_id in sorted(set(excluded) | set(pending)):
        if node_id not in nodes:
            out.append(f"{node_id}: listed in the census but isn't an image, video or audio generator with a prompt")
        if node_id in excluded and node_id in pending:
            out.append(f"{node_id}: listed as both excluded and pending")
    for node_id, reason in excluded.items():
        if not (isinstance(reason, str) and reason.strip()):
            out.append(f"{node_id}: an excluded node needs a reason")
    for node_id, pr in pending.items():
        if not (isinstance(pr, str) and _PENDING.match(pr)):
            out.append(f"{node_id}: pending must name the PR that gives it a port (PR16), not {pr!r}")
    return out


def table_problems(table_: Mapping[str, Any], definitions: Mapping[str, Any], catalog: Mapping[str, Any] | None,
                   *, fixtures: bool = False) -> list[str]:
    """Every problem in the table against the node definitions and the
    pinned Krea catalog (rules 1 to 9, 12 and 13). Empty means it passes."""
    entries = table_.get("entries") if isinstance(table_.get("entries"), Mapping) else {}
    out: list[str] = []
    # Rule 1: a Moodboard port has an entry (and is a board port).
    for node_id, definition in definitions.items():
        port = board_port(definition)
        if port is None:
            continue
        if port.get("dataType") != "Moodboard":
            out.append(f"{node_id}: input port moodboard must be dataType Moodboard (is {port.get('dataType')})")
        if node_id not in entries:
            out.append(f"{node_id}: has a Moodboard input port but no adapter entry")
    # Rule 2, and each entry's own rules.
    for node_id, entry in entries.items():
        definition = definitions.get(node_id)
        if not isinstance(definition, Mapping):
            out.append(f"{node_id}: no such node")
            continue
        if board_port(definition) is None:
            out.append(f"{node_id}: has an entry but no Moodboard input port")
        out.extend(entry_problems(node_id, entry, definition, catalog, fixtures=fixtures))
    out.extend(census_problems(table_, definitions))
    return out
