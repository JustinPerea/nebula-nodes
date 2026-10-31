"""PR #203 round 12: the settings 409s name the file, a value that holds no
key is replaced, unreadable keys read as none for every reader, one provider
tag in the CLI line, and each surface's words from the one table.

- GM r22 item 3: each 409 line names the settings file by its full path.
- GM r22 item 4: person lines say "Krea API key", as the Settings row does.
- GM r22 item 5: "1 free run (fal)" beside "1 paid run (google)".
- GM r23 and review 11, LOW-3: a value that holds nothing is replaced.
- Review 11, HIGH-1 (option a): unreadable keys read as none, for the spend
  gate too, and no handler falls back to a token in the environment.
- Review 11, LOW-1: an older CLI's `?via=cli` reads as the CLI.
- Review 11, LOW-2 and GM r23: "Settings > Providers > Krea".
- Review 11, NIT-1 to NIT-8 and the surviving mutants G5, G6, S4, S7, T5.
"""
from __future__ import annotations

import ast
import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import graph_file_client
import main
import mcp_server
import services.settings as settings
from cli.formatter import _cost_line, format_proposal
from execution.person_line import key_line, key_phrase
from services import agent_spend, agent_words, canvas_proposals, model_pricing, node_route
from services.credential_catalog import CREDENTIAL_PROVIDERS
from services.node_registry import NodeRegistry
from tests.conftest import PERSON
from tests.speridlabs_fakes import API, idol_hosts
from tests.test_agent_start import CLAUDE, start  # noqa: F401 - fixture
from tests.test_idol_round10 import CLASS_PARTS, class_part_reads, sockets  # noqa: F401 - fixture
from tests.test_speridlabs_idol import run_node

BACKEND = Path(__file__).resolve().parents[1]
REGISTRY = NodeRegistry().get_all()
TOKEN = "hf_fixturetoken0123456789abcdefghijklmnop"
IDOL = {"id": "n1", "definitionId": "speridlabs-idol", "params": {"_provider": "auto"}}


def _person() -> TestClient:
    return TestClient(main.app, headers=PERSON)


# -- the 409 lines name the file by its full path (GM r22 item 3) ----------------------------


def test_the_keys_refusal_names_the_settings_file_by_its_full_path(sockets):  # noqa: F811
    sockets.write_text(json.dumps({"apiKeys": ["sk-a"]}), encoding="utf-8")
    full = str(sockets.resolve())
    line = (f"Nothing was saved because Nebula can’t read the keys saved in {full}. "
            "Fix “apiKeys” in that file, then try again.")
    client = _person()
    refused = client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "fal-1111"}})
    assert (refused.status_code, refused.json()["detail"]) == (409, line)
    removed = client.delete("/api/settings/api-keys/FAL_KEY")
    assert (removed.status_code, removed.json()["detail"]) == (409, line)


def test_the_settings_refusal_names_the_settings_file_by_its_full_path(sockets):  # noqa: F811
    sockets.write_text("[1, 2]", encoding="utf-8")
    line = f"Nothing was saved because Nebula can’t read {sockets.resolve()}. Fix the file, then try again."
    client = _person()
    for response in (client.put("/api/settings", json={"favorites": []}),
                     client.delete("/api/settings/api-keys/FAL_KEY")):
        assert (response.status_code, response.json()["detail"]) == (409, line)


def test_the_path_is_the_one_nebula_settings_path_names(tmp_path):
    """The real resolved path: NEBULA_SETTINGS_PATH when it is set, read
    when the backend starts (a fresh process, so the import reads it)."""
    named = tmp_path / "elsewhere" / "my-settings.json"
    named.parent.mkdir()
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "NEBULA_SETTINGS_PATH": str(named),
           "NEBULA_STATE_DIR": str(tmp_path / "state"), "NEBULA_OUTPUT_ROOT": str(tmp_path / "out")}
    shown = subprocess.run([sys.executable, "-c", "import services.settings as s; print(s.settings_file_path())"],
                           cwd=BACKEND, env=env, capture_output=True, text=True, check=True).stdout.strip()
    assert shown == str(named.resolve())
    relative = subprocess.run([sys.executable, "-c", "import services.settings as s; print(s.settings_file_path())"],
                              cwd=BACKEND, env={**env, "NEBULA_SETTINGS_PATH": "rel/s.json"},
                              capture_output=True, text=True, check=True).stdout.strip()
    assert relative == str((BACKEND / "rel" / "s.json").resolve()) and os.path.isabs(relative)


# -- a value that holds nothing is replaced (GM r23; review 11, LOW-3) -----------------------


@pytest.mark.parametrize("empty", [None, [], "", False, 0], ids=["null", "list", "text", "false", "zero"])
def test_a_save_replaces_an_api_keys_that_holds_nothing(sockets, empty):  # noqa: F811
    sockets.write_text(json.dumps({"apiKeys": empty, "favorites": ["a"]}), encoding="utf-8")
    client = _person()
    saved = client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "fal-1111"}})
    assert saved.status_code == 200, saved.text
    on_disk = json.loads(sockets.read_text())
    assert on_disk["apiKeys"] == {"FAL_KEY": "fal-1111"} and on_disk["favorites"] == ["a"]
    assert settings.load_settings()["apiKeys"] == {"FAL_KEY": "fal-1111"}


@pytest.mark.parametrize("empty", [None, [], "", False, 0], ids=["null", "list", "text", "false", "zero"])
def test_a_removal_replaces_an_api_keys_that_holds_nothing(sockets, empty):  # noqa: F811
    sockets.write_text(json.dumps({"apiKeys": empty}), encoding="utf-8")
    removed = _person().delete("/api/settings/api-keys/FAL_KEY")
    assert removed.status_code == 200, removed.text
    assert json.loads(sockets.read_text())["apiKeys"] == {}


@pytest.mark.parametrize("held", [["sk-a"], "sk-a", 42, True, "0"], ids=["list", "string", "number", "true", "zero-text"])
def test_content_nebula_cant_read_still_gets_the_409(sockets, held):  # noqa: F811
    sockets.write_text(json.dumps({"apiKeys": held}), encoding="utf-8")
    before = sockets.read_text()
    client = _person()
    assert client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "fal-1111"}}).status_code == 409
    assert client.delete("/api/settings/api-keys/FAL_KEY").status_code == 409
    assert sockets.read_text() == before


def test_holding_nothing_is_only_a_value_with_no_key_in_it():
    for empty in (None, [], "", False, 0, 0.0):
        assert settings.saved_keys_hold_nothing({"apiKeys": empty}) and settings.saved_keys_writable({"apiKeys": empty})
    for held in (["sk-a"], "sk-a", 42, True, "0"):
        assert not settings.saved_keys_hold_nothing({"apiKeys": held}) and not settings.saved_keys_writable(
            {"apiKeys": held})
    assert settings.saved_keys_writable({"apiKeys": {}}) and not settings.saved_keys_hold_nothing({"apiKeys": {}})
    assert not settings.saved_keys_hold_nothing({}) and not settings.saved_keys_hold_nothing([None])


# -- masked values while the keys are unreadable (review 11, NIT-8; mutant T5) ---------------


def test_a_save_that_echoes_masked_keys_writes_no_key_and_keeps_them(sockets):  # noqa: F811
    """The Settings panel sends a set key back as its mask ("***2222"); with
    keys Nebula can't read, that is no key write, so the save goes through
    and the file keeps them as saved."""
    sockets.write_text(json.dumps({"apiKeys": "sk-kept-2222", "favorites": []}), encoding="utf-8")
    saved = _person().put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "***2222"}, "favorites": ["x"]})
    assert saved.status_code == 200, saved.text
    on_disk = json.loads(sockets.read_text())
    assert on_disk["apiKeys"] == "sk-kept-2222" and on_disk["favorites"] == ["x"]


# -- desktop mode writes {} over the file's keys, on purpose (review 11, NIT-5) --------------


def test_desktop_mode_writes_no_keys_to_the_file_readable_or_not(sockets, monkeypatch):  # noqa: F811
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"FAL_KEY": "fal-injected-1111"})
    for held in ("sk-plain-text", {"OPENAI_API_KEY": "sk-plain-2222"}):
        sockets.write_text(json.dumps({"apiKeys": held, "favorites": []}), encoding="utf-8")
        assert _person().put("/api/settings", json={"favorites": ["y"]}).status_code == 200
        on_disk = json.loads(sockets.read_text())
        assert on_disk["apiKeys"] == {} and on_disk["favorites"] == ["y"]
        assert "fal-injected" not in sockets.read_text()


# -- unreadable keys read as none, for the gate too (review 11, HIGH-1, option a) ------------


def test_unreadable_keys_read_as_none_so_an_agent_runs_idol_keyless(sockets, monkeypatch):  # noqa: F811
    """Option (a): keys Nebula can't read are no keys, for every reader. An
    agent's Idol run is then keyless (nothing can bill), so the gate lets it
    run, and the run carries no token. To refuse instead (option b), the gate
    would check settings.saved_keys_readable before agent_spend.decide."""
    sockets.write_text(json.dumps({"apiKeys": [TOKEN]}), encoding="utf-8")
    monkeypatch.setenv("HF_TOKEN", TOKEN)
    read = settings.load_settings()
    assert read["apiKeys"] == {} and settings.get_api_key("HF_TOKEN") is None
    decision = agent_spend.decide([IDOL], [], settings=read, pricing=model_pricing.load_pricing(),
                                  definitions=REGISTRY, how_to_ask="Propose it.")
    assert decision.refusal is None
    assert agent_spend.may_bill_nodes([IDOL], REGISTRY, read["apiKeys"]) == []
    assert model_pricing.cost_class(REGISTRY["speridlabs-idol"], {}, read["apiKeys"]) == model_pricing.FREE


@pytest.mark.asyncio
async def test_no_handler_falls_back_to_a_token_in_the_environment(sockets, monkeypatch):  # noqa: F811
    sockets.write_text(json.dumps({"apiKeys": "hf_unreadable"}), encoding="utf-8")
    monkeypatch.setenv("HF_TOKEN", TOKEN)
    hosts = idol_hosts(monkeypatch)
    await run_node(keys=settings.load_settings()["apiKeys"])
    assert hosts.sent("POST", re.escape(f"{API}/call/run"))
    sent = [request for request in hosts.requests]
    assert sent and all("authorization" not in r.headers and "x-hf-authorization" not in r.headers for r in sent)
    assert all(TOKEN not in (r.content or b"").decode("utf-8", "replace") for r in sent)


def test_no_backend_module_reads_a_provider_key_from_the_environment():
    """Keys come from Settings only (load_settings: the file, or the desktop
    app's injected keys): no handler, service or engine reads one from the
    process environment, so an unreadable `apiKeys` can't fall back to it."""
    found = []
    for path in BACKEND.rglob("*.py"):
        parts = set(path.relative_to(BACKEND).parts)
        if parts & {".venv", "tests", "__pycache__", "scripts"}:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            name = None
            if isinstance(node, ast.Call) and ast.unparse(node.func) in ("os.environ.get", "os.getenv") and node.args:
                name = node.args[0]
            elif isinstance(node, ast.Subscript) and ast.unparse(node.value) == "os.environ":
                name = node.slice
            if isinstance(name, ast.Constant) and name.value in CREDENTIAL_PROVIDERS:
                found.append(f"{path.relative_to(BACKEND)}:{node.lineno} {name.value}")
    assert found == []
    assert "HF_TOKEN" in CREDENTIAL_PROVIDERS


# -- an older CLI's ?via=cli (review 11, LOW-1) ----------------------------------------------


@pytest.mark.parametrize("headers,params,cli", [
    ({}, {"via": "cli"}, True),
    ({"X-Nebula-Surface": "cli"}, None, True),
    ({"X-Nebula-Surface": "mcp"}, {"via": "cli"}, False),
    ({}, None, False),
    ({}, {"via": "telnet"}, False),
], ids=["old-cli-query", "header", "header-wins", "neither", "unknown-query"])
def test_the_header_or_an_old_clis_query_says_the_cli(headers, params, cli):
    assert (agent_words.surface(headers, (params or {}).get("via")) == agent_words.CLI) is cli


def test_start_here_reads_an_old_clis_query_as_the_cli(start):  # noqa: F811
    client = start.client
    old = client.get("/api/agent/start", params={"via": "cli"}, headers=CLAUDE)
    new = client.get("/api/agent/start", headers={**CLAUDE, "X-Nebula-Surface": "cli"})
    assert old.status_code == new.status_code == 200
    assert "`nebula " in old.text and "`nebula " in new.text
    mcp = client.get("/api/agent/start", params={"via": "cli"}, headers={**CLAUDE, "X-Nebula-Surface": "mcp"})
    assert "`nebula " not in mcp.text


# -- start_here's providers note in CLI words (review 11, NIT-7; mutant S7) ------------------


def test_start_heres_providers_note_names_the_cli_commands():
    rows = [{"id": "krea-image-x", "runsWith": "fal", "providers": ["fal", "krea"]},
            {"id": "krea-image-y", "runsWith": "krea"}]
    context = {"definitions": {}, "keys": {}, "krea": {}}
    cli = main._start_node_notes(rows, context, agent_words.CLI)
    assert ("A node with providers runs on one route (_provider; `nebula info <id>` lists them); switching it is "
            "the person's call: `nebula propose` it.") in cli
    assert ("runsWith krea: runs on the signed-in Krea account. Billing a node differently (_kreaAuth) is the "
            "person's call: `nebula propose` it.") in cli
    mcp = main._start_node_notes(rows, context, agent_words.MCP)
    assert any("(_provider; describe_node lists them)" in note and "propose_change it." in note for note in mcp)


# -- cli_words reads every named call the other way (mutant S4) ------------------------------


@pytest.mark.parametrize("name", ["propose", "describe", "find", "apply", "projects"])
def test_cli_words_rewords_every_named_call(name):
    mcp, cli = agent_words.WORDS["mcp"][name], agent_words.WORDS["cli"][name]
    assert agent_words.cli_words(f"see {mcp} first") == f"see {cli} first"


# -- cost_class reads key billing before the Krea plan (review 11, NIT-1; mutant G5) ---------


def test_a_key_billing_route_on_the_krea_plan_is_counted_by_its_key():
    """A fixture definition whose one route both may bill with a key and
    runs on the Krea plan: cost_class reads key billing first, so it is
    never "plan", as the gate's reach (node_route.may_bill) needs."""
    definition = copy.deepcopy(REGISTRY["speridlabs-idol"])
    definition["routes"][0].update({"provider": "krea", "plan": "only"})
    assert model_pricing.uses_krea_account(definition, {}) is True
    for keys in ({"HF_TOKEN": TOKEN}, {}):
        billing = node_route.key_billing(definition, {}, keys)
        assert billing in (node_route.MAY_COST, node_route.FREE_WITHOUT_KEY)
        assert model_pricing.cost_class(definition, {}, keys) == billing != model_pricing.PLAN


# -- the class ratchet sees a second may_bill reader (review 11, NIT-2; mutant G6) -----------


def test_nothing_outside_the_tests_reads_may_bill(tmp_path):
    assert CLASS_PARTS["may_bill"] == set()
    (tmp_path / "gate.py").write_text("def gate(d, p, k):\n    return node_route.may_bill(d, p, k)\n",
                                      encoding="utf-8")
    assert class_part_reads(tmp_path) == ["gate.py:2 may_bill in gate"]


# -- `nebula load` in the CLI's words, from the one table (review 11, NIT-3) -----------------


def test_the_load_notes_name_calls_from_the_one_table():
    cli = graph_file_client._words({"X-Nebula-Surface": "cli"})
    mcp = graph_file_client._words({})
    assert cli == {"size": "`nebula project size`", "trim": "`nebula apply` or `nebula delete`",
                   "back": "`nebula project open {id}`"}
    assert mcp == {"size": "project_size", "trim": "edit_canvas or remove_from_canvas",
                   "back": "`open_project('{id}')`"}
    for where in ("mcp", "cli"):
        words = agent_words.WORDS[where]
        assert {words["size"], words["delete"], words["open"]} <= {*graph_file_client._words(
            {"X-Nebula-Surface": where}).values(), words["delete"], f"{words['apply']} or {words['delete']}"}
    assert "_words(via" not in (BACKEND / "graph_file_client.py").read_text(encoding="utf-8")


def test_nebula_load_sends_the_clis_surface(tmp_path, monkeypatch, capsys):
    from cli.client import NebulaClient
    from cli.commands.graph import run_load

    seen = {}

    def load(api, source, **kwargs):
        seen.update(kwargs)
        return {"note": "Loaded.", "warnings": []}

    monkeypatch.setattr(graph_file_client, "load", load)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    # Nothing is sent: load is stubbed, and port 9 is the discard port.
    client = NebulaClient("http://127.0.0.1:9")
    run_load(client, str(tmp_path / "a.nebula"))
    assert seen["headers"]["X-Nebula-Surface"] == "cli" and seen["headers"]["X-Nebula-Agent"] == "Codex"
    assert "via" not in seen
    assert capsys.readouterr().out.strip() == "Loaded."


# -- an unknown kind is never counted free (review 11, NIT-4) --------------------------------


def _entry(kind, provider=None, label=None):
    return {"ref": f"+{kind}", "nodeId": None, "kind": kind, "provider": provider, "label": label or kind}


def test_an_unknown_kind_counts_as_paid_never_free():
    entries = [_entry("paid", "google"), _entry("free", "fal"), _entry("someday", "x"), _entry("plan"),
               _entry("mayCost")]
    cost = canvas_proposals.summarize_cost(entries, up_to=False)
    assert (cost["paidRuns"], cost["freeRuns"], cost["planRuns"], cost["mayCostRuns"]) == (2, 1, 1, 1)
    assert canvas_proposals.class_counts(entries)[0] == 2 and canvas_proposals.class_counts(entries)[3] == 1
    # Every run counted once.
    assert sum((cost["paidRuns"], cost["freeRuns"], cost["planRuns"], cost["mayCostRuns"])) == len(entries)


def test_propose_change_reads_an_unknown_kind_as_paid():
    import asyncio

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    description = " ".join((tools["propose_change"].description or "").split())
    assert "Read a `kind` or a `reason` kind you don't know as paid with no listed price." in description


# -- one provider tag in the CLI line (GM r22 item 5) ----------------------------------------


def test_a_free_run_is_tagged_as_a_paid_run_is():
    entries = [{**_entry("paid", "google", "paid · google"), "price": 0.13},
               _entry("free", "fal", "free · fal.ai")]
    cost = canvas_proposals.summarize_cost(entries, up_to=False, estimate={"low": 0.13, "high": 0.13})
    assert _cost_line(cost) == "1 paid run (google) and 1 free (fal), $0.13 at list prices"
    view = {"id": "p1", "status": "open", "note": "n", "expiresInSeconds": 600, "nodes": [], "edges": [],
            "params": [], "run": ["+paid", "+free"], "cost": cost}
    assert ("  runs     +paid, +free — 1 paid run (google) and 1 free (fal), $0.13 at list prices"
            in format_proposal(view, created=True).splitlines())


@pytest.mark.parametrize("entries,line", [
    ([_entry("free", "fal", "free · fal.ai")], "1 free run (fal)"),
    ([_entry("free", "fal", "free · fal.ai"), _entry("free", "speridlabs", "free · Hugging Face")],
     "2 free runs (1 fal, 1 speridlabs)"),
    ([_entry("free", "fal", "free · fal.ai"), _entry("free", None, "free · runs locally")], "2 free runs (1 fal, 1 local)"),
    ([_entry("free", None, "free · runs locally")], "1 free run (runs locally)"),
], ids=["one", "two-providers", "one-local", "local"])
def test_the_free_tag_names_provider_ids(entries, line):
    assert _cost_line(canvas_proposals.summarize_cost(entries, up_to=False)) == line


def test_an_idol_run_without_a_token_is_tagged_by_its_route():
    entry = canvas_proposals.cost_for(REGISTRY["speridlabs-idol"], {}, REGISTRY, {})
    assert (entry["kind"], entry["provider"], entry["label"]) == ("free", "speridlabs", "free · Hugging Face")
    cost = canvas_proposals.summarize_cost([{"ref": "+i", "nodeId": None, **entry}], up_to=False)
    # Where it runs (GM r24 item 1): tests/test_idol_round13.py.
    assert _cost_line(cost) == "1 free run (huggingface)"


# -- "Krea API key" in person lines, as the row says (GM r22 item 4) -------------------------


def test_person_lines_name_the_krea_key_as_its_row_does():
    assert key_phrase(["KREA_API_TOKEN"]) == "Krea API key"
    assert key_line(["KREA_API_TOKEN"]) == "Add your Krea API key in Settings, then run the node again."
    assert key_line(["FAL_KEY", "KREA_API_TOKEN"]) == "Add your fal.ai or Krea API key in Settings, then run the node again."
    fixtures = json.loads((BACKEND / "tests" / "fixtures" / "route_tables.json").read_text(encoding="utf-8"))
    assert fixtures["keyNames"]["KREA_API_TOKEN"] == ["Krea", "API key"]


# -- the Krea place name (review 11, LOW-2; GM r23) ------------------------------------------


def test_every_agent_line_names_the_providers_tab_for_krea():
    source = (BACKEND / "mcp_server.py").read_text(encoding="utf-8")
    assert "Connections > Krea" not in source
    assert "(Settings > Providers > Krea)" in (mcp_server.krea_discovery_tools.__doc__ or "")


# -- the writing tab's id rides back on the signal (review 11, copy MEDIUM-1) ----------------


def test_the_signal_names_the_tab_that_wrote(sockets, monkeypatch):  # noqa: F811
    from unittest.mock import AsyncMock

    broadcast = AsyncMock()
    monkeypatch.setattr(main.manager, "broadcast_browser", broadcast)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    client = _person()
    tab = {"X-Nebula-Tab": "tab-0b2f0c1e-7a7d-4b1e-9f55-2f5d3a1c9e01"}
    assert client.put("/api/settings", json={"apiKeys": {"HF_TOKEN": "hf_tab_4444"}}, headers=tab).status_code == 200
    assert client.delete("/api/settings/api-keys/HF_TOKEN", headers=tab).status_code == 200
    # Another window, the CLI or a script: no tab id, so no origin.
    assert client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "fal-5555"}}).status_code == 200
    # Anything that isn't such an id is no origin at all.
    for bad in ("short", "x" * 65, "tab id with spaces", "<script>"):
        assert client.put("/api/settings", json={"favorites": [bad[:4]]}, headers={"X-Nebula-Tab": bad}).status_code == 200
    sent = [call.args[0] for call in broadcast.call_args_list]
    assert sent[:3] == [{"type": "settingsChanged", "keys": ["HF_TOKEN"], "origin": tab["X-Nebula-Tab"]},
                        {"type": "settingsChanged", "keys": ["HF_TOKEN"], "origin": tab["X-Nebula-Tab"]},
                        {"type": "settingsChanged", "keys": ["FAL_KEY"]}]
    assert all("origin" not in message for message in sent[3:]) and len(sent) == 7


def test_the_desktop_bridge_names_the_tab_that_wrote(sockets, monkeypatch):  # noqa: F811
    from unittest.mock import AsyncMock

    broadcast = AsyncMock()
    monkeypatch.setattr(main.manager, "broadcast_browser", broadcast)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"FAL_KEY": "fal-injected-1111"})
    tab = {"X-Nebula-Tab": "tab-desktop-window-0001"}
    answer = _person().post("/api/credentials/update", json={"provider": "HF_TOKEN", "key": "hf_desktop_6666"}, headers=tab)
    assert answer.status_code == 200, answer.text
    assert broadcast.call_args.args[0] == {"type": "settingsChanged", "keys": ["HF_TOKEN"], "origin": tab["X-Nebula-Tab"]}
