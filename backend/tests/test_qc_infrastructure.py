from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image

from services import output as output_service
from services.qc_common import (
    bounded_sample_count,
    create_annotated_frame,
    evenly_spaced_points,
    format_report,
    resolve_local_media,
    save_annotated_output,
)
from services.vision_llm import (
    NoVisionProviderError,
    VisionProviderError,
    VISION_PROVIDERS,
    build_vision_request,
    call_vision_llm,
)


def _image(path: Path, color: str = "#345678") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 36), color).save(path)
    return path


def test_local_media_resolution_is_contained_and_rejects_remote(tmp_path: Path) -> None:
    local = _image(output_service.OUTPUT_ROOT / "qc-contract" / "frame.png")
    rel = local.relative_to(output_service.OUTPUT_ROOT)
    assert resolve_local_media(f"/api/outputs/{rel}", label="frame") == local.resolve()

    with pytest.raises(ValueError, match="Remote or inline"):
        resolve_local_media("https://example.invalid/frame.png", label="frame")
    outside = _image(tmp_path / "outside.png")
    with pytest.raises(ValueError, match="contained"):
        resolve_local_media(str(outside), label="frame")
    with pytest.raises(ValueError, match="escapes"):
        resolve_local_media("/api/outputs/../../outside.png", label="frame")


def test_sampling_and_report_are_bounded_json() -> None:
    assert bounded_sample_count(999) == 12
    assert bounded_sample_count("bad", default=4) == 4
    assert evenly_spaced_points(3) == [0.0, 0.5, 1.0]
    report = json.loads(format_report({"score": 0.5}, node_id="n7", mode="opencv"))
    assert report["score"] == 0.5
    assert report["node_id"] == "n7"
    assert report["mode"] == "opencv"
    assert report["timestamp"].endswith("+00:00")


def test_annotated_output_is_decodable_png() -> None:
    sheet = create_annotated_frame(
        [Image.new("RGB", (80, 45), "red"), Image.new("RGB", (80, 45), "blue")],
        title="QC",
        labels=["first", "last"],
        boxes={0: [(5, 5, 20, 20)]},
        footer=["score: 0.95"],
    )
    path, url = save_annotated_output(sheet, node_id="n7", stem="qc-test")
    assert url.startswith("/api/outputs/")
    with Image.open(path) as result:
        result.verify()
        assert result.format == "PNG"


@pytest.mark.parametrize("provider_name", ["anthropic", "openai", "google"])
def test_provider_requests_use_expected_auth_and_inline_images(
    provider_name: str, tmp_path: Path
) -> None:
    provider = next(item for item in VISION_PROVIDERS if item.name == provider_name)
    image = _image(tmp_path / "sample.png")
    url, headers, body = build_vision_request(
        provider,
        "secret",
        system_prompt="system",
        images=[image],
        user_prompt="inspect",
    )
    assert url.startswith("https://")
    assert any("secret" in value for value in headers.values())
    encoded = json.dumps(body)
    assert "image/jpeg" in encoded
    assert "Respond with one JSON object" in encoded


def test_vision_images_are_resized_and_count_bounded(tmp_path: Path) -> None:
    from services.vision_llm import MAX_VISION_IMAGE_EDGE, _encoded_images

    source = _image(tmp_path / "large.png")
    Image.new("RGB", (1800, 900), "#123456").save(source)
    encoded = _encoded_images([source] * 13)
    assert len(encoded) == 13
    assert {mime for mime, _ in encoded} == {"image/jpeg"}
    with Image.open(io.BytesIO(base64.b64decode(encoded[0][1]))) as image:
        assert max(image.size) == MAX_VISION_IMAGE_EDGE
    assert sum(len(data) for _, data in encoded) < 16 * 1024 * 1024

    with pytest.raises(ValueError, match="at most 13"):
        _encoded_images([source] * 14)


@pytest.mark.asyncio
async def test_vision_mode_fails_clearly_without_a_provider(tmp_path: Path) -> None:
    with pytest.raises(NoVisionProviderError, match="requires ANTHROPIC_API_KEY"):
        await call_vision_llm(
            {}, system_prompt="system", images=[_image(tmp_path / "x.png")], user_prompt="inspect"
        )


@pytest.mark.asyncio
async def test_vision_response_is_parsed_without_a_real_provider_call(tmp_path: Path) -> None:
    async def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"seam_score":0.91}'}}]},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    try:
        result = await call_vision_llm(
            {"OPENAI_API_KEY": "test-key"},
            system_prompt="system",
            images=[_image(tmp_path / "sample.png")],
            user_prompt="inspect",
            client=client,
        )
    finally:
        await client.aclose()
    assert result["seam_score"] == pytest.approx(0.91)
    assert result["provider_json_valid"] is True
    assert result["vision_provider"] == "openai"


@pytest.mark.asyncio
async def test_injected_vision_client_cannot_bypass_request_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import vision_llm

    async def never_responds(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    monkeypatch.setattr(vision_llm, "VISION_TIMEOUT_SECONDS", 0.01)
    client = httpx.AsyncClient(transport=httpx.MockTransport(never_responds), timeout=None)
    try:
        with pytest.raises(VisionProviderError, match="timed out"):
            await call_vision_llm(
                {"OPENAI_API_KEY": "test-key"},
                system_prompt="system",
                images=[_image(tmp_path / "sample.png")],
                user_prompt="inspect",
                client=client,
            )
    finally:
        await client.aclose()


# PR #208 round 4 (review 3 R1, N1): a reference opens as it shows on the
# node, EXIF turn included, so an EXIF-rotated opaque reference is measured
# upright (open_rgb, for video frames, doesn't turn it).

def _exif_6_jpeg(path: Path) -> Path:
    """A 60x40 opaque JPEG stored sideways: Orientation 6 shows it 40x60."""
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (60, 40), (200, 40, 40))
    exif = Image.Exif()
    exif[0x0112] = 6
    image.save(path, format="JPEG", exif=exif.tobytes())
    return path


def test_open_seen_turns_an_exif_rotated_reference() -> None:
    from services.qc_common import open_rgb, open_seen

    path = _exif_6_jpeg(output_service.OUTPUT_ROOT / "qc-contract" / "exif-6.jpg")
    assert open_rgb(path).size == (60, 40)
    assert open_seen(path).size == (40, 60)


@pytest.mark.asyncio
async def test_qc_camera_geometry_measures_an_exif_rotated_opaque_reference_upright(monkeypatch) -> None:
    import handlers.qc_camera_geometry as handler
    from models.graph import GraphNode, PortValueDict

    frame = _image(output_service.OUTPUT_ROOT / "qc-contract" / "geometry-frame.png")
    reference = _exif_6_jpeg(output_service.OUTPUT_ROOT / "qc-contract" / "geometry-reference.jpg")
    rel = reference.relative_to(output_service.OUTPUT_ROOT).as_posix()

    async def frames(_source, _points, _temp):
        return [frame] * 5

    seen: dict = {}

    def metrics(frames_in, *, reference=None, opencv=False):
        seen["size"] = reference.size
        raise RuntimeError("stop after the metrics")

    monkeypatch.setattr(handler, "required_video", lambda inputs: frame)
    monkeypatch.setattr(handler, "extract_frames", frames)
    monkeypatch.setattr(handler, "camera_geometry_metrics", metrics)
    node = GraphNode(id="q1", definitionId="qc-camera-geometry", params={"mode": "opencv"})
    inputs = {"reference": PortValueDict(type="Image", value=f"/api/outputs/{rel}")}
    with pytest.raises(RuntimeError, match="stop after the metrics"):
        await handler.handle_qc_camera_geometry(node, inputs, {})
    assert seen["size"] == (40, 60)
