"""JSON request bodies whose numbers no route can use get one clear 422.

Starlette's Request.json() is plain json.loads: it takes NaN and Infinity
(not JSON), turns 1e400 into inf and keeps integers of up to 4,300 digits.
float(10**400) raises OverflowError, so a route that checked its numbers with
float() or math.isfinite() answered 500. services/json_number_guard.py checks
every JSON body once, before any route sees it (2026-10-20).
"""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_arrange import ArrangeBook
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Desktop"}
JSON = {"content-type": "application/json"}
HUGE_INT = "1" + "0" * 400  # 10**400: past float's range
LONG_INT = "9" * 4301        # past int()'s 4,300-digit limit


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    """The real app on a throwaway graph and project store (as test_graph_apply.py builds it)."""
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    sent: list[dict] = []

    async def capture(data, **kw):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.main = main_module
    ctx.app = main_module.app
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    return ctx


def _seed(api) -> str:
    return api.graph.add_node("text-input", {"value": "a lighthouse"})


def _move_body(node_id: str, x_token: str) -> bytes:
    """A graph-apply move written by hand, so the number token is exactly x_token."""
    return ('{"move": {"%s": {"x": %s, "y": 60}}}' % (node_id, x_token)).encode()


def _assert_refused(response, token_shown: str) -> None:
    assert response.status_code == 422, response.text
    body = response.json()
    assert set(body) == {"detail"}
    detail = body["detail"]
    assert isinstance(detail, str) and "\n" not in detail and len(detail) < 200
    assert token_shown in detail
    assert "finite number" in detail and "1.8e308" in detail


# -- the real app: graph apply --------------------------------------------------

@pytest.mark.parametrize("token", ["1e400", "NaN", "-Infinity", "Infinity", HUGE_INT, "-" + HUGE_INT],
                         ids=["1e400", "NaN", "-Infinity", "Infinity", "10**400", "-10**400"])
def test_apply_refuses_numbers_out_of_range_with_one_line(api, token):
    node = _seed(api)
    response = api.client.post("/api/graph/apply", headers={**AGENT, **JSON}, content=_move_body(node, token))
    _assert_refused(response, token[:40])
    assert "position" not in api.graph.nodes[node]


def test_the_token_shown_is_cut_to_forty_characters(api):
    node = _seed(api)
    response = api.client.post("/api/graph/apply", headers={**AGENT, **JSON}, content=_move_body(node, HUGE_INT))
    _assert_refused(response, HUGE_INT[:40] + "...")
    assert HUGE_INT[:41] not in response.json()["detail"]


def test_a_number_deep_in_params_is_checked(api):
    node = _seed(api)
    body = ('{"params": [{"nodeId": "%s", "params": {"value": {"a": [1, {"b": [2, 1e999]}]}}}]}' % node).encode()
    response = api.client.post("/api/graph/apply", headers={**AGENT, **JSON}, content=body)
    _assert_refused(response, "1e999")
    assert api.graph.nodes[node]["params"]["value"] == "a lighthouse"


def test_an_int_past_the_4300_digit_limit_is_out_of_range(api):
    node = _seed(api)
    response = api.client.post("/api/graph/apply", headers={**AGENT, **JSON}, content=_move_body(node, LONG_INT))
    _assert_refused(response, LONG_INT[:40] + "...")


def test_strings_that_look_like_numbers_pass(api):
    node = _seed(api)
    for text in ("NaN", "Infinity and 1e400", "9" * 400):
        response = api.client.post("/api/graph/apply", headers=AGENT, json={
            "params": [{"nodeId": node, "params": {"value": text}}],
        })
        assert response.status_code == 200, response.text
        assert api.graph.nodes[node]["params"]["value"] == text


def test_a_normal_body_reaches_the_route_unchanged(api):
    response = api.client.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+prompt", "definitionId": "text-input", "params": {"value": "a red fox"}}],
        "move": {"+prompt": {"x": -1.5e3, "y": 1797.25}},
    })
    assert response.status_code == 200, response.text
    body = response.json()
    prompt = body["idMap"]["+prompt"]
    assert body["status"] == "applied"
    assert api.graph.nodes[prompt]["params"]["value"] == "a red fox"
    assert api.graph.nodes[prompt]["position"] == {"x": -1500.0, "y": 1797.25}


def test_a_large_int_still_inside_float_range_passes_the_guard(api):
    # 308 and 309 digits under float's max: the guard lets them through, and
    # the route's own coordinate limit answers (not this guard's line).
    node = _seed(api)
    for token in ("9" * 308, "17976931348623157" + "0" * 292):
        response = api.client.post("/api/graph/apply", headers={**AGENT, **JSON}, content=_move_body(node, token))
        assert response.status_code == 422, response.text
        assert "1.8e308" not in response.json()["detail"]


# -- which bodies are checked -------------------------------------------------

def test_a_body_with_no_content_type_is_checked(api):
    node = _seed(api)
    response = api.client.post("/api/graph/apply", headers=AGENT, content=_move_body(node, "NaN"))
    assert "content-type" not in response.request.headers
    _assert_refused(response, "NaN")


@pytest.mark.parametrize("content_type", ["application/json; charset=utf-8", "application/merge-patch+json",
                                          "APPLICATION/JSON"])
def test_json_media_types_are_checked(api, content_type):
    node = _seed(api)
    response = api.client.post("/api/graph/apply", headers={**AGENT, "content-type": content_type},
                               content=_move_body(node, "NaN"))
    _assert_refused(response, "NaN")


def test_text_plain_and_multipart_are_left_alone(api, monkeypatch, tmp_path):
    from services import json_number_guard

    checked: list[bytes] = []
    real = json_number_guard.check_numbers
    monkeypatch.setattr(json_number_guard, "check_numbers", lambda body: (checked.append(body), real(body))[1])

    node = _seed(api)
    plain = api.client.post("/api/graph/apply", headers={**AGENT, "content-type": "text/plain"},
                            content=_move_body(node, "NaN"))
    # FastAPI doesn't read text/plain as JSON, so the route's own body check answers.
    assert plain.status_code == 422 and isinstance(plain.json()["detail"], list)

    monkeypatch.setattr(api.main, "CHAT_UPLOADS_DIR", tmp_path)
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )
    upload = api.client.post("/api/uploads", files={"file": ("NaN.png", png, "image/png")},
                             data={"create_node": "false", "note": '{"x": NaN}'})
    assert upload.status_code == 200, upload.text
    assert checked == []

    api.client.post("/api/graph/apply", headers=AGENT, json={"remove": []})
    assert len(checked) == 1  # the spy itself works


def test_an_invalid_json_body_keeps_the_routes_own_error(api):
    response = api.client.post("/api/graph/apply", headers={**AGENT, **JSON}, content=b'{"move": ')
    assert response.status_code == 422
    assert response.json()["detail"][0]["type"] == "json_invalid"


# -- chunked bodies, driven through ASGI ----------------------------------------

def _drive(app, method: str, path: str, parts: list[bytes], headers: dict[str, str]) -> tuple[int, dict, bytes]:
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
        "headers": [(b"host", b"testserver"), *((k.lower().encode(), v.encode()) for k, v in headers.items())],
        "client": ("127.0.0.1", 50000), "server": ("testserver", 80),
    }
    messages = [{"type": "http.request", "body": part, "more_body": index < len(parts) - 1}
                for index, part in enumerate(parts)]
    sent: list[dict] = []

    async def receive():
        if messages:
            return messages.pop(0)
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    asyncio.run(asyncio.wait_for(app(scope, receive, send), 30))
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], {k.decode(): v.decode() for k, v in start["headers"]}, body


def test_a_chunked_body_is_checked_whole(api):
    node = _seed(api)
    raw = _move_body(node, HUGE_INT)
    parts = [raw[:5], raw[5:30], raw[30:200], raw[200:]]
    status, headers, body = _drive(api.app, "POST", "/api/graph/apply", parts, {**AGENT, **JSON})
    assert status == 422
    assert headers["content-type"] == "application/json"
    assert HUGE_INT[:40] in json.loads(body)["detail"]


def test_a_chunked_body_is_replayed_whole(api):
    node = _seed(api)
    raw = json.dumps({"move": {node: {"x": 40, "y": 60}}, "rename": {node: "Split"}}).encode()
    parts = [raw[:1], raw[1:12], b"", raw[12:]]
    status, _headers, body = _drive(api.app, "POST", "/api/graph/apply", parts, {**AGENT, **JSON})
    assert status == 200, body
    assert api.graph.nodes[node]["position"] == {"x": 40.0, "y": 60.0}
    assert api.graph.nodes[node]["label"] == "Split"


# -- where it sits: inside LocalRequestGuard and CORS ---------------------------

def test_the_422_carries_cors_for_a_localhost_origin(api):
    node = _seed(api)
    response = api.client.post("/api/graph/apply", headers={**AGENT, **JSON, "Origin": "http://localhost:5173"},
                               content=_move_body(node, "NaN"))
    _assert_refused(response, "NaN")
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_a_foreign_host_or_origin_is_refused_before_the_body_is_read(api):
    node = _seed(api)
    host = api.client.post("/api/graph/apply", headers={**AGENT, **JSON, "Host": "evil.example"},
                           content=_move_body(node, "NaN"))
    assert host.status_code == 403 and host.json() == {"detail": "Host not allowed"}
    origin = api.client.post("/api/graph/apply", headers={**AGENT, **JSON, "Origin": "https://evil.example"},
                             content=_move_body(node, "NaN"))
    assert origin.status_code == 403 and origin.json() == {"detail": "Origin not allowed"}


def test_the_guard_sits_inside_local_request_guard_and_cors():
    """Starlette runs app.user_middleware outermost first (later add_middleware
    calls and @app.middleware decorators are inserted at the front)."""
    from starlette.middleware.cors import CORSMiddleware

    import main
    from services.json_number_guard import JsonNumberGuard
    from services.local_guard import LocalRequestGuard

    order = [m.cls for m in main.app.user_middleware]
    assert order.count(JsonNumberGuard) == 1
    assert order.index(LocalRequestGuard) < order.index(JsonNumberGuard)
    assert order.index(CORSMiddleware) < order.index(JsonNumberGuard)


# -- real routes that answered 500 before ------------------------------------------

def test_layout_with_a_huge_int_is_a_422_not_a_500(api):
    node = _seed(api)
    body = ('{"positions": {"%s": {"x": %s, "y": 0}}}' % (node, HUGE_INT)).encode()
    response = TestClient(api.app, raise_server_exceptions=False).put(
        "/api/graph/layout", headers={**PERSON, **JSON}, content=body)
    _assert_refused(response, HUGE_INT[:40])


# -- the guard on its own, with a tiny ASGI app --------------------------------------

class _Recorder:
    """A fake app that reads its whole body, then one more receive(), and answers 200."""

    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.calls = 0

    async def __call__(self, scope, receive, send):
        self.calls += 1
        if scope["type"] != "http":
            self.messages.append(await receive())
            return
        while True:
            message = await receive()
            self.messages.append(message)
            if message["type"] != "http.request" or not message.get("more_body"):
                break
        self.messages.append(await receive())
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def _http_scope(content_type: str | None = "application/json") -> dict:
    headers = [(b"host", b"testserver")]
    if content_type is not None:
        headers.append((b"content-type", content_type.encode()))
    return {"type": "http", "method": "POST", "path": "/x", "headers": headers}


def _feed(messages: list[dict]):
    pending = list(messages)
    pulled: list[dict] = []

    async def receive():
        message = pending.pop(0)
        pulled.append(message)
        return message

    return receive, pulled


def _run(guard, scope, receive) -> list[dict]:
    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    asyncio.run(guard(scope, receive, send))
    return sent


def test_unit_replays_the_body_as_one_message_then_hands_on_disconnect():
    from services.json_number_guard import JsonNumberGuard

    inner = _Recorder()
    receive, _pulled = _feed([
        {"type": "http.request", "body": b'{"a": [1,', "more_body": True},
        {"type": "http.request", "body": b' 2.5, "NaN"]}', "more_body": False},
        {"type": "http.disconnect"},
    ])
    sent = _run(JsonNumberGuard(inner), _http_scope(), receive)
    assert inner.messages == [
        {"type": "http.request", "body": b'{"a": [1, 2.5, "NaN"]}', "more_body": False},
        {"type": "http.disconnect"},
    ]
    assert sent[0]["status"] == 200


def test_unit_refuses_without_calling_the_app():
    from services.json_number_guard import JsonNumberGuard

    inner = _Recorder()
    receive, _pulled = _feed([{"type": "http.request", "body": b'{"a": -Infinity}', "more_body": False}])
    sent = _run(JsonNumberGuard(inner), _http_scope(None), receive)
    assert inner.calls == 0
    assert sent[0]["status"] == 422
    assert (b"content-type", b"application/json") in sent[0]["headers"]
    assert "-Infinity" in json.loads(sent[1]["body"])["detail"]


def test_unit_a_disconnect_mid_body_reaches_the_app():
    from services.json_number_guard import JsonNumberGuard

    inner = _Recorder()
    receive, _pulled = _feed([
        {"type": "http.request", "body": b'{"a": ', "more_body": True},
        {"type": "http.disconnect"},
        {"type": "http.disconnect"},
    ])
    _run(JsonNumberGuard(inner), _http_scope(), receive)
    assert inner.messages[0] == {"type": "http.request", "body": b'{"a": ', "more_body": True}
    assert inner.messages[1] == {"type": "http.disconnect"}


@pytest.mark.parametrize("content_type", ["text/plain", "multipart/form-data; boundary=x",
                                          "application/x-www-form-urlencoded", "application/zip"])
def test_unit_other_content_types_are_not_read(content_type):
    from services.json_number_guard import JsonNumberGuard

    inner = _Recorder()
    first = {"type": "http.request", "body": b'{"a": NaN}', "more_body": False}
    receive, pulled = _feed([first, {"type": "http.disconnect"}])
    _run(JsonNumberGuard(inner), _http_scope(content_type), receive)
    assert inner.messages[0] is first  # the original message, read by the app itself
    assert pulled == [first, {"type": "http.disconnect"}]


def test_unit_an_empty_body_passes():
    from services.json_number_guard import JsonNumberGuard

    inner = _Recorder()
    receive, _pulled = _feed([{"type": "http.request", "body": b"", "more_body": False}, {"type": "http.disconnect"}])
    sent = _run(JsonNumberGuard(inner), _http_scope(None), receive)
    assert inner.messages[0] == {"type": "http.request", "body": b"", "more_body": False}
    assert sent[0]["status"] == 200


@pytest.mark.parametrize("kind", ["websocket", "lifespan"])
def test_unit_websocket_and_lifespan_are_untouched(kind):
    from services.json_number_guard import JsonNumberGuard

    inner = _Recorder()
    first = {"type": "websocket.receive", "text": '{"a": NaN}'} if kind == "websocket" else {"type": "lifespan.startup"}
    receive, pulled = _feed([first])
    _run(JsonNumberGuard(inner), {"type": kind, "headers": []}, receive)
    assert inner.calls == 1 and inner.messages == [first] and pulled == [first]


@pytest.mark.parametrize("raw,ok", [
    (b'{"a": 1e308, "b": -1.7976931348623157e308, "c": 1e-400, "d": "1e400"}', True),
    (b'[' + b"9" * 308 + b']', True),
    (b'[1.7976931348623159e308]', False),
    (b'[' + HUGE_INT.encode() + b']', False),
    (b'{"x": NaN}', False),
    (b'not json at all', True),   # passes through: the route keeps its own error
    (b'[1, 2', True),
    (b'\xff\xfe', True),
], ids=["in-range", "308-digits", "float-past-max", "10**400", "NaN", "not-json", "truncated", "bad-bytes"])
def test_unit_check_numbers(raw, ok):
    from services.json_number_guard import JsonNumberOutOfRange, check_numbers

    if ok:
        assert check_numbers(raw) is None
    else:
        with pytest.raises(JsonNumberOutOfRange):
            check_numbers(raw)


# -- the websockets parse their own frames ---------------------------------------
# json.loads raises ValueError (not JSONDecodeError) for an int past 4,300
# digits; /ws and /ws/chat caught only JSONDecodeError, so one such frame
# ended the socket's handler with an exception (2026-10-20).

def test_ws_survives_a_frame_with_a_too_long_int(api, person):
    with api.client.websocket_connect("/ws", headers=PERSON) as ws:
        for _ in range(3):  # graphSync, canvasPins, canvas notes
            ws.receive_json()
        ws.send_text('{"type": "hello", "n": %s}' % LONG_INT)
        ws.send_text('{"type": "hello", "personToken": NaN}')
        ws.send_json(person.hello)
        assert ws.receive_json()["type"] == "proposalSync"


def test_ws_chat_answers_a_frame_with_a_number_out_of_range(api):
    with api.client.websocket_connect("/ws/chat") as ws:
        ws.send_text('{"type": "cancel", "n": %s}' % LONG_INT)
        event = ws.receive_json()
        assert event["type"] == "error" and LONG_INT[:40] in event["message"]
        ws.send_text('{"type": "cancel", "n": NaN}')
        assert "NaN" in ws.receive_json()["message"]
        ws.send_json({"type": "cancel"})
        assert ws.receive_json()["type"] == "cancellation"


# -- routes that accept any "application/json..." content type -------------------
# routes/commons.py json_body and the Codex login route take any content type
# that starts with "application/json", then call request.json(). The guard
# first used FastAPI's narrower rule (subtype "json" or "+json"), so
# "application/json-seq" slipped past it and 10**400 reached math.isfinite():
# a 500 (review, 2026-10-20).

PREFIX_TYPES = ["application/json-seq", "application/jsonx", "application/json , text/plain"]


@pytest.fixture
def commons_client(tmp_path, monkeypatch, fresh_person_session):
    from commons import runtime

    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    runtime.reset_for_tests()
    import main as main_module

    yield TestClient(main_module.app, raise_server_exceptions=False)
    runtime.reset_for_tests()


@pytest.mark.parametrize("content_type", ["application/json", *PREFIX_TYPES])
def test_commons_settings_refuses_a_huge_int_under_any_json_prefix(commons_client, content_type):
    import secrets

    from services import person_session

    token = secrets.token_urlsafe(32)
    person_session.current().set(token)
    response = commons_client.patch(
        "/api/commons/settings", content='{"load_threshold": %s}' % HUGE_INT,
        headers={"Authorization": f"Bearer {token}", "content-type": content_type})
    _assert_refused(response, HUGE_INT[:40])


@pytest.mark.parametrize("content_type", ["application/json", "application/json-seq"])
def test_codex_login_refuses_a_too_long_int_under_any_json_prefix(api, monkeypatch, content_type):
    from services import codex_session

    async def fake_start(device_auth=False):
        return {"started": device_auth}

    monkeypatch.setattr(codex_session, "start_codex_chatgpt_login", fake_start)
    monkeypatch.setattr(api.main, "require_person", lambda headers: None)
    client = TestClient(api.app, raise_server_exceptions=False)
    response = client.post("/api/agents/codex/login/chatgpt", content='{"deviceAuth": %s}' % LONG_INT,
                           headers={"content-type": content_type})
    _assert_refused(response, LONG_INT[:40])
    ok = client.post("/api/agents/codex/login/chatgpt", content=b'{"deviceAuth": 1}',
                     headers={"content-type": content_type})
    assert ok.status_code == 200 and ok.json() == {"started": True}


@pytest.mark.parametrize("content_type,read", [
    *((t, True) for t in PREFIX_TYPES),
    ("Application/JSON-seq", True),
    ("application/problem+json", True),
    ("application/ndjson", False),   # FastAPI and the routes leave it alone too
    ("text/json", False),
])
def test_unit_read_as_json_covers_the_application_json_prefix(content_type, read):
    from services.json_number_guard import read_as_json

    assert read_as_json(content_type) is read


# -- memory: the body is held once while the route runs -------------------------

def test_unit_chunks_are_let_go_once_joined():
    import gc
    import weakref

    from services.json_number_guard import JsonNumberGuard

    class Chunk(bytearray):  # bytes can't be weakly referenced; a bytearray subclass can
        pass

    refs: list[weakref.ref] = []
    parts = [b'{"a": [', b"1, 2, ", b'3]}']

    async def receive():
        if parts:
            chunk = Chunk(parts.pop(0))
            refs.append(weakref.ref(chunk))
            return {"type": "http.request", "body": chunk, "more_body": bool(parts)}
        return {"type": "http.disconnect"}

    seen: dict = {}

    async def app(scope, receive, send):
        gc.collect()
        seen["alive"] = sum(ref() is not None for ref in refs)
        seen["body"] = (await receive())["body"]
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def send(message):
        pass

    asyncio.run(JsonNumberGuard(app)(_http_scope(), receive, send))
    assert len(refs) == 3
    assert seen["alive"] == 0, "the guard still holds the chunks next to the joined body"
    assert seen["body"] == b'{"a": [1, 2, 3]}'


# -- a body that can't hold a JSON number streams through -----------------------

def test_unit_a_body_that_cannot_hold_a_number_streams_through_unheld():
    # A zip upload sent with no content type (the restore route spools it under
    # its own cap): the guard hands the first part on at once and the rest
    # comes straight from the client, so the upload is never held whole.
    from services.json_number_guard import JsonNumberGuard

    receive, pulled = _feed([
        {"type": "http.request", "body": b"PK\x03\x04", "more_body": True},
        {"type": "http.request", "body": b"rest of the zip", "more_body": False},
        {"type": "http.disconnect"},
    ])
    seen: dict = {}

    async def app(scope, receive, send):
        seen["pulled_before_app"] = len(pulled)
        seen["parts"] = [await receive(), await receive()]
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    _run(JsonNumberGuard(app), _http_scope(None), receive)
    assert seen["pulled_before_app"] == 1
    assert seen["parts"] == [
        {"type": "http.request", "body": b"PK\x03\x04", "more_body": True},
        {"type": "http.request", "body": b"rest of the zip", "more_body": False},
    ]


@pytest.mark.parametrize("parts", [
    [b"  \n", b'{"a": NaN}'],                     # whitespace first, in its own part
    [b'\xef\xbb\xbf{"a": NaN}'],                  # a UTF-8 BOM (json.loads reads it)
    ['{"a": NaN}'.encode("utf-16")],              # UTF-16 with its BOM
    ['{"a": NaN}'.encode("utf-16-be")],           # UTF-16 without one: NUL first
    [b"[1e400]"],
    [b"-1e400"],
], ids=["whitespace-first", "utf8-bom", "utf16", "utf16-be", "array", "bare-number"])
def test_unit_bodies_that_can_hold_a_number_are_still_checked(parts):
    from services.json_number_guard import JsonNumberGuard

    inner = _Recorder()
    receive, _pulled = _feed([{"type": "http.request", "body": part, "more_body": index < len(parts) - 1}
                              for index, part in enumerate(parts)])
    sent = _run(JsonNumberGuard(inner), _http_scope(None), receive)
    assert inner.calls == 0 and sent[0]["status"] == 422, sent
