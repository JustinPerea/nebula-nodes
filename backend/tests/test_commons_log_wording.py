"""GM, PR #202 r4: how an asset proposal's ask and its withdrawal read in the
Agent log ("Asks to X (decide …)" / "Withdrew its request to X"), X built
once by the shared helper (asset_proposals.summary). Agents read the log, so a
Commons line names no reference by its id, filename, page title or collection,
and carries no Commons text: "an image in the Commons" everywhere."""
from __future__ import annotations

import re

import pytest

from commons import actors, intake
from services import asset_proposals, commons_proposals
from services.agent_presence import AgentIdentity
from tests.test_asset_proposals import A, C, CLAUDE as ASSET_CLAUDE, _pin, _propose as _propose_asset, api  # noqa: F401
from tests.test_commons_proposals import CLAUDE, _propose, cx, png  # noqa: F401

REF = "an image in the Commons"

# Every Commons kind the helper words: (the ask's change, X).
COMMONS_KINDS = [
    ("role", lambda cx: {"membership": {"id": cx.poster_membership, "role": "avoid"}}, f"set {REF} to avoid"),
    ("new region", lambda cx: {"region": {"label": "headline", "box": [0.5, 0.5, 0.2, 0.2]}}, f"add a region to {REF}"),
    ("several", lambda cx: {"edits": [
        {"correction": {"field_path": "type_style.value", "value": "serif"}},
        {"correction": {"field_path": "axes.quiet_loud", "value": -0.4}},
        {"correction": {"field_path": "summary", "op": "set", "value": "A quiet grid poster"}}]},
     f"make 3 changes to {REF}"),
    ("keyword add", lambda cx: {"correction": {"field_path": "keywords", "op": "add", "value": "brutalist"}},
     f"add a keyword to {REF}"),
    ("keyword remove", lambda cx: {"correction": {"field_path": "keywords", "op": "remove", "value": "grid"}},
     f"remove a keyword from {REF}"),
    ("field", lambda cx: {"correction": {"field_path": "type_style.value", "value": "serif"}},
     f"correct the type style of {REF}"),
    ("region confirm", lambda cx: {"region": {"id": cx.region, "status": "confirmed"}}, f"confirm a region of {REF}"),
    ("region delete", lambda cx: {"region": {"id": cx.region, "status": "deleted"}}, f"delete a region of {REF}"),
    ("region change", lambda cx: {"region": {"id": cx.region, "label": "masthead"}}, f"change a region of {REF}"),
    ("why", lambda cx: {"membership": {"id": cx.poster_membership, "why": "it is loud"}},
     f"change why {REF} is in a collection"),
]


def _log(sent: list[dict]) -> list[tuple[str, str]]:
    """The Agent log rows: (agent, words), as the frontend's agentActionEntry reads them."""
    return [((event.get("agent") or {}).get("name", ""), event.get("log") or event.get("say") or "")
            for event in sent if event.get("type") == "agentPresence" and (event.get("log") or event.get("say"))]


def _ask_and_withdraw(cx, change, *, target=None) -> tuple[str, str]:
    start = len(cx.sent)
    made = _propose(cx, change, target=target)
    assert made.status_code == 201, made.text
    assert cx.client.delete(f"/api/canvas/proposals/{made.json()['proposal']['id']}", headers=CLAUDE).status_code == 200
    lines = [words for who, words in _log(cx.sent[start:]) if who == "Claude Code"]
    (ask,) = [line for line in lines if line.startswith("Asks to ")]
    (withdrew,) = [line for line in lines if line.startswith("Withdrew ")]
    return ask, withdrew


@pytest.mark.parametrize("name,change,what", COMMONS_KINDS, ids=[kind[0] for kind in COMMONS_KINDS])
def test_every_commons_kind_asks_and_withdraws_in_the_same_words(cx, name, change, what):
    ask, withdrew = _ask_and_withdraw(cx, change(cx))
    assert ask == f"Asks to {what} (decide in the Commons)"
    assert withdrew == f"Withdrew its request to {what}"


def test_an_inbox_ask_and_its_withdrawal(cx):
    ask, withdrew = _ask_and_withdraw(cx, {"membership": {"id": cx.inbox_membership, "accept": True}}, target=cx.inbox)
    assert ask == f"Asks to take {REF} out of the inbox (decide in the Commons)"
    assert withdrew == f"Withdrew its request to take {REF} out of the inbox"


def test_cover_asks_and_withdrawals(api):
    _pin(api, A, api.person)
    for change, what in (({"cover": C}, "make another image the cover of “Dusk”"),
                         ({"cover": None}, "set the cover of “Dusk” back to automatic")):
        start = len(api.sent)
        view = _propose_asset(api, change).json()["proposal"]
        assert api.client.delete(f"/api/canvas/proposals/{view['id']}", headers=ASSET_CLAUDE).status_code == 200
        lines = [words for _, words in _log(api.sent[start:])]
        assert f"Asks to {what} (decide on the Projects screen)" in lines
        assert f"Withdrew its request to {what}" in lines


def test_a_moodboard_ask_and_its_withdrawal(api):
    from tests.test_asset_proposals import _board

    board = _board(api)
    start = len(api.sent)
    view = _propose_asset(api, {"sendNotes": True}, kind="moodboard", target=board["id"]).json()["proposal"]
    assert api.client.delete(f"/api/canvas/proposals/{view['id']}", headers=ASSET_CLAUDE).status_code == 200
    lines = [words for _, words in _log(api.sent[start:])]
    what = f"send the notes of “{board['name']}” to generators"
    assert f"Asks to {what} (decide in Moodboard Studio)" in lines
    assert f"Withdrew its request to {what}" in lines


def test_the_helper_words_each_kind_once():
    agent = AgentIdentity(id="c", name="Claude Code", color="#E8825A", verified=True)

    def proposal(kind, change, name=""):
        return asset_proposals.AssetProposal(id="pa_x", agent=agent, kind=kind, target_id="ast_0123456789abcdef",
                                             target_name=name, change=change, before={}, note="", created_at=1.0,
                                             expires_at=2.0)

    assert asset_proposals.summary(proposal("project", {"cover": None}, "Dusk")) == "set the cover of “Dusk” back to automatic"
    assert asset_proposals.summary(proposal("project", {"cover": "/api/outputs/c.png"}, "Dusk")) == \
        "make another image the cover of “Dusk”"
    assert asset_proposals.summary(proposal("moodboard", {"sendNotes": True}, "Dusk board")) == \
        "send the notes of “Dusk board” to generators"
    assert asset_proposals.summary(proposal("commons", {"edits": [{"membership": {"id": "mem_1", "role": "attract"}}]})) == \
        f"set {REF} to attract"
    assert commons_proposals.summary("ast_0123456789abcdef", {"edits": [{"region": {"label": "x", "box": [0, 0, 1, 1]}}]}) == \
        f"add a region to {REF}"


# -- the ratchet: nothing private reaches a Commons log line ----------------------------

SECRETS = {
    "label": "Secret Label Text", "value": "Secret Field Value", "why": "Secret Why Text", "new why": "Another Secret Why", "keyword": "secretkeyword",
    "note": "Secret Agent Note", "filename": "secret-file-name.png", "page title": "Secret Page Title",
    "page url": "https://example.test/secret-page", "collection": "Open refs",
}


def test_no_commons_log_line_carries_an_id_a_filename_a_page_title_or_commons_text(cx):
    """Fixtures that hold each private thing; every Commons kind is asked and
    withdrawn against them; no log line may carry any of it."""
    collection = cx.store.ensure_collection(SECRETS["collection"], "manual", actor=actors.HUMAN)
    secret = intake.add_bytes(cx.store, png(9), filename=SECRETS["filename"], collection_id=collection["id"],
                              actor=actors.HUMAN, why=SECRETS["why"],
                              source={"kind": "url", "url": SECRETS["page url"], "page_url": SECRETS["page url"],
                                      "page_title": SECRETS["page title"]})
    asset, membership = secret.asset["id"], secret.membership["id"]
    changes = [
        {"membership": {"id": membership, "role": "avoid", "why": SECRETS["why"]}},
        {"membership": {"id": membership, "why": SECRETS["new why"]}},
        {"region": {"label": SECRETS["label"], "box": [0.5, 0.5, 0.2, 0.2]}},
        {"correction": {"field_path": "keywords", "op": "add", "value": SECRETS["keyword"]}},
        {"correction": {"field_path": "summary", "op": "set", "value": SECRETS["value"], "reason": SECRETS["why"]}},
        {"edits": [{"correction": {"field_path": "summary", "op": "set", "value": SECRETS["value"]}},
                   {"region": {"label": SECRETS["label"], "box": [0.1, 0.1, 0.2, 0.2]}}]},
    ]
    start = len(cx.sent)
    for change in changes:
        made = _propose(cx, change, target=asset, note=SECRETS["note"])
        assert made.status_code == 201, made.text
        assert cx.client.delete(f"/api/canvas/proposals/{made.json()['proposal']['id']}", headers=CLAUDE).status_code == 200
    # The same on the fixture's reference, with its region, analysis and inbox.
    for _, change, _ in COMMONS_KINDS:
        made = _propose(cx, change(cx), note=SECRETS["note"])
        assert made.status_code == 201, made.text
        cx.client.delete(f"/api/canvas/proposals/{made.json()['proposal']['id']}", headers=CLAUDE)
    lines = [words for _, words in _log(cx.sent[start:])]
    assert len(lines) >= 2 * (len(changes) + len(COMMONS_KINDS))
    ids = {asset, membership, cx.poster, cx.poster_membership, cx.region, cx.inbox, cx.inbox_membership, collection["id"]}
    for line in lines:
        assert not re.search(r"\b(?:ast|mem|reg|col)_[0-9a-z]+", line), line
        for name, text in SECRETS.items():
            assert text.lower() not in line.lower(), (name, line)
        for private in ids | {"poster.png", "found.png", "headline", "A loud poster", "big type", "loud poster",
                              "found it", "masthead", "brutalist", "A quiet grid poster", "it is loud"}:
            assert private not in line, (private, line)
