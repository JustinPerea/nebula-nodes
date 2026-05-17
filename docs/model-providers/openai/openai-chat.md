---
id: nebula-openai-chat
kind: project-model-integration
project: nebula_nodes
provider: openai
model: openai-chat
status: active
verified: 2026-05-16
stale_after_days: 30
---

# OpenAI Chat (gpt-4o-chat) in Nebula Nodes

Nebula-specific integration notes for the `gpt-4o-chat` node, which targets the
OpenAI Chat Completions streaming endpoint (`POST /v1/chat/completions`).

## Sources

Verified against openai-python SDK type stubs fetched 2026-05-16:

- `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/completion_create_params.py`
- `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/shared/chat_model.py`

`https://platform.openai.com/docs/api-reference/chat/create` returned HTTP 403 —
SDK stubs used as canonical fallback (same pattern as prior OpenAI audio/image audits).

## Node Summary

| Field | Value |
|---|---|
| Node ID | `gpt-4o-chat` |
| Endpoint | `POST /v1/chat/completions` |
| Env key | `OPENAI_API_KEY` |
| Execution | `stream` (SSE, `[DONE]` sentinel) |
| Input ports | `messages` (Text, required), `images` (Image, optional, multiple) |
| Output port | `text` (Text) |

## Param Matrix (post-audit)

| Param key | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `model` | enum | yes | `gpt-4o` | `model` | See model list below |
| `max_completion_tokens` | integer | no | 4096 | `max_completion_tokens` | Replaces deprecated `max_tokens` |
| `temperature` | float | no | 1 | `temperature` | 0–2; not forwarded if absent |
| `top_p` | float | no | — | `top_p` | 0–1; not forwarded if absent |
| `frequency_penalty` | float | no | 0 | `frequency_penalty` | -2 to 2 |
| `presence_penalty` | float | no | 0 | `presence_penalty` | -2 to 2 |
| `response_format` | enum | no | `text` | `response_format.type` | `text` suppressed; `json_object` sent as `{type: json_object}` |

## Model Lineup (post-audit)

| Label | Value |
|---|---|
| GPT-4o | `gpt-4o` |
| GPT-4o Mini | `gpt-4o-mini` |
| GPT-4.1 | `gpt-4.1` |
| GPT-4.1 Mini | `gpt-4.1-mini` |
| GPT-4.1 Nano | `gpt-4.1-nano` |

Reasoning models (`o1`, `o3`, `o4-mini`, etc.) are intentionally excluded — they reject
`temperature`, `top_p`, and `stop` params that the registry exposes. If added in future,
the handler must guard those params.

## Findings

### `max_tokens` deprecated; handler used wrong field name (FIXED)

**Severity:** High. The OpenAI SDK type stubs explicitly mark `max_tokens` as
"now deprecated in favor of `max_completion_tokens`, and is not compatible with
o-series models." The handler was reading `node.params.get("max_tokens")` and
writing `request_body["max_tokens"]`. Both registries exposed the param under the key
`max_tokens`.

**Fix:** Renamed the param key to `max_completion_tokens` in both `node_definitions.json`
and `nodeDefinitions.ts`. Handler now reads `max_completion_tokens` and sends
`max_completion_tokens` in the request body. The display label ("Max Tokens") is unchanged
for UX continuity.

### `top_p`, `frequency_penalty`, `presence_penalty` in registry but never forwarded (FIXED)

**Severity:** High. All three params appeared in both registries (UI exposed them) but
the handler only forwarded `model`, `stream`, `max_tokens`, and `temperature`. Users
setting `top_p`, `frequency_penalty`, or `presence_penalty` in the UI got silent no-ops.

**Fix:** Handler now reads and forwards all three when present. `top_p` and penalties
are only included in the request body when the param is non-`None`, matching the
`temperature` pattern already in place.

### `response_format` in registry but never forwarded (FIXED)

**Severity:** High. The `response_format` param (options: `text`, `json_object`) was
in both registries but completely absent from the handler's request body construction.
Users selecting JSON mode got text output regardless.

**Fix:** Handler now forwards `response_format` as `{"type": response_format}` when the
value is not `"text"` (the API default). The `text` value is suppressed to avoid sending
a redundant field.

### Model list missing `gpt-4.1-mini` and `gpt-4.1-nano` (FIXED)

**Severity:** Medium. The SDK `ChatModel` union includes `gpt-4.1-mini` and `gpt-4.1-nano`
as current production models. The registry only had three options (`gpt-4o`, `gpt-4o-mini`,
`gpt-4.1`), omitting the two smaller/cheaper 4.1 variants.

**Fix:** Added `gpt-4.1-mini` and `gpt-4.1-nano` to the model enum in both registries.

## Check Summary

| Check | Result |
|---|---|
| Port id ↔ handler read match (`messages`, `images`) | PASS |
| Required ports marked required | PASS |
| All registered params forwarded by handler | FIXED (top_p, freq/presence penalty, response_format) |
| `max_tokens` replaced with `max_completion_tokens` | FIXED |
| Enum values match SDK stubs | FIXED (added gpt-4.1-mini, gpt-4.1-nano) |
| No deprecated legacy models in dropdown | PASS |
| No reasoning models without temperature guard | PASS (excluded) |
| Output port type correct (Text) | PASS |
| Missing API key error names `OPENAI_API_KEY` | PASS |
| Contract check (100 definitions) | PASS |
| Test suite (9 tests) | PASS |

## Open Questions

1. **System prompt** — The handler builds a single `user` message. There is no `system`
   param or port. For use-cases that require a system prompt (persona, instructions), users
   currently have no path. A `system` textarea param that prepends a system message is the
   natural fix; deferred until there is a UX request.

2. **Reasoning model support** — `o3`, `o4-mini`, and `gpt-5` family models are in the
   SDK `ChatModel` union. Adding them requires the handler to suppress `temperature`,
   `top_p`, and `stop` for those model IDs. Deferred until demand is confirmed.

3. **`max_completion_tokens` upper bound** — The registry caps at 128,000. The actual
   model context window varies (`gpt-4.1` has a 1M context window for input + output
   combined; max output tokens is 32,768 per SDK stubs). A per-model cap would be more
   accurate; currently the registry uses a conservative shared ceiling.

4. **Saved graph migration** — Users with `max_tokens` stored in saved graphs will
   silently lose token limiting on next load — no in-app migration or warning currently
   exists.
