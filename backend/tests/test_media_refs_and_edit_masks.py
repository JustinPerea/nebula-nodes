"""Nebula's own media refs reach every handler as files, and edit masks go
out in the shape each provider reads.

- services.output.local_media_ref and the engine's _local_media_inputs map
  /api/outputs refs (and loopback URLs to them) to paths under OUTPUT_ROOT.
- services.edit_masks converts white-on-black masks for OpenAI (transparent
  = edit) and resizes them for FLUX Fill (white = fill).
- End to end: a real Jev Box mask wired into FLUX Fill and GPT Image 2.5
  Edit sends the right bytes. TypeSafe, fal and OpenAI are all mocked.
"""
from __future__ import annotations

import base64
import email
import io
import json
from pathlib import Path

import httpx
import pytest
import respx
from PIL import Image

import execution.engine as engine
from execution.engine import _local_media_inputs, execute_graph
from execution.sync_runner import get_handler_registry
from models.graph import GraphEdge, GraphNode, PortValueDict
from services import typesafe_client as ts
from services.edit_masks import fit_mask, has_transparency, openai_edit_mask
from services.file_access import ProtectedPathError
from services.output import OUTPUT_ROOT, local_media_ref

OPENAI_SSE = (Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "handlers" / "openai"
              / "gpt-image-2-edit-sse.txt")
KEYS = {"TYPESAFE_API_KEY": "ts-test-key", "FAL_KEY": "fal-test-key", "OPENAI_API_KEY": "oa-test-key"}


def _png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _output_file(name: str, image: Image.Image) -> tuple[Path, str]:
    path = OUTPUT_ROOT / "media-refs" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")
    return path, f"/api/outputs/media-refs/{name}"


def _white_on_black(size: tuple[int, int], rect: tuple[int, int, int, int]) -> Image.Image:
    mask = Image.new("L", size, 0)
    mask.paste(255, rect)
    return mask


# -- local_media_ref -------------------------------------------------------------


def test_output_refs_and_loopback_urls_become_paths():
    path, ref = _output_file("ref.png", Image.new("RGB", (8, 8)))
    expected = str(path.resolve())
    assert local_media_ref(ref) == expected
    assert local_media_ref(f"http://127.0.0.1:8000{ref}") == expected
    assert local_media_ref(f"http://localhost:5173{ref}?v=2#x") == expected
    assert local_media_ref(f"http://[::1]:8000{ref}") == expected


@pytest.mark.parametrize("value", [
    "/tmp/elsewhere.png", "https://example.com/api/outputs/x.png", "data:image/png;base64,AAAA",
    "a red mug", "",
])
def test_everything_else_passes_through(value):
    assert local_media_ref(value) == value


def test_an_escaping_ref_is_refused():
    with pytest.raises(ValueError, match="escapes Nebula's output directory"):
        local_media_ref("/api/outputs/../../etc/passwd")


def test_the_engine_maps_media_ports_but_never_text():
    path, ref = _output_file("port.png", Image.new("RGB", (8, 8)))
    mapped = _local_media_inputs({
        "image": PortValueDict(type="Image", value=ref),
        "mask": PortValueDict(type="Mask", value=f"http://127.0.0.1:8000{ref}"),
        "images": PortValueDict(type="Image", value=[ref, "https://example.com/b.png"]),
        "through": PortValueDict(type="Any", value=ref),
        "prompt": PortValueDict(type="Text", value=ref),
    })
    resolved = str(path.resolve())
    assert mapped["image"].value == resolved and mapped["mask"].value == resolved
    assert mapped["images"].value == [resolved, "https://example.com/b.png"]
    assert mapped["through"].value == resolved
    assert mapped["prompt"].value == ref  # a prompt is never turned into a local path


# -- edit masks ------------------------------------------------------------------


def test_openai_mask_turns_white_into_transparent_and_matches_the_image():
    mask = _png(_white_on_black((100, 50), (10, 10, 40, 30)))
    out = Image.open(io.BytesIO(openai_edit_mask(mask, (200, 100))))
    assert out.format == "PNG" and out.mode == "RGBA" and out.size == (200, 100)
    alpha = out.getchannel("A")
    assert alpha.getpixel((50, 40)) == 0  # inside the white area: edit
    assert alpha.getpixel((5, 5)) == 255 and alpha.getpixel((150, 80)) == 255  # black: keep
    assert set(alpha.getdata()) == {0, 255}  # hard edges, no greys


def test_an_opaque_rgba_mask_is_converted_too():
    mask = _white_on_black((64, 64), (0, 0, 32, 64)).convert("RGBA")
    out = Image.open(io.BytesIO(openai_edit_mask(_png(mask), (64, 64))))
    assert out.getchannel("A").getpixel((10, 10)) == 0 and out.getchannel("A").getpixel((50, 10)) == 255


def test_a_mask_that_already_has_transparency_is_left_alone():
    mask = Image.new("RGBA", (64, 64), (0, 0, 0, 255))
    mask.paste((0, 0, 0, 0), (0, 0, 16, 16))
    data = _png(mask)
    assert has_transparency(mask)
    # Already a PNG with alpha at the image's size: sent byte for byte.
    assert openai_edit_mask(data, (64, 64)) == data


def test_fit_mask_keeps_polarity_and_skips_a_mask_that_fits():
    mask = _png(_white_on_black((100, 50), (50, 0, 100, 50)))
    assert fit_mask(mask, (100, 50)) is None
    fitted = Image.open(io.BytesIO(fit_mask(mask, (200, 100))))
    assert fitted.size == (200, 100) and fitted.mode == "L"
    assert fitted.getpixel((150, 50)) == 255 and fitted.getpixel((20, 50)) == 0


# -- end to end: Box's mask into the edit nodes ----------------------------------


def _box_reply() -> dict:
    return {"model": "jev-1.14.0", "usage": {"input_tokens": 3068, "output_tokens": 36}, "answers": {
        "present": {"type": "noul", "noul": 0.95},
        "where": {"type": "box", "box": {"top": 0.25, "bottom": 0.75, "left": 0.5, "right": 0.9},
                  "confidence": 0.92}}}


def _mock_typesafe(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_box_reply())

    monkeypatch.setattr(ts, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def _keep(outputs, run_dir):  # no download of the mocked provider URL
    return outputs


def _graph(edit_id: str, image_port: str, size: tuple[int, int]):
    scene = Image.new("RGB", size, (128, 128, 128))
    scene.paste((255, 0, 0), (size[0] // 2, size[1] // 4, size[0] * 9 // 10, size[1] * 3 // 4))
    path, ref = _output_file(f"scene-{edit_id}.png", scene)
    nodes = [
        GraphNode(id="img", definitionId="image-input", params={"filePath": ref}),
        GraphNode(id="bx1", definitionId="jev-box", params={"target": "the red square"}),
        GraphNode(id="txt", definitionId="text-input", params={"value": "a blue square"}),
        GraphNode(id="edit", definitionId=edit_id, params={}),
    ]
    wires = [("img", "image", "bx1", "image"), ("img", "image", "edit", image_port),
             ("bx1", "mask", "edit", "mask"), ("txt", "text", "edit", "prompt")]
    edges = [GraphEdge(id=f"{a}.{p}->{b}.{q}", source=a, sourceHandle=p, target=b, targetHandle=q)
             for a, p, b, q in wires]
    return nodes, edges, path


async def _run(nodes, edges):
    events: list = []

    async def emit(event):
        events.append(event)

    await execute_graph(nodes, edges, KEYS, get_handler_registry(emit=emit), emit, run_id="box-into-edit")
    errors = [event for event in events if event.type == "error"]
    assert errors == [], errors
    box = next(event for event in events if event.type == "executed" and event.node_id == "bx1")
    mask_ref = box.outputs["mask"]["value"]
    assert mask_ref.startswith("/api/outputs/")  # Box still emits a ref
    return Image.open(local_media_ref(mask_ref))


def _decode_data_uri(uri: str) -> bytes:
    header, _, payload = uri.partition(",")
    assert header == "data:image/png;base64"
    return base64.b64decode(payload)


@pytest.mark.asyncio
@respx.mock
async def test_box_mask_drives_flux_fill_with_the_right_bytes(monkeypatch):
    _mock_typesafe(monkeypatch)
    monkeypatch.setattr(engine, "_materialize_media_outputs", _keep)
    route = respx.post("https://queue.fal.run/fal-ai/flux-pro/v1/fill").mock(return_value=httpx.Response(
        200, json={"images": [{"url": "https://example.invalid/filled.png"}]}))
    nodes, edges, scene = _graph("flux-fill-inpaint", "image", (640, 480))

    box_mask = await _run(nodes, edges)

    body = json.loads(route.calls.last.request.content)
    assert _decode_data_uri(body["image_url"]) == scene.read_bytes()
    sent = Image.open(io.BytesIO(_decode_data_uri(body["mask_url"])))
    # White = fill, at the image's size, exactly Box's mask.
    assert sent.size == (640, 480)
    assert list(sent.convert("L").getdata()) == list(box_mask.convert("L").getdata())
    assert sent.convert("L").getpixel((500, 240)) == 255 and sent.convert("L").getpixel((50, 50)) == 0


@pytest.mark.asyncio
@respx.mock
async def test_flux_fill_gets_a_mask_resized_to_the_image():
    path, _ = _output_file("small-mask.png", _white_on_black((64, 48), (32, 0, 64, 48)))
    image, _ = _output_file("big-image.png", Image.new("RGB", (640, 480)))
    route = respx.post("https://queue.fal.run/fal-ai/flux-pro/v1/fill").mock(return_value=httpx.Response(
        200, json={"images": [{"url": "https://example.invalid/filled.png"}]}))
    node = GraphNode(id="fill", definitionId="flux-fill-inpaint", params={})
    async def emit(event):
        return None

    await get_handler_registry(emit=emit)["flux-fill-inpaint"](node, {
        "image": PortValueDict(type="Image", value=str(image)),
        "mask": PortValueDict(type="Image", value=str(path)),
        "prompt": PortValueDict(type="Text", value="fill"),
    }, KEYS)
    sent = Image.open(io.BytesIO(_decode_data_uri(json.loads(route.calls.last.request.content)["mask_url"])))
    assert sent.size == (640, 480) and sent.getpixel((600, 240)) == 255 and sent.getpixel((10, 240)) == 0


def _multipart(request: httpx.Request) -> dict[str, list[bytes]]:
    raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
    parts: dict[str, list[bytes]] = {}
    for part in email.message_from_bytes(raw).get_payload():
        name = part.get_param("name", header="content-disposition")
        parts.setdefault(name, []).append(part.get_payload(decode=True))
    return parts


@pytest.mark.asyncio
@respx.mock
async def test_box_mask_drives_gpt_image_25_edit_with_a_transparent_mask(monkeypatch):
    _mock_typesafe(monkeypatch)
    route = respx.post("https://api.openai.com/v1/images/edits").mock(return_value=httpx.Response(
        200, content=OPENAI_SSE.read_bytes(), headers={"content-type": "text/event-stream"}))
    nodes, edges, scene = _graph("gpt-image-2-5-edit", "images", (512, 384))

    box_mask = await _run(nodes, edges)

    parts = _multipart(route.calls.last.request)
    assert parts["image[]"] == [scene.read_bytes()]
    sent = Image.open(io.BytesIO(parts["mask"][0]))
    assert sent.format == "PNG" and sent.mode == "RGBA" and sent.size == (512, 384)
    # Box's white (the target) is fully transparent, so OpenAI edits only there.
    expected = [0 if level >= 128 else 255 for level in box_mask.convert("L").getdata()]
    assert list(sent.getchannel("A").getdata()) == expected
    assert sent.getchannel("A").getpixel((380, 190)) == 0 and sent.getchannel("A").getpixel((20, 20)) == 255


# -- review: resolver edge cases ---------------------------------------------------


@pytest.mark.parametrize("host", [
    "0.0.0.0:8000", "127.0.0.2:8000", "LOCALHOST:5173", "localhost.:8000", "app.localhost:8000",
    "[::ffff:127.0.0.1]:8000", "[::]:8000", "127.1:8000", "2130706433:8000", "user@127.0.0.1:8000",
])
def test_every_loopback_spelling_maps_to_the_file(host):
    path, ref = _output_file("spelling.png", Image.new("RGB", (8, 8)))
    assert local_media_ref(f"http://{host}{ref}") == str(path.resolve())


@pytest.mark.parametrize("host", [
    "10.0.0.5:8000", "192.168.1.2", "example.com", "127.0.0.1.example.com", "localhost.example.com",
    "[2001:db8::1]",
])
def test_other_hosts_are_left_as_urls(host):
    url = f"http://{host}/api/outputs/media-refs/spelling.png"
    assert local_media_ref(url) == url


@pytest.mark.parametrize("ref", [
    "/api/outputs/%2e%2e/%2e%2e/etc/passwd",
    "/api/outputs/media-refs/%2E%2E/%2E%2E/%2E%2E/etc/passwd",
    "/api/outputs/a%2F..%2F..%2Fetc%2Fpasswd",
    "/api/outputs//etc/passwd",
    "/api/outputs/media-refs/./ref.png",
    "/api/outputs/media-refs\\..\\..\\x.png",
    "/api/outputs/media-refs/%00.png",
    "http://127.0.0.1:8000/api/outputs/../../etc/passwd",
    "http://0.0.0.0:8000/api/outputs/%2e%2e/%2e%2e/etc/passwd",
])
def test_encoded_and_url_traversal_is_refused(ref):
    with pytest.raises(ValueError):
        local_media_ref(ref)


def test_double_encoding_names_a_file_inside_the_output_folder():
    # %252e%252e decodes once to the literal name "%2e%2e", never to "..".
    resolved = Path(local_media_ref("/api/outputs/media-refs/%252e%252e/x.png"))
    assert resolved.is_relative_to(OUTPUT_ROOT.resolve())
    assert resolved.parent.name == "%2e%2e"


def test_a_symlink_out_of_the_output_folder_is_refused(tmp_path):
    outside = tmp_path / "secret.png"
    Image.new("RGB", (4, 4)).save(outside)
    link = OUTPUT_ROOT / "media-refs" / "escape.png"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.unlink(missing_ok=True)
    link.symlink_to(outside)
    with pytest.raises(ValueError):
        local_media_ref("/api/outputs/media-refs/escape.png")


def test_a_symlink_inside_the_output_folder_resolves_to_its_target():
    target, _ = _output_file("target.png", Image.new("RGB", (4, 4)))
    link = OUTPUT_ROOT / "media-refs" / "inside-link.png"
    link.unlink(missing_ok=True)
    link.symlink_to(target)
    assert local_media_ref("/api/outputs/media-refs/inside-link.png") == str(target.resolve())


def test_the_allowed_path_policy_still_runs():
    # A file with a second hard link can't be proven outside protected stores.
    target, ref = _output_file("linked.png", Image.new("RGB", (4, 4)))
    twin = target.with_name("linked-twin.png")
    twin.unlink(missing_ok=True)
    twin.hardlink_to(target)
    try:
        with pytest.raises(ProtectedPathError):
            local_media_ref(ref)
    finally:
        twin.unlink()


def test_spatial_values_keep_their_refs():
    _, ref = _output_file("depth.png", Image.new("L", (4, 4)))
    mapped = _local_media_inputs({"depth": PortValueDict(type="DepthMap", value=ref),
                                  "frames": PortValueDict(type="DepthSequence", value=[ref])})
    assert mapped["depth"].value == ref and mapped["frames"].value == [ref]


# -- review: OpenAI masks that already have alpha, and soft edges ---------------------


def _alpha_hole(size: tuple[int, int], hole: tuple[int, int, int, int]) -> Image.Image:
    mask = Image.new("RGBA", size, (20, 40, 60, 255))
    mask.paste((0, 0, 0, 0), hole)
    return mask


def test_a_transparent_mask_at_another_size_is_resized_keeping_its_alpha():
    out = Image.open(io.BytesIO(openai_edit_mask(_png(_alpha_hole((64, 32), (0, 0, 32, 32))), (256, 128))))
    assert out.format == "PNG" and out.mode == "RGBA" and out.size == (256, 128)
    alpha = out.getchannel("A")
    assert alpha.getpixel((60, 60)) == 0 and alpha.getpixel((200, 60)) == 255
    assert set(alpha.getdata()) == {0, 255}


def test_a_transparent_webp_mask_goes_out_as_png():
    buffer = io.BytesIO()
    _alpha_hole((64, 64), (0, 0, 32, 64)).save(buffer, format="WEBP", lossless=True)
    out = Image.open(io.BytesIO(openai_edit_mask(buffer.getvalue(), (64, 64))))
    assert out.format == "PNG" and out.mode == "RGBA"
    assert out.getchannel("A").getpixel((10, 10)) == 0 and out.getchannel("A").getpixel((50, 10)) == 255


def test_a_trns_mask_counts_as_transparent_and_gets_a_real_alpha_channel():
    mask = Image.new("L", (32, 32), 200)
    mask.paste(0, (0, 0, 16, 32))
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG", transparency=0)  # black marked see-through via tRNS
    reopened = Image.open(io.BytesIO(buffer.getvalue()))
    assert has_transparency(reopened)
    out = Image.open(io.BytesIO(openai_edit_mask(buffer.getvalue(), (32, 32))))
    assert out.mode == "RGBA"
    # The person's transparent half stays the edit area; it isn't inverted.
    assert out.getchannel("A").getpixel((4, 4)) == 0 and out.getchannel("A").getpixel((28, 4)) == 255


def test_antialiased_grey_edges_split_at_mid_grey():
    ramp = Image.new("L", (256, 1))
    ramp.putdata(list(range(256)))
    alpha = Image.open(io.BytesIO(openai_edit_mask(_png(ramp), (256, 1)))).getchannel("A")
    assert [alpha.getpixel((x, 0)) for x in (0, 127, 128, 255)] == [255, 255, 0, 0]


@pytest.mark.asyncio
@respx.mock
async def test_gpt_image_1_edit_sends_the_converted_mask():
    image, _ = _output_file("v1-image.png", Image.new("RGB", (200, 100)))
    mask, _ = _output_file("v1-mask.png", _white_on_black((100, 50), (0, 0, 50, 50)))
    payload = base64.b64encode(_png(Image.new("RGB", (4, 4)))).decode()
    route = respx.post("https://api.openai.com/v1/images/edits").mock(
        return_value=httpx.Response(200, json={"data": [{"b64_json": payload}]}))
    node = GraphNode(id="e1", definitionId="gpt-image-1-edit", params={})

    async def emit(event):
        return None

    await get_handler_registry(emit=emit)["gpt-image-1-edit"](node, {
        "image": PortValueDict(type="Image", value=str(image)),
        "mask": PortValueDict(type="Image", value=str(mask)),
        "prompt": PortValueDict(type="Text", value="paint it blue"),
    }, KEYS)
    sent = Image.open(io.BytesIO(_multipart(route.calls.last.request)["mask"][0]))
    assert sent.format == "PNG" and sent.mode == "RGBA" and sent.size == (200, 100)
    assert sent.getchannel("A").getpixel((50, 50)) == 0 and sent.getchannel("A").getpixel((150, 50)) == 255


@pytest.mark.asyncio
async def test_mask_painter_never_fetches_a_private_source_url(monkeypatch):
    monkeypatch.setattr(engine, "_materialize_media_outputs", _keep)
    router = respx.mock(assert_all_called=False)
    private = router.get("http://10.0.0.5/scene.png").mock(
        return_value=httpx.Response(200, content=_png(Image.new("RGB", (8, 8)))))
    painted = "data:image/png;base64," + base64.b64encode(_png(Image.new("L", (8, 8), 255))).decode()

    async def remote_image(node, inputs, api_keys):
        return {"image": {"type": "Image", "value": "http://10.0.0.5/scene.png"}}

    events: list = []

    async def emit(event):
        events.append(event)

    registry = get_handler_registry(emit=emit)
    registry["nano-banana"] = remote_image
    nodes = [GraphNode(id="src", definitionId="nano-banana", params={}),
             GraphNode(id="mp", definitionId="mask-painter", params={"_maskData": painted})]
    edges = [GraphEdge(id="e", source="src", sourceHandle="image", target="mp", targetHandle="image")]
    with router:
        await execute_graph(nodes, edges, KEYS, registry, emit, run_id="mask-painter-private")

    assert not private.called
    errors = [event for event in events if event.type == "error" and event.node_id == "mp"]
    assert errors, events
