---
name: openai
description: OpenAI (BYOK, direct) in Nebula — text-to-image (GPT Image 1/1.5/mini, GPT Image 2 up to 4K), image edit + inpaint (single image or up to 10 refs, optional mask), text-to-speech (13 voices, 6 formats, voice instructions), Whisper/GPT-4o transcription (text/json/srt/vtt), audio translation to English, and OpenAI Chat (GPT-5.5/5.4 + legacy GPT-4o/4.1) with vision and JSON-object output. Activate when the user configures any gpt-image-1-generate, gpt-image-1-edit, gpt-image-2-generate, gpt-image-2-edit, openai-tts, openai-stt, openai-translate, or gpt-4o-chat node, or asks about OpenAI in Nebula. For gpt-image-2 prompting craft and the FAL-routed gpt-image-2 nodes, see .claude/skills/gpt-image-2/SKILL.md. Sourced from the official OpenAI API docs (platform.openai.com / developers.openai.com) and the Nebula audit guide docs/api-guides/openai.md, verified against the backend handlers on 2026-06-04 (updated 2026-06-10).
---

# OpenAI Skill

These are the **eight OpenAI-direct nodes** (all BYOK, one key). For prompting *craft* on the GPT Image 2 nodes and for the **FAL-routed** `gpt-image-2-fal-*` nodes (different provider, `FAL_KEY`, `image_size`/`num_images` naming), defer to `.claude/skills/gpt-image-2/SKILL.md` — this skill does not duplicate that detail.

## When to use

- User drags or configures any of: `gpt-image-1-generate`, `gpt-image-1-edit`, `gpt-image-2-generate`, `gpt-image-2-edit`, `openai-tts`, `openai-stt`, `openai-translate`, `gpt-4o-chat`.
- User wants to turn text → image, edit/inpaint an image, read text aloud, transcribe or translate speech, or run OpenAI chat (GPT-5.x or legacy 4o/4.1, including describing piped-in images).
- User asks which OpenAI model/voice/format to pick, what a param does, or why an OpenAI run failed (org verification, English-only translate, missing key).
- User asks to chain OpenAI nodes (e.g. image → caption → speech, or audio → subtitles).

## Universal rules

1. **Auth + env var.** Every node sends `Authorization: Bearer <OPENAI_API_KEY>`. One key (`OPENAI_API_KEY`) covers all eight. Set it in `.env` at repo root or `backend/`, then **restart the backend** (`.env` is read at boot). Missing key → handler raises `OPENAI_API_KEY is required` before any network call.
2. **Base URL.** `https://api.openai.com/v1`. Endpoints used: `/images/generations`, `/images/edits`, `/audio/speech`, `/audio/transcriptions`, `/audio/translations`, `/chat/completions`. No base-URL override in the handlers.
3. **Execution pattern (confirmed per handler):**
   - **Sync (single POST, parse JSON):** `gpt-image-1-generate`, `gpt-image-1-edit`, `openai-tts`, `openai-stt`, `openai-translate`. Images come back base64 (`data[0].b64_json`) and are written to the run dir; audio (TTS) comes back as raw bytes; STT/Translate return text.
   - **Stream (SSE):** `gpt-4o-chat` (token deltas via `choices.0.delta.content`) and **both gpt-image-2 nodes** (partial-image frames + final). These set `stream: true` in the request body. There is **no async-poll** pattern anywhere in the OpenAI provider — unlike Meshy/Runway, nothing returns a task id to poll.
4. **Status / error codes.** Handlers treat any non-`200` as a failure and surface `OpenAI ... error <status>: <body>`. Common: `400` bad params (e.g. an unsupported `size` for the chosen model), `401` bad/missing key, `429` rate limit / no quota, `403`/`organization_must_be_verified` → **org-verification** (gpt-image-2 only, see below), `500` server. The gpt-image-2 handlers detect the org-verification body and rewrite it to a clear message pointing at the settings page.
5. **Input-URI rules.**
   - **Images into edit/chat are resolved from local run-dir file paths.** The edit nodes (`gpt-image-1-edit`, `gpt-image-2-edit`) read the upstream image **file bytes** and POST multipart — they do **not** accept a remote URL on the image port; the file must exist on disk. `gpt-4o-chat`'s `images` port is more flexible: a value starting with `http://`/`https://`/`data:` is passed through as an `image_url`; anything else is treated as a local path, read, and base64-encoded into a data URI (png/jpg/jpeg/webp MIME inferred from extension).
   - **Masks** (`gpt-image-1-edit`, `gpt-image-2-edit`) are PNG with an alpha channel; the mask applies to the **first** image and marks where edits are allowed. The prompt must describe the **whole** desired image, not just the masked region.
6. **Key gotchas (full list in "Capability boundaries"):**
   - **gpt-image-2 needs Organization Verification.** GPT Image 1 does **not**. Verify at https://platform.openai.com/settings/organization/general.
   - **Translate is English-only and model-locked.** `openai-translate` always runs `whisper-1` under the hood (no model param); output is English text regardless of input language.
   - **`instructions` (voice tone) only works on `gpt-4o-mini-tts`.** `tts-1`/`tts-1-hd` silently ignore it.
   - **STT `temperature` only affects `whisper-1`.** The GPT-4o transcribe models ignore it; the handler only forwards non-zero values.
   - **gpt-image-2 drops `n>1`, `background`, `input_fidelity`, and a user `partial_images` count** — OpenAI rejects `n>1` while streaming, and these params aren't valid/forwarded. Run the node multiple times for multiple images.
   - **gpt-5.x are reasoning models: sampler params are dropped.** On `gpt-4o-chat`, the handler omits `temperature`/`top_p`/`frequency_penalty`/`presence_penalty` for any `gpt-5.*` model (the API rejects them) and instead sends `reasoning_effort` (none/low/medium/high/xhigh). The sampler params are only forwarded — and only shown in the UI — for the legacy gpt-4o/4.1 models.

## Pick the right node

| Node (display) | Node ID | Endpoint / model | Key inputs | Key params |
|---|---|---|---|---|
| GPT Image 1 | `gpt-image-1-generate` | `/v1/images/generations` · `gpt-image-1` \| `gpt-image-1.5` \| `gpt-image-1-mini` | `prompt` (Text) | `model`, `size`, `quality`, `output_format`, `background` (transparent OK) |
| GPT Image 2 | `gpt-image-2-generate` | `/v1/images/generations` · `gpt-image-2` (streams) | `prompt` (Text) | `size` (→4K), `quality`, `output_format`, `output_compression`, `moderation` |
| GPT Image 1 Edit | `gpt-image-1-edit` | `/v1/images/edits` · `gpt-image-1*` | `image` (Image), `prompt` (Text), `mask` (Mask) | `model`, `n` (1–10), `size`, `quality`, `output_format`, `background` |
| GPT Image 2 Edit | `gpt-image-2-edit` | `/v1/images/edits` · `gpt-image-2` (streams) | `images` (Image, ≤10), `prompt` (Text), `mask` (Mask) | `size`, `quality`, `output_format`, `output_compression`, `moderation` |
| OpenAI TTS | `openai-tts` | `/v1/audio/speech` · `tts-1` \| `tts-1-hd` \| `gpt-4o-mini-tts` | `text` (Text) | `model`, `voice` (13), `speed`, `response_format` (6), `instructions` (mini-tts only) |
| OpenAI Whisper STT | `openai-stt` | `/v1/audio/transcriptions` · `whisper-1` \| `gpt-4o-transcribe` \| `gpt-4o-mini-transcribe` | `audio` (Audio) | `model`, `language`, `response_format` (text/json/verbose_json/srt/vtt), `temperature`, `prompt` |
| OpenAI Audio Translate | `openai-translate` | `/v1/audio/translations` · **`whisper-1` (fixed)** → English | `audio` (Audio) | `response_format`, `temperature`, `prompt` (must be English) |
| OpenAI Chat | `gpt-4o-chat` | `/v1/chat/completions` · `gpt-5.5` \| `gpt-5.4` \| `gpt-5.4-mini` \| `gpt-5.4-nano` \| legacy `gpt-4o` \| `gpt-4o-mini` \| `gpt-4.1` \| `gpt-4.1-mini` \| `gpt-4.1-nano` (streams) | `messages` (Text), `images` (Image, multiple) | `model`, `reasoning_effort` (gpt-5.x only), `max_completion_tokens`, `temperature`, `top_p`, `frequency_penalty`, `presence_penalty` (legacy only), `response_format` (text/json_object) |

## Param reference

Types/ranges/enums/defaults are from `node_definitions.json`; behavior notes are from the handlers.

### `gpt-image-1-generate` (sync)
- `model` *(enum, req, default `gpt-image-1`)*: `gpt-image-1` · `gpt-image-1.5` · `gpt-image-1-mini`.
- `size` *(enum, default `auto`)*: `auto` · `1024x1024` · `1536x1024` · `1024x1536`. `auto` is omitted from the request (lets OpenAI pick).
- `quality` *(enum, default `auto`)*: `auto` · `low` · `medium` · `high`. `auto` omitted.
- `output_format` *(enum, default `png`)*: `png` · `jpeg` · `webp`. Drives the saved file extension (so downstream MIME is correct). Only sent when ≠ `png`.
- `background` *(enum, default `auto`)*: `auto` · `transparent` · `opaque`. **GPT Image only** — transparent works here (not on gpt-image-2). Only sent when ≠ `auto`.

### `gpt-image-2-generate` (stream)
- `size` *(enum, default `auto`)*: `auto` · `1024x1024` · `1536x1024` · `1024x1536` · `2048x2048` · `2048x1152` · `3840x2160` (4K landscape) · `2160x3840` (4K portrait).
- `quality` *(enum, default `auto`)*: `auto` · `low` · `medium` · `high`.
- `output_format` *(enum, default `png`)*: `png` · `jpeg` · `webp`.
- `output_compression` *(int 0–100, default 90)*: only applied when `output_format` ≠ `png`.
- `moderation` *(enum, default `auto`)*: `auto` · `low` (less restrictive).
- Handler **always** sets `stream: true`, `partial_images: 0`, and strips `background`/`input_fidelity`/`n`. For prompting craft + cost table, see the gpt-image-2 skill.

### `gpt-image-1-edit` (sync, multipart)
- `model` *(enum, req, default `gpt-image-1`)*: `gpt-image-1` · `gpt-image-1.5` · `gpt-image-1-mini`.
- `n` *(int 1–10, default 1)*: number of variations; only sent when >1.
- `size` / `quality` / `output_format` / `background`: same enums/defaults as `gpt-image-1-generate`.
- Inputs: `image` (req), `prompt` (req), `mask` (optional PNG). Image + mask are read from disk and uploaded multipart.

### `gpt-image-2-edit` (stream, multipart)
- Same param set as `gpt-image-2-generate` (`size`, `quality`, `output_format`, `output_compression`, `moderation`). No `model` param (fixed `gpt-image-2`), no `n`, no `background`.
- Inputs: `images` (req, **multiple, ≤10** — handler rejects >10), `prompt` (req), `mask` (optional, applies to first image).

### `openai-tts` (sync)
- `model` *(enum, default `tts-1`)*: `tts-1` · `tts-1-hd` · `gpt-4o-mini-tts`.
- `voice` *(enum, default `alloy`, 13)*: `alloy` · `ash` · `ballad` · `cedar` · `coral` · `echo` · `fable` · `marin` · `nova` · `onyx` · `sage` · `shimmer` · `verse`.
- `speed` *(float 0.25–4.0, step 0.25, default 1.0)*.
- `response_format` *(enum, default `mp3`)*: `mp3` · `wav` · `flac` · `opus` · `aac` · `pcm`. Drives the saved audio file extension.
- `instructions` *(string, optional)*: free-text tone/accent (e.g. "Speak slowly with warmth"). **Only `gpt-4o-mini-tts` honors it**; `tts-1`/`tts-1-hd` ignore it.

### `openai-stt` (sync, multipart)
- `model` *(enum, default `whisper-1`)*: `whisper-1` · `gpt-4o-transcribe` · `gpt-4o-mini-transcribe`.
- `language` *(enum, default `auto`)*: `auto` (omitted) · `en` `es` `fr` `de` `it` `pt` `ja` `ko` `zh` `ar` `ru` `hi`.
- `response_format` *(enum, default `text`)*: `text` · `json` · `verbose_json` · `srt` · `vtt`. For `json`/`verbose_json` the handler extracts `.text`; for `srt`/`vtt`/`text` it returns the raw body. **Output port is always `Text`** — even SRT/VTT come back as a text string (save it as `.srt`/`.vtt` downstream).
- `temperature` *(float 0–1, step 0.1, default 0)*: only forwarded when non-zero; **affects `whisper-1` only**.
- `prompt` *(string, optional)*: biasing hint (spellings, names, style).

### `openai-translate` (sync, multipart)
- **No model param** — fixed `whisper-1`, output is **English text** regardless of source language.
- `response_format` *(enum, default `text`)*: `text` · `json` · `verbose_json` · `srt` · `vtt` (same extraction logic as STT).
- `temperature` *(float 0–1, default 0)*: forwarded only when non-zero.
- `prompt` *(string, optional)*: must be in **English**.

### `gpt-4o-chat` (stream) — display name "OpenAI Chat" (updated 2026-06-10)
- `model` *(enum, req, default `gpt-5.4`)*: `gpt-5.5` (flagship) · `gpt-5.4` · `gpt-5.4-mini` · `gpt-5.4-nano` · legacy `gpt-4o` · `gpt-4o-mini` · `gpt-4.1` · `gpt-4.1-mini` · `gpt-4.1-nano` (sunsets 2026-10-23).
- `reasoning_effort` *(enum, default `medium`)*: `none` · `low` · `medium` · `high` · `xhigh`. **gpt-5.x models only** — shown only when a `gpt-5.*` model is selected and sent only for those models.
- `max_completion_tokens` *(int 1–128000, default 4096)*.
- `temperature` *(float 0–2, step 0.1, default 1)* — **legacy gpt-4o/4.1 models only**; the handler omits it for gpt-5.x (reasoning models reject it).
- `top_p` *(float 0–1, step 0.05, default unset/blank)* — only sent when set; legacy models only.
- `frequency_penalty` / `presence_penalty` *(float −2–2, step 0.1, default 0)* — legacy models only.
- `response_format` *(enum, default `text`)*: `text` · `json_object`. `json_object` sends `{"type":"json_object"}` and enables **JSON mode** — **JSON-mode only, no strict `json_schema`** (see boundaries). **Gotcha:** OpenAI requires the literal word **"json"** to appear somewhere in the prompt (`messages`/`system`) when `json_object` is set, or the request errors. Instruct the model to "respond in JSON."
- Inputs: `messages` (req, Text — becomes the user message text) and `images` (optional, **multiple** — each appended as an `image_url` content part for vision). A single user message is constructed; there is no multi-turn history or system-role port.

## Recipes

All node ids below are real and in `node_definitions.json`.

1. **Illustrated quote card (text → image).** `Text` (your quote) → `gpt-image-2-generate` (`size 1024x1536`, `quality high`) → canvas. Iterate at `quality low` to save cost, then bump to `high`. Use `gpt-image-1-generate` (`background transparent`) for a cut-out sticker.
2. **Narrated image caption (three OpenAI nodes, one key).** `Text` (image brief) → `gpt-image-1-generate` → feed its `image` output into `gpt-4o-chat`'s `images` port with a `messages` prompt like "Write a 2-sentence caption" → take the `text` output into `openai-tts` (`voice coral`) → an `Audio` clip of the spoken caption. (Chains text-gen → vision → audio-gen.)
3. **Subtitle a voiceover.** `Audio` → `openai-stt` (`model gpt-4o-transcribe`, `response_format srt`) → the `Text` output is SRT content; save as `.srt`. If the audio is in another language and you want **English** subtitles, swap `openai-stt` for `openai-translate` (same `response_format srt`).
4. **Masked inpaint.** `Image` + `Mask` + `Text` ("replace the sky with aurora") → `gpt-image-2-edit` (or `gpt-image-1-edit` for a single image + the `n` Count param). The prompt must describe the **whole** desired image; the mask marks where edits are allowed and applies to the first image. `gpt-image-2-edit` accepts up to 10 reference images for compositing.

## In the nebula_nodes context

- **Node ids (8):** `gpt-image-1-generate`, `gpt-image-2-generate`, `gpt-image-1-edit`, `gpt-image-2-edit`, `openai-tts`, `openai-stt`, `openai-translate`, `gpt-4o-chat`. Palette groups: the four image nodes under **image-gen**, the three audio nodes under **audio-gen**, chat under **text-gen**. (`dalle-3-generate` was removed 2026-06-10 — OpenAI shut down dall-e-2/3 on 2026-05-12.)
- **Handler files & routing** (`backend/execution/sync_runner.py` maps ids → handlers):
  - `backend/handlers/openai_image.py` → `handle_openai_image_generate` serves `gpt-image-1-generate`.
  - `backend/handlers/openai_image_edit.py` → `handle_openai_image_edit` serves `gpt-image-1-edit`.
  - `backend/handlers/openai_image_v2.py` → `handle_gpt_image_2_generate` / `handle_gpt_image_2_edit` (SSE streaming, `gpt-image-2-*`).
  - `backend/handlers/openai_audio.py` → `handle_openai_stt` / `handle_openai_translate` / `handle_openai_tts`.
  - `backend/handlers/openai_chat.py` → `handle_openai_chat` (`gpt-4o-chat`, SSE token streaming).
- **Ports.** Image gen: in `prompt` (Text) → out `image` (Image). Image edit: in `image`/`images`+`prompt`+`mask` → out `image`. TTS: in `text` (Text) → out `audio` (Audio). STT/Translate: in `audio` (Audio) → out `text` (Text). Chat: in `messages` (Text) + `images` (Image, multiple) → out `text` (Text).
- **Chaining rules.**
  - An `Image` output port wires straight into any image-input port (`gpt-image-*-edit` images, or `gpt-4o-chat` `images`).
  - The edit nodes need the upstream image as a **local file** (they read bytes for multipart); a same-graph upstream image node satisfies this. `gpt-4o-chat` additionally accepts http(s)/data-URI strings on `images`.
  - `Text` outputs (chat, STT, translate) chain into any Text-input port — e.g. STT `text` → `gpt-4o-chat` `messages`, or chat `text` → `openai-tts` `text`.
  - There is no task-id port anywhere in this provider (no async-poll), so no "poll handle" chaining like Meshy/Runway.
- **How outputs render.** Generated images write base64 to the run dir and display in the node's preview surface (`DynamicNode`/`ModelNode`); gpt-image-2 streams partial frames that swap in live as it renders. Chat text streams token-by-token into the node's text surface. **Audio (TTS) renders as an inline `<audio>` player with a download control** on the node. STT/Translate text (including SRT/VTT) renders as text.

### Capability boundaries (what the OpenAI API supports but Nebula does NOT expose)

Do not promise these — they aren't wired. (From the audit guide's gap table, `docs/api-guides/openai.md`.)

- **Image variations** (`/v1/images/variations`, dall-e-2) — no node; largely moot since OpenAI retired dall-e-2/3 on 2026-05-12.
- **`background: transparent` on gpt-image-2** — exposed only on GPT Image 1 / 1 Edit; the API doesn't support it on v2. For a transparent v2 result, chain a downstream `remove-background` node instead.
- **`n>1` on the gpt-image-2 nodes** — dropped (OpenAI rejects `n>1` while streaming); only `gpt-image-1-edit` exposes Count (1–10). Run the node again for more images.
- **User-controllable streaming `partial_images` count** — gpt-image-2 streams internally but the count is fixed at 0 (not a param).
- **`input_fidelity` on edits** — not forwarded; gpt-image-2 always processes inputs at high fidelity.
- **Streaming TTS** (`stream_format: sse` on gpt-4o-mini-tts) — the node writes the whole file; no live audio streaming.
- **Transcription `timestamp_granularities` (word/segment)** — `verbose_json` is selectable but per-word/segment timestamps aren't surfaced.
- **Streaming / diarized transcription** (`gpt-4o-transcribe-diarize`) — no streaming STT; the diarize model isn't in the enum.
- **Chat tool / function calling** — no tools port.
- **Strict structured outputs** (`json_schema`) — only `json_object` mode; no schema enforcement.
- **Audio-in/out chat** (`gpt-4o-audio-preview`) — not wired.
- **Realtime API** (gpt-realtime, speech-to-speech) — entire family unsupported.
- **Responses API** (`/v1/responses`) — Nebula uses the older Chat Completions endpoint.
- **Embeddings / Moderations / Batch / Files / Assistants / Sora video** — out of scope (Sora's Videos API + sora-2/sora-2-pro shut down 2026-09-24 anyway).

Coverage: roughly 60% of OpenAI's media-generation surface (images + audio + chat) is exposed; ~30% of the entire OpenAI platform.

## Sources

- Image generation guide — https://developers.openai.com/api/docs/guides/image-generation
- Images API reference (create / edit) — https://platform.openai.com/docs/api-reference/images
- Text-to-speech guide — https://platform.openai.com/docs/guides/text-to-speech
- Speech-to-text guide — https://developers.openai.com/api/docs/guides/speech-to-text
- Create transcription reference — https://platform.openai.com/docs/api-reference/audio/createTranscription
- Audio and speech guide — https://platform.openai.com/docs/guides/audio
- Chat Completions reference — https://platform.openai.com/docs/api-reference/chat
- Realtime and audio guide — https://developers.openai.com/api/docs/guides/realtime
- **Nebula audit guide** — `docs/api-guides/openai.md` (node table, param surface, full gap table, sources)
- **GPT Image 2 prompting + FAL-routed nodes** — `.claude/skills/gpt-image-2/SKILL.md`
