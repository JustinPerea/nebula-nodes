---
id: nebula-claude-chat
kind: project-model-integration
project: nebula_nodes
provider: anthropic
model: claude-chat
status: active
verified: 2026-10-16
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

The 2026-10-16 model refresh (Fable 5.1 and the 5.5 generation) was checked
against these Anthropic pages, fetched that day:

- `https://platform.claude.com/docs/en/about-claude/models/overview.md`
- `https://platform.claude.com/docs/en/about-claude/model-deprecations.md`
- `https://platform.claude.com/docs/en/build-with-claude/effort.md`
- `https://platform.claude.com/docs/en/models/opus-5-5/migration-guide.md`
- `https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1.md`
- `https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5.md`
- `https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide.md`

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
| `temperature` | float | no | 1 | `temperature` | 0–1; overridden to 1 when extended_thinking is enabled. Hidden and never sent for Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 |
| `system` | textarea | no | — | `system` | Top-level field, not a messages role |
| `top_p` | float | no | — | `top_p` | Not forwarded if absent (FIXED). Hidden and never sent for the 5.5 generation and Fable 5.1 |
| `stop_sequences` | string | no | — | `stop_sequences` | Comma-separated → forwarded as string array (FIXED) |
| `extended_thinking` | boolean | no | false | `thinking.type` | When true, sends `{"type":"enabled","budget_tokens":N}` (FIXED) |
| `thinkingBudget` | integer | no | 10000 | `thinking.budget_tokens` | Clamped to min 1024; only sent when extended_thinking=true (FIXED) |
| `effort` | enum | no | `""` (model default) | `output_config.effort` | low / medium / high / xhigh / max. Shown and sent only for Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 (2026-10-16) |

## Model Lineup (post-audit)

Canonical source: `https://platform.claude.com/docs/en/docs/about-claude/models/all-models`, verified 2026-05-16.

Menu as of 2026-10-16, newest first (Anthropic models overview and deprecations pages, fetched that day):

| Label | API ID | Notes |
|---|---|---|
| Claude Fable 5.1 (flagship) | `claude-fable-5-1` | Released 2026-09-01. 1M context, 128K sync output, default effort `high` |
| Claude Opus 5.5 | `claude-opus-5-5` | Released 2026-09-22. 1M / 128K, default effort `medium` |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | Released 2026-09-28. 1M / 128K, default effort `high` |
| Claude Haiku 5.5 | `claude-haiku-5-5` | Released 2026-10-07. 1M / 128K, default effort `medium` |
| Claude Fable 5 | `claude-fable-5` | Superseded by Fable 5.1; retirement not sooner than 2027-06-09 |
| Claude Opus 4.8 | `claude-opus-4-8` | Not sooner than 2027-05-28 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | Node default |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | "Not sooner than October 15, 2026"; no deprecation announced yet |
| Claude Opus 4.7 (legacy) | `claude-opus-4-7` | Not sooner than 2027-04-16 |
| Claude Opus 4.6 (legacy) | `claude-opus-4-6` | Not sooner than 2027-02-05 |

### Call shape for Fable 5.1 and the 5.5 generation (2026-10-16)

The four new models always think. Anthropic's model pages say they return HTTP 400
for `thinking: {type: "enabled", budget_tokens}` and for non-default
`temperature` / `top_p` / `top_k`, and take an effort level as top-level
`output_config: {"effort": ...}`. The handler (`ADAPTIVE_EFFORT_MODELS` in
`handlers/anthropic_chat.py`) therefore:

- never sends `temperature`, `top_p` or `thinking` for them, even when a node
  switched from an older model still holds those values;
- sends `output_config.effort` only when the Effort param is set;
- caps `max_tokens` at 128,000, the synchronous output limit;
- skips `thinking_delta` / `signature_delta` stream events (they carry no
  `delta.text`), so only the answer text reaches the output port.

Every other model sends exactly the request it sent before.

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

2. **`thinkingBudget` default** — Resolved: both registries now carry `"default": 10000`,
   matching the handler fallback. UI will show 10,000 as the pre-filled value.

3. **`max_tokens` upper bound per model** — The registry caps `max_tokens` at 200,000.
   Actual output limits vary: Opus 4.7 → 128k, Sonnet 4.6 → 64k, Haiku 4.5 → 64k.
   A user setting `max_tokens=200000` on Haiku will get an API error. Per-model caps
   would be more accurate; currently using a conservative shared ceiling.

4. **Saved-graph compatibility for deprecated models** — Graphs saved before the model
   lineup audit that selected `claude-opus-4-20250514` (deprecated, retiring 2026-06-15)
   will continue to execute without error until that date. After 2026-06-15 the Anthropic
   API will reject the model ID and the node will error on run. Users with saved graphs
   should re-open the node and switch to `claude-opus-4-7` before that date.
