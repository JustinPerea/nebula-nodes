from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from handlers.openai_image import handle_openai_image_generate
from handlers.google_gemini import handle_imagen4


SYNC_HANDLERS: dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
] = {
    "gpt-image-1-generate": handle_openai_image_generate,
    "dalle-3-generate": handle_openai_image_generate,
    "imagen-4-generate": handle_imagen4,
}


def get_handler_registry(
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
]:
    registry = dict(SYNC_HANDLERS)

    if emit is not None:
        from handlers.runway import handle_runway_gen4_turbo
        from handlers.anthropic_chat import handle_claude_chat
        from handlers.openai_chat import handle_openai_chat
        from handlers.google_gemini import handle_gemini_chat
        from handlers.openrouter import handle_openrouter_universal
        from handlers.replicate_universal import handle_replicate_universal
        from handlers.fal_universal import handle_fal_universal

        async def _runway_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_runway_gen4_turbo(node, inputs, api_keys, emit=emit)

        async def _claude_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_claude_chat(node, inputs, api_keys, emit=emit)

        async def _openai_chat_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_openai_chat(node, inputs, api_keys, emit=emit)

        async def _gemini_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_gemini_chat(node, inputs, api_keys, emit=emit)

        async def _openrouter_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_openrouter_universal(node, inputs, api_keys, emit=emit)

        async def _replicate_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_replicate_universal(node, inputs, api_keys, emit=emit)

        async def _fal_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _kling_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Pre-configured FAL node: inject the endpoint_id into params and route to fal-universal
            node.params.setdefault("endpoint_id", "fal-ai/kling-video/v2.1/pro/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _sora2_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Pre-configured FAL node: inject the endpoint_id into params and route to fal-universal
            node.params.setdefault("endpoint_id", "fal-ai/sora-2/text-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        registry["runway-gen4-turbo"] = _runway_handler
        registry["claude-chat"] = _claude_handler
        registry["gpt-4o-chat"] = _openai_chat_handler
        registry["gemini-chat"] = _gemini_handler
        registry["openrouter-universal"] = _openrouter_handler
        registry["replicate-universal"] = _replicate_handler
        registry["fal-universal"] = _fal_handler
        registry["kling-v2-1"] = _kling_handler
        registry["sora-2"] = _sora2_handler

    return registry
