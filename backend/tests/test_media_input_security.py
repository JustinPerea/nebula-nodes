"""Server-side media reads in the direct maker routes (round 2 security stage).

Every URL the backend fetches for an upload goes through the public fetcher
(public https only, each redirect re-checked), owned outputs resolve to their
files, local reads pass the file policy and a size cap before any byte is
read, and ids or params that land in a provider URL can't change its path.
"""
from __future__ import annotations

import base64
import ipaddress
from pathlib import Path
from unittest.mock import AsyncMock, Mock, PropertyMock, patch

import httpx
import pytest
import respx

from models.graph import GraphNode, PortValueDict
from services import public_url
from services.file_access import ProtectedPathError

PUBLIC = {ipaddress.ip_address("93.184.216.34")}
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24


@pytest.fixture
def dns(monkeypatch):
    table = {
        "media.example.test": PUBLIC,
        "internal.example.test": {ipaddress.ip_address("10.0.0.7")},
        "rebind.example.test": {ipaddress.ip_address("192.168.1.20")},
        "127.1": {ipaddress.ip_address("127.0.0.1")},  # what getaddrinfo makes of it
    }

    async def resolve(hostname, _port):
        return table[hostname]

    monkeypatch.setattr(public_url, "resolve_host", resolve)
    return table


@pytest.fixture
def no_network(monkeypatch):
    """Any request that isn't mocked by respx fails the test."""
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        yield router


def _output_file(name: str, payload: bytes) -> Path:
    from services import output

    path = output.OUTPUT_ROOT / "media-input-security" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


@pytest.fixture
def private_media(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    path = root / "reference.png"
    path.write_bytes(b"synthetic protected media")
    return path


# -- SSRF: the shared Ideogram loader -------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    "https://10.0.0.7/a.png",                 # private IP
    "https://127.1/a.png",                    # short loopback spelling
    "https://0.0.0.0/a.png",
    "https://[::1]/a.png",
    "https://169.254.169.254/latest/meta-data",
    "https://internal.example.test/a.png",    # DNS name that resolves to a private address
    "http://media.example.test/a.png",        # plain http, even to a public host
    "https://127.0.0.1:8000/api/outputs/../settings.json",
])
async def test_ideogram_loader_refuses_non_public_urls_without_a_request(dns, no_network, url):
    from handlers.ideogram import _load_binary

    with pytest.raises((RuntimeError, ValueError)):
        await _load_binary(url)
    assert not no_network.calls


@pytest.mark.asyncio
async def test_ideogram_loader_rechecks_each_redirect_hop(dns, no_network):
    from handlers.ideogram import _load_binary

    no_network.get("https://media.example.test/a.png").respond(302, headers={"location": "https://rebind.example.test/x"})
    internal = no_network.get("https://rebind.example.test/x").respond(200, content=PNG)
    with pytest.raises(RuntimeError, match="will not fetch"):
        await _load_binary("https://media.example.test/a.png")
    assert not internal.called


@pytest.mark.asyncio
async def test_ideogram_loader_fetches_public_https_without_credentials(dns, no_network):
    from handlers.ideogram import _load_binary

    route = no_network.get("https://media.example.test/a.png").respond(
        200, content=PNG, headers={"content-type": "image/png"})
    assert await _load_binary("https://media.example.test/a.png") == (PNG, "image/png")
    sent = route.calls[0].request.headers
    assert "api-key" not in sent and "authorization" not in sent


@pytest.mark.asyncio
async def test_ideogram_loader_caps_remote_local_and_data_inputs(dns, no_network, monkeypatch, tmp_path):
    from handlers import ideogram

    monkeypatch.setattr(ideogram, "MAX_INPUT_IMAGE_BYTES", 10)
    no_network.get("https://media.example.test/big.png").respond(200, content=b"x" * 11)
    with pytest.raises(RuntimeError, match="larger than"):
        await ideogram._load_binary("https://media.example.test/big.png")
    big = tmp_path / "big.png"
    big.write_bytes(b"x" * 11)
    read = Mock(side_effect=AssertionError("an oversized file must not be read"))
    monkeypatch.setattr(Path, "read_bytes", read)
    monkeypatch.setattr(Path, "open", Mock(side_effect=AssertionError("an oversized file must not be opened")))
    with pytest.raises(ValueError, match="larger than"):
        await ideogram._load_binary(str(big))
    monkeypatch.undo()
    monkeypatch.setattr(ideogram, "MAX_INPUT_IMAGE_BYTES", 10)
    with pytest.raises(ValueError, match="larger than"):
        await ideogram._load_binary("data:image/png;base64," + base64.b64encode(b"x" * 30).decode())
    with pytest.raises(ValueError, match="larger than"):
        await ideogram._load_binary("data:image/svg+xml," + "x" * 30)


def test_local_read_is_bounded_even_if_the_file_grows_after_the_check(monkeypatch, tmp_path):
    from services import media_input

    grown = tmp_path / "grown.png"
    grown.write_bytes(b"x" * 50)
    monkeypatch.setattr(media_input, "checked_local_file", lambda value, **_: Path(value))
    with pytest.raises(ValueError, match="larger than"):
        media_input.read_local_media(grown, label="Image", max_bytes=10)


@pytest.mark.asyncio
async def test_ideogram_loader_keeps_owned_outputs_local(no_network):
    from handlers.ideogram import _load_binary
    from services.output import OUTPUT_ROOT

    path = _output_file("owned.png", PNG)
    ref = "/api/outputs/" + path.relative_to(OUTPUT_ROOT).as_posix()
    assert await _load_binary(ref) == (PNG, "image/png")
    assert await _load_binary(f"http://127.0.0.1:8000{ref}") == (PNG, "image/png")
    assert await _load_binary(f"http://localhost:8000{ref}") == (PNG, "image/png")
    assert not no_network.calls


@pytest.mark.asyncio
async def test_krea_ideogram_route_refuses_a_private_param_url_before_ideogram(dns, no_network):
    from execution import maker_routes_ideogram_runway as route

    post = AsyncMock(side_effect=AssertionError("Ideogram must not be called"))
    with patch("handlers.ideogram._post_multipart", post):
        with pytest.raises(RuntimeError, match="will not fetch"):
            await route._ideogram_file("image", "https://internal.example.test/a.png", "Image")
        with pytest.raises(ValueError, match="points at this machine"):
            await route._ideogram_file("image", "https://127.0.0.2/secret", "Image")
    post.assert_not_awaited()
    assert not no_network.calls


# -- local reads: file policy, then a cap, before any byte -----------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("call", [
    lambda v: __import__("handlers.minimax_v2", fromlist=["x"]).media_url(v, "image"),
    lambda v: __import__("handlers.xai_image", fromlist=["x"]).xai_image_url(v),
    lambda v: __import__("execution.maker_routes_byteplus", fromlist=["x"])._reference(v),
    lambda v: __import__("execution.maker_routes_byteplus_seedance", fromlist=["x"])._image(v),
    lambda v: __import__("handlers.openai_image_edit", fromlist=["x"])._resolve_image_bytes(v),
])
async def test_new_local_readers_apply_the_file_policy_before_reading(private_media, monkeypatch, call):
    monkeypatch.setattr(Path, "read_bytes", Mock(side_effect=AssertionError("protected bytes must not be read")))
    monkeypatch.setattr(Path, "open", Mock(side_effect=AssertionError("protected file must not be opened")))
    with pytest.raises(ProtectedPathError):
        call(str(private_media))


def test_minimax_v2_caps_each_kind_and_the_request(monkeypatch, tmp_path):
    from handlers import minimax_v2

    monkeypatch.setattr(minimax_v2, "MAX_FILE_BYTES", {"image": 10, "video": 10, "audio": 10})
    big = tmp_path / "big.png"
    big.write_bytes(b"x" * 11)
    monkeypatch.setattr(Path, "read_bytes", Mock(side_effect=AssertionError("must not be read")))
    with pytest.raises(ValueError, match="larger than"):
        minimax_v2.media_url(str(big), "image")
    monkeypatch.undo()

    monkeypatch.setattr(minimax_v2, "MAX_BODY_BYTES", 40)
    small = tmp_path / "small.png"
    small.write_bytes(b"x" * 9)
    inputs = {"prompt": PortValueDict(type="Text", value="go"),
              "reference_images": PortValueDict(type="Image", value=[str(small), str(small)])}
    with pytest.raises(ValueError, match="request of up to"):
        minimax_v2.build_content(inputs)


def test_minimax_v2_turns_owned_output_urls_into_data_uris():
    from handlers import minimax_v2
    from services.output import OUTPUT_ROOT

    path = _output_file("frame.png", PNG)
    url = "http://127.0.0.1:8000/api/outputs/" + path.relative_to(OUTPUT_ROOT).as_posix()
    assert minimax_v2.media_url(url, "image") == "data:image/png;base64," + base64.b64encode(PNG).decode()


def test_byteplus_readers_cap_images_audio_and_the_request(monkeypatch, tmp_path):
    from execution import maker_routes_byteplus as seedream
    from execution import maker_routes_byteplus_seedance as seedance

    big = tmp_path / "big.png"
    big.write_bytes(b"x" * 11)
    voice = tmp_path / "voice.mp3"
    voice.write_bytes(b"x" * 11)
    monkeypatch.setattr(seedream, "MAX_REFERENCE_BYTES", 10)
    monkeypatch.setattr(seedance, "MAX_IMAGE_BYTES", 10)
    monkeypatch.setattr(seedance, "MAX_AUDIO_BYTES", 10)
    with pytest.raises(ValueError, match="larger than"):
        seedream._reference(str(big))
    with pytest.raises(ValueError, match="larger than"):
        seedance._image(str(big))
    with pytest.raises(ValueError, match="larger than"):
        seedance._audio(str(voice))

    monkeypatch.setattr(seedance, "MAX_IMAGE_BYTES", 100)
    monkeypatch.setattr(seedance, "MAX_BODY_BYTES", 20)
    node = GraphNode(id="n", definitionId="krea-video-bytedance-seedance-2", params={"model": "m"})
    inputs = {"prompt": PortValueDict(type="Text", value="go"),
              "reference_images": PortValueDict(type="Image", value=[str(big)])}
    with pytest.raises(ValueError, match="request of up to"):
        seedance.task_body(node, inputs)


@pytest.mark.parametrize("url", ["https://127.0.0.2/clip.mp4", "https://[::1]/clip.mp4", "http://app.localhost/c.mp4"])
def test_byteplus_refuses_loopback_reference_videos(url):
    from execution.maker_routes_byteplus_seedance import _video

    with pytest.raises(ValueError, match="public URL"):
        _video(url)


def test_xai_video_reader_is_capped(monkeypatch, tmp_path):
    from handlers import xai_image

    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"x" * 11)
    monkeypatch.setattr(xai_image, "MAX_VIDEO_BYTES", 10)
    monkeypatch.setattr(Path, "read_bytes", Mock(side_effect=AssertionError("must not be read")))
    with pytest.raises(ValueError, match="larger than"):
        xai_image.xai_video_url(str(clip))


def test_xai_video_reader_applies_the_file_policy(private_media, monkeypatch):
    from handlers import xai_image

    clip = private_media.with_suffix(".mp4")
    private_media.rename(clip)
    monkeypatch.setattr(Path, "open", Mock(side_effect=AssertionError("protected file must not be opened")))
    with pytest.raises(ProtectedPathError):
        xai_image.xai_video_url(str(clip))


def test_shared_image_readers_are_capped(monkeypatch, tmp_path):
    from services import output
    from services.image_input import load_local_image

    big = tmp_path / "big.png"
    big.write_bytes(b"x" * 11)
    monkeypatch.setattr(Path, "read_bytes", Mock(side_effect=AssertionError("must not be read")))
    monkeypatch.setattr(Path, "open", Mock(side_effect=AssertionError("must not be opened")))
    with pytest.raises(ValueError, match="larger than"):
        load_local_image(str(big), max_bytes=10)
    monkeypatch.undo()
    with pytest.raises(ValueError, match="larger than"):
        output.image_to_data_uri(big, max_bytes=10)


@pytest.mark.asyncio
async def test_openai_reference_data_uri_is_capped(monkeypatch, tmp_path):
    from execution import maker_routes_openai

    monkeypatch.setattr(maker_routes_openai, "MAX_REFERENCE_BYTES", 10)
    with pytest.raises(ValueError, match="larger than"):
        await maker_routes_openai.local_images(
            ["data:image/png;base64," + base64.b64encode(b"x" * 30).decode()], tmp_path)


def test_openai_edit_upload_is_capped(monkeypatch, tmp_path):
    from handlers import openai_image_edit

    big = tmp_path / "big.png"
    big.write_bytes(b"x" * 11)
    monkeypatch.setattr(openai_image_edit, "MAX_IMAGE_BYTES", 10)
    with pytest.raises(ValueError, match="larger than"):
        openai_image_edit._resolve_image_bytes(str(big))


def test_escaping_output_refs_are_refused():
    from services.media_input import owned_output_value

    with pytest.raises(ValueError, match="output reference"):
        owned_output_value("/api/outputs/../../etc/hosts")


# -- URL path and query injection -----------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("voice_id", ["../../music", "a/b", "abc%2F..", "abc?x=1", "voice-1", "a b", "voice_1"])
async def test_elevenlabs_refuses_a_voice_id_that_is_not_one_id(voice_id, tmp_path):
    from handlers import elevenlabs

    network = Mock(side_effect=AssertionError("ElevenLabs must not be called"))
    audio = tmp_path / "in.mp3"
    audio.write_bytes(b"ID3")
    with patch.object(elevenlabs.httpx, "AsyncClient", network):
        with pytest.raises(ValueError, match="voice_id"):
            await elevenlabs.handle_elevenlabs_tts(
                GraphNode(id="t", definitionId="elevenlabs-tts", params={"voice_id": voice_id}),
                {"text": PortValueDict(type="Text", value="hi")}, {"ELEVENLABS_API_KEY": "k"})
        with pytest.raises(ValueError, match="voice_id"):
            await elevenlabs.handle_elevenlabs_sts(
                GraphNode(id="s", definitionId="elevenlabs-sts", params={"voice_id": voice_id}),
                {"audio": PortValueDict(type="Audio", value=str(audio))}, {"ELEVENLABS_API_KEY": "k"})
    network.assert_not_called()


def test_elevenlabs_voice_id_is_quoted_and_output_format_checked():
    from handlers import elevenlabs

    with patch.object(elevenlabs, "quote", wraps=elevenlabs.quote) as quote:
        assert elevenlabs._voice_id(GraphNode(id="t", definitionId="x", params={"voice_id": "JBFqnCBsd6RMkjVDRZzb"})) \
            == "JBFqnCBsd6RMkjVDRZzb"
    assert quote.call_args.kwargs == {"safe": ""}
    assert elevenlabs._with_output_format("https://e/x", "mp3_44100_128") == "https://e/x?output_format=mp3_44100_128"
    for bad in ("mp3&enable_logging=false", "mp3_44100_128#", "../x"):
        with pytest.raises(ValueError, match="output_format"):
            elevenlabs._with_output_format("https://e/x", bad)


@pytest.mark.asyncio
async def test_elevenlabs_dubbing_redirect_elsewhere_drops_the_key(dns, tmp_path, monkeypatch):
    from handlers import elevenlabs

    monkeypatch.setattr(elevenlabs.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(elevenlabs, "get_run_dir", lambda: tmp_path)
    with respx.mock(assert_all_mocked=True) as router:
        router.get("https://api.elevenlabs.io/v1/dubbing/dub%2F1").respond(200, json={"status": "dubbed"})
        router.get("https://api.elevenlabs.io/v1/dubbing/dub%2F1/audio/es").respond(
            302, headers={"location": "https://media.example.test/dub.mp3"})
        cdn = router.get("https://media.example.test/dub.mp3").respond(200, content=b"ID3audio")
        async with httpx.AsyncClient() as client:
            result = await elevenlabs._poll_dubbing(client, "dub/1", "es", "secret-key")
    assert Path(result["audio"]["value"]).read_bytes() == b"ID3audio"
    assert "xi-api-key" not in cdn.calls[0].request.headers


@pytest.mark.asyncio
async def test_poll_runner_escapes_provider_task_ids():
    from execution.async_poll_runner import AsyncPollConfig, poll_until_terminal

    config = AsyncPollConfig(submit_url="https://p.test/submit", poll_url_template="https://p.test/tasks/{task_id}",
                             headers={}, terminal_success={"OK"}, terminal_failure={"FAILED"},
                             status_path="status", task_id_path="id", poll_interval=0, max_polls=1)
    with respx.mock(assert_all_mocked=True) as router:
        route = router.get("https://p.test/tasks/..%2Fadmin%3Fx").respond(200, json={"status": "OK"})
        async with httpx.AsyncClient() as client:
            await poll_until_terminal(client, config, "../admin?x", "n", AsyncMock())
    assert route.called


@pytest.mark.asyncio
async def test_byteplus_and_minimax_task_ids_stay_one_segment(monkeypatch):
    from handlers import byteplus

    request = AsyncMock(return_value={})
    monkeypatch.setattr(byteplus, "request", request)
    await byteplus.get_video_task("k", "../../images/generations")
    assert request.call_args.args[1].endswith("/tasks/..%2F..%2Fimages%2Fgenerations")


# -- downloads stream to disk ---------------------------------------------------

@pytest.mark.asyncio
async def test_video_downloads_stream_to_disk_and_leave_no_partial_file(tmp_path, monkeypatch):
    from services import output

    monkeypatch.setattr(output, "_validate_and_correct_extension", AsyncMock(side_effect=lambda p: p))
    with respx.mock(assert_all_mocked=True) as router:
        router.get("https://cdn.example.test/v.mp4").respond(200, content=b"v" * 200_000)
        with patch.object(httpx.Response, "content", new_callable=PropertyMock,
                          side_effect=AssertionError("the whole body must not be buffered")):
            saved = await output.save_video_from_url("https://cdn.example.test/v.mp4", tmp_path)
        assert saved.read_bytes() == b"v" * 200_000
        router.get("https://cdn.example.test/broken.mp4").respond(500)
        with pytest.raises(httpx.HTTPStatusError):
            await output.save_video_from_url("https://cdn.example.test/broken.mp4", tmp_path)
        router.get("https://cdn.example.test/cut.mp4").mock(
            return_value=httpx.Response(200, stream=_CutStream()))
        with pytest.raises(httpx.ReadError):
            await output.save_video_from_url("https://cdn.example.test/cut.mp4", tmp_path)
    assert [p.name for p in tmp_path.iterdir()] == [saved.name]


class _CutStream(httpx.AsyncByteStream):
    """A body that drops after the first chunk."""

    async def __aiter__(self):
        yield b"v" * 1000
        raise httpx.ReadError("connection dropped")


@pytest.mark.asyncio
async def test_google_local_readers_are_capped(monkeypatch, tmp_path):
    from handlers import gemini_omni, veo

    big = tmp_path / "big.png"
    big.write_bytes(b"x" * 11)
    monkeypatch.setattr(gemini_omni, "MAX_INPUT_BYTES", 10)
    monkeypatch.setattr(veo, "MAX_FRAME_BYTES", 10)
    with pytest.raises(ValueError, match="larger than"):
        await gemini_omni._load_bytes(str(big))
    with pytest.raises(ValueError, match="larger than"):
        await veo._image_to_veo_payload(str(big))
