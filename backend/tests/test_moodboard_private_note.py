"""An image's private note: the person's own label ("PAINTERLY (liked)").

It is kept on the board and shown to whoever inspects it (Moodboard Studio,
`nebula moodboard show`, moodboard_get), but it never reaches the analysis,
its source hash, the composed brief, the negative prompt or the Moodboard
node's outputs, and changing it keeps the analysis.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

import mcp_server
import moodboard_client as boards
from handlers.moodboard import handle_moodboard_node
from models.graph import GraphNode
from services.moodboard_analysis import analysis_is_current, analyze_moodboard, source_hash
from services.moodboard_brief import brief_basis, compose
from services.moodboard_store import PRIVATE_NOTE_LIMIT, MoodboardStore
from services.output import OUTPUT_ROOT

# A label no analysis, brief or prompt would ever make up on its own.
LABEL = "ZQXPRIVATE painterly (liked)"


def _image_url(name: str, color: tuple[int, int, int]) -> str:
    path = OUTPUT_ROOT / "moodboard-tests" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _board(tmp_path, monkeypatch, *, private: str = LABEL) -> dict:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    store = MoodboardStore()
    board = store.create(
        name="Private board",
        images=[{"url": _image_url("private-a.png", (210, 90, 30)), "notes": "the orange accent", "privateNote": private},
                {"url": _image_url("private-b.png", (20, 140, 190))}],
        notes="editorial warmth", direction="Quiet coastal mornings", avoid=["neon signage"])
    return store.update(board["id"], analysis=analyze_moodboard(board))


def test_the_store_keeps_a_private_note_and_refuses_one_too_long(tmp_path, monkeypatch):
    board = _board(tmp_path, monkeypatch)
    assert board["images"][0]["privateNote"] == LABEL
    assert board["images"][1]["privateNote"] == ""
    assert MoodboardStore().get(board["id"])["images"][0]["privateNote"] == LABEL
    with pytest.raises(ValueError, match=r"images\[0\]\.privateNote is longer than 2000 characters"):
        MoodboardStore().update(board["id"], images=[{**board["images"][0], "privateNote": "x" * (PRIVATE_NOTE_LIMIT + 1)}])


def test_a_board_saved_before_private_notes_reads_with_empty_ones(tmp_path, monkeypatch):
    board = _board(tmp_path, monkeypatch)
    path = next((tmp_path / "moodboards" / "_global").glob("*.json"))
    raw = json.loads(path.read_text(encoding="utf-8"))
    for image in raw["images"]:
        image.pop("privateNote")
    path.write_text(json.dumps(raw), encoding="utf-8")
    read = MoodboardStore().get(board["id"])
    assert [image["privateNote"] for image in read["images"]] == ["", ""]
    assert analysis_is_current(read, read["analysis"])


def test_the_private_note_is_no_analysis_input(tmp_path, monkeypatch):
    board = _board(tmp_path, monkeypatch)
    relabelled = {**board, "images": [{**board["images"][0], "privateNote": "something else"}, board["images"][1]]}
    assert source_hash(relabelled) == source_hash(board)
    assert source_hash(relabelled, 1) == source_hash(board, 1)
    assert brief_basis(relabelled) == brief_basis(board)
    analysis = analyze_moodboard(board)
    assert LABEL not in json.dumps(analysis)
    assert all("privateNote" not in image for image in analysis["images"])
    # The image note that steers still does.
    assert "the orange accent" in json.dumps(analysis)


def test_changing_the_private_note_keeps_the_analysis_current(tmp_path, monkeypatch):
    board = _board(tmp_path, monkeypatch)
    updated = MoodboardStore().update(
        board["id"], images=[{**board["images"][0], "privateNote": "TOO GRUNGY (no)"}, board["images"][1]])
    assert updated["images"][0]["privateNote"] == "TOO GRUNGY (no)"
    assert updated["analysis"] == board["analysis"]
    assert analysis_is_current(updated, updated["analysis"])


def test_the_composed_brief_and_negative_prompt_never_carry_it(tmp_path, monkeypatch):
    board = _board(tmp_path, monkeypatch)
    brief = compose(board)
    assert brief["styleBrief"]
    assert brief["negativePrompt"]
    assert LABEL not in json.dumps(brief)


@pytest.mark.asyncio
async def test_the_moodboard_node_outputs_never_carry_it(tmp_path, monkeypatch):
    board = _board(tmp_path, monkeypatch)
    # Notes sent (gap 18 sends none by default), so the image note is there
    # beside the private one, which still never goes.
    result = await handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard",
                  params={"moodboard": board["id"], "send_notes": "yes"}), {}, {})
    dumped = json.dumps(result)
    assert LABEL not in dumped
    assert "privateNote" not in dumped
    bundle = result["moodboard"]["value"]
    assert [image["notes"] for image in bundle["images"]] == ["the orange accent", ""]
    assert LABEL not in result["style_brief"]["value"]
    assert LABEL not in result["negative_prompt"]["value"]


# -- the API, the CLI and MCP ---------------------------------------------------

@pytest.fixture
def app(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import main as main_module
    from cli.client import NebulaClient
    from nebula_api import NebulaAPI

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    http = TestClient(main_module.app)
    client = NebulaClient("http://testserver")
    client._client = http
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
    return client


def _png(path: Path, color) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (24, 16), color).save(path, format="PNG")
    return str(path)


def _analyzed(app, tmp_path) -> dict:
    board, _ = boards.create_board(app.api, "Labelled", [_png(tmp_path / "a.png", (232, 89, 60)),
                                                         _png(tmp_path / "b.png", (30, 60, 90))])
    boards.analyze_board(app.api, board["id"])
    return boards.get_board(app.api, board["id"])


def _cli(client, argv: list[str], capsys) -> str:
    from cli.__main__ import build_parser
    from cli.commands import moodboard as moodboard_cmd

    moodboard_cmd.run(client, build_parser().parse_args(argv))
    return capsys.readouterr().out


def test_studio_saving_a_private_note_keeps_the_analysis(app, tmp_path):
    board = _analyzed(app, tmp_path)
    images = [{**image, "privateNote": LABEL if index == 0 else ""} for index, image in enumerate(board["images"])]
    # Studio sends the whole draft back, its analysis included.
    response = app._client.put(f"/api/moodboards/{board['id']}", json={
        "images": [{key: image[key] for key in ("id", "url", "weight", "notes", "privateNote", "excluded")}
                   for image in images],
        "analysis": board["analysis"]})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["images"][0]["privateNote"] == LABEL
    assert saved["analysis"] == board["analysis"]
    assert LABEL not in json.dumps(saved["brief"])


def test_cli_sets_shows_and_restores_a_private_note(app, tmp_path, capsys):
    board = _analyzed(app, tmp_path)
    out = _cli(app, ["moodboard", "set", board["id"], "--private-note", f"1={LABEL}", "--json"], capsys)
    data = json.loads(out)
    assert data["images"][0]["privateNote"] == LABEL
    assert data["images"][1]["privateNote"] == ""
    assert data["analysis"], "a private note keeps the analysis"
    assert data["previous"]["images"][0]["privateNote"] == ""
    assert LABEL not in json.dumps(data["brief"])

    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert f'Private note (not sent anywhere): "{LABEL}"' in shown
    assert "Not analyzed since its last change" not in shown

    previous = tmp_path / "set.json"
    previous.write_text(out, encoding="utf-8")
    _cli(app, ["moodboard", "set", board["id"], "--restore", str(previous)], capsys)
    restored = boards.get_board(app.api, board["id"])
    assert [image["privateNote"] for image in restored["images"]] == ["", ""]
    assert restored["analysis"]


def test_a_private_note_with_a_steering_change_still_clears_the_analysis(app, tmp_path):
    board = _analyzed(app, tmp_path)
    updated, _, _ = boards.update_board(app.api, board["id"], images=[{"image": 1, "privateNote": LABEL, "notes": "warm"}])
    assert updated["images"][0]["privateNote"] == LABEL
    assert updated["analysis"] is None


def test_mcp_update_takes_a_private_note_and_get_shows_it(app, tmp_path):
    board = _analyzed(app, tmp_path)
    updated = mcp_server.moodboard_update(board["id"], images=[{"image": 2, "privateNote": LABEL}])
    assert updated["images"][1]["privateNote"] == LABEL
    assert updated["analysis"]
    assert mcp_server.moodboard_get(board["id"])["images"][1]["privateNote"] == LABEL
    restored = mcp_server.moodboard_update(board["id"], **updated["previous"])
    assert restored["images"][1]["privateNote"] == ""


def test_an_older_nebula_without_private_notes_is_told_plainly(monkeypatch):
    board = {"id": "abc", "name": "Old", "images": [{"id": "i1", "url": "/api/outputs/a.png", "weight": 1.0,
                                                    "notes": "", "excluded": False}]}
    monkeypatch.setattr(boards, "get_board", lambda api, ref, headers=None: board)
    with pytest.raises(boards.MoodboardError, match="no private notes"):
        boards.update_board(object(), "abc", images=[{"image": 1, "privateNote": LABEL}])
    # And `previous` from such a Nebula never sends one back.
    assert "privateNote" not in boards.previous_settings(board)["images"][0]
    assert "privateNote" not in boards.brief(board)["images"][0]
