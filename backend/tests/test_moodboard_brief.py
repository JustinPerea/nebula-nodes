"""The moodboard brief: fields on the board, an override, model-aware Avoid,
and the one-time migration (design-canvas gap 14; decisions B4-B7).

- Direction, Avoid and pinned colours live on the board, so analyzing again
  keeps them, and the brief generators get joins them with the analysis.
- Default negatives are defects only; content intent is a positive sentence.
- A hand-written brief survives analysis and is flagged once the board
  changes; Keep restamps it, Regenerate (null) drops it.
- The Avoid list joins the prompt only for instruction-following models
  (GPT Image, Nano Banana, Krea 2); diffusion-style ones never get it there,
  and a model with a negative field gets the negatives there.
- Boards saved before these fields are migrated once, with backups.
"""
from __future__ import annotations

import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from execution.engine import execute_graph
from handlers.moodboard import handle_moodboard_node
from models.events import ErrorEvent
from models.graph import GraphEdge, GraphNode, PortValueDict
from services import moodboard_brief
from services.moodboard_analysis import analyze_moodboard, source_hash
from services.moodboard_brief import apply_to_generator, compose, migrate_board, migrate_store
from services.moodboard_store import MoodboardStore, migrate_brief_fields
from services.output import OUTPUT_ROOT

BLUE = (72, 92, 170)       # #485caa, the colour that took over a GM branch
ORANGE = (240, 110, 30)


def _url(color=(200, 80, 40)) -> str:
    path = OUTPUT_ROOT / "moodboard-brief-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


@pytest.fixture
def client(tmp_path, monkeypatch):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    return TestClient(main_module.app)


def _create(client, **body) -> dict:
    response = client.post("/api/moodboards", json={"name": "Board", "images": [{"url": _url(BLUE)}], **body})
    assert response.status_code == 200, response.text
    return response.json()


# -- fields on the board -------------------------------------------------------

def test_direction_avoid_and_pins_survive_analyzing_again(client):
    board = _create(client)
    fields = {
        "direction": "Warm editorial product shots",
        "avoid": ["neon signage", " Neon signage ", "", "lens flare"],
        "pinnedColors": {"include": ["#F06E1E"], "exclude": ["485caa"]},
    }
    updated = client.put(f"/api/moodboards/{board['id']}", json=fields).json()
    assert updated["avoid"] == ["neon signage", "lens flare"]
    assert updated["pinnedColors"] == {"include": ["#f06e1e"], "exclude": ["#485caa"]}

    for _ in range(2):
        analyzed = client.post(f"/api/moodboards/{board['id']}/analyze").json()
        assert analyzed["direction"] == "Warm editorial product shots"
        assert analyzed["avoid"] == ["neon signage", "lens flare"]
        assert analyzed["pinnedColors"]["exclude"] == ["#485caa"]

    brief = analyzed["brief"]
    assert brief["styleBrief"].startswith("Warm editorial product shots. Use the Nebula moodboard")
    assert "Make sure these colors appear: #f06e1e." in brief["styleBrief"]
    # The board is all #485caa, which the person kept out: it leaves the
    # brief's palette and the palette sent on, but stays in the analysis.
    assert analyzed["analysis"]["palette"] and "Color palette" not in brief["styleBrief"]
    assert brief["palette"] == []
    assert brief["negativePrompt"] == "blurry, low-detail artifacts, neon signage, lens flare"
    assert brief["avoidPrompt"] == ("Keep these out of the image: neon signage, lens flare, "
                                   "colors close to #485caa.")


def test_changing_the_fields_keeps_the_analysis_current(client):
    board = _create(client)
    analyzed = client.post(f"/api/moodboards/{board['id']}/analyze").json()
    client.put(f"/api/moodboards/{board['id']}", json={"direction": "Calm", "avoid": ["text"]})

    stored = MoodboardStore().get(board["id"])
    assert stored["analysis"]["sourceHash"] == analyzed["analysis"]["sourceHash"] == source_hash(stored)


@pytest.mark.parametrize("body", [
    {"pinnedColors": {"include": ["#zzz"]}},
    {"pinnedColors": {"include": ["#fff"], "exclude": ["#FFFFFF"]}},
    {"avoid": ["x" * 201]},
    {"briefOverride": {"text": "x", "basis": "forged"}},
])
def test_bad_fields_are_refused(client, body):
    board = _create(client)
    assert client.put(f"/api/moodboards/{board['id']}", json=body).status_code == 422


@pytest.mark.parametrize("mode", ["look", "world", "subject"])
def test_default_negatives_are_defects_only(mode):
    url = _url(ORANGE)
    board = {"id": "b", "name": "Board", "mode": mode, "strength": 0.7, "notes": "",
             "images": [{"url": url, "weight": 1.0}]}
    analysis = analyze_moodboard(board)
    brief = compose(board, analysis)

    assert analysis["negativePrompt"] == brief["negativePrompt"] == "blurry, low-detail artifacts"
    assert analysis["avoids"] == ["blurry", "low-detail artifacts"]
    for banned in ("logo replication", "identity transfer", "copying exact subjects", "mixed eras"):
        assert banned not in brief["negativePrompt"] and banned not in brief["styleBrief"]
    assert brief["avoidPrompt"] == ""
    assert moodboard_brief.MODE_INTENTS[mode] in brief["styleBrief"]


# -- the override ----------------------------------------------------------------

def test_an_override_survives_analysis_and_is_flagged_when_the_board_changes(client):
    board = _create(client)
    client.post(f"/api/moodboards/{board['id']}/analyze")
    written = client.put(f"/api/moodboards/{board['id']}", json={"briefOverride": {"text": "My own brief."}}).json()
    assert written["brief"]["styleBrief"] == "My own brief."
    assert written["brief"]["override"] == {"active": True, "stale": False}
    assert written["brief"]["generatedStyleBrief"].startswith("Use the Nebula moodboard")

    analyzed = client.post(f"/api/moodboards/{board['id']}/analyze").json()
    assert analyzed["brief"]["styleBrief"] == "My own brief." and not analyzed["brief"]["override"]["stale"]

    # Studio saves the whole draft: same override text, new weight.
    images = [{**analyzed["images"][0], "weight": 0.4}]
    changed = client.put(f"/api/moodboards/{board['id']}",
                         json={"images": images, "analysis": None, "briefOverride": {"text": "My own brief."}}).json()
    assert changed["brief"]["override"] == {"active": True, "stale": True}
    assert changed["briefOverride"]["basis"] == written["briefOverride"]["basis"]

    # A Direction change counts as a change too, once kept.
    kept = client.post(f"/api/moodboards/{board['id']}/brief-override/keep").json()
    assert kept["brief"]["override"] == {"active": True, "stale": False}
    assert kept["brief"]["styleBrief"] == "My own brief."
    redirected = client.put(f"/api/moodboards/{board['id']}", json={"direction": "Cooler"}).json()
    assert redirected["brief"]["override"]["stale"] is True

    regenerated = client.put(f"/api/moodboards/{board['id']}", json={"briefOverride": None}).json()
    assert regenerated["briefOverride"] is None
    assert regenerated["brief"]["override"] == {"active": False, "stale": False}
    assert regenerated["brief"]["styleBrief"] == regenerated["brief"]["generatedStyleBrief"] == ""
    assert regenerated["brief"]["needsAnalysis"] is True
    again = client.post(f"/api/moodboards/{board['id']}/analyze").json()
    assert again["brief"]["styleBrief"].startswith("Cooler. Use the Nebula moodboard")


def test_keep_needs_an_override(client):
    board = _create(client)
    assert client.post(f"/api/moodboards/{board['id']}/brief-override/keep").status_code == 409
    assert client.post("/api/moodboards/nope/brief-override/keep").status_code == 404


@pytest.mark.asyncio
async def test_the_node_sends_the_override_and_notes_when_it_is_stale(tmp_path, monkeypatch):
    from models.events import execution_notes

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    board = store.create(name="Board", images=[{"url": _url()}], avoid=["neon"],
                         briefOverride={"text": "Hand brief."})
    store.update(board["id"], strength=0.2)

    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        result = await handle_moodboard_node(
            GraphNode(id="m", definitionId="nebula-moodboard", params={"moodboard": board["id"]}), {}, {})
    finally:
        execution_notes.reset(token)

    bundle = result["moodboard"]["value"]
    assert result["style_brief"]["value"] == bundle["styleBrief"] == "Hand brief."
    assert result["negative_prompt"]["value"] == "blurry, low-detail artifacts, neon"
    assert bundle["providerHints"]["krea"]["styleBrief"] == "Hand brief."
    assert bundle["providerHints"]["generic"]["avoidPrompt"] == "Keep these out of the image: neon."
    assert bundle["briefOverride"] == {"active": True, "stale": True}
    assert notes and "changed after its brief was edited by hand" in notes[0]


# -- reaching generators (B5) ----------------------------------------------------

BUNDLE = {
    "kind": "nebula_moodboard",
    "styleBrief": "Warm light.",
    "negativePrompt": "blurry, low-detail artifacts, neon signage",
    "avoidPrompt": "Keep these out of the image: neon signage.",
}


def _apply(definition_id: str, params: dict | None = None):
    from execution.engine import _node_def_for

    definition = _node_def_for(definition_id)
    inputs = {"prompt": PortValueDict(type="Text", value="A chair"),
              "moodboard": PortValueDict(type="Moodboard", value=BUNDLE)}
    return apply_to_generator(definition_id, definition, inputs, params or {})


@pytest.mark.parametrize("definition_id", [
    "gpt-image-2-generate", "gpt-image-2-edit", "gpt-image-2-5-generate", "gpt-image-1-5",
    "gpt-image-2-fal-generate", "nano-banana", "nano-banana-fal-edit", "krea-2-generate",
])
def test_instruction_following_models_get_the_avoid_list_in_the_prompt(definition_id):
    inputs, params = _apply(definition_id)

    assert inputs["prompt"].value == ("A chair\n\nMoodboard direction: Warm light.\n\n"
                                      "Keep these out of the image: neon signage.")
    assert params == {}


def test_a_diffusion_model_gets_the_brief_but_never_the_avoid_list():
    inputs, params = _apply("flux-2-pro")

    assert inputs["prompt"].value == "A chair\n\nMoodboard direction: Warm light."
    assert "neon" not in inputs["prompt"].value and params == {}


def test_a_negative_field_gets_the_negatives_and_the_node_keeps_its_own():
    own = {"negative_prompt": "watermark, Blurry"}
    inputs, params = _apply("fast-sdxl", own)

    assert "neon" not in inputs["prompt"].value
    assert params["negative_prompt"] == "watermark, Blurry, low-detail artifacts, neon signage"
    assert own == {"negative_prompt": "watermark, Blurry"}


def test_every_node_with_a_board_port_is_classified():
    from execution.engine import _node_def_for

    import json as _json
    from pathlib import Path

    registry = _json.loads((Path(__file__).parent.parent / "data" / "node_definitions.json").read_text())
    with_port = sorted(node_id for node_id, d in registry.items()
                       if any(p.get("id") == "moodboard" and p.get("dataType") == "Moodboard"
                              for p in d.get("inputPorts", [])))
    assert with_port, "generators take a Moodboard input"
    instruction = [i for i in with_port if moodboard_brief.follows_instructions(i)]
    diffusion = [i for i in with_port if not moodboard_brief.follows_instructions(i)]
    assert all(i.startswith(("gpt-image-", "nano-banana")) for i in instruction)
    assert set(diffusion) == {"fast-sdxl", "flux-2-pro"}
    assert all(_node_def_for(i) for i in with_port)


@pytest.mark.asyncio
async def test_the_engine_hands_each_generator_its_own_request(tmp_path, monkeypatch):
    """A board wired into GPT Image and FLUX.2: GPT Image's prompt carries the
    Avoid list, FLUX.2's doesn't, and the saved node params are untouched."""
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    board = MoodboardStore().create(name="Board", images=[{"url": _url(ORANGE)}],
                                    direction="Sunlit", avoid=["neon signage"])
    seen: dict[str, tuple[str, dict]] = {}
    ports: dict[str, set[str]] = {}

    def fake(node_key):
        async def handler(node, inputs, api_keys):
            seen[node_key] = (inputs["prompt"].value, dict(node.params))
            node.params["_usedSize"] = "1024x1024"  # what a handler records it used
            ports[node_key] = set(inputs)
            return {"image": {"type": "Image", "value": _url()}}
        return handler

    events: list[object] = []

    async def emit(event):
        events.append(event)

    sdxl = GraphNode(id="sdxl", definitionId="fast-sdxl", params={"negative_prompt": "watermark"})
    nodes = [
        GraphNode(id="text", definitionId="text-input", params={"value": "A chair"}),
        GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board["id"]}),
        GraphNode(id="gpt", definitionId="gpt-image-2-generate", params={}),
        GraphNode(id="flux", definitionId="flux-2-pro", params={}),
        sdxl,
    ]
    edges = []
    for target in ("gpt", "flux", "sdxl"):
        edges.append(GraphEdge(id=f"p-{target}", source="text", sourceHandle="text",
                               target=target, targetHandle="prompt"))
        edges.append(GraphEdge(id=f"m-{target}", source="board", sourceHandle="moodboard",
                               target=target, targetHandle="moodboard"))
    await execute_graph(
        nodes=nodes, edges=edges, api_keys={},
        handler_registry={"nebula-moodboard": handle_moodboard_node, "gpt-image-2-generate": fake("gpt"),
                          "flux-2-pro": fake("flux"), "fast-sdxl": fake("sdxl")},
        emit=emit,
    )

    assert not [e for e in events if isinstance(e, ErrorEvent)], events
    gpt_prompt, _ = seen["gpt"]
    flux_prompt, _ = seen["flux"]
    sdxl_prompt, sdxl_params = seen["sdxl"]
    assert gpt_prompt.startswith("A chair\n\nMoodboard direction: Sunlit. Use the Nebula moodboard")
    assert gpt_prompt.endswith("\n\nKeep these out of the image: neon signage.")
    assert flux_prompt.startswith("A chair\n\nMoodboard direction: Sunlit.") and "neon" not in flux_prompt
    assert "neon" not in sdxl_prompt
    assert sdxl_params["negative_prompt"] == "watermark, blurry, low-detail artifacts, neon signage"
    # The node keeps its own negative, and still gets what the handler recorded.
    assert sdxl.params == {"negative_prompt": "watermark", "_usedSize": "1024x1024"}
    # The board is folded in, not passed on: these handlers never see it.
    assert ports == {"gpt": {"prompt"}, "flux": {"prompt"}, "sdxl": {"prompt"}}


def test_only_a_handler_that_reads_the_board_gets_the_port():
    """Krea 2 turns the board's images into style references; other nodes'
    Moodboard port exists only for the brief, and a handler that sends wired
    ports by name (Krea's catalog routes) must not send the bundle on."""
    gpt_inputs, _ = _apply("gpt-image-2-generate")
    krea_inputs, _ = _apply("krea-2-generate")

    assert "moodboard" not in gpt_inputs
    assert krea_inputs["moodboard"].value == BUNDLE

    from execution.engine import _node_def_for
    empty = {"prompt": PortValueDict(type="Text", value=""),
             "moodboard": PortValueDict(type="Moodboard", value=BUNDLE)}
    still, _ = apply_to_generator("flux-2-pro", _node_def_for("flux-2-pro"), empty, {})
    assert set(still) == {"prompt"}


@pytest.mark.asyncio
async def test_a_new_avoid_item_is_a_new_cache_entry(tmp_path, monkeypatch):
    """FLUX-style models get the Avoid list only in their negative field, so
    the cache key must see it there: editing Avoid can't replay an old image."""
    from services.cache import ExecutionCache

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    board = store.create(name="Board", images=[{"url": _url(ORANGE)}], avoid=["neon signage"])
    calls: list[str] = []

    async def sdxl(node, inputs, api_keys):
        calls.append(node.params["negative_prompt"])
        return {"image": {"type": "Image", "value": _url()}}

    async def emit(event):
        return None

    nodes = [
        GraphNode(id="text", definitionId="text-input", params={"value": "A chair"}),
        GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board["id"]}),
        GraphNode(id="sdxl", definitionId="fast-sdxl", params={}),
    ]
    edges = [GraphEdge(id="p", source="text", sourceHandle="text", target="sdxl", targetHandle="prompt"),
             GraphEdge(id="m", source="board", sourceHandle="moodboard", target="sdxl", targetHandle="moodboard")]
    cache = ExecutionCache()
    registry = {"nebula-moodboard": handle_moodboard_node, "fast-sdxl": sdxl}
    for avoid in (["neon signage"], ["neon signage"], ["neon signage", "lens flare"]):
        store.update(board["id"], avoid=avoid)
        await execute_graph(nodes=nodes, edges=edges, api_keys={}, handler_registry=registry,
                            emit=emit, cache=cache)

    assert calls == ["blurry, low-detail artifacts, neon signage",
                     "blurry, low-detail artifacts, neon signage, lens flare"]


# -- migration (B7) ----------------------------------------------------------------

def _old_board(tmp_path, *, edited_brief: str | None = None, negatives: str | None = None,
               version: int = 2, rename: str | None = None) -> dict:
    """A board as analyzer version 1 or 2 left it, built with the old code's words."""
    url = _url(ORANGE)
    board = {"id": uuid4().hex[:12], "name": "Old board", "version": 3, "mode": "look", "strength": 0.7,
             "notes": "dusty film grain", "images": [{"id": "i", "url": url, "weight": 1.0, "notes": "",
                                                       "excluded": False}],
             "thumbnail": url, "projectId": None, "createdAt": "2026-10-01", "updatedAt": "2026-10-01"}
    analysis = analyze_moodboard(board)
    label = "visual style only; avoid copying specific subjects or identities"
    parts = [f"Use the Nebula moodboard 'Old board' as look direction at strength 0.70."]
    if version == 1:
        parts.append(label)
        parts.append(f"Color palette: {', '.join(analysis['palette'])}.")
    else:
        parts.append(f"{label.capitalize()}.")
        parts.append(f"Color palette: {', '.join(analysis['palette'])}.")
        if analysis["accents"]:
            parts.append(f"Accent colors, used sparingly: {', '.join(analysis['accents'])}.")
    parts.append(f"Visual cues: {', '.join(analysis['keywords'][:10])}.")
    parts.append("User notes: dusty film grain")
    old_negatives = ("unrelated style drift, conflicting palettes, random artifacts, "
                     "copying exact subjects, identity transfer, logo replication")
    analysis.update({"version": version, "styleBrief": edited_brief or " ".join(parts),
                     "negativePrompt": negatives or old_negatives})
    if version == 1:
        analysis["sourceHash"] = source_hash(board, 1)
        analysis.pop("accents", None)
    board["analysis"] = analysis
    if rename:
        board["name"] = rename
    return board


def test_an_untouched_old_board_gains_empty_fields_and_no_override(tmp_path):
    for version in (1, 2):
        board = _old_board(tmp_path, version=version, rename="Renamed since" if version == 2 else None)
        new, record = migrate_board(board)

        assert new["avoid"] == [] and new["direction"] == "" and new["briefOverride"] is None
        assert new["pinnedColors"] == {"include": [], "exclude": []}
        assert record["avoidAdded"] == [] and record["overrideFromEditedBrief"] is False
        assert new["analysis"] == board["analysis"]
        assert migrate_board(new) is None


def test_extra_negatives_move_to_avoid_and_an_edited_brief_becomes_the_override(tmp_path):
    board = _old_board(tmp_path, edited_brief="My words, not the analyzer's.",
                       negatives="unrelated style drift, conflicting palettes, random artifacts, "
                                 "copying exact subjects, identity transfer, chrome text, neon")
    new, record = migrate_board(board)

    assert new["avoid"] == ["chrome text", "neon"] and record["avoidAdded"] == ["chrome text", "neon"]
    assert new["briefOverride"]["text"] == "My words, not the analyzer's."
    brief = compose(new)
    assert brief["styleBrief"] == "My words, not the analyzer's."
    assert brief["override"] == {"active": True, "stale": False}
    assert "logo replication" not in brief["negativePrompt"]


def test_an_edit_on_an_out_of_date_analysis_is_flagged(tmp_path):
    board = _old_board(tmp_path, edited_brief="Edited, then the board changed.")
    board["images"][0]["weight"] = 0.5
    new, record = migrate_board(board)

    assert record["overrideFromEditedBrief"] is True and record["overrideCurrent"] is False
    assert compose(new)["override"]["stale"] is True


def test_migrating_the_store_backs_up_every_file_and_runs_once(tmp_path, monkeypatch):
    root = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    (root / "_global").mkdir(parents=True)
    (root / "proj1").mkdir()
    edited = _old_board(tmp_path, edited_brief="Hand edit.", negatives="random artifacts, chrome text")
    plain = _old_board(tmp_path)
    (root / "_global" / f"{edited['id']}.json").write_text(json.dumps(edited))
    (root / "proj1" / f"{plain['id']}.json").write_text(json.dumps(plain))
    (root / "proj1" / "broken.json").write_text("{not json")
    before = {p.name: p.read_text() for p in root.rglob("*.json")}

    report = migrate_brief_fields()

    assert {r["id"] for r in report["migrated"]} == {edited["id"], plain["id"]}
    assert len(report["skipped"]) == 1
    backups = tmp_path / "moodboard-backups"
    for record in report["migrated"]:
        backup = backups / record["backup"].split("moodboard-backups/", 1)[1]
        assert backup.read_text() == before[backup.name]
    log = json.loads((backups / report["backupDir"].rsplit("/", 1)[1] / "migration-log.json").read_text())
    assert any(r["avoidAdded"] == ["chrome text"] and r["overrideFromEditedBrief"] for r in log["migrated"])

    saved = MoodboardStore().get(edited["id"])
    assert saved["briefVersion"] == 1 and saved["avoid"] == ["chrome text"]
    assert saved["briefOverride"]["text"] == "Hand edit."
    assert saved["analysis"] == edited["analysis"]

    again = migrate_store(root, backups)
    assert again["migrated"] == [] and len(list(backups.iterdir())) == 1


def test_a_board_read_before_the_startup_migration_still_has_its_fields(tmp_path, monkeypatch):
    root = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    (root / "_global").mkdir(parents=True)
    board = _old_board(tmp_path, negatives="random artifacts, chrome text")
    (root / "_global" / f"{board['id']}.json").write_text(json.dumps(board))

    assert MoodboardStore().get(board["id"])["avoid"] == ["chrome text"]
    assert MoodboardStore().list("global")[0]["avoid"] == ["chrome text"]


def test_one_board_that_fails_to_migrate_does_not_stop_the_others(tmp_path, monkeypatch):
    root = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    (root / "_global").mkdir(parents=True)
    good, odd = _old_board(tmp_path, negatives="random artifacts, chrome text"), _old_board(tmp_path)
    for board in (good, odd):
        (root / "_global" / f"{board['id']}.json").write_text(json.dumps(board))
    real = moodboard_brief.migrate_board

    def flaky(board):
        if board.get("id") == odd["id"]:
            raise TypeError("odd board")
        return real(board)

    monkeypatch.setattr(moodboard_brief, "migrate_board", flaky)
    report = migrate_brief_fields()

    assert [r["id"] for r in report["migrated"]] == [good["id"]]
    assert report["skipped"] and "odd board" in report["skipped"][0]["reason"]
    # It still opens, as it was saved.
    assert MoodboardStore().get(odd["id"])["analysis"] == odd["analysis"]


# -- review fixes ----------------------------------------------------------------

def test_a_migrated_board_with_a_long_old_negative_can_still_be_saved(client, tmp_path):
    root = tmp_path / "moodboards"
    (root / "_global").mkdir(parents=True)
    long_term = "keep the background plain and quiet " * 8          # one 288-character negative
    board = _old_board(tmp_path, negatives=f"random artifacts, {long_term}")
    (root / "_global" / f"{board['id']}.json").write_text(json.dumps(board))

    report = migrate_brief_fields()
    record = report["migrated"][0]
    assert record["avoidClipped"]["original"] == [long_term.strip()]

    saved = client.get(f"/api/moodboards/{board['id']}").json()
    assert all(len(item) <= moodboard_brief.AVOID_ITEM_LIMIT for item in saved["avoid"])
    # What Studio does on every change: send the whole draft back.
    response = client.put(f"/api/moodboards/{board['id']}", json={"name": "Renamed", "avoid": saved["avoid"]})
    assert response.status_code == 200, response.text


def test_keep_on_an_id_no_board_can_have_is_not_found(client):
    response = client.post("/api/moodboards/not..an..id/brief-override/keep")
    assert response.status_code == 404


def test_keep_without_an_override_says_how_to_write_one(client):
    board = _create(client)
    response = client.post(f"/api/moodboards/{board['id']}/brief-override/keep")
    assert response.status_code == 409 and "briefOverride" in response.json()["detail"]


def test_an_unreadable_board_file_leaves_no_backup_folder_behind(tmp_path, monkeypatch):
    root = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    (root / "_global").mkdir(parents=True)
    (root / "_global" / "broken.json").write_text("{not json")

    for _ in range(2):
        report = migrate_brief_fields()
        assert len(report["skipped"]) == 1 and report["backupDir"] is None
    assert not (tmp_path / "moodboard-backups").exists()


def test_a_board_written_by_this_analyzer_but_never_migrated_gets_no_override(tmp_path):
    board = _old_board(tmp_path)
    board["analysis"] = analyze_moodboard(board)          # version 3, its own brief
    new, record = migrate_board(board)
    assert record["overrideFromEditedBrief"] is False and new["briefOverride"] is None


def test_a_board_that_cannot_be_written_is_skipped_and_the_rest_migrate(tmp_path, monkeypatch):
    root = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    (root / "_global").mkdir(parents=True)
    first, second = _old_board(tmp_path), _old_board(tmp_path)
    for board in (first, second):
        (root / "_global" / f"{board['id']}.json").write_text(json.dumps(board))
    from services import moodboard_store
    real = moodboard_store._write_json

    def full_disk(path, data):
        if path.stem == first["id"]:
            raise OSError(28, "No space left on device")
        return real(path, data)

    monkeypatch.setattr(moodboard_store, "_write_json", full_disk)
    report = migrate_brief_fields()

    assert [r["id"] for r in report["migrated"]] == [second["id"]]
    assert "No space left" in report["skipped"][0]["reason"]
    assert json.loads((root / "_global" / f"{first['id']}.json").read_text()) == first


def test_studio_stops_at_the_same_limits_the_store_keeps():
    from pathlib import Path
    import re

    source = (Path(__file__).resolve().parents[2] / "frontend/src/components/moodboard-studio/briefLimits.ts").read_text()
    limits = {key: int(value) for key, value in re.findall(r"(\w+): (\d+)", source)}
    assert limits == {
        "direction": moodboard_brief.DIRECTION_LIMIT, "avoidItems": moodboard_brief.AVOID_LIMIT,
        "avoidItem": moodboard_brief.AVOID_ITEM_LIMIT, "pinned": moodboard_brief.PINNED_LIMIT,
        "override": moodboard_brief.OVERRIDE_LIMIT,
    }
