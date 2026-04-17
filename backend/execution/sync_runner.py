from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from handlers.openai_image import handle_openai_image_generate
from handlers.openai_image_edit import handle_openai_image_edit
from handlers.google_gemini import handle_imagen4, handle_nano_banana, handle_lyria3, handle_gemini_tts, handle_gemini_embeddings
from handlers.elevenlabs import handle_elevenlabs_tts, handle_elevenlabs_sfx, handle_elevenlabs_sts, handle_elevenlabs_isolation, handle_elevenlabs_dubbing
from handlers.openai_audio import handle_openai_stt, handle_openai_translate, handle_openai_tts


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
    "elevenlabs-sfx": handle_elevenlabs_sfx,
    "elevenlabs-sts": handle_elevenlabs_sts,
    "elevenlabs-isolation": handle_elevenlabs_isolation,
    "elevenlabs-dubbing": handle_elevenlabs_dubbing,
    "openai-stt": handle_openai_stt,
    "openai-translate": handle_openai_translate,
    "openai-tts": handle_openai_tts,
    "lyria-3": handle_lyria3,
    "gemini-tts": handle_gemini_tts,
    "gemini-embeddings": handle_gemini_embeddings,
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
        from handlers.runway import handle_runway_video
        from handlers.anthropic_chat import handle_claude_chat
        from handlers.openai_chat import handle_openai_chat
        from handlers.google_gemini import handle_gemini_chat
        from handlers.openrouter import handle_openrouter_universal
        from handlers.replicate_universal import handle_replicate_universal
        from handlers.fal_universal import handle_fal_universal

        async def _runway_video_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.runway import handle_runway_video
            return await handle_runway_video(node, inputs, api_keys, emit=emit)

        async def _runway_aleph_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.runway import handle_runway_aleph
            return await handle_runway_aleph(node, inputs, api_keys, emit=emit)

        async def _runway_image_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.runway import handle_runway_image
            return await handle_runway_image(node, inputs, api_keys, emit=emit)

        async def _runway_act_two_handler(node, inputs, api_keys):
            from handlers.runway import handle_runway_act_two
            return await handle_runway_act_two(node, inputs, api_keys, emit=emit)

        async def _runway_tts_handler(node, inputs, api_keys):
            from handlers.runway import handle_runway_tts
            return await handle_runway_tts(node, inputs, api_keys, emit=emit)

        async def _runway_sts_handler(node, inputs, api_keys):
            from handlers.runway import handle_runway_speech_to_speech
            return await handle_runway_speech_to_speech(node, inputs, api_keys, emit=emit)

        async def _runway_dubbing_handler(node, inputs, api_keys):
            from handlers.runway import handle_runway_voice_dubbing
            return await handle_runway_voice_dubbing(node, inputs, api_keys, emit=emit)

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
            # Route to Standard or Pro endpoint based on `model` param.
            # Pop `model` so FAL doesn't receive an unknown value (FAL's inner model key uses different values).
            tier = node.params.pop("model", "standard")
            if str(tier).lower() == "pro":
                node.params.setdefault("endpoint_id", "fal-ai/sora-2/text-to-video/pro")
            else:
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
            import json as _json
            for array_key in ("loras", "embeddings"):
                raw = node.params.get(array_key)
                if isinstance(raw, str):
                    stripped = raw.strip()
                    if not stripped:
                        node.params.pop(array_key, None)
                    else:
                        try:
                            node.params[array_key] = _json.loads(stripped)
                        except _json.JSONDecodeError:
                            node.params.pop(array_key, None)
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

        async def _meshy_multi_image_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.meshy import handle_meshy_multi_image_to_3d
            return await handle_meshy_multi_image_to_3d(node, inputs, api_keys, emit=emit)

        async def _meshy_retexture_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.meshy import handle_meshy_retexture
            return await handle_meshy_retexture(node, inputs, api_keys, emit=emit)

        async def _meshy_rigging_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.meshy import handle_meshy_rigging
            return await handle_meshy_rigging(node, inputs, api_keys, emit=emit)

        async def _meshy_animate_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.meshy import handle_meshy_animate
            return await handle_meshy_animate(node, inputs, api_keys, emit=emit)

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
            mp = node.params.get("multi_prompt")
            if isinstance(mp, str) and mp.strip():
                import json as _json
                try:
                    node.params["multi_prompt"] = _json.loads(mp)
                except _json.JSONDecodeError:
                    node.params.pop("multi_prompt", None)
            elif mp == "":
                node.params.pop("multi_prompt", None)
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
            node.params.setdefault("endpoint_id", "wan/v2.6/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _minimax_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.minimax import handle_minimax_video
            return await handle_minimax_video(node, inputs, api_keys, emit=emit)

        async def _luma_ray2_flash_modify_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/luma-dream-machine/ray-2-flash/modify")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _wan26_r2v_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "wan/v2.6/reference-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _pixverse_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/pixverse/v4.5/text-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedance_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/bytedance/seedance/v1.5/pro/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _moonvalley_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/moonvalley/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _kling_o3_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/kling-video/o3/standard/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _ltx_23_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/ltx-2.3/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _grok_video_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.grok_video import handle_grok_video
            return await handle_grok_video(node, inputs, api_keys, emit=emit)

        async def _higgsfield_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.higgsfield import handle_higgsfield
            return await handle_higgsfield(node, inputs, api_keys, emit=emit)

        registry["runway-video"] = _runway_video_handler
        registry["runway-aleph"] = _runway_aleph_handler
        registry["runway-image"] = _runway_image_handler
        registry["runway-act-two"] = _runway_act_two_handler
        registry["runway-tts"] = _runway_tts_handler
        registry["runway-sts"] = _runway_sts_handler
        registry["runway-dubbing"] = _runway_dubbing_handler
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
        registry["meshy-multi-image-to-3d"] = _meshy_multi_image_to_3d_handler
        registry["meshy-retexture"] = _meshy_retexture_handler
        registry["meshy-rigging"] = _meshy_rigging_handler
        registry["meshy-animate"] = _meshy_animate_handler

        async def _meshy_remesh_handler(node, inputs, api_keys):
            from handlers.meshy import handle_meshy_remesh
            return await handle_meshy_remesh(node, inputs, api_keys, emit=emit)

        async def _meshy_text_to_image_handler(node, inputs, api_keys):
            from handlers.meshy import handle_meshy_text_to_image
            return await handle_meshy_text_to_image(node, inputs, api_keys, emit=emit)

        async def _meshy_image_to_image_handler(node, inputs, api_keys):
            from handlers.meshy import handle_meshy_image_to_image
            return await handle_meshy_image_to_image(node, inputs, api_keys, emit=emit)

        async def _meshy_3d_print_handler(node, inputs, api_keys):
            from handlers.meshy import handle_meshy_3d_print
            return await handle_meshy_3d_print(node, inputs, api_keys, emit=emit)

        registry["meshy-remesh"] = _meshy_remesh_handler
        registry["meshy-text-to-image"] = _meshy_text_to_image_handler
        registry["meshy-image-to-image"] = _meshy_image_to_image_handler
        registry["meshy-3d-print"] = _meshy_3d_print_handler
        registry["hunyuan3d-text-to-3d"] = _hunyuan3d_text_to_3d_handler
        registry["hunyuan3d-image-to-3d"] = _hunyuan3d_image_to_3d_handler
        registry["remove-background"] = _remove_bg_handler
        registry["recraft-v4-raster"] = _recraft_raster_handler
        registry["recraft-v4-svg"] = _recraft_svg_handler
        registry["kling-v3"] = _kling_v3_handler
        registry["luma-ray2-i2v"] = _luma_ray2_i2v_handler
        registry["wan-2-6-i2v"] = _wan26_i2v_handler
        registry["minimax-t2v"] = _minimax_handler
        registry["minimax-i2v"] = _minimax_handler
        registry["minimax-s2v"] = _minimax_handler
        registry["luma-ray2-flash-modify"] = _luma_ray2_flash_modify_handler
        registry["wan-2-6-r2v"] = _wan26_r2v_handler
        registry["pixverse-v4-5"] = _pixverse_handler
        registry["seedance-v1-5"] = _seedance_handler
        registry["moonvalley"] = _moonvalley_handler
        registry["kling-o3"] = _kling_o3_handler
        registry["ltx-2-3"] = _ltx_23_handler
        registry["grok-imagine-video"] = _grok_video_handler
        registry["higgsfield"] = _higgsfield_handler

        # Pre-configured FAL nodes
        async def _seedance2_t2v_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/text-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedance2_i2v_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedance2_r2v_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/reference-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _flux_kontext_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/flux-pro/kontext")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _flux2_pro_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/flux-2-pro")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _gpt_image_15_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/gpt-image-1.5")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _gpt_image_15_edit_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/gpt-image-1.5/edit")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedvr2_upscale_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/seedvr/upscale/image")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedream45_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/bytedance/seedream/v4.5/text-to-image")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        registry["seedance-2-t2v"] = _seedance2_t2v_handler
        registry["seedance-2-i2v"] = _seedance2_i2v_handler
        registry["seedance-2-r2v"] = _seedance2_r2v_handler
        registry["flux-kontext"] = _flux_kontext_handler
        registry["flux-2-pro"] = _flux2_pro_handler
        registry["gpt-image-1-5"] = _gpt_image_15_handler
        registry["gpt-image-1-5-edit"] = _gpt_image_15_edit_handler
        registry["seedvr2-upscale"] = _seedvr2_upscale_handler
        registry["seedream-4-5"] = _seedream45_handler

    return registry
