"""A moodboard's images are Nebula's own files (Q98, Justin 2026-10-21).

Justin's answer to "Should moodboards get the same check?": "a) Yes: the
same check, and the same placeholder for old boards". #133 made a Style's
and a Character's images refuse outside links (services/stored_image_refs.py);
this does the same for every board write that stores an image: making a
board, a PUT that sets or replaces images, the ``add`` edit, and a
``restore`` slice that would put an image back. Each refuses with #133's
answer shape (the field, why, what is allowed) and takes an upload or an
output. A link a board already holds isn't checked again, so a board saved
before the check keeps loading and saving; nothing in Nebula loads it: the
API read names it (``outsideImages``), a run and the analysis leave it out
and say so, Commons' import skips it, and the app shows #133's placeholder.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Code"}
OUTSIDE = "https://example.com/x.png"


def _image(color=(200, 80, 40), size=(32, 24)) -> tuple[str, str]:
    """A real image in the uploads folder: its /api/outputs URL and its path."""
    from services.output import OUTPUT_ROOT

    path = OUTPUT_ROOT / "chat-uploads" / f"board-ref-{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)
    return f"/api/outputs/chat-uploads/{path.name}", str(path.resolve())


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    folder = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(folder))
    return folder


@pytest.fixture
def client(root, monkeypatch, canvas_project):
    import main as main_module

    async def quiet(_data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", quiet)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", quiet)
    return TestClient(main_module.app)


def _detail(response) -> str:
    return str(response.json().get("detail"))


def _refused(response, where: str) -> str:
    assert response.status_code == 422, response.text
    detail = _detail(response)
    assert where in detail, detail
    # #133's answer: what is allowed and how to get there.
    assert "Nebula's own files" in detail and "/api/outputs/" in detail and "/api/uploads" in detail, detail
    return detail


def _old_board(root: Path, *, local: str, outside: str = OUTSIDE, board_id: str = "oldboard0001",
               analysis: dict | None = None) -> dict:
    """A board file written before the check: #1 an outside link, #2 an upload."""
    record = {
        "id": board_id, "name": "Old board", "version": 3, "mode": "look", "strength": 0.7, "notes": "",
        "images": [
            {"id": "imgout", "url": outside, "weight": 1.0, "notes": "", "excluded": False},
            {"id": "imgloc", "url": local, "weight": 1.0, "notes": "", "excluded": False},
        ],
        "analysis": analysis, "thumbnail": outside, "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }
    folder = root / "_global"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{board_id}.json").write_text(json.dumps(record), encoding="utf-8")
    return record


# --------------------------------------------------------------- making a board

@pytest.mark.parametrize("headers", [AGENT, {}, PERSON], ids=["agent", "unnamed", "person"])
def test_a_board_with_an_outside_link_is_refused_and_not_saved(client, headers):
    local, _ = _image()
    response = client.post("/api/moodboards", headers=headers,
                           json={"name": "Web", "images": [{"url": local}, {"url": OUTSIDE}]})

    detail = _refused(response, "images[1].url")
    assert "outside Nebula" in detail
    assert client.get("/api/moodboards").json() == []


def test_a_board_of_nebulas_own_files_saves_in_every_local_form(client):
    upload, _ = _image((10, 10, 200))
    output, path = _image((10, 200, 10))
    loopback = f"http://127.0.0.1:8000{_image((200, 10, 10))[0]}"
    response = client.post("/api/moodboards", headers=AGENT, json={
        "name": "Mine", "images": [{"url": upload}, {"url": path}, {"url": loopback}]})

    assert response.status_code == 200, response.text
    assert [img["url"] for img in response.json()["images"]] == [upload, path, loopback]
    assert "outsideImages" not in response.json()


# The tricky cases #133 reads the way a browser does, plus local refs that
# aren't Nebula's files. Each is refused on a board too.
TRICKY = {
    "https": "https://images.example.com/a.png",
    "upper": "HTTPS://IMAGES.EXAMPLE.COM/A.PNG",
    "lan": "http://192.168.1.20/a.png",
    "protocol-relative": "//images.example.com/a.png",
    "data": "data:image/png;base64,iVBORw0KGgo=",
    "blob": "blob:https://images.example.com/1234",
    "one-slash": "https:/images.example.com/a.png",
    "no-slash": "https:images.example.com/a.png",
    "backslashes": "https:\\\\images.example.com\\a.png",
    "slash-backslash": "/\\images.example.com/a.png",
    "tab-in-scheme": "ht\ttps://images.example.com/a.png",
    "outside-host-outputs-path": "https://images.example.com/api/outputs/chat-uploads/a.png",
    "loopback-not-an-output": "http://localhost:8000/api/moodboards/x",
    "file": "file:///etc/hosts",
    "javascript": "javascript:alert(1)",
    "missing": "/api/outputs/chat-uploads/not-there.png",
    "traversal": "/api/outputs/../settings.json",
    "encoded-traversal": "/api/outputs/%2e%2e/settings.json",
    "text": "url_a",
}


@pytest.mark.parametrize("bad", list(TRICKY.values()), ids=list(TRICKY))
def test_an_image_that_isnt_a_nebula_file_is_refused(client, bad):
    response = client.post("/api/moodboards", headers=AGENT, json={"name": "B", "images": [{"url": bad}]})
    _refused(response, "images[0].url")


def test_a_loopback_looking_link_a_browser_sends_to_another_host_is_refused(client):
    local, _ = _image()
    sneaky = f"http://images.example.com\\@127.0.0.1:8000{local}"
    response = client.post("/api/moodboards", headers=AGENT, json={"name": "B", "images": [{"url": sneaky}]})
    _refused(response, "images[0].url")


# ------------------------------------------------------------------ PUT and edits

def test_a_put_adding_an_outside_link_is_refused_and_writes_nothing(client):
    local, _ = _image()
    made = client.post("/api/moodboards", json={"name": "B", "images": [{"url": local}]}).json()
    images = [{"id": made["images"][0]["id"], "url": local}, {"url": OUTSIDE}]

    _refused(client.put(f"/api/moodboards/{made['id']}", json={"images": images}, headers=AGENT), "images[1].url")
    assert client.get(f"/api/moodboards/{made['id']}").json()["version"] == made["version"]


def test_a_put_replacing_an_images_url_with_an_outside_link_is_refused(client):
    local, _ = _image()
    made = client.post("/api/moodboards", json={"name": "B", "images": [{"url": local}]}).json()
    swapped = [{"id": made["images"][0]["id"], "url": OUTSIDE}]

    _refused(client.put(f"/api/moodboards/{made['id']}", json={"images": swapped}, headers=AGENT), "images[0].url")
    assert client.get(f"/api/moodboards/{made['id']}").json()["images"][0]["url"] == local


@pytest.mark.parametrize("op,where", [
    ({"op": "add", "urls": [OUTSIDE]}, "ops[0] (add): urls[0] is an image link from outside Nebula"),
    ({"op": "add", "images": [{"url": "data:image/png;base64,iVBORw0KGgo="}]},
     "ops[0] (add): images[0].url is an image link from outside Nebula"),
    ({"op": "add", "urls": ["//images.example.com/a.png"], "at": {"x": 10, "y": 10}},
     "ops[0] (add): urls[0] is an image link from outside Nebula"),
], ids=["urls", "images", "protocol-relative-at"])
def test_an_add_edit_with_an_outside_link_is_refused_and_writes_nothing(client, op, where):
    local, _ = _image()
    made = client.post("/api/moodboards", json={"name": "B", "images": [{"url": local}]}).json()

    response = client.post(f"/api/moodboards/{made['id']}/edits", json={"ops": [op]}, headers=AGENT)

    _refused(response, where)  # named as the op names it
    after = client.get(f"/api/moodboards/{made['id']}").json()
    assert after["version"] == made["version"] and len(after["images"]) == 1


def test_an_add_edit_of_an_upload_lands(client):
    local, _ = _image()
    extra, _ = _image((1, 2, 3))
    made = client.post("/api/moodboards", json={"name": "B", "images": [{"url": local}]}).json()

    response = client.post(f"/api/moodboards/{made['id']}/edits", json={"ops": [{"op": "add", "urls": [extra]}]},
                           headers=AGENT)

    assert response.status_code == 200, response.text
    assert [img["url"] for img in response.json()["board"]["images"]] == [local, extra]


def test_a_restore_slice_cant_put_an_outside_link_on_the_board(client):
    """A ``restore`` puts back what a slice says was there: a made-up slice
    naming an outside link is skipped, says why, and saves nothing."""
    local, _ = _image()
    made = client.post("/api/moodboards", json={"name": "B", "images": [{"url": local}]}).json()
    slice_ = {"part": "image", "image": "sneaky1", "index": 0, "expect": None,
              "before": {"id": "sneaky1", "url": OUTSIDE, "weight": 1.0, "notes": "", "privateNote": "",
                         "excluded": False}}

    response = client.post(f"/api/moodboards/{made['id']}/edits",
                           json={"ops": [{"op": "restore", "slices": [slice_]}]}, headers=AGENT)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [img["url"] for img in body["board"]["images"]] == [local]
    skipped = body["applied"][0]["skipped"]
    assert len(skipped) == 1 and "outside Nebula" in skipped[0]["message"], skipped
    assert body["version"] == made["version"]


def test_undoing_the_removal_of_an_old_outside_image_leaves_it_off_and_says_why(client, root):
    local, _ = _image()
    _old_board(root, local=local)
    removed = client.post("/api/moodboards/oldboard0001/edits",
                          json={"ops": [{"op": "remove", "images": [1]}]}, headers=PERSON)
    assert removed.status_code == 200, removed.text
    assert [img["url"] for img in removed.json()["board"]["images"]] == [local]

    undone = client.post("/api/moodboards/oldboard0001/edits", json={"ops": removed.json()["undo"]["ops"]}, headers=PERSON)

    assert undone.status_code == 200, undone.text
    assert [img["url"] for img in undone.json()["board"]["images"]] == [local]
    skipped = undone.json()["applied"][0]["skipped"]
    assert any("outside Nebula" in item["message"] for item in skipped), skipped


def test_an_analysis_naming_an_outside_image_is_refused(client):
    local, _ = _image()
    made = client.post("/api/moodboards", json={"name": "B", "images": [{"url": local}]}).json()
    analysis = {"palette": ["#112233"], "representativeImages": [local, OUTSIDE],
                "providerHints": {"krea": {"representativeImages": [OUTSIDE]}}}

    _refused(client.put(f"/api/moodboards/{made['id']}", json={"analysis": analysis}, headers=AGENT),
             "analysis.representativeImages[1]")
    _refused(client.post("/api/moodboards", json={"name": "C", "images": [{"url": local}], "analysis": analysis},
                         headers=AGENT), "analysis.representativeImages[1]")


# --------------------------------------------------------------------- old boards

def test_an_old_board_reads_whole_and_names_its_outside_images(client, root):
    local, _ = _image()
    _old_board(root, local=local)

    board = client.get("/api/moodboards/oldboard0001").json()
    assert [img["url"] for img in board["images"]] == [OUTSIDE, local]  # nothing rewritten
    assert board["outsideImages"] == ["imgout"]
    listed = client.get("/api/moodboards").json()
    assert listed[0]["outsideImages"] == ["imgout"]
    # The file on disk is untouched by the read.
    saved = json.loads((root / "_global" / "oldboard0001.json").read_text(encoding="utf-8"))
    assert "outsideImages" not in saved


def test_the_studio_can_still_save_an_old_board_with_the_link_it_holds(client, root):
    """The Studio sends every image it read, the held link too: not checked again."""
    local, _ = _image()
    old = _old_board(root, local=local, analysis={"palette": ["#112233"], "representativeImages": [OUTSIDE],
                                                  "images": [{"id": "imgout", "url": OUTSIDE,
                                                              "status": "unresolved"}]})
    images = [{key: img[key] for key in ("id", "url", "weight", "notes", "excluded")} for img in old["images"]]

    saved = client.put("/api/moodboards/oldboard0001", headers=PERSON,
                       json={"name": "Renamed", "images": images, "analysis": old["analysis"], "baseVersion": 3})

    assert saved.status_code == 200, saved.text
    assert saved.json()["name"] == "Renamed"
    assert [img["url"] for img in saved.json()["images"]] == [OUTSIDE, local]


def test_restore_from_recently_deleted_keeps_what_was_stored(client, root):
    """A board in Recently deleted comes back as it was: restore isn't a new
    write of its images, so an old board's outside link comes back with it
    (and is still never loaded)."""
    local, _ = _image()
    _old_board(root, local=local)
    assert client.delete("/api/moodboards/oldboard0001", headers=PERSON).status_code == 200

    restored = client.post("/api/trash/moodboard/oldboard0001/restore", headers=PERSON)

    assert restored.status_code == 200, restored.text
    board = client.get("/api/moodboards/oldboard0001").json()
    assert [img["url"] for img in board["images"]] == [OUTSIDE, local]
    assert board["outsideImages"] == ["imgout"]


# ---------------------------------------------------------------- runs and analysis

@pytest.mark.asyncio
async def test_a_run_of_an_old_board_leaves_its_outside_image_out_and_says_so(root):
    from handlers.moodboard import handle_moodboard_node
    from models.events import execution_notes
    from models.graph import GraphNode

    local, _ = _image()
    _old_board(root, local=local, analysis={
        # A saved analysis an agent wrote before the check, naming the link.
        "palette": ["#112233"], "representativeImages": [OUTSIDE, local],
        "providerHints": {"krea": {"representativeImages": [OUTSIDE, local]}}})
    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        result = await handle_moodboard_node(
            GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": "oldboard0001"}), {}, {})
    finally:
        execution_notes.reset(token)

    bundle = result["moodboard"]["value"]
    assert [img["url"] for img in bundle["images"]] == [local]
    assert OUTSIDE not in json.dumps(result)
    assert result["representative_images"]["value"] == [local]
    assert any("outside Nebula" in note and "Old board" in note for note in notes), notes


def test_the_analysis_leaves_an_outside_image_out_and_never_reads_it(root, monkeypatch):
    """Not resolved, so not even a local file behind an outside host's
    /api/outputs path is read (a browser would fetch that host)."""
    from services import moodboard_analysis

    local, _ = _image()
    behind_host = f"https://images.example.com{local}"
    asked: list[str] = []
    real = moodboard_analysis.resolve_moodboard_image_path
    monkeypatch.setattr(moodboard_analysis, "resolve_moodboard_image_path",
                        lambda value: asked.append(value) or real(value))
    board = {"id": "b", "name": "B", "mode": "look", "strength": 0.7, "notes": "", "images": [
        {"id": "i1", "url": behind_host, "weight": 1.0, "notes": "", "excluded": False},
        {"id": "i2", "url": local, "weight": 1.0, "notes": "", "excluded": False}]}

    analysis = moodboard_analysis.analyze_moodboard(board)

    first = analysis["images"][0]
    assert first["status"] == "outside" and first["palette"] == []
    assert analysis["representativeImages"] == [local]
    assert any("#1" in warning and "outside Nebula" in warning for warning in analysis["warnings"])
    assert moodboard_analysis.resolve_moodboard_image_path(behind_host) is None
    assert moodboard_analysis.resolve_moodboard_image_path(local) is not None


def test_the_analyze_route_on_an_old_board_marks_the_outside_image(client, root):
    local, _ = _image()
    _old_board(root, local=local)

    response = client.post("/api/moodboards/oldboard0001/analyze", headers=PERSON)

    assert response.status_code == 200, response.text
    analysis = response.json()["analysis"]
    assert analysis["images"][0]["status"] == "outside"
    assert analysis["representativeImages"] == [local]


def test_commons_import_skips_an_outside_board_image_without_fetching_it(tmp_path, root, monkeypatch):
    from commons import intake, net
    from commons.db import CommonsDB
    from commons.store import CommonsStore

    local, _ = _image()
    _old_board(root, local=local)
    calls: list[str] = []

    async def fake_fetch(url, **kw):
        calls.append(url)
        raise AssertionError("an outside board image was fetched")

    monkeypatch.setattr(net, "safe_fetch", fake_fetch)
    store = CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")
    summary = intake.import_moodboards(store)

    assert calls == []
    assert summary["added"] == 1
    assert [item["url"] for item in summary["skipped"]] == [OUTSIDE]
    assert "outside Nebula" in summary["skipped"][0]["reason"]


# ------------------------------------------------------------------- agents and CLI

def test_an_agents_board_read_marks_an_outside_image(client, root):
    import moodboard_client as boards

    local, _ = _image()
    _old_board(root, local=local)
    view = boards.brief(client.get("/api/moodboards/oldboard0001").json(), layout=True)

    assert view["images"][0]["outside"] is True and "outside" not in view["images"][1]
    assert "outside Nebula" in view["outsideNote"]


def test_cli_show_prints_the_placeholder_for_an_outside_image(client, root, capsys):
    from cli.commands import moodboard as moodboard_cmd

    local, _ = _image()
    _old_board(root, local=local)
    moodboard_cmd._print_board(client.get("/api/moodboards/oldboard0001").json())
    out = capsys.readouterr().out

    line = next(line for line in out.splitlines() if "imgout" in line)
    assert "Image link from outside Nebula" in line


@pytest.mark.parametrize("source", ["data:image/png;base64,iVBORw0KGgo=", "blob:https://example.com/1",
                                    "javascript:alert(1)"])
def test_the_cli_never_hands_a_non_http_link_on(source):
    """`nebula moodboard new/add` (and the MCP tools) take files, folders,
    http(s) links (downloaded and uploaded) and Nebula outputs; anything else
    is refused before anything is read or uploaded."""
    import moodboard_client as boards

    with pytest.raises(boards.MoodboardError, match="only http and https links"):
        boards.expand_sources([source])


def test_agents_are_told_board_images_must_be_nebulas_own():
    """Justin's rule: the agent-facing docs say what the board routes accept."""
    import mcp_server

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    for name in ("moodboard_create", "moodboard_add", "moodboard_get", "moodboard_edit"):
        text = " ".join(tools[name].description.split())
        assert "outside" in text, name
    get = " ".join(tools["moodboard_get"].description.split())
    assert "outsideImages" in get or "`outside`" in get
    root = Path(__file__).resolve().parents[2]
    for doc in (root / "docs" / "MCP-SETUP.md", root / "skills" / "nebula" / "SKILL.md"):
        text = " ".join(doc.read_text(encoding="utf-8").split())
        assert re.search(r"board.{0,80}Nebula's own", text), doc
        assert re.search(r"/api/moodboards.{0,200}refuse", text), doc


# ------------------------------------------------------------- review fixes (Q98)

def _counted(summary: str, count: int) -> bool:
    return summary.startswith(f"{count} reference image(s) analyzed as ")


@pytest.mark.asyncio
async def test_the_summaries_count_only_the_images_a_generator_gets(root):
    """An outside image steers by its settings but no generator gets it, so
    neither the analysis summary nor the run's summary counts it."""
    from handlers.moodboard import handle_moodboard_node
    from models.events import execution_notes
    from models.graph import GraphNode
    from services import moodboard_analysis

    local, _ = _image()
    record = _old_board(root, local=local)

    assert _counted(moodboard_analysis.analyze_moodboard(record)["summary"], 1)
    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        result = await handle_moodboard_node(
            GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": "oldboard0001"}), {}, {})
    finally:
        execution_notes.reset(token)
    bundle = result["moodboard"]["value"]
    assert len(bundle["images"]) == 1
    assert _counted(bundle["analysis"]["summary"], 1), bundle["analysis"]["summary"]


def test_a_saved_summary_that_counted_an_outside_image_reads_with_the_right_count(client, root):
    from services import moodboard_analysis

    local, _ = _image()
    record = _old_board(root, local=local)
    analysis = moodboard_analysis.analyze_moodboard(record)
    analysis["summary"] = re.sub(r"^\d+ reference", "2 reference", analysis["summary"])
    _old_board(root, local=local, analysis=analysis)

    summary = client.get("/api/moodboards/oldboard0001").json()["analysis"]["summary"]

    assert _counted(summary, 1), summary


@pytest.mark.asyncio
async def test_a_board_whose_steering_images_are_all_outside_says_so_not_set_aside(root):
    from handlers.moodboard import handle_moodboard_node
    from models.events import execution_notes
    from models.graph import GraphNode
    from services import moodboard_analysis

    local, _ = _image()
    record = _old_board(root, local=local)
    record["images"][1]["excluded"] = True  # the upload is set aside; only the outside link steers
    folder = root / "_global"
    (folder / "oldboard0001.json").write_text(json.dumps(record), encoding="utf-8")

    summary = moodboard_analysis.analyze_moodboard(record)["summary"]
    assert summary != moodboard_analysis.NONE_STEER_SUMMARY
    assert "outside Nebula" in summary, summary
    token = execution_notes.set([])
    try:
        result = await handle_moodboard_node(
            GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": "oldboard0001"}), {}, {})
    finally:
        execution_notes.reset(token)
    assert result["moodboard"]["value"]["analysis"]["summary"] == summary


def test_undoing_an_outside_images_removal_names_the_image(client, root):
    """Contract 07 §1.19: the skip reads "#1 is an image link from outside
    Nebula, left as is", the number the image had, not "An image"."""
    local, _ = _image()
    _old_board(root, local=local)
    removed = client.post("/api/moodboards/oldboard0001/edits",
                          json={"ops": [{"op": "remove", "images": [1]}]}, headers=PERSON)

    undone = client.post("/api/moodboards/oldboard0001/edits", json={"ops": removed.json()["undo"]["ops"]},
                         headers=PERSON)

    skipped = undone.json()["applied"][0]["skipped"]
    assert [item["message"] for item in skipped] == ["#1 is an image link from outside Nebula, left as is"]
    assert skipped[0]["number"] == 1


def test_agents_are_told_to_ask_the_person_before_fetching_an_old_outside_link():
    """An old board's outside link may have been planted by anyone who could
    reach the routes: fetching it from the person's machine is the leak Q98
    closes. Agent guidance never tells an agent to fetch it on its own."""
    import mcp_server
    import moodboard_client as boards

    get = " ".join(next(tool for tool in asyncio.run(mcp_server.mcp.list_tools())
                        if tool.name == "moodboard_get").description.split())
    skill = " ".join((Path(__file__).resolve().parents[2] / "skills" / "nebula" / "SKILL.md")
                     .read_text(encoding="utf-8").split())
    passage = skill[skill.index("link from outside Nebula (not loaded)"):][:500]
    for name, text in (("OUTSIDE_NOTE", boards.OUTSIDE_NOTE), ("OUTSIDE_NOTE_CLI", boards.OUTSIDE_NOTE_CLI),
                       ("moodboard_get", get[get.index("outsideNote"):][:300]), ("SKILL.md", passage)):
        assert re.search(r"ask the person", text, re.I), name


def test_the_contract_lists_the_outside_analysis_status():
    contract = (Path(__file__).resolve().parents[2] / "docs" / "contracts" / "07-studios-and-resources.md")
    text = contract.read_text(encoding="utf-8")
    line = next(line for line in text.splitlines() if line.startswith("`analysis.images[]` lists each image"))
    assert "`outside`" in line, line
