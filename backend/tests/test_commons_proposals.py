"""Commons curation as proposals the person accepts (Justin's Q63 b, 2026-10-20; audit U13).

Agents read the Commons and add to it already; curating it (correcting a
reading, drawing or confirming a region, a reference's role, why or inbox
place in a collection) is the person's. Agents now ask for those through the
asset proposals' path (`POST /api/asset-proposals`, kind ``commons``) and the
person decides in the Commons, on the reference's detail. Accept applies each
edit through the route the Commons UI uses, as the person. Evaluation and
review stay human-only, unchanged.

Every curation write, the person's own and an accepted proposal's, journals a
``commons.*`` event with its actor, so `wait_for_canvas_change` sees it.

No hosted Commons service and no brand data: a local Commons store seeded
here, under this test's own directory.
"""
from __future__ import annotations

import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from commons import actors, intake, records, runtime
from commons.reader import PROMPT_VERSION
from services.canvas_events import CanvasEventJournal

CLAUDE = {"X-Nebula-Agent": "Claude Code"}
KEY = "X-Nebula-Proposal-Key"


class Clock:
    def __init__(self) -> None:
        self.now = 1_760_000_000.0

    def __call__(self) -> float:
        return self.now


def png(seed: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (24, 24, 3), dtype=np.uint8)).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def cx(tmp_path, monkeypatch, person):
    import main as main_module
    from services import asset_proposals

    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    runtime.reset_for_tests()
    store = runtime.get_store()
    open_refs = store.ensure_collection("Open refs", "manual", actor=actors.HUMAN)
    acme_refs = store.ensure_collection("Acme refs", "manual", brand="acme", actor=actors.HUMAN)
    poster = intake.add_bytes(store, png(1), filename="poster.png", collection_id=open_refs["id"],
                              actor=actors.HUMAN, source={"kind": "file"}, why="loud poster")
    records.write_analysis_ok(
        store, poster.asset["id"],
        fields={"summary": {"value": "A loud poster", "why": "big type"},
                "type_style": {"value": "display", "why": "x"},
                "axes": {"quiet_loud": {"value": 0.8, "why": "x"}},
                "keywords": ["poster", "grid"]},
        raw_output="{}", fewshot_ids=[], prompt_version=PROMPT_VERSION, model_id="test-reader",
        vocab_version="1", candidates=[], proposed_regions=[{"box": [0.1, 0.1, 0.3, 0.2], "label": "headline"}],
        duration_ms=1)
    acme_only = intake.add_bytes(store, png(2), filename="acme.png", collection_id=acme_refs["id"],
                                 actor=actors.HUMAN, source={"kind": "file"})
    inbox = intake.add_bytes(store, png(3), filename="found.png", collection_id=open_refs["id"],
                             actor="agent:mcp:cursor", source={"kind": "file"}, in_inbox=True, why="found it")

    book = asset_proposals.AssetProposalBook(Clock())
    journal = CanvasEventJournal()
    sent: list[dict] = []
    browser: list[dict] = []

    async def capture(data):
        sent.append(data)

    async def capture_browser(data):
        browser.append(data)

    monkeypatch.setattr(main_module, "asset_proposals", book)
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture_browser)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.client = TestClient(main_module.app)
    ctx.main = main_module
    ctx.store = store
    ctx.book = book
    ctx.journal = journal
    ctx.sent = sent
    ctx.browser = browser
    ctx.person = person.headers
    ctx.human = {"Authorization": f"Bearer {person.token}"}
    ctx.poster = poster.asset["id"]
    ctx.poster_membership = poster.membership["id"]
    ctx.acme_only = acme_only.asset["id"]
    ctx.inbox = inbox.asset["id"]
    ctx.inbox_membership = inbox.membership["id"]
    ctx.region = records.list_regions(store, poster.asset["id"])[0]["id"]
    yield ctx
    runtime.reset_for_tests()


def _propose(cx, change, *, target=None, headers=CLAUDE, note="Reads quieter to me", brand=None):
    body = {"kind": "commons", "id": target or cx.poster, "change": change, "note": note}
    if brand is not None:
        body["brand"] = brand
    return cx.client.post("/api/asset-proposals", json=body, headers=headers)


def _opened(cx, proposal_id: str) -> dict:
    for message in cx.browser:
        if message.get("type") == "assetProposalOpened" and message["proposal"]["id"] == proposal_id:
            return message
    raise AssertionError("no assetProposalOpened message for the browser")


def _accept(cx, proposal_id: str):
    return cx.client.post(f"/api/asset-proposals/{proposal_id}/accept",
                          headers={**cx.person, KEY: _opened(cx, proposal_id)["acceptKey"]})


def _events(cx, prefix: str = "") -> list[dict]:
    return [event for event in cx.journal.read(after=0, limit=200)["events"] if event["kind"].startswith(prefix)]


def _fields(cx, asset_id=None) -> dict:
    return cx.client.get(f"/api/commons/assets/{asset_id or cx.poster}", headers=cx.human).json()["effective"]["fields"]


# -- the round trip ------------------------------------------------------------------

def test_an_agent_proposes_a_correction_and_the_person_accepts_it_in_the_commons(cx):
    made = _propose(cx, {"correction": {"field_path": "summary", "op": "set", "value": "A quiet grid poster",
                                        "reason": "the type is small"}})
    assert made.status_code == 201, made.text
    view = made.json()["proposal"]
    assert view["id"].startswith("pa_") and view["status"] == "open"
    assert view["kind"] == "commons" and view["decideIn"] == "commons"
    assert view["target"] == {"kind": "commons", "id": cx.poster, "name": ""}
    assert view["change"] == {"edits": [{"correction": {"field_path": "summary.value", "op": "set",
                                                        "value": "A quiet grid poster", "reason": "the type is small"}}]}
    # The reading as it is now is Commons text: only the person's screen gets it.
    assert "A loud poster" not in made.text and "before" not in view
    opened = _opened(cx, view["id"])
    assert opened["proposal"]["before"] == [{"value": "A loud poster"}]
    assert "acceptKey" not in made.text
    assert [e["kind"] for e in _events(cx, "proposal.")] == ["proposal.created"]
    assert _events(cx, "proposal.")[0]["data"]["kind"] == "commons"

    # Nothing changed yet.
    assert _fields(cx)["summary"]["value"] == "A loud poster"
    accepted = _accept(cx, view["id"])
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    assert body["status"] == "accepted" and body["kind"] == "commons"
    assert list(body["applied"]["edits"][0]) == ["correction"]
    detail = cx.client.get(f"/api/commons/assets/{cx.poster}", headers=cx.human).json()
    assert detail["effective"]["fields"]["summary"]["value"] == "A quiet grid poster"
    # The person accepted it, so it is the person's correction (it outranks the model's reading).
    assert detail["corrections"][-1]["actor"] == actors.HUMAN
    assert detail["corrections"][-1]["reason"] == "the type is small"
    assert "summary.value" in detail["effective"]["corrected_paths"]

    corrected = _events(cx, "commons.")
    assert [e["kind"] for e in corrected] == ["commons.corrected"]
    assert corrected[0]["actor"]["kind"] == "person"
    assert corrected[0]["data"] == {"assetId": cx.poster, "fieldPath": "summary.value", "op": "set"}
    assert corrected[0]["summary"].endswith("(accepted from Claude Code)")
    assert [e["kind"] for e in _events(cx, "proposal.")] == ["proposal.created", "proposal.accepted"]
    got = cx.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert got["status"] == "accepted" and got["applied"] == body["applied"]


def test_one_proposal_carries_several_edits_to_one_reference(cx):
    made = _propose(cx, {"edits": [
        {"correction": {"field_path": "keywords", "op": "add", "value": "Brutalist "}},
        {"correction": {"field_path": "type_style.value", "value": "serif"}},
        {"correction": {"field_path": "axes.quiet_loud", "value": -0.4}},
        {"region": {"id": cx.region, "status": "confirmed"}},
        {"region": {"box": [0.5, 0.5, 0.25, 0.25], "label": "logo"}},
        {"membership": {"id": cx.poster_membership, "role": "avoid", "why": "too loud for us"}},
    ]})
    assert made.status_code == 201, made.text
    edits = made.json()["proposal"]["change"]["edits"]
    assert edits[0] == {"correction": {"field_path": "keywords", "op": "add", "value": "brutalist", "reason": None}}
    assert edits[1]["correction"]["op"] == "set"
    assert edits[2]["correction"]["field_path"] == "axes.quiet_loud.value"
    assert edits[3] == {"region": {"id": cx.region, "status": "confirmed"}}
    assert edits[5] == {"membership": {"id": cx.poster_membership, "role": "avoid", "why": "too loud for us"}}
    before = _opened(cx, made.json()["proposal"]["id"])["proposal"]["before"]
    assert before[0] == {"present": False}
    assert before[3]["status"] == "proposed" and before[3]["label"] == "headline"
    assert before[4] is None
    assert before[5] == {"role": "neutral", "why": "loud poster", "in_inbox": False}

    accepted = _accept(cx, made.json()["proposal"]["id"])
    assert accepted.status_code == 200, accepted.text
    fields = _fields(cx)
    assert "brutalist" in fields["keywords"] and fields["type_style"]["value"] == "serif"
    assert fields["axes"]["quiet_loud"]["value"] == -0.4
    regions = {r["label"]: r for r in records.list_regions(cx.store, cx.poster)}
    assert regions["headline"]["status"] == "confirmed"
    assert regions["logo"]["status"] == "confirmed" and regions["logo"]["actor"] == actors.HUMAN
    membership = cx.store.get_membership(cx.poster_membership)
    assert membership["role"] == "avoid" and membership["why"] == "too loud for us"
    kinds = [e["kind"] for e in _events(cx, "commons.")]
    assert kinds == ["commons.corrected"] * 3 + ["commons.region"] * 2 + ["commons.membership"]


def test_an_agent_asks_to_take_a_reference_out_of_the_inbox(cx):
    made = _propose(cx, {"membership": {"id": cx.inbox_membership, "accept": True}}, target=cx.inbox)
    assert made.status_code == 201, made.text
    assert cx.store.get_membership(cx.inbox_membership)["in_inbox"] == 1
    assert _accept(cx, made.json()["proposal"]["id"]).status_code == 200
    assert cx.store.get_membership(cx.inbox_membership)["in_inbox"] == 0
    event = _events(cx, "commons.membership")[0]
    assert event["data"]["change"] == ["accepted"] and event["data"]["membershipId"] == cx.inbox_membership


def test_the_person_says_no(cx):
    view = _propose(cx, {"correction": {"field_path": "summary", "value": "Something else"}}).json()["proposal"]
    rejected = cx.client.post(f"/api/asset-proposals/{view['id']}/reject", json={"reason": "it is loud"},
                              headers={**cx.person, KEY: _opened(cx, view["id"])["acceptKey"]})
    assert rejected.status_code == 200, rejected.text
    assert _fields(cx)["summary"]["value"] == "A loud poster"
    got = cx.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert got["status"] == "rejected" and got["reason"] == "it is loud"


# -- checks when proposing ------------------------------------------------------------

@pytest.mark.parametrize("change, status, words", [
    ({"correction": {"field_path": "analysis.raw_output", "value": "x"}}, 422, "field_path"),
    ({"correction": {"field_path": "palette", "value": []}}, 422, "field_path"),
    ({"correction": {"field_path": "type_style", "value": "comic"}}, 422, "type_style"),
    ({"correction": {"field_path": "axes.quiet_loud", "value": 1.5}}, 422, "-1"),
    ({"correction": {"field_path": "axes.quiet_loud", "value": True}}, 422, "-1"),
    ({"correction": {"field_path": "keywords", "op": "set", "value": ["a"]}}, 422, "add or remove"),
    ({"correction": {"field_path": "summary", "op": "add", "value": "x"}}, 422, "set"),
    ({"correction": {"field_path": "summary", "value": "   "}}, 422, "summary"),
    ({"region": {"box": [0.9, 0.9, 0.5, 0.5], "label": "x"}}, 422, "box"),
    ({"region": {"box": [0.1, 0.1, 0.2, 0.2]}}, 422, "label"),
    ({"region": {"id": "reg_x", "status": "proposed"}}, 422, "status"),
    ({"membership": {"id": "mem_x", "accept": False}}, 422, "accept"),
    ({"membership": {"id": "mem_x", "role": "love"}}, 422, "role"),
    ({"membership": {"role": "avoid"}}, 422, "id"),
    ({"palette": {"hex": "#000000"}}, 422, "correction"),
    ({"correction": {"field_path": "summary", "value": "x"}, "region": {"box": [0, 0, 0.1, 0.1], "label": "y"}},
     422, "edits"),
    ({"edits": []}, 422, "edits"),
    ({"edits": [{"correction": {"field_path": "keywords", "op": "add", "value": f"k{i}"}} for i in range(9)]},
     422, "8"),
])
def test_a_malformed_change_is_refused(cx, change, status, words):
    refused = _propose(cx, change)
    assert refused.status_code == status, refused.text
    assert words in refused.json()["detail"]
    assert cx.book.open_list() == []


def test_the_target_must_be_a_reference_the_agent_can_see(cx):
    missing = _propose(cx, {"correction": {"field_path": "summary", "value": "x"}}, target="ast_missing")
    assert missing.status_code == 404
    # Only in an Acme collection: an agent sees it only for that brand.
    other_brand = _propose(cx, {"correction": {"field_path": "summary", "value": "x"}}, target=cx.acme_only)
    assert other_brand.status_code == 404
    in_brand = _propose(cx, {"correction": {"field_path": "summary", "value": "x"}}, target=cx.acme_only, brand="acme")
    assert in_brand.status_code == 201, in_brand.text
    # A region or membership of another reference is not this one's.
    stray_region = _propose(cx, {"region": {"id": cx.region, "status": "deleted"}}, target=cx.inbox)
    assert stray_region.status_code == 404
    stray_membership = _propose(cx, {"membership": {"id": cx.poster_membership, "role": "avoid"}}, target=cx.inbox)
    assert stray_membership.status_code == 404
    # brand is for the Commons only.
    cover = cx.client.post("/api/asset-proposals", json={"kind": "project", "id": "p", "change": {"cover": ""},
                                                         "note": "x", "brand": "acme"}, headers=CLAUDE)
    assert cover.status_code == 422


def test_a_change_that_is_already_so_is_refused(cx):
    for change in ({"correction": {"field_path": "summary", "value": "A loud poster"}},
                   {"correction": {"field_path": "keywords", "op": "add", "value": "poster"}},
                   {"correction": {"field_path": "keywords", "op": "remove", "value": "nope"}},
                   {"membership": {"id": cx.poster_membership, "role": "neutral"}},
                   {"membership": {"id": cx.poster_membership, "accept": True}},
                   {"region": {"id": cx.region, "label": "headline"}}):
        refused = _propose(cx, change)
        assert refused.status_code == 409, (change, refused.text)
    # Parts already so are dropped from an edit that changes something else.
    kept = _propose(cx, {"membership": {"id": cx.poster_membership, "role": "neutral", "why": "a new why"}})
    assert kept.status_code == 201, kept.text
    assert kept.json()["proposal"]["change"]["edits"] == [{"membership": {"id": cx.poster_membership, "why": "a new why"}}]


def test_only_named_agents_propose_and_the_person_needs_no_proposal(cx):
    assert _propose(cx, {"correction": {"field_path": "summary", "value": "x"}}, headers={}).status_code == 400
    assert _propose(cx, {"correction": {"field_path": "summary", "value": "x"}}, headers=cx.person).status_code == 403


def test_off_when_the_commons_is_off(cx, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "0")
    refused = _propose(cx, {"correction": {"field_path": "summary", "value": "x"}})
    assert refused.status_code == 404 and "Commons" in refused.json()["detail"]


# -- the reference moved on ----------------------------------------------------------

def test_a_proposal_closes_when_the_person_changes_that_field_first(cx):
    view = _propose(cx, {"correction": {"field_path": "summary", "value": "A quiet grid"}}).json()["proposal"]
    key = _opened(cx, view["id"])["acceptKey"]
    direct = cx.client.post(f"/api/commons/assets/{cx.poster}/corrections", headers=cx.human,
                            json={"field_path": "summary.value", "op": "set", "value": "Mine"})
    assert direct.status_code == 200, direct.text
    # The person's own edit sweeps the proposals waiting on that reference.
    assert cx.book.get(view["id"]).status == "invalidated"
    assert "summary" in cx.book.get(view["id"]).reason
    closed = [m for m in cx.sent if m.get("type") == "assetProposalClosed"]
    assert closed and closed[-1]["kind"] == "commons" and closed[-1]["targetId"] == cx.poster
    late = cx.client.post(f"/api/asset-proposals/{view['id']}/accept", headers={**cx.person, KEY: key})
    assert late.status_code == 409
    assert _fields(cx)["summary"]["value"] == "Mine"


def test_a_proposal_closes_when_its_reference_or_membership_goes(cx):
    region = _propose(cx, {"region": {"id": cx.region, "label": "title"}}).json()["proposal"]
    membership = _propose(cx, {"membership": {"id": cx.inbox_membership, "accept": True}},
                          target=cx.inbox).json()["proposal"]
    assert cx.client.patch(f"/api/commons/regions/{cx.region}", json={"status": "deleted"},
                           headers=cx.human).status_code == 200
    assert cx.book.get(region["id"]).status == "invalidated"
    assert cx.client.delete(f"/api/commons/assets/{cx.inbox}", headers=cx.human).status_code == 200
    cx.client.get("/api/asset-proposals")  # any read sweeps
    assert cx.book.get(membership["id"]).status == "invalidated"
    assert "deleted" in cx.book.get(membership["id"]).reason


# -- the journal sees curation, whoever made it ---------------------------------------

def test_the_persons_own_curation_is_journaled_with_the_person_as_actor(cx):
    h = cx.human
    assert cx.client.post(f"/api/commons/assets/{cx.poster}/corrections", headers=h,
                          json={"field_path": "keywords", "op": "add", "value": "swiss"}).status_code == 200
    made = cx.client.post(f"/api/commons/assets/{cx.poster}/regions", headers=h,
                          json={"box": [0.2, 0.2, 0.2, 0.2], "label": "mark"}).json()
    assert cx.client.patch(f"/api/commons/regions/{made['id']}", headers=h, json={"label": "logo"}).status_code == 200
    assert cx.client.patch(f"/api/commons/memberships/{cx.poster_membership}", headers=h,
                           json={"role": "attract"}).status_code == 200
    assert cx.client.post(f"/api/commons/memberships/{cx.inbox_membership}/accept", headers=h).status_code == 200
    events = _events(cx, "commons.")
    assert [e["kind"] for e in events] == ["commons.corrected", "commons.region", "commons.region",
                                           "commons.membership", "commons.membership"]
    assert {e["actor"]["kind"] for e in events} == {"person"}
    assert events[1]["data"] == {"assetId": cx.poster, "regionId": made["id"], "change": ["added"]}
    assert events[2]["data"]["change"] == ["label"]
    assert events[3]["data"]["change"] == ["role"]
    # Never Commons text in the journal: no values, labels or whys.
    flat = repr(events)
    assert "swiss" not in flat and "logo" not in flat
    # wait_for_canvas_change can ask for just these.
    only = cx.client.get("/api/canvas/events", params={"after": 0, "kinds": "commons"}, headers=CLAUDE).json()
    assert len(only["events"]) == 5


def test_agents_still_cannot_curate_evaluate_or_review_directly(cx):
    for method, path, body in (
        ("POST", f"/api/commons/assets/{cx.poster}/corrections", {"field_path": "summary.value", "op": "set", "value": "x"}),
        ("POST", f"/api/commons/assets/{cx.poster}/regions", {"box": [0, 0, 0.1, 0.1], "label": "x"}),
        ("PATCH", f"/api/commons/regions/{cx.region}", {"status": "confirmed"}),
        ("PATCH", f"/api/commons/memberships/{cx.poster_membership}", {"role": "avoid"}),
        ("POST", f"/api/commons/memberships/{cx.inbox_membership}/accept", None),
        ("GET", "/api/commons/evaluation", None),
        ("GET", "/api/commons/review", None),
        ("POST", "/api/commons/review/items/0/propose", {}),
    ):
        for headers in ({"X-Nebula-Client": "claude-code"}, CLAUDE):
            r = cx.client.request(method, path, json=body, headers=headers)
            assert r.status_code == 403, (method, path, r.text)
    # And an agent can't accept its own proposal.
    view = _propose(cx, {"correction": {"field_path": "summary", "value": "x"}}).json()["proposal"]
    forged = cx.client.post(f"/api/asset-proposals/{view['id']}/accept",
                            headers={**CLAUDE, KEY: _opened(cx, view["id"])["acceptKey"]})
    assert forged.status_code == 403
    assert _fields(cx)["summary"]["value"] == "A loud poster"


def test_concentration_is_brand_scoped_for_every_agent(cx):
    from commons import borrow
    from commons.effective import effective

    for asset_id, collection in ((cx.poster, None), (cx.acme_only, "acme")):
        hexes = (effective(cx.store, asset_id)["fields"].get("palette") or [{}])
        borrow.record_borrow(cx.store, actor_id=actors.HUMAN, asset_id=asset_id, attribute="palette",
                             value=hexes[0]["hex"], region_id=None, used_in={"kind": "external", "ref": "x"},
                             why="palette", scope_ids={m["collection"] for m in cx.store.memberships_for_asset(asset_id)})
    outside = {"X-Nebula-Client": "claude-code"}
    unscoped = cx.client.get("/api/commons/concentration", headers=outside).json()
    assert unscoped["total"] == 1 and set(unscoped["by_asset"]) == {cx.poster}
    acme = cx.client.get("/api/commons/concentration", params={"brand": "acme"}, headers=outside).json()
    assert acme["total"] == 2
    assert cx.client.get("/api/commons/concentration", headers=cx.human).json()["total"] == 2


def test_the_cli_prints_a_commons_proposal_as_its_edits(cx):
    from cli.formatter import format_proposal, format_proposal_outcome

    view = _propose(cx, {"edits": [
        {"correction": {"field_path": "summary", "value": "A quiet grid"}},
        {"correction": {"field_path": "keywords", "op": "remove", "value": "grid"}},
        {"region": {"id": cx.region, "status": "confirmed"}},
        {"membership": {"id": cx.poster_membership, "role": "avoid"}},
    ]}).json()["proposal"]
    printed = format_proposal(view)
    assert f"make 4 changes to Commons reference {cx.poster}" in printed
    assert 'summary → "A quiet grid"' in printed
    assert 'keywords − "grid"' in printed
    assert f"region {cx.region}: status confirmed" in printed
    assert f"membership {cx.poster_membership}: role avoid" in printed
    assert "decide in the Commons" in printed
    assert "in the Commons for the person" in format_proposal(view, created=True)
    accepted = {**view, "status": "accepted", "applied": {"edits": [{"correction": "cor_1"}] * 4}}
    assert format_proposal_outcome(accepted) == "Accepted by the person: 4 changes made to the reference."


# -- review fixes (2026-10-20): fences and edits that collide ------------------------

@pytest.fixture
def bound(tmp_path, monkeypatch):
    """Nebula-issued agent sessions bound to one brand's workspace (the in-app agents)."""
    monkeypatch.setattr(actors, "agent_registry", actors.AgentRegistry())

    def session(name: str, brand: str | None) -> dict:
        workspace = tmp_path / f"ws-{name}"
        workspace.mkdir()
        token = actors.agent_registry.mint("codex", [workspace], brand=brand, workspace=workspace)
        return {"Authorization": f"Agent {token}"}

    return session


def test_another_brands_agent_never_sees_a_commons_proposal(cx, bound):
    acme_agent = bound("acme", "acme")
    other_agent = bound("other", "other")
    made = _propose(cx, {"correction": {"field_path": "summary", "value": "The Acme launch poster"}},
                    target=cx.acme_only, headers=acme_agent, note="Acme calls it the launch poster")
    assert made.status_code == 201, made.text
    proposal_id = made.json()["proposal"]["id"]

    # The Commons hides that reference from another brand's session; its proposals too.
    listed = cx.client.get("/api/asset-proposals", headers=other_agent).json()["proposals"]
    assert listed == []
    assert cx.client.get(f"/api/canvas/proposals/{proposal_id}", headers=other_agent).status_code == 404
    assert cx.client.delete(f"/api/canvas/proposals/{proposal_id}", headers=other_agent).status_code == 404
    assert cx.book.get(proposal_id).is_open
    # The proposing session, the person's screen and outside agents naming the brand still see it.
    assert cx.client.get(f"/api/canvas/proposals/{proposal_id}", headers=acme_agent).status_code == 200
    assert [p["id"] for p in cx.client.get("/api/asset-proposals", headers=acme_agent).json()["proposals"]] \
        == [proposal_id]
    assert [p["id"] for p in cx.client.get("/api/asset-proposals").json()["proposals"]] == [proposal_id]
    assert [p["id"] for p in cx.client.get("/api/asset-proposals", headers=cx.person).json()["proposals"]] \
        == [proposal_id]


def test_the_proposer_reads_its_proposal_after_the_reference_went(cx, bound):
    acme_agent = bound("acme", "acme")
    made = _propose(cx, {"correction": {"field_path": "summary", "value": "x"}}, target=cx.acme_only,
                    headers=acme_agent)
    assert made.status_code == 201, made.text
    assert cx.client.delete(f"/api/commons/assets/{cx.acme_only}", headers=cx.human).status_code == 200
    got = cx.client.get(f"/api/canvas/proposals/{made.json()['proposal']['id']}", headers=acme_agent)
    assert got.status_code == 200, got.text
    assert got.json()["proposal"]["status"] == "invalidated"


def test_the_journal_carries_no_note_of_a_commons_proposal(cx):
    view = _propose(cx, {"correction": {"field_path": "summary", "value": "x"}},
                    note="Acme calls it the launch poster").json()["proposal"]
    rejected = cx.client.post(f"/api/asset-proposals/{view['id']}/reject", json={"reason": "Acme keeps its own"},
                              headers={**cx.person, KEY: _opened(cx, view["id"])["acceptKey"]})
    assert rejected.status_code == 200
    events = _events(cx, "proposal.")
    assert [e["kind"] for e in events] == ["proposal.created", "proposal.rejected"]
    assert "launch poster" not in repr(events) and "keeps its own" not in repr(events)
    # assetProposalClosed goes to every socket, agents' too: ids and the status only.
    closed = [m for m in cx.sent if m.get("type") == "assetProposalClosed"]
    assert closed and "keeps its own" not in repr(closed)
    # The proposer still reads the person's reason.
    got = cx.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert got["reason"] == "Acme keeps its own"


def test_a_deleted_region_is_not_one_an_agent_can_propose_on(cx):
    assert cx.client.patch(f"/api/commons/regions/{cx.region}", json={"status": "deleted"},
                           headers=cx.human).status_code == 200
    # commons_get no longer lists it for agents, so it is gone for them.
    refused = _propose(cx, {"region": {"id": cx.region, "status": "confirmed"}})
    assert refused.status_code == 404, refused.text
    refused = _propose(cx, {"region": {"id": cx.region, "label": "title"}})
    assert refused.status_code == 404, refused.text


@pytest.mark.parametrize("edits", [
    [{"correction": {"field_path": "summary", "value": "a"}}, {"correction": {"field_path": "summary.value", "value": "b"}}],
    [{"correction": {"field_path": "keywords", "op": "add", "value": "swiss"}},
     {"correction": {"field_path": "keywords", "op": "remove", "value": "Swiss"}}],
    [{"region": {"id": "reg_1", "label": "a"}}, {"region": {"id": "reg_1", "status": "confirmed"}}],
    [{"membership": {"id": "mem_1", "role": "avoid"}}, {"membership": {"id": "mem_1", "why": "x"}}],
])
def test_two_edits_of_the_same_thing_are_refused(cx, edits):
    refused = _propose(cx, {"edits": edits})
    assert refused.status_code == 422, refused.text
    assert "same" in refused.json()["detail"]


def test_edits_of_different_keywords_and_new_regions_go_together(cx):
    made = _propose(cx, {"edits": [
        {"correction": {"field_path": "keywords", "op": "add", "value": "swiss"}},
        {"correction": {"field_path": "keywords", "op": "add", "value": "bold"}},
        {"region": {"box": [0.1, 0.1, 0.2, 0.2], "label": "a"}},
        {"region": {"box": [0.5, 0.5, 0.2, 0.2], "label": "b"}},
    ]})
    assert made.status_code == 201, made.text
