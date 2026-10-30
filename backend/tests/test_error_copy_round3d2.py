"""Error copy round 3d, part 2: the status comes from the call, not the text.

Round 3d's table found a provider's HTTP status by searching the error text,
provider bodies included. That read facts out of free text again (the bug 3c
fixed): a presigned storage upload's 403 read as a refused key, and "Prompt is
too long: 500 characters over" read as provider trouble. Now:

- A raise after the provider's own API answered attaches that status to the
  exception (person_line.with_api_status); uploads to storage URLs and
  downloads of results attach none and keep today's line.
- A terminal job failure is marked where it is raised (as_job_failure), not
  matched by its wording; it never takes the key, busy or trouble lines, and
  the classifier never calls it ``auth``.
- A status written in text alone never selects a table line.
- A fal.ai stream job still running when Nebula stops polling gets GM's
  slow-job line.
- The id guard catches "gen4_turbo", "MiniMax-Hailuo-02", "nano-banana-pro"
  and "owner/name".

Exception texts (what agents, MCP, the run record and the journal read) are
unchanged; every site test asserts the exact text beside the line.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from execution.engine import execute_graph
from execution.person_line import person_line, slow_job_line
from models.events import ErrorEvent
from models.graph import GraphEdge, GraphNode, PortValueDict

BACKEND = Path(__file__).resolve().parent.parent
_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _node(definition_id: str, params: dict[str, Any] | None = None, *, node_id: str = "n1") -> GraphNode:
    return GraphNode(id=node_id, definitionId=definition_id, params=params or {}, outputs={})


def _port(value: Any, port_type: str = "Text") -> PortValueDict:
    return PortValueDict(type=port_type, value=value)


def _raised(fn, *args, **kwargs) -> BaseException:
    with pytest.raises(Exception) as info:
        fn(*args, **kwargs)
    return info.value


async def _araised(fn, *args, **kwargs) -> BaseException:
    with pytest.raises(Exception) as info:
        await fn(*args, **kwargs)
    return info.value


def _card(exc: BaseException, definition_id: str, params: dict[str, Any] | None = None,
          api_keys: dict[str, str] | None = None):
    from execution.provider_status import card_line

    return card_line(exc, definition_id, params or {}, api_keys or {})


def _mock_clients(monkeypatch, module, handler) -> None:
    """Every httpx.AsyncClient the module opens answers through `handler`."""
    transport = httpx.MockTransport(handler)

    def client(*args, **kwargs):
        kwargs.pop("transport", None)
        return _REAL_ASYNC_CLIENT(*args, transport=transport, **kwargs)

    monkeypatch.setattr(module.httpx, "AsyncClient", client)


# -- 1. a status written in text alone never selects a line -------------------

TEXT_ONLY = [
    # A presigned storage upload: the key worked, it issued the upload ticket.
    ("Runway upload failed (403): <Error><Code>AccessDenied</Code></Error>", "runway-image",
     {"RUNWAY_API_KEY": "x"}),
    ("Krea Files upload failed (403)", "krea-files-save", {"KREA_API_TOKEN": "x"}),
    # A number after a colon is not a status.
    ("Prompt is too long: 500 characters over", "meshy-text-to-3d", {"MESHY_API_KEY": "x"}),
    ("Too many frames: 500 max", "meshy-text-to-3d", {"MESHY_API_KEY": "x"}),
    # A job's own error, with an input URL's status inside it.
    ("Async job failed: HTTPError: 403 Client Error: Forbidden for url: https://cdn.example/a.png",
     "runway-image", {"RUNWAY_API_KEY": "x"}),
]


@pytest.mark.parametrize("text, definition_id, keys", TEXT_ONLY)
def test_a_status_in_text_alone_never_selects_a_line(text, definition_id, keys) -> None:
    from execution.provider_status import http_status

    exc = RuntimeError(text)
    assert http_status(exc) is None
    card = _card(exc, definition_id, {}, keys)
    assert card.person is None
    assert card.provider_text is False


@pytest.mark.parametrize("status", [401, 402, 403, 429, 500, 503])
@pytest.mark.parametrize("shape", ["Meshy submit failed ({}): no", "Meshy API error {}: no", "Meshy (HTTP {})",
                                   "Meshy: {} no", "{}: forbidden", "Meshy status {}"])
def test_no_text_shape_is_read_as_a_status(shape, status) -> None:
    from execution.provider_status import http_status

    exc = RuntimeError(shape.format(status))
    assert http_status(exc) is None
    # Credits and rate-limit words are words, not a status: only those cases
    # may still read a line.
    assert _card(exc, "meshy-text-to-3d", {}, {"MESHY_API_KEY": "x"}).person is None


def test_the_free_text_search_and_the_job_pattern_are_gone() -> None:
    import execution.provider_status as provider_status

    assert not hasattr(provider_status, "_STATUS_SHAPES")
    assert not hasattr(provider_status, "_JOB_FAILED")


# -- 2. the status the provider's API answered, attached where it is raised ---


def test_an_attached_status_selects_the_line_and_changes_no_text() -> None:
    from execution.person_line import api_status, with_api_status

    exc = with_api_status(RuntimeError("Meshy submit failed (429): slow down"), 429)
    assert str(exc) == "Meshy submit failed (429): slow down"
    assert api_status(exc) == 429
    card = _card(exc, "meshy-text-to-3d", {}, {"MESHY_API_KEY": "x"})
    assert card.person == "Meshy is busy. Wait a moment, then run the node again."
    assert card.provider_text is True
    # Only an HTTP status attaches.
    assert api_status(with_api_status(RuntimeError("x"), None)) is None
    assert api_status(with_api_status(RuntimeError("x"), True)) is None
    assert api_status(with_api_status(RuntimeError("x"), 42)) is None


@pytest.mark.asyncio
async def test_runways_presigned_upload_keeps_todays_line_and_its_api_says_the_key(monkeypatch, tmp_path) -> None:
    import handlers.runway as runway
    from execution.person_line import api_status

    clip = tmp_path / "a.png"
    clip.write_bytes(b"png")

    def storage_refuses(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.dev.runwayml.com":
            return httpx.Response(200, json={"uploadUrl": "https://storage.example/put", "fields": {},
                                             "runwayUri": "runway://a"})
        return httpx.Response(403, text="<Error><Code>AccessDenied</Code></Error>")

    _mock_clients(monkeypatch, runway, storage_refuses)
    exc = await _araised(runway._upload_ephemeral, clip, "fixture", "image/png")
    assert str(exc) == "Runway upload failed (403): <Error><Code>AccessDenied</Code></Error>"
    assert api_status(exc) is None
    assert _card(exc, "runway-image", {}, {"RUNWAY_API_KEY": "x"}).person is None

    _mock_clients(monkeypatch, runway, lambda request: httpx.Response(401, text="bad key"))
    exc = await _araised(runway._upload_ephemeral, clip, "fixture", "image/png")
    assert str(exc) == "Runway upload could not start (401): bad key"
    assert api_status(exc) == 401
    assert _card(exc, "runway-image", {}, {"RUNWAY_API_KEY": "x"}).person == (
        "Runway didn't accept your API key. Check it in Settings, then run the node again.")


@pytest.mark.asyncio
async def test_a_krea_files_storage_upload_keeps_todays_line(tmp_path) -> None:
    from execution.person_line import api_status
    from handlers.krea_workspace import _send_file

    path = tmp_path / "a.png"
    path.write_bytes(b"png")
    transport = httpx.MockTransport(lambda request: httpx.Response(403, text="AccessDenied"))
    async with httpx.AsyncClient(transport=transport) as client:
        exc = await _araised(_send_file, client, {"uploadUrl": "https://storage.example/put"}, path, "image/png")
        assert str(exc) == "Krea Files upload failed (403)"
        assert api_status(exc) is None
        transport_ok = httpx.MockTransport(lambda request: httpx.Response(
            200 if request.url.path == "/put" else 403))
    async with httpx.AsyncClient(transport=transport_ok) as client:
        exc = await _araised(_send_file, client, {"uploadUrl": "https://storage.example/put",
                                                  "commitUrl": "https://storage.example/commit"}, path, "image/png")
        assert str(exc) == "Krea Files upload commit failed (403)"
        assert api_status(exc) is None
    assert _card(exc, "krea-files-save", {}, {"KREA_API_TOKEN": "x"}).person is None


@pytest.mark.parametrize("status, line", [
    (401, "Meshy didn't accept your API key. Check it in Settings, then run the node again."),
    (402, "Your Meshy account is out of credits. Add credits, then run the node again."),
    (429, "Meshy is busy. Wait a moment, then run the node again."),
    (503, "Meshy is having trouble right now. Try again in a few minutes."),
])
@pytest.mark.asyncio
async def test_meshys_submit_attaches_its_status(monkeypatch, status, line) -> None:
    import handlers.meshy as meshy
    from execution.person_line import api_status

    _mock_clients(monkeypatch, meshy, lambda request: httpx.Response(status, text="said no"))
    exc = await _araised(meshy.handle_meshy_text_to_3d, _node("meshy-text-to-3d"), {"prompt": _port("a chair")},
                         {"MESHY_API_KEY": "fixture"})
    assert str(exc) == f"Meshy submit failed ({status}): said no"
    assert api_status(exc) == status
    assert _card(exc, "meshy-text-to-3d", {}, {"MESHY_API_KEY": "x"}).person == line


@pytest.mark.asyncio
async def test_the_shared_poll_runners_submit_and_poll_attach_their_status(monkeypatch) -> None:
    import execution.async_poll_runner as runner
    from execution.person_line import api_status
    from handlers.runway import _runway_poll_config

    config = _runway_poll_config("fixture", "https://api.dev.runwayml.com/v1/image_to_video")
    config.poll_interval = 0
    _mock_clients(monkeypatch, runner, lambda request: httpx.Response(429, text="slow down"))

    async def emit(_event):
        return None

    exc = await _araised(runner.async_poll_execute, config, {}, "n1", emit)
    assert str(exc) == "Async submit failed (429): slow down"
    assert api_status(exc) == 429
    transport = httpx.MockTransport(lambda request: httpx.Response(
        401 if request.method == "GET" else 204, text="expired"))
    async with _REAL_ASYNC_CLIENT(transport=transport) as client:
        exc = await _araised(runner.poll_until_terminal, client, config, "task-1", "n1", emit)
    assert str(exc) == "Poll request failed (401): expired"
    assert api_status(exc) == 401


def test_krea_world_labs_openrouter_and_replicate_errors_attach_their_status() -> None:
    from execution.person_line import api_status
    from handlers.krea import _raise_for_krea_response
    from handlers.openrouter_media import _error as openrouter_error
    from handlers.replicate_model import _error as replicate_error
    from handlers.worldlabs import _raise_api_error

    exc = _raised(_raise_for_krea_response, httpx.Response(402, json={"error": "Krea API balance is depleted"}),
                  "generate")
    assert str(exc) == "Krea generate failed (402): Krea API balance is depleted"
    assert api_status(exc) == 402
    exc = _raised(_raise_api_error, "world generation", httpx.Response(503, text="down"))
    assert str(exc) == "World Labs world generation failed (503): down"
    assert api_status(exc) == 503
    exc = openrouter_error(httpx.Response(429, json={"error": {"message": "slow"}}), "video")
    assert str(exc) == "OpenRouter is rate-limiting this key (429: slow). Wait a moment, then run again."
    assert api_status(exc) == 429
    exc = replicate_error(httpx.Response(500, text="boom"), "prediction")
    assert str(exc) == "Replicate prediction failed (500): boom"
    assert api_status(exc) == 500


@pytest.mark.asyncio
async def test_elevenlabs_voice_list_refusal_attaches_its_status() -> None:
    from execution.person_line import api_status
    from handlers.elevenlabs import _get_voices_page

    transport = httpx.MockTransport(lambda request: httpx.Response(401, json={"detail": "invalid key"}))
    async with httpx.AsyncClient(transport=transport) as client:
        exc = await _araised(_get_voices_page, client, "fixture", {})
    assert str(exc) == ("ElevenLabs rejected the API key while listing voices (error 401: invalid key). "
                        "Check ELEVENLABS_API_KEY in Settings.")
    assert api_status(exc) == 401


@pytest.mark.asyncio
async def test_a_chat_stream_refusal_attaches_its_status(monkeypatch) -> None:
    import execution.stream_runner as stream_runner
    from execution.person_line import api_status

    _mock_clients(monkeypatch, stream_runner, lambda request: httpx.Response(503, text="overloaded upstream"))

    async def emit(_event):
        return None

    config = stream_runner.StreamConfig(url="https://api.anthropic.com/v1/messages", headers={})
    exc = await _araised(stream_runner.stream_execute, config, {}, "n1", emit)
    assert str(exc) == "Stream request failed (503): overloaded upstream"
    assert api_status(exc) == 503


def test_quivers_wrapped_errors_keep_their_status() -> None:
    from execution.person_line import api_status
    from handlers.quiver import _wrap_provider_error
    from services.quiver_client import QuiverRateLimitError, QuiverServerError

    exc = _wrap_provider_error(QuiverServerError("Quiver server error (502)", status_code=502))
    assert str(exc) == "QuiverAI server error: Quiver server error (502)"
    assert api_status(exc) == 502
    exc = _wrap_provider_error(QuiverRateLimitError("Quiver rate limit exceeded", status_code=429))
    assert str(exc) == "QuiverAI rate limit exceeded — retry in a moment"
    assert api_status(exc) == 429


# -- the guard: a status in a raise's text is attached, or excluded with a reason


SCAN_DIRS = ("handlers", "execution", "services")
STATUS_WRAPPER = "with_api_status"
# A call that isn't the provider's own API with the person's key: a presigned
# or storage upload, a download of a result or an input. Its raise says why on
# the line before or on it, and keeps today's line.
EXCLUSION = re.compile(r"#\s*no API status:")
_STATUS_IN_TEXT = re.compile(
    r"\((?:HTTP\s*)?[1-5]\d\d(?:\)|:)|\b(?:error|HTTP|status)\s+[1-5]\d\d\b")


def _status_names(function: ast.AST) -> set[str]:
    """Names a function assigns from an HTTP status (``status = response.status_code``)."""
    names: set[str] = set()
    for node in ast.walk(function):
        if isinstance(node, ast.Assign) and "status_code" in ast.unparse(node.value):
            names.update(target.id for target in node.targets if isinstance(target, ast.Name))
        if isinstance(node, ast.arg) and node.arg == "status_code":
            names.add("status_code")
    return names


def _exception_calls(path: Path):
    """(call, text node, enclosing function, wrapped in with_api_status) for every exception built."""
    tree = ast.parse(path.read_text())
    parents: dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
        if not name.endswith(("Error", "Exception")):
            continue
        function = node
        while function in parents and not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function = parents[function]
        parent = parents.get(node)
        wrapped = (isinstance(parent, ast.Call) and getattr(parent.func, "id", "") == STATUS_WRAPPER
                   and parent.args and parent.args[0] is node)
        yield node, function, wrapped


def _writes_a_status(call: ast.Call, function: ast.AST, source: str) -> bool:
    if any(keyword.arg in {"status_code", "status"} for keyword in call.keywords):
        return False  # a typed error that carries it (QuiverError, TypeSafeError)
    names = _status_names(function)
    for arg in call.args:
        for part in ast.walk(arg):
            if isinstance(part, ast.FormattedValue):
                expression = ast.unparse(part.value)
                if "status_code" in expression or expression in names:
                    return True
            if isinstance(part, ast.Constant) and isinstance(part.value, str) and _STATUS_IN_TEXT.search(part.value):
                return True
    return False


def _unattached_statuses() -> list[str]:
    found = []
    for folder in SCAN_DIRS:
        for path in sorted((BACKEND / folder).rglob("*.py")):
            source = path.read_text()
            lines = source.splitlines()
            for call, function, wrapped in _exception_calls(path):
                if wrapped or not _writes_a_status(call, function, source):
                    continue
                around = "\n".join(lines[max(0, call.lineno - 3):call.end_lineno or call.lineno])
                if EXCLUSION.search(around):
                    continue
                found.append(f"{path.relative_to(BACKEND)}:{call.lineno}: {ast.unparse(call)[:120]}")
    return found


def test_every_raise_that_writes_a_status_attaches_it() -> None:
    unattached = _unattached_statuses()
    assert not unattached, (
        "These exceptions write a provider's HTTP status into their text without attaching it. "
        "The card reads the status from the call, never the text: build the exception inside "
        "with_api_status(exc, response.status_code) (execution/person_line.py) when the provider's "
        "own API answered, or say why not on the line before it with '# no API status: <why>' "
        "(a presigned or storage upload, a download of a result or an input).\n" + "\n".join(unattached))


def test_the_guard_finds_an_unattached_status() -> None:
    sample = ast.parse('def f(response):\n    raise RuntimeError(f"X failed ({response.status_code}): no")\n')
    function = sample.body[0]
    call = function.body[0].exc
    assert _writes_a_status(call, function, "")
    named = ast.parse('def f(response):\n    status = response.status_code\n    return RuntimeError(f"X ({status})")\n')
    assert _writes_a_status(named.body[0].body[1].value, named.body[0], "")
    literal = ast.parse('def f():\n    raise RuntimeError("X rejected the key (error 401: no)")\n')
    assert _writes_a_status(literal.body[0].body[0].exc, literal.body[0], "")
    typed = ast.parse('def f(s):\n    raise QuiverError(f"Q ({s})", status_code=s)\n')
    assert not _writes_a_status(typed.body[0].body[0].exc, typed.body[0], "")


def test_storage_uploads_and_downloads_say_why_they_attach_no_status() -> None:
    # The list in the notes: each keeps today's line.
    excluded = {
        "handlers/runway.py": ["Runway upload failed ("],
        "handlers/krea_workspace.py": ["Krea Files upload failed (", "Krea Files upload commit failed ("],
        "handlers/bfl.py": ["Black Forest Labs' result download failed ("],
        "handlers/replicate_model.py": ["Replicate's result download failed ("],
        "handlers/openrouter_media.py": ["OpenRouter's video download failed ("],
        "handlers/elevenlabs.py": ["ElevenLabs Dubbing download failed: "],
        "services/antigravity_agent.py": ["Google's download answered "],
    }
    for name, starts in excluded.items():
        source = (BACKEND / name).read_text()
        lines = source.splitlines()
        for start in starts:
            [lineno] = [number for number, line in enumerate(lines, 1) if start in line]
            assert EXCLUSION.search("\n".join(lines[lineno - 3:lineno])), (name, start)


# -- 3. terminal job failures, marked where they are raised --------------------


@pytest.mark.asyncio
async def test_the_poll_runners_job_failure_is_marked_and_reads_todays_line() -> None:
    from execution.person_line import is_job_failure
    from execution.async_poll_runner import poll_until_terminal
    from handlers.runway import _runway_poll_config

    config = _runway_poll_config("fixture", "https://api.dev.runwayml.com/v1/image_to_video")
    config.poll_interval = 0
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "status": "FAILED", "failure": "HTTPError: 403 Client Error: Forbidden for url: https://cdn.example/a.png"}))

    async def emit(_event):
        return None

    async with httpx.AsyncClient(transport=transport) as client:
        exc = await _araised(poll_until_terminal, client, config, "task-1", "n1", emit)
    assert str(exc) == "Async job failed: HTTPError: 403 Client Error: Forbidden for url: https://cdn.example/a.png"
    assert is_job_failure(exc)
    card = _card(exc, "runway-image", {}, {"RUNWAY_API_KEY": "x"})
    assert card.person is None
    assert card.provider_text is False


def test_a_marked_job_failure_never_takes_the_key_busy_or_trouble_line() -> None:
    from execution.person_line import as_job_failure, with_api_status

    keys = {"MESHY_API_KEY": "x"}
    for text, status in (("Meshy task failed: unauthorized to fetch input", None),
                         ("Meshy task failed: rate limit on the worker", None),
                         ("Meshy task failed: worker said 503", 503),
                         ("Meshy task failed: input fetch 403", 403)):
        exc = as_job_failure(RuntimeError(text))
        if status is not None:
            with_api_status(exc, status)
        assert _card(exc, "meshy-text-to-3d", {}, keys).person is None, text
    # Credits words still read as credits.
    assert _card(as_job_failure(RuntimeError("Meshy task failed: insufficient credits")), "meshy-text-to-3d", {},
                 keys).person == "Your Meshy account is out of credits. Add credits, then run the node again."


def test_a_job_failure_is_never_classified_as_a_rejected_key() -> None:
    from execution.error_classifier import classify_error

    text = "Async job failed: unauthorized to fetch input"
    # The text alone still reads as auth (the classifier reads strings) ...
    assert classify_error(text)[0] == "auth"
    # ... but a marked job failure is never auth; its other categories stay.
    assert classify_error(text, job_failure=True)[0] != "auth"
    assert classify_error("Async job failed: HTTP 401 fetching input", job_failure=True)[0] != "auth"
    assert classify_error("Async job failed: rate limit", job_failure=True)[0] == "rate_limit"
    assert classify_error("Async job failed: timed out on the worker", job_failure=True)[0] == "timeout"
    assert classify_error("Async job failed: insufficient credits", job_failure=True)[0] == "quota"


@pytest.mark.asyncio
async def test_the_engine_never_calls_a_marked_job_failure_auth() -> None:
    from execution.person_line import as_job_failure

    text = "Async job failed: unauthorized to fetch input"

    async def handler(node, inputs, api_keys):
        raise as_job_failure(RuntimeError(text))

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    nodes = [GraphNode(id="p", definitionId="text-input", params={"value": "a chair"}),
             _node("meshy-text-to-3d")]
    edges = [GraphEdge(id="e", source="p", sourceHandle="text", target="n1", targetHandle="prompt")]
    await execute_graph(nodes=nodes, edges=edges, api_keys={"MESHY_API_KEY": "fixture"},
                        handler_registry={"meshy-text-to-3d": handler}, emit=emit, run_id=None)
    [error] = [event for event in events if isinstance(event, ErrorEvent)]
    assert error.error == text  # agents' text, word for word
    assert error.category != "auth"
    assert error.friendly != "The API key was rejected. Check your key for this provider in Settings."
    assert error.person is None


@pytest.mark.asyncio
async def test_a_cinema_shots_job_failure_is_never_auth(monkeypatch) -> None:
    import execution.sync_runner as sync_runner
    import handlers.cinema_scene as cinema_scene
    from execution.person_line import as_job_failure

    async def boom(node, inputs, api_keys):
        raise as_job_failure(RuntimeError("FAL job failed: unauthorized to fetch input"))

    class _AnyKey(dict):
        def get(self, _key, _default=None):
            return boom

    monkeypatch.setattr(cinema_scene, "get_handler_registry", lambda emit=None: _AnyKey(), raising=False)
    monkeypatch.setattr(sync_runner, "get_handler_registry", lambda emit=None: _AnyKey())
    scene = {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
             "shots": [{"id": "bad", "prompt": "a shot"}]}
    await cinema_scene.handle_cinema_scene(GraphNode(id="scene1", definitionId="cinema-scene", params={"scene": scene}),
                                           inputs={}, api_keys={"FAL_KEY": "x"}, emit=None)
    output = scene["shots"][0]["output"]
    assert output["error"] == "FAL job failed: unauthorized to fetch input"
    assert output.get("errorCategory") != "auth"


# Every terminal job failure raise (the list 3d's text pattern was written
# from): the provider took the job, then reported it failed, cancelled or
# expired.
JOB_FAILURE_RAISES: dict[str, list[str]] = {
    "execution/async_poll_runner.py": ["Async job failed: {}"],
    "execution/stream_runner.py": ["Replicate stream error: {}"],
    "handlers/elevenlabs.py": ["ElevenLabs Dubbing failed: {}"],
    "handlers/fal_universal.py": ["FAL job failed: {}", "FAL job failed: {}"],
    "handlers/gemini_omni.py": ["Gemini Omni interaction {}: {}"],
    "handlers/grok_video.py": ["Grok failed: {}"],
    "handlers/higgsfield.py": ["Higgsfield failed: {}", "Higgsfield generation was cancelled"],
    "handlers/ideogram.py": ["Ideogram training failed: status={}"],
    "handlers/krea.py": ["Krea job {} {}: {}"],
    "handlers/krea_gateway.py": ["Krea job {}: {}"],
    "handlers/meshy.py": ["Meshy task {}: {}"],
    "handlers/minimax.py": ["MiniMax task failed: {}"],
    "handlers/minimax_v2.py": ["MiniMax H3 task {}: {}{}"],
    "handlers/openrouter_media.py": ["OpenRouter video {}: {}"],
    "handlers/veo.py": ["Veo failed: {}", "Veo (Vertex) failed: {}"],
    "handlers/worldlabs.py": ["World Labs operation failed: {}"],
    "services/krea_mcp_generation.py": ["Krea job {}; inspect the saved run before retrying"],
}


def _marked_texts(path: Path) -> tuple[list[str], list[str]]:
    """(marked, unmarked) exception text templates in `path`."""
    from tests.test_error_copy_round3c2 import _template

    marked, unmarked = [], []
    tree = ast.parse(path.read_text())
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
        if not name.endswith("Error"):
            continue
        text = _template(node.args[0])
        if text is None:
            continue
        up, is_marked = parents.get(node), False
        while isinstance(up, ast.Call):
            if getattr(up.func, "id", "") == "as_job_failure":
                is_marked = True
            up = parents.get(up)
        (marked if is_marked else unmarked).append(text)
    return marked, unmarked


def test_every_terminal_job_failure_is_marked_where_it_is_raised() -> None:
    for name, texts in JOB_FAILURE_RAISES.items():
        marked, _unmarked = _marked_texts(BACKEND / name)
        assert sorted(text for text in marked if text in texts) == sorted(texts), (name, marked)


def test_bfl_and_byteplus_mark_their_failed_tasks() -> None:
    for name, needle in (("handlers/bfl.py", "as_job_failure(RuntimeError(_failure_message(task)))"),
                         ("handlers/byteplus.py", "as_job_failure(BytePlusError(200, code, message,")):
        assert needle in (BACKEND / name).read_text(), name


# -- 4. the classifier's auth with no status: only for an API refusal ---------


def test_auth_words_without_an_api_refusal_take_no_key_line() -> None:
    from execution.person_line import with_api_status
    from services.quiver_client import QuiverAuthError

    keys = {"MESHY_API_KEY": "x"}
    # Words alone (a re-raised provider message, a job's error) are not a refusal.
    assert _card(RuntimeError("Meshy said: unauthorized"), "meshy-text-to-3d", {}, keys).person is None
    assert _card(RuntimeError("Meshy said: invalid api key"), "meshy-text-to-3d", {}, keys).person is None
    # A 401/403 the API answered is.
    assert _card(with_api_status(RuntimeError("Meshy said: invalid api key"), 401), "meshy-text-to-3d", {},
                 keys).person == "Meshy didn't accept your API key. Check it in Settings, then run the node again."
    # So is a typed auth error that carries its status.
    exc = QuiverAuthError("Quiver auth failed (401)", status_code=401)
    assert _card(exc, "quiver-text-to-svg", {}, {"QUIVER_API_KEY": "x"}).person == (
        "QuiverAI didn't accept your API key. Check it in Settings, then run the node again.")


def test_rate_limit_and_credits_words_still_read_their_lines() -> None:
    keys = {"MESHY_API_KEY": "x"}
    assert _card(RuntimeError("Meshy said: rate limit exceeded"), "meshy-text-to-3d", {}, keys).person == (
        "Meshy is busy. Wait a moment, then run the node again.")
    assert _card(RuntimeError("Meshy said: insufficient credits"), "meshy-text-to-3d", {}, keys).person == (
        "Your Meshy account is out of credits. Add credits, then run the node again.")


# -- 5. the fal.ai stream still running when Nebula stops ---------------------


def _fal_stream(final_status: str):
    def answer(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, headers={"x-fal-request-id": "req-1", "content-type": "text/event-stream"},
                                  text='data: {"status": "IN_PROGRESS"}\n\n')
        return httpx.Response(200, json={"status": final_status, "error": "worker crashed"})
    return answer


@pytest.mark.asyncio
async def test_a_fal_stream_still_running_when_polling_stops_says_check_fal(monkeypatch, tmp_path) -> None:
    import execution.stream_runner as stream_runner

    _mock_clients(monkeypatch, stream_runner, _fal_stream("IN_PROGRESS"))

    async def emit(_event):
        return None

    config = stream_runner.StreamConfig(url="https://fal.run/fal-ai/gpt-image-2/stream", headers={})
    exc = await _araised(stream_runner.stream_execute_image, config, {}, "n1", emit, tmp_path, "fal",
                         recovery_max_polls=2, recovery_poll_interval=0)
    assert str(exc).startswith("Image stream ended without a final image event (provider=fal, "
                               "fal_request_id=req-1). Retrieval by request ID failed: job still IN_PROGRESS "
                               "after 2 status polls. Last 1 raw events: ")
    assert person_line(exc) == slow_job_line("fal.ai")
    assert person_line(exc) == ("fal.ai took too long, so Nebula stopped waiting. The job may still finish there and "
                                "be billed, so check fal.ai before you run the node again.")


@pytest.mark.asyncio
async def test_a_fal_stream_whose_job_failed_is_a_job_failure_not_a_slow_job(monkeypatch, tmp_path) -> None:
    import execution.stream_runner as stream_runner
    from execution.person_line import is_job_failure

    _mock_clients(monkeypatch, stream_runner, _fal_stream("FAILED"))

    async def emit(_event):
        return None

    config = stream_runner.StreamConfig(url="https://fal.run/fal-ai/gpt-image-2/stream", headers={})
    exc = await _araised(stream_runner.stream_execute_image, config, {}, "n1", emit, tmp_path, "fal",
                         recovery_max_polls=2, recovery_poll_interval=0)
    assert "Retrieval by request ID failed: job FAILED: worker crashed." in str(exc)
    assert person_line(exc) is None
    assert is_job_failure(exc)


# -- 6. the guard knows more id shapes ----------------------------------------


@pytest.mark.parametrize("line", [
    "Runway's gen4_turbo takes one image", "MiniMax-Hailuo-02 takes an end image",
    "Pick MiniMax-Hailuo-2.3-Fast", "nano-banana-pro takes 14 images", "Use stability-ai/sdxl",
    "Enter a model written as owner/name",
])
def test_the_guard_catches_more_provider_id_shapes(line) -> None:
    from tests.test_error_copy_round3c2 import forbidden_in_a_line

    assert forbidden_in_a_line(line), line


@pytest.mark.parametrize("line", [
    "Nodes saved with the retired Gen-3a Turbo now use Gen-4 Turbo.", "Meshy text-to-3D needs a prompt",
    "Audio input is required for speech-to-speech", "MiniMax's first-and-last-frame mode is Hailuo 02 only",
    "Hailuo 2.3 Fast on MiniMax takes a start image", "On Vertex, reference images only make 8-second videos",
    "Verify it at https://platform.openai.com/settings/organization/general, then run the node again.",
    "Your Krea account is out of credits. Add credits, then run the node again.",
    "Set the node's Duration (ms) to 3.",
])
def test_the_guard_lets_gms_words_through(line) -> None:
    from tests.test_error_copy_round3c2 import forbidden_in_a_line

    assert not forbidden_in_a_line(line), line


@pytest.mark.asyncio
async def test_a_replicate_model_with_no_version_says_so_without_its_id(monkeypatch) -> None:
    import handlers.replicate_universal as replicate_universal
    from execution.person_line import api_status
    from tests.test_error_copy_round3c2 import forbidden_in_a_line

    _mock_clients(monkeypatch, replicate_universal, lambda request: httpx.Response(200, json={}))
    exc = await _araised(replicate_universal._resolve_version, "acme", "painter", "fixture")
    assert str(exc) == "No version found for acme/painter"
    line = person_line(exc)
    assert line == ("Replicate has no version of the model in “Model ID” to run. "
                    "Check the model on Replicate, then run the node again.")
    assert not forbidden_in_a_line(line)
    _mock_clients(monkeypatch, replicate_universal, lambda request: httpx.Response(404, text="not found"))
    exc = await _araised(replicate_universal._resolve_version, "acme", "painter", "fixture")
    assert str(exc) == "Failed to fetch Replicate model acme/painter: 404 not found"
    assert api_status(exc) == 404


@pytest.mark.asyncio
async def test_a_replicate_model_id_missing_says_where_to_find_it_without_owner_name() -> None:
    from handlers.replicate_universal import handle_replicate_universal
    from tests.test_error_copy_round3c2 import forbidden_in_a_line

    exc = await _araised(handle_replicate_universal, _node("replicate-universal"), {}, {"REPLICATE_API_TOKEN": "x"})
    assert str(exc) == "Model ID is required (format: owner/name, e.g. stability-ai/sdxl)"
    line = person_line(exc)
    assert line == ("Enter a Replicate model in “Model ID”, as its page on Replicate writes it, "
                    "then run the node again.")
    assert not forbidden_in_a_line(line)


# -- 7. a wrapper that adds a hint to a cause's text keeps what the call said --


def test_a_rewritten_failure_keeps_its_status_and_job_mark_but_not_its_line() -> None:
    from execution.person_line import (api_status, as_job_failure, is_job_failure, with_api_status, with_call_facts,
                                       with_person_line)

    cause = with_person_line(with_api_status(RuntimeError("FAL submit failed (429): slow"), 429), "A cause's line.")
    exc = with_call_facts(RuntimeError(f"{cause} — a hint for agents"), cause)
    assert api_status(exc) == 429
    assert person_line(exc) is None
    assert is_job_failure(with_call_facts(RuntimeError("x"), as_job_failure(RuntimeError("y"))))


@pytest.mark.asyncio
async def test_meshys_entitlement_hint_keeps_the_submit_status(monkeypatch) -> None:
    import handlers.meshy as meshy
    from execution.maker_routes_minimax_meshy import _MESHY_TASK, krea_meshy
    from execution.person_line import api_status

    _mock_clients(monkeypatch, meshy, lambda request: httpx.Response(403, text="no entitlement"))
    node = _node("krea-3d-meshy-6", {_MESHY_TASK: "text", "ai_model": "meshy-6"})
    exc = await _araised(krea_meshy, node, {"prompt": _port("a chair")}, {"MESHY_API_KEY": "fixture"})
    assert str(exc).startswith("Meshy submit failed (403): no entitlement. Meshy documents that meshy-6 ")
    assert api_status(exc) == 403


def test_every_wrapper_that_rewrites_a_cause_keeps_its_facts() -> None:
    for name, start in (("execution/sync_runner.py", "RuntimeError(with_vertex_hint(str(exc)))"),
                        ("execution/sync_runner.py", "RuntimeError(with_vertex_hint(str(exc)))"),
                        ("execution/maker_routes.py", "RuntimeError(\n                    f\"{exc}. Google lists"),
                        ("execution/maker_routes_minimax_meshy.py", "RuntimeError(\n                f\"{exc}. Meshy documents")):
        source = (BACKEND / name).read_text()
        assert source.count(start) >= 1, (name, start)
        for index in [m.start() for m in re.finditer(re.escape(start), source)]:
            assert source[:index].rstrip().endswith("raise with_call_facts("), (name, start)


# -- 8. review: a World Labs job failure after the run was accepted ------------
# _post_accept_failure rewrites the cause's text (recovery ids for agents), so
# it keeps the cause's facts: World Labs failing the job is never "auth".

_WL_FAILED = "unauthorized to fetch input image"


def _wl_operation_failed(operation_id: str) -> dict[str, Any]:
    return {"operation_id": operation_id, "done": True, "error": {"message": _WL_FAILED}}


async def _wl_raise(kind: str) -> BaseException:
    import respx

    from handlers.worldlabs import WORLDLABS_API_BASE, handle_worldlabs_environment, handle_worldlabs_export

    keys = {"WORLDLABS_API_KEY": "fixture"}
    with respx.mock(assert_all_called=True) as mock:
        if kind == "generation":
            mock.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
                return_value=httpx.Response(200, json=_wl_operation_failed("op-7")))
            return await _araised(handle_worldlabs_environment, _node("worldlabs-environment"),
                                  {"prompt": _port("a quiet harbour")}, keys)
        mock.post(f"{WORLDLABS_API_BASE}/worlds/world-123:export").mock(
            return_value=httpx.Response(200, json=_wl_operation_failed("op-8")))
        world = {"schemaVersion": 1, "provider": "worldlabs", "worldId": "world-123"}
        return await _araised(handle_worldlabs_export, _node("worldlabs-world-export", {"format": "glb"}),
                              {"world": _port(world, "World")}, keys)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind, text", [
    ("generation", "World Labs generation/recovery was already accepted or is being recovered (operationId=op-7), "
                   "but Nebula could not finish locally. Provider work may have completed and may be billable. "
                   "Check World Labs Marble before taking action; do not blindly rerun this node. Recover with "
                   f"resume_operation_id=op-7; cause: World Labs operation failed: {_WL_FAILED}"),
    ("export", "World Labs export/recovery was already accepted or is being recovered (operationId=op-8, "
               "worldId=world-123), but Nebula could not finish locally. Provider work may have completed and "
               "may be billable. Check World Labs Marble before taking action; do not blindly rerun this node. "
               f"Recover with resume_operation_id=op-8; cause: World Labs operation failed: {_WL_FAILED}"),
])
async def test_a_world_labs_job_failure_after_accept_stays_a_job_failure(kind, text) -> None:
    from execution.error_classifier import classify_error
    from execution.person_line import is_job_failure
    from handlers.worldlabs import _job_failed_line, _recovery_field

    exc = await _wl_raise(kind)
    assert str(exc) == text  # agents' text, word for word
    assert is_job_failure(exc)
    assert classify_error(str(exc), job_failure=is_job_failure(exc))[0] != "auth"
    definition_id = "worldlabs-environment" if kind == "generation" else "worldlabs-world-export"
    assert person_line(exc) == _job_failed_line(_recovery_field(definition_id, "resume_operation_id"))


@pytest.mark.asyncio
async def test_the_engine_never_calls_a_world_labs_job_failure_auth() -> None:
    import respx

    from execution.sync_runner import get_handler_registry
    from handlers.worldlabs import WORLDLABS_API_BASE, _job_failed_line, _recovery_field

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    nodes = [GraphNode(id="p", definitionId="text-input", params={"value": "a quiet harbour"}),
             _node("worldlabs-environment")]
    edges = [GraphEdge(id="e", source="p", sourceHandle="text", target="n1", targetHandle="prompt")]
    with respx.mock(assert_all_called=True) as mock:
        mock.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
            return_value=httpx.Response(200, json=_wl_operation_failed("op-9")))
        await execute_graph(nodes=nodes, edges=edges, api_keys={"WORLDLABS_API_KEY": "fixture"},
                            handler_registry=get_handler_registry(emit=emit), emit=emit, run_id=None)
    [error] = [event for event in events if isinstance(event, ErrorEvent)]
    assert error.error.endswith(f"cause: World Labs operation failed: {_WL_FAILED}")
    assert error.category != "auth"
    assert error.friendly != "The API key was rejected. Check your key for this provider in Settings."
    assert error.person == _job_failed_line(_recovery_field("worldlabs-environment", "resume_operation_id"))


# Builders whose text embeds a caught exception that never carries an API
# status or a job mark: a transport error (no API answered), a local file or
# graph error, or a sign-in step. Each says why it is not a provider's answer.
_WRAPPER_EXCLUSIONS = {
    ("execution/engine.py", "topological_sort"): "a graph cycle, found locally",
    ("handlers/nous_portal.py", "handle_nous_portal_universal"): "no Hermes sign-in on this machine, before any call",
    ("handlers/openrouter_media.py", "_post"): "httpx transport error: OpenRouter never answered",
    ("handlers/openrouter_media.py", "_download"): "httpx transport error on a result download",
    ("handlers/openrouter_media.py", "generate_video"): "httpx transport error while polling",
    ("handlers/replicate_model.py", "upload_file"): "httpx transport error on a file upload",
    ("handlers/speridlabs_idol.py", "_download_ply"): "Nebula's own PLY preflight refused the file, not an answer",
    ("handlers/speridlabs_idol.py", "run_idol"): "httpx transport error: the Idol Space never answered",
    ("handlers/replicate_model.py", "_save_output"): "httpx transport error on a result download",
    ("handlers/replicate_model.py", "run_model"): "httpx transport error: Replicate never answered",
    ("services/antigravity_agent.py", "start_sign_in"): "an ACP sign-in error from the local agent process",
    ("services/antigravity_agent.py", "work"): "an ACP sign-in error from the local agent process",
    ("services/vision_llm.py", "call_vision_llm"): "httpx transport error: the vision API never answered",
}
_WRAPPER_FILES = ("execution", "handlers")
_WRAPPER_SERVICES = ("antigravity_agent", "google_vertex", "krea_mcp_generation", "prompt_enhance", "vision_llm")


def _wrappers_without_facts() -> set[tuple[str, str]]:
    """Every exception built from a caught exception's text (an ``except ...
    as exc`` name, or a parameter typed Exception) that neither passes through
    with_call_facts nor is assigned to a name that later does."""
    paths = [p for d in _WRAPPER_FILES for p in sorted((BACKEND / d).glob("*.py"))]
    paths += [BACKEND / "services" / f"{name}.py" for name in _WRAPPER_SERVICES]
    found: set[tuple[str, str]] = set()
    for path in paths:
        tree = ast.parse(path.read_text())
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            causes = {a.arg for a in fn.args.args + fn.args.kwonlyargs if a.annotation is not None
                      and any(isinstance(x, ast.Name) and x.id in {"Exception", "BaseException"}
                              for x in ast.walk(a.annotation))}
            causes |= {h.name for h in ast.walk(fn) if isinstance(h, ast.ExceptHandler) and h.name}
            if not causes:
                continue
            parents = {child: node for node in ast.walk(fn) for child in ast.iter_child_nodes(node)}
            kept = {n.args[0].id for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                    and n.func.id == "with_call_facts" and n.args and isinstance(n.args[0], ast.Name)}
            for call in ast.walk(fn):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                        and call.func.id.endswith(("Error", "Exception"))):
                    continue
                if not any(isinstance(x, ast.Name) and x.id in causes for arg in call.args for x in ast.walk(arg)):
                    continue
                parent, ok = parents.get(call), False
                while parent is not None:
                    if isinstance(parent, ast.Call) and isinstance(parent.func, ast.Name) \
                            and parent.func.id == "with_call_facts":
                        ok = True
                    if isinstance(parent, ast.Assign) and any(isinstance(t, ast.Name) and t.id in kept
                                                              for t in parent.targets):
                        ok = True
                    if isinstance(parent, ast.stmt):
                        break
                    parent = parents.get(parent)
                if not ok:
                    found.add((str(path.relative_to(BACKEND)), fn.name))
    return found


def test_every_builder_from_a_caught_error_keeps_its_facts_or_says_why_not() -> None:
    found = _wrappers_without_facts()
    assert found - set(_WRAPPER_EXCLUSIONS) == set()
    assert set(_WRAPPER_EXCLUSIONS) - found == set()  # an exclusion that no longer applies goes


@pytest.mark.asyncio
async def test_elevenlabs_voices_hint_keeps_the_listings_status() -> None:
    from execution.person_line import api_status
    from handlers.elevenlabs import resolve_dialogue_voices

    transport = httpx.MockTransport(lambda request: httpx.Response(403, json={"detail": {"message": "no"}}))
    async with _REAL_ASYNC_CLIENT(transport=transport) as client:
        exc = await _araised(resolve_dialogue_voices, client, "fixture", ["Rachel"])
    assert str(exc).startswith("Your ElevenLabs API key can't list your voices (403: no), so Nebula can't look up ")
    assert api_status(exc) == 403
    assert person_line(exc) == ("Your ElevenLabs API key can't list your voices, so Nebula can't look up the "
                                "speaker names. Give the key Voices read access under Developers > API Keys in "
                                "ElevenLabs, or write each voice's ID in place of its name.")
