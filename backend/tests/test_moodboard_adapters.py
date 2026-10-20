"""Moodboard adapters: the table, the dispatcher's first steps and the A5
contract (moodboard canvas plan section 5.7, PR13; contract 07 section 1.16).

Every node that can take a board says how, in one table
(``backend/data/moodboard_adapters.json``, plus the generated
``moodboard_adapters_krea.json``), and these checks refuse a Moodboard port
without an entry (decision A5). Nothing a generator receives changes in PR13:
``apply_to_generator`` resolves the entry and sends today's text fold through
it, early return included (plan section 5.7.3 steps 1, 2 and 8).

The rule numbers below are section 5.7.10's.
"""
from __future__ import annotations

import base64
import copy
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from models.events import execution_notes
from models.graph import GraphNode, PortValueDict

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "backend" / "data"
DEFINITIONS = json.loads((DATA / "node_definitions.json").read_text())
CATALOG = json.loads((DATA / "krea_gateway_models.json").read_text())
BEFORE = json.loads((Path(__file__).parent / "fixtures" / "moodboard_dispatch_before_adapters.json").read_text())
PROMPT = "A lighthouse on a cliff at dusk"


def _adapters():
    from services import moodboard_adapters

    return moodboard_adapters


def _table() -> dict[str, Any]:
    return _adapters().load_table()


def _problems(table: dict[str, Any], **kwargs: Any) -> list[str]:
    return _adapters().table_problems(table, DEFINITIONS, CATALOG, **kwargs)


def _with_entry(node_id: str, entry: dict[str, Any] | None, *, census: bool = True) -> dict[str, Any]:
    """The real table with one entry set (or removed, for None)."""
    table = copy.deepcopy(_table())
    if entry is None:
        table["entries"].pop(node_id, None)
    else:
        table["entries"][node_id] = entry
        if census:
            table["census"]["pending"].pop(node_id, None)
    return table


def _definitions_with_port(node_id: str) -> dict[str, Any]:
    """The registry with a Moodboard port added to ``node_id`` (a fixture)."""
    definitions = copy.deepcopy(DEFINITIONS)
    definitions[node_id]["inputPorts"].append(
        {"id": "moodboard", "label": "Moodboard", "dataType": "Moodboard", "required": False, "maxConnections": 1})
    return definitions


SOURCE = [{"code": "backend/data/node_definitions.json", "checked": "2026-10-20"}]


def _text_only(**extra: Any) -> dict[str, Any]:
    return {"channel": "text-only", "textSlot": {"port": "prompt"}, "text": "brief",
            "reason": "fixture", "sources": SOURCE, "checked": "2026-10-20", **extra}


def _refs(**extra: Any) -> dict[str, Any]:
    return {"channel": "refs", "default": "text", "slots": [{"port": "images", "max": 4}],
            "textSlot": {"port": "prompt"}, "text": "brief", "weight": {"mode": "select", "normalize": "rank"},
            "order": "weight", "syntax": "Image {n}", "sources": SOURCE, "checked": "2026-10-20", **extra}


# -- the table ---------------------------------------------------------------------------------------------

def test_every_moodboard_port_has_an_adapter_entry():
    """Rule 1 (A5): a node can't have a Moodboard port without an entry."""
    entries = _table()["entries"]
    ported = sorted(node_id for node_id, definition in DEFINITIONS.items()
                    if any(port.get("id") == "moodboard" for port in definition.get("inputPorts") or []))
    assert len(ported) == 16  # the 15 Moodboard-port nodes on main plus Krea 2 (plan section 5.7.11 A)
    assert [node_id for node_id in ported if node_id not in entries] == []


def test_krea2_moodboard_port_is_a_board_port():
    from services.moodboard_brief import has_board_port

    port = next(p for p in DEFINITIONS["krea-2-generate"]["inputPorts"] if p["id"] == "moodboard")
    assert port["dataType"] == "Moodboard"
    assert has_board_port(DEFINITIONS["krea-2-generate"])


def test_the_table_passes_the_contract():
    assert _problems(_table()) == []


def test_the_entries_are_what_the_plan_declares():
    """Section 5.7.11 A, declared truthfully: text-only, content slots with the
    text default, and Krea 2's weighted style slot read by its own handler."""
    entries = _table()["entries"]
    text_only = {"gpt-image-1-generate", "gpt-image-2-generate", "gpt-image-2-5-generate", "gpt-image-1-5",
                 "gpt-image-2-fal-generate", "nano-banana-fal", "fast-sdxl", "flux-2-pro", "gpt-image-1-edit"}
    refs = {"gpt-image-2-edit", "gpt-image-2-5-edit", "gpt-image-1-5-edit", "gpt-image-2-fal-edit",
            "nano-banana", "nano-banana-fal-edit"}
    assert {node_id for node_id, entry in entries.items() if entry["channel"] == "text-only"} == text_only
    assert {node_id for node_id, entry in entries.items() if entry["channel"] == "refs"} == refs
    assert all(entries[node_id]["default"] == "text" for node_id in refs)
    assert {node_id for node_id in entries if node_id.startswith("gpt-image-") and node_id.endswith("-edit")
            and node_id != "gpt-image-1-edit"} <= {n for n in refs if "images" in entries[n].get("needsWired", [])}
    krea = entries["krea-2-generate"]
    assert krea["channel"] == "weighted-style" and krea["default"] == "images" and krea["handler"] == "reads-board"
    assert krea["slots"] == [{"port": "image_style_references", "max": 10, "sharesLimitWith": ["style_images"]}]
    assert krea["weight"]["mode"] == "native" and krea["weight"]["normalize"] == "sum-to-strength"
    assert krea["weight"]["range"] == [0, 1] and krea["syntax"] is None and krea["syntaxReason"]


def test_the_hand_written_entries_stay_sorted():
    """Section 9: PR15 to PR18 each add their own family's entries, so the
    file is kept sorted by node id and merges stay mechanical."""
    raw = json.loads((DATA / "moodboard_adapters.json").read_text())["entries"]
    assert list(raw) == sorted(raw)


def test_the_tables_never_share_an_id(tmp_path):
    hand = json.loads((DATA / "moodboard_adapters.json").read_text())
    generated = {"generatedBy": "scripts/sync-krea-catalog.py",
                 "entries": {"fast-sdxl": hand["entries"]["fast-sdxl"]}}
    path = tmp_path / "krea.json"
    path.write_text(json.dumps(generated))
    with pytest.raises(ValueError, match="fast-sdxl is in both"):
        _adapters().load_table(krea_path=path)


def test_a_moodboard_input_that_is_not_a_board_port_is_refused():
    definitions = copy.deepcopy(DEFINITIONS)
    port = next(p for p in definitions["krea-2-generate"]["inputPorts"] if p["id"] == "moodboard")
    port["dataType"] = "Any"
    problems = _adapters().table_problems(_table(), definitions, CATALOG)
    assert "krea-2-generate: input port moodboard must be dataType Moodboard (is Any)" in problems


def test_an_entry_needs_its_node_and_its_port():
    """Rule 2."""
    assert "no-such-node: no such node" in _problems(_with_entry("no-such-node", _text_only()))
    assert "flux-schnell: has an entry but no Moodboard input port" in _problems(_with_entry(
        "flux-schnell", _text_only()))


def test_named_ports_are_real_and_classified_once():
    """Rule 3: slots, never, needsWired and exclusive name real input ports, and
    no port is both a slot and never (an edit target that is also the slot's
    first value, as on GPT Image edits, is a slot that needsWired)."""
    problems = _problems(_with_entry("gpt-image-2-edit", _refs(never=["mask", "images", "nope"],
                                                                  needsWired=["images"])))
    assert "gpt-image-2-edit: never names no input port nope" in problems
    assert "gpt-image-2-edit: images is in both slots and never" in problems
    assert "gpt-image-2-edit: images is in both never and needsWired" in problems
    assert _problems(_with_entry("gpt-image-2-edit", _refs(never=["mask"], needsWired=["images"]))) == []


def test_every_image_input_is_classified():
    """Rule 4: every Image or Any input port of a node with an entry is a slot,
    never or needsWired. Runway Video's ``image``, labelled just "Image", is
    its first frame (``runway.py``'s ``promptImage``): an entry that leaves it
    out must fail, whatever its name says."""
    definitions = _definitions_with_port("runway-video")
    table = _with_entry("runway-video", _text_only(never=[]))
    problems = _adapters().table_problems(table, definitions, CATALOG)
    assert "runway-video: input port image (Image) isn't classified in slots, never or needsWired" in problems
    table = _with_entry("runway-video", _text_only(never=["image"]))
    assert _adapters().table_problems(table, definitions, CATALOG) == []

    # The edit target of GPT Image 1 Edit too.
    problems = _problems(_with_entry("gpt-image-1-edit", _text_only(never=["mask"])))
    assert "gpt-image-1-edit: input port image (Image) isn't classified in slots, never or needsWired" in problems


def test_frame_ports_are_never():
    """Rule 5: on top of rule 4, a port whose id or label says first, last,
    start, end, tail, frame or keyframes must be in never."""
    definitions = _definitions_with_port("kling-v2-1")
    entry = _refs(slots=[{"port": "tail_image", "max": 1}], never=["image"])
    problems = _adapters().table_problems(_with_entry("kling-v2-1", entry), definitions, CATALOG)
    assert "kling-v2-1: tail_image reads as a frame (tail), so it must be in never" in problems
    assert _adapters().frame_word("reference_images", "Reference Images") is None
    assert _adapters().frame_word("first_frame_image", "First frame") == "first"
    assert _adapters().frame_word("keyframes", "Keyframes") == "keyframes"


def test_slot_limits_stay_within_the_port_and_every_route():
    """Rule 6: a slot's max is at most the port's maxConnections and each
    route's ``rules.ports.<port>.max``; byModel keys name real enum values and
    byRoute keys real routes."""
    definitions = _definitions_with_port("krea-3")
    routes = definitions["krea-3"]["routes"]
    limits = {route["id"]: route.get("rules", {}).get("ports", {}).get("images", {}).get("max") for route in routes}
    assert any(isinstance(limit, int) for limit in limits.values()), limits
    entry = _refs(slots=[{"port": "images", "max": 99}])
    problems = _adapters().table_problems(_with_entry("krea-3", entry), definitions, CATALOG)
    assert any(p.startswith("krea-3: slot images takes up to 99, more than the") for p in problems), problems

    entry = _refs(byModel={"model=gemini-9": {"slots": [{"port": "images", "max": 3}]}},
                  byRoute={"replicate": {"default": "never", "reason": "fixture"}})
    problems = _problems(_with_entry("nano-banana", entry))
    assert "nano-banana: byModel model=gemini-9 isn't a value of model" in problems
    assert "nano-banana: byRoute replicate isn't one of its routes (google)" in problems


def test_views_text_only_and_never_need_their_reasons():
    """Rule 7."""
    problems = _problems(_with_entry("fast-sdxl", {**_text_only(), "reason": ""}))
    assert "fast-sdxl: a text-only entry needs a reason" in problems
    problems = _problems(_with_entry("nano-banana", _refs(default="never")))
    assert "nano-banana: default never needs a reason" in problems
    problems = _problems(_with_entry("nano-banana", _refs(channel="views")))
    assert "nano-banana: a views entry takes no slots" in problems


def test_syntax_null_needs_a_reason():
    """Rule 7 and A2: every model without a weight gets a legend unless its
    entry says why not."""
    problems = _problems(_with_entry("nano-banana", _refs(syntax=None)))
    assert "nano-banana: syntax null needs a syntaxReason" in problems
    assert _problems(_with_entry("nano-banana", _refs(syntax=None, syntaxReason="naming an image tags it"))) == []


def test_collage_only_on_a_single_reference_slot():
    """Rule 8."""
    problems = _problems(_with_entry("nano-banana", _refs(collage=True)))
    assert "nano-banana: collage needs a single slot with max 1" in problems
    problems = _problems(_with_entry("gpt-image-2-edit", _refs(slots=[{"port": "images", "max": 1}], collage=True,
                                                                  never=["mask"], needsWired=["images"])))
    assert "gpt-image-2-edit: collage can't go on an edit target (images)" in problems


def test_sources_are_dated_and_real():
    """Rule 9: ``sources`` and ``checked`` are dated, code sources name files
    that exist, and ``unconfirmed`` is a list of what no source says."""
    problems = _problems(_with_entry("fast-sdxl", _text_only(checked="last week")))
    assert "fast-sdxl: checked must be a date (YYYY-MM-DD), not 'last week'" in problems
    problems = _problems(_with_entry("fast-sdxl", _text_only(sources=[])))
    assert "fast-sdxl: needs at least one source" in problems
    problems = _problems(_with_entry("fast-sdxl", _text_only(sources=[{"code": "backend/nope.py:3"}])))
    assert "fast-sdxl: source backend/nope.py:3 names no file in the repo" in problems
    problems = _problems(_with_entry("fast-sdxl", _text_only(sources=[{"url": "http://example.com"}])))
    assert "fast-sdxl: source http://example.com must be an https URL or a repo path" in problems
    problems = _problems(_with_entry("fast-sdxl", _text_only(unconfirmed="the limit")))
    assert "fast-sdxl: unconfirmed must be a list of what no source says" in problems
    for entry in _table()["entries"].values():
        for source in entry["sources"]:
            if "code" in source:
                assert (ROOT / source["code"].split(":")[0]).is_file(), source


def test_weight_normalize_matches_mode():
    """Rule 13 (Q21 b): native needs sum-to-strength, at-creation sum-to-one,
    select rank, and a native range is the vendor's, read from the schema
    Nebula records."""
    krea = copy.deepcopy(_table()["entries"]["krea-2-generate"])
    krea["weight"] = {**krea["weight"], "normalize": "rank"}
    assert "krea-2-generate: weight mode native needs normalize sum-to-strength (has rank)" in _problems(
        _with_entry("krea-2-generate", krea))
    krea["weight"] = {**_table()["entries"]["krea-2-generate"]["weight"], "range": [-2, 2]}
    assert ("krea-2-generate: weight range [-2, 2] isn't the vendor's [0, 1] "
            "(image_style_references[].strength on /generate/image/krea/krea-2/medium)") in _problems(
        _with_entry("krea-2-generate", krea))
    no_schema = {key: value for key, value in _table()["entries"]["krea-2-generate"]["weight"].items()
                 if key != "schema"}
    assert "krea-2-generate: a native weight names the vendor schema its range comes from" in _problems(
        _with_entry("krea-2-generate", {**krea, "weight": no_schema}))
    assert "nano-banana: weight mode select needs normalize rank (has sum-to-one)" in _problems(
        _with_entry("nano-banana", _refs(weight={"mode": "select", "normalize": "sum-to-one"})))
    assert "nano-banana: weight mode at-creation needs normalize sum-to-one (has rank)" in _problems(
        _with_entry("nano-banana", _refs(weight={"mode": "at-creation", "field": "image_weights",
                                                 "normalize": "rank"})))
    # "none" (strength x weight, the pre-Q21 behaviour) is for test fixtures only.
    raw = {**_table()["entries"]["krea-2-generate"]["weight"], "normalize": "none"}
    assert "krea-2-generate: weight normalize none is for test fixtures only" in _problems(
        _with_entry("krea-2-generate", {**krea, "weight": raw}))
    assert _problems(_with_entry("krea-2-generate", {**krea, "weight": raw}), fixtures=True) == []


def test_a_krea_field_that_requires_a_strength_is_native():
    """Rule 13: a Krea catalog field whose items have ``strength`` in
    ``required`` can't be planned as a bare list (Krea's gateway refuses it)."""
    definitions = _definitions_with_port("krea-image-bytedance-seedream-4")
    entry = {"channel": "weighted-style", "default": "text", "slots": [{"port": "style_images", "max": 10}],
             "never": [], "textSlot": {"port": "prompt"}, "text": "brief",
             "weight": {"mode": "select", "normalize": "rank"}, "syntax": "plain",
             "sources": SOURCE, "checked": "2026-10-20"}
    problems = _adapters().table_problems(_with_entry("krea-image-bytedance-seedream-4", entry), definitions,
                                          CATALOG)
    assert ("krea-image-bytedance-seedream-4: style_images items require a strength on Krea, "
            "so the weight must be native") in problems


def test_unknown_fields_are_refused():
    problems = _problems(_with_entry("fast-sdxl", _text_only(defualt="text")))
    assert "fast-sdxl: unknown field defualt" in problems


def test_negative_field_is_declared_where_the_fold_fills_it():
    """``negativeField`` says what the engine already does: a node with a
    ``negative_prompt`` param gets the board's negatives (PR14 resolves it
    from the active route's params)."""
    from services.moodboard_brief import has_negative_field

    for node_id, entry in _table()["entries"].items():
        assert ("negativeField" in entry) == has_negative_field(DEFINITIONS[node_id]), node_id


# -- the census (rule 12) ----------------------------------------------------------------------------------

def test_every_generator_with_a_prompt_has_a_board_port_or_is_listed():
    """Every image, video and audio generator with a prompt has a Moodboard
    port and an entry, or is listed: ``excluded`` for good, with a reason
    (speech, transcription, translation, edits of an existing clip...), or
    ``pending`` with the PR that gives it a port (PR15 to PR18 shrink it)."""
    adapters = _adapters()
    census = adapters.census_nodes(DEFINITIONS)
    table = _table()
    listed = set(table["census"]["excluded"]) | set(table["census"]["pending"])
    assert set(census) == set(table["entries"]) | listed
    assert set(table["census"]["excluded"]) == {"identity-edit", "flux-video-edit", "openai-stt",
                                                "openai-translate", "krea-audio-elevenlabs-tts"}
    assert all(reason for reason in table["census"]["excluded"].values())
    assert set(table["census"]["pending"].values()) <= {"PR15", "PR16", "PR17", "PR18"}

    missing = copy.deepcopy(table)
    missing["census"]["pending"].pop("krea-3")
    assert ("krea-3: takes a prompt but has no Moodboard port, and isn't listed as excluded or pending "
            "(census, plan section 5.7.10 rule 12)") in _problems(missing)

    stale = copy.deepcopy(table)
    stale["census"]["pending"]["gpt-image-2-edit"] = "PR16"
    assert "gpt-image-2-edit: has a Moodboard port, so it can't be listed as pending" in _problems(stale)

    gone = copy.deepcopy(table)
    gone["census"]["excluded"]["claude-chat"] = "not a generator"
    assert "claude-chat: listed in the census but isn't an image, video or audio generator with a prompt" in (
        _problems(gone))


# -- the generated Krea part (rules 10 and 13) -------------------------------------------------------------

def _sync():
    spec = importlib.util.spec_from_file_location("sync_krea_catalog_adapters", ROOT / "scripts/sync-krea-catalog.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_generated_krea_table_is_what_the_sync_script_writes():
    """Rule 10. Empty until PR15 and PR16 give Krea catalog nodes a port."""
    sync = _sync()
    written = json.loads((DATA / "moodboard_adapters_krea.json").read_text())
    assert written == sync.adapter_table(CATALOG, sync.definitions(CATALOG))
    assert written == {"_about": sync.ADAPTER_ABOUT, "generatedBy": "scripts/sync-krea-catalog.py", "entries": {}}


def test_sync_check_fails_on_a_stale_generated_table(tmp_path, monkeypatch):
    sync = _sync()
    stale = tmp_path / "moodboard_adapters_krea.json"
    stale.write_text(json.dumps({"generatedBy": "scripts/sync-krea-catalog.py", "entries": {"x": {}}}))
    monkeypatch.setattr(sync, "ADAPTERS", stale)
    monkeypatch.setattr(sync.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(AssertionError))
    monkeypatch.setattr(sys, "argv", ["sync-krea-catalog.py", "--check"])
    with pytest.raises(SystemExit, match="moodboard_adapters_krea.json"):
        sync.main()


def test_every_catalog_image_field_is_classified():
    """Every Image or Any input of a Krea catalog generation model is a slot or
    never in the script, so a field the catalog adds fails --check until the
    script classifies it."""
    sync = _sync()
    assert sync.unclassified_fields(CATALOG) == []
    catalog = copy.deepcopy(CATALOG)
    model = catalog["models"]["krea-image-bytedance-seedream-4"]
    model["inputPorts"].append({"id": "subject_image", "label": "Subject image", "dataType": "Image",
                                "required": False})
    assert sync.unclassified_fields(catalog) == ["krea-image-bytedance-seedream-4.subject_image"]


def test_generated_entries_take_their_weights_from_krea_schema():
    """With a port (PR15 adds them), the script derives each entry from the
    catalog: Krea 2's style references are native 0..1 and on by default
    (STYLE_VERIFIED); Seedream 4's style_images require a strength on Krea's
    gateway, so they are native -2..2, and off by default (not verified as
    style). Frames and edit targets are never."""
    sync = _sync()
    generated = sync.definitions(CATALOG)
    for node_id in ("krea-image-krea-krea-2-medium", "krea-image-bytedance-seedream-4"):
        generated[node_id]["inputPorts"].append(dict(sync.BOARD_PORT))
    table = sync.adapter_table(CATALOG, generated)
    krea2 = table["entries"]["krea-image-krea-krea-2-medium"]
    assert krea2["default"] == "images" and krea2["channel"] == "weighted-style"
    assert krea2["slots"] == [{"port": "image_style_references", "max": 10}]
    assert krea2["weight"]["mode"] == "native" and krea2["weight"]["range"] == [0, 1]
    assert set(krea2["never"]) == {"styles", "moodboards", "image_url"}
    seedream = table["entries"]["krea-image-bytedance-seedream-4"]
    assert seedream["default"] == "text" and seedream["weight"]["range"] == [-2, 2]
    assert seedream["weight"]["normalize"] == "sum-to-strength"
    definitions = {**DEFINITIONS, **generated}
    full = copy.deepcopy(_table())
    full["entries"].update(table["entries"])
    for node_id in table["entries"]:
        full["census"]["pending"].pop(node_id, None)
    assert _adapters().table_problems(full, definitions, CATALOG) == []


def test_no_generated_entry_defaults_to_images_on_an_unverified_style_field():
    sync = _sync()
    generated = sync.definitions(CATALOG)
    style_models = [node_id for node_id, model in CATALOG["models"].items() if not model.get("foldedInto")
                    and any(p["id"] in sync.STYLE_FIELDS for p in model["inputPorts"])]
    for node_id in style_models:
        generated[node_id]["inputPorts"].append(dict(sync.BOARD_PORT))
    entries = sync.adapter_table(CATALOG, generated)["entries"]
    on = sorted(node_id for node_id, entry in entries.items()
                if entry["default"] == "images" and entry["channel"] == "weighted-style")
    assert on == sorted(node_id for node_id in style_models
                        if CATALOG["models"][node_id]["endpoint"] in sync.STYLE_VERIFIED)
    assert {CATALOG["models"][n]["endpoint"] for n in on} == set(sync.STYLE_VERIFIED)


# -- rule 11: maker routes that refuse a start image with references ----------------------------------------

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class _Sent(Exception):
    """The handler got as far as calling its provider."""


def _route_refuses_frame_and_references(node_id: str, keys: dict[str, str], frame: str, slot: str) -> str | None:
    """Run ``node_id``'s registry handler on the route ``keys`` select, with
    one start image and one reference and every HTTP call mocked. Returns the
    refusal (a ValueError before any request) or None when it sent."""
    import asyncio

    from execution.sync_runner import get_handler_registry
    from services.node_route import all_param_definitions
    from services.output import OUTPUT_ROOT

    image = OUTPUT_ROOT / "rule11.png"
    image.write_bytes(PNG)
    definition = DEFINITIONS[node_id]
    params = {param["key"]: param["default"] for param in all_param_definitions(definition) if "default" in param}
    node = GraphNode(id="n1", definitionId=node_id, params=params)
    inputs = {"prompt": PortValueDict(type="Text", value="a field at dawn"),
              frame: PortValueDict(type="Image", value=str(image)),
              slot: PortValueDict(type="Image", value=[str(image)])}
    handler = get_handler_registry()[node_id]

    def sent(request: httpx.Request) -> httpx.Response:
        raise _Sent(str(request.url))

    with respx.mock(assert_all_called=False) as mock:
        mock.route().mock(side_effect=sent)
        try:
            asyncio.run(handler(node, inputs, keys))
        except _Sent:
            return None
        except ValueError as exc:
            assert not mock.calls, f"{node_id} refused after a request: {exc}"
            return str(exc)
    raise AssertionError(f"{node_id} finished without a request")


@pytest.mark.parametrize("node_id,keys,frame,words", [
    ("krea-video-bytedance-seedance-2", {"BYTEPLUS_API_KEY": "k"}, "start_image", "mutually exclusive"),
    ("krea-video-minimax-hailuo-3", {"MINIMAX_API_KEY": "k"}, "start_image", "not both in one run"),
    ("krea-video-google-gemini-omni-flash-1-1", {"GOOGLE_API_KEY": "k"}, "start_image", "together"),
])
def test_the_rule_11_run_finds_each_maker_route_that_refuses(node_id, keys, frame, words):
    refusal = _route_refuses_frame_and_references(node_id, keys, frame, "reference_images")
    assert refusal is not None and words in refusal


def test_the_rule_11_run_sees_a_route_that_sends_both():
    assert _route_refuses_frame_and_references(
        "krea-video-minimax-hailuo-3", {"KREA_API_TOKEN": "k"}, "start_image", "reference_images") is None


def test_every_refusing_maker_route_is_exclusive_in_its_entry():
    """Rule 11: each entry with a reference slot on a node with a frame port
    lists the frame ports in ``exclusive`` for every maker route that refuses
    the pair. No entry has one before PR17; this runs on whatever entries
    exist, so the PR that adds one is held to it."""
    from services.node_route import routes_of

    adapters = _adapters()
    checked = []
    for node_id, entry in _table()["entries"].items():
        definition = DEFINITIONS[node_id]
        frames = [port for port in entry.get("never", []) if adapters.frame_word(
            port, next((p.get("label", "") for p in definition["inputPorts"] if p["id"] == port), ""))]
        for slot in entry.get("slots", []):
            for frame in frames:
                for route in routes_of(definition):
                    keys = {key: "k" for key in route.get("keys") or []}
                    if _route_refuses_frame_and_references(node_id, keys, frame, slot["port"]):
                        resolved = adapters.resolve_entry(entry, {}, str(route.get("id")))
                        assert frame in resolved.get("exclusive", []), (node_id, route.get("id"), frame)
                    checked.append((node_id, route.get("id")))
    assert checked == []  # PR17 adds the first such entries; remove this line then


# -- resolving an entry -------------------------------------------------------------------------------------

def test_resolve_merges_by_model_then_by_route():
    adapters = _adapters()
    entry = _refs(byModel={"model=gemini-2.5-flash-image": {"slots": [{"port": "images", "max": 3}]},
                           "model=gemini-nano-banana-2.1": {"channel": "text-only", "reason": "limits unconfirmed"}},
                  byRoute={"fal": {"default": "never", "reason": "fixture"}})
    assert adapters.resolve_entry(entry, {}, None)["slots"] == [{"port": "images", "max": 4}]
    small = adapters.resolve_entry(entry, {"model": "gemini-2.5-flash-image"}, None)
    assert small["slots"] == [{"port": "images", "max": 3}] and "byModel" not in small and "byRoute" not in small
    text = adapters.resolve_entry(entry, {"model": "gemini-nano-banana-2.1"}, None)
    assert text["channel"] == "text-only" and text["reason"] == "limits unconfirmed"
    assert adapters.resolve_entry(entry, {"model": "gemini-2.5-flash-image"}, "fal")["default"] == "never"


def test_resolve_reads_a_models_default_when_the_param_is_unset():
    adapters = _adapters()
    entry = _table()["entries"]["nano-banana"]
    assert adapters.resolve("nano-banana", {}, None) == adapters.resolve_entry(
        entry, {"model": "gemini-3.1-flash-image"}, None)
    assert adapters.resolve("nano-banana", {"model": "gemini-2.5-flash-image"}, None)["slots"][0]["max"] == 3
    assert adapters.resolve("no-such-node", {}, None) is None


# -- the dispatcher (section 5.7.3 steps 1, 2 and 8) --------------------------------------------------------

def _apply(definition_id: str, definition: dict[str, Any] | None, inputs: dict[str, Any],
           params: dict[str, Any] | None = None):
    from services.moodboard_brief import apply_to_generator

    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        new_inputs, new_params = apply_to_generator(definition_id, definition, inputs,
                                                    {} if params is None else params)
    finally:
        execution_notes.reset(token)
    return new_inputs, new_params, notes


def test_the_handler_reads_board_set_is_retired():
    from services import moodboard_brief

    assert not hasattr(moodboard_brief, "_HANDLER_READS_BOARD")


def _replay(record_key: str) -> dict[str, Any]:
    node_id, label, case = record_key.split("|")
    bundle = (json.loads((Path(__file__).parent / "fixtures" / "moodboard_golden" / "expected.json").read_text())
              [label]["node"]["moodboard"]["value"] if label != "-" else None)
    prompt = PortValueDict(type="Text", value=PROMPT)
    board = (lambda value: PortValueDict(type="Moodboard", value=value))
    inputs: dict[str, Any] = {"prompt": prompt}
    params: dict[str, Any] = {}
    if case == "wired":
        inputs["moodboard"] = board(copy.deepcopy(bundle))
    elif case == "own-negative":
        inputs["moodboard"] = board(copy.deepcopy(bundle))
        params = {"negative_prompt": "blurry, Unrelated style drift"}
    elif case == "no-prompt":
        inputs = {"moodboard": board(copy.deepcopy(bundle))}
    elif case == "blank-prompt":
        inputs = {"prompt": PortValueDict(type="Text", value="   "), "moodboard": board(copy.deepcopy(bundle))}
    elif case == "two-boards":
        inputs["moodboard"] = board([copy.deepcopy(bundle), {**copy.deepcopy(bundle), "styleBrief": "Second."}])
    elif case == "strength-0":
        inputs["moodboard"] = board({**copy.deepcopy(bundle), "strength": 0})
    new_inputs, new_params, notes = _apply(node_id, DEFINITIONS[node_id], inputs, params)
    out: dict[str, Any] = {"inputs": sorted(new_inputs), "params": new_params, "notes": notes,
                           "paramsSame": new_params is params}
    if "prompt" in new_inputs:
        value = new_inputs["prompt"].value
        out["prompt"] = next(key for key, text in BEFORE["prompts"].items() if text == value) \
            if value in BEFORE["prompts"].values() else value
    if "moodboard" in new_inputs:
        out["moodboardSame"] = new_inputs["moodboard"] is inputs.get("moodboard")
    return out


@pytest.mark.parametrize("record_key", sorted(BEFORE["records"]))
def test_dispatch_sends_what_main_sent(record_key):
    """Every node that takes a board (the 15 plus Krea 2), every golden board
    shape, with and without a prompt: the same inputs, prompt, params and
    notes as main at 24123df3 (captured before the change)."""
    assert _replay(record_key) == BEFORE["records"][record_key]


def test_the_capture_covers_every_board_node_and_golden_board():
    golden = sorted(json.loads((Path(__file__).parent / "fixtures" / "moodboard_golden" / "expected.json")
                               .read_text()))
    assert BEFORE["nodes"] == sorted(_table()["entries"]) and BEFORE["boards"] == golden


BUNDLE = {"kind": "nebula_moodboard", "styleBrief": "Warm light.", "strength": 0.7,
          "negativePrompt": "blurry, neon signage", "avoidPrompt": "Keep these out of the image: neon signage."}


def test_a_missing_entry_falls_back_to_text_with_a_run_note():
    """A node with a Moodboard port and no entry can't pass the contract; if
    one ever runs, the board still goes as text, and the run says why."""
    definition = {"id": "made-up-generator", "inputPorts": [
        {"id": "prompt", "dataType": "Text"}, {"id": "moodboard", "dataType": "Moodboard"}], "params": []}
    inputs = {"prompt": PortValueDict(type="Text", value="A chair"),
              "moodboard": PortValueDict(type="Moodboard", value=BUNDLE)}
    new_inputs, params, notes = _apply("made-up-generator", definition, inputs)
    assert new_inputs["prompt"].value == "A chair\n\nMoodboard direction: Warm light."
    assert "moodboard" not in new_inputs and params == {}
    assert notes == ["This node has no moodboard adapter entry, so the board went as text only."]

    # With no prompt nothing goes (as for every node, early return), so the
    # note would say the text went when it didn't.
    new_inputs, params, notes = _apply("made-up-generator", definition, {"moodboard": inputs["moodboard"]})
    assert new_inputs == {} and params == {} and notes == []


def test_a_reads_board_entry_keeps_the_port_and_others_drop_it():
    for node_id in ("krea-2-generate", "gpt-image-2-edit", "flux-2-pro"):
        inputs = {"prompt": PortValueDict(type="Text", value="A chair"),
                  "moodboard": PortValueDict(type="Moodboard", value=BUNDLE)}
        new_inputs, _, notes = _apply(node_id, DEFINITIONS[node_id], inputs)
        assert ("moodboard" in new_inputs) == (node_id == "krea-2-generate"), node_id
        assert notes == []


def test_an_entry_resolved_on_another_route_is_used(monkeypatch):
    """The dispatcher resolves the entry for the run's route (byRoute), from
    the keys it is given, as the dual-route handler picks it; a node with one
    route resolves with none."""
    adapters = _adapters()
    seen: list[Any] = []
    real = adapters.resolve

    def spy(node_id, params, route=None, **kwargs):
        seen.append((node_id, route))
        return real(node_id, params, route, **kwargs)

    monkeypatch.setattr(adapters, "resolve", spy)
    from services.moodboard_brief import apply_to_generator

    inputs = {"prompt": PortValueDict(type="Text", value="A chair"),
              "moodboard": PortValueDict(type="Moodboard", value=BUNDLE)}
    apply_to_generator("gpt-image-2-fal-edit", DEFINITIONS["gpt-image-2-fal-edit"], inputs, {},
                       api_keys={"FAL_KEY": "k"})
    apply_to_generator("gpt-image-2-fal-edit", DEFINITIONS["gpt-image-2-fal-edit"], inputs, {},
                       api_keys={"OPENAI_API_KEY": "k", "FAL_KEY": "k"})
    apply_to_generator("fast-sdxl", DEFINITIONS["fast-sdxl"], inputs, {}, api_keys={"FAL_KEY": "k"})
    assert seen == [("gpt-image-2-fal-edit", "fal"), ("gpt-image-2-fal-edit", "openai"), ("fast-sdxl", None)]


# -- Krea 2's port and saved graphs -------------------------------------------------------------------------

def _edge_issues(source_definition: str, source_handle: str) -> list[str]:
    from services.port_contracts import ContractEdge, ContractNode, validate_edge_contracts

    result = validate_edge_contracts(
        [ContractNode("a", source_definition), ContractNode("k", "krea-2-generate")],
        [ContractEdge("e", "a", source_handle, "k", "moodboard")], DEFINITIONS)
    return [issue.message for issue in result.issues]


def test_krea2_board_port_still_takes_a_krea_moodboard_and_a_nebula_board():
    """Krea's Moodboard node outputs Any, so it still wires into Krea 2's
    Moodboard port (the handler tells a Krea moodboard id from a Nebula board
    by the value), and so does a Nebula board."""
    assert _edge_issues("krea-moodboard-create", "moodboard") == []
    assert _edge_issues("nebula-moodboard", "moodboard") == []


HINT = ("Krea 2's Moodboard input takes a Nebula moodboard or the Krea Moodboard node's Moodboard output; put a "
        "Krea moodboard id in the node's Moodboard ID setting instead.")


@pytest.mark.parametrize("source,handle", [("text-input", "text"), ("krea-moodboard-create", "moodboard_id")])
def test_a_text_wire_into_krea2_moodboard_is_flagged_with_where_the_id_goes(source, handle):
    """Plan PR13 risk: a saved graph that wired text (a Krea moodboard id, by
    hand or from Krea's Moodboard node's Moodboard ID output) into Krea 2's
    old Any port. The run names the port and where the id goes now."""
    assert _edge_issues(source, handle) == [
        f"Incompatible port types: source '{handle}' on node 'a' outputs Text, but target 'moodboard' on node 'k' "
        f"accepts Moodboard. {HINT}"]


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from fastapi.testclient import TestClient

    import main as main_module
    from services.cli_graph import CLIGraph
    from services.execution_runs import ExecutionRunRegistry
    from services.project_store import ProjectStore
    from services.provider_recovery import ProviderRecoveryStore
    from services.provider_start_guard import ProviderStartGuard

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", ProjectStore(tmp_path / "projects"))
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return TestClient(main_module.app), graph


def test_a_saved_text_wire_into_krea2_moodboard_is_kept_on_save_and_open(workspace, person):
    """Saving and opening a project keep the old edge (nothing drops it on
    load); only a run flags it (above)."""
    client, graph = workspace
    first = client.post("/api/projects", json={"name": "Old Krea 2 graph"}).json()
    project_id = first["project"]["id"]
    snapshot = {
        "nodes": [
            {"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
             "data": {"definitionId": "text-input", "label": "Id", "params": {"value": "mb-123"}, "outputs": {}}},
            {"id": "n2", "type": "model-node", "position": {"x": 300, "y": 0},
             "data": {"definitionId": "krea-2-generate", "label": "Krea 2", "params": {}, "outputs": {}}},
        ],
        "edges": [{"id": "old-wire", "source": "n1", "sourceHandle": "text", "target": "n2",
                   "targetHandle": "moodboard"}],
    }
    saved = client.put(f"/api/projects/{project_id}", json={"workspaceRevision": first["workspaceRevision"],
                                                             "snapshot": snapshot}, headers=person.headers)
    assert saved.status_code == 200, saved.text
    second = client.post("/api/projects", json={"name": "Elsewhere",
                                                "workspaceRevision": first["workspaceRevision"]}).json()
    opened = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": second["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    assert opened.json()["project"]["snapshot"]["edges"] == snapshot["edges"]
    assert [edge["id"] for edge in graph.edges] == ["old-wire"]


def _old_krea2_graph(source_handle: str = "text", target_handle: str = "moodboard") -> dict[str, Any]:
    return {
        "nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "mb-123"}},
                  {"id": "b", "definitionId": "krea-2-generate", "params": {}}],
        "edges": [{"id": "e", "source": "a", "sourceHandle": source_handle, "target": "b",
                   "targetHandle": target_handle}],
    }


def test_an_imported_graph_keeps_the_old_wire_and_a_new_wire_is_refused(workspace, person):
    """A .nebula file is a saved graph too; a wire made now isn't."""
    client, graph = workspace
    imported = client.post("/api/graph/import", json=_old_krea2_graph(), headers=person.headers)
    assert imported.status_code == 200, imported.text
    assert [(edge["sourceHandle"], edge["targetHandle"]) for edge in graph.edges] == [("text", "moodboard")]
    client.post("/api/graph/import", json={"nodes": [], "edges": []}, headers=person.headers)
    added = [client.post("/api/graph/node", json={"definitionId": d, "params": p}, headers=person.headers).json()
             for d, p in (("text-input", {"value": "mb-123"}), ("krea-2-generate", {}))]
    refused = client.post("/api/graph/connect", json={"source": added[0]["id"], "sourceHandle": "text",
                                                      "target": added[1]["id"], "targetHandle": "moodboard"},
                          headers=person.headers)
    assert refused.status_code == 400 and HINT in refused.json()["detail"], refused.text


def test_a_saved_wire_that_was_never_valid_is_still_refused(workspace, person):
    """Only a retyped port's old wires are kept: text into Krea 2's style
    images was never valid, so a saved graph with it still fails."""
    client, _ = workspace
    refused = client.post("/api/graph/import", json=_old_krea2_graph(target_handle="style_images"),
                          headers=person.headers)
    assert refused.status_code == 400 and "Incompatible port types" in refused.json()["detail"], refused.text


# -- the route ----------------------------------------------------------------------------------------------

def test_the_adapters_route_serves_both_tables():
    from fastapi.testclient import TestClient

    import main as main_module

    response = TestClient(main_module.app).get("/api/moodboard/adapters")
    assert response.status_code == 200
    body = response.json()
    assert body["entries"] == _table()["entries"]
    assert body["entries"]["gpt-image-2-edit"]["default"] == "text"
    assert "census" not in body


# -- the contract script (scripts/check-node-contracts.mjs) -------------------------------------------------

def _contract_script(table: dict[str, Any], tmp_path: Path) -> subprocess.CompletedProcess:
    path = tmp_path / "moodboard_adapters.json"
    path.write_text(json.dumps(table))
    return subprocess.run(["node", str(ROOT / "scripts" / "check-node-contracts.mjs")], capture_output=True,
                          text=True, env={**os.environ, "NEBULA_CONTRACTS_ADAPTERS_PATH": str(path)})


def test_the_contract_script_passes_the_real_table(tmp_path):
    result = _contract_script(json.loads((DATA / "moodboard_adapters.json").read_text()), tmp_path)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("change,message", [
    (lambda t: t["entries"].pop("nano-banana"), "nano-banana: has a Moodboard input port but no adapter entry"),
    (lambda t: t["entries"]["gpt-image-1-edit"].update(never=["mask"]),
     "gpt-image-1-edit: input port image (Image) isn't classified in slots, never or needsWired"),
    (lambda t: t["entries"]["krea-2-generate"]["weight"].update(range=[-2, 2]),
     "krea-2-generate: weight range [-2, 2] isn't the vendor's [0, 1]"),
    (lambda t: t["entries"]["nano-banana"].update(syntax=None),
     "nano-banana: syntax null needs a syntaxReason"),
    (lambda t: t["census"]["pending"].pop("krea-3"),
     "krea-3: takes a prompt but has no Moodboard port, and isn't listed as excluded or pending"),
    (lambda t: t.update(entries=dict(reversed(list(t["entries"].items())))),
     "moodboard_adapters.json: entries must be sorted by node id"),
])
def test_the_contract_script_refuses_what_the_backend_refuses(tmp_path, change, message):
    table = json.loads((DATA / "moodboard_adapters.json").read_text())
    change(table)
    result = _contract_script(table, tmp_path)
    assert result.returncode == 1, result.stdout
    assert message in result.stderr, result.stderr


_PARITY_RUNNER = """
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [moduleUrl, casesPath, catalogPath, routeTablesPath, repoRoot] = process.argv.slice(1);
const { tableProblems } = await import(moduleUrl);
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const keyProviders = JSON.parse(readFileSync(routeTablesPath, 'utf8')).keyProviders;
console.log(JSON.stringify(cases.map((c) => tableProblems(c.table, c.definitions, { catalog, keyProviders, repoRoot }))));
"""


def _parity_cases() -> list[dict[str, Any]]:
    cases = []

    def case(change):
        table, definitions = copy.deepcopy(_table()), copy.deepcopy(DEFINITIONS)
        change(table["entries"], table["census"], definitions)
        cases.append({"table": {"entries": table["entries"], "census": table["census"]}, "definitions": definitions})

    def frame_and_global(entries, census, definitions):
        definitions["gpt-image-2-edit"]["inputPorts"].append({"id": "endFrame", "label": "x", "dataType": "Image"})
        entries["gpt-image-2-edit"]["slots"].append({"port": "endFrame", "max": 1})
        entries["gpt-image-2-edit"]["weight"] = {"mode": "global", "param": "nope", "range": [1, 0], "normalize": "x"}

    def ports_moved(entries, census, definitions):
        definitions["krea-2-generate"]["inputPorts"] = [
            p for p in definitions["krea-2-generate"]["inputPorts"] if p["id"] != "moodboard"]
        definitions["krea-3"]["inputPorts"].append({"id": "moodboard", "dataType": "Any"})
        entries["nosuchnode"] = {}

    case(lambda e, c, d: None)
    case(lambda e, c, d: e["krea-2-generate"]["weight"].update(normalize="rank", precision=2, extra=1))
    case(lambda e, c, d: e["krea-2-generate"]["weight"]["schema"].update(endpoints=["/nope"]))
    case(lambda e, c, d: e["nano-banana"].update(syntax=None, order="x", collage=True, limits={"face": "x"},
                                                 requires=3, costPerRef="z", handler="h", channel="bogus"))
    case(lambda e, c, d: e["nano-banana"].update(syntax="Image n", byModel={"model=gemini-9": {}, "zz": 3},
                                                 byRoute={"replicate": {}}))
    case(lambda e, c, d: e["gpt-image-2-edit"].update(
        slots=[{"port": "images", "max": 99, "x": 1, "sharesLimitWith": ["nope"], "roles": {"a": -1}}],
        needsWired=["mask"], exclusive=["zzz"]))
    case(lambda e, c, d: e["gpt-image-2-fal-edit"].update(byRoute={"openai": {"channel": "text-only"}}))
    case(lambda e, c, d: e["fast-sdxl"].update(
        slots=[{"port": "prompt", "max": 1}], weight={}, checked="2099-01-01",
        sources=[{"url": "http://x"}, {"code": "nope.py:1"}, {"code": "README.md", "quote": "", "checked": "bad",
                                                              "k": 1}],
        unconfirmed=[""], textSlot={"port": "nope"}, text="x", textUnless="q", negativeField="y",
        paletteParam={"param": "x"}))
    case(lambda e, c, d: e["gpt-image-2-edit"].update(weight={"mode": "at-creation", "normalize": "none"},
                                                      collage=True, slots=[{"port": "images", "max": 1}]))
    case(lambda e, c, d: e["nano-banana"].update(weight={"mode": "zzz"}, slots="x", never="y"))
    case(lambda e, c, d: c.update(categories=["image-gen"]))
    case(lambda e, c, d: c["pending"].update({"krea-2-generate": "x", "flux-video-edit": "PR16", "nosuch": "PR1"}))
    case(frame_and_global)
    case(ports_moved)
    return cases


def test_the_contract_script_and_the_backend_say_the_same(tmp_path):
    """The two checks (Node for CI's contracts job, Python for the backend
    suite) give the same problems, in the same order, on broken tables."""
    cases = _parity_cases()
    path = tmp_path / "cases.json"
    path.write_text(json.dumps(cases))
    module = (ROOT / "scripts" / "moodboard-adapter-contract.mjs").as_uri()
    result = subprocess.run(
        ["node", "--input-type=module", "-e", _PARITY_RUNNER, module, str(path),
         str(DATA / "krea_gateway_models.json"), str(ROOT / "backend/tests/fixtures/route_tables.json"), str(ROOT)],
        capture_output=True, text=True, check=True)
    node = json.loads(result.stdout)
    python = [_adapters().table_problems(c["table"], c["definitions"], CATALOG) for c in cases]
    assert node == python
    assert python[0] == [] and all(python[1:])


def test_card_line_reads_as_the_card_says_it():
    """card_line is lib/moodboardAdapters.ts adapterLine, for describe_node and
    `nebula info` (frontend/tests/moodboardAdapters.test.ts has the same cases)."""
    from services import moodboard_adapters as adapters

    def line(node_id: str) -> str:
        return adapters.card_line(adapters.resolve(node_id, {}, None), DEFINITIONS[node_id])

    assert line("gpt-image-2-generate") == "This model takes the brief as text."
    assert line("fast-sdxl") == "This model takes the brief as text."
    assert line("gpt-image-2-edit") == "Board images: off · the brief goes as text"
    assert line("nano-banana") == "Board images: off · the brief goes as text"
    assert line("krea-2-generate") == "Board images: on · up to 10 to Image Style Refs"
    assert adapters.card_line(None, DEFINITIONS["flux-2-pro"]) == "This model takes the brief as text."


def test_describe_variants_resolve_on_the_route_their_own_run_takes(monkeypatch):
    """A byModel value that moves the run to another route (here a fal-only
    image_size on GPT Image 2 Edit) is described on that route, as the run
    resolves it, not on the default's."""
    from services import moodboard_adapters as adapters

    definition = DEFINITIONS["gpt-image-2-fal-edit"]
    entry = copy.deepcopy(_table()["entries"]["gpt-image-2-fal-edit"])
    entry["byModel"] = {"image_size=square": {"order": "upload"}}
    entry["byRoute"] = {"fal": {"slots": [{"port": "images", "max": 4}]}}
    real = adapters.table()
    monkeypatch.setattr(adapters, "table", lambda: {**real, "entries": {**real["entries"], definition["id"]: entry}})
    keys = {"OPENAI_API_KEY": "o", "FAL_KEY": "f"}

    described = adapters.describe(definition, keys)
    assert described["route"] == "openai" and described["slots"][0]["max"] == 16
    square = next(v for v in described["variants"] if v["when"] == {"image_size": "square"})
    wired = {"moodboard": PortValueDict(type="Moodboard", value={"id": "b1"})}
    route = adapters.run_route(definition, {"image_size": "square"}, wired, keys)
    run = adapters.resolve(definition["id"], {"image_size": "square"}, route, definition=definition)
    assert route == "fal" and square["route"] == "fal"
    assert square["slots"] == [{"port": "images", "label": "Reference Images", "max": run["slots"][0]["max"]}] == [
        {"port": "images", "label": "Reference Images", "max": 4}]
    assert square["order"] == "upload"
