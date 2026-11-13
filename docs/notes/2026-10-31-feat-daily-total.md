# Daily total for everything that isn't the person (feat/daily-total, 2026-10-31)

Justin decided: "Add a default daily total for everything that isn't you, shown and changeable in Settings (you pick the amount; $5 a day is a starting point). Over it, runs wait for your OK like a run over $1 does. Its own PR." GM - Design designed the surfaces and wrote every line; they're used verbatim.

## What it does

- **Setting:** `agentSpend.dailyTotalUsd`. Unset is $5 (`DEFAULT_DAILY_TOTAL_USD`). An explicit null is "No limit". An unreadable value is $5, never no limit, and so is anything over $100,000 (`MAX_DAILY_TOTAL_USD`) or a number too large for a float. Only the person can change it (the settings route is person-only; agents get 403).
- **What counts:** every run that isn't the person's: chat agents, outside agents, connected apps, personal agents, scripts, and a tab not opened from the link. It covers the last 24 hours, rolling.
  - `SpendLedger.spent_daily()` sums the outside keys' events (the same records the outside cap counts).
  - It also sums `daily:chats`, a timed copy of every chat run. A chat key keeps a session total, which doesn't roll, so the copy is what lets chats roll in the same window.
  - A give-back with a time subtracts from the copy at the run's own time. One without a time stays counted (over-counting is the safe side).
  - The copy is pruned with the outside events and is never dropped by the chat-session cap.
  - A ledger file from before the daily total gets its chats' last 24 hours seeded into the copy once, at each chat's `updated` time (`_seed_chats_daily`, marked `chatsDailySeeded` in the file).
  - Each key is summed and held at 0 on its own before the keys are added, so one key's give-backs can't erase another's spend.
- **Order:** the daily total is the first budget for every key (`session_budgets(..., daily_spent=)`). `decide` checks it first.
- **Over the total:**
  - `decide` returns a refusal with `Decision.wait` set (`DailyWait`).
  - Canvas run routes (`/api/graph/run`, `/api/execute`, `/api/execute-node`) pass `propose=True`. There `_require_spend_approval` raises `_WaitForOk`, and `_propose_waiting_run` opens a run-only proposal.
    - The note is the bar line. `proposal.wait` holds the lines, node ids and names.
    - The caller gets `202 {status: "waiting", proposalId, message, dailyTotal, alsoNeeds?, runId?}`.
    - Accept runs it as the person's, with an approval id, uncounted.
    - The same caller, project and nodes asking again get the proposal they already have, even when the requests arrive together: dedupe-then-create is one critical section per (caller, nodes, project) (`_waiting_section`). A run-only `POST /api/canvas/proposals` of the same nodes answers with that proposal too.
    - Only a caller that names itself gets the proposal. A nameless one (a script, curl, a tab not opened from the link) is refused in the total's words with no proposal: "This would pass the $5 daily total. Name yourself with NEBULA_AGENT_NAME or --as to send it as a proposal." It carries the person gate's `code: person_required`, so a tab shows its own not-connected line.
    - A caller whose 3 proposal slots are full gets GM's line, "This would pass the $5 daily total, and you already have 3 open proposals. Wait until the person accepts or rejects one, then propose it again.", and the person's Agent log gets a neutral line. No bar or card.
    - On `/api/execute` and `/api/execute-node`, a request whose nodes aren't the canvas's (by the run approval's fingerprint) is refused, not proposed, because the proposal would run the canvas's nodes and its line would price something else.
    - More nodes than a proposal runs, a node not on the canvas, or another proposal error falls back to the refusal, saying why.
  - Off-canvas runs (`/api/quick`, a moodboard read, a Cinema shot) have no canvas nodes to propose, so they're refused in the total's words.
- **Combined reason:** when the run also needs an OK for another reason, the line names the total first, then that reason (`also`).
  - The reasons are a per-run limit that trips (the per-model cap first, then the general one) or, when a USD limit applies, a node with no list price.
  - The total itself is left out of `usd_limited`, so the total alone never makes an unpriced node ask.
- **Atomic:** `SpendLedger.reserve(key, label, check)` runs the decision and the count under one lock. `_require_spend_approval` and the moodboard reader's hold both go through it. Two runs that each fit alone can't both pass.
- **The person's runs:** `_require_spend_approval` returns before any check for the person, as before. Their runs never reach the ledger, so they never count and never wait.
- **Agents read it:**
  - `GET /api/agent/spend` → `dailyTotal {limitUsd, usedUsd, leftUsd, window: "24h"}`.
  - `start_here` / `nebula context` → `spend.daily {limitUsd, usedUsd, leftUsd}` and a "Daily total" line.
  - `/api/agent/apps` → `daily.spentUsd`.
  - `nebula spend` prints the line, and `get_spend_limits` describes it.
  - `run_nodes` and `nebula run` report the waiting proposal; `nebula run` exits with 4 and prints the numbers. The check-it hint follows the surface: "Check it with nebula proposals." for the CLI and HTTP, `Check it with get_proposal("<id>").` over MCP.
  - The in-app chat prompt says a run answered "waiting" was already sent as a proposal: wait on it with get_proposal, don't propose it again.
- **UI:**
  - Settings › Preferences › Agent spending, first row: Daily total. Choices are $1, $2, $5, $10, $20 and $50 a day, plus Other amount… and No limit, with GM's usage line and a thin meter. The row lives in the lazy PreferencesTab chunk, not the entry.
  - The proposal bar shows `wait.barLine`.
  - Each waiting node gets a band at the top of its own card, above the title, in the proposal's accent: "Waiting for your OK" and "This run would pass the $5 daily total." (`NodeWaitBand`, drawn by every card's wrapper). Several proposals on one node: one band for the shown proposal (else the newest) with a count, "Waiting for your OK · 2". Its role=status points at the bar line through `aria-describedby` while the bar shows that proposal. The node grows by the band's height on the POP spring and shrinks back on SOFT; at once under reduced motion.
  - The Updates card reads "<agent> wants to run “Writer” and “Editor”. <bar line>".
  - A "waiting" start never reads as a started run: its nodes go back to idle and Run history is unchanged (`settleWaitingStart`). Tabs don't get one any more (they are nameless), so this is a guard.
  - Settings: Escape in "Other amount…" goes back to the select without closing Settings (the field claims Escape in the capture phase). After Enter saves, focus returns to the select once it's enabled. The draft reads "7.50", not "7.5". What can't be saved keeps the field open with a line saying why, and never saves No limit.
- Docs: `docs/MCP-SETUP.md` (Spending limits, the spend read, the table row) and `skills/nebula/SKILL.md` (waiting runs, `nebula spend`).

## Decisions not in the brief

- **Auto-proposal only on canvas run routes.** GM's agent line says "Sent as proposal <id>", so a canvas run that passes the total opens the proposal itself; the agent doesn't have to ask. Every other refusal still leaves proposing to the agent, as before. Off-canvas routes can't be proposals, so they refuse.
- **The total doesn't make unpriced nodes ask.** Changing that would alter rows that don't pass the total, which the brief rules out. Unpriced spend can't be counted against the total either way. Question for Justin below.
- **`node_name_list` in the backend** mirrors the frontend `nodeNameList`, so the Updates line names nodes the same way the bar does: up to three quoted, repeats counted, then a count.
- **The waiting tag is a band inside the card** (GM, round 2), not round 1's overlay. It is drawn by `withNodeCardBoundary`, the wrapper every card goes through, as the node's first child, so it lands in every node kind from one place. It takes the card's width without widening it (`width: 0; min-width: 100%`), and the card meets it square while it's up.
- **The focus ring for the Other amount field** sits on the field wrapper (`:has(input:focus-visible)`), like the API key field. focusRingCss's list names it.

## Guard tables (1944d052 → this branch)

**`agent_spend.decide` table:** 720 rows (5 runs × per-run on/off × 3 cap sets × daily unset/null/$2 × 4 used amounts × chat/outside key). 228 rows changed, and every one now waits. An independent check found that a row changed exactly when `used + run > limit` (0 mismatches). Rows at or under the total and rows with "No limit" are unchanged.

| Before | After | Rows |
|---|---|---|
| runs | wait: "…which has $X left." | 28 |
| runs | wait: "…which is used up." | 60 |
| refused: per-run limit | wait: "…and cost more than $1 per run." | 88 |
| refused: no list price | wait: "…and has a node with no list price." | 40 |
| refused: session or outside cap | wait: "…which has $X left." / "…is used up." | 12 |

**HTTP matrix:** 120 rows (6 scenarios × 4 routes × 5 callers). 32 rows changed, all in scenarios B (passes the total) and D (over $1 and the total), and all for callers that aren't the person.

| Scenario, route | Chat agent, outside agent, script, unconnected tab |
|---|---|
| B, graph/run | 200 finished → 202 waiting |
| B, execute / execute-node | 200 started → 202 waiting |
| B, quick | 200 → 403 in the total's words |
| D, graph/run / execute / execute-node | 403 per-run → 202 waiting |
| D, quick | 403 per-run → 403 in the total's words (total first) |

Unchanged: every person row, A (under everything), C (over $1 only), E (unpriced) and F (exactly at the total: $4.60 + $0.40 = $5.00 runs).

## Gates

Run on 2026-10-31 in the worktree, on a machine at load average 30–50. All npm calls used `NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false`.

- **Frontend:**
  - `tsc -b --noEmit` clean. `npm run lint` clean (check:inline-styles with 255 files, check:slava-css-scope, eslint).
  - `vite build` plus `check-build-budget.mjs` passed: entry 444,808 bytes raw (limit 512,000). The Daily total row is only in the `PreferencesTab` chunk.
- **Focused vitest:** 198 files, `--maxWorkers=2`, from an explicit non-empty zsh array, including every ratchet that reads src/ or styles/. Run in five chunks: 3,055 passed and 9 failed. No "Errors" line in any chunk.
  - focusRingCss caught the new field, which cleared its outline without naming its focus rule. Fixed (see Decisions), and it passed on the rerun.
  - Six were timeouts under load: lazyText, r27pin, the ratchet's 120 s corpus, AgentRosterCorner, round21Store, and canvasPinsStore's first test. All passed on a one-worker rerun.
  - Settings.test fails 2–3 tests on the branch, waiting for the lazy Providers tab and the setup-link focus. The same file fails 4 tests on 1944d052 under the same load, so it isn't this change.
- **Backend:** 66 files, isolated (temp HOME and every NEBULA_* path): 2,491 passed in 9 m 45 s.
  - They cover every test that touches agent_spend, the spend ledger or runCostConfirm, every test that reads SKILL.md or MCP-SETUP.md, and the CLI tests.
  - Also test_daily_total, test_canvas_proposals, test_canvas_proposal_updates, test_mcp_tools, test_agent_notes, test_round19_node_names, test_unprivileged_marker and test_ci_shard.
- **New tests on 1944d052:**
  - `tests/dailyTotal.test.tsx` fails to import `lib/dailyTotal`.
  - Both tests in `tests/graphStore.dailyTotalWait.test.ts` fail: the node ends in "error", not "idle".
  - `tests/test_daily_total.py` fails at collection: `node_name_list` and the daily names don't exist.
- **Mutants:** each was applied, the new tests run, and the file restored byte for byte. All 18 were killed.
  - Backend (test_daily_total.py):
    - `>` becomes `>=` in the total check.
    - No daily budget in `_spend_budgets`.
    - Chat runs not copied into `daily:chats`.
    - `reserve` without its lock.
    - `reserve` that checks but never counts.
    - Unset becomes no limit.
    - Unreadable becomes no limit.
    - The total counts toward `usd_limited`.
    - `propose` forced off.
    - No read-time window. The first run survived, because a later write prunes old events anyway. I added a read before any write, and it's killed now.
    - A chat give-back skips the daily copy.
    - No dedupe of a waiting proposal.
    - The person's runs are checked too.
  - Frontend (dailyTotal.test.tsx, graphStore.dailyTotalWait.test.ts):
    - `>=` becomes `>` in the usage line.
    - The waiting start isn't settled (all four call sites).
    - The tag always points at the bar line.
    - Escape saves.
    - The bar doesn't carry the wait line's id.
- **Live check:** backend on 127.0.0.1:8791 with a temp HOME and every NEBULA_* path, and an in-process socket guard (canary 1.1.1.1:443 refused). Vite on 5791 with `VITE_NEBULA_BACKEND_PORT=8791`.
  - Puppeteer blocked 8000–8010, 5173, 8840 and 5840 through CDP `setBlockedURLs`, with a dead proxy for every other host. Canaries 8000, 5173 and example.com were all blocked, and 0 requests were blocked during the shots.
  - The key was fake, the $0.20 gpt-image-1 price was a fixture, and the spend was fixture spend. Nothing ran a provider.
  - Shots: 10 of Settings (nothing, $3.40, $5.20, No limit and Other amount…, each at 1440 and 700) and 5 of the canvas (full frame with the arrival card, full frame, bar, cards, Updates card). No two share an md5 (`uniq -d` is empty), and I opened every one.

## Round 2 (GM's review, review 1's findings, GM's answers)

Items and their tests are listed in the commit message. What a reader needs to trust them:

- **Gates**, 2026-11-05, from this worktree (branch still behind main; main is not merged yet):
  - `tsc -b --noEmit` clean. `npm run lint` clean (check:inline-styles, 256 files; check:slava-css-scope; eslint). `check:ratchets` doesn't exist on this branch; the ratchet tests ran inside vitest.
  - `vite build` plus `check-build-budget.mjs`: 447,408 bytes raw (limit 512,000).
  - vitest, explicit list of 413 files (every changed test, every importer of a changed module, every test that reads source from disk), `--maxWorkers=2`: 5,645 passed, 3 failed, no "Errors" line.
    - The 3 were `errorCopy.round3e.cards`. The node card now imports the proposals store for its band, and that store subscribes to the socket when it loads, so the test's "last subscriber" was no longer the graph store's. The test now sends the event to every subscriber (it passed on 696c3c85 and passes again). Then tsc, lint and the 160 tests of the six affected files passed again.
  - pytest, 158 backend files that touch the changed modules, isolated (temp HOME and every NEBULA_* path), seven chunks of 25: 5,119 passed.
    - One chunk showed 66 failures in `test_moodboard_cli`, `test_moodboard_edits` and `test_moodboard_private_note`. They come from `test_krea_gateway.py` running before them in the same process, and they are identical on 696c3c85 (51 failures with just those two files). Run apart, `test_krea_gateway` passes (86) and the rest of the chunk passes (870). Not caused by this change; worth its own fix.
- **Mutants**, each applied, the tests run, the file restored byte for byte (the tree diff was identical before and after):
  - Backend: 31 of 32 killed. The survivor is equivalent: seeding events from outside the window, which the window sum and the save drop anyway.
  - Frontend, earlier set: 25 of 25 killed.
  - The band, against the restructured NodeWaitBand (`NodeWaitBand.tsx`, `lib/nodeWaitBand.ts`): 15 mutants. 14 killed at once. The survivor was "a band that arrives after the node doesn't open at once under reduced motion". New test: `opens at once under reduced motion when the band arrives after the node, and closes at once`; the mutant is killed.
- **Live check** (backend through `harness/serve_isolated.py` on 8791, Vite on 5791 with `VITE_NEBULA_BACKEND_PORT=8791`, canaries first, fake keys, fixture spend seeded in the ledger file at start):
  - Backend blocked log: canary lines only, for every phase. Browser: 8000-8010, 5173, 8840 and 5840 blocked through CDP, canaries blocked, 0 requests blocked during the shots. No run was accepted.
  - Settings, at 1440 and 1000: nothing, $3.40 of $5, $5.20 of $5 (new runs wait), No limit, Other amount… open, and "Same as chats · $5". Help, usage line and the 2 px meter 8 px under it; the outside select fits, not cut off.
  - The agent runs, each a 202 with the cursor saying "Waiting for your OK": a run that passes the total ("has $0.02 left"), one with a node that has no list price ("and “Sketch” has no list price"), one over a model's per-run limit ("…and cost more than the $0.01 per-run limit for “FLUX.2”"), one over the outside limit ("…and the $1 limit for agents outside Nebula chats"). A nameless caller got `403 person_required` and no proposal. The bar, the band and the Updates card for each line.
  - The band: one node; two proposals on one node ("Waiting for your OK · 2"); a neighbour 12.8 px below. Shots wait for the height to stop moving.
- **Correction to round 1.** Round 1 said the live check ran nothing against a provider. Its backend guard patched Python's socket module, but uvicorn used uvloop, which connects in libuv and never goes through it, so a guard check can't prove that. No round-1 run was accepted, so none executed, but background calls can't be ruled out. In the first round-2 shot attempt, two runs ($4.80 and $0.20) reached api.openai.com with a fake key at both widths and got 401, unbilled. This pass used the shared `serve_isolated.py` (uvloop made unimportable, every outbound connect refused, canaries inside the running loop); its log held canary lines only.
- **Why $100,000.** A typed total above it isn't a limit anyone means, and No limit already says that. Capping it keeps every sum and label finite.
- **Invalid amount line** (draft, for GM): "Type an amount from $0.01 to $100,000, like 7.50."

## Open questions

For GM (items 1-6 of round 1 were answered in the round 2 brief and are built):
1. **The Agent log line omits the agent's name**, because the source column shows it. Right?
2. **The band pushes the card down.** An upper node that grows by the band's height (52 px, 61 with a long line) overlaps a neighbour 12.8 px below it by about 39 px; the neighbour draws on top. I read "layout spring" as POP to open and SOFT to close. Should the neighbour move, or the band sit inside the node's own height?
3. **The 12-total proposal cap** still uses the old fallback line, and `propose_hint` still names both surfaces (MCP and CLI).

For Justin:
1. **Unpriced nodes.** Should the total alone make a node with no list price ask? Today it doesn't (no other USD limit set means unpriced nodes run). Turning that on would change rows that don't pass the total, so I left it off.

## Round 3 (2026-11-05)

### Merge of origin/main (GM item 6)

`git merge origin/main` (about 325 commits) gave 7 conflicted files. Each kept main's behaviour and this PR's additions. The merge commit also carries this round's edits to those 7 files and the deletion of the three band files (I could not split them out of the conflicted files safely), so the merge commit alone does not build; the commit after it does.

| File | Resolution |
|---|---|
| `backend/main.py` | Kept `proposal.wait = wait` and main's `proposal.wires`/`removed_edges`. `_show_agent(...)` takes main's signature (`proposal_id=`) with this PR's wait say. `_open_canvas_proposal` gets `headers = current_request_headers()` (main's `presence_session(headers)` needs it). |
| `backend/services/canvas_proposals.py` | Kept the `wait` field with main's `wires`, `removed_edges` and `presence_session`. `update_text` has the wait branch plus main's `change_count(spec, removed=...)`. |
| `frontend/src/components/canvas/ProposalBar.tsx` | Took main's redesigned bar and re-applied this PR's wait line. |
| `frontend/src/components/panels/AgentLog.tsx` | Took main's `<AgentLogEntryRow>`; the muted class moved into `AgentLogEntryRow.tsx`. |
| `frontend/src/components/panels/settings/AgentSpendSection.tsx` | Kept `DailyTotalRow`, main's `lock(...)` on the select (#204) and this PR's `settings__select--fits`. |
| `frontend/src/lib/canvasProposals.ts` | Kept main's `decisionLine` and this PR's wait helpers. `PROPOSAL_GATE_COPY` is gone upstream, so it is not re-added. |
| `frontend/src/lib/wsClient.ts` | The proposal view has both `wait` and main's `plan`. |

Merge-time test fixes: `dailyTotal.test.tsx` (button is "Accept and run"; the lock is `aria-disabled` plus a description), backend `broadcast_raw` stand-ins take `others=None` (main's conftest now requires it), `clearsOnPromote.ratchet.test.ts` lists `_propose_waiting_run: ['graph.run-start', 'graph.refusal']`.

### Decisions

- **GM 1.** The waiting state is in the card header (`NodeWaitSwap.tsx`, `lib/nodeWait.ts`, `lib/nodeWaitHeader.ts`, `styles/node-wait.css`). The model chip and the label sit in one grid cell and crossfade on the SOFT opacity spring, so the node never changes size; the title truncates before the label does. The band component, its helper and its CSS are deleted. Only ModelNode and DynamicNode have a header state; other card types (cinema, etc.) have none.
- **Q165.** With the total on, `usd_limited` includes it, so a node with no list price waits even with the per-run limit off and room left. Nodes priced by an input's size that can't be measured yet (`awaitingInput`) keep their own refusal: a proposal for them could never be priced. With the total off nothing changes. The person's own runs are never limited (`_require_spend_approval` returns early for them).
- **Unpriced-only wording.** GM 4 gives the bar, Updates and agent lines. The nameless-caller, slots-full and refusal variants for an unpriced-only wait are my adaptation of GM's wording (no "would pass the total" when it wouldn't).
- **Agent line.** Keeps the standard trailer ("Sent as proposal ... Check it with ...").
- **GM 8.** The cursor's default say for a held run is dropped while the header shows the state (`sayFor(cursor, lookup, headerWaits)`); an agent's own say still shows; the dashed halo and mark stay.
- **MCP and CLI in step.** `propose_hint` is CLI-only; `propose_hint_for_mcp` and `_worded_for_this_surface` rewrite it to "Propose it instead with propose_change." for MCP. Docstrings, `docs/MCP-SETUP.md`, `skills/nebula/SKILL.md` and `nebula spend --help` say the Q165 rule.
- **`cardLine` removed** from the proposal API (the band was its only reader). New `over` flag on the wait.
- **Agent log rows** have `aria-label="{agent}: {message}"` so a line that omits the name still reads whole (all rows, not only these).
- **Left as is.** "published price" in PreferencesTab.tsx (outside #212, GM 10).
- **Fixtures.** Tests that relied on unpriced nodes running under default settings now set `dailyTotalUsd: None`.

### Mutants (each applied, tests run, file restored byte for byte, hashes compared)

- Backend Q165 and wording, 15 of 15 killed. The first run left one alive (a node awaiting its input counted as unlisted); `test_a_size_priced_node_still_awaiting_its_input_keeps_its_own_refusal_with_the_total_on` kills it.
- Frontend header, GM 8, Settings copy and log row, 15 of 15 killed. The first run left "Settings copy back to 'published price'" alive; `Settings.test.tsx` now asserts the sentence.

### Shots and flags (isolated backend 8791, Vite 5791; canary lines only in the blocked logs; 0 requests blocked during shots)

Shots wait until the springs rest (the bar, cards, cursors, the header and its label hold the same rect and opacity for 6 samples, about 1.2 s). Files are in `scratchpad/daily/shots4/` (1440 and 1000 each); no two are identical (md5 `uniq -d` empty).

- **Size.** One waiting proposal: Writer is 207.5 x 171.2 before and after at 1440 (156.1 x 128.8 at 1000); the header 205.4 x 34.2 both ways. With "· 2" the node grows in width, 207.5 to 217.3 at 1440 and 156.1 to 163.4 at 1000, because the longer label is wider than the chip it replaces and the node is content-sized. Height never changes. Flag for GM: either the count text fits the chip's width, or a second waiting agent is allowed to widen the node by about 10 px.
- **Cursor on the label.** A cursor's rest point is the card's header middle (`nodeHeaderPoint`, shared with the backend), which is where the label sits; the arrow and mark draw over part of "Waiting for your OK" in `header-neighbour`, `header-count2` and `two-cursors`. Not changed here (the point is shared with the backend's target chains). Flag for GM.
- **GM 7.** Two cursors on Writer: pills do not overlap (Claude Code 719,151 to 802.6,171; Codex 719,193 to 767.8,213 at 1440; no overlap at 1000). Main already stacks them; shown in `two-cursors-1440/1000`.
- **Missed by the tests, found by pr_tests.** The daily total select was not under the person lock (#204): `presenceRound10.locks` failed until `DailyTotalRow` took the section's `lock`.
- **Bundle.** `npm run build` budget line: 504,602 bytes raw (limit 512,000), after the merge; main alone was about 444 KB on 2026-10-31.

## Round 4 (2026-11-05)

GM's round 3 rulings. No merge of main: `git merge-tree` against origin/main showed no conflict.

### Built (uncommitted in the worktree)

- **GM 1.** One label "Waiting for your OK" for one or several (`NodeWaitSwap.tsx`); the count is in the header's description (`waitDescription` in `lib/nodeWait.ts`): "2 proposals are waiting for your OK." and, new copy, "A proposal is waiting for your OK." Width 207.52 px unchanged from idle to 1 to 2 at 1440 (170 at 1000).
- **GM 2.** While a node's header waits, every cursor on it is drawn at the header's left end, tip over the icon (`restPoints`/`waitRestPoint` in `lib/agentCursorMotion.ts`, used in `AgentCursorLayer.tsx`); the chain point stays the header middle. A say under a wait header keeps the name's slot. Measured: arrow origin equals the icon centre; no visible cursor piece overlaps the label at 1440 and 1000 (one cursor, two cursors, long-title node), except a transient glide of an idle second cursor right after load.
- **GM 3.** "cost more than $X per run" (backend `agent_spend.py` and the two exact-string tests).
- **GM 6.** Cinema scene title row takes the wait (`CinemaSceneNode.tsx`, `cinema-node.css`, `node-wait.css`); model, dynamic and Video QC already had it; other kinds are utilities that never bill. `tests/nodeWaitCards.test.tsx` classifies every `CANVAS_CARDS` kind. Flag: at 200 px the scene title is cut to the glyph.
- **Contrast.** One ink `--sr-wait-ink` (white) on the accent at 16% over opaque `#18181a`; worst accent (white) 10.85:1, Claude 13.83, Codex 13.81, lime 11.66; pixels in shots 12.0 to 15.2 (8.2 when a selection toolbar's shadow overlaps at 1440). `tests/nodeWaitContrast.test.ts` reads the CSS tokens.
- **Dimmed canvas.** Not an app state: Puppeteer `clip` screenshots resize the viewport and restart every CSS transition (animations 9 to 20, label opacity 0.09 mid-capture), so frames were caught mid-fade. Full-viewport captures are stable. Not Show's preview.
- **Mutants:** 14 of 14 frontend killed plus the backend "costs" mutant killed; all files restored byte for byte (hashes compared).
- **Tests added:** `tests/nodeWaitContrast.test.ts`, `tests/nodeWaitCards.test.tsx`, `tests/agentCursorWaitRest.test.ts`; edits to `tests/nodeWaitHeader.test.tsx` and `tests/agentCursorLayer.test.tsx`.

### Round 4 handoff (paused for restart)

Done and verified: `tsc` rc 0; `npm run lint` rc 0; `check:ratchets` ok (frontend 193 files, 5928 tests; backend 82 files); isolated pytest on `test_daily_total.py` and `test_daily_total_round2.py` 69 passed; `person_gate.py` diff empty; all new tests pass; shots taken at 1440 and 1000 (full captures, viewed).

Left:
1. `pr_tests.sh` re-run (the last run was killed by the restart; the earlier run only failed on the ratchet now fixed by `resetDeletedSceneEditsForTests` in `nodeWaitCards.test.tsx`).
2. `npm run build` plus the budget line (last known 504,602 bytes of 512,000 in round 3; this round adds a little).
3. Commit message: not written to the repo. Use the subject "fix(spend): the daily total, round 4: one waiting label, the cursor beside it, one ink, the Cinema scene", a short body of the bullets above, ending with exactly:
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01KQGNB346VWPzXRTrUUBJHr
4. Shots are in /private/tmp (wiped on reboot); re-take with the harness if GM needs them (phases r4 with spend 4.99 and cinema with spend 0; use full-viewport screenshots, not `clip`).

Flags for GM: below zoom about 0.48 the cursor's mark can reach the label; the header tint is now opaque (covers the top 34 px of an image preview while waiting); Cinema scene title truncates to its glyph at 200 px.

No half-done edit. Servers on 8791/5791 and the gate run were stopped.

## Round 5 (2026-11-13)

GM's round 4 rulings.

- **Ruling 1.** The cursor's mark reaching the label below about 0.48 zoom: accepted, no change.
- **Ruling 2, built.** On a model card whose header sits over media (the card's own `.model-node__preview` is pulled up beneath the title, `--sr-node-preview-overlap`), the header keeps the legibility gradient it has at rest and takes no tint. The tint becomes a pill: a `::before` on `.node-wait-swap__label`, out of flow (`position: absolute`, `inset: -3px -8px`), so it sits where the model chip sits, adds no width and the node does not change size. It is the same opaque mix as the row (accent at `--sr-wait-tint` over `--sr-wait-base`), so the ink and the ratio are unchanged. Header rows on the card surface keep the full-row tint: no preview yet, a preview behind a column of input ports, text, image (its title sits above the picture), world, structured and Jev surfaces, spatial and structured previews, and the Cinema title row. The selector (`node-wait.css`) mirrors the pull-up rules in `slava-restraint.css`; nested `:has()` is invalid, so the world-with-spatial case is covered by the world-surface exclusion instead. Tests: `tests/nodeWaitOverMedia.test.ts` (reads the rule's own selector and matches it against each card structure; the pill's mix, the transparent row, the order), `tests/nodeWaitContrast.test.ts` (new case for the pill; the one-ink test no longer counts `background-color` as ink and skips the rules that only place the pill). Mutants: 5 of 5 killed (drop the image-surface exclusion, drop the input-ports exclusion, keep the row tint, pill in flow, pill transparent); file restored byte for byte (md5 compared).
- **Contrast, re-measured.** From the tokens: white accent 10.85:1 (the worst), amber 12.48, lime 11.66, blue 13.81. From the shot pixels: ink (255,255,255) on (52,59,39) for the lime accent, 11.66:1 on the row, the Cinema title and the pill alike; 13.83:1 on the blue accent.
- **Ruling 3.** Cinema scene at its 200 px width: no change. The title shows 6 of its 14 characters ("⛭ Cine" and the ellipsis: the glyph, a space and 4 letters of "Cinema Scene"). The name span is 55.6 px wide of the 99 px it needs; the label takes 108.4 px.
- **Shots** (`.planning/private/gm-shots/212/`, isolated backend 8631, Vite 5631, Chrome for Testing 138, full-viewport captures after the rects held for 6 samples; 0 requests blocked in the browser; canary lines only in the backend's blocked log): the stores were seeded from the page (graph, proposals, presence); the clip is a generated WebM answered from the request interceptor. Cursor shots use one agent per cursor (a presence store keeps one cursor per agent id).
- **Flag.** A header over media exists only for cards with no input ports and a media result, such as an imported video; a paid model card with input ports draws its result below the ports, so its header is on the card surface and keeps the row tint.

## Merge of origin/main 723dbf79 (2026-11-13: #199 catalog backup, #203 Idol)

- `agent_spend.py`: main's `MAY_BILL_WHO`, `may_bill_nodes` and `propose_hint(run_ids, where="mcp")` (worded per surface through `agent_words`) kept; the branch's `propose_hint_for_mcp` kept beside it, with `_PROPOSE_MCP`. The branch's one-argument CLI-only `propose_hint` can't stand: main's callers pass the surface. The MCP wording is now main's ("Propose it instead: propose_change (run: n1).") where GM's r2 item 3 had "Propose it instead with propose_change."; flagged for GM.
- `main.py`: both typing imports; `proposal.created` keeps main's `mayCostRuns`/`planRuns` and the branch's `waiting`.
- `mcp_server.py` `run_nodes` docstring and `MCP-SETUP.md` spend paragraph: both sides' sentences.
- `ModelNode.tsx`: main's backend-id chip (#199) and provider-chip `label` inside the branch's `NodeWaitSwap`.
- `canvasProposals.ts`: `WAITING_FOR_OK` kept; `decisionLine` moved to `canvasProposalsBar.ts` by main.
- Tests: `test_idol_round20_review19.py`'s "no spending limits" settings also turn the daily total off (`dailyTotalUsd: None`), since the default $5 total now holds the unpriced scene; `test_daily_total_review1.py` asks `propose_hint(..., "cli")`.
