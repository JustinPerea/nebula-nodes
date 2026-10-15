"""jev-box: the paired request, box geometry back to the original image, the
crop / mask / annotated files, and the shared fixture.

httpx is mocked through typesafe_client._make_client; nothing reaches
TypeSafe. The box samples in backend/tests/fixtures/jev_outputs.json are this
handler's real outputs (saved file names normalised); frontend/tests/lib/
jev.test.ts parses the same file. To refresh them after a deliberate format
change, run this file with JEV_FIXTURE_WRITE=1, review the diff and update
each sample's `parsed` by hand.
"""
from __future__ import annotations

import base64
import email
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from PIL import Image

from execution.engine import execute_graph
from execution.gating import WITHHELD_KEY
from execution.missing_credential import MissingCredentialError
from handlers.jev_box import crop_rect, handle_jev_box
from models.graph import GraphEdge, GraphNode, PortValueDict
from services import jev_outputs
from services import typesafe_client as ts
from services.output import OUTPUT_ROOT, resolve_output_ref

FIXTURE = Path(__file__).parent / "fixtures" / "jev_outputs.json"
KEYS = {"TYPESAFE_API_KEY": "ts-test-key"}
MEDIA_PORTS = ("crop", "mask", "annotated")


def _node(**params) -> GraphNode:
    return GraphNode(id="bx1", definitionId="jev-box", params={"target": "the red square", **params})


def _inputs(image: str, target: str | None = None) -> dict[str, PortValueDict]:
    inputs = {"image": PortValueDict(type="Image", value=image)}
    if target is not None:
        inputs["target"] = PortValueDict(type="Text", value=target)
    return inputs


def _response(presence: float, box: dict | None = None, confidence: float | None = 0.9, *,
              tokens: int = 290) -> dict:
    answers: dict = {"present": {"type": "noul", "noul": presence}}
    edges = box or {"top": 0.25, "bottom": 0.82, "left": 0.44, "right": 0.84}
    answers["where"] = {"type": "box", "box": edges, "confidence": confidence}
    return {"model": "jev-1.14.0", "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 21}}


def _install(monkeypatch, body: dict, status: int = 200):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status, json=body)

    monkeypatch.setattr(ts, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(ts, "_sleep", no_sleep)
    return calls


def _parts(request: httpx.Request) -> list:
    raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
    return email.message_from_bytes(raw).get_payload()


def _json_body(request: httpx.Request) -> dict:
    return json.loads(_parts(request)[0].get_payload(decode=True))


def _scene(size: tuple[int, int], square: tuple[int, int, int, int]) -> Image.Image:
    """A grey image with one red rectangle (left, top, right, bottom)."""
    image = Image.new("RGB", size, (128, 128, 128))
    image.paste((255, 0, 0), square)
    return image


def _data_uri(image: Image.Image, fmt: str = "PNG", **save) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **save)
    mime = "image/png" if fmt == "PNG" else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(buffer.getvalue()).decode()


def _open(url: str) -> Image.Image:
    assert url.startswith("/api/outputs/")
    path = Path(resolve_output_ref(url))
    assert path.is_file() and path.resolve().is_relative_to(OUTPUT_ROOT.resolve())
    return Image.open(path)


async def _run(monkeypatch, params: dict, image: str, response: dict, *, target: str | None = None):
    calls = _install(monkeypatch, response)
    outputs = await handle_jev_box(_node(**params), _inputs(image, target), KEYS)
    assert jev_outputs.validate_outputs("jev-box", outputs) == []
    return outputs, calls


def _box(outputs: dict) -> dict | None:
    return json.loads(outputs["box"]["value"])


def _red_fraction(image: Image.Image) -> float:
    pixels = list(image.convert("RGB").getdata())
    return sum(1 for r, g, b in pixels if r > 200 and g < 60 and b < 60) / len(pixels)


# -- request ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_request_with_presence_and_box_sharing_the_image(monkeypatch):
    _, calls = await _run(monkeypatch, {}, _data_uri(_scene((640, 480), (100, 100, 200, 200))), _response(0.95))
    assert len(calls) == 1
    request = calls[0]
    assert request.headers[ts.IMAGES_HEADER] == "true"
    body = _json_body(request)
    assert body["model"] == "jev-1.14.0"
    (placeholder,) = body["assets"]
    assert body["state"] == {"image": placeholder}
    assert body["questions"] == {
        "present": {"type": "noul", "instructions": "Does `image` show the red square?"},
        "where": {"type": "box", "instructions": "the red square in `image`"},
    }
    # The image is in the state once; neither question repeats it.
    assert json.dumps(body["questions"]).count(placeholder) == 0
    assert len(_parts(request)) == 2


@pytest.mark.asyncio
async def test_the_target_input_overrides_the_param(monkeypatch):
    _, calls = await _run(monkeypatch, {"target": "a dog"}, _data_uri(_scene((640, 480), (0, 0, 9, 9))),
                          _response(0.05), target="  the `blue`\n car ")
    questions = _json_body(calls[0])["questions"]
    assert questions["where"]["instructions"] == "the 'blue' car in `image`"


@pytest.mark.asyncio
@pytest.mark.parametrize(("params", "image", "message"), [
    ({"model": "jev-1.13.0"}, "x", "needs Jev 1.14"),
    ({"model": "jev-latest"}, "x", "needs Jev 1.14"),
    ({"target": ""}, "x", "needs a target"),
    ({"pad": 0.8}, "x", "pad must be from 0 to 0.5"),
    ({}, "", "needs an image"),
])
async def test_bad_settings_fail_before_any_request(monkeypatch, params, image, message):
    calls = _install(monkeypatch, _response(0.9))
    with pytest.raises(ValueError, match=message):
        await handle_jev_box(_node(**params), _inputs(image), KEYS)
    assert calls == []


@pytest.mark.asyncio
async def test_missing_key_fails_before_any_request(monkeypatch):
    calls = _install(monkeypatch, _response(0.9))
    with pytest.raises(MissingCredentialError, match="TYPESAFE_API_KEY is required"):
        await handle_jev_box(_node(), _inputs("x"), {})
    assert calls == []


def test_box_is_registered_as_a_sync_handler():
    from execution.sync_runner import SYNC_HANDLERS

    assert SYNC_HANDLERS["jev-box"] is handle_jev_box


# -- found: geometry and files ---------------------------------------------------


@pytest.mark.asyncio
async def test_found_maps_fractions_to_pixels_and_cuts_crop_and_mask(monkeypatch):
    image = _scene((1000, 500), (400, 100, 600, 300))
    edges = {"top": 0.2, "bottom": 0.6, "left": 0.4, "right": 0.6}
    outputs, _ = await _run(monkeypatch, {"pad": 0}, _data_uri(image), _response(0.97, edges, 0.92))
    assert set(outputs) == {"found", "box", "crop", "mask", "annotated", "report"}
    assert outputs["found"]["value"] == "true"
    box = _box(outputs)
    assert box == {"top": 0.2, "bottom": 0.6, "left": 0.4, "right": 0.6, "confidence": 0.92,
                   "px": {"x": 400, "y": 100, "w": 200, "h": 200}, "image": {"w": 1000, "h": 500}}
    crop = _open(outputs["crop"]["value"])
    assert crop.size == (200, 200) and _red_fraction(crop) == 1.0
    mask = _open(outputs["mask"]["value"])
    assert outputs["mask"]["type"] == "Mask"
    assert mask.mode == "L" and mask.size == (1000, 500)
    assert mask.getbbox() == (400, 100, 600, 300)  # the white area is exactly the crop
    assert sum(1 for value in mask.getdata() if value == 255) == 200 * 200
    annotated = _open(outputs["annotated"]["value"])
    assert annotated.size == (1000, 500)
    assert annotated.getpixel((400, 200)) != image.getpixel((400, 200))  # the outline is drawn
    assert len({Path(resolve_output_ref(outputs[port]["value"])).parent for port in MEDIA_PORTS}) == 1
    report = outputs["report"]["value"]
    assert "Box: x 400, y 100, 200 x 200 px of 1000 x 500" in report
    assert "Crop: x 400, y 100, 200 x 200 px (pad 0)" in report


@pytest.mark.asyncio
async def test_pad_grows_the_crop_and_mask_but_stays_inside_the_image(monkeypatch):
    image = _scene((800, 400), (0, 0, 80, 80))
    edges = {"top": 0.0, "bottom": 0.2, "left": 0.0, "right": 0.1}
    outputs, _ = await _run(monkeypatch, {"pad": 0.1}, _data_uri(image), _response(0.99, edges))
    assert _box(outputs)["px"] == {"x": 0, "y": 0, "w": 80, "h": 80}  # box itself is unpadded
    crop = _open(outputs["crop"]["value"])
    assert crop.size == (160, 120)  # +80 px right, +40 px down; clamped at the top-left
    assert _open(outputs["mask"]["value"]).getbbox() == (0, 0, 160, 120)


def test_crop_rect_clamps_and_never_collapses():
    mapped = {"px": {"x": 990, "y": 5, "w": 10, "h": 0}, "image": {"w": 1000, "h": 500}}
    assert crop_rect(mapped, 0.05) == (940, 0, 1000, 30)
    assert crop_rect(mapped, 0.0) == (990, 5, 1000, 6)
    edge = {"px": {"x": 1000, "y": 500, "w": 0, "h": 0}, "image": {"w": 1000, "h": 500}}
    assert crop_rect(edge, 0.0) == (999, 499, 1000, 500)


@pytest.mark.asyncio
async def test_exif_rotated_input_maps_back_to_the_upright_image(monkeypatch):
    # Stored 400x300 landscape with EXIF orientation 6 ("rotate 90° clockwise to
    # view"): a browser shows it 300x400. The red square sits at upright
    # (50, 250)-(150, 350).
    upright = _scene((300, 400), (50, 250, 150, 350))
    stored = upright.transpose(Image.Transpose.ROTATE_90)  # undo of the clockwise view rotation
    exif = Image.Exif()
    exif[0x0112] = 6
    uri = _data_uri(stored, "JPEG", exif=exif.tobytes(), quality=95)
    # TypeSafe sees the upright copy (300x400, inside the limits): fractions of it.
    edges = {"top": 250 / 400, "bottom": 350 / 400, "left": 50 / 300, "right": 150 / 300}
    outputs, calls = await _run(monkeypatch, {"pad": 0}, uri, _response(0.98, edges))
    sent = Image.open(io.BytesIO(_parts(calls[0])[1].get_payload(decode=True)))
    assert sent.size == (300, 400)
    box = _box(outputs)
    assert box["image"] == {"w": 300, "h": 400}
    assert box["px"] == {"x": 50, "y": 250, "w": 100, "h": 100}
    crop = _open(outputs["crop"]["value"])
    assert crop.size == (100, 100) and _red_fraction(crop) > 0.9
    assert "rotated upright" in outputs["report"]["value"]


@pytest.mark.asyncio
async def test_padded_small_input_maps_back_to_the_original_pixels(monkeypatch):
    # 100x100 is padded to 280x280 with the image centred at (90, 90).
    image = _scene((100, 100), (25, 25, 75, 75))
    edges = {"top": 115 / 280, "bottom": 165 / 280, "left": 115 / 280, "right": 165 / 280}
    outputs, calls = await _run(monkeypatch, {"pad": 0}, _data_uri(image), _response(0.9, edges))
    sent = Image.open(io.BytesIO(_parts(calls[0])[1].get_payload(decode=True)))
    assert sent.size == (280, 280)
    box = _box(outputs)
    assert box["image"] == {"w": 100, "h": 100}
    assert box["px"] == {"x": 25, "y": 25, "w": 50, "h": 50}
    assert (box["top"], box["left"], box["bottom"], box["right"]) == (0.25, 0.25, 0.75, 0.75)
    assert _red_fraction(_open(outputs["crop"]["value"])) == 1.0
    # A box reaching into the padding is clamped to the real image.
    wide = {"top": 0.0, "bottom": 1.0, "left": 0.0, "right": 1.0}
    outputs, _ = await _run(monkeypatch, {"pad": 0}, _data_uri(image), _response(0.9, wide))
    assert _box(outputs)["px"] == {"x": 0, "y": 0, "w": 100, "h": 100}


@pytest.mark.asyncio
async def test_resized_large_input_maps_back_to_full_resolution(monkeypatch):
    image = _scene((3136, 1568), (1000, 400, 1400, 800))
    edges = {"top": 200 / 784, "bottom": 400 / 784, "left": 500 / 1568, "right": 700 / 1568}
    outputs, _ = await _run(monkeypatch, {"pad": 0}, _data_uri(image), _response(0.9, edges))
    assert _box(outputs)["px"] == {"x": 1000, "y": 400, "w": 400, "h": 400}
    assert _open(outputs["crop"]["value"]).size == (400, 400)


@pytest.mark.asyncio
async def test_a_missing_box_confidence_stays_null(monkeypatch):
    outputs, _ = await _run(monkeypatch, {}, _data_uri(_scene((640, 480), (0, 0, 9, 9))),
                            _response(0.95, confidence=None))
    assert _box(outputs)["confidence"] is None
    assert "Box confidence: unknown" in outputs["report"]["value"]


# -- not found / unsure ----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("presence", "found"), [(0.05, "false"), (0.6, "unsure"), (0.3, "unsure")])
async def test_missing_or_unsure_targets_get_no_box_crop_or_mask(monkeypatch, presence, found):
    before = set(OUTPUT_ROOT.rglob("*jev-box-*"))
    outputs, _ = await _run(monkeypatch, {}, _data_uri(_scene((640, 480), (0, 0, 9, 9))), _response(presence))
    assert set(outputs) == {"found", "box", "report", *MEDIA_PORTS}
    # Crop, mask and annotated are withheld, so the nodes wired to them are skipped.
    reasons = {port: outputs[port].get(WITHHELD_KEY) for port in MEDIA_PORTS}
    expected = (f"Jev Box didn't find the red square (presence {presence})" if found == "false"
                else f"Jev Box was unsure whether the red square is there (presence {presence})")
    assert reasons == dict.fromkeys(MEDIA_PORTS, expected)
    assert outputs["found"]["value"] == found
    assert outputs["box"]["value"] == "null"
    assert set(OUTPUT_ROOT.rglob("*jev-box-*")) == before  # nothing saved
    report = outputs["report"]["value"]
    assert "Box:" not in report and "Crop:" not in report
    assert ("so found is unsure" in report) == (found == "unsure")


@pytest.mark.asyncio
async def test_presence_threshold_and_minimum_confidence_set_found(monkeypatch):
    uri = _data_uri(_scene((640, 480), (0, 0, 9, 9)))
    strict, _ = await _run(monkeypatch, {"presence_threshold": 0.95}, uri, _response(0.9))
    assert strict["found"]["value"] == "false"
    lenient, _ = await _run(monkeypatch, {"min_confidence": 0.1}, uri, _response(0.6))
    assert lenient["found"]["value"] == "true"


@pytest.mark.asyncio
@pytest.mark.parametrize(("presence", "inpaint_runs"), [(0.97, True), (0.05, False), (0.6, False)])
async def test_an_inpaint_fed_the_mask_runs_only_when_the_target_was_found(monkeypatch, presence, inpaint_runs):
    import execution.engine as engine

    async def keep(outputs, run_dir):
        return outputs

    monkeypatch.setattr(engine, "_materialize_media_outputs", keep)
    _install(monkeypatch, _response(presence))
    inpainted: list[dict] = []

    async def inpaint(node, inputs, api_keys):  # stands in for a paid edit node
        inpainted.append({port: value.value for port, value in inputs.items()})
        return {"image": {"type": "Image", "value": "https://example.invalid/inpainted.png"}}

    image = _scene_file([640, 480])
    nodes = [GraphNode(id="img", definitionId="image-input", params={"filePath": image}),
             _node(), GraphNode(id="edit", definitionId="gpt-image-1-edit", params={})]
    wires = [("img", "image", "bx1", "image"), ("img", "image", "edit", "image"), ("bx1", "mask", "edit", "mask")]
    edges = [GraphEdge(id=f"{a}.{p}->{b}.{q}", source=a, sourceHandle=p, target=b, targetHandle=q)
             for a, p, b, q in wires]
    events: list = []

    async def emit(event):
        events.append(event)

    await execute_graph(nodes, edges, KEYS, {"jev-box": handle_jev_box, "gpt-image-1-edit": inpaint}, emit,
                        run_id="jev-box-gate")
    skipped = [event for event in events if event.type == "skipped"]
    if inpaint_runs:
        assert len(inpainted) == 1 and not skipped
        # The engine hands the edit node Box's mask as a file path, not the ref.
        mask = Path(inpainted[0]["mask"])
        assert mask.is_file() and mask.name.startswith("jev-box-mask-")
        assert mask.resolve().is_relative_to(OUTPUT_ROOT.resolve())
    else:
        assert inpainted == []
        assert [(event.node_id, event.gate_node_id) for event in skipped] == [("edit", "bx1")]
        assert skipped[0].reason.startswith(("Jev Box didn't find the red square", "Jev Box was unsure"))


# -- the shared fixture ----------------------------------------------------------


def _scene_file(size: list[int]) -> str:
    name = f"photo-{size[0]}x{size[1]}.png"
    path = OUTPUT_ROOT / "jev-fixture" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", tuple(size), (128, 128, 128)).save(path, format="PNG")
    return f"/api/outputs/jev-fixture/{name}"


def _normalised(outputs: dict) -> dict:
    """Saved files get unique names; the fixture holds stable ones."""
    return {port: ({**entry, "value": f"/api/outputs/jev-box/{port}.png"}
                   if port in MEDIA_PORTS and WITHHELD_KEY not in entry else entry)
            for port, entry in outputs.items()}


@pytest.mark.asyncio
async def test_box_outputs_match_the_shared_fixture(monkeypatch):
    fixture = json.loads(FIXTURE.read_text())
    produced = []
    for case in fixture["box"]:
        outputs, _ = await _run(monkeypatch, case["params"], _scene_file(case["image"]), case["response"],
                                target=case.get("target"))
        produced.append({**case, "outputs": _normalised(outputs)})
    if os.environ.get("JEV_FIXTURE_WRITE") == "1":
        fixture["box"] = produced
        FIXTURE.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    for case, made in zip(fixture["box"], produced):
        assert made["outputs"] == case["outputs"], case["name"]


@pytest.mark.asyncio
async def test_transparent_input_keeps_alpha_in_the_crop_and_shows_white_when_annotated(monkeypatch):
    image = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
    image.paste((255, 0, 0, 255), (100, 100, 200, 200))
    edges = {"top": 0.25, "bottom": 0.5, "left": 0.25, "right": 0.5}
    outputs, _ = await _run(monkeypatch, {"pad": 0}, _data_uri(image), _response(0.95, edges))
    crop = _open(outputs["crop"]["value"])
    assert crop.mode == "RGBA" and crop.size == (100, 100)
    annotated = _open(outputs["annotated"]["value"])
    assert annotated.mode == "RGB" and annotated.getpixel((5, 395)) == (255, 255, 255)
