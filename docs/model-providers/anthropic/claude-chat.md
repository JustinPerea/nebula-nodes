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
| `model` | enum | yes | `claude-opus-5-5` | `model` | See model list below. Was `claude-sonnet-4-6` until 2026-10-16 |
| `max_tokens` | integer | yes | 64000 (Fable 5.1, the 5.5 generation incl. the default Opus 5.5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6); 4096 on Fable 5 and Haiku 4.5 (`defaultBy`). Opus 4.6-4.8 and Sonnet 4.6 were 4096 until 2026-10-16 | `max_tokens` | Required by Anthropic API (unlike OpenAI); always sent. Range 1–128000. When the key is missing (a node an agent made with only a model), the handler sends the model's default |
| `temperature` | float | no | 1 | `temperature` | 0–1; overridden to 1 when extended_thinking is enabled (budget thinking on Haiku 4.5, adaptive thinking on Opus 4.6 / Sonnet 4.6). Hidden and never sent for Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5 / Opus 4.8 / Opus 4.7 |
| `system` | textarea | no | — | `system` | Top-level field, not a messages role |
| `top_p` | float | no | — | `top_p` | Not forwarded if absent (FIXED). Hidden and never sent for the 5.5 generation, Fable 5.1, Fable 5, Opus 4.8 and Opus 4.7. Dropped while Extended Thinking is on (thinking forces `temperature: 1`) |
| `stop_sequences` | string | no | — | `stop_sequences` | Comma-separated → forwarded as string array (FIXED) |
| `extended_thinking` | boolean | no | false | `thinking.type` | When true, sends `{"type":"enabled","budget_tokens":N}` on Haiku 4.5 (FIXED). On Opus 4.6/4.7/4.8 and Sonnet 4.6 sends `{"type":"adaptive"}` with no budget (4.7/4.8 from 2026-10-16; 4.6 from Justin's answers the same day) |
| `thinkingBudget` | integer | no | 10000 | `thinking.budget_tokens` | Clamped to min 1024; only sent when extended_thinking=true (FIXED). Shown and sent on Haiku 4.5 only; hidden and never sent on Opus 4.6/4.7/4.8 and Sonnet 4.6 |
| `effort` | enum | no | `medium` | `output_config.effort` | `""` (model default) / low / medium / high / xhigh / max. Shown and sent only for Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 4.8, Opus 4.7 (2026-10-16), and Opus 4.6 / Sonnet 4.6 without `xhigh` (Justin's answers, 2026-10-16). Default was `""` before 2026-10-16 |

## Model Lineup (post-audit)

Canonical source: `https://platform.claude.com/docs/en/docs/about-claude/models/all-models`, verified 2026-05-16.

Menu as of 2026-10-16, newest first (Anthropic models overview and deprecations pages, fetched that day):

| Label | API ID | Notes |
|---|---|---|
| Claude Fable 5.1 (flagship) | `claude-fable-5-1` | Released 2026-09-01. 1M context, 128K sync output, default effort `high` |
| Claude Opus 5.5 | `claude-opus-5-5` | Node default (from 2026-10-16). Released 2026-09-22. 1M / 128K, default effort `medium` |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | Released 2026-09-28. 1M / 128K, default effort `high` |
| Claude Haiku 5.5 | `claude-haiku-5-5` | Released 2026-10-07. 1M / 128K, default effort `medium` |
| Claude Fable 5 | `claude-fable-5` | Superseded by Fable 5.1; retirement not sooner than 2027-06-09. No sampling params (2026-10-17) |
| Claude Opus 4.8 | `claude-opus-4-8` | Not sooner than 2027-05-28. Effort, adaptive thinking only (off by default) |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | Node default until 2026-10-16. Effort (no `xhigh`, API default `high`) plus an adaptive-thinking toggle; sampling kept |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | "Not sooner than October 15, 2026"; no deprecation announced yet |
| Claude Opus 4.7 (legacy) | `claude-opus-4-7` | Not sooner than 2027-04-16. Effort, adaptive thinking only (off by default) |
| Claude Opus 4.6 (legacy) | `claude-opus-4-6` | Not sooner than 2027-02-05. Effort (no `xhigh`, API default `high`) plus an adaptive-thinking toggle; sampling kept |

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
- defaults `max_tokens` to 64,000 for them (the definition's `default`; Fable 5
  and Haiku 4.5 are listed at 4,096 in `defaultBy`).
  Thinking counts toward `max_tokens`, and Anthropic's effort guide says that at
  `xhigh` or `max` effort, "start at 64k tokens and tune from there". Switching
  the model in the Inspector or a Create pill moves an untouched value to the
  new model's default and notes it under the field; an edited value stays;
- skips `thinking_delta` / `signature_delta` stream events (they carry no
  `delta.text`), so only the answer text reaches the output port.

### Call shape for Opus 4.7 and 4.8 (2026-10-16)

Anthropic's thinking pages (fetched 2026-10-16) say Claude 4.7 and later reject
`thinking.type: "enabled"` with `budget_tokens` (HTTP 400), and that Opus 4.7
and 4.8 reject non-default `temperature` / `top_p` / `top_k` on every request.
Their thinking is adaptive only and **off** by default; it turns on with
`thinking: {"type": "adaptive"}`. The effort page lists both models with all
five levels and an API default of `high`. The handler (`OPTIONAL_ADAPTIVE_MODELS`)
therefore:

- never sends `temperature`, `top_p` or a thinking budget for them;
- sends `thinking: {"type": "adaptive"}` when Extended Thinking is on;
- sends `output_config.effort` when Effort is set (new nodes start at `medium`);
- defaults `max_tokens` to 64,000 (Justin's answer, item 3, 2026-10-16; was
  4,096). The effort page: "When running Claude Opus 4.8 at `xhigh` or `max`
  effort, set a large `max_tokens` ... Starting at 64k tokens and tuning from
  there is a reasonable default." Both models' synchronous output cap is 128K.

### Call shape for Opus 4.6 and Sonnet 4.6 (Justin's answers, 2026-10-16)

Item 5 moved both to Effort. Anthropic's thinking page: "On Claude Opus 4.8,
Claude Opus 4.7, Claude Opus 4.6, and Claude Sonnet 4.6, thinking is off until
you set `thinking: {type: "adaptive"}`", and extended thinking "is deprecated on
the Claude 4.6 models (requests using it still succeed)". The effort page lists
both in `supportedModels`, with `max` but not `xhigh`, an API default of `high`,
and "Effort works with or without thinking". Unlike 4.7/4.8 they still accept
sampling params ("On older models, the restriction applies only while thinking
is on"). The handler (`SAMPLING_ADAPTIVE_MODELS`) therefore:

- sends `output_config.effort` when Effort is set (low / medium / high / max; a
  saved `xhigh` is refused before the request, and the card hides X-High);
- sends `thinking: {"type": "adaptive"}` when Extended Thinking is on, never a
  `budget_tokens` budget, and forces `temperature` to 1 then, as it did with
  budget thinking, and drops `top_p` (the handler never sends both, and while
  thinking is on "top_p is allowed at values between 0.95 and 1");
- otherwise sends `temperature` / `top_p` exactly as before;
- defaults `max_tokens` to 64,000 (was 4,096): thinking counts toward it, as on
  4.7/4.8. Saved nodes keep their stored value, except one: on Opus 4.6-4.8 and
  Sonnet 4.6 with Extended Thinking on, a stored 4,096 (main's only default)
  becomes 64,000 once, when the saved graph loads
  (`backend/services/saved_graph_upgrades.py`, 2026-10-17), so the card shows
  what runs. That covers projects (including their Create draft), the live
  graph, imported graph files, recovered copies of a stale tab (from the
  version the tab loaded at) and Create drafts kept in the browser
  (`frontend/src/lib/savedParamsUpgrades.ts`). Run records are not rewritten:
  each keeps the 4,096 it sent, and carries the version it was sent at
  (`paramsVersion`; none means before the upgrade). Replaying one, reusing its
  settings in Create, or checking a Paper run's freshness uses the recipe
  upgraded to 64,000; the replay's own record holds what it sent. A saved budget used to cap thinking inside that 4,096; adaptive
  thinking has no cap, and "thinking tokens count toward `max_tokens`, so a long
  thinking pass can consume the budget before the text response completes"
  (thinking-troubleshooting). The graph records that the upgrade ran, so a
  4,096 set after that is kept and sent as set. (From 2026-10-16 to 2026-10-17
  the handler sent a stored 4,096 as 64,000 while the card still showed 4,096.)

On every Claude model, a stream that ends with `stop_reason: "max_tokens"` (read
from the `message_delta` event) and no text fails the node ("Claude ran out of
Max Tokens (N) before it wrote an answer") instead of returning an empty
success. A cut-off answer that has some text is still returned.

Sources: `build-with-claude/thinking-troubleshooting.md` (per-model table),
`build-with-claude/thinking.md`, `build-with-claude/extended-thinking.md`,
`build-with-claude/effort.md`, `about-claude/models/overview.md` (footnote on
`budget_tokens`).

Haiku 4.5 sends exactly the request it sent before.

### Claude Fable 5 sampling (2026-10-17)

The thinking page's sampling section (fetched 2026-10-17) lists Claude Fable 5
among the models where "non-default `temperature`, `top_p`, or `top_k` values
return a 400 error on every request, regardless of whether thinking is used".
Justin approved hiding Temperature and Top P for it, so the card hides both
and the handler never sends them (`NO_SAMPLING_MODELS`). A saved Fable 5 node
holding a non-default temperature used to fail with a 400; it now runs at the
model's own default.

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

3. **`max_tokens` upper bound per model** — The registry caps `max_tokens` at 128,000
   (since 2026-10-16), the largest synchronous output of any listed model. Anthropic's
   model pages (checked 2026-10-16) list 128K for every listed model except Haiku 4.5
   (64K), so a value over 64,000 on Haiku 4.5 still gets an API error. The UI clamps
   only when you edit the field; a saved larger value is still sent as before.

4. **Saved-graph compatibility for deprecated models** — Graphs saved before the model
   lineup audit that selected `claude-opus-4-20250514` (deprecated, retiring 2026-06-15)
   will continue to execute without error until that date. After 2026-06-15 the Anthropic
   API will reject the model ID and the node will error on run. Users with saved graphs
   should re-open the node and switch to `claude-opus-4-7` before that date.
