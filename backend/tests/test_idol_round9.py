"""PR #203 round 9: one key state and one cost class for every surface.

- GM r17 item 1 (review 8, LOW-1): a key that is empty once trimmed reads as
  not set everywhere, through node_route.key_text, a value already stored
  that way included; PUT /api/settings and the desktop credential bridge
  refuse it, as the Settings field does.
- GM r17 item 2 (review 8, LOW-2): the re-ask over an Idol-only "may cost"
  placeholder has no total line (Idol adds nothing to any estimate), and the
  409's fallback message says "may cost", never "paid".
- Review 8, LOW-3: the gate, the billing note and the label read the one cost
  class (node_route.key_billing, key_billing_account), and the frontend's
  twin agrees case by case (tests/fixtures/key_billing_cases.json).
- Review 8, NIT-2: the billing note states the downstream rule.
- Review 8, NIT-3: every key change tells every socket, with no values.
- Review 8, NIT-4: the refusal names MCP's tool; the CLI prints its command.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from services import node_route
from services.node_registry import NodeRegistry
from tests.conftest import PERSON
from tests.test_idol_may_bill import SIGNED_IN, _execute, _idol_placeholder, gated  # noqa: F401 - fixture
from tests.test_canvas_proposals import _propose, api  # noqa: F401 - fixture
from tests.test_idol_proposal_cost import keyed  # noqa: F401 - fixture
from tests.test_pending_nodes import pend  # noqa: F401 - fixture
from services import model_pricing

FIXTURES = Path(__file__).parent / "fixtures"
KEY_CASES = json.loads((FIXTURES / "key_text_cases.json").read_text(encoding="utf-8"))["cases"]
UNSET = [case["raw"] for case in KEY_CASES if isinstance(case["raw"], str) and case["raw"] and not case["text"]]
BILLING_CASES = json.loads((FIXTURES / "key_billing_cases.json").read_text(encoding="utf-8"))["cases"]
DEFINITIONS = NodeRegistry().get_all()


# -- one cost class (review 8, LOW-3) --------------------------------------------------------


@pytest.mark.parametrize("case", BILLING_CASES, ids=lambda c: f"{c['params']}-{c['apiKeys']!r}")
def test_the_backend_gives_each_shared_key_billing_case(case):
    definition = DEFINITIONS[case["definitionId"]]
    kind = node_route.key_billing(definition, case["params"], case["apiKeys"])
    account = node_route.key_billing_account(definition, case["params"], case["apiKeys"])
    assert (kind, account) == (case["kind"], case["account"])
    assert (node_route.key_billing_label(kind, account) if kind else None) == case["label"]


def test_the_shared_cases_cover_every_key_billing_definition():
    flagged = {definition["id"] for definition in DEFINITIONS.values()
               if node_route.has_routes(definition) and node_route.key_billing(definition, {}, {}) is not None}
    assert flagged and flagged == {case["definitionId"] for case in BILLING_CASES}


@pytest.mark.parametrize("keys", [{}, SIGNED_IN, {"HF_TOKEN": "​"}, {"OPENAI_API_KEY": "sk-x"}])
def test_the_gate_reads_the_cost_class_for_every_definition(keys):
    for definition in DEFINITIONS.values():
        routes = node_route.routes_of(definition) if node_route.has_routes(definition) else []
        for params in [{}, *({"_provider": route["id"]} for route in routes)]:
            assert node_route.may_bill(definition, params, keys) == (
                node_route.key_billing(definition, params, keys) == node_route.MAY_COST), definition["id"]


def test_the_billing_note_reads_the_cost_class():
    idol = DEFINITIONS["speridlabs-idol"]
    assert main._space_billing(idol, {}) == main.HF_SPACE_BILLING_FREE
    assert main._space_billing(idol, SIGNED_IN) == main.HF_SPACE_BILLING_TOKEN
    # Unset once trimmed: free, as the gate reads it.
    assert main._space_billing(idol, {"HF_TOKEN": "﻿​"}) == main.HF_SPACE_BILLING_FREE
    # A node with no key-billing route has no note.
    assert main._space_billing(DEFINITIONS["nano-banana"], SIGNED_IN) is None
    rows = main._describe_routes(idol, SIGNED_IN, lambda _route: [])["routes"]
    assert [row["billing"] for row in rows] == [main.HF_SPACE_BILLING_TOKEN]


def test_a_key_billing_route_that_is_no_space_gets_its_note_from_the_class():
    """A flagged route on another handler: the note follows key_billing, not
    the handler, so it can't contradict the gate."""
    idol = json.loads(json.dumps(DEFINITIONS["speridlabs-idol"]))
    idol["routes"][0]["handler"] = "fal"
    idol["routes"][0]["provider"] = "fal"
    assert main._space_billing(idol, {}) == main.HF_SPACE_BILLING_FREE
    assert node_route.key_billing_account(idol, {}, {}) == "fal.ai"
    plain = json.loads(json.dumps(DEFINITIONS["speridlabs-idol"]))
    del plain["routes"][0]["mayBillWithKey"]
    assert main._space_billing(plain, SIGNED_IN) is None


def test_the_billing_note_states_the_downstream_rule():
    """Review 8, NIT-2: an agent that reads only describe_node or find_nodes
    learns the rule before its first refusal."""
    assert "or any run that includes it, even for a node after it" in main.HF_SPACE_BILLING_TOKEN
    assert "or any run that includes it" in main.HF_SPACE_BILLING_FREE


# -- one key state (GM r17 item 1; review 8, LOW-1) ------------------------------------------


@pytest.fixture
def stored(tmp_path, monkeypatch, person):
    path = tmp_path / "settings.json"
    monkeypatch.setattr(settings, "SETTINGS_PATH", path)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    monkeypatch.setattr(main, "load_settings", settings.load_settings)
    monkeypatch.setattr(main, "save_settings", settings.save_settings)
    monkeypatch.setattr(main, "is_injected_mode", settings.is_injected_mode)
    broadcast = AsyncMock()
    monkeypatch.setattr(main.manager, "broadcast_raw", broadcast)
    # Round 10 (review 9, keys LOW-1): the signal goes to the person's tabs only.
    monkeypatch.setattr(main.manager, "broadcast_browser", broadcast)

    def write(keys):
        path.write_text(json.dumps({"apiKeys": keys}), encoding="utf-8")

    return TestClient(main.app, headers=PERSON), path, write, broadcast


@pytest.mark.parametrize("raw", UNSET, ids=repr)
def test_a_key_already_stored_empty_once_trimmed_reads_as_not_set_everywhere(stored, raw):
    client, _path, write, _broadcast = stored
    write({"HF_TOKEN": raw, "OPENAI_API_KEY": "sk-fixture-1234"})
    # The masked keys the canvas reads: unset, so its class agrees with the gate.
    keys = client.get("/api/settings").json()["apiKeys"]
    assert keys.get("HF_TOKEN", "") == "" and keys["OPENAI_API_KEY"] == "***1234"
    # Every backend reader gets the keys through load_settings.
    assert "HF_TOKEN" not in settings.load_settings()["apiKeys"]
    assert settings.get_api_key("HF_TOKEN") is None
    route = client.get("/api/agent/nodes/speridlabs-idol").json()["routes"][0]
    assert route["optionalKeys"] == [{"key": "HF_TOKEN", "set": False}]
    assert route["billing"] == main.HF_SPACE_BILLING_FREE


def test_a_padded_stored_key_reads_trimmed(stored):
    client, _path, write, _broadcast = stored
    write({"HF_TOKEN": "﻿ hf_padded_token_9876\n​"})
    assert settings.load_settings()["apiKeys"]["HF_TOKEN"] == "hf_padded_token_9876"
    assert client.get("/api/settings").json()["apiKeys"]["HF_TOKEN"] == "***9876"


@pytest.mark.parametrize("raw", UNSET, ids=repr)
def test_put_refuses_a_key_that_is_empty_once_trimmed(stored, raw):
    client, path, write, broadcast = stored
    write({"HF_TOKEN": "hf_kept_token_1111", "OPENAI_API_KEY": "sk-kept-2222"})
    before = path.read_text()
    for name in ("HF_TOKEN", "OPENAI_API_KEY"):
        response = client.put("/api/settings", json={"apiKeys": {name: raw}})
        assert response.status_code == 400, (name, response.text)
        assert response.json()["detail"] == main.KEY_ONLY_INVISIBLE
    assert path.read_text() == before
    broadcast.assert_not_called()


def test_put_refuses_a_hugging_face_token_with_a_character_no_token_has(stored):
    client, path, write, _broadcast = stored
    write({})
    response = client.put("/api/settings", json={"apiKeys": {"HF_TOKEN": "hf_ab cd"}})
    assert response.status_code == 400 and response.json()["detail"] == settings.HF_TOKEN_CHARACTER_LINE


def test_put_stores_every_key_trimmed_and_an_empty_value_changes_nothing(stored):
    client, path, write, _broadcast = stored
    write({"OPENAI_API_KEY": "sk-kept-2222"})
    response = client.put("/api/settings", json={"apiKeys": {"HF_TOKEN": "﻿hf_new_token_3333\n",
                                                             "FAL_KEY": " fal-key-4444 ", "OPENAI_API_KEY": ""}})
    assert response.status_code == 200, response.text
    saved = json.loads(path.read_text())["apiKeys"]
    assert saved == {"OPENAI_API_KEY": "sk-kept-2222", "HF_TOKEN": "hf_new_token_3333", "FAL_KEY": "fal-key-4444"}


# -- every key change tells every socket (review 8, NIT-3) -----------------------------------


def _signals(broadcast):
    return [call.args[0] for call in broadcast.call_args_list if call.args and call.args[0].get("type") == "settingsChanged"]


def test_each_key_change_tells_every_socket_with_no_values(stored, monkeypatch):
    client, _path, write, broadcast = stored
    write({"OPENAI_API_KEY": "sk-kept-2222"})
    # Round 10 (GM, PR #203 r19 item 7): the names of the keys that changed, never a value.
    signal = {"type": "settingsChanged", "keys": ["HF_TOKEN"]}
    assert client.put("/api/settings", json={"apiKeys": {"HF_TOKEN": "hf_signal_token_5555"}}).status_code == 200
    assert _signals(broadcast) == [signal]
    assert client.delete("/api/settings/api-keys/HF_TOKEN").status_code == 200
    assert _signals(broadcast) == [signal] * 2
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-desktop"})
    assert client.post("/api/credentials/update", json={"provider": "HF_TOKEN", "key": "hf_desktop_6666"}).status_code == 200
    assert _signals(broadcast) == [signal] * 3
    # No value travels: not a key, not a mask.
    assert "6666" not in json.dumps(broadcast.call_args_list[-1].args[0])


def test_a_token_set_from_a_second_client_reaches_an_open_socket(tmp_path, monkeypatch, person):
    """The canvas's socket is open; another client (a second window, a script
    with the person token, the desktop bridge) sets the token: the socket hears it."""
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"apiKeys": {}}), encoding="utf-8")
    monkeypatch.setattr(settings, "SETTINGS_PATH", path)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    monkeypatch.setattr(main, "load_settings", settings.load_settings)
    monkeypatch.setattr(main, "save_settings", settings.save_settings)
    tab = TestClient(main.app)
    other = TestClient(main.app, headers=PERSON)
    with tab.websocket_connect("/ws", headers=PERSON) as socket:
        # The person's tab (round 10: the signal goes to their tabs only).
        socket.send_json({"type": "hello", "personToken": PERSON["X-Nebula-Person"]})
        assert other.put("/api/settings", json={"apiKeys": {"HF_TOKEN": "hf_second_client_7777"}}).status_code == 200
        # A marker sent after the PUT answered, so a backend that sends
        # nothing fails here instead of waiting for ever.
        socket.portal.call(main.manager.broadcast_raw, {"type": "testMarker"})
        heard = []
        for _ in range(50):
            message = socket.receive_json()
            if message.get("type") == "testMarker":
                break
            if message.get("type") == "settingsChanged":
                heard.append(message)
        assert heard == [{"type": "settingsChanged", "keys": ["HF_TOKEN"]}]


# -- the placeholder re-ask (GM r17 item 2; review 8, LOW-2) ---------------------------------


def test_the_reask_over_an_idol_only_may_cost_placeholder_has_no_total(gated):  # noqa: F811
    gated.keys(SIGNED_IN)
    idol = _idol_placeholder(gated)
    response = _execute(gated, PERSON, "r-may9", idol)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    # Idol adds nothing to the estimate: no line for it, no total.
    assert idol not in detail["estimate"]["nodes"] and detail["estimate"]["high"] is None
    assert detail["estimate"]["unpriced"] == []
    assert "may cost" in detail["message"] and "paid" not in detail["message"]
    assert detail["message"].startswith("Nothing ran. This run includes 1 node that may cost, which ")


def test_the_409_counts_paid_and_may_cost_apart():
    refusal = main._placeholder_confirm_refusal("r-mixed", ["n1", "n2", "n3"], None, may_cost=["n3"])
    assert "This run includes 2 paid nodes and 1 that may cost, which " in refusal.detail["message"]
    plain = main._placeholder_confirm_refusal("r-paid", ["n1"], None)
    assert "This run includes 1 paid node " in plain.detail["message"]


# -- the refusal per surface (review 8, NIT-4) -----------------------------------------------


def test_the_refusal_names_mcps_tool_and_the_cli_prints_its_command(capsys):
    """Round 10 (review 9, keys MEDIUM-1): each surface's words are written
    where the refusal is, and the CLI prints it as it came."""
    from cli.client import NebulaClient
    from nebula_api import NebulaAPIError

    hint = main.agent_spend.propose_hint(["n2", "n5"])
    assert "propose_change (run: n2, n5)" in hint and "nebula propose" not in hint
    cli = main.agent_spend.propose_hint(["n2", "n5"], "cli")
    assert '`nebula propose --note "<why>" --run n2 --run n5`' in cli and "propose_change" not in cli
    client = NebulaClient.__new__(NebulaClient)
    client.base_url = "http://127.0.0.1:1"
    with pytest.raises(SystemExit):
        client._fail(NebulaAPIError(f"Needs the person's approval: x. {cli}", status=403), "POST /api/execute")
    printed = capsys.readouterr().err
    assert printed == f"error: Needs the person's approval: x. {cli}\n"


# -- the Accept chip's reasons (GM r17 item 4) -----------------------------------------------


def test_the_estimate_names_why_each_paid_node_leaves_the_total_open():
    pricing = {"nodes": {"gpt-image-2-edit": {"currency": "usd", "per": "image", "plus": "input images",
                                              "rows": [{"match": {}, "price": [0.01, 0.2]}]}}}
    items = [{"id": "e", "definitionId": "gpt-image-2-edit", "params": {}, "name": "Edit"},
             {"id": "c", "definitionId": "claude-chat", "params": {}, "name": "Writer"},
             {"id": "i", "definitionId": "speridlabs-idol", "params": {}, "name": "Idol"}]
    result = model_pricing.estimate_run(items, pricing, DEFINITIONS, {**SIGNED_IN, "OPENAI_API_KEY": "k",
                                                                      "ANTHROPIC_API_KEY": "k"})
    assert result["reasons"] == {"e": {"kind": "leftOut", "plus": "input images"}, "c": {"kind": "noPrice"}}


def test_a_proposals_paid_entries_carry_their_reason(keyed):  # noqa: F811
    keyed.keys({**SIGNED_IN, "GEMINI_API_KEY": "k", "ANTHROPIC_API_KEY": "k"})
    text = keyed.graph.add_node("text-input", {"value": "a cat"})
    keyed.graph.nodes[text]["outputs"] = {"text": {"type": "Text", "value": "a cat"}}
    body = {"note": "a picture and a caption",
            "nodes": [{"ref": "+img", "definitionId": "nano-banana", "params": {}},
                      {"ref": "+chat", "definitionId": "claude-chat", "params": {}}],
            "edges": [{"source": text, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"},
                      {"source": text, "sourceHandle": "text", "target": "+chat", "targetHandle": "messages"}],
            "run": ["+img", "+chat"]}
    response = _propose(keyed, body)
    assert response.status_code == 201, response.text
    entries = {entry["ref"]: entry for entry in response.json()["proposal"]["cost"]["nodes"]}
    assert entries["+chat"]["reason"] == {"kind": "noPrice"}
    assert "reason" not in entries["+img"]
