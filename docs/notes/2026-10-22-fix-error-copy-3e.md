# 2026-10-22 — Every card says why, pre-run checks in words, no raw error text

Branch `fix/error-copy-3e`, from main `6b362b85`. Backend and frontend. No package installed, no paid provider call (the live check ran with no keys and a network guard).

## What changed and why

GM - Design's rules for this round, from the round 3c notes: "Never show raw error.message strings in UI"; "Couldn't {verb} {object}." then the reason, never "Could not"; no "failed:", no status codes, no parentheses; no ids, record names, parameter keys or env-var names in what the person reads (a field by its label, an input in words); "people get the written line; agents keep the specific detail"; a Retry that does something else is a defect.

1. **Every card shows its run error.** Round 3c-2 found nine cards that turned red with no line: Video Edit, Remotion, Cinema Scene, Character, Camera Rig, Reference Set, Moodboard, Paper source and the reroute dot. Each now renders the shared NodeError through a new `NodeRunError` (`components/nodes/NodeError.tsx`): "Couldn't run the node." over the person's line, the classifier's line or GM's general line, the raw text behind a closed Details. It clears when the node runs again (the store clears `error` on `executing`) and reads the same after a reload (graph sync carries the same fields). The reroute dot is 14 px wide, so its error hangs under the dot (`.reroute-node__run-error`, 200 px, centred). Video QC already worked: it wraps ModelNode, so 3c-2's list was wrong about it.
2. **Pre-run checks read like run errors.** `ValidationErrorDetail` gains an additive `person` (`backend/models/events.py`). Every check in `execution/engine.validate_graph` sets it beside its unchanged `message`: a missing key reads `missing_key_line` ("Add your OpenAI API key in Settings, then run the node again."), an unwired input names it in words (`port_line`: "Connect a prompt, then run the node again.", or "Connect the node's {Label} input, ..."), a route that can't run names providers by label (`node_route.route_unavailable_line`), a Batch over its cap uses its run line. `main._validation_response` (the canvas's `/api/execute`, `/api/execute-node`, a shot run) and the `validationError` socket event carry it; `node_errors.record_validation` keeps it for a reload. The agents' answers (`/api/graph/run`, MCP `run_nodes`, `nebula run`, `look_at_canvas`) are unchanged word for word and never carry `person`. In the store, `lib/validationCopy.ts` joins several checks on one node the way `node_errors` does (texts with "; ", lines with a space), a check with no line reads GM's general line with Details, and every "Validation failed before execution. Check required inputs and API keys." fallback is gone: a node with nothing wrong of its own reads "Nothing ran. Another node in this run needs a fix first." The Batch card hides its own cap warning while the run error for the cap stands, so the cap is said once.
3. **The last "Could not", "failed:" and raw messages** (list below). The Paper source card was the worst: it showed the route's text as is ("Paper CLI unavailable; open Paper Desktop or configure NEBULA_PAPER_CLI"). Its routes now send `detail.person` beside `detail.message` (new `backend/services/paper_copy.py`), a failed refresh keeps `lastErrorPerson` beside `lastError` on the source record, and `lib/paperSource.ts` throws a `PaperSourceError` (now a `RequestFailedError`) named by the card's action. Krea (`lib/kreaConnection.ts`) throws `FailureNotice`s whose reason comes from the kind of failure, never the error's text (it can hold credential-bearing URLs). Paper Desktop links, the graph file's own checks, the node-create store lines, the Toolbar's CLI import and the World splat format check all read written lines; their specific text goes to the console.
4. **Projects never show a plain Error's message.** `showError` reads `failureMessage(error, RETRY_HEADINGS[action])`, so a plain Error under rename reads "Couldn't rename the project. That didn't work. Try again, or reload if it keeps happening." with 3b's Try again kept exactly (it redoes the rename; an open that may have landed still reads the list and reopens).
5. **Guards.** `frontend/tests/errorCopy.rawMessageGuard.test.ts` scans `src/` for the shapes that render an Error's own message (`x instanceof Error ? x.message` and `if (x instanceof Error) … x.message` on one line, `(x as Error).message` / `?.message`, `(x: Error) => x.message`, `String(e|err|error|exc|failure|reason)`, `${e}` / `${err.message}` in a template, `{error.message}` in JSX), console lines aside. `frontend/tests/errorCopy.round3e.sweep.test.ts` scans for "Could not", "{word} failed: " and "Failed to" in code. Each has an `ALLOWED` list with reasons (two classifiers, an agent-log entry's message, a written graph-file size line, a swallowed health probe, a console-only sync, a swallowed thumbnail) that must stay exact. `backend/tests/test_error_copy_round3e.py` fails when a `ValidationErrorDetail` in `validate_graph` has no `person=`, and the cards test fails when a new canvas card type doesn't show its error. AGENTS.md has the rules next to 3c-2's.

## Decisions

- `failureUnder(error, heading)` (new in `lib/errorCopy.ts`): the action's heading wins over the request's. Import CLI graph reads the canvas through a call headed "Couldn't load the canvas."; the alert now says "Couldn't import the CLI graph." over the reason.
- Browser-written lines a surface heads itself are `FailureNotice('', reason)`: the ZIP size lines (round 2's exact words, now under "Couldn't download the outputs." in the toolbar's tooltip), the graph file's limit errors (`GraphStructureLimitError`, `GraphBundleImportTooLargeError`), and the store's node-create lines under "Couldn't add {node}.". Their `message` didn't change, so the round 2 pins hold.
- The graph file's shape checks ("Invalid .nebula file: nodes[3].data.outputs.image must be a typed port object", 22 sites) became `GraphFileInvalidError(detail)`: the alert reads "Couldn't load the graph. This file is damaged or isn't a Nebula graph." (or "This file is from a newer Nebula. Update Nebula, then open it again." for a version above 3), the check's text goes to the console.
- Paper's person lines are matched on the transport's texts in one table (`paper_copy._PAPER_LINES`), not set at each of the 25 raise sites; an unlisted text reads "Nebula couldn't confirm the object in Paper. Refresh the source again." The 404 detail became `{message, person}` (it was a bare string; only the card reads it).
- The run-history notes are re-set on every load for a running record, so changing their constants needs no migration of saved records.
- The World splat format check keeps its text for the console and its tests; the card reads "This world's preview file is damaged or in a format Nebula can't open. Use the panorama or the downloaded splat in a 3D viewer."
- The import-busy refusal in Create Studio stays "Wait for the graph import to finish." under "Couldn't generate." (I had added "then try again"; a pin caught it, and the panel has its own Try again).

- `writtenLine(line)` (new in `lib/errorCopy.ts`, a `FailureNotice` marked standalone): the browser's own steps that read on their own ("The project didn't open. Try again.", "This proposal is no longer waiting for you.", "Turn on the Commons in Settings to review this proposal.", the Commons unsaved refusal, the Updates corner's "\"{action}\" can't run here yet.") were plain Errors. Once their catches went through `failureMessage` they read GM's general line; the full suite caught it (the Updates corner tests). They throw `writtenLine` now, which `failureCopy` shows word for word with no heading over it.
- `uploadReference`'s checks ("Image exceeds the 20 MB limit.", "Use a PNG, JPEG, GIF or WebP image.", and the empty answer) were plain Errors, so once plain Errors read GM's general line the chip would have lost them; they're `FailureNotice`s under "Couldn't upload {file}." now. Both chips that show them (Create's reference tray, the Cinema Scene uploads) sit beside Retry or Attach again, so the empty-answer reason drops its "Please try again" (the WRAP rule); the second full run caught the old pin in `tests/lib/createUploads.test.ts`.

## Tradeoffs

- The Batch card detects "the run stopped on the cap" from the agents' pinned text (`exceeding its batch_size_cap of N`). If the person edits the items afterwards, the numbers in the error can be stale until the next run; the live warning comes back as soon as the error clears.
- A check with no person line (duplicate ids, missing nodes, unknown definitions: only an agent or a damaged saved graph reaches them) reads GM's general line with the text behind Details, rather than a line per check.
- A Projects create that fails without an answer still reads 3b's "Couldn't confirm the project change. Try again checks your saved projects; it won't make the change twice." That's by design (the create may have landed), so the live check used a rename whose answer can't be read to reach the plain-Error path.
- The Paper source card's network-failure branch now writes the written reason into `lastError` too (before, the raw message). Agents reading a record the browser wrote get the written line; records the backend writes keep the specific text.

## Surprises

- Video QC already showed its errors (it wraps ModelNode). 3c-2's list was wrong about it.
- The node-create store lines ("Nebula lost contact with the known backend before node creation. ...", "Backend returned an invalid graph export response.") were a second set of developer-worded alerts, found by the guard.
- `chatAuthority` threw the Commons session line as a plain Error; it's a `FailureNotice('', line)` now so the chat panel shows the line on its own.
- Besides load timeouts, the full frontend suite found tests that mocked an API refusal as `new Error('reason')` and expected the reason on screen. Production throws typed errors (`apiRequest`, `CommonsRequestError`, `ProjectRequestError`) for every one, so those mocks now throw `RequestFailedError` and expect "{heading} {reason}" (PinComposer, canvasPinsStore, agentNotesStore, commonsCloseBatch, commonsDrafts, commonsLeavePanels, ConnectedApps, AssetsPanel, Settings, CreateView.save, ResultCard, projectStore.autosave, projectStore.agentSave); the others were the writtenLine bug above.
- A test-only bug before going green: the backend FORBIDDEN regex flagged every apostrophe ("node's"); it now flags only quoted tokens.

## Tests (red first on 6b362b85)

Each new test failed before its change; logs in the session scratchpad (`error-copy-3e/red/`).

- `backend/tests/test_error_copy_round3e.py`: 29 failed on the base for the validation half; the Paper half was added later and failed 9 (routes) + 1 (record) before `paper_copy.py`. Now 39 passed.
- `frontend/tests/errorCopy.round3e.cards.test.tsx`: 27 failed / 13 passed on the base (Video QC's three passed, and the batch and model cards), now 40 passed.
- `frontend/tests/errorCopy.round3e.validation.test.tsx`: 6 failed / 4 passed, now 10 passed.
- `frontend/tests/projectStore.retry.test.ts` round 3e block: 8 failed / 2 passed, now passing. Three pins in `projectStore.test.ts` moved to the new lines.
- `frontend/tests/errorCopy.rawMessageGuard.test.ts`: 1 failed (67 matches) / 2 passed, now 3 passed.
- `frontend/tests/errorCopy.round3e.paper.test.tsx`: 3 card cases failed / 4 passed while `paperSource.ts` was already changed; against the base `paperSource.ts` all 7 failed (I wrote the lib cases after the lib change, so I checked them against the base file swapped in).
- `frontend/tests/lib/paperDesktop.test.ts`: 2 failed / 2 passed against the base file, now 4 passed.
- `frontend/tests/lib/kreaConnection.test.ts`: 2 failed / 7 passed, now 9 passed.
- `frontend/tests/graphFile.test.ts`: the two moved pins failed (2 / 43), now 45 passed.
- `frontend/tests/store/graphStore.errorCopy.test.ts`: the new unreadable-export case failed (1 / 7), now 8 passed; one pin in `graphStore.test.ts` moved.
- `frontend/tests/components/Toolbar.test.tsx`: the three CLI import cases failed (3 / 25), now 28 passed.
- `frontend/tests/errorCopy.round3e.sweep.test.ts` plus the moved pins in `providerReadinessStore.test.ts` and `ProviderRecoveryStatus.test.tsx`: 6 failed / 8 passed, now all pass.

## Live check

Isolated stack: backend on 8789 through `iso.sh` with a launcher that refuses every non-loopback request, writes no keys, and stubs the run handlers of the ten silent cards to fail with provider-style text; Vite on 5789 with `VITE_NEBULA_BACKEND_PORT=8789`. Puppeteer through Chromium's dead proxy `127.0.0.1:9` and CDP `Network.setBlockedURLs` on 8000-8010 and 5173 (all three loopback hosts). Desktop viewports 1440x900 and 1280x800. Result: **114 PASS, 0 FAIL**; blocked requests to 8000-8010/5173: 1 (the script's own canary to 8001); the network guard refused 0 outside requests; the stubs failed 10 times; no dialogs.

- All ten cards (Video Edit, Video QC, Remotion, Cinema Scene, Character, Camera Rig, Reference Set, Moodboard, Paper source, reroute) read "Couldn't run the node." over GM's general line with the raw text behind closed Details, at both widths, inside their cards (the reroute's under its dot), and the same after a reload.
- Pre-run checks, before and after a reload: the keyless GPT Image 1 reads "Add your OpenAI API key in Settings, then run the node again." with no env-var name and no Details; the unwired one reads "Connect a prompt, then run the node again. Add your OpenAI API key in Settings, then run the node again."; the Batch over its cap reads its line once, no `batch_size_cap`, no second warning.
- The Paper source card with no Paper reads "Couldn't read the Paper selection. Paper isn't answering. Open Paper Desktop, then try again.", no `NEBULA_PAPER_CLI`.
- Projects: a rename whose answer can't be read reads "Couldn't rename the project. That didn't work. Try again, or reload if it keeps happening." with Try again; Try again renamed it, and the banner cleared.
- Over a real MCP stdio session: `look_at_canvas` reads "Missing API key: OPENAI_API_KEY", "Required input port 'prompt' is not connected" and the Batch cap text word for word, and none of the person lines; `run_nodes` on the Batch and on the keyless node return `errors` with the same texts and no `person`.
- No status code or "Could not" on the last screen; no page errors.

Servers stopped by port, state deleted.

The live check ran before the last fixes (`writtenLine` for the browser's own lines, the upload chip's lines). Those surfaces weren't in the live run; their unit tests and the second full run cover them.

## Gates

All on a heavily loaded machine (other sessions' suites running at the same time).

- Backend, `iso.sh .venv/bin/python -m pytest -q -p no:cacheprovider` from `backend/`: **1 failed, 9907 passed, 71 skipped** in 25:26. The one failure is `tests/test_iterator_execution.py::test_cancelled_batch_cancels_active_handler_and_keeps_completed_items`, an `asyncio` wait that timed out under load; that file alone: **16 passed** in 0.74s.
- Frontend `npx vitest run`, first full run: 33 files / 73 tests failed of 4845 (35 timeouts). The real ones were written lines thrown as plain Errors (now `writtenLine` / `FailureNotice`) and test mocks that refused with plain Errors (now `RequestFailedError`).
- Frontend `npx vitest run`, second full run after those fixes: **15 files failed, 361 passed (376); 45 tests failed, 4802 passed (4847)**. One was real: `tests/lib/createUploads.test.ts` pinned the old empty-upload line; it pins the new one now (10 passed alone). The other 44 were timeouts or queries that ran before a lazy panel mounted. Those 15 files rerun together: 12 passed, 3 failed (232 tests: 229 passed, 3 timed out). Each of the three alone: `Settings.test.tsx` 71 passed, `ModelPicker.test.tsx` 11 passed, `ResultsGallery.test.tsx` 8 passed.
- `npx tsc -b`: clean (also rerun after the last edit).
- `npm run -s lint`: passed (the last edit's two files linted again on their own).
- `npx vite build && node scripts/check-build-budget.mjs`: build passed; entry **362,249 bytes raw** (108,688 gzip), under the 512,000 budget. `frontend/dist` deleted afterwards.

Gates again after the review fixes (machine still heavily loaded; the backend and frontend suites ran at the same time):

- Backend, whole suite through `iso.sh`: **1 failed, 9909 passed, 71 skipped** in 18:57. The one failure is `tests/test_agent_process.py::test_terminate_agent_process_tree_kills_setsid_grandchild` ("setsid grandchild survived cancellation", a process-kill timing check this change doesn't touch); that file alone: **4 passed**.
- Frontend `npx vitest run`: **41 files failed, 335 passed (376); 124 tests failed, 4728 passed (4852)**, 107 of them "Test timed out in 5000ms". The 41 files rerun together: 10 failed, 31 passed (583 tests: 25 failed, 558 passed, 16 timeouts). Each of those 10 alone passes: MoodboardStudioFieldUndo 22, CommandPalette 3, DeferredSecondPass 11, ModelDiscovery.integration 4, ModelPicker 11, ResultsGallery 8, ConnectionPopup 16, GraphFileActions 25, NodeLibrary 20, Settings 71.
- `npx tsc -b`: clean. `npm run -s lint`: passed.
- `npx vite build && node scripts/check-build-budget.mjs`: passed, entry **362,249 bytes raw** (108,673 gzip), under 512,000. `frontend/dist` deleted.

## Agent support

The `person` field is additive and rides only on the canvas's own answers and the socket event; agents see no change in any text they read (`/api/graph/run`, MCP `run_nodes`, `nebula run`, `look_at_canvas`, `nebula look`, the run record). The Paper routes are the person's; their `detail.message` and the record's `lastError` are unchanged. `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md` say so. No new MCP tool or CLI command: nothing new an agent can do.

## Open items

- Round 3d (parallel) also takes "pre-run validation lines that name keys" (round 3c notes). This branch leaves every `message` as it was and adds `person`; if 3d rewrites the messages, the merge needs `person=` kept on each `ValidationErrorDetail` (the 3e guard test fails otherwise).
- The proposal bar and proposal layer show the backend's `find_nodes` / `node_readiness.instance_missing` text as it is ("GPT Image 2 (+img) needs OPENAI_API_KEY in Settings > Providers"): an env-var name and a ref on a person surface. It needs a person field on the proposal's missing list, a backend change of its own; found in the review round, not converted here.
- The Agent Log's other lines still name node and definition ids ("Added gpt-image-2-generate (n3)", "Running n3...", "2 errored: n3, n5"). None carries raw error text; whether the log names cards by label is GM's call.
- Some backend route lines (`node_route._why_person`, now the switcher's too) read rough: a switch's value as "Draft true", option values instead of their labels ("Pick 768sq, 1k, 2k or 4k"), a route's own detail with parentheses ("(fal.ai takes it on krea/v3/edit only)"). Listed for GM below.
- The switcher's row notes and its Auto row (`providerSwitch.ts` `rowBlock` / `autoReason`) still name a blocked setting by its key ("Doesn't take safety_tolerance", "Needs resolution") where the route's block has no detail. Listed for GM.
- The World Labs nondurable warning comes from the backend (`checkpoint.warning`) when it sends one; only the fallback note changed here.
- Paper linking has no agent path (no MCP tool, no CLI command). It predates this round; per the standing rule it should get at least a read path.
- `requestUniversalModel`'s "HTTP n" goes to the console only; left as is.

## Review

A refuter-checked review found four defects; each got a test that failed first, then the fix (logs in the session scratchpad, `error-copy-3e/red-review/`).

- **The raw-message guard missed the direct shapes.** `{error.message}` in JSX, `if (err instanceof Error) setError(err.message)`, `String(e)`, `${e}` in a template and `(err as Error)?.message` all got past it. The guard's own sample now carries those (6 missed on the old patterns), the patterns cover them, and the two real hits they find are allowed with reasons: AgentLog's `{e.message}` (an agent-log entry, not an Error; its text is fixed at the source, below) and graphFile's `${err.message}` on `GraphBundleImportTooLargeError` (a FailureNotice with a written size line). ChatPanel and lazyWithPreload still count 1 each.
- **The provider switcher still named env vars.** `routeUnavailableMessage` (the switcher's stop line, its title and aria-label, the run-cost summary) said "FLUX.2 is set to Black Forest Labs, which needs BFL_API_KEY. Add it in Settings > Providers or choose another provider.", while the same card's run error read the backend's new line. It is now `node_route.route_unavailable_line` word for word: `KEY_NAMES` / `keyPhrase` / `missingKeyLine` twin `person_line`, `whyPerson` twins `_why_person` (a setting by its label), the unknown-provider line drops the route-id list, and the keyless "can take it" drops its parentheses. To keep them from drifting, `route_cases.json` gains `unavailableLine` on all 165 route-table cases (the backend's own output; `test_node_route.py` pins it to `route_unavailable_line`, `directRoute.test.ts` to `routeUnavailable().message`), and `scripts/generate-route-tables.py` writes `keyNames` into `route_tables.json` (`routeTables.test.ts` pins `KEY_NAMES`). Red first: 35 of 334 in `directRoute.test.ts`, the new switcher test in `providerSwitch.test.ts` (1 of 47), the key-name pin (1 of 4). The fix suggested mapping keys through `providerLabel`; that would have said "Google API key" where the backend says "Gemini API key", so the frontend copies `KEY_NAMES` instead, pinned.
- **A Paper source's run error vanished at the next sync.** The graphSync merge set a linked Paper source to 'complete' or 'idle' over the backend's 'error'. It now lets 'error' stand (the state worked out above it, which also keeps a node started again since). Red first: 2 of 3 new cases in `errorCopy.round3e.cards.test.tsx` ("expected 'complete' / 'idle' to be 'error'"); a sync without an error still reads 'complete'. `applyPaperSource` (a refresh the person made) keeps setting 'complete'/'idle'; that is a new source, not a sync.
- **The Agent Log named the key and the node id for a refused run.** `_refused_cli_run` published "Run stopped before it started. n2 (GPT Image 2): Missing API key: OPENAI_API_KEY". It now reads "Run stopped before it started. GPT Image 2 can't run. Add your OpenAI API key in Settings, then run the node again.", and a graph-wide refusal alone (a cycle) reads "Run stopped before it started. Couldn't run the canvas." instead of "Graph contains a cycle: …". The cursor reuses the same line; the agent's `error` and `errors` are unchanged. Red first: both new tests in `test_cli_run_errors.py` (2 of 8).
- AGENTS.md: the switcher's line is `route_unavailable_line` word for word (change both, the fixture pins them), and the Agent Log's refused-run line is the card's line.
- Live check, review round (same isolation: backend 8789 through `iso.sh` with the network guard and no keys, this time with no handler stubs; Vite 5789 with `VITE_NEBULA_BACKEND_PORT=8789`; dead proxy plus CDP blocks on 8000-8010 and 5173; 1440x900 and 1280x800): **56 PASS, 0 FAIL**, blocked requests to 8000-8010/5173: 1 (the script's own canary to 8001), outside requests refused: 0, no dialogs, no page errors. Three FLUX.2 cards with no keys (set to Black Forest Labs, set to fal.ai, Auto): each chip's title and aria-label and the open menu's stop line read the person line ("FLUX.2 is set to Black Forest Labs, which needs your Black Forest Labs API key. Add it in Settings, or choose another provider."; Auto: "Add your Black Forest Labs or fal.ai API key in Settings, then run the node again."), no env-var name; after Run each card's error reads the same words as its chip, and again after a reload. A linked Paper source whose pinned snapshot isn't on disk, run by an agent (`POST /api/graph/run`): its card reads "Couldn't run the node." after the run's closing sync, after a later agent edit, after a reload, and after an edit following the reload. The same script with the one-line graphStore fix taken out failed 6 of those 8 card reads (the error showed only right after the reload, then the next sync wiped it), so the check exercises the path the review named. An unknown provider can't be set through the API (it answers 400); it only comes from an older saved graph, so the unit test covers it. The Agent Log line needs an in-app chat turn, which the live check can't start without a model; the backend test covers it. Servers stopped by port, state deleted.

## Round 3e lines for GM

### Node cards (all ten silent types)
- (nothing) -> "Couldn't run the node." over the person's line, the classifier's line, or "That didn't work. Try again, or reload if it keeps happening." with Details.

### Pre-run checks (card line; the agents' text unchanged)
- "Missing API key: OPENAI_API_KEY" -> "Add your OpenAI API key in Settings, then run the node again." (no key named: "Add this node's API key in Settings, then run the node again.")
- "Required input port 'prompt' is not connected" -> "Connect a prompt, then run the node again." (image/video/audio: "Connect an image", "Connect a video", "Connect audio"; others: "Connect the node's {Label} input, then run the node again.")
- "Batch has 3 items, exceeding its batch_size_cap of 2. ..." -> "This Batch has 3 items, more than its Item cap of 2. Remove items or raise the cap, then run it again. Nothing was generated." (said once on the card)
- "Iterator batch_size_cap must be an integer from 1 to 25" -> "Set the node's Batch Size Cap to a whole number from 1 to 25."
- "Joining independent iterator batches is unsupported. ..." -> "This node takes items from two separate Batch or iterator nodes. Nebula won't combine them, because that would multiply the paid runs. Feed it from one of them, then run it again."
- "World Labs recovery-aware operations cannot run inside an iterator. ..." -> "A World Labs node can't run once for each item of a Batch or iterator. Give each World Labs run its own node, then run them one at a time."
- "Connect your Krea account in Settings before running this recipe" -> "Connect your Krea account in Settings, then run the node again."
- Route can't run, unknown provider -> "{Node} is set to a provider it doesn't have. Choose one in the node's provider switcher."
- The same route lines now also read in the provider switcher (stop line, chip title and aria-label) and the run-cost summary, which said: "{Node} is set to provider 'xyz', which it doesn't have. Choose auto, bfl, fal ..." / "{Node} is set to {Provider}, which needs {ENV_KEY}. Add it in Settings > Providers or choose another provider." / "{Node} needs {ENV_KEY} or {ENV_KEY} in Settings > Providers." / "{Node} can't run on {Provider}: it doesn't take {param_key}. ..." / "... can take it (add its key in Settings > Providers)." (review round)
- Rough spots in those route lines, unchanged, for GM: a switch's value reads "it doesn't take Draft true"; listed values are option values, not labels ("Pick 768sq, 1k, 2k or 4k"); a route's own detail can carry parentheses ("(fal.ai takes it on krea/v3/edit only)"). The switcher's row notes still name a setting by its key where the block has no detail ("Doesn't take safety_tolerance", "Needs resolution").
- Route can't run, chosen provider's key missing -> "{Node} is set to {Provider}, which needs your {Provider} API key. Add it in Settings, or choose another provider."
- A wire of the wrong kind -> "The wire into the node's {Label} input brings something it can't take. Remove that wire, then connect a matching output."
- Too many wires -> "The node's {Label} input takes one wire. Remove the extra one, then run the node again." / "... takes up to {n} wires. Remove the extra ones, then run the node again."
- A stale wire -> "A wire into this node no longer matches its inputs. Remove it, then connect it again." / "A wire from this node no longer matches its outputs. ..."
- Krea 2's Moodboard input from a Krea moodboard -> "Krea 2's Moodboard input takes a Nebula moodboard now. To use a Krea moodboard, put its ID in the node's Moodboard ID field and remove the wire."
- A node with nothing wrong of its own, in a refused run: "Validation failed before execution. Check required inputs and API keys." -> "Nothing ran. Another node in this run needs a fix first."
- No node named: "Validation failed before execution. Check the saved inputs and API keys." -> "Nothing ran. Check the inputs and API keys, then run again."
- Cinema shot: "Validation failed. Check inputs and API keys." -> "Nothing ran. Check the scene's inputs and API keys, then generate the shot again."

### Paper source card
- Route text as is ("Paper CLI unavailable; open Paper Desktop or configure NEBULA_PAPER_CLI", "Paper tool failed", "Paper is disconnected ...") -> "Couldn't {read the Paper selection | find that Paper object | link the artwork | reconnect the object | refresh the source | open the source}." then "Paper isn't answering. Open Paper Desktop, then try again."
- Object missing -> "... The linked object is missing in Paper. Reconnect it, or link another object."
- Page root chosen -> "Choose an object on the page, not the page itself, then link it again."
- Changed mid-export -> "The object changed while Paper was exporting it. Refresh the source again."
- Over 32 MiB -> "Paper couldn't export this object, or its export is over 32 MB. Try a smaller object."
- Export checks ("not a PNG", "Snapshot integrity check failed", ...) -> "Nebula couldn't check the artwork Paper exported. Refresh the source again."
- Anything else -> "Nebula couldn't confirm the object in Paper. Refresh the source again."
- Source gone -> "Nebula can't find this Paper source. Link the object again."
- "Paper source is unavailable." / "Could not resolve this exact Paper object." -> the lines above under their heading.
- "Could not open Paper Desktop. Use Open source link." -> "Couldn't open Paper Desktop. Use Open source link."
- "Could not open the source link. Copy its address and open it in your browser." -> "Couldn't open the source link. Copy its address and open it in your browser."
- Paper Desktop bridge: "Paper desktop links require the current Nebula desktop bridge." -> "Couldn't open the Paper artwork. Update the Nebula desktop app, then try again."; bridge text -> "Couldn't open the Paper artwork. Paper Desktop didn't open it. Use Open source link."

### Krea (Settings)
- "Could not update the Krea connection. Check that the Nebula backend is available." -> "Couldn't update the Krea connection." + "Couldn't reach Nebula. Check your connection and try again." / "Nebula didn't respond. Try again." / GM's general line.
- "Could not load Krea plans. Check the Krea connection and try again." -> "Couldn't load the Krea plans." + the same reasons.
- "Could not start the Krea trial. Check the Krea connection and try again." -> "Couldn't start the Krea trial." + the same reasons.
- "Krea returned an unexpected trial link." -> "Couldn't start the Krea trial. Krea sent back an unexpected trial link, so Nebula didn't open it."
- "Krea plans are unavailable." -> "Couldn't load the Krea plans." + reason.

### Create Studio
- "Could not start generation. Please try again." -> "Couldn't generate." + reason
- "Could not create generation nodes. Please try again." -> "Couldn't generate. Its nodes weren't added to the canvas. Try again."
- "Wait for the graph import to finish." -> "Couldn't generate. Wait for the graph import to finish."
- "Could not save this style. Please try again." -> "Couldn't save the style." + reason
- "Could not save this output. Please try again." -> "Couldn't save the file." + reason
- "Enhance failed." -> "Couldn't enhance the prompt." + reason; "Enhance returned nothing." -> "Couldn't enhance the prompt. The model sent back an empty prompt. Try again."
- "The upload returned no image reference. Please try again." -> "Couldn't upload {file}. The upload sent back no image." (beside the chip's Retry / Attach again)
- "Image exceeds the 20 MB limit." and "Use a PNG, JPEG, GIF or WebP image." keep their words, now under "Couldn't upload {file}."

### Commons
- "Could not load reference" -> "Couldn't load this reference." + reason
- "Could not decode this reference. Reload to try again." -> "Couldn't show this reference. Reload to try again."
- Raw messages -> "Couldn't load the Commons settings." / "Couldn't save the settings." / "Couldn't export the Commons." / "Couldn't load the review." / "Couldn't propose labels." / "Couldn't update the library." / "Couldn't load the collections." / "Couldn't load the library status." / "Couldn't search the library." / "Couldn't load the reference." / "Couldn't save the change." / "Couldn't delete the reference." / "Couldn't close the review.", each + reason.

### Canvas, panels and settings (raw messages -> heading + reason)
- Inspector: "Could not load models" (placeholder) -> "Couldn't load the models."; the Nous error -> "Couldn't load the Nous models." / "Couldn't load the OpenRouter models." + reason.
- MaskPainterModal: "Could not load the upstream image for painting." -> "Couldn't load the upstream image for painting."
- 3D preview: raw / "Interactive preview unavailable." -> "Couldn't load the 3D preview." + reason; downloads: "Couldn't download the 3D model." / "Couldn't download the world." / "Couldn't download the output." / "Couldn't download the outputs." + reason.
- Restore button: "Restore failed." -> "Couldn't restore the board." / "Couldn't restore the character." + reason.
- Assets panel: "Move failed." -> "Couldn't move the board." / "Couldn't move the character." + reason.
- Chat panel: raw -> "Couldn't load the models." / "Couldn't check Claude status." / "Couldn't check Codex status." / "Couldn't start the ChatGPT sign-in." / "Couldn't check the ChatGPT sign-in." + reason.
- Personal agents, connected apps, spend: raw -> "Couldn't save your answer." / "Couldn't load your agents." / "Couldn't update your agents." / "Couldn't update the connected apps." / "Couldn't load the connected apps." + reason.
- Render jobs: raw -> "Couldn't check the render." / "Couldn't start the render." / "Couldn't cancel the render." + reason.
- Pins, proposals, notes, Recently deleted: raw -> "Couldn't add the pin." / "Couldn't remove the pin." / "Couldn't accept the proposal." / "Couldn't reject the proposal." / "Couldn't {verb} the proposal." / "Couldn't mark the notes read." / "Couldn't dismiss the note." / "Couldn't update the note." / "Couldn't load Recently deleted." + reason.
- Run start refused (cards): unchanged words, now through failureMessage ("Couldn't start the run." / "Couldn't run the node." / "Couldn't start the shot." + reason).
- Provider readiness: "{Provider} could not be checked. The saved connection is unchanged; retry Check connections." -> "Couldn't check {Provider}. The saved connection is unchanged. Use Check connections to try again."; "{Provider} is configured, but connections could not be checked. Retry Check connections." -> "{Provider} is configured, but Nebula couldn't check the connections. Use Check connections to try again."; "Connections could not be checked. Check that the Nebula backend is available, then retry." -> "Couldn't check the connections. Make sure Nebula's backend is running, then try again."
- Result context: "The saved prompt input could not be recovered. ..." -> "Nebula couldn't recover the saved prompt input. Open the saved run in Run History."; "A saved image input could not be recovered. ..." -> "Nebula couldn't recover a saved image input. Open the saved run in Run History."
- World Labs: "Recovery ID captured, but the backend could not save it durably. Keep this tab open and copy the ID before reloading." -> "World Labs sent back the job's ID, but Nebula couldn't save it. Keep this tab open and copy the ID before you reload."; "Reconnecting to this World Labs run. Run remains locked until Nebula confirms its backend status." -> "Reconnecting to this World Labs run. Run stays off until Nebula hears back about it."; "Reconnecting to this run. It remains active until Nebula confirms its backend status." -> "Reconnecting to this run. It stays active until Nebula hears back about it."; "The hold could not be saved durably; do not restart the backend." -> "Nebula couldn't save the hold, so don't restart the backend."
- World viewer: "The spatial preview is not a valid supported SPZ file ({check})." -> "This world's preview file is damaged or in a format Nebula can't open. Use the panorama or the downloaded splat in a 3D viewer."
- Graph file: "graph.json is {n} MB; the portable limit is {m} MB." -> "The graph is {n} MB, over the portable limit of {m} MB."
- Projects: a plain Error -> "{the action's heading} That didn't work. Try again, or reload if it keeps happening." (headings: "Couldn't load your projects.", "Couldn't save the project.", "Couldn't open the project.", "Couldn't create the project.", "Couldn't rename the project.", "Couldn't delete the project.", "Couldn't restore the project.", "Couldn't delete the project for good.", "Couldn't empty Recently deleted.", "Couldn't set the cover.").

### Agent Log (review round)
- A refused run: "Run stopped before it started. n3 (GPT Image 2): Missing API key: OPENAI_API_KEY" -> "Run stopped before it started. GPT Image 2 can't run. Add your OpenAI API key in Settings, then run the node again." (several nodes: each "{Node} can't run. {line}" in turn); a graph-wide refusal alone: "Run stopped before it started. Graph contains a cycle: ..." -> "Run stopped before it started. Couldn't run the canvas."
- Unchanged, for GM: the log's other lines name ids ("Added gpt-image-2-generate (n3)", "Running n3...", "Ran 3 node(s) in 2.1s — 1 errored: n3").

### Alerts and confirms (words only)
- Toolbar, Import CLI graph: "Could not fetch CLI graph — is the backend running?" -> "Couldn't import the CLI graph." + reason.
- Toolbar, Import CLI graph: "CLI graph is empty — build one with the nebula CLI first." -> "The CLI graph is empty. Build one with the nebula CLI first."
- Graph file, load: "Couldn't load the graph. Invalid .nebula file: {check}" -> "Couldn't load the graph. This file is damaged or isn't a Nebula graph."; "Couldn't load the graph. Unsupported .nebula file version: {v}" -> "Couldn't load the graph. This file is from a newer Nebula. Update Nebula, then open it again." (older or garbage: the damaged line); JSON that doesn't parse: the JS parser's text -> the damaged line; a picked file that can't be read: its text -> "Couldn't load the graph." + GM's general line. The size lines keep their words.
- Graph file, save: "Couldn't save the graph. {error text}" / "The graph could not be serialized safely." / "The portable bundle could not be created." -> "Couldn't save the graph." + the size line, or GM's general line.
- Node card download (ModelNode): unchanged words, "Couldn't download the output." + reason, through failureMessage.
- Adding a node: "Couldn't add {node}. Nebula lost contact with the known backend before node creation. No local copy was added; reconnect and try again." -> "Couldn't add {node}. Nebula lost contact with its backend, so the node wasn't added. Reconnect, then add it again."; "... Backend returned an invalid graph export response." -> "... Nebula couldn't read the backend's answer, so the node wasn't added. Reload, then add it again."; "... Nebula lost the response after sending the graph-clear request. No local node was added because the clear may have completed; reload before trying again." -> "... Nebula lost the answer to clearing the canvas, so the node wasn't added. The canvas may be clear already. Reload before you add it again."
- Unchanged and listed for GM: "Delete {n} selected node(s)?" (confirm); "Graph saved, but {n} referenced asset(s) were/was not included. Those outputs may be unavailable when the bundle is opened elsewhere."; the graph file's size alerts ("The selected graph is {n} MB. Nebula can safely open bundles up to {m} MB.", "The selected JSON graph is ...", "The finished bundle is ...").
