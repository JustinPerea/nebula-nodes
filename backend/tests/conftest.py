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
import contextlib
import contextvars
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


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    """The cursor checks go in before any fixture runs (PR #211 review 5,
    M3; see _install_cursor_route_check below).

    Root ignores file permissions, so a test that makes a file unreadable or
    unwritable with chmod proves nothing as root, and Claude Code cloud
    sessions run as root (CI doesn't). Such tests carry
    @pytest.mark.unprivileged; tests/test_unprivileged_marker.py keeps every
    one of them marked."""
    _install_cursor_route_check()
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
    # What the fixtures' undo left on main.manager (PR #211 review 5, M3).
    _check_instance_senders()
    import sys

    module = sys.modules.get("services.settings")
    if module is not None and Path(module.SETTINGS_PATH) != _TEST_SETTINGS_PATH:
        raise AssertionError(
            f"services.settings.SETTINGS_PATH is {module.SETTINGS_PATH} after {item.nodeid}; "
            f"restore it to {_TEST_SETTINGS_PATH} (reload with NEBULA_SETTINGS_PATH set)"
        )
    _assert_no_canvas_socket_left(item, sys.modules.get("main"))


def _assert_no_canvas_socket_left(item, main_module) -> None:
    """Fail the test that leaves a canvas socket registered in main.manager.

    The manager lives for the process, so a socket a test's /ws handler never
    removed made every later test see an open canvas: `nebula apply --arrange`
    then said "The open canvas lays out…" (the CI flake of 2026-11-02, after
    test_canvas_pins' websocket test). The handler now leaves the manager on
    every exit (main.websocket_endpoint's finally); this keeps it that way.
    The leftovers are cleared first so only the leaking test fails."""
    manager = getattr(main_module, "manager", None)
    if manager is None:
        return
    left = len(manager.active_connections) + len(manager.browser_connections)
    if not left:
        return
    manager.active_connections.clear()
    manager.browser_connections.clear()
    raise AssertionError(
        f"{item.nodeid} left {left} canvas socket(s) registered in main.manager; "
        "a /ws handler must call manager.disconnect on every exit (close a test's sockets "
        "with `with client.websocket_connect(...)`)")


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


class BroadcastCapture:
    """A stand-in for manager.broadcast_raw that takes what the real one
    takes, ``others=`` included (presence sends the person form as ``data``
    and the agent form as ``others``). ``sent`` is every call's ``data``;
    ``others`` holds each call's ``others`` (None when there was one form)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.others: list[dict | None] = []

    async def __call__(self, data, *, others=None, **_kw) -> None:
        self.sent.append(data)
        self.others.append(others)


@pytest.fixture
def broadcast_capture(monkeypatch) -> BroadcastCapture:
    """Patch main.manager.broadcast_raw with a BroadcastCapture. Use it in
    place of a hand-written fake (review 1 of PR #211, LOW-2)."""
    import main

    capture = BroadcastCapture()
    monkeypatch.setattr(main.manager, "broadcast_raw", capture)
    return capture


# -- every broadcast_raw stand-in takes ``others=`` (PR #211 review 2, LOW-3) --
#
# A stand-in that can't take ``others=`` raises a TypeError that _show_agent
# swallows, so presence events vanish from a test with no failure (review 1,
# LOW-2). The old guard read the test files' syntax and missed
# functools.partial, a class with __call__, string-path and keyword setattr
# and direct assignment. This checks behaviour instead: whatever sits at
# main.manager.broadcast_raw after any monkeypatch.setattr, and again when a
# test's body ends, must bind ``(data, others=None)``.

def broadcast_raw_takes_others(fake: object) -> bool:
    import inspect

    try:
        inspect.signature(fake).bind({}, others=None)  # type: ignore[arg-type]
    except TypeError:
        return False
    except ValueError:  # no signature to read (a C builtin): nothing to check
        return True
    return True


def _check_broadcast_raw(where: str) -> None:
    import sys

    manager = getattr(sys.modules.get("main"), "manager", None)
    fake = getattr(manager, "broadcast_raw", None) if manager is not None else None
    if fake is not None and not broadcast_raw_takes_others(fake):
        raise TypeError(
            f"{where}: main.manager.broadcast_raw is now {fake!r}, which can't take others=. "
            "Use the broadcast_capture fixture, or give the stand-in `**kw` and forward it.")


_monkeypatch_setattr = pytest.MonkeyPatch.setattr


def _checked_setattr(self, *args, **kwargs):  # type: ignore[no-untyped-def]
    # The cursor check goes in before anything is saved, so a fixture that
    # patches a sender saves (and puts back) the checked one (review 5, M3).
    _install_cursor_route_check()
    result = _monkeypatch_setattr(self, *args, **kwargs)
    _check_broadcast_raw("monkeypatch.setattr")
    _check_instance_senders()
    return result


pytest.MonkeyPatch.setattr = _checked_setattr  # type: ignore[method-assign]


# -- a cursor event with a target goes out only through _broadcast_presence --
#
# PR #211 review 4, LOW-1: the person's tabs must get a cursor event in the
# person form (its session and number), so every one is sent by
# main._broadcast_presence. The AST guards in test_agent_cursor_round4.py read
# the source; this checks behaviour, in every test, two ways (tests only: the
# backend itself refuses nothing, which would change the boundary):
#
# - The route: while a test runs, the ConnectionManager's senders record any
#   ``agentPresence`` with a target that reaches them from anywhere but
#   _broadcast_presence.
# - The content (review 5, LOW-1): no person-only frame (an ``agentPresence``
#   carrying ``session``, its key and number, or an ``agentPresenceReplay``)
#   may reach a socket that isn't the person's canvas. Checked on the real
#   senders, on every instance-level stand-in a test puts on main.manager,
#   and on the sockets themselves (Starlette's WebSocket.send_text,
#   send_json and send_bytes), so the replay sent on a verified hello is
#   checked too.
#
# Either one fails the test. The check is installed before any fixture runs
# (pytest_runtest_setup, tryfirst, and every monkeypatch.setattr), and a
# sender left on the manager instance by a fixture's undo is dropped before
# and after each test, so a patched sender can't blind it (review 5, M3).
# A stand-in, a Mock included, is wrapped in a proxy that checks each call
# and forwards everything else to it (review 6, MEDIUM-1). It is a check for
# the ways the suite patches senders (monkeypatch.setattr on the manager),
# not a wall: a test that patches the class, uses mock.patch.object or
# sends from a thread after the call phase can still go around it (review 6,
# LOW-1); the AST guards read main.py for those.

_PRESENCE_ROUTE: contextvars.ContextVar[bool] = contextvars.ContextVar("nebula_presence_route", default=False)
# Where the checks record a stray event while a test runs; None between tests.
_STRAY_CURSORS: list[str] | None = None
_SENDERS = ("broadcast_raw", "broadcast_others", "broadcast_browser")


def _targeted_cursor(data: object) -> bool:
    return isinstance(data, Mapping) and data.get("type") == "agentPresence" and data.get("target") is not None


def person_only_frame(data: object) -> bool:
    """A frame only the person's canvas may get: a cursor event in the person
    form (it carries ``session``) or the replay of the live cursors. Text or
    bytes are read as JSON; bytes in any encoding json reads (UTF-8, -16 or
    -32, a BOM included), else as UTF-8 with bad bytes replaced (review 7,
    NIT-2)."""
    import json

    if isinstance(data, (bytes, bytearray)):
        try:
            data = json.loads(bytes(data))
        except ValueError:
            data = bytes(data).decode("utf-8", "replace")
    if isinstance(data, str):
        if "agentPresence" not in data:
            return False
        try:
            data = json.loads(data)
        except ValueError:
            return False
    if not isinstance(data, Mapping):
        return False
    kind = data.get("type")
    # Also the carried cursors' new arrivals (#211 follow-up, r23 item 2) and
    # a person form's event id, which a log-only line carries with no session.
    return kind in ("agentPresenceReplay", "agentPresenceArrival") or (
        kind == "agentPresence" and ("session" in data or "eventId" in data))


def _record(line: str) -> None:
    stray = _STRAY_CURSORS
    if stray is not None:
        stray.append(line)


def _check_send(name: str, data: object, others: object, *, stand_in: bool = False) -> None:
    """Both checks for one call to a sender (or a stand-in for one)."""
    where = f"{name} (a stand-in)" if stand_in else name
    if not _PRESENCE_ROUTE.get() and (_targeted_cursor(data) or _targeted_cursor(others)):
        _record(f"{where}: {dict(data) if isinstance(data, Mapping) else data!r}")
    # What every socket that isn't the person's canvas gets from this call.
    to_others = None if name == "broadcast_browser" else (others if name == "broadcast_raw" and others is not None else data)
    if person_only_frame(to_others):
        _record(f"{where}: a person-only frame for the other sockets: {to_others!r}")


def _socket_check(send):  # type: ignore[no-untyped-def]
    import functools
    import sys

    @functools.wraps(send)
    async def checked(self, data, *args, **kwargs):  # type: ignore[no-untyped-def]
        if _STRAY_CURSORS is not None and person_only_frame(data):
            manager = getattr(sys.modules.get("main"), "manager", None)
            if manager is None or self not in getattr(manager, "browser_connections", ()):
                _record(f"{send.__name__}: a person-only frame to a socket that isn't the person's canvas: {data!r}")
        return await send(self, data, *args, **kwargs)

    checked._nebula_cursor_route = True  # type: ignore[attr-defined]
    _CHECKED_CODES.add(checked.__code__)
    return checked


# The code of this file's own checked wrappers: a stand-in is left as it is
# only if it is one of them (or a _CheckedStandIn), never because it says so
# (review 7, NIT-1: a Mock given the marker by hand).
_CHECKED_CODES: set[object] = set()


def _install_cursor_route_check() -> None:
    """Wrap main's senders and Starlette's socket sends once, for the rest of
    the run (and again if main is reloaded). Installed for good, not per
    test, so a monkeypatch that saves and restores a sender saves and
    restores the checked one."""
    import functools
    import sys

    from starlette.websockets import WebSocket

    for send_name in ("send_text", "send_json", "send_bytes"):
        send = WebSocket.__dict__.get(send_name)
        if send is not None and getattr(send, "_nebula_cursor_route", False) is not True:
            setattr(WebSocket, send_name, _socket_check(send))
    main = sys.modules.get("main")
    manager_class = getattr(main, "ConnectionManager", None)
    route = getattr(main, "_broadcast_presence", None)
    if manager_class is None or route is None:
        return
    if getattr(route, "_nebula_cursor_route", False) is not True:
        @functools.wraps(route)
        async def routed(*args, **kwargs):  # type: ignore[no-untyped-def]
            token = _PRESENCE_ROUTE.set(True)
            try:
                return await route(*args, **kwargs)
            finally:
                _PRESENCE_ROUTE.reset(token)

        routed._nebula_cursor_route = True  # type: ignore[attr-defined]
        main._broadcast_presence = routed
    for name in _SENDERS:
        sender = manager_class.__dict__.get(name)
        if sender is None or getattr(sender, "_nebula_cursor_route", False) is True:
            continue

        def checked(sender=sender, name=name):  # type: ignore[no-untyped-def]
            @functools.wraps(sender)
            async def send(self, data, *args, **kwargs):  # type: ignore[no-untyped-def]
                if _STRAY_CURSORS is not None:
                    _check_send(name, data, kwargs.get("others"))
                return await sender(self, data, *args, **kwargs)
            send._nebula_cursor_route = True  # type: ignore[attr-defined]
            _CHECKED_CODES.add(send.__code__)
            return send

        setattr(manager_class, name, checked())
    _check_instance_senders()


def _check_instance_senders() -> None:
    """Senders on the manager instance itself (they shadow the class's):
    a bound copy of the class's own sender, checked or not, which a
    monkeypatch undo leaves behind, is dropped; any other stand-in is
    wrapped so both checks see what it is sent."""
    import sys

    main = sys.modules.get("main")
    manager = getattr(main, "manager", None)
    manager_class = getattr(main, "ConnectionManager", None)
    if manager is None or manager_class is None or not hasattr(manager, "__dict__"):
        return
    own = vars(manager)
    for name in _SENDERS:
        if name not in own:
            continue
        value = own[name]
        func = getattr(value, "__func__", None)
        real = manager_class.__dict__.get(name)
        if getattr(value, "__self__", None) is manager and func is not None and (
                func is real or func is getattr(real, "__wrapped__", None)):
            del own[name]  # (a bound method reads its function's marker, so this goes first)
            continue
        # By what it is, not by the marker: a Mock makes up any attribute it
        # is asked for (review 6, MEDIUM-1), and one can be given the marker
        # by hand (review 7, NIT-1).
        if type(value) is _CheckedStandIn or getattr(getattr(value, "__func__", value), "__code__", None) in _CHECKED_CODES:
            continue
        own[name] = _CheckedStandIn(value, name)


class _CheckedStandIn:
    """A stand-in for a sender, checked: each call goes through both checks,
    then to the stand-in; every attribute is the stand-in's own, read when
    asked (a Mock's ``await_args``, a capture's ``sent``), so the test reads
    it as if nothing were in between (review 6, MEDIUM-1 and N4)."""

    _nebula_cursor_route = True

    def __init__(self, fake: object, name: str) -> None:
        object.__setattr__(self, "_fake", fake)
        object.__setattr__(self, "_name", name)

    def __call__(self, data, *args, **kwargs):  # type: ignore[no-untyped-def]
        if _STRAY_CURSORS is not None:
            _check_send(self._name, data, kwargs.get("others"), stand_in=True)
        return self._fake(data, *args, **kwargs)  # type: ignore[operator]

    def __getattr__(self, attr: str):  # type: ignore[no-untyped-def]
        return getattr(object.__getattribute__(self, "_fake"), attr)

    def __setattr__(self, attr: str, value: object) -> None:
        setattr(self._fake, attr, value)

    def __delattr__(self, attr: str) -> None:
        delattr(self._fake, attr)

    def __repr__(self) -> str:
        return f"<checked {self._fake!r}>"


@contextlib.contextmanager
def watch_cursor_routes():  # type: ignore[no-untyped-def]
    """Record, for the block, every cursor event with a target that reaches a
    sender other than through main._broadcast_presence, and every
    person-only frame bound for a socket that isn't the person's canvas."""
    global _STRAY_CURSORS
    _install_cursor_route_check()
    outer, _STRAY_CURSORS = _STRAY_CURSORS, []
    try:
        yield _STRAY_CURSORS
    finally:
        _STRAY_CURSORS = outer


@pytest.hookimpl(wrapper=True)
def pytest_runtest_call(item):  # type: ignore[no-untyped-def]
    with watch_cursor_routes() as stray:
        result = yield
    _check_broadcast_raw(item.nodeid)  # catches a direct assignment left in place
    if stray:
        raise AssertionError(
            f"{item.nodeid}: a cursor event with a target went out other than through "
            f"main._broadcast_presence, or a person-only frame reached another socket "
            f"(PR #211 review 4 and review 5, LOW-1): {stray[0]}")
    return result
