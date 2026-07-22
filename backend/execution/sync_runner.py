from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
# Single source of truth for hex/{r,g,b} color parsing lives in cinema.color.
# Re-exported here so existing imports (and the Recraft handler / its tests)
# keep working: `from execution.sync_runner import _parse_recraft_color`.
from cinema.color import _parse_recraft_color
from handlers.openai_image import handle_openai_image_generate
from handlers.openai_image_edit import handle_openai_image_edit
from handlers.google_gemini import handle_imagen4, handle_nano_banana, handle_lyria3, handle_gemini_tts, handle_gemini_embeddings
from handlers.elevenlabs import handle_elevenlabs_tts, handle_elevenlabs_sfx, handle_elevenlabs_sts, handle_elevenlabs_isolation, handle_elevenlabs_dubbing, handle_elevenlabs_stt
from handlers.openai_audio import handle_openai_stt, handle_openai_translate, handle_openai_tts
from handlers.krea import (
    handle_krea_image_style_reference,
    handle_krea_moodboard,
    handle_krea_style,
    handle_krea_style_search,
)
from handlers.moodboard import handle_moodboard_node


SYNC_HANDLERS: dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
] = {
    "gpt-image-1-generate": handle_openai_image_generate,
    "gpt-image-1-edit": handle_openai_image_edit,
    "imagen-4-generate": handle_imagen4,
    "nano-banana": handle_nano_banana,
    "elevenlabs-tts": handle_elevenlabs_tts,
    "elevenlabs-sfx": handle_elevenlabs_sfx,
    "elevenlabs-sts": handle_elevenlabs_sts,
    "elevenlabs-isolation": handle_elevenlabs_isolation,
    "elevenlabs-dubbing": handle_elevenlabs_dubbing,
    "elevenlabs-stt": handle_elevenlabs_stt,
    "openai-stt": handle_openai_stt,
    "openai-translate": handle_openai_translate,
    "openai-tts": handle_openai_tts,
    "lyria-3": handle_lyria3,
    "gemini-tts": handle_gemini_tts,
    "gemini-embeddings": handle_gemini_embeddings,
    "krea-image-style-reference": handle_krea_image_style_reference,
    "krea-moodboard": handle_krea_moodboard,
    "krea-style": handle_krea_style,
    "krea-style-search": handle_krea_style_search,
    "nebula-moodboard": handle_moodboard_node,
}


# Wrapper-only selector values for the fixed Nano Banana FAL nodes. Keep this
# routing out of fal_universal so arbitrary FAL schemas can still use a real
# input parameter named `model`.
NANO_BANANA_FAL_MODEL_ENDPOINTS: dict[str, str] = {
    "nano-banana": "fal-ai/nano-banana",
    "nano-banana-2": "fal-ai/nano-banana-2",
    "nano-banana-pro": "fal-ai/nano-banana-pro",
    "gemini-25-flash-image": "fal-ai/gemini-25-flash-image",
    "gemini-3-pro-image": "fal-ai/gemini-3-pro-image-preview",
}


def _fal_wrapper_node(
    node: GraphNode,
    endpoint_id: str,
    *,
    internal_params: tuple[str, ...] = (),
) -> GraphNode:
    """Return a routed FAL node without mutating the persisted graph node."""
    params = dict(node.params)
    for key in internal_params:
        params.pop(key, None)
    params["endpoint_id"] = endpoint_id
    return node.model_copy(update={"params": params})


def _nano_banana_fal_node(node: GraphNode, *, edit: bool) -> GraphNode:
    """Resolve a Nano Banana selector into an isolated per-run FAL node."""
    model = str(node.params.get("model", "nano-banana-2"))
    endpoint_id = NANO_BANANA_FAL_MODEL_ENDPOINTS.get(model, model)
    if not endpoint_id.startswith("fal-ai/"):
        endpoint_id = f"fal-ai/{endpoint_id}"
    if edit:
        endpoint_id = f"{endpoint_id}/edit"

    params = dict(node.params)
    aspect = str(params.get("aspect_ratio") or "")
    if model == "nano-banana-pro":
        if aspect in {"1:4", "4:1", "1:8", "8:1"}:
            params["aspect_ratio"] = "auto"
        if params.get("resolution") == "0.5K":
            params["resolution"] = "1K"
        params.pop("thinking_level", None)
    elif model != "nano-banana-2":
        if aspect in {"auto", "1:4", "4:1", "1:8", "8:1"}:
            params["aspect_ratio"] = "1:1"
        params.pop("resolution", None)
        params.pop("thinking_level", None)
        params.pop("enable_web_search", None)

    routed_node = node.model_copy(update={"params": params})
    return _fal_wrapper_node(routed_node, endpoint_id, internal_params=("model",))


def _apply_recraft_color_params(node: GraphNode) -> None:
    """Convert Recraft color params from string representation to FAL's expected format.

    FAL's Recraft V4 API expects:
    - colors: list[{r, g, b}]   (NOT comma-separated hex strings)
    - background_color: {r, g, b}  (NOT a hex string)

    The UI stores these as:
    - colors: JSON array string like '[{"r":255,"g":0,"b":0}]'
              OR comma-separated hex string like '#FF0000,#00FF00'
    - background_color: JSON object string like '{"r":255,"g":255,"b":255}'
                        OR a hex string like '#FFFFFF'

    Drops the param if the value is empty, unparseable, or produces no valid colors.
    """
    # --- colors ---
    raw_colors = node.params.get("colors")
    if raw_colors is not None:
        if isinstance(raw_colors, list):
            # Already a list — ensure each item is an {r,g,b} dict
            parsed = [c for c in (_parse_recraft_color(c) for c in raw_colors) if c]
            if parsed:
                node.params["colors"] = parsed
            else:
                node.params.pop("colors", None)
        else:
            s = str(raw_colors).strip()
            if not s:
                node.params.pop("colors", None)
            elif s.startswith("["):
                # JSON array
                try:
                    items = json.loads(s)
                    parsed = [c for c in (_parse_recraft_color(i) for i in items) if c]
                    if parsed:
                        node.params["colors"] = parsed
                    else:
                        node.params.pop("colors", None)
                except (json.JSONDecodeError, TypeError):
                    node.params.pop("colors", None)
            else:
                # Comma-separated hex strings: "#FF0000,#00FF00,#0000FF"
                parts = [p.strip() for p in s.split(",") if p.strip()]
                parsed = [c for c in (_parse_recraft_color(p) for p in parts) if c]
                if parsed:
                    node.params["colors"] = parsed
                else:
                    node.params.pop("colors", None)

    # --- background_color ---
    raw_bg = node.params.get("background_color")
    if raw_bg is not None:
        if isinstance(raw_bg, dict):
            result = _parse_recraft_color(raw_bg)
            if result:
                node.params["background_color"] = result
            else:
                node.params.pop("background_color", None)
        else:
            s = str(raw_bg).strip()
            if not s:
                node.params.pop("background_color", None)
            elif s.startswith("{"):
                try:
                    obj = json.loads(s)
                    result = _parse_recraft_color(obj)
                    if result:
                        node.params["background_color"] = result
                    else:
                        node.params.pop("background_color", None)
                except (json.JSONDecodeError, TypeError):
                    node.params.pop("background_color", None)
            else:
                result = _parse_recraft_color(s)
                if result:
                    node.params["background_color"] = result
                else:
                    node.params.pop("background_color", None)


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
        from handlers.fal_universal import handle_fal_universal, handle_demucs
        from handlers.krea import handle_krea_generate, handle_krea_style_train

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

        async def _runway_upscale_handler(node, inputs, api_keys):
            from handlers.runway import handle_runway_image_upscale
            return await handle_runway_image_upscale(node, inputs, api_keys, emit=emit)

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

        async def _krea_generate_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_krea_generate(node, inputs, api_keys, emit=emit)

        async def _krea_style_train_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_krea_style_train(node, inputs, api_keys, emit=emit)

        async def _flux_ultra_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/flux-pro/v1.1-ultra")
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
            tier = node.params.get("model", "standard")
            if str(tier).lower() == "pro":
                endpoint_id = "fal-ai/sora-2/text-to-video/pro"
            else:
                endpoint_id = "fal-ai/sora-2/text-to-video"
            routed_node = _fal_wrapper_node(node, endpoint_id, internal_params=("model",))
            return await handle_fal_universal(routed_node, inputs, api_keys, emit=emit)

        async def _veo3_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Prefer direct Google API, fall back to FAL
            if api_keys.get("GOOGLE_API_KEY"):
                from handlers.veo import handle_veo
                return await handle_veo(node, inputs, api_keys, emit=emit)
            routed_node = _fal_wrapper_node(node, "fal-ai/veo3", internal_params=("model",))
            return await handle_fal_universal(routed_node, inputs, api_keys, emit=emit)

        async def _gemini_omni_flash_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.gemini_omni import handle_gemini_omni
            return await handle_gemini_omni(node, inputs, api_keys, emit=emit)

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

        async def _flux_fill_inpaint_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/flux-pro/v1/fill")
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

        async def _stable_audio_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Stable Audio 2.5 text-to-audio (music + SFX) via FAL. No new logic —
            # the universal handler maps the `prompt` input + params and parses the
            # audio output URL.
            node.params.setdefault("endpoint_id", "fal-ai/stable-audio-25/text-to-audio")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _ace_step_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # ACE-Step music+vocals via FAL. Param-only node — `tags` + `lyrics`
            # drive it (no `prompt` input, so the universal handler sends only the
            # params and never an unsupported `prompt` field). Audio output parsed
            # by _parse_fal_output.
            node.params.setdefault("endpoint_id", "fal-ai/ace-step")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _mmaudio_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # MMAudio V2 Foley via FAL: a video + an audio-prompt produce the same
            # video muxed with newly generated, synchronized audio. The universal
            # handler maps the `video` input (-> video_url) and `prompt` input and
            # parses the video output.
            node.params.setdefault("endpoint_id", "fal-ai/mmaudio-v2")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _demucs_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            # Demucs returns multiple stems -> dedicated handler (multi-output),
            # not the single-output universal handler.
            return await handle_demucs(node, inputs, api_keys, emit=emit)

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
            _apply_recraft_color_params(node)
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _recraft_svg_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/recraft/v4/text-to-vector")
            _apply_recraft_color_params(node)
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _kling_v3_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/kling-video/v3/standard/text-to-video")
            mp = node.params.get("multi_prompt")
            if isinstance(mp, str) and mp.strip():
                try:
                    node.params["multi_prompt"] = json.loads(mp)
                except json.JSONDecodeError:
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

        async def _wan26_r2v_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "wan/v2.6/reference-to-video")
            # Collate video1/video2/video3 ports into the video_urls array the API expects.
            # handle_fal_universal has no mapping for numbered video ports, so we inject
            # video_urls into params before calling it; the universal handler will forward
            # any param key whose value is not None/"" straight to the FAL payload.
            video_urls: list[str] = []
            from handlers.fal_universal import _to_fal_url
            for port_id in ("video1", "video2", "video3"):
                port_val = inputs.get(port_id)
                if port_val and port_val.value:
                    video_urls.append(_to_fal_url(str(port_val.value)))
            if video_urls:
                node.params["video_urls"] = video_urls
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _pixverse_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/pixverse/v4.5/text-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedance_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/bytedance/seedance/v1.5/pro/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _kling_o3_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/kling-video/o3/standard/image-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _ltx_23_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
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

        async def _nous_portal_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.nous_portal import handle_nous_portal_universal
            return await handle_nous_portal_universal(node, inputs, api_keys, emit=emit)

        registry["runway-video"] = _runway_video_handler
        registry["runway-aleph"] = _runway_aleph_handler
        registry["runway-image"] = _runway_image_handler
        registry["runway-upscale"] = _runway_upscale_handler
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
        registry["nous-portal-universal"] = _nous_portal_handler
        registry["flux-1-1-ultra"] = _flux_ultra_handler
        registry["kling-v2-1"] = _kling_handler
        registry["sora-2"] = _sora2_handler
        registry["veo-3"] = _veo3_handler
        registry["gemini-omni-flash"] = _gemini_omni_flash_handler
        registry["flux-schnell"] = _flux_schnell_handler
        registry["fast-sdxl"] = _fast_sdxl_handler
        registry["flux-fill-inpaint"] = _flux_fill_inpaint_handler
        registry["wan-2-6-t2v"] = _wan26_t2v_handler
        registry["luma-ray2-t2v"] = _luma_ray2_handler
        registry["ltx-video-2"] = _ltx_video2_handler
        registry["stable-audio-25"] = _stable_audio_handler
        registry["ace-step"] = _ace_step_handler
        registry["mmaudio-v2"] = _mmaudio_handler
        registry["demucs"] = _demucs_handler
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

        async def _quiver_generate_handler(node, inputs, api_keys):
            from handlers.quiver import handle_quiver_arrow_generate
            return await handle_quiver_arrow_generate(node, inputs, api_keys, emit=emit)

        async def _quiver_vectorize_handler(node, inputs, api_keys):
            from handlers.quiver import handle_quiver_arrow_vectorize
            return await handle_quiver_arrow_vectorize(node, inputs, api_keys, emit=emit)

        async def _style_reference_handler(node, inputs, api_keys):
            from handlers.style_reference import handle_style_reference
            return await handle_style_reference(node, inputs, api_keys, emit=emit)

        async def _cinema_color_handler(node, inputs, api_keys):
            from handlers.cinema_color import handle_cinema_color
            return await handle_cinema_color(node, inputs, api_keys, emit=emit)

        async def _cinema_look_handler(node, inputs, api_keys):
            from handlers.cinema_look import handle_cinema_look
            return await handle_cinema_look(node, inputs, api_keys, emit=emit)

        async def _cinema_scene_handler(node, inputs, api_keys):
            from handlers.cinema_scene import handle_cinema_scene
            return await handle_cinema_scene(node, inputs, api_keys, emit=emit)

        async def _character_handler(node, inputs, api_keys):
            from handlers.character_node import handle_character_node
            return await handle_character_node(node, inputs, api_keys, emit=emit)

        async def _video_edit_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.video_edit import handle_video_edit
            return await handle_video_edit(node, inputs, api_keys, emit=emit)

        async def _remotion_node_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.remotion_node import handle_remotion_node
            return await handle_remotion_node(node, inputs, api_keys, emit=emit)

        registry["quiver-arrow-generate"] = _quiver_generate_handler
        registry["quiver-arrow-vectorize"] = _quiver_vectorize_handler
        registry["style-reference"] = _style_reference_handler
        registry["cinema-color"] = _cinema_color_handler
        registry["cinema-look"] = _cinema_look_handler
        registry["cinema-scene"] = _cinema_scene_handler
        registry["character"] = _character_handler
        registry["video-edit"] = _video_edit_handler
        registry["remotion-node"] = _remotion_node_handler

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

        async def _seedance2_fast_t2v_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/fast/text-to-video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedance2_fast_i2v_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/fast/image-to-video")
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

        from handlers.openai_image_v2 import handle_gpt_image_2_generate, handle_gpt_image_2_edit
        from services.output import get_run_dir

        async def _openai_image_2_generate_handler(node, inputs, api_keys):
            return await handle_gpt_image_2_generate(
                node, inputs, api_keys, emit=emit, run_dir=get_run_dir(),
            )

        async def _openai_image_2_edit_handler(node, inputs, api_keys):
            return await handle_gpt_image_2_edit(
                node, inputs, api_keys, emit=emit, run_dir=get_run_dir(),
            )

        async def _seedvr2_upscale_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/seedvr/upscale/image")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _clarity_upscaler_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/clarity-upscaler")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedvr_video_upscale_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/seedvr/upscale/video")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _seedream45_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "fal-ai/bytedance/seedream/v4.5/text-to-image")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _nano_banana_fal_handler(node, inputs, api_keys):
            routed_node = _nano_banana_fal_node(node, edit=False)
            return await handle_fal_universal(routed_node, inputs, api_keys, emit=emit)

        async def _nano_banana_fal_edit_handler(node, inputs, api_keys):
            routed_node = _nano_banana_fal_node(node, edit=True)
            return await handle_fal_universal(routed_node, inputs, api_keys, emit=emit)

        # Ideogram dual-route nodes: direct api.ideogram.ai when IDEOGRAM_API_KEY is
        # set, else FAL. Editing suite rides v3 on FAL (no v4 edit surfaces hosted
        # yet); the direct remix rides v4. Direct reframe needs `resolution` (the
        # FAL dialect uses `image_size`), so an unset resolution falls back to FAL.
        def _ideogram_router(direct_handler, fal_endpoint, *, require_param: str | None = None):
            async def _route(node, inputs, api_keys):
                use_direct = bool(api_keys.get("IDEOGRAM_API_KEY"))
                if use_direct and require_param and not node.params.get(require_param):
                    use_direct = False
                if use_direct:
                    return await direct_handler(node, inputs, api_keys, emit=emit)
                node.params.setdefault("endpoint_id", fal_endpoint)
                return await handle_fal_universal(node, inputs, api_keys, emit=emit)
            return _route

        from handlers.ideogram import (
            expand_character_inputs,
            handle_ideogram_character,
            handle_ideogram_describe,
            handle_ideogram_edit,
            handle_ideogram_edit_prompt,
            handle_ideogram_layerize,
            handle_ideogram_magic_prompt,
            handle_ideogram_reframe,
            handle_ideogram_remix,
            handle_ideogram_remove_background,
            handle_ideogram_replace_background,
            handle_ideogram_train_model,
            handle_ideogram_transparent,
            handle_ideogram_upscale,
            handle_ideogram_v4_generate,
        )

        _ideogram_v4_handler = _ideogram_router(handle_ideogram_v4_generate, "ideogram/v4")
        _ideogram_edit_handler = _ideogram_router(handle_ideogram_edit, "fal-ai/ideogram/v3/edit")
        _ideogram_remix_handler = _ideogram_router(handle_ideogram_remix, "fal-ai/ideogram/v3/remix")
        _ideogram_reframe_handler = _ideogram_router(
            handle_ideogram_reframe, "fal-ai/ideogram/v3/reframe", require_param="resolution"
        )
        _ideogram_replace_bg_handler = _ideogram_router(
            handle_ideogram_replace_background, "fal-ai/ideogram/v3/replace-background"
        )
        _ideogram_upscale_handler = _ideogram_router(handle_ideogram_upscale, "fal-ai/ideogram/upscale")

        _ideogram_character_route = _ideogram_router(handle_ideogram_character, "fal-ai/ideogram/character")

        async def _ideogram_character_handler(node, inputs, api_keys):
            # Fold an attached Character bundle into prompt + reference_images for
            # BOTH routes (trait string verbatim, stored views first — identity.py).
            expanded = expand_character_inputs(node, inputs)
            refs = expanded.get("reference_images")
            if not refs or not refs.value:
                raise ValueError(
                    "Ideogram Character needs reference images — connect Character Refs "
                    "or attach a Character node"
                )
            return await _ideogram_character_route(node, expanded, api_keys)

        # Direct-only Ideogram capabilities (no FAL equivalents) — these require
        # IDEOGRAM_API_KEY and bind the engine's emit for progress events.
        def _ideogram_direct(handler):
            async def _run(node, inputs, api_keys):
                return await handler(node, inputs, api_keys, emit=emit)
            return _run

        _ideogram_describe_handler = _ideogram_direct(handle_ideogram_describe)
        _ideogram_magic_prompt_handler = _ideogram_direct(handle_ideogram_magic_prompt)
        _ideogram_transparent_handler = _ideogram_direct(handle_ideogram_transparent)
        _ideogram_remove_bg_handler = _ideogram_direct(handle_ideogram_remove_background)
        _ideogram_layerize_handler = _ideogram_direct(handle_ideogram_layerize)
        _ideogram_edit_prompt_handler = _ideogram_direct(handle_ideogram_edit_prompt)
        _ideogram_train_model_handler = _ideogram_direct(handle_ideogram_train_model)

        registry["seedance-2-t2v"] = _seedance2_t2v_handler
        registry["seedance-2-i2v"] = _seedance2_i2v_handler
        registry["seedance-2-r2v"] = _seedance2_r2v_handler
        registry["seedance-2-fast-t2v"] = _seedance2_fast_t2v_handler
        registry["seedance-2-fast-i2v"] = _seedance2_fast_i2v_handler
        registry["flux-kontext"] = _flux_kontext_handler
        registry["flux-2-pro"] = _flux2_pro_handler
        registry["gpt-image-1-5"] = _gpt_image_15_handler
        registry["gpt-image-1-5-edit"] = _gpt_image_15_edit_handler
        async def _gpt_image_2_fal_generate_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "openai/gpt-image-2")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _gpt_image_2_fal_edit_handler(node, inputs, api_keys):
            node.params.setdefault("endpoint_id", "openai/gpt-image-2/edit")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        registry["gpt-image-2-generate"] = _openai_image_2_generate_handler
        registry["gpt-image-2-edit"] = _openai_image_2_edit_handler
        registry["gpt-image-2-fal-generate"] = _gpt_image_2_fal_generate_handler
        registry["gpt-image-2-fal-edit"] = _gpt_image_2_fal_edit_handler
        registry["seedvr2-upscale"] = _seedvr2_upscale_handler
        registry["clarity-upscaler"] = _clarity_upscaler_handler
        registry["seedvr-video-upscale"] = _seedvr_video_upscale_handler
        registry["seedream-4-5"] = _seedream45_handler
        registry["nano-banana-fal"] = _nano_banana_fal_handler
        registry["nano-banana-fal-edit"] = _nano_banana_fal_edit_handler
        registry["ideogram-v4"] = _ideogram_v4_handler
        registry["ideogram-edit"] = _ideogram_edit_handler
        registry["ideogram-remix"] = _ideogram_remix_handler
        registry["ideogram-reframe"] = _ideogram_reframe_handler
        registry["ideogram-replace-background"] = _ideogram_replace_bg_handler
        registry["ideogram-character"] = _ideogram_character_handler
        registry["ideogram-upscale"] = _ideogram_upscale_handler
        registry["ideogram-describe"] = _ideogram_describe_handler
        registry["ideogram-magic-prompt"] = _ideogram_magic_prompt_handler
        registry["ideogram-transparent"] = _ideogram_transparent_handler
        registry["ideogram-remove-background"] = _ideogram_remove_bg_handler
        registry["ideogram-layerize"] = _ideogram_layerize_handler
        registry["ideogram-edit-prompt"] = _ideogram_edit_prompt_handler
        registry["ideogram-train-model"] = _ideogram_train_model_handler
        registry["krea-2-generate"] = _krea_generate_handler
        registry["krea-style-train"] = _krea_style_train_handler

    return registry
