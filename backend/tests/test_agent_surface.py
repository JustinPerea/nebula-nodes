"""The agent-surface guard: every feature ships with agent support (Justin, 2026-10-20).

backend/agent_surface.py is the manifest; backend/agent_surface_check.py reads
the code. Each test here fails with sentences that say which row to add or
change. The canvas half is frontend/scripts/check-agent-surface.mjs (CI).

What this can't catch, so the PR checklist has to: a change inside an
existing route, tool or store action (new logic in autoLayout, a new field in
a body), logic only the frontend computes, whether a tool gives the UI's
guarantees (undo, baseVersion, skip-if-changed), whether a classification is
right, and state kept only in localStorage.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import agent_surface as surface  # noqa: E402
import agent_surface_check as check  # noqa: E402
import main  # noqa: E402
from services.person_gate import require_person  # noqa: E402

# GAPS_2026_10_20 held this many keys when it was seeded from the audit. It may
# only shrink: lower this number when you close a gap, never raise it.
GAPS_SEEDED = 138
DOCS_GAPS_SEEDED = 19


def _clean(problems: list[str]) -> None:
    assert not problems, "\n" + "\n".join(f"- {p}" for p in problems)


# -- the manifest against the code ----------------------------------------------

def test_the_manifest_keeps_one_sorted_row_per_line():
    _clean(check.check_layout())


def test_every_route_and_websocket_has_a_row():
    _clean(check.check_routes(main.app))


def test_every_row_names_real_tools_and_closed_reasons():
    _clean(check.check_rows())


def test_gaps_only_shrink():
    _clean(check.check_gaps())
    assert len(surface.GAPS_2026_10_20) <= GAPS_SEEDED, (
        "GAPS_2026_10_20 grew. A new feature can't ship as a Gap: give its row a real agent path.")
    assert len(surface.DOCS_GAPS_2026_10_20) <= DOCS_GAPS_SEEDED, (
        "DOCS_GAPS_2026_10_20 grew: document the new tool argument in docs/MCP-SETUP.md instead.")


def test_person_only_routes_show_a_gate_and_tool_routes_show_none():
    _clean(check.check_gates(main.app))


def test_tool_rows_are_routes_the_mcp_side_calls():
    _clean(check.check_tool_routes())


def test_every_mcp_tool_is_named_by_a_row():
    _clean(check.check_tools_covered())


def test_every_cli_command_and_option_has_an_mcp_equivalent():
    _clean(check.check_cli())


def test_every_event_kind_and_broadcast_type_has_a_row():
    _clean(check.check_events())


def test_every_internal_param_has_a_row():
    _clean(check.check_internal_params())


def test_every_tool_is_annotated():
    _clean(check.check_annotations())


def test_the_mcp_doc_names_every_tool_and_argument():
    _clean(check.check_docs())


def test_mcp_tools_stay_on_the_http_path():
    _clean(check.check_mcp_imports())


def test_the_json_export_is_up_to_date():
    _clean(check.check_export())


# -- the gates, live ------------------------------------------------------------

def _example(schema: dict[str, Any], defs: dict[str, Any]) -> Any:
    """The smallest value a JSON schema accepts, good enough to get past body
    validation to the handler's gate."""
    if "$ref" in schema:
        return _example(defs[schema["$ref"].rsplit("/", 1)[-1]], defs)
    for key in ("anyOf", "oneOf", "allOf"):
        if key in schema:
            options = [s for s in schema[key] if s.get("type") != "null"] or schema[key]
            return _example(options[0], defs)
    if "enum" in schema:
        return schema["enum"][0]
    if "const" in schema:
        return schema["const"]
    if "default" in schema:
        return schema["default"]
    kind = schema.get("type")
    if kind == "object" or "properties" in schema:
        props = schema.get("properties", {})
        return {name: _example(props[name], defs) for name in schema.get("required", []) if name in props}
    if kind == "array":
        return [_example(schema.get("items", {}), defs)] * int(schema.get("minItems", 0))
    if kind == "string":
        return "x" * max(1, int(schema.get("minLength", 1)))
    if kind in ("integer", "number"):
        return max(0, schema.get("minimum", 0), schema.get("exclusiveMinimum", -1) + 1)
    if kind == "boolean":
        return False
    return {}


def _body_for(route: Any) -> Any:
    field = getattr(route, "body_field", None)
    if field is None:
        return None
    from pydantic import TypeAdapter

    try:
        schema = TypeAdapter(field.field_info.annotation).json_schema()
    except Exception:  # noqa: BLE001 - a body we can't describe gets {}
        return {}
    return _example(schema, schema.get("$defs", {}))


# Path params a route checks before its gate (an unknown kind is a 400 for anyone).
_PATH_SAMPLES = {"kind": "moodboard"}


def test_an_agent_is_refused_on_every_person_only_route(tmp_path, monkeypatch):
    """Calls each PersonOnly/Propose route as an agent (X-Nebula-Agent), with a
    body that passes validation, and expects the person gate's own 403 before
    anything else runs."""
    from commons import runtime

    # The commons routes 404 while the commons is off; turn it on in a temp root.
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    runtime.reset_for_tests()
    try:
        refused, problems = _refuse_agents_live(main.app, surface.ROUTES)
    finally:
        runtime.reset_for_tests()
    _clean(problems)
    assert refused > 0


# What the person gates answer an agent with: services/person_gate.require_person
# (code agent_refused) and the commons' human_dep (routes/commons.py).
_COMMONS_HUMAN_ONLY = "only the human UI session can do this"


def _is_person_gate_refusal(response: Any) -> bool:
    if response.status_code != 403:
        return False
    try:
        body = response.json()
    except ValueError:
        return False
    return isinstance(body, dict) and (body.get("code") == "agent_refused" or body.get("detail") == _COMMONS_HUMAN_ONLY)


def _refuse_agents_live(app: Any, rows: dict[str, Any]) -> tuple[int, list[str]]:
    """(routes that refused, problems). Routes the static check finds ungated
    aren't called: an ungated route would really run (test_person_only_routes_
    show_a_gate... reports them). The client is on loopback so local-only
    routers (/api/krea) let the request through to the gate."""
    client = TestClient(app, raise_server_exceptions=False, client=("127.0.0.1", 50000))
    routes = check.app_routes(app)
    refused, unreached, problems = 0, [], []
    for key, row in sorted(rows.items()):
        if not isinstance(row, (surface.PersonOnly, surface.Propose)) or key.startswith("WS "):
            continue
        route = routes.get(key)
        if route is None or check.route_gate(route) is None:
            continue
        method, path = key.split(" ", 1)
        url = path
        for name in route.param_convertors:
            value = _PATH_SAMPLES.get(name, "agent-surface-check")
            url = url.replace("{" + name + ":path}", value).replace("{" + name + "}", value)
        body = _body_for(route)
        response = client.request(method, url, headers={"X-Nebula-Agent": "agent-surface-check"},
                                  **({"json": body} if body is not None else {}))
        if response.status_code in (415, 422):  # the body's shape is checked first, for anyone
            unreached.append(key)
            continue
        if not _is_person_gate_refusal(response):
            problems.append(f'ROUTES["{key}"] is {type(row).__name__}, but an agent got {response.status_code} '
                            f"({response.text[:120]}), not the person gate's refusal. Call "
                            "require_person(current_request_headers()) first thing in the handler, before any "
                            "lookup, other check or work")
            continue
        refused += 1
    # A route whose body this test can't build is only fine when its gate is a
    # dependency, which runs whatever the body (test_person_only_routes_show_a_gate...).
    problems += [f'ROUTES["{key}"]: the live check couldn\'t get past body checks to the handler\'s gate; '
                 "declare the body as a pydantic model, or gate it with a dependency"
                 for key in unreached if check.route_gate(routes[key]) != "dependency"]
    return refused, problems


def test_the_live_check_wants_the_person_gate_not_any_403():
    """A 403 from some other check (an origin rule, a workspace fence) proves
    nothing about the person gate."""
    from fastapi import HTTPException

    def origin_rule(request: Request) -> None:
        raise HTTPException(403, "origin is not allowed")

    def handler(request: Request, _=Depends(origin_rule)) -> dict:
        require_person(request.headers)
        return {}

    app = FastAPI()
    app.add_api_route("/api/widgets", handler, methods=["DELETE"])
    app.add_api_route("/api/widgets/gated", _gated_handler, methods=["DELETE"])
    from services.person_gate import PersonGateError, person_gate_error

    app.add_exception_handler(PersonGateError, person_gate_error)
    rows = {"DELETE /api/widgets": surface.PersonOnly("deleting for good"),
            "DELETE /api/widgets/gated": surface.PersonOnly("deleting for good")}
    refused, problems = _refuse_agents_live(app, rows)
    assert refused == 1
    assert len(problems) == 1 and "not the person gate's refusal" in problems[0] and "origin" in problems[0]


def test_the_dev_helper_keeps_off_the_persons_state(tmp_path):
    """`cd backend && .venv/bin/python agent_surface_check.py` imports main,
    which seeds ~/.nebula (presets, locks, projects/) when nothing points it
    elsewhere. The helper is what AGENTS.md tells every author to run, so it
    must work in a throwaway state of its own."""
    import os
    import subprocess

    home = tmp_path / "home"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEBULA_")}
    env["HOME"] = str(home)
    settings = check.BACKEND / "settings.json"
    settings_before = settings.read_bytes() if settings.exists() else None
    result = subprocess.run([sys.executable, str(check.BACKEND / "agent_surface_check.py")], cwd=check.BACKEND,
                            env=env, capture_output=True, text=True, timeout=120)
    # 1 means it found problems, which the other tests report; this one is about state.
    assert result.returncode in (0, 1) and "The canvas side" in result.stdout, result.stdout + result.stderr
    assert not (home / ".nebula").exists(), sorted(str(p) for p in (home / ".nebula").rglob("*"))[:10]
    assert (settings.read_bytes() if settings.exists() else None) == settings_before


def test_routes_the_guard_cannot_read_fail_closed():
    """A mounted sub-app or a bare Starlette route would serve requests no row
    covers; only FastAPI's own docs pages are left out."""
    app = FastAPI()
    app.mount("/api/widgets", FastAPI())
    app.add_route("/api/gloss", lambda request: None, methods=["POST"])
    problems = check.check_routes(app)
    assert any('"/api/widgets"' in p and "Mount" in p for p in problems), problems
    assert any('"/api/gloss"' in p and "Route" in p for p in problems), problems
    assert not any("/docs" in p or "/openapi.json" in p for p in problems), problems


def test_messages_the_canvas_socket_sends_directly_are_read():
    """/ws answers a hello itself (proposalSync, personRequired), outside manager.broadcast*."""
    types, unreadable = check.broadcast_types()
    assert unreadable == []
    assert {"proposalSync", "personRequired"} <= set(types)


def test_internal_params_named_by_a_constant_are_read():
    """params.pop(_MESHY_TASK) with _MESHY_TASK = "_meshy_task" at module level."""
    assert "_meshy_task" in check.backend_internal_params()


# -- the guard itself -----------------------------------------------------------

def _open_handler(request: Request) -> dict:
    return {}


def _gated_handler(request: Request) -> dict:
    require_person(request.headers)
    return {}


def _app_with(*paths: tuple[str, str], gated: bool = False) -> FastAPI:
    app = FastAPI()
    for method, path in paths:
        app.add_api_route(path, _gated_handler if gated else _open_handler, methods=[method])
    return app


def test_guard_names_the_row_a_new_route_needs(monkeypatch):
    monkeypatch.setattr(surface, "ROUTES", {})
    problems = check.check_routes(_app_with(("POST", "/api/widgets/{widget_id}/polish")))
    assert len(problems) == 1
    assert 'add "POST /api/widgets/{widget_id}/polish": ... to ROUTES in backend/agent_surface.py' in problems[0]


def test_guard_flags_a_stale_row(monkeypatch):
    monkeypatch.setattr(surface, "ROUTES", {"GET /api/gone": surface.Exempt("health")})
    assert check.check_routes(FastAPI()) == ['ROUTES["GET /api/gone"]: main.app no longer serves it; delete the row']


def test_guard_sees_whether_a_person_only_route_is_gated(monkeypatch):
    monkeypatch.setattr(surface, "ROUTES", {"DELETE /api/widgets/{widget_id}": surface.PersonOnly("deleting for good")})
    open_app = _app_with(("DELETE", "/api/widgets/{widget_id}"))
    problems = check.check_gates(open_app)
    assert len(problems) == 1 and "agents get through" in problems[0]
    assert check.check_gates(_app_with(("DELETE", "/api/widgets/{widget_id}"), gated=True)) == []


def test_a_gate_behind_a_condition_does_not_count():
    def handler(request: Request, force: bool = False) -> dict:
        if force:
            require_person(request.headers)
        return {}

    app = FastAPI()
    app.add_api_route("/api/widgets", handler, methods=["POST"])
    assert check.route_gate(check.app_routes(app)["POST /api/widgets"]) is None


def test_a_dependency_gate_counts():
    def human_dep(request: Request) -> None:
        require_person(request.headers)

    app = FastAPI()
    app.add_api_route("/api/widgets", lambda _=Depends(human_dep): {}, methods=["GET"])
    assert check.route_gate(check.app_routes(app)["GET /api/widgets"]) == "dependency"


def test_guard_flags_a_tool_route_that_refuses_agents(monkeypatch):
    monkeypatch.setattr(surface, "ROUTES", {"POST /api/widgets": surface.Tool("edit_canvas")})
    problems = check.check_gates(_app_with(("POST", "/api/widgets"), gated=True))
    assert len(problems) == 1 and "make it PersonOnly or Propose" in problems[0]


def test_a_new_gap_is_refused(monkeypatch):
    routes = dict(surface.ROUTES)
    routes["POST /api/widgets"] = surface.Gap("U1")
    monkeypatch.setattr(surface, "ROUTES", routes)
    problems = check.check_rows()
    assert any('"POST /api/widgets" isn\'t in GAPS_2026_10_20, which may only shrink' in p for p in problems)


def test_a_gap_must_cite_the_audit(monkeypatch):
    routes = dict(surface.ROUTES)
    routes["DELETE /api/graph"] = surface.Gap("U99")
    monkeypatch.setattr(surface, "ROUTES", routes)
    assert any("isn't an audit unit" in p for p in check.check_rows())


def test_a_closed_gap_must_leave_the_set(monkeypatch):
    routes = dict(surface.ROUTES)
    routes["DELETE /api/graph"] = surface.Exempt("maintenance")
    monkeypatch.setattr(surface, "ROUTES", routes)
    assert check.check_gaps() == [
        '"DELETE /api/graph" has a real agent path now: delete it from GAPS_2026_10_20 in backend/agent_surface.py']


def test_an_exempt_reason_must_come_from_the_closed_set(monkeypatch):
    routes = dict(surface.ROUTES)
    routes["GET /api/health"] = surface.Exempt("agents don't need it")
    monkeypatch.setattr(surface, "ROUTES", routes)
    assert any("isn't one of EXEMPT_REASONS" in p for p in check.check_rows())


def test_an_unknown_tool_is_flagged(monkeypatch):
    routes = dict(surface.ROUTES)
    routes["GET /api/health"] = surface.Tool("polish_widget")
    monkeypatch.setattr(surface, "ROUTES", routes)
    assert any('"polish_widget", which mcp_server.py doesn\'t register' in p for p in check.check_rows())


def test_a_cli_option_without_an_mcp_argument_is_flagged(monkeypatch):
    leaves = check.cli_leaves()
    leaves["nebula look"] = [*leaves["nebula look"], "highlight"]
    monkeypatch.setattr(check, "cli_leaves", lambda: leaves)
    problems = check.check_cli()
    assert len(problems) == 1
    assert 'CLI["nebula look"]: option highlight has no MCP equivalent in look_at_canvas' in problems[0]
    assert 'args={"highlight": "<tool argument>"}' in problems[0]


def test_a_new_cli_command_needs_a_row(monkeypatch):
    leaves = {**check.cli_leaves(), "nebula polish": []}
    monkeypatch.setattr(check, "cli_leaves", lambda: leaves)
    assert check.check_cli() == ['"nebula polish" has no row: add "nebula polish": Tool("<mcp tool>") (or '
                                 'Exempt/PersonOnly) to CLI in backend/agent_surface.py']


def test_a_new_journal_kind_needs_a_row(monkeypatch):
    monkeypatch.setattr(check, "event_kinds", lambda: {*surface_kinds(), "widget.polished"})
    problems = check.check_events()
    assert len(problems) == 1 and '"kind widget.polished" has no row' in problems[0]


def surface_kinds() -> set[str]:
    from services.canvas_events import EVENT_KINDS

    return set(EVENT_KINDS)


def test_broadcast_types_are_read_from_the_code():
    types, unreadable = check.broadcast_types()
    assert unreadable == []
    # A dict literal, a helper's return value, and the typed run events.
    assert {"projectsChanged", "canvasPins", "storedAssetChanged", "graphSync", "executed"} <= set(types)


def test_a_backend_internal_param_needs_a_row(monkeypatch):
    found = {**check.backend_internal_params(), "_widgetGloss": ["handlers/widget.py:1"]}
    monkeypatch.setattr(check, "backend_internal_params", lambda: found)
    problems = check.check_internal_params()
    assert len(problems) == 1 and '"_widgetGloss" is read by the backend but has no row' in problems[0]


def test_layout_check_flags_order_duplicates_and_shared_lines(tmp_path):
    bad = tmp_path / "agent_surface.py"
    bad.write_text('ROUTES = {\n    "b": 1,\n    "a": 2,\n}\nCLI = {\n    "x": 1, "y": 2,\n    "x": 3,\n}\n')
    problems = check.check_layout(bad)
    assert any('put "a" before "b"' in p for p in problems)
    assert any('"x" is in CLI twice' in p for p in problems)
    assert any("two rows on one line" in p for p in problems)


@pytest.mark.parametrize(("literal", "route", "reaches"), [
    ("/api/canvas/pins/\x00/resolve", "/api/canvas/pins/{pin_id}/resolve", True),
    ("/api/\x00s/\x00/move", "/api/moodboards/{moodboard_id}/move", True),
    ("/api/commons\x00", "/api/commons/assets/{asset_id}", True),
    ("/api/graph/apply", "/api/graph/restore", False),
    ("/api/trash", "/api/trash/empty", False),
])
def test_literal_matching(literal, route, reaches):
    assert check.literal_reaches(literal, route) is reaches


# -- the canvas half (frontend/scripts/check-agent-surface.mjs) ------------------

_MJS = check.REPO / "frontend" / "scripts" / "check-agent-surface.mjs"


def _run_mjs(**env: str):
    import os
    import shutil
    import subprocess

    node = shutil.which("node")
    if node is None:
        pytest.skip("node isn't installed; CI runs the canvas check in the contracts job")
    return subprocess.run([node, str(_MJS)], capture_output=True, text=True, timeout=60,
                          env={**os.environ, **env})


def test_the_canvas_check_passes_on_this_tree():
    result = _run_mjs()
    assert result.returncode == 0, result.stderr


def test_the_canvas_check_names_the_row_each_new_thing_needs(tmp_path):
    src = tmp_path / "src"
    (src / "store").mkdir(parents=True)
    (src / "store" / "graphStore.ts").write_text(
        "interface GraphState {\n"
        "  nodes: Node[];\n"
        "  // a comment (with an open bracket\n"
        "  polishWidget: (\n"
        "    id: string,\n"
        "  ) => void;\n"
        "}\n")
    (src / "lib").mkdir()
    (src / "lib" / "widgets.ts").write_text(
        "export const polish = (id: string) => apiFetch(`/api/widgets/${id}/polish`);\n"
        "export const ok = () => apiFetch('/api/graph/apply');\n"
        "export const gloss = (params: Record<string, unknown>) => { params._widgetGloss = 1; };\n")
    result = _run_mjs(NEBULA_AGENT_SURFACE_SRC=str(src))
    assert result.returncode == 1
    err = result.stderr
    assert "calls /api/widgets/${...}/polish, which no ROUTES row in backend/agent_surface.py matches" in err
    assert "/api/graph/apply" not in err
    assert 'graphStore.polishWidget has no row: add "graphStore.polishWidget"' in err
    assert 'uses "_widgetGloss": add "_widgetGloss": ... to INTERNAL_PARAMS' in err
    # Rows for store members this copy doesn't have are stale.
    assert 'FRONTEND_ACTIONS["graphStore.undo"]: GraphState no longer has it' in err
    assert "graphStore.nodes" not in err
