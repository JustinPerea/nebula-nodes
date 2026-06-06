---
name: openrouter
description: OpenRouter universal gateway in Nebula — one node (openrouter-universal) that reaches hundreds of models (GPT, Claude, Gemini, Llama, DeepSeek, FLUX, Recraft, and more) through OpenRouter's chat-completions API. Capabilities exposed in Nebula: streaming text/chat/reasoning/coding, vision (image-in → text-out), and image generation (text → image) — the model you pick decides which. Activate when the user configures the `openrouter-universal` node (display name "OpenRouter"), picks/searches an OpenRouter model in the Inspector, or asks about OpenRouter in Nebula. Sourced from the official OpenRouter docs (openrouter.ai/docs) and the Nebula audit guide docs/api-guides/openrouter.md on 2026-06-04 — every node id, port, param, header, and capability boundary here is cross-checked against backend/handlers/openrouter.py, backend/routes/openrouter_proxy.py, and backend/data/node_definitions.json.
---

# OpenRouter Skill

## When to use

- User drags or configures the **OpenRouter** node (`openrouter-universal`) onto the canvas.
- User picks or searches a model in the Inspector's OpenRouter model dropdown.
- User wants chat / writing / summarization / code / reasoning / Q&A from *any* text model (GPT, Claude, Gemini, Llama, DeepSeek, Mistral, Qwen…) without leaving Nebula.
- User wants to ask a question about an image (vision: image-in → text-out).
- User wants to generate an image from a prompt via an image-output model on OpenRouter (e.g. Gemini Flash Image, FLUX, Recraft).
- User asks about OpenRouter auth, the model list, or which model to pick for a job.

It's one node that *reconfigures itself* based on the chosen model. There is no separate "OpenRouter image" or "OpenRouter vision" node — same `openrouter-universal`, different model.

## Universal rules

1. **Auth — `OPENROUTER_API_KEY`.** Sent as `Authorization: Bearer <OPENROUTER_API_KEY>`. The key (from <https://openrouter.ai/keys>, format `sk-or-...`) goes in Nebula **Settings → OpenRouter** or `.env` as `OPENROUTER_API_KEY=sk-or-...`. It is required **both to run the node and to load the model dropdown** — until it's set, the model picker can't populate (the `/api/openrouter/models` proxy returns `400 OPENROUTER_API_KEY not configured`).
2. **Attribution headers (sent by the handler, do not re-add).** Every request also carries `HTTP-Referer: http://localhost:5173` and `X-OpenRouter-Title: Nebula Nodes`. ⚠️ Nebula uses `X-OpenRouter-Title`, **not** the legacy `X-Title` header that some OpenRouter docs show — the handler tests explicitly assert `X-Title` is *not* present. Don't tell the user to set `X-Title`.
3. **Base URL:** `https://openrouter.ai/api/v1/chat/completions` (chat-completions endpoint for *everything* — text, vision, and image generation all go through this one URL). Model list proxy: `GET /api/openrouter/models` (Nebula backend → OpenRouter `/api/v1/models`, cached 5 min).
4. **Execution pattern depends on output type (no async polling either way):**
   - **Text / vision → streaming (SSE).** `executionPattern: "stream"`. Sends `stream: true`; tokens stream into the `text` output via `delta_path = choices.0.delta.content`; the stream ends on `[DONE]`. Timeout 30s.
   - **Image output → single synchronous POST** (not streamed). When the picked model has `image` in its output modalities, the handler sends `modalities: ["text","image"]` and does one blocking request (120s timeout), then reads the picture from `choices[0].message.images[]`.
5. **Status / error codes.** `200` success. On the image path a non-200 raises `OpenRouter API error <code>: <body>`. Common: `400` bad request / no model / key not configured (model proxy), `401` bad or missing key, `402` insufficient credits, `429` rate-limited, `5xx` upstream/provider error. Surface the body — OpenRouter returns useful messages.
6. **Input-URI rules (vision `images` port).** The handler accepts, per image: an `http(s)://` URL (passed through as `image_url`), a `data:` URI (passed through), or a **local file path** (the handler base64-encodes it and builds a data URI; recognized suffixes `png`/`jpg`/`jpeg`/`webp`, anything else is sent as `image/png`). Upstream image-generation nodes wired into `images` resolve to local paths, so they "just work."
7. **Key gotchas.**
   - **`model` is required and drives everything.** No default model (default is `""`). If unset, the run fails with *"No model selected — choose a model from the Inspector panel."*
   - **Ports are dynamic, set when you pick the model — not configured by hand.** Picking a model with `image` *input* adds the `images` input port; picking one with `image` *output* adds the `image` output port and flips the internal `_output_image` flag. Changing the model **drops edges connected to ports that no longer exist.**
   - **`temperature` and `max_tokens` are text-only.** The image path never sends them; they're ignored for image generation. (The handler *does* still attach them to the request body if present, but image models disregard sampling params.)
   - **Vision needs both inputs.** `messages` (your question) is always required; `images` is the picture. A vision model with no `images` wired just behaves like a text model.
   - **JSON mode works (`response_format`=JSON, model-dependent); but no tools, no strict `json_schema`/grammar, no audio/PDF/video, no provider routing, no image_config, no web search.** See **Capability boundaries** — never promise these.

## Pick the right node

There is exactly one OpenRouter node. The model dropdown is what varies.

| Node (in app) | Node ID | Endpoint / model | Key params | Use it for |
|---|---|---|---|---|
| **OpenRouter** | `openrouter-universal` | `POST https://openrouter.ai/api/v1/chat/completions` — model chosen live from `/api/openrouter/models` (OpenRouter's full catalog) | `model` (required, string; from the live searchable list), `temperature` (float 0–2, default 1, text only), `max_tokens` (int 1–200000, default 4096, text only), `response_format` (Text / JSON, text only — JSON mode, model-dependent), `prompt_caching` (boolean, default off — opt-in `cache_control` for Anthropic-family models) | One node for the whole OpenRouter catalog. Text chat/reasoning/coding with any text model · vision Q&A (image-in → text-out) with a vision model · image generation (text → image) with an image-output model. The chosen model decides which. |

The model list is **live and per-account** (backend proxies OpenRouter's `/api/v1/models`, slimmed to `id` / `name` / `input_modalities` / `output_modalities` / `context_length` / `pricing`, cached 5 min). You are not limited to a hardcoded set — use the Inspector search box to filter. To do a given job, **pick a model whose modalities match it**: text-out for chat, `image` in `input_modalities` for vision, `image` in `output_modalities` to generate pictures.

## Param reference

### `openrouter-universal` — OpenRouter

| Param | Key | Type | Range / default | Applies to | Notes |
|---|---|---|---|---|---|
| Model | `model` | string | **required**, default `""` (placeholder "Loading models…") | all modes | The OpenRouter model id (e.g. `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `google/gemini-2.5-flash-image`). Chosen from the live list; selecting it reconfigures ports and sets `_output_image` automatically. |
| Temperature | `temperature` | float | 0 – 2, step 0.1, default **1** | **text/vision only** | Higher = more random. Lower (e.g. 0.2–0.4) = more focused/deterministic. Ignored by image generation. |
| Max Tokens | `max_tokens` | integer | 1 – 200000, default **4096** | **text/vision only** | Upper bound on generated tokens. Ignored by image generation. |
| Response Format | `response_format` | enum | Text / JSON, default **Text** | **text only** | **JSON mode** (added 2026-06-05). When set to JSON the handler forwards `response_format: {"type":"json_object"}`, so the reply is valid JSON. **Model-dependent** — the chosen model must support JSON output. Live-verified against the API. |
| Prompt Caching | `prompt_caching` | boolean | default **off** | text/vision | **Opt-in** prompt caching (added 2026-06-05). When on, the handler attaches `cache_control: {type: ephemeral}` to the last user content block. OpenRouter passes it through to **Anthropic-family models** (cache read ~90% cheaper on a re-run within ~5 min); **other providers ignore it**, and **OpenAI models cache automatically** so the toggle is a no-op for them. Off by default because a never-reused large prefix pays a small cache-write premium. |

**Internal / not user-set:** `_output_image` (boolean) — written by the frontend when you pick a model with `image` output; it routes the run to the image path. Don't expose or hand-edit it.

**Not exposed (the API supports them; the node does not send them):** `top_p`, `top_k`, `seed`, `stop`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `min_p`, `logit_bias`, `tools` / `tool_choice`, strict `json_schema` / grammar (basic `json_object` JSON mode *is* now exposed via `response_format` — see above), `reasoning` / `reasoning_effort`, `provider` routing, `image_config` (aspect ratio / size / style / strength), web-search plugins. (`cache_control` *is* now exposed via the opt-in `prompt_caching` toggle — see above.) See **Capability boundaries**.

## Recipes

### Recipe 1 — Ask a model a question (text / chat)
1. Add a **Text** input node with your prompt (e.g. "Explain quantum entanglement in one paragraph").
2. Add an **OpenRouter** node (`openrouter-universal`); in the Inspector pick a **text** model.
3. Wire the Text node → `messages`. Optionally lower `temperature` (e.g. 0.3) for a focused answer; raise `max_tokens` for longer output.
4. Run. The reply **streams** into the `text` output, which chains into any node that accepts Text.

### Recipe 2 — Describe / analyze an image (vision, image-in → text-out)
1. Add an **OpenRouter** node and pick a **vision** model (one that lists `image` in its input modalities). An **Images** input port appears.
2. Wire an image source — an upstream image-generation node's `image` output, or an image file — into `images`, and a Text node with your question ("What's in this photo?", "Read this receipt", "What's wrong with this UI?") into `messages`.
3. Run. The description **streams** out of `text`.

### Recipe 3 — Generate an image (text → image)
1. Add an **OpenRouter** node and pick an **image-output** model (e.g. a Gemini Flash Image, FLUX, or Recraft variant — one that lists `image` in its output modalities). An **Image** output port appears and the node switches to image mode.
2. Wire a Text node with your prompt ("a neon-lit crab on a beach at dusk, cinematic") into `messages`. (`temperature`/`max_tokens` don't apply here.)
3. Run. The handler does one POST, pulls the picture from `choices[0].message.images[]`, saves it as a PNG in the run directory, and emits it on `image` — ready to feed an upscaler, a video node, or a save node.

## In the nebula_nodes context

- **Node id:** `openrouter-universal` (display "OpenRouter", `category: universal`, `apiProvider: openrouter`). Lives in the **Universal** category of the palette alongside Replicate / Nous Portal.
- **Handler:** `backend/handlers/openrouter.py` → `handle_openrouter_universal`. Text path: `_handle_text_streaming` (uses `execution/stream_runner.py` `StreamConfig` / `stream_execute`). Image path: `_handle_image_generation`.
- **Model list proxy:** `backend/routes/openrouter_proxy.py` → `GET /api/openrouter/models` (5-min cache via `services/model_cache.py`). Frontend fetches it in `frontend/src/lib/api.ts`.
- **Dynamic-port wiring:** `frontend/src/store/graphStore.ts` → `configureOpenRouterModel(nodeId, modelId, model)`. It reads `input_modalities` / `output_modalities` and rebuilds ports; sets `params.model = modelId` and `params._output_image = output_modalities.includes('image')`.
- **Ports:**
  - **Input** — `messages` (Text, **required**) always present; `images` (Image, **multiple**, optional) added only for models with `image` input.
  - **Output** — `text` (Text) present for text-output models; `image` (Image) added for image-output models. The base node ships with just `messages` in / `text` out; the rest appear after a model is chosen.
- **Chaining rules:**
  - `text` output → any Text input (another OpenRouter node, a TTS node, a save/text node, an image-gen node's prompt, etc.).
  - `image` output → any Image input (upscaler, video/image-edit node, vision node's `images`, save node).
  - Into `images`: accepts http(s) URLs, data URIs, or local file paths (handler base64-encodes local files). Multiple images allowed.
  - **Switching models mid-graph drops edges on ports that disappear** — rewire after changing the model.
- **How outputs render:** `text` streams token-by-token into the node as it generates. `image` is saved as a PNG in the run directory (`save_base64_image`) and surfaced on the Image port; it renders in the canvas image preview like any other Image output.

### Capability boundaries — what OpenRouter's API can do that Nebula does NOT expose

Do not promise these through the node. They're real OpenRouter API features, just **not surfaced** in Nebula (≈30% of the API surface is wired: text chat, streaming, vision input, basic image gen, and the model list). If a user needs one, say it's an API feature not yet exposed in Nebula.

| Capability | API | Nebula | Note |
|---|---|---|---|
| Tool / function calling (`tools`, `tool_choice`, `parallel_tool_calls`) | Yes | **No** | The node never sends `tools`. No function calling. |
| Structured outputs — `json_object` JSON mode | Yes | **Yes** | Wired 2026-06-05, live-verified. `response_format`=JSON → `{"type":"json_object"}` for text models (model-dependent). |
| Structured outputs — strict `json_schema` / grammar | Yes | **No** | Can't request JSON-schema-constrained or grammar-constrained output; only `json_object` JSON mode. |
| Reasoning controls (`reasoning`, `reasoning_effort`) | Yes | **No** | No reasoning effort / summary controls. |
| Extra sampling params (`top_p`, `top_k`, `seed`, `stop`, penalties, `min_p`, `logit_bias`) | Yes | **No** | Only `temperature` + `max_tokens` are exposed. |
| Image-gen controls (`image_config`: aspect ratio / image_size / style / strength) | Yes | **No** | Image gen uses the model's defaults; no size/aspect/style knobs. |
| Audio **input** (`input_audio` parts) / Audio **output** (`modalities:["audio"]`) | Yes | **No** | Handler only builds `text` + `image_url` parts; no audio port. |
| PDF/document & video **input** (`file` / `video_url` parts) | Yes | **No** | Not wired. |
| Provider routing & fallbacks (`provider`, `models`, `route`) | Yes | **No** | Can't pin/exclude providers, set price/latency prefs, or define fallback chains. |
| Web Search server tool (`openrouter:web_search`, `:online`, plugins) | Yes | **No** | No web-grounded answers. |
| Prompt caching (`cache_control`) | Yes | **Yes (opt-in)** | The `prompt_caching` toggle (default off, added 2026-06-05) sets an ephemeral `cache_control` breakpoint on the last content block. Passed through to Anthropic-family models (~90%-cheaper cache reads on re-runs); other providers ignore it; OpenAI caches automatically. |
| Embeddings (`POST /api/v1/embeddings`) · legacy completions · generation-stats (`GET /api/v1/generation`) · credits/key endpoints | Yes | **No** | Separate endpoints; not wired. The model-list proxy also ignores `category` / `supported_parameters` filters. |

## Sources

- Nebula audit guide (node table, params, gap table, citations): `docs/api-guides/openrouter.md`
- OpenRouter Quickstart (auth, attribution headers): <https://openrouter.ai/docs/quickstart>
- API Reference overview (request schema, output modalities): <https://openrouter.ai/docs/api/reference/overview>
- Create a chat completion (full param & content-part list): <https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>
- List models & properties (modalities, model object fields): <https://openrouter.ai/docs/api/api-reference/models/get-models>
- Image generation (`modalities`, `image_config`, `message.images[]` shape): <https://openrouter.ai/docs/guides/overview/multimodal/image-generation>
- Tool calling: <https://openrouter.ai/docs/guides/features/tool-calling>
- Web Search server tool: <https://openrouter.ai/docs/guides/features/server-tools/web-search>
- Ground-truth in repo: `backend/handlers/openrouter.py`, `backend/routes/openrouter_proxy.py`, `backend/data/node_definitions.json`, `frontend/src/store/graphStore.ts` (`configureOpenRouterModel`).
