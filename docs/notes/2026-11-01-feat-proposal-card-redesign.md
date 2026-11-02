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
  - Adds plus a run of exactly the new nodes reads "Adds “Krea 2” and 1 connection and runs it".
  - Three clauses use a serial comma when a name list already has "and".
  - A run that waits on placeholders keeps its old words as their own segment.
  - A paid run that no provider can take (no `billedTo`) names only the model.
- **"List prices, not a quote".** It goes first in the disclosure, as the spec says. A run-only proposal has no disclosure, so the plan line also carries it as its `title`.
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
