"""One order of precedence for what a board sends (design-canvas gap 18).

Justin's answers (2026-10-19):

- P1: by default Nebula leaves a measured colour that clashes with the
  Direction or Avoid list out of the brief, lists it with the reason, and Keep
  anyway puts it back. Per board (``clashMode``) he can pick flag only, no
  measured colours once there's a Direction, or keep everything.
- P2: the colour-word check runs now; a second check can add findings later,
  each recording which check found it (``foundBy``).
- P3: a "Left out of the brief" list with reasons and Keep anyway.
- P4: board notes (and image notes, and the cues lifted from them) never go to
  generators by default; a board or a node opts in. Only the person may opt in.

The board below is the Good Machines board 4df26f93ff63 as GM set it on
2026-10-19: its measured colours and shares, Direction, Avoid and pin. Its
notes text and image links are left out; the notes here are made up.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from services import moodboard_brief
from services.moodboard_brief import CLASH_MODES, colour_check, compose
from services.moodboard_store import MoodboardStore
from services.output import OUTPUT_ROOT

GM_DIRECTION = (
    "Real 19th-century landscape oil (Hudson River School, Luminism, Tonalism) in a silver tonalist palette: "
    "cool pearl-grey sky, pale blue-grey water, sage and grey-green land, soft mist. Fine detail confined to "
    "about a third of the canvas; the rest is quiet sky, mist or water. Flowers in cool jewel tones: cornflower "
    "blue, violet, lilac and white."
)
GM_AVOID = ["busy all-over detail", "warm yellow varnish cast", "red, orange or pink flowers",
            "digital or illustration look", "people, buildings, text"]
PALETTE = [("#f7f8f7", 0.2037), ("#111010", 0.136), ("#2a2b28", 0.0478), ("#dce0e2", 0.0344),
           ("#16121f", 0.0245), ("#1c70f2", 0.0232), ("#98acac", 0.0208), ("#e7e2d4", 0.0197)]
ACCENTS = [("#a6392d", 0.0015), ("#ef8172", 0.0019), ("#9b492b", 0.0006), ("#c8b03e", 0.0005)]
BRICK, SALMON, RUST, OCHRE, BLUE, PIN = "#a6392d", "#ef8172", "#9b492b", "#c8b03e", "#1c70f2", "#e8593c"
NOTES = "Liquid glass panels over soft nature, with one orange accent and quiet type."
MEASURED_KEYWORDS = ["palette-led", "style consistency", "visual language"]
NOTE_KEYWORDS = ["liquid", "glass", "panels", "over", "soft", "nature"]


def gm_analysis(palette=PALETTE, accents=ACCENTS) -> dict:
    return {
        "version": 4, "sourceHash": "fixture", "mode": "look", "strength": 0.7,
        "summary": "33 reference image(s) analyzed as look. Palette: x. Notes emphasize: liquid glass",
        "styleBrief": "analyzer brief", "negativePrompt": "blurry, low-detail artifacts",
        "keywords": [*MEASURED_KEYWORDS, *NOTE_KEYWORDS],
        "palette": [hex_value for hex_value, _ in palette], "accents": [hex_value for hex_value, _ in accents],
        "colors": ([{"hex": h, "share": s, "role": "dominant", "images": 1} for h, s in palette]
                   + [{"hex": h, "share": s, "role": "accent", "images": 1} for h, s in accents]),
        "materials": [], "textures": [], "motifs": [], "subjectBias": [],
    }


def gm_board(**fields) -> dict:
    board = {
        "id": "gmtestboard1", "name": "GM test board", "mode": "look", "strength": 0.7, "notes": NOTES,
        "images": [], "direction": GM_DIRECTION, "avoid": list(GM_AVOID),
        "pinnedColors": {"include": [PIN], "exclude": []}, "briefOverride": None, "briefVersion": 1,
        "analysis": gm_analysis(),
    }
    board.update(fields)
    return board


def hexes(items: list[dict]) -> list[str]:
    return [item["hex"] for item in items]


# -- P1 a): the default --------------------------------------------------------

def test_the_good_machines_board_leaves_out_its_clashing_accents():
    brief = compose(gm_board())
    assert brief["clashMode"] == "leave-out"
    assert sorted(hexes(brief["leftOut"])) == sorted([BRICK, SALMON, RUST, OCHRE])
    by_hex = {item["hex"]: item for item in brief["leftOut"]}
    assert by_hex[BRICK]["reason"].startswith("Avoid: red, orange or pink flowers")
    assert by_hex[OCHRE]["reason"].startswith("Direction: silver tonalist palette")
    assert any("warm yellow varnish cast" in reason for reason in by_hex[OCHRE]["reasons"])
    assert all(item["role"] == "accent" and item["level"] == "conflict" and item["why"] == "check"
               and item["foundBy"] == ["words"] for item in brief["leftOut"])
    # The blue stays: the Direction allows blue for the flowers. It may clash.
    assert hexes(brief["mayClash"]) == [BLUE] and brief["mayClash"][0]["level"] == "warning"
    assert "cornflower" in brief["mayClash"][0]["reason"].lower()
    # The pin goes, against Avoid, and is flagged.
    assert hexes(brief["pinnedClashes"]) == [PIN]
    assert brief["pinnedClashes"][0]["reason"].startswith("Avoid: red, orange or pink flowers")
    text = brief["styleBrief"]
    assert "Make sure these colors appear: #e8593c." in text
    for hex_value in hexes(brief["leftOut"]):
        assert hex_value not in text.lower()
    assert "Accent colors" not in text
    assert brief["palette"] == [hex_value for hex_value, _ in PALETTE]
    assert brief["accents"] == []
    assert brief["kept"] == []


def test_keep_anyway_puts_a_colour_back_without_pinning_it():
    brief = compose(gm_board(colorChoices={"keep": [BRICK], "leaveOut": []}))
    assert brief["accents"] == [BRICK]
    assert hexes(brief["kept"]) == [BRICK] and BRICK not in hexes(brief["leftOut"])
    assert "Accent colors, used sparingly: #a6392d." in brief["styleBrief"]
    assert "Make sure these colors appear: #e8593c." in brief["styleBrief"]


def test_a_choice_survives_a_reanalysis_that_shifts_the_hex():
    shifted = [("#a83a2f" if hex_value == BRICK else hex_value, share) for hex_value, share in ACCENTS]
    brief = compose(gm_board(analysis=gm_analysis(accents=shifted), colorChoices={"keep": [BRICK], "leaveOut": []}))
    assert brief["accents"] == ["#a83a2f"] and hexes(brief["kept"]) == ["#a83a2f"]
    # A choice with no colour near it stays stored and does nothing.
    stray = compose(gm_board(colorChoices={"keep": ["#00ff00"], "leaveOut": ["#123456"]}))
    assert sorted(hexes(stray["leftOut"])) == sorted([BRICK, SALMON, RUST, OCHRE])


def test_leave_out_takes_a_warning_out():
    brief = compose(gm_board(colorChoices={"keep": [], "leaveOut": [BLUE]}))
    assert BLUE not in brief["palette"] and BLUE not in brief["styleBrief"]
    assert {item["hex"]: item["why"] for item in brief["leftOut"]}[BLUE] == "choice"
    assert brief["mayClash"] == []


def test_a_warm_direction_leaves_avoided_reds_out():
    brief = compose(gm_board(direction="Warm evening light.", avoid=["red, orange or pink flowers"],
                             pinnedColors={"include": [], "exclude": []}))
    assert sorted(hexes(brief["leftOut"])) == sorted([BRICK, SALMON, RUST])
    for hex_value in (BRICK, SALMON, RUST):
        assert hex_value not in brief["styleBrief"]


def test_no_people_keeps_the_red_flowers_and_blue_sky_the_direction_asks_for():
    brief = compose(gm_board(direction="No people, red flowers and a blue sky.", avoid=[],
                             pinnedColors={"include": [], "exclude": []}))
    assert brief["leftOut"] == [] and brief["mayClash"] == []
    assert BRICK in brief["styleBrief"] and SALMON in brief["styleBrief"] and BLUE in brief["styleBrief"]


# -- the advanced options --------------------------------------------------------

def test_every_clash_mode_is_known():
    assert CLASH_MODES == ("leave-out", "flag", "no-measured", "keep-all")


def test_flag_leaves_nothing_out_until_the_person_does():
    brief = compose(gm_board(clashMode="flag"))
    assert brief["leftOut"] == []
    assert sorted(hexes(brief["mayClash"])) == sorted([BRICK, SALMON, RUST, OCHRE, BLUE])
    assert {item["hex"]: item["level"] for item in brief["mayClash"]}[BRICK] == "conflict"
    assert brief["accents"] == [BRICK, SALMON, RUST, OCHRE]
    chosen = compose(gm_board(clashMode="flag", colorChoices={"keep": [], "leaveOut": [BRICK]}))
    assert hexes(chosen["leftOut"]) == [BRICK] and chosen["leftOut"][0]["why"] == "choice"
    assert BRICK not in chosen["styleBrief"]


def test_no_measured_sends_no_measured_colour_once_there_is_a_direction():
    brief = compose(gm_board(clashMode="no-measured"))
    assert brief["palette"] == [] and brief["accents"] == []
    assert len(brief["leftOut"]) == len(PALETTE) + len(ACCENTS)
    assert all(item["reason"] == "Measured colors are off for this board" and item["why"] == "mode"
               for item in brief["leftOut"])
    assert "Color palette" not in brief["styleBrief"]
    assert "Make sure these colors appear: #e8593c." in brief["styleBrief"]
    # A colour that also clashes keeps its clash: the person sees it before
    # pressing Keep anyway.
    brick = next(item for item in brief["leftOut"] if item["hex"] == BRICK)
    assert brick["level"] == "conflict"
    assert brick["reasons"][0] == "Measured colors are off for this board"
    assert "Avoid: red, orange or pink flowers" in brick["reasons"][1:]
    kept = compose(gm_board(clashMode="no-measured", colorChoices={"keep": ["#f7f8f7"], "leaveOut": []}))
    assert kept["palette"] == ["#f7f8f7"] and hexes(kept["kept"]) == ["#f7f8f7"]
    # Without a Direction it behaves as the default.
    plain = compose(gm_board(clashMode="no-measured", direction=""))
    assert plain["palette"] == [hex_value for hex_value, _ in PALETTE]
    assert sorted(hexes(plain["leftOut"])) == sorted([BRICK, SALMON, RUST])
    assert OCHRE in hexes(plain["mayClash"])  # only the cast warning, without the palette rule


def test_keep_all_sends_everything_but_still_runs_the_check():
    board = gm_board(clashMode="keep-all", colorChoices={"keep": [], "leaveOut": [BLUE]})
    brief = compose(board)
    assert brief["leftOut"] == brief["mayClash"] == brief["pinnedClashes"] == brief["kept"] == []
    assert brief["palette"] == [hex_value for hex_value, _ in PALETTE]
    assert brief["accents"] == [hex_value for hex_value, _ in ACCENTS]
    assert colour_check(board)["findings"]


# -- P4: notes ----------------------------------------------------------------------

@pytest.mark.parametrize("direction", [GM_DIRECTION, ""])
def test_notes_never_reach_generators_by_default(direction):
    brief = compose(gm_board(direction=direction))
    assert brief["notesSent"] is False
    assert "Notes:" not in brief["styleBrief"] and "liquid glass" not in brief["styleBrief"].lower()
    assert "Visual cues: palette-led, style consistency, visual language." in brief["styleBrief"]


def test_notes_go_when_the_board_or_the_node_opts_in():
    on = gm_board(sendNotes=True)
    assert compose(on)["notesSent"] is True
    assert f"Notes: {NOTES}" in compose(on)["styleBrief"]
    assert "liquid" in compose(on)["styleBrief"]                       # the cues lifted from the notes too
    assert compose(gm_board(), send_notes=True)["notesSent"] is True   # node yes over board off
    assert "Notes:" in compose(gm_board(), send_notes=True)["styleBrief"]
    assert compose(on, send_notes=False)["notesSent"] is False         # node no over board on
    assert "Notes:" not in compose(on, send_notes=False)["styleBrief"]


# -- the hand-written brief and its basis ------------------------------------------

def _basis_on_main(board: dict) -> str:
    """brief_basis as main (12257250) computed it."""
    from services.moodboard_analysis import source_hash

    direction, avoid, pinned = moodboard_brief.board_fields(board)
    payload = {"source": source_hash({**board, "images": board.get("images") or []}), "direction": direction,
               "avoid": avoid, "pinned": pinned}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("utf-8")).hexdigest()[:16]


def test_an_override_written_on_main_is_not_marked_stale_by_the_upgrade():
    board = gm_board()
    board["briefOverride"] = {"text": "Mine.", "basis": _basis_on_main(board), "updatedAt": "x", "by": "person"}
    brief = compose(board)
    assert brief["override"] == {"active": True, "stale": False}
    assert brief["styleBrief"] == "Mine."


@pytest.mark.parametrize("change", [
    {"clashMode": "flag"}, {"colorChoices": {"keep": [BRICK], "leaveOut": []}}, {"sendNotes": True},
])
def test_changing_a_new_field_marks_an_override_stale(change):
    board = gm_board()
    board["briefOverride"] = {"text": "Mine.", "basis": _basis_on_main(board), "updatedAt": "x", "by": "person"}
    assert compose({**board, **change})["override"]["stale"] is True


# -- the saved check and room for a second one ----------------------------------------

def test_a_saved_check_from_another_checker_counts_at_its_basis_only():
    board = gm_board()
    saved = colour_check(board)
    assert saved["version"] == 1 and saved["checks"]["words"]["version"] >= 1
    reader = {"hex": "#98acac", "role": "palette", "share": 0.0208, "level": "conflict", "source": "direction",
              "clause": "soft mist", "rule": "global", "reason": "Direction: soft mist", "foundBy": "reader"}
    board["colorCheck"] = {**saved, "checks": {**saved["checks"], "reader": {"version": 1}},
                           "findings": [*saved["findings"], reader]}
    brief = compose(board)
    item = {i["hex"]: i for i in brief["leftOut"]}["#98acac"]
    assert item["foundBy"] == ["reader"] and item["reason"] == "Direction: soft mist"
    # The board moved: the words check runs again in memory, the reader's finding waits.
    moved = compose({**board, "avoid": [*GM_AVOID, "neon"]})
    assert "#98acac" not in hexes(moved["leftOut"])
    assert sorted(hexes(moved["leftOut"])) == sorted([BRICK, SALMON, RUST, OCHRE])


def test_reading_an_old_board_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    folder = tmp_path / "moodboards" / "_global"
    folder.mkdir(parents=True)
    path = folder / "gmtestboard1.json"
    path.write_text(json.dumps(gm_board()), encoding="utf-8")
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    store = MoodboardStore()
    board = store.get("gmtestboard1")
    store.list("global")
    assert moodboard_brief.with_brief(board)["brief"]["leftOut"]
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    assert "colorCheck" not in json.loads(path.read_text())


def test_startup_saves_the_check_on_boards_saved_before_it(tmp_path, monkeypatch):
    """An old board gets its check once at startup, so generations and reads
    stop running it; running again writes nothing."""
    import asyncio

    import main as main_module
    from services import moodboard_colour_words

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    folder = tmp_path / "moodboards" / "_global"
    folder.mkdir(parents=True)
    path = folder / "gmtestboard1.json"
    path.write_text(json.dumps(gm_board()), encoding="utf-8")
    trash = tmp_path / "moodboards" / ".trash"
    trash.mkdir()
    (trash / "gmtestboard2.json").write_text(json.dumps(gm_board(id="gmtestboard2")), encoding="utf-8")

    asyncio.run(main_module._moodboard_brief_fields_startup())
    saved = json.loads(path.read_text())
    assert saved["colorCheck"]["basis"] == moodboard_brief.colour_check_basis(saved)
    assert {f["hex"] for f in saved["colorCheck"]["findings"]} >= {BRICK, SALMON, RUST}
    assert "colorCheck" in json.loads((trash / "gmtestboard2.json").read_text())
    assert {k: v for k, v in saved.items() if k != "colorCheck"} == gm_board()

    calls = []
    real = moodboard_colour_words.check
    monkeypatch.setattr(moodboard_colour_words, "check", lambda *a, **k: calls.append(1) or real(*a, **k))
    for _ in range(3):
        compose(MoodboardStore().get("gmtestboard1"))
    assert calls == []
    before = path.stat().st_mtime_ns
    assert moodboard_brief.save_colour_checks(tmp_path / "moodboards")["saved"] == []
    assert path.stat().st_mtime_ns == before


# -- the store and routes -------------------------------------------------------------

AGENT = {"X-Nebula-Agent": "Claude Code"}


def _url(color) -> str:
    path = OUTPUT_ROOT / "moodboard-precedence-tests" / f"{uuid4().hex[:10]}.png"
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


def _stored(board_id: str) -> dict:
    return MoodboardStore().get(board_id)


def _gm_via_api(client, **extra) -> dict:
    body = {"name": "GM", "images": [], "direction": GM_DIRECTION, "avoid": GM_AVOID,
            "pinnedColors": {"include": [PIN], "exclude": []}, "analysis": gm_analysis(), **extra}
    response = client.post("/api/moodboards", json=body)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("body", [
    {"clashMode": "nope"},
    {"colorChoices": {"keep": ["#zz"], "leaveOut": []}},
    {"colorChoices": {"keep": [BRICK], "leaveOut": ["#A6392D"]}},
    {"colorChoices": {"keep": [f"#0000{i:02x}" for i in range(25)], "leaveOut": []}},
    {"colorChoices": {"keep": [], "leaveOut": [], "other": []}},
    {"colorChoices": {"keep": ["#0000ff"]}, "pinnedColors": {"include": [], "exclude": ["#0000FF"]}},
    {"sendNotes": "yes"},
])
def test_bad_new_fields_are_refused(client, body):
    board = _gm_via_api(client)
    response = client.put(f"/api/moodboards/{board['id']}", json=body)
    assert response.status_code == 422, response.text


def test_new_fields_default_and_round_trip(client):
    board = _gm_via_api(client)
    assert board["clashMode"] == "leave-out" and board["sendNotes"] is False
    assert board["colorChoices"] == {"keep": [], "leaveOut": []}
    updated = client.put(f"/api/moodboards/{board['id']}", json={
        "clashMode": "flag", "colorChoices": {"keep": ["#A6392D"], "leaveOut": [BLUE]}}).json()
    assert updated["clashMode"] == "flag"
    assert updated["colorChoices"] == {"keep": [BRICK], "leaveOut": [BLUE]}


def test_the_check_is_saved_on_every_change_that_moves_it_and_a_sent_one_is_ignored(client):
    board = _gm_via_api(client)
    saved = _stored(board["id"])["colorCheck"]
    assert saved["basis"] and {f["hex"] for f in saved["findings"]} >= {BRICK, SALMON, RUST, OCHRE, BLUE, PIN}
    assert board["colorCheck"] == saved
    cleared = client.put(f"/api/moodboards/{board['id']}", json={"direction": ""}).json()
    after = _stored(board["id"])["colorCheck"]
    assert after["basis"] != saved["basis"] and BLUE not in {f["hex"] for f in after["findings"]}
    assert cleared["colorCheck"] == after
    forged = {"version": 1, "basis": after["basis"], "checks": {}, "findings": []}
    client.put(f"/api/moodboards/{board['id']}", json={"colorCheck": forged, "name": "Renamed"})
    assert _stored(board["id"])["colorCheck"] == after


def test_analyze_refreshes_the_saved_check(client):
    created = client.post("/api/moodboards", json={"name": "Orange", "images": [{"url": _url((240, 110, 30))}],
                                                   "avoid": ["orange flowers"]}).json()
    assert created["colorCheck"]["findings"] == []
    analyzed = client.post(f"/api/moodboards/{created['id']}/analyze").json()
    findings = _stored(created["id"])["colorCheck"]["findings"]
    assert findings and findings[0]["clause"] == "orange flowers"
    assert analyzed["brief"]["palette"] == [] and hexes(analyzed["brief"]["leftOut"])


def test_only_the_person_may_send_notes_and_anyone_may_stop_them(client, person):
    board = _gm_via_api(client)
    for headers, code in ((AGENT, "agent_refused"), ({}, "person_required")):
        refused = client.put(f"/api/moodboards/{board['id']}", json={"sendNotes": True, "direction": "x"},
                             headers=headers)
        assert refused.status_code == 403, refused.text
        assert refused.json()["code"] == code and "notes" in refused.json()["detail"].lower()
    assert _stored(board["id"])["sendNotes"] is False and _stored(board["id"])["direction"] == GM_DIRECTION
    assert client.put(f"/api/moodboards/{board['id']}", json={"sendNotes": True},
                      headers=person.headers).status_code == 200
    # Sent again as it is (Studio saves the whole board), it isn't turning anything on.
    assert client.put(f"/api/moodboards/{board['id']}", json={"sendNotes": True, "name": "Same"},
                      headers=AGENT).status_code == 200
    assert client.put(f"/api/moodboards/{board['id']}", json={"sendNotes": False},
                      headers=AGENT).status_code == 200
    created = client.post("/api/moodboards", json={"name": "N", "images": [], "sendNotes": True}, headers=AGENT)
    assert created.status_code == 403


def test_a_node_sending_notes_is_the_persons_call(monkeypatch):
    import main

    monkeypatch.setattr(main, "_is_person_request", lambda: False)

    def refusal(before, after):
        try:
            main._refuse_agent_billing_change([("n1", "nebula-moodboard", before, after)])
        except HTTPException as exc:
            assert exc.status_code == 403
            return str(exc.detail)
        return None

    detail = refusal({}, {"send_notes": "yes"})
    assert detail and "send_notes" in detail and "propose_change" in detail
    assert refusal(None, {"send_notes": "yes"})              # a new node
    assert refusal({"send_notes": "no"}, {"send_notes": "board"})  # back to the board's "on"
    assert refusal(None, {"send_notes": "board"}) is None
    assert refusal({}, {"send_notes": "no"}) is None
    assert refusal({"send_notes": "yes"}, {"send_notes": "board"}) is None
    # A "yes" is for the board it was set on: pointing it at another board
    # would send that board's notes.
    moved = refusal({"moodboard": "aaaaaaaaaaaa", "send_notes": "yes"},
                    {"moodboard": "bbbbbbbbbbbb", "send_notes": "yes"})
    assert moved and "another board" in moved
    assert refusal({"moodboard": "aaaaaaaaaaaa", "send_notes": "yes"},
                   {"moodboard": "aaaaaaaaaaaa", "send_notes": "yes"}) is None   # unchanged
    assert refusal({"moodboard": "aaaaaaaaaaaa", "send_notes": "yes"},
                   {"moodboard": "bbbbbbbbbbbb", "send_notes": "board"}) is None  # closed in the same edit
    assert refusal({"moodboard": "aaaaaaaaaaaa", "send_notes": "board"},
                   {"moodboard": "bbbbbbbbbbbb", "send_notes": "board"}) is None  # follows board B's own switch
    monkeypatch.setattr(main, "_is_person_request", lambda: True)
    assert refusal({}, {"send_notes": "yes"}) is None


def test_the_moodboard_node_has_the_send_notes_param():
    data = json.loads((Path(__file__).resolve().parent.parent / "data" / "node_definitions.json").read_text())
    nodes = data if isinstance(data, dict) else {n["id"]: n for n in data}
    param = next(p for p in nodes["nebula-moodboard"]["params"] if p["key"] == "send_notes")
    assert param["type"] == "enum" and param["default"] == "board"
    assert [o["value"] for o in param["options"]] == ["board", "yes", "no"]
    assert param["label"] == "Board notes to generators"


# -- CLI and MCP ---------------------------------------------------------------------

@pytest.fixture
def app(tmp_path, monkeypatch):
    import main as main_module
    import mcp_server
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
    cli = NebulaClient("http://testserver")
    cli._client = http
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
    return cli


def _cli(client, argv, capsys) -> str:
    from cli.__main__ import build_parser
    from cli.commands import moodboard as moodboard_cmd

    moodboard_cmd.run(client, build_parser().parse_args(argv))
    return capsys.readouterr().out


def _red_board(app, tmp_path) -> dict:
    import moodboard_client as boards

    path = tmp_path / "red.png"
    Image.new("RGB", (24, 16), (232, 89, 60)).save(path)
    board, _ = boards.create_board(app.api, "Red board", [str(path)], notes="warm paper and glass")
    boards.analyze_board(app.api, board["id"])
    boards.update_board(app.api, board["id"], avoid_add=["red, orange or pink flowers"])
    return boards.get_board(app.api, board["id"])


def test_cli_show_lists_what_was_left_out_and_how_to_keep_it(app, tmp_path, capsys):
    board = _red_board(app, tmp_path)
    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert "Left out of the brief:" in shown
    assert "#e8593c" in shown and "Avoid: red, orange or pink flowers" in shown
    assert f'nebula moodboard set {board["id"]} --keep-anyway "#e8593c"' in shown
    assert "Notes: not sent to generators" in shown
    data = json.loads(_cli(app, ["moodboard", "show", board["id"], "--json"], capsys))
    assert data["clashMode"] == "leave-out" and data["sendNotes"] is False
    assert data["colorChoices"] == {"keep": [], "leaveOut": []}
    assert data["colorCheck"]["findings"] and hexes(data["brief"]["leftOut"]) == ["#e8593c"]
    assert data["brief"]["notesSent"] is False


def test_cli_show_gives_every_reason_when_measured_colours_are_off(app, tmp_path, capsys):
    import moodboard_client as boards

    board = _red_board(app, tmp_path)
    boards.update_board(app.api, board["id"], direction="Quiet harbour at dawn.", clash_mode="no-measured")
    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert ("#e8593c (palette): Measured colors are off for this board; "
            "Avoid: red, orange or pink flowers") in shown


def test_cli_set_flags_and_restore(app, tmp_path, capsys):
    import moodboard_client as boards

    board = _red_board(app, tmp_path)
    out = json.loads(_cli(app, ["moodboard", "set", board["id"], "--keep-anyway", "#E8593C", "--json"], capsys))
    assert out["colorChoices"] == {"keep": ["#e8593c"], "leaveOut": []}
    assert out["brief"]["palette"] == ["#e8593c"] and hexes(out["brief"]["kept"]) == ["#e8593c"]
    assert out["previous"]["color_choices"] == {"keep": [], "leaveOut": []}
    # A change that doesn't touch notes doesn't carry send_notes: undoing it
    # never asks to send notes the person has since turned on.
    assert "send_notes" not in out["previous"]
    flagged = json.loads(_cli(app, ["moodboard", "set", board["id"], "--clash-mode", "flag", "--json"], capsys))
    assert "send_notes" not in flagged["previous"] and flagged["previous"]["clash_mode"] == "leave-out"
    _cli(app, ["moodboard", "set", board["id"], "--clash-mode", "leave-out"], capsys)
    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert "Kept anyway" in shown and "--reset-color" in shown

    _cli(app, ["moodboard", "set", board["id"], "--reset-color", "#e8593c", "--clash-mode", "flag"], capsys)
    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert "May clash (still sent):" in shown and "--leave-out" in shown
    assert "Clash check: flag" in shown
    out = json.loads(_cli(app, ["moodboard", "set", board["id"], "--leave-out-flagged", "--json"], capsys))
    assert out["colorChoices"]["leaveOut"] == ["#e8593c"] and out["brief"]["palette"] == []
    out = json.loads(_cli(app, ["moodboard", "set", board["id"], "--clash-mode", "keep-all", "--leave-out",
                                "#000000", "--no-send-notes", "--json"], capsys))
    previous = out["previous"]
    assert previous["clash_mode"] == "flag" and previous["send_notes"] is False
    path = tmp_path / "previous.json"
    path.write_text(json.dumps(out), encoding="utf-8")
    _cli(app, ["moodboard", "set", board["id"], "--restore", str(path)], capsys)
    restored = boards.get_board(app.api, board["id"])
    assert restored["clashMode"] == "flag" and restored["colorChoices"] == {"keep": [], "leaveOut": ["#e8593c"]}


def test_cli_send_notes_is_refused_for_an_agent(app, tmp_path, capsys):
    board = _red_board(app, tmp_path)
    with pytest.raises(SystemExit):
        _cli(app, ["moodboard", "set", board["id"], "--send-notes"], capsys)
    err = capsys.readouterr().err
    assert "notes" in err.lower() and "person" in err.lower()


def test_mcp_update_takes_the_new_arguments(app, tmp_path):
    import mcp_server

    board = _red_board(app, tmp_path)
    kept = mcp_server.moodboard_update(board["id"], keep_anyway=["#e8593c"], clash_mode="flag", send_notes=False)
    assert kept["colorChoices"]["keep"] == ["#e8593c"] and kept["clashMode"] == "flag"
    assert kept["brief"]["palette"] == ["#e8593c"]
    reset = mcp_server.moodboard_update(board["id"], reset_colors=["#e8593c"], leave_out=["#e8593c"])
    assert reset["colorChoices"] == {"keep": [], "leaveOut": ["#e8593c"]}
    with pytest.raises(RuntimeError, match="(?i)notes"):
        mcp_server.moodboard_update(board["id"], send_notes=True)
    got = mcp_server.moodboard_get(board["id"])
    assert "colorCheck" in got and "leftOut" in got["brief"]
    assert "leftOut" in (mcp_server.moodboard_get.__doc__ or "")
