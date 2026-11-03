# The canvas proposal card, redesigned (feat/proposal-card-redesign)

Brand dogfood item 24 (Justin: "This card looks bad... greatly improve this"), built to GM - Design's spec of 2026-11-01.

## The cause

The card was a row: the text column (`flex: 1`) beside three buttons that couldn't shrink (about 280 px). Justin's capture is Retina: his card was about 385 CSS px, which is a ~417 px window with the Agent log hidden. At that width the text got 75–100 px, so the agent's name wrapped onto three lines and the note was cut. The card is now one column, so nothing takes width from the note.

## What changed

**The card** (`ProposalBar.tsx`, `canvasProposals.css`), top to bottom:
- A 20 px header line: the dot, the name (white 0.92, never wraps, truncates, with `title`), "proposes", the pager, then "Expires in 13:00". The countdown moved up from the meta line.
- The note at 14/1.45, full width. Past six lines it clamps and "Show all" opens it in place on the layout spring (`interpolate-size`, a measured length to `auto`). "Read the whole note" and the Note group are gone.
- The plan line (below).
- The not-ready lines, as before.
- "What Accept writes": a real disclosure row (32 px, chevron, `aria-expanded`, `aria-controls`, a count on the right). Its label never changes. With no change lines but more than three nodes that can't run, it reads "Every node that can’t run". The panel stays mounted (`inert` while closed) and opens on the spring. Group titles are names, never ids: “Hero shot” · Krea 2, New “Krea 2”.
- The footer: a hairline, then Show on the left and Reject and Accept on the right. Accept is the app's primary button (ink fill, canvas label: 18:1), never the agent colour. It reads "Accept and run" or "Accept". Below 400 px of card width Show is its icon alone (a container query). Buttons are 44 px on a coarse pointer.
- Width: `min(600px, …)`, through `--proposal-bar-max-w`. The run-later notice (DeferredRunNotice) shares `.proposal-bar` and keeps its row and the 560 px cap.
- Restraint reads the --sr tokens (glass, edges, ink, the primary fill) through fallbacks. No `body:not(.app-slava-restraint)` rules: the classic skin can't be reached (lib/skins.ts).

**The plan line comes from the backend, so agents read the same words.** `services/canvas_proposals.plan_line` writes it into every view as `plan`. For example: "Changes and runs “Hero shot” · Krea 2 on your Krea plan · no list price".
- Cost entries now carry `name`, `model` and `billedTo` (`main._proposal_cost`, `canvas_proposals.billed_to`).
- Changed nodes carry `title` and `model` (`main` existing snapshot, `ProposalBook.view`). `name` keeps "Hero shot (n4)" for agents.
- The price is the run chip's own label. `services/money.chip_label` is a twin of `lib/pricing.formatChipEstimate`. Both test against `contracts/fixtures/money/chips.json` (243 rows taken from the TS side).
- `nebula proposal` / `propose` print it as `  card     …`. MCP's `propose_change` and `get_proposal` return it in the view, and the `propose_change` doc says so. `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md` are updated.

## Decisions not in the spec

- **The backend writes the plan line and the card shows it, rather than the card building it.** This keeps one source for the person and the agents. The cost: a node renamed while the proposal is open keeps its old name on the plan line. Changed nodes' titles already worked that way.
- **Clauses.** The spec didn't cover every mix of clauses:
  - Adds plus a run of exactly the new nodes reads "Adds “Krea 2” and 1 connection and runs it". *(Superseded in round 3: "Adds and runs “Krea 2” plus 1 connection".)*
  - Three clauses use a serial comma when a name list already has "and". *(Superseded in round 2: no serial comma; in round 3, groups join with ", ".)*
  - A run that waits on placeholders keeps its old words as their own segment.
  - A paid run that no provider can take (no `billedTo`) names only the model.
- **"List prices, not a quote".** It goes first in the disclosure, as the spec says. A run-only proposal has no disclosure, so the plan line also carries it as its `title`. *(Superseded in round 2: the title is on the price segment alone, with screen-reader text.)*
- **The six-line clamp is defensive.** Agents' notes are one line of up to 160 characters (`MAX_NOTE`). That's at most 4 lines at a 320 px card, so a real note never clamps. The clamped shots use a longer note set in the page's store.
- **No plan allowance.** "1 of 10 Krea runs today" isn't shown because Nebula doesn't track it. `agent_spend.py:59-61` says the person's runs, accepted proposals included, aren't counted. `kreaPlanRuns` (`agent_spend.py:223`, `:317`) caps an agent's own plan runs, not the person's. Krea's own units aren't read (`agent_spend.py:69-71`).
- **The width-cap test** (`noticeWidthCap.test.ts`) now allows the card's own 600 px token, and only on `.proposal-bar`.

## Found, not fixed (pre-existing on main 529665ef, measured live)

With the Agent log shown, the card goes off screen below a ~950 px window. Two rules both make room for the log:
- the notice region's `right: --agent-log-clearance` (noticeRegion.css);
- the room rule's `translate` in `layouts.css` (`body.agent-log-reserved .proposal-bar`).

Measured on main: the card's left edge is at x = −58 at 900 px, −178 at 760 px, and −332 at 420 px (card 43 px wide). At 1000 px it is +42; at 1200 px, 190. The spec says to keep the room rule, so I left it; it needs its own fix. Justin's capture had the log hidden, and the narrow shots are taken that way.

## Checks

- Backend: `tests/test_proposal_plan_line.py` covers the chip parity, every plan-line case, `billed_to`, and the view, CLI and HTTP reads end to end. The placeholder cases moved here from `proposalPendingSummary.test.ts`, which is deleted.
- Frontend: `tests/proposalCardLayout.test.ts` covers the column, the note's W − 36 at 320–600, the one-line name, Accept as primary, the icon-only Show, and the chip parity. ProposalBar tests cover the disclosure (fixed label, `aria-expanded`/`aria-controls`/`inert`, closing on page), Show all and less, the header and the titles.
- Live, at 1000 px and 420 px, in Restraint. The isolated backend on 8798 and Vite on 5798 were network-guarded, with a fake OpenAI key. Nothing was accepted or run.

## Round 2 (GM - Design's review of #216, 2026-11-01)

**Fixes, built to GM's words:**
1. **No serial comma in the plan line.** When the same node is changed and run, the clause merges, whatever else the proposal adds: "Adds “Second take” and 2 connections, changes and runs “Alt still”". When the clause before the last already has its own "and", a comma alone joins the last clause (`canvas_proposals._join_clauses`).
2. **Node names in curly quotes on the not-ready line.**
   - "“Hero shot” needs your Krea account. Connect it in Settings." The API-token line reads the same way: "“Alt still” needs your OpenAI API key. Add it in Settings."
   - A route's line starts with the model's name; `main._quoted_name_line` gives it the node's name, quoted.
   - Agents keep `missing`, find_nodes' words.
3. **"Show all" can't push the card off screen.** The card's height is capped at the region's room: from the region's bottom edge (`--notice-region-bottom`, now one token in noticeRegion.css), less any lift over the log, up to the app's top line (`floatingTopLimit`, which ProposalBar writes as `--proposal-bar-top-line`). Past that cap, only `.proposal-bar__note-area` scrolls; the header, the plan line and the footer stay put. "Show all"/"Show less" sits outside the scroll area, so it is always reachable.

**GM's calls:**
- **The note clamp** stays as built.
- **"List prices, not a quote"** is now on the price segment only (`.proposal-bar__price` has the title). Visually hidden text follows it for screen readers: " (list prices, not a quote)". The card finds the price because the plan line's last segment is the run chip's label (`proposalEstimateLabel`); the two sides are checked to match by the shared fixture.
- **The Agent log overlap (the bug on main).**
  - Only one clearance applies now: the notice region's `--agent-log-clearance`. The proposal card's room rule and left shift in `layouts.css` are deleted; they were the double count.
  - While the region beside a docked log is at least 400 px wide, the card stays there.
  - Below 400 px, ProposalBar marks the card `data-above-log`. Its CSS sets it to the full width (`min(600, 100vw − 32)`), moves it back to the window's centre, and lifts it so its bottom clears the log's top edge. AgentLog writes that edge as `--agent-log-top` beside the clearance it already measured.
  - The log never moves or collapses for the card.
  - Size: about 40 lines of code across AgentLog, ProposalBar, canvasProposals.css, noticeRegion.css and layouts.css, so it is in this PR.
- **MCP.** `propose_change` and `get_proposal` return `plan` and every field it is made from. A new test runs both through the app and rebuilds the line from the view without `plan`: `plan_line(view) == plan`.

**Checks:**
- tsc and lint are clean.
- Focused vitest (an explicit array of 144 files): 2520 passed, 0 errors.
- Isolated pytest (88 files): 2865 passed.
- Entry size: 443,579 B raw (unchanged; the card's code is in its own deferred chunk).
- Mutation checks: 16, all caught. The not-ready quoting has two paths that cover for each other, so it was checked with each path mutated on its own and with both together.

**Live (Restraint, isolated backend on 8798, Vite on 5798; nothing accepted or run):**

| Shot | Card (px) | Log | Result |
|---|---|---|---|
| 1440, 3-change plan line | 600 wide, left edge at 229 | closed, from x 1050 | no overlap |
| 900, log open | 520 wide, left edge at 16 (the whole region) | from x 544 | beside the log, no overlap |
| 420, log open | 388 wide, bottom at 532 | top at 540 | above the log, no overlap, fully on screen |
| 420, "Show all" | 416 tall, top at 116, bottom at 532 | open | note scrolls; header and footer don't move when it scrolls |

- At 900 the card sits beside the log because that leaves it 520 px, over the 400 px threshold; 520 is the region's full width.
- At 420 the card is 388 px, the window less its gutters.

## Round 3 (GM - Design's r2 shots and r3 answers to review 1, 2026-11-02)

**The notice stack (GM r3 1–3; review HIGH-1, MEDIUM-2, LOW-3–5; GM r2 bug 3).**
- The region is one stack that moves as one. The card is the only part of it that shrinks.
- The region clears the left tool rail the way it clears a docked log on the right. While the rail is mounted, `workspace-rail.css` sets `--notice-left-clearance` (the rail plus 8 px).
- `lib/noticeStackPlace.ts` is run by `NoticeRegion`. It measures the region, the stack, the card's fixed rows and what lies under the card, the log's two root variables, and the top inset (`floatingTopLimit(16)`). From those:
  - If a log is docked and less than 400 px is left after both clearances, the region gets `data-above-log`. It then stops clearing the log (`right: gutter`), and the stack is lifted over the log's top edge (`--notice-stack-lift`, a margin on the stack). The region and its band stay where they are, so floating panels don't move.
  - The card's cap (`--notice-card-cap`) is the room from the stack's bottom line up to the inset, less the notices under the card and their gaps.
  - When the header, a 60 px body and the footer don't fit, the lift gives way. The card keeps that minimum and its foot comes down over the log's top edge with its shadow, and its top stays at the inset. The log never moves.
- It re-measures when:
  - the region, the stack, the card or the body's content resizes (ResizeObserver);
  - a top bar resizes, which covers the selection toolbar (LOW-5);
  - the root's `style` changes (the log docks, moves or is dragged; the bottom bar moves);
  - an item enters or leaves a slot;
  - the region's transition ends;
  - the window resizes.
- The card's old `useCardPlace`, `data-above-log`, `--proposal-bar-lift` and `--proposal-bar-top-line` are gone.

**The card's body (GM r3 2; GM r2 small; review LOW-7, NIT-8).**
- The header and footer are fixed. Between them, `.proposal-bar__scroll` (what shrinks) holds `.proposal-bar__body` (the scroller). The note, Show all, the plan line, the not-ready lines, the disclosure, "What Accept writes" and the error all scroll as one. The panel no longer has its own 240 px scroll.
- Fade masks are 16 px, on whichever edge hides content (`data-fade-top` / `data-fade-bottom`), with none at the ends. They have no transition, so reduced motion shows them the same.
- While the body scrolls it is a tab stop: `role="region"`, `aria-label="Proposal details"`. Its focus ring is drawn on the wrapper (`:has(> body:focus-visible)`), outside the mask.
- The details panel is a named `role="group"`.

**The plan line (GM r3 4–7, 9; review M1, L1–L3, N1).**
- `canvas_proposals.plan_groups` lists each node once, merged by id (never by name), under the verbs that happen to it, in this order: adds and runs, adds, changes and runs, changes, runs.
- Groups join with ", ". Within a group, names join with "and" and no serial comma, up to 3; from 4 it's a count.
- New connections ride on the adding group: "and N connections" after one verb and one name, otherwise "plus N connections". With no added nodes they form their own "adds N connections" group. Dropped wires close the list: "removes 2 connections".
- Two nodes in one group with the same name read "2 “Image” nodes". A later group's node with a name already used reads "another “Image”". The plan line never names a model.
- Names come from the view's new `names` map (every node the proposal touches, by its canvas name). An unnamed one reads "N more nodes", so it never turns the named ones into a count (L3). Quotes a name already has are stripped (N1).
- A run count has no "up to"; the chip's "Up to" covers a run that may be skipped (GM r3 7).
- One test runs every mix of adds, changes, runs, connections and removals, up to four nodes each. It checks that no group holds two " and " outside quoted names, counting a merged verb ("changes and runs") as one verb.
- L2: `_quoted_name_line` tries only the model's names as leads. `route_unavailable_line` takes `name=`, and `instance_missing_line` passes the quoted name through, so route lines start with “Hero shot” with no prefix matching.
- N2: `billed_to`'s docstring now says it names the routed provider even when that provider's key is missing.

**One count (GM r2 bug 1, GM r3 8).**
- `change_count(spec, removed=…)` counts nodes added, connections added, nodes changed and connections removed. The view carries it as `changeCount`, and the Update reads the same function.
- The card's disclosure reads `view.changeCount`. A view without it counts the panel the same way. The frontend's old field-line `changeCount` is gone.
- The panel lists everything the count counts: a group per node, then "New connections" and "Removed connections", one line each: “Prompt” → “Second take” · Prompt, with the target port muted. Removed lines are struck through and carry a "Removed:" prefix for screen readers.

**Agent-facing behaviour change: a proposal's model swap drops wires (coordinator, 2026-11-02: keep it).**
- On main, `_stage_proposal` refused a model change that left wires on ports the new model doesn't have. The refusal told the agent to `unwire`, which proposals can't do. Review 1 assumed the wires were dropped; they weren't.
- Now a canvas proposal (create, the misfit check and Accept) passes `drops`. When the new model's ports are known, the wires already on the canvas that it can't take are removed from the candidate and listed. The view carries them as `removedEdges` (`source`, `sourceHandle`, `target`, `targetHandle`, `sourceName`, `targetName`, `targetLabel`), and the plan line says "removes N connections".
- What still refuses:
  - Ports that can't be read (no key, an unknown model) refuse as before, with `unwire` in the message.
  - A wire the proposal itself makes to a port that's gone is refused.
  - Direct edits (`edit_canvas`, `nebula apply`, the node routes) never drop; they stay all or nothing.
- Accept re-stages, and refuses with 409 "the connections it removes changed after it was proposed" when the live graph would drop different wires than the card showed (one gained or lost since). It journals each dropped wire as `edge.removed` with the proposal's id.
- Undo of the Accept puts the wires back, along with the old model, while both ends are still on the canvas:
  - the store hands `removedEdges` to `adoptAcceptedProposal`, which keeps them on the step's `OwnAdd.unwired`;
  - `captureOwnAdd` writes them into the step;
  - the restore sends them as `wire`.
- Agent docs now say this: the `propose_change` and `edit_canvas` MCP docstrings, `nebula propose`'s help, `skills/nebula/SKILL.md` and `docs/MCP-SETUP.md`.
- The person's gate is unchanged: the person still accepts the card.
- MCP diff against main for propose and get_proposal, key for key: added top-level `changeCount`, `names` and `removedEdges`, and `sourceName`/`targetName`/`targetLabel` on each edge. Nothing person-only.

**Checks.**
- tsc and lint are clean.
- Focused vitest, `--maxWorkers=2` from an explicit array: 36 files, 591 passed; the undo set, 13 files, 192 passed.
- Isolated pytest: 1080 passed on plan line, canvas proposals, universal ports, every `test_error_copy_*`, CLI commands, MCP tools, the first-turn tests and the connected-copy sweep. Another 909 passed on 25 proposal-related files.
- Entry: 447,559 B raw, 137,014 B gzip (limits 512,000 / 160,000).
- Mutation checks: 34 run, 31 caught. The three that survived are equivalent:
  - B13: the guard that keeps the proposal's own wires. Staging already refuses a new wire to a port that's gone; the test pins that.
  - F14: AgentLog's hidden-state removal. The effect's cleanup removes both variables first.
  - U2: undo skipping a wire whose end was deleted. `applySlice` drops wires without both ends.
- **Live** (Restraint; isolated backend on 8798 with OpenRouter's model list warmed in the cache; Vite on 5798; canaries blocked; nothing accepted or run). The shots are in `scratchpad/proposal-card/shots3/`: 11 PNGs, and `md5 | uniq -d` is empty.

| Shot | Card (px) | Result |
|---|---|---|
| 1440 Codex, closed, Updates open | 600 wide, top 585 | "4 changes" = Update "Codex proposes 4 changes" |
| 1440 Codex, open | top 417 | New connections: “Prompt” → “Alt still” · Prompt, “Prompt” → “Second take” · Prompt |
| 1440 "another" | | "Changes “Image”, runs another “Image” · GPT Image 2 on your OpenAI key · Up to $0.43" |
| 1440 swap, closed and open | | "Changes “Second look”, removes 2 connections"; 3 changes = Update; both struck through |
| 900, log open | 466 wide from x 70 (rail ends 54) | beside the log, no overlap |
| 420, log open | 340 wide from x 64 (rail ends 49), bottom 614 | above the log (top 622), lift 206 |
| 420, Show all, mid-scroll | top 116 = inset, bottom 614 | both fades; body a named tab stop; ring on the wrapper |
| 420×640, 1 notice | top 116, cap 202 | notice under the card, over the log's edge, footer visible |
| 900, Show all, 2 notices | top 152 (inset 150), bottom 712 | two notices under it, footer visible |
| 420×560, log dragged up | top 116, cap 149 (60 px body) | foot over the log's top edge; top at the inset |

## Round 3b (GM - Design's r4 answers to review 2, 2026-11-02)

**Plan grammar (GM r4 1–2; review 2 L1, L2).**
- `plan_groups` now writes the nodes added, then the nodes changed, then the other runs, then the removals.
- A group with one node keeps its merged verb: "Adds and runs “A” plus 1 connection", "Changes and runs “K”".
- A group with more than one node names them and then says which of them run:
  - "Adds “A”, “B” and 1 connection, runs both";
  - "runs all 3";
  - "Adds 4 nodes and 1 connection, runs all 4".
  - Only some running are named: "runs “A”". When a shared name can't tell them apart, it says "runs 1 of them".
- Changed nodes follow the same rule ("Changes “A” and “B”, runs both"), so no group says "and" twice.
- New connections close the list of added nodes.
- The other runs join the last run clause ("runs both plus “C”", "runs “A” and “C”"). After a single merged group they keep their own group, as in r3 ("Changes and runs “Krea 2”, runs “GPT Image 2”").
- L2: a group adds its names to `said` only when it spoke them (3 or fewer nodes), so a count of 4 is never followed by "another".
- The group order stays r3's (changes before other runs), so GM's example "Runs 2 “Image” nodes, changes another “Image”" reads "Changes 2 “Image” nodes, runs another “Image”". The test says so; GM can ask for the other order.
- The combinatorial test no longer rewrites the merged verb, and still passes over more than 1000 mixes.

**Universal nodes name the model (GM r4 3, L3).** `_proposal_cost` passes the looked-up models to `_plan_model`. For a universal node that gives the catalog name without the maker's prefix (`universal_ports.model_name`: "Anthropic: Claude Sonnet 4.5" → "Claude Sonnet 4.5"), read from the lookup or from the pickers' cache, else the model id. The result: "Claude Sonnet 4.5 on your OpenRouter key".

**Names follow renames (GM r4 4, N2).**
- `view(live=…)` takes the names of the existing nodes on the canvas now (`_proposal_live_names`). These cover:
  - only open proposals for the open project;
  - titles, the `params[].name` field, `names`, the names on both new and removed wires, the `cost.nodes` names, and each not-ready row's name and the quoted name that starts its person line.
- get_proposal and the plan line read them.
- After every non-replacing graph sync, `_follow_renamed_proposals` re-sends `proposalOpened` to the person's canvases for proposals whose names changed. The store's `open` replaces the view and keeps the drag.
- The note is never rewritten.

**Cleared model, inputs updated, a failed read at Accept (GM r4 8; review 2 wire-drop MEDIUM-1→LOW, LOW-4).**
- The drop loop also requires a model, so a proposal that clears it is refused with the `unwire` 400, as the docs say.
- Setting the model a node already has (`_model_reread`) stores `inputsUpdated` {key, name} on the change. The panel then shows "GPT-4o · inputs updated" instead of "X → X", and any wires the re-read ports drop are listed as removed.
- A read that fails while a canvas proposal is staged now raises `PortsUnread`, a subclass of the same 400 with the same agent words:
  - create and reopen answer the agent as before;
  - Accept catches it and answers 409 with the person's line: "Nebula couldn't read which inputs X takes from OpenRouter's server, so it can't tell which connections “Y” keeps. Try Accept again in a moment." With no key, it says "Add it in Settings".
  - The proposal stays open, and Accept works once the read does.
- N1: `proposal.created` journals `removes`.
- N3 (two fields named `plan`): not renamed. `cost.estimate.plan` is the run estimate's shared shape (pricing, the run chip, other callers), so a rename isn't cheap. Left as is.

**Quotes (L4).**
- The card's frontend uses `cardQuoted` (the plan line's rule: quote marks are stripped from both ends) for the New title, the edit title and both ends of each wire line.
- The backend's not-ready name and `_quoted_name_line` use `_card_quoted`.

**Notice stack give-way (GM r4 5–7; review 2 stack MEDIUM-1, LOW-2/3/4, NIT-5).**
- `placeNoticeStack` follows GM's order, and the docked log's header is covered only in the last step:
  1. When the notices don't fit under the card, they go over its body's foot. The card sits on the log's line. Its scroll wrapper keeps their room as `padding-bottom` (`--notice-overlay-pad`, with `--notice-body-floor` as its min-height). Each notice moves up by its own `--notice-overlay-y` (`translate`, on the stack's spring, z above the card), and the last one sits 8 px above the footer.
  2. The body shrinks below 60, down to one line (or, with notices over it, to the newest notice and its gap).
  3. Only when header, that floor and footer can't fit does the card's foot come down (the lift drops).
- The header and footer always show.
- When the body is shorter than the notices, older notices tuck under the newest one, which keeps the button and shows in full. At 420×560 with 2 notices the overlap is 13 px. **For GM:** this is the one place the brief's rules can't all hold (body 87 px, notices 100 px). The alternatives are to cover the log's header, or to cover the card's header.
- A floating log in the card's column is cleared. AgentLog writes `--agent-log-float-top/bottom/left/right` while it's undocked. The card stays under the log when the stack fits below it, else the stack is lifted above it.
- The offline banner joins the card's top line only. It carries `data-notice-top-line` and `noticeTopLimit` reads it, so floating panels don't move when Nebula goes offline. While the banner shows it puts `data-offline-banner` on the root, which the region's root watch hears.
- A layout switch (`aboveLog` flips, `--agent-log-top` or the floating log's top moves) applies the lift with `data-notice-jump` on the region for two frames (`transition: none`). Changes inside the stack keep the spring (`stackJumps`).
- NIT-5: a body shorter than 60 needs no give-way (pinned).
- The footer carries `data-notice-shrink-foot`, so the overlaid notices land above it.

**Pins (review 2 LOW-2, L5, L6).** Every mutant named in the reviews now has a test:
- the re-pointed and moved-handle drops (R1/R2);
- the reopen misfit's drops (R3/R4, B20);
- the `edge.removed` journal: 2 events, actor person, `proposalId`, summary (R5–R7, R13, B19);
- the exact wire words ("Image Input", "Second take", "Images"), including a new wire into a renamed new node (B14/B15/B23, R9);
- an output-side drop (R10);
- the CLI's `removes` lines (R11);
- the undo keeps the original edge id and type (FE6/F12);
- F7: a wire on the canvas again at Undo stays, and its Redo too.

**Checks.**
- tsc 0 and lint 0.
- Focused vitest, `--maxWorkers=2`, from an explicit array of every test file that names the changed modules or styles (focusRingCss included): 99 files, 1777 passed.
- Isolated pytest: 1374 passed on plan line, canvas proposals, universal ports, every `test_error_copy_*`, MCP tools, CLI commands, node route and the reopen tests. 97 passed again after the doc edits (MCP tools, CLI, universal ports).
- Entry: 449,262 B raw, 138,026 B gzip.
- Mutation checks: 41 run, 41 caught (F7 needed the Redo pin). The runner is `scratchpad/proposal-card/mut3b/run.py`, its results `out.txt`.
- **Live** (Restraint; isolated backend on 8798 with OpenRouter's rows warmed; Vite on 5798; canaries blocked; nothing accepted or run). The shots are in `scratchpad/proposal-card/shots3b/`, and `md5 | uniq -d` is empty:

| Shot | Result |
|---|---|
| 1440 "runs both" | "Adds “Ice prompt”, “Chrome prompt” and 1 connection, runs both · free"; "3 changes" = Update. After a rename of the target, the card read “Ice prompt” → “Alt still (final)” with no reload. |
| 420×560, log open, 2 notices | Card 116–292, header and footer whole; notices at 151–230 over the body's foot, 8 px above the footer; log header at 301, clear. |
| 1440 "inputs updated" | "“Second look” · OpenRouter / model GPT-4o · inputs updated"; 1 change. |

- Found while live: a Vite left running through the mutation run served stale modules (notices didn't render) until it was restarted, as the restart-Vite note warns.

## Round 3c (GM - Design's r5, 2026-11-02)

**The give-way order, replaced (GM r5).** Never covered: the docked log's header and its collapse control; the card's header, plan line and footer. No notice overlaps another; the r4 tuck and the overlay over the body's foot are gone (`--notice-overlay-*`, `--notice-body-floor` and their CSS removed). `placeNoticeStack` (lib/noticeStackPlace.ts) is pure and returns `mode` `under` | `above` | `folded`:
- 0, `under`: card on top, notices under it, while the body keeps its note and plan line whole (`bodyFloors().full` = plan line's foot + the 16 px fade).
- 1, GM's "overlay the body's foot while the plan line stays clear": not built. It holds exactly the room of step 0 (the notices and their gaps come out of the same column whether they sit under the footer or over the body's foot), so once step 0 would squeeze the plan line, step 1 would too. **For GM:** the order is effectively under → above → folded. Said in the module's header.
- 2, `above`: the card goes to the stack's end (`order: 1`), on the stack's line; the notices sit over the canvas under the top line, the newest nearest the card. The body keeps at least the plan line between two fades (`bodyFloors().min`); `keepPlan` makes the region scroll the body so the plan line shows, and the note goes behind the top fade (GM r5 2's "the note clamps or scrolls behind its fade").
- 3, `folded`: the older notices get `data-notice-folded` (out of flow, hidden, no clicks or focus, still mounted so their timers run) and one row shows above the newest, "1 more notice" / "N more notices": a real `<button>` first in the stack, `aria-expanded`, its words and state written with the place. A click unfolds them above the newest (step 2 with the row on top; the card's body may then go below its floor) and folds them again; it resets once they all fit.
- 4, last resort, only where step 3 can't fit: the stack first rises into the room the selection toolbar's empty Panel keeps (`topFloor`, from `noticeTopLimit(gutter, true)`, which leaves out top-bar parts with no width), and only past that does the card's foot come down over the log's top edge (`over`).
- Every step change glides: `applyNoticeStack(…, glide)` keeps each row's last resting layout box (`layoutBox`, its transform taken out), lands the new layout in one frame (`data-notice-jump`), then springs each row and the card from where it was (Web Animations `translateY`, 420 ms, the stack's `--notice-spring`; the card held by its footer, the rows by their tops). Reduced motion lands it at once; a folded row or one with nowhere to come from doesn't glide; a new step's glide takes over from one in flight, and any other place lets it run. Live: under → above at 420×700 started `translateY(-54px)` on the card and `translateY(270px)` on the older notice, on the `linear(…)` spring.
- The region now measures heights from the layout (`offsetHeight`, and boxes inside the card divided by its scale), never what's on screen: the step in force, the card's entrance scale (0.96) or a glide no longer change the measure. Before this, a notice measured mid-entrance read 44 px instead of 46.
- The grid test proves the invariants in 210 cells: 7 window sizes × log open, closed or floating in the column × 0–4 notices × the offline banner on or off. In every cell nothing overlaps (card, notices, row), the plan line shows between the card's header and footer, the newest notice is whole, nothing leaves the window, nothing passes the top line except into the spare room, and nothing reaches a floating log except where neither side of it has the room (then the stack sits under it and crosses the 8 px gap, never the log's header). Only the cells in `OVER` cross the docked log's line.

**For GM: where r5 can't all hold.** At 420×560 with the log open, the room between the top line (116, the empty toolbar Panel's 108 + 8) and the log's line (291) is 175 px. The card's fixed rows are 89 and its plan line with two fades 65, so the card alone needs 154. GM's "about 130 px above the card" isn't there: one notice needs 208, two folded 248. Live:
- 1 notice: step 2, rising 22 px into the toolbar's room (notice at 84, under the tabs at 52 + 8);
- 2 notices: step 3, the row at 60 and the newest at 100, the card 154–308: its foot crosses the log's line by 16 px, 7 px into the log's header (header 301–338; the collapse chevron's top edge). Listed in `OVER` with 420×560 and 1 notice + banner, 2–4 notices with or without the banner, and 768×600 with the banner and 2–4 notices.
- The choices for GM: allow that (current); or let the plan line go behind the fades there instead (the body scrolls, the log's header stays clear); or let the empty toolbar Panel not count for the card at all (+56 px everywhere, but a selection would then move the card).

**Universal nodes name the model everywhere (GM r5).** `canvas_proposals.model_label(definition, params, models)` is the one helper: the canvas title, or for a universal node its chosen model by catalog name. It feeds `cost.nodes[].model` (the plan line), the existing nodes' `model` at create (the panel's group titles: "“Second look” · GPT-4o"), new nodes' `model` in `view()`, and so get_proposal, MCP, the CLI and Updates, which all read the view. main's `_plan_model` is gone. Pinned in `test_universal_ports.py` (swap → "Claude Sonnet 4.5" in params and cost; same model → "GPT-4o"; a new node; get_proposal and the CLI) and in `tests/lib/canvasProposals.test.ts` (the fixture said "OpenRouter").

**Not this PR (GM r5):** the "Canvas actions" bar clip at 420 (follow-up: the "…" icon alone, aria-label "Canvas actions"); the wording batch ("Person changed the canvas" naming what changed; the run chip's en dash).

**Checks (round 3c).**
- tsc 0 and lint 0.
- Focused vitest, `--maxWorkers=2`, on the round 3b list plus every test file that reads `src/` or styles or names the changed modules (focusRingCss included): 160 files, 2967 tests. The second full run had 3 timeouts under machine load (the ratchet corpus and the money property test, 130 s each); both files pass alone (127 tests). The copy sweep caught `white-space: nowrap` on the new row (removed), and the dialogs' focus test caught the hidden row as a Tab stop (it now carries `hidden`, and folded notices `inert`).
- Isolated pytest: 1447 passed (plan line, canvas proposals, universal ports, every `test_error_copy_*`, the connected-copy sweep, MCP tools, CLI, node route, reopen).
- Entry: 451,560 B raw, 138,887 B gzip.
- Mutation checks: 39 run; 35 caught at first, and the 4 that survived (the floating log's no-room choice and its spare room, the card's glide held by its footer, reduced motion) are pinned now and caught. Runner `scratchpad/proposal-card/mut3c/run.py`, results `out.txt`.
- **Live** (Restraint; isolated backend on 8798, Vite on 5798, restarted after the mutation run; canaries blocked; nothing accepted or run). Shots in `scratchpad/proposal-card/shots3c/`, `md5 | uniq -d` empty:

| Shot | Result |
|---|---|
| 02, 420×560, log open, 2 notices | Step 3 plus the last resort: "1 more notice" at 60–92, the newest whole at 100–146, the card 154–308 with the plan line at 204–237. The card's foot is 16 px past the log's line (log header at 301). |
| 02b, 420×700, log open, 2 notices | Step 2: both notices above (116–162, 170–216), the card 224–432, plan line 328–361, the log's header at 441 clear. |
| 04, 420×640, log open, 2 notices | Step 3: the row at 116–148, the newest at 156–202, the card 210–372, plan line 260–293, the log's header at 381 clear. |
| 05, 04 after a click on the row | Unfolded, `aria-expanded="true"`: the row at 70, both notices, the card 218–372. |
| 03, 1440 "inputs updated" | "“Second look” · GPT-4o / model GPT-4o · inputs updated". |

- Live glide, under → above at 420×700: the card `translateY(-54px)` → 0 and the older notice `translateY(270px)` → 0, 420 ms on the stack's `linear(…)` spring. The new notice keeps its own entrance.
- Found while live: the Chrome for Testing 150 build the harness used is gone from `~/.cache/puppeteer` (removed outside this session), so the shots ran on the cached 131 build.

## Round 3d (GM - Design's r6, 2026-11-02)

**Short heights: the docked log's body gives way (GM r6 1).** `placeNoticeStack` keeps its pure shape; two steps follow the fold:
- 4, `squeeze`: when the card's header, kept lines and footer don't fit above the docked, open log, the log's body gives way by the shortfall, capped at `logSpare` (its own height less its floor). The region writes it as `--agent-log-squeeze` on the root; layouts.css turns it into `max-height: max(floor, natural - squeeze)` on `.agent-log--open[data-docked]`, on `--agent-log-spring` (420 ms; none with reduced motion). The log is a flex column held at its foot: the header and collapse control stay whole and come down with the body's top, and the body shrinks and scrolls. When the card leaves, the squeeze var goes and the body springs back.
- 5, `underFade`: only with the log at its floor does the card's body go under its kept lines, down to one line; past that `over` (the foot crossing the log's line) is left only for cells that can't hold header, one line and footer.
- The floor is "2 rows" read as the log's header plus two text lines of its body, with its padding and borders (`logFloor`, AgentLog.tsx): 91 px live.
- AgentLog writes `--agent-log-top` from the log's height with no give (`--agent-log-natural-h`: the person's inline resize, else `--agent-log-h` read off a probe), so the squeeze never moves the line the region measures. Live, the top line stayed at 268 with squeeze 0, 24, 78 and 89: no feedback loop. `--agent-log-floor` is written beside it, and all three are cleared when the log isn't docked.
- **Not (c), and the rise is gone.** Round 3c's last resort let the stack rise into the empty selection toolbar Panel's room (`topFloor`, `noticeTopLimit(…, true)`, `rise`). GM r6 rules out counting that room in a way that makes the card jump when a selection appears, so it's removed; the empty Panel counts as covered at all times, and a selection appearing doesn't move the card (pinned).
- Floating and closed logs are unchanged (no squeeze; `logSpare` is gated on `aboveLog`).

**The card's minimum body (GM r6 2)** is the plan line plus the first ⚠ (not-ready) line when there is one: ProposalBar marks that first `li` with `KEEP_ATTR` too, `measureNoticeStack` spans every kept element (min top, max bottom), and `applyNoticeStack` pins the lowest kept line's foot just over the bottom fade. The body is whole lines: a partial line sits under the 16 px fade, never hard-cut. Pinned with and without the ⚠ line.

**The fold button (GM r6 3)** reads "1 more notice" / "N more notices" folded and "Show less" unfolded (`SHOW_LESS`), with `aria-expanded`. Pinned.

**The grid, on the live top lines.** The 210 cells now use the measured top lines: 116 at 420 wide and 150 at 768 and up (the top bars' bottom + 8); with the offline banner, its bottom + 16: 214 at 420 (it wraps to two lines) and 199 at 768 and up. Every cell holds the never-covered invariants (the card's header and footer, the docked log's header, no overlaps, nothing off screen or past the top line).
- **Physically impossible (3 cells):** 420×560, log open, the banner, 2, 3 or 4 notices. 78 px from the top line to the log's line, plus 89 from the log at its floor, is 167; header, one line and footer with the "more" row and the newest notice need 203. There the card's foot crosses the log's line. Pinned as `IMPOSSIBLE` with those numbers.
- **The body under its kept lines (`underFade`), pinned per class:**
  - log open (the log always at its floor there, asserted per cell): 420×560 with 2–4 notices, and with the banner 0–4; 420×640 with the banner and 2–4; 768×600 with 2–4, and with the banner 1–4;
  - log closed (nothing to give): 420×560 with the banner and 2–4;
  - log floating (round 3c's placement, unchanged): 420×560 and 420×640 with 0–4, 420×760 with 2–4, 768×600 and 1024×640 with 0–4, with or without the banner. **For GM:** a floating log in the card's column at those heights still leaves the card less than its kept lines; r6 didn't touch floating logs, so this is unchanged.

**Checks (round 3d).**
- tsc 0 and lint 0.
- Focused vitest, `--maxWorkers=2`, the round 3c list of 160 files (focusRingCss and the copy sweep `pr198Fix6Copy` included): 2974 passed; then the three files touched by the pins, 292 passed.
- Backend unchanged this round; pytest not rerun.
- Entry: 452,080 B raw, 139,044 B gzip.
- Mutation checks: 25 run. 22 caught at first; the ⚠ line's keep mark and the log's floor survived and are pinned now (ProposalBar.test.tsx, pr198Fix7Ui.test.tsx), and the third, the card's height `max(min(room4, max(cap, keep)), least)`, was equivalent to `max(room4, least)` (the squeeze only ever brings the room up to the kept lines), so the line is simplified and its mutant caught. Runner `scratchpad/proposal-card/mut3d/run.py`, results `out.txt`.
- **Live** (Restraint; isolated backend on 8798, Vite on 5798; canaries blocked; nothing accepted or run; offline by blocking `/api/health`). Shots in `scratchpad/proposal-card/shots3d/`, `md5 | uniq -d` empty:

| Shot | Result |
|---|---|
| 01, 420×560, log open, 2 notices | Folded ("1 more notice" 116–148, newest 156–202), card 210–381, the log squeezed 89 to its floor (389–480), its header 390–427 whole. Body 82 < 97: under its kept lines, as allowed at the floor. |
| 02, 768×600, offline banner, 4 notices | Banner 150–183, "3 more notices" 199–231, newest 239–285, card 293–421, log at its floor (429–520), header 430–467 whole. The ⚠ line shows whole; the plan line is behind the top fade (the body is 39 px). |
| 03, 420×640, log open, 2 notices | Squeeze 24; the plan line 245–278 and the ⚠ line 284–310 whole above the bottom fade (footer at 342). |
| 04, 03 unfolded | "Show less", `aria-expanded="true"`, both notices above, card 264–450, squeeze 78, log header 459–496 whole. |
| 05, frames 1–3 | The card withdrawn: the log springs back from 91 to 180 px in about 200 ms (top 389 → 357 → 300), the notices glide down. |

- Found while live: proposals left open by earlier crashed driver runs kept a card on screen after a withdraw; the driver now withdraws every open proposal first. The harness's intermittent "Promise was collected" in the offline scene needed one or two reruns.

## Round 3e (GM - Design's r7, 2026-11-02)

**The give-way order, as GM r7 sets it: the plan line goes last.** `placeNoticeStack` stays pure; at short heights:
1. The notices go under the card, then above it, then the older ones fold under "N more notices" (as built).
2. **New: the pill.** Every notice without an Undo folds into the one row, "1 notice" / "4 notices" (`pillLabel`, mode `pill`). A notice that offers Undo or Redo never folds, in this step or the last (`offersUndo`: its `data-notice-undo` mark, or a button reading "Undo"/"Redo"; the measure reads it per notice as `card.undo`). When the newest offers Undo, steps 1 and 2 are the same fold, and it is the pill: everything that can fold is in it, the Undo notice whole under it.
3. The log's body gives way to header + 2 rows (as built).
4. **New: the log collapses to its header** (`collapse`). The region asks uiStore (`holdAgentLogForCard(want, card)`), which tracks who collapsed it in `agentLogCardHold`:
   - `card`: the card collapsed it. It reopens when the card leaves, or once the card no longer needs the room.
   - A collapse the person makes is theirs. It's never reopened for the card, and a log they collapsed gives nothing (AgentLog writes `--agent-log-collapse: 0px`).
   - `refused`: the person reopened it over the card's collapse (the header, or "See all actions"). The card doesn't collapse it again while it shows; step 5 follows instead. That's reset when the card leaves.
   - While the card holds the log collapsed, AgentLog keeps writing the open log's natural height, floor and top line, so the region's measure, and the stack, don't move.
   - What the collapse frees is the floor's whole px less the closed log's `--agent-h-closed` (44): 47 px live.
5. Only then does the card's body go under its kept lines. The plan line stays whole first, just under the top fade (or centred when even it can't clear both fades), and the ⚠ line comes next in the scroll. Before r7 the last kept line was pinned over the bottom fade, which is why shot 02 showed the ⚠ line and not the plan line.

**The floating log gives way the same way (GM r7).** When the stack sits above a floating log in the card's column, the log's body shrinks to header + 2 rows, then collapses, held at its bottom edge, and grows back when the card leaves. Where the person put it is never changed:
- A log pinned by its bottom edge (`data-floating="bottom"`) shrinks with no move.
- A log pinned by its top edge (`data-floating="top"`) is moved down by what it gives (CSS `translate`, on the same spring), so its bottom edge stays put.
- AgentLog writes the floating box with no give (`--agent-log-float-top` = its bottom less its natural height).
- Choosing a side: under the log when the stack fits there; else above it with the give when that fits; else the side with more room. Under the log, the stack may cross the log's body, never its header (round 3c's last resort).
- Under the log there's nothing to give, since its bottom edge stays.

**Found live, fixed with a check:** the card stayed on top in the new `pill` step, because noticeRegion.css listed only `above` and `folded` for the card's `order: 1`. `ABOVE_MODES` (noticeStackPlace.ts) now lists every step that stands the notices above the card, and the rules test checks that the CSS selector names exactly those.

**The grid** now has 378 cells: 7 sizes × log open, closed or floating × 0–4 notices × the banner on or off, plus every count of 1–4 again with the newest notice offering Undo. Every cell holds the never-covered rules. SHORT lists, by name with numbers, each cell where even every step leaves the body short of its kept lines (97 px); PLAN_SHORT lists those where even the plan line alone (65 px) can't show whole.
- **GM's cells, 420×560, the docked log, the banner, 2–4 notices (no Undo): still 12 px short.** The numbers:
  - 78 px from the top line (the two-line banner, 214) to the log's line;
  - plus the log's give, 89 + 47;
  - less the card's header and footer (89) and the pill row (40), leaves a body of 85 px against the 97 the kept lines need.
  - The plan line shows whole, and the ⚠ line's last 12 px sit under the bottom fade. Live shot 06 matches: plan 305–338, ⚠ 344–370, fade from 358.
- **The same window with 1 notice** is also 85 px. **The closed log** behaves the same (85), since a collapsed log is a closed one.
- **With an Undo notice that stays whole, the body is shorter:**
  - 420×560 with the banner: 71 px with 1 notice, 31 px with 2–4. At 31 px the plan line isn't whole; it's listed in PLAN_SHORT.
  - 768×600 with the banner and 2–4 notices: 86 px.
- **Floating logs: 77 cells short, 62 of them past the plan line too.** These are the grid's logs left mid-column at 30% of the height (420×560, 420×640, 420×760, 768×600, 1024×640). Since the log's bottom edge stays where the person put it, only the room above it grows. At 420×560 that's 44 px + 136 of give above it, against 123 under it. The card alone needs 186, and the pill 40 more.

  **For GM:** holding the kept lines there would mean moving the log or letting its bottom edge rise. Both go against "its position stays the person's".

**Not this PR, flagged for GM:** with no card, notices sit on the region's line even over a floating log the person dragged into the band (shot 09: "Saved the board…" over the log's body). That's how it was before; the floating clearance only runs with a card.

**Checks (round 3e).**
- tsc 0 and lint 0.
- Focused vitest, `--maxWorkers=2`, the round 3d list with the new `tests/proposalLogGive.round3e.test.tsx` (focusRingCss and the copy sweep among them): 160 files, 3148 passed.
- Backend unchanged; pytest not rerun.
- Entry: 453,444 B raw, 139,570 B gzip.
- Mutation checks: 37 run, 32 caught at first. The 5 that survived are now pinned, and caught:
  - an older Undo notice kept whole in step 1;
  - the pill when the newest offers Undo and step 1 has the room;
  - the plan line from the body's top when even it can't clear the fades;
  - "See all actions" as the person's reopening;
  - a bottom-pinned floating log.

  Runner `scratchpad/proposal-card/mut3e/run.py`; results in `out-first.txt` and `out-pins.txt`.
- **Live** (Restraint; isolated backend on 8798, Vite on 5798; the installed Chrome with a throwaway profile, removed after; canaries blocked; nothing accepted or run; offline by blocking `/api/health`). Shots are in `scratchpad/proposal-card/shots3e/`, and `md5 | uniq -d` is empty:

| Shot | Result |
|---|---|
| 02, 768×600, offline, 4 notices | The pill "4 notices" (199–231). Card 239–395, plan line 289–305 and ⚠ line 311–324 both whole over the bottom fade (footer 341). The log gives 63 (header 404–441). |
| 06, 420×560, offline, 3 notices | The pill "3 notices" (214–246). The log collapsed to its header for the card (436–480, `agentLogCardHold: 'card'`). Card 254–428, plan line 305–338 whole, the ⚠ line 12 px under the fade. |
| 07, 420×640, the pill with an Undo notice | "3 notices" (116–148), then "Deleted “Photo 2”. Undo" whole (156–202), then the card 210–396 with both kept lines whole. The log gives 24. |
| 08, 1024×640, a floating log in the column | Pinned by its top at 330, bottom 510. It gives 24: 355–510, bottom edge unmoved. "2 notices" over the card (190–346), both kept lines whole. |
| 09, frames 1–3 | The card withdrawn: the log springs back 355 → 340 → 330, its bottom at 510 (the spring slowed to a tenth via CDP for frames 1–2). Its bottom dips 3 px in the spring's overshoot, since `translate` overshoots and `max-height` can't. |

- Also live, with no shot:
  - The log the card collapsed at 420×560 (shot 06) reopened by itself once the window grew to 420×640 and the card no longer needed the room (`hold: 'none'`, open).
  - Collapsed by hand at 420×560, the card arrived (step 1, "2 more notices") and left, and the log stayed collapsed (`open: false`, `--agent-log-collapse: 0px`).
