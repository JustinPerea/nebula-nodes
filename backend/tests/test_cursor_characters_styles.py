"""The agent cursor on Characters and Styles (the surfaces `character` and `style`).

A cursor can point at a Character (and one of its reference views, by position)
and at a Style, as it can at a moodboard: the target is an anchor, never a
screen position. These tests pin what ``parse_surface_target`` takes and refuses,
the names a read-back is written from, how the route, MCP and CLI send it, how a
rename, a delete and a shrinking view list keep the cursors true, what a Style
write does to the writer's cursor, and the words a new Style has everywhere.
"""
from __future__ import annotations

import asyncio
import io
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import mcp_server
from nebula_api import NebulaAPI
from services.agent_presence import AgentPresence, PresenceError, parse_surface_target, parse_target
from services.cursor_actions import (
    CHARACTER_LABELS, CHARACTER_PARTS, SURFACE_TABLE, SURFACES, STYLE_PARTS, surface_clash_refusal,
)
from services.output import OUTPUT_ROOT
from services.saved_graph_upgrades import PARAMS_VERSION

AGENT = {"X-Nebula-Agent": "Claude Code"}
LANE_A = {**AGENT, "X-Nebula-Agent-Session": "lane-a"}
LANE_B = {**AGENT, "X-Nebula-Agent-Session": "lane-b"}

CHARACTERS = [
    {"id": "c1", "name": "Mara", "referenceViews": ["/a", "/b", "/c", "/d"]},
    {"id": "c2", "name": "Odd", "referenceViews": []},
    {"id": "c3", "name": "Twin", "referenceViews": ["/a", "/b", "/c"]},
    {"id": "c4", "name": "Twin", "referenceViews": ["/a", "/b", "/c"]},
]
STYLES = [
    {"id": "s1", "name": "Dusk grain"},
    {"id": "s2", "name": "Twin"},
    {"id": "s3", "name": "Twin"},
]


def _character(raw):
    return parse_surface_target({"surface": "character", **raw}, None, characters=CHARACTERS)


def _style(raw):
    return parse_surface_target({"surface": "style", **raw}, None, styles=STYLES)


# -- the table ---------------------------------------------------------------------------------

def test_the_table_has_one_row_per_surface():
    assert SURFACES == ("moodboard", "character", "style") == tuple(SURFACE_TABLE)
    assert SURFACE_TABLE["character"].parts == CHARACTER_PARTS == ("name", "subject-type", "views", "traits", "seed")
    assert SURFACE_TABLE["style"].parts == STYLE_PARTS
    assert SURFACE_TABLE["style"].sub_key is None


def test_the_character_part_labels_are_the_studios():
    assert CHARACTER_LABELS == {"name": "Name", "subject-type": "Subject type", "views": "Reference views",
                                "traits": "Frozen trait string", "seed": "Seed"}


def test_each_character_part_label_is_a_visible_label_of_the_definition_panel():
    """The pin GM asked for: the label a part goes by is the text the panel shows."""
    panel = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "components" / "character-studio"
             / "CharacterDefinitionPanel.tsx").read_text(encoding="utf-8")
    shown = re.findall(r'className="character-def__label">\s*([^<{]+?)\s*(?:\(|\{|<)', panel)
    for part, label in CHARACTER_LABELS.items():
        assert any(text == label for text in shown), (part, label, shown)


# -- parse: a character --------------------------------------------------------------------------

def test_a_character_by_id_by_name_and_by_name_with_folded_whitespace():
    target = {"surface": "character", "itemId": "c1"}
    assert _character({"character": "c1"}) == (target, {"character": "Mara"})
    assert _character({"character": "Mara"})[0] == target
    assert _character({"character": "  Mara "})[0] == target


@pytest.mark.parametrize("view", [2, "2", "#2", " #2 "])
def test_a_view_by_number(view):
    assert _character({"character": "c1", "view": view}) == (
        {"surface": "character", "itemId": "c1/2"}, {"character": "Mara", "view": 2})


def test_the_cover_is_view_one_and_the_last_view_is_in_range():
    assert _character({"character": "c1", "view": 1})[0]["itemId"] == "c1/1"
    assert _character({"character": "c1", "view": 4})[0]["itemId"] == "c1/4"


@pytest.mark.parametrize("part", CHARACTER_PARTS)
def test_a_character_part_has_the_studios_label(part):
    target, names = _character({"character": "c1", "part": part})
    assert target == {"surface": "character", "itemId": "c1", "part": part}
    assert names == {"character": "Mara", "part": CHARACTER_LABELS[part]}


def test_consistency_is_dropped_and_the_target_is_the_character():
    assert _character({"character": "c1", "part": "consistency"}) == (
        {"surface": "character", "itemId": "c1"}, {"character": "Mara"})


@pytest.mark.parametrize("raw, said", [
    ({"character": "Nope"}, "No character “Nope” here. The characters here: “Mara”, “Odd”, “Twin”, “Twin”."),
    ({"character": "Twin"}, "“Twin” names 2 characters. Use an id: c3, c4."),
    ({}, "A character target needs `character`: a character's id or its exact name."),
    ({"character": 4}, "A character target needs `character`: a character's id or its exact name."),
    ({"character": "c1", "view": 0}, "Character “Mara” has no view “0”. Use its number (1-4)."),
    ({"character": "c1", "view": 5}, "Character “Mara” has no view “5”. Use its number (1-4)."),
    ({"character": "c1", "view": "#5"}, "Character “Mara” has no view “#5”. Use its number (1-4)."),
    ({"character": "c1", "view": -1}, "Character “Mara” has no view “-1”. Use its number (1-4)."),
    ({"character": "c1", "view": "two"}, "Character “Mara” has no view “two”. Use its number (1-4)."),
    ({"character": "c2", "view": 1}, "Character “Odd” has no reference views, so there is no view “1”."),
    ({"character": "c1", "view": True}, "target.view must be a view's number"),
    ({"character": "c1", "view": 2, "part": "seed"},
     "Nebula couldn’t point at view 2 because a view has no parts. Leave out the part."),
    ({"character": "c1", "part": "tint"},
     "“tint” isn’t a part of a character. Use name, subject-type, views, traits or seed."),
    ({"character": "c1", "image": 1}, "target.image isn’t for a character. Use view."),
    ({"character": "c1", "nodeId": "n1"}, "target is a character or a node or a spot, not more than one"),
    ({"itemId": "c1/1/x"}, "target.itemId is invalid"),
    ({"itemId": "c 1"}, "target.itemId is invalid"),
])
def test_a_character_refusal_says_what_to_use(raw, said):
    with pytest.raises(PresenceError) as refused:
        _character(raw)
    assert str(refused.value) == said


@pytest.mark.parametrize("view", ["9" * 5000, "#" + "9" * 5000, "x" * 10_000, "9" * 65, 10 ** 5000, "²", "①", "#²"],
                         ids=["digits", "hash-digits", "letters", "65-digits", "huge-int", "superscript", "circled",
                              "hash-superscript"])
def test_an_unbounded_or_unicode_view_is_refused_not_a_500(view):
    with pytest.raises(PresenceError):
        _character({"character": "c1", "view": view})


def test_the_anchors_own_item_id_round_trips_for_a_character():
    assert _character({"itemId": "c1/3", "part": None}) == (
        {"surface": "character", "itemId": "c1/3"}, {"character": "Mara", "view": 3})
    assert _character({"itemId": "c1", "part": "traits"})[0] == {
        "surface": "character", "itemId": "c1", "part": "traits"}


def test_no_characters_here_says_so():
    with pytest.raises(PresenceError) as refused:
        parse_surface_target({"surface": "character", "character": "Mara"}, None, characters=[])
    assert str(refused.value) == "No character “Mara” here. There are no characters yet."


def test_a_long_name_is_cut_to_80_characters_with_whitespace_folded():
    long = [{"id": "c9", "name": "A   " + "b" * 200, "referenceViews": []}]
    _, names = parse_surface_target({"surface": "character", "character": "c9"}, None, characters=long)
    assert names == {"character": "A " + "b" * 78}


# -- parse: a style -------------------------------------------------------------------------------

def test_a_style_by_id_and_by_name():
    target = {"surface": "style", "itemId": "s1"}
    assert _style({"style": "s1"}) == (target, {"style": "Dusk grain"})
    assert _style({"style": "Dusk grain"})[0] == target
    assert _style({"itemId": "s1"})[0] == target


@pytest.mark.parametrize("part", STYLE_PARTS)
def test_a_style_part_stays_its_own_id_in_the_names(part):
    target, names = _style({"style": "s1", "part": part})
    assert target == {"surface": "style", "itemId": "s1", "part": part}
    assert names == {"style": "Dusk grain", "part": part}


@pytest.mark.parametrize("raw, said", [
    ({"style": "Nope"}, "No style “Nope” here. The styles here: “Dusk grain”, “Twin”, “Twin”."),
    ({"style": "Twin"}, "“Twin” names 2 styles. Use an id: s2, s3."),
    ({}, "A style target needs `style`: a style's id or its exact name."),
    ({"style": "s1", "part": "tint"},
     "“tint” isn’t a part of a style. Use name, category, prompt, settings, model, references or thumbnail."),
    ({"style": "s1", "view": 1}, "target.view isn’t for a style. A style has no views."),
    ({"style": "s1", "image": 1}, "target.image isn’t for a style. A style has no images."),
    ({"itemId": "s1/2"}, "target.itemId is invalid"),
    ({"style": "s1", "x": 1}, "target is a style or a node or a spot, not more than one"),
])
def test_a_style_refusal_says_what_to_use(raw, said):
    with pytest.raises(PresenceError) as refused:
        _style(raw)
    assert str(refused.value) == said


def test_an_unknown_surface_lists_the_three():
    for surface in ("characters", "styles", "board", "Character", None, 5):
        with pytest.raises(PresenceError) as refused:
            parse_surface_target({"surface": surface}, None)
        assert str(refused.value).endswith("isn’t a surface Nebula knows. Use moodboard, character or style.")


def test_a_drag_start_is_never_a_surface_item():
    with pytest.raises(PresenceError) as refused:
        parse_surface_target({"surface": "style", "style": "s1"}, None, "from", styles=STYLES)
    assert str(refused.value) == "from can't be a style: a drag starts at a node or a spot (nodeId, or x and y)"


def test_parse_target_takes_the_new_forms_beside_the_others():
    assert parse_target({"surface": "character", "character": "Mara", "view": 2}, {}, characters=CHARACTERS) == {
        "surface": "character", "itemId": "c1/2"}
    assert parse_target({"surface": "style", "style": "Dusk grain"}, {}, styles=STYLES) == {
        "surface": "style", "itemId": "s1"}


def test_the_clash_refusal_names_its_surface():
    assert surface_clash_refusal(["from"], "character") == (
        "character can't be combined with from. Point at a character, or at a node or a spot, in one call.")


# -- AgentPresence: the cursor keeps its names ------------------------------------------------------

def _presence_with(target, names):
    from services.agent_presence import identify

    presence = AgentPresence()
    identity = identify({"X-Nebula-Agent": "Claude Code"})
    presence.point(identity, target=target, action="look", names=names)
    return presence, identity


def test_a_surface_cursor_has_no_canvas_point_and_keeps_its_names():
    presence, identity = _presence_with({"surface": "character", "itemId": "c1/2"},
                                        {"character": "Mara", "view": 2})
    (live,) = presence.active()
    assert live["anchorNames"] == {"character": "Mara", "view": 2}
    presence2, _ = _presence_with({"surface": "style", "itemId": "s1", "part": "prompt"},
                                  {"style": "Dusk grain", "part": "prompt"})
    assert presence2.active()[0]["anchorNames"] == {"style": "Dusk grain", "part": "prompt"}


def test_rename_item_changes_only_its_own_surface_and_id():
    presence, identity = _presence_with({"surface": "character", "itemId": "c1/2"},
                                        {"character": "Mara", "view": 2})
    assert presence.rename_item("style", "c1", "Nope") == 0  # same id, another surface
    assert presence.rename_item("character", "c9", "Nope") == 0
    assert presence.rename_item("character", "c1", "  Mara   Vance ") == 1
    assert presence.active()[0]["anchorNames"] == {"character": "Mara Vance", "view": 2}
    assert presence.rename_item("character", "c1", "Mara Vance") == 0  # unchanged


def test_forget_item_is_per_surface():
    presence, identity = _presence_with({"surface": "style", "itemId": "x1"}, {"style": "S"})
    gone: list = []
    assert presence.forget_item("character", "x1", gone) == 0 and gone == []
    assert presence.forget_item("style", "x1", gone) == 1
    assert gone == [{"agentId": identity.id, "key": None}] and presence.active() == []


def test_forget_subs_drops_a_view_past_the_end_back_to_the_character_with_its_name():
    presence, identity = _presence_with({"surface": "character", "itemId": "c1/4"},
                                        {"character": "Mara", "view": 4})
    fell: list = []
    assert presence.forget_subs("character", "c1", ["4", "5"], fell=fell) == 1
    assert fell == [{"agentId": identity.id, "key": None, "target": {"surface": "character", "itemId": "c1"},
                     "anchorNames": {"character": "Mara"}}]
    assert presence.active()[0]["target"] == {"surface": "character", "itemId": "c1"}
    assert presence.forget_subs("character", "c1", ["4"], fell=[]) == 0  # already on the character


# -- the route, with stores ----------------------------------------------------------------------

@pytest.fixture
def api(tmp_path, monkeypatch, canvas_project):
    import main as main_module

    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    presence = AgentPresence()
    sent: list[dict] = []
    heard: list[dict] = []

    async def capture(data, **_kw):
        sent.append(data)

    async def hear(data):
        heard.append(data)

    monkeypatch.setattr(main_module, "agent_presence", presence)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", hear)
    client = TestClient(main_module.app)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    return client, sent, heard, presence, canvas_project


def _url(color=(200, 80, 40)) -> str:
    path = OUTPUT_ROOT / "cursor-characters-styles-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _make_character(client, name="Mara", views=4, **body) -> dict:
    made = client.post("/api/characters", json={
        "name": name, "subjectType": "human", "referenceViews": [_url((20 * n, 80, 40)) for n in range(views)],
        "frozenTraitString": "auburn hair", "seed": 7, "consistencyStrength": 0.6, **body})
    assert made.status_code == 200, made.text
    return made.json()


STYLE = {"name": "Dusk grain", "category": "My Styles", "prompt": "dusk, film grain", "params": {},
         "modelId": None, "refImages": [], "scope": "global", "paramsVersion": PARAMS_VERSION}


def _make_style(client, headers=None, **overrides) -> dict:
    made = client.post("/api/presets", headers=headers or {}, json={**STYLE, **overrides})
    assert made.status_code == 200, made.text
    return made.json()


def _point(client, target, headers=AGENT, **body):
    return client.post("/api/canvas/cursor", headers=headers, json={"target": target, **body})


def _live_names(presence):
    """The names on every cursor kept: the agents' own and each session's."""
    kept = [value.get("anchorNames") for value in presence._agents.values()]
    for slots in presence._slots.values():
        kept.extend((slot.event or {}).get("anchorNames") for slot in slots.values())
    return [names for names in kept if names]


def _cursors(sent):
    return [event for event in sent if event.get("type") == "agentPresence"]


def test_the_route_turns_a_character_name_and_a_view_into_the_canonical_anchor(api):
    client, sent, _, _, _ = api
    character = _make_character(client)
    answer = _point(client, {"surface": "character", "character": "Mara", "view": "#2"}, action="look")
    assert answer.status_code == 200, answer.text
    assert answer.json()["target"] == {"surface": "character", "itemId": f"{character['id']}/2"}
    assert answer.json()["anchorNames"] == {"character": "Mara", "view": 2}
    event = _cursors(sent)[-1]
    assert event["target"]["surface"] == "character" and event["anchorNames"] == {"character": "Mara", "view": 2}
    assert event["did"]["verb"] == "Looked at" and event["did"]["label"] == "Mara"


def test_the_route_points_at_a_character_part_and_drops_consistency(api):
    client, sent, _, _, _ = api
    character = _make_character(client)
    answer = _point(client, {"surface": "character", "character": character["id"], "part": "traits"})
    assert answer.json()["target"] == {"surface": "character", "itemId": character["id"], "part": "traits"}
    assert answer.json()["anchorNames"] == {"character": "Mara", "part": "Frozen trait string"}
    answer = _point(client, {"surface": "character", "character": character["id"], "part": "consistency"})
    assert answer.status_code == 200
    assert answer.json()["target"] == {"surface": "character", "itemId": character["id"]}


def test_the_route_points_at_a_style_and_looks_at_it(api):
    client, sent, _, _, _ = api
    style = _make_style(client)
    answer = _point(client, {"surface": "style", "style": "Dusk grain", "part": "prompt"}, action="look")
    assert answer.status_code == 200, answer.text
    assert answer.json()["target"] == {"surface": "style", "itemId": style["id"], "part": "prompt"}
    assert answer.json()["anchorNames"] == {"style": "Dusk grain", "part": "prompt"}
    assert _cursors(sent)[-1]["did"]["verb"] == "Looked at" and _cursors(sent)[-1]["did"]["label"] == "Dusk grain"


def test_the_route_refuses_in_the_house_voice_and_sends_nothing(api):
    client, sent, _, _, _ = api
    _make_character(client)
    _make_character(client, name="Twin")
    _make_character(client, name="Twin")
    _make_style(client)
    listed = _point(client, {"surface": "character", "character": "Nobody"})
    assert listed.status_code == 422
    assert re.fullmatch(r"No character “Nobody” here\. The characters here: (“(Mara|Twin)”(, )?){3}\.",
                        listed.json()["detail"]), listed.text
    cases = [
        ({"surface": "style", "style": "Nobody"}, "No style “Nobody” here. The styles here: “Dusk grain”."),
        ({"surface": "character", "character": "Mara", "view": 9}, "Character “Mara” has no view “9”. Use its number (1-4)."),
        ({"surface": "characters", "character": "Mara"},
         "“characters” isn’t a surface Nebula knows. Use moodboard, character or style."),
    ]
    for target, said in cases:
        refused = _point(client, target)
        assert refused.status_code == 422 and refused.json()["detail"] == said, refused.text
    twin = _point(client, {"surface": "character", "character": "Twin"})
    assert twin.status_code == 422 and twin.json()["detail"].startswith("“Twin” names 2 characters. Use an id: ")
    # A drag can't start on one, and a surface item takes no `from`.
    drag = client.post("/api/canvas/cursor", headers=AGENT, json={
        "target": {"x": 1, "y": 2}, "from": {"surface": "style", "style": "Dusk grain"}, "action": "drag"})
    assert drag.status_code == 422 and "from can't be a style" in drag.json()["detail"]
    with_from = client.post("/api/canvas/cursor", headers=AGENT, json={
        "target": {"surface": "character", "character": "Mara"}, "from": {"nodeId": "n1"}, "action": "drag"})
    assert with_from.status_code == 422
    assert with_from.json()["detail"] == ("character can't be combined with from. "
                                          "Point at a character, or at a node or a spot, in one call.")
    assert _cursors(sent) == []


def test_a_project_item_of_another_project_can_not_be_named_but_global_can(api, monkeypatch):
    import main as main_module

    client, _, _, _, project_id = api
    theirs = _make_character(client, name="Elsewhere", projectId=project_id)
    far = _make_style(client, name="Far style", scope="project", projectId=project_id)
    house = _make_character(client, name="House")
    shared = _make_style(client, name="Shared style")
    own = [({"surface": "character", "character": "Elsewhere"}, "character"),
           ({"surface": "character", "character": theirs["id"]}, "character"),
           ({"surface": "style", "style": "Far style"}, "style"),
           ({"surface": "style", "style": far["id"]}, "style")]
    for target, _ in own:  # while their project is the open one
        assert _point(client, target).status_code == 200, target
    # Another project is open: neither the name nor the id reaches them, and
    # the refusal lists only what is here (review of PR #243: the earlier test
    # never left the project).
    monkeypatch.setattr(main_module, "_open_project_id", lambda: "some-other-project")
    for target, kind in own:
        refused = _point(client, target)
        assert refused.status_code == 422, target
        said = refused.json()["detail"]
        assert said.startswith(f"No {kind} “") and "Elsewhere”," not in said.split("here.", 1)[1], said
        assert "Far style" not in said.split("here.", 1)[1], said
    assert _point(client, {"surface": "character", "character": house["id"]}).status_code == 200
    assert _point(client, {"surface": "character", "character": "House"}).status_code == 200
    assert _point(client, {"surface": "style", "style": shared["id"]}).status_code == 200


def test_an_item_in_recently_deleted_can_not_be_pointed_at(api):
    client, _, _, _, _ = api
    character = _make_character(client)
    style = _make_style(client)
    assert client.delete(f"/api/characters/{character['id']}").status_code == 200
    assert client.delete(f"/api/presets/{style['id']}").status_code == 200
    for target in ({"surface": "character", "character": "Mara"},
                   {"surface": "character", "character": character["id"]},
                   {"surface": "style", "style": "Dusk grain"},
                   {"surface": "style", "style": style["id"]}):
        refused = _point(client, target)
        assert refused.status_code == 422 and refused.json()["detail"].startswith("No "), refused.text


def test_items_that_go_with_a_project_deleted_for_good_take_their_cursors(api):
    """A project purged for good deletes its characters and styles (and
    boards): cursors on them leave and the tabs are told, as on a delete
    (review of PR #243)."""
    import main as main_module

    client, _, heard, presence, _ = api
    character = _make_character(client)
    style = _make_style(client)
    for target, removed in (
            ({"surface": "character", "character": character["id"], "view": 2},
             {"character": [{"id": character["id"], "name": "Mara"}]}),
            ({"surface": "style", "style": style["id"]}, {"style": [{"id": style["id"], "name": "Dusk grain"}]})):
        assert _point(client, target).status_code == 200
        assert len(presence.active()) == 1
        heard.clear()
        asyncio.run(main_module._broadcast_assets_gone(removed))
        assert presence.active() == [], target
        assert [event["type"] for event in heard].count("agentPresenceLeave") == 1, heard


def test_a_style_delete_clears_its_cursors_before_its_line_is_said(api, monkeypatch):
    """As a board's delete: a tab must not draw the delete's line at a cursor
    that is about to leave (review of PR #243)."""
    import main as main_module

    client, _, _, _, _ = api
    order: list[tuple[str, dict]] = []

    async def raw(data, **_kw):
        order.append(("raw", data))

    async def tabs(data):
        order.append(("tabs", data))

    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", tabs)
    style = _make_style(client, LANE_A)
    order.clear()
    assert client.delete(f"/api/presets/{style['id']}", headers=LANE_A).status_code == 200
    left = [n for n, (where, data) in enumerate(order) if data.get("type") == "agentPresenceLeave"]
    said = [n for n, (where, data) in enumerate(order)
            if data.get("say") == "Moved the style “Dusk grain” to “Recently deleted”"]
    assert left and said and max(left) < min(said), [(where, data.get("type")) for where, data in order]


# -- renames and deletes keep the cursors true ------------------------------------------------------

def test_renaming_a_character_and_a_style_reaches_the_names_on_their_cursors(api):
    client, sent, _, presence, _ = api
    character = _make_character(client)
    style = _make_style(client)
    _point(client, {"surface": "character", "character": character["id"], "view": 2}, LANE_A)
    _point(client, {"surface": "style", "style": style["id"]}, LANE_B)
    assert client.put(f"/api/characters/{character['id']}", json={"name": "Mara Vance"}).status_code == 200
    assert client.put(f"/api/presets/{style['id']}", json={"name": "Dusk grain II"}).status_code == 200
    names = _live_names(presence)
    assert {"character": "Mara Vance", "view": 2} in names and {"style": "Dusk grain II"} in names
    assert not [n for n in names if n.get("character") == "Mara" or n.get("style") == "Dusk grain"]


def test_deleting_a_character_clears_its_cursors_and_tells_the_tabs(api):
    client, sent, heard, presence, _ = api
    character = _make_character(client)
    other = _make_character(client, name="Other")
    _point(client, {"surface": "character", "character": character["id"]}, LANE_A)
    _point(client, {"surface": "character", "character": character["id"], "view": 1}, LANE_B)
    _point(client, {"surface": "character", "character": other["id"]}, {**AGENT, "X-Nebula-Agent-Session": "lane-c"})
    heard.clear()
    assert client.delete(f"/api/characters/{character['id']}", headers=LANE_A).status_code == 200
    (leave,) = [event for event in heard if event.get("type") == "agentPresenceLeave"]
    assert len([c for c in leave["cursors"] if c["key"] is not None]) == 2
    left = presence.active()
    assert [live["anchorNames"] for live in left] == [{"character": "Other"}]


def test_deleting_a_style_clears_its_cursors_and_tells_the_tabs(api):
    client, sent, heard, presence, _ = api
    style = _make_style(client)
    _point(client, {"surface": "style", "style": style["id"]}, LANE_A)
    heard.clear()
    assert client.delete(f"/api/presets/{style['id']}", headers=LANE_B).status_code == 200
    (leave,) = [event for event in heard if event.get("type") == "agentPresenceLeave"]
    assert len([c for c in leave["cursors"] if c["key"] is not None]) == 1
    assert presence.active() == []
    # A delete says nothing at a cursor: no target on its line.
    assert all("target" not in event or event["target"].get("surface") != "style" for event in _cursors(sent)[1:])


def test_a_delete_that_drops_no_cursor_tells_no_tab(api):
    client, _, heard, _, _ = api
    character = _make_character(client)
    heard.clear()
    assert client.delete(f"/api/characters/{character['id']}", headers=LANE_A).status_code == 200
    assert [event for event in heard if event.get("type") == "agentPresenceLeave"] == []


def test_views_cut_down_move_the_cursors_past_the_end_to_the_character(api):
    client, sent, heard, presence, _ = api
    character = _make_character(client, views=5)
    _point(client, {"surface": "character", "character": character["id"], "view": 5}, LANE_A)
    _point(client, {"surface": "character", "character": character["id"], "view": 3}, LANE_B)
    _point(client, {"surface": "character", "character": character["id"], "view": 4},
           {**AGENT, "X-Nebula-Agent-Session": "lane-c"})
    heard.clear()
    kept = [_url(), _url(), _url()]
    assert client.put(f"/api/characters/{character['id']}", json={"referenceViews": kept}).status_code == 200
    (retarget,) = [event for event in heard if event.get("type") == "agentPresenceRetarget"]
    assert len({c["key"] for c in retarget["cursors"] if c["key"] is not None}) == 2  # lanes a and c, not b
    for cursor in retarget["cursors"]:
        assert cursor["target"] == {"surface": "character", "itemId": character["id"]}
        assert cursor["anchorNames"] == {"character": "Mara"}
    held = [value["target"]["itemId"] for value in presence._agents.values()]
    held += [slot.target["itemId"] for slots in presence._slots.values() for slot in slots.values()]
    assert sorted(held) == sorted([character["id"], character["id"], f"{character['id']}/3", character["id"]])


def test_a_put_that_keeps_every_view_moves_no_cursor(api):
    client, _, heard, _, _ = api
    character = _make_character(client)
    _point(client, {"surface": "character", "character": character["id"], "view": 4}, LANE_A)
    heard.clear()
    assert client.put(f"/api/characters/{character['id']}", json={"frozenTraitString": "grey"}).status_code == 200
    assert client.put(f"/api/characters/{character['id']}",
                      json={"referenceViews": character["referenceViews"]}).status_code == 200
    assert [event for event in heard if event.get("type") == "agentPresenceRetarget"] == []


def test_moving_a_character_between_project_and_global_keeps_the_cursor_on_it(api):
    """The id does not change on a move, so the anchor is still true: the cursor stays, and the tabs find the
    item wherever its list now shows it (or park at the Assets button). Nothing is cleared."""
    client, _, heard, presence, project_id = api
    character = _make_character(client)
    _point(client, {"surface": "character", "character": character["id"]}, LANE_A)
    heard.clear()
    moved = client.post(f"/api/characters/{character['id']}/move", json={"projectId": project_id})
    assert moved.status_code == 200, moved.text
    assert [event for event in heard if event.get("type") in ("agentPresenceLeave", "agentPresenceRetarget")] == []
    assert [live["target"] for live in presence.active()] == [{"surface": "character", "itemId": character["id"]}]
    assert [live["anchorNames"] for live in presence.active()] == [{"character": "Mara"}]


# -- Style writes move the writer's cursor ------------------------------------------------------------

def _style_cursor(sent):
    return [event for event in _cursors(sent) if (event.get("target") or {}).get("surface") == "style"][-1]


def test_an_agents_new_style_moves_its_cursor_to_the_style_with_the_new_words(api):
    client, sent, _, _, _ = api
    style = _make_style(client, LANE_A)
    event = _style_cursor(sent)
    assert event["target"] == {"surface": "style", "itemId": style["id"]}
    assert event["action"] == "type" and event["anchorNames"] == {"style": "Dusk grain"}
    assert event["say"] == "Made the style “Dusk grain”"


def test_each_single_field_update_points_at_its_part_and_two_fields_have_none(api):
    client, sent, _, _, _ = api
    style = _make_style(client, LANE_A)
    one = {"name": ("Dusk grain 2", "name"), "category": ("Film", "category"), "prompt": ("new prompt", "prompt"),
           "params": ({"a": 1}, "settings"), "refImages": ([_url()], "references")}
    for field, (value, part) in one.items():
        assert client.put(f"/api/presets/{style['id']}", headers=LANE_A, json={field: value}).status_code == 200
        event = _style_cursor(sent)
        assert event["target"].get("part") == part, (field, event["target"])
        assert event["action"] == "type"
        assert event["anchorNames"]["style"].startswith("Dusk grain") and event["anchorNames"].get("part") == part
    two = client.put(f"/api/presets/{style['id']}", headers=LANE_A, json={"prompt": "again", "category": "Other"})
    assert two.status_code == 200
    event = _style_cursor(sent)
    assert "part" not in event["target"] and "part" not in event["anchorNames"]
    assert event["say"].startswith("Changed the category and the prompt of the style “")


def test_the_say_for_an_update_uses_the_journals_words(api):
    client, sent, _, _, _ = api
    style = _make_style(client, LANE_A)
    assert client.put(f"/api/presets/{style['id']}", headers=LANE_A, json={"prompt": "x"}).status_code == 200
    assert _style_cursor(sent)["say"] == "Changed the prompt of the style “Dusk grain”"


def test_a_renames_say_gives_both_names(api):
    client, sent, _, _, _ = api
    style = _make_style(client, LANE_A)
    renamed = client.put(f"/api/presets/{style['id']}", headers=LANE_A, json={"name": "Dusk grain II", "prompt": "y"})
    assert renamed.status_code == 200
    event = _style_cursor(sent)
    assert event["say"] == "Renamed the style “Dusk grain” to “Dusk grain II” and changed its prompt"
    assert event["anchorNames"] == {"style": "Dusk grain II"} and "part" not in event["target"]


def test_a_person_writing_a_style_moves_no_cursor(api):
    client, sent, _, _, _ = api
    style = _make_style(client)
    client.put(f"/api/presets/{style['id']}", json={"prompt": "x"})
    assert _cursors(sent) == []


def test_a_style_delete_and_restore_move_nothing_but_leave_a_line(api):
    client, sent, _, presence, _ = api
    style = _make_style(client, LANE_A)
    assert client.delete(f"/api/presets/{style['id']}", headers=LANE_A).status_code == 200
    assert presence.active() == []  # the cursor left
    assert client.post(f"/api/trash/style/{style['id']}/restore", headers=LANE_A).status_code == 200
    assert presence.active() == []  # a restore doesn't bring it back


def test_a_project_style_of_another_project_sends_no_target(api, monkeypatch):
    import main as main_module

    client, sent, _, _, project_id = api
    monkeypatch.setattr(main_module, "_open_project_id", lambda: "some-other-project")
    made = client.post("/api/presets", headers=LANE_A,
                       json={**STYLE, "scope": "project", "projectId": project_id})
    assert made.status_code == 200, made.text
    assert not [event for event in _cursors(sent) if (event.get("target") or {}).get("surface") == "style"]
    log = [event for event in _cursors(sent)]
    assert log and log[-1]["say"] == "Made the style “Dusk grain”"


def test_the_journal_the_log_and_the_say_use_one_set_of_words(api):
    import main as main_module

    client, sent, _, _, _ = api
    style = _make_style(client, LANE_A, name="Dusk grain")
    events = main_module.canvas_events.read(after=0, kinds={"style"}, limit=500)["events"]
    assert [event["summary"] for event in events if event["data"].get("styleId") == style["id"]] == [
        "made the style “Dusk grain”"]
    assert _cursors(sent)[-1]["say"] == "Made the style “Dusk grain”"


def test_style_actions_words_for_every_verb():
    from services import style_actions

    style = {"id": "s1", "name": "Dusk grain"}
    assert style_actions.describe("created", style) == "made the style “Dusk grain”"
    assert style_actions.describe("updated", style, fields=["prompt"]) == "changed the prompt of the style “Dusk grain”"
    assert style_actions.describe("updated", style, fields=["prompt", "params"]) == \
        "changed the prompt and the settings of the style “Dusk grain”"
    assert style_actions.describe("updated", style, fields=["prompt", "params", "modelId"]) == \
        "changed the prompt, the settings and the model of the style “Dusk grain”"
    assert style_actions.describe("updated", style, fields=["category", "prompt", "params", "modelId"]) == \
        "made 4 changes to the style “Dusk grain”"
    # A rename gives both names, then up to three other fields or a count.
    was = {"id": "s1", "name": "Dusk"}
    assert style_actions.describe("updated", style, fields=["name"], before=was) == \
        "renamed the style “Dusk” to “Dusk grain”"
    assert style_actions.describe("updated", style, fields=["name", "prompt"], before=was) == \
        "renamed the style “Dusk” to “Dusk grain” and changed its prompt"
    assert style_actions.describe("updated", style, fields=["name", "prompt", "params"], before=was) == \
        "renamed the style “Dusk” to “Dusk grain” and changed its prompt and settings"
    assert style_actions.describe("updated", style, fields=["name", "prompt", "params", "modelId"], before=was) == \
        "renamed the style “Dusk” to “Dusk grain” and changed its prompt, settings and model"
    assert style_actions.describe("updated", style, fields=["name", "category", "prompt", "params", "modelId"],
                                  before=was) == "renamed the style “Dusk” to “Dusk grain” and made 4 other changes"
    # With no earlier name to give, a name change reads as any field's.
    assert style_actions.describe("updated", style, fields=["name"]) == "changed the name of the style “Dusk grain”"
    assert style_actions.describe("updated", style, fields=[]) == "saved the style “Dusk grain” with no changes"
    assert style_actions.describe("deleted", style) == "moved the style “Dusk grain” to “Recently deleted”"
    # The log, the journal and the say are one line, so a line that would pass
    # the say's length shortens its names and keeps its end.
    long = style_actions.describe("updated", {"id": "s1", "name": "N" * 80},
                                  fields=["name", "category", "refImages", "thumbnail"], before={"name": "O" * 80})
    assert len(long) <= 140 and long.endswith("and changed its category, references and thumbnail")
    # Two long names that are cut to the same text would read “XXX…” to “XXX…”,
    # which names nothing: that rename takes the plain form (review of PR #243).
    start = "X" * 100
    twins = {"fields": ["name", "prompt", "params"], "before": {"name": start + "a"}}
    assert style_actions.describe("updated", {"id": "s1", "name": start + "b"}, **twins) == \
        f"changed the name, the prompt and the settings of the style “{'X' * 59}…”"
    assert style_actions.describe("updated", {"id": "s1", "name": start + "b"}, fields=["name"],
                                  before={"name": start + "a"}) == f"changed the name of the style “{'X' * 59}…”"
    # A cut never splits a character: a joined emoji stays whole or goes.
    family = "\U0001F468\u200d\U0001F469\u200d\U0001F467"
    cut = style_actions.describe("created", {"id": "s1", "name": family * 20})
    assert "\u200d\u2026" not in cut and not cut.rstrip("…”").endswith("\u200d")
    assert not style_actions.style_anchor({"id": "s1", "name": family * 20})[1]["style"].endswith("\u200d")
    assert style_actions.describe("restored", style) == "restored the style “Dusk grain”"
    assert style_actions.describe("purged", style) == "deleted the style “Dusk grain” for good"
    assert style_actions.describe("created", None, style_id="s9") == "made the style “s9”"
    assert style_actions.sentence("made the style “Dusk grain”") == "Made the style “Dusk grain”"
    assert style_actions.style_anchor(style, ["category"]) == (
        {"surface": "style", "itemId": "s1", "part": "category"}, {"style": "Dusk grain", "part": "category"})
    assert style_actions.style_anchor(style, ["category", "prompt"]) == (
        {"surface": "style", "itemId": "s1"}, {"style": "Dusk grain"})


# -- reads: names in look, context and agents ----------------------------------------------------------

def test_formatter_words_for_a_character_and_a_style_cursor():
    from cli import formatter

    names = {"character": "Mara", "view": 2}
    assert formatter._surface_words({"surface": "character", "itemId": "c1/2"}, names) == \
        "character “Mara”, view 2"
    assert formatter._surface_words({"surface": "character", "itemId": "c1", "part": "traits"},
                                    {"character": "Mara", "part": "Frozen trait string"}) == "character “Mara” (traits)"
    assert formatter._surface_words({"surface": "style", "itemId": "s1", "part": "prompt"},
                                    {"style": "Dusk grain", "part": "prompt"}) == "style “Dusk grain” (prompt)"
    assert formatter._surface_words({"surface": "style", "itemId": "s1"}, None) == "style s1"
    assert formatter._surface_words({"surface": "character", "itemId": "c1/3"}, None) == "character c1, view 3"
    # A moodboard is as it was.
    assert formatter._surface_words({"surface": "moodboard", "itemId": "b1/i12", "part": "note"},
                                    {"board": "Desert light", "image": 12}) == \
        "moodboard “Desert light”, image 12 (note)"


def test_the_roster_and_agent_start_carry_a_character_cursors_names():
    from cli import formatter
    from services import agent_start
    from services.agent_status import build_roster

    target = {"surface": "character", "itemId": "c1/2"}
    names = {"character": "Mara", "view": 2}
    cursors = [{"agent": {"id": "claude-code", "name": "Claude", "color": "#d97757", "verified": True},
                "projectId": "p1", "target": target, "anchorNames": names, "action": "look", "secondsAgo": 2.0,
                "did": {"verb": "Looked at", "label": "Mara", "secondsAgo": 2.0}}]
    (entry,) = build_roster(project_id="p1", now=10.0, cursors=cursors, statuses=[], waiting=[],
                            status_view=lambda status: {})
    assert entry["cursor"]["surface"] == {"target": target, "anchorNames": names}
    assert "cursor on character “Mara”, view 2" in formatter.format_agents({"agents": [entry]})
    assert entry["lastAction"]["verb"] == "Looked at" and entry["lastAction"]["label"] == "Mara"
    part = agent_start.canvas_part(
        {"agents": [{"id": "x", "name": "Claude", "target": target, "anchorNames": names, "secondsAgo": 1.0}]},
        project=None, caller_id=None, via="mcp")
    assert part["agents"][0]["anchorNames"] == names


def test_look_snapshot_names_a_character_cursor(api):
    client, _, _, presence, _ = api
    character = _make_character(client)
    _point(client, {"surface": "character", "character": character["id"], "view": 2}, action="look")
    (live,) = presence.active()
    assert live["target"] == {"surface": "character", "itemId": f"{character['id']}/2"}
    assert live["anchorNames"] == {"character": "Mara", "view": 2}


# -- MCP ---------------------------------------------------------------------------------------------

@pytest.fixture
def mcp_calls(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(mcp_server, "_canvas_call",
                        lambda method, path, ctx, **kwargs: calls.append(kwargs["json"]) or {"placed": "target"})
    return calls


def test_point_at_a_character_and_a_style_sends_one_surface_target(mcp_calls):
    mcp_server.point_at(character="Mara", view="#2", say="Checking", action="look")
    mcp_server.point_at(character="c1", part="traits", action="look")
    mcp_server.point_at(style="Dusk grain", part="prompt", action="type")
    mcp_server.point_at(style="s1")
    assert mcp_calls == [
        {"target": {"surface": "character", "character": "Mara", "view": "#2"}, "say": "Checking", "action": "look"},
        {"target": {"surface": "character", "character": "c1", "part": "traits"}, "say": "", "action": "look"},
        {"target": {"surface": "style", "style": "Dusk grain", "part": "prompt"}, "say": "", "action": "type"},
        {"target": {"surface": "style", "style": "s1"}, "say": "", "action": "move"},
    ]


@pytest.mark.parametrize("kwargs, said", [
    ({"character": "c1", "node_id": "n1"}, "point_at: character can't be combined with node_id."),
    ({"style": "s1", "x": 1.0, "y": 2.0}, "point_at: style can't be combined with x, y."),
    ({"character": "c1", "from_node_id": "n1", "action": "drag"},
     "point_at: character can't be combined with from_node_id."),
    ({"character": "c1", "style": "s1"},
     "point_at: character and style can't be given together. Point at a moodboard, a character or a style in one call."),
    ({"moodboard": "b1", "character": "c1"},
     "point_at: moodboard and character can't be given together."),
    ({"view": 2}, "point_at: view needs character (its id or exact name)"),
    ({"style": "s1", "view": 2}, "point_at: view needs character (its id or exact name)"),
    ({"character": "c1", "image": 2}, "point_at: image goes with moodboard"),
    ({"part": "seed"}, "point_at: part needs moodboard, character or style (an id or exact name)"),
])
def test_point_at_refuses_a_surface_mixed_with_anything_else(mcp_calls, kwargs, said):
    with pytest.raises(ValueError) as refused:
        mcp_server.point_at(**kwargs)
    assert str(refused.value).startswith(said)
    assert mcp_calls == []


def test_point_at_says_how_to_name_a_character_and_a_style():
    doc = mcp_server.point_at.__doc__
    for word in ("`character`", "`view`", "`style`", "character_list", "style_list", "subject-type", "traits",
                 "settings", "references", "never opens a panel or scrolls", "style_create"):
        assert word in doc, word
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    assert {"moodboard", "image", "part", "character", "view", "style"} <= set(tools["point_at"].inputSchema["properties"])


def test_the_mcp_point_goes_through_the_route(api, monkeypatch):
    client, sent, _, _, _ = api
    character = _make_character(client)

    def call(method, path, ctx, **kwargs):
        response = client.request(method, path, headers=AGENT, **kwargs)
        if response.status_code >= 400:
            raise ValueError(response.json()["detail"])
        return response.json()

    monkeypatch.setattr(mcp_server, "_canvas_call", call)
    answer = mcp_server.point_at(character="Mara", view=3, action="look")
    assert answer["target"] == {"surface": "character", "itemId": f"{character['id']}/3"}
    with pytest.raises(ValueError) as refused:
        mcp_server.point_at(character="Mara", view=9)
    assert "has no view “9”" in str(refused.value)


# -- the character read tools -------------------------------------------------------------------------

def test_character_list_and_get_over_mcp(api):
    client, _, _, _, project_id = api
    house = _make_character(client, name="House")
    here = client.post("/api/characters", json={
        "name": "Here", "subjectType": "stylized", "referenceViews": [_url(), _url(), _url()],
        "frozenTraitString": "red scarf", "seed": 11, "consistencyStrength": 0.5, "projectId": project_id}).json()
    listed = mcp_server.character_list()
    assert {item["id"] for item in listed} == {house["id"], here["id"]}
    mine = next(item for item in listed if item["id"] == here["id"])
    assert mine == {
        "id": here["id"], "name": "Here", "scope": "project", "projectId": project_id, "subjectType": "stylized",
        "viewCount": 3, "referenceViews": here["referenceViews"], "frozenTraitString": "red scarf", "seed": 11,
        "version": here["version"]}
    assert [item["id"] for item in mcp_server.character_list(project_id="none")] == [house["id"]]
    assert mcp_server.character_get("here")["id"] == here["id"]  # exact name, any case
    assert mcp_server.character_get(house["id"])["scope"] == "global"
    with pytest.raises(RuntimeError, match="no Character “Nobody”"):
        mcp_server.character_get("Nobody")


def test_character_get_echoes_a_long_name_cut(api):
    with pytest.raises(Exception) as refused:
        mcp_server.character_get("N" * 10_000)
    assert "N" * 41 not in str(refused.value) and len(str(refused.value)) < 200


def test_character_get_says_a_deleted_one_is_in_recently_deleted(api):
    client, _, _, _, _ = api
    character = _make_character(client)
    assert client.delete(f"/api/characters/{character['id']}").status_code == 200
    with pytest.raises(RuntimeError) as refused:
        mcp_server.character_get(character["id"])
    assert "Recently deleted" in str(refused.value)


def test_the_character_read_tools_are_registered_read_only_and_allowed():
    from services.agent_profiles import CLAUDE_ALLOW_RULES
    from services.krea_agent_mcp import NEBULA_MCP_TOOLS

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    for name in ("character_list", "character_get"):
        assert name in tools and name in NEBULA_MCP_TOOLS and f"mcp__nebula__{name}" in CLAUDE_ALLOW_RULES
        assert tools[name].annotations.readOnlyHint is True


def test_the_docs_and_the_skill_say_every_new_thing():
    root = Path(__file__).resolve().parents[2]
    docs = (root / "docs" / "MCP-SETUP.md").read_text(encoding="utf-8")
    skill = (root / "skills" / "nebula" / "SKILL.md").read_text(encoding="utf-8")
    for word in ("character_list", "character_get", "nebula character list", "nebula character show",
                 "--character", "--view", "--style", "Made the style"):
        assert word in docs, word
    for word in ("nebula character list", "nebula character show", "--character", "--view", "--style"):
        assert word in skill, word


# -- the CLI ---------------------------------------------------------------------------------------------

def _cli(monkeypatch, *argv):
    from cli import __main__ as cli_main

    monkeypatch.setattr(sys, "argv", ["nebula", "point", *argv])
    err = io.StringIO()
    with redirect_stderr(err), pytest.raises(SystemExit) as stopped:
        cli_main.main()
    assert stopped.value.code == 2
    return err.getvalue().strip().splitlines()[-1]


def test_nebula_point_refuses_the_new_flags_misused(monkeypatch):
    assert _cli(monkeypatch, "n2", "--character", "Mara").startswith(
        "nebula point: error: --character is a target of its own")
    assert _cli(monkeypatch, "--style", "Dusk", "--from", "n2").endswith(
        "--from can't go with --style: a drag starts at a node or a spot")
    assert _cli(monkeypatch, "--character", "Mara", "--style", "Dusk").endswith(
        "can't go together: point at a moodboard, a character or a style in one call")
    assert _cli(monkeypatch, "--view", "2").endswith("--view goes with --character NAME_OR_ID (its id or exact name)")
    assert _cli(monkeypatch, "--style", "Dusk", "--view", "2").endswith(
        "--view goes with --character NAME_OR_ID (its id or exact name)")
    assert _cli(monkeypatch, "--character", "Mara", "--image", "1").endswith(
        "--image goes with --moodboard BOARD; a character's reference view is --view N")
    # An empty value is a mistake to name, not a flag that wasn't given.
    assert _cli(monkeypatch, "--character", "", "--part", "name").endswith(
        "--character needs an id or an exact name")
    assert _cli(monkeypatch, "--style", " ").endswith("--style needs an id or an exact name")


def test_nebula_point_character_and_style_send_the_surface_target_and_print_where():
    from cli.__main__ import build_parser
    from cli.commands import canvas

    args = build_parser().parse_args(["point", "--character", "Mara", "--view", "2", "--action", "look"])
    assert (args.character, args.view, args.style, args.part, args.target) == ("Mara", "2", None, None, None)
    args = build_parser().parse_args(["point", "--style", "Dusk grain", "--part", "prompt"])
    assert (args.style, args.part, args.character, args.moodboard) == ("Dusk grain", "prompt", None, None)

    class Client:
        body = None

        def point_cursor(self, body, agent_name=None):
            Client.body = body
            return {"agent": {"name": "Claude"}, "say": "", "anchorNames": Client.names}

    Client.names = {"character": "Mara", "view": 2}
    out = io.StringIO()
    with redirect_stdout(out):
        canvas.run_point(Client(), None, action="look", character="Mara", view="2")
    assert Client.body == {"target": {"surface": "character", "character": "Mara", "view": "2"}, "say": "",
                           "action": "look"}
    assert out.getvalue().strip() == "Claude → character “Mara”, view 2"
    Client.names = {"style": "Dusk grain", "part": "prompt"}
    out = io.StringIO()
    with redirect_stdout(out):
        canvas.run_point(Client(), None, say="Reading", action="look", style="Dusk grain", part="prompt")
    assert Client.body["target"] == {"surface": "style", "style": "Dusk grain", "part": "prompt"}
    assert out.getvalue().strip() == "Claude → style “Dusk grain” (prompt)"


def test_nebula_character_list_and_show(api, monkeypatch, capsys):
    from cli import __main__ as cli_main
    from cli.client import NebulaClient

    client, _, _, _, project_id = api
    made = _make_character(client, name="Mara")
    seen = NebulaAPI("http://testserver", client=client)
    monkeypatch.setattr(NebulaClient, "api", property(lambda self: seen))

    def run(*argv):
        monkeypatch.setattr(sys, "argv", ["nebula", "character", *argv])
        cli_main.main()
        return capsys.readouterr().out

    listing = run("list")
    assert f"{made['id']}  Mara  (human, 4 views, Global)" in listing
    shown = run("show", "Mara")
    assert "frozen trait string: auburn hair" in shown and "seed: 7" in shown
    assert "reference views (4;" in shown and "    1. /api/outputs/" in shown and "    4. /api/outputs/" in shown
    assert '"viewCount": 4' in run("show", made["id"], "--json")
    assert '"scope": "global"' in run("list", "--json", "--global")


# -- GM round 1: a Character can only be looked at ------------------------------------------------------

@pytest.mark.parametrize("action", ["type", "click"])
@pytest.mark.parametrize("extra", [{}, {"view": 2}, {"part": "traits"}])
def test_a_type_or_a_click_at_a_character_is_stored_and_told_as_a_look(api, action, extra):
    client, sent, heard, presence, _ = api
    character = _make_character(client)
    made = _point(client, {"surface": "character", "character": character["id"], **extra}, LANE_A, action=action,
                  say="Checking")
    assert made.status_code == 200, made.text
    assert made.json()["action"] == "look"
    assert _cursors(sent)[-1]["action"] == "look"
    assert [live["action"] for live in presence.active()] == ["look"]
    assert [value["action"] for value in presence._agents.values()] == ["look"]
    (slot,) = [slot for slots in presence._slots.values() for slot in slots.values()]
    assert slot.event["action"] == "look"
    # The Agents panel's line reads as a look, as it does for `look`.
    assert presence.active()[0]["did"]["verb"] == "Looked at"


def test_a_style_and_a_board_keep_their_type_and_click(api):
    client, _, _, presence, _ = api
    style = _make_style(client)
    board = client.post("/api/moodboards", json={"name": "Desert light", "images": [{"url": _url()}]}).json()
    for target in ({"surface": "style", "style": style["id"]}, {"surface": "moodboard", "board": board["id"]}):
        for action in ("type", "click"):
            assert _point(client, target, LANE_A, action=action).json()["action"] == action


def test_point_at_and_the_cli_say_what_was_stored_for_a_character(api):
    client, _, _, _, _ = api
    character = _make_character(client)
    assert mcp_server.point_at(character=character["id"], action="type")["action"] == "look"
    from cli.commands.canvas import run_point

    class Echo:
        def point_cursor(self, body, agent_name=None):
            stored = "look" if body["action"] in ("type", "click") else body["action"]
            return {"agent": {"name": "Claude"}, "say": "", "action": stored, "anchorNames": {"character": "Mara"}}

    out = io.StringIO()
    with redirect_stdout(out):
        run_point(Echo(), None, character="Mara", action="click")
        run_point(Echo(), None, character="Mara", action="look")
    assert out.getvalue().splitlines() == ["Claude \u2192 character \u201cMara\u201d (shown as look)",
                                           "Claude \u2192 character \u201cMara\u201d"]


# -- GM round 1, R1: an item deleted while the point route reads ------------------------------------

def _delete_during_first_lookup(monkeypatch, name, act):
    """The route's first lookup reads the item, then `act` changes it before the
    cursor is stored (the window a person's delete can land in)."""
    import main as main_module

    real = getattr(main_module, name)
    calls: list[int] = []

    def lookup():
        found = real()
        if not calls:
            calls.append(1)
            act(main_module)
        return found

    monkeypatch.setattr(main_module, name, lookup)


def _told(heard):
    """What the person's tabs were told about cursors leaving or moving."""
    return [event for event in heard if event.get("type") in ("agentPresenceLeave", "agentPresenceRetarget")]


def _nothing_left(presence, sent, heard):
    assert presence.active() == [] and presence._agents == {} and _live_names(presence) == []
    assert presence.replay() == [] and _cursors(sent) == []
    # The refused point wrote no session cursor and sent none, so no tab has one to drop.
    assert _told(heard) == []


def test_a_character_deleted_while_the_point_reads_leaves_no_cursor(api, monkeypatch):
    client, sent, heard, presence, _ = api
    character = _make_character(client)
    _delete_during_first_lookup(monkeypatch, "_characters_to_point_at",
                                lambda main: main._char_store().delete(character["id"]))
    refused = _point(client, {"surface": "character", "character": "Mara"}, LANE_A, action="look")
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"].startswith("No character “Mara” here."), refused.text
    _nothing_left(presence, sent, heard)


def test_a_view_cut_while_the_point_reads_leaves_no_cursor(api, monkeypatch):
    client, sent, heard, presence, _ = api
    character = _make_character(client, views=5)
    kept = _make_character(client, name="Other", views=3)  # another cursor, which stays
    assert _point(client, {"surface": "character", "character": kept["id"]},
                  {**AGENT, "X-Nebula-Agent-Session": "lane-c"}).status_code == 200
    sent.clear()
    heard.clear()
    _delete_during_first_lookup(monkeypatch, "_characters_to_point_at",
                                lambda main: main._char_store().update(character["id"], referenceViews=[_url(), _url(), _url()]))
    refused = _point(client, {"surface": "character", "character": character["id"], "view": 5}, LANE_A)
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"] == "Character “Mara” has no view “5”. Use its number (1-3)."
    assert _cursors(sent) == [] and _told(heard) == []
    assert [live["anchorNames"] for live in presence.active()] == [{"character": "Other"}]
    assert [cursor["anchorNames"] for cursor in presence.replay()] == [{"character": "Other"}]


def test_a_style_deleted_while_the_point_reads_leaves_no_cursor(api, monkeypatch):
    import main as main_module

    client, sent, heard, presence, _ = api
    style = _make_style(client)
    _delete_during_first_lookup(monkeypatch, "_styles_to_point_at", lambda main: main.preset_store.delete(style["id"]))
    refused = _point(client, {"surface": "style", "style": "Dusk grain"}, LANE_A, action="type")
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"].startswith("No style “Dusk grain” here."), refused.text
    _nothing_left(presence, sent, heard)
    assert main_module.preset_store.trashed(style["id"]) is not None


def test_a_board_deleted_while_the_point_reads_leaves_no_cursor(api, monkeypatch):
    client, sent, heard, presence, _ = api
    board = client.post("/api/moodboards", json={"name": "Desert light", "images": [{"url": _url()}]}).json()
    _delete_during_first_lookup(monkeypatch, "_boards_to_point_at",
                                lambda main: main._moodboard_store().delete(board["id"]))
    refused = _point(client, {"surface": "moodboard", "board": "Desert light", "image": 1}, LANE_A)
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"].startswith("No moodboard “Desert light” here."), refused.text
    _nothing_left(presence, sent, heard)


def _forget_before_the_second_look(monkeypatch, forget):
    """The deleting route's own forget runs between the store of the cursor and
    the route's second look (it awaits there)."""
    import main as main_module

    real = main_module._surface_target_missing

    def look_again(raw, target):
        forget(main_module.agent_presence)
        return real(raw, target)

    monkeypatch.setattr(main_module, "_surface_target_missing", look_again)


@pytest.mark.parametrize("forget_runs_meanwhile", [False, True])
def test_a_refused_point_never_puts_back_a_cursor_on_the_deleted_item(api, monkeypatch, forget_runs_meanwhile):
    """The agent is on the Character already and points at it again as it is
    deleted: its earlier cursor there goes too, the plain one and the session's."""
    client, sent, heard, presence, _ = api
    character = _make_character(client)
    assert _point(client, {"surface": "character", "character": "Mara"}, LANE_A).status_code == 200
    (before,) = presence.replay()
    sent.clear()
    heard.clear()
    _delete_during_first_lookup(monkeypatch, "_characters_to_point_at",
                                lambda main: main._char_store().delete(character["id"]))
    if forget_runs_meanwhile:
        _forget_before_the_second_look(monkeypatch, lambda held: held.forget_item("character", character["id"]))
    refused = _point(client, {"surface": "character", "character": "Mara", "view": 2}, LANE_A, action="look")
    assert refused.status_code == 422, refused.text
    assert presence.active() == [] and presence._agents == {} and _live_names(presence) == []
    assert presence.replay() == [] and _cursors(sent) == []
    if not forget_runs_meanwhile:  # else the deleting route tells the tabs itself
        (leave,) = _told(heard)
        assert leave["type"] == "agentPresenceLeave"
        assert [cursor["key"] for cursor in leave["cursors"] if cursor["key"] is not None] == [before["session"]["key"]]


def test_a_refused_point_leaves_the_sessions_cursor_where_it_was(api, monkeypatch):
    """A cursor at a spot stays there, in the roster and on the tabs alike."""
    client, sent, heard, presence, _ = api
    spot = {"x": 120.0, "y": 80.0}
    assert _point(client, spot, LANE_A).status_code == 200
    character = _make_character(client)
    sent.clear()
    heard.clear()
    _delete_during_first_lookup(monkeypatch, "_characters_to_point_at",
                                lambda main: main._char_store().delete(character["id"]))
    refused = _point(client, {"surface": "character", "character": "Mara"}, LANE_A, action="look")
    assert refused.status_code == 422, refused.text
    assert [live["target"] for live in presence.active()] == [spot]
    assert [cursor["target"] for cursor in presence.replay()] == [spot]
    assert _cursors(sent) == [] and _told(heard) == []


def test_a_refused_point_at_a_cut_view_moves_the_earlier_cursor_on_it_to_the_character(api, monkeypatch):
    client, sent, heard, presence, _ = api
    character = _make_character(client, views=5)
    on_character = {"surface": "character", "itemId": character["id"]}
    assert _point(client, {"surface": "character", "character": character["id"], "view": 5}, LANE_A).status_code == 200
    (before,) = presence.replay()
    sent.clear()
    heard.clear()
    _delete_during_first_lookup(monkeypatch, "_characters_to_point_at",
                                lambda main: main._char_store().update(character["id"], referenceViews=[_url(), _url(), _url()]))
    refused = _point(client, {"surface": "character", "character": character["id"], "view": 5}, LANE_A, action="look")
    assert refused.status_code == 422, refused.text
    assert [live["target"] for live in presence.active()] == [on_character]
    assert [cursor["target"] for cursor in presence.replay()] == [on_character]
    assert _cursors(sent) == []
    (retarget,) = _told(heard)
    assert retarget["type"] == "agentPresenceRetarget"
    assert [(cursor["key"], cursor["target"]) for cursor in retarget["cursors"] if cursor["key"] is not None] == [
        (before["session"]["key"], on_character)]


def test_a_newer_point_is_not_undone_by_a_refused_one():
    from services.agent_presence import identify

    presence, identity = AgentPresence(), identify({"X-Nebula-Agent": "Claude Code"})
    spot, later = {"x": 1.0, "y": 2.0}, {"x": 9.0, "y": 9.0}
    presence.point(identity, target=spot)
    before = presence.plain_cursor(identity)
    presence.point(identity, target={"surface": "character", "itemId": "c1"}, names={"character": "Mara"})
    stored = presence.plain_cursor(identity)
    presence.point(identity, target=later)
    presence.undo_point(identity, stored, before)
    assert [live["target"] for live in presence.active()] == [later]
    presence.undo_point(identity, presence.plain_cursor(identity), before)
    assert [live["target"] for live in presence.active()] == [spot]
    presence.undo_point(identity, presence.plain_cursor(identity), None)
    assert presence.active() == []


def test_a_name_that_is_one_long_character_is_still_a_name():
    """A letter under a hundred combining marks has no safe cut: it is cut plainly, never to nothing."""
    from services.agent_presence import _clean_did, _shown_name

    name = "a" + "\u0301" * 100
    assert _shown_name(name) == name[:80]
    assert _clean_did({"verb": "Added", "label": name})["label"] == name[:80]
    assert _shown_name("  ") == "" and _clean_did({"verb": "Added", "label": "  "})["label"] is None
    _, names = parse_surface_target({"surface": "character", "character": "c1"}, None,
                                    characters=[{"id": "c1", "name": name, "referenceViews": []}])
    assert names == {"character": name[:80]}


def test_a_rename_while_the_point_reads_does_not_refuse_it(api, monkeypatch):
    """The second look is by the stored ids: an item renamed in the window is still there."""
    client, sent, _, presence, _ = api
    character = _make_character(client)
    _delete_during_first_lookup(monkeypatch, "_characters_to_point_at",
                                lambda main: main._char_store().update(character["id"], name="Mara Vance"))
    made = _point(client, {"surface": "character", "character": "Mara"}, LANE_A)
    assert made.status_code == 200, made.text
    assert len(presence.active()) == 1 and len(_cursors(sent)) == 1


# -- GM round 1, R2: a name cut at 80 characters keeps a joined emoji whole ----------------------------

FAMILY = "\U0001F468‍\U0001F469‍\U0001F467"  # man, ZWJ, woman, ZWJ, girl: characters 79 to 83
LONG_NAME = "a" * 78 + FAMILY + "tail"


def test_a_cut_name_never_splits_a_joined_emoji_through_a_point(api):
    client, _, _, presence, _ = api
    character = _make_character(client, name=LONG_NAME)
    assert _point(client, {"surface": "character", "character": character["id"]}, LANE_A).status_code == 200
    names = _live_names(presence)
    assert names and all(shown == {"character": "a" * 78} for shown in names)


def test_a_cut_name_never_splits_a_joined_emoji_through_a_rename(api):
    client, _, _, presence, _ = api
    character = _make_character(client)
    _point(client, {"surface": "character", "character": character["id"], "view": 2}, LANE_A)
    assert client.put(f"/api/characters/{character['id']}", json={"name": LONG_NAME}).status_code == 200
    assert {"character": "a" * 78, "view": 2} in _live_names(presence)


def test_the_parse_and_the_rename_cut_the_same_way():
    names = [parse_surface_target({"surface": "character", "character": "c1"}, None,
                                  characters=[{"id": "c1", "name": LONG_NAME, "referenceViews": []}])[1]["character"]]
    presence, _ = _presence_with({"surface": "character", "itemId": "c1"}, {"character": "x"})
    presence.rename_item("character", "c1", LONG_NAME)
    names.append(presence.active()[0]["anchorNames"]["character"])
    assert names == ["a" * 78, "a" * 78]
