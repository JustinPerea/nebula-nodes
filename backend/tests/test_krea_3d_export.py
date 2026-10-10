"""Krea 3D export: one API call, a credential-free download, a defensive unzip."""
from __future__ import annotations

import io
import json
import zipfile

import pytest
import respx

from handlers import krea_export
from models.graph import GraphNode, PortValueDict
from services import output

JOB = "633d1ed4-7fff-45cb-8588-8413a1cd58f5"
ZIP_URL = "https://exports.example.test/model.zip"
KEYS = {"KREA_API_TOKEN": "fixture"}


def archive(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, data in entries:
            bundle.writestr(name, data)
    return buffer.getvalue()


@pytest.fixture
def run_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(krea_export, "get_run_dir", lambda: tmp_path)
    monkeypatch.setattr(output, "OUTPUT_ROOT", tmp_path)
    return tmp_path


def export_node(**params):
    return GraphNode(id="export", definitionId="krea-3d-export", params={"file_format": "obj", **params})


@pytest.mark.asyncio
async def test_exports_a_wired_job_and_unpacks_the_model(run_dir):
    bundle = archive([("model/mesh.obj", b"v 0 0 0\n"), ("model/mesh.mtl", b"newmtl a\n")])
    with respx.mock as router:
        submit = router.post("https://api.krea.ai/export/3d").respond(200, json={"url": ZIP_URL})
        download = router.get(ZIP_URL).respond(200, content=bundle)
        result = await krea_export.handle_krea_3d_export(
            export_node(), {"job": PortValueDict(type="Any", value={"job_id": JOB, "status": "completed"})}, KEYS)
    assert json.loads(submit.calls[0].request.content) == {"job_id": JOB, "file_format": "obj"}
    assert submit.calls[0].request.headers["authorization"] == "Bearer fixture"
    assert "authorization" not in download.calls[0].request.headers
    assert result["mesh"]["value"].endswith("mesh.obj")
    assert result["file"]["value"] == result["mesh"]["value"]
    assert len(result["files"]["value"]) == 2


@pytest.mark.asyncio
async def test_ply_is_saved_but_not_offered_as_a_previewable_mesh(run_dir):
    with respx.mock as router:
        router.post("https://api.krea.ai/export/3d").respond(200, json={"url": ZIP_URL})
        router.get(ZIP_URL).respond(200, content=archive([("out.ply", b"ply\n")]))
        result = await krea_export.handle_krea_3d_export(export_node(file_format="ply", job_id=JOB), {}, KEYS)
    assert result["mesh"]["value"] is None
    assert result["file"]["value"].endswith("out.ply")


def symlink_entry():
    info = zipfile.ZipInfo("link.obj")
    info.external_attr = (0o120777 << 16)
    return info


@pytest.mark.asyncio
@pytest.mark.parametrize("entries", [
    [("../escape.obj", b"v")],
    [("/abs/escape.obj", b"v")],
    [("dir\\escape.obj", b"v")],
    [(symlink_entry(), b"/etc/passwd")],
])
async def test_unsafe_archives_are_refused(run_dir, entries):
    with respx.mock as router:
        router.post("https://api.krea.ai/export/3d").respond(200, json={"url": ZIP_URL})
        router.get(ZIP_URL).respond(200, content=archive(entries))
        with pytest.raises(RuntimeError, match="unsafe path"):
            await krea_export.handle_krea_3d_export(export_node(job_id=JOB), {}, KEYS)
    assert not (run_dir.parent / "escape.obj").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("params,inputs,match", [
    ({"job_id": "../usage"}, {}, "Krea 3D job"),
    ({}, {}, "Krea 3D job"),
    ({"job_id": JOB, "file_format": "glb"}, {}, "OBJ, FBX, STL or PLY"),
])
async def test_bad_requests_fail_before_any_call(run_dir, params, inputs, match):
    with respx.mock(assert_all_called=False) as router:
        api = router.route(host="api.krea.ai").respond(500)
        with pytest.raises(ValueError, match=match):
            await krea_export.handle_krea_3d_export(export_node(**params), inputs, KEYS)
        assert not api.called


@pytest.mark.asyncio
async def test_non_https_or_missing_export_urls_are_not_downloaded(run_dir):
    with respx.mock as router:
        router.post("https://api.krea.ai/export/3d").respond(200, json={"url": "http://exports.example.test/a.zip"})
        with pytest.raises(RuntimeError, match="unexpected export URL"):
            await krea_export.handle_krea_3d_export(export_node(job_id=JOB), {}, KEYS)
