"""ElevenLabs' own API for the fal, Krea and Runway copies of its models.

Each node here runs on ElevenLabs with the person's ``ELEVENLABS_API_KEY``
and otherwise on the copy it always ran on (services/node_route.py
``select_route``; the router is execution/maker_routes.py ``dual_route``):

- ``elevenlabs-music`` (fal ``fal-ai/elevenlabs/music``) and the Krea copies
  ``krea-audio-elevenlabs-music``, ``-music-v2``, ``-music-v2-5`` ->
  POST /v1/music with ``music_v1`` / ``music_v2`` / ``music_v2_5``.
- ``krea-audio-elevenlabs-tts`` -> POST /v1/text-to-speech/{voice_id}. Krea's
  schema documents both fields as ElevenLabs': ``voice_id`` "ElevenLabs voice
  ID. Available voices: Bella (hpp4J3VqNfWAUOO0d1Us), ..." and ``model_id``
  "ElevenLabs model ID. Defaults to eleven_multilingual_v2"
  (https://api.krea.ai/openapi.json, read 2026-10-14).
- ``runway-tts``, ``runway-sts``, ``runway-dubbing``: Runway resells
  ElevenLabs ("Multilingual v2 | `eleven_multilingual_v2`", "Multilingual
  Speech to Speech | `eleven_multilingual_sts_v2`", "ElevenLabs Voice Dubbing
  | `eleven_voice_dubbing`", https://docs.dev.runwayml.com/llms-full.txt,
  read 2026-10-14). Runway's voices are its own presets ("the same Runway
  preset voices"), not ElevenLabs voice ids, and nothing maps one to the
  other, so TTS and STS take the ElevenLabs route only when the recipe names
  an ElevenLabs ``voice_id`` (node_route.DIRECT_REQUIRES); a recipe with just
  a Runway preset stays on Runway.

Every translator works on the route-filtered copy ``dual_route`` passes in
and never touches the saved node. A setting the node doesn't save takes its
definition default, the same value pricing reads.
"""
from __future__ import annotations

from functools import partial
from typing import Any, Awaitable, Callable, Mapping

from models.graph import GraphNode, PortValueDict
from services import node_route
from execution.person_line import with_person_line

Handler = Callable[[GraphNode, dict[str, PortValueDict], dict[str, str]], Awaitable[dict[str, Any]]]
Translate = Callable[
    [GraphNode, dict[str, PortValueDict]], tuple[GraphNode, dict[str, PortValueDict]]
]

# Runway's handlers (handlers/runway.py) send these fixed models.
RUNWAY_TTS_MODEL = "eleven_multilingual_v2"
RUNWAY_STS_MODEL = "eleven_multilingual_sts_v2"
# Runway's voice preset param, and the ElevenLabs voice id that replaces it on
# the direct route (directParams; node_route.DIRECT_REQUIRES).
RUNWAY_PRESET_PARAM = "voiceId"
ELEVENLABS_VOICE_PARAM = "voice_id"


def _default(definition_id: str, key: str) -> Any:
    from execution.maker_routes import definition_for

    param = node_route.param_definition(definition_for(definition_id), key)
    return param.get("default") if param is not None else None


def _value(node: GraphNode, key: str) -> Any:
    """The saved value, else the definition default (what pricing reads)."""
    value = node.params.get(key)
    if value is None or value == "":
        return _default(node.definition_id, key)
    return value


def _prompt(node: GraphNode, inputs: Mapping[str, PortValueDict], port: str = "prompt") -> PortValueDict | None:
    """A Krea copy's prompt: the wired port, else the prompt param."""
    wired = inputs.get(port)
    if wired is not None and wired.value not in (None, ""):
        return wired
    if node.params.get("prompt"):
        return PortValueDict(type="Text", value=str(node.params["prompt"]))
    return None


def _copy(node: GraphNode, params: dict[str, Any]) -> GraphNode:
    return node.model_copy(update={"params": {k: v for k, v in params.items() if v is not None and v != ""}})


# -- Music ---------------------------------------------------------------------

def fal_music_to_elevenlabs(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """elevenlabs-music: fal's names are ElevenLabs' (music_length_ms,
    force_instrumental, same 3000-600000 range); model_id is the direct-only
    choice (default music_v1, ElevenLabs' own default)."""
    params = {key: _value(node, key) for key in ("model_id", "music_length_ms", "force_instrumental")}
    return _copy(node, params), {"prompt": inputs["prompt"]} if "prompt" in inputs else {}


def krea_music_to_elevenlabs(model: str) -> Translate:
    """A Krea music copy -> handle_elevenlabs_music for one model. Krea's
    fields are ElevenLabs' (prompt, music_length_ms 3000-600000 or omitted "to
    let the model choose", force_instrumental), so nothing is dropped."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = {"model_id": model, "music_length_ms": _value(node, "music_length_ms"),
                  "force_instrumental": _value(node, "force_instrumental")}
        prompt = _prompt(node, inputs)
        return _copy(node, params), ({"prompt": prompt} if prompt else {})

    return translate


async def elevenlabs_music(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from handlers.elevenlabs import handle_elevenlabs_music

    return await handle_elevenlabs_music(node, inputs, api_keys)


# -- Krea TTS ------------------------------------------------------------------

def krea_tts_to_elevenlabs(model: str) -> Translate:
    """krea-audio-elevenlabs-tts -> handle_elevenlabs_tts: prompt (port, else
    param) -> text; voice_id and model_id as saved (Krea default Bella,
    hpp4J3VqNfWAUOO0d1Us, and eleven_multilingual_v2). ``model`` is the
    overlay's model, used only when the node saves none and has no default.
    Krea exposes no voice settings, so none are sent (the voice's stored
    settings apply)."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = {"voice_id": _value(node, "voice_id"), "model_id": _value(node, "model_id") or model}
        prompt = _prompt(node, inputs)
        return _copy(node, params), ({"text": prompt} if prompt else {})

    return translate


async def elevenlabs_tts_stored_voice(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from handlers.elevenlabs import handle_elevenlabs_tts

    return await handle_elevenlabs_tts(node, inputs, api_keys, voice_settings=False)


async def _krea_ports(result: dict[str, Any]) -> dict[str, Any]:
    """The direct result in a Krea node's ports: audio, audios and artifacts
    (no Krea job on this route)."""
    from services.output import portable_output_ref

    ref = portable_output_ref(str(result["audio"]["value"]), require_file=True)
    return {
        "audio": result["audio"],
        "audios": {"type": "Array", "value": [ref]},
        "artifacts": {"type": "Array", "value": [{"type": "Audio", "value": ref}]},
    }


async def krea_elevenlabs_music(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    return await _krea_ports(await elevenlabs_music(node, inputs, api_keys))


async def krea_elevenlabs_tts(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    return await _krea_ports(await elevenlabs_tts_stored_voice(node, inputs, api_keys))


# Translation ids a generated Krea node names in ``directRoute.translation``
# (scripts/sync-krea-catalog.py DIRECT_ROUTES); maker_routes.KREA_TRANSLATIONS
# merges these.
KREA_TRANSLATIONS: dict[str, tuple[Handler, Callable[[str], Translate]]] = {
    "krea-elevenlabs-music": (krea_elevenlabs_music, krea_music_to_elevenlabs),
    "krea-elevenlabs-tts": (krea_elevenlabs_tts, krea_tts_to_elevenlabs),
}


# -- Runway's ElevenLabs models -------------------------------------------------

def _voice_id(node: GraphNode) -> str:
    voice = node.params.get(ELEVENLABS_VOICE_PARAM)
    if not isinstance(voice, str) or not voice.strip():
        # select_route keeps such a run on Runway (DIRECT_REQUIRES); this is
        # the guard if a caller skips it.
        raise with_person_line(
            ValueError("The ElevenLabs route needs an ElevenLabs voice_id; Runway voice presets don't carry over"),
            "To run this on ElevenLabs, fill in “ElevenLabs voice ID”. Runway voice presets don't carry over.")
    return voice.strip()


def runway_tts_to_elevenlabs(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """runway-tts -> handle_elevenlabs_tts with Runway's model
    (eleven_multilingual_v2) and the recipe's ElevenLabs voice_id. Runway's
    voiceId preset is Runway-only (falParams) and never reaches here. The
    whole text is sent (Runway's handler cuts it at 1,000 characters;
    ElevenLabs takes 10,000 on this model, docs/overview/models)."""
    params = {"voice_id": _voice_id(node), "model_id": RUNWAY_TTS_MODEL}
    return _copy(node, params), ({"text": inputs["text"]} if "text" in inputs else {})


def runway_sts_to_elevenlabs(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """runway-sts -> handle_elevenlabs_sts: eleven_multilingual_sts_v2, the
    ElevenLabs voice_id, removeBackgroundNoise -> remove_background_noise.
    ElevenLabs' speech-to-speech takes an ``audio`` file only ("The audio file
    which holds the content and emotion that will control the generated
    speech", api-reference/speech-to-speech/convert, read 2026-10-14), so a
    run with only Runway's video input stays on Runway: the definition's
    directRoute rejectsWhen ``{video: "(set)", audio: "(unset)"}``. The check
    below is the guard if a caller skips select_route."""
    audio = inputs.get("audio")
    if audio is None or audio.value in (None, ""):
        if inputs.get("video") is not None and inputs["video"].value not in (None, ""):
            raise with_person_line(ValueError("ElevenLabs speech-to-speech takes audio, not video. Wire the audio track into "
                             "Audio, or clear the ElevenLabs voice_id to run this on Runway."),
                "ElevenLabs speech-to-speech takes audio, not video. Connect the audio track to “Audio”, or clear “ElevenLabs voice ID” to run this on Runway.")
        raise with_person_line(ValueError("Audio input is required for speech-to-speech"), "Connect audio to this node, then run it again.")
    params = {"voice_id": _voice_id(node), "model_id": RUNWAY_STS_MODEL,
              "remove_background_noise": bool(_value(node, "removeBackgroundNoise"))}
    return _copy(node, params), {"audio": audio}


# Runway's dubbing names -> ElevenLabs' (POST /v1/dubbing fields
# `target_lang`, `num_speakers`, `drop_background_audio`,
# `disable_voice_cloning`; docs/api-reference/legacy/dubbing/create).
RUNWAY_DUBBING_PARAMS = {
    "targetLang": "target_lang",
    "numSpeakers": "num_speakers",
    "dropBackgroundAudio": "drop_background_audio",
    "disableVoiceCloning": "disable_voice_cloning",
}


def runway_dubbing_to_elevenlabs(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """runway-dubbing -> handle_elevenlabs_dubbing: a rename only. Runway's 28
    target languages are all in ElevenLabs' Dubbing v1 list
    (https://elevenlabs.io/docs/help-center/product/dubbing/which-languages-are-supported-in-dubbing,
    "Dubbing v1 supports the same languages as the Eleven v3 model")."""
    params = {theirs: _value(node, ours) for ours, theirs in RUNWAY_DUBBING_PARAMS.items()}
    return _copy(node, params), ({"audio": inputs["audio"]} if "audio" in inputs else {})


def register(registry: dict[str, Handler], emit: Any) -> None:
    """Wrap the registered fal/Runway handlers of these nodes in their
    ElevenLabs dual route (execution/sync_runner.py calls this once the
    provider handlers exist)."""
    from execution.maker_routes import dual_route
    from handlers.elevenlabs import handle_elevenlabs_dubbing, handle_elevenlabs_sts

    async def sts(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
        return await handle_elevenlabs_sts(node, inputs, api_keys)

    routes: dict[str, tuple[Handler, Translate]] = {
        "elevenlabs-music": (elevenlabs_music, fal_music_to_elevenlabs),
        "runway-tts": (elevenlabs_tts_stored_voice, runway_tts_to_elevenlabs),
        "runway-sts": (sts, runway_sts_to_elevenlabs),
        "runway-dubbing": (partial(handle_elevenlabs_dubbing, emit=emit), runway_dubbing_to_elevenlabs),
    }
    for node_id, (direct, translate) in routes.items():
        fallback = registry.get(node_id)
        if fallback is None:
            raise ValueError(f"{node_id}: no fallback handler registered to route around")
        registry[node_id] = dual_route(direct=direct, fallback=fallback, translate=translate)
