# 2026-10-25 — Agent presence: the mark on a node, placeholders and done cards

Branch `feat/agent-presence`, from main at 5a80a15c (#193 merged). Q125 item 3 (Justin, 2026-10-24, merge-oks Q125: "The agent's mark stays on its node with a status line ("Running FLUX.2 [pro] · 0:41") ... A finished run posts a card with a thumbnail and Show on canvas, without the agent having to remember to."), built to GM - Design's rulings of 2026-10-25, verbatim.

## What changed and why

- **The mark on a node (frontend `components/canvas/AgentNodeMarkLayer.tsx`, `agentNodeMarks.ts`, `agentNodeMarks.css`).** A pill 6 px above the node's card, left-aligned: the agent's dot (a ring when it named itself), its name, then its status. It shows while the agent has a status on that node (`set_status` with a node) or while a run it started is on that node ("Running FLUX.2 [pro] · 0:41", m:ss, ticking once a second only while a run is shown). The pill is truncated at the node's width, with the full text as its tooltip. With two or more agents on a node, the most recent one's pill comes first, then a "+N" chip that lists the others on hover or focus. Below 60% zoom it collapses to the dot alone, kept at 22 px on screen; the words show on hover or keyboard focus, and the "+N" chip stays so every agent can still be found. It is drawn in a `ViewportPortal`, deferred (`DEFERRED_MODULES`), and runs on the spring tokens (reduced motion keeps only the fade).
- **Run marks (backend `services/run_done_cards.py` `AgentRunBook`).** Covers each run an identified agent starts on any route: `/api/graph/run` (MCP `run_nodes`, `nebula run`), `/api/execute` and `/api/execute-node`. It records who started the run, in which project, the planned nodes in run order, and which of them are running now. Each change is an `agentRun` socket event (started or ended). The roster read (`GET /api/canvas/agents`) carries each agent's `running` and `pending`, so a tab that loads mid-run still gets the marks. Runs the person starts get no mark and no card.
- **Placeholders (backend `services/pending_nodes.py`).**
  - `edit_canvas` / `POST /api/graph/apply` with `pending: true` marks the call's new nodes as pending, owned by the caller. `pending: false` with `nodeIds` clears the caller's own.
  - Another agent gets a 403 and can't clear or claim one. No agent can mark an existing node (422 "new nodes").
  - The flag is a node key (`pending: {agent, at}`). It is saved with the project and the handoff, exported as `data.pending`, and carried through undo and redo (a person's restore sets the cleaned flag or drops it).
  - A placeholder turns normal when:
    - its owner runs it;
    - its owner sets pending false;
    - its owner has been idle for 10 minutes (the status book's `last_seen`; one `call_later` timer, no polling);
    - the person edits it (params, label, wiring, a real move);
    - the person runs it directly.
  - Nothing is ever deleted.
  - Every run path (`/api/execute`, `/api/execute-node`, `/api/graph/run`) skips placeholders and their downstream nodes before the pre-call check and the spend check, so nothing is spent on them. Each skipped node gets a `skipped` event with a reason, and the reply carries `skipped` and `pendingSkipped`.
- **Placeholder look.** A dashed outline in the owner's colour around the card, and the line "Codex is setting this up." in the preview area, which is dimmed while the header stays put (`PlaceholderLine`, on every card since round 3). After Run, the canvas shows GM's skip line: "Skipped 1 node Codex is still setting up.", "Skipped 3 nodes Codex is still setting up." or "Skipped 3 nodes agents are still setting up."
- **Done cards.**
  - When an agent's run ends (not when it is cancelled, and not when nothing ran), Nebula posts one Update per run as the agent (`source: "nebula"`, `about: "run"`).
  - The copy is GM's, word for word:
    - Success: "Codex finished “Hero shots”." or "Codex finished 3 nodes."
    - Partial: "Codex finished 2 of 3 nodes. “Upscale” failed." or "… 3 failed."
    - Failure: "Codex's run of “Hero shots” failed."
  - Each card has one button, Show on canvas, and the agent's colour on its left edge. A failure card gets the error icon and no red edge.
  - Thumbnail: 96 px tall, natural aspect, capped at the card's width. It shows the last node's first output, or for a partial run the last output that succeeded. Only images and videos Nebula keeps in its output folder get one; a video shows its first frame with its length in mono. Text, audio and failures get no thumbnail.
  - Flood guard: a new card for the same node from the same agent replaces the old one.
  - A run that ends partial or failed also gets an Agent log line.
- **Agent support (Justin: "Every feature we add needs to make sure we include MCP support for agents").**
  - MCP `edit_canvas(pending, node_ids)`, plus the INSTRUCTIONS step-2 line. INSTRUCTIONS is 2271 characters; the full instructions are 2995 of the 3000 budget.
  - Docstrings for `list_agents` (running, pending), `list_notes` (done cards) and `run_nodes` (placeholders in `skipped`).
  - CLI `nebula apply --pending` and `--ready nX`, and steps files. `nebula agents` prints "Running {model} ({nodeId}) · m:ss" and "N placeholder(s) (runs skip them)".
  - Docs: `docs/MCP-SETUP.md` ("Placeholders, the run mark and done cards") and `skills/nebula/SKILL.md` ("Placeholders while you set nodes up", plus a paragraph on the run mark and done cards).

## Decisions not in the spec

- The pill anchors on the drawn card (`nodeMarkBox`), not the React Flow node box. The node box starts about 38 px above the card, which leaves room for the floating settings bar. The first live run showed a 40 px gap instead of 6 px. While the settings bar is up (multi-select), the pill sits above the bar.
- (Superseded in round 3: the pill is now a fixed screen size at every zoom.) The pill lived in flow units, so it scaled with the canvas down to 60%.
- One mark per agent per node: a run beats a status line (it says more and it ticks).
- A run's model name is the label of the node's enum model option, else the universal model id, else the node's display name. Utility nodes read the node name, quoted since round 3: "Running “Video Edit” · 0:04".
- A failed run's card uses ⚠ by the message (`aria-hidden` since round 3); the partial card has no icon (GM named the icon for failure only).
- A whole-canvas Run by the person skips every agent's placeholder. A direct run of a node (execute-node on it) runs it and everything that feeds it, so every placeholder in that run turns normal and runs ("the person runs it directly"; see Review).
- `/api/graph/run` pre-seeds `outcome["skipped"]` with the pending reasons, so `nebula run` and `run_nodes` list them like a gate's skips.

## Tradeoffs

- Run marks and the run book are memory-only, like statuses and cursors: a restart ends every run anyway.
- `nodeCardBox`/`nodeMarkBox` read the DOM inside a React Flow store selector, so they re-measure on store changes, not on every layout change inside a card. The outline did follow the card when the Skipped badge grew it (live).

## Surprises

- The fake engines in the first tests ran nodes downstream of a failure. The real engine never starts them, so the failure card read as partial until both fixtures skipped downstream nodes.
- Socket `skipped` events are camelCase (`nodeId`).
- With TestClient, each request runs on its own event loop, so a later request can't await a run task. The tests read `_cli_runs[...]["task"].result()` instead.
- svg-rasterize accepts the SVG type only, not Text. The live check used combine-text for the placeholder.
- This canvas pans on scroll (`panOnScroll`); zooming in the live check needed ctrl+wheel.

## Tests

- Tests first. Backend `test_pending_nodes.py`, `test_run_done_cards.py` and `test_agent_presence_agents.py` failed at collection (ImportError) before the modules existed. After that, the route tests failed on the missing `main.AgentRunBook`.
- Frontend `pendingNodes`, `agentNodeMarks`, `AgentNodeMarkLayer` and `PlaceholderLine` failed to resolve their modules. `agentRunCards` had 5 failures and `graphStore.pendingNodes` had 3; only its "says nothing" case passed before the code existed.
- `nodeMarkBox.test.ts` (3 tests) was written after the live check found the 40 px gap. All 3 failed before `nodeMarkBox` existed.
- Gates: see the end of this file.

## Live check

- Isolated backend on 8795 and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`). `/api/health` through Vite matched the backend directly. The backend ran with a temp HOME and every NEBULA_* root under scratch; the person token came over stdin.
- Two agents:
  - Codex, verified with an app token made through the person's `POST /api/agent/spend/apps`;
  - "Claude Code", self-named.
- Free local nodes only: text, image and video inputs, combine-text and image-compare. The media was made with ffmpeg inside the isolated output folder. No provider call.
- 24 of 24 checks passed:
  - The pill is 6 px above the card (5.1 px at 85% zoom), left-aligned, with no chip.
  - With two agents, Claude Code (ring) comes first with "+1". Focusing "+1" lists Codex.
  - At 49% zoom the pill is a 22 px dot with no words or chip, and still 22 px at 28%.
  - The placeholder has a dashed outline in Codex blue and "Codex is setting this up."
  - Claude Code got a 403 trying to clear Codex's placeholder.
  - The toolbar Run showed "Skipped 1 node Codex is still setting up." and left the placeholder pending.
  - Codex running its placeholder made it normal.
  - Run pills appeared ("Running Video Input · 0:00", and others).
  - Cards:
    - "Codex finished “Hero still”." with a 96 px image;
    - "Codex finished “Teaser clip”." with a first frame and "1:23";
    - "Codex finished 1 of 3 nodes. “Old still” failed." with the image that succeeded;
    - "Codex's run of “Old still” failed." with ⚠ and Codex's edge, not red;
    - "Claude Code finished “Hero prompt”."
  - The flood guard left one card per node.
  - The Agent log has the failed and partial lines.
  - Show on canvas from the partial card selected "Compare stills".
- Screenshots at 1440x900 and 1280x800 are in the scratchpad (`agent-presence/01..10`).
- Blocking: CDP `Network.setBlockedURLs` for 8000-8010 and 5173, plus a dead proxy.
  - 3 blocked in all: 2 were the canaries (8794 through the dead proxy, 8000 blocked).
  - The third was the browser's ORB block of the missing `gone.png` preview on 8795.
  - 0 requests went toward Justin's ports. The only console error was the canary's.
- Servers stopped by PID and the state dir deleted.

## Review

- Review fixes (2026-10-25, each test first, failing before the fix):
  - A project switch brought back a placeholder cleared since the last save: `_overlaid_snapshot` merged the old snapshot's `data.pending` under the live node. Now the live graph decides the flag for every node it holds. Test: `test_a_project_switch_never_brings_back_a_placeholder_made_ready_since_the_last_save` (failed: the stored snapshot still had the flag).
  - An agent's run refused before it started (pre-call check, cycle, spend check) had already turned its placeholders normal. `_skip_placeholders` now only works out which placeholders the run makes ready (`run_skips(..., ready=)` counts them as normal for the skip); `_make_ready` clears them after the last gate on `/api/execute`, `/api/execute-node` and `/api/graph/run`. Tests: `test_the_owning_agents_refused_run_leaves_its_placeholders_pending` (3 routes x pre-call/spend, 6 failed) and `test_the_persons_refused_direct_run_leaves_it_pending` (2 failed).
  - The person picking a placeholder's model (`POST /api/graph/node/{id}/model`) didn't turn it normal. It now calls `_person_touched`, even for the same model. Test: `test_the_persons_model_pick_turns_it_normal` (failed: still pending).
  - The person's direct Run of a node fed by placeholders cleared only the target and then skipped all three. GM: "it turns normal and runs". Now every placeholder in that run's scope (the node and its ancestors) turns normal and runs. Tests: `test_the_person_running_a_node_downstream_of_placeholders_runs_them_all` and `..._leaves_placeholders_outside_its_scope` (both failed). This was a choice between two readings, so it is listed for GM below.
  - The person's undo of an unrelated step put back a placeholder the agent had since made ready (the step's whole-canvas snapshot held the flag). A graphSync that clears flags and isn't this tab's own echo now strips them from every undo and redo step (`forgetClearedPlaceholders` in `lib/canvasUndo.ts`, in place like `foldArrange`). Undoing the person's own edit of a placeholder still brings it back. Test: `graphStore.pendingNodes` "stays normal when the person undoes or redoes an unrelated step" (failed); the own-edit case passed before and after.
  - Run selected and an accepted proposal's run (`executeCluster`) didn't show the skip line. Test failed, then `announcePendingSkips(result)` added.
  - Below 60% zoom the "+N" chip was `display: none` and the dot couldn't take focus. The chip stays, the dot is `tabIndex=0` when collapsed and shows its words on `:focus-visible` with a focus ring, and the others' list (from the chip) keeps its words and sits above the scaled row. Tests: `AgentNodeMarkLayer` (tabIndex, chip) and the new `agentNodeMarksCss.test.ts` (4 rules; all failed first). The live check found the last one: the list showed dots only, because the low-zoom rule hid every name.
  - Live check again on 8795/5795, 12 of 12: low-zoom dot + "+1" chip, keyboard focus on the dot, the others' list at low zoom, Run selected's skip line, the person's direct Run of a two-placeholder chain (both normal, it ran, no skip line), Codex's refused run (still a placeholder), and Cmd+Z of the person's unrelated edit after Codex's `pending: false` (stays normal). Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. Screenshots `agent-presence/11..18`. The model picker wasn't checked live (it needs provider model data); the switch fix is covered by its test. In the headless browser a node drag made no undo step, so the undo check used a typed edit.

## Round 3: GM - Design's rulings of 2026-10-25 (built verbatim)

- **Accessible names** (GM: sentences, no semicolons, the panel's "{agent}, {status}" form; `agentNodeMarks.ts` `markLabel`, `othersLabel`):
  - Pill: "Codex, Writing the hero prompt"; an agent that named itself: "Codex, unverified, Writing the hero prompt".
  - "+N" chip: "2 more agents. Codex, Writing the hero prompt. Claude Code, Checking the crop." ("1 more agent." for one). A status that already ends in a full stop gets no second one.
  - The done card's failure icon is `aria-hidden` (the message says "failed").
  - The Skipped badge on a skipped placeholder: "Skipped: Codex is still setting this up." The backend's skip reason is now "Codex is still setting this up." (`pending_nodes.pending_reason`; agents read the same words in `skipped`), and the canvas puts "Skipped: " before it.
- **Failure icon:** the node's own error block has no icon (text with a red edge or rail). The only glyph a node shows for a failure is ⚠ (a failed Cinema shot, `CinemaSceneNode`, and the shots rail), so the card keeps ⚠.
- **The pill is a fixed screen size at every zoom** (GM: "like the cursor labels: always 22 px tall"). The layer sets `--anm-scale` to 1/zoom and `--anm-max` to the node's on-screen width; the row and the others' list use the CSS `scale` property (not `transform`, which the entrance keyframes replace while they run), and the 6 px gap is on screen too. Below 60% it is the 22 px dot, as before.
- **Below 60% only:** `isLowZoom` reads the zoom at the whole percent the toolbar shows (`Math.round(zoom * 100) < 60`), so React Flow's 0.5999… counts as 60% and shows the full pill.
- **Run pill:** a node name is quoted, "Running “Video Edit” · 0:04" (`_run_model_name` quotes the type-name fallback; `model` carries the quotes, so `nebula agents` prints them too); a provider model name stays unquoted. The pill shows only once the node has run 1 s (`RUN_MARK_DELAY_MS`), so an instant local run never flashes one.
- **The cost before a run matches what runs** (GM: "Find every place the person sees a cost before a run"). `runScope.summarizeRunScope` mirrors the backend's `_skip_placeholders` with `pendingNodes.runSkips` (a port of `pending_nodes.run_skips`):
  - the whole-canvas Run (toolbar chip, its description, the confirm), Run selected (the selection toolbar with several nodes, the confirm) and an accepted proposal's run (`executeNode`/`executeCluster` with `approvalId`, the confirm) leave out each placeholder and everything downstream of it, and report `pendingSkipped`;
  - the person's direct run of a node (the selection toolbar with one node, the node's context menu, the Inspector, the Cinema Studio run) counts them and says so: "Includes 2 nodes Codex is still setting up." (or "… agents are still setting up."), the line directly under "This run could cost up to $0.43 at list prices." in the confirm, and the last sentence of the Run button's description. The count includes the nodes downstream that the run also makes run, like the skip line.
  - The proposal bar's own estimate comes from the backend: `_proposal_run_scope` now leaves the run's skipped placeholders (and what needs them) out of `chosen` and `scope`, so the proposal's `cost` (and its "Accept & run (N paid)") prices only what runs, and adds `pendingSkipped`. It is worked out when the proposal is made; the confirm after Accept reads the canvas as it is then.
- **The placeholder rule wins over Skipped** (`gating.css`): a skipped placeholder dims only its preview (0.4); the header, the line, the Skipped badge and the ports stay at 1 with no desaturation, and the card keeps a solid edge (its own dashed outline says pending).
- **The skip line names the agent** when every skipped node is one agent's (downstream nodes count toward the agent whose placeholder blocked them), "agents" only for several: "Skipped 1 node Codex is still setting up.", "Skipped 3 nodes Codex is still setting up.", "Skipped 3 nodes agents are still setting up." The backend has the same line (`pending_nodes.skip_line`).
- **The placeholder line on every card:** Edit, Remotion, Character, Cinema Scene, Moodboard, Paper Source, Batch, Camera Rig and Reference Set now render `PlaceholderLine` (ModelNode, DynamicNode and Video QC, which is a ModelNode, had it) and set `data-pending` (`lib/pendingNodes` `pendingAttr`). Each dims only its preview: Edit's preview, Character's and Cinema Scene's thumb, Moodboard's preview, Paper Source's preview, Camera Rig's diagram, Reference Set's preview (one rule list in `nodes.css`). Remotion has no preview and Batch's body is the list of items the person typed, so nothing on them dims. A **Reroute** has no body: its line hangs below the dot at a card's width, where its run error already hangs (`.reroute-node__pending`).
  - One shared place was tried first: a wrapper in `canvasTypes.ts` can only add the line after the card, outside its border, and can't reach each card's preview. So each card renders the one shared component, and `tests/placeholderEveryNode.test.tsx` renders every type in `CANVAS_NODE_TYPES`: a new card type without the line fails there.
- **Agent log:** the run's line (`publish_action` in `_execute_cli_run`) counted a gate's skips only. It now ends with GM's skip line: "Ran 1 node(s) cleanly in 0.0s. Skipped 3 nodes Claude Code is still setting up." (with a gate's skips too: "…, 1 skipped by a gate. Skipped …").
- **An agent's own undo restores the flag** as the person's undo does (`services/canvas_undo.py`): a removed placeholder comes back as one (the kept copy has its flag), and an agent's `pending: false` edit now gets an undo token whose undo makes those nodes placeholders again, unless the node is one already or someone else ran it since (left as "ran since"). The restore applies a flag only for the person or for the server's own kept inverse (`trusted`); an agent can still never send one. The reply lists `placeholders`, and the message says "Undone: made pending 1." An undo of the edit that *made* the placeholders removes them (they were that edit's new nodes), as before; there is no flag to put back there.
- Agent support: MCP `undo_canvas_edit` docstring (placeholders), `docs/MCP-SETUP.md` (the reason, the skip line, the cost, the agent's undo, the quoted run name), `skills/nebula/SKILL.md` (`nebula undo` of `--ready`).
- Not touched: the cursor-bubble strings in `backend/main.py` (fix/connected-copy changes them). The live check shows the bubble still says "Running Video Edit" unquoted beside the pill's "Running “Video Edit”".

### Round 3 tests (first, each seen failing)

- Frontend, 37 failures before the code: `agentNodeMarks` (labels missing, `isLowZoom(0.5999)` true, no 1 s delay), `AgentNodeMarkLayer` (aria-labels "Codex: …", `--anm-max` 240px at 150%), `agentNodeMarksCss` (no `scale:` on the row; `transform: scale(...)` rules), `agentRunCards` (no `aria-hidden`), `pendingNodes` (skip line said "agents" for one agent; `pendingIncludedLine`, `runSkips`, `skipSummaryOf` missing), `runScope.placeholders` (5, the summary priced skipped nodes and said nothing), `graphStore.runCostConfirm` (4: the confirm priced $1.80 for a whole Run, asked for an accepted proposal's run, had no line), `placeholderEveryNode` (9 card types without the line; the two CSS rules). The ModelNode, DynamicNode and Video QC cases passed before.
- Backend, 8 failures before the code: `skip_line` missing; the reason was "pending: Codex is still setting this node up"; the Agent log line had no skip count; the proposal's cost listed `['n1', '+c', '+free']`; the agent's undo of its removal brought the node back without the flag; `pending: false` had no undo token (2 tests); `_run_model_name` gave `Text Input` unquoted.

### Round 3 live check

- Isolated backend 8795 (temp HOME and every NEBULA_* root under scratch, no keys; `/opt/homebrew/bin` added to its PATH for ffmpeg) and Vite 5795 (`VITE_NEBULA_BACKEND_PORT=8795`); `/api/health` through Vite matched. Codex verified (an app token made through the person's `POST /api/agent/spend/apps`); "Claude Code" and "Cursor" self-named. Free local nodes only, plus one GPT Image 2 node that was never run: its cost confirm was declined, and the backend had no key for it anyway.
- 23 of 23 checks passed:
  - The pill at 151%: 22 px tall, 6 px gap, the full pill. At 50%: the 22 px dot. At 102%: 22 px, 6 px gap.
  - Read live: the pill "Codex, Writing the hero prompt"; "Cursor, unverified, Reading the brief"; the chip "2 more agents. Claude Code, unverified, Checking the crop. Codex, Writing the hero prompt."
  - Codex's Text Input run (0.04 s) showed no pill (polled every 16 ms). A Video Edit re-encode (28 s, ffmpeg) showed "Running “Video Edit” · 0:02" and on.
  - The selection Run of a GPT Image 2 node fed by Codex's placeholder: chip "$0.0047–0.43", description ending "Includes 2 nodes Codex is still setting up", and the confirm (read from the dialog, declined): "This run could cost up to $0.43 at list prices.\nIncludes 2 nodes Codex is still setting up.\n\n• Hero image: $0.0047–0.43\n\nRun it?". The toolbar's whole-canvas chip showed no cost (the paid node is skipped), and that Run asked no confirm.
  - A Video Edit placeholder: "Codex is setting this up." in its card, preview 0.4, title 1.
  - Codex's own undo of its `pending: false` made the node a placeholder again ("Undone: made pending 1.").
  - The person's whole-canvas Run: "Skipped 6 nodes Codex is still setting up."
  - The skipped image placeholder: preview 0.4; header, file name, line, Skipped badge and ports at 1, no filter; the badge's title "Skipped: Codex is still setting this up."
- Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. The one console error was the canary's. Servers stopped by PID; the state dir deleted.
- Screenshots (1440x900) in the scratchpad `agent-presence/`: `r3-pill-150.png`, `r3-pill-50.png`, `r3-plus-chip.png`, `r3-run-pill.png`, `r3-cost-line.png`, `r3-skip-line.png`, `r3-skipped-placeholder.png`, `r3-edit-placeholder.png`. The confirm is the browser's own dialog, which a screenshot can't show; `r3-cost-line.png` shows the selection's cost chip and the placeholder, and the dialog's text is above.

## Q133: the person confirms running paid placeholders (Justin, 2026-10-25, option b)

Justin kept option A (the person's direct Run of a node runs the placeholders feeding it and turns them normal), and added: Nebula always asks first when any of them calls a paid model, whatever "Ask before costly runs" says, even off. Free placeholders just run, with GM's "Includes …" line under the cost. GM - Design's copy, built verbatim:

- `lib/placeholderRunConfirm.ts` builds the dialog's words from the run's own summary (`summarizeRunScope`, node scope, direct): heading counting every placeholder in the run, paid or free ("Run 2 nodes Codex is still setting up?" / "Run 3 nodes agents are still setting up?", the skip line's naming rule); the line under it ("Codex hasn't finished these, so their settings may not be final." / "Agents haven't …"); one row per paid placeholder, “Hero still” · model · price (the model is the chosen model option's label, as `main._run_model_name`; the price from the run's cost line for that node, now keyed by `nodeId`); "Plus 1 free node." / "Plus 2 free nodes."; the whole run's total in the costly-run confirm's own line ("This run could cost up to $0.43 at list prices."), its notes (`runCostNotes`, split out of `runCostConfirmMessage`), and "Run for $0.43" / "Cancel". "Paid" is `!isLocalRun` (backend `model_pricing.is_local`); an unknown type counts as paid.
- `components/PlaceholderRunDialog.tsx`: the app's own dialog (`role="alertdialog"`, modal, named by its heading, described by its body), on the prompt-dialog styles. Each row has the agent's dot (a ring when it named itself), hidden from screen readers. Focus starts on Cancel so Enter never spends; Escape is Cancel; Tab stays inside. `components/askPlaceholderRun.tsx` mounts it and resolves with the answer. Both are deferred: `lib/placeholderRunDialogModule.ts` loads them when the run asks and `DEFERRED_PRELOADS` fetches them on idle. A dialog that can't load runs nothing.
- `graphStore.executeNode`: the person's direct run (no `approvalId`) builds the dialog first; when there is one it replaces the costly-run confirm (one dialog, never two). Cancel returns before anything changes. After Run it re-reads the canvas: if another run started it stops; if an agent changed which paid placeholders are in the run it asks again over the new set. The run sends `confirmedPlaceholders` (sorted ids). An accepted proposal's run never asks (it skips placeholders).
- Backend: `ExecuteNodeRequest.confirmedPlaceholders`; `main._require_placeholder_confirmation` runs right after `_skip_placeholders` in `/api/execute-node`. For the person's direct run (no agent identity, the person's token) it takes the paid ones among `ready` (`_paid_placeholders`, from the params this run sends) and refuses with 409 `{code: "placeholder_confirm_required", message, placeholders}` unless the request names exactly those, before validation, pricing or `_make_ready`, and forgets the run. Free-only runs and agents' runs are unchanged. Not tied to `run_approvals`: those are one-time approvals the backend mints on Accept for a proposal's exact run, and this confirmation is made on the canvas just before the same request, so the request carrying the ids is the check; a missed dialog, a stale tab (no field) or another client gets the 409.
- Docs: `docs/MCP-SETUP.md` (the placeholder section, a "The person confirms paid ones" bullet) and `skills/nebula/SKILL.md` (agents: leave the model and params as they should be; the person is asked).

### Q133 tests (first, each seen failing)

- Frontend, 7 failures before the code: `tests/lib/placeholderRunConfirm.test.ts` (4: one agent's copy, several agents' copy with "Plus 2 free nodes.", only this run's placeholders, still asks with no price table; the module had no `runCostNotes` to call), `graphStore.runCostConfirm` (3: always asks with the setting off and Cancel changes nothing; one dialog when both apply, no `window.confirm`; the confirmed run sends `['a']`). `tests/PlaceholderRunDialog.test.tsx` failed to import (no component): GM's copy and rows with dot/ring, Cancel/Escape/Run, focus on Cancel, `askPlaceholderRun` resolves and unmounts. The free-placeholder case (no dialog, the "Includes" line) and the proposal case passed before and still pass. `runScope.test.ts`'s two exact cost-line assertions gained `nodeId`.
- Backend, 5 failures before the code: `test_the_persons_direct_run_of_a_paid_placeholder_needs_their_confirmation` (no field, `[]`, the free one only, an extra id, a wrong id: each 409, nothing ran or was priced, both still placeholders). Passing before and after: the confirmed run runs and turns them normal; free placeholders need nothing; an agent's run of its own paid placeholder is unchanged.

### Q133 live check

- Same isolated stack (8795/5795, temp state, no keys). Codex verified (app token through the person's route), Cursor self-named. Two GPT Image 2 placeholders priced with no key; the dialog was opened, read, shot and cancelled each time. Run was never clicked on a paid node.
- 17 of 17 checks passed:
  - One agent, "Ask before costly runs" off: the dialog asked anyway, no native confirm. Read live: alertdialog named "Run 2 nodes Codex is still setting up?"; "Codex hasn't finished these, so their settings may not be final."; row "“Hero still” · GPT Image 2 · $0.0047–0.43" with a filled dot; "Plus 1 free node."; "This run could cost up to $0.43 at list prices."; buttons "Cancel" / "Run for $0.43"; focus on Cancel. Cancel: both still placeholders, no outputs.
  - The backend, sent the person's direct run without the confirmation: 409 `placeholder_confirm_required`, "Nothing ran: this run includes 1 paid node Codex is still setting up, and Nebula asks before running those. Click Run again to see them.", `placeholders: ["n3"]`; nothing changed.
  - Several agents with a free node, the setting on at $0.001 too: one dialog, no native confirm. "Run 3 nodes agents are still setting up?", "Agents haven't finished these, so their settings may not be final.", rows "“Hero still” · GPT Image 2 · $0.0047–0.43" (Codex, filled) and "“Alt still” · GPT Image 2 · $0.0047–0.43" (Cursor, ring), "Plus 1 free node.", "This run could cost up to $0.86 at list prices.", "Run for $0.86". Cancel changed nothing.
- Blocked requests: 2, both canaries; 0 toward 8000-8010 or 5173. Servers stopped, state deleted.
- Screenshots: `r3-q133-one-agent.png`, `r3-q133-several-agents.png` (scratchpad `agent-presence/`).

## Open items

- For GM:
  - A Text Input never runs for 1 s, so its run pill never shows now; the live shot of a quoted node name is Video Edit ("Running “Video Edit” · 0:04").
  - The cursor bubble beside the pill still reads "Running Video Edit" unquoted (fix/connected-copy owns those strings).
  - The costly-run confirm (free placeholders only, or none) is still the browser's dialog: "Includes …" is its second line, under the cost. The Run chip itself ("$0.0047–0.43") has no room for a line; its description (tooltip and screen readers) ends with it.
  - A proposal whose whole run waits on placeholders reads "runs 0 free nodes" in its bar (its cost leaves them out; `cost.pendingSkipped` says why). No copy for that yet.
  - The reason on a node downstream of a placeholder still reads "Skipped: needs n3 (“Hero prompt”), which Codex is still setting up" (GM ruled only the placeholder's own).
  - A node downstream of two agents' placeholders counts toward the one reached first (as the backend's skip order does), so the line can name one agent when two blocked it.
  - The person's direct Run of a node whose inputs are placeholders runs them all (Justin kept it, Q133); paid ones ask first.
  - Q133 copy GM didn't give: the intro for a single placeholder ("Codex hasn't finished this, so its settings may not be final."); a row's price when there's no list price ("no list price") or it's billed to a Krea plan ("Krea plan"); "Run" with no price table loaded; the backend's 409 message ("Nothing ran: this run includes 1 paid node Codex is still setting up, and Nebula asks before running those. Click Run again to see them."), which the node shows as its run error.
- No card is posted for a cancelled run or for an agent's CLI run refused by the pre-call check (nothing ran).
- A proposal's cost is worked out when it is made; a placeholder made or cleared later changes what Accept & run will run, and only the confirm after Accept sees that.
- A roster read can race with `agentRun` events; the next event or read corrects it.

## Gates

After Q133 (the last code change):

- Backend, the whole suite (`iso.sh .venv/bin/python -m pytest -q -p no:cacheprovider`): 10864 passed, 71 skipped (5 min 31 s).
- Frontend `npx vitest run`: 446 of 446 files, 5730 of 5730 tests passed.
- errorCopy ratchet (`tests/errorCopy.*`): 14 files, 173 tests passed.
- `npx tsc -b`: clean.
- `npm run -s lint`: clean (inline style guard, Slava CSS scope guard).
- `npx vite build && node scripts/check-build-budget.mjs`: passed, 389,002 bytes raw and 117,136 gzip.
- Surprise on the way: importing the dialog's loader from `lib/deferredChunks.ts` into the store hung `DeferredHeldIntentFailure.test.tsx` (its `vi.doMock` of deferredChunks imports the store graph inside the mock factory). The loader moved to its own `lib/placeholderRunDialogModule.ts`.

## Round 4: review 3 and GM - Design's round-4 rulings (2026-10-25)

Justin, Q133 b: the person's direct run makes the placeholders it needs normal and runs them, "but if any is a paid model Nebula always asks first", whatever the costly-run setting. Review 3 found paths that skipped that rule, and GM gave the copy that was still open. Each fix below was test-first.

### What changed and why

- **Every route that runs or prices canvas nodes now keeps the Q133 rule (finding 1).** The Cinema shot route (`POST /api/cinema/generate-shot`) skipped every placeholder rule: a paid placeholder feeding a Cinema Scene was priced and run with no dialog and no 409. A shot is the person's direct run of the scene, so the route now does what `/api/execute-node` does:
  - `_skip_placeholders(direct=nodeId)`;
  - `_require_placeholder_confirmation` with `confirmedPlaceholders`/`confirmedCost` on `GenerateShotRequest`;
  - skipped nodes left out of the spend check;
  - `_make_ready` only after the last gate.
  An agent's shot skips other agents' placeholders. When that skips the scene itself, the reply is `{"status": "skipped", skipped, pendingSkipped}` and nothing is priced. On the canvas, `executeShot` asks through the same helper as a node's Run (below).
- **The route table** (every caller of `execute_graph`, plus the routes that price a run). Each row has a test in `tests/test_pending_nodes_round4.py`:

  | Route | Who | Placeholders | Test |
  |---|---|---|---|
  | `POST /api/execute` (toolbar Run, Run selected, replay of a whole run) | person | skipped with what needs them | `route_table_..._for_the_person[execute-skips]` |
  | same | agent | other agents' skipped; its own run | `route_table_another_agent...[execute]` |
  | `POST /api/execute-node` (a node's Run, Inspector, context menu, replay of a node run) | person | asks: 409 `placeholder_confirm_required` without the confirmation | `...[execute-node-asks]`, Q133 tests |
  | same, with `approvalId` (accepted proposal) | person | skipped (even a made-up id) | `route_table_an_approved_proposal_run_with_a_made_up_approval_skips` |
  | `POST /api/cinema/generate-shot` (Generate, shot replay) | person | asks: 409 without the confirmation | `...[cinema-shot-asks]`, `test_the_persons_shot_over_a_paid_placeholder_needs_their_confirmation` |
  | same | agent | other agents' skipped (`status: skipped`); its own run and turn normal | `test_another_agents_shot_skips...`, `test_the_owning_agents_shot_runs_its_own_placeholders` |
  | `POST /api/graph/run` (MCP `run_nodes`, `nebula run`) | person token | skipped (not the canvas's direct Run) | `...[graph-run-skips]` |
  | same | agent | other agents' skipped; its own run | `...another_agent...[graph-run]` |
  | `POST /api/quick` | anyone | n/a: temp nodes only, never a canvas node | (no canvas node to hold a flag) |
  | proposal create (`_proposal_cost`), Accept, the approved run | person/agent | priced without them; Accept and the run refuse once one turned normal (finding 3) | `test_accept_refuses_...`, `test_the_approved_run_refuses_...` |

- **The dialog's re-check compares everything it said (finding 2).** It compared only the placeholder ids before, so these two cases slipped through:
  - Same ids at a new cost (an agent connected another paid node, or changed the placeholder's model) ran at the new cost with no second ask.
  - An agent clearing `pending` meanwhile skipped even the costly-run confirm.

  Now `confirmDirectRun` in `graphStore.ts` asks again when anything the dialog said changed: the rows (model and price), the total, the free line, the button. When no paid placeholder is left, the costly-run setting decides over what runs now. The run sends `confirmedCost` (the total the dialog showed). The backend (`_run_estimate_high`, the same estimator as the proposal's cost) refuses with the same 409 and copy when its own estimate is higher. For a shot, that estimate is one shot times its variations.
- **One helper for every direct run on the canvas.** `confirmDirectRun(read, nodeId, {passes, costly})` serves a node's Run, the Inspector, a Cinema shot and a replay. When no dialog is needed it answers in the same turn, so a second click can't slip in, as before.
- **Replays (finding 7).** A replay of a node run or a shot over a live paid placeholder sent no confirmation, so it got a 409 whose words led back to the same 409. Replays now ask in the same dialog, over what the replay sends: its snapshot's params, with the live canvas's names and flags, since the backend reads the flags live. A whole-canvas replay skips placeholders, as before. Replays still never ask the costly-run question.
- **A proposal's run goes stale once a placeholder turns normal (finding 3).** I chose to put the placeholder's owner into the run fingerprint (`run_approvals.fingerprint`), rather than storing the skip set on the proposal, because it covers every case:
  - proposal to Accept: `_refuse_changed_runs` gives the existing "what it runs changed after it was proposed" 409;
  - Accept to the run starting: `_check_run_approval` gives "changed since you accepted";
  - while an approved run waits: `_refuse_agent_change_to_approved_runs` refuses the owner's `pending: false` (409);
  - the idle sweep turning one normal is caught by both checks.

  A stored skip set would only have covered the first window.
- **INSTRUCTIONS (finding 4).** They were at 3,039 of 3,000 characters after the merge. Cuts:
  - the `pending` clause (edit_canvas's docstring covers it);
  - "the person accepts or rejects it in Nebula" → "the person decides in Nebula";
  - "picks the image a board opens on" → "sets its cover".

  Now 2,957 with the commons guide (43 to spare); INSTRUCTIONS alone are 2,233.
- **An agent's undo vs the person's later edit (finding 5).** `canvas_undo` ready entries now keep the node's params, label, position and connections as the `pending: false` edit left it. The agent's undo leaves a node anyone changed since: it is `skipped` with reason "changed since", like params, names and moves.
- **"Connected" wording (finding 6).** Fixed in `pending_nodes.py`, `main._person_touched` and `docs/MCP-SETUP.md`. The ratchet in `test_connected_copy_sweep.py` now also reads the prose of `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md`. It leaves out fenced code, backtick spans, the `--wire` flags and the one line that names the old word to retire it. It found exactly the one hit.
- **Pill keyboard access (finding 8).** A node's own keyboard focus (`:focus-visible` on the React Flow node or a control in it) sets `data-focused` on its mark. The pill then shows its whole status instead of cutting it at the node's width, and the low-zoom dot shows its words. There is no new tab stop, and a pointer's focus changes nothing. The "+N" chip's accessible name now starts with its visible text ("+2 more agents. …", WCAG 2.5.3).
- **GM round 4, built verbatim:**
  1. One placeholder: "Codex hasn't finished this, so its settings may not be final." The code already said this; its test passed before any change.
  2. Rows: "price not listed" and "on your Krea plan". Any "price not listed" row makes the button just "Run"; Krea-plan rows don't count as missing. The total line is unchanged.
  3. "Run for up to $0.86" when the total is a range, "Run for $0.12" when it is fixed.
  4. The backend refusal: "Nothing ran. This run includes 1 paid node Codex is still setting up, and Nebula asks before running those. Click “Run” again to review it." (plural "…them", "agents are" for several).
  5. The proposal bar: "runs nothing until Codex finishes 2 nodes" / "runs nothing until agents finish 3 nodes" (`proposalSummary`, from `cost.pendingSkipped`).
  6. Downstream reason: `needs “Hero prompt”, which Codex is still setting up.`, the type's name only when there's no label. Proposals now use the same fallback (`_node_label(id, candidate)`).
- **Agent support:** MCP `undo_canvas_edit` docstring ("changed since"); `docs/MCP-SETUP.md` (the routes that enforce the confirmation, `confirmedCost`, the refusal's words, the re-ask, replays and shots, the fingerprint, the proposal line, the downstream reason); `skills/nebula/SKILL.md` (undo after a change, proposals that wait on your placeholders). No CLI change: `nebula run` already skips, and the confirmation is the person's alone.

### Decisions not in the spec

- A Cinema shot now asks the costly-run question too, when no paid placeholder is in it. It never asked before. Justin's setting says "Ask before costly runs", and the store's own comment says every run path checks it. It is priced as the one shot it makes, times its variations. Replays keep not asking it.
- The backend's cost check is skipped when the dialog showed no total (no price table loaded): the person confirmed the rows without one.
- A size-priced node isn't measured for the person's runs, so the backend counts it as unpriced (lower), never higher than the canvas. The check can't refuse a run for a price the canvas couldn't show.

### Tests (first, each seen failing)

- **Backend:** 25 failed first.
  - Cinema: 8. Each shot returned 200 "started" instead of 409, or left the placeholders pending; an agent's shot returned "started", not "skipped".
  - Cost check: 3. A 200 where a 409 belonged, and `_run_estimate_high` missing.
  - Proposals: 3. Accept returned 200, and `pending: false` under an approval returned 200.
  - Undo: 5. Still a placeholder after the person's edit, and the ready entry had no `params`.
  - GM refusal: 2 (the old words).
  - Downstream reason: 3.
  - `test_first_turn_instructions` (3,039).
  - Then the docs ratchet (1 hit).

  Two downstream tests first failed for a fixture reason: the whole chain was pending. I fixed their setup before the code.
- **Frontend:** 22 failed first.
  - `placeholderRunConfirm`: 4 ("no list price", "Krea plan", no `confirmCost`).
  - The store: 10. Shots asked nothing; replays asked nothing; the re-ask, the model-change re-ask and the fall-through each asked once; no `confirmedCost`.
  - `proposalPendingSummary`: 3.
  - The pill: 5 (2 CSS rules, 2 chip labels, node focus).

  Passing before and after: the one-placeholder intro, the setting-off fall-through with no confirmation to send, the replay with no placeholder left, and "keeps its old line when something still runs".

### Live check (1280x800)

- Isolated backend on 8795 (temp HOME and every NEBULA_* root under scratch, no keys) and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`); `/api/health` through Vite matched. Codex verified (an app token made through the person's route); Cursor and Claude Code self-named. No key was set, so nothing paid could run. Run was clicked once, in the re-ask check, and the dialog asked again (then Cancel).
- 23 of 23 checks passed (script `agent-presence/live-r4.mjs`):
  - **One agent:** "“Hero still” · GPT Image 2 · $0.0047–0.43", "Run for up to $0.43", the total line unchanged, Cancel changed nothing.
  - **The re-ask:** Codex set quality low while the dialog was open. Run then opened a second dialog: "$0.0047–0.012", "Run for up to $0.012".
  - **The backend's 409:** GM's exact words, and the same 409 for a `confirmedCost` below Nebula's estimate.
  - **Several agents:** one dialog, "Run for up to $0.44".
  - **Downstream badge:** "Skipped: needs “Hero still”, which Codex is still setting up."
  - **The pill:** cut off at the node's width at rest (186 px). The node's keyboard focus showed the whole status (419 px). Blur and a click changed nothing. The chip read "+1 more agent. Claude Code, unverified, Checking the crop."
  - **The proposal bar:** "Adds 1 node · 1 connection · runs nothing until Codex finishes 2 nodes".
- Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. The one console error was the canary's. Servers stopped by PID; the state dir deleted.
- Screenshots in the scratchpad `agent-presence/`: `r4-q133-one-agent.png`, `r4-q133-several-agents.png`, `r4-q133-reask.png`, `r4-pill.png`, `r4-pill-node-focus.png`, `r4-downstream-reason.png`, `r4-proposal-waits.png`.
- Not checked live: a Cinema shot's dialog (opening the Cinema panel headless wasn't worth the time; the store and route tests cover it).

### Open items (round 4)

- For GM:
  - The chip's accessible name now starts "+2 more agents." (GM's words were "2 more agents."). The "+" is the visible text, for WCAG 2.5.3.
  - The node's keyboard focus widens its pill past the node, up to 480 px: new visible behaviour, no new words.
  - A proposal that runs nothing still has the button "Accept & run" (`acceptLabel`).
  - The shot's costly-run confirm is the browser's dialog, as for the other runs (GM's item 7 moves those later).
- A screen reader reaches the pill by its own label, not from the node's focus. React Flow owns the node's `aria-describedby`.

### Gates (round 4)

- Backend full suite: 10,979 passed, 71 skipped (14 min 31 s).
- Vitest full: 450 files, 5,761 tests. The first run, during the backend suite, had 29 failures in 10 files, all timeouts under load ("Test timed out in 5000ms" and findBy/focus waits). Rerun alone, those 10 files passed: 200 of 200. None of them is a file this round touched.
- errorCopy ratchets: 14 files, 173 tests passed.
- `tsc` clean, lint clean.
- Build budget: 389,238 bytes raw entry, 117,227 gzip (limit 512,000 raw).
- MCP instructions: 2,957 characters with the commons guide (limit 3,000); `INSTRUCTIONS` alone 2,233.

## Round 5: review 4 and GM - Design's round-5 rulings (2026-10-25)

Justin, Q133 b, again the rule this round holds: a paid placeholder never runs without the person's confirmation, and what runs never costs more than the person was shown. Review 4 found three ways the second half could break: a price read from an input's size, a tab and server pricing with different keys, and a confirmation sent without a total. GM ruled the copy that was open. Each fix below was test-first.

### What changed and why

- **H1: a size-priced placeholder is priced at its measured input.** Before, Video Input → Codex's FLUX Video Upscale showed "price not listed" and "Run", sent `confirmedCost: 0`, and the backend counted the node as unpriced, so any cost passed. A 1080p minute at 2x is about $35.
  - Backend: `_require_placeholder_confirmation` is now async. It measures the run's inputs off the event loop (`_measure_confirmed_run`, the same `input_sizes.measure_run` the spending check uses; a project switch meanwhile refuses), then compares with `_run_estimate(..., sizes=...)`. Shots and replays go through the same function, so they measure too.
  - Canvas: the dialog asks for the sizes of the files its price reads (`directRunConfirm` requests `summary.cost.sizeRefs`). The open dialog updates in place when they arrive (see "the dialog watches" below). Seen live: "“Upscale” · SeedVR2 Video Upscale · price not listed" turned into "$9.95" and "Run for $9.95" while it was open.
- **M1: Nebula's refusal carries its own estimate, and the canvas asks again with it.** A tab with no keys loaded priced FLUX.2 [pro] as "price not listed" and confirmed $0; the server priced it $0.03 and refused forever, with "Click “Run” again".
  - The 409 now has `estimate` (`_run_estimate`: `low`, `high`, per-node `nodes`, `unpriced`, `plan`, `plus`, `unavailable`, `awaitingInput`, for this run times its passes) and `agents` (each paid placeholder's owner, for a tab that hasn't heard of the flag yet).
  - The canvas (`sendDirectRun`) catches that 409 on a node's Run, a Cinema shot and a replay. It re-opens GM's dialog priced at Nebula's numbers (`withRunEstimate`, `withRefusalFlags`), with GM's "This run changed since you last reviewed it." when the person had confirmed before, and sends the same run (same run id) again with `estimate.high`. It never shows the refusal's words; those are for a tab too old to ask again. Cancel closes the run as cancelled, nodes back to idle, the placeholder untouched.
  - The canvas also reads the keys again when the dialog opens (`nebula:settings-refresh`, App.tsx reuses the settings-saved handler), so the first dialog is usually right already.
- **M4: `confirmedCost` is required with `confirmedPlaceholders`** whenever Nebula can price the run. Missing, it gets the same 409, which the canvas answers by asking again. When nothing in the run has a list price, there is nothing to hold it to, and the confirmed rows are enough. docs/MCP-SETUP.md now says exactly this.
- **L1: the same arithmetic on both sides.** `_run_estimate` multiplies each node's price by the passes and then rounds the total to 6 places; the canvas sends its total rounded to 6 places (`roundUsd`). The check allows $0.000001. Review 4's probe (a $0.00001256 price, 4 variations) refused before and runs now.
- **M2: "runs nothing until Codex finishes N nodes" counts the placeholders.** `skip_summary` adds `placeholders` (entries whose root is themselves) beside `count` (the skip line still counts what needs them). `proposalSummary` uses `placeholders`, falling back to `count` for an older backend. Live: "runs nothing until Codex finishes 1 node" where it said 2.
- **M3 and GM's re-ask rules.** `PlaceholderRunDialog` takes `changed` (the line above the rows) and holds Run for 500 ms (`RUN_CLICK_GUARD_MS`) when it opens as a re-ask and whenever a row, the free line, the total, a note or the button changes while it is open. Cancel is never held. The buttons re-render in place, so focus stays where it was.
- **The dialog watches** (new, needed for H1 and M1 to be honest). `askPlaceholderRun(model, {changed, watch})`: the store subscribes to the graph, the price table, measured sizes and the keys, recomputes the dialog's words and pushes newer ones. They are drawn at once (`flushSync`), so the guard starts with them and a click can't land on the old ones. The watch stops the moment the dialog is answered. The store keeps the last words it pushed and compares those with the run after the click, so a click confirms only what was on screen. Because of this, a change while the dialog is open now updates it in place; "This run changed…" shows when the run changed after the click (or Nebula refused).
- **GM item 4: one dialog.** Every path checked (node Run, Inspector, context menu, Run selected of one node, Cinema "Generate shot" and "Generate N", Cinema "Generate all", replays): when the placeholder dialog shows, the browser's costly-run confirm doesn't. The one way it still could: an agent makes its placeholders normal while the dialog is open. Now the run goes ahead without a second dialog when the total the person confirmed covers it (`coveredBy`); only a run that now costs more than that falls to the costly-run setting (review 3's case 2). That last case is in Open items.
- **GM item 3: "Accept" for a proposal that runs nothing.** I checked what Accept does there: it starts the proposal's run at once (`canvasProposalsStore.accept` → `runNodes`), and that run skips every node (the placeholders and everything needing them), so nothing runs, and nothing is queued for when the agent finishes. So the button reads "Accept" (`acceptLabel`, `runsNothing`). The skip notice and the nodes' "Skipped: needs …" badges still show what waited.
- **GM item 2: the focused pill wraps past 480 px.** With the node's keyboard focus the pill grows up from its bottom edge (the row is anchored there), 11 px corners, the dot on the first line, status `white-space: normal`. Live: 480 px wide, 40 px tall, bottom edge unmoved, nothing cut.
- **L3 (GM's answer): a shot's refusal ends "Generate again to review it."** Node runs keep "Click “Run” again to review it." (`_placeholder_confirm_refusal(shot=True)`).
- **L2 (GM's answer): a dollar amount only when it covers every paid row.** Only Krea-plan rows, or every row "price not listed": no total line, button "Run". Krea-plan rows plus priced ones: the usual line and "Run for (up to) $X". A "price not listed" row plus priced ones: "The listed prices total up to $0.43." (or "…total $0.43." when fixed), button "Run" (`totalLineFor`, `runLabelFor`).
- **L4:** an agent's undo of `pending: false` calls a node "changed since" only after a real move (8 px, `MOVE_THRESHOLD_PX`, as the layout route counts one), not a 0.5 px nudge (`canvas_undo._moved_far`).
- **L5:** the pill widens on the node's keyboard focus only when a key was pressed since the last pointer press, not on `:focus-visible`, which a text field clicked with the mouse matches too. Tabbing into a field still widens it.
- **L6:** "+2 more agents." approved by GM; no change.
- **Agent support:** docs/MCP-SETUP.md (the dialog's lines, the live update and the 500 ms hold, `confirmedCost` required, measured sizes, the 409's `estimate` and `agents`, the shot's words, `pendingSkipped.placeholders`, "Accept", a move of 8 px for undo). No MCP tool or CLI change: confirming is the person's alone, agents already get `pendingSkipped` in a proposal's cost, and INSTRUCTIONS are untouched (2,233 characters).

### Decisions not in the spec

- The refusal re-ask resends the same run (same id, same snapshot) rather than starting a new one: nothing ran under that id, and the run history keeps one record. While the person decides, that record is "starting" and its nodes show Queued (visible behind the dialog in `r5-q133-reask.png`).
- The canvas sends `confirmedCost` even when the dialog shows no total ($0, or just the listed prices), so Nebula can hold the run to it and ask again with its own numbers.
- A Krea-plan placeholder can't be made by an agent today (agents can't choose plan billing, `_refuse_agent_billing_change`), so the live screenshot of that row flags a person-made Krea node as Codex's in that tab only. The rows' words are covered by unit tests either way.

### Tests (first, each seen failing)

- **Backend** (`tests/test_pending_nodes_round5.py`, 14 tests): 12 failed first, 2 passed (the node run's "Click “Run”" wording and "a real move still leaves the node"). How they failed:
  - H1 (3): 200 "started" where a 409 belonged, then `KeyError: 'detail'`/`'estimate'`.
  - M1 (2): `KeyError: 'estimate'`.
  - M4 (2): 200 instead of 409.
  - L1 (2): `5.2e-05 != 5e-05`, and the probe's `KeyError: 'estimate'`.
  - L3: "Click “Run” again…" instead of "Generate again…".
  - M2: `KeyError: 'placeholders'`.
  - L4: still normal after the undo (`None is not None`).
  - Then existing tests that sent placeholders without a total (2) and the `pendingSkipped` equalities (3) were updated to the new contract; GM_SHOT for the shot refusal (3 parametrized cases).
- **Frontend:** 26 failed first.
  - `lib/placeholderRunConfirm.round5.test.ts` (7): the old "This run could cost up to $0" lines, an unrounded total, `placeholderRefusalOf`/`withRunEstimate` missing.
  - `PlaceholderRunDialog.round5.test.tsx` (4): no changed line, Run taken at once, no watch.
  - `graphStore.placeholderRuns.round5.test.ts` (9): the 409 shown as the node's error with no second ask (node Run, shot, replay, unknown placeholder), no `changed` on a re-ask, no size request, the browser confirm after the dialog, no settings refresh.
  - `lib/proposalPendingSummary.round5.test.ts` (2), `AgentNodeMarkLayer` L5 (1), `agentNodeMarksCss` wrap (2), and the round-4 "price not listed" case's total line (GM's new words).
  - Passing before and after: a first ask has no changed line, Cancel is never held, the same words hold nothing back, Krea plus priced keeps its line, $0 is still sent, any other refusal still shows, tabbing into a field widens the pill, "Accept & run" when something runs.

### Live check (1280x800)

- Isolated backend on 8795 (temp HOME and every NEBULA_* root under scratch, no keys) and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`); `/api/health` through Vite matched. Codex verified (an app token), Claude Code self-named. No key was set, so nothing paid could run. Run was clicked once (the re-ask): Nebula refused it with a 409, and nothing ran.
- 21 of 21 checks passed (script `agent-presence/live-r5.mjs`):
  - "· price not listed", "· on your Krea plan", no dollar line, plain "Run", no native dialog.
  - "The listed prices total up to $0.43." with plain "Run".
  - The re-ask: the tab couldn't price GPT Image 2 (its entry taken out of the tab's table) and showed "price not listed" and "Run"; Run → one 409 → the dialog came back with "This run changed since you last reviewed it.", "$0.0047–0.43" and "Run for up to $0.43". A click right after it reopened was held (no second request). Cancel: no refusal text anywhere, still a placeholder.
  - Size: "price not listed" → "$9.95", "Run for $9.95" in the open dialog (SeedVR2 Video Upscale; FLUX Video Upscale has no price without a BFL key, which the backend test covers).
  - Cinema "Generate shot" over a paid placeholder, with "Ask before costly runs" at $0.001: GM's dialog only, no browser confirm; Cancel left the shot as it was.
  - The focused pill: 480 px, 40 px tall (wrapped), bottom edge unmoved, nothing cut; a mouse click into the node's text field left it at rest.
  - The proposal: "runs nothing until Codex finishes 1 node", buttons Show / Reject / Accept.
- Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. Console errors: the canary's and the expected 409. Servers stopped by PID; the state dir deleted.
- Screenshots in the scratchpad `agent-presence/`: `r5-q133-unlisted-krea.png`, `r5-q133-mixed-unlisted.png`, `r5-q133-reask.png`, `r5-size-priced-before.png`, `r5-size-priced.png`, `r5-cinema-shot-dialog.png`, `r5-pill-wrap.png`, `r5-proposal-runs-nothing.png`.

### Open items (round 5)

- GM: a shot's refusal says "Generate again to review it." for one or several paid nodes; GM gave only that form ("them" for several would be new words).
- GM: the one remaining two-dialog case: an agent makes its placeholders normal while the dialog is open AND the run now costs more than the person confirmed. The costly-run setting then asks in the browser's confirm (review 3's ruling). Moving that to the Nebula dialog is GM's item 7 follow-up.
- While a refusal's re-ask is open, the run's nodes show Queued behind it.

### Gates (round 5)

- Backend full suite: 10,993 passed, 71 skipped (9 min 2 s).
- Vitest full: 454 files, 5,796 tests. The first run had 21 failures in 10 files, all load timeouts and focus/findBy waits ("Test timed out in 5000ms", `toHaveFocus`, a role not found in time); none of them is a file this round touched. Rerun alone, those 10 files passed: 200 of 200.
- errorCopy ratchets: 14 files, 173 tests passed.
- `tsc -b` clean, lint clean.
- Build budget: 389,437 bytes raw entry, 117,275 gzip (limit 512,000 raw).
- MCP INSTRUCTIONS: 2,233 characters, unchanged (2,957 with the commons guide, limit 3,000).

## Round 6: review 5 and GM - Design's round-6 rulings (2026-10-26)

Justin, Q133 b, again the rule: a paid placeholder never runs without the person's confirmation, and what runs never costs more than the person was shown. Review 5 found the one way left around the second half (H1): an agent finishing its placeholders while the dialog was open turned the run into an ordinary one, which then fell to the costly-run setting (off by default) and to a backend with nothing to hold it to. The coordinator chose both halves of the fix; GM ruled the copy. Every fix was test-first.

### What changed and why

- **H1 (a), the canvas: the dialog stays in charge once it has shown.** `askUntilSettled` (graphStore.ts) keeps every placeholder a dialog of this run showed (`shown`), and `placeholderRunConfirm` never returns "no dialog" while it has some. When their agents finish them while it is open, the open dialog updates in place to GM's words: "Run with Codex's changes?" / "Codex finished setting up these nodes." ("Run with the agents' changes?" / "The agents finished setting up these nodes." for several), then the changed line, the rows, the total and the button as usual. If some placeholders are left, the first heading counts only those. After the click the run is read again: the same words run at what was shown; a run with no placeholder left that the shown total still covers (no higher, and no row without a price the dialog didn't show) runs, sending the total the person saw; anything else asks again. The costly-run setting and the browser's confirm never follow the dialog any more (`coveredBy`/`costlyOk` fall-through removed).
- **H1 (b), the backend: a confirmed total holds with no placeholder left.** `_require_placeholder_confirmation` (main.py) now checks whenever the request carries `confirmedCost`, not only when a paid placeholder is left: above Nebula's estimate it refuses with the same 409 `placeholder_confirm_required`, `placeholders: []`, the estimate, and (for a tab too old to re-ask) "Nothing ran. This run changed since you last reviewed it. Click “Run” again to review it." ("Generate again to review it." for a shot). The ids confirmed don't matter then. The canvas answers that 409 with GM's dialog in the finished form. Agents' requests are never held to it.
- **L1: Accept on a proposal that runs nothing starts no run.** `canvasProposalsStore.accept` skips `runNodes` and the deferred "Run them when the current run finishes." when `runsNothing(view)` (what made the button "Accept"), and releases the approval. No Run history entry, no Queued, no skip line.
- **L2 and GM item 4: a refused run leaves the canvas as it was.** `sendDirectRun` takes the start back before it asks again (`withdrawRunStart`): no Run history record (an older record the new one pushed past the cap comes back), no owner, no Stop, isExecuting off, and each node's state, error and progress as they were (a "complete" node stays complete). After a yes it registers the same run again (`begin`), unless another run started meanwhile. A Cinema shot gets its output back too. Every direct path does this: node Run (and Inspector, context menu, Run selected of one, Generate all), Generate shot / Generate N, replays.
- **L3:** left as the item-7 known gap (see Open items); not fixable without asking Nebula before the browser confirm.
- **L4: one measuring for inline images.** `POST /api/pricing/input-sizes` measures a `data:` image as the run's checks do (`input_sizes.measure(ref, kind)`, inline on), so the canvas no longer shows "price not listed", the "can't read the size" note, and a forced re-ask for one.
- **L5 and GM item 3: every dollar in the total has a row.** Each paid node of the run that is no placeholder gets a muted row with no dot ("“Shot 1” · Nano Banana · $0.067"), after the agents' rows and above "Plus 1 free node.". A normal paid node with no list price reads "price not listed", makes the button plain "Run" and is in the footnote. The backend counts an unpriced node as nothing, as the canvas does (pinned by a test).
- **L6: the dialog hands back what it showed.** `PlaceholderRunDialog` calls `onDone(ok, model)` with the model it had rendered; `askPlaceholderRun` resolves with it (or null), and the store sends that model's cost. A newer model still waiting to be drawn can't be confirmed.
- **L7: the change is announced.** A visually hidden `aria-live="polite"` region says "This run changed since you last reviewed it." at each in-place change (a no-break space alternates, so a second change is read again). No new words.
- **L8:** left as is: the refusal's words can still show when the person stopped the run mid-request or the canvas can't build a model.
- **GM item 1: footnotes.** No total line, no footnote. With one: "“Flux still” has no list price, so the run may cost more.", "“Flux still” and “Upscale” have no list price, so the run may cost more.", "3 nodes have no list price, so the run may cost more." The old "No list price for …" note is gone from the dialog (`runCostNotes(..., { prices: false })`; the browser's costly-run confirm keeps it).
- **GM item 2:** a price waiting on its input reads "“Upscale” · SeedVR2 Video Upscale · price depends on its input"; "Priced when its input is known: …" and the unreadable-size note are gone from the dialog. The row updates in place to the real price.
- **GM item 3, Cinema's button:** "Generate for $X", "Generate for up to $0.50", plain "Generate", from Generate shot, Generate N and Generate all (`executeNode(id, { verb: 'Generate' })` from the toolbar). Heading unchanged. Replays from Run history keep "Run".
- **GM item 5: the pill.** It already wraps every line. What stopped it after 2 lines was the status itself: Nebula keeps 140 characters (the documented limit), and the round-5 check sent 172, cut mid-word. A cut status now ends in "…" (`clean_status_text`), so the pill never ends as if that were all. Raising the limit would change the agents' contract, so I didn't.
- **GM note 2:** the changed line shows for in-place updates too, whenever the heading, the intro, a row, a price, the total or the button changes after the dialog first shows, and stays.
- **Rows by node, not name.** `RunCost` gains `ids` (unpriced, plan, awaitingInput by node id) so two nodes with one name get their own prices.
- **Agent support:** docs/MCP-SETUP.md (the muted rows, the footnotes, "price depends on its input", Generate, the dialog staying in charge, "Run with Codex's changes?", `confirmedCost` held with no placeholder left, `placeholders: []` and its message, the canvas taking the start back, inline images measured, Accept starting no run, the status cut with "…"); skills/nebula/SKILL.md (finishing or changing placeholders while the person decides; the status cut); the `set_status` MCP docstring (the cut). INSTRUCTIONS unchanged: 2,233 characters. No CLI change: confirming is the person's alone.

### Decisions not in the spec

- In "Run with Codex's changes?" the nodes Codex finished keep its dot (they are "these nodes" the body names); the run's other paid nodes are muted. GM's rule for muted rows is "paid nodes that aren't placeholders"; strictly those finished nodes aren't placeholders any more. Listed for GM.
- The footnote names only "price not listed" rows. A row that reads "price depends on its input" says so itself, and "has no list price" would be wrong for it.
- A run that got cheaper or stayed the same after its agent finished goes ahead without a second ask, sending the total the person saw (the coordinator's ruling). A change that adds a row with no price, or a different set of placeholders, asks again.
- The shot's row is named "Shot N" (its place in the scene, as the Cinema panel numbers it) and its model is the scene's base model's display name ("Nano Banana"), as in GM's example.
- After the refusal re-ask, the run's id stays the same (its record is removed and made again), as round 5 decided.

### Tests (first, each seen failing)

- **Backend** (`tests/test_pending_nodes_round6.py`, 10 tests): 5 failed first, 5 passed.
  - H1 (3): 200 "started" where a 409 belonged (node run below the estimate with no placeholder left, stale ids, a shot).
  - L4: `None == {'height': 480, 'width': 640}` from the size endpoint.
  - GM item 5: the cut status didn't end in "…".
  - Passing before and after (they pin what must not change): a covered total runs, no confirmation and no placeholder runs as before, an agent's run is never held, L5's unpriced node counts nothing on both sides, a status that fits is kept whole.
- **Frontend:** 33 failed first, 12 passed.
  - `lib/placeholderRunConfirm.round6.test.ts` (16): 14 failed (the old notes, "price not listed" instead of "price depends on its input", no muted rows, "Run for" from Cinema, no finished heading, prices by name); 2 passed (no dialog when nothing was shown and no paid placeholder is in the run, and the "some still left" heading).
  - `PlaceholderRunDialog.round6.test.tsx` (6): all failed (no muted row class, no changed line in place, no live region, `onDone`/`askPlaceholderRun` gave a boolean).
  - `graphStore.placeholderRuns.round6.test.ts` (13): 12 failed (no second ask after the agent finished, `confirmedPlaceholders` undefined, a "cancelled" history record and a "complete" node turned idle, the shot's output left "idle", "Run for" in Cinema), 1 passed (a yes on the re-ask makes one record).
  - `canvasProposalsStore.test.ts` L1: `executeNode` was called.
  - Added after the first pass: "a full Run history keeps every record it had" (the withdrawn record had pushed the oldest one past the 100-record cap; only those come back, so a history the person cleared meanwhile stays cleared).
  - Updated to the new rules: round-3/4/5 cases where a paid node of the person's sat beside the placeholders (it now has a muted row), the shot's button ("Generate for $2.40"), the awaiting row's words, the ask mocks (the dialog now resolves with the model), and the two round-5 tests that pinned the costly-run fall-through H1 removes.

### Live check (1280x800)

- Isolated backend on 8795 (temp HOME and every NEBULA_* root under scratch, no keys) and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`); `/api/health` through Vite matched. Codex verified (an app token), Claude Code self-named. No key was set, so nothing paid could run. Run was clicked once (the re-ask check): Nebula refused it with a 409, and nothing ran.
- 24 of 24 checks passed (script `agent-presence/live-r6.mjs`):
  - Cinema Generate shot: "“Hero still” · GPT Image 2 · $0.0047–0.43", the muted "“Shot 1” · Nano Banana · $0.067", "Plus 1 free node.", "This run could cost up to $0.50 at list prices.", "Generate for up to $0.50"; the rows add up to the total; no browser confirm.
  - The canvas dialog with the scene's muted row ("“Cinema Scene” · Nano Banana · $0.13"), "The listed prices total up to $0.56.", plain "Run", and each footnote: one name, two names, "3 nodes".
  - "“Upscale” · SeedVR2 Video Upscale · price depends on its input" with no note, then "$9.95", "Run for $9.95" and the changed line, in place.
  - Codex changed the quality while the dialog was open: the changed line in place (and in the live region). Then Codex set high quality and finished both nodes: "Run with Codex's changes?", "Codex finished setting up these nodes.", the changed line, "$0.16–0.43", "Run for up to $0.43". Cancel ran nothing.
  - The refusal's re-ask: behind it no Stop, nothing Queued, the Agent log not "streaming", no run, no Run history record; Cancel left none.
  - The pill: a 172-character status shows whole, cut by Nebula to "…then checki…", wrapped on two lines at 480 px, nothing clipped.
  - A proposal that runs nothing: "runs nothing until Codex finishes 1 node", Show / Reject / Accept; Accept added its node and started nothing (Run history "No saved runs yet.").
- Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. Console errors: the canary's and the expected 409. Servers stopped by PID; the state dir deleted.
- Screenshots in the scratchpad `agent-presence/`: `r6-cinema-generate.png`, `r6-footnote-1.png`, `r6-footnote-2.png`, `r6-footnote-3.png`, `r6-depends-before.png`, `r6-depends-after.png`, `r6-changed-inplace.png`, `r6-h1-codex-changes.png`, `r6-reask-canvas-clear.png`, `r6-pill-wrap.png`, `r6-proposal-accepted-no-run.png`.

### Open items (round 6)

- For GM:
  - The backend's refusal with no placeholder left: "Nothing ran. This run changed since you last reviewed it. Click “Run” again to review it." (a shot's ends "Generate again to review it."). Put together from GM's existing lines; the canvas never shows it, only a tab too old to re-ask.
  - In "Run with Codex's changes?" the finished nodes keep Codex's dot (see Decisions).
  - The footnote leaves out "price depends on its input" rows.
  - The pill: the 2-line stop was the 140-character status limit, now marked with "…". A longer limit is a contract change for Justin.
- Known gaps (item 7 follow-up, for the PR body):
  - Round 5's two-dialog case (an agent clears its placeholders mid-dialog and the run costs more) is gone: H1 asks again in GM's dialog and never falls to the browser's confirm.
  - The one two-dialog case left: the tab hasn't heard of an agent's placeholder yet and "Ask before costly runs" is on. The browser's costly-run confirm shows, then Nebula's 409 brings GM's dialog (review 5, L3). Avoiding it would need asking Nebula before the browser confirm; item 7 moves that confirm into Nebula's dialog. No new browser-confirm path was added.
  - A free-placeholder run's costly-run confirm is still the browser's (GM round 4, item 7).
- L8 as is: the refusal's words can show if the person stopped the run mid-request or the canvas can't build the dialog.

### Gates (round 6)

- Backend full suite: 11,003 passed, 71 skipped (13 min 25 s).
- Vitest full: 457 files, 5,833 tests. The first run, during the backend suite, had 22 failures in 10 files, all load timeouts and focus/findBy waits ("Test timed out in 5000ms" 16 times, `toHaveFocus`, a role not found in time); none of them is a file this round touched. Rerun alone, those 10 files passed: 200 of 200.
- errorCopy ratchets: 14 files, 173 tests passed.
- `tsc -b` clean, lint clean.
- Build budget: 389,508 bytes raw entry, 117,299 gzip (limit 512,000 raw).
- MCP INSTRUCTIONS: 2,233 characters, unchanged.

## Round 7: review 6 and GM - Design's round-7 rulings (2026-10-26)

Justin, Q133 b, the same two rules: a paid placeholder never runs without the person's confirmation, and what runs never costs more than the person was shown. Review 6 found no high finding; one medium (many rows pushed Run off-screen) and five lows. GM ruled the copy for round 7 and answered the two open questions (placeholders that left the run; a yes dropped because another run started), plus M1 and the rounding. Every fix was test-first.

### What changed and why

- **M1: many rows scroll, everything else stays.** The card never grows past the window (`max-height: calc(100dvh - 32px)`); the heading, intro, changed line, total, footnotes and buttons keep their height, and only the rows list shrinks and scrolls (placeholder-run-dialog.css). GM: "rows scroll with everything else pinned: yes. The scroll area must be reachable by keyboard, and initial focus stays on Cancel." A list that overflows is a Tab stop named by the heading (`tabIndex=0`, `aria-labelledby`), part of the dialog's Tab cycle; a list that fits isn't. Focus still starts on Cancel. No new words.
- **L-a: a cheaper run goes ahead only if everything in it was on screen.** After a yes, a run with no placeholder left runs without asking again only if its total is no higher than the one shown, every row (by node) was on screen, no row without a price is new, and no gate or "Not included" note is new (`coveredBy`, graphStore.ts; the model's new `costNotes`). Probe N1 (Codex finishes on a cheaper model and wires in a FLUX.2 node with "Not included: input images") now asks again with the new row.
- **L-b: only this run's placeholders; one that left is never "finished".** The dialog remembers only placeholders in this run's scope (`runPlaceholders`), so another agent's placeholder elsewhere on the canvas never changes it. GM's words, verbatim: none finished, all left: "Run without the node Codex was setting up?" / "It's no longer in this run." ("Run without the nodes Codex was setting up?" / "They're no longer in this run."; several agents "Run without the nodes agents were setting up?"). Some finished, some left: "Run with Codex's changes?", the body counting only the finished, then "1 node Codex was setting up is no longer in this run." ("2 nodes Codex was setting up are no longer in this run.").
- **L-c: a yes dropped because another run started first says so.** GM: "Nothing ran. Another run started first. Click “Run” again when it finishes." (Cinema: "Nothing ran. Another run started first. Generate again when it finishes."). Shown as the canvas notice on both places a yes can be dropped: the first dialog (the run can't be read any more because another run holds the canvas) and Nebula's re-ask (`begin` refused). The other run is left alone. It shows only when another run really holds it (`busy`: `isExecuting` for node runs, Generate all and replays; for a shot, the shot running or an active run over its nodes); a Cancel, or an import in progress, says nothing.
- **L-d and GM item 2: rows priced by their input under a total.** The button already dropped the amount; the footnote is GM's: "“Upscale” is priced by its input, so the run may cost more." / "“Upscale” and “Grade” are priced by their input, so the run may cost more."; both kinds together, or three or more by input: "3 nodes have no price yet, so the run may cost more." Unlisted-only rows keep round 6's words.
- **L-e: amounts the person confirms are in cents, rounded up.** GM: "ALWAYS show cents, rounded UP to the next cent, regardless of size: "$0.21", "$10.49", and "$0.01" for anything under a cent. Never whole dollars there. Row prices keep their current formatting. Send that shown amount as confirmedCost; the backend must not let a run exceed it." The button and the total line use `formatConfirmUsd`; `confirmCost` is `roundUpToCent` (read at 6 places first, so 0.07 never becomes 0.08). Nebula's refusal estimate is rounded up the same way before it is sent. Backend: `_CONFIRMED_COST_SLACK` is gone; any estimate above `confirmedCost` is refused.
- **GM item 1:** "Codex finished setting up this node." for one, "these nodes" for two or more; "The agents finished setting up this node / these nodes."
- **GM polish: the status cut lands on a word.** `clean_status_text` cuts after the last whole word that fits, then "…" ("…then…" not "…then checki…"); a word ending exactly at the cap is kept; with no space, a hard cut.
- **The r6 zz-error question: reachable, fixed.** See "Surprises".
- **Agent support:** docs/MCP-SETUP.md (cents and no slack for `confirmedCost`; "this node"; "Run without…"; the left line; only this run's placeholders; what lets a cheaper run go ahead; the "Another run started first" notice; input-priced footnotes; the rows scrolling; the status cut at a word); skills/nebula/SKILL.md (nothing runs that the person didn't see; a deleted or disconnected placeholder is "no longer in the run"; the status cut); the `set_status` MCP docstring. INSTRUCTIONS unchanged. No CLI change: confirming is the person's alone.

### Decisions not in the spec

- Several agents in the left line ("2 nodes agents were setting up are no longer in this run.") follows GM's "Run without the nodes agents were setting up?"; GM gave only Codex's forms for that line. Listed for GM.
- A placeholder that left while others are still placeholders: the first heading counts only those left in the run (GM round 6) and no left line is added; GM ruled the left line only for the "changes" heading.
- "Run for up to" now means the low and high differ in cents (rounded up), the same unit the button shows.
- The L-c notice uses the canvas notice's error tone (announced as an alert), like the other "Nothing ran" lines.
- A list that fits is not a Tab stop (it would be an empty stop for keyboard users); it becomes one when it overflows (measured on resize).

### Tradeoffs

- No slack in the backend: a tab whose arithmetic differs from Nebula's in the last place now gets a 409 and an immediate re-ask at Nebula's numbers instead of passing; with the canvas rounding up to the cent this only happens when the two prices really differ.
- The left line and "Run without…" count shown placeholders by id; a placeholder deleted and re-added by its agent with a new id counts as one that left and a new one.

### Surprises

- **r6-zz-error-cinema.png was a real bug.** Reproduced live (r7, section Z, CPU throttled 8x as on a busy machine): back on the canvas from Cinema Studio, the notice region still sat where it sits with no bar (24 px up, the bar's own place) and sprang to its line above the bar on its 420 ms `bottom` transition; for that time a showing notice ("Codex changed the canvas" with Undo) covered Canvas actions and the zoom. The fade was the canvas coming back (and Run's price not computed yet), which is why it looked like a faded canvas. The earlier r6 attempt's screenshot was taken in that window. Fix: a bar that comes or goes is a screen switch; `publishBottomBarClearance`/`clearBottomBarClearance` mark the root (`data-bottom-bar-switch`) for two frames and the region jumps (`transition: none`); the bar growing (Canvas actions) keeps the spring. After the fix the region's line was above the bar in every sample; a notice remounting on return still plays its own 12 px rise from opacity 0, as every new notice does.
- Probe N4's yes was not clobbering the shot (the node's `begin` already refused); it was only silent.

### Tests (first, each seen failing)

- **Backend** (`tests/test_pending_nodes_round7.py`, 7 tests): 4 failed first, 3 passed.
  - L-e (2): 200 "started" for a `confirmedCost` 0.0000005 below Nebula's estimate (with and without a placeholder left).
  - GM polish (2): the cut status ended "then checki…" (direct and over HTTP).
  - Passing before and after: the canvas's cents rounded up runs; a word ending exactly at the cap is kept; no space, hard cut.
- **Frontend:** 41 failed first, 8 passed.
  - `lib/placeholderRunConfirm.round7.test.ts` (27): 24 failed (no `formatConfirmUsd`/`roundUpToCent`, "these nodes" for one, "Run with Codex's changes?" where GM's "Run without…" belongs, no left line, no input-priced footnotes, "$0.20" for $0.201 and "$10" for $10.481); 3 passed (two finished nodes, several agents, unlisted-only footnote).
  - `PlaceholderRunDialog.round7.test.tsx` (5): 4 failed (the overflowing list not a Tab stop, no name, no max-height/overflow in the CSS, no left line); 1 passed (a list that fits is no Tab stop).
  - `graphStore.placeholderRuns.round7.test.ts` (13): 10 failed (N1 ran f unasked, a new priced node ran unasked, "The agents finished…" after a delete or disconnect, no left line, no notice on any of the three dropped yeses, "Run for $0.20", "$1.20" for $1.2001); 3 passed (same rows cheaper goes ahead, another agent's placeholder elsewhere changes nothing, Cancel says nothing).
  - `noticeRegionScreenSwitch.test.ts` (4): 3 failed (no mark on a bar arriving or leaving, no CSS rule); 1 passed (the bar growing keeps the spring).
  - Updated to the new rulings: round 5's "rounded to 6 places" (now cents, rounded up: $0.00005 confirms $0.01), round 6's "$0.067" total line ("$0.07") and "these nodes" for one finished node ("this node", lib and store).

### Live check (1280x800, and 1440x900 for many rows)

- Isolated backend on 8795 (temp HOME and every NEBULA_* root under scratch, no keys) and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`); `/api/health` through Vite matched. Codex verified (an app token), Claude Code self-named. No key was set, so nothing paid could run. Run was clicked once (the L-c check): another run held the canvas, the yes sent nothing, and the only run request was the free Video Edit's.
- 18 of 18 checks passed on the final run (script `agent-presence/live-r7.mjs`). Two earlier runs: the first failed the zz check (the reproduction, before the fix); the second hit a Puppeteer "Promise was collected" error in the L-c section's async `waitForFunction`, replaced by a Node-side poll.
  - Z: canvas → Cinema Studio → canvas at 8x CPU throttling, sampled every 80 ms. Before the fix: back on the canvas the region sat 730–776 over the bar's 728–776 (`r7-zz-repro-bug-before-fix.png`). After: the region's line stayed above the bar in every sample (674–720), and the notice ended above it.
  - "Codex finished setting up this node." (one), "… these nodes." (two), "The agents finished setting up these nodes." (Codex and Claude Code).
  - “Upscale” · SeedVR2 Upscale · price depends on its input (a remote input, never downloaded) under "The listed prices total $0.07.", plain "Run", "“Upscale” is priced by its input, so the run may cost more."; with a FLUX still and a second upscale: "3 nodes have no price yet, so the run may cost more.".
  - Three rows at $0.067 ($0.201): "This run could cost up to $0.21 at list prices." and "Run for $0.21".
  - 32 rows: at 1280x800 the heading at 33 px, the total ending at 717, Cancel and "Run for $2.15" at 729–767; at 1440x900 the same at 817 / 829–867. Focus on Cancel; Tab, Tab reached the rows; End scrolled them 245 px.
  - Codex removed its placeholder while the dialog was open: "Run without the node Codex was setting up?" / "It's no longer in this run." and the changed line.
  - A Video Edit run started while the dialog was open; Run in the dialog: "Nothing ran. Another run started first. Click “Run” again when it finishes.", no request for the placeholder's node.
  - The 172-character status shows "…, then…" in the focused pill, nothing clipped.
- Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. Console errors: the canary's only. Servers stopped by PID; the state dir deleted.
- Screenshots in the scratchpad `agent-presence/`: `r7-finished-one.png`, `r7-finished-several.png`, `r7-finished-agents.png`, `r7-input-priced-footnote.png`, `r7-no-price-yet.png`, `r7-rounded-up.png`, `r7-many-rows.png`, `r7-many-rows-1440.png`, `r7-many-rows-scrolled.png`, `r7-left-run.png`, `r7-another-run-first.png`, `r7-pill-word-cut.png`, `r7-zz-repro-bug-before-fix.png`, `r7-zz-repro-before.png`, `r7-zz-repro-after.png`.

### Open items (round 7)

- For GM:
  - The left line for several agents ("2 nodes agents were setting up are no longer in this run."), built on GM's "Run without the nodes agents were setting up?" pattern.
  - A placeholder that left while others are still placeholders: no left line under "Run 1 node Codex is still setting up?" (GM ruled the line only under the "changes" heading).
  - L-d: the dropped note "Nebula can't read the size of its input (a file on another host is never downloaded to price it)" said something GM's footnote doesn't: for a remote input the price will never be known before the run, so the row stays "price depends on its input" and won't update in place. Not restored.
  - A yes dropped while a graph import is running says nothing (no words for that; "Another run started first" would be wrong).
  - The browser's costly-run confirm (item 7) still shows whole dollars from $10 ("$10"); GM's cents rule was given for this dialog.
- Known gaps unchanged (item 7 follow-up, for the PR body): the tab that hasn't heard of an agent's placeholder with "Ask before costly runs" on (browser confirm, then Nebula's dialog); free-placeholder runs still use the browser's costly-run confirm. No browser-confirm fallback added.
- L8 as before.

### Gates (round 7)

- Backend full suite: 11,010 passed, 71 skipped (13 min 4 s).
- Vitest full: 461 files, 5,882 tests. The first run, during the backend suite, had 21 failures in 8 files, all load-shaped: 16 "Test timed out", 2 `toHaveFocus` waits, 1 role not found in time, 1 leftover request from a timed-out test. None is a file this round touched. Rerun alone, those 8 files passed: 175 of 175.
- errorCopy ratchets: 14 files, 173 tests passed.
- `tsc -b` clean, lint clean.
- Build budget: 389,865 bytes raw entry, 117,428 gzip (limit 512,000 raw).
- MCP INSTRUCTIONS: 2,233 characters, unchanged (2,957 with the commons guide).

## Round 8: review 7 and GM - Design's round-8 rulings (2026-10-26)

Justin, Q133 b, the same two rules: a paid placeholder never runs without the person's confirmation, and what runs never costs more than the person was shown. Review 7 found no high finding: one medium (focus could fall out of the dialog, and canvas shortcuts then acted behind it) and five lows. GM signed off item 3 once its two round-8 items are in (the left line under the still-setting-up heading; the import notice). Every fix was test-first.

### What changed and why

- **M-1: focus stays in the dialog, and nothing acts behind it.** When the rows stop scrolling while the list has focus (an agent deletes placeholders, the window grows), focus moves to Cancel in the same commit that drops the list's Tab stop, before the browser can drop it on the page; any other slip to the page (a click on the backdrop, an element that went away) comes back to Cancel (PlaceholderRunDialog.tsx). Structural part: `isModalDialogOpen()` (lib/canvasShortcutScope.ts) reads whether any `[aria-modal="true"]` is on the page; while one is, `isCanvasShortcutTarget` is false for every target, the page included, so Cmd+Enter, Delete, Cmd+Z and the rest don't act behind any modal dialog, wherever focus is. The same check stops the app-wide keys that aren't canvas shortcuts but act on the graph: Cmd+O and Cmd+S (GraphFileActions: Cmd+O would open a file over the canvas) and Cmd+K (lib/commandPaletteKeys.ts: the palette's "Run graph" would run behind the dialog, even with focus correctly on Cancel, since the palette listens app-wide).
- **L1: a replay words what runs.** A replay sends its saved copy of every node. `snapshotCanvas` now marks a saved node `gone` when its live node was deleted, or is another type and no placeholder; the dialog (`gone` option) never counts such a node as "finished": the agent's placeholder is one that left the run ("Run without the node Codex was setting up?" / "It's no longer in this run.", or the left line), and the saved copy runs as a muted row priced in the total (it is what runs, so its dollars need a row). The row keeps the name the dialog last showed. A live placeholder under another type is still flagged (by id, regardless of type), because Nebula reads placeholders by id (main._skip_placeholders) and would refuse the run otherwise; before, the tab dropped the flag and only Nebula's 409 brought the dialog back.
- **L2 (coordinator's decision): a row counts as seen only if its node, model and price all match** what was drawn (`rowSeen`, graphStore.ts). A node switched to another model, or at another price, asks again with "This run changed since you last reviewed it.", even when cheaper. What still goes ahead without a second ask: every row unchanged (Codex finishes without changing anything), or rows dropped, at a total no higher.
- **L3: a notice never takes an agent's Undo away.** `notify` (every caller: a failure, "Nothing ran. Another run started first.", the import notice) writes the canvas notice as before, except while it offers an Undo or Redo: then the line goes to `messageNotice`, shown by `CanvasMessageNotice` in a new region slot `message` above the late count and the canvas notice, so the notice with the button stays nearest the bar (GM round 4's rule for the late count). Same look, tone (alert for errors), Dismiss and reading-time hold; on every screen; a project open clears it. No new words.
- **L4: any amount above zero confirms at least $0.01.** `roundUpToCent` floors a positive amount at a cent (it read under half a millionth as $0.00). Backend: `_six_places` (main.py) reads an estimate at 6 places as before, but a positive one never as 0 (under half a millionth it reads 0.000001), so `confirmedCost: 0` can't pass a run that costs something.
- **L5 (coordinator's decision; GM did not override):** a status over 140 characters is cut at its last space only if that keeps at least 100 characters (`MIN_WORD_CUT_CHARS`), otherwise cut hard ("Reading https://example.com/ppp…", 139 characters and "…", not "Reading…"). A hard cut never splits a character: `services/text_cut.py` `safe_cut` backs off over combining marks (Mn, Mc, Me), ZWJ sequences, variation selectors, skin tones, emoji tags, Hangul medial vowels and finals, and regional-indicator pairs (counted from the start of the run). A cursor's `say` (cut at 140 with no "…") uses the same safe cut: the same kind of cut on the same kind of text.
- **GM item 2:** the left line also shows under the still-setting-up heading: "Run 1 node Codex is still setting up?" / "Codex hasn't finished this, so its settings may not be final." / "1 node Codex was setting up is no longer in this run." / "This run changed since you last reviewed it." / rows (the dialog already drew lines in that order).
- **GM item 4:** a yes dropped while a graph import runs: "Nothing ran. Nebula is still importing. Click “Run” again when it finishes." (Cinema: "Nothing ran. Nebula is still importing. Generate again when it finishes."). `announceDroppedYes` checks the import first (no run starts while one runs), then another run; on both places a yes can be dropped (the first dialog, Nebula's re-ask), for node runs, Generate all, replays and shots. Cancel still says nothing.
- **Found in the live check: the dot's keyboard focus showed 320 px and "…".** Below 60% zoom the pill's dot is a Tab stop, but only the node's keyboard focus showed the whole status (wrapping past 480 px, GM round 5). With L5 a status now keeps a long URL, so the dot's keyboard focus now counts the same (AgentNodeMarkLayer.tsx `useKeyboardFocusedNode`); a pointer press still doesn't.
- **Agent support:** docs/MCP-SETUP.md (the left line under the first heading; what a replay runs and says; "every row exactly as it is now" for going ahead; the import notice; a notice beside an Undo; focus and no shortcuts behind the dialog; an estimate above zero never reads 0; the status cut's 100-character rule and safe hard cut), skills/nebula/SKILL.md (a model or price change asks again; a replay runs its saved copy; the status cut), the `set_status` docstring. INSTRUCTIONS unchanged. No CLI change: confirming is the person's alone, and `nebula status` sends the text to the same cut.

### Decisions not in the spec

- The structural guard reads `aria-modal="true"` from the page rather than a registry, so every modal dialog counts, including later ones; all of the app's are rendered only while open (checked each). Cmd+K, Cmd+O and Cmd+S yield too: they act on the graph from app-wide listeners that never asked `isCanvasShortcutTarget`. Side effect: "?" on the page no longer closes the keyboard shortcuts dialog (its own keys still do; focus starts in it).
- A replay's saved copy of a deleted placeholder still runs (replays run their saved recipe, unchanged); it is worded as a normal paid node, and its placeholder as one that left.
- L2 makes the round-6 and round-7 "a cheaper run goes ahead" tests ask again (updated, with a comment); the round-8 suite pins the case that still goes ahead.
- The message slot sits above the late count; the late count stays directly above the canvas notice, as its test and GM's rule have it.
- `say` gets the safe hard cut but keeps its own rule otherwise (no "…", no word cut).

### Tradeoffs

- L2 asks again for a cheaper price too: one more click in that race, never a run at words the person didn't see.
- `safe_cut` covers the grapheme rules that matter for one line of agent text, not all of UAX #29 (no package for one line; no installs).

### Tests (first, each seen failing)

- **Backend** (`tests/test_pending_nodes_round8.py`, 14 tests): 11 failed first, 3 passed.
  - L4 (2 failed): the estimate's `high` and `low` read 0.0 for a run of 4e-7; `confirmedCost: 0` got 200 "started" for it. Passed before and after: $0.01 runs.
  - L5 (9 failed): "Reading…" for the 228-character URL (direct and over HTTP); a word cut keeping 99 characters; hard cuts that split a combining accent, a ZWJ family, a flag, a variation selector, a skin tone (139 code points where a whole number of units fits in 138 or 135); a cursor `say` ending on a bare "e" before its accent. Passed before and after: word cuts keeping 100 and 110 characters; a flag run after a lone indicator.
- **Frontend:** 28 failed first, 8 passed (the ⌘O control first failed for a missing ReactFlowProvider in the test, fixed before it counted), plus 1 from the live check.
  - `lib/placeholderRunConfirm.round8.test.ts` (10): 8 failed (no left line under "Run 1 node Codex is still setting up?" for one or two left; a gone saved copy counted "finished" with its agent's dot; $0.00 for 4e-7, 4.9e-7, 1e-9 and the smallest double); 2 passed (nothing left, no line; zero stays zero, float noise kept out).
  - `graphStore.placeholderRuns.round8.test.ts` (15): 11 failed (replay delete: "Run with Codex's changes?"; replay type change: same; a live placeholder under another type: no dialog at all; another model, and a lower price: ran unasked; the Undo notice replaced by "Another run started first" and by any notice; no import notice on node Run, Nebula's re-ask, a replay or Cinema); 4 passed (Codex finishing unchanged goes ahead; a notice with no Undo showing is the canvas notice; Cancel during an import says nothing; another run keeps its notice).
  - `PlaceholderRunDialog.round8.test.tsx` (5): 4 failed (focus stayed on the list after it stopped scrolling; a slip to the page stayed there; the page and the canvas were shortcut targets with the dialog open); 1 passed (Escape cancels).
  - `shortcutsBehindModal.round8.test.tsx` (3): 2 failed (⌘O loaded and ⌘S saved behind an open dialog; ⌘K opened the palette); 1 passed (⌘O with no dialog).
  - `noticeMessageBesideUndo.round8.test.tsx` (3): 3 failed (no `message` slot; the line replaced the Undo, on the canvas and in Cinema).
  - `AgentNodeMarkLayer.test.tsx` (+1, from the live check): failed first (the dot's keyboard focus set no `data-focused`).
  - Updated to the new rules: round 6 "a run that got cheaper goes ahead" and round 7 "the same rows, cheaper" (now ask again, then run at the new total), and `lateRestoreCount`'s slot list (adds `message`).

### Live check (1280x800)

- Isolated backend on 8795 (temp HOME and every NEBULA_* root under scratch, no keys) and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`); `/api/health` through Vite matched. Codex verified (an app token). No key was set, so nothing paid could run. Run was clicked in three dialogs, each a yes that sends nothing (an import holding the canvas, twice; another run holding it); the model-switch re-ask was cancelled. Run requests: one POST (and its OPTIONS) for the free Video Edit, nothing else.
- 16 of 16 checks passed (script `agent-presence/live-r8.mjs`). The first run failed one check, which found a real gap: the dot's keyboard focus showed the URL status at 320 px with "…" (fixed and tested above; the script then focuses the dot from the keyboard, as Tab would).
  - Codex removes one of two placeholders while the dialog is open: "Run 1 node Codex is still setting up?", the body, "1 node Codex was setting up is no longer in this run.", "This run changed since you last reviewed it.", the rows.
  - 34 rows: Shift+Tab from Cancel puts focus on the list; Codex deletes 30: the list fits, no Tab stop, focus on Cancel; the dialog reads "Run 4 nodes Codex is still setting up?" with "30 nodes Codex was setting up are no longer in this run.". A blur to the page came back to Cancel. With focus on the page, Cmd+Enter, Ctrl+Enter, Cmd+K, Cmd+O and Cmd+A did nothing: no run request, no palette, the dialog still open. Escape cancelled.
  - An import reserved through the store's own `reserveGraphImport` (as an Open or a project open does) while the dialog was open; Run: "Nothing ran. Nebula is still importing. Click “Run” again when it finishes.", no request. From a Cinema shot's Generate (the store's `executeShot`, which the Cinema panel calls; the dialog's button read "Generate for $0.14"): "Nothing ran. Nebula is still importing. Generate again when it finishes.". Both showed above "Codex changed the canvas · Undo", which kept its Undo.
  - L2: the click on "Run for $0.14" and Codex's change in the same task (applied to the tab's store as a socket sync would: a socket message can't be timed into that window from outside): the dialog came back as "Run with Codex's changes?" with the changed line and "“a” · Nano Banana 2.1 · $0.034" (was "Nano Banana 2 (3.1 Flash) · $0.067"), "Run for $0.11"; nothing sent.
  - L3: a free Video Edit run started while the dialog was open, Codex renamed a node (its notice with Undo), Run: "Nothing ran. Another run started first. Click “Run” again when it finishes." in the message slot above "Codex changed the canvas" with its Undo.
  - L5: the 228-character status came back "Reading https://example.com/ppp…" (140 with "…"), and the dot's keyboard focus at 50% zoom shows it whole, wrapped over three lines.
- Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. Console errors: the canary's only. No browser dialog. Servers stopped by PID; the state dir deleted.
- Screenshots in the scratchpad `agent-presence/`: `r8-still-setting-up-left-line.png`, `r8-focus-cancel-after-shrink.png`, `r8-still-importing.png`, `r8-still-importing-cinema.png`, `r8-reask-model-switch.png`, `r8-another-run-with-undo.png`, `r8-status-url-cut.png`.

### Open items (round 8)

- For GM: the left line for several agents ("2 nodes agents were setting up are no longer in this run.") still follows GM's "Run without the nodes agents were setting up?" pattern (round 7 open item, now under both headings).
- Known gaps unchanged (item 7 follow-up, for the PR body): the tab that hasn't heard of an agent's placeholder with "Ask before costly runs" on (browser confirm, then Nebula's dialog); free-placeholder runs still use the browser's costly-run confirm; the browser confirm's whole dollars from $10. No browser-confirm fallback added.
- L8 as before.

### Gates (round 8)

- Backend full suite: 11,024 passed, 71 skipped (13 min 14 s).
- Vitest full: 466 files, 5,919 tests. The first run, during the backend suite, had 21 failures in 10 files, all load-shaped: 15 "Test timed out", 2 `toHaveFocus` waits, 2 roles not found in time, and 2 more in the same files. Two of those files (CommandPalette, GraphFileActions) are near this round's change, so they were checked: rerun alone, all 10 files passed, 200 of 200.
- errorCopy ratchets: 14 files, 173 tests passed.
- `tsc -b` clean, lint clean.
- Build budget: 389,993 bytes raw entry, 117,453 gzip (limit 512,000 raw).
- MCP INSTRUCTIONS: 2,233 characters, unchanged.

## Round 9: review 8 and GM - Design's ruling on L-b (2026-10-26)

Justin, Q133 b, the same two rules: a paid placeholder never runs without the person's confirmation, and what runs never costs more than the person was shown; and nothing acts behind an open modal dialog. Review 8 found no high finding: one medium (Delete behind the dialog), four lows and a nit. GM - Design ruled the replay wording (L-b), replacing the coordinator's first decision ("no longer in this run" for it), and confirmed that OpenRouter / Nous Portal rows name the chosen model as the card shows it. Every fix was test-first.

### What changed and why

- **M-1: Delete and Backspace never act behind a modal dialog.** They were React Flow's own `deleteKeyCode`, which listens on the document, takes a focused button (the dialog's Cancel) as fair game and never asked whether a dialog is open. Live, review 8's LV1a deleted the selected node behind the dialog. The key is now the canvas's own (Canvas.tsx onKeyDown, `deleteKeyCode={null}`): it goes through the same guard as every canvas key (`isCanvasShortcutTarget`, false while any `aria-modal` dialog is open, wherever focus is) and keeps React Flow's rules (the bare key only, nothing inside `.nokey` or a text field, not while a run goes, one delete per press, selected nodes and wires), deleting through React Flow so `onBeforeDelete` (World Labs holds) and "Deleted the node." with Undo still apply. `onBeforeDelete` also refuses while a modal dialog is open, for any delete that would still reach React Flow. docs/MCP-SETUP.md said Delete was blocked; now it is.
- **L-a: a row names the model a model param picks, as Nebula shows it.** `modelName` (lib/placeholderRunConfirm.ts) reads, in order: a Cinema scene's model; the chosen option of a select labelled Model (`model`, `model_id`, and Meshy's `ai_model`, "GPT Image 2"); the model id a free-text model param names, as the node card shows it (OpenRouter and Nous Portal `model`, Replicate `model_id`, fal's `endpoint_id`, Krea Agent's `model`: "“Writer” · openai/gpt-4o-mini · price not listed"); else the node type. A switch is then a changed row: the open dialog redraws with the changed line, and after the click it asks again (`rowSeen` compares it). The run pill (backend `main._run_model_name`) names the model the same way (the same two key lists), so the pill and the dialog agree.
- **L-b (GM - Design, verbatim):** a replay's placeholder its agent changed after the run was saved (same type, live params differ from the saved ones; `snapshotCanvas` `changed`, compared with `sameRecipeParams` in lib/runHistory.ts, the comparison Run history already uses for "Recipe settings … changed") runs at the saved settings, so the dialog says so: heading "Replay the saved version?", body "Codex changed this node after the run was saved. The replay uses the saved settings." ("these nodes" for two or more; "The agents changed this node / these nodes …" for several agents), then the changed line if it applies, the saved versions as muted rows, the total and the button. If placeholders are still being set up, the still-setting-up heading wins and the sentence goes under its body (`savedLine`), before the left line and the changed line. Deleted or retyped placeholders keep round 8's "no longer in this run" handling; one finished with the saved settings keeps "Run with Codex's changes?".
- **L-c: the keyboard shortcuts dialog is no dead end.** A click on its text put focus on the page, where "?" no longer reached it and Escape never had. It now has the placeholder dialog's focus return (`returnFocusOnSlip`, lib/modalFocus.ts, shared by both), and while it is open Escape or "?" close it from the page too, unless another modal dialog is on top of it.
- **L-d: one guard for every document- and window-wide key listener.** `keyBlockedByModal(owner?)` (lib/canvasShortcutScope.ts): with no owner, any open modal dialog blocks the listener; with one (a dialog's or popup's own keys), only a modal dialog on top that isn't its own does: the one it sits in, or the one it holds (the tour's overlay holds its modal card) (the last `aria-modal` on the page is on top: dialogs portal to the end of the page in the order they open). Every listener checked is listed under "Keydown listeners" below. The mask painter covers the whole window, so it is now `aria-modal` with focus management (panels/maskPainterDialog.ts: focus on Close, Tab kept inside, Escape closes, a slip to the page comes back, focus returns to Paint Mask), for the painter and the shell shown while its chunk loads. The two direct writers that replaced an agent's Undo notice (a refused wire, a held delete) now go through notify's rule (`noticeLine`): beside the Undo, never over it.
- **Nit:** `safe_cut` backs off over an Indic conjunct (a virama, combining class 9, and the letter after it), so "क्ष" is never split.
- **Agent support:** docs/MCP-SETUP.md (rows naming a free-text model; the replay wording; no key at all behind a modal dialog, Delete included, nor Moodboard Studio's or the video editors'; the run pill's model name), skills/nebula/SKILL.md (a free-text model switch asks again; a replay of a placeholder changed after the save says it uses the saved settings). INSTRUCTIONS unchanged. No CLI change: confirming is the person's alone, and `nebula` shows no model names of its own.

### Keydown listeners (every document or window listener, and how each is guarded)

- Canvas.tsx (document): `isCanvasShortcutTarget` (modal check first); Delete and Backspace now here too.
- React Flow's own keys: Delete off (`deleteKeyCode={null}`, above). Space (pan), Cmd/Ctrl (zoom) and Shift (add to the selection) only change what a pointer drag, wheel or click does on the pane; a modal dialog's backdrop or overlay takes the pointer, so they can't act behind it. Not turned off: changing React Flow's key props while a key is held leaves its pressed state stuck (found while testing: a toggled `deleteKeyCode` stopped Delete working after the dialog closed; a held Cmd would have left scroll zooming).
- GraphFileActions (Cmd+S, Cmd+O) and the command palette's Cmd+K (CommandPalette, DeferredPanels via `isPaletteHotkey`): round 8's modal check.
- KeyboardShortcuts (document): opening through `isCanvasShortcutTarget`; closing with `keyBlockedByModal(card)`.
- WorkspaceRail Escape: `keyBlockedByModal()` (its old `[role="dialog"]` check missed the placeholder's `alertdialog`).
- ContextMenu, ConnectionPopup, PresetLibrary (Escape): `keyBlockedByModal(own element)`.
- Lightbox (arrows), ResultComparison (capture-phase containment), WorldPreview and MeshPreview (Escape, Tab), OnboardingOverlay (capture-phase containment): `keyBlockedByModal(own dialog)`, so a dialog on top keeps its keys.
- Moodboard Studio (MoodboardStudioView: Cmd+Z, Shift+Cmd+Z, Cmd+Y, Cmd+S, Delete; BoardCanvas: Shift+1): `isStudioShortcutTarget` checks `keyBlockedByModal()` first.
- Remotion editor (`useRemotionKeyboard`: Delete, Backspace, Cmd+D), trim editor (EditorView: Escape, Cmd+S, zoom, B, Cmd+K, Delete, M, I, O), VideoPreview (Space): `keyBlockedByModal()`.
- Not guarded, by design: AgentNodeMarkLayer (records only that a key was pressed, for its keyboard-focus rule; acts on nothing), usePanelFocus and WorldEnvironmentViewer (listen on their own element, so they hear keys only with focus inside it), and React `onKeyDown` props (element-scoped).

### Decisions not in the spec

- Delete moved into the canvas's own handler rather than toggling React Flow's key props (stuck-key problem above). Side effect: like every canvas key, Delete no longer deletes nodes while focus is in a panel that owns its keys (the Inspector, chat); React Flow's did. A text field never deleted nodes, before or now.
- Meshy's `ai_model` (labelled "Model") is named in the row and on the run pill ("GPT Image 2"), as its option label; before, both said "Meshy Text-to-Image".
- A replay's placeholder still being set up whose settings already differ from the saved ones gets the sentence too (it was changed after the save, and the saved settings run).
- Under "Replay the saved version?", a placeholder that finished with the saved settings keeps its dot and gets no sentence of its own; GM gave the body only for the changed ones.
- `keyBlockedByModal` takes the last `aria-modal` on the page as the one on top. A modal rendered inside the page's tree (the mask painter, the 3D previews) that opened after a portalled one would read as below it; none can open that way today (the portalled dialogs keep focus and cover the window).

### Tradeoffs

- The canvas's Delete follows `isCanvasShortcutTarget`'s scope, which is narrower than React Flow's (see above): one guard for every canvas key, at the cost of Delete in panels that own their keys.
- Krea's sub-model settings (Krea 2's Variant, Magnific's Engine, Topaz's enhancement and frame-interpolation models) are not named in a row: those nodes run on the Krea plan, and naming them would need a row format GM hasn't given. Listed for GM.

### Tests (first, each seen failing)

- **Backend** (`tests/test_pending_nodes_round9.py`, 9 tests): 4 failed first, 5 passed. Failed: the run pill named fal's node "“FAL”", Krea Agent "“Krea Agent”" and Meshy "“Meshy Text-to-Image”" instead of the model; `safe_cut("aक्षb", 3)` cut between the virama and ष (3, not 1). Passed before and after: OpenRouter, Nous Portal and Replicate model ids (the universal path already named them), no model yet ("“OpenRouter”"), and a 180-code-point run of conjuncts cut on whole conjuncts (kept as a guard for the status path; it passed on the old code too).
- **Frontend:** 51 failed first, 5 passed, plus 1 added after.
  - `lib/placeholderRunConfirm.round9.test.ts` (16): 15 failed (OpenRouter, Nous Portal, Replicate, fal and Krea Agent rows read the node type; Meshy read the type; no "Replay the saved version?", no `savedLine` in any form); 1 passed (no model chosen: the node type).
  - `graphStore.placeholderRuns.round9.test.ts` (7): 7 failed (an OpenRouter switch after the click ran unasked; a switch while open didn't redraw; the replay said "Run with Codex's changes?"; no `savedLine` from the first dialog or after; a refused wire and a held delete replaced Codex's Undo).
  - `canvasDeleteBehindModal.round9.test.tsx` (the real Canvas with React Flow, 6): 5 failed (Backspace and Delete on Cancel and on the page deleted the node; Delete after the dialog closed — first failing behind the dialog, then, with toggled key props, failing to delete at all: the stuck key that decided the design); 1 passed (control: no dialog, Backspace deletes). Added after the fix and passing: a selected wire alone goes, a text field keeps Backspace, a repeat doesn't delete.
  - `components/KeyboardShortcuts.round9.test.tsx` (4): 3 failed (focus stayed on the page after a click on its text; Escape and "?" on the page left it open); 1 passed (another modal dialog on top keeps it open on Escape).
  - `keysBehindModal.round9.test.tsx` (16): 14 failed (no shared guard; the rail closed its drawer behind the alertdialog; the Studio's undo, redo, save, delete and fit acted; the Remotion editor deleted and duplicated; the trim editor muted, trimmed, cut, removed a clip and exited; Space played; the context menu closed behind the dialog); 2 passed (controls with no dialog).
  - `components/MaskPainterModal.round9.test.tsx` (5): 5 failed (no `aria-modal`, canvas keys acted, no initial focus, no Tab loop, no focus return).
  - `PlaceholderRunDialog.round9.test.tsx` (2): 2 failed (no replay sentence in the order body, sentence, left line, changed line, rows; a change to it alone wasn't a change in place).
- Review 8's probes, rerun on this code: P1 asks twice and runs nothing; P1b redraws once (the yes then runs what it showed, the new model); P2 reads "Replay the saved version?" with the saved row ($0.10) and sends the saved params; K2 closes on "?" and on Escape from the page. K1 builds a bare React Flow with its own `deleteKeyCode` (not Nebula's canvas), so it still deletes there; the real-canvas test above covers it. `probe_cut.py`: the conjunct line now ends on whole conjuncts.

### Live check (1280x800)

- Isolated backend on 8795 (temp HOME and every NEBULA_* root under scratch, no keys) and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`); `/api/health` through Vite matched. Codex verified (an app token). No key was set, so nothing paid could run. Run was clicked in one dialog (the OpenRouter re-ask: the run changed in the same task, so the yes sent nothing). Run requests: none.
- 21 of 21 checks passed (script `agent-presence/live-r9.mjs`). The first run passed 20 of 21: the script's "Delete works again after the dialog closes" step ran right after Cmd+A had selected all three nodes, so Delete deleted three ("Deleted 3 nodes.", Undo put them back): the key worked, the script's selection was wrong. Fixed in the script (select n1 alone first); the second run passed it ("Deleted the node.", Cmd+Z back).
  - Review 8's LV1a, as it ran there: with focus on Cancel, Backspace and then Delete left n1 on the canvas and selected, the dialog open, the notice still "Codex changed the canvas" (review 8: `{"nodes":false,"undo":"Deleted the node."}`). Every other key it tried on Cancel (Cmd+Enter, Cmd+A, Cmd+Z, Shift+Cmd+Z, Cmd+K, Cmd+O, Cmd+S, Cmd+D, Cmd+=, Shift+1, "?", F2, ArrowRight) changed nothing behind it. On the page (blur, then the key in the same task): Cmd+Enter, Cmd+A, Delete and Backspace changed nothing, and focus came back to Cancel. After it closed: no `aria-modal` left, Cmd+A selected all three, Delete deleted n1 and Cmd+Z put it back.
  - Review 8's LV3, as it ran there: "?" opened Keyboard shortcuts; after a click on a group heading focus was on Close (review 8: BODY), and "?" closed it (review 8: stayed open). Opened again, a click on a shortcut's name, then Escape closed it.
  - L-a: "“Writer” · openai/gpt-4o-mini · price not listed"; Codex switched it while open: the row redrew to anthropic/claude-opus-4.1 with the changed line; the click and a switch to google/gemini-2.5-pro in the same task: asked again over the new model, nothing sent.
  - L-b: a saved run of “Wide”, then Codex changed “Hero still”'s aspect ratio: the replay's first dialog read "Run 2 nodes Codex is still setting up?", the body, then "Codex changed this node after the run was saved. The replay uses the saved settings."; Codex finished both: "Replay the saved version?", the sentence, the changed line, “Hero still” muted with no dot, “Grade” (finished unchanged) with its dot, "Run for $0.21". A second replay whose placeholder Codex deleted: "Run without the node Codex was setting up?" / "It's no longer in this run.", “Plate” muted. Both cancelled; nothing sent.
- Blocked requests: 2, both the canaries; 0 toward 8000-8010 or 5173. Console errors: the canary's only. No browser dialog. Servers stopped by PID; the state dir deleted.
- Screenshots in the scratchpad `agent-presence/`: `r9-backspace-on-cancel.png`, `r9-shortcuts-after-text-click.png`, `r9-shortcuts-escape-closed.png`, `r9-openrouter-row.png`, `r9-openrouter-reask.png`, `r9-replay-still-setting-up.png`, `r9-replay-saved-version.png`, `r9-replay-left-run.png`.

### Open items (round 9)

- For GM: Krea's sub-model settings (Krea 2's Variant, Magnific's Engine, Topaz's enhancement and frame-interpolation models) aren't named in a row, so switching one while the dialog is open doesn't redraw or ask again (they run on the Krea plan; no dollar changes). Naming them needs a row format.
- For GM: under "Replay the saved version?", a placeholder finished with the saved settings has no sentence of its own (its row keeps its dot).
- For GM (from round 7, unchanged): the left line for several agents.
- Known gaps unchanged (item 7 follow-up, for the PR body): the tab that hasn't heard of an agent's placeholder with "Ask before costly runs" on (browser confirm, then Nebula's dialog); free-placeholder runs still use the browser's costly-run confirm; the browser confirm's whole dollars from $10.
- L8 as before.

### Surprise from the full suite

- The full vitest run caught a regression of my own: the onboarding tour stopped containing keys when its card had lost focus (`OnboardingOverlay.test.tsx`, "captures background keyboard events even when the browser has dropped card focus": Ctrl+Enter on the page was not prevented). The tour's listener passes its overlay as the owner, and the overlay holds the `aria-modal` card instead of sitting inside it, so the first `keyBlockedByModal` took the tour's own card for a dialog over it. The helper now counts a modal dialog the owner holds as its own too. Test first: `keysBehindModal.round9.test.tsx`, "an owner that holds its own modal dialog … keeps its keys until one opens over it", failed (`expected true to be false`), then passed with the onboarding file (14 of 14). Every other owner (Keyboard shortcuts, Lightbox, ResultComparison, World and Mesh previews) is the `aria-modal` element itself; PresetLibrary and the menus aren't modal.

### Gates (round 9)

- Backend full suite: 11,033 passed, 71 skipped (20 min 30 s, under machine load ~30).
- Vitest full suite (run beside the backend suite, load average 27-41 from other sessions): 473 files, 5,976 tests: 416 files passed, 57 failed (144 tests; 124 "Test timed out" lines). Rerun of the 57 together: 22 passed, 35 failed (116 tests, 90 timeouts, the rest `findBy`/`waitFor` misses), one of them the onboarding regression above (fixed). The other 34 run one file at a time (`--no-file-parallelism`): 34 files, 545 tests passed. After the fix: `keysBehindModal.round9` 17 of 17, OnboardingOverlay 14 of 14.
- errorCopy ratchets: 14 files, 173 tests passed.
- tsc: clean. Lint: clean (after the last change).
- Build budget: 391,266 bytes raw / 117,762 gzip (limit 512,000).
- INSTRUCTIONS: 2,233 characters (2,957 with the Commons guide), unchanged.


## Round 10: review 9 and GM - Design's round-10 rulings (2026-10-26)

### What changed and why

- **One way to render a modal (M-1, M-2, nit b).** New `components/ModalPortal.tsx`; all 15 `aria-modal="true"` dialogs render through it. It renders onto `document.body` inside a `div.modal-portal.nokey[data-modal-layer]` (`display: contents`).
  - On the body, a modal covers the window wherever it opened from.
  - `nokey`: React Flow ignores keys coming from inside it. Before this, a modal opened from a node card (the Mesh and World previews) passed its keys up to the node through React's portal bubbling: arrows moved the node, Enter and Space selected it, Escape deselected it.
  - Clicks, double clicks and context menus stop at the wrapper, so the node behind doesn't select itself or open its menu.
  - `data-modal-layer` records the order modals opened in, so the guard knows which one is on top.
  - A test (`modalStructure.round10.test.tsx`) lists every `aria-modal` file and fails if any of them still calls `createPortal` itself.
- **Mask painter (M-2).** It rendered inside the Inspector popover. Under Slava restraint, the popover's backdrop-filter made it the containing block of the painter's fixed overlay, so the "modal" was the popover's 260x300 box. The painter and its loading shell now go through ModalPortal (`DeferredPanels.tsx`).
- **Command palette (L-1).** It is now a labelled modal dialog. Its label, "Search commands and nodes", is copy that already exists: the rail button and the shortcuts list use it.
  - Tab stays inside, and focus that slips out comes back to the search field (`returnFocusOnSlip`).
  - Cmd+K still closes it: `isPaletteHotkey` uses `keyBlockedByModal(palette)`, so the palette's own key passes while a modal on top of it blocks.
- **Delete is one undo step (L-4).** The canvas's Delete and Backspace now call a new `deleteCanvasElements` in the graph store. It takes one undo step for the selected nodes, their wires and any other selected wires.
  - Before, the key went through React Flow's `deleteElements`, which removed wires and nodes as two steps.
  - `onNodesChange` and `onEdgesChange` are split into module functions so the delete can share one step.
  - Every other delete path was checked: see the list below.
- **Model switch hidden by a label (L-3).** A row now carries `modelKey`, the raw model name, even when it hides the model because it equals the node's label. The "seen" key and the unpriced key read it, so a switch asks again.
- **The modal guard (nits a, b).** `canvasShortcutScope.ts` now counts only shown dialogs: none under `[hidden]` or `[inert]`, none with `display: none` (`checkVisibility` where the browser has it).
  - The dialog on top is the last one opened, by `data-modal-layer`.
  - A dialog without a layer counts as above anything before it in page order. That keeps a raw `aria-modal` element appended later on top, which the round-9 KeyboardShortcuts test relies on.
- **Focus isolation.** ResultComparison and the onboarding tour now leave a modal opened over them alone:
  - their sibling isolation skips their own portal wrapper and later layers (`sitsBehind` in `modalFocus.ts`);
  - their focus trap stands down while a modal sits on top (`keyBlockedByModal`).
- **Provider switcher popover.** Also portalled from inside the node card. It gets `nokey`, so arrows in its menu don't move the node.
- **CommonsPrompt.** It is portalled now, so it left `.commons-view`, which defined `--commons-spring`. Its own rule now defines that token, and it keeps its spring.
- **GM r10 item 1.** The replay sentence names the changed nodes, verbatim:
  - one: "Codex changed “Grade” …";
  - two: "“Grade” and “Wide”";
  - three or more: "3 nodes";
  - several agents: "The agents changed …".
  
  It applies under "Replay the saved version?" and as the still-setting-up `savedLine`. The names are the rows' names (Cinema names included), in the rows' order.
- **GM r10 item 2.** A Krea node's sub-model setting is named in its row, using the card's labels, even at its default:
  - "“Hero” · Krea 2 · Variant: Medium · on your Krea plan";
  - Magnific "Engine: …", Topaz "Model: …", krea-node-app "Version: …".
  
  The setting is part of the row's seen key, so a switch while the dialog is open redraws it, and a switch in the moment of the click asks again. These settings are no longer taken for the model name.
- **Krea Style Search (nit c).** Its free-text `model` is a search filter. Neither the row nor the run pill presents it as the model (`NOT_A_MODEL` in the frontend, `_NOT_A_MODEL` in `main.py`).
- **The 80-character cut (nit d).** The JS cut now counts code points (`Array.from`), as Python does, so an astral character is never cut in half.
- **Docs.** `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md` now cover:
  - the Krea setting rows and Style Search;
  - the named replay sentence;
  - the seen key ("same node, model, Krea setting and price");
  - every modal covering the window and containing clicks and keys;
  - `remove_from_canvas` and the person's delete each being one undo step with the connections;
  - the L-2 sentence.

### Decisions not in the spec

- **L-2 is kept (the coordinator's decision).** Delete and Backspace act only with focus on the canvas or its bars, never in the Inspector, the chat or behind a modal. Panels own their keys, like every other canvas shortcut. MCP-SETUP says so.
- **Keys are not stopped at a modal's root; only `nokey` is added.** React's synthetic `stopPropagation` would also stop the native event at the portal container (body), before the window and document listeners the modals themselves use (Escape, Tab, "?"). `nokey` is the scoped switch React Flow provides. Clicks, double clicks and context menus are stopped, because no window or document listener reads those from inside a modal.
- **Names follow the rows' order.** Live, the target “Wide” was added before “Grade”, so the dialog read "Codex changed “Wide” and “Grade” …" over rows listing “Wide” first. GM's example order is "“Grade” and “Wide”"; the sentence follows the list under it.
- **Label choices for Topaz and krea-node-app.**
  - Topaz video names its two settings by the card's labels: "Enhancement model: …" and "Frame interpolation model: …". GM wrote "Model: …", which is the single-setting Topaz image node's card label.
  - krea-node-app uses GM's "Version", although its card label is "Node app version ID".
- **The backend run pill is unchanged except for Style Search.** For Topaz on Krea it still names the chosen model option (for example "Redefine") as the model. The row splits the same information into node type and setting.

### Tradeoffs

- The selection toolbar's action slot is also portalled from inside the node, and keys from it still bubble to React Flow (arrows move the node with focus on a toolbar button). Adding `nokey` there would also change Delete with focus on the toolbar, so it stays as it was and is listed below.
- A modal with no `data-modal-layer` (none in the app; only a raw element in a test) is taken as on top of anything before it in page order.

### Tests (first, each seen failing)

- `lib/placeholderRunConfirm.round10.test.ts`: 16 tests, all 16 failed first:
  - GM1: the sentence still read "this node / these nodes";
  - GM2: no `setting` field, so Krea rows were unnamed;
  - L-3: no `modelKey`;
  - nit c: the Style Search row read "flux";
  - nit d: `.slice` cut a surrogate pair.
- `graphStore.placeholderRuns.round10.test.ts`: 5 tests, all 5 failed first:
  - a model switch on a node labelled with its model id ran unasked;
  - the Krea row had no setting;
  - a Variant switch ran unasked and didn't redraw;
  - the replay `savedLine` read "this node".
- `canvasShortcutScope.round10.test.ts`: 4 tests, all 4 failed first:
  - nit a (3): a dialog under `hidden`, under `inert` and under `display: none` still blocked;
  - nit b (1): an inline modal opened later read as below a portalled one.
- `modalsInsideNodes.round10.test.tsx`: the real React Flow canvas with the Mesh and World previews, 16 tests, all 16 failed first:
  - arrows moved the node (for example to 905,160);
  - Enter and Space selected it, and Escape deselected it;
  - a context menu inside the preview reached `onNodeContextMenu`.
- `modalStructure.round10.test.tsx`: the inventory of 15 files, plus ModalPortal's behaviour. It failed first on the import, because ModalPortal didn't exist.
- `commandPaletteModal.round10.test.tsx`: the real Canvas with the palette, 5 tests. 4 failed first:
  - no dialog role or label;
  - focus wasn't returned after a click on a group label;
  - Backspace on the page deleted node "a" (`['b']` left);
  - Tab walked out.
  
  "Cmd+K still closes it" passed before, as a control.
- `canvasDeleteUndo.round10.test.tsx`: 8 tests. 3 failed first: the Delete key with canvas-only ids, the Delete key with n1/n2 ids, and a node plus a separate selected wire each made 2 undo steps. 5 controls passed before and after: a wire alone, `deleteSelected`, `deleteNode` (context menu and Inspector), and an agent's `remove_from_canvas` arriving as one graphSync.
- `components/MaskPainterPortal.round10.test.tsx`: 2 tests, both failed first: the loading shell and the painter both rendered inside the popover.
- `components/ProviderSwitcher.test.tsx`: added one test, the popover carries `nokey`, which failed first.
- Backend `tests/test_pending_nodes_round10.py`: 2 tests.
  - The Style Search test failed first: the pill named "flux".
  - The 80-code-point test passed first: Python already counts code points. It stays as the other half of nit d.
- Updated to the new wording and fields: the round-9 placeholder tests (the named sentences, the `SAVED` constant) and `placeholderRunConfirm.test.ts` (rows carry `modelKey` and `setting`).

### Every modal

The 15 `aria-modal="true"` dialogs below render through ModalPortal: on `document.body`, `nokey`, clicks contained, layered. The mask painter's shell and painter count as one.

- PlaceholderRunDialog (alertdialog)
- PromptDialog
- KeyboardShortcuts
- CommandPalette (new modal)
- ResultComparison
- ModelPicker
- Lightbox
- MeshPreview
- WorldPreview
- the mask painter (`DeferredPanels` shell + `panels/MaskPainterModal`)
- CommonsPrompt
- UnsavedEditsNotice (alertdialog)
- PersonalAgentWarning
- OnboardingOverlay

Panels with `role="dialog"` that aren't modal are unchanged: Settings, ChatPanel, AgentQuestionsForm, AgentNotesList, ConnectionPopup, PresetLibrary, ChatModelPicker, ProjectSizePanel, the final-export popovers, CommonsLeavePopover (`aria-modal="false"`) and CommonsCloseBatch.

### Every delete path and its undo step

- **Delete or Backspace on the canvas:** `deleteCanvasElements`, one step for the nodes, their wires and other selected wires.
- **Selection toolbar:** `deleteSelected` → `onNodesChange`, one step.
- **Context menu and Inspector:** `deleteNode`, one step.
- **A generation:** `deleteGeneration`, one step.
- **An agent's `remove_from_canvas`:** one `graphSync` per apply, so one foreign step with the node and its wires.

All are tested in `canvasDeleteUndo.round10`.

### Live check (1280x800 and 1440x900)

- **Setup.**
  - Isolated backend on 8795 (temp HOME, every NEBULA_* root under scratch, no keys) and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`). `/api/health` through Vite matched.
  - Codex and Claude were verified agents (app tokens). No key was set, so nothing paid could run.
  - Run was clicked once, in the Krea re-ask: the run changed in the same task, so the yes sent nothing. Run requests: none.
- **The skins.** The app has one skin, Slava restraint (`DEFAULT_SKIN`), so "the default skin" and "slava-restraint" are the same. The painter was also checked with that skin's body class removed (the base styles).
- **Review 9's probes, adapted to 8795/5795** (`agent-presence/r10probes/`): live-rv9 passed 22 of 22, live-rv9b 4 of 4.
  - LA1 to LA7 passed.
  - LA6 (Delete with focus on an Inspector button) deleted nothing, as kept for L-2.
  - LB1: Backspace with the palette open left the node; focus stayed in the search field.
  - LC1 to LC7 passed.
  - LD1: arrows with focus on the Mesh preview's Close left the node at 900,160 (review 9: it moved to 920,165).
  - LD2: Escape closed the preview and the node stayed selected (review 9: deselected).
  - LE1 passed.
  - LF: one Cmd+Z brought back the node and its wire together. The second Cmd+Z undid Codex's earlier edit, as expected.
  - LG: the painter is 0,0,1440,900 and 0,0,1280,800, not inside the popover. A click at a node's place hit the painter, and Delete deleted nothing (review 9: the overlay was the popover's 260x300 box).
- **Round 10's own script** (`agent-presence/live-r10.mjs`): 33 of 33.
  - Delete on a node with a wire added one undo step: the stack went from 1 (Codex's own foreign step from adding the pair) to 2. One Cmd+Z put back the node and its wire.
  - The palette: a labelled modal on the body; Backspace and Delete with focus on the page left the canvas.
  - The Mesh preview is on the body. Arrows, then Enter and Space on the dialog, left the node in place and selected; Escape closed it with the node still selected.
  - The painter covered the window at both sizes under Slava restraint and under the base styles, with Close in view and every probe point hitting the painter.
  - The replay sentence, from real agent edits:
    - one: "Codex changed “Grade”";
    - two: "Codex changed “Wide” and “Grade”";
    - three: "Codex changed 3 nodes";
    - several agents: "The agents changed “Wide” and “Grade”" and "The agents changed 3 nodes".
    
    Each read the same under the still-setting-up heading and under "Replay the saved version?". All were cancelled, and nothing was sent.
  - Krea 2:
    - "“Hero” · Krea 2 · Variant: Medium · on your Krea plan" showed at the default.
    - Codex's switch to Large while the dialog was open redrew the row with the changed line.
    - The click and a switch back in the same task asked again ("Run with Codex's changes?"), and nothing was sent.
    - The Krea placeholder is Codex's in the tab only, as in rounds 5 and 9: agents can't choose plan billing.
- **Blocked requests and console.** Every run blocked 2 requests, both the canaries; 0 went toward 8000-8010 or 5173.
  - Undo toasts were dismissed before every screenshot (0 shown).
  - The Mesh step's fake output (`none.glb`) makes the project save answer 400 ("Save failed · Retry" in the header). That is the probe's doing, as in review 9's run.
  - Servers were stopped by PID and the state dirs deleted.
- **Screenshots:** in the scratchpad `agent-presence/`, the `r10-*.png` files:
  - replay: one, two, three, agents and agents-three, each still-setting-up and saved, at 1440 and 1280;
  - `krea-row`, `krea-redrawn`, `krea-reask`;
  - `painter-{slava,base}-{1440,1280}`;
  - `palette-backspace`;
  - `mesh-arrows`;
  - `delete-1-before`, `delete-2-deleted`, `delete-3-one-undo`.

### Open items (round 10)

- **For GM:**
  - Topaz video's two settings are named by their card labels ("Enhancement model", "Frame interpolation model"), not "Model".
  - krea-node-app uses "Version", not its card label "Node app version ID".
  - Magnific Precise's "Flavor" and Topaz's "Grain model" aren't named.
  - Topaz Standard with no model chosen shows no setting.
  - The replay sentence names nodes in the rows' order; GM's example had the upstream node first.
- **The run pill** still names Topaz-on-Krea by its model option, so the pill and the row split it differently.
- **The selection toolbar's action slot** still passes keys to React Flow (see Tradeoffs).
- **For GM, from round 7, unchanged:** the left line for several agents.
- **Known gaps, unchanged** (item 7 follow-up, for the PR body):
  - the tab that hasn't heard of an agent's placeholder, with "Ask before costly runs" on, shows the browser confirm and then Nebula's dialog;
  - free-placeholder runs still use the browser's costly-run confirm;
  - the browser confirm shows whole dollars from $10.
- L8 as before.

### Gates (round 10)

- Backend full suite: 11,035 passed, 71 skipped (16 min 16 s).
- Vitest full suite, run beside the backend suite: 481 files and 6,053 tests. 464 files passed and 17 failed (43 tests, 35 of them "Test timed out").
  - The 17 rerun one file at a time (`--no-file-parallelism`): 17 files, 289 tests passed.
- Lint, first run: 2 errors, both in my own new test (`modalsInsideNodes.round10`, `react-hooks/globals`: its harness reassigned module variables during render). The harness now assigns them in an effect. Lint is clean after that, and the file passes 16 of 16.
- errorCopy ratchets: 14 files, 173 tests passed.
- tsc: clean.
- Build budget: 392,133 bytes raw / 118,097 gzip (limit 512,000).
- INSTRUCTIONS: 2,233 characters (2,957 with the Commons guide), unchanged (`mcp_server.py` untouched).

## Round 11: review 10 and GM - Design's round-11 rulings (2026-10-26)

Branch feat/agent-presence, base main (head de9909bd before this round).

### What changed and why

- **M-1, the Commons prompt lost its styling on the body.** ModalPortal moved Commons' prompt ("New collection…", "Why?", "Label this region", "Rename region") out of `.commons-view`, and its field, button-focus and type rules were scoped to that view. On the body its field became the browser's white box (no padding, 11px uppercase meta ink from a looser rule, black focus ring).
  - Fix: a scope class the prompt carries itself. `body.app-slava-restraint .commons-scope` holds the ink, type and spring that `.commons-view` used to set (`styles/commons.css`); the field, focus-visible, textarea and range rules now select `.commons-scope` instead of `.commons-view`. `CommonsView` and `CommonsPrompt` both carry the class. No rule is duplicated.
  - `.commons-view` keeps only its own layout, its detail width and its background.
- **M-1, every portalled modal checked.** 15 modals render through ModalPortal. A static scan of every stylesheet (no rule targets a body child, a sibling of a modal, `.nokey` or the wrapper beyond `display: contents` and the `*` reset) and a live sweep per modal (below) compare the rules and computed styles where each renders now with where it rendered before the move.
  - 12 were already portalled to the body before ModalPortal; only the `display: contents` wrapper is new.
  - 2 really moved: the Commons prompt (from `.commons-view`, fixed above) and the mask painter (from the Inspector's `.inspector__section`; its geometry changed on purpose in round 10).
  - PlaceholderRunDialog was new on this branch and always on the body.
- **L-1, the palette with focus on an item.** Escape, ArrowDown and ArrowUp are handled on the dialog root when focus is on an item or on Clear search (`CommandPalette.tsx` `onDialogKeyDown`), not only in the search field. Escape in agent mode goes back to commands; otherwise it closes. Arrows move focus and the active row together and stop at the ends, passing over disabled rows. An item that gets focus (Tab) becomes the active row.
- **L-2, Cmd+Z while a delete is on its way.** A generic hold at the undo-step level (`graphStore.ts`, `holdStep` / `settleStep` / `holdsHistory`).
  - A step whose backend request is still on its way is "in flight". Cmd+Z on top of it waits (and later presses queue in order) until the answer is on the canvas, then replays. A delete that went through is then undone by the usual restore (`POST /api/graph/restore`), so Nebula's graph and the canvas match, and Redo deletes again.
  - A refused or cancelled step drops the first held undo, so the press doesn't undo an earlier step the person didn't mean.
  - A 15 s limit releases a stuck hold.
  - Callers end their step with the new `endUndoStep` (in a `finally`) or cancel it with `cancelUndoStep`; a test reads every file that begins a step and checks it.
- **Delete paths covered:** Delete/Backspace on the canvas (`deleteCanvasElements`), the toolbar's delete (`deleteSelected`), the context menu and Inspector (`deleteNode`), `deleteGeneration`, the toolbar's Clear canvas, and chat `/clear`. Chat `/clear` now also takes its canvas side locally (`clearBackendNodes`: the CLI nodes and their wires go, local nodes stay), as Toolbar's clear did, so the step it begins holds a real change.
  - Also every other `beginUndoStep` caller: file drop, chat upload, proposal accept, and the OpenRouter and Replicate model configures.
  - remove_from_canvas (an agent's delete) has no in-flight window in the tab: it arrives as one graphSync, one foreign step (round 10's test covers it).
- **GM r11, the replay sentence.** Names up to three nodes ("Codex changed “Wide”, “Hero still” and “Grade” after the run was saved. …"), a count from four ("Codex changed 4 nodes …"); the agents form follows the same rule. Names are sorted by row order explicitly; the price footnotes keep their count from 3.
- **GM r11 item 4.** "Grain model" is named only while Grain is on (`KREA_SETTING_WHEN`); Flavor is not named.
- **GM r11 item 5.** A model-picking setting with nothing chosen reads "Model: default" (Topaz Standard is the only such node today).
- **GM r11 item 6.** "the agents" in the heading and the left line: "Run 3 nodes the agents are still setting up?", "Run without the nodes the agents were setting up?", "2 nodes the agents were setting up are no longer in this run." The body and "The agents changed…" are unchanged.
- **GM r11 items 1-3:** row order kept, Topaz video keeps its card labels, krea-node-app keeps "Version". No code change.
- **Docs:** `docs/MCP-SETUP.md` (the in-flight Cmd+Z on remove_from_canvas, the three-name and count rule, the full Krea setting list including Training Model, Grain model and the Topaz video nodes by name, "Model: default", the agents wording) and `skills/nebula/SKILL.md` (the setting list, "up to three; a count from four"). MCP tools and the CLI are unchanged (nothing an agent can call changed); INSTRUCTIONS unchanged.

### Decisions and tradeoffs

- **The hold, not a per-path patch.** One mechanism for every step with a request in flight, rather than special-casing the delete. Cost: an undo pressed in that window waits for the answer (normally well under a second; at most 15 s).
- **The row-naming inventory (review 10):**
  - Meshy's Mesh Type ("Smart Topology (Meshy T2)") is not named: it reads like a model, so it's a question for GM.
  - krea-node-app with no version is refused (the backend never picks one), so no "Version: default".
  - Krea Style Train's "Training Model" was already named.
- **The test-side cascade (`tests/helpers/cssCascade.ts`).** jsdom's `getComputedStyle` drops shorthands that hold a `var()` and mis-resolves `font: inherit`, so the modal-style test reads the app's stylesheets with postcss, matches each selector, and keeps the winning declaration per state and property.

### Tests (each failed first on the current code)

- `tests/lib/placeholderRunConfirm.round11.test.ts`, 18 tests. 9 failed first: the three-name sentences (got "3 nodes"), the agents heading and left line (got "nodes agents"), Grain model (not named), "Model: default" (no setting). 9 controls passed.
- `tests/commandPaletteKeys.round11.test.tsx`, 7 tests. 5 failed first: Escape on an item and on Clear search (the palette stayed open), Tab made no item active, the arrows on an item did nothing, passing over a disabled item. 2 controls passed.
- `tests/canvasDeleteInFlightUndo.round11.test.tsx`, 13 tests. 12 failed first: with the delete held, Cmd+Z left nodes [n1] with stacks undo 1 / redo 1 and no restore sent; `endUndoStep` and `clearBackendNodes` were not functions. 1 control passed (a refused delete with a separate wire).
- `tests/undoStepEnds.round11.test.ts`, 6 tests. 5 failed first: no caller ended its step.
- `tests/modalStyles.round11.test.tsx`, 4 tests. 3 failed first, on HEAD's CSS (input padding 0, ink `--sr-ink-meta`, 11px uppercase, no Slava border, background or focus ring). The spring control passed.
- Updated to the new wording or the hold: `placeholderRunConfirm.round10` (the count case uses 4 nodes), `round7`, `placeholderRunConfirm.test`, `PlaceholderRunDialog.test`, `graphStore.agentUndo` (an undo before `endUndoStep` waits, then applies), and the mocks in `canvasProposalsStore.test`, `ProposalBar.test` and `components/Toolbar.test` (which now also checks the step is ended on success and on refusal).

### Live check (round 11)

- Isolated backend on 8795 and Vite on 5795, no keys, 8000-8010 and 5173 blocked. 45 of 45 checks passed. 6 attempts were blocked: the 2 canaries, plus 4 ORB blocks of a missing thumbnail on the isolated backend (the World preview fixture). None went toward Justin's ports.
- **L-2:** with Nebula's delete answer held 2.5 s, Delete then Cmd+Z brought back the node and its wire. Stacks were undo 1 / redo 1 (as before the delete), Nebula's graph had the node and the wire, and the notice read "Restored the node."
- **L-1:** Tab to an item, then the arrows moved focus and the active row together (Run graph → Save graph → Run graph). Escape with focus on the item closed the palette.
- **GM r11:**
  - the three-name and four-count replay sentences, Codex and agents forms, still setting up and saved;
  - "the agents" heading, left line and "Run without…";
  - "Topaz Standard (Krea) · Model: default" and "Topaz Bloom 2 (Krea) · Grain model: gaussian".
  - Cancel sent nothing in every case.
- **The modal sweep, at 1440:** for each modal, the rules that match every element and the full computed style (with ::before, ::after and ::placeholder), measured where it renders now and where it rendered before the move. The subtree is moved there and back, and both placements are measured right after a move, with focus put back and entry animations finished.
  - All 15 have 0 rules lost, 0 rules gained and 0 style differences.
  - Mask painter: 40 geometry values differ, as intended in round 10. Two inherited values have no effect in the painter: the Inspector's scrollbar colour (nothing in the painter scrolls) and `--scroll-fade-size` (no rule in it reads it).
  - Commons prompt: the view's `--commons-detail-w` differs, and no rule in the prompt reads it.
  - The real Commons field on the body matches review 10's in-view measurement: rgba(0,0,0,.3) background, 0.92 ink, 1px edge, 12px Inter, 5px 7px padding. Focused, it shows the Slava 2px ring.
- **Review 10's probes, on 8795/5795:**
  - rv9: 22 of 22.
  - rv9b: 4 of 4.
  - rv9c: 23 of 23.
  - rv9d: 6 of 6.
  - rv10rv: 10 of 12, the same two failures as in review 10's own run. P1a types "fit", which leaves one item, so the arrows can't move. P1e expects a graph selection, but Enter focuses the node in the Inspector (rv10rv2 Q1b passes). Its mesh-clicks section can't find the preview, as in review 10; rv9c's RV10-Q2 covers it and passes.
  - rv10rv2: 7 of 8. Q3a builds the prompt's old markup by hand, without `commons-scope`. Q3b, the real prompt, is now the Slava field: in review 10 it was the white Arial box.
  - The first runs of rv9, rv9b and rv9c, beside the full vitest suite, had "Promise was collected" section errors. Rerun with the machine quieter, they are clean.
- **Screenshots:** under `scratchpad/agent-presence/`:
  - `r11-inflight-{1-before,2-undo-pressed-while-deleting,3-restored}-1440`;
  - `r11-palette-{1-focus-on-item,2-closed-on-escape}-1440`;
  - `r11-replay-{three,four,agents-three,agents-four}-{still-setting-up,saved}-{1440,1280}`;
  - `r11-the-agents-{heading,left-line,run-without}-{1440,1280}`;
  - `r11-topaz-rows-{1440,1280}`;
  - `r11-modal-<name>-1440` for every modal, and `r11-modal-CommonsPrompt-{focused,unfocused}-1440` plus `unfocused-1280`.

### Open items (round 11)

- **For GM:**
  - Three lines still read "nodes agents", not "the agents": the skip line ("Skipped 3 nodes agents are still setting up."), the included line ("Includes 3 nodes agents …") and the backend's refusal ("…2 paid nodes agents are still setting up…"). r11 ruled only the heading and the left line.
  - Meshy's Mesh Type ("Smart Topology (Meshy T2)"): is it a model setting to name?
  - A changed node with no row (a free one) is named after the rowed names. Is that the right place?
- **The held undo for uploads and drops:** their node arrives only with the echo sync. If the HTTP answer lands before the echo, a held undo finds nothing to undo, and the step ends as a no-op. Not seen live.
  - *Corrected in round 12 (review 11, L-2):* this understated it. The press was not a no-op: the undo was lost, a stray redo stayed, and Redo then deleted the upload on the canvas and in Nebula's graph (probe H7). Round 12 fixes it: such a step settles only once both its answer and its echo are in.
- **The UnsavedEditsNotice sweep** used a stand-in reason line (no real project state).
- **From round 10, unchanged:**
  - the run pill names Topaz-on-Krea by its model option;
  - the selection toolbar's action slot passes keys to React Flow.
- **Known gaps, unchanged** (item 7 follow-up, for the PR body):
  - the tab that hasn't heard of an agent's placeholder, with "Ask before costly runs" on, shows the browser confirm and then Nebula's dialog;
  - free-placeholder runs still use the browser's costly-run confirm;
  - the browser confirm shows whole dollars from $10.

### Gates (round 11)

- Backend full suite: 11,034 passed, 71 skipped, 1 failed (19 min 10 s), run beside the vitest suite and the live checks. The failure was `test_acp_session.py::test_opening_a_gemini_agent_never_blocks_the_event_loop`, a timing test; it passes alone. The backend is untouched this round.
- Vitest full suite, run beside the review probes: 486 files and 6,101 tests. 444 files passed and 42 failed (105 tests, 93 of them "Test timed out").
  - The 42 rerun one file at a time (`--no-file-parallelism`): 42 files, 629 tests passed.
- errorCopy ratchets: 14 files, 173 tests passed.
- tsc: clean.
- Lint: clean (the inline-style and Slava-scope guards passed).
- Build budget: 392,261 bytes raw / 118,126 gzip (limit 512,000).
- INSTRUCTIONS: 2,233 characters (2,957 with the Commons guide), unchanged.

## Round 12: review 11 and GM - Design's round-12 rulings (2026-10-26)

Branch feat/agent-presence, base main (head 942a375c before this round).

### What changed and why

- **M-1, a held Cmd+Z is bound to its step.** Round 11's hold replayed a held press against whatever was on top when the step settled, so an agent's or the person's newer edit could be undone instead (H2 upload, H8 model configure, H9 accept, live S1 clear). Now each held press records its target (`graphStore.ts` `PressTarget`, ~3145): the undo entry it was pressed for, or the inverse of an earlier held press (`{ inverseOf }`).
  - On settle (`runHeldPresses`, ~3275), a press applies only to its own step or to a delete's re-pushed successor of that step (`stepSuccessors`, recorded in `applyCanvasNodeChanges` ~2049).
  - If a newer step is on top, every held press is dropped and GM's notice shows: "Nothing was undone. Your last change was still saving." (`lib/deleteNotice.ts` `DROPPED_UNDO_TEXT`).
  - A step that was cancelled or refused drops its press silently: the failure notice already says what happened.
- **M-1 root cause, a clear covers only the ids it sent.** `clearGraph` (~7017) and `clearBackendNodes` (~7052) remove only nodes that the step's snapshot holds and that did not arrive while it was in flight (`clearedBy`, `arrivedSince` filled by `noteSyncArrivals` in both graphSync branches). A node an agent added mid-clear stays. A clear whose step is already on the stack folds into it instead of pushing a second step. Chat `/clear` uses the same path (L-6).
- **L-2, a step whose change arrives by echo.** Chat upload (`ChatPanel.tsx` ~846-921) and file drop (`canvasFileDrop.ts` ~203-215) pass the node id from the answer: `endUndoStep(step, { arrives })`. The step settles only once that node is on the canvas (`awaitArrival`, ~3195), and the line ~1021 note above is corrected.
- **L-3, the 15 s limit drops, never applies late.** At the limit the held presses go with the notice. A later answer is a normal sync: no stray redo, canvas and Nebula's graph agree.
- **L-4, a project switch.** `loadGraph`, `loadProjectGraph` and a graphReplaced sync call `forgetStepsInFlight` (~3238): the old project's presses are dropped with the notice, and its steps no longer hold anything, so a press in the new project never waits.
- **L-5, an accept that was undone runs nothing.** `canvasProposalsStore.ts` ~225: if any of the run's nodes is gone from the canvas after the accept settles, the approval is released and no run is sent.
- **Proposal accept, no empty step.** `adoptAcceptedProposal` (~6428) adds no step when nothing changed and folds into the accept's step when it is on the stack (H9: no no-op step, no stray redo).
- **L-1, L-7, docs.** "Model: default … Krea picks it" was wrong (Krea requires Topaz Standard's model) and is gone from `docs/MCP-SETUP.md`. `skills/nebula/SKILL.md` lists Topaz video's Enhancement model and Frame interpolation model.
- **The palette.** "Ask the agent…" closed the palette, so agent mode was unreachable. `agent:ask` now has `keepsOpen` (`lib/commandPalette.ts` 61; `CommandPalette.tsx` 210). Escape and Enter are ignored while composing (`isComposing` or keyCode 229, `composing()` at 27). Focus follows the mode.
- **GM r12, rows wrap only at " · " (bug r11-topaz-rows).** `PlaceholderRunDialog.tsx` `RowSegments` (83) renders each row as whole segments (`rowSegments` in `placeholderRunConfirm.ts` 310). Each segment is an inline-block that keeps its trailing " ·", and the lead holds the dot and the name. `styles/placeholder-run-dialog.css` 77-90: segments get `text-indent: 0`, and a dotted row's lead keeps the 16px hanging indent. Every row kind (dotted and muted) and every node kind.
- **GM r12 item 1, "the agents".** The skip line, the included line (`pendingNodes.ts` 70) and the backend's paid-placeholder refusal (`main.py` 8816, `services/pending_nodes.py` 228).
- **GM r12 item 2, Meshy.** "Mesh type: Smart Topology (Meshy T2)" for Meshy text- and image-to-3D, named at its default too (`placeholderRunConfirm.ts` 169-170), so a switch re-asks.
- **GM r12 item 3.** A changed free node stays named in the replay sentence, after the names with rows (already so; a test now holds it).
- **Addendum (a).** The dropped-undo notice is GM's sentence for all three cases (newer step on top, the 15 s limit, a project switch). No button.
- **Addendum (b), a model nobody chose.**
  - Inventory (`backend/services/model_choice.py` `required_model_settings`): Krea definitions whose model-choosing setting is required with no default. These are Topaz Standard's Model and a node app's Version. Every other Krea model setting has a default.
  - Canvas: a required setting with nothing in it reads "Model: not chosen" ("Version: not chosen") and keeps the rest of the row (`SETTING_NOT_CHOSEN`, 164).
  - Before any dialog, `refuseUnchosenModel` (`graphStore.ts` ~3907) shows "Nothing ran. Choose a model for “Clean plate” first." and sends nothing. It runs on every run path: a node's Run (Inspector and context menu included) through `confirmDirectRun` (~4046), an accepted proposal's run (~5858), Run selected (~6175), the toolbar's Run (~5777), Creator Studio's cluster (~6266), and replays from Run history (~2712). Cinema shots go through `confirmDirectRun`.
  - Backend: `engine.unchosen_model_errors` (810) runs first in `validate_graph`, with the node's name (`name_of=_run_names(...)` at every call). A direct run over placeholders is refused before its placeholder confirmation (`_refuse_unchosen_models`, 4818, called at 9099 and 9758).
  - Agents' `run_nodes` and `nebula run` read "Nothing ran, so nothing was spent. n7 (Clean plate): Choose a model for “Clean plate” first."
  - Docs: MCP-SETUP.md's "A model nobody chose" bullet; SKILL.md's Run section (with `nebula set`).
- **INSTRUCTIONS unchanged:** 2,233 characters (2,957 with the Commons guide).

### Every beginUndoStep caller under the bound press

- **Deletes** (Delete key, `deleteSelected`, `deleteNode`, `deleteGeneration`, `deleteCanvasElements`): the press applies to the step or to its re-pushed successor. A newer step on top drops it with the notice.
- **Toolbar Clear canvas, chat /clear:** fold into their own step and clear only the ids they sent. A newer step on top drops the press with the notice.
- **Chat upload, file drop:** settle once both the answer and the node's echo are in.
- **Proposal accept:** the adopt folds into its step, with no empty step. A run is skipped if the accept was undone.
- **OpenRouter and Replicate configures:** the local set happens at once, with no extra step. A newer step on top drops the press.
- **A cancelled or refused step:** its press is dropped silently.
- **The 15 s limit, a project switch:** drop with the notice.

### Decisions and tradeoffs

- **Drop, not redirect.** When a newer step is on top, the press is dropped rather than applied to the older step underneath. Undoing out of stack order would split the canvas from Nebula's graph. The person presses again, and the notice says why.
- **"Version: not chosen" and "Choose a version for “X” first."** extend GM's Topaz ruling to krea-node-app. GM to confirm.
- **The backend's card and agent line is "Choose a model for “X” first."** without "Nothing ran.", because run_nodes' frame already opens with "Nothing ran, so nothing was spent." The canvas notice is GM's full sentence.
- **"Mesh type"** follows GM's casing; the card label is "Mesh Type".

### Tests (each failed first on the current code)

- `tests/heldUndoBound.round12.test.tsx`, 19 tests. 14 failed first, for example:
  - H2: nodes [n1, n2], without Codex's n7;
  - H3 and S1: redo 1, not 0;
  - H6: the value 'NewProjectEdit';
  - H7: n2 not removed;
  - H9: undo 3, not 2;
  - H10: nodes [n1] at 15 s;
  - H13: only [local];
  - clear-only-sent: [], not ['later'];
  - delete echo + agent: undo 3.
  - H8, H11 and H12 also failed when run on their own: H8 [n1], H11 [n1, n2], H12 redo 1.
  - H1 and S1 answer-first failed only because `DROPPED_UNDO_TEXT` did not exist yet.
  - H5 is a control: deletes already re-pushed.
  - The source check that ChatPanel and canvasFileDrop pass `arrives` failed 3 ways on HEAD's files.
- `tests/acceptUndoneNoRun.round12.test.ts` (H14 + control): HEAD sent 1 execute request.
- `tests/commandPaletteAgentMode.round12.test.tsx`: 8 of 8 failed first.
- `tests/lib/placeholderRunConfirm.round12.test.ts`: 10 failed first. Rows read 'Model: default'; the node app's Version was null; `modelNotChosenText` and `rowSegments` did not exist; Meshy's setting was null; the lines said "agents are". Item 3 and the chosen-model case passed as controls.
- `tests/PlaceholderRunDialog.round12.test.tsx`: no segments existed (the length check guards against a vacuous pass).
- `tests/graphStore.modelNotChosen.round12.test.ts`: 7 failed on HEAD's store; the control passed.
- `backend/tests/test_model_not_chosen_round12.py`, 20 tests: 12 failed first. The runs got 'finished' or 'started' instead of validation_error, a direct run over a placeholder got 409 instead of the refusal, and the lines were worded wrong. The agent, whole-canvas and chosen-model runs use the real `validate_graph` (the `pend` fixture stubs it).
- Updated:
  - `Canvas.fileDrop.test` (arrives);
  - `ProposalBar.test` and `canvasProposalsStore.test` (their adopt mock now puts the run's nodes on the canvas);
  - `pendingNodes.test`, `runScope.placeholders.test`, `test_pending_nodes_round4.py`, `test_pending_nodes.py` ("the agents");
  - `placeholderRunConfirm.round11.test` ("Model: not chosen").

### Live check (round 12)

- Isolated backend on 8795 and Vite on 5795, no keys, 8000-8010 and 5173 blocked. 19 of 19 checks passed. 2 attempts were blocked, both canaries; none went toward Justin's ports.
- **S1, Clear canvas held while Codex adds a node:**
  - Cmd+Z pressed during the clear was dropped with GM's notice. Canvas and backend were both [n1:Agent node], with redo 0.
  - Three Cmd+Z presses then walked back Codex's label, Codex's node and the clear. Hero prompt and Second prompt came back on the canvas and in Nebula's graph.
- **Rows, at 1440 and 1280:**
  - The Bloom 2 row (Grain model: gaussian), the Meshy row ("Mesh type: Smart Topology (Meshy T2)") and the long-name row each wrap only between segments. Every continuation line starts at the 16px indent.
  - The long name wraps inside its own segment because it is wider than the row.
  - Cancel sent nothing.
- **Model not chosen:** Topaz Standard as Codex's placeholder showed no dialog and GM's refusal, and nothing was sent. An agent's run_nodes read the refusal.
- **"The agents":**
  - "Skipped 3 nodes the agents are still setting up." (toast).
  - "Includes 4 nodes the agents are still setting up" (the selection's Run title; the target counts as downstream).
  - "Nothing ran. This run includes 2 paid nodes the agents are still setting up, …" (backend 409).
- **Review 11's live-rv11.mjs on 8795/5795: 11 of 13.**
  - S1 "brings back the cleared nodes" fails by design: under M-1 the press is dropped with the notice, and the later presses restore everything (above).
  - S2's computed-style diff is only `--commons-detail-w`, which nothing in the prompt reads (as in round 11).
  - S3a-e pass: agent mode is reachable, Escape goes back to commands.
- **Screenshots** in `scratchpad/agent-presence/`: `r12-rows-wrap`, `r12-dropped-undo`, `r12-clear-restored`, `r12-model-not-chosen` and `r12-the-agents-skipped`, each at `-1440` and `-1280`.

### Open items (round 12)

- **For GM:**
  - "Version: not chosen" and "Choose a version for “X” first." for a node app;
  - "Mesh type" vs the card's "Mesh Type";
  - the backend line without "Nothing ran." inside run_nodes' own "Nothing ran" frame.
- **A cancelled step's held press is dropped silently.**
- **The Commons prompt doesn't close on Escape when focus has left it** (the live script blurred it). This was the same before ModalPortal; not changed here.
- **Known gaps, unchanged** (item 7 follow-up, for the PR body):
  - the tab that hasn't heard of an agent's placeholder, with "Ask before costly runs" on, shows the browser confirm and then Nebula's dialog;
  - free-placeholder runs still use the browser's costly-run confirm;
  - the browser confirm shows whole dollars from $10.

### Gates (round 12)

- Backend full suite: 11,047 passed, 71 skipped and 8 failed (19 min 16 s), run beside the vitest suite.
  - 7 failures were in `test_provider_start_admission.py`. Its `validate_graph` stubs (`lambda *_args`) didn't accept the new `name_of` keyword; they now take `**_kwargs`. That file plus the eighth failure's file, rerun alone: 53 passed.
  - The eighth was `test_krea_mcp_server.py::test_stdio_bridge_process_connects_to_only_local_discovery_routes`, a timing test under load; it passes alone.
- Vitest full suite: 492 files and 6,154 tests. 478 files passed and 14 failed (47 tests: 41 "Test timed out", 6 focus or find timeouts under load).
  - The 14 rerun one file at a time (`--no-file-parallelism`): 214 tests passed.
- errorCopy ratchets: 14 files, 173 tests passed.
- tsc: clean.
- Lint: clean (the inline-style and Slava-scope guards passed).
- Build budget: 392,767 bytes raw / 118,192 gzip (limit 512,000).
- INSTRUCTIONS: 2,233 characters (2,957 with the Commons guide), unchanged.
