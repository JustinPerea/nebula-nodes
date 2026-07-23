# Implementation Notes

## 2026-07-22 - Targeted frontend development-dependency remediation

The clean npm audit reported five development-only findings: one low and four
high. `npm audit --omit=dev` remained at zero. A dry-run audit auto-fix would
have changed dozens of packages and selected Vite 8.1.5, which was only six
days old, so the remediation is deliberately narrower.

Decisions:
- Pin direct Vite to 8.0.16, the first non-vulnerable 8.0.x release, instead of
  allowing the caret range to select the too-new 8.1.5 release.
- Override only the vulnerable transitive packages: `@babel/core` 7.29.7,
  `js-yaml` 4.3.0, and `undici` 7.28.0.
- Keep each `brace-expansion` major compatible with its parent minimatch:
  1.1.16 under minimatch 3.1.5 and 5.0.7 under minimatch 10.2.5.
- Pin the existing Browserslist toolchain at 4.28.2 as an explicit development
  constraint and preserve its already-locked data packages. Re-resolving Babel
  otherwise selected five releases between 0 and 13.6 days old even though
  none was required for the security fixes.
- All selected versions were at least 14 days old at installation time. No
  production dependency or Remotion pin changed.
- Regenerate the lockfile with the explicit package policy, then validate from
  a clean `npm ci`; do not run `npm audit fix`.

## 2026-07-22 - GitHub Actions CI baseline

The repository previously had no configured GitHub checks. The first CI
workflow mirrors the local merge gates in three independent jobs.

Decisions:
- Run on pull requests and pushes to `main`; do not change branch protection.
- Keep backend, frontend, and contract jobs independent so a failure names the
  affected surface and does not serialize unrelated work.
- Use Python 3.12 and Node.js 22, with dependency caches keyed by the existing
  requirements and lockfiles.
- Pin official GitHub Actions to immutable commits while documenting their
  release-major tags in comments.
- Do not upgrade pip or run an audit auto-fix in CI. The workflow installs only
  repository-pinned Python requirements and the checked-in npm lockfile.
- Treat the contract inventory as an executable inventory gate. Its 48 known
  exemplar gaps remain visible in logs rather than being reclassified as CI
  failures by this infrastructure-only change.

## 2026-07-22 - Malformed Cinema refs and FileProvider object audit

Four loose refs had Finder-style duplicate names ending in ` 2`: local and
remote-tracking copies for both Cinema branches. Their alternate tips were
preserved by the existing `archive/cinema-per-shot-pre-repair-2026-07-22` and
`archive/cinema-variations-pre-repair-2026-07-22` tags before deleting only the
four malformed ref files. The valid Cinema refs remain at `d4421a8` and
`0a172c9`; `git fetch --prune`, `show-ref`, and `log --all` work afterward.

The repository lives in an iCloud/FileProvider-backed folder. A default
`git fsck --full` blocks when it reaches one of 2,210 dataless loose-object
placeholders. A fresh GitHub mirror restored every remote-reachable object; an
isolated all-ref audit then proved 8,700 branch/tag objects complete and passed
`git fsck --full --no-reflogs --no-cache --no-dangling`. The remaining nine
unavailable blobs belong only to dangling or reflog-only trees, not any current
branch, tag, or index entry.

Decisions:
- Keep the original FileProvider object store untouched. Do not replace it or
  discard reflogs merely to make the default scanner quiet.
- Preserve every current ref in the verified 61 MB recovery bundle at
  `.git/recovery/object-store-2026-07-22/pre-repair-all-refs.bundle`.
- Treat branch/tag connectivity as green, while retaining the default-fsck
  FileProvider limitation as an explicit local-environment risk.

## 2026-07-22 - PR #21 retired-plan reference cleanup

The repository documentation cleanup intentionally removes completed historical
plans and specs. Review found that a small set of retained backlog and
implementation notes still linked to those deleted paths.

Decisions:
- Preserve the historical context in the retained documents, but describe the
  deleted plans as recoverable from Git history instead of leaving dead links.
- Keep the Quiver placement alternatives as decision history while making clear
  that the retired master plan is no longer a live integration target.
- Do not restore any retired plan or spec solely to keep a historical link alive.

## 2026-07-22 - Gemini Omni provider capability guardrail

Google's current Gemini Omni documentation supports stateful video editing via
`previous_interaction_id`, but explicitly excludes video extension. The live
provider test confirmed that an extension-style follow-up reaches Google and
fails with a paid-request 400, while an in-place edit succeeds.

Decisions:
- Keep one backend capability rule as the source of truth. `validate_graph`
  catches direct Text Input plus edit-context graphs before execution starts;
  the Gemini Omni handler repeats the check after inputs resolve so composed or
  otherwise dynamic prompts cannot slip through to the provider.
- Classify only explicit duration-extension language and only when an edit
  context exists (previous interaction, video input, or explicit Edit task).
  Ordinary edit prompts and fresh text-to-video prompts remain valid.
- Return structured validation details from both execution endpoints. Create
  and Canvas already share these endpoints, so both surfaces can show the exact
  capability guidance instead of overwriting it with a generic validation
  message.
- Preserve connected `previous_interaction_id` precedence over the manual
  fallback. The guardrail uses that same resolved value and does not alter the
  request shape for valid edits.

Validation:
- 1,116 backend tests and 392 frontend tests passed. Frontend lint, production
  build, and the 142-node contract gate also passed.
- The Create UI was browser-checked with Gemini Omni selected; the capability
  note is visible alongside the expected Task, Aspect Ratio, and Delivery
  controls. Canvas exact-error behavior is covered at the store layer, and both
  `/api/execute` and `/api/execute-node` return the identical structured error.
- A provider client mock proves the runtime backstop raises before
  `httpx.AsyncClient` is instantiated, so the unsupported request cannot incur a
  paid submit.
- The checked-in `backend/.venv` points at an old repository location and its
  pytest launcher is not runnable. Verification used the existing Miniconda
  Python environment. The managed session also denied Python localhost binds,
  so a live backend restart was not available for browser QA.

## 2026-07-22 - PR #19 provider/runtime merge-readiness review

Independently re-verified the Google Gemini image and Omni contracts plus the FAL Nano Banana 2/Pro schemas before promoting the provider-runtime branch.

Decisions and corrections:
- Keep FAL endpoint slugs independent from Google's direct model lifecycle. The legacy FAL `gemini-3-pro-image-preview` selector remains valid even though Google shut its direct preview model.
- Scope direct Gemini image-size options by model: Flash Lite is 1K-only, Flash supports 512/1K/2K/4K, and Pro supports 1K/2K/4K.
- Scope FAL extreme aspect ratios to Nano Banana 2. Nano Banana Pro supports the common range through 21:9, not 1:4/4:1/1:8/8:1. Web search remains available on both current FAL models.
- Normalize hidden stale values in the execution adapters without mutating saved nodes. Direct Flash Lite falls back to 1K/common aspect ratios; FAL Pro falls back from 0.5K/extreme ratios and drops the Nano Banana 2-only thinking field. Legacy FAL selectors drop modern-only controls.
- Preserve the manual Gemini Omni previous-interaction parameter for pasted IDs, but add a real Text input so the advertised output-to-input chain works in the graph. A connected value takes precedence over the manual fallback.
- Add focused frontend visibility tests and a handler request-shape test to prevent contract drift.

Validation:
- Clean `npm ci`, 1084 backend tests, 390 frontend tests, lint, production build, and the 142-node contract gate passed.
- Capped live FAL Nano Banana 2 smoke returned one 0.5K image with web search disabled.
- Capped live Gemini Omni smoke exercised URI delivery end to end and saved a 3.008-second, 825417-byte video with an interaction ID.
- `npm audit --omit=dev` reports zero production vulnerabilities. The full audit reports five pre-existing development-only findings; this PR does not change the affected toolchain dependencies.
- Existing non-blocking warnings remain: two backend test coroutine warnings and Vite's large-chunk/lottie dependency warnings.

## 2026-07-22: Provider contract refresh and repository recovery

- **Preserved the inherited mixed worktree before editing.** Created `codex/provider-contract-refresh` directly from `main` with all existing modified, deleted, and untracked files still present. This keeps `main` available as the clean upstream baseline without stashing or rewriting unattributed work.
- **Repackaged the checkpoint as a three-level draft PR stack without moving it.** `codex/provider-runtime-safety` starts at the refreshed `origin/main`; `codex/provider-contracts-skills` adds only the portable contracts and repo-backed provider skills; `codex/repository-docs-cleanup` adds only historical-doc retirement, the local-engine research checkpoint, README updates, and implementation notes. The original `codex/provider-contract-refresh` branch remains fixed at `33f15cc` as the recovery checkpoint.
- **Kept the generated model reference with the runtime level.** `docs/MODEL_REFERENCE.md` is generated from the node registry changed by the runtime PR. Moving it to the next PR would make the runtime branch fail its own drift gate, so the generated artifact travels with its source while the portable contract corpus remains isolated in the second level.
- **Treat provider routing and provider schemas as separate responsibilities.** Node-specific model selection belongs in `backend/execution/sync_runner.py`; `backend/handlers/fal_universal.py` must continue forwarding arbitrary endpoint schemas and therefore cannot reserve the generic `model` key globally.
- **Live vendor documentation overrides the bundled provider skills.** The checked-in Gemini and FAL skills are useful routing references but contain preview-era model IDs. Production IDs and response-delivery behavior will be pinned to the current Google and FAL primary documentation and covered by regression tests.
- **Do not combine historical-doc deletion, provider skills, provider contracts, Gemini/FAL features, and cinema changes in one commit.** The inherited worktree mixes these independent concerns. Each scope will be validated and committed separately so it can be reviewed or reverted independently.
- **Use `contracts/fixtures/handlers/` as the only provider-contract fixture source.** The inherited `backend/tests/fixtures/{fal,google,openai}` files were untracked duplicate copies and no test referenced them. Keeping two writable trees already produced a stale Omni fixture, so the duplicates were removed and the contract README now names the portable root as the single golden source.
- **Pin a compatible model-viewer/Three pair instead of bypassing npm peers.** The inherited lock combined `@google/model-viewer@4.2.0` (`three ^0.182.0`) with `three@0.184.0`, so clean `npm ci` failed. Updated to `@google/model-viewer@4.3.1` with `three@0.183.2`; both versions are older than 14 days, satisfy model-viewer and every React Three/Remotion peer range, and are pinned exactly to keep future installs reproducible.
- **Closed the pre-existing brand showcase lint gate while restoring the frontend baseline.** Seven fixed palette swatches used static inline backgrounds. They are now named CSS modifier classes with the same RGB values; no visual behavior changed. The Helix mask also dropped an unused angle parameter; callers may still pass the computed angle, and JavaScript ignores the extra argument.
- **Reconciled provider skill conflict copies instead of committing both versions.** Eleven Finder-style `* 2.md` files were either exact duplicates or older copies. The newer skill files retained later cancellation, streaming, model, and caching guidance; corrupted Claude-to-Codex substitutions were repaired against the executable node registry and current Anthropic documentation before the duplicates were removed.
- **Kept FAL route slugs distinct from direct Google model IDs.** FAL still publishes legacy route names containing `gemini-3-pro-image-preview`, so those slugs and skill filenames remain intact. Direct Gemini and Vertex examples now use the stable `gemini-3-pro-image` model ID.
- **Retired historical milestone plans without breaking live references.** `docs/superpowers/` is superseded by the portable contract corpus and remains recoverable from Git history. The two remaining live references were made self-contained before deletion: the hackathon evidence guide embeds its demo sequence, and the Remotion schema names its implementation as the current runtime contract.
- **Integrated PR #5's image-input validation as a fresh commit on the recovered baseline.** The branch was 50 commits behind `main`, but its single commit transplanted cleanly while retaining the stable Gemini IDs and newer provider routing. The shared loader now fails loudly for missing, unreadable, non-file, and unsupported local image references; remote and data URI behavior remains unchanged.
- **Kept Cinema PRs #15 and #16 review-only.** Both branches have no submitted GitHub review and are eight `main` commits behind. PR #15 needs an explicit terminal error merge when its background task fails, otherwise the final graph sync can restore stale success after the optimistic spinner. PR #16 also lets a promoted thumbnail update `shot.output.imageUrl` without updating the dynamic `shot_<id>` port, so the UI and downstream graph can disagree. Neither branch was merged.
- **Merged the unique local-engine research checkpoint, archived the other stale lines.** The ComfyUI/Flora/Weave comparison was documentation-only and applied cleanly. Fifteen fully merged local branches were safely deleted. Six stale non-worktree branches and both stashes were tagged under `archive/` before their local refs were removed; the stash tags retain the merge commits and their untracked-file parents.
- **Preserved two cloud-backed worktrees instead of forcing deletion.** `feat/batch-cross-pair` had two dirty dev-routing edits; they were security-scanned and committed as `2d7634d` before its archive tag was created. The old frontend-baseline and batch worktree directories could not be removed because both Git deletion and a Trash move blocked on cloud file hydration. Their branch refs, worktree registrations, and archive tags remain intact.
- **Final verification is green with known warnings only.** Backend: 1,111 passed with the two pre-existing AsyncMock coroutine warnings in `test_async_poll_runner.py`. Frontend: 389 tests, lint, inline-style guard, Slava CSS scope guard, and production build passed. Contract parity and generated model-reference checks passed for 142 definitions; the build retained the known large-chunk and `lottie-web` direct-eval warnings.

## 2026-07-22: Cinema PR repair

- **Preserve the review stack before rewriting it.** Tagged the original PR #15 tip `66599b7` as `archive/cinema-per-shot-pre-repair-2026-07-22` and the original PR #16 tip `4468ba1` as `archive/cinema-variations-pre-repair-2026-07-22` before rebasing either branch.
- **A completed `execute_graph` call does not prove the Cinema node executed.** Normal upstream failures are emitted as `ErrorEvent` and `execute_graph` returns without a target `ExecutedEvent`. The per-shot task now requires that target event, captures the first user-facing error, and persists it on the live target shot instead of reading stale success from the request snapshot.
- **Failure reconciliation preserves useful state.** A terminal error changes only the target shot status and error text. Its last successful image, hash, and dynamic output port remain available, and sibling edits made during the slow pass remain untouched under the existing per-node merge lock.
- **Keep the Cinema stack independent from provider work.** The original repair did not duplicate the then-unmerged provider fixes into #15. The final restack inherits those merged fixes, CI, and dependency remediation from `main` while keeping the Cinema diff reviewable on its own.
- **Variation promotion is one scene-plus-port transaction.** PR #16 now promotes through a Cinema-specific backend endpoint guarded by the same per-node lock as generation merges. It persists `selectedVariation`, replaces the canonical shot output without retaining a stale hash/error, updates `shot_<id>`, and broadcasts one graph sync. The frontend mirrors both fields after success and uses the same local operation for frontend-only nodes.

## 2026-06-10 (night) — Full Ideogram direct-API surface: 7 direct-only nodes incl. custom-model training

User wanted EVERYTHING the direct API offers, not just the dual-route nodes. Pulled the full OpenAPI (developer.ideogram.ai/openapi.json), enumerated all 27 endpoints, and wired every current (non-legacy) one. Registry 131 → **138**.

New direct-only nodes (envKeyName IDEOGRAM_API_KEY, apiProvider 'ideogram', no FAL fallback):
- `ideogram-describe` (v4): image → readable `description` + raw `json_prompt` (the v4 structured contract incl. bbox layout when include_bbox on). Category analyzer.
- `ideogram-magic-prompt` (v4, **application/json** not multipart): text → expanded json_prompt. Category text-gen.
- `ideogram-transparent` (v3 generate-transparent): prompt → real-alpha PNG, upscale_factor X1/X2/X4.
- `ideogram-remove-background`: Ideogram's own cutout — deliberately separate node id from the FAL rembg `remove-background`.
- `ideogram-layerize` (layerize-text): returns the clean **base plate** (text stripped); the response is NOT the standard data[] shape — base_image_url/original_image_url/seed, normalized through `_save_first_image({"data":[{"url": base}]})`.
- `ideogram-edit-prompt` (`/v1/edit`): MASKLESS prompt-driven edit, 1+ images (single `image` port leads, multi `images` appends), optional transparent_background. Response schema is V1EditImageObject but the endpoint is NOT marked legacy.
- `ideogram-train-model`: one node = the whole training pipeline (POST /datasets → upload_assets multipart `files` array → train-model → poll GET /models/{id} every 30s, ≤3h, statuses CREATING/DRAFT/TRAINING/COMPLETED/ERRORED/ARCHIVED; requires is_available_for_generation). Outputs `custom_model_uri` + `model_id` Texts.

Closing the loop: `custom_model_uri` directParam added to ideogram-character (v3 generate accepts it) → train-model output wires straight into fine-tuned character generation.

Still consciously unexposed (in ideogram.md): raw json_prompt INPUT on v4 generate (we only OUTPUT it from describe/magic-prompt so far), dataset/model list-get endpoints, per-character-ref masks, all 5 legacy endpoints.

980 backend (+10: per-endpoint body shapes incl. the JSON-vs-multipart split, train full-flow ordering + ERRORED failure, custom_model_uri forwarding) + 347 frontend; parity 138. NOTE: `npm run lint` currently fails on BrandShowcaseView.tsx inline-style violations — that's the user's in-flight brand work, not this session's files (mask-painter/inspector pass the checker).

## 2026-06-10 (evening) — Ideogram direct API (dual-route), Character Studio integration, Mask Painter

Three asks in one pass: stop depending on FAL alone for Ideogram, wire Character Studio into ideogram-character, and give masks an in-app painting UI. Registry 130 → **131** (+mask-painter).

**1. Ideogram direct API — dual-route conversion (not new nodes).** All 7 ideogram nodes now follow the veo-3/meshy dual-route pattern: `envKeyName: [IDEOGRAM_API_KEY, FAL_KEY]`, `directKeyName`, params split into shared/fal/direct. New `backend/handlers/ideogram.py` (multipart/form-data, Api-Key header, SYNC endpoints, ephemeral result URLs downloaded immediately). Schemas all fetched from developer.ideogram.ai OpenAPI (.md suffix trick). Notables:
- **Direct remix rides V4** (`/v1/ideogram-v4/remix`, `image_weight` 1-100) while FAL remix is still v3 — the direct route is a real upgrade, not just margin-avoidance.
- **Param dialects differ per route** and the dual-param architecture was built for exactly this: rendering_speed TURBO/DEFAULT/QUALITY (direct) vs TURBO/BALANCED/QUALITY (FAL); magic_prompt enum vs expand_prompt bool; resolution pixel enums vs image_size presets; v4 generate/remix take no seed/num_images.
- **Router fallback nuance:** direct reframe REQUIRES `resolution`; the router falls back to FAL when it's unset rather than 400ing (`require_param` hook in `_ideogram_router`).
- Skipped on direct: v4 `json_prompt` structured contract, describe/remove-bg/layerize-text/transparent-bg/custom-model training (documented in docs/api-guides/ideogram.md as unwired).

**2. Character Studio → ideogram-character.** Optional `character` input port (Character dataType). `expand_character_inputs` in handlers/ideogram.py reuses `cinema.identity.expand_character` — the SINGLE identity-correctness implementation (trait string VERBATIM prefix, stored views first, per-use overrides appended, max-refs guardrail at 10) — and the sync_runner wrapper applies it to BOTH routes before delegation. Bundle seed lands in params only when the user left seed unset. `reference_images` port went required→optional (refs OR character, enforced in the wrapper with a clear error).

**3. Mask Painter.** New utility node + canvas paint modal:
- Storage contract: `params._maskData` = white-on-black PNG data URI (underscore param rides `_validate_params` like `_characterId`). **Polarity applied at EXECUTION** by the engine branch (`white-edit` FLUX / `black-edit` Ideogram) so flipping the param never requires repainting.
- Engine branch resizes the mask to the source image's EXACT dims (PIL, NEAREST to keep edges hard) — Ideogram 422s on any mismatch.
- Modal exports only the strokes layer (never the photo canvas) → cross-origin upstream images can't taint the export. Paints at natural resolution, CSS-scaled display.
- **UI lives in the Inspector, not a custom canvas node** — deliberate: Canvas.tsx is mid-flight with the user's uncommitted brand-showcase work, and a custom node type would have forced edits there. Inspector section finds the upstream image via edges→source outputs (falls back to image-input `_previewUrl`).
- Added to docs/utility-node-test-manifest.json (the manifest gate requires every utility node covered).

Tests: 970 backend (+21: direct body-shapes per endpoint, router direct/fallback/require_param, FAL-route bundle expansion, mask polarity/resize/error) + 347 frontend; contracts parity 131. The earlier FAL-session contract test pinning `envKeyName == "FAL_KEY"` was updated to pin the dual-route shape instead (intended evolution, not a regression).

## 2026-06-10 (later) — Ideogram editing suite: six capability nodes, not just t2i

User caught that the morning's Ideogram add was text-to-image only while Ideogram's whole pitch includes region editing. Wired the full capability surface as 6 new nodes (registry 124 → **130**), all via FAL (FAL_KEY, existing handler):

- `ideogram-edit` (fal-ai/ideogram/v3/edit) — masked inpaint. **Mask polarity is BLACK = edit, the inverse of FLUX Fill** (verified against developer.ideogram.ai: "Black regions in the mask should match up with the regions of the image that you would like to edit"). Surfaced in the port label ("Mask (black = edit)") and pinned by a registry contract test, since a silent polarity flip would invert every edit.
- `ideogram-remix` (v3/remix) — image+prompt restructure with `strength`.
- `ideogram-reframe` (v3/reframe) — outpaint to a required target `image_size`; schema takes NO prompt (contract-tested).
- `ideogram-replace-background` (v3/replace-background).
- `ideogram-character` (fal-ai/ideogram/character) — consistent identity from reference photos; needed a NEW handler mapping `reference_images` port → `reference_image_urls` (style refs ride the existing `images` → `image_urls`). Style enum here is AUTO/REALISTIC/FICTION (different from the v3 AUTO/GENERAL/REALISTIC/DESIGN).
- `ideogram-upscale` (fal-ai/ideogram/upscale) — `resemblance`/`detail` 1-100; `expand_prompt` defaults FALSE on this endpoint (true elsewhere).

Decisions:
- **v3 endpoints for the editing suite** — probed FAL's OpenAPI: `ideogram/v4/{edit,remix,reframe,replace-background}` all 404; only `ideogram/v4` + `ideogram/v4/lora` exist. The direct Ideogram API has a v4 Remix but FAL doesn't host it yet. Swap slugs when FAL ships v4 editing (node ids stay stable).
- **Skipped params:** `style_codes` / `style_preset` / `color_palette` (array/object types the param UI can't express — reachable via fal-universal), `reference_mask_urls` on character (must count-match refs; awkward in graph UI), v4 LoRA node (needs a loras array; fal-universal covers it).
- All six endpoints return `{images: [...]}` → existing `_parse_fal_output` handles them; no output changes.

949 backend (+3: edit body-shape, character ref-mapping, 7-node registry contract incl. mask-polarity + reframe-promptless pins) + 347 frontend; contracts parity 130; lint/build green.

## 2026-06-10 — Gap-audit remediation: dead DALL·E removal, GPT-5.x/Fable-5/Gemini-3.5 refresh, Ideogram 4 + Runway Upscale, doc sync

Full-session remediation of the comprehensive gap review (4 subagent audits + canonical-source verification). Registry: 123 → **124 nodes** (−dalle-3-generate, +ideogram-v4, +runway-upscale). Tests: 946 backend + 347 frontend, node-contracts parity green.

**Decisions not dictated by the spec:**
- **`dalle-3-generate` removed outright** (not aliased): OpenAI shut down dall-e-2/3 on 2026-05-12, and gpt-image nodes already cover the category. Saved graphs containing it will fail validation — acceptable since the API itself is dead. Also dropped the dall-e branches from `openai_image.py` and the dead `dall-e-2` option from `gpt-image-1-edit`'s enum (caught by the docs subagent).
- **`gpt-4o-chat` keeps its node id** (saved-graph compat) but displayName → "OpenAI Chat"; default model gpt-4o → **gpt-5.4**; new `reasoning_effort` param (gpt-5.x only, default medium). Handler omits temperature/top_p/penalties for gpt-5.x (reasoning models reject them) — guarded in code, not just UI visibleWhen.
- **`claude-chat`**: added claude-fable-5 + claude-opus-4-8; **default stays sonnet-4-6** (cost/perf for graph work). Handler suppresses the extended-thinking block for fable/mythos models (adaptive thinking is always-on there; the param 400s).
- **`gemini-chat` default** 2.5-flash → **3.5-flash** (now the stable frontier model). `gemini-3.1-flash-lite-preview` → stable `gemini-3.1-flash-lite` id. `thinkingLevel` visibleWhen refreshed to the 3.x set incl. 3.5-flash (was stale → param would never show for new models).
- **Runway**: video options += seedance2/seedance2_fast/happyhorse_1_0 (all text-capable per docs); aleph gets a model param (default **stays gen4_aleph**, aleph2 opt-in); image += gemini_image3_pro + gpt_image_2; **new `runway-upscale` node** (magnific_precision_upscaler_v2, schema from runwayml SDK 4.18.0 via opensrc: scaleFactor 2/4/8/16, flavor, sharpen/smartGrain/ultraDetail). gen3a_turbo kept but labeled legacy (dropped from Runway's models table, still priced).
- **Ideogram 4 wired via FAL** (`ideogram/v4`, schema fetched from fal.ai OpenAPI) rather than direct api.ideogram.ai — zero new auth, matches the 40+ existing FAL preset nodes. Direct integration (IDEOGRAM_API_KEY) deferred; key removed from .env.example with the other never-wired keys (BFL/BYTEDANCE/RECRAFT).
- **Sora 2 sunset surfaced in displayName** ("Sora 2 (sunsets Sep '26)") since node defs have no description field — OpenAI kills the Videos API 2026-09-24 and the FAL endpoints proxy it. Plan removal mid-September.
- **Cancellation**: veo.py now schedules a detached `{op_name}:cancel` (standard google.longrunning interface, best-effort) on CancelledError; grok_video.py documented local-only (xAI has no cancel endpoint) matching the MiniMax precedent. The 342e86e claim of "all poll-based providers" had skipped both.
- **Settings UI**: added KREA_API_TOKEN (was un-keyable via UI); removed the BFL field + the dead "FLUX Routing" control — the `routing` setting was persisted but no handler ever read it (scaffolding for an unbuilt BFL-direct path; ROUTING_OPTIONS left in place, emptied).
- **node_definitions.json formatting normalized** to plain `json.dump(indent=2)` — a few hand-compacted option blocks (seedvr resolution etc.) re-expanded; future scripted edits now produce clean diffs.

**Verified-false subagent claims (do NOT "fix" these):** `anthropic-version: 2023-06-01` is still Anthropic's latest API version; `api.dev.runwayml.com` IS Runway's production host.

**Deferred / follow-ups:**
- README still says "seven workspaces" deliberately — brand-showcase is in-flight uncommitted work; its README mention should ride that commit.
- runway-image caps reference images at 3; gemini_image3_pro supports 14 and gpt_image_2 supports 16 — widen when someone needs it.
- Frontend/backend node-def duplication: parity is gated (`npm run check:node-contracts` + backend contract tests) but codegen from the backend JSON is the structural fix — sized as its own session.
- minimax handler still on `api.minimaxi.com` (works; docs now say `api.minimax.io`) — flip after a live smoke.
- Eleven Music (`/v1/music`, model music_v1) is API-ready at ElevenLabs but unintegrated — candidate next node.

## 2026-06-03 — Output storage: Reveal in Finder, Save-to-folder, configurable output dir

Three follow-on features after the user asked where generated images live (answer: `<repo>/output/<UTC-timestamp>/<uuid>.<ext>`, served at `/api/outputs/...`, never auto-deleted).

- **Reveal in Finder** — `POST /api/reveal {url}` resolves via the existing `_output_path_from_ref` (containment-checked under the output root), then `open -R` (macOS) / `xdg-open` (Linux) / `explorer /select,` (Windows) via `asyncio.create_subprocess_exec`. ResultCard gets a FolderOpen button.
- **Save to a default export folder** — new `exportFolder` setting (added to `DEFAULT_SETTINGS` + the `PUT /api/settings` allowlist + a Settings field). `POST /api/export {url}` copies the output file into `exportFolder` (default `~/Downloads`), de-duping the filename on collision. ResultCard gets a FolderDown "Save" button.
- **Configurable output directory** — wired the previously-DORMANT `outputPath` setting (the Settings field + persistence already existed but nothing honored it). `_resolve_output_root()` now sets `OUTPUT_ROOT` from `NEBULA_OUTPUT_ROOT` env > `outputPath` setting > default, at import (applies on restart). **Replaced the `/api/outputs` StaticFiles mount with a dynamic `@app.get("/api/outputs/{rel:path}")` FileResponse route** that serves from `OUTPUT_ROOT` and falls back to `DEFAULT_OUTPUT_ROOT`, so outputs created before a relocation still serve. Starlette `FileResponse` preserves content-type + HTTP Range/206 (video seeking) + HEAD — verified live.

**Review-caught fixes (opus, on the serving-path change):**
- **Critical — startup brick:** once `outputPath` is user-set, the unguarded `OUTPUT_ROOT.mkdir()` at import could crash uvicorn on a bad/unwritable path. Fixed inside `_resolve_output_root()`: anchor relative paths to the repo root, then `mkdir`-or-fall-back-to-default so `OUTPUT_ROOT` is always a usable dir. Live-verified: `NEBULA_OUTPUT_ROOT=/dev/null/nope` boots via fallback instead of bricking.
- **False-green traversal test:** the original `client.get("/api/outputs/../../etc/passwd")` passed only because httpx normalizes `../` client-side, never hitting the guard. Replaced with a direct `serve_output("../../../../etc/passwd")` test that actually exercises the `relative_to` containment (and a server-side `curl --path-as-is` live check → 404).
- Relative `outputPath` was CWD-dependent → anchored to repo root. Dual-root fallback also applied to `convert_to_glb` + `resolve_moodboard_image_path` for consistency. Registered `.webm`/`.glb` mime types.

**Verification:** backend `pytest` 865 passed (twice); frontend `tsc` clean, 322 vitest, build/eslint/css-scope green. Live (running backend): image 200 (image/png), video full 200 + Range 206 (seek), server-side traversal 404, missing 404, no-brick boot on bad path. Commits: 14a4d83 (reveal+export), a53cbb5 (configurable dir), 782b4ef (review fixes).

## 2026-06-03 — Create view Phase 3 (presets / styles library)

Branch `feat/create-view-p2-p3` (same branch as P2). A library of named "styles" — prompt fragment + params + optional model — that pre-fill the composer, plus save-current-as-style. The historical implementation plan was retired in the 2026-07-22 documentation cleanup and remains recoverable from Git history.

**Decisions / non-obvious calls:**
- **Typographic preset cards, no shipped thumbnails.** Higgsfield merchandises styles with auto-playing video tiles; we ship ALL-CAPS name + category over a deterministic per-id Slava gradient. This sidesteps two real constraints at once: (1) shipping binary PNGs through the toolchain is awkward, and (2) the backend serves **only** `OUTPUT_ROOT` (one `StaticFiles` mount) — there's no arbitrary-file route, so a repo-shipped thumbnail isn't directly servable without copying it into the outputs dir at seed time. Real thumbnails are deferred to P4. The one allowed inline style is `PresetCard`'s `--preset-hue` custom property (a dynamic data value — `check:inline-styles` only flags static visual props).
- **First-run seeding is a NEW pattern.** No seeding existed anywhere in the codebase (verified). Added `seed_presets_if_empty()` (idempotent — only when the global store is empty; wrapped in try/except so it can never break boot) reading 12 curated styles from `backend/data/presets/seed.json` (JSON only, no binaries). Placed at the END of `main.py` (Python executes top-to-bottom; the fn must be defined first), running once at import. `conftest.py` sets `NEBULA_PRESET_ROOT` to a temp dir at module-eval time so the boot seeder never writes into the user's real `~/.nebula/presets` during tests.
- **Mirror the store pattern faithfully.** `preset_store.py` clones `moodboard_store.py`. Code review caught that the first cut simplified away three guards the moodboard store has — added back: `_scope_dir`'s `resolve().is_relative_to()` path-containment check, `list`'s per-file `try/except (JSONDecodeError, OSError)`, and the route's `ValueError → 422`. "Reuse verbatim" means *including* the defensive bits.
- **`applyPresetToComposer` rebuilds model defaults on a model switch.** When a preset hints a different model, we re-seed that model's defaults (`buildDefaultParamsForUi`) before overlaying the preset's params, so stale params from the previously-selected model don't leak through. Pure function, unit-tested.
- **Repeated lesson — global-singleton test isolation.** Same trap as P2's cluster route: backend tests must pass in the FULL suite, not just isolation. The preset tests use the module-attribute swap (`monkeypatch.setattr(main, "preset_store", ...)`) + `NEBULA_PRESET_ROOT` sandbox + reference the store through the module (never a stale `from main import preset_store`).

**Verification:** backend `pytest` 847 passed; frontend `tsc` clean, 300 vitest tests, `vite build`, `eslint`, `check:slava-css-scope` green. **Live (isolated uvicorn, temp dirs, port 8001):** boot seeder produced 12 presets (`GET /api/presets` → 200, 12 files on disk); `POST /api/graph/cluster` persisted the cluster to `state.json` (confirming P2 reload-survival) — the user's real `~/.nebula` was never touched.

## 2026-06-03 — Create view Phase 2 (gallery, refs, variations, persistence)

Branch `feat/create-view-p2-p3`. Five sub-features: results gallery/History, reference-image attach, quantity>1 variations, all output types in the stage, and **backend-authored persistence**. Built subagent-driven in batches (Phase A persistence → B/C refs+quantity → D/E gallery+output-alignment) with spec + code-quality reviews. The historical implementation plan was retired in the 2026-07-22 documentation cleanup and remains recoverable from Git history.

**The big reversal — clusters are now persisted (P1 debt closed).** P1 authored clusters client-side (uuid ids, never persisted). P2 flips `authorGenerationCluster` to **backend-first**: it POSTs the cluster to a new additive route `POST /api/graph/cluster` (mirrors `/api/graph/import` but no `clear()`), which adds the nodes/edges to `cli_graph` (assigning `n`-ids, persisting to `state.json` via `_maybe_persist`, normalizing image-input params) and returns them in React Flow shape. The client applies the returned nodes directly + tags model nodes `_createOrigin`. Switching to canvas shows the cluster; it now survives reload.

**Decisions / non-obvious calls:**
- **Tag race (caught in review).** The backend's graphSync WS broadcast usually delivers the new nodes (untagged) to the client store *before* `authorGenerationCluster`'s own `set` runs, so an insert-if-absent merge silently dropped `_createOrigin`. Fixed with an **upsert** that merges only the tag onto already-present nodes (never clobbering their state/outputs) — and a test that pre-seeds the node to actually exercise the ordering (the unit tests mock `wsClient`, so the race was previously untested = false green).
- **image-input accepts `/api/outputs/...` URLs.** The engine passed `filePath` verbatim and FAL's `_to_fal_url` treats any non-`http(s)`/`data:` value as a local disk path — so a served URL broke. Added `resolve_output_ref` (output.py) + an engine `_image_input_output` helper so generated outputs can be reused as references (execution side); the cluster route's `_normalize_image_input_params` handles the persistence side. "Use as input" stores the backend-RELATIVE pathname (not the absolute `http://localhost:8000/...` URL, which would reach external providers unresolved).
- **Gallery is session-scoped.** History is driven by a `generations: {genId, prompt, ts, modelNodeIds}[]` array in `CreateView` (not by scanning `_createOrigin`), so it's reliable in-session. The spec's "All outputs" tab and reload-repopulation are deferred (the canvas persists; the gallery starts fresh after reload). Shipped Grid/List toggle.
- **`deleteGeneration`** removes the model node(s) of a generation plus any now-orphaned `text-input`/`image-input` (an input feeding *other* surviving model nodes is kept). Fires a best-effort backend `DELETE /api/graph/node/{id}` for every id (harmless 404 for any non-cli id) — diverges from sibling delete paths' `CLI_ID_RE` guard, justified because Create clusters are backend-authored now.
- **Cluster-route response built directly, not via full re-export.** Initial impl re-exported the whole graph and filtered to new ids — which failed in the full pytest suite (a sibling test's autouse fixture swaps `main.cli_graph`; root cause proven). Fixed by extracting `_cli_node_to_rf(n, position, all_defs)` (shared by `export_graph_for_frontend` and the route) and looking up the new nodes directly in `cli_graph.nodes`. More robust + avoids export-time normalization side-effects on unrelated nodes.

**Verification:** backend `pytest` 839 passed (twice, order-independent); frontend `tsc` clean, 293 vitest tests, `vite build`, `eslint`, `check:slava-css-scope` all green. Persistence to `state.json` is structurally guaranteed (route → `add_node` → `_maybe_persist`) and covered by the route test. Full browser smoke (gallery progression, persistence-across-reload, use-as-input round-trip) is consolidated with P3 in the verify-and-finish step.

## 2026-06-02 — Create view (Higgsfield-style creation surface), Phase 1

Branch `feat/create-view`. A new full-screen `viewMode: 'create'` surface (4th studio) with a Higgsfield-style bottom-floating composer. Each **Generate** authors a real `text-input → model` node cluster and runs only that cluster via the existing engine. The historical design spec and implementation plan were retired in the 2026-07-22 documentation cleanup and remain recoverable from Git history.

**Architecture — graph-builder (chosen over single-node / hybrid).** `graphStore.authorGenerationCluster(request)` builds nodes/edges and `executeCluster(nodeIds)` POSTs only the cluster to `/api/execute` (reusing `lib/api.executeGraph`). Zero changes to the execution engine, handlers, or node definitions — the surface inherits output rendering, WS streaming, error handling, undo, and canvas editability for free. This is why it's ~640 lines of source for a full creation UI.

**Decisions made beyond the spec:**
- **Local node authoring, not backend-authored.** `authorGenerationCluster` creates nodes client-side (like `addDynamicNode`/paste) in one `set()`, for atomicity + testability + immediate ids. Consequence (verified in live smoke): **Create-authored clusters are client-only and do NOT persist to the backend `~/.nebula/state.json`** — after a generation, `state.json` still held only the pre-existing moodboard node. In-session "fill in" works (nodes are in the client graphStore, render on the canvas, and execute correctly). **Cross-reload durability is NOT wired in P1.** If we want authored clusters to survive a reload, P2 should author via `/api/graph/node-and-connect` (backend-authored, persisted) or push the cluster to the backend graph. Spec §4.3 was updated to reflect this.
- **`_createOrigin` tags model nodes only** (not the `text-input`/`image-input` wiring nodes) — from code review; the P2 results gallery filters on this tag, so tagging input nodes would pollute it.
- **`executeCluster` pre-marks cluster nodes `queued`** (clearing stale `error`/`progress`/streaming fields) before POSTing — from review; without it the stage flashed the previous result on every 2nd Generate.
- **Dropped `cinematic` + `universal` from the picker's `CREATE_MODEL_CATEGORIES`.** `cinematic` = post-process nodes (`cinema-color`/`cinema-look`/`cinema-scene`), not prompt-first generators. `universal` = the 4 dynamic nodes (OpenRouter/Replicate/FAL) — deferred to P4 (they need a model-schema fetch step). v1 picker = `image-gen`/`video-gen`/`audio-gen`/`3d-gen`/`text-gen`.
- **Accent = Slava orange (`--sr-accent`), not Higgsfield lime.** Copy the layout/interactions, render in the house skin.
- **`model-viewer` rendered via the existing `types/model-viewer.d.ts` JSX declaration** (no `@ts-expect-error` — that would be an unused-directive error), mirroring `MeshPreview.tsx`.

**Known debt / deferred:**
- DRY: `buildDefaultParams` (graphStore) duplicates `buildDefaultParamsForUi` (createParams) and the inline logic in `addNode`. Consolidate post-P1 (a shared param-defaults util imported by all three).
- Image-required models (e.g. `runway-video`, `meshy-image-to-3d`) appear in the picker but will fail backend validation without a reference image until P2 adds reference attach — acceptable; surfaces the real validation error.
- P2: results gallery/History, reference-image attach, quantity>1 UI, all output types in the stage. P3: presets/styles library. P4: universal dynamic nodes, generated preset thumbnails, draw/mask, @-mention elements.

**Verification:**
- Gates: `tsc` clean, **288 vitest tests pass** (incl. new createCluster/createModels/createParams/uiStore tests), `vite build` succeeds, `eslint` clean on all new/changed files, `check:slava-css-scope` passes. (`npm run lint` is red on `main` due to **pre-existing** `CrabMark.tsx` inline-style debt — unrelated to this branch.)
- Live smoke (real browser, not lspace): entered Create, opened the model picker (full catalog), typed a prompt, hit Generate → a **real nano-banana image of exactly the prompt** was generated end-to-end (`POST /api/execute → [exec] _run completed → output/.../*.jpeg`). The prompt-faithful output proves the `text-input → model` wiring carried the prompt.
- **Environment gotcha:** background dev servers get reaped (SIGTERM 143) in this harness; when Vite's dev server dies, its `@vite/client` intercepts `console.error` and recursively tries to `send` over the dead HMR socket → a multi-million-line "send was called before connect" storm. This is a Vite-client failure mode, NOT app code. The canvas-cluster screenshot wasn't captured for this reason; the cluster's existence is proven by the unit tests + the successful generation.

## 2026-05-26 — Codex chat agent

- Added Codex as a separate chat runtime rather than overloading the Claude runner. Codex has its own JSONL event stream, auth state, and resume command shape, so a dedicated adapter keeps the existing Claude/Daedalus paths untouched.
- Codex uses the local CLI login state (`codex login status`) instead of storing ChatGPT credentials in Nebula. This follows OpenAI's documented Codex auth model and avoids copying subscription tokens into `settings.json`.
- The Codex runner launches with `workspace-write`, `approval_policy="never"`, and local network enabled so it can call the Nebula CLI/backend without interactive approval prompts while still avoiding the full `--dangerously-bypass-approvals-and-sandbox` path.
- GPT Image 2 generation remains on Nebula's existing OpenAI/FAL nodes. ChatGPT-backed Codex auth is only for the Codex agent brain; Image API calls still require `OPENAI_API_KEY` or `FAL_KEY`.

## 2026-05-26 — Codex skill bootstrap

- Added a repo-backed skill bootstrap to the Codex runner instead of relying on private/global agent skill state. The bootstrap indexes `.agents/skills/*/SKILL.md`, lists available skills, preloads relevant root skill docs based on the user's message, and points Codex to tracked provider docs for exact node/API details.
- Kept preload bounded (`MAX_SKILL_BOOTSTRAP_CHARS`, `MAX_SKILL_DOC_CHARS`) so FAL's large model catalog remains available on disk without bloating every Codex turn.
- `.agents/skills` is not currently committed on `origin/main`; it exists locally as an untracked public-safe bundle. It needs to be added to the repo before the GitHub version has the same Codex/Nebula knowledge.

## 2026-05-26 — Agent connection instructions

- Added Claude auth status parity with Codex via `/api/agents/claude/status`. Nebula still does not collect credentials; it only reports the local CLI's installed/logged-in state.
- Added compact connection instructions inside the chat composer for Claude and Codex. They show the relevant local CLI login/status commands and open automatically when the selected CLI is missing, unavailable, or not logged in.

## 2026-05-26 — Codex announcement HyperFrames video

- Creating the announcement as a standalone HyperFrames composition under `hyperframes/codex-chat-announcement` so it can be rendered independently from the Vite frontend while still matching the Slava UI.
- `npx hyperframes` is not available in the local cache and registry access is blocked in this sandbox, so the work will produce valid composition source and local structural checks rather than a rendered MP4 in this pass.
- The video mirrors the actual Slava chat panel affordance: Claude / Codex / Daedalus selector with Codex active, `Codex · ChatGPT` status copy, dot-matrix canvas, glass panels, orange focus accent, and compact node graph surfaces.

## 2026-05-27 — Backend URL discovery

- Added frontend-side Nebula backend discovery instead of assuming every request and WebSocket lives at `localhost:8000`.
- Discovery checks the same-origin `/api/health` path first, then cached/local localhost candidates on ports 8000-8010, and caches the working base URL in localStorage.
- Kept `VITE_NEBULA_API_BASE` and `VITE_NEBULA_BACKEND_PORTS` as explicit overrides for users who run the backend on a nonstandard fixed port.
- Rewrote local `/api/outputs/...` asset URLs to the discovered backend origin so images, videos, downloads, and restored graph bundles still work when the backend is not on 8000.

## 2026-05-27 — Agent reconnect retry

- Fixed backend discovery treating the same-origin Vite proxy candidate (`""`) as not found even after `/api/health` succeeded.
- Added retry loops for Claude/Codex status checks and the chat WebSocket so a backend that starts after the page loads is picked up without switching tabs or reopening the panel.

## 2026-05-27 — Codex ChatGPT login from UI

- Added a Nebula-launched Codex ChatGPT login path instead of asking users to copy terminal commands first. The backend starts `codex login` and the frontend polls progress/status from the chat panel.
- Treat Codex API-key mode as not connected for the ChatGPT subscription path. The button is intentionally labeled `Connect ChatGPT Account`; starting it runs `codex logout` first, then `codex login`, so an existing API-key login can switch to ChatGPT OAuth cleanly.
- Nebula still does not store OpenAI OAuth tokens. Codex owns the browser/device OAuth flow and caches credentials in its normal local store; Nebula only reads `codex login status`.
- Added a `Device Code` fallback in the UI for machines where the browser callback flow is awkward or blocked.

## 2026-05-27 — GPT Image 2 graph run crash

- Diagnosed the GPT Image 2 "no images" symptom as a backend graph-sync crash before or after the image node, not a Codex auth problem. A long prompt Text output was being probed as if it might be an output file path.
- Hardened output-path normalization so `Path.exists()` / path parsing errors from long plain-text values are treated as "not a file" instead of crashing `/api/graph/run`.
- Verified the regression with the existing long-text output sync test plus the GPT Image 2 handler suite.

## 2026-05-27 — OpenAI API billing guard

- Added an explicit billing acknowledgement guard for OpenAI-direct image nodes (`gpt-image-1-generate`, `dalle-3-generate`, `gpt-image-2-generate`, `gpt-image-2-edit`).
- Frontend graph and node runs now show a native confirmation explaining that these nodes use `OPENAI_API_KEY`, bill the OpenAI API project, and do not use the ChatGPT subscription or Codex ChatGPT login.
- Backend `/api/execute`, `/api/execute-node`, `/api/graph/run`, and `/api/quick` reject unacknowledged OpenAI-direct image runs with HTTP 409, so CLI/agent-triggered runs cannot silently spend API money.
- Human CLI users can deliberately opt in with `NEBULA_ALLOW_OPENAI_API_BILLING=1` for `nebula run` / `nebula quick`; agents do not get that bypass by default.

## 2026-05-27 — CLI graph text output normalization

- While generating media from long prompt text nodes, `/api/graph/run` crashed before downstream image nodes executed because output normalization treated every string output as a possible file path and called `Path.exists()` on the entire prompt.
- Fixed output URL normalization to treat filesystem probes as best-effort: `OSError` from impossible path strings now means "not a media asset", preserving text outputs unchanged.
- Added a regression test so long text-output values do not break CLI graph execution while real output file paths still normalize to `/api/outputs/...`.

## 2026-05-27 — Codex agent ChatGPT-only auth

- Hardened the Nebula Codex runner so `codex exec` only starts when `codex login status` reports `Logged in using ChatGPT`.
- API-key, access-token, unknown, not-installed, and not-logged-in states now return a chat error before any Codex subprocess can run.
- Stripped `OPENAI_API_KEY`, `OPENAI_ACCESS_TOKEN`, and `CODEX_ACCESS_TOKEN` from the Nebula-owned Codex subprocess environment so an inherited shell credential cannot silently flip the agent back to API billing.

## 2026-05-27 — GPT Image 2 visible run feedback

- Diagnosed a Nebula UI feedback gap after adding the OpenAI API billing guard: if the native confirmation was cancelled or suppressed, the run returned before any visible node state changed.
- Node execution now marks the selected execution scope as `queued` immediately after confirmation so GPT Image 2 nodes show visible activity even before the first backend websocket event arrives.
- Queued nodes now render the loading block, and start/validation failures write a visible node error instead of only logging to the browser console.

## 2026-05-27 — Removed API billing confirmation blocker

- Removed the OpenAI-direct image billing acknowledgement as a run blocker. The user decided the confirmation was slowing down normal workflow and was not needed now that Codex-agent auth is ChatGPT-only.
- Frontend Run / Run This Node no longer opens a native confirmation dialog before GPT Image 2 direct execution.
- Backend `/api/execute`, `/api/execute-node`, `/api/graph/run`, and `/api/quick` no longer require `allowOpenAIApiBilling`, so CLI and agent-triggered runs use the same normal validation/execution path.
- GPT Image 2 direct nodes still use `OPENAI_API_KEY` and bill the OpenAI API project; this change only removes the extra acknowledgement gate.

## 2026-05-29 — Soul Cinema (Phase 0 + 1): cinematic pillars + Cinema Studio

Built overnight via a 7-wave dependency-ordered subagent workflow. The historical design spec was retired in the 2026-07-22 documentation cleanup and remains recoverable from Git history. The framing decision: Higgsfield Soul Cinema is a *stack* (cinematic base + Soul ID + Soul HEX + film-look + keyframe handoff), which maps 1:1 onto our node graph — so we add the two genuinely-missing pillars as deterministic local nodes and a multi-shot Studio editor, reusing existing models for everything else.

**Decisions made beyond the spec (collated from wave reports):**
- **`_parse_recraft_color` was extracted into `backend/cinema/color.py`** as the single source of truth and re-imported back into `execution/sync_runner.py` (the old inline def removed), so `from execution.sync_runner import _parse_recraft_color` stays valid for `test_fal_handler.py`. Honors "extract/share, don't duplicate."
- **sRGB↔CIELAB (D65) implemented in pure numpy** rather than adding a color-science dependency (honored "add nothing else but Pillow/numpy", both already pinned in the venv).
- **Grain determinism**: RNG seed derived from a sha256 of the look params + image dims (no wall-clock), so identical inputs → byte-identical noise. Same idea for the whole pipeline → `ExecutionCache`-friendly.
- **`lab-transfer` (default color method)** = Reinhard mean/std match in Lab **plus** a per-pixel nudge toward the nearest target swatch at `strength·0.5`. This is what makes the cool-blue grade keep the forge fires hot orange (visible in the smoke set) instead of a flat global tint.
- **`cinema-scene` stores its spec exactly like `remotion-node` stores its manifest** — `params:[]` in the catalog, the real `CinemaSceneSpec` lives on `data.params.scene` at runtime (there is no `object` param type and adding one was out of scope). The editor writes it via `graphStore.updateScene`.
- **`cinema-scene` base dispatch reuses the full `get_handler_registry` path** (synthesize a GraphNode, invoke the chosen base model's registered closure) rather than the `fal_universal` fallback — a clean internal base→color→look call. Reference images are fed into BOTH `image` (single) and `images` (multiple) ports since edit bases differ (flux-kontext vs nano-banana); handlers ignore ports they don't map.
- **License guard**: an empty/missing or FLUX.1-dev base model is substituted with `seedream-4-5` (commercial-OK) instead of crashing.
- **Per-shot output ports** use `isDynamic:true` + `dynamicOutputPorts` on node data (mirrors `configureOpenRouterModel`) so `useIsValidConnection` resolves them and Send-to-motion can wire a shot into a `veo-3` first-frame input.
- **New `cinematic` category + `palette` param type** required extending the contract validators (`scripts/check-node-contracts.mjs`, `backend/tests/test_node_contracts.py`) and the model-reference generator (`scripts/generate-model-reference.mjs`) — extending the allowed sets, not weakening any shape rule. `docs/MODEL_REFERENCE.md` regenerated (107 nodes).
- **Inspector palette extraction is client-side k-means** (deterministic seeding, 96px downscale) per spec latitude; no backend `/api/cinema/extract-palette` endpoint was added.

**Orchestrator fix after the build (the one bug self-verification couldn't catch):**
- **Port-id mismatch**: frontend `shotPortId()` produced `shot_<id>` while the backend handler produced `shot-<id>`. Unit tests + `tsc` both passed because it's a cross-process string contract. Aligned the **backend** to `shot_<id>` (`backend/handlers/cinema_scene.py` `_output_port_id` + the `test_cinema_scene.py` assertions) — underscore matches the codebase's port-id convention (`video_in`, `first_frame_image`). Re-verified: 55 cinema tests + contract check green.

**Known gaps for the next (interactive) session — needs the live app:**
1. **In-Studio preview round-trip (verify live).** The handler writes finished shot URLs onto `node.params['scene'].shots[*].output` AND returns per-shot port outputs. Canvas per-shot ports + downstream wiring update via the normal executed-output mechanism; the *in-editor* preview reads `scene.shots[*].output.imageUrl`, which only refreshes when the backend re-pushes the node's params via `graphSync` after `cinema-scene` completes. Confirm the backend emits that graphSync (or have the Studio also read from `data.outputs[portId]`).
2. **Live base→color→look end-to-end** was only exercised with a **mocked** base model. Run a real `seedream-4-5`/`nano-banana` scene with character refs against live keys.
3. **Variations strip** is a single-slot placeholder (handler emits one image/shot); populate when multi-output lands.
4. **Send-to-motion** gives only an inline "Sent ✓"; the new `veo-3` node isn't visible until you exit the Studio — consider auto-exit or a toast.
5. **Offline node-create** falls back to `model-node` type for `cinema-scene` (same limitation as `remotion-node`); online graphSync assigns `cinemaSceneNode` correctly.
6. Pre-existing: `backend/.venv` `pytest` console-script has a stale shebang (points at the old `Documents/Projects` path) — run tests via `.venv/bin/python -m pytest`.

**Out of scope (next spec):** Looks/preset library + Studio "Looks" gallery; `soul-cinema` SKILL.md + Codex/Daedalus agent wiring; ffmpeg video film-look; trained-LoRA / PuLID identity modes.

**Smoke proof:** `docs/soul-cinema-smoke/` — 11 PNGs from a real Athens golden-hour still (color transfers, all 5 film presets, 2 full-pipeline grades). All deterministic, generated with no server.

### 2026-05-30 — Fix: named presets were being clobbered by neutral default sliders

First live test surfaced a real bug: a `cinema-look` node with `preset='kodak-portra'` produced a near-unchanged ("just darker") image. Root cause (found via systematic debugging, evidence-first):

- `cinema.look._resolve_params` correctly lets **explicit** float sliders override a preset (this is intentional — per-shot Studio overrides rely on it; `test_explicit_param_overrides_preset` pins it).
- BUT the node always carries its slider params (catalog defaults `grain 0.2 / halation 0.2 / vignette 0.25 / contrast 0 / saturation 0 / temperature 0`), and the frontend forwards them even though `visibleWhen` only *shows* them for `preset==='custom'`. Hiding a control doesn't remove its value.
- So `_build_look` forwarded those neutral defaults as if explicit → they overrode kodak-portra's grade (`temperature 0.18, contrast 0.12, saturation 0.08`) back to **0**, leaving only a uniform vignette darken. Channel evidence: buggy `R−18 G−17 B−15` (uniform darken, no colour) vs correct preset-only `R−2 G−9 B−19` (warm R-vs-B separation).

**Fix at the build sites (intent is known there), not the pillar:**
- `backend/handlers/cinema_look.py::_build_look` — when `preset in PRESETS` (a real named preset), do **not** forward the float sliders; the preset's own bundle stands. `'custom'`/unset still forwards sliders. LUT always honored. (+5 regression tests in `test_cinema_look.py`, red→green; the existing pillar override test still passes.)
- `frontend/.../CinemaSharedControls.tsx` — selecting a preset chip now calls `selectPreset()` which sets `look = { preset: id }` (drops neutral sliders); `'custom'` restores editable sliders. Required making the `CinemaSceneSpec.look` slider fields **optional** (`types/index.ts`) — semantically correct: a named-preset look omits sliders, matching the backend "missing → use preset" behavior.

**Gotcha for re-testing:** `cinema-color`/`cinema-look` are deterministic and cached (`services/cache.py` `ExecutionCache`, in-memory). Re-running a node with identical params returns the cached result — switch the preset (or restart the backend, which clears the cache) to see a fresh render. Also: running a node re-executes its whole subgraph, so re-running a `cinema-look` wired off a `gpt-image-2` node will re-generate the (paid) base image; wire film-look off a static image-input to iterate for free.

**Follow-up (not done, user's call):** the node/scene default preset is `'custom'` (subtle grain+vignette, no colour) — consider defaulting to a named preset like `kodak-portra` so a freshly-dropped node obviously "does the film thing."

### 2026-05-30 — Canvas ↔ Studio parity for character refs

User principle: "what happens in the node view should happen in all views and vice versa." Gap found while testing: an image wired into the `cinema-scene` node's `character_refs` port on the canvas was used by generation (the handler reads `inputs['character_refs']`) but was **invisible** in the Studio's CHARACTER REFS box (which only rendered uploaded `scene.character.refImageUrls`).

- `CinemaStudioView` now resolves canvas edges into the node's `character_refs` port to image URLs (robust to both a generated source — `data.outputs[handle].value` — and a static `image-input` — `data.params._previewUrl`/`filePath`, whose `outputs` may be empty until run) and passes them to `CinemaSharedControls`.
- `CinemaSharedControls` renders connected refs read-only with a 🔗 badge (disconnect on the canvas to remove); uploaded refs keep their × remove button.
- Reverse direction: `CinemaSceneNode`'s card summary now shows the uploaded-ref count (`2 shots · 1 ref`), so refs added inside the Studio are reflected on the canvas (connected refs already show as the edge).
- Verified live: constructed `image-input → cinema-scene:character_refs` via the API and ran the exact resolution logic against `/api/graph/export` → resolved the ref URL; tsc + vite build clean.

### 2026-05-30 — Krea 2 direct provider plan

- Created branch `codex/krea-2-direct-provider` from the current dirty `main` state as requested; unrelated existing worktree changes are being left untouched.
- Scope decision: implement Krea direct API only. FAL Krea endpoints are intentionally skipped for this goal even though they exist, because Krea-native style IDs, moodboards, assets, and style training are not covered equivalently by the generic FAL node.
- Node-family decision: add one main `krea-2-generate` node plus Krea resource wrapper/training/search nodes. This keeps simple prompt-to-image easy while allowing graph-native use of `image_style_references`, `moodboards`, and `styles`.
- Moodboard limitation: verified Krea docs expose moodboard use by ID but no public create/list moodboard endpoints, so Nebula will model moodboards as existing-ID wrapper nodes and direct fallback params.
- Asset handling decision: local or generated images connected as Krea style references will be uploaded internally via `POST /assets`; users should not have to paste URLs for normal graph workflows.
- Shipped direct Krea implementation: `krea-2-generate`, `krea-image-style-reference`, `krea-style`, `krea-moodboard`, `krea-style-search`, and `krea-style-train`.
- `krea-2-generate` accepts raw image style inputs and typed Krea resource objects together; the handler merges them into Krea's documented `image_style_references`, `styles`, and `moodboards` request fields, enforcing max 10 image refs and max 1 moodboard.
- Style training uploads local graph images to Krea assets before calling `/styles/train`, polls `/jobs/{id}`, emits a reusable style object, and optionally shares the style with the API workspace.
- Verification: Krea handler tests, node registry/contract tests, Codex skill bootstrap tests, full backend suite (`827 passed`), frontend production build, and `git diff --check` all passed. No live Krea smoke was run because no `KREA_API_TOKEN` was available in this session.

### 2026-05-31 — Krea agent skill

- Added/expanded the project-local Krea agent skill at `.agents/skills/krea/SKILL.md` so Codex/Daedalus agents know the direct-Krea node IDs, graph wiring patterns, resource wrapper shapes, API key naming, and Krea-specific live-test caveats.
- Kept the skill as one concise `SKILL.md` rather than adding extra docs, because detailed provider research already lives in `docs/model-providers/krea/krea-2.md` and skills should stay lightweight.
- Included the `402` API-balance caveat from live testing: a valid Krea token can authenticate and still fail generation until the separate API balance is topped up.

### 2026-05-31 — Native Moodboard Studio

- User chose Nebula-native moodboards rather than Krea-owned moodboards. Decision: make Moodboard a first-class Nebula resource and port type; Krea is only a downstream adapter.
- First canvas mirror is a custom `nebula-moodboard` node/card with grouped visual state and multiple outputs (`Moodboard`, style brief, negative prompt, images, palette). True React Flow parent/child grouping is deferred because the current graph persistence path does not carry parentId/extent/group metadata.
- Analysis starts as deterministic local extraction: resolve Nebula-local images, extract palettes with the existing CIELAB k-means code, and produce an editable creative-direction object. The schema is intentionally richer than the local analyzer can fully populate so a future vision-model analyzer can fill materials, motifs, and semantic cues without changing stored resources.
- Krea integration consumes native Moodboards by adapting representative images to `image_style_references` and appending the extracted style brief to the prompt. We still keep Krea-owned moodboard IDs as their own `krea-moodboard` wrapper because Krea does not expose public create/list moodboard endpoints.
- Browser smoke used the existing local backend (`127.0.0.1:8000`) and Nebula Vite dev server (`127.0.0.1:5180`) in Chrome. A temporary "Smoke Moodboard" verified library listing, Studio loading, canvas node mirroring, and Analyze output; the temporary moodboard, canvas nodes, and generated test image were removed afterward.
- Follow-up fix: the Studio "Add Images" action no longer relies on a script-triggered `.click()` against a hidden file input. It is now a native file input inside the visible label with the input layered above the styled text, so normal mouse clicks hit browser-native file picker behavior. Drag/drop still uses the same upload path.

### 2026-06-03 — Surface-hardening sweep (lands on `main`)

- **Dead code:** removed two stale Finder "Add Copy" duplicates — `CinemaStudioView 2.tsx` and `CinemaSceneNode 2.tsx`. Both were untracked, older-and-smaller copies; `diff` confirmed each held nothing the real file lacked (`CinemaSceneNode 2.tsx` predated the `refCount` card summary). Repo now has zero `* 2.*` artifacts. Untracked → deletion leaves no git diff, so the work shows only as the files' absence.
- **Real bug surfaced by a lint audit (`TimelineRuler.tsx`):** a *bare* `react-hooks/exhaustive-deps` disable was masking a defect. The thumbnail effect keyed on `[sourceUrl, sourceDuration]`, but its sample set derives from `stepCount` (← `totalOutputDuration`), and `Timeline.tsx` mounts the ruler without a `key`. So editing clips (which changes output duration) shifted the sample times without re-running the effect → placeholder thumbnails. Fix: add `stepCount` to deps. Safe because `getThumbnail` (`lib/editor/thumbnailStrip.ts`) caches by `sourceUrl|time|width`, so a re-sync only fetches genuinely-new times (≤13, capped). Kept the disable (the true dep is the `sourceStepTimes` array, fresh each render) but replaced the bare suppression with a justification comment. Shipped as commit `5647fb7`.
- **Discipline — distinguish "intentional suppression" from "hidden bug":** of the disables a grep flagged as bare, the two `CharacterStudioView` ones were already justified, `MoodboardStudioView`'s loader disable was correct-but-undocumented (got a comment mirroring its Character twin), and only `TimelineRuler`'s was an actual bug. The right move was reading each effect, not papering every disable with a "looks intentional" comment — that would have buried the real defect.
- **Cruft:** dropped a leftover `console.log('[zoom-manifest] init', data)` in `useZoomManifest.ts`. Removing only the log line would orphan the `data` param (→ `no-unused-vars`), so the init call was collapsed to fire-and-forget and the now-vestigial `cancelled` flag removed.
- **Surface otherwise clean:** 0 `as any` / `@ts-ignore` / real `: any`; the ~55 `console.*` calls are deliberate `warn`/`error` in catch handlers; gates green (eslint, `tsc -b`, 322/322 vitest).
- **Process gotcha (shared working tree):** this spanned a live branch. A concurrent session merged `chore/harden-surface` into `main`, deleted the branch, and kept committing to `main` — all in the *same* working tree (it switched this tree's HEAD out from under me). My fix landed on `main` because I checked the HEAD commit but not the branch *name* before committing. Kept on `main` per user (matches the now-trunk-based flow). Lesson: re-verify `git branch --show-current` immediately before committing when a tree may be shared, and isolate parallel work in a `git worktree` rather than switching the shared tree's branch.

### 2026-06-03 — Create P4 polish (branch `feat/create-p4-polish`)

Two features + a post-review hardening pass. All on `feat/create-p4-polish`, not yet merged.

- **Concurrent generations (commit `4b5f08e`):** the Create view can run up to 2 generations at once. Key decision: the global `isExecuting` lock (which Canvas/Toolbar/Inspector rely on for one-at-a-time canvas Run) is left *completely untouched*. New `executeClusterConcurrent(nodeIds)` in `graphStore.ts` is a sibling of `executeCluster` that never reads/sets `isExecuting` and never calls global `resetExecution` — it marks only its own idSet `queued`, POSTs the cluster, and errors only its own nodes on failure. The cap is enforced *Create-locally* (`MAX_CONCURRENT = 2`) via an `activeCount` derived from node states. Layout Y uses a synchronous `genIndexRef` counter (not `generations.length`, which is stale across rapid fires under React batching).
- **Real preset thumbnails (commit `81bba74`):** chose "generate once via the app, commit WebPs" over first-run generation or static placeholders (user's call — it reverses the earlier P3 "no shipped binaries" stance, but the binaries are tiny). `scripts/generate_preset_thumbnails.py` dogfoods `POST /api/quick` (nano-banana) for each of the 12 seed prompts, downscales to 640px WebP (q82, ~6–81 KB each, ~520 KB total), writes `data/presets/thumbnails/<slug>.webp`. `slug_for_preset()` lives in `preset_store.py` as the single source of truth shared by the generator (filename) and the seeder (URL) so they can't drift. Served by a new `GET /api/presets/thumbnails/{slug}` (slug regex + resolve/relative_to traversal guard, `FileResponse`). `backfill_preset_thumbnails()` runs every boot to fix installs seeded before thumbnails existed.
  - *Gotcha during generation:* `/api/quick` returns the output as an **absolute filesystem path**, not a `/api/outputs/...` URL — the first run silently 404'd on download because I built `http://localhost:8000<abspath>`. Fix: read absolute-path refs straight from disk. (The 12 generations had actually succeeded; only the download leg failed.)

- **Post-review fixes (commit `[pending]`):** a code-review pass flagged 4 issues; 3 fixed, 1 deferred.
  - *Fixed — thumbnail URL resolution (the important one):* generated media render through `backendAssetUrlSync` (rewrites `/api/outputs/` → the *discovered* backend origin), but seeded thumbnails were left as relative `/api/presets/thumbnails/...` and only worked in dev by accident (Vite proxy → :8000). They'd 404 whenever the backend isn't same-origin/on-8000 (packaged shell, alt port), with the `onError` gradient masking the failure. Fix: generalized `backendAssetUrlSync`/`isLocalBackendAssetUrl` to a `BACKEND_ASSET_PREFIXES` list covering both `/api/outputs/` and `/api/presets/thumbnails/`; `PresetCard` now resolves `preset.thumbnail` through it.
  - *Fixed — concurrency cap TOCTOU:* `activeCount` can't see a new generation's nodes until they're in the store, so a rapid second click could pass the cap during the `authorGenerationCluster` await. Added a synchronous `launchingRef` counter; the cap gates on `activeCount + launchingRef.current`. (Residual: a sub-render-cycle staleness window remains if `activeCount` lags by a full unit with exact timing — bounded and harmless since the backend handles disjoint node sets; the dominant network-RTT window is closed.)
  - *Fixed — backfill clobber:* backfill matched seeded presets by name and overwrote any thumbnail that differed from the shipped URL — so a user's *global* preset that happened to share a seed name + a custom captured thumbnail would be silently overwritten every boot. Fix: only fill *empty* thumbnails (`if preset.get("thumbnail"): continue`). Also naturally idempotent (post-fill it's non-empty → skipped, no version churn).
  - *Deferred — `graphComplete` clears the global lock unconditionally (KNOWN LIMITATION):* `handleExecutionEvent`'s `graphComplete` case does `set({ isExecuting: false })` regardless of which run emitted it. Since `executeClusterConcurrent` never *sets* the lock, a concurrent Create generation finishing will now *clear* a lock that a canvas Run set — but only if the two overlap (start a canvas Run, switch to Create, generate). Consequence is an early lock release (a second canvas Run could overlap), not data corruption (backend runs are independent per disjoint node sets). A correct fix needs backend run-scoped events (`run_id` on each `ExecutionEvent`, frontend clears only the matching run) — that's a real change to the engine + event types + WS handling, out of scope for this polish pass. Flagged to the user as a follow-up rather than bolting on a fragile attribution-less counter.

- **Gates:** backend `887 passed`; frontend `tsc` clean, `331` vitest (42 files), lint (inline-style + slava-scope + eslint) clean, build clean. Node-def contracts untouched (no node-def changes in P4).

### 2026-06-03 — Image lightbox (same branch, follow-up to user feedback)

User asked to click a result image and see it fullscreen. Added a `Lightbox` component to the Create results gallery.

- **Component:** `Lightbox.tsx` renders into `document.body` via `createPortal` (so it sits above the canvas + every panel; `body` carries `app-slava-restraint`, so the scoped CSS still matches). Closes on Esc / backdrop click / X; `←/→` (and edge chevrons) step through the gallery's viewable items; a "n / N" counter; body scroll locked via a `lightbox-open` class (not an inline style — keeps the `check:inline-styles` guard happy). Clicking the media `__stage` stops propagation so it doesn't close.
- **What's zoomable:** `firstViewableMedia(node)` in `createGallery.ts` (the single source for "what would the lightbox show") returns the completed node's Video (preferred) or Image/SVG, else null — mirroring OutputRenderer's order. `ResultsGallery` builds a `viewable[]` in card order so a clicked card maps to a lightbox index and the arrows step through exactly what's on screen; switching the Session/Canvas tab closes the lightbox (the viewable set changes).
- **Affordances (`ResultCard`):** images get a full-area transparent overlay button (`zoom-in` cursor) so a click anywhere opens the lightbox; **video gets only a corner expand button** (not a full overlay) so the native video controls stay usable. The overlay sits at `z-index:1`; the actions bar was bumped to `z-index:2` so Download/Delete/etc. stay clickable over it.
- **Tests:** `firstViewableMedia` (6 cases incl. video-precedence, SVG-as-image, object `{url}`, not-complete → null); `Lightbox` (image/video render, Esc/backdrop/stage-click, arrow nav + prev hidden at index 0, scroll-lock on/off); `ResultCard` (image → overlay+btn, video → btn only, text/incomplete → neither). Frontend now `347` vitest (44 files); lint + build clean.

### 2026-06-08 — Replicate SSE token streaming (audit gap #2)

Closes the "Replicate real-time streaming (urls.stream)" capability gap. Text/LLM models on Replicate now stream token deltas live in the UI; image/video/audio/mesh models are unchanged (poll as before). **Frontend: zero changes** — the `StreamDeltaEvent → _event_to_camel → streamDelta → node.data.streamingText` pipeline already existed for the chat nodes; only the Replicate handler had to learn to consume the stream.

**Decisions / non-obvious calls:**
- **Auto-detect, no user toggle.** Replicate's own model is "the prediction response carries `urls.stream` iff the model streams" (the legacy `stream: true` request flag is deprecated). So the handler streams when `urls.stream` is present AND an `emit` is wired, else polls. No new node, no new param, no node-def change → contract parity untouched.
- **A dedicated raw-text SSE consumer (`stream_execute_replicate`), NOT the existing `stream_execute`.** Replicate `output` events carry RAW TEXT in `data:` (a token delta); Anthropic/OpenAI/OpenRouter carry JSON. Reusing the JSON path (`json.loads(data)`) would silently drop every non-JSON token. The new consumer concatenates `output` data verbatim (joining multi-`data:`-line events with `\n` per the SSE spec), raises on `error` (surfacing JSON `detail`), and stops on `done`. The existing JSON `stream_execute` is untouched (chat-stream tests stay green). Regression-guarded by a test that feeds `{not valid json` and asserts it's taken verbatim.
- **Handler self-submits; extracted `poll_until_terminal` from `async_poll_execute`.** To inspect `urls.stream` you must create the prediction first — but you can't double-submit. So `async_poll_execute` was split into submit + a public `poll_until_terminal(client, config, task_id, …)` (behavior-preserving; guarded by the existing 15 async-poll/Runway/Replicate tests). The handler now POSTs once, then either streams or calls `poll_until_terminal` on its own client. This rewrote the 5 old replicate tests that mocked `async_poll_execute` (they encoded the old delegate-everything design) into httpx-level tests of the real submit→stream/poll flow. Note: `patch("handlers.replicate_universal.httpx.AsyncClient")` patches the shared `httpx` module singleton, so it also covers the runner's client — convenient for the non-stream tests.
- **Cancel propagation on the streaming branch.** `CancelledError` mid-stream schedules a detached `POST .../predictions/{id}/cancel` (reusing `_cancel_async_poll` + `schedule_detached_cancel`) before re-raising, matching the polling path's upstream-cancel so a cancelled stream doesn't leak a running (billable) prediction.
- **Honest scope:** this helps only Replicate *language-model* nodes — a minority of Nebula's Replicate usage. It's UX polish for text gen, not a broad capability. The SSE 30s idle reconnect (`:408` keepalive / `Last-Event-ID`) is NOT implemented; long-idle generations could truncate — documented as a known limitation, deferrable since v1 targets normal-cadence text gen.

**Verification:** backend `pytest` **927 passed** (was 918 + 9 new replicate/stream-consumer tests, 0 regressions). **Live-verified** against the real Replicate API (`meta/meta-llama-3-8b-instruct`, key loaded from `settings.json`, never printed): a 220-token generation produced **46 delta events over a 2.23s span, time-to-first-token 0.84s, spread across 38 distinct 50ms windows** — genuinely incremental token streaming through the real handler, not a buffered burst. Accumulated text verified as a monotonic prefix; final output routed to the `text` port.

### 2026-06-08 — Veo video extension (audio gap #5), and why reference images were dropped

Closes the "Veo extension" half of gap #5. The `veo-3` node (Google direct path, `backend/handlers/veo.py`) gained a `video` ("Extend Video") input + a `source_uri` output so a clip can be continued in-graph. **Reference images ("ingredients to video") were implemented per the canonical docs, then REMOVED after live testing proved the public API doesn't support them on this key.** This entry is mostly a record of how live verification overturned the docs research — twice.

**What the docs said vs. what the live API does (key loaded from `settings.json`, never printed):**
- **Billing:** metadata probe (models.list) only proved the key *sees* Veo. The first real generation confirmed the project has **paid-tier billing** — text→video succeeded (32s, 2.5 MB). Not a blocker after all.
- **Reference images — docs WRONG twice.** (1) The canonical example nests bytes under `image.inlineData`; live API → **400 "`inlineData` isn't supported by this model."** Switched to the `bytesBase64Encoded` shape the first/last-frame fields already use. (2) That got past the shape error into **400 "Your use case is currently not supported"** — on BOTH `veo-3.1-generate-preview` AND `veo-3.1-fast-generate-preview`. So "ingredients to video" is simply not enabled on the public Gemini API for this AI-Studio key, regardless of request shape. **Decision: remove the `reference_images` port entirely** rather than ship a port that always 400s (shipping-broken = worse than not-shipping). A code comment + the gemini skill document the exact shape to re-add if Google enables the use case.
- **Extension — docs' "biggest risk" materialized, but a working path exists.** The realistic in-graph path (upload a local/downloaded clip via the Files API, pass as `video.uri`) is **rejected: 400 "Input video must be a video that was generated by VEO that has been processed."** Veo only accepts the **original generation's** `files/...` URI, not re-uploaded bytes — even bytes that Veo itself generated. The Files-API-upload path is dead; **removed `_upload_video_to_files`/`_resolve_video_bytes`.** Passing a base generation's own `video.uri` **directly** works (live-verified).

**Design that makes extension usable in-graph:** Nebula downloads + discards the Veo `files/...` URI today, so a downstream node had nothing to extend. Fix: `handle_veo` now also returns `source_uri` (the generation's `files/...` URI) as a second `Video`-typed output. Wire **upstream `veo-3.source_uri` → downstream `veo-3.video`** to continue a clip. The handler accepts only a `files/...` URI on the `video` input (else a `ValueError` tells the user to wire `source_uri`, not the downloaded `video` output). Guards: extension is `veo-3.0`/`3.1` generate+fast only (not lite/veo-2.0), can't combine with `image`/`last_frame`, and `resolution` is force-overridden to **720p** (the API locks extension to 720p). Source URI is valid ~2 days (already noted in the skill).

**Decisions / non-obvious calls:**
- `source_uri` is typed `Video` (not `Text`) so the edge validates straight into the `Extend Video` (`Video`) input; the value it carries is the URI string, which the handler detects by the `generativelanguage.googleapis.com/.../files/` pattern.
- The node now has two `Video` outputs (`video` = downloaded file for normal downstream use; `source_uri` = the extend handle). Labels disambiguate; wiring the wrong one fails with a clear message.
- Reference-image guards/sets (`VEO_REFERENCE_MODELS`, `_image_to_inline_data`) were added then removed in the same session — the git diff won't show them, but they're why the `bytesBase64Encoded`-vs-`inlineData` lesson is recorded here.

**Verification:** backend `pytest` **935 passed** (+8 veo tests, 0 regressions); `check-node-contracts --check` green for **123** node defs (node_definitions.json ↔ frontend nodeDefinitions.ts in sync; `MODEL_REFERENCE.md` regenerated). **Live end-to-end through the SHIPPED handlers:** `handle_veo(base)` returned a clip + `source_uri`; feeding that `source_uri` into `handle_veo(extend)` produced a continued 2.8 MB clip. Reference-image generation confirmed rejected on both 3.1 models (the reason it's not shipped). ~6 paid Veo generations total during verification.

### 2026-06-08 — Review-caught fixes for gaps #2 + #5 (adversarial review pass)

A 16-agent adversarial review (3 dimensions → per-finding verify) surfaced 13 findings, 12 confirmed. Fixed the substantive ones; the trivial/by-design ones are documented. Final: **940 backend tests** (+5), contract green (123), frontend `tsc` clean.

- **Replicate SSE abnormal-close robustness (the one that mattered, medium).** The consumer returned silently-**truncated** text as a *success* if the stream closed before `done` (idle timeout / dropped connection), and swallowed a bare `error` event (no `data:` line). Rewrote the dispatch: a buffered event now flushes at **every** boundary (blank line, next `event:` line, or end-of-stream), a bare `error` raises, and a premature close (no `done`) **fails loud** instead of reporting partial text. Emitted deltas still surface live before the failure. RED→GREEN with 5 new tests (multi-line `data:` join, `id:`/`:`-comment skip, premature-close-raises, trailing-output-flush, bare-error-raises).
- **Replicate `task_id` fail-fast (low).** Self-submit used `submit_data.get("id")` → `"None"` on a malformed 2xx submit (the old `async_poll_execute` path raised via `_get_nested`). Restored fail-fast with an explicit guard.
- **Cancel-test warning (low).** `_cancel_async_poll` was auto-mocked as AsyncMock, so the test's lambda built an un-awaited coroutine (`RuntimeWarning`). Patched it as `MagicMock` — warning gone (suite warnings 3→2; the remaining 2 are pre-existing in `test_async_poll_runner`).
- **Veo `source_uri` ordering guard (low).** The frontend video preview picks the first `Video`-typed output by insertion order; added a test pinning `video` before `source_uri` so a refactor can't silently make the preview select the auth-gated API URL.
- **Doc sync — `veo.md` skill topic file (medium).** It still showed reference images as usable and extension wiring as "feed via a Video port." Added a ⚠️ "NOT EXPOSED IN NEBULA" caveat over the reference-images section and corrected the extension note to `source_uri → Extend Video`. Synced both copies (`.claude/` + `.agents/`).
- **By-design, documented (not changed): `source_uri` is `Video`-typed but carries an auth-gated `files/...` URI.** It must be `Video` so the edge validates into the `Extend Video` (Video) input; wiring it into a *non-Veo* Video sink fails confusingly (401/file-not-found). Mitigated by the port label ("Source URI") + `_note`, and the ordering guard keeps the node's own preview on the playable `video` output. A dedicated `VideoRef` port subtype (frontend `portCompatibility` + colors) is the clean long-term fix — deferred as it's a deliberate mis-wire of a clearly-labeled port, not a main-path bug.
- **Deferred (low, documented limitation): no SSE `Last-Event-ID` reconnect** for Replicate's 30 s idle gap — a long idle now fails loud (above) rather than truncating silently, which is the safe behavior; true reconnect is a follow-up.

### 2026-07-22 — Run-scoped execution lifecycle events

- **Goal selection:** the next autonomous pass is the documented Create/Canvas concurrency race: a `graphComplete` from `executeClusterConcurrent` can currently clear the global Canvas `isExecuting` lock and close the wrong run-history record. Finishing the remaining provider audit would require paid calls and additional credentials, so it is not the next fully autonomous goal without a spend decision.
- **Contract:** every frontend-started graph, node, concurrent Create, and Cinema-shot execution gets a UUID `runId`. The backend accepts it on the request and includes it on all execution WebSocket events. Events without a `runId` remain supported for CLI/legacy callers.
- **Async propagation:** handler-emitted progress/stream events bypass the engine's direct `emit` callback, so tagging only the engine's own event constructors would be incomplete. The backend uses a task-local `ContextVar` while an execution is active and resolves the current `runId` during WebSocket serialization; explicit validation events carry it directly because they occur before `execute_graph` starts.
- **Frontend ownership:** node state updates still apply for all events, but only a lifecycle event whose `runId` matches the active global Canvas run may clear `isExecuting` or close its history record. Concurrent Create/Cinema completions can still notify and clean their own error bookkeeping without touching the global lock. Missing `runId` preserves the prior single-run behavior for backwards compatibility.
- **Verification:** backend `1167 passed` with the same two existing AsyncMock warnings; frontend `397 passed`, lint, TypeScript, and production build passed. The build retains its existing `lottie-web` direct-eval and large-chunk warnings. No paid provider call ran.

### 2026-07-22 — Hunyuan3D contract and freshness pass

- **Goal selection:** Phase 2 provider auditing remains the repository's explicit next milestone, but the complete remaining matrix includes paid live calls. Hunyuan3D is a bounded two-node FAL slice whose live schemas, request bodies, and output contract can be fully reverified without inference spend.
- **Canonical finding:** the live FAL v3 schemas still match Nebula's endpoint, port, parameter, and output mappings. They expose `seed` in the response only, not as an accepted input. The older provider note and image-to-3D skill incorrectly described it as a missing reproducibility knob; both skill mirrors and the audit note are corrected.
- **Runtime hardening:** the fixed Hunyuan wrappers now route through an isolated `GraphNode` copy instead of mutating persisted params with `endpoint_id`. Text-to-3D also rejects prompts over FAL's documented 1024-character maximum before queue submission.
- **Parity scope:** add one gold exemplar covering both nodes plus separate text and four-view image golden request fixtures. Fixture capture runs through the real registry wrappers and FAL universal body builder; no provider request or paid generation is made.
