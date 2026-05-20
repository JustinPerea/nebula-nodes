---
id: nebula-elevenlabs
kind: project-model-integration
project: nebula_nodes
provider: elevenlabs
model: elevenlabs-tts, elevenlabs-sfx, elevenlabs-sts, elevenlabs-isolation, elevenlabs-dubbing
status: active
verified: 2026-05-17
stale_after_days: 30
---

# ElevenLabs Family in Nebula Nodes

Nebula-specific integration notes for the five ElevenLabs nodes:
`elevenlabs-tts`, `elevenlabs-sfx`, `elevenlabs-sts`, `elevenlabs-isolation`, `elevenlabs-dubbing`.

All share `backend/handlers/elevenlabs.py`.

## Sources

Verified against canonical sources fetched 2026-05-16:

- `https://api.elevenlabs.io/openapi.json` — machine-readable OpenAPI spec (authoritative)
- `https://elevenlabs.io/docs/api-reference/text-to-speech/convert` — TTS endpoint reference
- `https://elevenlabs.io/docs/api-reference/speech-to-speech/convert` — STS endpoint reference
- `https://elevenlabs.io/docs/api-reference/audio-isolation/convert` — Isolation endpoint reference
- `https://github.com/elevenlabs/elevenlabs-python` — official Python SDK (Fern-generated)
  - `src/elevenlabs/text_to_speech/client.py` — TTS `convert()` signature
  - `src/elevenlabs/text_to_sound_effects/client.py` — SFX `convert()` signature
  - `src/elevenlabs/speech_to_speech/client.py` — STS `convert()` signature
  - `src/elevenlabs/audio_isolation/client.py` — Isolation `convert()` signature
  - `src/elevenlabs/dubbing/client.py` — Dubbing `create()` / `get()` signatures
  - `src/elevenlabs/dubbing/audio/client.py` — Dubbing audio `get()` (download)
  - `src/elevenlabs/types/dubbing_metadata_response.py` — Status field schema
  - `src/elevenlabs/text_to_speech/types/text_to_speech_convert_request_output_format.py`
  - `src/elevenlabs/types/allowed_output_formats.py` — SFX output format enum

Several docs pages (`/sound-generation/generate`, `/dubbing/start`) returned 404 at time of audit;
the SDK stubs and `openapi.json` were used as the authoritative fallback per audit protocol.

## API Fundamentals

| Field | Value |
|---|---|
| Base URL | `https://api.elevenlabs.io` |
| Auth header | `xi-api-key: {key}` (NOT `Authorization: Bearer`) |
| TTS endpoint | `POST /v1/text-to-speech/{voice_id}?output_format=…` |
| SFX endpoint | `POST /v1/sound-generation?output_format=…` |
| STS endpoint | `POST /v1/speech-to-speech/{voice_id}?output_format=…` (multipart/form-data) |
| Isolation endpoint | `POST /v1/audio-isolation` (multipart/form-data) |
| Dubbing submit | `POST /v1/dubbing` (multipart/form-data) |
| Dubbing poll | `GET /v1/dubbing/{dubbing_id}` |
| Dubbing download | `GET /v1/dubbing/{dubbing_id}/audio/{language_code}` |

## Node Summary

| Node | Inputs | Output | Exec pattern |
|---|---|---|---|
| `elevenlabs-tts` | `text` (Text) | `audio` (Audio) | sync |
| `elevenlabs-sfx` | `text` (Text) | `audio` (Audio) | sync |
| `elevenlabs-sts` | `audio` (Audio) | `audio` (Audio) | sync |
| `elevenlabs-isolation` | `audio` (Audio) | `audio` (Audio) | sync |
| `elevenlabs-dubbing` | `audio` (Audio) | `audio` (Audio) | sync (internal async poll) |

## Findings and Fixes

### PCM output saved as `.wav` without WAV header — broken file (FIXED 2026-05-17, found via live smoke test)

**Severity:** High. The original audit missed this because the failing path was pinned
by structural tests that asserted the wrong behavior — tests checked that PCM output
produced a `.wav` file, but never verified the file's actual content.

ElevenLabs `pcm_*` `output_format` values return RAW PCM bytes (no RIFF/WAVE header).
The handler was saving those bytes with a `.wav` extension. Media players that infer
format from extension would reject the file (`file` reports `data`, not `WAVE audio`).
Caught by smoke-testing `elevenlabs-tts` with `output_format=pcm_24000` on 2026-05-17:
file started with `00 00 00 00` instead of `RIFF`.

**Fix:** Extracted `_audio_extension(output_format)` helper that maps:
- `mp3` → `.mp3`
- `pcm` → `.pcm` (was `.wav`)
- `wav` → `.wav`

Applied to both `handle_elevenlabs_tts` and the shared `_save_audio` helper used by
SFX, STS, and isolation. Three existing tests (`test_*_pcm_format_saves_as_wav`)
renamed to `_saves_as_pcm` and updated to assert the correct extension.

**Lesson for future audits:** when an extension fix activates a previously-dropped
param (OpenAI Image precedent), verify the saved file format matches the extension.
When an extension is hard-coded to a value that differs from the API's actual byte
shape (this case), audit the byte shape, not just the extension string.

### TTS: `speed` was a top-level body field — should be inside `voice_settings` (FIXED)

**Severity:** High. The ElevenLabs API spec places `speed` inside the `voice_settings`
object, alongside `stability`, `similarity_boost`, `style`, and `use_speaker_boost`. The
handler was sending `speed` as a top-level body key alongside `text` and `model_id`. This
would have been silently ignored by the API (unknown top-level keys are dropped).

**Fix:** `speed` is now set in `voice_settings["speed"]`. The separate `if speed != 1.0`
conditional was removed — `speed` is always included in `voice_settings` (matching the
API's default of `1.0`).

### TTS: Model lineup incomplete (FIXED)

**Severity:** Medium. The node offered three models:
- `eleven_v3` (correct)
- `eleven_multilingual_v2` (correct)
- `eleven_flash_v2_5` (correct)

The SDK and OpenAPI spec list additional current models not offered in the UI:
- `eleven_turbo_v2_5` — low-latency option
- `eleven_turbo_v2` — prior turbo generation, still supported
- `eleven_flash_v2` — prior flash generation, still supported
- `eleven_monolingual_v1` / `eleven_multilingual_v1` — legacy; intentionally excluded as
  outdated

**Fix:** Added `eleven_turbo_v2_5`, `eleven_turbo_v2`, `eleven_flash_v2` to both JSON and
TypeScript registries.

### SFX: PCM format options mislabeled as "WAV" (FIXED)

**Severity:** Low (UX). The SFX node offered `pcm_44100` labeled "WAV 44.1kHz" and
`pcm_24000` labeled "WAV 24kHz". These are raw PCM formats, not WAV container format.
The `AllowedOutputFormats` enum for SFX (`/v1/sound-generation`) does not include `wav_*`
values — only `pcm_*`, `mp3_*`, `opus_*`, `ulaw_8000`, and `alaw_8000`.

**Fix:** Labels corrected to "PCM 44.1kHz" and "PCM 24kHz" in both registries. Values
unchanged (`pcm_44100`, `pcm_24000` are valid API enum values). The `_save_audio` helper
correctly maps `pcm_*` → `.wav` extension (standard practice for raw PCM files).

### STS: `voice_settings` never forwarded (FIXED + LIVE-VERIFIED 2026-05-19)

**Severity:** High. The STS API accepts `voice_settings` as a JSON-encoded string in the
multipart form body. The handler sent `model_id` and `remove_background_noise` but never
forwarded `stability` or `similarity_boost`, even though they were present in the node
params from Phase 1 (they were listed as params but never read or sent).

**Fix:** The handler now reads `stability` and `similarity_boost` from `node.params`. When
either is present, it constructs a `voice_settings` dict and serialises it with
`json.dumps()`, then sends it as the `voice_settings` multipart field — matching the API's
expected format.

**Live-smoke (2026-05-19):** Verified end-to-end via
`backend/scripts/smoke_elevenlabs_sts.py` with `stability=0.7`, `similarity_boost=0.6`,
`seed=42`, and a 3s MP3 input. API returned 200; output MP3 is valid (ID3 header present),
duration 3.02s, 49KB at `mp3_44100_128`. Multipart `voice_settings` and `seed` fields both
accepted without rejection. No further bugs found.

### STS: `seed` param not forwarded (FIXED)

**Severity:** Medium. The STS API supports `seed` (integer 0–4294967295) for deterministic
sampling, documented in both the OpenAPI spec and SDK. The param was not in the node
definition and not read by the handler.

**Fix:** Added `seed` param to both registries. Handler reads it and forwards as
`data["seed"] = str(int(seed))` in the multipart form.

### STS: PCM format options mislabeled as "WAV" (FIXED)

**Severity:** Low (UX). Same mislabeling issue as SFX. `pcm_44100` and `pcm_24000`
were labeled "WAV 44.1kHz" / "WAV 24kHz".

**Fix:** Labels corrected to "PCM 44.1kHz" / "PCM 24kHz" in both registries.

### STS: Missing `stability` and `similarity_boost` params in registries (FIXED)

**Severity:** Medium. The handler fix for voice_settings would be useless without the
params being declared. Both were absent from the STS node definition.

**Fix:** Added `stability` (float, default 0.5, 0–1) and `similarity_boost` (float,
default 0.75, 0–1) to both JSON and TypeScript registries for `elevenlabs-sts`.

### Dubbing: Silent poll failures swallowed indefinitely (FIXED)

**Severity:** Medium. The polling loop used `continue` on any non-200 status response,
meaning transient 500/503 errors during the poll phase would silently retry for up to 10
minutes (120 × 5s) with no signal to the caller.

**Fix:** Added a `poll_errors` counter. After 5 consecutive non-200 poll responses, the
handler raises `RuntimeError` with the HTTP status and body, failing fast rather than
spinning silently.

### Handler: `import asyncio` and `import json` moved to module top-level (FIXED)

**Severity:** Low (code quality). Both were inline imports inside functions. Moved to
module-level imports per Python convention.

### `base64` import removed (FIXED)

**Severity:** Trivial. `base64` was imported at module level but never used. Removed.

## Param Matrix (post-audit)

### elevenlabs-tts

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `model_id` | enum | no | `eleven_multilingual_v2` | `model_id` | See model lineup |
| `voice_id` | string | no | Rachel ID | path param `{voice_id}` | |
| `stability` | float | no | 0.5 | `voice_settings.stability` | 0–1 |
| `similarity_boost` | float | no | 0.75 | `voice_settings.similarity_boost` | 0–1 |
| `style` | float | no | 0 | `voice_settings.style` | Only sent when > 0 |
| `use_speaker_boost` | boolean | no | true | `voice_settings.use_speaker_boost` | |
| `speed` | float | no | 1.0 | `voice_settings.speed` | 0.7–1.2; always sent |
| `output_format` | enum | no | `mp3_44100_128` | `?output_format=` query | |
| `seed` | integer | no | — | `seed` | Only sent when set |

### elevenlabs-sfx

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `duration_seconds` | float | no | — | `duration_seconds` | 0.5–30; omitted when not set |
| `prompt_influence` | float | no | 0.3 | `prompt_influence` | 0–1 |
| `loop` | boolean | no | false | `loop` | Only for `eleven_text_to_sound_v2` |
| `output_format` | enum | no | `mp3_44100_128` | `?output_format=` query | |

### elevenlabs-sts

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `voice_id` | string | no | Rachel ID | path param `{voice_id}` | |
| `model_id` | enum | no | `eleven_english_sts_v2` | `model_id` (multipart) | |
| `stability` | float | no | 0.5 | `voice_settings` (JSON string) | ADDED |
| `similarity_boost` | float | no | 0.75 | `voice_settings` (JSON string) | ADDED |
| `remove_background_noise` | boolean | no | false | `remove_background_noise` (multipart) | |
| `seed` | integer | no | — | `seed` (multipart string) | ADDED |
| `output_format` | enum | no | `mp3_44100_128` | `?output_format=` query | |

### elevenlabs-isolation

No params. Only input is the audio file; output is always MP3.

### elevenlabs-dubbing

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `target_lang` | enum | yes | `es` | `target_lang` (multipart) | ISO 639-1 |
| `source_lang` | enum | no | `auto` | `source_lang` (multipart) | Omitted when `auto` |
| `num_speakers` | integer | no | — | `num_speakers` (multipart string) | Omitted when 0 or absent |
| `drop_background_audio` | boolean | no | false | `drop_background_audio` | |
| `disable_voice_cloning` | boolean | no | false | `disable_voice_cloning` | |

## TTS Model Lineup (post-audit)

| Label | API ID | Notes |
|---|---|---|
| v3 (Highest Quality) | `eleven_v3` | Best quality |
| Multilingual v2 | `eleven_multilingual_v2` | Default; best balance |
| Turbo v2.5 (Low Latency) | `eleven_turbo_v2_5` | ADDED |
| Flash v2.5 (Fastest) | `eleven_flash_v2_5` | Fastest generation |
| Turbo v2 | `eleven_turbo_v2` | ADDED |
| Flash v2 | `eleven_flash_v2` | ADDED |

## Output Format / File Extension Mapping

| Format prefix | File extension | Notes |
|---|---|---|
| `mp3_*` | `.mp3` | Default |
| `pcm_*` | `.wav` | Raw PCM saved as .wav (convention) |
| `wav_*` | `.wav` | TTS/STS only; not available for SFX |
| `opus_*` | `.mp3` | Currently no opus options in UI |
| `ulaw_*` / `alaw_*` | `.mp3` | Telephony; not offered in UI |

Note: isolation always outputs MP3 (hardcoded); dubbing always outputs MP3 (hardcoded).

## Dubbing Flow

```
POST /v1/dubbing          → { dubbing_id, expected_duration_sec }
  ↓ poll every 5s (max 120 attempts = 10 min)
GET /v1/dubbing/{id}      → { status: "dubbing" | "dubbed" | "failed", error? }
  ↓ when status == "dubbed"
GET /v1/dubbing/{id}/audio/{language_code}  → binary MP3/MP4 stream
```

Poll failure handling: 5 consecutive non-200 responses → raise immediately (FIXED).

## Check Summary

| Check | elevenlabs-tts | elevenlabs-sfx | elevenlabs-sts | elevenlabs-isolation | elevenlabs-dubbing |
|---|---|---|---|---|---|
| Port id ↔ handler read match | PASS | PASS | PASS | PASS | PASS |
| Output port id ↔ handler return key | PASS | PASS | PASS | PASS | PASS |
| Auth header `xi-api-key` used | PASS | PASS | PASS | PASS | PASS |
| Base URL correct | PASS | PASS | PASS | PASS | PASS |
| `speed` inside `voice_settings` | FIXED | N/A | N/A | N/A | N/A |
| Model lineup current | FIXED | N/A | PASS | N/A | N/A |
| PCM format labels correct | PASS | FIXED | FIXED | N/A | N/A |
| `voice_settings` forwarded | PASS | N/A | FIXED | N/A | N/A |
| `seed` param forwarded | PASS | N/A | FIXED | N/A | N/A |
| Output file extension correct | PASS | PASS | PASS | PASS | PASS |
| Poll failures raise after threshold | N/A | N/A | N/A | N/A | FIXED |
| `source_lang=auto` omitted from payload | N/A | N/A | N/A | N/A | PASS |
| Dubbing download URL correct | N/A | N/A | N/A | N/A | PASS |

## Open Questions

1. **STS `remove_background_noise_level`** — The SDK now includes a `remove_background_noise_level`
   field (`"low" | "medium" | "high"`) as a companion to `remove_background_noise`. Not yet
   added to the node definition. Low priority until the feature is more prominent in docs.

2. **SFX model_id** — The SFX handler defaults to `"eleven_text_to_sound_v2"` and passes
   it in the body. The OpenAPI spec accepts an optional `model_id` string but lists no enum;
   it is not clear whether other model IDs are valid. The current default appears correct
   based on SDK examples, but cannot be fully verified until ElevenLabs publishes an explicit
   model list for the SFX endpoint.

3. **Dubbing `expected_duration_sec` in submit response** — The `DoDubbingResponse` includes
   `expected_duration_sec` (float). The handler discards it. This could be used to set a
   smarter poll timeout rather than the flat 120 × 5s ceiling.

4. **Opus extension** — If `opus_*` output formats are ever added to the UI, `_save_audio`
   will incorrectly save them as `.mp3`. The extension logic needs a third branch for `opus`.

5. **Isolation output format** — The isolation endpoint returns audio but the handler
   hardcodes `"mp3_44100_128"` for the extension calculation. The API does not accept an
   `output_format` query parameter for isolation (confirmed by SDK: no such param in
   `audio_isolation/client.py`). This is correct behavior — isolation output is always MP3.
