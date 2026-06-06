# Google (Gemini / Imagen / Veo / Lyria) in Nebula Nodes

> Google's models let a Nebula user generate and edit images, produce video with sound, write and reason over text, make music and spoken audio, and turn text or media into search-ready embeddings — all from nodes you drag onto the canvas.

## What you can make

**Images**
- Text-to-image from a written prompt (Imagen 4, or Nano Banana).
- Edit / combine images — feed reference pictures in and describe the change (Nano Banana: blend up to ~14 references for character and product consistency).
- High-resolution renders up to 4K (Nano Banana) or 2K (Imagen 4), in aspect ratios from square to ultra-wide panoramas.
- Extract a reusable "style fingerprint" from any image to steer other generators (Style Reference utility).

**Video**
- Text-to-video and image-to-video clips with native audio (Veo 3.1).
- First-frame + last-frame control to interpolate between two stills.
- 720p / 1080p / 4K output, 16:9 or 9:16, 4–8 second clips.

**Audio**
- Music from a text prompt — 30-second clips or full multi-minute songs, instrumental or with lyrics (Lyria 3).
- Spoken narration / text-to-speech in 30 expressive voices (Gemini TTS).

**Text & utility**
- Chat, reasoning, summarization, and structured (JSON) output from the Gemini text models, with adjustable "thinking" effort and vision input (drop images in for it to describe or analyze).
- Vector embeddings of text for semantic search, RAG, clustering, and classification (Gemini Embeddings).

## Nodes available in Nebula (8)

All eight nodes authenticate with the same `GOOGLE_API_KEY` and call Google's `generativelanguage.googleapis.com` endpoints directly.

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Gemini | `gemini-chat` | text-gen | `messages` (text), `images` | `model` (Gemini 3.1 Pro / 3 Flash / 3.1 Flash Lite / 2.5 Pro / 2.5 Flash / 2.5 Flash Lite), `max_tokens`, `temperature`, `system`, `thinkingLevel`, `thinkingBudget`, `top_p`, `top_k`, `stop_sequences`, `response_format` (text / JSON) | Chat, reasoning, summarization, JSON extraction, describing/analyzing images |
| Imagen 4 | `imagen-4-generate` | image-gen | `prompt` | `model` (Imagen 4 / Ultra / Fast), `aspectRatio` (1:1, 4:3, 3:4, 16:9, 9:16), `numberOfImages`, `seed`, `enhancePrompt`, `imageSize` (1K / 2K), `personGeneration` | Clean text-to-image when you don't need editing or references |
| Nano Banana | `nano-banana` | image-gen | `prompt`, `images` | `model` (Nano Banana 2 / Nano Banana Pro / Nano Banana 2.5 Flash), `aspect_ratio` (1:1 … 21:9, plus 1:4/4:1/1:8/8:1 on Nano Banana 2), `imageSize` (512 / 1K / 2K / 4K) | Image editing, multi-image composition, character/product consistency, legible in-image text |
| Veo 3.1 | `veo-3` | video-gen | `prompt`, `image` (First Frame), `last_frame` (Last Frame) | `model` (Veo 3.1 / Fast / Lite / Veo 3 / Veo 2), `aspectRatio` (16:9, 9:16), `duration` (4/6/8s), `resolution` (720p / 1080p / 4K), `personGeneration`, `seed` | Cinematic clips with sound, image-to-video, first→last frame interpolation |
| Lyria 3 | `lyria-3` | audio-gen | `prompt`, `images` | `model` (Lyria 3 Clip 30s / Lyria 3 Pro full song), `outputFormat` (MP3 / WAV) | Background music, songs with lyrics, mood-from-image scoring |
| Gemini TTS | `gemini-tts` | audio-gen | `text` | `model` (2.5 Flash TTS / 2.5 Pro TTS), `voiceName` (30 voices: Kore, Puck, Zephyr, Charon, …) | Voiceover, narration, spoken-word from a script |
| Gemini Embeddings | `gemini-embeddings` | utility | `text` | `model` (Embedding 001 / Embedding 2 multimodal), `taskType` (Semantic Similarity, Retrieval Query/Document, Classification, Clustering, Code Retrieval, Question Answering, Fact Verification), `outputDimensionality` (768 / 1536 / 3072) | Semantic search, RAG, clustering, similarity scoring |
| Style Reference | `style-reference` | utility | _(none — uploads a file)_ | `filePath` (reference image), `mode` (Auto via Gemini / Manual / Image only), `focus` (all / palette / lighting / medium), `strength` (0–1) | Turn one image into a reusable style description + reference to feed image generators |

Notes that matter when wiring these up:
- **Style Reference takes no input port** — you upload the image directly in the node's `filePath` field. It outputs both a `Reference` image and a `Style` text description you route into a generator's prompt.
- **Veo is asynchronous** — it submits a long-running job and polls until the clip is ready, so expect it to take longer than image nodes. Google deletes generated videos after ~2 days; Nebula downloads them to your run folder automatically on completion.
- **Veo can also run through FAL** in Nebula (it carries both `GOOGLE_API_KEY` and `FAL_KEY`). This guide covers the direct Google path; the FAL path exposes a couple of extra params (`negative_prompt`, `safety_tolerance`).
- The `images` input on Gemini, Nano Banana, and Lyria accepts file paths, URLs, or data URIs — so you can chain another node's image output straight in.

## How to use it in Nebula

**Where the nodes appear.** Open the node palette on the canvas and look under the category that matches the media type: **text-gen** (Gemini), **image-gen** (Imagen 4, Nano Banana), **video-gen** (Veo 3.1), **audio-gen** (Lyria 3, Gemini TTS), and **utility** (Gemini Embeddings, Style Reference). Drag a node onto the canvas, type into its prompt/text field (or wire an input into its port), set the params in the node's panel, and run.

**API-key setup.** Every Google node reads one environment variable, `GOOGLE_API_KEY`. Create a key in [Google AI Studio](https://aistudio.google.com/apikey), then add it to your `.env` file at the repo root:

```
GOOGLE_API_KEY=your_key_here
```

Restart the backend so it picks up the new value. One key covers all eight nodes — Gemini, Imagen, Nano Banana, Veo, Lyria, TTS, and Embeddings.

**Example pipelines:**

1. **Illustrated short with a soundtrack.**
   `imagen-4-generate` (generate a hero still) → `veo-3` (drop that still into the **First Frame** input, prompt the motion) for an animated clip with sound. In parallel, `lyria-3` (prompt a matching mood) → mix the music under the video. One prompt idea per node, three nodes, a finished scene.

2. **Style-locked product shots.**
   `style-reference` (upload a reference photo, set Focus = "palette + lighting + medium", strength 0.7) → route its `Style` text and `Reference` image into `nano-banana`'s `prompt`/`images` inputs, then describe your product. Every render inherits the reference's look, and Nano Banana keeps the product consistent across angles.

3. **Narrated explainer.**
   `gemini-chat` (System Prompt: "You are a concise narrator"; `response_format` = Text) writes a script from a topic → feed its `text` output into `gemini-tts` (`voiceName` = Charon for an informative read) to get spoken narration. Pair with `imagen-4-generate` stills for slides.

4. **Searchable knowledge base.**
   `gemini-embeddings` (`taskType` = Retrieval Document, `outputDimensionality` = 768) turns each document into a vector you can store and later query — the backbone of a semantic-search or RAG pipeline.

## API coverage — what Nebula uses vs. what Google (Gemini / Imagen / Veo / Lyria) offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text generation (`generateContent` / streaming) | Yes | **full** | `gemini-chat` streams responses; model, temperature, max tokens, system prompt all wired |
| Thinking / reasoning control | Yes | **full** | `thinkingLevel` (Gemini 3) and `thinkingBudget` (2.5) both exposed |
| Structured / JSON output | Yes | **partial** | **JSON mode now wired** (2026-06-05) — `gemini-chat`'s `response_format` maps to `generationConfig.responseMimeType` (`application/json`). No `responseSchema` field, so a strict schema must still be prompt-engineered |
| Vision / image understanding (text models) | Yes | **partial** | `gemini-chat` accepts an `images` input; video/audio/PDF understanding not surfaced |
| Function calling / tools | Yes | **none** | No tool/function-calling param on the node |
| Grounding with Google Search | Yes | **none** | Not exposed on `gemini-chat` (nor image-search grounding on Nano Banana) |
| URL context tool | Yes | **none** | Not exposed |
| Code execution tool | Yes | **none** | Not exposed |
| Image gen — Imagen 4 (text-to-image) | Yes | **full** | `imagen-4-generate` covers all three variants + aspect ratio, count, seed, size, enhancePrompt, personGeneration. (Imagen edit/inpaint/customize/upscale are Vertex-only — not in this API.) |
| Image gen/edit — Gemini native (Nano Banana) | Yes | **partial** | `nano-banana` does text-to-image, editing, and multi-image composition; image-search grounding and explicit `thinkingLevel` control are not surfaced |
| Video — Veo (text/image-to-video, last frame) | Yes | **partial** | `veo-3` covers t2v, first frame, last frame, aspect/resolution/duration/seed. Missing: **reference images** (up to 3), **video extension** (up to ~148s), negative prompt (direct path) |
| Music — Lyria 3 (clip + full song) | Yes | **full** | `lyria-3` covers both models, image input, MP3/WAV. (No control over weighted-prompt steering, but that's a realtime-only feature.) |
| Music — Lyria RealTime (streaming/WebSocket) | Yes | **none** | Realtime music over the Live API is not exposed |
| Text-to-speech (single speaker) | Yes | **partial** | `gemini-tts` does single-speaker with 30 voices; **multi-speaker (2-voice)** dialogue and the 3.1 Flash TTS model are not surfaced |
| Embeddings (text + multimodal) | Yes | **partial** | `gemini-embeddings` covers task types + dimensionality; multimodal embedding (image/audio/video/PDF via Embedding 2) only reaches the API as text |
| Live API (realtime audio dialogue) | Yes | **none** | No realtime voice/agent node |
| Computer Use (UI automation) | Yes | **none** | Not exposed |
| File Search / managed RAG | Yes | **none** | Not exposed (Nebula builds RAG manually from raw embeddings) |
| Batch API | Yes | **none** | Each node makes synchronous (or single long-running) calls |
| Context caching | Yes | **none** | Not exposed |
| Token counting | Yes | **none** | Not exposed |
| Safety settings | Yes | **partial** | Only `personGeneration` (Imagen/Veo) is adjustable; no general `safetySettings` block |

Coverage: ~45% of the Google (Gemini / Imagen / Veo / Lyria) API surface is exposed in Nebula. (The eight core generative modalities — text, Imagen, Nano Banana, Veo, Lyria, TTS, embeddings, plus a style-extraction helper — are all wired and usable; the gaps are mostly advanced text-model tooling and operational/streaming endpoints rather than missing media types.)

Notable unused capabilities: Veo **reference images** and **video extension** (longer-than-8s clips); **multi-speaker TTS** for two-voice dialogue; **Lyria RealTime** streaming music; **Gemini tools** — Google Search grounding, URL context, function calling, and code execution on the text node; **multimodal embeddings** (image/audio/video/PDF) and **File Search** managed RAG; **batch API** and **context caching** for cost/throughput. Imagen editing/inpainting/upscaling is not a gap here — those capabilities live only in Vertex AI, not the Gemini Developer API that Nebula targets.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/gemini/SKILL.md` (the skill folder is named `gemini`; refreshed 2026-06-04). It covers all **8** Nebula nodes for Google's Gemini / Imagen / Veo / Lyria models. It gives an agent the real Nebula node IDs and their param keys, model-ID enums, wiring/chaining rules, and capability boundaries — alongside the preserved prompting/topic files (`nano-banana.md`, `veo.md`, `imagen.md`, `gemini-text.md`) for prompt craft.

What it covers:
- **All 8 nodes by Nebula ID** — `gemini-chat`, `imagen-4-generate`, `nano-banana`, `veo-3`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, and `style-reference` — with their param keys (the previously-missing TTS, Lyria, Embeddings, and Style Reference nodes are now documented, not just catalog entries).
- **Locked model IDs** — all 24 model IDs are pinned to the literal `-preview` enum strings the nodes actually ship (no blind suffix-stripping).
- **Prompting depth** — the preserved topic files cover Gemini text, Imagen, Nano Banana, and Veo prompt structure and model-picking, with Nebula hand-off notes.
- **Capability boundaries** — which advanced features Nebula does *not* surface (Veo references/extension, multi-speaker TTS, tools/grounding), so an agent doesn't promise capabilities the nodes can't deliver.

## Sources

- Gemini API overview — https://ai.google.dev/gemini-api/docs
- Image generation & editing (Nano Banana) — https://ai.google.dev/gemini-api/docs/image-generation
- Imagen — https://ai.google.dev/gemini-api/docs/imagen
- Video generation (Veo) — https://ai.google.dev/gemini-api/docs/video
- Speech generation (TTS) — https://ai.google.dev/gemini-api/docs/speech-generation
- Music generation (Lyria) — https://ai.google.dev/gemini-api/docs/music-generation
- Embeddings — https://ai.google.dev/gemini-api/docs/embeddings
- Model catalog — https://ai.google.dev/gemini-api/docs/models
