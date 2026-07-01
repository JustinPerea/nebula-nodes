---
id: nebula-openai-audio
kind: project-model-integration
project: nebula_nodes
provider: openai
model: openai-audio
status: active
verified: 2026-06-30
stale_after_days: 30
---

# OpenAI Audio in Nebula Nodes

Nebula-specific integration notes for the three OpenAI Audio nodes:
`openai-stt`, `openai-translate`, `openai-tts`.

## Sources

Verified against openai-python SDK type stubs fetched 2026-05-16:

- `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/transcription_create_params.py`
- `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/translation_create_params.py`
- `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/speech_create_params.py`

`https://platform.openai.com/docs/api-reference/audio` returned HTTP 403 — SDK stubs used as fallback (same pattern as previous OpenAI Image audit).

## Node Matrix

| Node ID | Endpoint | Key | Use |
|---|---|---|---|
| `openai-stt` | `POST /v1/audio/transcriptions` | `OPENAI_API_KEY` | Transcribe audio to text |
| `openai-translate` | `POST /v1/audio/translations` | `OPENAI_API_KEY` | Translate audio to English text |
| `openai-tts` | `POST /v1/audio/speech` | `OPENAI_API_KEY` | Synthesize speech from text |

## openai-stt Params

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `model` | enum | no | `whisper-1` | `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` |
| `language` | enum | no | `auto` | ISO-639-1 code; `auto` sentinel filtered by handler (not sent to API) |
| `response_format` | enum | no | `text` | `text`, `json`, `verbose_json`, `srt`, `vtt` |
| `temperature` | float | no | `0` | 0–1; silently ignored by gpt-4o-* models |
| `prompt` | string | no | — | Style guide for the model |

Input port: `audio` (Audio, required). Output port: `text` (Text).

## openai-translate Params

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `response_format` | enum | no | `text` | `text`, `json`, `verbose_json`, `srt`, `vtt` |
| `temperature` | float | no | `0` | 0–1 |
| `prompt` | string | no | — | Must be in English |

Model is hardcoded to `whisper-1` in the handler (only model that supports this endpoint). Not exposed in UI.

Input port: `audio` (Audio, required). Output port: `text` (Text).

## openai-tts Params

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `model` | enum | no | `tts-1` | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` |
| `voice` | enum | no | `alloy` | See voice list below |
| `speed` | float | no | `1.0` | 0.25–4.0 |
| `response_format` | enum | no | `mp3` | `mp3`, `wav`, `flac`, `opus`, `aac`, `pcm` |
| `instructions` | string | no | — | Voice style instructions; only respected by `gpt-4o-mini-tts` |

### TTS Voice List (as of 2026-05-16)

`alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`, `sage`, `shimmer`, `verse`

Input port: `text` (Text, required). Output port: `audio` (Audio).

## Findings

### openai-translate — Missing `temperature` param (FIXED)

**Severity:** Medium. The OpenAI translations API accepts `temperature` (0–1), and the handler already reads `node.params.get("temperature")`. The registry did not expose it, so users had no way to set it.

**Fix:** Added `temperature` param to `openai-translate` in both `node_definitions.json` and `nodeDefinitions.ts`.

### openai-translate — Missing `verbose_json` response format (FIXED)

**Severity:** Low. The SDK stubs show `verbose_json` is a valid `response_format` for translations. The registry only listed `text`, `json`, `srt`, `vtt`.

**Fix:** Added `verbose_json` option to the `response_format` enum for `openai-translate`.

### openai-translate — Prompt placeholder misleading (FIXED)

**Severity:** Low. Old placeholder said "Guide the model (optional)" without noting the English-only constraint. The translations API docs specify the prompt must be in English.

**Fix:** Updated placeholder to "Guide the model (must be in English)".

### openai-tts — Missing voices: cedar, marin, verse (FIXED)

**Severity:** Medium. Three voices present in the SDK type stubs were absent from the registry voice enum: `cedar`, `marin`, `verse`. Selecting them via a saved graph with those values would have silently sent them to the API, but they were unreachable from the UI.

**Fix:** Added `cedar`, `marin`, `verse` to the voice enum in both registries.

### openai-tts — Missing formats: aac, pcm (FIXED)

**Severity:** Medium. The TTS endpoint accepts six formats: `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`. The registry only listed four (`mp3`, `wav`, `flac`, `opus`), omitting `aac` and `pcm`.

**Fix:** Added `aac` and `pcm` to the `response_format` enum in both registries.

### openai-tts — Latent extension bug for aac/pcm (FIXED)

**Severity:** High (latent). The handler computed the saved file extension with:

```python
ext = response_format if response_format in ("mp3", "wav", "flac", "opus") else "mp3"
```

This meant that if `aac` or `pcm` were ever sent (e.g. via a saved graph or future registry update), the file would be saved with a `.mp3` extension regardless. Now that `aac` and `pcm` are added to the registry, this would have been a live bug.

**Fix:** Replaced the hard-coded tuple check with a `_TTS_VALID_FORMATS` set constant containing all six valid formats:

```python
_TTS_VALID_FORMATS = {"mp3", "opus", "aac", "flac", "wav", "pcm"}
ext = response_format if response_format in _TTS_VALID_FORMATS else "mp3"
```

### openai-tts — Missing `instructions` param for gpt-4o-mini-tts (FIXED)

**Severity:** Low. `gpt-4o-mini-tts` supports a string `instructions` field for voice style control (e.g. "Speak slowly with warmth"). Not present in registry or handler.

**Fix:** Added `instructions` param to the registry (both JSON and TS). Handler already reads and forwards it conditionally.

### openai-stt — timestamp_granularities not in registry (NOT FIXED — follow-up)

**Severity:** Low. The API supports `timestamp_granularities` (`word` or `segment`) when `response_format=verbose_json`. This is a multipart repeated field (`timestamp_granularities[]`). The handler had partial support for it in a previous iteration that was removed. Adding it properly requires either UI to select multiple values or the handler to accept a comma-joined list. Deferred as follow-up — the missing param does not cause breakage, it just limits the output detail available to users of the `verbose_json` format.

### Nodes Passing All Checks

| Check | openai-stt | openai-translate | openai-tts |
|---|---|---|---|
| Port id ↔ handler read match | PASS | PASS | PASS |
| Required ports marked required | PASS | PASS | PASS |
| All registered params forwarded by handler | PASS | PASS | PASS |
| Enum values match SDK stubs | PASS | FIXED | FIXED |
| Default models current | PASS | N/A (fixed) | PASS |
| Output port type correct | Text — PASS | Text — PASS | Audio — PASS |
| Missing API key error names OPENAI_API_KEY | PASS | PASS | PASS |
| File extension follows response_format | N/A | N/A | FIXED |

## Open Questions

1. **timestamp_granularities for STT verbose_json** — The translations endpoint does not support it, but the transcription endpoint does. If users need word-level timestamps, what should the UI look like? A multi-select checkbox? A hidden param that auto-activates when `verbose_json` is selected? Needs UX decision before implementing.

2. **`gpt-4o-transcribe-diarize` model** — Present in SDK stubs with its own `response_format` (`diarized_json`) and restrictions (no `temperature`, no `prompt`, requires `chunking_strategy` for files > 30s). Not added to registry — it warrants its own node or a dedicated diarize mode given the constraint differences.

3. **`stream` param for TTS** — The SDK stubs expose `stream_format` (`sse` or `audio`) for streaming TTS responses. Not currently supported in Nebula. Would require SSE plumbing similar to gpt-image-2.
