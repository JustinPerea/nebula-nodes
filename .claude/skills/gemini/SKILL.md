---
name: gemini
description: Google's Gemini / Veo / Lyria models inside Nebula — text & vision chat, Nano Banana image gen/edit/compose (incl. Nano Banana 2.1, the replacement for the retired Imagen 4), Veo 3.1 video with sound (Vertex AI, Gemini API or fal), Lyria 3 music, Gemini TTS narration, text embeddings, and a Style Reference utility. Activate when the user configures any gemini-chat, nano-banana, veo-3, veo-3-flf, lyria-3, gemini-tts, gemini-embeddings, or style-reference node, asks about Gemini / Veo / Nano Banana / Lyria in Nebula, or asks for Imagen (retired — use Nano Banana 2.1). For prompt craft also load the topic files (nano-banana.md, veo.md, gemini-text.md). Sourced from ai.google.dev (image-generation, video, speech-generation, music-generation, embeddings, pricing) and Vertex AI Veo docs plus the Nebula audit guide docs/api-guides/google.md, cross-checked against backend/data/node_definitions.json + backend/handlers/google_gemini.py + backend/handlers/veo.py on 2026-06-04 (Imagen retirement, Nano Banana 2.1 and Veo routes updated 2026-10-10).
---

# Gemini Skill

Nebula exposes Google's generative stack as **7 nodes**, all keyed on one `GOOGLE_API_KEY` and hitting `generativelanguage.googleapis.com/v1beta` directly (the Gemini Developer API). The exception is Veo 3.1, which prefers **Vertex AI** when a service-account key is set (see `veo-3` below). **Imagen 4 is retired** (Google shut it down 2026-08-17): the `imagen-4-generate` node was removed, saved ones migrate to `nano-banana` on Nano Banana 2.1, and creating one returns a 400. The separate `gemini-omni-flash` video node now calls `gemini-omni-1.1-flash` (the `gemini-omni-flash-preview` id shuts down 2026-10-22). This file is the authoritative map of the **real Nebula node IDs, param keys, ports, and execution patterns**. For prompt-writing depth, load the topic files listed under [Routing](#routing).

## When to use

- The user configures or asks about any Google node: `gemini-chat`, `nano-banana`, `veo-3`, `veo-3-flf`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, `style-reference`.
- The user asks "which Gemini / Nano Banana / Veo / Lyria model should I use?" (or for Imagen: point them to Nano Banana 2.1) or how to wire one into a graph.
- Editing the handlers `backend/handlers/google_gemini.py` or `backend/handlers/veo.py`, or the Google node defs in `backend/data/node_definitions.json`.
- The user describes an image/video/music/TTS/embedding task that a Google node could serve.

## Universal rules

1. **Auth.** Every node sends the header `x-goog-api-key: <GOOGLE_API_KEY>` (not `Authorization: Bearer`). Enter the key in Nebula **Settings → Google** and save; it is persisted under `apiKeys.GOOGLE_API_KEY` in project-root `settings.json` and takes effect without a restart. One key covers all 7 nodes. `veo-3` *also* accepts `GOOGLE_VERTEX_CREDENTIALS` (a Google Cloud service-account JSON key, Settings → "Google Vertex AI (service-account JSON, for Veo)") and `FAL_KEY`; its `directKeyName` is the list `['GOOGLE_VERTEX_CREDENTIALS','GOOGLE_API_KEY']`.
2. **Base URL.** `https://generativelanguage.googleapis.com/v1beta/models`. The endpoint verb is per-node: `:generateContent` (Nano Banana, Lyria, TTS, Style Reference), `POST /v1beta/interactions` (Nano Banana 2.1 only), `:streamGenerateContent?alt=sse` (Gemini chat), `:embedContent` (Embeddings), `:predictLongRunning` + operation polling (Veo; on Vertex the same verb under `us-central1-aiplatform.googleapis.com`).
3. **Execution patterns (confirmed from handlers):**
   - **stream (SSE)** — `gemini-chat` only. Hits `:streamGenerateContent?alt=sse`; deltas read from `candidates.0.content.parts.0.text`; 60 s timeout.
   - **sync (one POST, blocks for the result)** — `nano-banana`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, `style-reference`. Timeouts: 120 s images/TTS, 180 s Lyria, 60 s embeddings.
   - **async-poll** — `veo-3` (and `veo-3-flf`, `gemini-omni-flash`). POST to `:predictLongRunning` returns an operation `name`; the handler polls `GET /v1beta/{name}` every **3 s up to 300 times** (~15 min ceiling), emits progress, then downloads the finished MP4 to the run dir. Expect minutes, not seconds.
4. **Status / error codes.** Handlers treat any non-`200` as a hard failure and raise `"<Service> API error <status>: <body>"`. Common: `400` bad params (e.g. sending both `thinkingLevel` and `thinkingBudget` to Gemini 3 → 400; an unsupported aspect/size for the chosen model), `401/403` bad or missing key, `429` rate/quota, `5xx` transient. Veo additionally surfaces an `error` object inside the completed operation.
5. **Input-URI rules.** Image inputs on `gemini-chat`, `nano-banana`, `lyria-3`, and `veo-3` accept three forms and the handler converts each: a **local file path** (base64-inlined; png/jpg/jpeg/webp mapped, anything else defaults to `image/png`), an **`http(s)://` URL** (sent as `fileData`/`file_data`; for Veo it's downloaded then inlined, from public https hosts only), or a **`data:` URI** (split into mime + base64). So you can wire another node's `Image` output straight in. **Nano Banana 2.1** differs: it forwards URLs to Google as `{"type":"image","uri"}` and never fetches them itself. `style-reference` is the exception — it takes **no input port**; you set its `filePath` param to a local image.
6. **Key gotchas.**
   - **Gemini 3 vs 2.5 thinking is mutually exclusive.** `thinkingLevel` only shows on the Gemini 3 models; `thinkingBudget` only on the 2.5 models. The handler sends one or the other — never both (the API 400s on both).
   - **Model IDs are the literal enum strings.** The exact strings below (e.g. `gemini-3.1-flash-image`, `gemini-nano-banana-2.1`, `gemini-3-flash-preview`, `lyria-3-clip-preview`, `veo-3.1-generate-preview`) are the values the node's `model` enum actually sends. **Do not "modernize" them** by stripping or adding `-preview` — most are pinned preview ids, but a few are stable ids with no suffix (`gemini-3.5-flash`, `gemini-3.1-flash-lite`, the 2.5 text models). Use each id exactly as listed. (The prompting-craft topic files sometimes use shorthand; the IDs in this file are the ground truth for wiring. The `veo-3` enum keeps the preview ids even on Vertex — the handler maps them to Vertex's `-001` ids.)
   - **Nano Banana / Veo have no transparent-background mode.** Ask for "white background" in the prompt for stickers/cutouts.
   - **Veo outputs expire on Google's side (~2 days).** Nebula downloads the MP4 to the run folder automatically on completion, so the local copy is yours; don't rely on the remote URI later.
   - **Lyria WAV uses a proto-enum mime.** When `outputFormat=wav` on the Pro model, the handler sends `responseFormat.audio.mimeType = "AUDIO_WAV"` (not the literal `"audio/wav"`, which the API rejects). WAV is Pro-only; the Clip model returns MP3.
   - **TTS audio is raw PCM.** The model returns 24 kHz / 16-bit / mono PCM; the handler wraps it into a `.wav`. Output is always WAV regardless of model.
   - **Embeddings output is text, not a vector type.** The `embedding` port is a JSON-stringified float array (`Text`), and `dimensions` is the count as a string — so downstream nodes receive text you parse yourself.

## Pick the right node

One row per Nebula Google node. IDs, ports, and param keys are ground-truth from `node_definitions.json`.

| Node (display) | Node ID | Category · pattern | Endpoint verb | Key inputs → outputs | Model enum (literal values) | Headline params |
|---|---|---|---|---|---|---|
| Gemini | `gemini-chat` | text-gen · **stream** | `:streamGenerateContent?alt=sse` | `messages` (Text, req), `images` (Image, multi) → `text` | `gemini-3.5-flash` (default, stable), `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite` (stable), `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` | `temperature`, `max_tokens`, `system`, `thinkingLevel` (G3) / `thinkingBudget` (2.5), `top_p`, `top_k`, `stop_sequences`, `response_format` |
| Nano Banana | `nano-banana` | image-gen · **sync** | `:generateContent` | `prompt` (Text, req), `images` (Image, multi) → `image`, `text` | `gemini-3.1-flash-image` (default, "Nano Banana 2"), `gemini-nano-banana-2.1` ("Nano Banana 2.1", Interactions API), `gemini-3.1-flash-lite-image` ("2 Lite"), `gemini-3-pro-image` ("Pro"), `gemini-2.5-flash-image` ("2.5 Flash") | `aspect_ratio`, `imageSize` (512/1K/2K/4K) |
| Veo 3.1 | `veo-3` | video-gen · **async-poll** | `:predictLongRunning` → poll (Vertex, then Gemini API, then fal) | `prompt` (Text, req), `image` (First Frame), `last_frame` (Last Frame), `video` (Extend Video) → `video`, `source_uri` | `veo-3.1-generate-preview` (default), `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview` | `aspectRatio`, `duration`, `resolution`, `personGeneration`, `seed` (direct); `negative_prompt`/`safety_tolerance` (FAL path only) |
| Lyria 3 | `lyria-3` | audio-gen · **sync** | `:generateContent` | `prompt` (Text, req), `images` (Image, multi) → `audio`, `text` (Lyrics) | `lyria-3-clip-preview` (default, 30 s), `lyria-3-pro-preview` (full song) | `outputFormat` (MP3/WAV — WAV is Pro-only) |
| Gemini TTS | `gemini-tts` | audio-gen · **sync** | `:generateContent` | `text` (Text, req) → `audio` | `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts` (default), `gemini-2.5-pro-preview-tts` | `voiceName` (30 voices) |
| Gemini Embeddings | `gemini-embeddings` | utility · **sync** | `:embedContent` | `text` (Text, req) → `embedding`, `dimensions` | `gemini-embedding-001` (default, text), `gemini-embedding-2-preview` (multimodal — reaches API as text only) | `taskType` (8 enums), `outputDimensionality` (768/1536/3072) |
| Style Reference | `style-reference` | utility · **sync** | `gemini-2.5-flash:generateContent` | **no input port** → `image` (Reference), `style_description` (Style) | fixed `gemini-2.5-flash` | `filePath` (req), `mode`, `manual_description`, `focus`, `strength` |

## Param reference

Defaults, ranges, and enums per node, straight from `node_definitions.json` + handler behavior.

### `gemini-chat`
- `model` (enum, req, default `gemini-3.5-flash`) — seven values; see table (updated 2026-06-10: `gemini-3.5-flash` is the new stable default, replacing `gemini-2.5-flash`; `gemini-3.1-flash-lite` replaced the old `gemini-3.1-flash-lite-preview` id). The display picks the family.
- `max_tokens` (int, default 8192, 1–65535) → `generationConfig.maxOutputTokens`.
- `temperature` (float, default 1, 0–2, step 0.1). Keep at 1.0 for Gemini 3 (lowering can loop/degrade).
- `system` (textarea) → `systemInstruction`.
- `thinkingLevel` (enum, **Gemini 3 models only**: `""`/minimal/low/medium/high) → `thinkingConfig.thinkingLevel`. `""` = model default.
- `thinkingBudget` (int, **2.5 models only**, 0–65536) → `thinkingConfig.thinkingBudget`. Mutually exclusive with `thinkingLevel`.
- `top_p` (float, 0–1, step 0.05), `top_k` (int, hint 64), `stop_sequences` (comma-separated string).
- `response_format` (enum, default `text/plain`; or `application/json`). **JSON mode is now wired** (2026-06-05): `application/json` sets `generationConfig.responseMimeType = "application/json"` so the reply is valid JSON. **There is still no `responseSchema` field**, so a strict schema must be prompt-engineered. Unit-tested.
- Output: single `text` port. Streams token-by-token to the canvas.

### `imagen-4-generate` (retired)
Google shut Imagen 4 down on 2026-08-17 and names Nano Banana 2.1 as its replacement. The node was removed 2026-10-10: creating one returns a 400, and saved graphs migrate it (`backend/services/retired_nodes.py`) to `nano-banana` with `model=gemini-nano-banana-2.1`, carrying `aspectRatio` → `aspect_ratio` and a 1K/2K `imageSize`, titled "Nano Banana (was Imagen 4)" unless renamed. For plain text-to-image, use `nano-banana`.

### `nano-banana`
- `model` (enum, default `gemini-3.1-flash-image`, "Nano Banana 2"). Also `gemini-nano-banana-2.1` (Nano Banana 2.1), `gemini-3.1-flash-lite-image` (2 Lite, always 1K), `gemini-3-pro-image` (Pro), `gemini-2.5-flash-image` (original, no size control).
- `aspect_ratio` (enum, default `1:1`): `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9`. **Extreme ratios `1:4`, `4:1`, `1:8`, `8:1` appear only on Nano Banana 2.1 and Nano Banana 2.**
- `imageSize` (enum, default `1K`; not on 2.5 Flash): `1K`, plus `2K`/`4K` on 2.1, 2 and Pro, plus `512` **on Nano Banana 2 only** (a saved 512 renders at 1K on 2.1).
- Inputs: up to N reference images on `images` (multi). Outputs both an `image` and any model `text`.
- Sends `responseModalities: ["IMAGE","TEXT"]`; aspect/size go into `generationConfig.imageConfig`.
- **Nano Banana 2.1** goes through the Gemini Interactions API (`POST /v1beta/interactions`) instead of `:generateContent`; wired image URLs are passed as `{"type":"image","uri"}` and never fetched by the backend. Price $0.0336 (1K) / $0.0504 (2K) / $0.113 (4K) per image (ai.google.dev/gemini-api/docs/pricing, checked 2026-10-10). It's the replacement for text-to-image jobs that used Imagen 4.

### `veo-3`
Displayed as "Veo 3.1". Params split three ways in the def (this is a multi-route node):
- **`sharedParams`** (all routes): `aspectRatio` (default `16:9`; `16:9`/`9:16`), `duration` (default `8`; `4`/`6`/`8`), `resolution` (default `720p`; `720p`/`1080p`, plus `4k` on Standard and Fast — **not** Lite; on Vertex only Standard renders 4K and 4K + Fast/Lite raises a `ValueError`), `personGeneration` (`allow_all`/`allow_adult`/`dont_allow`).
- **`directParams`** (Google routes): `model` (default `veo-3.1-generate-preview`; also `-fast-` and `-lite-`), `seed` (int).
- **`falParams`** (FAL path only): `negative_prompt` (string), `seed` (int), `safety_tolerance` (enum `1`–`6`, default `4`). The Google routes do **not** expose a negative prompt.
- Veo 3.0, 3.0 Fast and 2.0 shut down 2026-06-30 and were removed; saved nodes migrate (2.0 → 3.1, 3.0 Fast → 3.1 Fast; a 5 s duration becomes 6 s).
- **Routes, in order** (checked 2026-10-10):
  1. **Vertex AI** when `GOOGLE_VERTEX_CREDENTIALS` is set: `us-central1`, project from the key, GA `veo-3.1-generate-001` / `veo-3.1-fast-generate-001` (retire "Nov 17 2026 or later") and preview `veo-3.1-lite-generate-001` (preview; Google's docs are contradictory about frames for Lite, so Nebula sends them and Vertex decides). Vertex is now branded Gemini Enterprise Agent Platform; the hosts are unchanged. Frames that aren't JPEG or PNG are converted to PNG (also on `veo-3-flf`). Auth is a self-signed JWT exchanged for an OAuth token (no Google SDK; express-mode API keys don't support Veo). Always sends `generateAudio: true`.
  2. **Gemini API** with `GOOGLE_API_KEY`, on the preview ids, which Google retires **2026-10-22**.
  3. **fal** with `FAL_KEY`: `fal-ai/veo3.1` or `fal-ai/veo3.1/fast` (Lite runs as Fast), `/image-to-video` when a first frame is wired, `/first-last-frame-to-video` when both are. Params are renamed to fal's (`aspect_ratio`, `"8s"`). No extension on fal.
  After 2026-10-22 a failed Gemini API or fal run appends a hint to add a Vertex key. (Google's deprecations page names `gemini-omni-1.1-flash` as the Gemini API replacement for the Veo 3.1 previews.)
- Handler maps `duration` → `durationSeconds` (int), strips a trailing `s`. First/last frame come from the `image` / `last_frame` ports, not params.
- **Video extension.** Input port `video` ("Extend Video") continues an existing clip; output `source_uri` carries what to extend from. Wire an upstream `veo-3` node's **`source_uri` → a downstream `veo-3` node's `video`**. On the Gemini API that's a `files/...` URI valid ~2 days, Veo only accepts its own clips, extension is Veo 3.1 and 3.1 Fast only (not Lite), and output is locked to **720p**. On Vertex the `source_uri` is the saved file of a previous Vertex run, but any MP4 works (1–30 s, 24 fps, 720p/1080p/4K, 16:9 or 9:16): a saved file such as any node's `Video` output, a public https URL (up to 100 MB) or a `gs://` URI; Gemini `files/` URIs are rejected there. Vertex extends on all three models (Lite included), keeps the chosen resolution and adds 7 s (total up to 37 s). Extension cannot combine with `image`/`last_frame`.
- **Pricing:** per second × duration, by model and resolution, with audio: Standard $0.40 (720p/1080p) / $0.60 (4K); Fast $0.10 / $0.12 / $0.30 (4K on the Gemini API only); Lite $0.05 / $0.08 (ai.google.dev/gemini-api/docs/pricing, checked 2026-10-10). Vertex runs use the same rows; the fal route is unpriced.
- **Reference images ("ingredients to video") are NOT available.** The live Gemini API rejected them ("Your use case is currently not supported") on both 3.1 preview models with an AI-Studio key (verified 2026-06-08). There is no reference-image port.

**`veo-3-flf`** (Veo 3.1 First-Last Frame) takes required `image` + `end_image` and fal-shaped params; it runs on Vertex (`veo-3.1-generate-001`) when `GOOGLE_VERTEX_CREDENTIALS` is set, else on fal.

### `lyria-3`
- `model` (enum, req, default `lyria-3-clip-preview`): Clip (≤30 s) or `lyria-3-pro-preview` (full song).
- `outputFormat` (enum, default `mp3`; **visible only on Pro**): `mp3` / `wav`. WAV → proto enum `AUDIO_WAV` over the wire.
- Inputs: `prompt` (req) + optional `images` (mood/scene reference). Outputs `audio` + `text` (Lyrics).
- Sends `responseModalities: ["AUDIO","TEXT"]`.

### `gemini-tts`
- `model` (enum, default `gemini-2.5-flash-preview-tts`): `gemini-3.1-flash-tts-preview` (added 2026-06-10) · `gemini-2.5-flash-preview-tts` · `gemini-2.5-pro-preview-tts`.
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
   `nano-banana` (hero still, `model=gemini-nano-banana-2.1`, `aspect_ratio=16:9`) → wire its `image` into `veo-3`'s **First Frame** (`image` port), prompt the motion (`model=veo-3.1-generate-preview`, `resolution=1080p`). In parallel, `lyria-3` (`model=lyria-3-clip-preview`, prompt the mood) produces a 30 s bed. Mix the Lyria `audio` under the Veo `video` downstream. Remember Veo is async-poll — it'll take minutes.

2. **Style-locked product shots.**
   `style-reference` (set `filePath` to a reference photo, `mode=auto`, `focus=all`, `strength=0.7`) → route `style_description` (Style) into `nano-banana`'s `prompt` and the Reference `image` into its `images` input, then append your product description. Use `model=gemini-3-pro-image` for legible packaging text; bump `imageSize=2K`. Every render inherits the reference's look and stays product-consistent across angles.

3. **Narrated explainer with slides.**
   `gemini-chat` (`system="You are a concise narrator", response_format=text/plain`) writes a script from a topic → feed its `text` into `gemini-tts` (`voiceName=Charon` for an informative read) for spoken VO. Generate matching `nano-banana` stills for each slide. (Keep narration single-voice — TTS here is single-speaker.)

4. **Searchable knowledge base (RAG backbone).**
   For each document: `gemini-embeddings` (`taskType=RETRIEVAL_DOCUMENT`, `outputDimensionality=768`) → store the `embedding` text (parse the JSON array). At query time, embed the user's question with `taskType=RETRIEVAL_QUERY` and cosine-rank. Nebula builds the index yourself — there's no managed File Search node.

## In the nebula_nodes context

- **Node IDs (7):** `gemini-chat`, `nano-banana`, `veo-3`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, `style-reference`.
- **Handler files:** `backend/handlers/google_gemini.py` (chat, nano-banana incl. the 2.1 Interactions call, lyria3, tts, embeddings — and Style Reference's `gemini-2.5-flash` describe call) and `backend/handlers/veo.py` (Veo submit + poll + download on Vertex / Gemini API, plus the fal route mapping); Vertex auth lives in `backend/services/google_vertex.py`. Param-build logic lives there; consult it before changing a param name.
- **Ports & chaining.**
  - Image outputs (`nano-banana.image`, `style-reference.image`) plug into any node's `Image`-typed input (`nano-banana.images`, `veo-3.image`/`last_frame`, `gemini-chat.images`, `lyria-3.images`).
  - `gemini-chat.text` → any `Text` input (e.g. `gemini-tts.text`, `nano-banana.prompt`).
  - `style-reference.style_description` (Text) → a generator's `prompt`; pair its `image` (Reference) into that generator's `images`.
  - `gemini-embeddings` emits **Text** (a JSON array + a count), not a numeric vector type — parse it downstream.
- **How outputs render.** Images/video/audio are saved to the run dir and served via the outputs route; the canvas previews them (image/video/audio players). `gemini-chat` streams text live into its node.
- **Where they appear in the palette:** text-gen (Gemini), image-gen (Nano Banana), video-gen (Veo 3.1), audio-gen (Lyria 3, Gemini TTS), utility (Gemini Embeddings, Style Reference).
- **Veo multi-route:** `veo-3` carries `GOOGLE_VERTEX_CREDENTIALS`, `GOOGLE_API_KEY` and `FAL_KEY`. Both Google routes use `directParams`; the FAL route swaps in `falParams` (`negative_prompt`, `safety_tolerance`) — the negative prompt is *only* reachable via FAL.

### Capability boundaries (what the API can do that Nebula does NOT expose)

Never promise these through the current nodes — they exist in the Google API but are not surfaced. (Source: gap table in `docs/api-guides/google.md`.)

- **Gemini text tools — all absent.** No function calling, no Google Search grounding, no URL-context tool, no code execution. `gemini-chat` is plain `generateContent` with vision-in.
- **Structured output: JSON mode works, no schema.** `response_format=application/json` is honored (sets `generationConfig.responseMimeType`, wired 2026-06-05), but there's **no `responseSchema`** — strict schemas must be prompt-engineered.
- **Vision-in only for understanding.** `gemini-chat` accepts images; video / audio / PDF understanding is not wired.
- **Nano Banana:** image-search grounding and explicit `thinkingLevel` control are not surfaced (text-to-image, edit, and multi-image compose are).
- **Imagen:** retired by Google (2026-08-17); no Imagen node remains.
- **Veo:** **reference images (up to 3)** are not exposed; negative prompt only via the FAL route; extension isn't available on FAL.
- **TTS:** **multi-speaker (2-voice) dialogue** is not surfaced — single-speaker only (the 3.1 Flash TTS preview model joined the enum 2026-06-10).
- **Lyria:** **Lyria RealTime** (streaming/WebSocket music, weighted-prompt steering) is not exposed — only the batch Clip/Pro models.
- **Embeddings:** **true multimodal embedding** (image/audio/video/PDF via Embedding 2) only reaches the API as text here.
- **Operational endpoints — none:** no Live API (realtime voice), no Computer Use, no File Search / managed RAG, no Batch API, no context caching, no token counting.
- **Safety:** only `personGeneration` (Veo) is adjustable; there is no general `safetySettings` block.

Coverage is the core generative modalities (text, Nano Banana, Veo, Lyria, TTS, embeddings, + a style-extraction helper); the gaps are advanced text-model tooling and operational/streaming endpoints, not missing media types.

## Routing

Prompt-writing depth lives in topic files — load the relevant one before authoring the text that feeds a node:

- **`nano-banana.md`** — Gemini image family: narrative prompting, editing, multi-image composition, in-image text.
- **`veo.md`** — Veo 3.x: prompt structure, camera language, audio, refs, extension, first/last frame.
- **`imagen.md`** — retirement note only: Imagen 4 is gone; use Nano Banana 2.1.
- **`gemini-text.md`** — Gemini text prompting, structured output, thinking mode.
- **`reference/model-ids.md`** — full model-ID catalog incl. Live, computer-use, deep-research (broader than the 7 Nebula nodes).
- **`reference/official-docs.md`** — canonical ai.google.dev URLs to fetch when content smells stale.

These topic files are prompt-craft references synthesized 2026-04-16 and may lag the live API; the node IDs/params in **this** SKILL.md were re-verified against the repo on 2026-06-04 (model enums updated 2026-06-10; Imagen retirement, Nano Banana 2.1, Veo routes and Omni id updated 2026-10-10) and are authoritative for wiring.

## Sources

- Gemini API overview — https://ai.google.dev/gemini-api/docs
- Image generation & editing (Nano Banana) — https://ai.google.dev/gemini-api/docs/image-generation
- Pricing — https://ai.google.dev/gemini-api/docs/pricing
- Video generation (Veo) — https://ai.google.dev/gemini-api/docs/video
- Veo on Vertex AI — https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation
- Speech generation (TTS) — https://ai.google.dev/gemini-api/docs/speech-generation
- Music generation (Lyria) — https://ai.google.dev/gemini-api/docs/music-generation
- Embeddings — https://ai.google.dev/gemini-api/docs/embeddings
- Model catalog — https://ai.google.dev/gemini-api/docs/models
- Nebula audit guide (node table, params, gap table) — `docs/api-guides/google.md`
