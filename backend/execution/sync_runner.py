from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from handlers.openai_image import handle_openai_image_generate
from handlers.openai_image_edit import handle_openai_image_edit
from handlers.google_gemini import handle_imagen4, handle_nano_banana
from handlers.elevenlabs import handle_elevenlabs_tts


SYNC_HANDLERS: dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
] = {
    "gpt-image-1-generate": handle_openai_image_generate,
    "gpt-image-1-edit": handle_openai_image_edit,
    "dalle-3-generate": handle_openai_image_generate,
    "imagen-4-generate": handle_imagen4,
    "nano-banana": handle_nano_banana,
    "elevenlabs-tts": handle_elevenlabs_tts,
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

        async def _veo3_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Prefer direct Google API, fall back to FAL
            if api_keys.get("GOOGLE_API_KEY"):
                from handlers.veo import handle_veo
                return await handle_veo(node, inputs, api_keys, emit=emit)
            node.params.setdefault("endpoint_id", "fal-ai/veo3")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _flux_schnell_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/flux/schnell")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _fast_sdxl_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/fast-sdxl")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _wan26_t2v_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "wan/v2.6/text-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _luma_ray2_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/luma-dream-machine/ray-2")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _ltx_video2_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/ltx-2/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _meshy_text_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Prefer direct Meshy API, fall back to FAL
            if api_keys.get("MESHY_API_KEY"):
                from handlers.meshy import handle_meshy_text_to_3d
                return await handle_meshy_text_to_3d(node, inputs, api_keys, emit=emit)
            node.params.setdefault("endpoint_id", "fal-ai/meshy/v6/text-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _meshy_image_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Prefer direct Meshy API, fall back to FAL
            if api_keys.get("MESHY_API_KEY"):
                from handlers.meshy import handle_meshy_image_to_3d
                return await handle_meshy_image_to_3d(node, inputs, api_keys, emit=emit)
            node.params.setdefault("endpoint_id", "fal-ai/meshy/v6/image-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _hunyuan3d_text_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/hunyuan3d-v3/text-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _hunyuan3d_image_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/hunyuan3d-v3/image-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _remove_bg_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/imageutils/rembg")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _recraft_raster_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/recraft/v4/text-to-image")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _recraft_svg_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/recraft/v4/text-to-vector")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _kling_v3_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/kling-video/v3/standard/text-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _luma_ray2_i2v_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/luma-dream-machine/ray-2/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _wan26_i2v_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/wan/v2.6/image-to-video")
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
        registry["veo-3"] = _veo3_handler
        registry["flux-schnell"] = _flux_schnell_handler
        registry["fast-sdxl"] = _fast_sdxl_handler
        registry["wan-2-6-t2v"] = _wan26_t2v_handler
        registry["luma-ray2-t2v"] = _luma_ray2_handler
        registry["ltx-video-2"] = _ltx_video2_handler
        registry["meshy-text-to-3d"] = _meshy_text_to_3d_handler
        registry["meshy-image-to-3d"] = _meshy_image_to_3d_handler
        registry["hunyuan3d-text-to-3d"] = _hunyuan3d_text_to_3d_handler
        registry["hunyuan3d-image-to-3d"] = _hunyuan3d_image_to_3d_handler
        registry["remove-background"] = _remove_bg_handler
        registry["recraft-v4-raster"] = _recraft_raster_handler
        registry["recraft-v4-svg"] = _recraft_svg_handler
        registry["kling-v3"] = _kling_v3_handler
        registry["luma-ray2-i2v"] = _luma_ray2_i2v_handler
        registry["wan-2-6-i2v"] = _wan26_i2v_handler

    return registry
