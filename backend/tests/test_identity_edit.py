"""identity-edit node tests.

identity-edit = nano-banana-2/edit + optional Character-bundle identity
preservation. With a Character wired into the `character` port, the handler
folds the bundle through cinema.identity.expand_character: the verbatim trait
string leads the prompt, the bundle's reference views are injected as
additional images behind the base (edit-target) image, the bundle seed pins
determinism when the node seed is unset. Saved strength metadata is retained,
but this endpoint has no native adherence control. Without a Character, the
node is a standard nano-banana edit.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from models.graph import GraphNode, PortValueDict

REPO_ROOT = Path(__file__).resolve().parents[2]

BASE_IMAGE = "https://cdn.example.com/base.png"
REF_VIEWS = ["https://cdn.example.com/nari-front.png", "https://cdn.example.com/nari-side.png"]
TRAIT = "Nari, a woman with copper hair and green eyes"


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="id-edit-1", definitionId="identity-edit", params=params or {})


def _bundle(**overrides) -> dict:
    bundle = {
        "characterId": "char-1",
        "name": "Nari",
        "referenceViews": list(REF_VIEWS),
        "frozenTraitString": TRAIT,
        "seed": 42,
        "consistencyStrength": 0.7,
    }
    bundle.update(overrides)
    return bundle


def _inputs(*, character: dict | None = None, mask: str | None = None) -> dict[str, PortValueDict]:
    inputs: dict[str, PortValueDict] = {
        "image": PortValueDict(type="Image", value=BASE_IMAGE),
        "prompt": PortValueDict(type="Text", value="change the background to a beach"),
    }
    if character is not None:
        inputs["character"] = PortValueDict(type="Character", value=character)
    if mask is not None:
        inputs["mask"] = PortValueDict(type="Mask", value=mask)
    return inputs


def _make_poll_mocks(result_payload: dict):
    """Return (mock_submit, mock_status, mock_result) for a standard poll flow."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-test"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = result_payload

    return mock_submit, mock_status, mock_result


def _image_result(url: str = "https://fal.ai/out.png") -> dict:
    return {"images": [{"url": url, "content_type": "image/png"}]}


async def _run(node: GraphNode, inputs: dict[str, PortValueDict]):
    """Invoke the registered identity-edit handler against a mocked FAL queue.

    Returns (result, mock_client) so tests can inspect the submit URL + body.
    """
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    handler = registry["identity-edit"]

    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handler(node, inputs, {"FAL_KEY": "test-key"})

    return result, mock_client


def _submit_body(mock_client) -> dict:
    return mock_client.post.call_args.kwargs["json"]


# ── Character connected (VAL-IDENTITY-002) ───────────────────────────────────


@pytest.mark.asyncio
async def test_character_refs_injected_behind_base_image() -> None:
    """Identity refs ride as additional images; the base image stays the
    edit target at the front of image_urls."""
    _, mock_client = await _run(_node(), _inputs(character=_bundle()))

    body = _submit_body(mock_client)
    assert body["image_urls"] == [BASE_IMAGE, *REF_VIEWS]
    # The singular image_url field is not part of the nano-banana edit schema.
    assert "image_url" not in body


@pytest.mark.asyncio
async def test_character_trait_prepended_verbatim() -> None:
    """The frozen trait string leads the prompt byte-identical (never
    paraphrased), followed by the user's edit instruction."""
    _, mock_client = await _run(_node(), _inputs(character=_bundle()))

    body = _submit_body(mock_client)
    assert body["prompt"] == f"{TRAIT}. change the background to a beach"


@pytest.mark.asyncio
@pytest.mark.parametrize("strength", [0.0, 0.3, 0.8, 1.0, "invalid"])
async def test_saved_identity_strength_is_not_a_native_provider_control(strength) -> None:
    """Legacy strength values remain in the recipe without invented payload fields."""
    node = _node({"identity_strength": strength})
    bundle = _bundle(strengthOverride=0.9, consistencyStrength=0.2)
    _, mock_client = await _run(node, _inputs(character=bundle))

    body = _submit_body(mock_client)
    assert "identity_strength" not in body
    assert "input_fidelity" not in body
    assert "consistencyStrength" not in body
    assert "strengthOverride" not in body
    assert node.params == {"identity_strength": strength}
    assert bundle["consistencyStrength"] == 0.2
    assert bundle["strengthOverride"] == 0.9
    assert body["image_urls"] == [BASE_IMAGE, *REF_VIEWS]
    assert body["prompt"] == f"{TRAIT}. change the background to a beach"


@pytest.mark.asyncio
async def test_bundle_strength_without_node_override_is_not_injected() -> None:
    _, mock_client = await _run(
        _node(), _inputs(character=_bundle(consistencyStrength=0.2))
    )
    assert "input_fidelity" not in _submit_body(mock_client)


@pytest.mark.asyncio
@pytest.mark.parametrize("character", [None, _bundle()])
async def test_legacy_input_fidelity_is_stripped_from_provider_request(character) -> None:
    node = _node({"identity_strength": 0.8, "input_fidelity": "high"})
    _, mock_client = await _run(node, _inputs(character=character))
    body = _submit_body(mock_client)
    assert "input_fidelity" not in body
    assert "identity_strength" not in body
    # Source recipes and previous run snapshots still contain their saved values.
    assert node.params == {"identity_strength": 0.8, "input_fidelity": "high"}


@pytest.mark.asyncio
async def test_bundle_seed_applied_when_node_seed_unset() -> None:
    """The Character seed pins determinism unless the user set a node seed."""
    _, mock_client = await _run(_node(), _inputs(character=_bundle()))
    assert _submit_body(mock_client)["seed"] == 42

    _, mock_client = await _run(_node({"seed": 7}), _inputs(character=_bundle()))
    assert _submit_body(mock_client)["seed"] == 7


# ── No Character connected (VAL-IDENTITY-003) ────────────────────────────────


@pytest.mark.asyncio
async def test_without_character_behaves_as_standard_edit() -> None:
    """No Character -> plain nano-banana edit: base image only, prompt
    untouched, no identity injection, no error."""
    result, mock_client = await _run(_node(), _inputs())

    body = _submit_body(mock_client)
    assert body["image_urls"] == [BASE_IMAGE]
    assert body["prompt"] == "change the background to a beach"
    assert "input_fidelity" not in body
    assert "seed" not in body
    assert result["image"]["value"] == "https://fal.ai/out.png"


@pytest.mark.asyncio
async def test_empty_character_value_behaves_as_standard_edit() -> None:
    """A connected-but-empty Character port is treated as unconnected."""
    inputs = _inputs()
    inputs["character"] = PortValueDict(type="Character", value=None)

    _, mock_client = await _run(_node(), inputs)

    body = _submit_body(mock_client)
    assert body["image_urls"] == [BASE_IMAGE]
    assert "input_fidelity" not in body


# ── Routing + params (VAL-IDENTITY-004) ──────────────────────────────────────


@pytest.mark.asyncio
async def test_routes_to_nano_banana_2_edit_endpoint() -> None:
    """The submit call targets the FAL queue for fal-ai/nano-banana-2/edit."""
    _, mock_client = await _run(_node(), _inputs(character=_bundle()))

    url = mock_client.post.call_args.args[0]
    assert url == "https://queue.fal.run/fal-ai/nano-banana-2/edit"


@pytest.mark.asyncio
async def test_ui_enums_translated_to_endpoint_dialect() -> None:
    """resolution 1024/2048 -> 1K/2K; thinking_level low/medium/high ->
    minimal/high/high (the endpoint's published values)."""
    _, mock_client = await _run(
        _node({"resolution": "2048", "thinking_level": "high"}), _inputs()
    )
    body = _submit_body(mock_client)
    assert body["resolution"] == "2K"
    assert body["thinking_level"] == "high"

    _, mock_client = await _run(
        _node({"resolution": "1024", "thinking_level": "low"}), _inputs()
    )
    body = _submit_body(mock_client)
    assert body["resolution"] == "1K"
    assert body["thinking_level"] == "minimal"

    _, mock_client = await _run(_node({"thinking_level": "medium"}), _inputs())
    assert _submit_body(mock_client)["thinking_level"] == "high"


@pytest.mark.asyncio
async def test_identity_strength_never_leaks_to_fal() -> None:
    """The endpoint receives neither saved strength nor an invented fidelity field."""
    _, mock_client = await _run(
        _node({"identity_strength": 0.6}), _inputs(character=_bundle())
    )
    body = _submit_body(mock_client)
    assert "identity_strength" not in body
    assert "input_fidelity" not in body


@pytest.mark.asyncio
@pytest.mark.parametrize("character", [None, _bundle()])
async def test_unsupported_mask_rejected_before_provider_submission(character) -> None:
    """Saved mask connections stay available, but unsupported requests never submit."""
    from execution.sync_runner import get_handler_registry

    handler = get_handler_registry(emit=AsyncMock())["identity-edit"]
    with patch("handlers.fal_universal.httpx.AsyncClient") as transport:
        with pytest.raises(ValueError, match="does not support masks.*disconnect Mask"):
            await handler(
                _node(), _inputs(character=character, mask="https://cdn.example.com/mask.png"),
                {"FAL_KEY": "fixture-key"},
            )
        transport.assert_not_called()


@pytest.mark.asyncio
async def test_empty_legacy_mask_port_remains_valid_standard_edit() -> None:
    inputs = _inputs()
    inputs["mask"] = PortValueDict(type="Mask", value=None)
    _, mock_client = await _run(_node(), inputs)
    assert "mask_url" not in _submit_body(mock_client)


@pytest.mark.asyncio
async def test_missing_base_image_raises() -> None:
    """The image port is required — a clear error, not a silent FAL 422."""
    inputs = {"prompt": PortValueDict(type="Text", value="edit this")}
    with pytest.raises(ValueError, match="base image"):
        await _run(_node(), inputs)


# ── Definition + registry (VAL-IDENTITY-001) ─────────────────────────────────


def test_handler_registered_in_sync_runner_registry() -> None:
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    assert "identity-edit" in registry


def test_node_definition_shape() -> None:
    """node_definitions.json entry: image-gen category, FAL provider, the
    nano-banana-2/edit endpoint, and the contracted ports + params."""
    defs = json.loads((REPO_ROOT / "backend" / "data" / "node_definitions.json").read_text())
    ndef = defs["identity-edit"]

    assert ndef["id"] == "identity-edit"
    assert ndef["category"] == "image-gen"
    assert ndef["apiProvider"] == "fal"
    assert ndef["apiEndpoint"] == "fal-ai/nano-banana-2/edit"
    assert ndef["envKeyName"] == "FAL_KEY"
    assert ndef["executionPattern"] == "async-poll"

    inputs = {p["id"]: p for p in ndef["inputPorts"]}
    assert set(inputs) == {"image", "prompt", "character", "mask"}
    assert inputs["image"]["dataType"] == "Image" and inputs["image"]["required"] is True
    assert inputs["prompt"]["dataType"] == "Text" and inputs["prompt"]["required"] is True
    assert inputs["character"]["dataType"] == "Character" and inputs["character"]["required"] is False
    assert inputs["mask"]["dataType"] == "Mask" and inputs["mask"]["required"] is False

    outputs = {p["id"]: p for p in ndef["outputPorts"]}
    assert set(outputs) == {"image"}
    assert outputs["image"]["dataType"] == "Image"

    params = {p["key"]: p for p in ndef["params"]}
    assert set(params) == {"resolution", "thinking_level", "identity_strength"}

    resolution_values = {o["value"] for o in params["resolution"]["options"]}
    assert resolution_values == {"1024", "2048"}
    thinking_values = {o["value"] for o in params["thinking_level"]["options"]}
    assert thinking_values == {"low", "medium", "high"}

    strength = params["identity_strength"]
    assert strength["type"] == "float"
    assert strength["min"] == 0.0 and strength["max"] == 1.0
    assert strength["default"] == 0.8


def test_frontend_mirror_has_identity_edit_entry() -> None:
    """The TS mirror declares the node with the same ports (incl. Character)."""
    source = (REPO_ROOT / "frontend" / "src" / "constants" / "nodeDefinitions.ts").read_text()

    assert "'identity-edit': {" in source
    assert "dataType: 'Character'" in source
    assert "key: 'identity_strength'" in source
