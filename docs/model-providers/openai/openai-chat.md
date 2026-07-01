---
id: nebula-openai-chat
kind: project-model-integration
project: nebula_nodes
provider: openai
model: openai-chat
status: active
verified: 2026-06-30
stale_after_days: 30
---

# OpenAI Chat (gpt-4o-chat) in Nebula Nodes

Nebula-specific integration notes for the `gpt-4o-chat` node (display name **OpenAI Chat**),
which targets the OpenAI Chat Completions streaming endpoint (`POST /v1/chat/completions`).

## Sources

Verified against `node_definitions.json`, `backend/handlers/openai_chat.py`, and
`backend/tests/test_openai_chat_handler.py` on 2026-06-30.

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
| `reasoning_effort` | enum | no | `medium` | `reasoning_effort` | **gpt-5.x only** — `none`, `low`, `medium`, `high`, `xhigh` |
| `max_completion_tokens` | integer | no | 4096 | `max_completion_tokens` | 1–128000 |
| `temperature` | float | no | 1 | `temperature` | **Legacy gpt-4o/4.1 only** — omitted for gpt-5.x |
| `top_p` | float | no | — | `top_p` | Legacy only; omitted when unset |
| `frequency_penalty` | float | no | 0 | `frequency_penalty` | Legacy only |
| `presence_penalty` | float | no | 0 | `presence_penalty` | Legacy only |
| `response_format` | enum | no | `text` | `response_format.type` | `text` suppressed; `json_object` sent as `{type: json_object}` |

## Model Lineup

### GPT-5.x (default family)

| Label | Value | Notes |
|---|---|---|
| GPT-5.5 | `gpt-5.5` | Flagship |
| GPT-5.4 | `gpt-5.4` | Default |
| GPT-5.4 Mini | `gpt-5.4-mini` | |
| GPT-5.4 Nano | `gpt-5.4-nano` | |

Uses `reasoning_effort`. Handler **omits** `temperature`, `top_p`, `frequency_penalty`, and
`presence_penalty` for any model id starting with `gpt-5`.

### Legacy (gpt-4o / gpt-4.1)

| Label | Value | Notes |
|---|---|---|
| GPT-4o | `gpt-4o` | |
| GPT-4o Mini | `gpt-4o-mini` | |
| GPT-4.1 | `gpt-4.1` | |
| GPT-4.1 Mini | `gpt-4.1-mini` | |
| GPT-4.1 Nano | `gpt-4.1-nano` | Sunsets 2026-10-23 per registry label |

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
| `reasoning_effort` forwarded for gpt-5.x only | PASS |
| Sampler params gated to legacy models | PASS |
| `max_completion_tokens` (not deprecated `max_tokens`) | PASS |
| `response_format` json_object forwarded | PASS |
| Missing API key error names `OPENAI_API_KEY` | PASS |

## Open Questions

1. **System prompt** — no `system` param/port; deferred until UX request.
2. **Per-model `max_completion_tokens` cap** — registry uses shared 128k ceiling.
3. **Responses API** — Nebula uses Chat Completions, not `/v1/responses`.
