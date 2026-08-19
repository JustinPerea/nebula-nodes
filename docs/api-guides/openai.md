# OpenAI in Nebula Nodes

> Drop OpenAI nodes onto the canvas to turn text into images, edit and inpaint pictures, speak text aloud, transcribe or translate audio, and run OpenAI chat (GPT-5.x, with vision) — all from your own OpenAI key.

## What you can make

- **Images (text → image)** — Generate pictures from a prompt with GPT Image 1 or GPT Image 2 (up to 4K). Pick size, quality, format, and (on v1) transparent backgrounds.
- **Image edits & inpainting (image → image)** — Edit an existing image from a prompt, optionally with a mask to change only part of it. GPT Image 2 Edit takes up to 10 reference images at once.
- **Speech (text → audio)** — Read any text aloud with 13 voices, 6 audio formats, adjustable speed, and free-text "voice instructions" (tone/accent) on the newest model.
- **Transcription (audio → text)** — Turn speech into text with Whisper or the GPT-4o transcribe models. Output plain text, JSON, or SRT/VTT subtitle files.
- **Translation (audio → English text)** — Take spoken audio in any language and get English text back.
- **Text & vision chat (text + images → text)** — Run OpenAI chat (GPT-5.5 / GPT-5.4, plus legacy GPT-4o / GPT-4.1): summarize, rewrite, reason, or describe images you pipe in. Optional JSON-object output.

## Nodes available in Nebula (8) (updated 2026-06-10)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| GPT Image 1 | `gpt-image-1-generate` | image-gen | `prompt` (Text) | `model` (gpt-image-1 / gpt-image-1.5 / gpt-image-1-mini), `size`, `quality`, `output_format`, `background` | Text→image with transparent-background support |
| GPT Image 2 | `gpt-image-2-generate` | image-gen | `prompt` (Text) | `size` (up to `3840x2160` 4K), `quality`, `output_format`, `output_compression`, `moderation` | Highest-detail text→image with streaming previews |
| GPT Image 1 Edit | `gpt-image-1-edit` | image-gen | `image` (Image), `prompt` (Text), `mask` (Mask) | `model`, `n` (1–10), `size`, `quality`, `output_format`, `background` | Edit / inpaint a single image, optional mask |
| GPT Image 2 Edit | `gpt-image-2-edit` | image-gen | `images` (Image, multiple ≤10), `prompt` (Text), `mask` (Mask) | `size`, `quality`, `output_format`, `output_compression`, `moderation` | Edit / compose from up to 10 reference images |
| OpenAI TTS | `openai-tts` | audio-gen | `text` (Text) | `model` (tts-1 / tts-1-hd / gpt-4o-mini-tts), `voice` (13), `speed`, `response_format`, `instructions` | Read text aloud in a chosen voice |
| OpenAI Whisper STT | `openai-stt` | audio-gen | `audio` (Audio) | `model` (whisper-1 / gpt-4o-transcribe / gpt-4o-mini-transcribe), `language`, `response_format` (text/json/srt/vtt), `temperature`, `prompt` | Transcribe speech to text or subtitles |
| OpenAI Audio Translate | `openai-translate` | audio-gen | `audio` (Audio) | `response_format` (text/json/srt/vtt), `temperature`, `prompt` | Translate spoken audio into English text |
| OpenAI Chat | `gpt-4o-chat` | text-gen | `messages` (Text), `images` (Image, multiple) | `model` (gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano, plus legacy gpt-4o / gpt-4o-mini / gpt-4.1 / gpt-4.1-mini / gpt-4.1-nano), `reasoning_effort` (gpt-5.x only), `max_completion_tokens`, `temperature`, `top_p`, `frequency_penalty`, `presence_penalty` (legacy models only), `response_format` (text/json_object) | Text reasoning + vision (describe/caption images) |

> DALL-E 3 node removed 2026-06-10 — OpenAI shut down dall-e-2/3 on 2026-05-12; use the GPT Image nodes.

## How to use it in Nebula

**Where the nodes appear.** Open the node palette and look under the media-type groups: the four image nodes are in **image-gen**, the three audio nodes (TTS, STT, Translate) are in **audio-gen**, and OpenAI Chat is in **text-gen**. Drag a node onto the canvas, wire a Text node (or another node's output) into its input port, and run.

**API-key setup.** All eight nodes use your own OpenAI key (BYOK). Open Nebula **Settings**, paste it into the **OpenAI** field (`OPENAI_API_KEY`), and choose **Save Settings**. Nebula stores it under `apiKeys.OPENAI_API_KEY` in the project-root `settings.json`; no restart is required. One key covers every OpenAI node. Two things to know:
- **GPT Image 2 requires Organization Verification.** If a `gpt-image-2-*` run fails with an "org isn't verified" error, verify at https://platform.openai.com/settings/organization/general. (GPT Image 1 doesn't need this.)
- **Translate is English-only output** and always runs on `whisper-1` under the hood — the model isn't selectable on that node.

**Example pipelines.**

1. **Illustrated quote card.** `Text (your quote)` → `gpt-image-2-generate` (size `1024x1536`, quality `high`) → preview. Iterate at quality `low` first to save cost, then bump to `high` for the final.
2. **Narrated image description (chained media).** `Text (image brief)` → `gpt-image-1-generate` → feed the `image` output into `gpt-4o-chat` (with a `messages` prompt like "Write a 2-sentence caption") → take the `text` output into `openai-tts` (voice `coral`) to get a spoken caption. Three OpenAI nodes, one key.
3. **Subtitle a voiceover.** `Audio` → `openai-stt` (model `gpt-4o-transcribe`, `response_format` `srt`) → save the SRT. Swap to `openai-translate` instead if the audio is in another language and you want English subtitles.
4. **Masked inpaint.** `Image` + `Mask` + `Text ("replace the sky with aurora")` → `gpt-image-2-edit`. The prompt must describe the **whole** desired image, not just the masked region; the mask marks where edits are allowed and applies to the first image.

## API coverage — what Nebula uses vs. what OpenAI offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Image generation `/v1/images/generations` | yes | full | gpt-image-1, gpt-image-1.5 (via model enum), gpt-image-1-mini, gpt-image-2 all reachable |
| Image edit / inpaint `/v1/images/edits` | yes | full | Single image (v1) and up to 10 images (v2), with optional mask |
| Image variations `/v1/images/variations` (dall-e-2) | yes | none | No variations node; largely moot since OpenAI retired dall-e-2/3 on 2026-05-12 |
| Image `background: transparent` | yes (GPT image v1) | partial | Exposed on GPT Image 1 / Edit; **not** on gpt-image-2 (API doesn't support it there) |
| Image `n > 1` (multiple per call) | yes | partial | Exposed on GPT Image 1 Edit (Count 1–10); dropped on gpt-image-2 nodes (they stream, and OpenAI rejects `n>1` while streaming) |
| Image streaming previews (`partial_images`) | yes (0–3) | partial | gpt-image-2 nodes stream partials to the canvas internally, but the count isn't a user param (fixed at 0) |
| Image `input_fidelity` (edit) | yes | none | Not forwarded; gpt-image-2 always processes inputs at high fidelity |
| Text-to-speech `/v1/audio/speech` | yes | full | tts-1, tts-1-hd, gpt-4o-mini-tts; 13 voices, 6 formats, speed, instructions |
| TTS streaming (`stream_format: sse`) | yes (gpt-4o-mini-tts) | none | Node writes the whole audio file; no live audio streaming |
| Transcription `/v1/audio/transcriptions` | yes | full | whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe; text/json/verbose_json/srt/vtt |
| Transcription `timestamp_granularities` (word/segment) | yes | none | Not exposed; verbose_json is selectable but per-word timestamps aren't surfaced |
| Transcription streaming / diarization (`gpt-4o-transcribe-diarize`) | yes | none | No streaming STT; diarize model not in the enum |
| Translation `/v1/audio/translations` | yes | full | whisper-1 → English; text/json/srt/vtt |
| Chat completions `/v1/chat/completions` (text) | yes | full | gpt-5.5, gpt-5.4 / mini / nano (with `reasoning_effort`), plus legacy gpt-4o, gpt-4o-mini, gpt-4.1 / mini / nano |
| Chat vision (image input) | yes | full | `images` port accepts URLs, data URIs, and local files (base64-encoded) |
| Chat tools / function calling | yes | none | No tool/function-calling support in the node |
| Chat structured outputs (JSON) | yes | partial | **JSON mode supported** via `gpt-4o-chat`'s `response_format` (Text / `json_object`) — handler sends `response_format: {"type":"json_object"}`. Only `json_object` mode; no strict `json_schema` enforcement |
| Chat audio in/out (`gpt-4o-audio-preview`) | yes | none | Audio-modality chat not wired up |
| Realtime API (gpt-realtime, speech-to-speech) | yes | none | Entire Realtime/voice-agent family unsupported |
| Responses API `/v1/responses` | yes | none | Nebula uses the older Chat Completions endpoint, not Responses |
| Embeddings / Moderations / Batch / Files / Assistants / Sora video | yes | none | Out of scope for Nebula's media nodes today (Sora's Videos API + sora-2/sora-2-pro shut down 2026-09-24 anyway, announced 2026-03-24) |

Coverage: ~60% of the OpenAI media-generation API surface (images + audio + chat) is exposed in Nebula. Counting OpenAI's *entire* platform (Realtime, Responses, Embeddings, Moderations, Batch, Files, Assistants, Sora video) the figure is closer to ~30%.

Notable unused capabilities: image **variations** (dall-e-2 only; moot since the 2026-05-12 dall-e shutdown), `input_fidelity` and a user-controllable `partial_images` count on edits, **streaming TTS**, **word/segment timestamps** and **streaming/diarized transcription**, chat **tool/function calling**, **strict JSON-schema** structured outputs, **audio-in/out chat** (gpt-4o-audio-preview), and the whole **Realtime** speech-to-speech and **Responses** API families.

## Agent skill coverage

**A complete skill exists** at **`.claude/skills/openai/SKILL.md`** (new 2026-06-04, updated 2026-06-10). It is a broad OpenAI-direct skill that supersedes the earlier gpt-image-2-only coverage and documents all **8** OpenAI-direct nodes. It gives an agent the node IDs and ports, exact params, handler gotchas, and the cross-node chaining recipes, so an agent can assemble any OpenAI pipeline without reading the handlers. (For gpt-image-2 prompting craft and the FAL-routed `gpt-image-2-fal-*` nodes, it cross-links to **`.claude/skills/gpt-image-2/SKILL.md`**, which still exists.)

What it covers:
- **Images** — `gpt-image-1-generate`, `gpt-image-1-edit`, `gpt-image-2-generate`, `gpt-image-2-edit`: the full param matrices, the v1-only `background: transparent` and `n` (Count) params, the org-verification gotcha, and the `input_fidelity` / `n>1` exclusions on the v2 nodes.
- **Audio** — `openai-tts` (voices/formats/instructions), `openai-stt` (model + `response_format`, incl. SRT/VTT), and `openai-translate` (English-only, fixed-`whisper-1`).
- **Chat** — `gpt-4o-chat` ("OpenAI Chat"): the GPT-5.x + legacy model enum, the gpt-5.x-only `reasoning_effort` param, the sampler-param drop on gpt-5.x, the vision `images` port (URL / data URI / local path), and `response_format: json_object`.
- **Capability boundaries** — what's not wired (variations, streaming TTS, tools/function calling, strict JSON-schema, Realtime/Responses), so an agent doesn't over-promise.

## Sources

- Image generation guide — https://developers.openai.com/api/docs/guides/image-generation
- Images API reference — https://platform.openai.com/docs/api-reference/images
- Create image / Create image edit references — https://developers.openai.com/api/reference/resources/images/methods/generate , https://developers.openai.com/api/reference/resources/images/methods/edit
- Text-to-speech guide — https://platform.openai.com/docs/guides/text-to-speech
- Speech-to-text guide — https://developers.openai.com/api/docs/guides/speech-to-text
- Create transcription reference — https://platform.openai.com/docs/api-reference/audio/createTranscription
- Audio and speech guide — https://platform.openai.com/docs/guides/audio
- Chat Completions reference — https://platform.openai.com/docs/api-reference/chat
- Realtime and audio guide — https://developers.openai.com/api/docs/guides/realtime
- Introducing image generation in the API — https://openai.com/index/image-generation-api/
