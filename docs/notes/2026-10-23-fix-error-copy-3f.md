# 2026-10-23 — Error copy round 3f: GM's rules for every card line

Branch `fix/error-copy-3f`, from main `74207c07` (the merge of #172, after 3d and 3e). Backend and frontend. No package installed, no paid provider call (the live check ran with fake key strings behind a network guard).

## What changed and why

GM - Design's message for this round: "RULES FOR EVERY CARD LINE (the "shown again, word for word" list breaks these all over; each one can be applied mechanically)", eleven rules, a list of specific lines from the 3c-2 notes, and after reading the 3d and 3e lists, a set of additions ("these are the changes they don't cover, so please fold them into 3f"). Where the two differ the additions win.

1. **GM's eleven rules on every card and shot-panel line.** Every line a person reads on a node card or the Cinema shot panel went through the rules, whichever round wrote it: 3c's World Labs lines, 3c-2's `with_person_line` / `as_person_line` lines, 3d's and 3e's lines, `missing_file_line`, `key_line`, `refuse()` tails, the pre-run (validation) person lines, the route lines and the unwired-input lines. 285 backend card lines changed (list below). Where the card used to show the exception text itself (`as_person_line`) and the rules changed the words, the site now uses `with_person_line`, so the exception's text stays exactly as it was. `scratchpad/textcheck/check2.py` compares every raised and returned exception text against `74207c07` by AST: 71 changed backend files, 0 differences. Agents read the same texts word for word.
2. **The guard.** `backend/tests/test_error_copy_round3f.py` walks every card line in the backend (person-line helpers, `with_person_line` / `with_provider_line` second arguments, `refuse()` tails, `port_line`, the route lines, the Gemini Omni guardrail) and fails on any of the rules a machine can check: no closing period, an em dash or semicolon, parentheses outside a quoted label, "wired"/"Wire", "is required", "nothing was sent" / "no job was submitted" without "Nothing was sent to {Provider}.", "run again" without "the node", "FAL", "BFL", "MiB", "1080P", a number followed by " s", "Unknown ... model", a param key, a port id or code name ("CameraPose input", "filePath param"). On `74207c07` it found 230 card lines that broke at least one rule.
3. **GM's specific lines** (22, 48, 51, 69, 71/72, 74, 93, 110/178/189, 112/114/179, 118/172, 152, 163, 164, 236): as GM wrote them; see "By GM's line numbers" below.
4. **Commons tooltips.** The daily-cap time is local time written like "12:00 AM" whatever the browser's locale (`lib/clockTime.ts`: `{h}:{mm} AM|PM`). The busy tooltip is GM's line: "Library analysis is paused while this computer is busy. Its load is {load}, above the {threshold} set in “Pause above load” in Settings. It resumes on its own when the load drops."
5. **Cinema, motion, recovery, Projects.** The shot panel heads a failed shot "Couldn't generate the shot." (the node card keeps "Couldn't run the node."). The motion handoff's no-answer line is "Couldn't confirm the video connection. Nebula didn't respond." The World Labs recovery warnings say "couldn't". Projects startup drops "That didn't work.": "Couldn't load your projects. Try again, or reload the page if it keeps happening.", and a full disk gets its own line, "Couldn't load your projects. Your disk is full. Free up some space, then try again." The full disk is read structurally: the backend's storage refusal (507) carries an additive `storage: "full"` when an `ENOSPC`/`EDQUOT` OSError is among its causes (`main._storage_full`, `_storage_error_body`), `RequestFailedError.storageFull` reads it from the body, `ProjectRequestError` carries it, and `projectStore.initialize` picks the line. Never from the words.
6. **Leftovers from 3d and 3e.** A proposal's not-ready row carries an additive `person` (the readiness line, "GPT Image 2 needs your OpenAI API key. Add it in Settings.") beside `missing`, and the ghost card shows it. The provider switcher's row notes and Auto reason name a setting by its label ("Doesn't take “Resolution” set to 1.5k.", "Needs “Reasoning level”."). The route lines' `_why_person` uses labels and option labels, never values or "Draft true". Validation entries saved before 3e (no category, no person) load as category `unknown`, so the card reads GM's general line with the text behind Details.
7. **GM's additions.**
   - The slow-job line, one helper (`person_line.slow_job_line`), everywhere 3d §2 and the fal.ai stream use it: "{Provider} took too long, so Nebula stopped waiting. The job may still finish there and be billed, so check {Provider} before you run the node again."
   - GM's general line, split by surface. On node cards and the Cinema shot panel (`lib/nodeErrorCopy.ts` `cardGeneralLine`): "Run the node again. If it keeps failing, Details shows what {Provider} said." when the failure names a provider, "Run the node again. If it keeps failing, open Details." when it doesn't. The provider is structural: the route that ran sets `CardLine.provider` (the backend's `called_provider`), the `ErrorEvent` carries an additive `provider`, `node_errors` keeps it for a reload, and the graph node's data and a shot's output carry `errorProvider`. Under any other heading (`errorCopy.ts` `REFUSED_FALLBACK_COPY`, the Commons person copy): "Try again, or reload if it keeps happening." 3b's WRAP rule holds as before: beside a Try again button only the two "try again" reasons shorten (`shortReason`: the server line to "Nebula's server isn't answering. Make sure it's running.", the no-response line to "Nebula didn't respond."); a refusal's reason, GM's general line included, stays whole, as it did.
   - "Couldn't reach Nebula. Check your connection…" is now "Nebula's server isn't answering. Make sure it's running, then try again." (short form without "then try again" where a Try again button sits beside it). The provider-readiness line is "Couldn't check the connections. Nebula's server isn't answering. Make sure it's running, then try again." when nothing answered; an answered failure reads its status line under the same heading.
   - xAI edit video, the OpenAI organization line (the URL stays in the exception text, behind Details), the Veo extension line, the route lines, Create Studio's three lines and "Couldn't save the output.", the two World Labs lines: GM's words. Agent Log ids stay.
   - **Alerts become canvas notices.** Every error `window.alert` in `src/` is gone (graph save/load/import, CLI import, output download, run-history forget, node create/delete failures, unsafe World Labs clone, pending Cinema upload, the Paper rerun note). They go through the canvas's own notice (`CanvasUndoNotice`, the graph store's `undoNotice`, now with a `tone`): an error is announced as `role="alert"`, a note ("Imported.", "Opened.", "Graph saved without…") as `role="status"`, each with a Dismiss button reachable by keyboard. Code outside the store raises one through `lib/canvasNotice.ts` (`showNotice`, a window event the store listens for, so `graphFile.ts` doesn't import the store). Screens other than the canvas (Create Studio, Cinema, Commons, Settings…) show the same notice through `StudioNotice`, deferred so it stays out of the first load. No motion was added.
   - The size and "saved without" alerts are notices in GM's words: "Graph saved without {n} of its files. They may be missing when the graph is opened somewhere else." / "Graph saved without 1 of its files. It may be missing when the graph is opened somewhere else." and "This graph is {n} MB. Nebula opens graphs up to {m} MB." (the JSON, the bundle, and the graph.json inside a bundle, under "Couldn't save the graph." / "Couldn't load the graph.").
   - **The delete confirm stays**, with GM's plural, "Delete {n} nodes?" / "Delete this node?", on every path that deletes nodes: the selection toolbar, the Delete/Backspace keys (`Canvas` `onBeforeDelete`), the context menu and the Inspector's Delete. There is no command palette delete. Why the confirm stays: Cmd+Z after a delete calls `restore` with the node's saved data and edges, but `DELETE /api/graph/node` also **detaches the node's canvas pins** (they become unattached pins) and **closes the open proposals that touch it**; undo puts the node, its params, outputs and edges back but leaves the pins detached and the proposals closed. A pin's attachment and a proposal's open state don't come back.
- **Review (four confirmed findings, fixed tests first).** (1) A card said "Details shows what World Labs said." for a failure World Labs never saw (a saved model the node doesn't list, refused before any request). GM's split is "when the failure names a provider", so `provider_status.card_line` now names the route's provider only when that provider answered (`provider_answered`: an API status, a job failure, its own words, or a status-table kind); anything else reads "Run the node again. If it keeps failing, open Details." (2) Rule 5 missed lines that named a field bare: Grok's "Set Duration to 10", Reasoning Effort, Thinking Level (which also looked up its options under the wrong key, so the card showed "minimal", not "Minimal"), xAI's Quality, Ruby's ProRes profile, BytePlus's Images per Generation, the image-count lines (now each node's own label, “Count” or “Images”), Ideogram's three field checks, Claude's Max Tokens/Effort, Style Reference's Description Mode, Jev's two thresholds, the Krea 2 moodboard hint and nine World Labs lines. (3) Rule 9: four Veo lines said "Vertex", now "Vertex AI". (4) MiniMax's 512P line now says 512p on the card; its exception text keeps 512P. The guard now catches all three shapes: a capitalized field label after a verb that sets it or after "the node's" (ports excluded), any `\d{3,4}P`, "Vertex" without "AI", plus an AST check that every `field_label(...)` written into a card line sits in quotes. Exception texts are unchanged (check2: 73 files, 0 differences).

## Decisions

- **Exception text never changes.** Every rewrite is a card line beside the exception (`with_person_line`, `with_provider_line`, a `refuse()` tail), and check2 proves it: 0 differences across 71 files (73 after the review fixes, still 0).
- **Rule 6's input in words** comes from one helper, `person_line.input_words(label)`: an article by the label's sound ("an SVG", "an array"), "URL"/"URLs" dropped ("Model URL" → "a 3D model" by a small table of known ports), mass nouns without an article ("Connect messages", "Connect text"), and a numbered port ("Item 1") gets "Connect an output to “Item 1”, then run the node again." because "an Item 1" isn't a thing.
- **Line 74's two-to-four-key case** (five FLUX nodes) reads GM's approved "Add one in Settings". A BLOCKED reason (a field only one fallback route takes) now names only that route's key ("These settings need your Krea API token. Add it in Settings, then run the node again."), not every fallback key.
- **The card's provider is the route that ran**, not the node's maker: a Nano Banana run on Gemini names Gemini; a Cinema base on FLUX Kontext names fal.ai. A failure with no route (an engine check, a local node) says "open Details". A card line written by a handler wins over the general line, as before. After review, the route's provider goes on the card only when that provider answered (`provider_status.provider_answered`: an API status, a job failure, the provider's own words, or a status-table kind). A failure Nebula raised before sending (a saved model the node doesn't list, a local file, a handler bug) and a download's own `HTTPStatusError` say "open Details", because GM's split is "when the failure names a provider".
- **The card's general line with no Details** (a failure whose raw text is empty) reads "Run the node again." alone: "open Details" with no Details to open would send the person to nothing.
- **The readiness split.** GM's "isn't answering" line is for a request with no answer; an answered failure (a 503) reads "Couldn't check the connections. Nebula didn't respond. Try again." (its status line), so the line never claims the server is down when it answered.
- **The motion no-answer line** uses GM's specific words ("Nebula didn't respond.") rather than the new server line; GM wrote that one for this surface.
- **Notices, not a new toast.** The canvas already had a dismissable notice for agent edits (`CanvasUndoNotice`); errors reuse it with a tone, and `StudioNotice` shows it messages-only elsewhere (an agent edit's Undo stays on the canvas).

## Tradeoffs

- The guard checks what a machine can check. "Drop a bad value the field already shows" and "either becomes a sentence or goes" are judgment; those are listed for GM.
- The full-disk line is only on Projects startup, as GM asked. Saves and other storage refusals keep their status line; the `storage: "full"` field is there if GM wants the same line elsewhere.
- Notices replace alerts one at a time: a second failure replaces the first notice rather than stacking.
- The delete confirm still blocks the canvas. GM's undo notice would need undo to re-attach pins and reopen proposals; that is backend work outside copy.

## Surprises

- The card's raw text for a provider failure often names a different company than the route (a Cinema shot's stub said "Gemini request failed" while the route was fal.ai). Reading the provider from the route, never the text, is what keeps the card honest.
- `graphFile.ts` importing the graph store changed the cached backend URL in its tests (they began fetching `http://localhost:8000`); the window-event notice (`lib/canvasNotice.ts`) avoids the import.
- The Commons cap test passed on `74207c07` under an en-US test locale, so it couldn't fail red; a second test mocks `toLocaleTimeString` to prove the line no longer depends on the locale.
- Exporting `clockTime` from `CommonsView.tsx` broke the react-refresh lint rule; it lives in `lib/clockTime.ts`.

## Tests (red first on 74207c07)

- Backend `tests/test_error_copy_round3f.py` (40 tests): 33 failed, 7 passed on `74207c07` (`red/be-3f-first.log`); the card-line guard listed 230 lines. 40 pass now.
- Frontend `tests/errorCopy.round3f.test.tsx` (25): 18 failed, 7 passed on base. `tests/errorCopy.round3f.projects.test.ts` (8): 7 failed, 1 passed. `tests/errorCopy.round3f.notices.test.tsx` (9): failed to import on base (no `StudioNotice`, `deleteConfirm`, `graphSizeLine`). All 42 pass now.
- Review fixes: 17 new or changed tests in `test_error_copy_round3f.py` failed on the uncommitted 3f change before the fix (17 failed, 38 passed; after three test-side mistakes were fixed: a wrong import, a MiniMax node with no prompt). The guard's own self-test passed red-first by design, then `test_every_card_line_follows_gms_rules` listed 12 lines and the World Labs table test 7 more. All 55 pass now. The engine test that pinned "Runway" for a plain error now pins "Runway" for a 400 the API answered and no provider for a plain error. Pins moved in `test_error_copy_round3c.py` (World Labs lines), `test_error_copy_round3d.py` (Ideogram "Images", Reasoning Effort), `test_cinema_scene_authoring_persistence.py` (a plain shot error no longer carries `errorProvider: "Gemini"`, the same class as finding 1) and the frontend fixture in `NodeError.round3c.test.tsx`.
- Pins moved to the new words (the three shared constants across 33 files, the card general line, Create Studio, the World Labs lines, ProviderSwitcher notes, providerReadiness, Commons, graphFile/Toolbar/GraphFileActions/graphStore alerts → notice spies through `tests/helpers/noticeSpy.ts`), plus additive-field pins in `test_cinema_scene_authoring_persistence.py` (`errorProvider`) and `test_canvas_proposals.py` (`person`).

## Live check

Isolated stack: backend on 8789 (`iso.sh`, temp HOME, every `NEBULA_*` root under the scratch dir, `launch_backend.py` with a network guard, canned in-process Black Forest Labs answers, nano-banana and flux-kontext stubs that fail with provider-style text, fake key strings, flag files for a full disk / a refusal / the Commons meter and load), Vite on 5789 with `VITE_NEBULA_BACKEND_PORT=8789`. Headless Chrome with `Network.setBlockedURLs` for 8000-8010 and 5173 plus a dead proxy; a canary request to 8799 was refused. **42 PASS, 0 FAIL. Blocked requests to 8000-8010/5173: 0. Outside requests the guard refused: 0.**

- Cards at 1440x900 and 1280x800, then again after a reload: rule 6 "Connect a prompt to this node, then run it again." (GPT Image 1), rule 2/3 "Gemini takes up to 5 stop sequences, and this node has 7.", rule 7 "Training Krea 1 styles needs the “Krea account” connection. Nothing was sent to Krea.", rule 11 "Couldn't download the result from Black Forest Labs. Its download link may have expired. Run the node again.", and a provider failure with no line: "Run the node again. If it keeps failing, Details shows what Gemini said." with Details closed and the raw text behind it.
- The Delete key asked "Delete this node?" (dismissed; the node stayed).
- Cinema shot panel at both sizes: "Couldn't generate the shot." over "Run the node again. If it keeps failing, Details shows what fal.ai said.", raw text behind Details.
- Commons: the busy tooltip in GM's words (load 99.5, threshold 72); the daily-cap label "Paused until 8:00 PM · daily cap" and tooltip "…It resumes on its own at 8:00 PM." (the meter's `resets_at` in local time).
- Projects startup with a stubbed full disk, at both sizes: "Couldn't load your projects. Your disk is full. Free up some space, then try again."; with a refusal with no reason: "Couldn't load your projects. Try again, or reload the page if it keeps happening."; Try again loaded the projects once the store answered.
- A real MCP stdio session (`look_at_canvas`) read the specific texts word for word ("Prompt input is required but was not provided", "Gemini takes up to 5 stop sequences; this node has 7.", Krea's "nothing was sent", "Black Forest Labs' result download failed (HTTP 403)", the request id) and none of the card lines. `GET /api/graph` showed the shot's `error` as the raw fal.ai text plus the additive `errorProvider: "fal.ai"`.
- No status code, "That didn't work" or "Check your connection" on screen; no page errors.

- **Coordinator, after the review: Krea Settings' first check** (the review's fifth finding, sent back unverified). The Krea row's first load caught every failure as "Couldn't check Krea. Check that the Nebula backend is running.": not GM's words, and it told the person the backend was down even when the backend had answered. It now reads `failureUnder(error, "Couldn't check Krea.")`, so a fetch with no answer reads "Couldn't check Krea. Nebula's server isn't answering. Make sure it's running, then try again." and an answered 503 "Couldn't check Krea. Nebula didn't respond. Try again." Pinned in `frontend/tests/Settings.test.tsx` ("Krea's first check says why it failed"): both cases failed on the old hook, 73 of 73 pass after. grep finds no other "backend is running" line in `frontend/src`.
- **Review fixes, live** (backend 8789, Vite 5789 pinned with `VITE_NEBULA_BACKEND_PORT=8789`, same blocking, `review-fix/live/launch_review.py`: a network guard, fake key strings, a stub that fails before sending and one that fails after Gemini answered with a 400): **39 PASS, 0 FAIL. Blocked requests to 8000-8010/5173: 0. Outside requests the guard refused: 0.** At 1440x900 and 1280x800, and again after a reload: the real World Labs handler with an off-list model and the plain-error stub read "Run the node again. If it keeps failing, open Details."; the answered stub reads "…Details shows what Gemini said."; Grok "…Set “Duration” to 10 or less. It was 12."; MiniMax "…renders 512p only…"; Gemini "Gemini 4 Argon doesn't offer Minimal for “Thinking Level”. Pick Low, Medium or High, then run the node again."; World Labs "Set “Seed” to a whole number…". The run asked the cost confirm (accepted: nothing can leave the machine). A real MCP stdio `look_at_canvas` read every exception text word for word (512P, "(received 12)", "Thinking level 'minimal'…", "Unknown World Labs model 'x-not-listed'") and none of the card lines.

## Gates

- Backend, whole suite (`iso.sh .venv/bin/python -m pytest -q -p no:cacheprovider`): 1 failed, 10170 passed, 71 skipped (12:52). The one failure was `test_commons_person_copy.py`'s pin that reads `REFUSED_FALLBACK_COPY = "…"` with double quotes from `errorCopy.ts`, where the new constant had single quotes; the constant uses double quotes now and the file passes (14 passed). Nothing else in the backend changed after the run.
- Frontend `npx vitest run` (run beside the backend suite on a loaded machine): 13 files failed, 367 passed (380); 27 tests failed, 4890 passed (4917), 20 of them "Test timed out in 5000ms". The 13 files rerun together: 5 failed (4 timeouts, 1 ModelPicker lookup), 231 passed (236). Those five alone: GraphFileActions 25/25, ModelPicker 11/11, CommandPalette 3/3, Settings 71/71, ResultsGallery 8/8. The round 3f files after the quote fix: 42/42.
- `npx tsc -b`: clean. `npm run -s lint`: clean (inline style and CSS scope guards passed).
- `npx vite build && node scripts/check-build-budget.mjs`: passed, 363,276 bytes raw / 109,103 gzip (budget 512,000 raw).
- check2 (exception texts against `74207c07`): 71 files, 0 differences.
- **After the review fixes:** backend whole suite 1 failed, 10185 passed, 71 skipped (7:39); the one failure was the cinema pin above, fixed and rerun alone (33 passed). Frontend `npx vitest run`: 6 files failed, 374 passed (380); 12 tests failed, 4905 passed (4917): 7 "Test timed out in 5000ms", 2 focus and 1 lookup in the same load-sensitive files. Those six alone (CommandPalette, GraphFileActions, NodeLibrary, Settings, ModelPicker, ResultsGallery): 6 files, 138/138 passed. `npx tsc -b` clean; `npm run -s lint` clean; `npx vite build && node scripts/check-build-budget.mjs` passed, 363,276 bytes raw / 109,103 gzip (budget 512,000). check2: 73 files, 0 differences.

## Agent support

Agents' texts don't change: every exception text, `error`, `look_at_canvas` / `run_nodes` answer, `nebula` CLI output and Agent Log line reads exactly as on `74207c07` (check2: 0 differences; the live MCP session confirmed it). Additive fields only: the `ErrorEvent`'s `provider`, the node's and a shot output's `errorProvider`, a not-ready proposal row's `person`, and a storage refusal's `storage: "full"`. `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md` describe them; `mcp_server.py`'s propose docstring says to read `missing` (the `person` beside it is the card's words). No person-only action was added.

## Open items

- Review: port labels aren't quoted ("The wire into the node's Prompt input…"), though GM's own Veo line quotes ports (“Video” output, “Extend Video”). Rule 5 names fields, so the guard leaves ports alone; ask GM.
- Review: World Labs' delete refusals ("…clear the node's Resume Operation ID and Existing World ID before you delete it.") aren't card lines and keep the 3c wording.

- The provider chip on a card still says "BFL" ("Auto · BFL"). Rule 9 says Black Forest Labs; the chip isn't a card line, so it's left for GM.
- `WORLD_LABS_UNSAFE_CLONE_MESSAGE` still says "did not", and the graph import notes still say "Settings > Providers"; neither is a card line.
- Create Studio's result delete has no confirm (it deletes the generation's nodes from its own panel); GM's confirm covers the canvas paths.
- An undo notice instead of the delete confirm needs undo to re-attach pins and reopen proposals (above).
- The full-disk line only on Projects startup (above).

## Round 3f lines for GM

### Judgment calls for GM

1. **Delete confirm kept.** Undo restores the node, its params, outputs and edges, but not the pins the delete detached or the proposals it closed. So "Delete {n} nodes?" / "Delete this node?" on the toolbar, the Delete/Backspace keys, the context menu and the Inspector. The Delete key didn't ask before; it does now.
2. **Card general line with nothing behind Details** reads "Run the node again." alone.
3. **Which provider the card names**: the route that ran (Nano Banana on Gemini → Gemini; a FLUX Kontext shot → fal.ai), never the error text, and only when that provider answered the run (review). No route, or a failure before anything was sent → "open Details". A result download that failed (`raise_for_status`) also reads "open Details": Details holds Nebula's download error, not what the provider said.
4. **Readiness**: GM's "isn't answering" only when nothing answered; an answered failure reads "Couldn't check the connections. Nebula didn't respond. Try again."
5. **Motion no-answer** keeps GM's specific "Nebula didn't respond." rather than the shared server line. The mask painter's lost-connection line uses the short server line, "Nebula's server isn't answering. Make sure it's running."
6. **Rule 6 wording**: mass nouns without an article ("Connect messages to this node…", "Connect text…"); "Model URL" → "Connect a 3D model…"; numbered ports → "Connect an output to “Item 1”, then run the node again."; camera ports → "Connect camera poses…" / "Connect sensor poses…".
7. **Line 74**: the FLUX form "Add one in Settings" (approved); a BLOCKED reason names only the key of the route that takes the field.
8. **Line 236** unchanged: its `{label}` is the image's label ("Image", "Image 2"), never a path or file name, so "{label} is damaged or incomplete. Connect another image." stands.
9. **Line 164** keeps GM's 3d Krea line 8 as already shipped ("Krea usage needs a workspace service key, and Krea doesn't accept personal API tokens for it. Add one to “{field}” in Settings. {tail}").
10. **xAI edit video** keeps GM's "the node's Model field" verbatim, though rule 5 would write “Model”.
11. **Labels that hold a parenthesis** ("Requested Duration (s)", "Duration (ms)", "HD Texture (4K)", "Image URLs (JSON)") are quoted whole (rule 5's exception); Krea node-app JSON fields keep their own label unquoted ("{label} must be a JSON object.") because the label is the app's own text.
12. **Rule 3 clauses**: option labels lose their parenthetical notes in lists; route parentheticals go; the switcher note keeps the value for an unsupported option ("Doesn't take “Resolution” set to 1.5k.") and drops it for a hidden setting ("Krea doesn't take “Reasoning level”"). ElevenLabs dialogue examples became a sentence: "…like “Rachel: Hello.”"
13. **Line 152** names the value unquoted: "“Passing options” lists {value}, which isn't one of the node's options. Pick from “Options”."
14. **Slow-job line** keeps "Google Vertex AI" where the provider is the Vertex route.
15. **Gemini Omni** (a guardrail, written fresh): "Gemini Omni can edit a video but can't make it longer. Describe the change as an edit, like “Change the lighting and keep everything else the same.”, or use Veo 3.1 to extend the video."
16. **Notices**: errors are `role="alert"` notices; "Imported.", "Opened." and "Graph saved without…" are `role="status"` notes; existing refusals (a wire, a held delete) stay status. The size line also covers graph.json inside a bundle, under its heading ("Couldn't load the graph. This graph is {n} MB. Nebula opens graphs up to {m} MB.").
17. **Left alone**: the "BFL" chip, "did not" in the unsafe World Labs clone note, "Settings > Providers" in import notes (none is a card line).
18. **A field's option in a refusal** (review, rule 5): "{model} doesn't offer {option} for “{Field}”." ("GPT-6 Astra doesn't offer None for “Reasoning Effort”. Pick Low, Medium, High, X-High or Max, then run the node again.", "GPT-5.5 doesn't offer Max for “Reasoning Effort”.", "Gemini 4 Argon doesn't offer Minimal for “Thinking Level”."). The option label stays unquoted, as in GM's route lines.
19. **World Labs lines that used GM's 3c example** "the node's Resume Operation ID field" (review, rule 5 "whatever round wrote it"): now “Resume Operation ID” keeps the job…, clear “Resume Operation ID” first, “Existing World ID” doesn't hold a World Labs job…, “World Name” is too long…, “Tags” takes up to 10 tags…, Write “Image Azimuths” as numbers…, Turn on “Reconstruct Image Set” for up to 8…, Set “Seed” to…, Fill in “Resume Operation ID” or “Existing World ID”, not both. If GM wants the 3c "in words" form kept for World Labs, say so.
20. **An image count on a node that doesn't show the field** (Nano Banana's copies, reached from an agent's params) reads "Set the number of images to a whole number from 1 to 4." in words; every node that shows it names its own label (“Count”, “Images”).

### By GM's line numbers

- **22** (BFL polling): "Black Forest Labs returned a polling URL outside https://*.bfl.ai; Nebula didn't send the key to it and stopped the run." -> "Black Forest Labs sent a status link from outside its own site, so Nebula didn't send your key there and stopped. The job may still run and be billed on Black Forest Labs." (line 111's wording; the exception text is unchanged).
- **48** (OpenAI org, GM's addition wins): -> "OpenAI needs your organization verified to use {model name}. Verify it in OpenAI's organization settings, then run the node again." The URL stays in the exception text, behind Details.
- **51** (Quiver): "Insufficient QuiverAI credits — top up or upgrade plan" -> "Your QuiverAI account is out of credits. Add credits, then run the node again."
- **69**: "The node's File can't be found. Choose the file again, then run the node again." -> "The node's file can't be found. Choose it again, then run the node again."
- **71/72**: "Set the node's Item cap…" -> "Set “Item cap” to a whole number from 1 to 25."; "…more than its Item cap of {n}…" -> "…more than its “Item cap” of {n}…"; the iterator -> "…more than its “Batch Size Cap” of {n}…" (each node's own label).
- **74**: "This node's settings can't run on your {maker key}. Add your {other key} in Settings, then run the node again." -> "These settings need your {other key}. Add it in Settings, then run the node again." ({other key} is the fallback route's key phrase, e.g. "Krea API token", "fal.ai API key"); five FLUX nodes: "These settings need your fal.ai API key, Replicate API token or Krea API token. Add one in Settings, then run the node again." (judgment 7).
- **93**: "{node} needs a prompt" -> "{node} needs a prompt. Connect one, then run the node again."; likewise "needs a video", "needs a video to edit", "needs a video to upscale", "needs at least one keyframe image".
- **110/178/189**: -> "Couldn't download the result from {Black Forest Labs|OpenRouter|Replicate}. Its download link may have expired. Run the node again."
- **112/114/179** and every 3d §2 slow job: -> "{Provider} took too long, so Nebula stopped waiting. The job may still finish there and be billed, so check {Provider} before you run the node again." (GM's addition replaces the rule's tail).
- **118/172**: "…can't be found; it may have been deleted for good…" -> "This node's character can't be found. It may have been deleted for good. Pick another character for this node." and "This node's board can't be found. It may have been deleted for good. Pick another board for this node."
- **152**: "The node's Passing Options name {…}, which isn't one of its Options." -> "“Passing options” lists {…}, which isn't one of the node's options. Pick from “Options”." (judgment 13).
- **163**: -> "The Krea Agent is still working after {n} seconds. It keeps running there, so open Krea to see the result."
- **164**: GM's 3d Krea line 8 (judgment 9).
- **236**: unchanged (judgment 8).

### Frontend lines (old -> new)

- Shared reason (`CONNECTION_LOST_COPY`): "Couldn't reach Nebula. Check your connection and try again." -> "Nebula's server isn't answering. Make sure it's running, then try again." Short form beside a Try again: "Couldn't reach Nebula. Check your connection." -> "Nebula's server isn't answering. Make sure it's running."
- General line under any other heading (`REFUSED_FALLBACK_COPY`, Commons person copy): "That didn't work. Try again, or reload if it keeps happening." -> "Try again, or reload if it keeps happening."
- Card and shot-panel general line: "That didn't work. Try again, or reload if it keeps happening." -> "Run the node again. If it keeps failing, Details shows what {Provider} said." / "Run the node again. If it keeps failing, open Details." / "Run the node again." (no Details, judgment 2).
- Cinema shot panel heading: "Couldn't run the node." -> "Couldn't generate the shot."
- Motion handoff no answer: "Couldn't confirm the video connection. Couldn't reach Nebula. Check your connection." -> "Couldn't confirm the video connection. Nebula didn't respond."
- Projects startup: "Couldn't load your projects. That didn't work. Try again, or reload if it keeps happening." -> "Couldn't load your projects. Try again, or reload the page if it keeps happening."; full disk (new) "Couldn't load your projects. Your disk is full. Free up some space, then try again."
- Provider readiness: "Couldn't check the connections. Make sure Nebula's backend is running, then try again." -> "Couldn't check the connections. Nebula's server isn't answering. Make sure it's running, then try again." (no answer) / "Couldn't check the connections. Nebula didn't respond. Try again." (answered failure, judgment 4).
- Commons busy tooltip: "…Its load average is {load}, and Settings has “Pause above load” at {threshold}…" -> "…Its load is {load}, above the {threshold} set in “Pause above load” in Settings…"; daily cap `{time}` -> local "h:mm AM/PM".
- Create Studio: "Couldn't generate." -> "Couldn't start the generation." (with "Its nodes weren't added to the canvas. Try again." and "Wait for the graph import to finish."); "Couldn't save the file." -> "Couldn't save the output."
- World Labs: "Reconnecting to this World Labs run. Run stays off until Nebula hears back about it." -> "Reconnecting to this World Labs run. You can't run it again until Nebula hears back about it."; "Nebula couldn't save the hold, so don't restart the backend." -> "Nebula couldn't save the hold, so keep Nebula running until this run finishes."; recovery warnings "could not" -> "couldn't".
- Pre-run "Nothing ran. Check the inputs and API keys, then run again." -> "…then run the node again."
- Provider switcher notes: "Doesn't take safety_tolerance" / "Needs resolution" / "Doesn't take wired {x}" -> "Doesn't take “{Label}”." / "Needs “{Label}”." / "Doesn't take connected {x}."; their fixes name option labels, never values.
- Proposal ghost card's not-ready warning: "{Node} ({id}) needs OPENAI_API_KEY in Settings > Providers" -> the readiness line, "GPT Image 2 needs your OpenAI API key. Add it in Settings."
- Graph file: "…Those outputs may be unavailable when the bundle is opened elsewhere." -> "Graph saved without {n} of its files. They may be missing when the graph is opened somewhere else." (singular: "…1 of its files. It may be missing…"); "…Nebula can safely open bundles up to {m} MB." / "…parse JSON graphs up to {m} MB." / "…above Nebula's {m} MB portable limit." -> "This graph is {n} MB. Nebula opens graphs up to {m} MB."
- Delete confirm: "Delete {n} selected {noun}?" -> "Delete {n} nodes?" / "Delete this node?" (judgment 1).
- Every error `window.alert` -> a canvas notice with the same words (judgment 16).

### Backend card lines, grouped by the rule each one broke (old -> new)

Each line is listed under the first rule it broke on `74207c07`, in the order 6, 7, 5, 3, 4, 2, 9, 8, then lines that broke only rule 1, then label and wording changes the guard doesn't name. `{}` is a value filled at run time. The judgment calls above are the ones GM should read; the rest is mechanical.

#### Rule 6: "{X} input is required" -> "Connect {X in words} to this node, then run it again." (required fields: "Fill in “{Field}”") (73)

- `execution/engine.py`: "Video input is required for frame extraction" -> "Connect a video to this node, then run it again."
- `execution/engine.py`: "SVG input is required" -> "Connect an SVG to this node, then run it again."
- `execution/maker_routes_elevenlabs.py`: "Audio input is required for speech-to-speech" -> "Connect audio to this node, then run it again."
- `execution/maker_routes_ideogram_runway.py`: "{} is required" -> "Connect {} to this node, then run it again."
- `execution/maker_routes_ideogram_runway.py`: "Prompt is required" -> "Connect a prompt to this node, then run it again."
- `execution/maker_routes_ideogram_runway.py`: "Image is required for Ideogram 4.5 Precise Edit" -> "Connect an image to this node, then run it again."
- `execution/maker_routes_ideogram_runway.py`: "Video is required for Runway Ruby" -> "Connect a video to this node, then run it again."
- `execution/maker_routes_minimax_meshy.py`: "Prompt input is required" -> "Connect a prompt to this node, then run it again."
- `handlers/anthropic_chat.py`: "Messages input is required for Claude chat" -> "Connect messages to this node, then run it again."
- `handlers/elevenlabs.py`: "Text input is required but was not provided" -> "Connect text to this node, then run it again."
- `handlers/elevenlabs.py`: "Script input is required but was not provided" -> "Connect a script to this node, then run it again."
- `handlers/elevenlabs.py`: "Text input is required for sound effects" -> "Connect text to this node, then run it again."
- `handlers/elevenlabs.py`: "Audio input is required for speech-to-speech" -> "Connect audio to this node, then run it again."
- `handlers/elevenlabs.py`: "Audio input is required for audio isolation" -> "Connect audio to this node, then run it again."
- `handlers/elevenlabs.py`: "Audio input is required for dubbing" -> "Connect audio to this node, then run it again."
- `handlers/elevenlabs.py`: "Audio input is required for transcription" -> "Connect audio to this node, then run it again."
- `handlers/elevenlabs.py`: "Prompt input is required for ElevenLabs Music" -> "Connect a prompt to this node, then run it again."
- `handlers/fal_universal.py`: "Audio input is required for stem separation" -> "Connect audio to this node, then run it again."
- `handlers/gemini_omni.py`: "Prompt, images, or video input is required" -> "Connect a prompt, images or a video to this node, then run it again."
- `handlers/google_gemini.py`: "Messages input is required for Gemini chat" -> "Connect messages to this node, then run it again."
- `handlers/google_gemini.py`: "Prompt input is required" -> "Connect a prompt to this node, then run it again."
- `handlers/google_gemini.py`: "Prompt input is required for Lyria 3" -> "Connect a prompt to this node, then run it again."
- `handlers/google_gemini.py`: "Text input is required for Gemini TTS" -> "Connect text to this node, then run it again."
- `handlers/google_gemini.py`: "Text input is required for embeddings" -> "Connect text to this node, then run it again."
- `handlers/grok_video.py`: "Prompt is required" -> "Connect a prompt to this node, then run it again."
- `handlers/higgsfield.py`: "Prompt is required" -> "Connect a prompt to this node, then run it again."
- `handlers/ideogram.py`: "{} input is required" -> "Connect {} to this node, then run it again."
- `handlers/ideogram.py`: "{} input is required" -> "Connect {} to this node, then run it again."
- `handlers/krea.py`: "Prompt input is required" -> "Connect a prompt to this node, then run it again."
- `handlers/krea.py`: "Image input is required for Krea image style reference" -> "Connect an image to this node, then run it again."
- `handlers/meshy.py`: "Image input is required" -> "Connect an image to this node, then run it again."
- `handlers/meshy.py`: "Prompt input is required" -> "Connect a prompt to this node, then run it again."
- `handlers/meshy.py`: "At least one image input is required" -> "Connect at least one image to this node, then run it again."
- `handlers/meshy.py`: "Model URL input is required for retexturing" -> "Connect a 3D model to this node, then run it again."
- `handlers/meshy.py`: "Model URL input is required for rigging" -> "Connect a 3D model to this node, then run it again."
- `handlers/meshy.py`: "Rig Task ID is required — connect from a Meshy Auto-Rig node" -> "Connect a Meshy Auto-Rig node to “Rig Task ID”, then run the node again."
- `handlers/meshy.py`: "Action ID is required — pick an animation from the library" -> "Pick an animation in “Animation”, then run the node again."
- `handlers/meshy.py`: "Model URL input is required for remeshing" -> "Connect a 3D model to this node, then run it again."
- `handlers/meshy.py`: "Prompt is required" -> "Connect a prompt to this node, then run it again."
- `handlers/meshy.py`: "Prompt is required" -> "Connect a prompt to this node, then run it again."
- `handlers/meshy.py`: "At least one reference image is required" -> "Connect at least one reference image to this node, then run it again."
- `handlers/meshy.py`: "Task ID from a completed 3D generation is required" -> "Connect a finished Meshy 3D generation to “Task ID”, then run the node again."
- `handlers/minimax.py`: "Prompt input is required" -> "Connect a prompt to this node, then run it again."
- `handlers/nous_portal.py`: "Messages input is required" -> "Connect messages to this node, then run it again."
- `handlers/openai_audio.py`: "Audio input is required for transcription" -> "Connect audio to this node, then run it again."
- `handlers/openai_audio.py`: "Audio input is required for translation" -> "Connect audio to this node, then run it again."
- `handlers/openai_audio.py`: "Text input is required for TTS" -> "Connect text to this node, then run it again."
- `handlers/openai_chat.py`: "Messages input is required for OpenAI chat" -> "Connect messages to this node, then run it again."
- `handlers/openai_image.py`: "Prompt input is required but was not provided" -> "Connect a prompt to this node, then run it again."
- `handlers/openai_image_edit.py`: "Image input is required but was not provided" -> "Connect an image to this node, then run it again."
- `handlers/openai_image_edit.py`: "Prompt input is required but was not provided" -> "Connect a prompt to this node, then run it again."
- `handlers/openai_image_v2.py`: "Prompt input is required but was not provided" -> "Connect a prompt to this node, then run it again."
- `handlers/openai_image_v2.py`: "Image input is required but was not provided" -> "Connect an image to this node, then run it again."
- `handlers/openai_image_v2.py`: "Prompt input is required but was not provided" -> "Connect a prompt to this node, then run it again."
- `handlers/openai_image_v2.py`: "Image input is required but was not provided" -> "Connect an image to this node, then run it again."
- `handlers/openrouter.py`: "Messages input is required" -> "Connect messages to this node, then run it again."
- `handlers/quiver.py`: "Prompt input is required for Quiver Arrow generate" -> "Connect a prompt to this node, then run it again."
- `handlers/quiver.py`: "Image input is required for Quiver Arrow vectorize" -> "Connect an image to this node, then run it again."
- `handlers/runway.py`: "Either an image or a text prompt is required" -> "Connect an image or a prompt to this node, then run it again."
- `handlers/runway.py`: "Video input is required for Aleph" -> "Connect a video to this node, then run it again."
- `handlers/runway.py`: "Text prompt is required for Aleph" -> "Connect a prompt to this node, then run it again."
- `handlers/runway.py`: "Text prompt is required for Runway Image" -> "Connect a prompt to this node, then run it again."
- `handlers/runway.py`: "Image input is required for Runway Upscale" -> "Connect an image to this node, then run it again."
- `handlers/runway.py`: "Character image or video is required" -> "Connect a character image or video to this node, then run it again."
- `handlers/runway.py`: "Reference performance video is required" -> "Connect a performance video to this node, then run it again."
- `handlers/runway.py`: "Text input is required" -> "Connect text to this node, then run it again."
- `handlers/runway.py`: "Audio or video input is required" -> "Connect audio or a video to this node, then run it again."
- `handlers/runway.py`: "Audio input is required for voice dubbing" -> "Connect audio to this node, then run it again."
- `handlers/xai_image.py`: "xAI image model is required" -> "Pick a model in “Model”, then run the node again."
- `handlers/xai_image.py`: "Prompt is required" -> "Connect a prompt to this node, then run it again."
- `services/qc_common.py`: "{} is required" -> "Connect {} to this node, then run it again."
- `services/qc_common.py`: "At least one sample point is required" -> "This check needs at least one frame to sample. Raise the number of samples, then run the node again."
- `services/vision_llm.py`: "At least one vision image is required" -> "Connect at least one image to this node, then run it again."

#### Rule 7: "Nothing was sent to {Provider}." (2)

- `services/krea_account.py`: "Your Krea connection doesn't offer what this node needs, so nothing was sent. Choose another provider, or check the connection in Settings." -> "Your Krea connection doesn't offer what this node needs. Nothing was sent to Krea. Choose another provider, or check the connection in Settings."
- `services/krea_mcp_generation.py`: "The saved Krea model is unavailable or ambiguous in this account; no job was submitted" -> "The saved Krea model isn't in this Krea account, or matches more than one, so pick another model. Nothing was sent to Krea."

#### Rule 5: a code name or param key -> the label or words (4)

- `execution/engine.py`: "Iterator requires an Array input" -> "Connect an array to this node, then run it again."
- `handlers/spatial.py`: "Camera Path requires at least one CameraPose input" -> "Connect camera poses to this node, then run it again."
- `handlers/spatial.py`: "Spatial Context requires equal non-zero CameraPose and Image inputs" -> "Spatial Context needs as many camera poses as images, and at least one of each. Connect them, then run the node again."
- `handlers/spatial.py`: "Sensor Rig requires at least one CameraPose input" -> "Connect sensor poses to this node, then run it again."

#### Rule 3: no parentheses (5)

- `handlers/duration_check.py`: "Connect a duration, or set the node's Requested Duration (s), then run it again." -> "Connect a duration, or set “Requested Duration (s)”, then run it again."
- `handlers/elevenlabs.py`: "Set the node's Duration (ms) to a whole number of milliseconds." -> "Set “Duration (ms)” to a whole number of milliseconds."
- `handlers/elevenlabs.py`: "Set the node's Duration (ms) to a whole number of milliseconds." -> "Set “Duration (ms)” to a whole number of milliseconds."
- `handlers/elevenlabs.py`: "Set the node's Duration (ms) to a number from {} to {}." -> "Set “Duration (ms)” to a number from {} to {}."
- `handlers/meshy.py`: "Meshy 6 Lite makes 2K textures only. Turn off HD Texture (4K) or pick another model." -> "Meshy 6 Lite makes 2K textures only. Turn off “HD Texture (4K)” or pick another model."

#### Rule 4: "wired" -> "connected" (9)

- `execution/route_clients.py`: "{node} takes one {}, but {} are wired. Disconnect the extra ones." -> "{node} takes one {}, but {} are connected. Disconnect the extra ones."
- `execution/route_clients.py`: "{node} can't take the wired {}. Disconnect it or choose another provider." -> "{node} can't take the connected {}. Disconnect it or choose another provider."
- `handlers/krea.py`: "Deletes need the ID typed into the node, not wired in; nothing was deleted" -> "Type the ID into “ID” to delete an item, instead of connecting it. Nothing was deleted."
- `handlers/krea_export.py`: "Wire a Krea 3D job or enter its job ID" -> "Connect a Krea 3D job or fill in “Job ID”, then run the node again."
- `handlers/krea_workspace.py`: "This node app takes {} more {}, and {} are wired. Disconnect the extra ones, then run the node again." -> "This node app takes {} more {}, and {} are connected. Disconnect the extra ones, then run the node again."
- `handlers/krea_workspace.py`: "This node app has no free text input for the wired text" -> "This node app has no free text input for the connected text. Disconnect it, then run the node again."
- `handlers/krea_workspace.py`: "Wire media or text to save to Krea Files" -> "Connect media or text to save to Krea Files, then run the node again."
- `handlers/veo.py`: "Veo extends only a clip Veo made, by its source URI. Wire the upstream Veo node's “Source URI” output into “Extend Video”. Veo rejects re-uploaded or external video files." -> "Veo extends only a clip Veo made, by its source URI. Connect the upstream Veo node's “Source URI” output into “Extend Video”. Veo rejects re-uploaded or external video files."
- `handlers/veo.py`: "Vertex can't read a Gemini API file URI. Wire the upstream node's “Video” output, the saved clip, into “Extend Video” instead." -> "Vertex AI can't extend a clip made through the Gemini API. Connect the upstream node's “Video” output to “Extend Video” instead."

#### Rule 2: no em dashes or semicolons (31)

- `execution/engine.py`: "ffmpeg not found — install ffmpeg to use Frame Extractor" -> "Frame Extractor needs ffmpeg, which isn't installed on this computer. Install ffmpeg, then run the node again."
- `execution/engine.py`: "No mask painted yet — open the Mask Painter node and paint one" -> "No mask is painted yet. Open the Mask Painter node and paint one, then run the node again."
- `execution/maker_routes_byteplus_seedance.py`: "BytePlus has no {} ratio; run this on Krea" -> "BytePlus doesn't offer this aspect ratio, so run this node on Krea."
- `execution/maker_routes_google.py`: "Identity Edit does not support masks on the Nano Banana 2 endpoint; disconnect Mask before running this node" -> "Identity Edit can't take a mask on the Nano Banana 2 endpoint. Disconnect “Mask”, then run the node again."
- `execution/maker_routes_google.py`: "On Vertex, reference images only make 8-second videos; set duration to 8" -> "On Vertex AI, reference images make 8-second videos only. Set “Duration” to 8, then run the node again."
- `execution/maker_routes_google.py`: "Google documents 4K with reference images only on the Veo previews; pick 720p or 1080p" -> "Google offers 4K with reference images only on the Veo previews. Pick 720p or 1080p in “Resolution”."
- `execution/maker_routes_ideogram_runway.py`: "{} points at this machine; connect the output itself or use a public URL" -> "{} points at this computer. Connect the output itself, or use a public link."
- `execution/maker_routes_openai.py`: "OpenAI image edits take up to {} images; got {}" -> "OpenAI image edits take up to {} images, and {} are connected."
- `execution/maker_routes_xai.py`: "Style images are a Krea feature; xAI's API has no style references" -> "xAI takes no style images, so run this node on Krea for them."
- `execution/maker_routes_xai.py`: "Start video is a Krea feature here; this run belongs on Krea" -> "A start video runs only on Krea, so run this node on Krea."
- `execution/sync_runner.py`: "Ideogram Character needs reference images — connect Character Refs or attach a Character node" -> "Ideogram Character needs reference images. Connect “Character Refs” or a Character node, then run the node again."
- `handlers/bfl.py`: "Black Forest Labs returned a polling URL outside https://*.bfl.ai; Nebula didn't send the key to it and stopped the run." -> "Black Forest Labs sent a status link from outside its own site, so Nebula didn't send your key there and stopped. The job may still run and be billed on Black Forest Labs."
- `handlers/bfl.py`: "Black Forest Labs' result couldn't be downloaded; its link may have expired. Run the node again." -> "Couldn't download the result from Black Forest Labs. Its download link may have expired. Run the node again."
- `handlers/character_node.py`: "This node's character can't be found; it may have been deleted for good. Pick another character for this node." -> "This node's character can't be found. It may have been deleted for good. Pick another character for this node."
- `handlers/google_gemini.py`: "Gemini takes up to {} stop sequences; this node has {}." -> "Gemini takes up to {} stop sequences, and this node has {}."
- `handlers/krea.py`: "Krea 2 accepts at most 10 image style references; got {}" -> "Krea 2 takes up to 10 image style references, and {} are connected."
- `handlers/krea.py`: "Type the same ID into Confirm delete to remove this Krea item; nothing was deleted" -> "Type the same ID into “Confirm delete” to remove this Krea item. Nothing was deleted."
- `handlers/krea_gateway.py`: "Krea cannot access a local URL; upload the media or use an owned output reference" -> "Krea can't open a link to this computer. Connect the file or the output itself instead."
- `handlers/krea_workspace.py`: "Krea asked for a multipart upload, which Nebula does not send yet; nothing was saved" -> "Krea asked for an upload in parts, which Nebula doesn't send yet. Nothing was saved."
- `handlers/krea_workspace.py`: "The Krea Agent is still working after {} seconds. It keeps running in Krea; open Krea to see it." -> "The Krea Agent is still working after {} seconds. It keeps running there, so open Krea to see the result."
- `handlers/moodboard.py`: "This node's board can't be found; it may have been deleted for good. Pick another board for this node." -> "This node's board can't be found. It may have been deleted for good. Pick another board for this node."
- `handlers/nous_portal.py`: "No model selected — choose one from the Inspector panel" -> "Pick a model in “Model”, then run the node again."
- `handlers/openai_image_v2.py`: "GPT Image edit accepts up to {} input images; got {}" -> "GPT Image edit takes up to {} images, and {} are connected."
- `handlers/openrouter.py`: "No model selected — choose a model from the Inspector panel" -> "Pick a model in “Model”, then run the node again."
- `handlers/paper_source.py`: "Pinned Paper snapshot requires its exact ID and SHA-256 hash; refresh or reconnect before running" -> "This node's Paper snapshot is incomplete. Refresh or reconnect it, then run the node again."
- `handlers/quiver.py`: "Insufficient QuiverAI credits — top up or upgrade plan" -> "Your QuiverAI account is out of credits. Add credits, then run the node again."
- `handlers/runway.py`: "{} takes a duration of {} s{}; got {} s." -> "{} takes a duration of {} seconds{}. {}"
- `handlers/runway.py`: "{} resolution must be one of {}; got '{}'." -> "{} takes a resolution of {}. Pick one in “Resolution”."
- `handlers/runway.py`: "{} takes up to {} reference images; {} are connected." -> "{} takes up to {} reference images, and {} are connected."
- `services/typesafe_client.py`: "{} is {}x{}, over Nebula's {} megapixel input limit; downscale it first" -> "{} is {}x{}, over Nebula's {} megapixel limit for an input. Downscale it, then run the node again."
- `services/typesafe_client.py`: "{} images connected; this node takes at most {}" -> "This node takes up to {} images, and {} are connected."

#### Rule 9: one name and one unit each (fal.ai, Black Forest Labs, Vertex AI, MB, seconds, 1080p) (8)

- `execution/maker_routes_minimax_meshy.py`: "MiniMax makes 1080P clips at 6 seconds only." -> "MiniMax makes 1080p clips at 6 seconds only."
- `handlers/runway.py`: "{} has no automatic duration. Pick one of: {} s." -> "{} has no automatic duration. Pick {} seconds in “Duration”."
- `services/typesafe_client.py`: "{} is larger than {} MiB" -> "{} is larger than {} MB. Connect a smaller image."
- `services/typesafe_client.py`: "{} took longer than {} s to download" -> "Couldn't download {}. It took longer than {} seconds."
- `services/typesafe_client.py`: "{} {} is over TypeSafe's 16 MiB per-image limit even as a small JPEG" -> "{} {} is over TypeSafe's 16 MB limit for one image, even as a small JPEG. Connect a smaller image."
- `services/typesafe_client.py`: "The {} images come to {} MiB even as small JPEGs, over TypeSafe's 32 MiB request limit. Send fewer images or split the work across nodes." -> "The {} images come to {} MB even as small JPEGs, over TypeSafe's 32 MB request limit. Send fewer images or split the work across nodes."
- `services/typesafe_client.py`: "The images come to more than {} MiB before resizing. Send fewer or smaller images." -> "The images come to more than {} MB before resizing. Send fewer or smaller images."
- `services/typesafe_client.py`: "The request is {} MiB, over TypeSafe's 32 MiB limit. Shorten the context or send fewer images." -> "The request is {} MB, over TypeSafe's 32 MB limit. Shorten the context or send fewer images."

#### Rule 8: "Run the node again." (1)

- `handlers/character_node.py`: "Every reference view of Character {} is an image link from outside Nebula, so none can be used. Replace them with uploads in Character Studio and run again." -> "Every reference view of this node's character is an image link from outside Nebula, so none can be used. Replace them with uploads in Character Studio, then run the node again."

#### A line built from runtime text (2)

- `execution/engine.py`: the Gemini Omni guardrail's card line (it showed the capability error's own text) -> GEMINI_OMNI_EXTENSION_LINE, "Gemini Omni can edit a video but can't make it longer. Describe the change as an edit, like “Change the lighting and keep everything else the same.”, or use Veo 3.1 to extend the video." (judgment 15)
- `execution/maker_routes.py`: line 74's key line now takes the route block, so a BLOCKED reason names only the key of the route that takes the field (judgment 7)

#### Rule 1: ends with a period (lines that broke only rule 1) (80)

- `execution/maker_routes_byteplus.py`: "Seedream needs a width and a height" -> "Seedream needs a width and a height. Fill in “Width” and “Height”, then run the node again."
- `execution/maker_routes_byteplus.py`: "Seedream needs a prompt" -> "Seedream needs a prompt. Connect one, then run the node again."
- `execution/maker_routes_byteplus_seedance.py`: "Seedance takes one start image and one end image" -> "Seedance takes one start image and one end image. Disconnect the extra ones, then run the node again."
- `execution/maker_routes_byteplus_seedance.py`: "BytePlus has no {} ratio" -> "BytePlus doesn't offer this aspect ratio. Pick another one, then run the node again."
- `execution/maker_routes_byteplus_seedance.py`: "Seedance needs a prompt or an image" -> "Seedance needs a prompt or an image. Connect one, then run the node again."
- `execution/maker_routes_google.py`: "An end image needs a start image too" -> "An end image needs a start image too. Connect one, then run the node again."
- `execution/maker_routes_google.py`: "Veo needs a prompt or a start image" -> "Veo needs a prompt or a start image. Connect one, then run the node again."
- `execution/maker_routes_google.py`: "Veo 3.1 Lite takes no reference images on Vertex" -> "Veo 3.1 Lite takes no reference images on Vertex AI. Disconnect them, then run the node again."
- `execution/maker_routes_ideogram_runway.py`: "{} is not a valid URL" -> "{} isn't a valid link. Connect another one."
- `execution/maker_routes_ideogram_runway.py`: "Width and height must be positive" -> "“Width” and “Height” must be more than 0."
- `execution/maker_routes_minimax_meshy.py`: "Meshy text-to-3D needs a prompt" -> "Meshy text-to-3D needs a prompt. Connect one, then run the node again."
- `execution/maker_routes_openai.py`: "Krea size {} at {} has no OpenAI equivalent" -> "OpenAI has no size for this aspect ratio and resolution. Pick another, or run this node on Krea."
- `execution/maker_routes_openai.py`: "Background must be auto, opaque or transparent" -> "Pick one of the “Background” options, then run the node again."
- `execution/maker_routes_openai.py`: "A transparent background needs PNG or WebP output, not JPEG" -> "A transparent background needs PNG or WebP output, not JPEG. Change “Format”, then run the node again."
- `execution/maker_routes_xai.py`: "Grok Imagine Image Edit needs at least one source image" -> "Grok Imagine Image Edit needs at least one source image. Connect one, then run the node again."
- `execution/maker_routes_xai.py`: "Grok Imagine 2.0 Edit needs at least one image in Image URLs" -> "Grok Imagine 2.0 Edit needs at least one image. Connect one, then run the node again."
- `execution/maker_routes_xai.py`: "xAI needs a prompt to edit a video" -> "xAI needs a prompt to edit a video. Connect one, then run the node again."
- `execution/maker_routes_xai.py`: "xAI needs a prompt unless a start image is set" -> "xAI needs a prompt or a start image. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs a video to edit" -> "{node} needs a video to edit. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs a video to upscale" -> "{node} needs a video to upscale. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs a prompt" -> "{node} needs a prompt. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs at least one keyframe image" -> "{node} needs at least one keyframe image. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs a video" -> "{node} needs a video. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs a prompt" -> "{node} needs a prompt. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs a prompt" -> "{node} needs a prompt. Connect one, then run the node again."
- `execution/route_clients.py`: "{node} needs a prompt" -> "{node} needs a prompt. Connect one, then run the node again."
- `handlers/elevenlabs.py`: "The dialogue script is empty. Write one line per turn, e.g. 'Rachel: Hello.' then 'Adam: Hi!'" -> "The dialogue script is empty. Write one line per turn, each starting with a voice name and a colon, like “Rachel: Hello.”"
- `handlers/fal_universal.py`: "Nano Banana edit requires at least one reference image" -> "Connect at least one reference image to this node, then run it again."
- `handlers/ideogram.py`: "Training images are required" -> "Connect training images to this node, then run it again."
- `handlers/ideogram.py`: "Training images are required" -> "Connect training images to this node, then run it again."
- `handlers/jev_box.py`: "Jev Box needs an image: connect one to Image" -> "Connect an image to this node, then run it again."
- `handlers/jev_box.py`: "Jev Box needs a target: what to find, e.g. 'the red car'" -> "Jev Box needs a target, what to find, like “the red car”. Fill in “Target”, then run the node again."
- `handlers/jev_decide.py`: "Jev Decide needs a question" -> "Fill in “Question”, then run the node again."
- `handlers/jev_decide.py`: "Jev Decide needs something to judge: connect Context text, Images, or both" -> "Jev Decide needs something to judge. Connect context text, images or both, then run the node again."
- `handlers/krea.py`: "Krea image reference is empty" -> "A connected image is empty. Connect another image."
- `handlers/krea.py`: "Krea asset upload needs an image value" -> "Krea needs an image here. Connect one, then run the node again."
- `handlers/krea.py`: "Krea 2 currently accepts at most one moodboard" -> "Krea 2 takes one moodboard. Disconnect the extra ones, then run the node again."
- `handlers/krea.py`: "Krea style training requires at least one training image" -> "Connect at least one training image to this node, then run it again."
- `handlers/krea.py`: "Krea style training requires a name" -> "Fill in “Name”, then run the node again."
- `handlers/krea.py`: "A Krea moodboard needs at least one image" -> "Connect at least one image to this node, then run it again."
- `handlers/krea.py`: "Choose a valid Krea style or moodboard ID to change" -> "Fill in “ID” with the Krea style or moodboard to change, then run the node again."
- `handlers/krea.py`: "Enter the new name" -> "Fill in “New name”, then run the node again."
- `handlers/krea_gateway.py`: "Krea media input exceeds the 75 MB asset limit" -> "A connected file is over Krea's 75 MB limit. Connect a smaller one."
- `handlers/krea_gateway.py`: "Krea media input is empty or exceeds the 75 MB asset limit" -> "A connected file is empty or over Krea's 75 MB limit. Connect another one."
- `handlers/krea_workspace.py`: "{} must be a JSON object" -> "{} must be a JSON object."
- `handlers/krea_workspace.py`: "{} must be a JSON object" -> "{} must be a JSON object."
- `handlers/krea_workspace.py`: "Enter a valid Krea job ID" -> "Enter a valid Krea job ID."
- `handlers/krea_workspace.py`: "Folder must be a Krea Files URI like folder:<uuid>" -> "Set “Folder” to a Krea Files folder, then run the node again."
- `handlers/krea_workspace.py`: "Save to Krea Files takes Nebula media from this machine, not remote URLs" -> "Save to Krea Files takes media made or uploaded in Nebula, not links. Connect one of those."
- `handlers/krea_workspace.py`: "Enter the Krea Nodes workflow ID or link" -> "Fill in “Workflow ID or link”, then run the node again."
- `handlers/krea_workspace.py`: "Operations must be a JSON list of Krea Nodes edits" -> "“Operations (JSON)” must be a JSON list of Krea Nodes edits."
- `handlers/krea_workspace.py`: "The Krea Agent needs a prompt" -> "Connect a prompt or fill in “Prompt”, then run the node again."
- `handlers/minimax_v2.py`: "MiniMax H3 needs a prompt" -> "MiniMax H3 needs a prompt. Connect one, then run the node again."
- `handlers/minimax_v2.py`: "MiniMax H3 takes one {} image" -> "MiniMax H3 takes one {} image. Disconnect the extra ones, then run the node again."
- `handlers/openai_image.py`: "A transparent background needs PNG or WebP output, not JPEG" -> "A transparent background needs PNG or WebP output, not JPEG. Change “Format”, then run the node again."
- `handlers/openai_image_v2.py`: "Background must be auto, opaque or transparent" -> "Pick one of the “Background” options, then run the node again."
- `handlers/openai_image_v2.py`: "A transparent background needs PNG or WebP output, not JPEG" -> "A transparent background needs PNG or WebP output, not JPEG. Change “Format”, then run the node again."
- `handlers/paper_source.py`: "Link and export a Paper object before running" -> "Link a Paper object and export it, then run the node again."
- `handlers/veo.py`: "Veo video extension cannot be combined with a first or last frame" -> "Veo can't extend a video and use a first or last frame at once. Disconnect one, then run the node again."
- `handlers/veo.py`: "Extend Video needs a file, a gs:// URI or an https URL" -> "“Extend Video” needs a video file, a Google Cloud Storage link or a web link. Connect one, then run the node again."
- `handlers/veo.py`: "Veo First-Last Frame needs both a first and a last frame" -> "Veo First-Last Frame needs a first and a last frame. Connect both, then run the node again."
- `handlers/veo.py`: "Extending a clip needs the Google route: add a Vertex or Gemini API key in Settings" -> "Extending a clip runs on Google. Add your Vertex AI credentials or Gemini API key in Settings, then run the node again."
- `handlers/veo.py`: "A last frame needs a first frame too" -> "A last frame needs a first frame too. Connect one, then run the node again."
- `handlers/xai_image.py`: "Image input is empty" -> "The connected image is empty. Connect another image."
- `handlers/xai_image.py`: "Video input is empty" -> "The connected video is empty. Connect another video."
- `services/edit_masks.py`: "{} isn't a PNG, JPEG, WebP or GIF image Nebula can read" -> "{} isn't a PNG, JPEG, WebP or GIF image Nebula can read."
- `services/edit_masks.py`: "The image to edit isn't a PNG, JPEG, WebP or GIF file Nebula can read, so its mask can't be sized to it" -> "The image to edit isn't a PNG, JPEG, WebP or GIF file Nebula can read, so its mask can't be sized to it."
- `services/krea_account.py`: "Krea needs a media URL or a local file" -> "Krea needs a media link or a file. Connect one, then run the node again."
- `services/media_input.py`: "{} is larger than {}, the most this provider takes" -> "{} is larger than {}, the most this provider takes. Connect a smaller one."
- `services/media_input.py`: "{} is empty" -> "{} is empty. Connect another one."
- `services/qc_jev.py`: "Jev mode needs at least one check" -> "Jev mode needs at least one check."
- `services/typesafe_client.py`: "{} is empty" -> "{} is empty. Connect another image."
- `services/typesafe_client.py`: "{} is too large to decode safely" -> "{} is too large to decode safely. Connect a smaller image."
- `services/typesafe_client.py`: "A Choice takes 1 to {} options" -> "A Choice takes 1 to {} options."
- `services/typesafe_client.py`: "A Choice needs at least two options" -> "A Choice needs at least two options."
- `services/typesafe_client.py`: "Choice options must be different from each other" -> "Choice options must be different from each other."
- `services/typesafe_client.py`: "A Score needs {} to {} levels" -> "A Score needs {} to {} levels."
- `services/typesafe_client.py`: "Score levels must be different from each other" -> "Score levels must be different from each other."
- `services/typesafe_client.py`: "A Jev request needs at least one question" -> "A Jev request needs at least one question."
- `services/vision_llm.py`: "Vision requests support at most {} images" -> "This node takes up to {} images, and {} are connected."

#### Labels in quotes (rule 5), GM's specific lines, the slow-job line, key lines and other wording (70)

- `execution/engine.py`: "The node's File can't be found. Choose the file again, then run the node again." -> "The node's file can't be found. Choose it again, then run the node again."
- `execution/engine.py`: "This {} would make {} items, more than its {} of {}. Make the batch smaller, then run it again. Nothing after it was generated." -> "This {} would make {} items, more than its “{}” of {}. Make the batch smaller, then run it again. Nothing after it was generated."
- `execution/engine.py`: "Set the node's Item cap to a whole number from 1 to 25." -> "Set “Item cap” to a whole number from 1 to 25."
- `execution/engine.py`: "This Batch has {} items, more than its Item cap of {}. Remove items or raise the cap, then run it again. Nothing was generated." -> "This Batch has {} items, more than its “Item cap” of {}. Remove items or raise the cap, then run it again. Nothing was generated."
- `execution/engine.py`: "Set the node's Batch Size Cap to a whole number from 1 to 25." -> "Set “Batch Size Cap” to a whole number from 1 to 25."
- `execution/maker_routes.py`: "Write the node's image URLs as a JSON list of links." -> "Write “Image URLs (JSON)” as a JSON list of links."
- `execution/maker_routes_byteplus_seedance.py`: "Set Duration to whole seconds from {} to {}. {}" -> "Set “Duration” to whole seconds from {} to {}. {}"
- `execution/maker_routes_byteplus_seedance.py`: "Set Duration to whole seconds from {} to {}. {}" -> "Set “Duration” to whole seconds from {} to {}. {}"
- `execution/maker_routes_byteplus_seedance.py`: "Set Duration to whole seconds from {} to {}. {}" -> "Set “Duration” to whole seconds from {} to {}. {}"
- `execution/maker_routes_byteplus_seedance.py`: "{} on BytePlus renders {}. Pick one in the node's Resolution field." -> "{} on BytePlus renders {}. Pick one in “Resolution”."
- `execution/maker_routes_byteplus_seedance.py`: "Set Seed to a whole number from -1 to 2147483647. {}" -> "Set “Seed” to a whole number from -1 to 2147483647. {}"
- `execution/maker_routes_elevenlabs.py`: "To run this on ElevenLabs, fill in the node's ElevenLabs voice ID. Runway voice presets don't carry over." -> "To run this on ElevenLabs, fill in “ElevenLabs voice ID”. Runway voice presets don't carry over."
- `execution/maker_routes_elevenlabs.py`: "ElevenLabs speech-to-speech takes audio, not video. Connect the audio track to Audio, or clear the node's ElevenLabs voice ID to run this on Runway." -> "ElevenLabs speech-to-speech takes audio, not video. Connect the audio track to “Audio”, or clear “ElevenLabs voice ID” to run this on Runway."
- `execution/maker_routes_ideogram_runway.py`: "Set Seed to a whole number from 0 to {}. {}" -> "Set “Seed” to a whole number from 0 to {}. {}"
- `execution/maker_routes_ideogram_runway.py`: "Pick one of the node's Quality options, then run the node again." -> "Pick one of the “Quality” options, then run the node again."
- `execution/maker_routes_minimax_meshy.py`: "MiniMax has no resolution {}" -> "MiniMax doesn't offer this resolution. Pick another in “Resolution”, then run the node again."
- `execution/maker_routes_minimax_meshy.py`: "MiniMax makes 6 or 10 second clips. Set Duration to 6 or 10. {}" -> "MiniMax makes 6 or 10 second clips. Set “Duration” to 6 or 10. {}"
- `execution/maker_routes_minimax_meshy.py`: "MiniMax's first-and-last-frame mode is Hailuo 02 only, so {} can't take an end image on your MiniMax key. Disconnect End image. {}" -> "MiniMax's first-and-last-frame mode is Hailuo 02 only, so {} can't take an end image on your MiniMax key. Disconnect “End image”. {}"
- `execution/maker_routes_minimax_meshy.py`: "Meshy image-to-3D needs an image. Connect one, or set Input mode to text." -> "Meshy image-to-3D needs an image. Connect one, or set “Input mode” to text."
- `execution/maker_routes_openai.py`: "Write the node's image URLs as a JSON list of links." -> "Write “Image URLs (JSON)” as a JSON list of links."
- `execution/maker_routes_openai.py`: "Set Quality to Auto, Low, Medium or High, then run the node again." -> "Set “Quality” to Auto, Low, Medium or High, then run the node again."
- `execution/maker_routes_xai.py`: "Set Resolution to 1K or 2K, then run the node again. {}" -> "Set “Resolution” to 1K or 2K, then run the node again. {}"
- `execution/maker_routes_xai.py`: "Set Duration to a whole number of seconds. {}" -> "Set “Duration” to a whole number of seconds. {}"
- `execution/maker_routes_xai.py`: "xAI edits videos only on {}, not on {}. Disconnect the edit video, then run the node again." -> "xAI edits videos only on {}. Pick it in the node's Model field, or disconnect the video to edit."
- `execution/maker_routes_xai.py`: "xAI makes videos of 1 to 15 seconds. Set Duration in that range. {}" -> "xAI makes videos of 1 to 15 seconds. Set “Duration” in that range. {}"
- `execution/route_clients.py`: "{node} can't use the saved size. Pick one in the node's Size field, then run it again." -> "{node} can't use the saved size. Pick one in “Size”, then run it again."
- `execution/route_clients.py`: "{node} needs a number of seconds to place its keyframes. Set the node's Duration field, then run it again." -> "{node} needs a number of seconds to place its keyframes. Set “Duration”, then run it again."
- `execution/sync_runner.py`: "Set the node's {} to a whole number from 1 to 100." -> "Set “{}” to a whole number from 1 to 100."
- `handlers/anthropic_chat.py`: "{} takes {} effort. Pick one in the node's Effort field, then run the node again." -> "{} takes {} effort. Pick one in “Effort”, then run the node again."
- `handlers/character_node.py`: "Choose a character in the node's Character field, then run it again." -> "Choose a character in “Character”, then run it again."
- `handlers/cinema_color.py`: "The node's Palette Source image can't be found. Choose it again, or clear it." -> "The node's palette source image can't be found. Choose it again, or clear it."
- `handlers/elevenlabs.py`: "The node's Voice ID must be an ElevenLabs voice ID, letters and digits only." -> "“Voice ID” must be an ElevenLabs voice ID, letters and digits only."
- `handlers/elevenlabs.py`: "Dialogue line {} has no speaker. Start each line with a voice name from your ElevenLabs voices and a colon, e.g. 'Rachel: Hello there.' Received {}" -> "Dialogue line {} has no speaker. Start each line with a voice name from your ElevenLabs voices and a colon, like “Rachel: Hello there.”"
- `handlers/elevenlabs.py`: "Set the node's Language Code to a two-letter code like en or es, or clear it." -> "Set “Language Code” to a two-letter code like en or es, or clear it."
- `handlers/elevenlabs.py`: "Set the node's Seed to a whole number from 0 to {}, or clear it." -> "Set “Seed” to a whole number from 0 to {}, or clear it."
- `handlers/fal_universal.py`: "Enter a fal.ai endpoint in the node's {} field, then run the node again." -> "Enter a fal.ai endpoint in “{}”, then run the node again."
- `handlers/gemini_omni.py`: "Gemini Omni makes videos of 3 to 10 seconds. Set Duration in that range. {}" -> "Gemini Omni makes videos of 3 to 10 seconds. Set “Duration” in that range. {}"
- `handlers/ideogram.py`: "Set the node's Resolution to run Ideogram Reframe on your Ideogram key." -> "Set “Resolution” to run Ideogram Reframe on your Ideogram key."
- `handlers/ideogram.py`: "Ideogram Character needs a character reference. Connect an image to Character Refs or attach a Character node, then run the node again." -> "Ideogram Character needs a character reference. Connect an image to “Character Refs” or attach a Character node, then run the node again."
- `handlers/ideogram.py`: "Ideogram needs an image to edit. Connect one to Image or Images, then run the node again." -> "Ideogram needs an image to edit. Connect one to “Image” or “Images”, then run the node again."
- `handlers/ideogram.py`: "Give the model a name in the node's Model Name field, then run it again." -> "Give the model a name in “Model Name”, then run it again."
- `handlers/jev_box.py`: "Jev Box runs on Jev 1.14 only. Pick {} in the node's Model field, then run the node again." -> "Jev Box runs on Jev 1.14 only. Pick {} in “Model”, then run the node again."
- `handlers/jev_decide.py`: "The node's Passing Options name {}, which isn't one of its Options." -> "“{}” lists {}, which isn't one of the node's options. Pick from “{}”."
- `handlers/jev_pick_best.py`: "Jev Pick Best needs at least two candidate images, got {}" -> "Jev Pick Best needs at least two candidate images. Connect another, then run the node again."
- `handlers/krea.py`: "Fill in the node's Style ID, then run it again." -> "Fill in “Style ID”, then run the node again."
- `handlers/krea.py`: "Fill in the node's Moodboard ID, then run it again." -> "Fill in “Moodboard ID”, then run the node again."
- `handlers/krea_export.py`: "Krea exports OBJ, FBX, STL or PLY, not {}" -> "Krea exports OBJ, FBX, STL or PLY. Pick one in “Format”, then run the node again."
- `handlers/krea_workspace.py`: "Enter a valid {}" -> "Enter a valid {}."
- `handlers/krea_workspace.py`: "This node app has no input named {}" -> "This node app has no input by one of the names given. Check the names, then run the node again."
- `handlers/meshy.py`: "Smart Topology makes triangles only. Set Topology to Triangle." -> "Smart Topology makes triangles only. Set “Topology” to Triangle."
- `handlers/meshy.py`: "Smart Topology makes at most {} faces. Set Polycount to {} or less." -> "Smart Topology makes at most {} faces. Set “Polycount” to {} or less."
- `handlers/openai_image_v2.py`: "Pick Flare or Sunburst in the node's Model field, then run the node again." -> "Pick Flare or Sunburst in “Model”, then run the node again."
- `handlers/openai_image_v2.py`: "GPT Image 2.5 quality must be one of {}" -> "Pick one of the “Quality” options for GPT Image 2.5, then run the node again."
- `handlers/openrouter_media.py`: "OpenRouter's video couldn't be downloaded. Run the node again." -> "Couldn't download the result from OpenRouter. Its download link may have expired. Run the node again."
- `handlers/replicate_model.py`: "Replicate's result couldn't be downloaded. Run the node again." -> "Couldn't download the result from Replicate. Its download link may have expired. Run the node again."
- `handlers/replicate_universal.py`: "Replicate has no version of the model in the node's Model ID field to run. Check the model on Replicate, then run the node again." -> "Replicate has no version of the model in “Model ID” to run. Check the model on Replicate, then run the node again."
- `handlers/replicate_universal.py`: "The model returned {}, but this node's output is set to {}, so nothing was passed on. Pick the model again in the node's Model ID field to re-read its outputs, then run the node again." -> "The model returned {}, but this node's output is set to {}, so nothing was passed on. Pick the model again in “Model ID” to re-read its outputs, then run the node again."
- `handlers/replicate_universal.py`: "Enter a Replicate model in the node's {} field, as its page on Replicate writes it, then run the node again." -> "Enter a Replicate model in “{}”, as its page on Replicate writes it, then run the node again."
- `handlers/runway.py`: "Duration must be a number of seconds, got {}" -> "Set “Duration” to a number of seconds."
- `handlers/runway.py`: "Pick a model in the node's Model field, then run the node again." -> "This node's model isn't one Runway offers. Pick one in “Model”, then run the node again."
- `handlers/runway.py`: "Pick {} in the node's Model field, then run the node again." -> "This node's model isn't one Runway offers. Pick {} in “Model”, then run the node again."
- `handlers/runway.py`: "Pick a model in the node's Model field, then run the node again." -> "This node's model isn't one Runway offers. Pick one in “Model”, then run the node again."
- `handlers/style_reference.py`: "Choose an image in the node's Reference Image field, then run it again." -> "Choose an image in “Reference Image”, then run it again."
- `handlers/style_reference.py`: "The node's Reference Image can't be found. Choose it again, then run the node again." -> "The node's reference image can't be found. Choose it again, then run the node again."
- `handlers/veo.py`: "Pick a Veo 3.1 model in the node's Model field, then run it again." -> "Pick a Veo 3.1 model in “Model”, then run it again."
- `handlers/veo.py`: "Extending a video takes Veo 3.1 or Veo 3.1 Fast. Pick one in the node's Model field, or disconnect Extend Video." -> "Extending a video takes Veo 3.1 or Veo 3.1 Fast. Pick one in “Model”, or disconnect “Extend Video”."
- `services/qc_common.py`: "Invalid sample point: {}" -> "A frame to sample isn't valid. Check the sampling settings, then run the node again."
- `services/qc_jev.py`: "Set the node's Minimum Confidence to a number from 0 to 1." -> "Set “Minimum Confidence” to a number from 0 to 1."
- `services/qc_jev.py`: "Set the node's Minimum Confidence to a number from 0 to 1." -> "Set “Minimum Confidence” to a number from 0 to 1."
- `services/vision_llm.py`: "Unsupported vision image type: {}" -> "A connected image isn't a PNG, JPEG, WebP or GIF. Connect one of those, then run the node again."


#### Review fixes: rules 5 and 9 on lines the first pass missed (old -> new)

- `execution/maker_routes_xai.py`: "…Set Duration to {} or less. {}" -> "…Set “Duration” to {} or less. {}"
- `handlers/openai_chat.py`: "Reasoning Effort Max isn't available for {}. Pick another level, then run the node again." -> "{} doesn't offer Max for “Reasoning Effort”. Pick another level, then run the node again." (judgment 18)
- `handlers/openai_chat.py`: "{} doesn't offer Reasoning Effort {}. Pick {}, then run the node again." -> "{} doesn't offer {} for “Reasoning Effort”. Pick {}, then run the node again."
- `handlers/google_gemini.py`: "{} doesn't offer Thinking Level {}. Pick {}, …" -> "{} doesn't offer {} for “Thinking Level”. Pick {}, …" (the options now come from the node's own `thinkingLevel` field: "Minimal", "Low, Medium or High", not "minimal", "low, medium or high")
- `handlers/xai_image.py`: "xAI takes Quality only on {}. Clear the node's Quality field, then run the node again." -> "xAI takes “Quality” only on {}. Clear “Quality”, then run the node again."
- `execution/maker_routes_ideogram_runway.py`: "Set the ProRes profile to {values}, then run the node again." -> "Set “Prores profile” to {option labels}, then run the node again." (the labels happen to equal the values: 422, 4444, 422 HQ)
- `execution/maker_routes_byteplus.py`: "…Use fewer references or fewer Images per Generation." -> "…Use fewer references, or lower “Images per Generation”."
- `execution/maker_routes_openai.py`, `execution/maker_routes.py`, `execution/sync_runner.py`: "Set the number of images to a whole number from 1 to {}." -> "Set “Count” / “Images” to a whole number from 1 to {}." (the node's own label; words when the node doesn't show the field, judgment 20)
- `handlers/ideogram.py` (3 lines): "Set {Label} to on or off…", "Pick one of the node's {Label} options…", "Set {Label} to a whole number…" -> the label in quotes.
- `handlers/anthropic_chat.py`: "Claude ran out of Max Tokens before it wrote an answer. Raise Max Tokens or lower Effort." -> "Claude ran out of “Max Tokens” before it wrote an answer. Raise “Max Tokens” or lower “Effort”."
- `handlers/style_reference.py`: "…Or set the node's Description Mode to Manual or Image only, which need no key." -> "…Or set “Description Mode” to Manual or Image only, which need no key."
- `handlers/jev_decide.py`, `handlers/jev_pick_best.py`: "Set the node's Pass Threshold / Minimum Confidence to a number from 0 to 1." -> "Set “Pass Threshold” / “Minimum Confidence” to a number from 0 to 1."
- `services/port_contracts.py`: "…put its ID in the node's Moodboard ID field and remove the wire." -> "…put its ID in “Moodboard ID” and remove the wire."
- `handlers/worldlabs.py` (judgment 19): "Set the node's Seed…" -> "Set “Seed”…"; "Fill in the node's Resume Operation ID or its Existing World ID, not both." -> "Fill in “Resume Operation ID” or “Existing World ID”, not both."; "The node's World Name is too long…" -> "“World Name” is too long…"; "The node's Tags field takes up to 10 tags…" -> "“Tags” takes up to 10 tags…"; "Write the node's Image Azimuths as numbers…" -> "Write “Image Azimuths” as numbers…"; "…Turn on the node's Reconstruct Image Set for up to 8…" -> "…Turn on “Reconstruct Image Set” for up to 8…"; "…The node's {field} field keeps the job…" -> "…“{field}” keeps the job…"; "…clear the node's {field} field first." -> "…clear “{field}” first."; "The node's {field} field doesn't hold a World Labs job…" -> "“{field}” doesn't hold a World Labs job…"
- Rule 9, `execution/maker_routes_google.py` and `handlers/veo.py`: "On Vertex only Veo 3.1 Standard renders 4K. Pick 1080p[, or pick Veo 3.1]." -> "On Vertex AI, only Veo 3.1 Standard renders 4K. Pick 1080p[, or pick Veo 3.1]."; "Vertex takes up to {} reference images…" -> "Vertex AI takes up to {} reference images…"; "On Vertex, reference images are their own mode…" -> "On Vertex AI, reference images are their own mode…"
- Rule 9, `execution/maker_routes_minimax_meshy.py`: "MiniMax renders 512P only from a start image…" -> "MiniMax renders 512p only from a start image…" (now `with_person_line`; the exception text keeps 512P)
