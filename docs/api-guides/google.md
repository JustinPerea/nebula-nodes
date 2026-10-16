# Google (Gemini / Imagen / Veo / Lyria) in Nebula Nodes

> Google's models let a Nebula user generate and edit images, produce video with sound, write and reason over text, make music and spoken audio, and turn text or media into search-ready embeddings — all from nodes you drag onto the canvas.

## What you can make

**Images**
- Text-to-image from a written prompt (Nano Banana; Nano Banana 2.1 replaces the retired Imagen 4).
- Edit / combine images — feed reference pictures in and describe the change (Nano Banana: blend up to ~14 references for character and product consistency).
- High-resolution renders up to 4K (Nano Banana), in aspect ratios from square to ultra-wide panoramas.
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

## Nodes available in Nebula (7) (updated 2026-10-10)

All seven nodes authenticate with the same `GOOGLE_API_KEY` and call Google's `generativelanguage.googleapis.com` endpoints directly. Veo 3.1 can also run on **Vertex AI** (now branded Gemini Enterprise Agent Platform; same `aiplatform.googleapis.com` endpoints) with a service-account key, and on fal (see the notes below). The Gemini Omni Flash video node (`gemini-omni-flash`, model `gemini-omni-1.1-flash`) is documented in [the Google contracts](../contracts/03-handler-families/google.md).

**Imagen 4 is retired.** Google shut Imagen 4 down on 2026-08-17 and names Nano Banana 2.1 as the replacement, so the `imagen-4-generate` node is gone. Saved graphs open with a `nano-banana` node set to Nano Banana 2.1 (aspect ratio and 1K/2K size carried over), titled "Nano Banana (was Imagen 4)" unless you renamed it.

**Your Google key also runs the fal and Krea copies of Nano Banana** (since 2026-10-14): `nano-banana-fal`, `nano-banana-fal-edit` and the four `krea-image-google-nano-banana*` nodes call the Gemini API with `GOOGLE_API_KEY` when it is saved, billed by Google at the [Gemini API image prices](https://ai.google.dev/gemini-api/docs/pricing). A Krea node set to the Krea plan stays on Krea. Without a Google key they run on fal or Krea as before. fal's `seed` and `output_format` don't apply on Google; web search and high thinking work but have no list price there (Google bills grounding per search query), so the run estimate shows them unpriced. The Google price is a range that includes up to 14 reference images at Google's input rate ($0.0011 each on Pro). Nano Banana (2.5) runs leave Google on 2027-03-15, the earliest shutdown in Google's [deprecations table](https://ai.google.dev/gemini-api/docs/deprecations), and take the fal or Krea copy from then on. A Krea copy with an explicit width/height stays on Krea.

**More copies on your Google keys** (2026-10-14, `backend/execution/maker_routes_google.py`), same rule (Krea plan first, then your Google key, then the copy's own key):

- `identity-edit` runs on `gemini-3.1-flash-image` (the model fal's `nano-banana-2/edit` runs) with `GOOGLE_API_KEY`. Character bundles and the mask refusal work the same on both routes. A bundle or node seed reaches fal only (the Gemini API documents no image seed). Google price: $0.067 (1024) / $0.101 (2048) per image plus up to 14 input images; thinking medium/high is unpriced there.
- `krea-image-google-nano-banana-2-1` runs on `gemini-nano-banana-2.1` (Interactions API) with `GOOGLE_API_KEY`, and `thinking_level` (minimal / medium / high) reaches Google as `generation_config.thinking_level`. Google lists $0.0336 / $0.0504 / $0.113 per 1K / 2K / 4K image, a little more than Krea's $0.03 / $0.0505 / $0.0755, and thinking tokens bill on top ($7.50 per 1M), so the estimate is open-ended.
- `krea-video-google-veo-3-1`, `-fast` and `-lite` run on Vertex AI (`veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, `veo-3.1-lite-generate-001`) with `GOOGLE_VERTEX_CREDENTIALS` only. A Gemini API key doesn't move them, because Google shuts the Gemini API previews down on 2026-10-22. `generate_audio` maps to `generateAudio` (Lite always sends false, matching Krea's Lite price). Start/end images map to `image`/`lastFrame`. Up to 3 reference images go as `referenceImages` (asset), and only at 8 seconds, not at 4K, and not with frames: Nebula refuses those combinations before any request. Fast at 4K stays on Krea, since Vertex lists Fast at 720p and 1080p. Vertex price per second: Standard $0.40 with audio / $0.20 video only ($0.60 / $0.40 at 4K), Fast $0.10 / $0.08 (720p) and $0.12 / $0.10 (1080p), Lite $0.03 / $0.05 video only. These match Krea's own prices.
- `krea-video-google-gemini-omni-flash-1-1` runs on `gemini-omni-1.1-flash` with `GOOGLE_API_KEY`. `duration` goes to `response_format.duration` as `"8s"`. A start image runs as `image_to_video`; reference images and up to 3 reference videos run as `reference_to_video`. A start image together with references is refused, because Google tells them apart only by tags written into the prompt. Price: about $0.101 per second (5,792 tokens per second of 720p video at $17.50 per 1M), plus input media and thinking tokens, which Google doesn't publish counts for.

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Gemini | `gemini-chat` | text-gen | `messages` (text), `images` | `model` (Gemini 4 Argon / 3.8 Flash / 3.6 Flash default / 3.5 Flash-Lite / 3.5 Flash deprecated / 3.1 Pro / 3 Flash / 3.1 Flash-Lite retiring 2027-05-07 / 2.5 Pro / 2.5 Flash / 2.5 Flash-Lite), `max_tokens` (8192; 65536 on Argon, Google's default, since Argon spends more of it on thinking; cleared sends none), `temperature` (hidden and not sent for Argon, 3.8 Flash, 3.6 Flash, 3.5 Flash-Lite), `system`, `thinkingLevel` (no `minimal` on Argon or 3.8 Flash), `thinkingBudget`, `top_p` + `top_k` (sent as `topP`/`topK`; hidden and not sent on the same four models as `temperature`), `stop_sequences` (up to 5, sent as `stopSequences`), `response_format` (text / JSON) | Chat, reasoning, summarization, JSON extraction, describing/analyzing images |
| Nano Banana | `nano-banana` | image-gen | `prompt`, `images` | `model` (Nano Banana 2.1 / Nano Banana 2 default / Nano Banana 2 Lite / Nano Banana Pro / Nano Banana 2.5 Flash), `aspect_ratio` (1:1 … 21:9, plus 1:4/4:1/1:8/8:1 on Nano Banana 2.1 and 2), `imageSize` (512 / 1K / 2K / 4K; 2.1 has 1K/2K/4K) | Text-to-image, image editing, multi-image composition, character/product consistency, legible in-image text |
| Veo 3.1 | `veo-3` | video-gen | `prompt`, `image` (First Frame), `last_frame` (Last Frame), `video` (Extend Video) | `model` (Veo 3.1 / 3.1 Fast / 3.1 Lite), `aspectRatio` (16:9, 9:16), `duration` (4/6/8s), `resolution` (720p / 1080p / 4K on Standard and Fast; on Vertex only Standard renders 4K), `personGeneration`, `seed` | Cinematic clips with sound, image-to-video, first→last frame interpolation, extension |
| Lyria 3 | `lyria-3` | audio-gen | `prompt`, `images` | `model` (Lyria 3 Clip 30s / Lyria 3 Pro full song), `outputFormat` (MP3 / WAV) | Background music, songs with lyrics, mood-from-image scoring |
| Gemini TTS | `gemini-tts` | audio-gen | `text` | `model` (3.8 Flash TTS default / 3.8 Flash-Lite TTS; 3.1 Flash TTS preview, 2.5 Flash TTS and 2.5 Pro TTS shut down 2026-11-17 and saved nodes move to 3.8), `voiceName` (30 voices: Kore, Puck, Zephyr, Charon, …) | Voiceover, narration, spoken-word from a script |
| Gemini Embeddings | `gemini-embeddings` | utility | `text` | `model` (Embedding 001 / Embedding 2 multimodal), `taskType` (Semantic Similarity, Retrieval Query/Document, Classification, Clustering, Code Retrieval, Question Answering, Fact Verification), `outputDimensionality` (768 / 1536 / 3072) | Semantic search, RAG, clustering, similarity scoring |
| Style Reference | `style-reference` | utility | _(none — uploads a file)_ | `filePath` (reference image), `mode` (Auto via Gemini / Manual / Image only), `focus` (all / palette / lighting / medium), `strength` (0–1) | Turn one image into a reusable style description + reference to feed image generators |

Notes that matter when wiring these up:
- **Style Reference takes no input port** — you upload the image directly in the node's `filePath` field. It outputs both a `Reference` image and a `Style` text description you route into a generator's prompt.
- **Veo is asynchronous** — it submits a long-running job and polls until the clip is ready, so expect it to take longer than image nodes. Google deletes generated videos after ~2 days; Nebula downloads them to your run folder automatically on completion.
- **Nano Banana 2.1** (`gemini-nano-banana-2.1`) runs on the Gemini Interactions API (`POST /v1beta/interactions`). Wired image URLs are passed to Google as `{"type":"image","uri"}`; Nebula doesn't download them. The default model stays Nano Banana 2 (`gemini-3.1-flash-image`).
- **Veo 3.1 routes, in order** (checked 2026-10-14). Veo 3.0, 3.0 Fast and 2.0 shut down on 2026-06-30; saved nodes on them move to the matching 3.1 model (a 5 s duration becomes 6 s). The node stores the Vertex model ids (`veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, `veo-3.1-lite-generate-001`); saved Gemini API preview ids load as the matching one.
  1. **Vertex AI**, when `GOOGLE_VERTEX_CREDENTIALS` is set (a Google Cloud service-account JSON key, pasted in Settings → "Google Vertex AI (service-account JSON, for Veo)"). Runs in `us-central1` on the key's project with the GA models `veo-3.1-generate-001` / `veo-3.1-fast-generate-001` (Google retires these "Nov 17 2026 or later") and the preview `veo-3.1-lite-generate-001` (Google's model card is contradictory about frames for Lite; Nebula sends them and Google decides). Only Veo 3.1 (Standard) renders 4K here; 4K with Fast or Lite is refused. Express-mode API keys don't support Veo. Audio is always generated. Extension works on all three models, keeps the chosen resolution, and takes any MP4 (1–30 s, 24 fps, 720p/1080p/4K, 16:9 or 9:16), not only Veo clips: wire any node's Video output (a saved file), a public https MP4 URL (up to 100 MB) or a `gs://` URI. Gemini API `files/` URIs are rejected. Frames that aren't JPEG or PNG are converted to PNG.
  2. **Gemini API**, with `GOOGLE_API_KEY`, until **2026-10-22**, when Google shuts down the Veo 3.1 previews this route uses (it has no GA Veo). Extension here needs Veo's own `files/` URI, works on 3.1 and 3.1 Fast only, and outputs 720p. From 2026-10-22 a run with only `GOOGLE_API_KEY` fails before calling Google and asks for a Vertex key.
  3. **fal**, with `FAL_KEY`: `fal-ai/veo3.1` and `fal-ai/veo3.1/fast` (plus `/image-to-video` or `/first-last-frame-to-video` when frames are wired). Lite runs as Fast, extension isn't available, and only this route has `negative_prompt` and `safety_tolerance`.

  After 2026-10-22, a failed fal Veo run suggests adding a Vertex key (whether fal's Veo 3.1 keeps working after that date is unverified). (Google's deprecations page names `gemini-omni-1.1-flash` as the Gemini API replacement for the Veo 3.1 previews.) **Veo 3.1 First-Last Frame** (`veo-3-flf`) also uses Vertex when the key is set, else fal.
- The `images` input on Gemini, Nano Banana, and Lyria accepts file paths, URLs, or data URIs — so you can chain another node's image output straight in.

## How to use it in Nebula

**Where the nodes appear.** Open the node palette on the canvas and look under the category that matches the media type: **text-gen** (Gemini), **image-gen** (Nano Banana), **video-gen** (Veo 3.1), **audio-gen** (Lyria 3, Gemini TTS), and **utility** (Gemini Embeddings, Style Reference). Drag a node onto the canvas, type into its prompt/text field (or wire an input into its port), set the params in the node's panel, and run.

**API-key setup.** Create a key in [Google AI Studio](https://aistudio.google.com/apikey). Open Nebula **Settings** → **Providers**, choose **Add key** on the **Google · Gemini API** row (`GOOGLE_API_KEY`), paste it and choose **Save key**. Saving checks the key without generating anything. Nebula stores it under `apiKeys.GOOGLE_API_KEY` in the project-root `settings.json`; no restart is required. One key covers all seven nodes — Gemini, Nano Banana, Veo, Lyria, TTS, Embeddings, and Style Reference. For Veo after 2026-10-22, also add a Vertex AI service-account key: create a service account with the **Gemini Enterprise Agent Platform User** role (`roles/aiplatform.user`, formerly "Vertex AI User") in a Google Cloud project with the Vertex AI API enabled, download its JSON key, and paste the whole JSON into **Settings → Google Vertex AI (service-account JSON, for Veo)**. The provider check only confirms the JSON is well-formed; the first Veo run is the real test.

**Example pipelines:**

1. **Illustrated short with a soundtrack.**
   `nano-banana` (`model` = Nano Banana 2.1, generate a hero still) → `veo-3` (drop that still into the **First Frame** input, prompt the motion) for an animated clip with sound. In parallel, `lyria-3` (prompt a matching mood) → mix the music under the video. One prompt idea per node, three nodes, a finished scene.

2. **Style-locked product shots.**
   `style-reference` (upload a reference photo, set Focus = "palette + lighting + medium", strength 0.7) → route its `Style` text and `Reference` image into `nano-banana`'s `prompt`/`images` inputs, then describe your product. Every render inherits the reference's look, and Nano Banana keeps the product consistent across angles.

3. **Narrated explainer.**
   `gemini-chat` (System Prompt: "You are a concise narrator"; `response_format` = Text) writes a script from a topic → feed its `text` output into `gemini-tts` (`voiceName` = Charon for an informative read) to get spoken narration. Pair with `nano-banana` stills for slides.

4. **Searchable knowledge base.**
   `gemini-embeddings` (`taskType` = Retrieval Document, `outputDimensionality` = 768) turns each document into a vector you can store and later query — the backbone of a semantic-search or RAG pipeline.

## API coverage — what Nebula uses vs. what Google (Gemini / Imagen / Veo / Lyria) offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text generation (`generateContent` / streaming) | Yes | **full** | `gemini-chat` streams responses; model, temperature, max tokens, system prompt, Top P, Top K and stop sequences all wired (the last three since 2026-10-16) |
| Thinking / reasoning control | Yes | **full** | `thinkingLevel` (Gemini 3) and `thinkingBudget` (2.5) both exposed |
| Structured / JSON output | Yes | **partial** | **JSON mode now wired** (2026-06-05) — `gemini-chat`'s `response_format` maps to `generationConfig.responseMimeType` (`application/json`). No `responseSchema` field, so a strict schema must still be prompt-engineered |
| Vision / image understanding (text models) | Yes | **partial** | `gemini-chat` accepts an `images` input; video/audio/PDF understanding not surfaced |
| Function calling / tools | Yes | **none** | No tool/function-calling param on the node |
| Grounding with Google Search | Yes | **none** | Not exposed on `gemini-chat` (nor image-search grounding on Nano Banana) |
| URL context tool | Yes | **none** | Not exposed |
| Code execution tool | Yes | **none** | Not exposed |
| Image gen — Imagen 4 (text-to-image) | Retired 2026-08-17 | **n/a** | Google shut Imagen 4 down; use `nano-banana` with Nano Banana 2.1 (saved `imagen-4-generate` nodes migrate automatically) |
| Image gen/edit — Gemini native (Nano Banana) | Yes | **partial** | `nano-banana` does text-to-image, editing, and multi-image composition (incl. Nano Banana 2.1 via the Interactions API); image-search grounding and explicit `thinkingLevel` control are not surfaced |
| Video — Veo (text/image-to-video, last frame) | Yes | **partial** | `veo-3` covers t2v, first frame, last frame, extension (`source_uri` → `Extend Video`), aspect/resolution/duration/seed, on Vertex AI or the Gemini API. Missing: **reference images** (up to 3), negative prompt (Google routes) |
| Music — Lyria 3 (clip + full song) | Yes | **full** | `lyria-3` covers both models, image input, MP3/WAV. (No control over weighted-prompt steering, but that's a realtime-only feature.) |
| Music — Lyria RealTime (streaming/WebSocket) | Yes | **none** | Realtime music over the Live API is not exposed |
| Text-to-speech (single speaker) | Yes | **partial** | `gemini-tts` does single-speaker with 30 voices (3.8 Flash and Flash-Lite added 2026-10-14; the 3.1/2.5 previews shut down 2026-11-17); **multi-speaker (2-voice)** dialogue is not surfaced |
| Embeddings (text + multimodal) | Yes | **partial** | `gemini-embeddings` covers task types + dimensionality; multimodal embedding (image/audio/video/PDF via Embedding 2) only reaches the API as text |
| Live API (realtime audio dialogue) | Yes | **none** | No realtime voice/agent node |
| Computer Use (UI automation) | Yes | **none** | Not exposed |
| File Search / managed RAG | Yes | **none** | Not exposed (Nebula builds RAG manually from raw embeddings) |
| Batch API | Yes | **none** | Each node makes synchronous (or single long-running) calls |
| Context caching | Yes | **none** | Not exposed |
| Token counting | Yes | **none** | Not exposed |
| Safety settings | Yes | **partial** | Only `personGeneration` (Veo) is adjustable; no general `safetySettings` block |

Coverage: ~45% of the Google (Gemini / Imagen / Veo / Lyria) API surface is exposed in Nebula. (The core generative modalities — text, Nano Banana, Veo, Lyria, TTS, embeddings, plus a style-extraction helper — are all wired and usable; the gaps are mostly advanced text-model tooling and operational/streaming endpoints rather than missing media types.)

Notable unused capabilities: Veo **reference images**; **multi-speaker TTS** for two-voice dialogue; **Lyria RealTime** streaming music; **Gemini tools** — Google Search grounding, URL context, function calling, and code execution on the text node; **multimodal embeddings** (image/audio/video/PDF) and **File Search** managed RAG; **batch API** and **context caching** for cost/throughput.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/gemini/SKILL.md` (the skill folder is named `gemini`; refreshed 2026-06-04). It covers the **7** Nebula Google nodes (the Imagen 4 node was removed 2026-10-10). It gives an agent the real Nebula node IDs and their param keys, model-ID enums, wiring/chaining rules, and capability boundaries — alongside the preserved prompting/topic files (`nano-banana.md`, `veo.md`, `gemini-text.md`; `imagen.md` is now a retirement note) for prompt craft.

What it covers:
- **All 7 nodes by Nebula ID** — `gemini-chat`, `nano-banana`, `veo-3`, `lyria-3`, `gemini-tts`, `gemini-embeddings`, and `style-reference` — with their param keys (the previously-missing TTS, Lyria, Embeddings, and Style Reference nodes are now documented, not just catalog entries).
- **Locked model IDs** — all 26 model IDs are pinned to the literal enum strings the nodes actually ship (preview ids keep their `-preview` suffix, stable ids like `gemini-3.5-flash` / `gemini-3.1-flash-lite` don't carry one — no blind suffix-stripping either way; refreshed 2026-06-10).
- **Prompting depth** — the preserved topic files cover Gemini text, Nano Banana, and Veo prompt structure and model-picking, with Nebula hand-off notes.
- **Capability boundaries** — which advanced features Nebula does *not* surface (Veo references, multi-speaker TTS, tools/grounding), so an agent doesn't promise capabilities the nodes can't deliver.

## Sources

- Gemini API overview — https://ai.google.dev/gemini-api/docs
- Image generation & editing (Nano Banana) — https://ai.google.dev/gemini-api/docs/image-generation
- Veo on Vertex AI — https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation
- Pricing — https://ai.google.dev/gemini-api/docs/pricing
- Video generation (Veo) — https://ai.google.dev/gemini-api/docs/video
- Speech generation (TTS) — https://ai.google.dev/gemini-api/docs/speech-generation
- Music generation (Lyria) — https://ai.google.dev/gemini-api/docs/music-generation
- Embeddings — https://ai.google.dev/gemini-api/docs/embeddings
- Model catalog — https://ai.google.dev/gemini-api/docs/models
