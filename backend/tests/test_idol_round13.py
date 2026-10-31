"""PR #203 round 13: GM r24 and the two CI failures on 485fb5e0.

- GM r24 items 1 and 2: the CLI tags each part by where its runs go, in one
  id style, with a count per id once there's more than one: "1 free
  (huggingface)", "2 free (1 fal, 1 local)", "3 paid runs (2 anthropic, 1
  krea)".
- GM r24 item 3: the Krea mode label is "API key · API balance".
- GM r24 item 5: the Krea handlers' errors say "Krea API key".
- GM r24 item 7: the 409's path shows the home folder as "~".
- CI: a /ws socket that ends any way but a clean disconnect is unregistered,
  so no canvas counts as open after it (test_cli_apply's arrange line).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import main
import services.settings as settings
from cli.formatter import _cost_line
from services import canvas_proposals, node_route
from services.node_registry import NodeRegistry
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round12 import _person

BACKEND = Path(__file__).resolve().parents[1]
REGISTRY = NodeRegistry().get_all()
TOKEN = "hf_fixturetoken0123456789abcdefghijklmnop"


def _entry(kind, provider=None, label=None, **extra):
    return {"ref": f"+{kind}{provider}", "nodeId": None, "kind": kind, "provider": provider,
            "label": label or kind, **extra}


# -- where each part's runs go, one id style (GM r24 items 1 and 2) ---------------------------


@pytest.mark.parametrize("token", [None, TOKEN], ids=["free", "may-cost"])
def test_idol_runs_on_huggingface(token):
    keys = {"HF_TOKEN": token} if token else {}
    entry = canvas_proposals.cost_for(REGISTRY["speridlabs-idol"], {}, REGISTRY, keys)
    assert (entry["provider"], entry["runsOn"], entry["account"]) == ("speridlabs", "huggingface", "Hugging Face")
    assert node_route.key_billing_host(REGISTRY["speridlabs-idol"], {}, keys) == "huggingface"
    # Any other node has no key-billing host, and no runsOn.
    assert node_route.key_billing_host(REGISTRY["gpt-image-1-5"], {}, {"OPENAI_API_KEY": "sk-x"}) is None
    assert "runsOn" not in canvas_proposals.cost_for(REGISTRY["gpt-image-1-5"], {}, REGISTRY, {"OPENAI_API_KEY": "sk-x"})


def test_an_idol_run_reads_1_free_huggingface_beside_a_paid_run():
    idol = canvas_proposals.cost_for(REGISTRY["speridlabs-idol"], {}, REGISTRY, {})
    entries = [{**_entry("paid", "openai"), "price": 0.13}, {"ref": "+i", "nodeId": None, **idol}]
    cost = canvas_proposals.summarize_cost(entries, up_to=False, estimate={"low": 0.13, "high": 0.13})
    assert _cost_line(cost) == "1 paid run (openai) and 1 free (huggingface), $0.13 at list prices"
    alone = canvas_proposals.summarize_cost([{"ref": "+i", "nodeId": None, **idol}], up_to=False)
    assert _cost_line(alone) == "1 free run (huggingface)"


LOCAL = "free · runs locally"


@pytest.mark.parametrize("entries,line", [
    # One place: no count, as "1 paid run (openai)".
    ([_entry("free", "fal", "free · fal.ai")], "1 free run (fal)"),
    ([_entry("free", "fal", "free · fal.ai"), _entry("free", "fal", "free · fal.ai")], "2 free runs (fal)"),
    # Several places: a count each, local last.
    ([_entry("free", "fal", "free · fal.ai"), _entry("free", None, LOCAL)], "2 free runs (1 fal, 1 local)"),
    ([_entry("free", None, LOCAL), _entry("free", "fal", "free · fal.ai"), _entry("free", "fal", "free · fal.ai"),
      _entry("free", "speridlabs", "free · Hugging Face", runsOn="huggingface")],
     "4 free runs (2 fal, 1 huggingface, 1 local)"),
    # Local last even where its id would sort before another's.
    ([_entry("free", None, LOCAL), _entry("free", "replicate", "free · replicate")], "2 free runs (1 replicate, 1 local)"),
    # Only local: said only when it's the whole run, as before.
    ([_entry("free", None, LOCAL), _entry("free", None, LOCAL)], "2 free runs (runs locally)"),
], ids=["one", "one-place", "fal-and-local", "three-places", "local-last", "local"])
def test_the_free_part_counts_each_place(entries, line):
    assert _cost_line(canvas_proposals.summarize_cost(entries, up_to=False)) == line


@pytest.mark.parametrize("entries,line", [
    ([_entry("paid", "anthropic"), _entry("paid", "anthropic"), _entry("paid", "krea"),
      _entry("free", "fal", "free · fal.ai"), _entry("free", None, LOCAL)],
     "3 paid runs (2 anthropic, 1 krea) and 2 free (1 fal, 1 local), no list price"),
    ([_entry("paid", "anthropic"), _entry("paid", "anthropic"), _entry("free", None, LOCAL)],
     "2 paid runs (anthropic) and 1 free, no list price"),
    ([_entry("paid", "openai"), _entry("plan", "krea", "on Krea plan"),
      _entry("free", "speridlabs", "free · Hugging Face", runsOn="huggingface")],
     "1 paid run (openai), 1 on the person's Krea plan and 1 free (huggingface), no list price"),
], ids=["paid-and-free-counted", "one-provider", "every-class"])
def test_the_paid_part_has_the_same_shape(entries, line):
    assert _cost_line(canvas_proposals.summarize_cost(entries, up_to=False)) == line


@pytest.mark.parametrize("entries,line", [
    # In a list, "run" goes on the first class only (GM r25 item 1) ...
    ([{**_entry("paid", "google"), "price": 0.039}, _entry("plan", "krea", "on Krea plan"),
      _entry("free", "fal", "free · fal.ai")],
     "1 paid run (google), 1 on the person's Krea plan and 1 free (fal), no list price"),
    ([_entry("plan", "krea", "on Krea plan"), _entry("free", "fal", "free · fal.ai")],
     "1 run on the person's Krea plan and 1 free (fal)"),
    ([_entry("mayCost", "speridlabs", "may cost · Hugging Face"), _entry("plan", "krea", "on Krea plan")],
     "1 run that may bill the person's own account (Idol) and 1 on the person's Krea plan"),
    # ... and a class that stands alone keeps it.
    ([_entry("free", "fal", "free · fal.ai")], "1 free run (fal)"),
    ([_entry("plan", "krea", "on Krea plan"), _entry("plan", "krea", "on Krea plan")], "2 runs on the person's Krea plan"),
], ids=["paid-first", "plan-first", "may-first", "free-alone", "plan-alone"])
def test_run_goes_on_the_first_class_only(entries, line):
    may = [{"name": "Idol", "account": "Hugging Face"}] if any(e["kind"] == "mayCost" for e in entries) else []
    cost = {**canvas_proposals.summarize_cost(entries, up_to=False), "mayCost": may}
    assert _cost_line(cost) == line
    assert line.count(" run") == 1


def test_a_cost_without_entries_keeps_its_providers():
    # An older backend's cost: no entry per run, so the providers as listed.
    assert _cost_line({"paidRuns": 3, "providers": ["anthropic", "krea"], "freeRuns": 0}) == (
        "3 paid runs (anthropic, krea), no list price")
    assert _cost_line({"paidRuns": 0, "freeRuns": 2}) == "2 free runs (runs locally)"


# -- Krea's words (GM r24 items 3 and 5) ------------------------------------------------------


def test_the_krea_mode_label_says_api_key():
    labels = {option.get("label") for definition in REGISTRY.values() for param in definition.get("params") or []
              if param.get("key") == "_kreaAuth" for option in param.get("options") or []}
    assert "API key · API balance" in labels and "API token · API balance" not in labels


def test_no_person_line_in_the_backend_says_krea_api_token():
    for path in [*BACKEND.joinpath("handlers").glob("*.py"), *BACKEND.joinpath("services").glob("*.py"),
                 BACKEND / "main.py", BACKEND / "mcp_server.py", BACKEND / "execution" / "person_line.py"]:
        assert "Krea API token" not in path.read_text(encoding="utf-8"), path


# -- the 409's path with "~" (GM r24 item 7) ---------------------------------------------------


def test_the_409_shows_the_home_folder_as_a_tilde(sockets, tmp_path, monkeypatch):  # noqa: F811
    home = tmp_path / "home"
    path = home / ".nebula" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"apiKeys": ["kept"]}), encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(settings, "SETTINGS_PATH", path)
    shown = f"~{os.sep}.nebula{os.sep}settings.json"
    assert settings.settings_file_shown() == shown
    line = (f"Nothing was saved because Nebula can’t read the keys saved in {shown}. "
            "Fix “apiKeys” in that file, then try again.")
    client = _person()
    for response in (client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "fal-1111"}}),
                     client.delete("/api/settings/api-keys/FAL_KEY")):
        assert (response.status_code, response.json()["detail"]) == (409, line)
    path.write_text("[1]", encoding="utf-8")
    refused = client.put("/api/settings", json={"favorites": []})
    assert refused.json()["detail"] == f"Nothing was saved because Nebula can’t read {shown}. Fix the file, then try again."


def test_a_path_outside_the_home_folder_stays_absolute(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    elsewhere = tmp_path / "elsewhere" / "settings.json"
    monkeypatch.setattr(settings, "SETTINGS_PATH", elsewhere)
    assert settings.settings_file_shown() == str(elsewhere.resolve())
    # A folder that only starts like the home folder isn't under it.
    sibling = tmp_path / "home-other" / "settings.json"
    monkeypatch.setattr(settings, "SETTINGS_PATH", sibling)
    assert settings.settings_file_shown() == str(sibling.resolve())
    # The home folder's own file.
    monkeypatch.setattr(settings, "SETTINGS_PATH", tmp_path / "home" / "settings.json")
    assert settings.settings_file_shown() == f"~{os.sep}settings.json"


# -- a socket that ends any way is unregistered (CI part 1) ----------------------------------


def test_a_socket_cancelled_before_it_reads_again_is_unregistered(monkeypatch):
    """The handler ended by cancellation, not WebSocketDisconnect, left the
    socket registered, so `canvas_open` stayed true for every later test."""
    from fastapi.testclient import TestClient

    from tests.conftest import PERSON

    client = TestClient(main.app)
    with client.websocket_connect("/ws", headers=PERSON) as ws:
        assert ws.receive_json()["type"] == "graphSync"
        assert main.manager.canvas_open()
    assert main.manager.active_connections == [] and not main.manager.canvas_open()


# -- GM r25 item 2: the HTTP and CLI sign-in line names the row ---------------------------------


def test_the_krea_sign_in_line_names_the_row_as_mcp_does():
    from services import node_readiness

    assert node_readiness.KREA_SIGN_IN == "needs the Krea account signed in (Settings > Providers > Krea)"
    krea = REGISTRY["krea-2-generate"]
    assert node_readiness.instance_missing(krea, {"_kreaAuth": "mcp"}, set()).endswith("(Settings > Providers > Krea)")
    mcp = (BACKEND / "mcp_server.py").read_text(encoding="utf-8")
    assert "Settings > Providers > Krea" in mcp


# -- review 12, LOW-2: one resolved path for reading, writing and the 409 ----------------------


def test_a_tilde_in_nebula_settings_path_is_the_home_folder_for_reads_writes_and_the_409(tmp_path):
    import subprocess
    import sys

    home = tmp_path / "home"
    (home / "x").mkdir(parents=True)
    (tmp_path / "cwd").mkdir()
    (home / "x" / "settings.json").write_text(json.dumps({"apiKeys": ["kept"], "favorites": ["a"]}), encoding="utf-8")
    script = (
        "import json, services.settings as s\n"
        "print(json.dumps([str(s.settings_file()), s.settings_file_shown(), s.load_saved_settings()['favorites'],"
        " s.load_settings()['apiKeys']]))\n"
        "saved = s.load_saved_settings(); saved['favorites'] = ['b']; s.save_settings(saved)\n"
    )
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "NEBULA_SETTINGS_PATH": "~/x/settings.json",
           "NEBULA_STATE_DIR": str(tmp_path / "state"), "NEBULA_OUTPUT_ROOT": str(tmp_path / "out"),
           "PYTHONPATH": str(BACKEND), "PYTHONDONTWRITEBYTECODE": "1", "HF_TOKEN": ""}
    done = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, %r)\n" % str(BACKEND) + script],
                          cwd=tmp_path / "cwd", env=env, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    read = json.loads(done.stdout.strip().splitlines()[-1])
    assert read == [str((home / "x" / "settings.json").resolve()), f"~{os.sep}x{os.sep}settings.json", ["a"], {}]
    # The write went to the same file, never to a folder named "~" under the working folder.
    assert json.loads((home / "x" / "settings.json").read_text(encoding="utf-8"))["favorites"] == ["b"]
    assert not (tmp_path / "cwd" / "~").exists()


# -- review 12, LOW-3: a file that isn't valid JSON gets the 409, never a 500 -------------------


CUT_SHORT = '{"apiKeys": {"FAL_KEY": "fal-kept-1111"'


@pytest.fixture
def cut_short(sockets, tmp_path, monkeypatch):  # noqa: F811
    home = tmp_path / "home"
    path = home / ".nebula" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(CUT_SHORT, encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(settings, "SETTINGS_PATH", path)
    return path


SHOWN = f"~{os.sep}.nebula{os.sep}settings.json"
SAVE_LINE = f"Nothing was saved because Nebula can’t read {SHOWN}. Fix the file, then try again."


def test_a_cut_short_file_refuses_every_write_with_gms_line_and_keeps_the_file(cut_short):
    client = _person()
    for response in (client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "sk-new-1111"}}),
                     client.put("/api/settings", json={"favorites": []}),
                     client.delete("/api/settings/api-keys/FAL_KEY")):
        assert (response.status_code, response.json()["detail"]) == (409, SAVE_LINE)
    assert cut_short.read_text(encoding="utf-8") == CUT_SHORT


def test_a_cut_short_file_reads_as_cant_read_not_a_500(cut_short):
    response = _person().get("/api/settings")
    assert (response.status_code, response.json()["detail"]) == (
        409, f"Nebula can’t read {SHOWN}. Fix the file, then try again.")
    # Not an object at all reads the same.
    cut_short.write_text("[1, 2]", encoding="utf-8")
    assert _person().get("/api/settings").status_code == 409


def test_runs_still_fail_closed_on_a_cut_short_file(cut_short):
    # Every reader: the error is a ValueError, as json.load's own was.
    with pytest.raises(ValueError):
        settings.load_settings()
    assert isinstance(settings.SettingsUnreadable("x"), ValueError)


@pytest.mark.parametrize("check", [True, False], ids=["check", "write"])
@pytest.mark.parametrize("key", ["sk-new-1111", ""], ids=["save", "remove"])
def test_desktop_refuses_before_any_key_changes_on_a_cut_short_file(cut_short, monkeypatch, check, key):
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-injected-0000"})
    response = _person().post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": key,
                                                               **({"check": True} if check else {})})
    assert (response.status_code, response.json()["detail"]) == (409, SAVE_LINE)
    assert settings._INJECTED_KEYS == {"OPENAI_API_KEY": "sk-injected-0000"}
    assert cut_short.read_text(encoding="utf-8") == CUT_SHORT


def test_desktop_check_changes_nothing_on_a_readable_file(sockets, monkeypatch):  # noqa: F811
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-injected-0000"})
    before = sockets.read_text(encoding="utf-8")
    response = _person().post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111", "check": True})
    assert (response.status_code, response.json()) == (200, {"status": "ok"})
    assert settings._INJECTED_KEYS == {"OPENAI_API_KEY": "sk-injected-0000"}
    assert sockets.read_text(encoding="utf-8") == before
    # Its key refusals are the write's.
    refused = _person().post("/api/credentials/update", json={"provider": "HF_TOKEN", "key": "​", "check": True})
    assert refused.status_code == 422
    written = _person().post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111"})
    assert written.status_code == 200 and settings._INJECTED_KEYS["OPENAI_API_KEY"] == "sk-new-1111"


# -- review 12, NIT-1: live_cost counts an unknown kind as the gate does -----------------------


def test_live_cost_counts_an_unknown_kind_as_paid_never_free():
    from types import SimpleNamespace

    proposal = SimpleNamespace(key_params={"+i": {}}, cost={
        "paidRuns": 1, "planRuns": 0, "mayCostRuns": 1, "mayCost": [{"name": "Idol", "account": "Hugging Face"}],
        "freeRuns": 0,
        "nodes": [{"ref": "+n", "nodeId": None, "definitionId": "gpt-image-1-5", "kind": "someday", "provider": "openai",
                   "label": "paid · openai"},
                  {"ref": "+i", "nodeId": None, "definitionId": "speridlabs-idol", "kind": "mayCost", "provider": "speridlabs",
                   "label": "may cost · Hugging Face", "name": "Idol"}]})
    # The token is gone now: Idol is free, and the unknown kind is not.
    live = canvas_proposals.live_cost(proposal, REGISTRY, {})
    assert (live["mayCostRuns"], live["freeRuns"]) == (0, 1)


@pytest.mark.parametrize("ending", ["cancelled", "send-to-closed"])
def test_a_socket_that_ends_any_way_but_a_disconnect_is_unregistered(ending):
    """The same, with no timing in it: the handler's read is cancelled, or a
    send hits a socket already closed. Either way it leaves no socket."""
    import asyncio

    class Socket:
        def __init__(self):
            self.sent: list[str] = []

        async def accept(self):
            return None

        async def send_text(self, text):
            if ending == "send-to-closed" and len(self.sent) == 1:
                raise RuntimeError('Cannot call "send" once a close message has been sent.')
            self.sent.append(text)

        async def receive_text(self):
            raise asyncio.CancelledError()

    socket = Socket()
    with pytest.raises(asyncio.CancelledError if ending == "cancelled" else RuntimeError):
        asyncio.run(main.websocket_endpoint(socket))
    assert len(socket.sent) == (3 if ending == "cancelled" else 1)
    assert socket not in main.manager.active_connections and not main.manager.canvas_open()
