"""Dropping files on the canvas (fix/canvas-drop-files, 2026-10-24).

POST /api/uploads takes audio too (an Audio Input holds it), checked by its
bytes like images, clips and PDFs, and puts a created node where the caller
asks (the canvas sends the drop point). A caller that names no spot keeps
today's placement. MCP `upload_file` and `nebula upload` pass a spot through.
"""
from __future__ import annotations

import io
import math
import wave

import pytest
from fastapi.testclient import TestClient

import main as main_module
from main import app
from services.cli_graph import CLIGraph


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


def _png_bytes() -> bytes:
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )


AUDIO_SAMPLES = [
    ("tone.wav", _wav_bytes(), ".wav"),
    ("tagged.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 200, ".mp3"),
    ("bare.mp3", b"\xff\xfb\x90\x64" + b"\x00" * 200, ".mp3"),
    ("voice.m4a", b"\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00" + b"\x00" * 200, ".m4a"),
    ("raw.aac", b"\xff\xf1\x50\x80" + b"\x00" * 200, ".aac"),
    ("lossless.flac", b"fLaC\x00\x00\x00\x22" + b"\x00" * 200, ".flac"),
    ("vorbis.ogg", b"OggS\x00\x02" + b"\x00" * 200, ".ogg"),
]


@pytest.mark.parametrize(("name", "data", "ext"), AUDIO_SAMPLES, ids=[s[0] for s in AUDIO_SAMPLES])
def test_audio_upload_makes_an_audio_input(client, name, data, ext):
    resp = client.post("/api/uploads", files={"file": (name, data, "application/octet-stream")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["nodeType"] == "audio-input"
    assert body["url"].endswith(ext)
    node = main_module.cli_graph.nodes[body["nodeId"]]
    assert node["definitionId"] == "audio-input"
    saved = main_module.CHAT_UPLOADS_DIR / body["url"].split("/")[-1]
    # The shape the engine reads (execution/engine.py: params["filePath"]).
    assert node["params"]["filePath"] == str(saved.resolve())
    # The Inspector's own upload control fills the same two params.
    assert node["params"]["_previewUrl"] == body["url"]
    assert saved.read_bytes() == data
    assert "thumbUrl" not in body


def test_audio_upload_without_create_node_only_stores_it(client):
    resp = client.post("/api/uploads", files={"file": ("tone.wav", _wav_bytes(), "audio/wav")})
    assert resp.status_code == 200
    assert resp.json()["nodeType"] == "audio-input"
    assert "nodeId" not in resp.json()
    assert not main_module.cli_graph.nodes


@pytest.mark.parametrize("name", ["fake.mp3", "fake.wav", "fake.m4a", "fake.flac", "fake.ogg"])
def test_a_file_named_like_audio_without_audio_bytes_is_refused(client, name):
    resp = client.post("/api/uploads", files={"file": (name, b"this is not really audio at all", "audio/mpeg")},
                       data={"create_node": "true"})
    assert resp.status_code == 415
    assert "audio" in resp.json()["detail"]
    assert not list(main_module.CHAT_UPLOADS_DIR.iterdir())
    assert not main_module.cli_graph.nodes


def test_riff_that_is_not_wave_or_webp_is_refused(client):
    resp = client.post("/api/uploads", files={"file": ("x.avi", b"RIFF\x10\x00\x00\x00AVI LIST" + b"\x00" * 40,
                                                       "video/x-msvideo")})
    assert resp.status_code == 415


def test_an_mp4_clip_still_makes_a_video_input(client, monkeypatch):
    from services.ffmpeg import ProbeResult

    async def probe(_path):
        return ProbeResult(duration=1.0, fps=24.0, is_vfr=False)

    monkeypatch.setattr("main.ffprobe_video", probe)
    resp = client.post("/api/uploads", files={"file": ("clip.mp4", b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00"
                                                       + b"\x00" * 100, "video/mp4")},
                       data={"create_node": "true"})
    assert resp.status_code == 200
    assert resp.json()["nodeType"] == "video-input"


def test_a_jpeg_is_not_mistaken_for_mp3(client):
    jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 64
    resp = client.post("/api/uploads", files={"file": ("p.jpg", jpeg, "image/jpeg")})
    assert resp.status_code == 200
    assert resp.json()["nodeType"] == "image-input"


# -- where a created node goes ---------------------------------------------------

def test_a_named_spot_places_the_node_there_and_export_keeps_it(client):
    resp = client.post("/api/uploads", files={"file": ("a.png", _png_bytes(), "image/png")},
                       data={"create_node": "true", "x": "412.5", "y": "-80"})
    assert resp.status_code == 200, resp.text
    node_id = resp.json()["nodeId"]
    assert main_module.cli_graph.nodes[node_id]["position"] == {"x": 412.5, "y": -80.0}
    exported = client.get("/api/graph/export").json()
    drawn = next(n for n in exported["nodes"] if n["id"] == node_id)
    assert drawn["position"] == {"x": 412.5, "y": -80.0}


def test_without_a_spot_the_node_goes_right_of_the_others_as_before(client):
    main_module.cli_graph.add_node("text-input", {"value": "x"}, position={"x": 900.0, "y": 40.0})
    resp = client.post("/api/uploads", files={"file": ("a.png", _png_bytes(), "image/png")},
                       data={"create_node": "true"})
    assert resp.status_code == 200
    assert main_module.cli_graph.nodes[resp.json()["nodeId"]]["position"] == {"x": 1200.0, "y": 100.0}


@pytest.mark.parametrize("spot", [{"x": "10"}, {"y": "10"}, {"x": "nan", "y": "1"}, {"x": "1", "y": "inf"},
                                  {"x": "left", "y": "1"}])
def test_a_bad_spot_is_refused_before_anything_is_stored(client, spot):
    resp = client.post("/api/uploads", files={"file": ("a.png", _png_bytes(), "image/png")},
                       data={"create_node": "true", **spot})
    assert resp.status_code == 422
    assert not list(main_module.CHAT_UPLOADS_DIR.iterdir())
    assert not main_module.cli_graph.nodes


# -- agents: upload_client, MCP upload_file and `nebula upload` ---------------------

def _api_for(client):
    from nebula_api import NebulaAPI

    return NebulaAPI("http://testserver", client=client)


def test_upload_client_adds_audio_at_a_spot(client, tmp_path):
    import upload_client

    song = tmp_path / "song.wav"
    song.write_bytes(_wav_bytes())
    result = upload_client.upload(_api_for(client), str(song), position={"x": 50, "y": 60})
    assert result["kind"] == "Audio"
    node = main_module.cli_graph.nodes[result["nodeId"]]
    assert node["definitionId"] == "audio-input"
    assert node["position"] == {"x": 50.0, "y": 60.0}


def test_upload_client_refuses_a_bad_spot_before_sending(client, tmp_path):
    import upload_client

    song = tmp_path / "song.wav"
    song.write_bytes(_wav_bytes())
    for bad in ({"x": 1}, {"x": math.nan, "y": 0}, {"x": "a", "y": 2}, [1, 2]):
        with pytest.raises(upload_client.UploadError, match="position"):
            upload_client.upload(_api_for(client), str(song), position=bad)  # type: ignore[arg-type]
    assert not main_module.cli_graph.nodes


def test_mcp_upload_file_takes_an_optional_position(monkeypatch):
    import mcp_server
    import upload_client

    params = mcp_server.mcp._tool_manager.get_tool("upload_file").parameters
    assert "position" in params["properties"] and params.get("required") == ["path"]
    seen = {}

    def fake_upload(api, source, headers=None, position=None):
        seen.update(source=source, position=position)
        return {"nodeId": "n3", "kind": "Audio"}

    monkeypatch.setattr(upload_client, "upload", fake_upload)
    monkeypatch.setattr(mcp_server, "_api", lambda: object())
    monkeypatch.setattr(mcp_server, "_board_headers", lambda ctx: {})
    assert mcp_server.upload_file("song.wav", position={"x": 10, "y": 20})["kind"] == "Audio"
    assert seen == {"source": "song.wav", "position": {"x": 10, "y": 20}}
    mcp_server.upload_file("song.wav")
    assert seen["position"] is None


def test_mcp_upload_file_docs_name_audio():
    import mcp_server

    doc = mcp_server.upload_file.__doc__ or ""
    assert "Audio Input" in doc and "WAV" in doc and "position" in doc


def test_nebula_upload_takes_at_and_names_the_audio_port(monkeypatch, capsys):
    import upload_client
    from cli.__main__ import build_parser
    from cli.commands import upload as upload_command

    args = build_parser().parse_args(["upload", "song.wav", "--at", "120,-40"])
    assert args.file == "song.wav" and args.at == "120,-40"
    seen = {}

    def fake_upload(api, source, headers=None, position=None):
        seen["position"] = position
        return {"kind": "Audio", "nodeId": "n9", "filename": "song.wav", "url": "/api/outputs/chat-uploads/s.wav"}

    monkeypatch.setattr(upload_client, "upload", fake_upload)

    class FakeClient:
        api = object()

        def _identity_headers(self):
            return {}

    upload_command.run(FakeClient(), "song.wav", at="120,-40")
    assert seen["position"] == {"x": 120.0, "y": -40.0}
    out = capsys.readouterr().out
    assert "Audio Input n9" in out and "nebula connect n9:audio <node>:<port>" in out


def test_nebula_upload_refuses_a_bad_at(monkeypatch, capsys):
    from cli.commands import upload as upload_command

    class FakeClient:
        api = object()

        def _identity_headers(self):
            return {}

    with pytest.raises(SystemExit):
        upload_command.run(FakeClient(), "song.wav", at="here")
    assert "--at" in capsys.readouterr().err


def test_docs_list_audio_for_uploads():
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    for doc in ("docs/MCP-SETUP.md", "skills/nebula/SKILL.md"):
        text = (root / doc).read_text()
        assert "Audio Input" in text, doc
        assert "--at" in text or "position" in text, doc


# -- Review fixes (2026-10-24) ------------------------------------------------

def _box(kind: bytes, body: bytes) -> bytes:
    return (8 + len(body)).to_bytes(4, "big") + kind + body


def _hdlr(handler: bytes) -> bytes:
    # version/flags(4) pre_defined(4) handler_type(4) reserved(12) name
    return _box(b"hdlr", b"\x00" * 8 + handler + b"\x00" * 12 + b"h\x00")


def _iso_file(*handlers: bytes, brand: bytes = b"isom", moov_last: bool = False) -> bytes:
    ftyp = _box(b"ftyp", brand + b"\x00\x00\x02\x00" + b"isomiso2mp41")
    moov = _box(b"moov", b"".join(_box(b"trak", _box(b"mdia", _hdlr(h))) for h in handlers))
    mdat = _box(b"mdat", b"\x00" * 256)
    return ftyp + (mdat + moov if moov_last else moov + mdat)


@pytest.mark.parametrize("moov_last", [False, True], ids=["faststart", "moov-at-end"])
@pytest.mark.parametrize("brand", [b"isom", b"mp42"])
def test_an_audio_only_iso_file_without_an_m4a_brand_makes_an_audio_input(client, brand, moov_last):
    data = _iso_file(b"soun", brand=brand, moov_last=moov_last)
    resp = client.post("/api/uploads", files={"file": ("voice.m4a", data, "audio/mp4")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["nodeType"] == "audio-input"
    assert body["url"].endswith(".m4a")


def test_an_iso_file_with_a_video_track_and_sound_stays_a_video_input(client, monkeypatch):
    from services.ffmpeg import ProbeResult

    async def probe(_path):
        return ProbeResult(duration=1.0, fps=24.0, is_vfr=False)

    monkeypatch.setattr("main.ffprobe_video", probe)
    resp = client.post("/api/uploads", files={"file": ("clip.mp4", _iso_file(b"vide", b"soun"), "video/mp4")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["nodeType"] == "video-input"


TEXT_THAT_LOOKS_LIKE_AUDIO = [
    ("utf16.txt", "hello notes\n".encode("utf-16"), ".txt"),
    ("bom.csv", b"\xff\xfeH\x00i\x00\n\x00" * 4, ".csv"),
    ("notes.md", b"ID3 notes about the tag format\n", ".md"),
]


@pytest.mark.parametrize(("name", "data", "ext"), TEXT_THAT_LOOKS_LIKE_AUDIO,
                         ids=[s[0] for s in TEXT_THAT_LOOKS_LIKE_AUDIO])
def test_a_text_file_that_starts_like_audio_stays_a_document_input(client, name, data, ext):
    resp = client.post("/api/uploads", files={"file": (name, data, "text/plain")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["nodeType"] == "document-input"
    assert body["url"].endswith(ext)


@pytest.mark.parametrize("argv_at", [["--at", "-200,140"], ["--at=-200,140"], ["--at", "-0.5,-3"]])
def test_nebula_upload_at_takes_a_negative_x(argv_at):
    from cli.__main__ import build_parser

    args = build_parser().parse_args(["upload", "voice.wav", *argv_at])
    assert args.command == "upload" and args.file == "voice.wav"
    assert args.at == argv_at[-1].removeprefix("--at=")
