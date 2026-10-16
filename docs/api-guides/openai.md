# OpenAI in Nebula Nodes

> Drop OpenAI nodes onto the canvas to turn text into images, edit and inpaint pictures, speak text aloud, transcribe or translate audio, and run OpenAI chat (GPT-5.x, with vision) — all from your own OpenAI key.

## What you can make

- **Images (text → image)** — Generate pictures from a prompt with GPT Image 1, GPT Image 2 (up to 4K) or GPT Image 2.5 (Flare for speed, Sunburst for precision). Pick size, quality, format, and (on v1 and 2.5) transparent backgrounds.
- **Image edits & inpainting (image → image)** — Edit an existing image from a prompt, optionally with a mask to change only part of it. GPT Image 2 Edit and GPT Image 2.5 Edit take up to 16 reference images at once (OpenAI's limit for GPT image models).
- **Speech (text → audio)** — Read any text aloud with 13 voices, 6 audio formats, adjustable speed, and free-text "voice instructions" (tone/accent) on the newest model.
- **Transcription (audio → text)** — Turn speech into text with Whisper or the GPT-4o transcribe models. Output plain text, JSON, or SRT/VTT subtitle files.
- **Translation (audio → English text)** — Take spoken audio in any language and get English text back.
- **Text & vision chat (text + images → text)** — Run OpenAI chat (GPT-5.5 / GPT-5.4, plus legacy GPT-4o / GPT-4.1): summarize, rewrite, reason, or describe images you pipe in. Optional JSON-object output.

## Nodes available in Nebula (10) (updated 2026-10-10)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| GPT Image 1 | `gpt-image-1-generate` | image-gen | `prompt` (Text) | `model` (GPT Image 2.5 Flare default / 2.5 Sunburst / gpt-image-1, shutting down 2026-10-23 / gpt-image-1.5 / gpt-image-1-mini), `size`, `quality`, `output_format`, `background` | Text→image with transparent-background support |
| GPT Image 2 | `gpt-image-2-generate` | image-gen | `prompt` (Text) | `size` (up to `3840x2160` 4K), `quality`, `output_format`, `output_compression`, `moderation` | Highest-detail text→image with streaming previews |
| GPT Image 2.5 | `gpt-image-2-5-generate` | image-gen | `prompt` (Text) | `model` (Flare / Sunburst), `size` (to 4K, >2560x1440 experimental), `quality` (adds xhigh / max), `background` (transparent needs png/webp), `output_format`, `output_compression`, `moderation` | Newest OpenAI image model, with transparent backgrounds |
| GPT Image 1 Edit | `gpt-image-1-edit` | image-gen | `image` (Image), `prompt` (Text), `mask` (Mask) | `model` (2.5 Sunburst default), `n` (1–10, every image kept on `images`), `size`, `quality`, `output_format`, `background` | Edit / inpaint a single image, optional mask |
| GPT Image 2 Edit | `gpt-image-2-edit` | image-gen | `images` (Image, multiple ≤16), `prompt` (Text), `mask` (Mask) | `size`, `quality`, `output_format`, `output_compression`, `moderation` | Edit / compose from up to 16 reference images |
| GPT Image 2.5 Edit | `gpt-image-2-5-edit` | image-gen | `images` (Image, multiple ≤16), `prompt` (Text), `mask` (Mask) | same as GPT Image 2.5 | Edit / compose with GPT Image 2.5 |
| OpenAI TTS | `openai-tts` | audio-gen | `text` (Text) | `model` (tts-1 / tts-1-hd / gpt-4o-mini-tts), `voice` (13), `speed`, `response_format`, `instructions` | Read text aloud in a chosen voice |
| OpenAI Whisper STT | `openai-stt` | audio-gen | `audio` (Audio) | `model` (whisper-1 / gpt-4o-transcribe / gpt-4o-mini-transcribe), `language`, `response_format` (text/json/srt/vtt), `temperature`, `prompt` | Transcribe speech to text or subtitles |
| OpenAI Audio Translate | `openai-translate` | audio-gen | `audio` (Audio) | `response_format` (text/json/srt/vtt), `temperature`, `prompt` | Translate spoken audio into English text |
| OpenAI Chat | `gpt-4o-chat` | text-gen | `messages` (Text), `images` (Image, multiple) | `model` (gpt-6-astra / gpt-6.1-sol default (2026-10-16) / gpt-6-sol / gpt-6-luna, gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna, gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano (retiring 2027-04-01), plus legacy gpt-4o / gpt-4o-mini / gpt-4.1 / gpt-4.1-mini (retiring 2027-01-14) / gpt-4.1-nano (retiring 2026-10-23)), `reasoning_effort` (GPT-6, GPT-5.6 and gpt-5.x only; `max` on GPT-6 and GPT-5.6; no `none` on GPT-6 Astra / GPT-6.1 Sol), `max_completion_tokens` (25000 on GPT-6 and GPT-5.6, since reasoning tokens count toward it; 4096 on the older models), `temperature`, `top_p`, `frequency_penalty`, `presence_penalty` (legacy models only), `response_format` (text/json_object) | Text reasoning + vision (describe/caption images) |

> DALL-E 3 node removed 2026-06-10 — OpenAI shut down dall-e-2/3 on 2026-05-12; use the GPT Image nodes.

**Your OpenAI key also runs the fal and Krea copies of GPT Image** (since 2026-10-14). With `OPENAI_API_KEY` saved, these nodes call OpenAI's Images API instead of fal or Krea, billed by OpenAI:

| Copy | Node ID | Runs on OpenAI as | Stays on fal / Krea when |
|---|---|---|---|
| GPT Image 1.5 / Edit (fal) | `gpt-image-1-5`, `gpt-image-1-5-edit` | `gpt-image-1.5` | from **2026-12-01**, when OpenAI shuts gpt-image-1.5 down |
| GPT Image 2 / Edit (FAL) | `gpt-image-2-fal-generate`, `gpt-image-2-fal-edit` | `gpt-image-2` | Size is Square (512x512) or a 16:9 preset (576x1024, 1024x576): all under OpenAI's 655,360-pixel minimum |
| GPT Image 2 (Krea) | `krea-image-openai-gpt-image-2` | `gpt-image-2` | the recipe sets Krea's `width` or `height` |
| GPT Image 2.5 Flare / Sunburst (Krea) | `krea-image-openai-gpt-image-2-5-flare`, `-sunburst` | `gpt-image-2.5-flare` / `-sunburst` | never (only the Krea plan choice) |

A Krea node set to the Krea plan stays on Krea. Without an OpenAI key, every copy runs on fal or Krea as before. Every fal param has an OpenAI field: `image_size` becomes `size` (fal's 4:3 presets render 1024x768 / 768x1024, Square HD 1024x1024), Count becomes that many calls (first image shown, as on fal), and GPT Image 1.5 Edit's `input_fidelity` is sent. Krea's aspect ratio and 1K/2K/4K become an exact-ratio OpenAI size from a fixed table (`backend/execution/maker_routes_openai.py` `KREA_OPENAI_SIZES`; e.g. 16:9 is 1280x720 / 2048x1152 / 3840x2160, and 4K is above 2560x1440, which OpenAI calls experimental). Krea references must be public https URLs or Nebula outputs; they are sent to `/v1/images/edits`. Prices: the GPT Image 1.5 copies use OpenAI's per-image table; the GPT Image 2 and 2.5 copies' OpenAI route is unpriced (OpenAI tabulates GPT Image 2 only at three sizes the defaults don't hit, and publishes no per-image figure for 2.5), so the run estimate says so.

## How to use it in Nebula

**Where the nodes appear.** Open the node palette and look under the media-type groups: the six image nodes are in **image-gen**, the three audio nodes (TTS, STT, Translate) are in **audio-gen**, and OpenAI Chat is in **text-gen**. Drag a node onto the canvas, wire a Text node (or another node's output) into its input port, and run.

**API-key setup.** All ten nodes use your own OpenAI key (BYOK). Open Nebula **Settings** → **Providers**, choose **Add key** on the **OpenAI** row (`OPENAI_API_KEY`), paste it and choose **Save key**. Saving checks the key without generating anything. Nebula stores it under `apiKeys.OPENAI_API_KEY` in the project-root `settings.json`; no restart is required. One key covers every OpenAI node. Two things to know:
- **GPT Image 2 and 2.5 require Organization Verification.** If a `gpt-image-2-*` or `gpt-image-2-5-*` run fails with an "org isn't verified" error, verify at https://platform.openai.com/settings/organization/general. (GPT Image 1 doesn't need this.)
- **Translate is English-only output** and always runs on `whisper-1` under the hood — the model isn't selectable on that node.

**Example pipelines.**

1. **Illustrated quote card.** `Text (your quote)` → `gpt-image-2-generate` (size `1024x1536`, quality `high`) → preview. Iterate at quality `low` first to save cost, then bump to `high` for the final.
2. **Narrated image description (chained media).** `Text (image brief)` → `gpt-image-1-generate` → feed the `image` output into `gpt-4o-chat` (with a `messages` prompt like "Write a 2-sentence caption") → take the `text` output into `openai-tts` (voice `coral`) to get a spoken caption. Three OpenAI nodes, one key.
3. **Subtitle a voiceover.** `Audio` → `openai-stt` (model `gpt-4o-transcribe`, `response_format` `srt`) → save the SRT. Swap to `openai-translate` instead if the audio is in another language and you want English subtitles.
4. **Masked inpaint.** `Image` + `Mask` + `Text ("replace the sky with aurora")` → `gpt-image-2-edit`. The prompt must describe the **whole** desired image, not just the masked region; the mask marks where edits are allowed and applies to the first image. OpenAI edits only where the mask is fully transparent; Nebula's masks (Mask Painter, Jev Box) are white-on-black, so the edit nodes convert a mask with no transparency (white becomes transparent, black opaque), resize it to the first image, and send it as PNG. A mask that already has transparency keeps its alpha; it is only re-encoded as PNG or resized when it isn't already a PNG with alpha at the image's size (`backend/services/edit_masks.py`). OpenAI's [image generation guide](https://developers.openai.com/api/docs/guides/image-generation) says GPT Image treats the mask as guidance through the prompt, so the edit may spill a little past the mask's edge.

## API coverage — what Nebula uses vs. what OpenAI offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Image generation `/v1/images/generations` | yes | full | gpt-image-1, gpt-image-1.5 (via model enum), gpt-image-1-mini, gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst all reachable |
| Image edit / inpaint `/v1/images/edits` | yes | full | Single image (v1) and up to 16 images (v2), with optional mask |
| Image variations `/v1/images/variations` (dall-e-2) | yes | none | No variations node; largely moot since OpenAI retired dall-e-2/3 on 2026-05-12 |
| Image `background: transparent` | yes (GPT image v1, 2.5) | partial | Exposed on GPT Image 1 / Edit and GPT Image 2.5 / Edit (png/webp only); **not** on gpt-image-2 (API doesn't support it there) |
| Image `n > 1` (multiple per call) | yes | partial | Exposed on GPT Image 1 Edit (Count 1–10); dropped on gpt-image-2 / 2.5 nodes (they stream, and OpenAI rejects `n>1` while streaming) |
| Image streaming previews (`partial_images`) | yes (0–3) | partial | gpt-image-2 / 2.5 nodes stream partials to the canvas internally, but the count isn't a user param (fixed at 0) |
| Image `input_fidelity` (edit) | yes | partial | Sent only by GPT Image 1.5 Edit (the fal copy) on the OpenAI route; gpt-image-2 always processes inputs at high fidelity and must omit it |
| Text-to-speech `/v1/audio/speech` | yes | full | tts-1, tts-1-hd, gpt-4o-mini-tts; 13 voices, 6 formats, speed, instructions |
| TTS streaming (`stream_format: sse`) | yes (gpt-4o-mini-tts) | none | Node writes the whole audio file; no live audio streaming |
| Transcription `/v1/audio/transcriptions` | yes | full | whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe; text/json/verbose_json/srt/vtt |
| Transcription `timestamp_granularities` (word/segment) | yes | none | Not exposed; verbose_json is selectable but per-word timestamps aren't surfaced |
| Transcription streaming / diarization (`gpt-4o-transcribe-diarize`) | yes | none | No streaming STT; diarize model not in the enum |
| Translation `/v1/audio/translations` | yes | full | whisper-1 → English; text/json/srt/vtt |
| Chat completions `/v1/chat/completions` (text) | yes | full | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna (added 2026-10-16), gpt-5.5, gpt-5.4 / mini / nano (with `reasoning_effort`), plus legacy gpt-4o, gpt-4o-mini, gpt-4.1 / mini / nano |
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

**A complete skill exists** at **`.claude/skills/openai/SKILL.md`** (new 2026-06-04, updated 2026-06-10). It is a broad OpenAI-direct skill that supersedes the earlier gpt-image-2-only coverage and documents all **10** OpenAI-direct nodes (GPT Image 2.5 added 2026-10-10). It gives an agent the node IDs and ports, exact params, handler gotchas, and the cross-node chaining recipes, so an agent can assemble any OpenAI pipeline without reading the handlers. (For gpt-image-2 prompting craft and the FAL-routed `gpt-image-2-fal-*` nodes, it cross-links to **`.claude/skills/gpt-image-2/SKILL.md`**, which still exists.)

What it covers:
- **Images** — `gpt-image-1-generate`, `gpt-image-1-edit`, `gpt-image-2-generate`, `gpt-image-2-edit`, `gpt-image-2-5-generate`, `gpt-image-2-5-edit`: the full param matrices, the `background: transparent` param (v1 and 2.5) and `n` (Count) params, the org-verification gotcha, and the `input_fidelity` / `n>1` exclusions on the v2 nodes.
- **Audio** — `openai-tts` (voices/formats/instructions), `openai-stt` (model + `response_format`, incl. SRT/VTT), and `openai-translate` (English-only, fixed-`whisper-1`).
- **Chat** — `gpt-4o-chat` ("OpenAI Chat"): the GPT-6 + GPT-5.6 + GPT-5.x + legacy model enum, the `reasoning_effort` param (reasoning models only), the per-model `max_completion_tokens` default, the sampler-param drop on those models, the vision `images` port (URL / data URI / local path), and `response_format: json_object`.
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
- GPT Image 2.5 model pages and changelog (2026-09-08) — https://developers.openai.com/api/docs/models/gpt-image-2.5-flare , https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst , https://developers.openai.com/api/docs/changelog
