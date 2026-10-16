---
id: nebula-openai-chat
kind: project-model-integration
project: nebula_nodes
provider: openai
model: openai-chat
status: active
verified: 2026-10-16
stale_after_days: 30
---

# OpenAI Chat (gpt-4o-chat) in Nebula Nodes

Nebula-specific integration notes for the `gpt-4o-chat` node (display name **OpenAI Chat**),
which targets the OpenAI Chat Completions streaming endpoint (`POST /v1/chat/completions`).

## Sources

Verified against `node_definitions.json`, `backend/handlers/openai_chat.py`, and
`backend/tests/test_openai_chat_handler.py` on 2026-06-30.

The 2026-10-16 GPT-6 refresh was checked against OpenAI's own pages, fetched that day:
`https://developers.openai.com/api/docs/models.md`, the per-model pages under
`https://developers.openai.com/api/docs/models/<id>.md`,
`https://developers.openai.com/api/docs/guides/latest-model.md` ("Using GPT-6"),
`https://developers.openai.com/api/docs/guides/reasoning.md` and
`https://developers.openai.com/api/docs/deprecations.md`.

## Node Summary

| Field | Value |
|---|---|
| Node ID | `gpt-4o-chat` |
| Display name | OpenAI Chat |
| Endpoint | `POST /v1/chat/completions` |
| Env key | `OPENAI_API_KEY` |
| Execution | `stream` (SSE, `[DONE]` sentinel) |
| Input ports | `messages` (Text, required), `images` (Image, optional, multiple) |
| Output port | `text` (Text) |

## Param Matrix

| Param key | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `model` | enum | yes | `gpt-5.4` | `model` | See model list below |
| `reasoning_effort` | enum | no | `medium` | `reasoning_effort` | **GPT-6 and gpt-5.x only** — `none`, `low`, `medium`, `high`, `xhigh`, plus `max` on GPT-6. `none` is hidden for GPT-6 Astra and GPT-6.1 Sol (HTTP 400) |
| `max_completion_tokens` | integer | no | 4096 | `max_completion_tokens` | 1–128000 |
| `temperature` | float | no | 1 | `temperature` | **Legacy gpt-4o/4.1 only** — omitted for GPT-6 and gpt-5.x |
| `top_p` | float | no | — | `top_p` | Legacy only; omitted when unset |
| `frequency_penalty` | float | no | 0 | `frequency_penalty` | Legacy only |
| `presence_penalty` | float | no | 0 | `presence_penalty` | Legacy only |
| `response_format` | enum | no | `text` | `response_format.type` | `text` suppressed; `json_object` sent as `{type: json_object}` |

## Model Lineup

### GPT-6 (added 2026-10-16)

| Label | Value | Notes |
|---|---|---|
| GPT-6 Astra (flagship) | `gpt-6-astra` | Effort low…max; **no `none`** (400) |
| GPT-6.1 Sol | `gpt-6.1-sol` | Effort low…max, default medium; **no `none` / `minimal`** |
| GPT-6 Luna | `gpt-6-luna` | Effort none…max, default medium |

All three: 1,050,000 context, 128,000 max output, Chat Completions supported
(tool calling needs the Responses API, which Nebula doesn't use). The handler
(`GPT6_MODELS` in `handlers/openai_chat.py`) sends `reasoning_effort` and never
sends sampler params. A saved effort the model rejects (for example `none` on
Astra after switching from GPT-5.4) is refused before the request with a
message naming the allowed levels; the Inspector marks it "(unavailable for
selected model)".

### GPT-5.x

| Label | Value | Notes |
|---|---|---|
| GPT-5.5 | `gpt-5.5` | |
| GPT-5.4 | `gpt-5.4` | Default |
| GPT-5.4 Mini | `gpt-5.4-mini` | |
| GPT-5.4 Nano (retiring 2027-04-01) | `gpt-5.4-nano` | Deprecated 2026-10-01, shutdown 2027-04-01; replacement `gpt-6-luna` |

Uses `reasoning_effort`. Handler **omits** `temperature`, `top_p`, `frequency_penalty`, and
`presence_penalty` for any model id starting with `gpt-5`.

### Legacy (gpt-4o / gpt-4.1)

| Label | Value | Notes |
|---|---|---|
| GPT-4o | `gpt-4o` | Shutdown 2027-01-14 (announced 2026-10-14); replacement `gpt-6-luna` |
| GPT-4o Mini | `gpt-4o-mini` | Shutdown 2027-01-14 |
| GPT-4.1 | `gpt-4.1` | Shutdown 2027-01-14 |
| GPT-4.1 Mini | `gpt-4.1-mini` | Shutdown 2027-01-14 |
| GPT-4.1 Nano | `gpt-4.1-nano` | Shutdown 2026-10-23 |

Retiring models stay on the menu with the date in the label, so saved graphs still open.

Legacy models use sampler params (`temperature`, `top_p`, penalties) and **do not** send
`reasoning_effort`.

## Handler behavior

- Builds a **single user message** from `messages` text plus optional `images` vision parts.
- Images: `http(s)://` and `data:` URLs pass through; local paths are base64-encoded.
- No system prompt port/param — persona must be inlined in `messages` today.
- No tools / function calling.

## Excluded models

`o1`, `o3`, `o4-mini`, and other o-series reasoning endpoints are **not** in the registry.
GPT-5.x covers the reasoning use case with `reasoning_effort` instead.

## Check Summary (2026-06-30)

| Check | Result |
|---|---|
| Port id ↔ handler read match (`messages`, `images`) | PASS |
| gpt-5.x models in registry + handler guard | PASS |
| GPT-6 models gated as reasoning models (2026-10-16) | PASS |
| `reasoning_effort` forwarded for gpt-5.x only | PASS |
| Sampler params gated to legacy models | PASS |
| `max_completion_tokens` (not deprecated `max_tokens`) | PASS |
| `response_format` json_object forwarded | PASS |
| Missing API key error names `OPENAI_API_KEY` | PASS |

## Open Questions

1. **System prompt** — no `system` param/port; deferred until UX request.
2. **Per-model `max_completion_tokens` cap** — registry uses shared 128k ceiling.
3. **Responses API** — Nebula uses Chat Completions, not `/v1/responses`.
