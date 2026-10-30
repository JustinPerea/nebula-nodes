"""PR #203 round 10: one cost class with the Krea plan and the sourced $0 in
it, refusals worded for their reader where they are written, and a settings
signal for the person's tabs that names the keys it changed.

- GM r18 item 1: a sourced $0 is free, never paid (model_pricing.cost_class).
- GM r19 item 1 (review 9, cost MEDIUM-1): a run on the Krea plan is its own
  class, out of "N paid" and the figure, with a ``plan`` reason.
- Review 9, keys MEDIUM-1: each refusal names its reader's own call
  (services/agent_words), and the CLI prints it as it came.
- Review 9, keys LOW-1 and GM r19 item 7: settingsChanged goes to the
  person's tabs only, with the names of the keys that changed.
- Review 9, keys NIT-1: a save writes back what it wasn't asked to change.
- Review 9, keys LOW-4: describe_node's per-route billing row reads the class.
- GM r18 item 3: the empty-key refusal's words.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from services import agent_spend, agent_words, canvas_proposals, model_pricing, node_route
from services.node_registry import NodeRegistry
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, _propose, api  # noqa: F401 - fixture
from tests.test_idol_may_bill import SIGNED_IN, _quick, gated  # noqa: F401 - fixture
from tests.test_idol_proposal_cost import keyed  # noqa: F401 - fixture
from tests.test_pending_nodes import pend  # noqa: F401 - fixture

BACKEND = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
CASES = json.loads((FIXTURES / "pricing_cases.json").read_text(encoding="utf-8"))
REGISTRY = NodeRegistry().get_all()
SHIPPED = json.loads((BACKEND / "data" / "model_pricing.json").read_text(encoding="utf-8"))


# -- one cost class (GM r18 item 1, r19 item 1) ---------------------------------------------


@pytest.mark.parametrize("case", CASES["classCases"], ids=[case["name"] for case in CASES["classCases"]])
def test_each_node_gets_the_shared_cost_class(case):
    """runScope.test.ts runs the same cases (pricing_cases.json classCases)."""
    definitions = {**REGISTRY, **CASES["definitions"]}
    pricing = {**SHIPPED, "nodes": {**SHIPPED["nodes"], **CASES["pricing"]["nodes"]}}
    items = [{"id": node["id"], "definitionId": node["nodeId"], "params": node["params"]} for node in case["nodes"]]
    result = model_pricing.estimate_run(items, pricing, definitions, case["apiKeys"])
    expected = case["expected"]
    by_class = {cls: sorted(node for node, got in result["classes"].items() if got == cls)
                for cls in ("paid", "plan", "free", "mayCost")}
    assert by_class == {cls: sorted(expected[cls]) for cls in ("paid", "plan", "free", "mayCost")}
    assert sorted(result["plan"]) == sorted(expected["plan"])
    # `free` lists the sourced $0 nodes (a key-billing route with no key is free, unlisted).
    assert sorted(result["free"]) == sorted(node["id"] for node in case["nodes"] if node["nodeId"] == "zeroed")
    # The figure covers the paid nodes only.
    assert set(result["priced"]) <= set(expected["paid"])
    assert result["high"] == (None if expected["high"] is None else pytest.approx(expected["high"]))
    assert result["sourcedZero"] is expected["sourcedZero"]
    for node in expected["plan"]:
        assert result["reasons"][node] == {"kind": "plan"}


def test_a_sourced_zero_is_free_and_anything_else_priced_is_paid():
    zeroed = CASES["definitions"]["zeroed"]
    assert model_pricing.cost_class(zeroed, {}, {}, {"currency": "usd", "low": 0, "high": 0}) == "free"
    assert model_pricing.cost_class(zeroed, {}, {}, {"currency": "usd", "low": 0, "high": 0.01}) == "paid"
    # Zero with a cost its price leaves out isn't free.
    assert model_pricing.cost_class(zeroed, {}, {}, {"currency": "usd", "low": 0, "high": 0, "plus": "x"}) == "paid"
    assert model_pricing.cost_class(zeroed, {}, {}, {"currency": "credits", "low": 0, "high": 0}) == "paid"
    assert model_pricing.cost_class(zeroed, {}, {}) == "paid"
    table = CASES["definitions"]["table"]
    assert model_pricing.cost_class(table, {"_provider": "krea", "_kreaAuth": "mcp"}, {}) == "plan"
    idol = REGISTRY["speridlabs-idol"]
    assert model_pricing.cost_class(idol, {}, SIGNED_IN) == "mayCost"
    assert model_pricing.cost_class(idol, {}, {}) == "free"


def test_a_sourced_zero_alone_is_a_free_proposal_run_with_its_price():
    entry = canvas_proposals.cost_for(CASES["definitions"]["zeroed"], {}, None, {"FAL_KEY": "k"}, cost_class="free")
    assert entry == {"kind": "free", "provider": "fal", "label": "free · fal.ai"}
    summary = canvas_proposals.summarize_cost([{"ref": "+z", "nodeId": None, **entry}], up_to=False)
    assert (summary["paidRuns"], summary["planRuns"], summary["freeRuns"]) == (0, 0, 1)


def test_a_proposal_counts_a_krea_plan_run_apart_from_paid(keyed):  # noqa: F811
    keyed.keys({"GEMINI_API_KEY": "k"})
    text = keyed.graph.add_node("text-input", {"value": "a cat"})
    keyed.graph.nodes[text]["outputs"] = {"text": {"type": "Text", "value": "a cat"}}
    body = {"note": "two pictures",
            "nodes": [{"ref": "+img", "definitionId": "nano-banana", "params": {}},
                      {"ref": "+krea", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}],
            "edges": [{"source": text, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"},
                      {"source": text, "sourceHandle": "text", "target": "+krea", "targetHandle": "prompt"}],
            "run": ["+img", "+krea"]}
    response = _propose(keyed, body)
    assert response.status_code == 201, response.text
    cost = response.json()["proposal"]["cost"]
    entries = {entry["ref"]: entry for entry in cost["nodes"]}
    assert entries["+krea"]["kind"] == "plan" and entries["+krea"]["label"] == "on Krea plan"
    assert entries["+krea"]["reason"] == {"kind": "plan"}
    assert (cost["paidRuns"], cost["planRuns"], cost["freeRuns"]) == (1, 1, 0)
    assert cost["providers"] == ["gemini"] or "krea" not in cost["providers"]


# -- nothing counts a node but the one class function ----------------------------------------

# Who may read the parts of the class: key_billing (the key-billing routes) and
# uses_krea_account (the Krea plan). Everything that counts a node reads
# model_pricing.cost_class.
CLASS_PARTS = {
    "key_billing": {("services/node_route.py", "may_bill"), ("services/node_route.py", "key_billing_account"),
                    ("services/model_pricing.py", "cost_class")},
    "uses_krea_account": {("services/model_pricing.py", "cost_class")},
}


def _sources(root: Path) -> list[Path]:
    skip = {".venv", "tests", "__pycache__", "node_modules"}
    return [path for path in root.rglob("*.py") if not skip & set(path.relative_to(root).parts)]


def class_part_reads(root: Path) -> list[str]:
    """Each call of a class part outside its readers, as "file:line in fn"."""
    found = []
    for path in _sources(root):
        where = str(path.relative_to(root))
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

        def visit(node: ast.AST, scope: str) -> None:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                scope = node.name
            if isinstance(node, ast.Call):
                func = node.func
                name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
                if name in CLASS_PARTS and (where, scope) not in CLASS_PARTS[name]:
                    found.append(f"{where}:{node.lineno} {name} in {scope}")
            for child in ast.iter_child_nodes(node):
                visit(child, scope)

        visit(tree, "<module>")
    return found


def test_only_the_cost_class_function_counts_a_node():
    assert class_part_reads(BACKEND) == []


def test_the_class_ratchet_catches_a_second_reader(tmp_path):
    (tmp_path / "services").mkdir()
    (tmp_path / "services" / "model_pricing.py").write_text(
        "def cost_class(d, p, k):\n    return key_billing(d, p, k) or uses_krea_account(d, p)\n"
        "def estimate(d, p, k):\n    if uses_krea_account(d, p):\n        return 'plan'\n", encoding="utf-8")
    (tmp_path / "gate.py").write_text("def gate(d, p, k):\n    return node_route.key_billing(d, p, k)\n", encoding="utf-8")
    reported = " ".join(class_part_reads(tmp_path))
    assert "services/model_pricing.py:4 uses_krea_account in estimate" in reported
    assert "gate.py:2 key_billing in gate" in reported
    assert "in cost_class" not in reported


# -- each refusal in its reader's words (review 9, keys MEDIUM-1) ---------------------------


def _refusal_constants() -> dict[str, str]:
    """Every module-level *_REFUSAL text in the backend, by name."""
    found = {}
    for path in _sources(BACKEND):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                    and node.targets[0].id.endswith("_REFUSAL"):
                value = ast.literal_eval(node.value)
                if isinstance(value, str):
                    found[f"{path.relative_to(BACKEND)}:{node.targets[0].id}"] = value
    return found


MCP_TOOLS = ("propose_change", "describe_node", "find_nodes", "edit_canvas")


@pytest.mark.parametrize("name", sorted(_refusal_constants()))
def test_every_refusal_reads_right_for_the_cli_and_for_mcp(name):
    template = _refusal_constants()[name]
    cli = agent_words.worded(template, agent_words.CLI)
    mcp = agent_words.worded(template, agent_words.MCP)
    assert not any(tool in cli for tool in MCP_TOOLS), cli
    assert "`nebula " not in mcp, mcp
    assert "{" not in cli and "{" not in mcp


def test_the_scan_found_the_billing_refusals():
    names = {name.split(":")[1] for name in _refusal_constants()}
    assert {"KREA_BILLING_REFUSAL", "PROVIDER_CHOICE_REFUSAL", "NOTES_TO_GENERATORS_REFUSAL",
            "PERSONS_RUN_REFUSAL"} <= names


@pytest.mark.parametrize("headers,expect,never", [
    ({"X-Nebula-Agent": "Codex"}, "propose the change instead with propose_change;", "`nebula"),
    ({"X-Nebula-Agent": "Codex", "X-Nebula-Surface": "cli"}, "propose the change instead with `nebula propose`;",
     "propose_change"),
], ids=["mcp", "cli"])
def test_a_billing_refusal_is_worded_where_it_is_raised(monkeypatch, headers, expect, never):
    table = json.loads((FIXTURES / "route_cases.json").read_text())["definitions"]["routes-image"]
    real_get = main.node_registry.get
    monkeypatch.setattr(main.node_registry, "get", lambda d: table if d == table["id"] else real_get(d))
    monkeypatch.setattr(main, "_is_person_request", lambda: False)
    monkeypatch.setattr(main, "current_request_headers", lambda: headers)
    with pytest.raises(main.HTTPException) as caught:
        main._refuse_agent_billing_change([("n1", table["id"], {}, {"_provider": "replicate"})])
    assert expect in caught.value.detail and never not in caught.value.detail
    assert "(`nebula propose`)" not in caught.value.detail


@pytest.mark.parametrize("surface,expect,never", [
    ({}, "Add it to the canvas instead (edit_canvas, a speridlabs-idol node), then propose the run: "
         "propose_change (run: <node id>).", "`nebula"),
    ({"X-Nebula-Surface": "cli"}, "Add it to the canvas instead (`nebula create speridlabs-idol`), then propose the run: "
                                  "`nebula propose --note \"<why>\" --run <node id>`.", "propose_change"),
], ids=["mcp", "cli"])
def test_quick_points_each_surface_at_its_own_commands(gated, monkeypatch, surface, expect, never):  # noqa: F811
    gated.keys(SIGNED_IN)
    response, called = _quick(gated, monkeypatch, {**CLAUDE, **surface})
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert expect in detail and never not in detail and called == []


def test_the_spend_hint_is_worded_per_surface():
    assert agent_spend.propose_hint(["n2"]) == (
        "Propose it instead: propose_change (run: n2). The person accepts on the canvas, and the canvas runs it.")
    assert agent_spend.propose_hint(["n2"], "cli") == (
        "Propose it instead: `nebula propose --note \"<why>\" --run n2`. "
        "The person accepts on the canvas, and the canvas runs it.")


def test_the_cli_says_it_is_the_cli_on_every_request_and_is_no_agent_marker():
    from cli.client import NebulaClient
    from services import person_gate

    client = NebulaClient.__new__(NebulaClient)
    assert client._identity_headers()["X-Nebula-Surface"] == "cli"
    assert "x-nebula-surface" not in person_gate.AGENT_MARKER_HEADERS
    assert agent_words.surface({"x-nebula-surface": "CLI"}) == "cli"
    assert agent_words.surface({"X-Nebula-Client": "nebula-cli"}) == "mcp"


def test_a_live_re_read_keeps_a_plan_run_out_of_free():
    """A token set after the proposal re-reads Idol (live_cost); the run on
    the Krea plan stays counted apart, never as free (GM r19 item 1)."""
    from types import SimpleNamespace

    proposal = SimpleNamespace(key_params={"+i": {}}, cost={
        "paidRuns": 0, "planRuns": 1, "mayCostRuns": 0, "mayCost": [], "freeRuns": 1,
        "nodes": [{"ref": "+k", "nodeId": None, "definitionId": "krea-2-generate", "kind": "plan", "provider": "krea",
                   "label": canvas_proposals.PLAN_LABEL},
                  {"ref": "+i", "nodeId": None, "definitionId": "speridlabs-idol", "kind": "free", "provider": "speridlabs",
                   "label": "free · Hugging Face", "name": "Idol"}]})
    live = canvas_proposals.live_cost(proposal, REGISTRY, SIGNED_IN)
    assert (live["planRuns"], live["mayCostRuns"], live["freeRuns"]) == (1, 1, 0)


def test_the_cli_prints_a_refusal_exactly_as_it_came(capsys):
    """Review 9, keys MEDIUM-1: _fail rewrites nothing, MCP words included
    (a refusal worded for MCP reaches the CLI only from a caller that didn't
    say it is the CLI, and stays as written)."""
    from cli.client import NebulaClient
    from nebula_api import NebulaAPIError

    client = NebulaClient.__new__(NebulaClient)
    client.base_url = "http://127.0.0.1:1"
    detail = ("Propose it instead: propose_change (run: n2), then describe_node and find_nodes; "
              "or `nebula propose` (`nebula propose --note \"<why>\" --run n2`).")
    with pytest.raises(SystemExit):
        client._fail(NebulaAPIError(detail, status=403), "POST /api/execute")
    assert capsys.readouterr().err == f"error: {detail}\n"


def test_one_table_and_a_name_beside_its_command_is_kept():
    import cli.formatter as formatter

    assert not hasattr(main, "_CLI_WORDS") and not hasattr(formatter, "_PROPOSE_RUN")
    both = "propose the change instead with propose_change (`nebula propose`); the person accepts it"
    assert agent_words.cli_words(both) == both
    assert main._cli_words("describe_node lists them") == formatter._cli_words("describe_node lists them") \
        == "`nebula info <id>` lists them"
    assert agent_words.cli_words("Propose it: propose_change (run: n2, n3).") == (
        "Propose it: `nebula propose --note \"<why>\" --run n2 --run n3`.")


# -- the settings signal (review 9, keys LOW-1; GM r19 item 7) -------------------------------


@pytest.fixture
def sockets(tmp_path, monkeypatch, person):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"apiKeys": {"OPENAI_API_KEY": "sk-kept-2222"}}), encoding="utf-8")
    monkeypatch.setattr(settings, "SETTINGS_PATH", path)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    monkeypatch.setattr(main, "load_settings", settings.load_settings)
    monkeypatch.setattr(main, "save_settings", settings.save_settings)
    return path


def _heard(socket) -> list[dict]:
    socket.portal.call(main.manager.broadcast_raw, {"type": "testMarker"})
    heard = []
    for _ in range(80):
        message = socket.receive_json()
        if message.get("type") == "testMarker":
            return heard
        if message.get("type") == "settingsChanged":
            heard.append(message)
    raise AssertionError("no marker")


def _promoted(socket) -> None:
    """Wait for the hello's answer. The hello goes through the socket's
    receive loop while the marker is sent straight from the portal, so on a
    busy run the marker can come back before the tab is the person's."""
    for _ in range(80):
        kind = socket.receive_json().get("type")
        if kind == "proposalSync":
            return
        assert kind != "personRequired", "the hello was refused"
    raise AssertionError("no proposalSync after the hello")


def test_the_signal_reaches_the_persons_tab_and_never_an_agent(sockets):
    tab = TestClient(main.app)
    agent = TestClient(main.app)
    other = TestClient(main.app, headers=PERSON)
    with tab.websocket_connect("/ws", headers=PERSON) as browser, \
            agent.websocket_connect("/ws", headers={"X-Nebula-Agent": "Codex"}) as listener:
        browser.send_json({"type": "hello", "personToken": PERSON["X-Nebula-Person"]})
        _promoted(browser)
        _heard(browser)
        assert other.put("/api/settings", json={"apiKeys": {"HF_TOKEN": "hf_signal_8888"}}).status_code == 200
        assert other.put("/api/settings", json={"favorites": ["nano-banana"]}).status_code == 200
        assert other.delete("/api/settings/api-keys/OPENAI_API_KEY").status_code == 200
        assert _heard(browser) == [{"type": "settingsChanged", "keys": ["HF_TOKEN"]},
                                   {"type": "settingsChanged", "keys": []},
                                   {"type": "settingsChanged", "keys": ["OPENAI_API_KEY"]}]
        assert _heard(listener) == []


def test_a_replaced_key_is_named_and_a_masked_echo_changes_nothing(sockets, monkeypatch):
    broadcast = AsyncMock()
    monkeypatch.setattr(main.manager, "broadcast_browser", broadcast)
    client = TestClient(main.app, headers=PERSON)
    assert client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "sk-new-3333"}}).status_code == 200
    assert client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "***3333"}}).status_code == 200
    assert [call.args[0] for call in broadcast.call_args_list] == [
        {"type": "settingsChanged", "keys": ["OPENAI_API_KEY"]}, {"type": "settingsChanged", "keys": []}]


# -- a save changes only what it was asked to (review 9, keys NIT-1) -------------------------


def test_a_save_writes_back_every_entry_it_was_not_asked_to_change(sockets):
    raw = {"OPENAI_API_KEY": " sk-padded-1111\n", "FAL_KEY": "", "HF_TOKEN": "​", "ODD": 42,
           "LIST": ["a"], "ANTHROPIC_API_KEY": "sk-ant-2222"}
    sockets.write_text(json.dumps({"apiKeys": raw, "custom": {"kept": True}}), encoding="utf-8")
    client = TestClient(main.app, headers=PERSON)
    assert client.put("/api/settings", json={"executionMode": "manual"}).status_code == 200
    saved = json.loads(sockets.read_text())
    assert saved["apiKeys"] == raw and saved["custom"] == {"kept": True}
    # A key written is trimmed; the others stay as they were.
    assert client.put("/api/settings", json={"apiKeys": {"FAL_KEY": " fal-3333 "}}).status_code == 200
    assert json.loads(sockets.read_text())["apiKeys"] == {**raw, "FAL_KEY": "fal-3333"}
    # A removal takes that key alone.
    assert client.delete("/api/settings/api-keys/ANTHROPIC_API_KEY").status_code == 200
    left = {name: value for name, value in raw.items() if name != "ANTHROPIC_API_KEY"}
    assert json.loads(sockets.read_text())["apiKeys"] == {**left, "FAL_KEY": "fal-3333"}
    # Readers still read them through key_text.
    assert settings.load_settings()["apiKeys"] == {"OPENAI_API_KEY": "sk-padded-1111", "FAL_KEY": "fal-3333"}


# -- GM r18 item 3, and the shared "can be stored" predicate (review 9, keys NIT-2) ----------


def test_the_empty_key_refusal_says_nothing_was_saved():
    assert main.KEY_ONLY_INVISIBLE == (
        "Nothing was saved because the key is empty once spaces and invisible characters are removed.")


STORE_CASES = json.loads((FIXTURES / "key_text_cases.json").read_text(encoding="utf-8"))["storeCases"]


@pytest.mark.parametrize("case", STORE_CASES, ids=[repr(case["raw"]) + case["key"] for case in STORE_CASES])
def test_what_settings_stores_matches_the_field(case):
    """frontend settingsWrites storableKey reads the same cases."""
    text = node_route.key_text(case["raw"])
    stored = text if text and main._key_refusal(case["key"], case["raw"]) is None else None
    assert stored == case["stored"]


# -- describe_node's billing row reads the class (review 9, keys LOW-4) ----------------------


def test_each_routes_billing_row_follows_the_cost_class():
    idol = json.loads(json.dumps(REGISTRY["speridlabs-idol"]))
    rows = main._describe_routes(idol, {}, lambda key: [])["routes"]
    assert rows[0]["billing"] == main.HF_SPACE_BILLING_FREE
    moved = json.loads(json.dumps(idol))
    moved["routes"][0]["handler"], moved["routes"][0]["provider"] = "fal", "fal"
    assert main._describe_routes(moved, SIGNED_IN, lambda key: [])["routes"][0]["billing"] == main.HF_SPACE_BILLING_TOKEN
    plain = json.loads(json.dumps(idol))
    del plain["routes"][0]["mayBillWithKey"]
    assert "billing" not in main._describe_routes(plain, SIGNED_IN, lambda key: [])["routes"][0]
