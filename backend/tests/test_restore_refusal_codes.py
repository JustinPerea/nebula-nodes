"""GM PR #205 r11 item 2: a bundle's graph.json refused for its shape.

The restore's answer keeps ``detail``, the backend's exact words, which agents
(MCP load_graph_file, ``nebula load``), HTTP callers and the log read. Beside
it, ``code`` (and the limit, where there is one) lets the person's tab pick its
line by the cause, never by the words (frontend lib/graphFile
bundleRefusalLine). Other refusals keep the answer they had, with no code.
"""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.cli_graph import CLIGraph
from services.json_number_guard import JsonNumberOutOfRange

ZIP = {"Content-Type": "application/zip", "X-Nebula-Agent": "Claude Code"}


@pytest.fixture
def api(tmp_path, monkeypatch):
    import main as main_module
    from nebula_api import NebulaAPI

    output_root = tmp_path / "output"
    output_root.mkdir()
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", output_root)
    monkeypatch.setattr(main_module, "cli_graph", CLIGraph(persist_path=tmp_path / "state.json"))

    class Ctx:
        pass

    ctx = Ctx()
    ctx.client = TestClient(main_module.app)
    ctx.http = NebulaAPI("http://testserver", client=ctx.client)
    ctx.main = main_module
    ctx.output_root = output_root
    return ctx


def _node(index: int) -> dict:
    return {"id": f"n{index}", "type": "model-node", "position": {"x": 0, "y": index * 10},
            "data": {"label": f"N{index}", "definitionId": "text-input", "params": {"value": "v"}, "state": "idle"}}


def _graph(nodes: int = 1, edges: int = 0, **extra) -> dict:
    graph = {"version": 3, "name": "Shape", "createdAt": "2026-10-31T00:00:00.000Z",
             "nodes": [_node(index) for index in range(nodes)], "edges": [], **extra}
    graph["edges"] = [{"id": f"e{index}", "source": "n0", "sourceHandle": "text", "target": "n0",
                       "targetHandle": "text", "type": "typed-edge", "data": {"dataType": "Text"}}
                      for index in range(edges)]
    return graph


def _bundle_bytes(graph_text: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("graph.json", graph_text)
    return buffer.getvalue()


def _nested(depth: int) -> str:
    return _graph_text(_graph(), deep="[" * depth + "]" * depth)


def _graph_text(graph: dict, **raw: str) -> str:
    """The graph's JSON, with raw JSON text in place of string markers."""
    for key in raw:
        graph[key] = f"@@{key}@@"
    text = json.dumps(graph)
    for key, value in raw.items():
        text = text.replace(f'"@@{key}@@"', value)
    return text


def _restore(api, graph_text: str):
    return api.client.post("/api/outputs/restore", content=_bundle_bytes(graph_text), headers=ZIP)


def _cases(main):
    return [
        ("nested too deeply", lambda: _nested(main.RESTORE_MAX_GRAPH_DEPTH + 2), 400,
         "graph.json is nested too deeply", {"code": "graph_too_complex"}),
        ("deeper than the parser goes", lambda: _nested(200_000), 400,
         None, {"code": "graph_too_complex"}),
        ("a non-finite number", lambda: _graph_text(_graph(), bad="NaN"), 400,
         f"Invalid graph.json: {JsonNumberOutOfRange('NaN')}", {"code": "graph_unreadable_value"}),
        ("a number past float's range", lambda: _graph_text(_graph(), bad="1e999"), 400,
         f"Invalid graph.json: {JsonNumberOutOfRange('1e999')}", {"code": "graph_unreadable_value"}),
    ]


@pytest.mark.parametrize("index", range(4))
def test_a_shape_refusal_carries_its_code_beside_the_exact_words(api, index):
    name, make, status, detail, fields = _cases(api.main)[index]
    response = _restore(api, make())
    assert response.status_code == status, name
    body = response.json()
    if detail is not None:
        assert body["detail"] == detail
    else:
        assert body["detail"].startswith("Invalid graph.json: ")
    assert {key: body[key] for key in fields} == fields
    assert list(api.output_root.iterdir()) == []


def test_too_many_values_is_too_complex(api, monkeypatch):
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_VALUES", 20)
    response = _restore(api, json.dumps(_graph(nodes=3)))
    assert response.status_code == 413
    assert response.json() == {"detail": "graph.json contains too many values", "code": "graph_too_complex"}


def test_the_walk_refuses_a_non_finite_number_with_its_code(api, monkeypatch):
    # The parser refuses NaN first; the walk's own check, for a graph that
    # reaches it, answers the same code.
    import main as main_module

    with pytest.raises(main_module.CodedRefusal) as caught:
        main_module._validate_restore_json_complexity({"x": float("inf")})
    assert (caught.value.status_code, caught.value.detail, caught.value.fields) == (
        400, "graph.json contains a non-finite number", {"code": "graph_unreadable_value"})


def test_too_many_nodes_carries_the_limit(api, monkeypatch):
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_NODES", 3)
    response = _restore(api, json.dumps(_graph(nodes=4)))
    assert response.status_code == 413
    assert response.json() == {"detail": "graph.json contains too many nodes", "code": "graph_too_many_nodes",
                               "maxNodes": 3}


def test_too_many_edges_carries_the_limit(api, monkeypatch):
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_EDGES", 2)
    response = _restore(api, json.dumps(_graph(edges=3)))
    assert response.status_code == 413
    assert response.json() == {"detail": "graph.json contains too many edges", "code": "graph_too_many_edges",
                               "maxEdges": 2}


def test_too_large_carries_its_size_and_the_limit(api, monkeypatch):
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_BYTES", 64)
    text = json.dumps(_graph())
    response = _restore(api, text)
    assert response.status_code == 413
    assert response.json() == {"detail": "graph.json is too large", "code": "graph_too_large",
                               "sizeBytes": len(text.encode("utf-8")), "limitBytes": 64}


def test_the_requests_own_refusals_keep_their_answer_with_no_code(api):
    """Not the file's: the request (an empty body). And graph.json's import
    checks (an unknown node) keep the code /api/graph/import gives them,
    which is what a plain file meets."""
    empty = api.client.post("/api/outputs/restore", content=b"", headers=ZIP)
    assert (empty.status_code, empty.json()) == (400, {"detail": "Empty request body"})
    graph = _graph()
    graph["nodes"][0]["data"]["definitionId"] = "no-such-node"
    unknown = _restore(api, json.dumps(graph))
    assert (unknown.status_code, unknown.json()) == (400, {"detail": "unknown node definition no-such-node",
                                                           "code": "unknown_definition", "definitionId": "no-such-node"})


def test_an_agent_still_reads_the_backends_exact_words(api, tmp_path, monkeypatch):
    """MCP load_graph_file and `nebula load` (graph_file_client) say the
    backend's words, not the person's line."""
    import graph_file_client

    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_NODES", 3)
    path = tmp_path / "big.nebula.zip"
    path.write_bytes(_bundle_bytes(json.dumps(_graph(nodes=4))))
    with pytest.raises(graph_file_client.GraphFileError) as caught:
        graph_file_client.load(api.http, str(path), headers={"X-Nebula-Agent": "Claude Code"})
    assert str(caught.value).endswith(": graph.json contains too many nodes")
    deep = tmp_path / "deep.nebula.zip"
    deep.write_bytes(_bundle_bytes(_nested(api.main.RESTORE_MAX_GRAPH_DEPTH + 2)))
    with pytest.raises(graph_file_client.GraphFileError) as caught:
        graph_file_client.load(api.http, str(deep), headers={"X-Nebula-Agent": "Claude Code"})
    assert str(caught.value).endswith(": graph.json is nested too deeply")


# -- GM PR #205 r12: graph.json that isn't a Nebula graph, and the zip's own checks ---------

import stat  # noqa: E402

_GOOD_NODE = _node(0)


def _shape(**changes) -> str:
    graph = _graph()
    for key, value in changes.items():
        if value is _DROP:
            graph.pop(key, None)
        else:
            graph[key] = value
    return json.dumps(graph)


_DROP = object()


def _with_node(**data_changes) -> str:
    node = json.loads(json.dumps(_GOOD_NODE))
    for key, value in data_changes.items():
        if key.startswith("data."):
            node["data"][key[5:]] = value
        else:
            node[key] = value
    return json.dumps(_graph() | {"nodes": [node]})


def _with_edge(edge) -> str:
    return json.dumps(_graph() | {"edges": [edge] if not isinstance(edge, list) else edge})


_EDGE = {"id": "e1", "source": "n0", "sourceHandle": "text", "target": "n0", "targetHandle": "text", "type": "typed-edge"}

INVALID = [
    ("[]", "graph.json must contain an object"),
    (_shape(version="3"), "Unsupported .nebula file version"),
    (_shape(version=0), "Unsupported .nebula file version"),
    (_shape(version=True), "Unsupported .nebula file version"),
    (_shape(name=_DROP), "graph.json name must be a non-empty string"),
    (_shape(createdAt=" "), "graph.json createdAt must be a non-empty string"),
    (_shape(nodes={}), "graph.json requires nodes and edges arrays"),
    (json.dumps(_graph() | {"nodes": [1]}), "nodes[0] must be an object"),
    (_with_node(id=""), "nodes[0].id must be a bounded non-empty string"),
    (json.dumps(_graph() | {"nodes": [_GOOD_NODE, _GOOD_NODE]}), "duplicate node id n0"),
    (_with_node(type=5), "nodes[0].type must be a string"),
    (_with_node(position=[0, 0]), "nodes[0].position must be an object"),
    (_with_node(position={"x": "0", "y": 0}), "nodes[0].position requires finite numeric x and y"),
    (_with_node(data=[]), "nodes[0].data must be an object"),
    (_with_node(**{"data.label": 3}), "nodes[0].data.label must be a string"),
    (_with_node(**{"data.definitionId": ""}), "nodes[0].data.definitionId must be a non-empty string"),
    (_with_node(**{"data.params": []}), "nodes[0].data.params must be an object"),
    (_with_node(**{"data.outputs": []}), "nodes[0].data.outputs must be an object"),
    (_with_node(**{"data.outputs": {"": {"type": "Text"}}}), "nodes[0] has an invalid output port id"),
    (_with_node(**{"data.outputs": {"text": {"value": 1}}}), "nodes[0].data.outputs.text must be a typed port object"),
    (_with_node(**{"data.state": "flying"}), "nodes[0].data.state is invalid"),
    (_with_edge(1), "edges[0] must be an object"),
    (_with_edge(_EDGE | {"id": ""}), "edges[0].id must be a bounded non-empty string"),
    (_with_edge([_EDGE, _EDGE]), "duplicate edge id e1"),
    (_with_edge(_EDGE | {"type": 1}), "edges[0].type must be a string"),
    (_with_edge(_EDGE | {"data": 1}), "edges[0].data must be an object"),
    (_shape(viewport=[]), "graph.json viewport must be an object"),
    (_shape(viewport={"x": 0, "y": 0, "zoom": 0}), "graph.json viewport requires finite x/y and positive zoom"),
    ("{nope", None),
    ('{"a": 1, "a": 2}', "Invalid graph.json: duplicate JSON key: a"),
]


@pytest.mark.parametrize("index", range(len(INVALID)))
def test_graph_json_that_isnt_a_nebula_graph_is_graph_invalid(api, index):
    text, detail = INVALID[index]
    response = _restore(api, text)
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "graph_invalid"
    if detail is None:
        assert body["detail"].startswith("Invalid graph.json: Expecting")
    else:
        assert body["detail"] == detail
    assert set(body) == {"detail", "code"}


def test_graph_json_that_isnt_utf8_is_graph_invalid(api):
    response = api.client.post("/api/outputs/restore", content=_bundle_raw(b"\xff\xfe{}"), headers=ZIP)
    assert response.status_code == 400
    assert response.json()["code"] == "graph_invalid"
    assert response.json()["detail"].startswith("Invalid graph.json: 'utf-8' codec can't decode")


@pytest.mark.parametrize("version", [4, 3.5, 99])
def test_a_version_past_the_newest_is_graph_newer_version(api, version):
    response = _restore(api, _shape(version=version))
    assert response.status_code == 400
    assert response.json() == {"detail": "Unsupported .nebula file version", "code": "graph_newer_version",
                               "version": version}


def _bundle_raw(graph_bytes: bytes, *, extra=(), info=None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr(info or "graph.json", graph_bytes)
        for name, data in extra:
            archive.writestr(name, data)
    return buffer.getvalue()


def _post(api, content: bytes):
    return api.client.post("/api/outputs/restore", content=content, headers=ZIP)


def _info(name: str, *, mode: int | None = None, compress: int = zipfile.ZIP_STORED, flags: int = 0) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name)
    info.compress_type = compress
    if mode is not None:
        info.external_attr = mode << 16
    info.flag_bits |= flags
    return info


GRAPH = json.dumps(_graph()).encode()


def test_the_zips_own_checks_carry_their_codes(api, monkeypatch):
    m = api.main
    cases = []

    def case(name, content, status, detail, code, **fields):
        cases.append((name, content, status, detail, code, fields))

    case("not a zip", b"PK\x03\x04 not really a zip", 400, None, "bundle_not_zip")
    case("encrypted", _encrypted(_bundle_raw(GRAPH)), 400,
         "Encrypted zip bundles are not supported", "bundle_encrypted")
    case("unsafe path", _bundle_raw(GRAPH, extra=[("assets/../x.png", b"x")]), 400,
         "Zip bundle contains an unsafe path", "bundle_unsafe_path")
    case("invalid path", _bundle_raw(GRAPH, extra=[("assets\\x.png", b"x")]), 400,
         "Zip bundle contains an invalid path", "bundle_unsafe_path")
    case("path too long", _bundle_raw(GRAPH, extra=[("assets/" + "a/" * 520 + "x.png", b"x")]), 400,
         "Zip bundle path is too long", "bundle_path_too_long", maxPathBytes=m.RESTORE_MAX_PATH_BYTES)
    case("component too long", _bundle_raw(GRAPH, extra=[("assets/" + "a" * 300 + ".png", b"x")]), 400,
         "Zip bundle path component is too long", "bundle_path_too_long", maxComponentBytes=255)
    case("colliding paths", _bundle_raw(GRAPH, extra=[("assets/A.png", b"x"), ("assets/a.png", b"y")]), 400,
         "Zip bundle contains duplicate or colliding paths", "bundle_unsafe_path")
    case("symlink", _bundle_raw(GRAPH, extra=[(_info("assets/link", mode=stat.S_IFLNK | 0o777), b"/etc/passwd")]), 400,
         "Zip bundle contains a symlink", "bundle_link")
    case("special file", _bundle_raw(GRAPH, extra=[(_info("assets/fifo", mode=stat.S_IFIFO | 0o644), b"")]), 400,
         "Zip bundle contains a special file", "bundle_special_file")
    case("missing graph.json", _bundle_raw(PNG_BYTES, info="assets/a.png"), 400,
         "Zip bundle is missing graph.json", "bundle_missing_graph")
    deflated = io.BytesIO()
    with zipfile.ZipFile(deflated, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("graph.json", GRAPH)
        archive.writestr("assets/big.txt", b"a" * 200_000)
    case("unsafe ratio", deflated.getvalue(), 413, "Zip bundle member has an unsafe compression ratio",
         "bundle_unsafe_ratio", maxRatio=m.RESTORE_MAX_COMPRESSION_RATIO)
    for name, content, status, detail, code, fields in cases:
        response = _post(api, content)
        body = response.json()
        assert response.status_code == status, (name, body)
        if detail is None:
            assert body["detail"].startswith("Not a valid zip bundle: "), (name, body)
        else:
            assert body["detail"] == detail, (name, body)
        assert body["code"] == code, (name, body)
        assert {key: body[key] for key in fields} == fields, (name, body)
    assert list(api.output_root.iterdir()) == []


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _encrypted(content: bytes) -> bytes:
    """The bundle with its entries marked encrypted (zipfile clears the flag
    when it writes, so it is set in the bytes: each local header's and
    central directory entry's general-purpose flags)."""
    data = bytearray(content)
    for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        start = 0
        while (at := data.find(signature, start)) != -1:
            data[at + offset] |= 0x1
            start = at + 4
    return bytes(data)


def test_unsupported_compression_is_its_own_code(api):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_BZIP2) as archive:
        archive.writestr("graph.json", GRAPH)
    response = _post(api, buffer.getvalue())
    assert (response.status_code, response.json()) == (400, {
        "detail": "Zip bundle uses an unsupported compression method", "code": "bundle_unsupported_compression"})


@pytest.mark.parametrize("limit,extra,status,detail,code,field", [
    ("RESTORE_MAX_MEMBERS", [("assets/a.png", PNG_BYTES), ("assets/b.png", PNG_BYTES)], 413,
     "Zip bundle contains too many members", "bundle_too_many_members", "maxMembers"),
    ("RESTORE_MAX_MEMBER_BYTES", [("assets/a.png", PNG_BYTES * 20)], 413,
     "Zip bundle member is too large", "bundle_member_too_large", "limitBytes"),
    ("RESTORE_MAX_TOTAL_UNCOMPRESSED_BYTES", [("assets/a.png", PNG_BYTES * 20)], 413,
     "Zip bundle expands beyond the restore limit", "bundle_expands_too_far", "limitBytes"),
])
def test_the_zips_limits_carry_their_codes_and_limits(api, monkeypatch, limit, extra, status, detail, code, field):
    small = {"RESTORE_MAX_MEMBERS": 2, "RESTORE_MAX_MEMBER_BYTES": len(GRAPH) + 10,
             "RESTORE_MAX_TOTAL_UNCOMPRESSED_BYTES": len(GRAPH) + 10}[limit]
    monkeypatch.setattr(api.main, limit, small)
    response = _post(api, _bundle_raw(GRAPH, extra=extra))
    assert (response.status_code, response.json()) == (status, {"detail": detail, "code": code, field: small})


def test_graph_json_past_its_limit_once_read_is_bad_size_metadata(api):
    """The preflight let graph.json through on its declared size; more came
    out: the bundle's size metadata is wrong."""
    with zipfile.ZipFile(io.BytesIO(_bundle_raw(GRAPH))) as archive:
        member = archive.getinfo("graph.json")
        with pytest.raises(api.main.CodedRefusal) as caught:
            api.main._read_restore_member_bytes(archive, member, byte_limit=10)
    assert (caught.value.status_code, caught.value.detail, caught.value.fields) == (
        413, "graph.json is too large", {"code": "bundle_size_metadata"})


def test_files_that_couldnt_be_copied_are_bundle_restore_failed(api, monkeypatch):
    def fail(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(api.main, "_extract_restore_member", fail)
    response = _post(api, _bundle_raw(GRAPH, extra=[("assets/a.png", PNG_BYTES)]))
    assert (response.status_code, response.json()) == (500, {
        "detail": "Could not restore zip bundle assets", "code": "bundle_restore_failed"})


def test_an_upload_past_the_limit_is_bundle_upload_too_large(api, monkeypatch):
    monkeypatch.setattr(api.main, "RESTORE_MAX_COMPRESSED_BYTES", 64)
    response = _post(api, _bundle_raw(GRAPH))
    assert (response.status_code, response.json()) == (413, {
        "detail": "Zip bundle exceeds the compressed upload limit", "code": "bundle_upload_too_large", "limitBytes": 64})


def test_a_streamed_upload_past_the_limit_is_bundle_upload_too_large(api, monkeypatch):
    # No Content-Length: the limit is caught while the body streams in.
    monkeypatch.setattr(api.main, "RESTORE_MAX_COMPRESSED_BYTES", 64)
    raw = _bundle_raw(GRAPH)
    response = api.client.post("/api/outputs/restore", content=iter([raw[:32], raw[32:]]), headers=ZIP)
    assert (response.status_code, response.json()) == (413, {
        "detail": "Zip bundle exceeds the compressed upload limit", "code": "bundle_upload_too_large", "limitBytes": 64})


def test_an_agent_reads_the_zips_own_words(api, tmp_path):
    import graph_file_client

    path = tmp_path / "noGraph.nebula.zip"
    path.write_bytes(_bundle_raw(PNG_BYTES, info="assets/a.png"))
    with pytest.raises(graph_file_client.GraphFileError) as caught:
        graph_file_client.load(api.http, str(path), headers={"X-Nebula-Agent": "Claude Code"})
    assert str(caught.value).endswith(": Zip bundle is missing graph.json")
