---
id: nebula-claude-chat
kind: project-model-integration
project: nebula_nodes
provider: anthropic
model: claude-chat
status: active
verified: 2026-05-16
stale_after_days: 30
---

# Claude Chat in Nebula Nodes

Nebula-specific integration notes for the `claude-chat` node, which targets the
Anthropic Messages API streaming endpoint (`POST /v1/messages`).

## Sources

Verified against canonical Anthropic docs fetched 2026-05-16:

- `https://platform.claude.com/docs/en/api/messages` (Messages API reference)
- `https://platform.claude.com/docs/en/docs/about-claude/models/all-models` (model list)

Both URLs redirect from `docs.anthropic.com` with HTTP 301 to `platform.claude.com`.

## Node Summary

| Field | Value |
|---|---|
| Node ID | `claude-chat` |
| Endpoint | `POST /v1/messages` |
| Env key | `ANTHROPIC_API_KEY` |
| Execution | `stream` (SSE, `content_block_delta` events) |
| Input ports | `messages` (Text, required), `images` (Image, optional, multiple) |
| Output port | `text` (Text) |

## Param Matrix (post-audit)

| Param key | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `model` | enum | yes | `claude-sonnet-4-6` | `model` | See model list below |
| `max_tokens` | integer | yes | 4096 | `max_tokens` | Required by Anthropic API (unlike OpenAI); always sent |
| `temperature` | float | no | 1 | `temperature` | 0–1; overridden to 1 when extended_thinking is enabled |
| `system` | textarea | no | — | `system` | Top-level field, not a messages role |
| `top_p` | float | no | — | `top_p` | Not forwarded if absent (FIXED) |
| `stop_sequences` | string | no | — | `stop_sequences` | Comma-separated → forwarded as string array (FIXED) |
| `extended_thinking` | boolean | no | false | `thinking.type` | When true, sends `{"type":"enabled","budget_tokens":N}` (FIXED) |
| `thinkingBudget` | integer | no | 10000 | `thinking.budget_tokens` | Clamped to min 1024; only sent when extended_thinking=true (FIXED) |

## Model Lineup (post-audit)

Canonical source: `https://platform.claude.com/docs/en/docs/about-claude/models/all-models`, verified 2026-05-16.

| Label | API ID | Context | Max Output | Notes |
|---|---|---|---|---|
| Claude Opus 4.7 | `claude-opus-4-7` | 1M tokens | 128k tokens | Current flagship |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M tokens | 64k tokens | Default; speed + intelligence |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | 200k tokens | 64k tokens | Fastest |
| Claude Opus 4.6 (legacy) | `claude-opus-4-6` | 1M tokens | 128k tokens | Still available, not deprecated |

Models removed from lineup:

| Model | Reason |
|---|---|
| `claude-opus-4-20250514` | Deprecated; retires 2026-06-15. Replaced by `claude-opus-4-7` |
| `claude-haiku-3-5-20241022` | Claude 3.5 Haiku — superseded by `claude-haiku-4-5-20251001` |

## Findings

### `top_p` and `stop_sequences` in registry but never forwarded (FIXED)

**Severity:** High. Both params appeared in both registries (UI exposed them) but the
handler only forwarded `model`, `max_tokens`, `temperature`, and `system`. Users setting
`top_p` or `stop_sequences` in the UI got silent no-ops.

**Fix:** Handler now reads and forwards `top_p` when present. `stop_sequences` is parsed
from comma-separated string to `list[str]` before forwarding — matching the Anthropic API's
expected `array of string` type.

### `extended_thinking` + `thinkingBudget` in registry but never forwarded (FIXED)

**Severity:** High. The extended thinking toggle and budget were exposed in the UI but
the handler had no code to construct the `thinking` block. Users enabling extended thinking
got no thinking output.

**Fix:** When `extended_thinking` is truthy, the handler now sends:
```json
{ "thinking": { "type": "enabled", "budget_tokens": N } }
```
`budget_tokens` is clamped to `max(1024, thinkingBudget)` per the API constraint
(`budget_tokens` must be ≥ 1024). The handler also forces `temperature=1` when thinking
is enabled, as required by the Anthropic API.

### Stale model list — wrong and deprecated IDs (FIXED)

**Severity:** High. The registry listed three models:
- `claude-opus-4-20250514` — deprecated, retiring 2026-06-15
- `claude-sonnet-4-6` — correct
- `claude-haiku-3-5-20241022` — wrong generation (Claude 3.5 Haiku, not 4.x)

The current Claude 4.x generation (`claude-opus-4-7`, `claude-haiku-4-5-20251001`) was
entirely absent. `claude-opus-4-7` is the current flagship.

**Fix:** Updated model enum in both registries to the current lineup. Default remains
`claude-sonnet-4-6` (unchanged — still correct).

## Check Summary

| Check | Result |
|---|---|
| Port id ↔ handler read match (`messages`, `images`) | PASS |
| Output port id ↔ handler return key (`text`) | PASS |
| Required ports marked required | PASS |
| `max_tokens` always sent (Anthropic requires it) | PASS |
| `system` sent as top-level field, not messages role | PASS |
| `anthropic-version` header sent | PASS |
| `temperature` forwarded when set | PASS |
| `top_p` forwarded when set | FIXED |
| `stop_sequences` forwarded as list | FIXED |
| `extended_thinking` / `thinkingBudget` forwarded | FIXED |
| `thinking` forces `temperature=1` | FIXED |
| `budget_tokens` clamped to min 1024 | FIXED |
| Model list current (no deprecated IDs) | FIXED |
| Missing API key error names `ANTHROPIC_API_KEY` | PASS |
| SSE event filter `content_block_delta` correct | PASS |
| Output port type correct (Text) | PASS |
| Frontend ↔ backend registry sync | PASS |

## Open Questions

1. **Thinking + streaming interaction** — The Anthropic streaming API emits
   `content_block_delta` events for both text and thinking deltas. The current
   `event_type_filter="content_block_delta"` and `delta_path="delta.text"` will
   silently skip `thinking_delta` blocks (type is `thinking_delta`, not `text_delta`).
   Thinking content is not surfaced to the output. This is acceptable for now but means
   users cannot see the model's reasoning chain in the UI.

2. **`thinkingBudget` default** — The handler defaults to 10,000 tokens when
   `thinkingBudget` is unset. The registry param has no `default` field, so the UI
   shows a placeholder. Aligning the registry default with the handler default (10,000)
   would make behavior predictable.

3. **`max_tokens` upper bound per model** — The registry caps `max_tokens` at 200,000.
   Actual output limits vary: Opus 4.7 → 128k, Sonnet 4.6 → 64k, Haiku 4.5 → 64k.
   A user setting `max_tokens=200000` on Haiku will get an API error. Per-model caps
   would be more accurate; currently using a conservative shared ceiling.
