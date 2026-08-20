# Provider and agent live acceptance — 2026-08-19

Status: **live provider/agent sweep complete; final cancellation repair and
release gates in progress**

Approved envelope: **$1.00 USD**, **6 Meshy credits**, **40 Quiver
credits**, two short read/mutation turns per agent, and at most one short
cancellation turn per agent. OpenAI and the four unconfigured providers remain
excluded. No credential, plan, or credit-purchase changes are authorized.

This document combines the preflight contract with the approved live execution
record. It contains verdicts and sanitized artifact metadata, but no API key,
token, credential prefix, private account identifier, generated asset bytes, or
full agent prompt.

## Candidate and zero-cost evidence

- Candidate: `71901584a45a5c932ade6592c35bf019d59dce97`
- Snapshot: 2026-08-19 13:28 EDT
- Catalog: 172 built-in nodes; 137 provider-backed nodes across 16 external
  provider families, plus 35 local/utility nodes.
- Credential health: 10 Settings credentials valid, OpenAI configured but
  rejected with HTTP 401, and xAI, MiniMax, Krea, and Higgsfield not configured.
  Nous Portal OAuth is separately valid.
- Live dynamic catalogs: OpenRouter returned 415 models including
  `openrouter/free`; Nous returned 369 models; Quiver returned three Arrow
  models with live operation-level credit prices.
- Agent shells: Claude CLI is installed and signed in via a Claude.ai Max
  subscription; Codex CLI is installed and signed in via ChatGPT; the
  Hermes/Daedalus executable is installed and its required Nous OAuth is valid.
- Preflight safety boundary: health and catalog reads were authenticated but
  non-billable. Generation and agent turns began only after the explicit first-
  wave approval recorded below.
- Deterministic preflight: the complete backend suite passes at **1,576 tests**
  across all 16 provider handlers, health/key validation, streaming parsers,
  async polling, provider cancellation adapters, retry classification, graph
  cancellation, manifests/cache/output persistence, and the Claude/Codex/
  Daedalus bridges. The complete frontend suite passes at **461 tests**, with
  lint and the production build/budget gate also green. These tests use
  fixtures/mocks and do not count as live-provider acceptance.

The Settings header reports **11/15 API Keys** because it counts non-empty
credentials, not health-valid credentials. The acceptance record therefore
uses the provider-health endpoint as the source of truth: 10 valid, one invalid,
four absent. Nous is OAuth-backed and is not one of those 15 Settings fields.

## Provider matrix

Costs are minimum single-call estimates for the exact representative path.
Prices can change; each row links the current first-party pricing surface used
for the estimate. A successful smoke proves only the named node/path, not every
model or operation available from that provider.

| Provider | Built-in nodes | Current auth state | Cheapest representative request | Pattern and output | Minimum usage | Paid-phase acceptance |
|---|---:|---|---|---|---:|---|
| Anthropic | 1 | Valid | `claude-chat`, Haiku 4.5, short deterministic reply | SSE stream -> Text | `<$0.001` ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) | Observe multiple deltas, final text, completed history, reload persistence |
| ElevenLabs | 6 | Valid | `elevenlabs-tts`, Flash v2.5, very short line, MP3 | Sync -> Audio file | about `$0.001` for ~20 characters ([pricing](https://elevenlabs.io/pricing/api)) | Play output, inspect file, reload, rerun from history |
| FAL | 77 | Valid | `flux-schnell`, one 1 MP image | Queue-backed request -> Image file | `$0.003` ([model pricing](https://fal.ai/models/fal-ai/flux/schnell)) | Image render/download, manifest redaction, persistence, immediate Stop race |
| Google | 9 | Valid | `gemini-chat`, Gemini 3.1 Flash Lite, short reply | SSE stream -> Text | `<$0.001` or free-tier usage ([pricing](https://ai.google.dev/gemini-api/docs/pricing)) | Streaming deltas, final text, history and reload persistence |
| Higgsfield | 1 | Not configured | `higgsfield`, DoP Preview, 1 second | Async poll -> Video file | Account/model price not public in the current docs | Requires key plus explicit per-call ceiling; exercise upstream cancellation |
| Ideogram | 7 direct + 7 FAL-routed | Valid | `ideogram-transparent`, Turbo, 1 image, 1x upscale | Sync -> Image file | `$0.04` ([API pricing](https://ideogram.ai/api-pricing/)) | Final response, output download/render, history, and persistence |
| Krea | 3 | Not configured | `krea-2-generate`, Medium, 1K, no references | Async poll -> Image file | `$0.03` ([Krea 2 API pricing](https://www.krea.ai/blog/krea-2-api-launch)) | Poll progress, image + job metadata, persistence, upstream cancellation |
| Meshy | 8 direct + 2 FAL-routed | Valid | `meshy-text-to-image`, Nano Banana, single view | Async poll -> Image file | `3 Meshy credits` ([pricing](https://docs.meshy.ai/en/api/pricing)) | Poll progress, image file, persistence, immediate Stop/upstream cancellation |
| MiniMax | 3 | Not configured | `minimax-t2v`, Hailuo 2.3, 6 s, 768P | Async poll -> Video file | `$0.28` ([pricing](https://platform.minimax.io/docs/guides/pricing-paygo)) | Video output and persistence; Stop is expected to be local-only because no provider cancel API is documented |
| Nous Portal | 1 | Valid OAuth | `nous-portal-universal`, `inclusionai/ling-2.6-flash`, short reply | SSE stream -> Text | `<$0.001` from live catalog price | Streaming, final text, history, persistence; also supplies Daedalus auth precondition |
| OpenAI | 8 | **Invalid: HTTP 401** | `gpt-4o-chat`, GPT-5.4 nano, short reply | SSE stream -> Text | `<$0.001` after credential repair ([pricing](https://developers.openai.com/api/docs/models/gpt-5.4-nano)) | First preserve truthful auth failure; after key repair prove streaming and successful retry |
| OpenRouter | 1 | Valid | `openrouter-universal`, `openrouter/free`, short reply | SSE stream -> Text | `$0` ([free router](https://openrouter.ai/docs/guides/routing/routers/free-router)) | Live model selection, streaming, completion, history and persistence |
| QuiverAI | 2 | Valid | `quiver-arrow-generate`, Arrow 1.1, one SVG | SSE stream -> SVG file | `20 Quiver credits` from live `/v1/models` catalog | Streamed SVG, safe local persistence, preview, reload, 429 retry covered separately |
| Replicate | 1 | Valid | `replicate-universal`, `black-forest-labs/flux-schnell`, one image | Async poll -> Image file | `$0.003` ([model pricing](https://replicate.com/black-forest-labs/flux-schnell/api/api-reference)) | Schema load, submit/poll/download, persistence, provider-side cancel |
| Runway | 8 | Valid | `runway-tts`, <=50 characters, Maya voice | Async poll -> Audio file | `$0.01` ([pricing](https://docs.dev.runwayml.com/guides/pricing/)) | Poll progress, playable output, persistence, DELETE cancellation path |
| xAI | 1 | Not configured | `grok-imagine-video`, 1 s, 480p | Async poll -> Video file | `$0.05` ([model pricing](https://docs.x.ai/developers/models/grok-imagine-video)) | Submit/poll/download and persistence; Stop is local-only because no provider cancel endpoint is documented |

## Cancellation capability ledger

Canvas Stop always cancels Nebula's frontend request and registered backend
execution task. Whether it also stops provider work depends on the exact path;
the live phase must not generalize one provider's result to another.

| Provider/path | Upstream behavior on Stop | Deterministic contract |
|---|---|---|
| FAL queue nodes | `PUT` the submit response's cancel URL (or derived queue cancel URL) | Covered for universal and multi-output handlers |
| Replicate predictions | `POST /v1/predictions/{id}/cancel` | Covered for polling and streaming predictions |
| Runway tasks | `DELETE /v1/tasks/{id}` | Covered by the shared async-poll runner |
| Meshy task nodes | `DELETE` the exact task URL | Covered for all direct Meshy task paths, including single-image-to-3D |
| Krea jobs | `DELETE /jobs/{id}` | Covered for generation and style training |
| Higgsfield jobs | `POST` the submit response's `cancel_url` when present | Covered both with and without a returned cancel URL |
| ElevenLabs dubbing | `DELETE /v1/dubbing/{id}` | Covered; the other five ElevenLabs calls are ordinary request/response operations |
| Google Gemini Omni background interactions | `POST /interactions/{id}/cancel` | Covered after the interaction id is known |
| Google Veo long-running operations | Best-effort `POST {operation}:cancel`; current service support is not guaranteed | Covered as an attempted detached request, not proof that billing stops |
| MiniMax video | Local task/request cancellation only; no provider cancel endpoint documented | Covered as local-only |
| xAI video | Local task/request cancellation only; no provider cancel endpoint documented | Covered as local-only |
| Ideogram custom-model training | Local polling cancellation only; current training reference documents start/status but no cancel endpoint | Local-only classification; do not start training for a smoke test |
| Anthropic, OpenAI, OpenRouter, Nous, Quiver streams | Close/cancel the in-flight HTTP stream; no separate job id exists in these handlers | Stream/task cancellation coverage; no provider cancel endpoint claim |
| Synchronous image/audio helpers | Cancel the in-flight HTTP request before a result is persisted | Request cancellation only; a server may already have accepted work |

## Agent matrix

Agent turns consume subscription or inference quota even when they do not have
an immediate per-call dollar charge, so they are part of the approval gate.
Every mutation will run against an isolated disposable graph and the original
8-node / 5-edge graph will be restored and reloaded afterward.

| Agent path | Current state | First turn | Mutation turn | Acceptance |
|---|---|---|---|---|
| Claude | Installed, signed in via Claude.ai Max | Read-only graph inventory | Add one named local Text node, then report its handle | Streaming UI, tool/action event, persisted graph, cancellation, cleanup |
| Codex | Installed, signed in via ChatGPT | Read-only graph inventory | Add one named local Text node, then report its handle | Streaming UI, tool/action event, persisted graph, cancellation, cleanup |
| Daedalus | Executable present; Nous OAuth valid | Read-only graph inventory using the cheapest live Nous text model | Add one named local Text node, then report its handle | Streaming UI, tool/action event, persisted graph, cancellation, cleanup |

Approved agent allowance: **up to two short turns per agent** (six
turns total), with an additional cancellation turn only if cancellation cannot
be exercised during one of those six.

## Defects found during zero-cost preflight

The following reproducible issues were repaired before live spend. Each has a
deterministic regression and is included in the full green backend suite:

1. `flux-schnell` and `fast-sdxl` claimed synchronous execution despite using
   FAL submit/poll; both now declare `async-poll`.
2. `ideogram-transparent` and `ideogram-edit-prompt` claimed async polling even
   though the direct API returns the final response synchronously; both now
   declare `sync`.
3. Meshy single-image-to-3D bypassed the shared cancel-aware poller, and Meshy
   `CANCELED` was not terminal. Both lifecycle gaps are fixed.
4. Gemini Omni background interactions stopped locally without invoking
   Google's documented interaction-cancel endpoint. Stop now schedules it.
5. ElevenLabs dubbing stopped its local poll but left the provider project
   running. Stop now schedules the documented project DELETE.
6. FAL and Replicate media could be emitted and cached as expiring provider CDN
   URLs. Provider-backed Image, Video, Audio, Mesh, and SVG outputs are now
   downloaded and validated in the bound run directory before success, cache,
   or manifest publication. Intentional API handles remain remote.

## Cross-cutting adversarial sequence

1. Save/export the original graph and record node/edge counts.
2. Run the cheapest successful provider request in an isolated graph.
3. For stream nodes, prove at least one intermediate delta before completion.
4. For file outputs, verify non-empty bytes, expected media type, in-app render
   or playback, manifest redaction, history linkage, and survival after reload.
5. Exercise Canvas Stop on representative async families with provider cancel
   support (FAL, Replicate, Runway, Meshy/Krea when available), plus
   ElevenLabs dubbing and Gemini Omni if their normal success probes are run. Confirm the
   frontend state, backend task, provider cancellation request, run history,
   and absence of a late success artifact agree. Record local-only cancellation
   honestly for providers without a remote cancel endpoint.
6. Produce a controlled failed run, confirm its retryability classification and
   the **Retry failed** history action, then rerun the same snapshot. OpenAI's
   existing 401 is a no-cost non-retryable case; Quiver's single automatic 429
   retry remains deterministically covered by its mocked client test unless a
   real 429 occurs naturally. Do not manufacture provider abuse or quota load.
7. Run each agent's read-only and isolated mutation turn; verify tool events,
   graph persistence, cancellation, and cleanup.
8. Restore and reload the original graph. Capture screenshots throughout.
9. Fix every reproducible defect, rerun the affected scenario, then run the
   complete release gates, scan the staged diff for secrets, push `main`, and
   confirm the resulting GitHub Actions run is green.

## Live isolation record

- Original backend graph: 8 nodes / 5 edges.
- Raw state fingerprint: `b23e8b5ffd4f1dd60c26412fe9bf69a0156faa517c284afebfc3447112a456ad`.
- UI-restorable bundle: `nebula-first-wave-original-2026-08-19.nebula.zip`
  (1,584 bytes; contains `graph.json` and an empty `assets/` directory).
- The first clear was stopped at Nebula's destructive confirmation until the
  UI-restorable bundle existed.
- Live calls run on a backend whose `NEBULA_STATE_DIR` and
  `NEBULA_OUTPUT_ROOT` point to a disposable evidence root, plus a separate
  `127.0.0.1:5174` origin. The normal state file was restored byte-for-byte
  before the isolated backend started, so the original IDs, history linkage,
  and output root are not used by live probes.
- Local UI smoke: complete; Run History recorded a one-node full-graph run in
  0.0 seconds before any provider call.
- Final restoration: the normal backend reloaded 8 nodes / 5 edges from the
  original state, the SHA-256 remained byte-identical, and the normal UI showed
  8 nodes ([screenshots 52-53](evidence/provider-agent-live-acceptance-2026-08-19/README.md)).

## Live execution results

All calls below were made through the actual Nebula UI against the disposable
state/output roots. A provider-side rejection is recorded as a truthful failed
acceptance result, not converted into a success by changing credentials,
billing, or plans.

| Provider | Live verdict | Evidence and durable-output check |
|---|---|---|
| OpenRouter | **Passed** | `openrouter/free` returned the requested 12-line deterministic text and survived graph reload. The run completed before the numbered screenshot set began. |
| Google | **Passed** | `gemini-3.1-flash-lite` returned the same exact 12-line text and persisted. The run completed before the numbered screenshot set began. |
| Nous Portal | **Passed after repair** | The first run exposed an expired preferred Hermes key shadowing a usable fallback. Expiry-aware/profile-pool selection, JWT checks, host pinning, and credential-bound caches were added; `poolside/laguna-s-2.1:free` then streamed the exact text and survived reload ([screenshots 04-09](evidence/provider-agent-live-acceptance-2026-08-19/README.md)). |
| Anthropic | **Provider-blocked** | Request reached Anthropic and returned HTTP 400 because the account credit balance was too low. No credential change or purchase was attempted ([screenshots 10-12](evidence/provider-agent-live-acceptance-2026-08-19/README.md)). |
| ElevenLabs | **Passed after repair** | TTS produced valid 22.05 kHz mono MP3s (5,451 and 4,929 bytes). The first absolute custom-root event URL rendered only after reload; canonicalizing outputs before broadcast fixed immediate controls/playback, then reload persistence passed ([screenshots 13-15 and 30-31](evidence/provider-agent-live-acceptance-2026-08-19/README.md)). |
| FAL | **Provider-blocked** | Flux Schnell reached FAL and returned HTTP 403 because the user/account was locked or exhausted. No generation artifact was accepted ([screenshot 16](evidence/provider-agent-live-acceptance-2026-08-19/16-fal-flux-running.jpg)). |
| Replicate | **Passed after repair** | UI schema fetch succeeded. Flux Schnell returned a streamed `data:image/webp` value; the handler incorrectly typed that stream as Text, producing an empty manifest. Stream inference now routes media data URIs through centralized materialization. The retest produced a valid 1,024x1,024 WebP (2,366 bytes), one manifest output, no embedded base64, and an in-app image ([screenshots 17-29](evidence/provider-agent-live-acceptance-2026-08-19/README.md)). A follow-up regression also proves streamed media data URIs emit no transient text-delta telemetry. The provider's near-white image is an output-quality observation, not an app persistence failure. |
| Runway | **Provider-blocked** | TTS was rejected with HTTP 400 before work because the account had insufficient credits ([screenshots 32-33](evidence/provider-agent-live-acceptance-2026-08-19/README.md)). |
| Meshy | **Provider-blocked** | Text-to-image submit returned HTTP 402 because the free plan no longer permits task creation. No Meshy credits were consumed and no task id existed to cancel ([screenshot 34](evidence/provider-agent-live-acceptance-2026-08-19/34-meshy-credit-blocked-details.jpg)). |
| Ideogram | **Passed** | Transparent Turbo generation produced a valid 1,024x1,024 RGBA PNG (145,289 bytes), one manifest output, and an in-app render ([screenshots 35-36](evidence/provider-agent-live-acceptance-2026-08-19/README.md)). |
| QuiverAI | **Provider-blocked** | Arrow generation was rejected for insufficient credits before a billable SVG completed ([screenshot 37](evidence/provider-agent-live-acceptance-2026-08-19/37-quiver-credit-blocked.jpg)). |

The request-price estimate for successful calls remains below **$0.10**, safely
inside the approved $1 cap, but no billing dashboard was queried and this is not
an exact charged-total claim. Meshy and Quiver consumed no accepted task/output
credits. FAL, Runway, Meshy, and Quiver rejected work before success; Anthropic
rejected for balance. OpenAI and the four unconfigured families were excluded
as approved.

Live provider-side cancellation could not be established in this account
state. FAL, Runway, and Meshy never returned a cancellable job; Replicate Flux
completed faster than a reliable upstream-cancel observation. The exact remote
cancel requests remain covered by deterministic handler/runner tests, while the
live ceiling is UI/backend cancellation behavior only.

## Live agent results

| Agent | Read-only turn | Mutation turn | Live verdict |
|---|---|---|---|
| Claude | Correctly reported one node, zero edges, and marker `n1` | Created only `n2` with `AGENT_MUTATION_CLAUDE_20260819` | **Passed** inventory and mutation ([screenshots 38-40](evidence/provider-agent-live-acceptance-2026-08-19/README.md)); the log incorrectly labeled activity `hermes`, leading to the attribution repair. |
| Codex | Correctly reported two nodes, zero edges, and markers `n1,n2` | Created only `n3` with `AGENT_MUTATION_CODEX_20260819` | **Passed** inventory and mutation ([screenshots 41-42](evidence/provider-agent-live-acceptance-2026-08-19/README.md)); reproduced the same attribution defect. |
| Daedalus | Reported the correct three-node/zero-edge counts but omitted the requested marker IDs | Created only `n4` with `AGENT_MUTATION_DAEDALUS_20260819` | **Partial** read-only response quality; **passed** graph mutation ([screenshots 43-44](evidence/provider-agent-live-acceptance-2026-08-19/README.md)). |

The first Stop probe showed an immediate unacknowledged `Cancelled.` state and
an agent descendant briefly outliving its wrapper. A requested/confirmed
WebSocket protocol and truthful sources were added. The next live Claude probe
proved the UI ordering but found a deeper backend defect: Claude's Bash tool
created a new process group, so the group-only cleanup falsely confirmed while
the shell and Python sleep remained orphaned under PID 1. Exact sanitized
topology and screenshots are retained in the [process evidence](evidence/provider-agent-live-acceptance-2026-08-19/runtime-process-evidence.md).
The final repair freezes and discovers descendants across new groups/sessions,
kills every captured PID, and verifies disappearance before confirmation. The
deterministic separate-session sentinel and cleanup-failure regressions pass.
The final Daedalus turn proved corrected attribution ([screenshots 50-51](evidence/provider-agent-live-acceptance-2026-08-19/README.md)), but the isolated sessions ended during the interrupted review before Stop/process inspection completed. It was not repeated beyond the approved allowance, so live full-descendant cancellation remains **inconclusive**, not a claimed pass.

## Approval envelopes

### Approved first wave: executed paths

The user approved all of the following together:

- **USD hard cap: $1.00** across the 10 valid Settings providers plus Nous.
  The known successful-call floor is about **$0.058**, excluding sub-cent text
  calls and account-denominated credits. The cap reserves room for cancellation
  races and one necessary rerun; execution stops before exceeding it.
- **Meshy: up to 6 credits** (one 3-credit success plus one cancellation/rerun
  allowance).
- **Quiver: up to 40 credits** (one 20-credit SVG plus one cancellation/rerun
  allowance).
- **Agents: up to two short turns each** for Claude, Codex, and Daedalus, plus
  at most one short cancellation turn per agent if needed.

This wave covers Anthropic, ElevenLabs, FAL, Google, Ideogram, Meshy, Nous,
OpenRouter, Quiver, Replicate, Runway, and all three agents. It excludes OpenAI
until its rejected credential is replaced, and excludes the four absent-key
providers.

### Full 16-family closure

OpenAI needs a valid replacement credential. xAI, MiniMax, Krea, and Higgsfield
need credentials added in Settings by the account owner. Once present, the
known added successful-call floor is about **$0.36 plus Higgsfield usage**.
Use a separate **$5.00 hard cap** for this completion wave; stop before the
first Higgsfield request if its live account price cannot be bounded inside the
remaining cap.

Approval of the first wave does not authorize credential creation, replacement,
plan upgrades, credit purchases, or calls to providers that remain invalid or
unconfigured.

## Completion ledger

| Requirement | Current verdict | Completion evidence required |
|---|---|---|
| Zero-cost credential/capability matrix | **Complete** | This document plus refreshed health/catalog responses |
| Minimum test budget | **Complete and approved** | First-wave envelope recorded above |
| Cheapest representative request per provider | **Complete for the approved wave** | Six successful paths and five truthful provider/account gates recorded above; excluded families unchanged |
| Streaming | **Passed for available text paths** | OpenRouter, Gemini, and Nous completed live; Quiver was credit-blocked |
| Cancellation | **Deterministic repair complete; live ceilings documented** | Separate-session descendant and failure-path regressions pass. Final live Daedalus cleanup was interrupted/inconclusive; remote provider adapters remain deterministic-only because no cancellable live job stayed active |
| Retries | **Live failure/retry UI exercised; deterministic transient coverage green** | Nous failure/retry/fallback sequence plus mocked 429/5xx contracts |
| Outputs and persistence | **Passed for available output families** | MP3, WebP, and alpha PNG artifacts validated; immediate audio and reload persistence retested |
| Agent-driven graph actions | **Complete with one response-quality partial** | All three agents inspected and mutated the isolated graph; Daedalus omitted requested IDs in its read-only prose |
| Screenshots | **50 numbered captures (04-53), including restoration** | [Evidence index](evidence/provider-agent-live-acceptance-2026-08-19/README.md) |
| Defect repair | **All reproduced defects repaired at the deterministic ceiling** | Full-descendant cancellation and media-stream redaction regressions included; live Daedalus cleanup remains explicitly inconclusive |
| Release gates, push, CI | **Clean-clone local gates green; push/CI pending at report time** | Commit the reviewed clean-clone candidate to `main`, then require every GitHub Actions job green |

## Release verification on 2026-08-20

- Frontend tests: **63 files / 472 tests passed** after rebuilding
  `node_modules` from the committed lockfile.
- Frontend lint: inline-style guard, Slava CSS scope guard, and ESLint all
  passed.
- Frontend production gate: TypeScript, Vite's complete 2,812-module build,
  and the bundle/eval budget passed in the clean clone. The previous dirty-
  checkout chunk-generation stall did not reproduce after a clean `npm ci`.
- Backend clean-clone full suite: **1,641 passed in 39.30 seconds**. The four
  process-tree tests, including the separate-session descendant regression,
  also passed independently in **2.59 seconds**. The earlier dirty-checkout
  count was inflated by four untracked Finder conflict copies named `* 2.py`;
  those duplicate test files are intentionally absent from the release
  candidate.
- Node/provider contracts, contract inventory, and two consecutive generated
  model-reference checks passed for **172 definitions**.
- A repository-wide changed-artifact secret scan found no API-key, bearer,
  private-key, GitHub-token, or cloud-key patterns. The existing root `.env`
  is unchanged and is not part of this wave.
- `npm audit --omit=dev` currently reports three high-severity advisories in
  the unchanged transitive lockfile (`fast-uri`, `nanoid`, and `postcss`). This
  wave changes no dependencies; automatic upgrades were not mixed into the
  provider/cancellation release, and newly published fixes remain subject to
  the project's 14-day package quarantine.
- Restoration is complete: normal backend 8 nodes / 5 edges, exact original
  state SHA-256, and UI evidence 52-53.

The original checkout's object database contains a truncated packfile, so the
release candidate was reconstructed from a fresh clone of remote `main`
(`71901584a45a5c932ade6592c35bf019d59dce97`) by copying only the reviewed task
paths. Both Nous and Replicate skill mirrors are byte-identical in that clean
candidate. The 50 public evidence images are cropped to the Nebula viewport
and stripped of metadata; unrelated Chrome tabs/bookmarks remain only in the
untouched local originals. Commit, push, and post-push CI status are operational
release steps and are not claimed by this pre-push report.
