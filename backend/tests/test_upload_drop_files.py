"""Dropping files on the canvas (fix/canvas-drop-files, 2026-10-24).

POST /api/uploads takes audio too (an Audio Input holds it), checked by its
bytes like images, clips and PDFs, and puts a created node where the caller
asks (the canvas sends the drop point). A caller that names no spot keeps
today's placement. MCP `upload_file` and `nebula upload` pass a spot through.
"""
from __future__ import annotations

import io
import math
import os
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


# An image's size as shown goes with its preview (services/preview_size.py,
# #226 round 3): the Inspector's preview has its height before it decodes.
def _image_bytes(fmt: str, size: tuple[int, int], orientation: int | None = None) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    image = Image.new("RGB", size, (40, 80, 120))
    if orientation is None:
        image.save(out, fmt)
    else:
        exif = Image.Exif()
        exif[0x0112] = orientation
        image.save(out, fmt, exif=exif.tobytes())
    return out.getvalue()


def test_an_image_upload_returns_its_size_and_its_node_keeps_it(client):
    resp = client.post("/api/uploads", files={"file": ("wide.png", _image_bytes("PNG", (640, 360)), "image/png")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["previewSize"] == {"width": 640, "height": 360}
    node = main_module.cli_graph.nodes[body["nodeId"]]
    assert node["params"]["_previewSize"] == {"width": 640, "height": 360}
    # Without a node (the Inspector's own upload) the response still says it.
    plain = client.post("/api/uploads", files={"file": ("tall.png", _image_bytes("PNG", (300, 500)), "image/png")})
    assert plain.status_code == 200, plain.text
    assert plain.json()["previewSize"] == {"width": 300, "height": 500}


@pytest.mark.parametrize(("orientation", "shown"), [(1, (400, 200)), (3, (400, 200)), (6, (200, 400)), (8, (200, 400))])
def test_an_image_turned_by_its_exif_reports_the_size_it_is_shown_at(client, orientation, shown):
    data = _image_bytes("JPEG", (400, 200), orientation)
    resp = client.post("/api/uploads", files={"file": ("photo.jpg", data, "image/jpeg")})
    assert resp.status_code == 200, resp.text
    assert resp.json()["previewSize"] == {"width": shown[0], "height": shown[1]}


def test_sound_and_documents_carry_no_preview_size(client):
    sound = client.post("/api/uploads", files={"file": ("tone.wav", _wav_bytes(), "audio/wav")},
                        data={"create_node": "true"})
    assert sound.status_code == 200, sound.text
    assert "previewSize" not in sound.json()
    assert "_previewSize" not in main_module.cli_graph.nodes[sound.json()["nodeId"]]["params"]
    doc = client.post("/api/uploads", files={"file": ("notes.txt", b"plain notes for the doc", "text/plain")})
    assert doc.status_code == 200, doc.text
    assert "previewSize" not in doc.json()


def test_an_image_whose_header_cannot_be_read_still_uploads_without_a_size(client):
    # PNG magic, then nothing Pillow can read: stored as before, no size.
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    resp = client.post("/api/uploads", files={"file": ("broken.png", data, "image/png")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    assert "previewSize" not in resp.json()
    assert "_previewSize" not in main_module.cli_graph.nodes[resp.json()["nodeId"]]["params"]


def test_agents_may_not_write_the_preview_size():
    from services.agent_params import internal_keys

    assert internal_keys({"_previewSize": {"width": 1, "height": 1}}) == ["_previewSize"]


# #226 review 2, MEDIUM-2: the size comes from the header, never the pixels.
# Pillow's getexif() decodes a whole PNG whose EXIF isn't ahead of its pixel
# data (a 13000x13000 PNG of 641 KB grew the process by ~680 MB), so these
# fail if anything calls load().
def _chunk(kind: bytes, data: bytes) -> bytes:
    import struct
    import zlib

    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def _png_header(width: int, height: int, exif: bytes | None = None) -> bytes:
    """A PNG that claims width x height, with an eXIf chunk before its pixel
    data when given, and pixel data that is not even valid (never decoded)."""
    import struct

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    chunks = _chunk(b"IHDR", ihdr)
    if exif is not None:
        chunks += _chunk(b"eXIf", exif)
    return b"\x89PNG\r\n\x1a\n" + chunks + _chunk(b"IDAT", b"\x00" * 32) + _chunk(b"IEND", b"")


def _exif_orientation(orientation: int) -> bytes:
    from PIL import Image

    exif = Image.Exif()
    exif[0x0112] = orientation
    return exif.tobytes()


@pytest.fixture
def no_pixels(monkeypatch):
    """Any pixel decode fails the test."""
    from PIL import ImageFile

    def refuse(self, *args, **kwargs):
        raise AssertionError("preview_size decoded pixels")

    monkeypatch.setattr(ImageFile.ImageFile, "load", refuse)


def test_a_large_png_reports_its_size_without_decoding_it(no_pixels):
    from services.preview_size import preview_size

    assert preview_size(_png_header(9000, 8000)) == {"width": 9000, "height": 8000}
    # Its eXIf chunk (before the pixel data, as browsers read it) turns it.
    assert preview_size(_png_header(9000, 8000, _exif_orientation(6))) == {"width": 8000, "height": 9000}
    assert preview_size(_png_header(9000, 8000, _exif_orientation(3))) == {"width": 9000, "height": 8000}


@pytest.mark.parametrize("orientation", range(1, 9))
def test_a_turned_jpeg_reports_its_shown_size_without_decoding_it(no_pixels, orientation):
    from services.preview_size import preview_size

    data = _image_bytes("JPEG", (400, 200), orientation)
    turned = orientation in (5, 6, 7, 8)
    assert preview_size(data) == ({"width": 200, "height": 400} if turned else {"width": 400, "height": 200})


def test_a_broken_exif_block_leaves_the_size_as_stored(no_pixels):
    from services.preview_size import preview_size

    assert preview_size(_png_header(640, 360, b"MM\x00\x2a\xff\xff\xff\xff garbage")) == {"width": 640, "height": 360}
    assert preview_size(_png_header(640, 360, b"not exif at all")) == {"width": 640, "height": 360}


def test_a_size_past_the_pixel_limit_is_not_reported(no_pixels):
    from PIL import Image

    from services.preview_size import preview_size

    limit = Image.MAX_IMAGE_PIXELS
    assert limit is not None
    # Past twice the limit Image.open refuses it (DecompressionBombError).
    assert preview_size(_png_header(100_000, 100_000)) is None
    # Past the limit but under twice it, Image.open only warns: still no size.
    side = int((limit * 1.5) ** 0.5)
    with pytest.warns(Image.DecompressionBombWarning):
        assert preview_size(_png_header(side, side)) is None
    # At the limit it is reported.
    assert preview_size(_png_header(limit // 10_000, 10_000)) == {"width": limit // 10_000, "height": 10_000}


def test_an_upload_whose_header_claims_a_huge_size_still_uploads(client):
    resp = client.post("/api/uploads", files={"file": ("bomb.png", _png_header(100_000, 100_000), "image/png")},
                       data={"create_node": "true"})
    assert resp.status_code == 200, resp.text
    assert "previewSize" not in resp.json()
    assert "_previewSize" not in main_module.cli_graph.nodes[resp.json()["nodeId"]]["params"]


def test_the_upload_reads_the_size_off_the_event_loop(client, monkeypatch):
    import asyncio

    from services.preview_size import preview_size as real

    calls: list[bool] = []

    def watched(content: bytes):
        try:
            asyncio.get_running_loop()
            calls.append(True)
        except RuntimeError:
            calls.append(False)
        return real(content)

    monkeypatch.setattr(main_module, "preview_size", watched)
    resp = client.post("/api/uploads", files={"file": ("wide.png", _image_bytes("PNG", (640, 360)), "image/png")})
    assert resp.status_code == 200, resp.text
    assert resp.json()["previewSize"] == {"width": 640, "height": 360}
    # Called once, on a worker thread (no event loop running there).
    assert calls == [False]


# #226 review 2, NIT-2: a `_previewSize` goes with its file. An agent or the
# CLI that names another file drops it; the Inspector's own upload sends the
# new one with the file.
AGENT = {"X-Nebula-Agent": "Codex"}


def _uploaded_node(client) -> tuple[str, dict]:
    made = client.post("/api/uploads", files={"file": ("wide.png", _image_bytes("PNG", (640, 360)), "image/png")},
                       data={"create_node": "true"})
    assert made.status_code == 200, made.text
    other = client.post("/api/uploads", files={"file": ("tall.png", _image_bytes("PNG", (300, 500)), "image/png")})
    assert other.status_code == 200, other.text
    node_id = made.json()["nodeId"]
    assert main_module.cli_graph.nodes[node_id]["params"]["_previewSize"] == {"width": 640, "height": 360}
    return node_id, other.json()


def _params(node_id: str) -> dict:
    return main_module.cli_graph.nodes[node_id]["params"]


def test_an_agent_that_sets_another_file_drops_the_old_size(client):
    node_id, other = _uploaded_node(client)
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": other["filePath"]}})
    assert resp.status_code == 200, resp.text
    assert "_previewSize" not in _params(node_id)


def test_the_cli_that_sets_another_file_drops_the_old_size(client):
    node_id, other = _uploaded_node(client)
    resp = client.put(f"/api/graph/node/{node_id}", json={"params": {"filePath": other["filePath"],
                                                                      "_previewUrl": other["url"]}})
    assert resp.status_code == 200, resp.text
    assert "_previewSize" not in _params(node_id)


def test_the_size_stays_when_the_file_does(client):
    node_id, _other = _uploaded_node(client)
    same = _params(node_id)["filePath"]
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": same}})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewSize"] == {"width": 640, "height": 360}
    # A change elsewhere keeps it too.
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"_fileName": "x"}})
    assert _params(node_id)["_previewSize"] == {"width": 640, "height": 360}


def test_the_inspector_upload_keeps_the_size_it_sends(client):
    node_id, other = _uploaded_node(client)
    resp = client.put(f"/api/graph/node/{node_id}", json={"params": {
        "filePath": other["filePath"], "_previewUrl": other["url"], "_previewSize": other["previewSize"]}})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewSize"] == {"width": 300, "height": 500}


def test_the_normalizer_drops_a_size_whose_preview_names_another_file(tmp_path):
    old = "/api/outputs/chat-uploads/" + "a" * 64 + ".png"
    kept = main_module._normalize_image_input_params({"_previewUrl": old, "_previewSize": {"width": 3, "height": 2}})
    assert kept["_previewSize"] == {"width": 3, "height": 2}
    # filePath imported from outside the output root: a new preview, no size.
    outside = tmp_path / "elsewhere.png"
    outside.write_bytes(_image_bytes("PNG", (30, 20)))
    moved = main_module._normalize_image_input_params(
        {"filePath": str(outside), "_previewUrl": old, "_previewSize": {"width": 3, "height": 2}})
    assert moved["_previewUrl"] != old
    assert "_previewSize" not in moved
    # A size with no preview at all goes too.
    assert "_previewSize" not in main_module._normalize_image_input_params({"_previewSize": {"width": 3, "height": 2}})


def test_an_agent_apply_that_sets_another_file_drops_the_old_size(client, monkeypatch):
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda: None)
    # The uploads here sit outside the output root, so the normalizer would
    # import the file and drop the size itself; keep the apply's own rule
    # the one under test.
    monkeypatch.setattr(main_module, "_import_external_image_to_output_root", lambda _path: None)
    node_id, other = _uploaded_node(client)
    resp = client.post("/api/graph/apply", headers=AGENT, json={
        "note": "Swap the picture", "params": [{"nodeId": node_id, "params": {"filePath": other["filePath"]}}]})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["filePath"] == other["filePath"]
    assert "_previewSize" not in _params(node_id)


# #226 review 3, LOW-2: the round 4 rules review 3's mutants showed untested.
def test_the_cli_that_sets_only_another_preview_drops_the_old_size(client, tmp_path, monkeypatch):
    # Under the output root, so the canvas sync's normalizer leaves the
    # preview as sent (it imports a file from outside and names its own).
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    node_id, other = _uploaded_node(client)
    resp = client.put(f"/api/graph/node/{node_id}", json={"params": {"_previewUrl": other["url"]}})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewUrl"] == other["url"]
    assert "_previewSize" not in _params(node_id)


def test_the_dropped_size_stays_dropped_after_a_restart(client, tmp_path, monkeypatch):
    # Under the output root, so the canvas sync's normalizer changes nothing
    # and saves nothing after the PUT: the save under test is the PUT's own.
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    saved = tmp_path / "graph.json"
    main_module.cli_graph = CLIGraph(persist_path=saved)
    node_id, other = _uploaded_node(client)
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": other["filePath"]}})
    assert resp.status_code == 200, resp.text
    # What the next launch loads.
    reloaded = CLIGraph()
    reloaded.load(saved)
    assert reloaded.nodes[node_id]["params"]["filePath"] == other["filePath"]
    assert "_previewSize" not in reloaded.nodes[node_id]["params"]


def test_the_normalizer_keeps_the_size_when_an_old_root_names_the_same_file(tmp_path, monkeypatch):
    root = tmp_path / "output"
    (root / "chat-uploads").mkdir(parents=True)
    name = "b" * 64 + ".png"
    (root / "chat-uploads" / name).write_bytes(_image_bytes("PNG", (30, 20)))
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", root)
    size = {"width": 30, "height": 20}
    # The served URL, the file under the current root, and the same file under
    # a root the outputs were moved from: each is rewritten to the served URL
    # and names the same file, so the size stays.
    for preview in (f"/api/outputs/chat-uploads/{name}", str(root / "chat-uploads" / name),
                    f"/Users/old/nebula/output/chat-uploads/{name}"):
        kept = main_module._normalize_image_input_params({"_previewUrl": preview, "_previewSize": size})
        assert kept["_previewUrl"] == f"/api/outputs/chat-uploads/{name}", preview
        assert kept["_previewSize"] == size, preview


# #226 review 3, NIT-2: the preview follows the file. An agent that names
# another file gets that file's preview, not the old one's.
def test_an_agent_that_sets_another_file_gets_its_preview(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    node_id, other = _uploaded_node(client)
    assert _params(node_id)["_previewUrl"] != other["url"]
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": other["filePath"]}})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewUrl"] == other["url"]
    assert resp.json()["params"]["_previewUrl"] == other["url"]
    assert "_previewSize" not in _params(node_id)


def test_an_agent_apply_that_sets_another_file_gets_its_preview(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda: None)
    node_id, other = _uploaded_node(client)
    resp = client.post("/api/graph/apply", headers=AGENT, json={
        "note": "Swap the picture", "params": [{"nodeId": node_id, "params": {"filePath": other["filePath"]}}]})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewUrl"] == other["url"]


def test_a_file_with_no_served_url_leaves_no_stale_preview(client, monkeypatch):
    # The uploads here sit outside the output root, and the import that would
    # give them a served URL fails: the old file's preview goes, not shown
    # for the new one.
    monkeypatch.setattr(main_module, "_import_external_image_to_output_root", lambda _path: None)
    node_id, other = _uploaded_node(client)
    assert main_module._output_url_from_ref(other["filePath"]) is None
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": other["filePath"]}})
    assert resp.status_code == 200, resp.text
    assert "_previewUrl" not in _params(node_id)
    # Clearing the file clears the preview too.
    node_id, _other = _uploaded_node(client)
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": ""}})
    assert resp.status_code == 200, resp.text
    assert "_previewUrl" not in _params(node_id)


def test_the_preview_and_size_stay_when_the_file_does_or_the_url_is_sent(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    node_id, other = _uploaded_node(client)
    before = dict(_params(node_id))
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": before["filePath"]}})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewUrl"] == before["_previewUrl"]
    assert _params(node_id)["_previewSize"] == before["_previewSize"]
    # The Inspector's own upload names its preview: that one is kept as sent.
    sent = "http://127.0.0.1:8000" + other["url"]
    resp = client.put(f"/api/graph/node/{node_id}", json={"params": {
        "filePath": other["filePath"], "_previewUrl": sent, "_previewSize": other["previewSize"]}})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewUrl"] == sent


# #226 review 4, LOW-1: the preview follows the file, not its name. Two files
# with one name in different folders (a node's `{id}_final.png` in two run
# folders, `~/a/photo.png` and `~/b/photo.png`) are different files.
def _image_input_at(client, path) -> str:
    made = client.post("/api/graph/node", json={"definitionId": "image-input", "params": {"filePath": str(path)}})
    assert made.status_code == 200, made.text
    return made.json().get("id") or made.json()["nodeId"]


def test_an_agent_that_sets_a_same_named_file_in_another_run_gets_its_preview(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    for run, size in (("run1", (640, 360)), ("run2", (300, 500))):
        (tmp_path / run).mkdir()
        (tmp_path / run / "n1_final.png").write_bytes(_image_bytes("PNG", size))
    node_id = _image_input_at(client, tmp_path / "run1" / "n1_final.png")
    _params(node_id)["_previewSize"] = {"width": 640, "height": 360}
    assert _params(node_id)["_previewUrl"] == "/api/outputs/run1/n1_final.png"
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT,
                      json={"params": {"filePath": str(tmp_path / "run2" / "n1_final.png")}})
    assert resp.status_code == 200, resp.text
    assert _params(node_id)["_previewUrl"] == "/api/outputs/run2/n1_final.png"
    assert "_previewSize" not in _params(node_id)


def test_a_same_named_file_outside_the_root_is_another_file(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "photo.png").write_bytes(_image_bytes("PNG", (30, 20)))
    (b / "photo.png").write_bytes(_image_bytes("PNG", (20, 30)))
    assert not main_module._same_ref_file(str(a / "photo.png"), str(b / "photo.png"))
    # The same file, however it is spelled, is the same file.
    assert main_module._same_ref_file(str(a / "photo.png"), str(a / "." / "photo.png"))


def test_a_same_named_preview_url_in_another_run_drops_the_old_size(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    for run in ("run1", "run2"):
        (tmp_path / run).mkdir()
        (tmp_path / run / "n1_final.png").write_bytes(_image_bytes("PNG", (30, 20)))
    node_id = _image_input_at(client, tmp_path / "run1" / "n1_final.png")
    _params(node_id)["_previewSize"] = {"width": 30, "height": 20}
    resp = client.put(f"/api/graph/node/{node_id}", json={"params": {"_previewUrl": "/api/outputs/run2/n1_final.png"}})
    assert resp.status_code == 200, resp.text
    assert "_previewSize" not in _params(node_id)


def test_the_same_file_spelled_another_way_keeps_its_preview_and_size(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    (tmp_path / "run1").mkdir()
    (tmp_path / "run1" / "n1_final.png").write_bytes(_image_bytes("PNG", (30, 20)))
    node_id = _image_input_at(client, tmp_path / "run1" / "n1_final.png")
    _params(node_id)["_previewSize"] = {"width": 30, "height": 20}
    before = dict(_params(node_id))
    # Its served URL, and its path through a `..`: the same file.
    for same in ("/api/outputs/run1/n1_final.png", str(tmp_path / "run1" / ".." / "run1" / "n1_final.png")):
        resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"filePath": same}})
        assert resp.status_code == 200, resp.text
        assert _params(node_id)["_previewUrl"] == before["_previewUrl"], same
        assert _params(node_id)["_previewSize"] == before["_previewSize"], same


def test_an_old_root_that_no_longer_resolves_falls_back_to_the_name():
    gone = "/Users/old/nebula/output/run1/n1_final.png"
    assert main_module._ref_identity(gone) is None
    assert main_module._same_ref_file(gone, "/elsewhere/output/run1/n1_final.png")
    assert not main_module._same_ref_file(gone, "/elsewhere/output/run1/other.png")


# #226 review 5, LOW-1 (B3): an outside http(s) URL names its own file, so two
# of them with one basename are two files (never read as one by name).
def test_two_outside_urls_with_one_basename_are_two_files():
    assert not main_module._same_ref_file("https://a.example.com/x/photo.png", "https://b.example.com/y/photo.png")
    assert not main_module._same_ref_file("https://a.example.com/x/photo.png", "https://a.example.com/x/other.png")
    # The same path on another host is another file.
    assert not main_module._same_ref_file("https://a.example.com/x/photo.png", "https://b.example.com/x/photo.png")
    assert main_module._same_ref_file("https://a.example.com/x/photo.png", "https://a.example.com/x/photo.png")


def test_a_deleted_local_file_is_not_an_outside_url_with_the_same_path(tmp_path):
    gone = tmp_path / "gone" / "photo.png"
    url = f"https://cdn.example.com{gone.as_posix()}"
    assert main_module._ref_identity(str(gone)) is None
    assert not main_module._same_ref_file(str(gone), url)
    assert main_module._unresolved_ref_key(url) == ("url", url)
    # Nor is an outside URL whose path has an "output" folder one of Nebula's outputs.
    assert main_module._unresolved_ref_key("https://cdn.example.com/output/run1/n1.png")[0] == "url"


# #226 review 5, NIT-3: the corners of the same-file rule.
def test_a_deleted_outside_file_is_not_another_file_of_the_same_name(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (b / "photo.png").write_bytes(_image_bytes("PNG", (20, 30)))
    # a/photo.png is gone: what is left of it is its path, not its name.
    assert not main_module._same_ref_file(str(a / "photo.png"), str(b / "photo.png"))
    # Both gone: still two paths. The same gone path, spelled another way, is one.
    (b / "photo.png").unlink()
    assert not main_module._same_ref_file(str(a / "photo.png"), str(b / "photo.png"))
    assert main_module._same_ref_file(str(a / "photo.png"), str(a / "." / "photo.png"))
    assert main_module._same_ref_file(str(a / "photo.png"), str(a / "x" / ".." / "photo.png"))


def test_one_file_under_two_names_is_one_file_as_samefile_reads_it(tmp_path):
    # A hard link has another name and the same file; a symlink's target path
    # resolves to it already. Neither reads as two files.
    (tmp_path / "out").mkdir()
    first = tmp_path / "first.png"
    first.write_bytes(_image_bytes("PNG", (30, 20)))
    os.link(first, tmp_path / "second.png")
    assert main_module._same_ref_file(str(first), str(tmp_path / "second.png"))
    other = tmp_path / "third.png"
    other.write_bytes(_image_bytes("PNG", (30, 20)))
    assert not main_module._same_ref_file(str(first), str(other))


def test_a_differently_cased_spelling_of_one_file_is_one_file_on_a_case_insensitive_disk(tmp_path):
    (tmp_path / "Photo.png").write_bytes(_image_bytes("PNG", (30, 20)))
    if not (tmp_path / "photo.png").exists():
        pytest.skip("a case-sensitive filesystem: the two spellings name two files")
    assert main_module._same_ref_file(str(tmp_path / "Photo.png"), str(tmp_path / "photo.png"))


def test_a_case_spelling_of_a_file_in_the_output_root_is_the_same_file(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    (tmp_path / "run1").mkdir()
    (tmp_path / "run1" / "N1_final.png").write_bytes(_image_bytes("PNG", (30, 20)))
    if not (tmp_path / "run1" / "n1_final.png").exists():
        pytest.skip("a case-sensitive filesystem")
    assert main_module._same_ref_file("/api/outputs/run1/N1_final.png", str(tmp_path / "run1" / "n1_final.png"))
    assert main_module._same_ref_file(str(tmp_path / "run1" / "N1_final.png"), str(tmp_path / "RUN1" / "n1_final.png"))


# #226 review 4, NIT-2: only an Image Input's preview follows its file. An
# Audio or Document Input's filePath write leaves its params as sent (a
# `_previewUrl` there would be read by the mask source's fallback).
@pytest.mark.parametrize("kind, ext", [("audio-input", "mp3"), ("document-input", "pdf")])
def test_another_input_kind_gets_no_preview_from_its_file(client, tmp_path, monkeypatch, kind, ext):
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)
    for name in ("one", "two"):
        (tmp_path / f"{name}.{ext}").write_bytes(b"x" * 16)
    made = client.post("/api/graph/node", json={"definitionId": kind, "params": {"filePath": str(tmp_path / f"one.{ext}")}})
    assert made.status_code == 200, made.text
    node_id = made.json().get("id") or made.json()["nodeId"]
    _params(node_id)["_previewSize"] = {"width": 1, "height": 1}
    resp = client.put(f"/api/graph/node/{node_id}", headers=AGENT,
                      json={"params": {"filePath": str(tmp_path / f"two.{ext}")}})
    assert resp.status_code == 200, resp.text
    params = _params(node_id)
    assert params["filePath"] == str(tmp_path / f"two.{ext}")
    assert "_previewUrl" not in params
    assert params["_previewSize"] == {"width": 1, "height": 1}
