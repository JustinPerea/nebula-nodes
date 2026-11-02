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
