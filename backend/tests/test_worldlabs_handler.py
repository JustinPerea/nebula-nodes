"""World Labs public Marble API adapter tests.

Every HTTP interaction is mocked. These tests never create a paid world or
contact a provider endpoint.
"""
from __future__ import annotations

import asyncio
import gzip
import ipaddress
import json
import struct
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from execution.engine import _collect_manifest_records
from handlers.worldlabs import (
    WORLDLABS_API_BASE,
    _api_headers,
    _build_world_prompt,
    _content_reference,
    _data_uri_reference,
    _download_asset,
    _materialize_world,
    _upload_local_media,
    _validated_world_input,
    handle_worldlabs_environment,
    handle_worldlabs_export,
)
from models.events import (
    ProgressEvent,
    ProviderRecoveryEvent,
    ProviderStartAmbiguousEvent,
)
from models.graph import GraphNode, PortValueDict


API_KEYS = {"WORLDLABS_API_KEY": "worldlabs-test-key"}


def _png_header(width: int, height: int) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I4sII5B", 13, b"IHDR", width, height, 8, 2, 0, 0, 0)
        + b"\0\0\0\0"
    )


def _jpeg_header(width: int, height: int) -> bytes:
    return (
        b"\xff\xd8\xff\xc0\x00\x08\x08"
        + height.to_bytes(2, "big")
        + width.to_bytes(2, "big")
        + b"\x01"
    )


PNG = _png_header(1, 1)
JPEG = _jpeg_header(1, 1)


def _spz_bytes(
    *,
    version: int = 2,
    point_count: int = 1,
    sh_degree: int = 0,
    fractional_bits: int = 12,
    flags: int = 0,
) -> bytes:
    position_bytes = 6 if version == 1 else 9
    rotation_bytes = 4 if version == 3 else 3
    sh_bytes = {0: 0, 1: 9, 2: 24, 3: 45}[sh_degree]
    lod_bytes = 6 if flags & 0x80 else 0
    payload_size = point_count * (
        position_bytes + 1 + 3 + 3 + rotation_bytes + sh_bytes + lod_bytes
    )
    raw = struct.pack(
        "<III4B",
        0x5053474E,
        version,
        point_count,
        sh_degree,
        fractional_bits,
        flags,
        0,
    ) + b"\0" * payload_size
    return gzip.compress(raw)


def _glb_bytes() -> bytes:
    json_chunk = b'{"asset":{"version":"2.0"}} '
    return (
        struct.pack("<4sII", b"glTF", 2, 20 + len(json_chunk))
        + struct.pack("<I4s", len(json_chunk), b"JSON")
        + json_chunk
    )


SPZ = _spz_bytes()
GLB = _glb_bytes()
PLY = (
    b"ply\nformat binary_little_endian 1.0\n"
    b"element vertex 1\nproperty float x\nend_header\n"
    b"\0\0\0\0"
)


@pytest.fixture(autouse=True)
def _resolve_mock_provider_hosts_to_public_test_address(monkeypatch) -> None:
    async def public_addresses(_hostname: str, _port: int):
        return {ipaddress.ip_address("8.8.8.8")}

    monkeypatch.setattr(
        "handlers.worldlabs._resolve_host_addresses", public_addresses
    )


def _node(
    definition_id: str = "worldlabs-environment",
    params: dict[str, Any] | None = None,
    *,
    node_id: str = "world-node",
) -> GraphNode:
    return GraphNode(
        id=node_id,
        definitionId=definition_id,
        params=params or {},
        outputs={},
    )


def _port(value: Any, port_type: str = "Text") -> PortValueDict:
    return PortValueDict(type=port_type, value=value)


def _complete_world(world_id: str = "world-123") -> dict[str, Any]:
    return {
        "id": world_id,
        "display_name": "Nebula room",
        "world_marble_url": f"https://marble.worldlabs.ai/world/{world_id}",
        "model": "marble-1.1",
        "assets": {
            "caption": "A softly lit room",
            "thumbnail_url": "https://assets.worldlabs.test/thumb?signature=secret",
            "imagery": {
                "pano_url": "https://assets.worldlabs.test/pano?signature=secret"
            },
            "mesh": {
                "collider_mesh_url": "https://assets.worldlabs.test/collider?signature=secret"
            },
            "splats": {
                "spz_urls": {
                    "100k": "https://assets.worldlabs.test/100k?signature=secret",
                    "150k": "https://assets.worldlabs.test/150k?signature=secret",
                    "500k": "https://assets.worldlabs.test/500k?signature=secret",
                    "full_res": "https://assets.worldlabs.test/full?signature=secret",
                },
                "semantics_metadata": {
                    "metric_scale_factor": 1.25,
                    "ground_plane_offset": -0.4,
                },
            },
        },
    }


def _world_v2(
    *,
    provider: str = "worldlabs",
    model: str = "marble-1.1",
) -> dict[str, Any]:
    coordinate_system = {
        "schemaVersion": 1,
        "kind": "coordinate-system",
        "id": "world",
        "handedness": "right",
        "upAxis": "-y",
        "forwardAxis": "z",
        "unit": "meters",
        "metersPerUnit": 1.0,
        "originMeters": [0.0, 0.0, 0.0],
    }
    return {
        "schemaVersion": 2,
        "kind": "world",
        "id": "world-v2-123",
        "displayName": "World v2",
        "coordinateSystem": coordinate_system,
        "session": {
            "schemaVersion": 1,
            "kind": "spatial-session",
            "id": "world-v2-session",
            "source": "generated",
            "provider": provider,
            "model": model,
            "tags": [],
        },
        "assets": {
            "splats": [
                {
                    "id": "100k",
                    "format": "spz",
                    "asset": {
                        "id": "world-v2-splat",
                        "uri": "/api/outputs/run/world-v2.spz",
                        "mediaType": "application/vnd.spark.spz",
                    },
                    "pointCount": 100_000,
                }
            ]
        },
    }


def _mock_world_assets() -> None:
    for suffix in ("100k", "150k", "500k", "full"):
        respx.get(f"https://assets.worldlabs.test/{suffix}?signature=secret").mock(
            return_value=httpx.Response(200, content=SPZ)
        )
    respx.get("https://assets.worldlabs.test/pano?signature=secret").mock(
        return_value=httpx.Response(200, content=PNG)
    )
    respx.get("https://assets.worldlabs.test/thumb?signature=secret").mock(
        return_value=httpx.Response(200, content=PNG)
    )
    respx.get("https://assets.worldlabs.test/collider?signature=secret").mock(
        return_value=httpx.Response(200, content=GLB)
    )


@pytest.mark.asyncio
@respx.mock
async def test_generation_polls_and_materializes_every_world_asset(tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def capture_start(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        captured["headers"] = dict(request.headers)
        return httpx.Response(
            200,
            json={"operation_id": "operation-1", "done": False, "metadata": {}},
        )

    start_route = respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        side_effect=capture_start
    )
    poll_route = respx.get(f"{WORLDLABS_API_BASE}/operations/operation-1").mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": "operation-1",
                "done": True,
                "response": {"world_id": "world-123"},
                "cost": {"total_credits": 1500, "line_items": []},
            },
        )
    )
    respx.get(f"{WORLDLABS_API_BASE}/worlds/world-123").mock(
        return_value=httpx.Response(200, json={"world": _complete_world()})
    )
    _mock_world_assets()
    emitted: list[Any] = []

    async def emit(event: Any) -> None:
        emitted.append(event)

    with (
        patch("handlers.worldlabs.get_run_dir", return_value=tmp_path),
        patch("handlers.worldlabs.asyncio.sleep", new_callable=AsyncMock),
    ):
        node = _node(
            params={"model": "marble-1.1", "display_name": "Nebula room"}
        )
        outputs = await handle_worldlabs_environment(
            node,
            {"prompt": _port("A softly lit room")},
            API_KEYS,
            emit=emit,
        )

    assert poll_route.call_count == 1
    body = captured["body"]
    assert body["model"] == "marble-1.1"
    assert body["world_prompt"] == {
        "type": "text",
        "text_prompt": "A softly lit room",
    }
    assert body["permission"] == {
        "public": False,
        "allow_id_access": False,
        "allowed_readers": [],
        "allowed_writers": [],
    }
    assert captured["headers"]["wlt-api-key"] == API_KEYS["WORLDLABS_API_KEY"]

    world = outputs["world"]["value"]
    assert outputs["world"]["type"] == "World"
    assert world["schemaVersion"] == 1
    assert world["provider"] == "worldlabs"
    assert world["worldId"] == "world-123"
    assert world["semantics"] == {
        "metricScaleFactor": 1.25,
        "groundPlaneOffset": -0.4,
        "coordinateFrame": "marble_raw_opencv",
    }
    assert set(world["assets"]["splats"]) == {"100k", "150k", "500k", "full_res"}
    local_paths = [
        *world["assets"]["splats"].values(),
        world["assets"]["panorama"],
        world["assets"]["colliderMesh"],
        world["assets"]["thumbnail"],
    ]
    assert all(Path(value).is_file() for value in local_paths)
    assert outputs["panorama"]["value"] == world["assets"]["panorama"]
    assert outputs["collider"]["value"] == world["assets"]["colliderMesh"]
    assert outputs["thumbnail"]["value"] == world["assets"]["thumbnail"]
    assert outputs["caption"]["value"] == "A softly lit room"
    assert world["cost"]["total_credits"] == 1500
    # Expiring signed URLs are never retained in the emitted/cached World.
    assert "signature=secret" not in json.dumps(outputs)
    assert any(
        isinstance(event, ProgressEvent) and 0 < event.value < 1
        for event in emitted
    )
    recovery_events = [
        event for event in emitted if isinstance(event, ProviderRecoveryEvent)
    ]
    assert [
        (event.resume_operation_id, event.existing_world_id)
        for event in recovery_events
    ] == [("operation-1", None), (None, "world-123")]
    assert "resume_operation_id" not in node.params
    assert node.params["existing_world_id"] == "world-123"

    # The pinned World ID makes an ordinary rerun a retrieval, not a second
    # paid generation POST.
    with patch("handlers.worldlabs.get_run_dir", return_value=tmp_path):
        rerun = await handle_worldlabs_environment(node, {}, API_KEYS)
    assert rerun["world"]["value"]["worldId"] == "world-123"
    assert start_route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_resume_generation_operation_skips_paid_post(tmp_path: Path) -> None:
    start_route = respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        return_value=httpx.Response(500)
    )
    poll_route = respx.get(
        f"{WORLDLABS_API_BASE}/operations/recover-operation"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": "recover-operation",
                "done": True,
                "response": {"world_id": "world-123"},
            },
        )
    )
    respx.get(f"{WORLDLABS_API_BASE}/worlds/world-123").mock(
        return_value=httpx.Response(200, json={"world": _complete_world()})
    )
    _mock_world_assets()

    with (
        patch("handlers.worldlabs.get_run_dir", return_value=tmp_path),
        patch("handlers.worldlabs.asyncio.sleep", new_callable=AsyncMock),
    ):
        node = _node(params={"resume_operation_id": "recover-operation"})
        outputs = await handle_worldlabs_environment(
            node,
            {"prompt": _port("this prompt must not start another world")},
            API_KEYS,
        )

    assert start_route.call_count == 0
    assert poll_route.call_count == 1
    assert outputs["world"]["value"]["worldId"] == "world-123"
    assert "resume_operation_id" not in node.params
    assert node.params["existing_world_id"] == "world-123"


@pytest.mark.asyncio
@respx.mock
async def test_existing_world_recovery_skips_generate_and_operation_poll(
    tmp_path: Path,
) -> None:
    start_route = respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        return_value=httpx.Response(500)
    )
    world_route = respx.get(f"{WORLDLABS_API_BASE}/worlds/world-123").mock(
        return_value=httpx.Response(200, json={"world": _complete_world()})
    )
    _mock_world_assets()

    with patch("handlers.worldlabs.get_run_dir", return_value=tmp_path):
        node = _node(params={"existing_world_id": "world-123"})
        outputs = await handle_worldlabs_environment(
            node,
            {},
            API_KEYS,
        )

    assert start_route.call_count == 0
    assert world_route.call_count == 1
    assert not any("/operations/" in str(call.request.url) for call in respx.calls)
    assert outputs["world"]["value"]["promptType"] == "existing-world"
    assert "resume_operation_id" not in node.params
    assert node.params["existing_world_id"] == "world-123"


@pytest.mark.asyncio
@respx.mock
async def test_existing_world_recovery_keeps_id_when_retrieval_fails() -> None:
    respx.get(f"{WORLDLABS_API_BASE}/worlds/world-123").mock(
        return_value=httpx.Response(503, content=b"temporarily unavailable")
    )
    node = _node(params={"existing_world_id": "world-123"})

    with pytest.raises(RuntimeError, match="existing_world_id=world-123"):
        await handle_worldlabs_environment(node, {}, API_KEYS)

    assert node.params["existing_world_id"] == "world-123"
    assert "resume_operation_id" not in node.params


@pytest.mark.asyncio
async def test_recovery_parameters_are_mutually_exclusive() -> None:
    with pytest.raises(ValueError, match="not both"):
        await handle_worldlabs_environment(
            _node(
                params={
                    "resume_operation_id": "operation-1",
                    "existing_world_id": "world-1",
                }
            ),
            {},
            API_KEYS,
        )


@pytest.mark.asyncio
@respx.mock
async def test_post_accept_generation_failure_preserves_recovery_ids(
    tmp_path: Path,
) -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": "paid-operation-7",
                "done": True,
                "response": {"world_id": "paid-world-9"},
            },
        )
    )
    world = _complete_world("paid-world-9")
    world["assets"] = {
        "splats": {
            "spz_urls": {"100k": "https://assets.worldlabs.test/not-an-spz"}
        }
    }
    respx.get(f"{WORLDLABS_API_BASE}/worlds/paid-world-9").mock(
        return_value=httpx.Response(200, json={"world": world})
    )
    respx.get("https://assets.worldlabs.test/not-an-spz").mock(
        return_value=httpx.Response(200, content=b"<html>upstream error</html>")
    )

    node = _node()
    with patch("handlers.worldlabs.get_run_dir", return_value=tmp_path):
        with pytest.raises(RuntimeError) as caught:
            await handle_worldlabs_environment(
                node, {"prompt": _port("paid request")}, API_KEYS
            )

    message = str(caught.value)
    assert "operationId=paid-operation-7" in message
    assert "worldId=paid-world-9" in message
    assert "existing_world_id=paid-world-9" in message
    assert "do not blindly rerun" in message
    assert "Check World Labs Marble" in message
    assert node.params["existing_world_id"] == "paid-world-9"
    assert "resume_operation_id" not in node.params
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@respx.mock
async def test_poll_transport_failure_preserves_operation_id() -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        return_value=httpx.Response(
            200,
            json={"operation_id": "paid-operation-transport", "done": False},
        )
    )
    respx.get(
        f"{WORLDLABS_API_BASE}/operations/paid-operation-transport"
    ).mock(side_effect=httpx.ConnectError("connection lost"))

    node = _node()
    with patch("handlers.worldlabs.asyncio.sleep", new_callable=AsyncMock):
        with pytest.raises(RuntimeError) as caught:
            await handle_worldlabs_environment(
                node, {"prompt": _port("paid request")}, API_KEYS
            )

    message = str(caught.value)
    assert "operationId=paid-operation-transport" in message
    assert "resume_operation_id=paid-operation-transport" in message
    assert "do not blindly rerun" in message
    assert node.params["resume_operation_id"] == "paid-operation-transport"
    assert "existing_world_id" not in node.params


@pytest.mark.asyncio
@respx.mock
async def test_loopback_output_url_uses_raw_upload_with_content_length(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.png"
    source.write_bytes(PNG)
    captured: dict[str, Any] = {}

    respx.post(f"{WORLDLABS_API_BASE}/media-assets:prepare_upload").mock(
        return_value=httpx.Response(
            200,
            json={
                "media_asset": {"id": "asset-1"},
                "upload_info": {
                    "upload_url": "https://uploads.worldlabs.test/signed",
                    "upload_method": "PUT",
                    "required_headers": {"x-goog-content-length-range": "0,1048576000"},
                },
            },
        )
    )

    async def capture_upload(request: httpx.Request) -> httpx.Response:
        captured["bytes"] = await request.aread()
        captured["headers"] = dict(request.headers)
        return httpx.Response(200)

    upload_route = respx.put("https://uploads.worldlabs.test/signed").mock(
        side_effect=capture_upload
    )

    with patch(
        "handlers.worldlabs.resolve_output_ref",
        side_effect=lambda value: str(source)
        if value == "/api/outputs/run/source.png"
        else value,
    ):
        async with httpx.AsyncClient() as client:
            result = await _content_reference(
                client,
                "http://127.0.0.1:5173/api/outputs/run/source.png?cache=1",
                "image",
                _api_headers("test-key"),
            )

    assert result == {"source": "media_asset", "media_asset_id": "asset-1"}
    assert upload_route.call_count == 1
    assert captured["bytes"] == PNG
    assert captured["headers"]["content-length"] == str(len(PNG))
    assert captured["headers"]["x-goog-content-length-range"] == "0,1048576000"
    assert "transfer-encoding" not in captured["headers"]


@pytest.mark.asyncio
async def test_external_public_url_remains_a_uri_without_upload() -> None:
    client = AsyncMock()
    result = await _content_reference(
        client,
        "https://public.example/world-input.jpg",
        "image",
        _api_headers("test-key"),
    )
    assert result == {
        "source": "uri",
        "uri": "https://public.example/world-input.jpg",
    }
    client.post.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("inputs", "params", "expected"),
    [
        (
            {"prompt": _port("a canyon")},
            {},
            {"type": "text", "text_prompt": "a canyon"},
        ),
        (
            {"prompt": _port("guidance"), "images": _port("image-one", "Image")},
            {"is_pano": "true"},
            {
                "type": "image",
                "image_prompt": {"source": "media_asset", "media_asset_id": "image-one"},
                "is_pano": True,
                "text_prompt": "guidance",
            },
        ),
        (
            {"images": _port(["one", "two"], "Image")},
            {"reconstruct_images": True, "azimuths": "0, 180"},
            {
                "type": "multi-image",
                "multi_image_prompt": [
                    {
                        "content": {"source": "media_asset", "media_asset_id": "one"},
                        "azimuth": 0.0,
                    },
                    {
                        "content": {"source": "media_asset", "media_asset_id": "two"},
                        "azimuth": 180.0,
                    },
                ],
                "reconstruct_images": True,
            },
        ),
        (
            {"prompt": _port("guidance"), "video": _port("clip", "Video")},
            {"disable_recaption": True},
            {
                "type": "video",
                "video_prompt": {"source": "media_asset", "media_asset_id": "clip"},
                "text_prompt": "guidance",
                "disable_recaption": True,
            },
        ),
    ],
)
async def test_prompt_modes_match_public_marble_discriminated_contract(
    inputs: dict[str, PortValueDict],
    params: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    async def fake_reference(_client: Any, value: Any, _kind: str, _headers: Any):
        return {"source": "media_asset", "media_asset_id": str(value)}

    with patch("handlers.worldlabs._content_reference", side_effect=fake_reference):
        prompt, prompt_type = await _build_world_prompt(
            AsyncMock(), _node(params=params), inputs, _api_headers("test-key")
        )

    assert prompt == expected
    assert prompt_type == expected["type"]


@pytest.mark.asyncio
async def test_rejects_ambiguous_image_and_video_inputs() -> None:
    with pytest.raises(ValueError, match="not both"):
        await _build_world_prompt(
            AsyncMock(),
            _node(),
            {
                "images": _port(["one"], "Image"),
                "video": _port("clip", "Video"),
            },
            _api_headers("test-key"),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("params", "expected_body", "bytes_out"),
    [
        (
            {"format": "ply", "resolution": "150k"},
            {"asset_type": "splats", "format": "ply", "resolution": "150k"},
            PLY,
        ),
        (
            {"format": "glb", "mesh_variant": "vertex_colored"},
            {"asset_type": "mesh", "format": "glb", "mesh_variant": "vertex_colored"},
            GLB,
        ),
    ],
)
@respx.mock
async def test_export_materializes_ply_and_glb(
    tmp_path: Path,
    params: dict[str, Any],
    expected_body: dict[str, Any],
    bytes_out: bytes,
) -> None:
    output_format = str(params["format"])
    captured: dict[str, Any] = {}

    def capture_export(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "operation_id": f"export-{output_format}",
                "done": True,
                "response": {
                    "asset_type": expected_body["asset_type"],
                    "format": output_format,
                    "url": f"https://assets.worldlabs.test/export.{output_format}?signed=1",
                },
            },
        )

    respx.post(f"{WORLDLABS_API_BASE}/worlds/world-123:export").mock(
        side_effect=capture_export
    )
    respx.get(
        f"https://assets.worldlabs.test/export.{output_format}?signed=1"
    ).mock(return_value=httpx.Response(200, content=bytes_out))

    node = _node(
        "worldlabs-world-export",
        params,
        node_id=f"export-node-{output_format}",
    )
    with patch("handlers.worldlabs.get_run_dir", return_value=tmp_path):
        outputs = await handle_worldlabs_export(
            node,
            {
                "world": _port(
                    {
                        "schemaVersion": 1,
                        "provider": "worldlabs",
                        "worldId": "world-123",
                    },
                    "World",
                )
            },
            API_KEYS,
        )

    assert captured["body"] == expected_body
    path = Path(outputs["file"]["value"])
    assert path.is_file()
    assert path.read_bytes() == bytes_out
    assert f"export-node-{output_format}" in path.name
    assert outputs["file"]["type"] == "Mesh"
    assert outputs["format"] == {"type": "Text", "value": output_format}
    assert node.params["resume_operation_id"] == f"export-{output_format}"


def test_export_rejects_self_declared_world_v2_marble_provenance() -> None:
    world = _world_v2()

    with pytest.raises(ValueError, match="verified provider-resource binding"):
        _validated_world_input({"world": _port(world, "World")})


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("fixture", "marble-1.1"),
        ("worldlabs", "atlas"),
        ("worldlabs", "marble-1.1"),
    ],
)
async def test_export_rejects_foreign_or_claimed_atlas_world_v2_before_http(
    provider: str,
    model: str,
) -> None:
    with pytest.raises(ValueError, match="verified provider-resource binding"):
        await handle_worldlabs_export(
            _node("worldlabs-world-export", {"format": "ply"}),
            {"world": _port(_world_v2(provider=provider, model=model), "World")},
            API_KEYS,
        )

    assert len(respx.calls) == 0


@pytest.mark.asyncio
@respx.mock
async def test_resume_export_operation_skips_paid_post(tmp_path: Path) -> None:
    export_route = respx.post(
        f"{WORLDLABS_API_BASE}/worlds/world-123:export"
    ).mock(return_value=httpx.Response(500))
    poll_route = respx.get(
        f"{WORLDLABS_API_BASE}/operations/export-recovery"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": "export-recovery",
                "done": True,
                "response": {
                    "asset_type": "splats",
                    "format": "ply",
                    "resolution": "full_res",
                    "url": "https://assets.worldlabs.test/recovered.ply",
                },
            },
        )
    )
    respx.get("https://assets.worldlabs.test/recovered.ply").mock(
        return_value=httpx.Response(200, content=PLY)
    )

    with (
        patch("handlers.worldlabs.get_run_dir", return_value=tmp_path),
        patch("handlers.worldlabs.asyncio.sleep", new_callable=AsyncMock),
    ):
        node = _node(
            "worldlabs-world-export",
            {"format": "ply", "resume_operation_id": "export-recovery"},
            node_id="export-resume-node",
        )
        outputs = await handle_worldlabs_export(
            node,
            {
                "world": _port(
                    {
                        "schemaVersion": 1,
                        "provider": "worldlabs",
                        "worldId": "world-123",
                    },
                    "World",
                )
            },
            API_KEYS,
        )

    assert export_route.call_count == 0
    assert poll_route.call_count == 1
    assert Path(outputs["file"]["value"]).read_bytes() == PLY
    assert node.params["resume_operation_id"] == "export-recovery"


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize(
    ("params", "response_fields", "message"),
    [
        (
            {"format": "ply", "resolution": "100k"},
            {"asset_type": "splats", "format": "ply", "resolution": "500k"},
            "result resolution does not match",
        ),
        (
            {"format": "glb", "mesh_variant": "vertex_colored"},
            {"asset_type": "mesh", "format": "glb", "mesh_variant": "textured"},
            "result mesh variant does not match",
        ),
    ],
)
async def test_resume_export_rejects_conflicting_provider_setting(
    tmp_path: Path,
    params: dict[str, Any],
    response_fields: dict[str, Any],
    message: str,
) -> None:
    operation_id = "export-setting-recovery"
    download_url = "https://assets.worldlabs.test/wrong-setting.bin"
    respx.get(f"{WORLDLABS_API_BASE}/operations/{operation_id}").mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": operation_id,
                "done": True,
                "response": {**response_fields, "url": download_url},
            },
        )
    )
    download_route = respx.get(download_url).mock(
        return_value=httpx.Response(200, content=b"must-not-download")
    )
    node = _node(
        "worldlabs-world-export",
        {**params, "resume_operation_id": operation_id},
        node_id="export-setting-mismatch",
    )

    with (
        patch("handlers.worldlabs.get_run_dir", return_value=tmp_path),
        patch("handlers.worldlabs.asyncio.sleep", new_callable=AsyncMock),
        pytest.raises(RuntimeError, match=message),
    ):
        await handle_worldlabs_export(
            node,
            {
                "world": _port(
                    {
                        "schemaVersion": 1,
                        "provider": "worldlabs",
                        "worldId": "world-123",
                    },
                    "World",
                )
            },
            API_KEYS,
        )

    assert download_route.call_count == 0
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@respx.mock
async def test_export_filenames_bound_long_components_and_resist_sanitized_collisions(
    tmp_path: Path,
) -> None:
    start_route = respx.post(
        f"{WORLDLABS_API_BASE}/worlds/world-123:export"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": "export-operation",
                "done": True,
                "response": {
                    "asset_type": "splats",
                    "format": "ply",
                    "url": "https://assets.worldlabs.test/bounded-export.ply",
                },
            },
        )
    )
    respx.get("https://assets.worldlabs.test/bounded-export.ply").mock(
        return_value=httpx.Response(200, content=PLY)
    )
    world_input = {
        "world": _port(
            {
                "schemaVersion": 1,
                "provider": "worldlabs",
                "worldId": "world-123",
            },
            "World",
        )
    }

    with patch("handlers.worldlabs.get_run_dir", return_value=tmp_path):
        first, second = await asyncio.gather(
            handle_worldlabs_export(
                _node(
                    "worldlabs-world-export",
                    {"format": "ply"},
                    node_id="node/" + "n" * 1000,
                ),
                world_input,
                API_KEYS,
            ),
            handle_worldlabs_export(
                _node(
                    "worldlabs-world-export",
                    {"format": "ply"},
                    node_id="node?" + "n" * 1000,
                ),
                world_input,
                API_KEYS,
            ),
        )

    first_path = Path(first["file"]["value"])
    second_path = Path(second["file"]["value"])
    assert start_route.call_count == 2
    assert first_path != second_path
    assert len(first_path.name.encode("utf-8")) <= 240
    assert len(second_path.name.encode("utf-8")) <= 240
    assert first_path.read_bytes() == second_path.read_bytes() == PLY


@pytest.mark.asyncio
@respx.mock
async def test_post_accept_export_failure_preserves_operation_and_world_ids(
    tmp_path: Path,
) -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds/world-123:export").mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": "paid-export-3",
                "done": True,
                "response": {
                    "asset_type": "mesh",
                    "format": "glb",
                    "url": "https://assets.worldlabs.test/export-error.glb",
                },
            },
        )
    )
    respx.get("https://assets.worldlabs.test/export-error.glb").mock(
        return_value=httpx.Response(200, content=b"<?xml version='1.0'?><Error/>")
    )

    node = _node(
        "worldlabs-world-export",
        {"format": "glb"},
        node_id="export-failure-node",
    )
    with patch("handlers.worldlabs.get_run_dir", return_value=tmp_path):
        with pytest.raises(RuntimeError) as caught:
            await handle_worldlabs_export(
                node,
                {
                    "world": _port(
                        {
                            "schemaVersion": 1,
                            "provider": "worldlabs",
                            "worldId": "world-123",
                        },
                        "World",
                    )
                },
                API_KEYS,
            )

    message = str(caught.value)
    assert "operationId=paid-export-3" in message
    assert "worldId=world-123" in message
    assert "resume_operation_id=paid-export-3" in message
    assert "do not blindly rerun" in message
    assert node.params["resume_operation_id"] == "paid-export-3"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "world_value",
    [
        {"provider": "worldlabs", "worldId": "world-123"},
        {"schemaVersion": 1, "worldId": "world-123"},
        {"schemaVersion": 1, "provider": "other", "worldId": "world-123"},
    ],
)
async def test_export_rejects_unversioned_or_foreign_world_values(
    world_value: dict[str, Any],
) -> None:
    with pytest.raises(ValueError, match="World Labs Export"):
        await handle_worldlabs_export(
            _node("worldlabs-world-export"),
            {"world": _port(world_value, "World")},
            API_KEYS,
        )


@pytest.mark.asyncio
@respx.mock
async def test_streamed_asset_error_has_bounded_readable_message(tmp_path: Path) -> None:
    respx.get("https://assets.worldlabs.test/broken").mock(
        return_value=httpx.Response(503, content=b"temporary upstream failure" + b"x" * 5000)
    )
    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError) as caught:
            await _download_asset(
                client, "https://assets.worldlabs.test/broken", tmp_path / "broken.spz"
            )
    message = str(caught.value)
    assert "503" in message
    assert "temporary upstream failure" in message
    assert len(message) < 1200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unsafe_url",
    [
        "http://assets.worldlabs.test/plaintext.png",
        "https://user:secret@assets.worldlabs.test/credential.png",
        "https://127.0.0.1/private.png",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/private.png",
    ],
)
async def test_asset_download_rejects_unsafe_or_nonpublic_urls_before_request(
    tmp_path: Path, unsafe_url: str
) -> None:
    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="unsafe|non-public"):
            await _download_asset(client, unsafe_url, tmp_path / "asset.png")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@respx.mock
async def test_asset_download_validates_redirect_target_before_following(
    tmp_path: Path,
) -> None:
    first = respx.get("https://assets.worldlabs.test/start.png").mock(
        return_value=httpx.Response(
            302,
            headers={"location": "https://127.0.0.1/private.png"},
        )
    )
    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="non-public"):
            await _download_asset(
                client,
                "https://assets.worldlabs.test/start.png",
                tmp_path / "asset.png",
            )
    assert first.call_count == 1
    assert len(respx.calls) == 1
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_asset_download_rejects_dns_name_with_private_resolution(
    tmp_path: Path,
) -> None:
    async def private_addresses(_hostname: str, _port: int):
        return {ipaddress.ip_address("10.0.0.7")}

    async with httpx.AsyncClient() as client:
        with (
            patch(
                "handlers.worldlabs._resolve_host_addresses",
                side_effect=private_addresses,
            ),
            pytest.raises(RuntimeError, match="non-public"),
        ):
            await _download_asset(
                client,
                "https://internal.example/asset.png",
                tmp_path / "asset.png",
            )
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@respx.mock
async def test_media_upload_rejects_provider_private_target_without_exfiltration(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.png"
    source.write_bytes(PNG)
    respx.post(f"{WORLDLABS_API_BASE}/media-assets:prepare_upload").mock(
        return_value=httpx.Response(
            200,
            json={
                "media_asset": {"id": "asset-private"},
                "upload_info": {
                    "upload_method": "PUT",
                    "upload_url": "https://127.0.0.1/private-upload",
                    "required_headers": {},
                },
            },
        )
    )

    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="non-public"):
            await _upload_local_media(client, source, "image", _api_headers("key"))

    assert len(respx.calls) == 1
    assert not (tmp_path / "broken.spz").exists()
    assert not (tmp_path / ".broken.spz.part").exists()


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize(
    ("filename", "payload", "message"),
    [
        ("panorama.png", b"<html>not an image</html>", "non-image bytes"),
        ("collider.glb", b"<?xml version='1.0'?><Error/>", "invalid GLB"),
        ("preview.spz", b"<html>not a splat</html>", "invalid SPZ"),
        ("export.ply", b"<Error>not a mesh</Error>", "PLY header"),
    ],
)
async def test_asset_download_rejects_200_error_documents_atomically(
    tmp_path: Path,
    filename: str,
    payload: bytes,
    message: str,
) -> None:
    destination = tmp_path / filename
    url = f"https://assets.worldlabs.test/{filename}"
    respx.get(url).mock(return_value=httpx.Response(200, content=payload))

    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match=message):
            await _download_asset(client, url, destination)

    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize(
    ("filename", "payload"),
    [
        ("huge.png", _png_header(32_769, 1)),
        ("huge-pixels.png", _png_header(16_384, 16_384)),
        ("huge.gif", b"GIF89a" + struct.pack("<HH", 65_535, 1)),
        ("huge.jpg", _jpeg_header(32_769, 1)),
        (
            "huge.webp",
            b"RIFF"
            + b"\0\0\0\0"
            + b"WEBPVP8X"
            + b"\x0a\0\0\0"
            + b"\0\0\0\0"
            + (32_768).to_bytes(3, "little")
            + (0).to_bytes(3, "little"),
        ),
    ],
)
async def test_asset_download_rejects_hostile_image_dimensions_before_install(
    tmp_path: Path, filename: str, payload: bytes,
) -> None:
    destination = tmp_path / filename
    url = f"https://assets.worldlabs.test/{filename}"
    respx.get(url).mock(return_value=httpx.Response(200, content=payload))

    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="unsafe image dimensions"):
            await _download_asset(client, url, destination)

    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@respx.mock
async def test_asset_download_accepts_vp8l_alpha_bit_without_inflating_height(
    tmp_path: Path,
) -> None:
    # VP8L packs alpha/version above its 14-bit height. Those bits must not be
    # interpreted as dimensions by the browser-safety preflight.
    dimensions = 1 << 28  # width=1, height=1, alpha_is_used=1, version=0
    payload = (
        b"RIFF"
        + b"\0\0\0\0"
        + b"WEBPVP8L"
        + b"\x05\0\0\0"
        + b"\x2f"
        + dimensions.to_bytes(4, "little")
    )
    destination = tmp_path / "alpha.webp"
    url = "https://assets.worldlabs.test/alpha.webp"
    respx.get(url).mock(return_value=httpx.Response(200, content=payload))

    async with httpx.AsyncClient() as client:
        installed = await _download_asset(client, url, destination)

    assert installed == destination
    assert installed.read_bytes() == payload


@pytest.mark.asyncio
@respx.mock
async def test_asset_download_accepts_spark_lod_spz_and_validates_entire_gzip(
    tmp_path: Path,
) -> None:
    payload = _spz_bytes(version=3, point_count=2, sh_degree=3, flags=0x81)
    destination = tmp_path / "lod.spz"
    respx.get("https://assets.worldlabs.test/lod.spz").mock(
        return_value=httpx.Response(200, content=payload)
    )

    async with httpx.AsyncClient() as client:
        path = await _download_asset(
            client, "https://assets.worldlabs.test/lod.spz", destination
        )

    assert path == destination
    assert path.read_bytes() == payload


@pytest.mark.asyncio
@respx.mock
async def test_asset_download_rejects_spz_forged_point_count_and_truncation(
    tmp_path: Path,
) -> None:
    forged = gzip.compress(
        struct.pack("<III4B", 0x5053474E, 3, 0xFFFFFFFF, 0, 12, 0, 0)
    )
    destination = tmp_path / "forged.spz"
    respx.get("https://assets.worldlabs.test/forged.spz").mock(
        return_value=httpx.Response(200, content=forged)
    )

    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="safe limit"):
            await _download_asset(
                client, "https://assets.worldlabs.test/forged.spz", destination
            )

    corrupt = bytearray(SPZ)
    corrupt[-8] ^= 0xFF  # gzip CRC32 trailer
    respx.get("https://assets.worldlabs.test/corrupt.spz").mock(
        return_value=httpx.Response(200, content=bytes(corrupt))
    )
    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="malformed SPZ gzip"):
            await _download_asset(
                client,
                "https://assets.worldlabs.test/corrupt.spz",
                tmp_path / "corrupt.spz",
            )

    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@respx.mock
async def test_asset_download_rejects_spz_fractional_bits_spark_cannot_render(
    tmp_path: Path,
) -> None:
    payload = _spz_bytes(fractional_bits=24)
    destination = tmp_path / "bad-fractional-bits.spz"
    respx.get("https://assets.worldlabs.test/bad-fractional-bits.spz").mock(
        return_value=httpx.Response(200, content=payload)
    )

    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="malformed SPZ header"):
            await _download_asset(
                client,
                "https://assets.worldlabs.test/bad-fractional-bits.spz",
                destination,
            )

    assert list(tmp_path.iterdir()) == []


def test_data_uri_preflight_rejects_oversize_before_decoding() -> None:
    with (
        patch("handlers.worldlabs._MAX_INLINE_BYTES", 3),
        patch("handlers.worldlabs.base64.b64decode") as decode_base64,
        patch("handlers.worldlabs.unquote_to_bytes") as decode_percent,
    ):
        with pytest.raises(ValueError, match="10 MB"):
            _data_uri_reference("data:image/png;base64," + "A" * 9, "image")
        decode_base64.assert_not_called()

        with pytest.raises(ValueError, match="10 MB"):
            _data_uri_reference("data:image/png," + "%41" * 4, "image")
        decode_percent.assert_not_called()


@pytest.mark.asyncio
@respx.mock
async def test_asset_download_rejects_declared_oversize_before_writing(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "declared-too-large.spz"
    respx.get("https://assets.worldlabs.test/declared-too-large").mock(
        return_value=httpx.Response(200, headers={"Content-Length": "9"}, content=b"x")
    )

    with patch("handlers.worldlabs._MAX_ASSET_DOWNLOAD_BYTES", 8):
        async with httpx.AsyncClient() as client:
            with pytest.raises(RuntimeError, match="download limit"):
                await _download_asset(
                    client,
                    "https://assets.worldlabs.test/declared-too-large",
                    destination,
                )

    assert not destination.exists()
    assert not (tmp_path / ".declared-too-large.spz.part").exists()


@pytest.mark.asyncio
@respx.mock
async def test_asset_download_rejects_undeclared_stream_oversize_and_cleans_partial(
    tmp_path: Path,
) -> None:
    class OversizeStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"12345"
            yield b"6789"

    destination = tmp_path / "stream-too-large.spz"
    respx.get("https://assets.worldlabs.test/stream-too-large").mock(
        return_value=httpx.Response(200, stream=OversizeStream())
    )

    with patch("handlers.worldlabs._MAX_ASSET_DOWNLOAD_BYTES", 8):
        async with httpx.AsyncClient() as client:
            with pytest.raises(RuntimeError, match="download limit"):
                await _download_asset(
                    client,
                    "https://assets.worldlabs.test/stream-too-large",
                    destination,
                )

    assert not destination.exists()
    assert not (tmp_path / ".stream-too-large.spz.part").exists()


@pytest.mark.asyncio
async def test_asset_failure_cleans_all_prior_files_under_sequential_budget(
    tmp_path: Path,
) -> None:
    async def fake_download(
        _client: Any,
        url: str,
        destination: Path,
        *,
        max_bytes: int | None = None,
    ) -> Path:
        assert max_bytes is not None
        if url.endswith("slow"):
            destination.write_bytes(SPZ)
            return destination
        if url.endswith("pano"):
            renamed = destination.with_suffix(".jpg")
            renamed.write_bytes(JPEG)
            return renamed
        if url.endswith("thumb"):
            raise RuntimeError("download failed")
        raise AssertionError(f"unexpected URL: {url}")

    world = {
        "id": "cleanup-world",
        "assets": {
            "splats": {"spz_urls": {"100k": "https://asset/slow"}},
            "imagery": {"pano_url": "https://asset/pano"},
            "thumbnail_url": "https://asset/thumb",
        },
    }
    with patch("handlers.worldlabs._download_asset", side_effect=fake_download):
        with pytest.raises(RuntimeError, match="download failed"):
            await _materialize_world(
                AsyncMock(),
                world,
                "text",
                {"done": True},
                tmp_path,
                requested_model="marble-1.1",
                node_id="cleanup-node",
            )

    assert list(tmp_path.iterdir()) == [], "original, partial, and renamed assets must be cleaned"


@pytest.mark.asyncio
async def test_variant_flood_is_rejected_before_any_download(tmp_path: Path) -> None:
    world = {
        "id": "variant-flood",
        "assets": {
            "splats": {
                "spz_urls": {
                    f"future-{index}": f"https://asset/{index}"
                    for index in range(17)
                }
            }
        },
    }
    with patch("handlers.worldlabs._download_asset", new_callable=AsyncMock) as download:
        with pytest.raises(RuntimeError, match="too many SPZ variants"):
            await _materialize_world(
                AsyncMock(),
                world,
                "text",
                {"done": True},
                tmp_path,
                requested_model="marble-1.1",
                node_id="variant-flood-node",
            )

    download.assert_not_awaited()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_aggregate_world_download_budget_cleans_every_asset(tmp_path: Path) -> None:
    observed_budgets: list[int | None] = []

    async def fake_download(
        _client: Any,
        _url: str,
        destination: Path,
        *,
        max_bytes: int | None = None,
    ) -> Path:
        observed_budgets.append(max_bytes)
        destination.write_bytes(b"four")
        return destination

    world = {
        "id": "aggregate-world",
        "assets": {
            "splats": {
                "spz_urls": {
                    "100k": "https://asset/one",
                    "500k": "https://asset/two",
                }
            }
        },
    }
    with (
        patch("handlers.worldlabs._MAX_WORLD_ASSET_BYTES", 6),
        patch("handlers.worldlabs._download_asset", side_effect=fake_download),
    ):
        with pytest.raises(RuntimeError, match="aggregate download limit"):
            await _materialize_world(
                AsyncMock(),
                world,
                "text",
                {"done": True},
                tmp_path,
                requested_model="marble-1.1",
                node_id="aggregate-node",
            )

    assert observed_budgets == [6, 2]
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_world_without_spz_cleans_successful_auxiliary_downloads(
    tmp_path: Path,
) -> None:
    async def fake_download(
        _client: Any,
        url: str,
        destination: Path,
        *,
        max_bytes: int | None = None,
    ) -> Path:
        assert max_bytes is not None
        if url.endswith("pano"):
            renamed = destination.with_suffix(".jpg")
            renamed.write_bytes(JPEG)
            return renamed
        destination.write_bytes(GLB if url.endswith("collider") else PNG)
        return destination

    world = {
        "id": "no-splat-world",
        "assets": {
            "splats": {"spz_urls": {}},
            "imagery": {"pano_url": "https://asset/pano"},
            "mesh": {"collider_mesh_url": "https://asset/collider"},
            "thumbnail_url": "https://asset/thumb",
        },
    }
    with patch("handlers.worldlabs._download_asset", side_effect=fake_download):
        with pytest.raises(RuntimeError, match="without any SPZ"):
            await _materialize_world(
                AsyncMock(),
                world,
                "text",
                {"done": True},
                tmp_path,
                requested_model="marble-1.1",
                node_id="no-splat-node",
            )

    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_sanitized_future_splat_variants_have_collision_proof_paths(
    tmp_path: Path,
) -> None:
    async def fake_download(
        _client: Any,
        _url: str,
        destination: Path,
        *,
        max_bytes: int | None = None,
    ) -> Path:
        assert max_bytes is not None
        destination.write_bytes(SPZ)
        return destination

    world = {
        "id": "variant-world",
        "assets": {
            "splats": {
                "spz_urls": {
                    "future/a": "https://asset/one",
                    "future?a": "https://asset/two",
                }
            }
        },
    }
    with patch("handlers.worldlabs._download_asset", side_effect=fake_download):
        value, _materialized = await _materialize_world(
            AsyncMock(),
            world,
            "text",
            {"done": True},
            tmp_path,
            requested_model="marble-1.1",
            node_id="variant-node",
        )

    paths = list(value["assets"]["splats"].values())
    assert set(value["assets"]["splats"]) == {"future/a", "future?a"}
    assert len(set(paths)) == 2
    assert all(Path(path).is_file() for path in paths)


@pytest.mark.asyncio
async def test_concurrent_same_world_nodes_use_disjoint_asset_paths(
    tmp_path: Path,
) -> None:
    async def fake_download(
        _client: Any,
        _url: str,
        destination: Path,
        *,
        max_bytes: int | None = None,
    ) -> Path:
        assert max_bytes is not None
        await asyncio.sleep(0)
        destination.write_bytes(SPZ)
        return destination

    world = {
        "id": "shared-world",
        "assets": {
            "splats": {"spz_urls": {"100k": "https://asset/shared"}},
        },
    }
    with patch("handlers.worldlabs._download_asset", side_effect=fake_download):
        first, second = await asyncio.gather(
            _materialize_world(
                AsyncMock(),
                world,
                "existing-world",
                {"done": True},
                tmp_path,
                requested_model="marble-1.1",
                node_id="node/a",
            ),
            _materialize_world(
                AsyncMock(),
                world,
                "existing-world",
                {"done": True},
                tmp_path,
                requested_model="marble-1.1",
                node_id="node?a",
            ),
        )

    first_paths = set(first[0]["assets"]["splats"].values())
    second_paths = set(second[0]["assets"]["splats"].values())
    assert first_paths.isdisjoint(second_paths)
    assert all(Path(path).is_file() for path in first_paths | second_paths)


@pytest.mark.asyncio
async def test_long_world_node_and_variant_names_stay_below_name_max(
    tmp_path: Path,
) -> None:
    async def fake_download(
        _client: Any,
        _url: str,
        destination: Path,
        *,
        max_bytes: int | None = None,
    ) -> Path:
        assert max_bytes is not None
        destination.write_bytes(SPZ)
        return destination

    world = {
        "id": "world-" + "w" * 250,
        "assets": {
            "splats": {
                "spz_urls": {"variant/" + "v" * 1000: "https://asset/shared"}
            },
        },
    }
    with patch("handlers.worldlabs._download_asset", side_effect=fake_download):
        value, _materialized = await _materialize_world(
            AsyncMock(),
            world,
            "text",
            {"done": True},
            tmp_path,
            requested_model="marble-1.1",
            node_id="node/" + "n" * 1000,
        )

    [path_value] = value["assets"]["splats"].values()
    assert len(Path(path_value).name.encode("utf-8")) <= 240
    assert Path(path_value).is_file()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("metric_scale", "ground_offset"),
    [
        (0.0, float("nan")),
        (-1.0, float("inf")),
        (float("nan"), float("-inf")),
    ],
)
async def test_nonfinite_or_nonpositive_world_semantics_are_not_emitted(
    tmp_path: Path,
    metric_scale: float,
    ground_offset: float,
) -> None:
    async def fake_download(
        _client: Any,
        _url: str,
        destination: Path,
        *,
        max_bytes: int | None = None,
    ) -> Path:
        assert max_bytes is not None
        destination.write_bytes(SPZ)
        return destination

    world = {
        "id": "bad-semantics",
        "assets": {
            "splats": {
                "spz_urls": {"100k": "https://asset/shared"},
                "semantics_metadata": {
                    "metric_scale_factor": metric_scale,
                    "ground_plane_offset": ground_offset,
                },
            },
        },
    }
    with patch("handlers.worldlabs._download_asset", side_effect=fake_download):
        value, _materialized = await _materialize_world(
            AsyncMock(),
            world,
            "text",
            {"done": True},
            tmp_path,
            requested_model="marble-1.1",
            node_id="semantics-node",
        )

    assert value["semantics"]["metricScaleFactor"] is None
    assert value["semantics"]["groundPlaneOffset"] is None


@pytest.mark.asyncio
@respx.mock
async def test_stop_during_paid_post_settles_response_and_publishes_recovery_id() -> None:
    request_started = asyncio.Event()
    release_response = asyncio.Event()
    emitted: list[Any] = []

    async def delayed_start(_request: httpx.Request) -> httpx.Response:
        request_started.set()
        await release_response.wait()
        return httpx.Response(
            200,
            json={"operation_id": "paid-handshake-operation", "done": False},
        )

    async def emit(event: Any) -> None:
        emitted.append(event)

    start_route = respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        side_effect=delayed_start
    )
    node = _node()
    task = asyncio.create_task(
        handle_worldlabs_environment(
            node,
            {"prompt": _port("a place")},
            API_KEYS,
            emit=emit,
        )
    )
    await asyncio.wait_for(request_started.wait(), timeout=1)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done(), "Stop must settle an in-flight paid POST handshake"

    release_response.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert start_route.call_count == 1
    assert len(respx.calls) == 1, "captured cancellation must not start or poll again"
    assert node.params["resume_operation_id"] == "paid-handshake-operation"
    assert "existing_world_id" not in node.params
    recovery_events = [
        event for event in emitted if isinstance(event, ProviderRecoveryEvent)
    ]
    assert len(recovery_events) == 1
    assert recovery_events[0].resume_operation_id == "paid-handshake-operation"
    assert recovery_events[0].existing_world_id is None


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize("settled_response", ["http-500", "malformed-200"])
async def test_stop_during_paid_post_remains_cancelled_when_response_fails(
    settled_response: str,
) -> None:
    request_started = asyncio.Event()
    release_response = asyncio.Event()

    async def delayed_start(_request: httpx.Request) -> httpx.Response:
        request_started.set()
        await release_response.wait()
        if settled_response == "http-500":
            return httpx.Response(500, text="provider failed")
        return httpx.Response(200, content=b"not-json")

    start_route = respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        side_effect=delayed_start
    )
    node = _node()
    task = asyncio.create_task(
        handle_worldlabs_environment(node, {"prompt": _port("a place")}, API_KEYS)
    )
    await asyncio.wait_for(request_started.wait(), timeout=1)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()

    release_response.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert start_route.call_count == 1
    assert len(respx.calls) == 1
    assert "resume_operation_id" not in node.params
    assert "existing_world_id" not in node.params


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize("kind", ["environment", "glb-export"])
@pytest.mark.parametrize("status_code", [307, 308, 408])
async def test_uncertain_provider_status_creates_paid_start_ambiguity(
    kind: str,
    status_code: int,
) -> None:
    emitted: list[Any] = []

    async def emit(event: Any) -> None:
        emitted.append(event)

    if kind == "environment":
        route = respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
            return_value=httpx.Response(status_code, text="uncertain response")
        )
        with pytest.raises(RuntimeError, match=str(status_code)):
            await handle_worldlabs_environment(
                _node(), {"prompt": _port("a place")}, API_KEYS, emit=emit
            )
        expected_kind = "worldlabs-environment"
    else:
        route = respx.post(
            f"{WORLDLABS_API_BASE}/worlds/world-123:export"
        ).mock(return_value=httpx.Response(status_code, text="uncertain response"))
        with pytest.raises(RuntimeError, match=str(status_code)):
            await handle_worldlabs_export(
                _node(
                    "worldlabs-world-export",
                    {"format": "glb"},
                    node_id="export-node",
                ),
                {
                    "world": _port(
                        {
                            "schemaVersion": 1,
                            "provider": "worldlabs",
                            "worldId": "world-123",
                        },
                        "World",
                    )
                },
                API_KEYS,
                emit=emit,
            )
        expected_kind = "worldlabs-world-export"

    assert route.call_count == 1
    ambiguity_events = [
        event for event in emitted if isinstance(event, ProviderStartAmbiguousEvent)
    ]
    assert len(ambiguity_events) == 1
    assert ambiguity_events[0].kind == expected_kind


@pytest.mark.asyncio
@respx.mock
async def test_free_ply_408_does_not_claim_paid_ambiguity() -> None:
    emitted: list[Any] = []
    async def emit(event: Any) -> None:
        emitted.append(event)

    route = respx.post(
        f"{WORLDLABS_API_BASE}/worlds/world-123:export"
    ).mock(return_value=httpx.Response(408, text="upstream timeout"))

    with pytest.raises(RuntimeError, match="408"):
        await handle_worldlabs_export(
            _node(
                "worldlabs-world-export",
                {"format": "ply"},
                node_id="export-node",
            ),
            {
                "world": _port(
                    {
                        "schemaVersion": 1,
                        "provider": "worldlabs",
                        "worldId": "world-123",
                    },
                    "World",
                )
            },
            API_KEYS,
            emit=emit,
        )

    assert route.call_count == 1
    assert not any(isinstance(event, ProviderStartAmbiguousEvent) for event in emitted)


@pytest.mark.asyncio
@respx.mock
async def test_cancel_stops_local_polling_without_claiming_upstream_cancel(caplog) -> None:
    sleep_started = asyncio.Event()
    never = asyncio.Event()

    async def blocking_sleep(_seconds: float) -> None:
        sleep_started.set()
        await never.wait()

    start_route = respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        return_value=httpx.Response(
            200, json={"operation_id": "paid-operation", "done": False}
        )
    )
    node = _node()
    with patch("handlers.worldlabs.asyncio.sleep", side_effect=blocking_sleep):
        task = asyncio.create_task(
            handle_worldlabs_environment(
                node, {"prompt": _port("a place")}, API_KEYS
            )
        )
        await sleep_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert start_route.call_count == 1
    assert len(respx.calls) == 1, "cancel must not invent DELETE/cancel provider traffic"
    assert "may continue and remain billable" in caplog.text
    assert node.params["resume_operation_id"] == "paid-operation"
    assert "existing_world_id" not in node.params


@pytest.mark.asyncio
@respx.mock
async def test_cancelled_export_preserves_accepted_operation_for_resume(caplog) -> None:
    sleep_started = asyncio.Event()

    async def blocking_sleep(_seconds: float) -> None:
        sleep_started.set()
        await asyncio.Event().wait()

    export_route = respx.post(
        f"{WORLDLABS_API_BASE}/worlds/world-123:export"
    ).mock(
        return_value=httpx.Response(
            200,
            json={"operation_id": "paid-export-operation", "done": False},
        )
    )
    node = _node(
        "worldlabs-world-export",
        {"format": "ply"},
        node_id="cancelled-export-node",
    )
    with patch("handlers.worldlabs.asyncio.sleep", side_effect=blocking_sleep):
        task = asyncio.create_task(
            handle_worldlabs_export(
                node,
                {
                    "world": _port(
                        {
                            "schemaVersion": 1,
                            "provider": "worldlabs",
                            "worldId": "world-123",
                        },
                        "World",
                    )
                },
                API_KEYS,
            )
        )
        await sleep_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert export_route.call_count == 1
    assert len(respx.calls) == 1, "cancel must not invent DELETE/cancel provider traffic"
    assert node.params["resume_operation_id"] == "paid-export-operation"
    assert "may continue and remain billable" in caplog.text


@pytest.mark.asyncio
async def test_missing_key_is_rejected_before_network() -> None:
    with pytest.raises(ValueError, match="WORLDLABS_API_KEY"):
        await handle_worldlabs_environment(
            _node(), {"prompt": _port("a place")}, {}
        )


def test_structured_world_storage_normalization_is_recursive() -> None:
    import main as main_module

    world = {
        "type": "World",
        "value": {
            "schemaVersion": 1,
            "provider": "worldlabs",
            "worldId": "world-123",
            "marbleUrl": "https://marble.worldlabs.ai/world/world-123",
            "assets": {
                "splats": {
                    "100k": "/owned/run/world-100k.spz",
                    "full_res": "/owned/run/world-full.spz",
                },
                "panorama": "/owned/run/world.png",
            },
        },
    }

    def normalize(value: str) -> str | None:
        return (
            f"/api/outputs/run/{Path(value).name}"
            if value.startswith("/owned/run/")
            else None
        )

    with patch.object(main_module, "_output_url_from_ref", side_effect=normalize):
        result = main_module._normalize_output_value_for_storage(world)

    assert result["value"]["assets"]["splats"] == {
        "100k": "/api/outputs/run/world-100k.spz",
        "full_res": "/api/outputs/run/world-full.spz",
    }
    assert result["value"]["assets"]["panorama"] == "/api/outputs/run/world.png"
    assert result["value"]["marbleUrl"] == world["value"]["marbleUrl"]


def test_manifest_collects_nested_world_assets_once(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    splat = run_dir / "world.spz"
    panorama = run_dir / "world.png"
    collider = run_dir / "world.glb"
    thumbnail = run_dir / "thumb.png"
    for path, data in (
        (splat, SPZ),
        (panorama, PNG),
        (collider, GLB),
        (thumbnail, PNG),
    ):
        path.write_bytes(data)

    world_value = {
        "schemaVersion": 1,
        "provider": "worldlabs",
        "worldId": "world-123",
        "assets": {
            "splats": {"100k": str(splat)},
            "panorama": str(panorama),
            "colliderMesh": str(collider),
            "thumbnail": str(thumbnail),
        },
    }
    outputs = {
        "world": PortValueDict(type="World", value=world_value),
        # The handler intentionally exposes panorama separately too. The
        # manifest should list the file once for this node, not once per port.
        "panorama": PortValueDict(type="Image", value=str(panorama)),
    }
    node = _node(params={"model": "marble-1.1"})

    with patch("execution.engine.OUTPUT_ROOT", tmp_path):
        records = _collect_manifest_records(
            {node.id: node}, {node.id: outputs}, [node.id], run_dir
        )

    assert {record["output_path"] for record in records} == {
        "world.spz",
        "world.png",
        "world.glb",
        "thumb.png",
    }
    assert len(records) == 4
