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
