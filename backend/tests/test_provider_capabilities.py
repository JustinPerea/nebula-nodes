from __future__ import annotations

import pytest

from execution.engine import validate_graph
from models.graph import GraphEdge, GraphNode
from services.provider_capabilities import (
    GEMINI_OMNI_EXTENSION_ERROR,
    gemini_omni_capability_error,
    is_explicit_video_extension,
)


@pytest.mark.parametrize(
    "prompt",
    [
        "Continue the same clip: make the circle shrink to a dot.",
        "Extend this video by showing the empty room.",
        "Make the existing footage ten seconds longer.",
        "Add another 3 seconds after the final movement.",
        "Add another five seconds after the final movement.",
        "Append a closing scene to the clip.",
        "Show what happens after the end.",
    ],
)
def test_explicit_video_extension_language_is_detected(prompt: str) -> None:
    assert is_explicit_video_extension(prompt)


@pytest.mark.parametrize(
    "prompt",
    [
        "Continue to make the clip blue while keeping the timing unchanged.",
        "Extend the blue gradient across the frame.",
        "Extend this video's color palette across the whole frame.",
        "Append a handwritten note to the scene.",
        "After 3 seconds, change the lighting to dusk.",
        "Make the existing clip feel longer with slow camera movement, but keep its duration.",
        "Change the circle to vivid blue and keep everything else the same.",
    ],
)
def test_edit_language_that_does_not_extend_duration_is_allowed(prompt: str) -> None:
    assert not is_explicit_video_extension(prompt)


def test_extension_requires_an_edit_context() -> None:
    prompt = "Continue the same clip with a second scene."
    assert gemini_omni_capability_error(prompt) is None
    assert gemini_omni_capability_error(
        prompt,
        has_previous_interaction=True,
    ) == GEMINI_OMNI_EXTENSION_ERROR
    assert gemini_omni_capability_error(
        prompt,
        has_video_input=True,
    ) == GEMINI_OMNI_EXTENSION_ERROR
    assert gemini_omni_capability_error(
        prompt,
        task="edit",
    ) == GEMINI_OMNI_EXTENSION_ERROR


def _edge(source: str, target: str, source_handle: str, target_handle: str) -> GraphEdge:
    return GraphEdge(
        id=f"{source}-{target}-{target_handle}",
        source=source,
        sourceHandle=source_handle,
        target=target,
        targetHandle=target_handle,
    )


def _capability_messages(errors) -> list[str]:
    return [error.message for error in errors if "capability guardrail" in error.message]


def test_graph_preflight_blocks_connected_extension_before_execution() -> None:
    nodes = [
        GraphNode(
            id="prompt",
            definitionId="text-input",
            params={"value": "Continue the same clip: make the circle shrink."},
        ),
        GraphNode(
            id="previous",
            definitionId="text-input",
            params={"value": "v1_previous"},
        ),
        GraphNode(id="omni", definitionId="gemini-omni-flash", params={}),
    ]
    edges = [
        _edge("prompt", "omni", "text", "prompt"),
        _edge("previous", "omni", "text", "previous_interaction_id"),
    ]

    errors = validate_graph(nodes, edges, {"GOOGLE_API_KEY": "test-key"})

    assert _capability_messages(errors) == [GEMINI_OMNI_EXTENSION_ERROR]


def test_graph_preflight_allows_valid_connected_edit() -> None:
    nodes = [
        GraphNode(
            id="prompt",
            definitionId="text-input",
            params={"value": "Make the circle vivid blue and keep everything else the same."},
        ),
        GraphNode(
            id="previous",
            definitionId="text-input",
            params={"value": "v1_previous"},
        ),
        GraphNode(id="omni", definitionId="gemini-omni-flash", params={}),
    ]
    edges = [
        _edge("prompt", "omni", "text", "prompt"),
        _edge("previous", "omni", "text", "previous_interaction_id"),
    ]

    errors = validate_graph(nodes, edges, {"GOOGLE_API_KEY": "test-key"})

    assert _capability_messages(errors) == []


def test_graph_preflight_honors_manual_previous_interaction_fallback() -> None:
    nodes = [
        GraphNode(
            id="prompt",
            definitionId="text-input",
            params={"value": "Extend the video by another five seconds."},
        ),
        GraphNode(
            id="omni",
            definitionId="gemini-omni-flash",
            params={"previous_interaction_id": "v1_manual"},
        ),
    ]
    edges = [_edge("prompt", "omni", "text", "prompt")]

    errors = validate_graph(nodes, edges, {"GOOGLE_API_KEY": "test-key"})

    assert _capability_messages(errors) == [GEMINI_OMNI_EXTENSION_ERROR]
