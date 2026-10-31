"""Pytest setup: sandbox file-system paths so tests never touch the user's
real working tree.

- NEBULA_STATE_DIR → temp dir, so auto-persist of cli_graph doesn't overwrite
  the user's real ~/.nebula/state.json.
- NEBULA_OUTPUT_ROOT → temp dir, so handlers that write generated images
  (and the three handler tests that `shutil.rmtree` their root at teardown)
  don't wipe the user's real output/ directory. The old behavior destroyed
  hours of Daedalus work when the test suite ran against the shared OUTPUT_ROOT.
- NEBULA_SETTINGS_PATH → temp file, so save_settings() (called by PUT
  /api/settings) writes to a throwaway file instead of the real repo
  settings.json. Without this, a full pytest run rewrites the real
  settings.json with apiKeys:{} on every execution.

All must be set BEFORE any test module imports `main` or `services.output`,
which happens at collection time for files that do `from main import app`.
They live in one temp folder that is removed when the run exits, so test runs
don't pile up folders in /tmp (a run that is killed still leaves its one).
"""
from __future__ import annotations

import atexit
import os
import shutil
import tempfile
from collections.abc import Mapping
import uuid
from pathlib import Path

_TEST_ROOT = Path(tempfile.mkdtemp(prefix="nebula-test-"))
atexit.register(shutil.rmtree, _TEST_ROOT, ignore_errors=True)


def _sandbox_dir(name: str) -> Path:
    path = _TEST_ROOT / name
    path.mkdir()
    return path


_TEST_STATE_DIR = _sandbox_dir("state")
os.environ["NEBULA_STATE_DIR"] = str(_TEST_STATE_DIR)

_TEST_OUTPUT_DIR = _sandbox_dir("output")
os.environ["NEBULA_OUTPUT_ROOT"] = str(_TEST_OUTPUT_DIR)

_TEST_CHARACTER_DIR = _sandbox_dir("characters")
os.environ["NEBULA_CHARACTER_ROOT"] = str(_TEST_CHARACTER_DIR)

# Moodboard routes write under ~/.nebula/moodboards otherwise; tests that
# create boards through the API (not the store) rely on this.
_TEST_MOODBOARD_DIR = _sandbox_dir("moodboards")
os.environ["NEBULA_MOODBOARD_ROOT"] = str(_TEST_MOODBOARD_DIR)

_TEST_PRESET_DIR = _sandbox_dir("presets")
os.environ["NEBULA_PRESET_ROOT"] = str(_TEST_PRESET_DIR)

_TEST_SETTINGS_PATH = _sandbox_dir("settings") / "settings.json"
os.environ["NEBULA_SETTINGS_PATH"] = str(_TEST_SETTINGS_PATH)

_TEST_COMMONS_DIR = _sandbox_dir("commons")
os.environ["NEBULA_COMMONS_ROOT"] = str(_TEST_COMMONS_DIR)
os.environ["NEBULA_COMMONS_NO_STARTUP_SCAN"] = "1"
# The one-time project re-home (services/asset_project_rehome.py) would move
# other tests' boards out of made-up project folders when a TestClient starts
# the app; tests/test_asset_project_rehome.py runs it directly.
os.environ["NEBULA_NO_ASSET_REHOME"] = "1"
# Ordinary tests exercise the released default: Commons remains inactive.
os.environ.pop("NEBULA_COMMONS_ENABLED", None)

import pytest  # noqa: E402

from services.saved_graph_upgrades import PARAMS_VERSION  # noqa: E402  (pure: reads no env)


def pytest_collection_modifyitems(config, items):
    """CI runs the suite in parts, one per job (.github/workflows/ci.yml).
    With NEBULA_TEST_SHARD="i/n" set, only part i's files run; unset, all do."""
    value = os.environ.get("NEBULA_TEST_SHARD")
    if not value:
        return
    from collections import Counter

    from .ci_shard import assign_files, parse_shard

    try:
        index, count = parse_shard(value)
    except ValueError as error:
        raise pytest.UsageError(str(error)) from None
    files = [item.nodeid.split("::", 1)[0] for item in items]
    parts = assign_files(Counter(files), count)
    kept = [item for item, path in zip(items, files) if parts[path] == index]
    dropped = [item for item, path in zip(items, files) if parts[path] != index]
    if dropped:
        config.hook.pytest_deselected(items=dropped)
    items[:] = kept


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "unprivileged: needs file permissions to hold; skipped as root, which ignores them",
    )


def pytest_runtest_setup(item):
    """Root ignores file permissions, so a test that makes a file unreadable or
    unwritable with chmod proves nothing as root, and Claude Code cloud
    sessions run as root (CI doesn't). Such tests carry
    @pytest.mark.unprivileged; tests/test_unprivileged_marker.py keeps every
    one of them marked."""
    if item.get_closest_marker("unprivileged") and hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root ignores file permissions; CI runs this as a normal user")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item, nextitem):
    """Fail the test that leaves services.settings pointing anywhere but the
    sandbox file above, checked after all of its fixtures (and monkeypatch)
    have been undone. Tests that reload the module (test_settings_path.py,
    test_credential_injection.py) once restored it by removing the variable,
    which falls back to the repo's real settings.json: every later test then
    read the person's keys and wrote their settings."""
    yield
    import sys

    module = sys.modules.get("services.settings")
    if module is not None and Path(module.SETTINGS_PATH) != _TEST_SETTINGS_PATH:
        raise AssertionError(
            f"services.settings.SETTINGS_PATH is {module.SETTINGS_PATH} after {item.nodeid}; "
            f"restore it to {_TEST_SETTINGS_PATH} (reload with NEBULA_SETTINGS_PATH set)"
        )


@pytest.fixture(autouse=True)
def empty_model_cache():
    """Each test starts and ends with an empty provider model cache (review
    14, L-G): services.model_cache lives for the process, so a model list one
    test cached (OpenRouter's, for 5 minutes) answered a later test's picker
    before its own fixture's keys were read, and its outcome depended on test
    order."""
    from services.model_cache import model_cache

    model_cache.clear()
    yield
    model_cache.clear()


@pytest.fixture(autouse=True)
def isolated_commons_opt_in(request, monkeypatch):
    """Only the dedicated synthetic Commons tests opt into store access."""
    name = request.node.path.name
    controls_activation = name in {
        "test_commons_activation.py", "test_commons_clients_activation.py",
        "test_commons_integration.py",
    }
    if (name.startswith("test_commons_") and not controls_activation) or name == "test_agent_workspace_authority.py":
        monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")


@pytest.fixture
def canvas_project(tmp_path, monkeypatch) -> str:
    """The id of a real canvas project, in a project store of this test's own
    (main.project_store). A new project Character, Moodboard or Style must name
    one (main._require_canvas_project). It is open on the canvas, as the
    project "current" means."""
    import main
    from services.project_store import ProjectStore, make_project

    store = ProjectStore(tmp_path / "canvas-projects")
    with store.transaction() as catalog:
        project = make_project("Test project")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    monkeypatch.setattr(main, "project_store", store)
    return project["id"]


@pytest.fixture
def spending_limits_off(monkeypatch):
    """Run as if the person turned agent spending limits off in Settings.

    For tests about other parts of a run (provider admission, quick, gateways)
    that call run routes the way an agent does, without the canvas's Origin.
    The limits themselves are tested in tests/test_agent_spend.py. Patching
    the reader, not settings.json, keeps it in force when a test rewrites its
    settings."""
    from services import agent_spend

    monkeypatch.setattr(agent_spend, "threshold_from_settings", lambda settings: None)
    monkeypatch.setattr(agent_spend, "caps_from_settings",
                        lambda settings: {"sessionUsd": None, "outsideDailyUsd": None, "kreaPlanRuns": None,
                                          "models": {}})


@pytest.fixture
def run_shot_task(monkeypatch, spending_limits_off):
    """Run one Cinema shot through POST /api/cinema/generate-shot's own task
    (main.generate_cinema_shot) and wait for it to end.

    For tests about what that task writes back (the shot's output, its
    terminal error); what comes before the task (validation, base models,
    spend) is tested elsewhere and is waved through here. The tests patch
    execute_graph; ``scene`` is the scene node as the canvas sends it."""
    import main
    from models.graph import GenerateShotRequest

    monkeypatch.setattr(main, "validate_graph", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(main, "_validate_cinema_base_models", lambda *_args: None)

    async def run(scene, shot_id: str) -> None:
        run_id = f"test-shot-{uuid.uuid4().hex}"
        response = await main.generate_cinema_shot(GenerateShotRequest(
            nodes=[scene], edges=[], nodeId=scene.id, shotId=shot_id, runId=run_id))
        assert response["status"] == "started", response
        record = main.execution_runs.get(run_id)
        assert record is not None
        await record.task

    return run


# The person's launch token in tests (services/person_session.py). The
# `person` fixture installs it; without that fixture it verifies as nothing.
PERSON_TOKEN = "test-person-token-" + "0" * 25
# The canvas sends its params version on every request, and a browser request
# without one is refused as a tab from before the gate (main.py
# _params_outdated). A local program copying the canvas copies it too.
CANVAS_PARAMS_VERSION = {"X-Nebula-Params-Version": str(PARAMS_VERSION)}
# What the person's canvas sends. A real browser also sends Origin, which
# proves nothing on its own: FORGED_ORIGIN is what any local program can send.
PERSON = {"Origin": "http://localhost:5173", "X-Nebula-Person": PERSON_TOKEN, **CANVAS_PARAMS_VERSION}
FORGED_ORIGIN = {"Origin": "http://localhost:5173", **CANVAS_PARAMS_VERSION}
PERSON_HELLO = {"type": "hello", "personToken": PERSON_TOKEN}


class TabHeaders(Mapping):
    """What a canvas tab sends on a graph write: ``base`` (PERSON and
    X-Nebula-Tab) plus the open workspace's revision, read when the request
    is made. Round 19 of PR #195: Nebula refuses a tab's write that carries no
    revision on a route that writes the graph (marked ``main.graph_write``
    since round 20), as the canvas's apiFetch always sends one while a
    project is open."""

    def __init__(self, base: Mapping[str, str]) -> None:
        self._base = dict(base)

    def _live(self) -> dict[str, str]:
        # A tab says its params version on every request, beside the revision.
        live = {**CANVAS_PARAMS_VERSION, **self._base}
        if "X-Nebula-Workspace-Revision" in live:
            return live
        import main
        return {**live, "X-Nebula-Workspace-Revision": main.project_store.workspace()["workspaceRevision"]}

    def __getitem__(self, key: str) -> str:
        return self._live()[key]

    def __iter__(self):
        return iter(self._live())

    def __len__(self) -> int:
        return len(self._live())


class PersonFixture:
    """This test's person: the launch token and the headers the canvas sends."""

    def __init__(self, token: str) -> None:
        self.token = token
        self.headers = {"Origin": "http://localhost:5173", "X-Nebula-Person": token, **CANVAS_PARAMS_VERSION}
        self.hello = {"type": "hello", "personToken": token}


@pytest.fixture
def fresh_person_session(monkeypatch):
    """Swap in an empty person session (services/person_session.py), the one
    object the person gate, /ws, /ws/chat and Commons all read."""
    from services import person_session

    session = person_session.PersonSession()
    monkeypatch.setattr(person_session, "_session", session)
    monkeypatch.setattr(person_session, "_provided", None)
    return session


@pytest.fixture
def person(fresh_person_session) -> PersonFixture:
    """A person session holding PERSON_TOKEN. Send ``PERSON`` (or
    ``person.headers``) where the canvas would, and keep forged-Origin cases
    (FORGED_ORIGIN) as negatives."""
    fresh_person_session.set(PERSON_TOKEN)
    return PersonFixture(PERSON_TOKEN)


def stored_image_urls(count: int = 3, *, name: str = "view") -> list[str]:
    """``count`` small images in the test output folder, as /api/uploads
    leaves them, and their /api/outputs URLs. A Character's referenceViews and
    a Style's refImages and thumbnail must be Nebula's own files
    (services/stored_image_refs.py). Call it where the test writes one, not at
    import: some tests empty the output folder."""
    from services.output import OUTPUT_ROOT

    folder = OUTPUT_ROOT / "chat-uploads"
    folder.mkdir(parents=True, exist_ok=True)
    urls = []
    for index in range(count):
        path = folder / f"test-{name}-{index}.png"
        if not path.exists():
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes([index % 256]) * 16)
        urls.append(f"/api/outputs/chat-uploads/{path.name}")
    return urls


async def asgi_get(app, path: str, query: str = "", headers: dict | None = None, gone=None) -> dict:
    """GET `path` straight through the ASGI app, as a client that hangs up
    when `gone` (an asyncio.Event) is set; until then it stays connected, as
    uvicorn's receive does (it answers http.disconnect only once the client
    closes the connection). Returns {"status": int | None, "body": bytes}.

    TestClient and httpx's ASGITransport can't do this: their receive only
    says disconnect after the response is complete, and cancelling the client
    cancels the app with it, so a long-poll whose client went away is never
    seen by the route."""
    import asyncio

    sent_request = False
    answer: dict = {"status": None, "body": b""}

    async def receive() -> dict:
        nonlocal sent_request
        if not sent_request:
            sent_request = True
            return {"type": "http.request", "body": b"", "more_body": False}
        if gone is None:
            await asyncio.Event().wait()  # never: a client that stays
        await gone.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            answer["status"] = message["status"]
        elif message["type"] == "http.response.body":
            answer["body"] += message.get("body", b"")

    raw = [(b"host", b"testserver")] + [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
             "method": "GET", "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
             "query_string": query.encode(), "headers": raw, "client": ("testclient", 50000),
             "server": ("testserver", 80)}
    await app(scope, receive, send)
    return answer
