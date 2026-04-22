from __future__ import annotations

import pytest

from handlers.fal_universal import _build_fal_stream_body
from models.graph import GraphNode, PortValueDict


def _edit_node() -> GraphNode:
    return GraphNode(
        id="n1",
        definitionId="gpt-image-2-fal-edit",
        params={"endpoint_id": "openai/gpt-image-2/edit"},
    )


def test_build_fal_stream_body_raises_on_edit_with_no_images() -> None:
    node = _edit_node()
    inputs = {"prompt": PortValueDict(type="Text", value="edit please")}
    with pytest.raises(ValueError, match="reference image is required"):
        _build_fal_stream_body(node, inputs)


def test_build_fal_stream_body_raises_on_edit_with_empty_images_list() -> None:
    node = _edit_node()
    inputs = {
        "prompt": PortValueDict(type="Text", value="edit please"),
        "images": PortValueDict(type="Image", value=[]),
    }
    with pytest.raises(ValueError, match="reference image is required"):
        _build_fal_stream_body(node, inputs)


def test_build_fal_stream_body_raises_on_edit_with_empty_string_images_list() -> None:
    node = _edit_node()
    inputs = {
        "prompt": PortValueDict(type="Text", value="edit please"),
        "images": PortValueDict(type="Image", value=[""]),
    }
    with pytest.raises(ValueError, match="reference image is required"):
        _build_fal_stream_body(node, inputs)


def test_build_fal_stream_body_edit_with_valid_image_list() -> None:
    node = _edit_node()
    inputs = {
        "prompt": PortValueDict(type="Text", value="make it blue"),
        "images": PortValueDict(type="Image", value=["https://example.com/img.png"]),
    }
    body = _build_fal_stream_body(node, inputs)
    assert body["prompt"] == "make it blue"
    assert body["image_urls"] == ["https://example.com/img.png"]


def test_build_fal_stream_body_edit_with_valid_image_string() -> None:
    node = _edit_node()
    inputs = {
        "prompt": PortValueDict(type="Text", value="edit"),
        "images": PortValueDict(type="Image", value="https://example.com/img.png"),
    }
    body = _build_fal_stream_body(node, inputs)
    assert body["image_urls"] == ["https://example.com/img.png"]


def test_build_fal_stream_body_generate_does_not_require_images() -> None:
    node = GraphNode(
        id="n2",
        definitionId="gpt-image-2-fal-generate",
        params={"endpoint_id": "openai/gpt-image-2"},
    )
    inputs = {"prompt": PortValueDict(type="Text", value="a cat")}
    body = _build_fal_stream_body(node, inputs)
    assert body["prompt"] == "a cat"
    assert "image_urls" not in body
