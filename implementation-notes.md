# Implementation Notes

## 2026-10-09 — Krea full coverage: enhance, 3D, account mode for styles and moodboards

- Scope changed after the audio work: the user asked to connect every Krea capability except API token admin. The phase table lives in `docs/model-providers/krea/krea-full-coverage.md`; this entry covers phases 1, 2 and 4.
- Enhance (18) and 3D (10) came in through the same generator. Enhance outputs Video when the route takes `video_url`, otherwise Image, and is categorized `transform`. Krea's MCP serves every enhance model, including video upscalers, through `enhance_image`. Krea tags every route's primary output `type: model`, so result parsing ignores that tag and uses the route's media type (an earlier mapping of `model`→Mesh broke video outputs).
- The frontend decided "Krea account capable" from an id/endpoint regex limited to image/video, so audio/enhance/3D nodes silently missed the default-mode and sign-in checks. It now reads the definition's `_kreaAuth` param (`supportsKreaAccount`, `usesKreaAccount`, `isKreaAccountOnly`). The engine's credential check and the cache-key revision did the same thing via `catalog_models()`; both now use `services/krea_account.uses_account`.
- `services/krea_account.py` holds the account plumbing for non-generation tools: exact-argument calls validated against the live tool schema, local-media upload, and a run-job helper that cancels on early exit. `krea_mcp_generation.py` was split into reusable `upload_asset` / `poll_job` helpers for this.
- Krea 2 Generate on the account path builds the same body as before, keeps local references as paths, and hands it to the gateway's new `run_gateway` for the matching `krea-image-krea-krea-2-{variant}` route. That reuses discovery, live-schema binding, uploads, polling and cancellation instead of a second Krea 2 implementation. The API-token path is unchanged.
- Account paths refuse controls they cannot honor before any request, rather than dropping them: Style Train (learning rate, batch size, steps, `Default` type, workspace share), Style Search (`filter`, `user`, `liked`). The API path refuses account-only training models (`k1`, `ltx-23-22b`).
- New nodes: Krea Moodboards and Moodboard Create are account-only (`_kreaAuth` with a single `mcp` option, `envKeyName: []`), because Krea's API has no moodboard endpoints. Library Manage renames/deletes styles and moodboards; deletes need an explicit Confirm delete switch so a copied recipe cannot remove library items, and IDs are restricted to `[A-Za-z0-9_-]` because the API rename puts the ID in the URL path.
- Tool schemas for list/create/update/delete style and moodboard were copied from the live MCP `tools/list` into `tests/fixtures/krea_mcp_tools.json`. Live read-only checks: `list_styles` → `{styles: [], next_cursor: null}`, `list_moodboards` → 11 presets.
- Changed a frontend test that pinned the old rule "legacy Krea nodes stay API-only even when signed in"; it now pins that they follow the saved choice and that old recipes without the param keep the API token.
- 3D export (phase 3, `handlers/krea_export.py`): API-token only because Krea has no MCP export tool. The ZIP is downloaded without credentials and unpacked with explicit checks (no absolute/parent paths, backslashes or symlinks; ≤500 entries, ≤500 MB download, ≤1.5 GB unpacked) instead of `extractall`. PLY is not in Nebula's Mesh allowlist, so a PLY export fills `file`/`files` and leaves `mesh` empty rather than widening the viewer's formats.
- The export node's docUrl is `krea-gateway.md#3d-export`, not the bare gateway doc: `sync-krea-catalog.py` treats every node whose docUrl equals the gateway doc as generated and would delete it on the next refresh.
- Library Manage is categorized `analyzer`, not `utility`: `utility` is reserved for local nodes covered by `docs/utility-node-test-manifest.json`.
- `tests/test_reference_roles.py` fingerprints the original node contracts. Added exact approvals for the prepended `_kreaAuth` param on the three original Krea nodes and the four appended training models, in the same style as the existing approvals, rather than refreshing the baseline.
- Krea `/usage` needs an enterprise workspace service key and refuses personal API keys; that shapes phase 11.
- Count pins: registry 289→293.

## 2026-10-09 — Krea audio models

- Added because the Krea announcement video opens on music generated through Nebula's Krea connector, and the connector could not generate audio. Built on `feat/krea-audio-models` from `main`, separate from the dirty Design-agent checkout.
- Extended the existing generator (`scripts/sync-krea-catalog.py`) to include `/generate/audio/` routes as `audio-gen` nodes with `audio`/`audios` outputs. Enhance (18 routes), 3D (10) and node apps stay out: they need different input/output node shapes, not just another prefix.
- The refresh came from Krea's live OpenAPI (2026-10-09), so it also brought in what Krea changed upstream since the 2026-10-03 pin: new `krea-image-google-nano-banana-2-1`; Ideogram 4.5 Precise `quality` is now `very_low…high` (no `very_high`, so a saved graph using `very_high` will fail schema validation before spend); Gemini Omni Flash 1.1 `reference_videos` max 1→3; Flux 1 Dev's published random seed default changed (Krea regenerates it per fetch — expect this churn on every refresh).
- Account path: Krea MCP exposes `generate_audio` with the same `model`/`input`/`sync` contract as image/video (checked live with read-only `get_model_schema` for `elevenlabs/music-v2.5`, endpointPath `audio/elevenlabs/music-v2.5`). Added that tool to the captured fixture and mapped the `Audio` category.
- Result parsing now labels a tagged `audio` URL as Audio. Before, an `audio` key on a video route would have been materialized as a Video artifact.
- Count pins updated: gateway 74→80, registry 255→261 (`test_video_qc_nodes`). `.claude/skills/krea/SKILL.md` is the older legacy-node skill and was left alone; `.agents/skills/krea/SKILL.md` is the current one and was updated.
- Validation: 3,489 backend, 1,684 frontend, desktop node tests, lint/style guards, production build/budget, catalog `--check`, 261 node contracts and regenerated MODEL_REFERENCE.

## 2026-10-07 — UI audit repairs

- Reuse the isolated `codex/audit-web-fixes` worktree and preserve its existing functional repairs. The parent checkout and its parallel brand-system work stay untouched; packaged Electron remains outside this task.
- The user explicitly removed alternate themes from scope: retain the current Slava Restraint appearance, normalize old saved theme choices, and remove automatic theme changes when switching agents.
- Consolidate canvas zoom/fit controls, count, and minimap at the bottom-right so the navigation rail owns the left edge. Keep zoom/fit and count available independently of the large-graph rendering preference; that preference still controls offscreen rendering and minimap visibility.
- Fix shared workspace layering and graph file-action ownership rather than leaving Create buttons/commands that silently do nothing. Browser checks use isolated empty state and blocked generation handlers.
- Opening Chat can precede socket readiness, so its preferred textarea may be disabled. Focus the next enabled control immediately; later connection readiness must not steal focus from user interaction. Reopening the still-mounted connected dock prefers its enabled composer. Settings and Chat remain nonmodal; the model picker traps Tab.
- Final validation: 993 frontend tests, full lint/inline-style/CSS-scope guards, TypeScript production build and bundle budget pass. Native browser checks cover clean/populated canvas navigation, minimap collapse and performance preference, compact drawer at 200%, picker search/provider visibility at 200%, Settings/Chat above Create, Escape, and Daedalus retaining the same appearance.
- Save/Open shortcuts from Create reach real native pickers. Native file completion remains unverified: Dia leaves Save/Open disabled here, including an independent unfiltered Save probe in the same writable private folder. Cancelled the dialogs; no speculative file-filter change. Automated tests cover routing, serialization, cancellation, guarded atomic import and history retention. The existing screenshot CDP harness was updated and syntax-checked, but not executed; all live UI checks used computer use.

## 2026-10-07 - Web/backend audit repairs

- Reuse the clean managed publication worktree, starting `codex/audit-web-fixes` at published main `998ad87c`. The active Design-agent checkout and its separate brand work remain untouched. Repair the seven web/backend findings; the user explicitly excludes packaged Electron, so the four desktop findings are deferred.
- Use the frozen development lifecycle implementation as a reference for Create/Cinema ownership, Stop, event filtering and reload reconciliation. Selectively port the required behavior rather than merging the dirty development checkout. Preserve published Paper/Krea paths, immutable source snapshots, historical recipe parameters and explicit rerun semantics.
- Verify paid-generation paths with deterministic provider stubs and real local media processing. No new paid jobs are needed. Dependency maintenance uses a separate private install; keep audit evidence and personal state outside Git.
- Iterator repair follows the documented per-item downstream workflow. Preserve scalar port values; carry cumulative batch outputs separately for history and use per-invocation artifact directories so fixed handler filenames cannot overwrite earlier items. Reject independent iterator joins before execution instead of silently inventing Cartesian paid-generation semantics.
- Do not add broad backend locking by node ID: IDs are recipe-local and concurrent Cinema variations intentionally reuse scene nodes. Shared frontend run ownership blocks conflicting Canvas/Create writers while disjoint jobs and explicit Cinema variations remain possible.
- Saved Cinema ports require authoritative reconstruction at both frontend load and backend typed graph ingress/execution validation. Derive Image ports only from persisted scene shot IDs; preserve saved edges and reject removed/fabricated handles rather than accept a wildcard. Create eligibility uses one predicate for normal, Featured and search lists, excluding unsupported required video/audio and second-image inputs while retaining optional alternatives.
- Frontend dependency maintenance uses exact compatible patched versions and canonical npm publication dates. Keep transitive Chai/tinyrainbow on mature compatible versions instead of accepting newly published releases. The only patched source-map-js release is dated 2026-09-30, so retain 1.2.1 until it satisfies the repository's 14-day rule; its advisory remains visible rather than suppressed. Use a private mature npm 11.13.0 CLI after installed npm 11.4.2 fails peer-tree resolution; no global runtime or parent dependencies change.
- Batch success remains accessible through Run History with per-item results, while normal canvas ports continue showing the current scalar result. Preserve immutable cumulative batch results on later failure/Stop and reload. Scene edits prune only deleted-shot outputs on the current Cinema node, consistent with its removed handles/edges; earlier shot/run history remains intact.
- Batch handlers receive the saved initial recipe for each item, then mirror the latest runtime metadata to Canvas. Nested expansion remains bounded by the declared iterator cap (maximum 25); failures stop that node's remaining items and block its consumers, while successful artifacts are settled even on cancellation. World Labs recovery-aware operations are rejected downstream of iterators because one node/run checkpoint cannot safely own several paid recovery IDs; use separate tracked nodes for those operations.
- Independent review caught a remote-video regression introduced by the extractor's local file check. Preserve the existing HTTP(S) input contract while validating missing local/portable paths; four no-network mode tests cover it. Video repair also needs canonical URL decoding for encoded owned output filenames without allowing path traversal.
- Normalize cumulative batch media URLs at the same backend boundary as scalar outputs, including custom output roots. Settle skipped descendants after empty batches or upstream failures so they do not remain queued; retain completed results and other active owners.
- Picker filtering alone does not cover Canvas selections or saved styles. Reuse the eligibility predicate in both the composer button/shortcut and the launch handler before reservation or authoring. Keep the chosen model visible with a Canvas guidance message instead of silently changing its provider.
- Final dependency review found four old browser-data overrides below Browserslist 4.29.0's declared minima. Raise them to the exact supported minima after verifying canonical npm dates; all are older than 14 days. The final audit still flags source-map-js and its dependents, so do not report a clean dependency audit.
- Final validation passes 2,435 backend tests, 958 frontend tests, full frontend lint/style guards, production TypeScript/build/budget, 254 node contracts and generated model reference checks. Native browser checks use an isolated credential-free fixture: a Create job retains Stop across navigation/reload, explicit replay completes with previous records intact, and both iterator downstream results remain inspectable after reload. Real FFmpeg verifies portable/escaped video extraction and replacement duration. No live provider submissions, Electron testing, merge or push.

## 2026-10-07 - Scoped Krea publication and privacy audit

- Publish a squash of the four local Krea commits from a fresh managed worktree based on current GitHub main. This preserves the active parent checkout and live preview and keeps the original local commit metadata out of the new public history. Use the account's verified ID-based GitHub no-reply email for this publication without changing shared Git configuration or previously published history.
- Scanned every introduced or changed blob across the four commits, including earlier revisions: no real credentials, private OAuth links, Krea account/workspace identities or generated test media are present. Keep private test receipts, identifiers and artifacts outside the repository; public validation notes describe the result without account/job/run IDs.
- Extend ignores to cover environment variants, repo-relative connector vaults/state, desktop vault master-key files and private-key/credential files. These are preventive protections for alternate local storage locations; the actual live preview already stores all credentials and outputs outside the repository.
- Fresh code validation passes: 2,389 backend tests, 878 frontend tests and 277 desktop non-GUI tests, plus lint, TypeScript/build/budget, 74-model catalog consistency, 254 node contracts and generated reference checks. The full desktop command reports missing Electron/ws dependencies in the isolated checkout; the separate sidecar suite reuses installed Python/ws with private temporary state. Electron GUI tests are not a passing gate here and were not retried against the user's real Application Support data. Final staged privacy and ignore checks pass.

## 2026-10-07 - Real Krea account generation verified

- The previous disposable preview directory no longer exists, including its OAuth vault and graph state. Restarted the isolated worktree's preview on the same 5203/8033 ports with private persistent state/output under `~/.nebula/previews/krea-provider-20261007`; the active parent checkout remains untouched. Browser graph state from the earlier in-app browser was unavailable, so this test recreates the user's original Kling prompt as a new single-node graph.
- Used native computer use in Dia to Connect Krea, complete equivalent reauthorization through its existing signed-in session, configure Kling 3.0 with account/workspace compute, and click Run once. No API-key fallback, model substitution, cancellation or automatic retry occurred. Parameters were 16:9, 5 seconds, standard mode and audio off.
- One actual account job completed in about 60 seconds. The Nebula run retains the exact recipe, local artifact and complete status; native UI playback and Run History both verified. The H.264 output is 1280 x 720 at 24 fps, 121 frames and 5.041667 seconds, with no audio stream as requested. Full FFmpeg decode passes. Account/job/run identifiers and media remain only in private local evidence.
- Saved the UI evidence outside the repository alongside the private preview. An optional graph ZIP export reached Dia's native save sheet with Save disabled; cancelled that sheet without replacing files. The completed run recipe remains in Nebula's persisted history. This proves one actual Kling account generation; the entire model catalog and other agent hosts were not exercised by this run.

## 2026-10-03 - Authenticated Krea generation contract repair

- The user's first account run failed before submission because the actual authenticated server advertises `generate_image`/`generate_video`, while its current published MCP guide describes `generate`. Live `list_models` also returns `kling/kling-3.0`; the documented `video/kling/kling-3.0` is rejected by live schema lookup. Sign-in succeeded; this was an adapter assumption, not a different Nebula backend.
- Select the discovered generation tool for the saved media category, retaining the generic tool only when that category tool is absent. Resolve the model ID from live catalog entries for the exact bundled category/route and verify the returned schema's model, category and endpoint before any upload or submission. Never dispatch by display name or switch to a different model/provider/billing source. Explicitly request async mode when the tool declares `sync`.
- Factor read-only generation preparation from paid execution so the actual connection can validate the Kling request/tool arguments without submitting a job. Preserve existing history and require the user to rerun explicitly after the backend repair.
- Validation: the user's exact saved Kling params and connected prompt pass bundled/live schemas and discovered `generate_video` arguments. Read-only live discovery resolves all 74 bundled model routes. Restarted only preview backend 8033 with its existing state/output/settings paths; Krea stays connected, two nodes/one edge and both browser run records remain. No live upload/generation/cancellation calls occurred. All 2,389 backend tests pass, including 250 focused Krea checks and sanitized authenticated-tool-schema fixtures with actual PNG/FFmpeg materialization, accepted-job cancellation and no secondary submissions.

## 2026-10-03 - Krea sign-in launch follow-up

- User testing found that Connect prepared OAuth consent but never opened it; the manual sign-in anchor was the only launch action. Open consent from the explicit Connect click, reserving one browser tab synchronously before async client registration, or using the existing guarded desktop external-browser IPC after registration.
- Clear the reserved tab's opener before loading any remote content; only the validated canonical Krea authorization URL can navigate it. Blocked/closed tabs and desktop launch failures retain a prominent manual link with an actionable message. Failed registration or malformed URLs close the blank tab. Pending consent can be explicitly restarted; Settings load, polling and Check never open extra tabs or start generation.
- Live preview verification: clicking Connect opened a new Krea login tab in the Codex in-app browser. Leave login/consent to the user; no account access or generation was performed. The affected Settings/connection gate passes 34 tests, frontend lint and production build/budget pass. The polling test counts relative to initial Settings mounts because its loading state remounts the card.

## 2026-10-03 - Krea account MCP connector

- Support the user's selected scope: one browser OAuth connection for agent model discovery and explicit Canvas/Create generation. Connecting, checking and refreshing credentials never submit a generation.
- Persist `_kreaAuth` on each gateway recipe. Existing recipes default to the API-token/API-balance path; account/MCP recipes use the consent-selected workspace's compute units. A future-node preference cannot rewrite saved runs.
- Use Krea's canonical Streamable HTTP endpoint and advertised OAuth metadata. Implement public native-client registration, PKCE, loopback callback, exact state/issuer checks and persisted expiry ourselves: installed MCP OAuth support drops native metadata and loses expiry/discovery context on restart.
- Keep OAuth tokens out of ordinary settings, graph exports and agent configs. Encrypt the backend vault; desktop protects its master key with existing Electron safeStorage and passes it only to its sidecar. Browser/dev mode uses an owner-only local key and encrypted vault. Desktop fails closed if OS credential storage is unavailable.
- Reuse installed cryptography 50.0.0 and pin it explicitly (PyPI release 2026-07-31, older than 14 days); no package installation or upgrade.
- Agent MCP exposes only model listing/schema tools. Paid media follows Nebula's existing graph execution, cancellation, artifact storage and history instead of bypassing those surfaces.
- Exact authenticated Krea tool schemas are discovered at connection time. Fixture tests cannot establish live account consent or funded generation; keep that validation boundary explicit.
- Real Krea public native-client registration succeeded from the local preview; no account consent or paid job was submitted. Authenticate before claiming live tool compatibility.
- Desktop connector requests require a per-sidecar nonce injected through the trusted preload. `Origin: null` alone is also possible from a sandboxed web iframe, so it cannot identify Electron. The nonce is separate from the vault key and the opaque-origin CORS exception is limited to connector routes.
- Expose that request nonce only to the configured renderer's main frame. Block navigation/redirects to another document and open validated web links in the external browser. A nonce exposed by a preload to a remote page would defeat the HTTP origin restriction.
- Refresh the bearer before each MCP request and pin the accepted connection revision for each job. Reconnecting to a different workspace cannot change an active job's billing identity or send its cancellation using the new connection.
- Extend the backend settings allowlist to persist `kreaConnectionMode`. A real settings API regression checks that saving it survives reload and neither rewrites graph params nor makes provider calls.
- Claude's `--mcp-config` option is variadic; place it before the next option so it cannot consume the user's prompt. Hermes merges a temporary MCP overlay only when no administrator scope exists. Its installed Daedalus profile is missing here, so live Hermes execution is not verified.
- Final checks: 2,373 backend and 870 frontend tests pass, plus 270 desktop credential/sidecar tests and seven new renderer-trust tests. Lint, production build/bundle budget, generated catalog/reference checks and 254 node contracts pass. The desktop GUI suites were not run against the user's real Application Support state; mocked OS encryption/navigation and a real temporary Python sidecar cover the local gate.

## 2026-08-19 - Provider and agent live-acceptance preflight

The paid-provider phase is intentionally split at an explicit budget gate. The
preflight may use authenticated health and model-catalog reads because they do
not create media or consume agent turns; any generation, text completion, or
agent prompt waits for user approval.

Decisions:
- Treat `/api/health/providers?refresh=true` as credential truth. The Settings
  `11/15` header counts configured values and includes the OpenAI key that the
  live health probe rejects, so it is not a validity count.
- Track Nous separately from the 15 Settings credentials because it is backed
  by Hermes OAuth. Daedalus readiness requires both the local executable and
  valid Nous OAuth; neither fact alone proves an agent turn works.
- Use the cheapest node that still exercises each family's real execution and
  output path. Prefer short streaming text, FAL/Replicate Flux Schnell, Runway
  TTS, Meshy text-to-image, and Quiver Arrow 1.1. For direct Ideogram, use the
  transparent async node so the smoke covers image download and persistence,
  not only a metadata helper.
- Separate dollar-denominated usage from Meshy and Quiver account credits. A
  `$1` configured-valid hard cap is deliberately much larger than the roughly
  `$0.058` known success floor so cancellation races and one rerun cannot turn
  a nominal estimate into unapproved spend.
- Do not induce a real provider 429 merely to prove retry behavior. Quiver's
  one-retry `Retry-After` contract is covered deterministically; the live phase
  will prove run-history retry through a controlled failed request and record
  any naturally occurring transient provider retry.
- Missing or rejected credentials are acceptance findings, not permission to
  create keys, change billing, or paste credentials through automation.
- The deterministic audit found complete provider handler coverage, including
  xAI under `test_grok_video_handler.py`, but no equivalent lifecycle contract
  for the Claude CLI bridge. Add the same normalized-event, resume, quick-mode
  gate, failure, and subprocess-cancellation coverage already expected of the
  Codex and Daedalus bridges. This does not replace the approved live turn.
- xAI's current video API documents submit and poll but no cancel endpoint, and
  the handler therefore cancels locally only. Record that explicitly in the
  matrix instead of implying a provider-side cancellation can be proved.
- Claude cancellation emits one terminal `done` event while the async generator
  unwinds, after killing and awaiting the child process; the suspended
  `CancelledError` propagates on the next stream advance. Pin this sequence
  rather than treating the cleanup marker as a swallowed cancellation.
- The live registry mislabeled `ideogram-transparent` and
  `ideogram-edit-prompt` as async-poll even though both direct handlers use the
  synchronous final-response endpoints and immediately download the ephemeral
  image URL. Ideogram's current reference explicitly calls transparent
  generation synchronous; align backend/frontend contracts and generated model
  docs, while leaving actual custom-model training as async-poll.
- `flux-schnell` and `fast-sdxl` had the inverse metadata drift: both were
  labeled sync even though their wrappers call the universal FAL queue
  submit/poll handler. Normalize every non-stream FAL node to async-poll and pin
  the only two streaming exceptions (`gpt-image-2-fal-generate` and `-edit`).
- Meshy's direct `meshy-image-to-3d` handler had drifted away from the shared
  `_poll_meshy_task` loop. Canvas Stop therefore cancelled Nebula's task but did
  not issue Meshy's documented irreversible DELETE for that one path. Route it
  through the shared cancel-aware poller and treat Meshy's `CANCELED` status as
  terminal instead of polling until timeout.
- Gemini Omni background video uses Google's Interactions API, whose current
  first-party contract exposes `POST /interactions/{id}/cancel`. The handler
  previously stopped local polling without calling it; schedule that provider
  cancellation on a detached task once the interaction id is known. Keep Veo's
  older long-running-operation `:cancel` call classified as best-effort because
  Google's current video SDK warns that client abort alone does not stop or
  unbill the service operation.
- ElevenLabs dubbing is the provider's one long-running Nebula audio path. Its
  handler previously cancelled only the local ten-minute poll loop even though
  ElevenLabs documents `DELETE /v1/dubbing/{dubbing_id}` and recommends
  cancelling stuck dubs. On Canvas Stop, schedule that delete on the same
  detached cancellation mechanism as the other async providers.
- FAL queue results (and Replicate non-stream results) exposed provider CDN
  URLs as successful media outputs even though FAL explicitly documents that
  signed URLs expire. Materialize remote/data Image, Video, Audio, Mesh, and SVG
  handler outputs into the bound run directory before caching, manifesting, or
  emitting success. Preserve intentional provider handles such as Veo
  `source_uri` and Meshy `model_url` for downstream API chaining.
- An early shared activity-log append was rejected by the workspace sandbox;
  the later post-repair helper invocation succeeded, so the cancellation and
  durable-output work is now present in the shared 2026-08-19 timeline as well
  as this in-repo record.

## 2026-08-17 - Video QC Suite continuation

Factory completed the preceding reference-role mission, then the user approved a
separate Video QC Suite mission. Factory persisted an architecture and a
63-assertion draft contract, but hit its weekly limit before creating features
or implementation code. The live baseline is therefore 168 nodes with no
`qc-*` entries; the new work starts from the accepted design, not from a partial
implementation.

Decisions:
- Continuation QC found that the original metrics module imported and used
  OpenCV even in `heuristic` mode. Keep OpenCV/skimage pinned for the full
  analyzer suite, but make heuristic metrics independently runnable with
  NumPy/Pillow fallbacks and return an actionable dependency error only when
  the caller explicitly selects `opencv` mode.
- Apply the 45-second vision deadline around the actual request coroutine, not
  only to the internally-created `httpx` client. Reused or test-injected clients
  can otherwise disable timeouts and violate the bounded-provider-work contract.
- Current Google first-party documentation caps inline multimodal requests at
  20 MB. Twelve noisy 960px PNG samples could cross that boundary after base64
  expansion, so advisory inputs are normalized in memory to 768px JPEGs and
  bounded to 13 images/16 MiB of encoded image data before request construction.
- Add a real `video-input` -> QC graph execution test for every analyzer. Direct
  handler tests prove the algorithms, while the engine test proves registry
  lookup, input propagation, run-directory binding, outputs, and terminal event.
- QC cancellation can arrive during metadata probing as well as frame
  extraction or a provider request. Extend the shared ffprobe wrapper's existing
  timeout cleanup to kill and await its child on `CancelledError`, matching the
  ffmpeg cleanup path and preventing an orphaned probe after Canvas Stop.
- Keep one custom `VideoQcNode` frontend component for all four analyzers. They
  have the same annotated-Image plus JSON-Text result surface; four near-copy
  components would add drift without adding capability.
- Treat the checked-in `docs/video-qc-validation-contract.md` as the finalized
  contract. It preserves the accepted modes and outputs while replacing the
  Factory draft's implementation-detail assertions with observable behavior.
- Resolve videos and optional reference images locally. Raw remote URLs are
  rejected before ffmpeg, OpenCV, Pillow, or provider request construction so
  the QC surface cannot reintroduce the SSRF fixed in `23f8333`.
- Heuristic and OpenCV modes are deterministic, keyless local analysis.
  Vision-LLM mode chooses the first configured provider in the accepted order
  Anthropic, OpenAI, Google and uses a bounded non-streaming request. Tests mock
  every provider; no paid live call is part of this milestone.
- Vision responses are advisory data. Each handler validates/coerces returned
  JSON into its own bounded report schema and falls back to an explicit
  unparsed assessment instead of trusting arbitrary provider fields.
- Camera `lens_distortion_estimate` is a measured straight-line deviation proxy,
  not a calibrated physical lens coefficient. A single generated clip without
  calibration imagery cannot truthfully recover optical distortion parameters.
- Preserve the four pre-existing untracked handoff/report/browser-save items
  byte-for-byte. The tracked friction source is `docs/flora-gap-audit.md`; add a
  closure entry there without editing the untracked audit report.
- Boundary extraction must seek one nominal frame before the container duration,
  not one millisecond before it. Low-FPS clips often report duration one frame
  beyond their final decodable PTS; focused synthetic-video tests caught the
  missing final sample before the suite was integrated.
- The existing backend virtualenv lacks the newly declared OpenCV/skimage
  packages. Validation uses the already-provisioned project Conda interpreter;
  requirements remain pinned so a fresh backend install receives them.
- The node-contract checker predated the existing CameraRig and ReferenceSet
  typed ports and failed before evaluating the QC definitions. Its valid-type
  set now mirrors the frontend `PortDataType` union; no node behavior changed.
- The reference-role additive-only regression test compared the entire live
  node set to its historical baseline, which made any future node addition fail.
  It now protects the historical nodes as a subset and still performs the same
  field-by-field additive-role check on every baseline node.
- Security review tightened the 60-second extraction ceiling to cover the whole
  sample batch. A per-frame timeout would have permitted a pathological 12-frame
  input to occupy a worker for up to 12 minutes despite the sample-count cap.
- Factory's proposed OpenCV 4.12 pin requires NumPy below 2.3 on Python 3.9+,
  which conflicts with this repo's NumPy 2.4.4 pin. Use headless OpenCV 4.13.0.92
  instead: its official wheel metadata accepts NumPy 2.x without that upper
  bound, it is over six months old, and it preserves the server-safe headless
  package choice.
- Frontend gates initially appeared to hang because 26,634 files in the ignored
  `frontend/node_modules` tree were macOS dataless placeholders. Restoring the
  exact lockfile tree with offline `npm ci` made lint, build, and all 434 tests
  complete normally; no dependency version or lockfile changed.

Validation (2026-08-18 continuation):
- The expanded focused QC/cancellation group passed 54 tests. The four QC nodes
  each ran through the real `video-input` -> registry -> execution-engine path,
  and the dependency-light project venv passed all four heuristic engine cases.
- The complete backend suite passed 1,528 tests with QC included under the
  available Python 3.12 environment (OpenCV 4.12.0, skimage 0.26.0, NumPy
  2.4.4). The two existing async-poll `AsyncMock` resource warnings remain.
- Frontend passed 440 tests across 55 files, TypeScript/production build, and
  lint with zero errors. The existing ReferenceSet hook warning, Lottie `eval`
  warning, and large-chunk warning remain unchanged.
- All 172 definitions passed the node-contract gate; generated model reference,
  changed-Python compilation, diff whitespace, startup import, registry wiring,
  and credential-prefix scans passed. Current first-party Anthropic, OpenAI,
  and Google references confirm the three vision model IDs/request surfaces.
- A final `pip install -r backend/requirements.txt` attempt in the stale local
  `.venv` was blocked by managed DNS before pip could resolve even an existing
  dependency. No package was partially installed. The exact pinned OpenCV
  4.13 wheel therefore remains an external install proof ceiling; PyPI confirms
  a Python 3.12-compatible macOS ARM64 wheel, while runtime behavior is covered
  locally by OpenCV 4.12 and heuristic mode no longer depends on it.

## 2026-07-23 - Ideogram seven-node contract and route-safety audit

The seven existing Ideogram nodes remain dual-route. The direct path keeps V4
generate/remix plus the provider's V3 edit surfaces; the FAL path keeps V4
generate and the V3 editing endpoints. FAL now publishes a V4 image-to-image
endpoint, but it is not a drop-in replacement for the fixed remix node because
it omits the node's V3 style-reference, style, and negative-prompt controls.

Decisions:
- Filter FAL requests through a per-node allowlist on a copied `GraphNode`.
  Dual-route nodes persist defaults for both providers, so forwarding the whole
  param map could send direct `rendering_speed=DEFAULT` and `resolution` to FAL.
- Preserve the source node for both endpoint injection and Character-bundle
  seed expansion. The previous wrappers wrote `endpoint_id` and sometimes a
  seed into persisted params during execution.
- Reject invalid route enums, counts, strengths, upscale controls, resolutions,
  and character-reference counts before creating a provider client. Both
  current Character routes consume exactly one identity image; FAL otherwise
  ignores extras and the direct route rejects them.
- Surface the current FAL V4 `acceleration` control and no-fee
  `expansion_model=None`, the full current V4 resolution enum, and direct V4
  copyright detection. Keep structured palette/style-code/json-prompt fields
  out of the fixed nodes; `fal-universal` remains the escape hatch for complex
  FAL objects.
- Freeze one FAL JSON body per node and maintain separate FAL and direct gold
  exemplars because their auth, request shapes, execution patterns, and result
  persistence differ.
- Do not run a paid provider smoke in this milestone. The prior 2026-06-10 live
  results remain empirical evidence; this pass is schema, handler, fixture, and
  regression validation.

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

### 2026-07-23 — Final video and Remotion export

- **One lifecycle for both editor surfaces:** final exports run as cancellable, in-memory jobs with `POST` to start, `GET /api/render-jobs/{id}` to poll, and `DELETE` to cancel. This gives the UI truthful progress/cancel/download behavior without pretending the existing fire-and-forget graph execution endpoint can cancel a child encoder.
- **Video Editor formats:** the final renderer reuses `_build_filter_complex` for MP4/H.264, MOV/ProRes 422 HQ, WebM/VP9, and animated GIF. Resolution presets are Source, 1080p, 720p, and 480p; quality presets map to CRF for H.264/VP9 and are intentionally disabled for ProRes/GIF. GIF drops audio at filter construction so it cannot leave an unconnected audio output.
- **Remotion parity contract:** a dedicated Node worker bundles the same `RemotionComposition` the Player imports. One unchanged `inputProps = {manifest}` object goes to both `selectComposition()` and `renderMedia()`, and a shared `compositionDurationInFrames()` function controls Player and renderer duration. Running `remotion-node` now produces a real H.264 MP4 instead of echoing a null video.
- **Cancellation:** ffmpeg and Remotion subprocess wrappers terminate their child process and delete partial output on `CancelledError`. The Remotion worker also connects SIGTERM/SIGINT to `makeCancelSignal()`.
- **Dependency/security decision:** enabling server rendering required `@remotion/renderer` and `@remotion/bundler`. The original 4.0.458 family exposed current `ws`/bundler advisories; 4.0.464 cleared the first range but not later advisories. The full Remotion family was aligned to exact 4.0.479, published 2026-06-17 and therefore outside the 14-day quarantine. `npm audit` then reported zero findings.
- **License boundary:** official Remotion material checked 2026-07-23 says individuals and companies up to three people may use the free license; collaborations/companies of four or more require a Company License. Nebula documents but does not enforce or procure that license.
- **Empirical proof:** a real text-manifest render produced a 5.056 s, 1280×720, 30 fps H.264/AAC MP4. A synthetic one-second source produced valid 854×480 outputs in H.264/AAC MP4, ProRes/PCM MOV, VP9/Opus WebM, and GIF. No provider API or paid call ran.
- **Graph persistence fix found during UI QA:** `video-edit` and `remotion-node` previously kept `clips`/source metadata and `manifest` under undeclared params, so the standard POST/PUT graph API rejected exact editor state. Those runtime fields are now declared as hidden params, following the existing Cinema `scene` pattern, with create/update/reload regression tests.
- **Live app proof on Remotion 4.0.479:** drove the real Vite app against the local backend using the already-generated three-second Gemini clip. A 1080p WebM completed with a download action and ffprobe confirmed VP9/Opus at 1920×1080. A repeated 60.2 s local timeline showed 1% progress, cancelled through the UI, and left no partial file. A persisted one-layer text manifest then rendered through the UI to a 5.056 s H.264/AAC MP4 at 1280×720 and 30 fps; a sampled frame visibly contained the exact `NEBULA EXPORT QA` manifest text. Temporary nodes, outputs, and the test edge were removed afterward, restoring the original eight-node canvas.
- **Review-caught lifecycle fix:** the first popover toggle reset its local job reference whenever it closed. Closing during a render could therefore orphan a still-running encoder. Closing now preserves job ownership and polling; completed jobs expose an explicit New export/New render reset action. A toolbar regression test pins the running-close and completed-reset behavior.
- **Full validation:** backend `1197 passed` with the same two existing AsyncMock warnings; frontend `402 passed`, lint, TypeScript, production build, 142-definition node contracts, generated reference, `git diff --check`, and `npm audit` passed. The existing build warnings remain for `lottie-web` direct `eval` and large chunks.
- **Non-gating harness finding:** `scripts/check-utility-nodes.mjs` repeatedly timed out after the backend logged its unrelated pure-utility graph as completed. This slice does not touch the execution-event/store paths that harness exercises, and the backend/frontend unit suites covering those paths pass. The failure remains an explicit follow-up for the run-history slice rather than an export change hidden in this PR.

### 2026-07-23 — Persistent run history and exact replay

- **Persistence boundary:** the newest 100 Canvas graph, single-node, and selection runs are stored in browser `localStorage` under a versioned envelope. Concurrent Create generations and Cinema shot jobs retain their existing independent lifecycle and are not forced into the single global Canvas history lock.
- **Exact replay contract:** every history record stores the JSON-cloned, deeply frozen request graph after network-boundary normalization. This matters for `video-edit`, whose derived clip speed is part of the backend request. Single-node records additionally retain `targetNodeId`; replay calls `/api/execute-node` with that original target, while graph/selection records call `/api/execute` with their original snapshot. Replaying never replaces or rewinds the live canvas.
- **Reload recovery:** a page reload cannot reconnect to an in-flight backend task, so persisted `running` records recover as `cancelled`. Malformed individual records are dropped and the remainder is rewritten; invalid JSON or an invalid storage envelope is removed. Storage access, quota, and privacy-mode errors are non-fatal.
- **Run isolation:** replay always receives a new UUID and records `sourceRunId` plus `replayAction`. Scoped stale completion events from the source run cannot close the new replay. Matching node IDs on the current canvas still show execution state, but the request payload comes exclusively from saved data.
- **Actions:** complete/cancelled rows show `Rerun`, failed rows show `Retry failed`, and the existing header clear action now removes both in-memory and persisted history. Replay actions are disabled while another global Canvas run owns the execution lock.
- **Carried utility harness timeout resolved:** the browser smoke graph still used nonexistent `/tmp/image-a.png` and `/tmp/image-b.png` placeholders. The newer image-input source guard correctly failed those nodes, leaving downstream image utilities idle while the harness only reported a generic timeout. The harness now uses tracked image/video fixtures, prints node state on timeout, fits all seeded nodes into view, and executes through `graphStore.executeGraph()` instead of bypassing the store with a raw fetch. That live-checks run-ID correlation plus history snapshot open/close, mutates the canvas and reruns the saved 17-node/14-edge snapshot, then reloads the page and confirms both completed records, replay lineage, and original `Alpha` params persist. Nested array outputs retain backend filesystem refs while top-level image outputs are rewritten to `/api/outputs/...`, so assertions compare output identities by filename across that intentional representation boundary.

### 2026-08-18 — Seven-defect adversarial reliability pass

- **Ownership boundary:** `backend/main.py` and `frontend/src/store/graphStore.ts` already contained user-owned QC node mappings. All edits were applied around those mappings and the original diff was preserved.
- **Run-scoped output decision:** handlers keep the stable `get_run_dir()` API, but the engine now binds one collision-proof directory through a `ContextVar`. Async child tasks inherit it, avoiding a risky rewrite across every provider handler. Standalone callers still receive a unique directory per call.
- **Manifest boundary:** manifests are provenance, not request archives. Private keys are omitted, credential-like keys are redacted, embedded data/binary values are replaced, and collections/strings/depth are bounded at `write_manifest()` so direct callers and `/meta` share the same safety boundary.
- **Cache policy:** only Nebula-owned local artifacts are existence-gated. Remote/data/blob values and external absolute paths are not treated as cache-owned files; `/api/outputs/...` and absolute paths beneath `OUTPUT_ROOT` must still exist or the entry is evicted.
- **Graph ingress decision:** imports and additive clusters mutate a persistence-free `CLIGraph` candidate. Node definitions, param shapes/coercion, references, handles, duplicates, and cycles are validated before one `replace_with()` call persists. Invalid requests neither broadcast nor alter the live graph. The file-import UI also keeps its current canvas until the backend returns the validated replacement.
- **Cancellation contract:** frontend-started graph tasks are retained by run ID. `DELETE /api/executions/{runId}` is idempotent, parent cancellation cancels and awaits engine node tasks (allowing existing provider `CancelledError` hooks to fire), `graphCancelled` closes the matching UI history, and both backend and frontend suppress late post-cancel events.
- **Telemetry decision:** demo zoom telemetry is a persisted, explicit opt-in (`zoomTelemetryEnabled`, default false). Both backend endpoints enforce the gate. Enabled sessions use unique archive-eligible directories under configured `OUTPUT_ROOT`; the old top-level hard-coded files are no longer created.
- **Adversarial findings fixed during the pass:** macOS `/var` vs `/private/var` resolution initially excluded valid run files from manifests; the new output directory suffix initially fell outside the archive regex; and the frontend import flow initially cleared local state before backend validation. Each now has a regression or direct contract check.
- **Final verification:** focused combined backend regressions passed, then the available full backend suite passed `1510` tests with the two pre-existing `test_async_poll_runner` AsyncMock warnings. Full collection still stops at the user-owned Video QC suite because this checkout's `backend/.venv` lacks `cv2`; no dependency installation was attempted. Frontend passed `440` tests across `55` files, TypeScript/production build, lint with zero errors, and the `172`-definition node contract. `git diff --check`, changed-Python compilation, a credential-pattern scan, and explicit QC-mapping preservation checks passed. Existing non-gating warnings remain: one `ReferenceSetNode` hook warning, Lottie's direct `eval`, and large Vite chunks.

### 2026-08-18 — Complete audit refresh and live UI pass

- **Live-browser boundary:** the sandbox denied a standalone Python/uvicorn listener, so a temporary Vite-owned ASGI bridge was used only to render the real frontend against the real FastAPI app. It used isolated graph/output roots, was removed after capture, and the original Vite proxy configuration was restored before the final build.
- **Interaction classification:** the browser automation layer could move the pointer but could not carry Nebula's custom `application/nebula-node` HTML drag payload. That automated drop failure is not classified as a product defect; pointer graph authoring remains a manual-browser ceiling.
- **New UI defects:** Run History defaults to `x=-340px` and Reset does not recover it; Nodes and Assets can be simultaneously active with overlapping left-column geometry; Create concatenates FAL and direct params, giving Veo 3.1 duplicate `seed` controls and a React duplicate-key error; node-library definitions are unfocusable drag-only `<div>` elements, so keyboard-only users cannot author a graph.
- **QC environment:** `backend/.venv` still lacks declared OpenCV/scikit-image packages, but the existing Miniconda Python 3.12 environment has them. The actual full backend suite therefore ran successfully there: `1528 passed` with the same two pre-existing AsyncMock warnings. The focused reliability/QC/cancellation slice passed `88` tests.
- **Final verification:** frontend `440` tests, lint (zero errors, one existing hook warning), production build, the `172`-definition node contract, backend `1528` tests, focused backend `88` tests, and `git diff --check` passed. No provider generation or account-consuming agent turn was submitted.

### 2026-08-18 — Live UI defect closure and adversarial follow-up

- **Run History geometry:** the fixed `-340px` default was replaced with a viewport-derived right-edge position. Opening the panel or resizing the viewport repairs stale coordinates, drag movement is clamped with a reachable header, and Reset now restores every panel's geometry while preserving which panels are open.
- **Left-rail ownership:** Nodes and Assets share the same coordinates by design, so opening either now closes the other. This keeps launcher state truthful and avoids introducing a second layout system for only two panels.
- **Create provider route:** Create now follows the Inspector contract: use `directParams` only when `directKeyName` has a configured value, otherwise use `falParams`, always combined with shared params. A final key-based de-duplication boundary prevents malformed catalog data from generating ambiguous controls. Model changes and preset-driven model changes rebuild defaults from the same selected route.
- **Node authoring accessibility:** node definitions are native buttons without removing HTML drag support. Click, tap, or native keyboard activation adds at the current viewport center; the follow-up click event from a double-click is ignored to preserve the old gesture without adding two nodes. Collapsed Slava categories are `aria-hidden` and their items leave the tab order.
- **Live proof:** Run History rendered at `x=988`, width `276`, right `1264` in a 1280px viewport and stayed there after Reset. Opening Assets removed Nodes from the rendered/accessibility tree. Clicking the focusable Text Input button created one Canvas node. Veo 3.1 rendered exactly one Seed input and emitted no duplicate-key console error. The browser-control harness focused the node button with Enter but did not synthesize the browser's native button click; the native keyboard activation contract is therefore pinned by the component test rather than overstated as live harness proof.
- **Environment boundary:** Vite served the real frontend, but this managed sandbox denied the FastAPI TCP listener. The UI checks above are local frontend behaviors and ran in the actual application; backend-dependent asset contents displayed the expected discovery error. No provider request, paid generation, settings write, or user graph persistence mutation was made.
- **Verification:** focused UI tests passed `19/19`; full frontend passed `447` tests across `56` files; full backend passed `1528` tests with the two existing AsyncMock warnings; the 172-definition node contract and TypeScript build passed. Lint first rejected an unscoped focus-ring rule, then Fast Refresh rejected an exported helper in the component module. The skin rule was scoped, the geometry helper moved to `lib/panelPosition.ts`, and lint/build/diff checks passed on rerun.

### 2026-08-18 — Audit follow-up: credential truth, diagnostics, and build budgets

- **One credential source:** provider keys remain exclusive to project-root `settings.json`. All user-facing provider guides, README setup, `settings.example.json`, and the writable `.claude/skills` mirror now point to Settings and explicitly say no restart is required. The optional project `.env` is loaded only for process/path overrides; the Daedalus narrator was changed from `os.environ[OPENROUTER_API_KEY]` to Nebula Settings with Hermes auth as its existing fallback. Contract tests pin exact equality among the 15 catalog keys, Settings fields, settings example, and provider health keys, and prove process environment is not a provider-key fallback.
- **Provider-health policy:** expanded the roster from nine to all 15 Settings credentials plus Nous OAuth. Use documented, non-billable authenticated reads. Never submit generation as a health probe: Higgsfield has no identified safe read and therefore reports `configured_unverified`. Preserve diagnostic truth by separating 401 rejection, 403 authorization, 402 credit exhaustion, 429 rate limiting, and transport/provider errors.
- **Startup payload:** alternate workspaces are route-lazy. Character and Moodboard draft sentinels moved into a small shared module so Assets no longer statically imports both full studios and defeats the split. Remotion, timeline, Lottie, and React Three packages use explicit deferred chunks. Three.js remains one indivisible ~717 kB lazy module, so Vite's generic threshold is calibrated to 750 kB while a stricter post-build gate caps the actual initial entry at 512 kB raw / 160 kB gzip. Current entry: 472,049 raw / 138,242 gzip, down from ~3.53 MB / 912 KB gzip.
- **Lottie tradeoff:** both Vite preview and Remotion export alias `lottie-web` to `lottie_light.js`. That removes runtime code generation and the direct-eval build warning, but expression-authored Lottie animations are intentionally unsupported. The build gate scans every emitted JS asset for `eval(` and `new Function(`; 21/21 are clean.
- **Hook and test hygiene:** `ReferenceSetNode` now computes its fallback params within the memo and depends on stable node data. The async-poll cancellation tests patch the async cancel function with `MagicMock`, eliminating the two unawaited-coroutine warnings without changing runtime cancellation.
- **Venv repair without network:** outbound package resolution stayed unavailable, but complete Python 3.12 distributions existed locally. Repacked their installed files from `RECORD`/`WHEEL` metadata into temporary wheels and installed them into `backend/.venv`, keeping the venv self-contained instead of adding a global `site-packages` path. The first OpenCV 4.12 candidate imported but `pip check` correctly rejected it against NumPy 2.4.4 (`numpy<2.3`); it was replaced with the exact declared OpenCV 4.13.0.92 distribution from the local ComfyUI environment. scikit-image 0.26.0 and its missing SciPy/imageio/tifffile/lazy-loader/networkx dependencies came from the local base Python 3.12 environment. Final unrestricted proof: both key imports resolve inside `backend/.venv`, `pip check` is clean, all 25 QC tests pass, and the live-workspace full suite is 1,544/1,544.

### 2026-08-18 — Release sequencing audit

- Validate the 32 committed-but-unpushed commits from an isolated `git archive`
  before publishing them. That snapshot passed all 1,463 backend tests (the
  baseline comparison test needed read-only access to the original Git object
  database), all 434 frontend tests, lint, and the production build.
- Withhold the fast-forward push because the committed node-contract checker
  predates the committed `CameraRig` and `ReferenceSet` port types. The checker
  fails on those two definitions; its required type-set correction currently
  lives in the uncommitted follow-up batch.
- Preserve the local browser-save evidence while preventing accidental staging.
  Root-only `/test.html` and `/test_files/` ignore rules cover the 9.3 MB saved
  page and generated images without deleting or moving user artifacts.
- The first full follow-up gate caught a second cross-layer mismatch: provider
  credentials intentionally moved from `.env.example` to
  `settings.example.json`, but `scripts/check-node-contracts.mjs` still required
  all 15 keys in `.env.example`. The checker now enforces exact Settings-example
  coverage and rejects provider credentials advertised in `.env.example`,
  matching the existing Python contract tests.
- A clean prospective candidate overlaid every intended tracked/untracked change
  plus the eight corrected `.agents` mirrors on `HEAD`. It passed 1,526 backend
  tests, 447 frontend tests, lint, production build, the initial-bundle/eval
  budget, the 172-definition contract, generated-reference parity, Python/Node
  syntax checks, and validation of all 19 affected provider skill folders. The
  live workspace's larger 1,544 collection includes 18 duplicate tests from four
  ignored Finder `* 2.py` files; those are not part of the release candidate.
- **Managed blocker resolved:** a later unrestricted session applied the eight canonical `.agents` Settings corrections and the OpenRouter/Replicate YAML-description fixes. The OpenAI canonical skill intentionally retains `.agents/skills/gpt-image-2` links rather than copying `.claude`-specific paths. All 22 provider skill folders across both trees validate with `quick_validate.py`, strict provider-guide parity passes, and the live backend suite is fully green.
- **Linux CI shallow-clone repair:** the first pushed release run exposed that
  `test_reference_roles.py` loaded its pre-role baseline with `git show
  c708400`, while `actions/checkout` intentionally provides only the pushed
  commit by default. Replace the history lookup with a checked-in map of
  canonical SHA-256 fingerprints for every baseline node after removing only
  the permitted port `role`/`weight` keys. This keeps the additive-only
  guarantee, permits later new nodes, stays compact, and makes the test
  deterministic in shallow clones and source archives without expanding every
  CI checkout to full repository history.
- **Browser ceiling:** `vite preview` was attempted for a real lazy-chunk browser smoke and failed before launch with `listen EPERM` on `127.0.0.1:4173`; no UI state was used and no screenshot was claimed. Frontend proof is lint + production build + 447 tests; built-chunk runtime remains environment-gated.

### 2026-08-19 — Full UI acceptance: layout persistence and accessible insertion

### 2026-08-19 — Saved-bundle runtime metadata compatibility

- A bundle saved through the native Chrome Save dialog could not be loaded back: completed `gemini-omni-flash` nodes contained `sourceDuration`, `sourceFps`, and `sourceIsVfr` in `params`, but those are runtime ffprobe facts rather than declared provider inputs. Strict import validation correctly rejected them and atomically preserved the empty post-Clear graph.
- Kept strict unknown-parameter validation intact. Runtime probe metadata now uses the existing private-param namespace (`_sourceDuration`, `_sourceFps`, `_sourceIsVfr`) on source/provider nodes. `video-edit` keeps its unprefixed fields because those are declared, durable editor state.
- Both graph serialization and deserialization migrate the three legacy fields only when the node definition does not declare them. This cleans future saves and allows existing v1-v3 bundles—including the UI-audit backup—to reopen.
- The editor reads private metadata first and retains a legacy fallback for already-hydrated nodes. Upload responses keep their existing public response field names; only persisted node params changed.

### 2026-08-19 — Live handler-param synchronization after Canvas runs

- A real Video Input → Video Edit run completed and persisted the edit handler's seeded 60-second clip, but the open frontend still showed `0 clips`. The frontend execution routes only received output events; their post-run handler-param sync updated `cli_graph` without broadcasting the new graph.
- `_sync_params_to_cli_graph` now reports whether values actually changed and deep-copies changed params. Full-graph and single-node Canvas execution send one final `graphSync` only when a handler mutated params, avoiding an unconditional extra graph refresh for ordinary runs.
- Added async regression coverage for both `/api/execute` and `/api/execute-node`; each proves the live broadcast contains the mutated value.

### 2026-08-19 — Silent-source Video Edit rendering

- The first deliberately long local Video Edit failed in 0.2 seconds: the source was a valid silent MP4, but filter construction inferred an audio stream from the clip's unmuted state and referenced nonexistent `[0:a]` input.
- Extended `ProbeResult` with `has_audio`, derived from ffprobe's existing stream list. Video Edit now emits audio filters/maps only when the source actually has audio and at least one clip is unmuted; GIF and all-muted exports continue to omit audio.
- Kept the render helper authoritative for both graph execution and final export. Added regression coverage for audio-bearing, silent, all-muted, and GIF paths.

- **Live reproduction:** a normal FastAPI + Vite pair in Chrome restored the user's 8-node graph, but two nodes were roughly 2,000 flow pixels away and multiple nodes shared exact coordinates. Auto-layout visibly repaired the graph, then a browser reload reverted every arranged position because React Flow changes never reached the persisted CLI graph. Three rapid click/keyboard additions also landed at the same viewport-center coordinate.
- **Persistence boundary:** Canvas drag completion and auto-layout now send positions through one atomic `PUT /api/graph/layout` contract. The backend validates every referenced node and finite coordinate before one `CLIGraph.update_positions()` mutation/persist/broadcast, so a stale or malformed layout cannot partially overwrite the saved graph.
- **Placement tradeoff:** accessible click/tap/keyboard insertion keeps the viewport-center behavior for the first open slot, then searches nearby 320x220 slots. Pending positions are reserved locally until graph-sync materializes them; this closes the real rapid-activation race without waiting for a backend round trip or changing HTML drag/drop placement.

### 2026-08-19 — Command Palette insertion parity

- The live workspace pass found that Command Palette node insertion still used the raw viewport center. Adding Cinema Scene and then Remotion Composition placed them at the same coordinates even though Node Library additions had already adopted collision-aware placement.
- Command Palette now uses the shared `findAvailableNodePosition()` policy and keeps its own pending reservations until graph sync materializes each node. This preserves the intended center-first behavior while making every click/keyboard insertion surface collision-safe.
- A component regression opens the palette twice without allowing either mocked backend addition to resolve into live graph state, then proves both requested nodes receive distinct non-overlapping positions.

### 2026-08-19 — Backend-owned project scope

- The live Assets/Character/Moodboard pass showed real `400` responses for every Project tab: the stores require `projectId`, but no frontend surface had a current-project concept. Presets were worse because `scope=project` without an id silently fell back to global storage.
- Nebula remains a one-local-project-per-backend application, so the backend now owns and exposes that identity at `/api/project`. The default is the stable repository-directory name; `NEBULA_PROJECT_ID` and `NEBULA_PROJECT_NAME` are explicit deployment overrides. Only the safe id and display name are exposed—not the local path.
- All project-scoped list and Preset-create helpers resolve the same identity automatically. Character and Moodboard Studio entry state also retains whether “New” was launched from Global or Project, so new drafts persist into the selected scope instead of silently becoming global.
- Preset storage now rejects a missing project id exactly like Character and Moodboard storage. This converts silent scope corruption into a truthful API error if a future caller bypasses the frontend resolver.

### 2026-08-19 — Backend disconnect truth and recovery

- Stopping the normal FastAPI process left the live Canvas looking fully operational; all 8 nodes remained safely present, but there was no visible indication that runs and backend persistence were unavailable.
- A lightweight health probe now renders a non-blocking offline pill and continues retrying. A successful recovery clears the warning and the cached current-project identity in case the restarted backend belongs to a different checkout.
- Canvas edits remain available while offline; the status copy states that limitation rather than disabling the workspace or implying that local-only edits were persisted.
## 2026-08-19 — first-wave live isolation

- The original 8-node / 5-edge graph is not being imported into the test
  backend after the live wave. Normal graph import remaps node IDs and fits the
  viewport, which would weaken history-linkage and exact-restoration proof.
- Before spend, the normal state file was restored from a byte-identical raw
  snapshot. Live calls use temporary `NEBULA_STATE_DIR` and
  `NEBULA_OUTPUT_ROOT` roots on the normal agent port plus a separate Vite
  origin (`5174`) for isolated localStorage and Run History.
- A UI `.nebula.zip` save is retained as an independent product-level recovery
  path. The initial clear dialog was cancelled until that bundle had been
  written and inspected.

## 2026-08-19 — Nous live credential fallback

- The live Nous node failed with HTTP 401 even though the non-billable model
  check returned valid. The preferred Daedalus profile contained an expired
  agent key, while a later fallback profile was still unexpired; the loader
  ignored Hermes's expiry metadata and always returned the first token.
- Credential selection now scans every pool entry in profile order, rejects
  blank/non-string tokens, and applies token-specific or generic expiry before
  continuing to a fallback. JWT-shaped tokens additionally need an
  `inference:invoke` scope and an `exp` beyond a 60-second safety window;
  legacy opaque Hermes `sk-*` tokens retain metadata-based compatibility.
- Treat persisted profile URLs as untrusted. A credential file may use only
  the canonical Nous HTTPS `/v1` host, so a modified profile cannot redirect
  its bearer. An operator-controlled `NOUS_INFERENCE_BASE_URL` may use another
  HTTPS, non-loopback, no-userinfo host for staging/tests.
- Model and provider-health caches re-read Hermes state before reuse and bind
  entries to a non-secret SHA-256 credential identity. An expired credential
  therefore cannot inherit a five-minute cached-valid result or a cached model
  catalog from another credential/base URL.
- No auth file is refreshed or modified by Nebula. All locally rejected
  credentials remain configured-but-invalid in health; the model proxy returns
  a controlled 401 without sending the rejected bearer upstream.

## 2026-08-19 — Executed output canonicalization

- Live ElevenLabs TTS produced a valid MP3, but its executed event contained an
  absolute path under the disposable `isolated-output` root. The browser-side
  fallback recognized only paths containing a literal `/output/`, so the first
  media load failed; reload worked because persisted graph export independently
  canonicalized the same value.
- Make the backend event boundary authoritative: normalize handler outputs once
  into `/api/outputs/...`, persist that exact scalar/list shape, and broadcast
  the same value. Bare outputs are wrapped as `Any`; shaped types and non-media
  values are preserved. This avoids frontend path-name heuristics and prevents
  broadcast/persist divergence.

## 2026-08-19 — Replicate streamed media data URIs

- Flux Schnell returned through Replicate's `urls.stream` route in about 1.4
  seconds. That branch hardcoded Text, so its `data:image/webp;base64,...` value
  bypassed the engine's existing media materializer and produced an empty
  manifest. Extending only the polling inference path was insufficient.
- Route the complete streamed value through the same output inference as a
  polled result. Well-formed Image, Video, Audio, SVG, and GLTF data URIs now
  receive a media port type; centralized engine materialization remains the
  sole decoder/persistence boundary. Unknown/text data URIs retain Text
  fallback.
- The live retest rendered a persisted 1,024x1,024 WebP and wrote one manifest
  entry without base64. The provider returned a near-white image despite the
  prompt; record that as provider output quality rather than weakening the
  application persistence verdict.
- A later adversarial review found a separate transient leak: before final
  typing, the stream runner broadcast each accumulated SSE `output` value as a
  text delta. A media data URI could therefore cross the WebSocket and appear
  in `streamingText` even though final persistence was redacted, with repeated
  accumulated chunks also creating quadratic traffic. Replicate now supplies a
  tri-state prefix classifier. Plausible `data:` prefixes remain private until
  the header is decisive; recognized media is buffered with zero text-delta
  events, while ordinary and ambiguous text retains its original delta
  boundaries. Final inference and centralized materialization are unchanged.

## 2026-08-19 — Truthful agent attribution and acknowledged cancellation

- Chat action events were globally labeled `hermes` in the frontend even when
  the selected runner was Claude or Codex. `/ws/chat` now stamps every agent,
  tool, and graph-action event with the selected runner (`claude`, `codex`, or
  `daedalus`); the Agent Log validates and displays that source instead of
  inventing one client-side.
- Stop is now a three-state protocol: the backend emits cancellation
  `requested`, waits for the runner cleanup to finish, then emits `confirmed`
  or `failed`. The frontend remains busy and says only “Cancellation
  requested…” until confirmation; “Cancelled.” is reserved for the confirmed
  event, and disconnect/cleanup failures remain visibly failed.
- The first cleanup attempt started each agent in its own OS process group and
  killed that group. Its delayed-grandchild regression inherited the parent's
  group and passed, but the live Claude retest falsified the design: the Bash
  tool created PGID 90706 beneath agent PGID 89999. Stop killed the agent group
  and confirmed while the shell and Python sleep remained orphaned under PID 1
  until natural completion.
- Keep the acknowledged WebSocket/UI protocol, but reject process-group-only
  cleanup as complete. POSIX cleanup must snapshot and kill descendants even
  when they create a new group/session, then verify the discovered processes
  are gone before confirmation. Add a `setsid`/separate-PGID sentinel
  regression; treat any interrupted live follow-up honestly rather than
  repeating an agent turn beyond the approved allowance.
- The initial focused contract passed 42 backend tests and 11 frontend tests,
  but that validation ceiling did not cover re-grouped descendants. It is not
  a release result.
- The replacement POSIX cleanup freezes the root, repeatedly snapshots PPID
  descendants, freezes each newly discovered generation, kills every captured
  PID individually, then refuses to return until `ps` verifies they are gone.
  A deterministic root → child → `setsid()` grandchild test now covers the
  exact separate-session escape that the original inherited-group sentinel
  missed. Verification failure propagates, so the WebSocket reports failed
  instead of confirmed.
- Codex's `login status` preflight is now isolated and uses the same cleanup in
  `finally`; Stop before the main Codex spawn therefore cannot leak the status
  process. Windows continues to use `taskkill /T /F`, the native tree-kill
  primitive, but that branch cannot be runtime-proved from this POSIX lane.
  The revised focused agent group passed 116 backend tests and 11 frontend
  tests across cancellation, source attribution, and WebSocket/UI state.
- Agent attribution is enforced at the WebSocket boundary: the selected runner
  overwrites any runner-supplied `source`, so stale or hostile output cannot
  masquerade as another agent. If the socket disconnects after Stop but before
  confirmation, chat now adds a visible cancellation-failed warning stating
  that backend cleanup was not confirmed; the hidden state transition alone
  was not sufficient user-facing truth.
- The final Daedalus cancellation turn reached the UI and proved corrected
  `daedalus` attribution in the Agent Log, but the isolated backend and Vite
  sessions ended during the interrupted review before Stop/process inspection
  could finish. That one approved cancellation turn was not repeated. The live
  full-descendant result is therefore **inconclusive**, with the deterministic
  separate-session sentinel and verification-failure regressions as the exact
  cleanup proof ceiling.
- A release security pass found a second, implicit cancellation path: a raw
  WebSocket client could send another turn while one was active; the backend
  cancelled the first task, swallowed any cleanup exception, and started the
  replacement without the requested/confirmed protocol. Concurrent sends are
  now rejected until the client explicitly Stops and receives confirmation.
  This keeps process cleanup and user-visible cancellation truth on one path,
  even if a client bypasses the frontend's disabled-Send state.

## 2026-08-21 — Trackpad canvas navigation

- The canvas explicitly disabled React Flow's scroll-panning path, so a
  two-finger trackpad scroll changed zoom instead of translating the viewport.
- Match the Flora-style interaction split: ordinary two-finger scrolling pans
  freely in both axes, pinch remains zoom, and click-drag panning remains
  available. Mouse-wheel scrolling follows the same pan path by design. Keep
  the three React Flow flags in one typed, unit-tested contract so a future
  canvas refactor cannot silently restore scroll-to-zoom.

## 2026-08-21 — Collapsible canvas minimap

- Performance Mode previously made the minimap permanently visible; disabling
  the mode also removed render culling and controls, so it was not a suitable
  minimization path.
- Add a direct 30px minimize affordance inside the expanded minimap and retain
  a 44px restore target above the chat launcher when collapsed. Persist the
  choice independently of Performance Mode so the compact state survives
  reloads without sacrificing large-graph rendering behavior.

## 2026-08-21 — Flora-inspired workspace rail

- Treat the rail as navigation, not a set of independent floating windows. A
  single `leftDock` owns Nodes, Assets, Run History, and Settings; the legacy
  panel visibility fields mirror that authority so the existing panel content
  can be reused without parallel state paths.
- Dock panels are intentionally no longer draggable or resizable. Their stable
  rail-adjacent drawer geometry makes the active destination predictable and
  prevents several left panels from obscuring the graph at once. Chat remains
  an independent bottom-right surface because it supports a simultaneous
  canvas conversation rather than workspace navigation.
- Keep execution and graph-manipulation actions in the bottom toolbar, but move
  Settings out of it. Search opens the existing command palette, Help opens the
  existing onboarding, and Create reuses the existing studio route. Do not add
  Flora icons for Comments, Flows, or Profile until Nebula has real destination
  behavior for them.
- Centralize fit padding around the actual rail, dock drawer, chat, and
  inspector rectangles. The rail and dock are explicitly classified as left
  chrome and chat as right chrome; nearest-edge inference misclassified a
  full-height drawer as top chrome because its top inset is smaller than its
  left inset.

## 2026-08-21 — Flora-style mode-free canvas selection

- Remove the persistent Pan/Select toggle instead of merely defaulting it to
  Select. Empty-canvas left drag now always marquee-selects, while dragging a
  node still moves it. This matches Flora's direct manipulation contract and
  removes the hidden mode that made the same gesture unexpectedly pan.
- Preserve every alternative navigation path: trackpad/two-axis wheel scroll
  pans, pinch zooms, Meta/Control + wheel zooms, middle/right drag pans, and
  Space temporarily turns left drag into pan. Shift remains the additive node
  selection modifier and marquee selection uses partial intersection.
- Keep the whole React Flow gesture configuration in one typed, unit-tested
  `CANVAS_INTERACTION_PROPS` object. This prevents toolbar/state changes from
  silently reintroducing left-drag panning or splitting the interaction model
  across component props.

## 2026-08-21 — Contextual selection actions and shared agent context

- The existing Claude, Codex, and Daedalus agents could inspect the full graph
  through `nebula graph`, but none received the live React Flow selection. Do
  not persist selection inside graph nodes or `.nebula` files. A dedicated
  ephemeral backend store keeps only selected IDs and resolves every read
  against the canonical `cli_graph`, so a deleted/import-replaced node cannot
  survive as a valid selected handle.
- Publish IDs rather than client-authored node data. The backend derives names,
  params, outputs, and touching connections, caps collection/string sizes,
  drops internal fields, and redacts credential-like keys plus every data URI.
  Per-turn chat context is stricter still: it contains only IDs, definition
  metadata, and internal selection topology so parameter text can never be
  promoted into a system instruction.
- A WebSocket chat turn carries its own selected-ID snapshot in addition to the
  continuously published selection. This makes vague references such as
  “change these” atomic at Send time instead of racing a later canvas click.
  Approval follow-ups take a fresh snapshot because the user may legitimately
  change the selection while an agent is paused.
- The repository did not contain an MCP server; MCP appeared only in research
  and roadmap documents. Add a real read-only stdio server rather than calling
  the REST endpoint “MCP.” Pin the maintained official Python SDK v1 line at
  `mcp==1.27.0`: it is old enough for the repository's package-age security
  rule and is locally testable, while the newly released v2 line would add an
  unproved dependency/lifespan migration. The MCP process reads the same
  backend selection endpoint as `nebula selection`.
- The MCP SDK's unconstrained `sse-starlette` dependency currently selects a
  release that requires a newer Starlette than FastAPI 0.115.12 supports. Pin
  the existing `starlette==0.46.2` runtime and the mature
  `sse-starlette==2.4.1` release (which does not impose a base Starlette
  upgrade), plus `pydantic-settings==2.14.0` to avoid the newer release's
  unresolved-lifespan warning against Nebula's pinned Pydantic 2.11 runtime.
  This keeps the optional stdio bridge installable in the main backend
  environment without changing Nebula's HTTP stack.
- Keep the contextual toolbar capability-based. Nebula has real batch run,
  copy, duplicate, dependency-aware arrange, output download, agent, and delete
  behavior, so those are exposed. Do not add Flora-style grouping or shared
  parameter editing until the graph has an actual group model and a validated
  heterogeneous batch-edit contract; decorative controls would create false
  affordances.
- Batch deletion routes through the existing React Flow removal path so one
  undo record, CLI deletion mirror, edge cleanup, and Remotion source pruning
  remain atomic. Batch arrange operates on the selected induced subgraph and
  translates its computed layout back to the selection's existing origin.

## 2026-09-03 — World Labs Environment MVP

- Ship against the public World Labs Marble API and name the capability
  **World Labs Environment**. Atlas remains an adapter target only: its public
  announcement says partner early access, while the published World API does
  not expose an Atlas model identifier. Do not present Marble execution as
  Atlas execution.
- Introduce a first-class structured `World` port rather than coercing the
  provider bundle into `Mesh`. A generated world owns several related assets
  (SPZ resolutions, collider GLB, panorama, thumbnail), provider/world IDs,
  and metric/ground metadata that must remain atomic across graph edges.
- Preserve provider assets in the graph run directory before emitting success.
  Store local paths in the `World` object and in derivative output ports so a
  signed provider URL cannot become a stale successful output. Download every
  returned SPZ resolution plus panorama, collider, and thumbnail; do not put
  API keys or signed query strings into manifests.
- Render `World` with a dedicated, lazily loaded Spark/Three.js viewport.
  The graph card uses a cheap thumbnail/fallback; the expanded viewer loads a
  bounded preview SPZ first and lets the user opt into full resolution. Clean
  up animation frames, controls, renderer, and WebGL resources on unmount.
- Keep generation and export separate. World generation exposes the provider's
  ordinary collider and visual assets; an explicit World Labs Export node owns
  paid HQ-GLB or PLY export requests, polling, local materialization, and its
  own cost-facing parameters.
- Keep World Labs Environment Canvas-only for this MVP. Create Studio currently
  launches concurrent variation runs without Canvas run history or Stop/recovery
  ownership; exposing a paid non-idempotent start there would make lost-response
  and repeated-click ambiguity unrecoverable. Re-enable it only after Create
  adopts the same tracked execution contract.
- Treat accepted World Labs IDs as durable paid-work checkpoints. A
  cancellation-shielded POST handshake captures the provider response, then a
  `providerRecovery` event persists and hydrates the operation/world ID before
  Stop can terminate local polling. Generation advances from
  `resume_operation_id` to a pinned `existing_world_id`; export keeps its
  `resume_operation_id`. Clearing the field, rather than an ordinary rerun, is
  the explicit request for a new paid operation.
- Match history replay to the real billing boundary rather than treating every
  World Labs node as paid. A fresh environment or fresh HQ GLB export is blocked
  unless its exact accepted-operation/world ID is restored, including legacy
  completed records; free PLY conversion remains a normal replay. Checkpoints
  are journaled by exact run/node and hydrated before startup graph-empty guards;
  a fully checkpointed snapshot becomes an explicit **Recover** action that
  resumes/fetches existing paid work without another POST. A journal write
  failure preserves the live ID but emits a durable=false warning that remains
  visible through cancellation; volatile records expose their actual ID but no
  forget action, and cleanup failures return HTTP 507 instead of claiming
  durable deletion.
- Reserve every fresh paid start and every supplied recovery ID before the
  execution task is scheduled. One OS-locked, fail-closed lifecycle boundary
  coordinates all backend processes, pre-admission Stop intent, unresolved
  submission ambiguity, provider checkpoints, and graph mutations. Capacity
  exhaustion refuses new paid work instead of evicting a safety record. This is
  deliberately stricter than per-process task maps: stale tabs, simultaneous
  workers, imported recovery params, or an immediate recovery/fresh-start race
  must not issue a duplicate provider POST.
- Do not replay POST/DELETE graph or execution mutations after backend
  rediscovery. GET/HEAD discovery can safely retry; a mutation with a lost
  response is status-reconciled by its run ID. Frontend execution ownership
  persists through Stop and reconnect until the backend reports a terminal raw
  execution status. Transport-ambiguous provider starts require a Marble check
  and exact run-identity acknowledgement; a stale acknowledgement cannot clear
  a newer hold.
- Treat recovery/ambiguity hydration as merge-only, no-eviction safety state.
  An old snapshot may conservatively over-lock but cannot erase a newer live
  checkpoint. Save, clear/import, undo/redo, deletion, clone, duplicate, and
  paste either block during unresolved paid state or carry the current recovery
  identity. Server-confirmed graph clear is the sole authoritative bulk reset;
  individual recovery deletion is conditional on the exact identity the user
  saw so run-ID reuse cannot clear newer work.
- Bound every untrusted boundary independently: provider downloads are
  streamed and format-validated; SPZ previews are source-bounded, header-
  preflighted, and fully gzip-inflated for CRC/exact-length validation before Spark;
  browser graph JSON and ZIP bundles have byte/shape/member limits; ZIP
  extraction is backend-only and validates the graph before writing assets.
  Restore and graph import remain two HTTP calls, so a network failure between
  them can leave an unreferenced restore directory even though it cannot erase
  or partially replace the current graph.
- Browser GLB viewing is explicit and lazy rather than eager: the model viewer
  mounts only after a bounded 128 MiB fetch, and Blob URLs/resources are cleaned
  up on close. Panorama downloads derive their safe extension from the backend-
  validated local path rather than falsely labeling every image as PNG.
- Structural and mocked-provider verification is intentional for this pass. No
  billable generation or HQ GLB export is required for acceptance; live UI
  proof uses a local SPZ fixture and therefore cannot establish provider-account
  billing, latency, or signed-URL behavior.
- Use one percent-aware portable path policy for graph-bundle collection and
  restore remapping. Unsafe or omitted local references become explicit
  unavailable values with warnings; retaining the old URL could silently bind
  an imported graph to an unrelated same-named output on another backend.
- Emit frontend-created ZIP members with STORE compression. World assets are
  already compressed, and DEFLATE made highly repetitive but valid graph JSON
  exceed the backend's compression-bomb ratio even when every byte and member
  limit was otherwise satisfied.
- The production compile exposed a global entry-budget regression while the
  World viewer itself remained correctly lazy. Keep React/Zustand, React Flow,
  and JSZip in stable named vendor chunks rather than weakening the 512 kB /
  160 kB entry limits. This makes feature-code growth visible again and lets
  browsers cache those shared frameworks independently.
- Spark 2.1.0's generic PLY reader ships an optional `new Function` parser
  compiler plus a non-codegen fallback for CSP-constrained pages. Nebula's
  World viewer accepts only fully preflighted SPZ, so the Vite build transform
  disables that unused compiler in both Spark's main module and embedded worker
  source. The existing all-chunk scanner remains strict—there is no Spark
  exemption—and fails if the pinned dependency changes its markers.

### Final adversarial follow-up

- Exclude both World Labs nodes from the generic one-hour execution-output
  cache. Their durable recovery IDs are the idempotency mechanism; caching the
  original no-ID parameter set would otherwise turn an explicit recovery clear
  into the old result instead of a deliberately fresh operation.
- Treat an export operation's returned `resolution` or `mesh_variant` as
  identity evidence when present. A resumed operation with conflicting live
  settings now fails before download instead of saving a correctly formatted
  but semantically mislabeled asset.
- World previews and graph imports accept asset references only through
  Nebula's `/api/outputs/` boundary (including localhost backend URLs that are
  rebound to the discovered backend). Imported provider/CDN/LAN URLs are
  removed with a warning, preventing a graph file from causing automatic
  cross-origin thumbnail requests or interactive fetches. `marbleUrl` remains
  a separately validated World Labs HTTPS navigation link.
- Fetch SPZ viewer bytes with `cache: no-store`. The output route has no
  immutable-cache contract and files may be archived or deleted independently
  of the graph, so a browser cache must not make a removed World asset appear
  live again after the backend returns it unavailable.
- Persist a pre-provider intent under an OS advisory lock and fsync both the
  replacement file and its parent directory before allowing a paid POST. The
  lock is deliberately shared across World generation, HQ export, recovery,
  graph replacement, and all backend workers; a second local backend therefore
  cannot turn a process-local timing window into duplicate spend.
- Classify provider 3xx, 408, 5xx, malformed success bodies, and transport loss
  as ambiguous acceptance. Only a trustworthy provider ID or a definite client
  rejection releases the fresh-start uncertainty. Ambiguities require an exact
  kind/node/run acknowledgement so a delayed old-tab action cannot erase a
  newer hold.
- Keep pre-admission Stop IDs permanently denied after their inspectable exact
  records are compacted. A fixed 1,048,576-bit, seven-hash Bloom filter was
  chosen to bound storage without unsafe eviction. False positives can
  conservatively reject a novel run ID; false negatives (and therefore delayed
  cancelled-run admission) are not permitted.
- Register per-shot Cinema tasks in the normal execution registry even though
  the frontend intentionally leaves the Canvas-wide execution gate open. This
  gives the task strong ownership, cross-worker Stop observation, and a terminal
  release fallback when cancellation lands before the coroutine's first turn.
  Cinema's nested base dispatcher also uses a strict four-model allowlist so a
  crafted scene cannot invoke a World handler below top-level admission.
- Validate port data types on the backend for direct connect, import, and
  clustering, using the same contract as the frontend: exact types, `Any`, and
  the intentional Image/Mask interchange are compatible. A structured `World`
  value cannot be wired into an Image or Text input through a raw API payload.
- Register `.spz` as `application/octet-stream` explicitly. The live macOS UI
  proof exposed a platform MIME mapping to `text/plain`; SPZ has no registered
  standard media type, and an opaque binary response avoids proxy or download
  clients interpreting compressed Gaussian-splat bytes as text.

## 2026-09-03 — World Labs live defect closure

- Preserve a blank string only for optional numeric parameters during backend
  coercion. The World node intentionally uses `seed: ""` as its Random sentinel;
  required numeric fields still reject blanks instead of weakening validation.
- Treat a returned backend rejection as authoritative, and a lost response
  after mutation dispatch as ambiguous. Node creation falls back to a
  frontend-only UUID only when backend discovery fails before any mutation is
  sent. HTTP 400/409/503 responses leave the canvas unchanged; a lost or
  malformed post-dispatch response reconciles through graph export/graphSync or
  keeps an uncertainty fence that blocks another create until sync/reload. This
  prevents both rejected-node ghosts and commit-then-response-loss duplicates.
- Route one selected node through the existing target-node execution contract,
  whose backend derives the authoritative ancestor closure. Multi-node selection
  remains an intentionally induced cluster. This keeps an upstream prompt in a
  single selected World run without changing multi-selection semantics.
- Reset raw Marble scenes from their transformed capture origin, not a splat
  density center. For `marble_raw_opencv`, the position is
  `[0, +groundPlaneOffset, 0]` facing Three.js `-Z`; sampled geometry bounds are
  limited to speed, control limits, clipping, and unknown-frame fallback.
- Do not traverse every splat twice on the browser main thread. Navigation
  bounds use at most 8,192 stratified indexed reads from `PackedSplats`; the
  Canvas/camera stay mounted while quality or Orbit/Fly mode changes, and only
  initial world load or explicit Reset repositions the camera. A decode that
  resolves after unmount receives a second terminal dispose.
- Keep the World surface inside Nebula's Slava token language while strengthening
  keyboard focus locally, including an inset ring on the actual WebGL canvas
  that cannot be clipped by the stage. Keep every quality variant reachable
  through a narrow-screen scroller, place the aria-modal viewer above the global
  recovery banner, and collapse Open in Marble to a centered icon on compact
  layouts.
- Reused the completed Mediterranean rooftop output for browser QA and made no
  additional paid World Labs request. A temporary default World node was added
  through the real node library, verified as backend ID `n4`, then deleted after
  confirming there was no local UUID ghost; the original three-node graph and
  two edges were restored.

## 2026-09-04 — Atlas-ready spatial foundation

- Keep Atlas absent from the executable public catalog. World Labs currently
  publishes Atlas only as select-partner early access, with no public model ID,
  endpoint, pricing, limits, cancellation, idempotency, or asset contract. The
  foundation therefore uses local schemas, fixtures, and backend-authoritative
  capability states; a frontend flag or configured Marble key cannot enable an
  Atlas request.
- Extend Nebula around provider-neutral, versioned spatial values rather than
  adding `atlas` to the Marble model enum. Existing `World` schema v1 graphs
  remain schema v1 on import and are adapted to v2 in memory. Persistence
  canonicalizes their supported fields and local assets instead of retaining
  opaque provider metadata.
- Separate authoring primitives from future billable provider tasks. Camera
  pose/path, spatial context, and sensor descriptions are deterministic local
  nodes. Future Atlas generation, reconstruction, reframing, and simulation
  adapters remain unavailable until an official versioned contract is installed
  and entitlement can be verified without starting billable work.
- Treat paid-operation admission, recovery identity, cache bypass, and quick-run
  eligibility as one backend registry. Per-operation billing conditions and
  recovery parameter names live in policy data so a new provider operation
  cannot silently skip the lifecycle classifier.
- Accept absolute paths only while they resolve inside the configured Nebula
  output root, then canonicalize them to `/api/outputs/...`; persisted spatial
  values never retain provider URLs or machine-specific paths.
- World Labs Export consumes the original Marble World v1. Adversarial review
  found that importable World v2 session metadata cannot authenticate a provider
  resource ID, so v2 export fails before HTTP until an adapter supplies a
  backend-verified resource binding. Local v1-to-v2 adaptation remains available.
- Keep the provider guide focused on the executable Marble workflow and make
  `docs/spatial-foundation.md` the canonical architecture/boundary reference.
  Document schema-ready values separately from implemented producers so the
  presence of depth, point-cloud, sensor-stream, or World-v2 contracts cannot
  be mistaken for a callable Atlas capability.

## 2026-09-05 — Spatial adversarial corrections

- Final-source verification checkpoint: 1,973 backend tests in 41.80s; 737
  frontend tests across 81 files; production build/budget, generated model docs,
  and diff checks passed. Inspected actual saved ZIP: graph.json and both image
  members present. Native Save/Load dialog remains the outstanding observed-UI
  acceptance gap; normal Dia use needs a quiet user-approved interaction window.

- Legacy parity closeout found two remaining edges: browser version lookup
  could skip invalid canonical values for a snake alias; backend null splat
  entries could skip control/trim validation. Both boundaries now reject these
  inputs consistently. 58 focused browser/import and 29 backend contract tests
  pass. Full pre-closeout checkpoint: 1,973 backend, 736 frontend, build passed.

- Native Dia testing stopped when CUA reported user activity; no further
  interaction with that browser. A temporary integration test exercised real
  saveToFile ZIP generation and real backend restore with picker I/O captured
  by the test. It exposed mapping.requestUrl persisting absolute backend URLs,
  which caused SpatialContext to be discarded. Restore mappings now preserve
  portable paths. The live archive test passes with nine nodes/six edges,
  correct context pose n7, zero warnings, and restored image HTTP 200. Added
  separate-origin regression to repo tests. Native file-dialog behavior remains
  unverified; archive bytes exist at the temporary runtime spatial-live.nebula.zip.

- Normal-browser save verification could not start: Chrome is unavailable to
  CUA. Source inspection found graph save revoked fallback Blob URLs immediately
  unlike World downloads. Applied the same 1s deferred cleanup with finally
  removal, and regression-check scheduled revocation. This closes a potential
  asynchronous download race; it is not a claim about the in-app save root cause.

- Rendered remaining six actual preview components in a temporary-only Vite
  fixture page (depth map/sequence, point cloud, stream, session, World v2).
  Screenshots show complete cards; links deliberately use synthetic paths and
  no decoding/provider proof is claimed. Depth-sequence metric labels now say
  first resolution/encoding because later frames can legitimately differ.

- World v2 now rejects contradictory MIME roles in both parsers: splats must
  declare their matching SPZ/PLY family, panorama/thumbnail supported raster
  media, colliders glTF. Generic octet-stream remains accepted for untyped
  local bytes. This is metadata consistency, not proof of byte-level validity;
  decoders must still validate content before interactive rendering.

- Depth cards now expose convention/byte order, scale/offset formula, and
  invalid sample policy as three bounded property chips so compact-card metric
  truncation cannot hide them. Added a rendered component assertion. Full
  regression after sensor/depth/cache/fit/import changes: 1,973 backend tests,
  732 frontend tests across 81 files. Production build/budget checks passed.

- Depth maps now require explicit sample scale/offset, invalid-sample sentinel
  (null means no finite sentinel), axial versus ray-distance convention, and
  byte order (including container-defined for encoded containers). Decoded
  distance = sample * scale + offset in the declared unit; nonfinite samples
  are always invalid. This tightens unreleased draft data without guessing
  defaults. It does not implement or attest an image/raw-depth decoder.

- SensorStream now requires an embedded SensorRig snapshot. Stream rigId,
  sensorId, modality, and coordinate system are checked against that snapshot
  in both parsers. This tightens the unreleased v1 foundation contract; older
  draft fixtures without a rig must be regenerated, not silently assigned one.
  It validates stream-to-rig binding, not physical calibration or provider truth.

- Added docs/spatial-foundation-acceptance.md as a requirement-by-requirement
  evidence ledger. Corrected the architecture status from shipped to acceptance
  in progress. Remaining semantic issues are explicit: depth decoding, sensor
  reference binding, media conformance, rendered fixtures, and live file save.
  Focused capability/policy/admission/start-guard regression: 86 passed.

- Extended file-import regression across all ten spatial port types: a boolean
  schema version drops only the invalid output, retains its node, and returns
  a warning. All 41 graph-file tests pass. Existing tests cover valid plain-JSON
  spatial round trips. Actual Save button was clicked, but no observable saved
  artifact/confirmation was available in the in-app browser; do not count that
  click as proof of completed disk save or load.

- Cache-identity follow-up: engine regression executes two identical Camera
  Pose nodes twice with a shared cache and requires each output ID match its
  node; all 26 cache tests pass. Restarted only isolated backend PID 6854
  (replacement PID 23204), which restored nine nodes/six edges. Two actual
  canvas runs now preserve n1/n2/n4/n7 identities and context n9 anchors n7.
  Screenshot shared. This proves backend restart restoration and cached rerun,
  not yet the user-facing file save/load round trip.

- Actual Spatial Context run exposed cross-node cache aliasing: default Camera
  Pose n7 reused output ID n4. Local spatial author cache keys now include node
  identity because pose/path/rig/anchor IDs derive from it. Other nodes retain
  their prior content-key behavior. Live restart/retest remains required.

- Canvas fit previously reserved side panels but omitted the top canvas tabs
  and bottom execution toolbar. Added their measured bounds to shared fit
  padding with the existing 24px safety gap, plus a regression for both edges.

- Actual isolated 5175 canvas QA: rechecked the two-pose Camera Path output
  (strictly ordered 1s/2s, duration 1s), then added and ran Camera Pose -> Sensor
  Rig -> Spatial Value Validate through the canvas Run control. Both downstream
  cards show one RGB sensor in nebula-world. Shared screenshots of both flows.
  Cluster ingress correctly rejected cross-cluster existing-node references
  before the self-contained cluster was submitted. No provider calls were made.
  Fit-to-screen makes six spread-out nodes small and top canvas chrome overlaps
  the path header; assess viewport fit/occlusion during remaining visual QA.

- Post-alias full regression checkpoint: 1,968 backend tests passed in 65.97s;
  720 frontend tests passed across 81 files. Production TypeScript/Vite build,
  bundle-budget/eval checks, generated model reference check, and diff whitespace
  check passed. Build still warns about the deferred Spark vendor chunk size.
  These checks do not close the remaining contract audit or canvas acceptance.

- Collider camel/snake aliases now both undergo URI validation, with null
  camel-case values falling back to the legacy spelling. This aligns backend
  adaptation with browser imports and prevents hidden invalid alias values.

- Legacy splat aliases now validate every supplied asset even when an earlier
  alias wins. Null aliases do not reserve a resolution; the first non-null
  valid asset wins. Browser validation also checks reserved variant names on
  null entries, matching the backend. Added regression cases on both sides.

- Default Camera Pose nodes now share the catalog's `nebula-world` frame, so
  separately authored default poses compose into a path or rig.
- Graph candidate writes reject non-finite JSON and roll back only newly seeded
  recovery records on a failed graph commit. Once atomic rename succeeds, a
  directory fsync error is surfaced as a durability warning while memory adopts
  the committed disk state.
- Raw graph ingress applies bounded recursive validation before staging; float
  coercion also rejects non-finite values. Schema versions reject booleans and
  quaternion normalization uses a stable norm. Thumbnail-only World values are
  invalid, and World summaries include spatial-context reference assets.
- Optional spatial nulls normalize to absent fields in both browser and backend.
  Successful execution now verifies referenced spatial files exist before
  emitting or caching a result, including legacy World assets.
- Verification checkpoint: 213 focused backend tests passed on 2026-09-05.
  Frontend Vitest is still running through iCloud-backed dependencies; full
  regression and rendered UI acceptance remain pending.

## 2026-09-05 — Regression runtime recovery

- The repository's installed frontend dependencies failed before test collection
  (`aria-query` destructuring and JSDOM constructor errors). A disposable runtime
  at `/tmp/nebula-spatial-verify.siqQGO` was installed from the existing lockfile
  with lifecycle scripts disabled; package versions and repository dependencies
  were not changed.
- That runtime passed all 717 frontend tests across 81 files. The production
  build exposed the missing spatial union in `PortValue.value`; adding the
  actual spatial types fixed TypeScript. Production build and bundle checks
  then passed (34 JavaScript assets eval-free).
- Regenerated MODEL_REFERENCE.md from the 179-node catalog and verified the
  generator's check mode. Full backend run: 1,960 passed, five older fixtures
  failed after stricter handler/port admission and catalog growth. Fixtures now
  use registered nodes and substitute canonical provider handlers at their
  source, preserving the identity gate during offline cache tests.
- Browser verification found the existing 5173 preview blank. The clean runtime
  on 5175 renders the node library and a locally added Camera Pose node; a
  screenshot was shared. Backend is offline, so this is rendering evidence only,
  not end-to-end execution acceptance. Legacy canonicalization parity and the
  remaining contract findings still require closure.

- Legacy World v1 output persistence and execution now reconstruct a validated
  field allowlist. Unknown provider fields, opaque billing objects, and supplied
  navigation URLs cannot carry signed URLs into graph/cache records. The Marble
  navigation link is derived from the World ID on both backend and browser.
  Cache rebinding continues to verify the referenced physical files while the
  structured value remains portable. Focused canonicalization/cache/import
  regression: 71 tests passed.
- Browser legacy asset URLs now reject query strings as well as fragments,
  matching the unsigned spatial reference contract. Localhost output URLs
  without a query still normalize to portable paths. The 60 focused frontend
  World/spatial/import tests pass after this correction.
- Full backend regression completed after canonicalization and fixture fixes:
  1,966 tests passed in 40.87 seconds. This does not close the remaining schema
  acceptance parity findings or substitute for backend-connected UI execution.
- Legacy browser parsing now uses the backend's 64-entry splat-map ceiling and
  preserves insertion order/first alias occurrence. Oversized maps and invalid
  asset bundles reject rather than silently truncating or filtering assets.
  Missing splats, malformed asset/semantics containers, unsupported coordinate
  frames, and nonpositive scales reject at the browser boundary. Import removes
  the invalid output with its existing warning instead of persisting a partial
  World. Viewer tests now require valid local splats in their valid fixtures.
- Browser metadata validation now matches backend ID/model/label bounds using
  Unicode code points; 61 focused frontend tests pass.
- Started an isolated backend at 8000 with state/output under
  `/tmp/nebula-spatial-backend.ZuuVFf` and settings pointed to an absent file
  there. Through the real 5175 canvas, created backend node n1 and executed
  Camera Pose successfully. Screenshot QA found the structured card inherited
  photographic header overlap and a pale theme; spatial CSS now uses a dark
  readable card and a more-specific zero-overlap rule. A subsequent screenshot
  confirmed title and output no longer overlap. This proves the single local
  node flow; multi-node spatial flows remain to be verified.

## 2026-10-01 — Paper source loop

- Built only in the managed `paper-linked-source` worktree from parent HEAD; parent uncommitted work and brand-lab remain independent.
- Use the currently installed official Paper CLI (`~/.paper/bin/paper mcp`); no new dependency, copied credential, watcher, or provider run on refresh. Transport and snapshot lifecycle are separate.
- Paper tools export one explicit file/page/object. Token contentHash is not an artwork revision; snapshots record observed PNG bytes, SHA-256, capture time, bounds, scale, actual alpha and transparency. An artboard export can be opaque even when a nested object is transparent.
- Keep immutable content-addressed PNGs and metadata in the isolated output root. SQLite request sequences reject late exports/errors and preserve histories across backend restarts. Failed reconnect retains the old binding until a successful export.
- The source handler resolves only the snapshot pinned into the submitted recipe. Existing handlers read/upload local owned media; no cloud provider is given a localhost preview URL.
- File/page link is the honest Open in Paper fallback: installed tools expose open_file, but no object-select/navigation tool. No object navigation claimed.
- Browser downstream proof will use an explicitly labeled deterministic fixture; paid provider execution is a separate unproven limit.

- Added an accepted `paper-inputs.json` receipt inside each Paper-backed backend run directory before dispatch: original snapshot descriptor, stable SHA-256 recipe revision, nodes/settings/edges. Credential field names are excluded; actual API key dictionaries never enter the receipt. Frontend history retains exact submitted snapshots and outputs for replay and inspection.
- Browser acceptance exposed derived video duration/FPS metadata falsely invalidating a just-finished run; exclude those observed-output fields from recipe revisions, while retaining real prompt/model/settings/connection changes.

- Explicit rerun exposed a source-history regression: trimmed request-only snapshot arrays were being merged back into the live canvas/source. Preserve equal-sequence live source records on graph sync and canonical source histories on backend export; run receipts remain pinned to one input.
- Added the source to the utility test manifest and advanced the intentional catalog-size assertion to 180 after the full backend suite caught both old catalog baselines.

- Live deletion returned a surviving Paper tombstone (same ID/name/size, null parent, no children) and a blank PNG instead of an error. The adapter must validate reciprocal ancestor membership to the exact page before and after export. The disposable fixture retains that early blank capture in history; repeated acceptance checks use the corrected adapter, without erasing earlier test evidence.
- Historical replay uses an explicit `preserveGraphParams` request flag: execute saved settings, keep live edited params, and retain output/recovery writes. Ordinary runs still persist handler-derived metadata. The backend guard is required because a frontend-only preservation rule would be undone by graph sync.
- The deterministic local fixture copies the immutable PNG before its artificial delay. Refresh to C during a B run kept C current and completed against B. This proves input pinning and deterministic compositing, not paid-provider generation or identical generative motion.
- Unchanged-refresh copy says no new snapshot; it no longer implies an already-stale output became current.

### Paper execution pins: final backend review

- The snapshot store allows an optional expected hash for preview delivery. Execution now requires both snapshot ID and content SHA-256 to be complete lowercase 64-hex strings before lookup; an incomplete saved recipe cannot silently omit its promised hash.
- Paper sources bypass the ordinary graph output cache so every run verifies the original immutable snapshot bytes. A preseeded unrelated cached success cannot substitute artwork or hide damaged source bytes.
- The complete backend suite passed 2,482 tests before this final pin-validation adjustment. The affected Paper/cache/utility/Video QC gate passed 108 tests after the adjustment; this distinction keeps the full-suite evidence tied to the code actually tested.

- Installed export schema has no transparent-background override. Export settings record `background: artwork`, and actual PNG alpha/transparency is measured separately. The card makes no promise to strip an opaque artboard background. Earlier disposable captures retain their earlier intent metadata.

### Paper final backend validation

- Final stabilized code, including replay preservation and SDK grouped-error handling, passed the complete backend suite: 2,542 tests, exit 0, 61.54 seconds, 12 inherited FastAPI startup deprecation warnings. This supersedes the earlier pre-tightening full-suite ceiling.
- Fixture protocol checks now include the exact page-root reciprocal ancestor chain before and after export. Export settings describe native artwork background; no unsupported transparent-background override is recorded, and actual alpha remains derived from PNG bytes.

### 2026-10-01 — Paper desktop navigation follow-up

- The installed Paper 0.5.13 app ships a `paper://file/<file>/<page>/<object>` deep-link parser. Its main handler restores/focuses the window; the tab handler forwards the full page/object route even for an already-open file. This is a separate capability from MCP `open_file`, which cannot select an object or activate an existing tab.
- Open in Paper now follows that desktop link directly in the click gesture. Electron routes it through the existing native external-link bridge. A visible HTTPS Open source link targets the same bound object and remains available when a browser has no protocol handler.
- Links are derived from validated stable IDs instead of imported `openUrl` strings. Opening does not read selection, refresh, mutate source records, or execute a recipe; existing snapshot metadata stays immutable.
- The real HTTPS fallback click opened the bound file/page/object route and displayed the logo. Browser automation blocked `paper://` navigation by security policy; no alternate desktop launch was attempted. Actual desktop activation/selection remains unverified. This browser is a guest viewer: artwork is visible, but editing/selection API verification requires an existing Paper login. No sharing/access setting changed.
- After opening and reloading, the same source hash, last refresh time, 7 source snapshots, 2 nodes, 1 edge and 4 run-history entries remain. Focused frontend lifecycle/desktop-mode/state checks pass (66), native bridge checks pass (139), and TypeScript/build/budget, targeted ESLint and CSS guards pass.

### 2026-10-01 — Paper feature demo

- The user personally confirmed that Open in Paper takes them to the desktop app, then requested a 40-second captioned landscape demo. The desktop transition uses edited real captures of the source link and its native Paper destination; it is not a continuous automated protocol-launch recording.
- Demo captures use separate local ports 5191/8021 and `output/paper-demo`, preserving the original acceptance graph, history and runtimes. The downstream result is the visibly labeled deterministic video fixture; no paid generation, package installation or provider credentials are used.
- Captured the real pink logo link/run, changed only the disposable Paper artwork to cyan, refreshed its source, captured the stale pink result, explicitly reran the saved recipe with the latest source, and captured the cyan result plus both history entries. Restored the editable Paper artwork to its original pink after capture. The demo's immutable cyan snapshot remains available independently.
- The video composition, captures and verification evidence live in `videos/paper-linked-source`. Use the already installed HyperFrames 0.8.41 renderer and its existing browser; the published version is older than 14 days. Source captures are actual UI plates with designed captions and editorial reframing.

### 2026-10-01 — Scoped publication to GitHub main

- The user authorized publishing the Paper feature and demo to GitHub main. The original isolated feature branch includes 60 unpublished ancestor commits from other development, so publication uses a second managed worktree based on current `origin/main` (`07b3c957`). Only the two Paper commits and the verified demo are ported; the parent Design-agent checkout and other active brand-system session remain intact.
- Main lacks the unrelated general file bridge, native dialogs and chat-workspace guards. The port keeps main's alert/confirm conventions, adds a narrow frozen Paper-link IPC namespace, and validates the native exported PNG with a standalone Paper path guard. No unrelated feature family is pulled into this change.
- The scoped-main backend passes all 2,129 tests. A fresh native Paper export through the new guard returns the actual original pink PNG at 480 × 360 with transparency and its expected SHA-256. The native tool writes to Downloads; the transport accepts that ordinary export path instead of assuming temporary-only output.
- Full frontend passes 818 tests in 86 files, lint, TypeScript, production build and bundle budget. The 180-node contract gate, provider inventory and generated model reference checks pass. The original development-worktree test counts elsewhere in these notes describe that earlier checkout, not main's smaller test baseline.
- The 40-second 1080p captioned demo is included on GitHub with its editable composition, actual UI plates and verification evidence. Native Paper plates exclude unrelated project tabs; uncropped originals stay local. The final movie contains 1,200 frames and passes full decode and encoded-frame visual review.
- Desktop validation: 267 non-UI tests pass; after the documented desktop build, all four Electron integration checks and the single-instance check pass. Two preexisting resilience assertions count every uvicorn process on the machine and expect zero, so the four preserved preview/service processes prevent those assertions from passing. No running service was stopped and no test was weakened.
- The scoped changed-file credential scan found only an inherited CSS class substring in Canvas, already present on origin/main; added-line and staged-artifact scans found no credentials. Dependency symlinks and raw native screenshots are excluded from publication.

### 2026-10-02 — GitHub README cleanup

- Reuse the managed `paper-main` worktree at current GitHub main; leave the active parent Design-agent checkout and untracked demo project untouched. Publication contains documentation and one image only.
- Keep the README frontmatter schema and existing banner for possible external portfolio consumers, but shorten the descriptions and remove stale node/provider/test counts. Replace repeated catalog, workspace, architecture and agent tables with focused links to their existing guides.
- Put Paper Source near the top with a frame from the already reviewed sharp demo. The image depicts the demo's actual UI and saved outputs; it is not new acceptance evidence or a new provider run. Link the existing published demo source rather than add another large movie to Git.
- Move contributor commands into GitHub's standard `CONTRIBUTING.md` and add a user-facing Paper setup guide. Keep the requirement that refresh only captures artwork and marks results out of date; a saved recipe must be rerun explicitly.
- Quickstart uses Python 3.12 (the CI target), Node 24 (compatible with the checked frontend/desktop lockfiles), and root-relative commands in separate terminals. This corrects the old Node 18 requirement and ambiguous working-directory instructions without installing or changing dependencies.
- Review corrected the first-run example to the exact GPT Image 2 library name, qualified staleness to changed artwork, and made the cross-page reconnect instructions explicit. Contributor pytest commands set the backend import path rather than rely on test collection order.
- Validation: the README is 114 lines instead of 483; all 31 relative links/images resolve, frontmatter parses with the retained schema, the 1920 × 1080 PNG is valid, and GitHub's Markdown API renders all three edited guides. No application code or dependencies change, so no application suite is rerun for this documentation edit.

### 2026-10-03 — Krea image/video provider catalog

- The user confirmed the broader Krea image/video catalog, using one Krea API key. Reuse the isolated worktree on `codex/krea-provider` from published main; the active Design-agent checkout and untracked Paper demo stay independent.
- Krea already has Settings, credential, health and legacy Krea 2/style integration. The missing piece is its third-party model catalog, not another key field. Use explicit Krea-backed model definitions instead of silently choosing a provider based on which keys happen to be present.
- The official public OpenAPI snapshot advertises 33 image and 41 video generation routes. Generate first-class definitions and exact model controls/ports from those schemas for Canvas and compatible Create workflows. Preserve the existing six nodes and their saved graph IDs. Other advertised enhancement, audio and 3D routes remain outside this image/video scope.
- Bundle the schema snapshot needed by those routes so offline graph creation and execution do not depend on live documentation availability. Keep a refresh/check script and source URL/hash with the catalog; regenerate MODEL_REFERENCE from the canonical Nebula registry. API schemas establish documented compatibility, not live generation proof for every model.
- Shared Krea gateway transport validates model-specific requests before submission, uploads local media including immutable Paper snapshots, retains plural image/video outputs, and polls/cancels jobs using Krea only. Model paths are bound to bundled definitions, never user-supplied URLs. Saved graph IDs and recipes pin the selected Krea route.
- Update the outdated only-Krea-2 guide/skill scope and incorrect Turbo path, while retaining legacy style/moodboard guidance. Show an accessible Provider filter in Create's existing model picker so the new catalog is easy to find. No package installation or credential copying is part of the implementation.
- Promote the already installed transitive `jsonschema` dependency to an explicit `4.26.0` pin for request validation. The canonical PyPI publication date is 2026-01-07, safely older than 14 days; no package is installed or upgraded.
- Gateway ports are optional wire alternatives to the same required control values; schema validation enforces required fields before uploads or paid submission. This avoids the existing graph validator requiring a wire even when the field is set in a control. Nullable scalar types and nested numeric choices need normalization for ordinary numeric/enum controls, rather than JSON textareas.
- An additional `artifacts` output retains typed local previews alongside primary image/video arrays. Bind one run directory for all artifacts. Keep provider credentials out of artifact-download requests, and request upstream cancellation on Stop/timeouts rather than silently resubmit.
- Review caught Create's `_variant` cache discriminator in requests for seedless models. Strip that one engine-owned field before provider validation, preserving it in graph/cache state and retaining strict rejection of other unknown fields. Empty optional enums are omitted only when their schema does not admit an empty value.
- Control review found numeric enum selections became strings, and optional values appeared to have defaults that the API never declared. Preserve option value types in Create and Canvas; show blank numeric fields and explicit Default/Choose states when there is no schema default. Clearing an optional choice removes it from the request.
- Keep three advanced routes Canvas-only in Create: Runway Gen-4 Image needs tagged reference objects, H3 camera controls needs a structured trajectory, and Flux Video Edit needs source video. Create's image-only attachments and scalar controls cannot supply those inputs. Cinema's base-model dispatcher has a separate four-model allowlist and is not expanded by this provider catalog.
- Preserve original non-Krea registry formatting in the generator, as well as existing definition values. Catalog checks/regeneration remain offline; refresh alone never submits generation. Live QA uses isolated ports 5203/8033 with temporary state/output/settings and no provider credentials.
- Review found plural outputs were usable in live graph edges but not collected by bulk download or graph ZIP save. Return portable owned output references for plural media and typed artifacts, preserving the existing absolute-path singular port convention. Cache rebinding must retain those portable references while owning fresh copies in each later run; old run artifacts remain untouched.
- HTTP media URL validation is self-contained because plain `jsonschema` installs can omit optional URI-format checkers. Reject malformed input/upload/result URLs before use without adding URI-extra dependencies. The explicit schema validator still checks required fields, bounds, enums, and JSON structure.
- Final validation: all 2,290 backend tests and 844 frontend tests pass, along with frontend lint, TypeScript/production build and bundle budget, offline catalog/reference checks, and all 254 node contracts. All 180 original definitions remain identical; 26 local documentation links resolve.
- Real browser QA verified Krea provider filtering, model selection without generation, blank/provider-default controls, and Canvas node creation with typed media/JSON ports. Deterministic execution uses mocked Krea HTTP with real PNG and FFmpeg/ffprobe media validation, downstream uploads, provider cancellation requests, and two-run cache/manifest checks. No paid Krea generation or workspace-wide live model availability is verified.

### UI repair details

# Single supported appearance — 2026-10-07

- Removed alternate theme registry, Settings picker, command-compatible theme setter, and unsupported Hermes runtime CSS. Slava Restraint is the sole supported appearance; the existing readonly `skin` state stays available to Canvas/node/Inspector rendering code, avoiding unrelated renderer changes.
- Startup now rewrites any saved `nebula:skin` value to Slava, removes legacy Hermes tone storage, and clears obsolete theme/tone/transition/bloom body classes. Storage failures still return/apply Slava. Historical design/research folders remain as provenance; the public Hermes portrait remains because the screenshot suite uses it as fixture artwork.
- Daedalus selection keeps its original agent/session/model/provider and Auto/Step controls. Removed only the old theme-switch/tone/bloom side effects and their UI. Agent switches no longer change app appearance.
- Removed the obsolete theme-setter call from capture and utility/screenshot helpers and updated the capture reference. Replaced the screenshot guard's deleted-picker switching sequence with supported-appearance, legacy-reload migration, Settings/no-picker, and Daedalus appearance checks. Only syntax-checked this browser guard; no browser automation ran for this task.
- Included root-requested Settings changes: Performance mode copy now mentions minimap only, plus `usePanelFocus(visible && shouldRender, ...)` wiring and dialog metadata. The delayed-unmount condition ensures the DOM ref exists before focus is requested; Settings remains a nonmodal dock. Unit regression verifies Escape close/opener restoration.
- Targeted gate: 61 tests across 6 matched files passed (skins, ChatPanel appearance, Settings, uiStore, palette); TypeScript, touched-file ESLint, CSS scope guard, inline-style guard, and diff whitespace checks passed. No paid jobs, package edits, browser actions, Electron work, or commits.

# U04: Graph file commands across workspaces

- Moved Save/Load ownership out of the Canvas-only Toolbar into one headless `GraphFileActions` component mounted once under App's persistent ReactFlowProvider. Root added the App import/mount; this agent did not edit App.tsx.
- Toolbar buttons and CommandPalette use shared `requestGraphSave` / `requestGraphLoad` dispatchers. Only the controller registers event listeners, preventing duplicate dialogs during StrictMode or view changes.
- Standard Cmd/Ctrl+S/O are also handled at document level in every workspace, including Editor/Remotion where Cmd+K is intentionally reserved. Skip defaultPrevented events so Canvas's existing React keyboard handler dispatches only once. This document handler runs before the legacy Editor window-level Cmd+S no-op; editor shortcut ownership stays unchanged.
- Kept the existing `saveToFile` / `loadFromFile` pipeline unchanged: portable bundles, asset restoration, browser/native file-dialog behavior, warnings, and backend-first atomic graph import still use their existing implementations.
- Added shared admission predicates for execution and Create preparation ownership (`createLaunchingIds`); Save retains its paid-start ambiguity restriction. Palette and Toolbar disabled states match controller checks. Load rechecks ownership after the file picker and after response JSON so an active or preparing generation cannot have its live frontend graph/workspace reset by a delayed callback.
- After successful Load, show Canvas and clear obsolete editor target/selection/playback state. Do not call previous editor exit cleanup against newly imported node IDs. Prior run history remains intact. Existing fit-to-loaded-graph behavior stays.
- Retain the last real Canvas viewport while another workspace is mounted, because ReactFlow may reset its transform on Canvas unmount. Saves from Create/Cinema serialize that viewport.
- Removed alternate-theme command generation and `setSkin` / `SkinId` caller plumbing, coordinated with audit_frontend's Slava-only theme change.
- Validation: 77 tests passed across GraphFileActions, Toolbar execution, CommandPalette, command data, graphFile, Cinema roundtrip, and Cinema deleted-shot history suites. TypeScript build, touched-file ESLint, and git diff --check passed. Tests cover Create/Cinema commands without a Toolbar, standard file shortcuts in Create/Cinema/Editor/Remotion, Canvas shortcut delegation, picker cancellation, backend rejection, duplicate-dialog prevention and listener cleanup, and execution/preparation admission both before and during asynchronous Load phases.
- No browser actions, paid jobs, package changes, commits, or parent-checkout edits by this agent.

- Model selection now uses a viewport-constrained portal dialog. Search and provider controls stay outside the scrolling results; Escape closes once, Tab stays inside the modal, and closing restores its opener. Settings/Chat docks restore focus without trapping it.
- At compact widths an open drawer reserves a separate navigation row; its minimap temporarily hides without changing the saved collapse preference. This avoids moving the old left-edge overlap to the right edge.

### 2026-10-07 — Ordered backlog delivery

- Begin with the audited web/backend and single-appearance UI changes, using the existing isolated worktree based on published main. The parent Design-agent checkout, local diverged main and isolated Brand Lab remain untouched. Review and publish this change before selectively bringing over the existing QC truthfulness and acknowledged Create-save fixes; the larger Commons feature is a separate integration.
- A fresh release review found that batch manifests could assign the last invocation's handler-enriched parameters to earlier outputs. Correct effective-parameter snapshots, including cached invocations, before publication; preserve saved recipes and previous artifacts. Detailed review repair evidence is recorded in `docs/audit-release-review-notes-2026-10-07.md`.
- The persistent file controller also needs a shared import reservation: a late HTTP-response check cannot undo an earlier replacement broadcast. Reserve immediately before import, refuse generation admission while it settles, and add a backend active-run check before commit so another client cannot replace a running graph. Saved Create reruns must carry their immutable Create origin so gallery Stop and capacity counting remain available.
- Release gates use the existing installed dependencies and isolated test state. Full frontend/backend checks, node contracts, generated reference parity, staged credential scan and GitHub CI precede merge. Packaged Electron remains outside the user's chosen scope; the previously documented browser native chooser completion limitation is not treated as resolved.
- Final local release gates passed 2,442 backend tests and 997 frontend tests in 105 files, full lint/build/budget, all 254 node contracts and generated-reference parity. The staged scan found no credentials; its initial `sk-` substring hit was part of a CSS mask variable and was corrected with a token-boundary check. Current source and review evidence are included; private captures/state remain excluded.

### 2026-10-07 — Selective QC and Create-save integration

- Bring over the existing parent fixes as a second scoped change, using selected hunks rather than merging Design-agent or copying its complete CreateView. Preserve the newly published audit lifecycle/import fences, Krea selection and single supported appearance. Commons, agent-profile, desktop bridge and isolated brand work remain separate.
- Unmeasured identity/expression QC results must be unavailable, not zero-valued passes. OpenCV face geometry/edge metrics remain named proxies with coverage and provenance; valid vision-model numeric reports are advisory and must not be described as semantic quality proof.
- Create result saving must await the existing export API and acknowledge only a nonempty saved path. Pending, cancellation, error and retry remain distinct. Replace style-name window.prompt with the shared in-app text-entry dialog; await preset persistence before refreshing the library. Keep the existing web export service and downloads intact.
- Regression coverage must exercise the real CreateView-to-ResultCard save delegate and a deferred preset write, as component-only mocks would miss a swallowed export rejection or premature library refresh. No provider calls or packages are needed for these ports.
- Independent review also found stale export acknowledgements when the same Canvas node replaces its output URL. Scope ResultCard save state/timers to node and media identity and guard each request: completing an old export must not mark a replacement output saved, display its error, or unlock a newer export. The old export may still finish; the UI reports only its current artifact.
- Final local gates passed all 2,471 backend tests, 1,015 frontend tests in 107 files, full frontend lint and production build/budget, 254 node contracts and generated-reference parity. The build budget measured 297,021 bytes raw / 83,042 bytes gzip with 34 eval-free JavaScript assets. These are isolated local checks; native browser picker completion remains a separately documented limitation.

- The next art-direction slice remains separate. Camera Rig and Reference Set currently have no typed generation consumers. Their first Cinema integration should translate explicit prompt guidance and ordered reference images, label its limits, and verify outgoing requests. Character strength support must be checked per actual consumer; the existing Identity Edit fidelity injection is absent from its exact FAL Nano Banana 2 Edit schema and needs correction in that slice. No new generation-control mapping is adopted by this QC/save port.

### 2026-10-07 — Cinema art-direction consumers

- Implement in the isolated release worktree from published main. Add optional typed Camera Rig and Reference Set inputs to Cinema, including its existing single-shot path. Source edits and disconnections only change graph state; generation still requires Run/rerun, and saved recipes retain their frozen inputs and earlier outputs.
- Camera Rig becomes explicitly labeled prompt guidance. Reference Set priorities determine stable image order; zero excludes, duplicate URLs share one delivered image with all associated roles in an indexed prompt legend. Keep serialized weight keys and stored identity-strength values compatible with existing files.
- Disable unsupported semantic identity-strength controls rather than presenting a model adherence knob. Remove unsupported Identity Edit fidelity injection after checking the exact current FAL schema. Keep real local palette-transfer strength enabled.
- Current adapter inspection exposed a deeper reference bug: Seedream's Cinema base dispatches text-to-image even when images are supplied, while generic FAL mapping can emit singular and plural image fields together. Correct the reference-aware base routing and request fields, and cap the final image list against the actual selected adapter/model before any provider submission. Preserve the original no-reference text-to-image route.
- Request verification also found that Seedream 5 Lite has no seed and Identity Edit has no mask input. Omit unsupported outbound seed/fidelity/strength fields without changing saved parameters. Preserve the legacy Mask port/edges, label its limitation, and reject a nonempty mask before submission. Restrict Seedream's seed and Auto 3K UI choices to the variants that support them; evaluate visibility against declared defaults without writing defaults into saved state.
- The custom Cinema card previously exposed only its Character Refs handle despite a declared Character input. Render all four declared inputs with separate labeled rows. Position each Reference Set role's handle within its own row. Native Chrome on isolated ports 5211/8041 verified both new click-to-connect paths, camera editing and connection persistence on reload; no generation was requested. A Vite hot-reload wire offset disappeared on a fresh page reload; no unrelated global edge renderer was changed.
- The full backend run found the legacy role-metadata baseline intentionally freezes five changed node definitions. Preserve that historical guard with exact approved-delta assertions, rather than excluding those nodes or replacing their baseline fingerprints.
- Peer review caught a reverse-model switch: a saved Seedream 5 Lite Auto 3K value must not disappear visually when switching to 4.5 while remaining in the request. Show the retained choice explicitly as unavailable, allow a valid replacement, and reject unsupported sizing before transport. Keep the saved value until the user chooses its replacement.
- Final transport review found that hidden saved base parameters could replace the validated Cinema prompt/reference list in FAL's request builder. Reject only those reserved input fields within Cinema before submission, retaining the source recipe and leaving the shared builder unchanged. Character expansion now defers its cap check to Cinema's final adapter check so its conservative original-Gemini limit is described accurately.
- Treat an omitted model selector as its adapter default, but reject explicitly stored empty or non-string selectors. Previously the cap helper treated these as defaults while the actual adapter dispatched an unknown route. Preserve the invalid saved value for explicit correction, with zero provider calls.
- Final local gates passed 2,634 backend tests and 1,030 frontend tests in 109 files, full frontend lint and TypeScript/production build, 254 node contracts and generated-reference parity. The build budget measured 298,478 bytes raw / 83,355 bytes gzip with 34 eval-free JavaScript assets. Provider payloads and saved replay were verified with mocked transport and real local PNG artifacts; native Chrome verified typed connections, editing without generation and reload persistence. No paid generation or image-adherence claim is part of this evidence.

### 2026-10-07 — Archived Batch branch reconciliation

- Reuse the isolated release worktree from published main `9cd707bf`; inspect the clean archived `feat/batch-cross-pair` branch at `2d7634d3` without altering that checkout or the parent Design-agent work. Its 33 commits include 17 obsolete baseline-cleanup commits and 16 Batch commits; the first-class Batch source and carousel are absent from current main.
- Restore the single-text Batch foundation through the current invocation-context scheduler rather than merging its older engine, cache, events and store over current lifecycle/artifact safeguards. Retain the original `batch` ID, `set` handle and authoring parameter keys. Current scalar Text ports remain authoritative; separate per-item results and lineage describe fan-out without migrating all port types.
- Bound Batch expansion with the existing 1–25 item-cap convention (default 10), rejecting overflow before downstream calls rather than silently truncating supplied items. Source edits and carousel navigation remain free of generation; Run and saved rerun retain their current explicit admission and immutable history.
- Cross/Pair joins, failure-rate policies, cost estimates, Compare Grid and provider pricing are later slices. Preserve the original archived branch/tag as historical evidence and document exactly which Plan 1 behavior was recovered and tested.

- Keep carousel selection local to each rendered node/run; it never changes canonical outputs, downstream inputs or saved parameters. Hydrate only the latest owning history record whose last result matches the current scalar output, comparing objects independent of key order. Known terminal run IDs remain fenced after reload; cloning clears galleries and undo preserves the current execution result.
- A selected Mask Painter result must display its captured produced artifact. Reconstructing a composite from live upstream inputs can show a different Batch item than its label/download; retain live composite editing only outside result browsing.
- Frontend JavaScript trim and Python strip disagree on BOM and control separators. Use the exact ECMAScript trim set for backend line parsing, with regression coverage; whole-text mode remains byte-preserving.
- Native Chrome verified creation/Inspector authoring, seven-item Batch-to-Preview execution, red/orange navigation, end clamping, connection/gallery reload, source edits without generation, frozen seven-item rerun after live source changed to two items, and an explicit current-source run. All browser execution was local utility work without provider credentials.
- The first aggregate gate exposed three catalog inventory fixtures that needed the new Batch local-execution/utility entry and count 255, plus an unrelated intermittent Settings loading test failure. The unchanged frontend suite then passed all 1,107 tests; final suite gates are recorded after the remaining history presentation and utility-manifest changes.
- Final local gates passed all 2,692 backend tests and 1,116 frontend tests in 113 files, full frontend lint and TypeScript/production build, all 255 node contracts and generated-reference parity. The entry budget measured 303,577 bytes raw / 84,895 bytes gzip with 34 eval-free JavaScript assets. The maintained legacy browser smoke script was syntax checked; native Chrome supplied the actual browser evidence.
- Run History now describes fanout counts as execution steps, displays captured item labels/lineage, and falls back to numbered results for legacy or malformed metadata. Metadata array indices must match output order; malformed metadata is discarded without losing otherwise valid outputs/recipes. The complete archived Cross/Pair roadmap remains separate.

## 2026-10-07 — Selective Commons integration

- User approved the next integration after readiness commit `5a935731`. Start from published main `6f7e7155` in clean managed release worktree, branch `codex/commons-integration`. Preserve parent dirty work, existing current features, real library/linked folders and human reader/evaluation decisions. Real activation, backup/restart, model calls and publication are separate from implementing the inactive integration.
- Bring across only committed Commons domain/UI and security modules plus their regressions. Exclude research outputs, prototypes, old themes, unrelated desktop changes and whole-file replacements of current runner/App/store behavior. Compose current Krea MCP and Daedalus dispatch with the scoped authority/workspace design.
- Commons defaults off through strict `NEBULA_COMMONS_ENABLED=1` opt-in. A non-storage capability response allows UI discovery; all real Commons routes and lazy runtime factories fail before state access while disabled. Startup must not mint human authority, recover jobs or scan links when disabled.
- Agent turns use backend-owned opaque conversation IDs and revoke scoped tokens before done/cancellation acknowledgement. Existing raw Claude/Codex conversation IDs must start a new chat with `/clear`; prior files/history remain on disk. Enabled Commons admits only Claude/Codex because Daedalus has no verified private file profile. Default-off Daedalus retains its existing contract.
- Independent lifecycle review found second-send validation could finish an active response, done could precede drainer settlement, and malformed envelopes could bypass cleanup. Move admission before validation, distinguish completed resource cleanup from transport draining, and clean up on every WebSocket exit. Regression tests use fake runners/transports only.
- Existing HTTP test fixtures used non-loopback Host values. Update them to loopback so lifecycle/Krea regressions exercise the route behind the new local request guard; do not widen the production Host allowlist.
- The historical human actor key is retained for record compatibility, while user-facing comments, API authority errors and reader guidance refer to the local user instead of a fixed personal name. This is a presentation change, not a real-store migration.
- Final integration gates passed 3,357 backend tests and 1,183 frontend tests in 126 files, full lint/TypeScript/production budget, 255 node contracts and generated-reference parity. Independent review closed actual Krea decoded-media and Paper export/snapshot read gaps. Native Chrome verified default-off discovery and synthetic opt-in artwork/comment persistence plus canvas/chat-draft preservation; zero analysis calls. Staged secret/whitespace checks passed; local-only publication boundary and real activation remain explicit.

### 2026-10-07 — Create UI continuity and result browsing

- Start the UI improvement backlog with one complete Create slice: durable unfinished composer drafts, bounded result browsing, keyboard/touch result actions and visible reference-upload lifecycle. Keep the current single appearance and existing shared generation/history ownership. Cinema and Settings repairs remain separately scoped follow-ups.
- Reuse the attached isolated release worktree at published main 362d201b. The dirty Design-agent checkout, real backend, credentials, Commons store and parallel Brand Lab remain untouched. Existing installed dependencies suffice.
- Draft state is session-scoped and persisted in origin-local browser storage. Initial Canvas selection seeds only a draft that does not yet exist; returning to Create resumes it. Explicit Styles handoff still applies once. New draft resets composer state, not the session ID or historical runs, and cannot generate.
- Uploads belong to the draft rather than the mounted Create component. Persist only pending/error metadata and accepted backend references; File objects and AbortControllers remain transient. A reload converts pending uploads into an interrupted state requiring reattachment/removal. Per-item attempt identity fences removed, reset or retried uploads, while functional updates preserve later prompt/model edits.
- Gate generation both in the composer controls/keyboard path and immediately before job reservation against latest draft/upload state. Pending or failed intended references require resolution before generation; no upload, navigation or draft restoration may submit a model job.
- Put reference tray and composer in a bounded footer in normal layout flow, so wrapped controls reserve their real height. Keep gallery toolbar stationary and cards in their own scrolling region. Short-height views must retain reachable results and composer, with compact list rows and explicit action/focus affordances.

- Native Chrome exposed compressed implicit Grid rows despite passing unit tests. Split the bounded scroll viewport from natural card content, set max-content rows, and fit artwork inside a fixed aspect preview; rechecked 30 results in Grid/List at 100% and 200%.
- Final proof: 129 frontend files / 1,225 tests, lint/style guards, TypeScript/build/budget and independent review passed. Native draft navigation/reload/reset and fullscreen focus passed; 200% footer scroll keeps controls reachable.
- Upload proof boundary: real isolated HTTP upload accepted valid PNG and rejected malformed PNG with 415 detail. The native file picker did not appear through computer use, so pending/error/retry/remove UI was verified with component integration/deferred responses rather than claiming native picker success. No provider/agent calls, real workspace mutation, dependency installs or main merge.

### 2026-10-07 — Cinema uploads and Settings recovery

- Continue the UI backlog in the same isolated branch. Cinema upload completions must append references to the latest scene/shot by stable identity, preserving newer edits, outputs, connections and saved history. Convert authoring callbacks to functional field updates; graph replacement and target deletion revoke pending upload ownership even when IDs are restored.
- Keep upload metadata separate from saved graph parameters and run recipes. Files/controllers are transient; reload shows interrupted references requiring explicit attachment/removal. Gate current-recipe generation against shared and selected-shot uploads, while an unrelated sibling shot and frozen historical replay retain their existing admission behavior.
- Settings must load successfully before saved fields can be edited or written. Preserve unsaved drafts in page memory across panel unmount, never browser storage; provide visible load/write errors and explicit read retry. Removing a provider key is a dedicated, idempotent provider-scoped DELETE and preserves other keys/settings and Krea MCP consent.
- No new packages, provider calls, packaged Electron changes, real credentials or parent checkout changes are needed. Broader Cinema layout/override controls and the remaining discovery/onboarding polish stay in later slices.
- Independent review exposed two lifecycle boundaries: clearing run history must retain current upload ownership, and terminal-owner settlement before graph hydration must retain restored interrupted metadata. Prune unknown restored targets only after authoritative graph hydration; target deletion and explicit replacement still revoke requests immediately.
- Serialize/coalesce Cinema scene persistence and temporarily protect newer authoring from stale WebSocket echoes. Suspend pending scene saves during import; resume on a failed import while retaining fresh runtime media. Accepted replacement discards the old suspension. A five-second bound releases successful writes without socket acknowledgements; client abort cannot undo a server commit.
- Browser echo protection alone could hide canonical data loss: a delayed whole-scene PUT can replace fresher completed shot media on the server. Preserve backend-owned output, variations and selected variation by stable shot ID when applying Cinema authoring edits. Graph import remains the separate authoritative replacement path.

- A successful graph import now tags its authoritative WebSocket update. This invalidates old upload/save ownership and fully replaces frontend nodes/edges even if HTTP acknowledgement is lost; ordinary synchronization remains a merge. Browser key values trim before Save, so whitespace-only fields follow the displayed blank-key preservation behavior.

- Reverse synchronization also needs the same ownership boundary: whole-scene generation now merges only actually produced shot outputs into current authoring. A private execution marker distinguishes produced data from untouched/cancelled snapshot fields, including cache hits and Batch invocation clones. Canonical/live ports exclude removed shots while complete produced artifacts remain in frozen Cinema run history. Other handlers retain their existing synchronization.
- Peer review caught a partial-cancellation mismatch: a settled shot could display its new image while its downstream port still held the old one. Terminal synchronization now commits both produced shot runtime and its matching done/error port, including disk reload, while retaining unrelated siblings.
- Final integrated gates passed: 3,425 backend tests and 1,298 frontend tests in 136 files, lint/style guards, TypeScript/production build/budget, independent review and staged whitespace/credential scans. Native synthetic Chrome verified Settings recovery/removal and Cinema authoring reload; native file selection remains unverified. No paid calls, real credentials, parent checkout changes or publication occurred.

### 2026-10-08 — Dependable Cinema motion handoff

- Continue in the clean isolated UI branch at f74d3413. Keep this slice to motion handoff feedback, connection confirmation, retry ownership and Canvas destination focus; broader Cinema layout/overrides stay separate.
- A dedicated Cinema endpoint creates or reuses the exact shot-to-Veo image connection atomically. Its existing graph edge is durable retry identity, avoiding duplicate destinations after lost HTTP acknowledgements without adding a credential or operation registry. Source artwork must still match the requested settled result. Existing target authoring/results remain intact.
- Page-memory feedback belongs to the source node and shot across panel navigation. Deletion/retyping/import/clear revoke obsolete callbacks; accepted HTTP responses adopt only the verified pair, never a full graph snapshot. Frontend-only scenes create a local node and typed Image edge together with an undo snapshot.
- Sending, retrying, reconciling and viewing a video node never submit generation. View uses a volatile Canvas focus request consumed after mounting and measuring the target, rather than an event fired while Canvas is absent.
- Review found a delayed successful HTTP reply could restore a pair deleted in newer authoritative synchronization even if the original creation event was lost. Capture a volatile graph-sync revision per attempt; an intervening sync that omits the exact pair requires explicit idempotent retry. Retyped targets reject before any edge adoption.
- Native synthetic testing passed failure → Retry → connected destination → Canvas selection/centering with no generation requests. It also exposed Cinema shot edges exporting as Any despite their Image contract; correct the canonical exporter so socket and HTTP confirmation agree.
- Final review caught canonical edge-only removal being retained by the generic optimistic-edge merge. Drop only previously confirmed server motion wires omitted by the new snapshot; preserve other frontend optimistic edges. Graph replacement also clears unmeasured focus ownership so reused IDs cannot redirect it.
- Final gates passed 3,465 backend tests and 1,342 frontend tests in 140 files, lint/style guards, TypeScript/build/budget and independent review. Native Chrome validated failure/retry, the Image wire and focused destination with one idle video node, empty video outputs and zero generation requests. Temporary fixtures/proof stay outside Git; no real app/settings/providers or main publication were touched.

### 2026-10-08 — Cinema selected-shot layout and controls

- Start from published main `94baa0e6` on isolated `codex/cinema-layout-controls`; keep the parallel Design-agent checkout and real app untouched. Preserve the established dark appearance and explicit generation.
- Use a collapsed scene summary with an expandable, bounded settings inspector. Desktop puts the selected preview beside its prompt and actions; compact/short layouts use a reachable scrolling body and smaller rail instead of spending the whole viewport on shared controls.
- Expose all four connected Cinema input roles by source identity, including connections awaiting an output. View on Canvas must resolve the surviving connection before selecting and centering its actual source; inspection never executes upstream models.
- Palette/look overrides edit only the selected shot through latest-state functional patches. Reset removes that override and restores inheritance. An explicitly selected named shot preset must not inherit scene custom sliders/LUT that clobber its grade; unmodified partial overrides keep their existing inheritance contract.
- Replace pseudo-button shot cards with native selection buttons and separate remove/reorder actions. Preserve selected shot identity and useful focus through reorder/delete; provide keyboard navigation and an explicit reorder equivalent.

- Independent review found authoring updates could scroll the compact body back to the rail. Key that effect by selected identity and ordered IDs rather than every shot-object change. Bound the shared settings/upload band so recovery rows cannot consume the selected editor.
- Match visible defaults and summaries to actual rendering: missing custom look scalars resolve to zero, legacy palette fields resolve to current defaults, and a saved source image without palette swatches does not claim an applied reference palette. Unknown saved model/method values remain exact rather than silently appearing as a known choice.
- Final gates passed 3,479 backend tests and 1,391 frontend tests in 144 files, lint/style guards, TypeScript/production build/budget and independent review. Native Chrome at 100% and verified 200% zoom exercised selection, explicit inheritance/reset, prompt/strength edits, Alt-arrow reorder and connected-source Canvas centering. All seven synthetic nodes, six edges and earlier images survived with zero generation requests. Temporary fixtures/proof remain outside Git; owned servers/tab were closed, with no real workspace/provider change or publication.

### 2026-10-08 — Model discovery and provider setup clarity

- User approved merging/pushing Cinema first; remote main is verified at `ffcd5bf8`. Continue the next slice in isolated `codex/model-discovery-setup`, preserving the parallel checkout, real app/settings and packaged Electron exclusion.
- Share source-backed search vocabulary across Nodes, Create and command search: friendly categories/providers, actual ports, catalog model options and existing capability notes. Task aliases explain user intent without inventing per-model guarantees. Keep Create's existing required-input exclusions.
- Keep the catalog browsable before setup. Separate adding/selecting a model from its setup action. Open Settings at the relevant credential or connection while preserving the draft, graph and earlier history.
- Presence means configured, not verified. Existing read-only provider checks run only after explicit Check connections. Session status must expire and reject old responses after credential changes; never expose raw provider exception details. A successful credential probe does not promise model entitlement or successful generation.
- Resolve actual credential routes rather than vendor labels: configured direct keys retain precedence over FAL, Krea token/sign-in modes remain distinct per saved recipe, and keyless Paper/Cinema/Nous nodes retain their other prerequisites. This slice changes discovery and feedback, not execution admission or saved billing modes.
- Independent review found legacy Ideogram Reframe lacking resolution still executes through FAL. Readiness now honors that exception; catalog rows use the defaults addNode saves, while selected recipes use their actual saved params. Supported-route filters include direct/FAL alternatives without changing the active route.
- Settings verification counts and model labels share one timestamp validity predicate. Expired/future checks are never counted as verified; one shared expiry timer clears displayed verification without another request. Fresh Settings loads also reject older credential-cache revisions while preserving dirty drafts.
- Native browser proof used private synthetic connections on 5222/8052, never real accounts. The controlled browser clock differed from the host; matching fixture timestamps were required to exercise successful verification. Initial mismatched timestamps remained unverified as intended. Final fixture proof preserved seven existing nodes/six edges after adding n8, with zero generation requests and three explicit connection checks.
- Final checks: 1,475 frontend tests/148 files, lint/style guards, TypeScript/production build/budget, 255 node contracts and independent reviews passed. Native normal/200% checks covered search, recovery, setup focus/draft retention, explicit check failure/retry, separate keyboard setup and disconnected addition. No backend handler, dependency or Electron changes.

### 2026-10-08 — Onboarding for the current workspace

- Continue the UI queue on isolated `codex/onboarding-current-navigation`, based on the local discovery slice. Keep the parallel checkout, real accounts and packaged Electron out of scope.
- Teach one passive five-step workflow using stable rail/chat targets: find a model, connect its provider, use Create, inspect earlier runs and ask the agent. Derive the catalog count from current definitions; moving through the tour never checks credentials, edits a graph or starts generation.
- Replace the destructive welcome sample-graph action with Start browsing. Reopening from a studio returns to Canvas so the targets exist, stops preview playback and retains graph selection, editor identities, drafts, connections and earlier runs.
- Portal the dialog outside the app so background content can be inert while its controls remain visible in the spotlight. Contain keyboard navigation and workspace shortcuts, restore the opener or Help when it has unmounted, and measure the real card/target rather than assuming a fixed height. Missing/replaced targets retain a usable centered tour.
- Independent review found a delayed initial hydration failure could reset panels and pull someone out of a newly entered studio. Gate first-run reset and onboarding together on the latest empty Canvas, incomplete onboarding and no active tour. User work/navigation wins over a delayed empty/error response.
- Native background clicking exposed focus loss to the page without a focus-in event. Keep background pointer-down from blurring the card and capture otherwise-unfocused keyboard events; Escape still dismisses and workspace shortcuts stay blocked. Let in-card focus scroll its own bounded content at high zoom, and fall back to Help when initial body focus cannot be restored.
- Final gates passed: 1,523 frontend tests/151 files, lint/style guards, TypeScript/production build/budget, all 255 node contracts and independent reviews. Native Chrome normal/200% verified every live target, navigation, background focus and Create draft retention. Seven synthetic nodes/six edges and exact graph export survived with zero generation or connection checks. Private proof stays outside Git; owned servers/tab were closed and the original browser state was restored. This slice remains local.

### 2026-10-08 — Result context and comparison

- Continue on isolated `codex/result-context-comparison` above the local discovery/onboarding commits. Keep this slice to gallery context, two-result comparison and explicit draft reuse; no publication, provider calls, dependencies or Electron changes.
- Live nodes can contain edited parameters and stale Create-origin captions. Attribute an artwork only to a terminal saved run whose actual result outputs match; inspect its frozen recipe and resolved inputs. Unrecorded artwork shows current settings explicitly and cannot claim saved-recipe reuse.
- Comparison pins output URLs and their context at selection, independently of later node edits/reruns, filters or deletion. Keep existing history and graph connections intact. Copy one result into a new draft revision with one variation, preserving its saved provider route; invalidate old uploads/asynchronous composer work. Provide Undo for the previous ready draft until further authoring changes it.
- Independent review found ordinary runs never retained `resultOutputs`; fixture-only metadata would have hidden a broken real loop. Record every owned executed node’s output immutably, including generated upstream prompt/reference values, before terminal settlement. Reject unknown nodes, unowned and terminal writes. Preserve Paper/Cinema freshness and existing replay semantics.
- Keep the gallery mounted for the whole Create visit so deleting the last live result cannot discard a pinned comparison. Other dual-provider recipes still use current configured credentials; make that visible in recipe details. Krea’s explicitly saved access mode remains pinned. Undo restores ready references and warns when unfinished attachments were revoked.
- A primary-input-only disclosure would undercount Kling start/end frames. Keep every connected input in frozen display metadata, while admitting only recipes that Create can reproduce without dropping ports. Count recovered image inputs explicitly; parameter-based references remain in saved settings.
- Final gates passed: 1,575 frontend tests/156 files, lint/style guards, TypeScript/production build/budget, 255 node contracts and independent review. Synthetic browser reuse/Undo, focus and comparison preserved the exact seven-node/six-edge graph with zero generation/check/handoff requests. Desktop geometry and compact layout were inspected; native Chrome/Dia control prevented actual 200% zoom proof, and the wide in-app screenshot clipped to its visible panel. Those limits are recorded rather than treated as passed visual checks.
- Captured the full normal-width gallery in native Dia after final source verification. Modal/reuse interactions remain proven in the in-app browser; actual native 200% zoom remains open. Close owned preview tabs/servers and restore the original browser state before handoff; no fixtures or screenshots enter Git.

### 2026-10-08 — Shared workspace navigation and controls

- Continue the approved UI queue on isolated `codex/workspace-navigation`, based on local result comparison commit `139b2019`. Keep the parallel Design-agent checkout, real running app/accounts and packaged Electron untouched; no publication is requested.
- Consolidate the active workspace identity and Canvas return pattern, remove covered Canvas/Editor controls from studio keyboard focus, and make secondary Canvas file/layout actions discoverable in a bounded menu. Preserve explicit Run/Generate, selected objects, drafts, saved history and prior Canvas viewport.
- Inspection exposed real continuity gaps beyond the covered controls: Canvas remount refits, Cinema resets its selected shot, and Character/Moodboard unmount drops invalid or pending-autosave drafts. Preserve those values in volatile UI/draft state by object identity; authoritative graph replacement resets Canvas camera/shot context, while explicit View on Canvas still owns target centering.
- Use one shared heading/return component inside each existing workspace layout. Commons retains its dirty-labeling guard and actual prior-workspace return. Canvas identifies itself with a heading and one contextual Edit video action; file/layout tools use an ordinary-button disclosure, with Fit retained only in Canvas navigation. No new animation or global appearance changes are needed.
- Independent review caught fixed-height rows and lazy stylesheet ordering that would undo wrapped headers. Give shared headers measured auto rows, bounded scrolling and stronger scoped layout rules; wrap Composition's inner tool groups. The secondary-actions surface composites existing glass onto the Canvas base so graph text cannot interfere with menu labels.
- Review required canonical draft aliases after a first save, persisted per-draft analysis ownership and resolved project IDs in cache keys. A new/saved asset now has one mutable draft, overlapping responses cannot clear another request's busy state, and a reconnect to another project cannot save the previous project's draft into it. Explicit New starts a new epoch; pending Canvas handoff navigation yields to later studio changes.
- Fence delayed graph-import fitting on any workspace transition, including a quick away/back round trip. Enable Edit video only for the selected settled node's actual Video output. Video preview keyboard playback yields to native controls and prevented events.
- The synthetic preview initially omitted the separate Moodboard-root override, which allowed a read-only list of existing library entries. No existing entry was opened or edited; add the override and restart before Moodboard authoring verification. Screenshots and fixtures remain outside Git.
- Final gates passed: 1,680 frontend tests/163 files, lint/style guards, TypeScript/production build/budget, all 255 node contracts and independent reviews. Synthetic browser checks retained Create/Character/Moodboard drafts, Cinema selection and exact Canvas camera, with seven nodes/six edges unchanged and zero generation/check/handoff requests. Compact menu/headers were inspected at 600×379; native browser 200% zoom remains unverified. No dependency, backend handler, real asset/account or packaged Electron change; local slice only.

### 2026-10-08 — Approved UI integration

- User approved merge and push of the four completed UI slices. Fresh remote main is ffcd5bf8; the isolated checkout fast-forwards main to e78ad4f3 without changing the parallel Design-agent checkout. Keep the tested commit history intact and update acceptance-document integration status. No new application code, dependency or Electron change is needed.
- Retain the final 1,680-test/lint/TypeScript/build evidence for the identical application tree. Current generated-reference parity, 255 node contracts and informational provider inventory pass. Publication requires a final outgoing credential/private-artifact scan and exact remote-hash verification; GitHub CI is checked separately from local validation.

### 2026-10-08 — Compact workspace sidebar

- User requested removing the unused vertical space in the Canvas sidebar. Work from published main 3ef2d9a5 in the existing isolated checkout; preserve Design-agent and Brand Lab.
- The rail stretches because both top/bottom are fixed and its groups use space-between. Fit its height to the actual controls, preserve top/left position, width, destinations, click targets and keyboard/onboarding identity. Short windows use tighter gaps/padding and 40px controls; exceptionally short windows need bounded scrolling with native title/accessibility labels instead of clipped custom tooltips. No action or generation behavior changes.
- Browser drawer/resize checks exposed a related existing Fit View bug: the built-in control captured padding during render and retained a closed compact drawer's width, moving the graph offscreen. Measure current chrome when Fit is clicked and fall back to the rail reservation when a covering drawer leaves no canvas area. This small scope addition keeps the graph usable during sidebar navigation; graph data and generation remain untouched.
- Independent review caught a classic-scrollbar clipping risk in the very-short narrow rail. Restore the 56px rail width only at the scrolling breakpoint to reserve the app's 8px scrollbar space while preserving 40px buttons and the derived drawer offset.
- Verification: 53 focused navigation/fit/rail/Commons/Canvas continuity and focus tests plus 36 onboarding tests passed; lint, TypeScript and production build/budget passed. Synthetic browser checks measured 426px desktop and 390px narrow rail height, all eight actions visible at 379px window height, and keyboard access at 300px height. Drawer dismissal and covering-drawer Fit both retain seven visible graph nodes. Exact exported seven-node/six-edge graph stayed unchanged, with zero generation, provider-check or handoff requests. Private screenshots/fixtures remain outside Git; this slice stays on codex/compact-sidebar pending merge.

### 2026-10-09 — Current Krea MCP asset upload route

- The authenticated current MCP upload contract returns an HTTPS `api.krea.ai/assets/presigned` URL with a signed query, while the adapter allowed only the older `/public-api/assets/presigned/` path-token route. Permit the exact new path alongside the legacy prefix, retaining the same host, HTTPS, port 443 and no-userinfo restrictions. Compare the raw parsed path so encoded aliases and suffix routes cannot broaden the upload destination. Keep redirects disabled; a redirect response fails before any generation submission. Signed queries and account identifiers stay out of logs and repository evidence.
- Focused adapter verification passed all 39 tests, including multipart artwork upload and materialized output through both allowed routes, rejection before file transfer for ten invalid destinations, and 302/307/308 responses without forwarding the local file or submitting a generation job. `git diff --check` passed. This repair changes only local upload-contract handling; no server restart or paid generation was performed for these tests.
- The live upload probe then confirmed HTTP 200 with no Content-Type and a single plain-text asset URL, matching the current MCP tool description and the official upload instructions (https://www.krea.ai/docs/developers/mcp). The old adapter assumed a JSON object unconditionally. Decode the documented raw-URL body explicitly for text/plain or absent Content-Type, retaining legacy JSON objects including absent-header objects. An advertised JSON response must parse as JSON; malformed JSON never falls back to text. Empty, HTML, mixed/multiple URLs and other unusable bodies fail before generation with a generic error that cannot disclose provider response text or signed URLs.
- Updated focused verification passes 58 adapter tests: both allowed routes now exercise JSON and raw URL success through file upload and output materialization; thirteen unusable response contracts fail without any generation call or private-body disclosure. Destination and redirect protections still pass. `git diff --check` passes; no restart or generation was performed by this repair.
- A bounded response-security review found that the shared media URL validator permits userinfo, and the pre-existing upload destination guard only rejected nonempty usernames/passwords. Keep the shared validator unchanged, but explicitly reject any userinfo in upload result URLs and destination URLs, including empty userinfo. Credential-bearing raw/JSON responses fail before generation with the same generic error.
- Final focused verification passes 68 adapter tests, including eight raw/JSON userinfo response failures and two empty-userinfo destination failures. Existing invalid URL/body, host/scheme/port/path and no-redirect assertions still pass. `git diff --check` passes; shared media validation, server state and generation remain unchanged by this review.

- Broader Krea verification passed308existingtests across gateway, MCPgeneration, OAuthconnector, agentMCP, MCPserver, desktopAPI, directhandler and catalog. Live artwork upload through the new route/plain URL response succeeded; the following explicit video submission was rejected by Krea for exhausted selected-workspace compute before a job was accepted. No alternate workspace or API-token billing was used. Private video state and provider diagnostics remain outside Git.
