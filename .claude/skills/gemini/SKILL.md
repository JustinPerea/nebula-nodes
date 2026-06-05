---
name: gemini
description: Google's Gemini / Imagen / Veo / Lyria models inside Nebula — text & vision chat, Imagen 4 text-to-image, Nano Banana image gen/edit/compose, Veo 3.1 video with sound, Lyria 3 music, Gemini TTS narration, text embeddings, and a Style Reference utility. Activate when the user configures any gemini-chat, imagen-4-generate, nano-banana, veo-3, lyria-3, gemini-tts, gemini-embeddings, or style-reference node, or asks about Gemini / Imagen / Veo / Nano Banana / Lyria in Nebula. For prompt craft also load the topic files (nano-banana.md, veo.md, imagen.md, gemini-text.md). Sourced from ai.google.dev (image-generation, imagen, video, speech-generation, music-generation, embeddings) and the Nebula audit guide docs/api-guides/google.md, cross-checked against backend/data/node_definitions.json + backend/handlers/google_gemini.py + backend/handlers/veo.py on 2026-06-04.
---

# Gemini Skill

Nebula exposes Google's generative stack as **8 nodes**, all keyed on one `GOOGLE_API_KEY` and all hitting `generativelanguage.googleapis.com/v1beta` directly (the Gemini Developer API, not Vertex). This file is the authoritative map of the **real Nebula node IDs, param keys, ports, and execution patterns**. For prompt-writing depth, load the topic files listed under [Routing](#routing).

## When to use

- The user configures or asks about any Google node: `gemini-chat`, `imagen-4-generate`, `nano-banana`, `veo-3`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, `style-reference`.
- The user asks "which Gemini / Imagen / Nano Banana / Veo / Lyria model should I use?" or how to wire one into a graph.
- Editing the handlers `backend/handlers/google_gemini.py` or `backend/handlers/veo.py`, or the Google node defs in `backend/data/node_definitions.json`.
- The user describes an image/video/music/TTS/embedding task that a Google node could serve.

## Universal rules

1. **Auth.** Every node sends the header `x-goog-api-key: <GOOGLE_API_KEY>` (not `Authorization: Bearer`). The env var is `GOOGLE_API_KEY`, read from `.env` at the repo root; restart the backend after adding it. One key covers all 8 nodes. `veo-3` *also* declares `FAL_KEY` because it can route through FAL — but the direct Google path documented here needs only `GOOGLE_API_KEY`.
2. **Base URL.** `https://generativelanguage.googleapis.com/v1beta/models`. The endpoint verb is per-node: `:generateContent` (Nano Banana, Lyria, TTS, Style Reference), `:streamGenerateContent?alt=sse` (Gemini chat), `:predict` (Imagen), `:embedContent` (Embeddings), `:predictLongRunning` + operation polling (Veo).
3. **Execution patterns (confirmed from handlers):**
   - **stream (SSE)** — `gemini-chat` only. Hits `:streamGenerateContent?alt=sse`; deltas read from `candidates.0.content.parts.0.text`; 60 s timeout.
   - **sync (one POST, blocks for the result)** — `nano-banana`, `imagen-4-generate`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, `style-reference`. Timeouts: 120 s images/TTS, 180 s Lyria, 60 s embeddings.
   - **async-poll** — `veo-3` only. POST to `:predictLongRunning` returns an operation `name`; the handler polls `GET /v1beta/{name}` every **3 s up to 300 times** (~15 min ceiling), emits progress, then downloads the finished MP4 to the run dir. Expect minutes, not seconds.
4. **Status / error codes.** Handlers treat any non-`200` as a hard failure and raise `"<Service> API error <status>: <body>"`. Common: `400` bad params (e.g. sending both `thinkingLevel` and `thinkingBudget` to Gemini 3 → 400; an unsupported aspect/size for the chosen model), `401/403` bad or missing key, `429` rate/quota, `5xx` transient. Veo additionally surfaces an `error` object inside the completed operation.
5. **Input-URI rules.** Image inputs on `gemini-chat`, `nano-banana`, `lyria-3`, and `veo-3` accept three forms and the handler converts each: a **local file path** (base64-inlined; png/jpg/jpeg/webp mapped, anything else defaults to `image/png`), an **`http(s)://` URL** (sent as `fileData`/`file_data`; for Veo it's downloaded then inlined), or a **`data:` URI** (split into mime + base64). So you can wire another node's `Image` output straight in. `style-reference` is the exception — it takes **no input port**; you set its `filePath` param to a local image.
6. **Key gotchas.**
   - **Gemini 3 vs 2.5 thinking is mutually exclusive.** `thinkingLevel` only shows on the Gemini 3 models; `thinkingBudget` only on the 2.5 models. The handler sends one or the other — never both (the API 400s on both).
   - **Model IDs are literal preview enums.** The exact strings below (e.g. `gemini-3.1-flash-image-preview`, `gemini-3-flash-preview`, `lyria-3-clip-preview`, `veo-3.1-generate-preview`) are the values the node's `model` enum actually sends. **Do not "modernize" them** by stripping `-preview` — those are the strings Nebula ships, and a non-preview form is not an option the node offers. (The prompting-craft topic files sometimes use shorthand like `imagen-4`; the IDs in this file are the ground truth for wiring.)
   - **Nano Banana / Imagen / Veo have no transparent-background mode.** Ask for "white background" in the prompt for stickers/cutouts.
   - **Veo outputs expire on Google's side (~2 days).** Nebula downloads the MP4 to the run folder automatically on completion, so the local copy is yours; don't rely on the remote URI later.
   - **Lyria WAV uses a proto-enum mime.** When `outputFormat=wav` on the Pro model, the handler sends `responseFormat.audio.mimeType = "AUDIO_WAV"` (not the literal `"audio/wav"`, which the API rejects). WAV is Pro-only; the Clip model returns MP3.
   - **TTS audio is raw PCM.** The model returns 24 kHz / 16-bit / mono PCM; the handler wraps it into a `.wav`. Output is always WAV regardless of model.
   - **Embeddings output is text, not a vector type.** The `embedding` port is a JSON-stringified float array (`Text`), and `dimensions` is the count as a string — so downstream nodes receive text you parse yourself.

## Pick the right node

One row per Nebula Google node. IDs, ports, and param keys are ground-truth from `node_definitions.json`.

| Node (display) | Node ID | Category · pattern | Endpoint verb | Key inputs → outputs | Model enum (literal values) | Headline params |
|---|---|---|---|---|---|---|
| Gemini | `gemini-chat` | text-gen · **stream** | `:streamGenerateContent?alt=sse` | `messages` (Text, req), `images` (Image, multi) → `text` | `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`, `gemini-2.5-pro`, `gemini-2.5-flash` (default), `gemini-2.5-flash-lite` | `temperature`, `max_tokens`, `system`, `thinkingLevel` (G3) / `thinkingBudget` (2.5), `top_p`, `top_k`, `stop_sequences`, `response_format` |
| Imagen 4 | `imagen-4-generate` | image-gen · **sync** | `:predict` | `prompt` (Text, req) → `image` | `imagen-4.0-generate-001` (default), `imagen-4.0-ultra-generate-001`, `imagen-4.0-fast-generate-001` | `aspectRatio`, `numberOfImages`, `seed`, `enhancePrompt`, `imageSize` (1K/2K, base+Ultra only), `personGeneration` |
| Nano Banana | `nano-banana` | image-gen · **sync** | `:generateContent` | `prompt` (Text, req), `images` (Image, multi) → `image`, `text` | `gemini-3.1-flash-image-preview` (default, "Nano Banana 2"), `gemini-3-pro-image-preview` ("Pro"), `gemini-2.5-flash-image` ("2.5 Flash") | `aspect_ratio`, `imageSize` (512/1K/2K/4K) |
| Veo 3.1 | `veo-3` | video-gen · **async-poll** | `:predictLongRunning` → poll | `prompt` (Text, req), `image` (First Frame), `last_frame` (Last Frame) → `video` | `veo-3.1-generate-preview` (default), `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview`, `veo-3.0-generate-001`, `veo-3.0-fast-generate-001`, `veo-2.0-generate-001` | `aspectRatio`, `duration`, `resolution`, `personGeneration`, `seed` (direct); `negative_prompt`/`safety_tolerance` (FAL path only) |
| Lyria 3 | `lyria-3` | audio-gen · **sync** | `:generateContent` | `prompt` (Text, req), `images` (Image, multi) → `audio`, `text` (Lyrics) | `lyria-3-clip-preview` (default, 30 s), `lyria-3-pro-preview` (full song) | `outputFormat` (MP3/WAV — WAV is Pro-only) |
| Gemini TTS | `gemini-tts` | audio-gen · **sync** | `:generateContent` | `text` (Text, req) → `audio` | `gemini-2.5-flash-preview-tts` (default), `gemini-2.5-pro-preview-tts` | `voiceName` (30 voices) |
| Gemini Embeddings | `gemini-embeddings` | utility · **sync** | `:embedContent` | `text` (Text, req) → `embedding`, `dimensions` | `gemini-embedding-001` (default, text), `gemini-embedding-2-preview` (multimodal — reaches API as text only) | `taskType` (8 enums), `outputDimensionality` (768/1536/3072) |
| Style Reference | `style-reference` | utility · **sync** | `gemini-2.5-flash:generateContent` | **no input port** → `image` (Reference), `style_description` (Style) | fixed `gemini-2.5-flash` | `filePath` (req), `mode`, `manual_description`, `focus`, `strength` |

## Param reference

Defaults, ranges, and enums per node, straight from `node_definitions.json` + handler behavior.

### `gemini-chat`
- `model` (enum, req, default `gemini-2.5-flash`) — six values; see table. The display picks the family.
- `max_tokens` (int, default 8192, 1–65535) → `generationConfig.maxOutputTokens`.
- `temperature` (float, default 1, 0–2, step 0.1). Keep at 1.0 for Gemini 3 (lowering can loop/degrade).
- `system` (textarea) → `systemInstruction`.
- `thinkingLevel` (enum, **Gemini 3 models only**: `""`/minimal/low/medium/high) → `thinkingConfig.thinkingLevel`. `""` = model default.
- `thinkingBudget` (int, **2.5 models only**, 0–65536) → `thinkingConfig.thinkingBudget`. Mutually exclusive with `thinkingLevel`.
- `top_p` (float, 0–1, step 0.05), `top_k` (int, hint 64), `stop_sequences` (comma-separated string).
- `response_format` (enum, default `text/plain`; or `application/json`). **JSON toggle only — there is no `responseSchema` field**, so a strict schema must be prompt-engineered.
- Output: single `text` port. Streams token-by-token to the canvas.

### `imagen-4-generate`
- `model` (enum, req, default `imagen-4.0-generate-001`) — base / `...ultra...` / `...fast...`.
- `aspectRatio` (enum, default `1:1`): `1:1`, `4:3`, `3:4`, `16:9`, `9:16`.
- `numberOfImages` (int, default 1, 1–4) → `sampleCount`. Note: only the first prediction is saved to the `image` port.
- `seed` (int, optional) — reproducibility.
- `enhancePrompt` (bool, default false) — Google rewrites the prompt for richer detail.
- `imageSize` (enum, default `1K`; `1K`/`2K`) — **visible only on base + Ultra** (not Fast).
- `personGeneration` (enum, default `allow_adult`): `allow_all` / `allow_adult` / `dont_allow`.

### `nano-banana`
- `model` (enum, default `gemini-3.1-flash-image-preview`). Pro = `gemini-3-pro-image-preview`; original = `gemini-2.5-flash-image`.
- `aspect_ratio` (enum, default `1:1`): `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9`. **Extreme ratios `1:4`, `4:1`, `1:8`, `8:1` appear only on Nano Banana 2** (`...3.1-flash-image-preview`).
- `imageSize` (enum, default `1K`; visible on Nano Banana 2 + Pro, not 2.5 Flash): `1K`, `2K`, `4K`, plus `512` **on Nano Banana 2 only**.
- Inputs: up to N reference images on `images` (multi). Outputs both an `image` and any model `text`.
- Sends `responseModalities: ["IMAGE","TEXT"]`; aspect/size go into `generationConfig.imageConfig`.

### `veo-3`
Params split three ways in the def (this is a dual-provider node):
- **`sharedParams`** (both Google + FAL): `aspectRatio` (default `16:9`; `16:9`/`9:16`), `duration` (default `8`; valid set varies by model — `4/6/8` on Veo 3.x & Veo 3, `5/6/8` on Veo 2), `resolution` (default `720p`; `720p`/`1080p`, plus `4k` on full Veo 3.x and Veo 3 — **not** Lite), `personGeneration` (`allow_all`/`allow_adult`/`dont_allow`).
- **`directParams`** (Google path): `model` (default `veo-3.1-generate-preview`, six values), `seed` (int; not on Veo 2).
- **`falParams`** (FAL path only): `negative_prompt` (string), `seed` (int), `safety_tolerance` (enum `1`–`6`, default `4`). The direct Google path does **not** expose a negative prompt.
- Handler maps `duration` → `durationSeconds` (int), strips a trailing `s`. First/last frame come from the `image` / `last_frame` ports, not params.

### `lyria-3`
- `model` (enum, req, default `lyria-3-clip-preview`): Clip (≤30 s) or `lyria-3-pro-preview` (full song).
- `outputFormat` (enum, default `mp3`; **visible only on Pro**): `mp3` / `wav`. WAV → proto enum `AUDIO_WAV` over the wire.
- Inputs: `prompt` (req) + optional `images` (mood/scene reference). Outputs `audio` + `text` (Lyrics).
- Sends `responseModalities: ["AUDIO","TEXT"]`.

### `gemini-tts`
- `model` (enum, default `gemini-2.5-flash-preview-tts`) or `gemini-2.5-pro-preview-tts`.
- `voiceName` (enum, default `Kore`) — **30 prebuilt voices**, each labeled with a character: e.g. `Kore` (Firm), `Puck` (Upbeat), `Zephyr` (Bright), `Charon` (Informative), `Fenrir` (Excitable), `Leda` (Youthful), `Aoede` (Breezy), `Enceladus` (Breathy), `Algieba` (Smooth), `Sulafat` (Warm), `Achird` (Friendly), `Gacrux` (Mature) … through `Sadaltager` (Knowledgeable). Pick by the vibe label.
- Input: `text` (req) — this is the script to speak. Output: `audio` (WAV).
- Single-speaker only; sends `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.

### `gemini-embeddings`
- `model` (enum, default `gemini-embedding-001`) or `gemini-embedding-2-preview` (multimodal model, but the node only feeds it `text`).
- `taskType` (enum, default `SEMANTIC_SIMILARITY`): `SEMANTIC_SIMILARITY`, `RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`, `CLASSIFICATION`, `CLUSTERING`, `CODE_RETRIEVAL_QUERY`, `QUESTION_ANSWERING`, `FACT_VERIFICATION`. **Match query vs document:** embed stored docs with `RETRIEVAL_DOCUMENT`, embed the live search string with `RETRIEVAL_QUERY` — mismatching them hurts recall.
- `outputDimensionality` (enum, default `768`): `768` / `1536` / `3072`. Smaller = cheaper storage & faster cosine; 3072 = max fidelity.
- Input: `text` (req). Outputs: `embedding` (JSON array as **Text**) + `dimensions` (count as **Text**).

### `style-reference`
A local utility that turns one image into a reusable look. **No input port** — set `filePath` directly.
- `filePath` (file, req) — the reference image on disk.
- `mode` (enum, default `auto`): `auto` (Gemini 2.5 Flash writes the description), `manual` (you supply it), `passthrough` ("Image only" — emit just the Reference image, no text).
- `manual_description` (textarea) — **visible only when `mode=manual`**; the style text you author.
- `focus` (enum, default `all`; **visible only when `mode=auto`**): `all` (palette + lighting + medium + mood), `palette`, `lighting`, `medium` (texture). Narrow it to transfer just one axis.
- `strength` (float, default 0.7, 0–1, step 0.05) — how strongly the description leans into the style.
- Outputs: `image` (Reference, the original image re-emitted) + `style_description` (Style, Text). Wire **Style → a generator's `prompt`** and **Reference → that generator's `images`** input.

## Recipes

Concrete graphs using real node IDs.

1. **Illustrated short with a soundtrack.**
   `imagen-4-generate` (hero still, `aspectRatio=16:9`) → wire its `image` into `veo-3`'s **First Frame** (`image` port), prompt the motion (`model=veo-3.1-generate-preview`, `resolution=1080p`). In parallel, `lyria-3` (`model=lyria-3-clip-preview`, prompt the mood) produces a 30 s bed. Mix the Lyria `audio` under the Veo `video` downstream. Remember Veo is async-poll — it'll take minutes.

2. **Style-locked product shots.**
   `style-reference` (set `filePath` to a reference photo, `mode=auto`, `focus=all`, `strength=0.7`) → route `style_description` (Style) into `nano-banana`'s `prompt` and the Reference `image` into its `images` input, then append your product description. Use `model=gemini-3-pro-image-preview` for legible packaging text; bump `imageSize=2K`. Every render inherits the reference's look and stays product-consistent across angles.

3. **Narrated explainer with slides.**
   `gemini-chat` (`system="You are a concise narrator", response_format=text/plain`) writes a script from a topic → feed its `text` into `gemini-tts` (`voiceName=Charon` for an informative read) for spoken VO. Generate matching `imagen-4-generate` stills for each slide. (Keep narration single-voice — TTS here is single-speaker.)

4. **Searchable knowledge base (RAG backbone).**
   For each document: `gemini-embeddings` (`taskType=RETRIEVAL_DOCUMENT`, `outputDimensionality=768`) → store the `embedding` text (parse the JSON array). At query time, embed the user's question with `taskType=RETRIEVAL_QUERY` and cosine-rank. Nebula builds the index yourself — there's no managed File Search node.

## In the nebula_nodes context

- **Node IDs (8):** `gemini-chat`, `imagen-4-generate`, `nano-banana`, `veo-3`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, `style-reference`.
- **Handler files:** `backend/handlers/google_gemini.py` (chat, nano-banana, imagen4, lyria3, tts, embeddings — and Style Reference's `gemini-2.5-flash` describe call) and `backend/handlers/veo.py` (Veo submit + poll + download). Param-build logic lives there; consult it before changing a param name.
- **Ports & chaining.**
  - Image outputs (`imagen-4-generate.image`, `nano-banana.image`, `style-reference.image`) plug into any node's `Image`-typed input (`nano-banana.images`, `veo-3.image`/`last_frame`, `gemini-chat.images`, `lyria-3.images`).
  - `gemini-chat.text` → any `Text` input (e.g. `gemini-tts.text`, `nano-banana.prompt`, `imagen-4-generate.prompt`).
  - `style-reference.style_description` (Text) → a generator's `prompt`; pair its `image` (Reference) into that generator's `images`.
  - `gemini-embeddings` emits **Text** (a JSON array + a count), not a numeric vector type — parse it downstream.
- **How outputs render.** Images/video/audio are saved to the run dir and served via the outputs route; the canvas previews them (image/video/audio players). `gemini-chat` streams text live into its node.
- **Where they appear in the palette:** text-gen (Gemini), image-gen (Imagen 4, Nano Banana), video-gen (Veo 3.1), audio-gen (Lyria 3, Gemini TTS), utility (Gemini Embeddings, Style Reference).
- **Veo dual-provider:** `veo-3` carries both `GOOGLE_API_KEY` and `FAL_KEY`. The direct Google path (this skill) uses `directParams`; switching to FAL swaps in `falParams` (`negative_prompt`, `safety_tolerance`) — the negative prompt is *only* reachable via FAL.

### Capability boundaries (what the API can do that Nebula does NOT expose)

Never promise these through the current nodes — they exist in the Google API but are not surfaced. (Source: gap table in `docs/api-guides/google.md`.)

- **Gemini text tools — all absent.** No function calling, no Google Search grounding, no URL-context tool, no code execution. `gemini-chat` is plain `generateContent` with vision-in.
- **Structured output is JSON-toggle only.** `response_format=application/json` exists, but there's **no `responseSchema`** — strict schemas must be prompt-engineered.
- **Vision-in only for understanding.** `gemini-chat` accepts images; video / audio / PDF understanding is not wired.
- **Nano Banana:** image-search grounding and explicit `thinkingLevel` control are not surfaced (text-to-image, edit, and multi-image compose are).
- **Imagen edit / inpaint / customize / upscale:** not available — those live in **Vertex AI**, not the Gemini Developer API Nebula targets. (Not a Nebula gap, an API-surface boundary.)
- **Veo:** **reference images (up to 3)** and **video extension (longer-than-8 s clips, up to ~148 s)** are not exposed on the direct path; negative prompt only via the FAL route.
- **TTS:** **multi-speaker (2-voice) dialogue** and the **3.1 Flash TTS** model are not surfaced — single-speaker, 2.5 Flash/Pro only.
- **Lyria:** **Lyria RealTime** (streaming/WebSocket music, weighted-prompt steering) is not exposed — only the batch Clip/Pro models.
- **Embeddings:** **true multimodal embedding** (image/audio/video/PDF via Embedding 2) only reaches the API as text here.
- **Operational endpoints — none:** no Live API (realtime voice), no Computer Use, no File Search / managed RAG, no Batch API, no context caching, no token counting.
- **Safety:** only `personGeneration` (Imagen/Veo) is adjustable; there is no general `safetySettings` block.

Coverage is roughly the 8 core generative modalities (text, Imagen, Nano Banana, Veo, Lyria, TTS, embeddings, + a style-extraction helper); the gaps are advanced text-model tooling and operational/streaming endpoints, not missing media types.

## Routing

Prompt-writing depth lives in topic files — load the relevant one before authoring the text that feeds a node:

- **`nano-banana.md`** — Gemini image family: narrative prompting, editing, multi-image composition, in-image text.
- **`veo.md`** — Veo 3.x: prompt structure, camera language, audio, refs, extension, first/last frame.
- **`imagen.md`** — Imagen 4 text-to-image (uses `imagen-4` shorthand; wire with the real `imagen-4.0-*` IDs above).
- **`gemini-text.md`** — Gemini text prompting, structured output, thinking mode.
- **`reference/model-ids.md`** — full model-ID catalog incl. Live, computer-use, deep-research (broader than the 8 Nebula nodes).
- **`reference/official-docs.md`** — canonical ai.google.dev URLs to fetch when content smells stale.

These topic files are prompt-craft references synthesized 2026-04-16 and may lag the live API; the node IDs/params in **this** SKILL.md were re-verified against the repo on 2026-06-04 and are authoritative for wiring.

## Sources

- Gemini API overview — https://ai.google.dev/gemini-api/docs
- Image generation & editing (Nano Banana) — https://ai.google.dev/gemini-api/docs/image-generation
- Imagen — https://ai.google.dev/gemini-api/docs/imagen
- Video generation (Veo) — https://ai.google.dev/gemini-api/docs/video
- Speech generation (TTS) — https://ai.google.dev/gemini-api/docs/speech-generation
- Music generation (Lyria) — https://ai.google.dev/gemini-api/docs/music-generation
- Embeddings — https://ai.google.dev/gemini-api/docs/embeddings
- Model catalog — https://ai.google.dev/gemini-api/docs/models
- Nebula audit guide (node table, params, gap table) — `docs/api-guides/google.md`
