---
name: anthropic
description: Anthropic (Claude) Messages API in Nebula — a single text-gen node (Claude / claude-chat) that turns a text prompt plus optional image(s) into streamed text, with system prompt, temperature/top_p/stop sampling, and extended-thinking. Use for captioning, summarizing, translating, rewriting, reasoning, and drafting prompts to feed other media nodes. Activate when the user configures the `claude-chat` node, wires a Claude/Anthropic node into a graph, or asks about Anthropic/Claude in Nebula. Sourced from the official Anthropic Messages API (platform.claude.com/docs/en/api/messages) and the Nebula audit guide docs/api-guides/anthropic.md on 2026-06-04.
---

# Anthropic (Claude) Skill

## When to use

- User configures the **Claude** node (`claude-chat`) on the canvas, or asks how to set it up.
- User wants text out of a Nebula graph: write, rewrite, summarize, translate, brainstorm, answer a question, or draft a prompt for an image/video/audio/3D node.
- User wants **vision** — describe / caption / critique a generated image, or read text out of one — and turn that into written output.
- User wants **extended thinking** (let Claude reason before answering) on a planning step.
- User asks about Anthropic/Claude models, params, image formats, or limits *inside Nebula* (this skill is Nebula-driving, not general SDK code — for raw Anthropic SDK work use the global `claude-api` skill).

Claude in Nebula is text-only output. It does **not** generate images, video, audio, or 3D — it is the "brain" you wire between visual nodes to write, plan, and describe.

## Universal rules

1. **Auth — `x-api-key` header, env var `ANTHROPIC_API_KEY`.** The handler reads `api_keys["ANTHROPIC_API_KEY"]`; set `ANTHROPIC_API_KEY=sk-ant-...` in the backend `.env` and restart so it loads. Missing key raises `ValueError("ANTHROPIC_API_KEY is required")`. Note: Anthropic uses `x-api-key`, **not** `Authorization: Bearer`.
2. **Version header is mandatory and pinned.** Every request sends `anthropic-version: 2023-06-01` (hardcoded in `backend/handlers/anthropic_chat.py`). Plus `Content-Type: application/json`.
3. **Base URL is hardcoded in the handler, not the docs host.** Requests go to `https://api.anthropic.com/v1/messages` (`ANTHROPIC_API_URL` constant). The node's `apiEndpoint` field is the path `/v1/messages`. (Docs pages live at `platform.claude.com`, but the API host is `api.anthropic.com`.)
4. **Execution pattern = `stream` (SSE), never async-poll.** The handler sets `stream: true` and uses `stream_execute` (`backend/execution/stream_runner.py`). It opens one POST, reads server-sent events, accumulates `content_block_delta` deltas at JSON path `delta.text`, and returns the full string. There is no task id, no polling, no batch. Output streams token-by-token to the `text` port as it generates; `message_stop` or `[DONE]` ends the stream.
5. **Single user turn only.** The handler builds exactly one message: `[{"role": "user", "content": [...]}]`. The `messages` input is a plain **Text** string (not a chat array) — it becomes one `text` content block; any images become `image` content blocks appended to that same user turn. No assistant/prior-turn history is constructed.
6. **Status / errors.** On any non-200, `stream_execute` reads the response body and raises `RuntimeError("Stream request failed (<status>): <body>")`. Common Anthropic codes: `400` invalid request (bad param, e.g. thinking budget ≥ max_tokens), `401` bad/missing key, `403` permission, `429` rate limit / overloaded, `529` overloaded. No automatic retry. Connect timeout is `30.0s`; read timeout is disabled so long streams don't get cut.
7. **Image input — three URI forms, four formats.** The `images` port (Image, optional, multiple) accepts, per item:
   - **base64 data URL** (`data:image/png;base64,...`) — media_type parsed from the prefix.
   - **http(s) URL** — sent as `source.type = "url"` (Anthropic fetches it).
   - **local file path** — only if the file exists on the backend; read and base64-encoded. Suffix → media type via `{png, jpg, jpeg, webp}`; unknown suffixes fall back to `image/png`.
   Accepted formats: **PNG, JPG/JPEG, WebP**. (GIF is not in the handler's map.) A local path that doesn't exist is silently skipped — no error, no image.
8. **Key gotchas (read before tuning params):**
   - **`top_p` is dropped whenever `temperature` is set.** The handler only sends `top_p` if `temperature` is `None` (`if top_p is not None and "temperature" not in request_body`). But `temperature` **defaults to `1`** in the node, so in practice `temperature` is always present and **`top_p` is effectively ignored** unless you clear the Temperature field to empty/null. Tune one or the other — not both.
   - **Extended thinking forces `temperature=1`.** When `extended_thinking` is on (and the model supports it), the handler hard-sets `temperature = 1` (Anthropic API constraint) regardless of what you entered, and sends `thinking: {type: "enabled", budget_tokens: <budget>}`. Your Temperature value is overridden.
   - **Claude Fable/Mythos 5 take no extended-thinking param.** They use always-on adaptive thinking; the handler suppresses the `thinking` block for `claude-fable-*`/`claude-mythos-*` models even if the toggle is set, and the UI hides `extended_thinking`/`thinkingBudget` for them (`visibleWhen` excludes Fable). Only the pre-5 models accept a thinking budget. (2026-06-10)
   - **Thinking output is filtered out.** Only `delta.text` is accumulated; the thinking deltas (`delta.thinking`) are never captured, so the reasoning chain is **not** surfaced to the `text` port — only the final answer is. Thinking still costs tokens and improves the answer; you just don't see the scratchpad.
   - **Thinking budget must be < `max_tokens`.** `budget_tokens` is floored to `1024` by the handler, but Anthropic requires `budget_tokens < max_tokens`. If your budget ≥ max_tokens you'll get a `400`. Raise `max_tokens` above the budget.
   - **Hardcoded model list may drift.** The six model ids live in the node enum, not fetched from `GET /v1/models`. The legacy `claude-opus-4-7`/`claude-opus-4-6` (and any older model id saved in an old graph) can stop working after their deprecation dates.

## Pick the right node

Only one Anthropic node exists. Pick the **model**, not the node.

| Nebula node (id · display) | Endpoint / model | Inputs → output | Key params |
|---|---|---|---|
| `claude-chat` · **Claude** | `POST /v1/messages` (host `api.anthropic.com`), model picked from enum (default `claude-sonnet-4-6`) | `messages` (Text, required) + `images` (Image, optional, multiple) → `text` (Text, streamed) | `model`, `max_tokens` (required), `temperature`, `system`, `top_p`, `stop_sequences`, `extended_thinking` + `thinkingBudget`, `prompt_caching` |

**Model choice (enum values — use the `value`, not the label; refreshed 2026-06-10):**

| Label in app | Enum value | When to pick |
|---|---|---|
| Claude Fable 5 (flagship) | `claude-fable-5` | Flagship (GA 2026-06-09). Hardest reasoning; always-on adaptive thinking — the extended-thinking toggle doesn't apply. |
| Claude Opus 4.8 | `claude-opus-4-8` | Current Opus — heavy reasoning / planning / nuanced writing with a thinking budget. |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | **Default.** Fast + capable — good for almost everything. |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | Fastest / cheapest pass (bulk captions, simple rewrites). |
| Claude Opus 4.7 (legacy) | `claude-opus-4-7` | Only if a saved graph or a specific need pins it. |
| Claude Opus 4.6 (legacy) | `claude-opus-4-6` | Only if a saved graph or a specific need pins it; may be deprecated. |

## Param reference

All params live on the `claude-chat` node (`backend/data/node_definitions.json`). Types, ranges, and defaults below are ground-truth from the node def + how `anthropic_chat.py` maps them.

| Param key | Type | Required | Default | Range / enum | Maps to | Notes |
|---|---|---|---|---|---|---|
| `model` | enum | yes | `claude-sonnet-4-6` | the 6 values in the table above | top-level `model` | Use the enum `value`. |
| `max_tokens` | integer | yes | `4096` | `1`–`200000` | `max_tokens` | Max output tokens. Must exceed `thinkingBudget` when thinking is on. |
| `temperature` | float | no | `1` | `0`–`1`, step `0.1` | `temperature` (sent when non-null) | Default `1` means `top_p` is suppressed (see gotcha). Overridden to `1` by extended thinking. |
| `system` | textarea | no | `""` | free text | top-level `system` | Only sent if non-empty. Steers role/format ("Output only the prompt.", "Reply in JSON.", etc.). |
| `top_p` | float | no | (unset) | `0`–`1`, step `0.05` | `top_p` | **Only applied if `temperature` is cleared to null** — otherwise dropped. Don't set alongside temperature. |
| `stop_sequences` | string | no | (unset) | comma-separated list | `stop_sequences` (array) | Split on `,`, trimmed, empties dropped. e.g. `END,###` → `["END", "###"]`. |
| `extended_thinking` | boolean | no | `false` | true/false | `thinking.type = "enabled"` | Turns on the reasoning pass; forces `temperature=1`; reasoning is **not** surfaced (only final text). **Hidden on Fable/Mythos 5** (`visibleWhen` excludes them) — those models think adaptively always-on, and the handler suppresses the `thinking` block for them. |
| `thinkingBudget` | integer | no | `10000` | min `1024`, max `200000` | `thinking.budget_tokens` | Only visible/active when `extended_thinking` is on (`condition: extended_thinking`); also hidden on Fable/Mythos 5. Floored to 1024; keep **below** `max_tokens`. |
| `prompt_caching` | boolean | no | `false` | true/false | `cache_control: {type: ephemeral}` on `system` (sent as a content-block array) + the last user content block | **Opt-in** prompt caching. When on, a re-run within ~5 min reads the cached prefix at ~90% lower input cost. Off by default because a never-reused large prefix pays a small cache-**write** premium; Anthropic **ignores prefixes under ~1024 tokens**, so it's a safe no-op on short prompts. Turn on when the same long `system`/prompt is reused across runs. |

**What never reaches the request body:** `top_k`, `tools`/`tool_choice`, `output_config`/structured-output, `document` content blocks, multi-turn `messages` arrays, `metadata`, `service_tier`. (`cache_control` *is* now sent when `prompt_caching` is on — see that param.) See Capability boundaries.

## Recipes

All use the real node id `claude-chat`. The `text` output is plain Text and feeds any node accepting a Text input (prompt fields on image/video/audio/3D nodes, another `claude-chat`, etc.).

**1. Idea → polished image prompt → image.**
Text node ("a lighthouse in a storm, moody") → `claude-chat` (`system` = *"You are a prompt engineer. Expand the user's idea into one vivid, detailed image-generation prompt. Output only the prompt."*) → wire the `text` output into the prompt input of an image node (e.g. a `gpt-image-2-*` or `gemini` generate node). Claude writes the prompt; the image node renders it.

**2. Generated image → caption / alt-text.**
Any generator node's image output → `claude-chat` `images` port. Put *"Write a one-sentence caption and a short alt-text for this image."* into `messages`. Pick `claude-haiku-4-5-20251001` for cheap bulk captioning. The `text` output is ready-made copy.

**3. Hard planning step with extended thinking → fan-out.**
For *"plan a 5-shot product video and write a prompt for each shot"*: enable **Extended Thinking** on `claude-chat`, set `thinkingBudget` ~10000 and **raise `max_tokens` above it** (e.g. 16000 so budget < max_tokens). Claude reasons, then emits the final shot list to `text`. Feed each shot prompt into your video nodes. (Only the final answer streams out — the reasoning chain is filtered.)

## In the nebula_nodes context

- **Node id:** `claude-chat` · **display:** "Claude" · **category:** `text-gen` · **apiProvider:** `anthropic`.
- **Handler:** `backend/handlers/anthropic_chat.py` → `handle_claude_chat`. It builds the single-user-turn `content` array (text block + optional image blocks), maps params, then delegates streaming to `stream_execute` in `backend/execution/stream_runner.py` (`StreamConfig` with `event_type_filter="content_block_delta"`, `delta_path="delta.text"`, `timeout=30.0`).
- **Ports:**
  - Input `messages` — Text, **required**, single string → becomes one `text` content block. Empty/missing → `ValueError("Messages input is required for Claude chat")`.
  - Input `images` — Image, optional, **multiple** (`multiple: true`) → each becomes an `image` content block on the same user turn. data URL / http(s) URL / existing local path; PNG/JPG/JPEG/WebP.
  - Output `text` — Text → the accumulated streamed response.
- **Chaining rules:** the `text` output is plain text; connect it to any Text input (image/video/audio/3D prompt fields, or another `claude-chat`). To give Claude vision, route an upstream node's **image** output into `images` (it can take several). The node is single-turn, so to "chat back and forth" you chain multiple `claude-chat` nodes, each a fresh single turn — there is no conversation memory.
- **How outputs render:** the `text` deltas stream live (token-by-token) into the node's output as `StreamDeltaEvent`s; the final value is a Text payload `{"type": "Text", "value": <string>}`. No file is written to `/api/outputs/…` — it's text, surfaced in-node and passed downstream.

### Capability boundaries — what the Anthropic API can do that Nebula does NOT expose

Never promise these through the `claude-chat` node (from the audit gap table in `docs/api-guides/anthropic.md`; ~20% of the API surface is wired):

- **Multi-turn conversation history** — none. One user turn per run; no assistant/prior turns. Chain nodes for "conversation," but each call is stateless.
- **Tool use / function calling** — none. `tools` / `tool_choice` aren't exposed; Claude can't call your functions from the node.
- **Server tools** (web search, web fetch, code execution, tool search) — none wired.
- **Client tools** (bash, text editor) — none.
- **Structured / JSON output** — **NOT available.** Anthropic has no native `response_format`/JSON-mode param (unlike OpenAI `gpt-4o-chat`, Gemini `gemini-chat`, and OpenRouter `openrouter-universal`, which got JSON mode 2026-06-05). On Anthropic, reliable structured output requires **tool-use or prompt/prefill**, neither of which `claude-chat` exposes. If you need JSON, prompt for it in `system`/`messages` as plain text — no guarantee it's valid.
- **Prompt caching** (`cache_control`) — **now exposed** as the opt-in `prompt_caching` toggle (default off; added 2026-06-05). When on, the handler attaches `cache_control: {type: ephemeral}` to the `system` block (sent as a content-block array) and the last user content block, so a re-run within ~5 min reads the cached prefix at ~90% lower input cost. Anthropic ignores prefixes under ~1024 tokens, so it's a no-op (no write premium) on short prompts.
- **PDF / document input** (`document` content block) — not supported. Only `image` and `text` content. No PDFs.
- **`top_k` sampling** — not exposed (only `temperature`, `top_p`*, `stop_sequences`). *and `top_p` is itself suppressed unless temperature is cleared.
- **Extended-thinking reasoning chain** — requested but **filtered out** of the stream (only the final text is surfaced). `adaptive` thinking is not a settable mode — on Fable/Mythos 5 it's always on (and the extended-thinking param is suppressed for those models); pre-5 models only get the budgeted toggle.
- **Citations** — not surfaced.
- **MCP connector** — not wired.
- **Token Counting API** (`POST /v1/messages/count_tokens`) — not used; no pre-flight token estimate.
- **Message Batches API** (`POST /v1/messages/batches`, ~50% cheaper async) — not used.
- **Models API** (`GET /v1/models`) — not used; model list is the hardcoded enum (can drift; legacy ids can deprecate).
- **Files API** (beta), **Skills API** (beta), **Managed Agents** (Agents / Sessions / Environments, beta) — none wired; entirely outside Nebula's scope.

## Sources

- Anthropic Messages API reference — https://platform.claude.com/docs/en/api/messages
- Anthropic API overview — https://platform.claude.com/docs/en/api/overview
- Tool use overview — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Nebula audit guide — `docs/api-guides/anthropic.md`
- Nebula ground truth — `backend/data/node_definitions.json` (node `claude-chat`), `backend/handlers/anthropic_chat.py`, `backend/execution/stream_runner.py`

(Official Anthropic docs fetched 2026-06-04; all `docs.claude.com/en/...` URLs 301-redirect to `platform.claude.com/docs/en/...`. The API host remains `api.anthropic.com`.)
