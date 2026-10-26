"""An input card names the file it holds (fix/drop-followups, 2026-10-24).

/api/uploads stores a file under its content hash ("3fa9...e1.pdf"), so the
name the person (or an agent) gave it was lost and an Audio or Document Input
card had nothing to show. A created node now keeps the original name in
`_fileName`, paired with the stored file it names ({"file": <basename of
filePath>, "name": <original>}), so a later filePath change can't leave the
old name on the card. Agents read it as `fileName` in look_at_canvas.
"""
from __future__ import annotations

import io
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main as main_module
from main import app
from services.cli_graph import CLIGraph
from services.input_file_name import file_name_param, input_file_name


@pytest.fixture(autouse=True)
def reset_graph_and_uploads(tmp_path, monkeypatch):
    main_module.cli_graph = CLIGraph()
    chat_uploads = tmp_path / "chat-uploads"
    chat_uploads.mkdir()
    monkeypatch.setattr("main.CHAT_UPLOADS_DIR", chat_uploads)
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _wav_bytes() -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(b"\x00\x00" * 800)
    return out.getvalue()


PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
    "ae426082"
)
PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"

SAMPLES = [
    ("quarterly-report-final-version-2026.pdf", PDF, "document-input"),
    ("field-recording-take-3.wav", _wav_bytes(), "audio-input"),
    ("mood.png", PNG, "image-input"),
]


@pytest.mark.parametrize(("name", "data", "node_type"), SAMPLES, ids=[s[2] for s in SAMPLES])
def test_a_created_input_keeps_the_original_name(client, name, data, node_type):
    resp = client.post("/api/uploads", files={"file": (name, data, "application/octet-stream")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["nodeType"] == node_type
    params = main_module.cli_graph.nodes[body["nodeId"]]["params"]
    assert params["_fileName"] == {"file": Path(body["filePath"]).name, "name": name}
    assert input_file_name(params) == name


def test_a_created_video_input_keeps_the_original_name(client, monkeypatch):
    from services.ffmpeg import ProbeResult

    async def probe(_path):
        return ProbeResult(duration=1.0, fps=24.0, is_vfr=False)

    monkeypatch.setattr("main.ffprobe_video", probe)
    resp = client.post("/api/uploads", files={"file": ("launch-cut.mp4", b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00"
                                                       + b"\x00" * 100, "video/mp4")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    params = main_module.cli_graph.nodes[resp.json()["nodeId"]]["params"]
    assert input_file_name(params) == "launch-cut.mp4"


@pytest.mark.parametrize("sent", ["../../etc/report.pdf", "C:\\Users\\me\\report.pdf", "/abs/report.pdf"])
def test_only_the_last_part_of_a_sent_name_is_kept(client, sent):
    resp = client.post("/api/uploads", files={"file": (sent, PDF, "application/pdf")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    params = main_module.cli_graph.nodes[resp.json()["nodeId"]]["params"]
    assert input_file_name(params) == "report.pdf"


def test_agents_read_the_name_in_look_at_canvas(client):
    resp = client.post("/api/uploads", files={"file": ("quarterly-report-final-version-2026.pdf", PDF,
                                                       "application/pdf")},
                       data={"create_node": "true"})
    node_id = resp.json()["nodeId"]
    snapshot = client.get("/api/canvas/snapshot").json()
    entry = next(n for n in snapshot["nodes"] if n["id"] == node_id)
    assert entry["fileName"] == "quarterly-report-final-version-2026.pdf"


def test_a_name_that_no_longer_matches_the_file_is_not_shown(client):
    resp = client.post("/api/uploads", files={"file": ("old-take.wav", _wav_bytes(), "audio/wav")},
                       data={"create_node": "true"})
    node_id = resp.json()["nodeId"]
    # An agent (edit_canvas) or a script points the node at another file
    # and leaves the private param behind.
    main_module.cli_graph.nodes[node_id]["params"]["filePath"] = "/elsewhere/0123abcd.wav"
    params = main_module.cli_graph.nodes[node_id]["params"]
    assert input_file_name(params) is None
    entry = next(n for n in client.get("/api/canvas/snapshot").json()["nodes"] if n["id"] == node_id)
    assert "fileName" not in entry


def test_mcp_upload_file_path_keeps_the_name(client, tmp_path):
    import upload_client
    from nebula_api import NebulaAPI

    song = tmp_path / "interview-raw.wav"
    song.write_bytes(_wav_bytes())
    result = upload_client.upload(NebulaAPI("http://testserver", client=client), str(song))
    params = main_module.cli_graph.nodes[result["nodeId"]]["params"]
    assert input_file_name(params) == "interview-raw.wav"


def test_the_helpers():
    assert file_name_param("/out/chat-uploads/abc.pdf", "a.pdf") == {"file": "abc.pdf", "name": "a.pdf"}
    assert file_name_param("/out/chat-uploads/abc.pdf", "") is None
    assert file_name_param("/out/chat-uploads/abc.pdf", None) is None
    # A node saved before names were kept has none.
    assert input_file_name({"filePath": "/out/chat-uploads/abc.pdf"}) is None
    assert input_file_name({}) is None
    assert input_file_name({"filePath": "/a/b.pdf", "_fileName": "b.pdf"}) is None


def test_nebula_look_prints_the_name():
    from cli.formatter import _node_lines

    lines = _node_lines({"id": "n2", "name": "Document Input", "state": "idle",
                         "position": {"x": 0, "y": 0}, "fileName": "quarterly-report-final-version-2026.pdf",
                         "params": {"filePath": "/out/chat-uploads/abc.pdf"}})
    assert '        file: "quarterly-report-final-version-2026.pdf"' in lines
    assert not any(line.strip().startswith("file:") for line in _node_lines({"id": "n3", "name": "Text"}))
