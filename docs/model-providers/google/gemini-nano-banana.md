---
id: nebula-google-gemini-nano-banana
kind: project-model-integration
project: nebula_nodes
provider: google
status: active
verified: 2026-05-17
stale_after_days: 14
---

# Gemini and Nano Banana in Nebula Nodes

Nebula-specific integration notes for Google's Gemini family in Nebula Nodes.

Read the shared provider reference first:

`~/Documents/Workspace/Reference/model-providers/google/gemini-nano-banana.md`

## Audit Log

| Date | Auditor | Scope | Sources |
|---|---|---|---|
| 2026-05-10 | Claude | Initial coverage: gemini-chat, nano-banana, gemini-tts, gemini-embeddings | ai.google.dev |
| 2026-05-17 | Claude | Phase 2 full audit: all 7 Google nodes (+ imagen-4, lyria-3, veo-3). Initial commit fixed handler bugs but introduced 2 regressions on nano-banana and lyria-3 (path/value mismatches); caught by live smoke tests on the same day and corrected. See "Live smoke regressions" below. Net result: gemini-embeddings camelCase fix verified, nano-banana `imageConfig` path restored, lyria-3 `AUDIO_WAV` proto enum value applied. | ai.google.dev/gemini-api/docs (text-generation, image-generation, imagen, video, speech-generation, music-generation, embeddings) accessed 2026-05-17; direct curl verification 2026-05-17 |

### 2026-05-17 Fixes Applied (final state after live smoke regression fix)

| Node | Component | Old (broken) | New (canonical) | Source |
|---|---|---|---|---|
| `nano-banana` | `google_gemini.py` handler | `responseFormat.image.aspectRatio` (interim audit value) | `generationConfig.imageConfig.aspectRatio` (live-verified, accepts natural `"1:1"`/`"16:9"` strings) | direct curl `gemini-3.1-flash-image-preview` 2026-05-17 |
| `lyria-3` | `google_gemini.py` handler | `responseFormat.audio.mimeType = "audio/wav"` (interim audit value rejected by proto) | `responseFormat.audio.mimeType = "AUDIO_WAV"` (proto enum form) | direct curl `lyria-3-pro-preview` 2026-05-17 |
| `gemini-embeddings` | `google_gemini.py` handler | `body["output_dimensionality"]` (snake_case) | `body["outputDimensionality"]` (camelCase) | [embeddings API](https://ai.google.dev/api/embeddings) — live-verified returns 256-dim vector when set |
| `gemini-embeddings` | `node_definitions.json` | `"gemini-embedding-2-preview"` | `"gemini-embedding-2"` (stable model ID) | [embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings) |
| `gemini-tts` | `node_definitions.json` | missing `gemini-3.1-flash-tts-preview` | added as first option | [speech-generation docs](https://ai.google.dev/gemini-api/docs/speech-generation) |

### Live smoke regressions caught and fixed

The first pass of this audit (commit `6a30941`) changed two paths based on the public docs page and shipped tests pinning the new shapes. Live smoke testing the same day exposed two regressions:

1. **nano-banana `responseFormat.image` rejects the natural value strings.** The docs page lists `"1:1"`, `"16:9"`, etc. as valid `aspectRatio` values under `generationConfig.responseFormat.image`, but the live v1beta API returns `Invalid value at 'generation_config.response_format.image.aspect_ratio'` for those strings. The pre-audit path (`generationConfig.imageConfig`) accepts the natural strings and is confirmed working. The audit fix was reverted; the test was flipped to assert the working path.
2. **lyria-3 `responseFormat.audio.mimeType` rejects `"audio/wav"`.** The proto enum `AudioResponseFormat.MimeType` accepts `AUDIO_WAV` (Google's enum constant form), not the literal MIME string the docs imply. The path itself is correct. Note: even with `AUDIO_WAV` set, both `lyria-3-pro-preview` and `lyria-3-clip-preview` currently return `audio/mpeg` — the format preference is parsed and accepted but does not change the response. Tracked as an open question.

**Methodology lesson:** "Canonical docs" is a layered claim. Public doc pages can be stale or describe a separate ingestion path. When an audit changes a request field name or shape, the only reliable check is to hit the live API.

## Node Matrix

| Node ID | Route | Key | Endpoint | Execution | Use |
|---|---|---|---|---|---|
| `gemini-chat` | Google direct | `GOOGLE_API_KEY` | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | stream | Streaming text and vision chat |
| `nano-banana` | Google direct | `GOOGLE_API_KEY` | `/v1beta/models/{model}:generateContent` | sync | Text-to-image and image edit, multi-image composition |
| `imagen-4-generate` | Google direct | `GOOGLE_API_KEY` | `/v1beta/models/{model}:predict` | sync | High-quality photorealistic image generation |
| `lyria-3` | Google direct | `GOOGLE_API_KEY` | `/v1beta/models/{model}:generateContent` | sync | Music/audio generation with optional lyrics |
| `gemini-tts` | Google direct | `GOOGLE_API_KEY` | `/v1beta/models/{model}:generateContent` | sync | Gemini text-to-speech, named voice catalog |
| `gemini-embeddings` | Google direct | `GOOGLE_API_KEY` | `/v1beta/models/{model}:embedContent` | sync | Text and multimodal embeddings |
| `veo-3` | Google direct | `GOOGLE_API_KEY` | `/v1beta/models/{model}:predictLongRunning` | async-poll | Video generation, image-to-video, frame interpolation |

Nebula does not currently expose FAL-routed Gemini/Nano Banana nodes. FAL
endpoints exist (`fal-ai/nano-banana`, `fal-ai/nano-banana-2`,
`fal-ai/nano-banana-pro`, plus matching `/edit` variants, and
`fal-ai/gemini-25-flash-image` and `fal-ai/gemini-3-pro-image-preview`), but
they are not wired as Nebula nodes today.

## `gemini-chat` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` | `gemini-2.5-flash` | Note: official docs list `gemini-3-pro-preview` as shut down 2026-03-09; not exposed here, good. |
| `max_tokens` | 1-65535 | 8192 | Output token cap. |
| `temperature` | 0-2 | 1 | Keep at `1.0` for Gemini 3 models; lower values cause loops. |
| `system` | textarea | "" | System instructions / persona. |
| `thinkingLevel` | `""`, `minimal`, `low`, `medium`, `high` | `""` | Visible only on `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`. |
| `thinkingBudget` | 0-65536 | unset | Visible only on `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. Token-count budget. |
| `top_p` | 0-1 | unset | Optional sampling cap. |
| `top_k` | integer | unset | Default 64 in placeholder. |
| `stop_sequences` | string | unset | Comma-separated. |
| `response_format` | `text/plain`, `application/json` | `text/plain` | Use `application/json` with a schema in the prompt for structured output. |

Inputs: `messages` (Text, required), `images` (Image, optional, multiple).
Output: `text` (Text).

## `nano-banana` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`, `gemini-2.5-flash-image` | `gemini-3.1-flash-image-preview` | Nano Banana 2, Nano Banana Pro, Nano Banana respectively. |
| `aspect_ratio` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9`, plus `1:4`, `4:1`, `1:8`, `8:1` | `1:1` | Extreme ratios only visible/permitted on `gemini-3.1-flash-image-preview`. |
| `imageSize` | `512`, `1K`, `2K`, `4K` | `1K` | Visible only on `gemini-3.1-flash-image-preview` and `gemini-3-pro-image-preview`. `512` is exclusive to `gemini-3.1-flash-image-preview`. `gemini-2.5-flash-image` is fixed-size. |

Inputs: `prompt` (Text, required), `images` (Image, optional, multiple).
Outputs: `image` (Image), `text` (Text).

## `imagen-4-generate` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `imagen-4.0-generate-001`, `imagen-4.0-ultra-generate-001`, `imagen-4.0-fast-generate-001` | `imagen-4.0-generate-001` | Standard, Ultra, Fast tiers. |
| `aspectRatio` | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` | `1:1` | All tiers. |
| `numberOfImages` | 1–4 | 1 | Maps to `parameters.sampleCount`. |
| `seed` | integer | random | Reproducibility. |
| `enhancePrompt` | boolean | false | Maps to `parameters.enhancePrompt`. |
| `imageSize` | `1K`, `2K` | `1K` | Standard and Ultra only; not available on Fast. |
| `personGeneration` | `allow_all`, `allow_adult`, `dont_allow` | `allow_adult` | |

Request shape: `{"instances": [{"prompt": "..."}], "parameters": {...}}` — uses `:predict` endpoint, not `generateContent`. Response: `predictions[].bytesBase64Encoded` + `mimeType`.

Inputs: `prompt` (Text, required).
Output: `image` (Image).

## `lyria-3` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `lyria-3-clip-preview`, `lyria-3-pro-preview` | `lyria-3-clip-preview` | Clip = ~30s MP3; Pro = longer, MP3 or WAV. |
| `outputFormat` | `mp3`, `wav` | `mp3` | WAV only available on Pro. Sent as `generationConfig.responseFormat.audio.mimeType`. |

Request shape: `generateContent` with `generationConfig.responseModalities: ["AUDIO", "TEXT"]`. Response: `candidates[0].content.parts[]` — iterate all parts; text parts contain lyrics, `inlineData` parts contain audio bytes. Audio `mimeType` is `audio/mp3` or `audio/wav`. Extension derived from mimeType.

Inputs: `prompt` (Text, required), `images` (Image, optional — mood reference).
Outputs: `audio` (Audio), `text` (Text — lyrics/structure).

## `gemini-tts` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` | `gemini-2.5-flash-preview-tts` | 3.1 Flash TTS added 2026-05-17. |
| `voiceName` | named voice (`Kore`, `Zephyr`, `Puck`, `Charon`, `Fenrir`, `Leda`, `Orus`, `Aoede`, `Callirrhoe`, `Autonoe`, `Enceladus`, `Iapetus`, `Umbriel`, `Algieba`, `Despina`, `Erinome`, `Algenib`, `Rasalgethi`, `Laomedeia`, `Achernar`, `Alnilam`, `Schedar`, `Gacrux`, `Pulcherrima`, `Achird`, `Zubenelgenubi`, `Vindemiatrix`, `Sadachbia`, `Sadaltager`, `Sulafat`) | `Kore` | Voices are fixed catalog strings. |

TTS returns raw PCM (24 kHz, 16-bit, mono). Handler wraps in WAV container before saving. Audio bytes at `candidates[0].content.parts[0].inlineData.data`.

Inputs: `text` (Text, required).
Output: `audio` (Audio).

## `gemini-embeddings` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gemini-embedding-001`, `gemini-embedding-2` | `gemini-embedding-001` | `gemini-embedding-2` is the stable multimodal model (fixed from `-preview` 2026-05-17). `taskType` is ignored for `gemini-embedding-2` — embed task hints in prompt text instead. |
| `taskType` | `SEMANTIC_SIMILARITY`, `RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`, `CLASSIFICATION`, `CLUSTERING`, `CODE_RETRIEVAL_QUERY`, `QUESTION_ANSWERING`, `FACT_VERIFICATION` | `SEMANTIC_SIMILARITY` | For `gemini-embedding-001` only. |
| `outputDimensionality` | `768`, `1536`, `3072` | `768` | Matryoshka-style trimming. Sent as camelCase `outputDimensionality` in request body. |

Response path: `embedding.values` (array of floats, singular `embedding` object for single calls). Serialised as JSON string in `embedding` output port.

Inputs: `text` (Text, required).
Outputs: `embedding` (Text — JSON array), `dimensions` (Text — integer string).

## `veo-3` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview`, `veo-3.0-generate-001`, `veo-3.0-fast-generate-001`, `veo-2.0-generate-001` | `veo-3.1-generate-preview` | |
| `aspectRatio` | `16:9`, `9:16` | `16:9` | |
| `duration` | `4`, `6`, `8` | `8` | 4s only on 3.x models; 5s only on 2.0. Sent as `parameters.durationSeconds`. |
| `resolution` | `720p`, `1080p`, `4k` | `720p` | 4K only on 3.1 and 3.0 non-lite. |
| `personGeneration` | `allow_all`, `allow_adult`, `dont_allow` | `allow_adult` | |
| `seed` | integer | random | 3.x models only. |

### Veo Async-Poll Pattern

1. POST `{BASE}/models/{model}:predictLongRunning` with `{"instances": [...], "parameters": {...}}` → returns `{"name": "operations/..."}`.
2. Poll GET `{BASE}/{name}` with `x-goog-api-key` header every ~3 s.
3. Terminal: `done == true`. Error: `poll_data.error` present.
4. Video URI: `response.generateVideoResponse.generatedSamples[0].video.uri`.
5. Download with `x-goog-api-key` header, save as `.mp4`.

Inputs: `prompt` (Text, required), `image` (Image, optional — first frame), `last_frame` (Image, optional — interpolation).
Output: `video` (Video).

## Known Integration Gaps

These are gaps between the official Gemini surface and Nebula's currently
exposed node schema. Treat them as implementation targets, not required
graph inputs.

### `nano-banana`

- No `thinking_level` UI param. Nano Banana 2 supports `minimal` and `high`
  and Nano Banana Pro thinks by default. Today the handler cannot expose
  this control to Daedalus.
- No grounding controls. `enable_web_search` is supported by Nano Banana 2
  and Nano Banana Pro; image-search grounding is supported by Nano Banana 2
  only. Neither is exposed.
- No `response_modalities` toggle. The handler likely defaults to image-only
  output; multi-modal text-plus-image responses (`['TEXT', 'IMAGE']`) are
  not separately selectable.
- No `safetySettings` or `safety_tolerance` control. Moderation behavior is
  fixed to the API default.
- No `system_instruction` field. Multi-turn chat editing through the SDK is
  not exposed; Nebula edits are stateless single-call.
- No `output_format` or `output_compression` controls. The handler likely
  emits a single fixed format.
- No `seed` control. Reproducibility through repeated runs is not exposed.
- No `num_images` / `n` control. To produce multiple variants, run the node
  multiple times.

### `gemini-chat`

- Multi-turn chat history is not directly expressed in the node graph; the
  `messages` input is a single Text field. For chat-style flows, the agent
  must serialize prior turns into the text body.
- No grounding tool toggle (`google_search`, `url_context`). Native Gemini
  supports search/url tools alongside the model call.
- No function-calling toggle. Gemini supports function calling, but Nebula
  treats `gemini-chat` as a text-only completion node.
- `response_format` exposes only `text/plain` and `application/json`. The
  native API supports `response_json_schema` with rich type definitions; the
  schema must be embedded in the prompt today.

### `gemini-tts`

- No control over audio sample rate, language, or speaking-style hint. Voice
  selection is the only knob.
- No streaming mode toggle even though the underlying call could stream.

### `gemini-embeddings`

- Nebula's `gemini-embedding-2-preview` option likely needs to be renamed to
  `gemini-embedding-2` to match the current stable model.
- `outputDimensionality` is exposed as an enum with three options. Native
  Gemini accepts a wider range (Matryoshka embeddings) up to the model's
  full dimension.

## Daedalus Guidance

When choosing a Gemini-family node:

| Goal | Node | Model |
|---|---|---|
| General text / vision Q&A | `gemini-chat` | `gemini-3-flash-preview` or `gemini-2.5-flash` |
| Hardest reasoning / planning | `gemini-chat` | `gemini-3.1-pro-preview` with `thinkingLevel: high` |
| Cheap bulk classification | `gemini-chat` | `gemini-3.1-flash-lite-preview` with `thinkingLevel: minimal` |
| Fast image gen for iteration | `nano-banana` | `gemini-3.1-flash-image-preview` at `1K` |
| Image with legible text or precise layout | `nano-banana` | `gemini-3-pro-image-preview` |
| Cheapest single-image baseline | `nano-banana` | `gemini-2.5-flash-image` |
| Character consistency across shots | `nano-banana` | `gemini-3.1-flash-image-preview`, stay within 4 character refs |
| Voice narration | `gemini-tts` | `gemini-2.5-pro-preview-tts` for fidelity, Flash TTS for cost |
| Text or multimodal embeddings | `gemini-embeddings` | `gemini-embedding-001` for text, multimodal option once Nebula switches to stable ID |

Before building a graph:

1. Read the shared Gemini reference.
2. Run `nebula nodes` to confirm node IDs.
3. Run `nebula info <node_id>` to confirm the live param schema.
4. For image work that needs grounding, thinking control, or chat-mode
   editing, prefer the native Gemini SDK outside Nebula until the missing
   params are wired up.

## Storage and Provenance

- Save downloaded image, audio, and embedding outputs under the project or
  experiment run that requested the asset, not under this docs folder.
- Keep model ID, prompt, source images, selected params, and downloaded
  output paths in the run README.
- Do not store `GOOGLE_API_KEY`, OAuth tokens, or Vertex credentials in this
  docs folder, the Workspace reference, or agent identity files.
