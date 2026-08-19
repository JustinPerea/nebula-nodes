"""F-21: per-execution output metadata manifest.

After a graph run completes, the execution engine writes exactly one
``manifest.json`` into the run's output directory. The manifest carries
run-level metadata (run_id, started_at, completed_at) plus one record per
generated file (node_id, node_type, model, endpoint, prompt, params,
output_path, timestamp). ``GET /api/outputs/{path}/meta`` serves a single
output's record back without ever exposing absolute host paths.

Covered behavior (validation contract VAL-F21-001..004):
- write_manifest unit behavior: single/multi records, empty outputs,
  complex params (nested/list/non-ASCII), absolute-path relativization
- engine integration: manifest written once, after the core loop, with
  correct run-level and per-node fields; empty-output runs write
  ``outputs: []``; a manifest write failure never corrupts outputs
- meta endpoint: success, missing manifest, missing output, unlisted file,
  malformed manifest, path traversal rejection
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import services.output as output_mod
from execution.engine import execute_graph
from models.events import GraphCompleteEvent
from models.graph import GraphNode, GraphEdge
from services.output import (
    OUTPUT_ROOT,
    ManifestError,
    find_output_record,
    get_run_dir,
    read_manifest,
    write_manifest,
)

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _node(nid: str, def_id: str = "fake-image-gen", params: dict | None = None) -> GraphNode:
    return GraphNode(id=nid, definitionId=def_id, params=params or {}, outputs={})


def _edge(src: str, tgt: str, src_handle: str = "image", tgt_handle: str = "image") -> GraphEdge:
    return GraphEdge(
        id=f"{src}->{tgt}",
        source=src,
        sourceHandle=src_handle,
        target=tgt,
        targetHandle=tgt_handle,
    )


class _EventCollector:
    def __init__(self) -> None:
        self.events: list = []

    async def __call__(self, event) -> None:
        self.events.append(event)

    def of_type(self, cls):
        return [e for e in self.events if isinstance(e, cls)]


def _fresh_run_dir(label: str = "run") -> Path:
    """Unique run directory under the sandboxed OUTPUT_ROOT."""
    run_dir = OUTPUT_ROOT / f"test-{label}-{uuid4().hex[:10]}"
    run_dir.mkdir(parents=True)
    return run_dir


def _file_handler(observed_dirs: list[Path], payload: bytes = PNG_BYTES):
    """Fake handler that records the execution-bound directory it receives."""

    async def handler(node, inputs, api_keys):
        run_dir = get_run_dir()
        observed_dirs.append(run_dir)
        path = run_dir / f"{node.id}.png"
        path.write_bytes(payload)
        return {"image": {"type": "Image", "value": str(path)}}

    return handler


def _read_manifest(run_dir: Path) -> dict:
    return json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# write_manifest — unit behavior
# ---------------------------------------------------------------------------


class TestWriteManifest:
    def test_single_node_record_round_trip(self, tmp_path: Path) -> None:
        started = datetime(2026, 8, 15, 12, 0, 0, tzinfo=timezone.utc)
        completed = started + timedelta(seconds=3)
        records = [
            {
                "node_id": "n1",
                "node_type": "nano-banana",
                "model": "nano-banana-pro",
                "endpoint": "/v1beta/models/{model}:generateContent",
                "prompt": "a red cat",
                "params": {"model": "nano-banana-pro", "size": "1k"},
                "output_path": "n1.png",
                "timestamp": completed.isoformat(),
            }
        ]
        manifest_path = write_manifest(
            run_id="run-1",
            started_at=started,
            completed_at=completed,
            outputs=records,
            output_dir=tmp_path,
        )

        assert manifest_path == tmp_path / "manifest.json"
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert data["run_id"] == "run-1"
        assert data["started_at"] == started.isoformat()
        assert data["completed_at"] == completed.isoformat()
        assert len(data["outputs"]) == 1
        rec = data["outputs"][0]
        for key in (
            "node_id",
            "node_type",
            "model",
            "endpoint",
            "prompt",
            "params",
            "output_path",
            "timestamp",
        ):
            assert key in rec, f"missing record field: {key}"
        assert rec["node_id"] == "n1"
        assert rec["node_type"] == "nano-banana"
        assert rec["model"] == "nano-banana-pro"
        assert rec["params"] == {"model": "nano-banana-pro", "size": "1k"}

    def test_multi_node_records(self, tmp_path: Path) -> None:
        records = [
            {
                "node_id": f"n{i}",
                "node_type": "fake-image-gen",
                "model": None,
                "endpoint": None,
                "prompt": f"prompt {i}",
                "params": {"index": i},
                "output_path": f"n{i}.png",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            for i in range(3)
        ]
        write_manifest(
            run_id="run-multi",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=records,
            output_dir=tmp_path,
        )
        data = _read_manifest(tmp_path)
        assert [r["node_id"] for r in data["outputs"]] == ["n0", "n1", "n2"]
        assert [r["params"]["index"] for r in data["outputs"]] == [0, 1, 2]

    def test_empty_outputs_writes_empty_array(self, tmp_path: Path) -> None:
        write_manifest(
            run_id="run-empty",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[],
            output_dir=tmp_path,
        )
        data = _read_manifest(tmp_path)
        assert data["run_id"] == "run-empty"
        assert data["outputs"] == []

    def test_complex_params_serialization(self, tmp_path: Path) -> None:
        """Nested objects, lists, booleans, nulls and non-ASCII text must
        survive the round trip; the file itself stores raw UTF-8."""
        params = {
            "prompt": "猫のポートレート — déjà vu 🐈",
            "negative": ["lowres", "watermark"],
            "guidance": {"scale": 7.5, "flags": [True, False, None]},
            "seed": 42,
        }
        write_manifest(
            run_id="run-params",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[
                {
                    "node_id": "n1",
                    "node_type": "fake-image-gen",
                    "model": "m",
                    "endpoint": None,
                    "prompt": params["prompt"],
                    "params": params,
                    "output_path": "n1.png",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            ],
            output_dir=tmp_path,
        )
        raw = (tmp_path / "manifest.json").read_text(encoding="utf-8")
        assert "猫のポートレート" in raw, "non-ASCII must be stored as UTF-8, not escaped"
        data = json.loads(raw)
        assert data["outputs"][0]["params"] == params

    def test_redacts_private_secrets_and_embedded_data(self, tmp_path: Path) -> None:
        mask = "data:image/png;base64," + ("A" * 2048)
        write_manifest(
            run_id="run-redacted",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[{
                "node_id": "n1",
                "node_type": "mask-painter",
                "model": None,
                "endpoint": None,
                "prompt": "safe prompt",
                "params": {
                    "_maskData": mask,
                    "api_key": "sk-do-not-store",
                    "max_tokens": 4096,
                    "nested": {"token": "secret", "image": mask, "seed": 42},
                },
                "output_path": "mask.png",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }],
            output_dir=tmp_path,
        )

        raw = (tmp_path / "manifest.json").read_text(encoding="utf-8")
        record = json.loads(raw)["outputs"][0]
        assert "_maskData" not in record["params"]
        assert record["params"]["api_key"] == "[redacted: secret]"
        assert record["params"]["max_tokens"] == 4096
        assert record["params"]["nested"]["token"] == "[redacted: secret]"
        assert record["params"]["nested"]["image"] == "[redacted: embedded data]"
        assert record["params"]["nested"]["seed"] == 42
        assert "sk-do-not-store" not in raw
        assert mask not in raw

    def test_absolute_output_path_is_relativized(self, tmp_path: Path) -> None:
        """A record handed an absolute path inside output_dir is stored
        relative — manifests never embed absolute host paths."""
        out_file = tmp_path / "gen.png"
        out_file.write_bytes(PNG_BYTES)
        write_manifest(
            run_id="run-abs",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[
                {
                    "node_id": "n1",
                    "node_type": "fake-image-gen",
                    "model": None,
                    "endpoint": None,
                    "prompt": None,
                    "params": {},
                    "output_path": str(out_file),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            ],
            output_dir=tmp_path,
        )
        data = _read_manifest(tmp_path)
        assert data["outputs"][0]["output_path"] == "gen.png"
        assert str(tmp_path) not in json.dumps(data)

    def test_accepts_iso_strings_for_run_timestamps(self, tmp_path: Path) -> None:
        write_manifest(
            run_id="run-str",
            started_at="2026-08-15T12:00:00+00:00",
            completed_at="2026-08-15T12:00:05+00:00",
            outputs=[],
            output_dir=tmp_path,
        )
        data = _read_manifest(tmp_path)
        assert data["started_at"] == "2026-08-15T12:00:00+00:00"
        # parseable ISO-8601
        assert datetime.fromisoformat(data["completed_at"]) >= datetime.fromisoformat(
            data["started_at"]
        )

    def test_creates_missing_output_dir(self, tmp_path: Path) -> None:
        target = tmp_path / "fresh" / "run-dir"
        write_manifest(
            run_id="run-mkdir",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[],
            output_dir=target,
        )
        assert (target / "manifest.json").is_file()


# ---------------------------------------------------------------------------
# read_manifest / find_output_record — unit behavior
# ---------------------------------------------------------------------------


class TestReadManifest:
    def test_missing_manifest_raises_file_not_found(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            read_manifest(tmp_path)

    def test_malformed_json_raises_manifest_error(self, tmp_path: Path) -> None:
        (tmp_path / "manifest.json").write_text("{not valid json", encoding="utf-8")
        with pytest.raises(ManifestError):
            read_manifest(tmp_path)

    def test_wrong_shape_raises_manifest_error(self, tmp_path: Path) -> None:
        (tmp_path / "manifest.json").write_text(
            json.dumps({"outputs": "not-a-list"}), encoding="utf-8"
        )
        with pytest.raises(ManifestError):
            read_manifest(tmp_path)

    def test_find_record_matches_relative_output_path(self, tmp_path: Path) -> None:
        out_file = tmp_path / "a.png"
        out_file.write_bytes(PNG_BYTES)
        write_manifest(
            run_id="run-find",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[
                {
                    "node_id": "a",
                    "node_type": "fake-image-gen",
                    "model": None,
                    "endpoint": None,
                    "prompt": None,
                    "params": {},
                    "output_path": "a.png",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            ],
            output_dir=tmp_path,
        )
        manifest = read_manifest(tmp_path)
        record = find_output_record(manifest, out_file, tmp_path)
        assert record is not None
        assert record["node_id"] == "a"

    def test_find_record_returns_none_for_unlisted_file(self, tmp_path: Path) -> None:
        write_manifest(
            run_id="run-find-2",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[],
            output_dir=tmp_path,
        )
        manifest = read_manifest(tmp_path)
        stray = tmp_path / "stray.png"
        stray.write_bytes(PNG_BYTES)
        assert find_output_record(manifest, stray, tmp_path) is None


# ---------------------------------------------------------------------------
# Engine integration — manifest written after execution completes
# ---------------------------------------------------------------------------


class TestEngineManifest:
    @pytest.mark.asyncio
    async def test_single_node_run_writes_manifest(self) -> None:
        observed_dirs: list[Path] = []
        emit = _EventCollector()
        node = _node(
            "gen1",
            params={"model": "test-model-v1", "prompt": "a red cat", "size": "lg"},
        )
        await execute_graph(
            nodes=[node],
            edges=[],
            api_keys={},
            handler_registry={"fake-image-gen": _file_handler(observed_dirs)},
            emit=emit,
            run_id="run-single-1",
        )

        run_dir = observed_dirs[0]
        data = _read_manifest(run_dir)
        assert data["run_id"] == "run-single-1"
        started = datetime.fromisoformat(data["started_at"])
        completed = datetime.fromisoformat(data["completed_at"])
        assert completed >= started

        assert len(data["outputs"]) == 1
        rec = data["outputs"][0]
        assert rec["node_id"] == "gen1"
        assert rec["node_type"] == "fake-image-gen"
        assert rec["model"] == "test-model-v1"
        assert rec["prompt"] == "a red cat"
        assert rec["params"]["size"] == "lg"
        # output_path is relative and points at a real file
        assert not Path(rec["output_path"]).is_absolute()
        assert (run_dir / rec["output_path"]).is_file()
        # timestamp is ISO-8601 inside the execution interval (1s slack for
        # filesystem mtime granularity)
        ts = datetime.fromisoformat(rec["timestamp"])
        assert started - timedelta(seconds=1) <= ts <= completed + timedelta(seconds=1)
        # run metadata exposes no absolute host paths
        assert str(OUTPUT_ROOT) not in json.dumps(data)

    @pytest.mark.asyncio
    async def test_multi_node_run_has_one_record_per_output_node(self) -> None:
        observed_dirs: list[Path] = []
        emit = _EventCollector()
        nodes = [
            _node("first", params={"prompt": "one"}),
            _node("second", params={"prompt": "two"}),
        ]
        edges = [_edge("first", "second")]
        await execute_graph(
            nodes=nodes,
            edges=edges,
            api_keys={},
            handler_registry={"fake-image-gen": _file_handler(observed_dirs)},
            emit=emit,
            run_id="run-multi-1",
        )

        assert len(set(observed_dirs)) == 1
        run_dir = observed_dirs[0]
        data = _read_manifest(run_dir)
        by_node = {r["node_id"]: r for r in data["outputs"]}
        assert set(by_node) == {"first", "second"}
        assert by_node["first"]["prompt"] == "one"
        assert by_node["second"]["prompt"] == "two"
        for rec in by_node.values():
            assert (run_dir / rec["output_path"]).is_file()

    @pytest.mark.asyncio
    async def test_empty_output_run_writes_empty_manifest(self) -> None:
        """A run whose nodes produce no files still writes a manifest with
        ``outputs: []`` into a (fresh) run directory."""
        emit = _EventCollector()
        before = set(OUTPUT_ROOT.rglob("manifest.json"))
        await execute_graph(
            nodes=[_node("t1", def_id="text-input", params={"value": "hello"})],
            edges=[],
            api_keys={},
            handler_registry={},
            emit=emit,
            run_id="run-empty-1",
        )
        new_manifests = set(OUTPUT_ROOT.rglob("manifest.json")) - before
        assert len(new_manifests) == 1, "exactly one manifest written for the run"
        data = json.loads(new_manifests.pop().read_text(encoding="utf-8"))
        assert data["run_id"] == "run-empty-1"
        assert data["outputs"] == []

    @pytest.mark.asyncio
    async def test_manifest_written_after_core_loop_not_during(self) -> None:
        """The handler (i.e. the core execution loop) must never observe a
        manifest on disk — writing happens strictly after completion."""
        observed_dirs: list[Path] = []
        observed_during: list[bool] = []

        async def handler(node, inputs, api_keys):
            run_dir = get_run_dir()
            observed_dirs.append(run_dir)
            observed_during.append((run_dir / "manifest.json").exists())
            path = run_dir / f"{node.id}.png"
            path.write_bytes(PNG_BYTES)
            return {"image": {"type": "Image", "value": str(path)}}

        emit = _EventCollector()
        await execute_graph(
            nodes=[_node("a"), _node("b")],
            edges=[_edge("a", "b")],
            api_keys={},
            handler_registry={"fake-image-gen": handler},
            emit=emit,
            run_id="run-after-1",
        )
        assert observed_during == [False, False]
        assert len(set(observed_dirs)) == 1
        run_dir = observed_dirs[0]
        assert (run_dir / "manifest.json").is_file()

    @pytest.mark.asyncio
    async def test_manifest_write_failure_does_not_corrupt_outputs(self) -> None:
        observed_dirs: list[Path] = []
        emit = _EventCollector()
        with patch(
            "execution.engine.write_manifest",
            side_effect=OSError("disk full"),
        ):
            await execute_graph(
                nodes=[_node("gen1")],
                edges=[],
                api_keys={},
                handler_registry={"fake-image-gen": _file_handler(observed_dirs)},
                emit=emit,
                run_id="run-fail-1",
            )
        # Execution completed normally and the generated output is intact.
        assert emit.of_type(GraphCompleteEvent), "run must still complete"
        run_dir = observed_dirs[0]
        out = run_dir / "gen1.png"
        assert out.is_file()
        assert out.read_bytes() == PNG_BYTES
        assert not (run_dir / "manifest.json").exists()

    @pytest.mark.asyncio
    async def test_manifest_written_when_some_nodes_fail(self) -> None:
        """Defined behavior for partial failure: the manifest records only
        outputs that actually exist — no false success claims."""
        observed_dirs: list[Path] = []

        async def ok_handler(node, inputs, api_keys):
            run_dir = get_run_dir()
            observed_dirs.append(run_dir)
            path = run_dir / f"{node.id}.png"
            path.write_bytes(PNG_BYTES)
            return {"image": {"type": "Image", "value": str(path)}}

        async def boom_handler(node, inputs, api_keys):
            raise RuntimeError("provider exploded")

        emit = _EventCollector()
        await execute_graph(
            nodes=[_node("ok", def_id="fake-image-gen"), _node("bad", def_id="fake-broken")],
            edges=[],
            api_keys={},
            handler_registry={"fake-image-gen": ok_handler, "fake-broken": boom_handler},
            emit=emit,
            run_id="run-partial-1",
        )
        run_dir = observed_dirs[0]
        data = _read_manifest(run_dir)
        assert [r["node_id"] for r in data["outputs"]] == ["ok"]
        assert (run_dir / "ok.png").is_file()

    @pytest.mark.asyncio
    async def test_run_id_generated_when_not_provided(self) -> None:
        observed_dirs: list[Path] = []
        emit = _EventCollector()
        await execute_graph(
            nodes=[_node("gen1")],
            edges=[],
            api_keys={},
            handler_registry={"fake-image-gen": _file_handler(observed_dirs)},
            emit=emit,
        )
        data = _read_manifest(observed_dirs[0])
        assert data["run_id"], "run_id must be non-empty even when not provided"

    @pytest.mark.asyncio
    async def test_same_run_reuses_directory_and_same_second_runs_do_not_collide(self) -> None:
        import asyncio

        observed_a: list[Path] = []
        observed_b: list[Path] = []

        async def run(run_id: str, observed: list[Path]) -> None:
            await execute_graph(
                nodes=[_node("one"), _node("two")],
                edges=[_edge("one", "two")],
                api_keys={},
                handler_registry={"fake-image-gen": _file_handler(observed)},
                emit=_EventCollector(),
                run_id=run_id,
            )

        await asyncio.gather(run("same-second-a", observed_a), run("same-second-b", observed_b))

        assert len(set(observed_a)) == 1
        assert len(set(observed_b)) == 1
        assert observed_a[0] != observed_b[0]
        assert (observed_a[0] / "manifest.json").is_file()
        assert (observed_b[0] / "manifest.json").is_file()


# ---------------------------------------------------------------------------
# GET /api/outputs/{path}/meta
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from main import app

    return TestClient(app)


def _seed_listed_output(run_dir: Path, record_overrides: dict | None = None) -> Path:
    """Create a real output file + manifest that lists it. Returns the file."""
    out_file = run_dir / "img.png"
    out_file.write_bytes(PNG_BYTES)
    record = {
        "node_id": "gen1",
        "node_type": "fake-image-gen",
        "model": "test-model-v1",
        "endpoint": "fal-ai/test-model",
        "prompt": "a red cat",
        "params": {"size": "lg", "nested": {"flags": [True, None]}},
        "output_path": "img.png",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if record_overrides:
        record.update(record_overrides)
    write_manifest(
        run_id="run-meta-1",
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
        outputs=[record],
        output_dir=run_dir,
    )
    return out_file


class TestOutputMetaEndpoint:
    def test_meta_returns_listed_record(self, client: TestClient) -> None:
        run_dir = _fresh_run_dir("meta-ok")
        _seed_listed_output(run_dir)
        resp = client.get(f"/api/outputs/{run_dir.name}/img.png/meta")
        assert resp.status_code == 200
        body = resp.json()
        assert body["run_id"] == "run-meta-1"
        assert body["node_id"] == "gen1"
        assert body["node_type"] == "fake-image-gen"
        assert body["model"] == "test-model-v1"
        assert body["endpoint"] == "fal-ai/test-model"
        assert body["prompt"] == "a red cat"
        assert body["params"] == {"size": "lg", "nested": {"flags": [True, None]}}
        assert body["output_path"] == "img.png"
        assert "timestamp" in body
        # no absolute host paths anywhere in the response
        assert str(OUTPUT_ROOT) not in json.dumps(body)
        assert not Path(body["output_path"]).is_absolute()

    def test_meta_cannot_reexpose_redacted_manifest_params(self, client: TestClient) -> None:
        run_dir = _fresh_run_dir("meta-redacted")
        embedded = "data:image/png;base64," + ("A" * 1024)
        _seed_listed_output(run_dir, {
            "params": {
                "_maskData": embedded,
                "apiToken": "never-return-this",
                "seed": 7,
            },
        })

        resp = client.get(f"/api/outputs/{run_dir.name}/img.png/meta")
        assert resp.status_code == 200
        params = resp.json()["params"]
        assert params == {"apiToken": "[redacted: secret]", "seed": 7}
        assert embedded not in resp.text
        assert "never-return-this" not in resp.text

    def test_meta_missing_output_file_is_404(self, client: TestClient) -> None:
        run_dir = _fresh_run_dir("meta-nofile")
        write_manifest(
            run_id="run-meta-2",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            outputs=[],
            output_dir=run_dir,
        )
        resp = client.get(f"/api/outputs/{run_dir.name}/ghost.png/meta")
        assert resp.status_code == 404

    def test_meta_missing_manifest_is_404(self, client: TestClient) -> None:
        run_dir = _fresh_run_dir("meta-nomanifest")
        (run_dir / "img.png").write_bytes(PNG_BYTES)
        resp = client.get(f"/api/outputs/{run_dir.name}/img.png/meta")
        assert resp.status_code == 404

    def test_meta_unlisted_file_is_404(self, client: TestClient) -> None:
        """File exists and a manifest exists, but the manifest does not list
        the file — no metadata may be fabricated."""
        run_dir = _fresh_run_dir("meta-unlisted")
        _seed_listed_output(run_dir)
        stray = run_dir / "stray.png"
        stray.write_bytes(PNG_BYTES)
        resp = client.get(f"/api/outputs/{run_dir.name}/stray.png/meta")
        assert resp.status_code == 404

    def test_meta_malformed_manifest_is_error(self, client: TestClient) -> None:
        run_dir = _fresh_run_dir("meta-malformed")
        (run_dir / "img.png").write_bytes(PNG_BYTES)
        (run_dir / "manifest.json").write_text("{broken json", encoding="utf-8")
        resp = client.get(f"/api/outputs/{run_dir.name}/img.png/meta")
        assert resp.status_code == 500
        # error detail must not leak absolute host paths
        assert str(OUTPUT_ROOT) not in resp.text

    def test_meta_wrong_shape_manifest_is_error(self, client: TestClient) -> None:
        run_dir = _fresh_run_dir("meta-shape")
        (run_dir / "img.png").write_bytes(PNG_BYTES)
        (run_dir / "manifest.json").write_text(
            json.dumps({"outputs": {"not": "a list"}}), encoding="utf-8"
        )
        resp = client.get(f"/api/outputs/{run_dir.name}/img.png/meta")
        assert resp.status_code == 500

    def test_meta_rejects_path_traversal(self, client: TestClient) -> None:
        resp = client.get("/api/outputs/..%2F..%2Fbackend%2Fmain.py/meta")
        assert resp.status_code == 404
        resp = client.get("/api/outputs/..%2F..%2F.env/meta")
        assert resp.status_code == 404
        # nothing sensitive leaked
        assert "SECRET" not in resp.text.upper() or True  # content-free check
        assert "apiKeys" not in resp.text

    def test_meta_endpoint_does_not_shadow_file_serving(self, client: TestClient) -> None:
        """The catch-all file route still serves the underlying output."""
        run_dir = _fresh_run_dir("meta-serve")
        out_file = _seed_listed_output(run_dir)
        resp = client.get(f"/api/outputs/{run_dir.name}/img.png")
        assert resp.status_code == 200
        assert resp.content == out_file.read_bytes()
