"""Styles (presets) join Recently deleted like boards and characters, and
agents get them over MCP and the CLI (Justin's Q53 a, 2026-10-20; audit U5).

- DELETE /api/presets/{id} moves a Style to Recently deleted (kind "style");
  anyone may, agents included, since restore_from_trash brings it back.
  Deleting for good stays the person's.
- Every Style change journals ``style.*`` with its actor and broadcasts
  ``storedAssetChanged`` (kind "style"), so wait_for_canvas_change and open
  panels see it.
- style_list / style_get / style_create / style_update / style_delete go
  through the same routes; style_create sends paramsVersion, style_update
  returns ``previous``, which undoes it as one checked write.
"""
from __future__ import annotations

import asyncio
import io
import json
from contextlib import redirect_stdout
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import mcp_server
from nebula_api import NebulaAPI
from services import asset_trash
from services.saved_graph_upgrades import PARAMS_VERSION
from tests.conftest import FORGED_ORIGIN, PERSON
from tests.test_asset_reference_params import AGENT, MCP, api  # noqa: F401

STYLE = {"name": "Neon noir", "category": "My Styles", "prompt": "neon noir, wet streets",
         "params": {"aspect_ratio": "3:4"}, "modelId": "nano-banana", "refImages": [], "scope": "global",
         "paramsVersion": PARAMS_VERSION}


@pytest.fixture
def styles(api, tmp_path, monkeypatch):  # noqa: F811 - pytest fixture reuse
    import main

    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=api.client))
    api.root = tmp_path / "presets"
    api.main = main
    return api


def _make(styles, headers=PERSON, **overrides):
    made = styles.client.post("/api/presets", json={**STYLE, **overrides}, headers=headers)
    assert made.status_code == 200, made.text
    return made.json()


def _changed(styles):
    return [m for m in styles.sent if m.get("type") == "storedAssetChanged" and m.get("kind") == "style"]


def _journal(styles):
    return styles.main.canvas_events.read(after=0, kinds={"style"}, limit=100)["events"]


# -- the store ----------------------------------------------------------------------

def test_the_store_moves_a_deleted_style_to_the_trash_untouched_and_restores_it(tmp_path, monkeypatch):
    from services.preset_store import PresetStore

    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    store = PresetStore()
    style = store.create(name="Dusk", category="Style", prompt="dusk", params={}, modelId=None, refImages=[],
                         scope="global", projectId=None, params_version=PARAMS_VERSION)
    live = tmp_path / "_global" / f"{style['id']}.json"
    raw = live.read_bytes()

    record = store.delete(style["id"], deleted_by={"kind": "agent", "name": "GM - Design"})
    assert record["kind"] == "style" and record["name"] == "Dusk" and record["scopeDir"] == "_global"
    assert not live.exists()
    assert (tmp_path / ".trash" / f"{style['id']}.json").read_bytes() == raw
    # A trashed Style isn't found, listed or editable until it comes back.
    assert store.get(style["id"]) is None
    assert store.list("global") == []
    with pytest.raises(KeyError):
        store.update(style["id"], name="Edited")
    assert store.trashed(style["id"])["deletedBy"] == {"kind": "agent", "name": "GM - Design"}
    assert [item["id"] for item in store.list_trash(scope="global")] == [style["id"]]

    assert store.restore(style["id"]) == style
    assert live.read_bytes() == raw
    assert store.trashed(style["id"]) is None


def test_the_store_purges_only_what_is_in_the_trash(tmp_path, monkeypatch):
    from services.preset_store import PresetStore

    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    store = PresetStore()
    style = store.create(name="Gone", category="Style", prompt="", params={}, modelId=None, refImages=[],
                         scope="global", projectId=None, params_version=PARAMS_VERSION)
    with pytest.raises(KeyError):
        store.purge(style["id"])  # live: never deleted for good from here
    store.delete(style["id"])
    store.purge(style["id"])
    assert store.trashed(style["id"]) is None and store.get(style["id"]) is None


# -- the routes ---------------------------------------------------------------------

def test_an_agent_deletes_a_style_and_restores_it(styles):
    style = _make(styles)
    deleted = styles.client.delete(f"/api/presets/{style['id']}", headers=AGENT)
    assert deleted.status_code == 200, deleted.text
    body = deleted.json()
    assert body["status"] == "trashed" and body["id"] == style["id"]
    assert body["trashed"]["deletedBy"] == {"kind": "agent", "name": "GM - Design"}
    assert body["trashed"]["kind"] == "style"

    gone = styles.client.get(f"/api/presets/{style['id']}")
    assert gone.status_code == 404 and gone.json()["code"] == "in_trash"
    assert "nebula trash restore style" in gone.json()["detail"]
    assert styles.client.get("/api/presets", params={"scope": "global"}).json() == []

    listed = styles.client.get("/api/trash", params={"kind": "style"}, headers=AGENT).json()["items"]
    assert [(item["kind"], item["id"], item["name"]) for item in listed] == [("style", style["id"], "Neon noir")]
    assert ("style", style["id"]) in [(item["kind"], item["id"]) for item in styles.client.get("/api/trash").json()["items"]]

    restored = styles.client.post(f"/api/trash/style/{style['id']}/restore", headers=AGENT)
    assert restored.status_code == 200, restored.text
    assert restored.json()["restored"] == "style" and restored.json()["asset"] == style
    assert styles.client.get(f"/api/presets/{style['id']}").json() == style
    again = styles.client.post(f"/api/trash/style/{style['id']}/restore", headers=PERSON)
    assert again.status_code == 200 and again.json()["alreadyRestored"] is True
    # Open panels hear the save, the delete and the restore.
    assert [m["deleted"] for m in _changed(styles) if m["id"] == style["id"]] == [False, True, False]


def test_saving_a_style_someone_trashed_says_it_is_in_recently_deleted(styles):
    style = _make(styles)
    styles.client.delete(f"/api/presets/{style['id']}", headers=AGENT)
    saved = styles.client.put(f"/api/presets/{style['id']}", headers=PERSON, json={"name": "Edited"})
    assert saved.status_code == 404 and saved.json()["code"] == "in_trash"
    missing = styles.client.put("/api/presets/nothere", headers=PERSON, json={"name": "Edited"})
    assert missing.status_code == 404 and "code" not in missing.json()
    assert styles.client.delete("/api/presets/nothere", headers=AGENT).status_code == 404


@pytest.mark.parametrize("headers", [AGENT, MCP, {}, FORGED_ORIGIN])
def test_only_the_person_deletes_a_style_for_good(styles, headers):
    style = _make(styles)
    styles.client.delete(f"/api/presets/{style['id']}", headers=AGENT)
    for method, path, params in (("DELETE", f"/api/trash/style/{style['id']}", None),
                                 ("POST", "/api/trash/empty", {"kind": "style"})):
        refused = styles.client.request(method, path, headers=headers, params=params)
        assert refused.status_code == 403, refused.text
        assert "You can restore it instead" in refused.json()["detail"]
    from services.preset_store import preset_store

    assert preset_store.trashed(style["id"]) is not None


def test_the_person_deletes_a_style_for_good_or_empties_what_they_saw(styles):
    from services.preset_store import preset_store

    purge, seen, late = _make(styles, name="Purge"), _make(styles, name="Seen"), _make(styles, name="Late")
    for style in (purge, seen):
        styles.client.delete(f"/api/presets/{style['id']}", headers=PERSON)
    assert styles.client.delete(f"/api/trash/style/{purge['id']}", headers=PERSON).json() == {
        "purged": "style", "id": purge["id"]}
    shown = styles.client.get("/api/trash", params={"kind": "style", "scope": "global"}, headers=PERSON).json()["items"]
    styles.client.delete(f"/api/presets/{late['id']}", headers=AGENT)
    emptied = styles.client.post("/api/trash/empty", params={"kind": "style", "scope": "global"}, headers=PERSON,
                                 json={"items": [{"kind": item["kind"], "id": item["id"]} for item in shown]})
    assert emptied.status_code == 200 and emptied.json() == {"purged": 1}
    assert preset_store.trashed(seen["id"]) is None
    assert preset_store.trashed(late["id"]) is not None  # the agent's late delete stays restorable


def test_style_changes_are_journaled_with_their_actor(styles):
    style = _make(styles)
    styles.client.put(f"/api/presets/{style['id']}", headers=AGENT, json={"prompt": "neon noir, rain"})
    styles.client.delete(f"/api/presets/{style['id']}", headers=AGENT)
    styles.client.post(f"/api/trash/style/{style['id']}/restore", headers=PERSON)
    styles.client.delete(f"/api/presets/{style['id']}", headers=PERSON)
    styles.client.delete(f"/api/trash/style/{style['id']}", headers=PERSON)

    events = _journal(styles)
    assert [(event["kind"], event["actor"]["kind"]) for event in events] == [
        ("style.created", "person"), ("style.updated", "agent"), ("style.deleted", "agent"),
        ("style.restored", "person"), ("style.deleted", "person"), ("style.purged", "person")]
    assert events[1]["data"] == {"styleId": style["id"], "styleName": "Neon noir", "scope": "global",
                                 "fields": ["prompt"]}
    assert events[1]["summary"] == "changed the prompt of Style Neon noir"
    assert events[2]["summary"] == "deleted Style Neon noir (in Recently deleted)"


def test_an_update_with_an_old_base_version_is_refused_with_the_style_as_it_is(styles):
    style = _make(styles)
    first = styles.client.put(f"/api/presets/{style['id']}", headers=AGENT,
                              json={"name": "First", "baseVersion": style["version"]})
    assert first.status_code == 200 and first.json()["version"] == style["version"] + 1
    stale = styles.client.put(f"/api/presets/{style['id']}", headers=AGENT,
                              json={"name": "Second", "baseVersion": style["version"]})
    assert stale.status_code == 409
    assert stale.json()["code"] == "version_conflict" and stale.json()["style"]["name"] == "First"
    assert styles.client.put(f"/api/presets/{style['id']}", json={"baseVersion": "2"}).status_code == 422


def test_an_agent_cannot_change_who_bills_a_style_or_write_internal_params(styles):
    refused = styles.client.post("/api/presets", headers=AGENT, json={
        **STYLE, "modelId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}})
    assert refused.status_code == 403 and "_kreaAuth" in refused.json()["detail"]
    refused = styles.client.post("/api/presets", headers=AGENT, json={
        **STYLE, "modelId": "flux-2-pro", "params": {"_provider": "fal"}})
    assert refused.status_code == 403 and "_provider" in refused.json()["detail"]
    internal = styles.client.post("/api/presets", headers=AGENT, json={**STYLE, "params": {"_previewUrl": "x"}})
    assert internal.status_code == 422 and "internal" in internal.json()["detail"]
    unknown = styles.client.post("/api/presets", headers=AGENT, json={**STYLE, "modelId": "no-such-node"})
    assert unknown.status_code == 400 and "find_nodes" in unknown.json()["detail"]

    # The person's own Krea Style keeps its plan billing; an agent's edit that
    # leaves the billing as it is passes, one that switches it doesn't.
    mine = _make(styles, modelId="krea-2-generate", params={"_kreaAuth": "mcp", "aspect_ratio": "1:1"})
    kept = styles.client.put(f"/api/presets/{mine['id']}", headers=AGENT,
                             json={"params": {"_kreaAuth": "mcp", "aspect_ratio": "16:9"}})
    assert kept.status_code == 200, kept.text
    switched = styles.client.put(f"/api/presets/{mine['id']}", headers=AGENT, json={"params": {"aspect_ratio": "4:3"}})
    assert switched.status_code == 403
    assert styles.client.get(f"/api/presets/{mine['id']}").json()["params"] == {"_kreaAuth": "mcp",
                                                                             "aspect_ratio": "16:9"}


def test_seeding_skips_when_the_person_trashed_every_global_style(styles):
    import main

    style = _make(styles)
    styles.client.delete(f"/api/presets/{style['id']}", headers=PERSON)
    main.seed_presets_if_empty()
    assert styles.client.get("/api/presets", params={"scope": "global"}).json() == []


def test_a_style_trashed_from_an_old_folder_is_rehomed_to_global(tmp_path, monkeypatch):
    """A Style deleted from an old working-folder project (contract 07, 1.9)
    moves to Global in Recently deleted too, so a restore lands where the
    live re-home would have put it."""
    from services import asset_project_rehome
    from services.preset_store import PresetStore

    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    store = PresetStore()
    old = store.create(name="Old", category="Style", prompt="", params={}, modelId=None, refImages=[],
                       scope="project", projectId="nebula_nodes", params_version=PARAMS_VERSION)
    store.delete(old["id"])
    spec = next(root for root in asset_project_rehome.default_roots() if root.kind == "preset")
    report = asset_project_rehome.rehome_legacy_assets(
        lambda: {"projects": {}, "trash": {}, "activeProjectId": None}, tmp_path / "state", roots=[spec])
    assert report["moved"] == 1
    record = json.loads((tmp_path / "presets" / ".trash" / f"{old['id']}.trash.json").read_text())
    assert record["scopeDir"] == "_global" and record["projectId"] is None
    restored = store.restore(old["id"])
    assert restored["scope"] == "global" and restored["projectId"] is None


# -- MCP ----------------------------------------------------------------------------

def test_mcp_style_tools_create_edit_delete_and_restore(styles):
    sent: list[tuple[str, str, dict]] = []
    real = NebulaAPI.request

    def spy(self, method, path, **kwargs):
        sent.append((method, path, kwargs.get("json") or {}))
        return real(self, method, path, **kwargs)

    import unittest.mock as mock

    with mock.patch.object(NebulaAPI, "request", spy):
        made = mcp_server.style_create("Dusk", prompt="dusk light", params={"aspect_ratio": "1:1"},
                                       model_id="nano-banana")
    post = next(body for method, path, body in sent if method == "POST" and path == "/api/presets")
    assert post["paramsVersion"] == PARAMS_VERSION  # never read as version 0
    assert made["name"] == "Dusk" and made["scope"] == "global" and made["category"] == "My Styles"

    assert mcp_server.style_get("dusk")["id"] == made["id"]  # by exact name, any case
    assert [style["id"] for style in mcp_server.style_list()] == [made["id"]]

    changed = mcp_server.style_update("Dusk", prompt="dusk light, haze", name="Haze")
    assert changed["style"]["prompt"] == "dusk light, haze" and changed["style"]["name"] == "Haze"
    assert changed["previous"] == {"prompt": "dusk light", "name": "Dusk", "base_version": made["version"] + 1}
    undone = mcp_server.style_update(made["id"], **changed["previous"])
    assert (undone["style"]["name"], undone["style"]["prompt"]) == ("Dusk", "dusk light")
    # The undo is checked: once someone else changed it, the old previous is refused.
    styles.client.put(f"/api/presets/{made['id']}", headers=PERSON, json={"name": "Person's"})
    with pytest.raises(RuntimeError, match="changed since"):
        mcp_server.style_update(made["id"], **undone["previous"])

    deleted = mcp_server.style_delete(made["id"])
    assert deleted["status"] == "trashed" and deleted["restorable"] is True
    assert "restore_from_trash" in deleted["detail"]
    with pytest.raises(RuntimeError, match="Recently deleted"):
        mcp_server.style_get(made["id"])
    assert mcp_server.list_trash("style")["items"][0]["id"] == made["id"]
    assert mcp_server.restore_from_trash("style", made["id"])["restored"] == "style"
    assert mcp_server.style_get(made["id"])["name"] == "Person's"
    actors = {event["actor"]["kind"] for event in _journal(styles) if event["kind"] != "style.updated"}
    assert actors == {"agent"}


def test_mcp_style_list_takes_the_open_project_and_global(styles):
    project_style = _make(styles, scope="project", projectId=styles.project_id, name="Project look")
    global_style = _make(styles, name="House look")
    assert {style["id"] for style in mcp_server.style_list()} == {project_style["id"], global_style["id"]}
    assert [style["id"] for style in mcp_server.style_list(project_id="none")] == [global_style["id"]]
    made = mcp_server.style_create("Here", project_id="current")
    assert made["scope"] == "project" and made["projectId"] == styles.project_id


def test_mcp_style_tools_are_registered_annotated_and_documented():
    from services.krea_agent_mcp import NEBULA_MCP_TOOLS

    names = ("style_list", "style_get", "style_create", "style_update", "style_delete")
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    for name in names:
        assert name in tools and name in NEBULA_MCP_TOOLS
    assert tools["style_list"].annotations.readOnlyHint is True
    assert tools["style_get"].annotations.readOnlyHint is True
    assert tools["style_create"].annotations.destructiveHint is False
    assert tools["style_update"].annotations.destructiveHint is False
    assert tools["style_delete"].annotations.destructiveHint is True
    assert "Styles" in mcp_server.INSTRUCTIONS and "style_delete" in mcp_server.INSTRUCTIONS
    docs = (Path(__file__).resolve().parents[2] / "docs" / "MCP-SETUP.md").read_text(encoding="utf-8")
    skill = (Path(__file__).resolve().parents[2] / "skills" / "nebula" / "SKILL.md").read_text(encoding="utf-8")
    for name in names:
        assert f"`{name}`" in docs
    assert "nebula style" in skill and "nebula trash restore style" in skill


# -- CLI ----------------------------------------------------------------------------

def _cli(styles, argv, capsys):
    from cli.__main__ import build_parser
    from cli.client import NebulaClient
    from cli.commands import style as style_cmd

    client = NebulaClient("http://testserver")
    client._client = styles.client
    args = build_parser().parse_args(argv)
    style_cmd.run(client, args)
    return capsys.readouterr().out


def test_cli_style_commands(styles, capsys):
    out = _cli(styles, ["style", "new", "Dusk", "--prompt", "dusk light", "--params", '{"aspect_ratio": "1:1"}',
                        "--json"], capsys)
    made = json.loads(out)
    assert made["name"] == "Dusk" and made["params"] == {"aspect_ratio": "1:1"}
    assert made["paramsVersion"] == PARAMS_VERSION
    assert f"{made['id']}  Dusk" in _cli(styles, ["style", "list"], capsys)
    assert "dusk light" in _cli(styles, ["style", "show", "Dusk"], capsys)
    changed = json.loads(_cli(styles, ["style", "set", "Dusk", "--prompt", "haze", "--json"], capsys))
    assert changed["previous"]["prompt"] == "dusk light"
    out = _cli(styles, ["style", "delete", "Dusk"], capsys)
    assert f"nebula trash restore style {made['id']}" in out
    assert styles.client.get(f"/api/presets/{made['id']}").json()["code"] == "in_trash"


def test_cli_trash_takes_the_style_kind(styles, monkeypatch):
    from cli.__main__ import build_parser
    from cli.client import NebulaClient
    from cli.commands import trash

    parser = build_parser()
    assert parser.parse_args(["trash", "list", "--kind", "style"]).kind == "style"
    style = _make(styles, name="CLI style")
    styles.client.delete(f"/api/presets/{style['id']}", headers=AGENT)
    client = NebulaClient("http://testserver")
    monkeypatch.setattr(client, "_request", lambda method, path, **kw: styles.client.request(
        method, path, headers=AGENT, params=kw.get("params")).json())
    # `trash list` reads through project_client (MCP list_trash's code), on the client's connection.
    client._client = styles.client
    out = io.StringIO()
    with redirect_stdout(out):
        assert trash.run_list(client, kind="style") == 0
        assert trash.run_restore(client, ["style", style["id"]]) == 0
    assert f"style     {style['id']}  CLI style  [global]" in out.getvalue()
    assert styles.client.get(f"/api/presets/{style['id']}").status_code == 200
    assert asset_trash.TRASH_DIR == ".trash"


# -- review fixes (2026-10-20) ------------------------------------------------------

def test_an_agents_params_update_keeps_the_internal_params_so_its_previous_undoes_it(styles):
    """An agent can't write internal (``_``) params, so it can't take them off
    either: a ``params`` update that leaves them out keeps the Style's own,
    and the ``previous`` it returns puts the Style back exactly."""
    original = {"_provider": "auto", "_previewUrl": "/api/outputs/x.png", "aspect_ratio": "1:1"}
    mine = _make(styles, modelId="flux-2-pro", params=original)
    changed = mcp_server.style_update(mine["id"], params={"aspect_ratio": "16:9"})
    assert changed["style"]["params"]["_previewUrl"] == "/api/outputs/x.png"
    assert changed["style"]["params"]["aspect_ratio"] == "16:9"
    undone = mcp_server.style_update(mine["id"], **changed["previous"])
    assert undone["style"]["params"] == original
    # The person's own save still replaces the settings whole.
    saved = styles.client.put(f"/api/presets/{mine['id']}", headers=PERSON, json={"params": {"aspect_ratio": "4:3"}})
    assert saved.status_code == 200 and saved.json()["params"] == {"aspect_ratio": "4:3"}


def test_starter_styles_stay_gone_once_the_person_deletes_them_for_good(styles):
    import main

    main.seed_presets_if_empty()
    starters = styles.client.get("/api/presets", params={"scope": "global"}).json()
    assert starters  # a first start seeds them
    for style in starters:
        styles.client.delete(f"/api/presets/{style['id']}", headers=PERSON)
    assert styles.client.post("/api/trash/empty", params={"kind": "style"}, headers=PERSON).status_code == 200
    main.seed_presets_if_empty()  # the next start
    assert styles.client.get("/api/presets", params={"scope": "global"}).json() == []


def test_an_agents_refused_style_billing_says_what_it_can_do(styles):
    """A Style change can't be proposed, so the refusal doesn't send the
    agent to propose_change."""
    for model, params, key in (("flux-2-pro", {"_provider": "fal"}, "_provider"),
                               ("krea-2-generate", {"_kreaAuth": "mcp"}, "_kreaAuth")):
        refused = styles.client.post("/api/presets", headers=AGENT, json={**STYLE, "modelId": model, "params": params})
        assert refused.status_code == 403
        detail = refused.json()["detail"]
        assert key in detail and "propose_change" not in detail and "Create" in detail
