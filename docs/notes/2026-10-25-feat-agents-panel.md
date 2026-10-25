# 2026-10-25 — The Agents panel (Needs you / Working), with agent support

Branch `feat/agents-panel`, from main at a6bbbd08 (#192 merged). Q125 item 2 (Justin, 2026-10-24: "Yes, all four, in that order"), plus a small GM copy batch (A: the string-cap download copy; B: whether "Closed when Nebula restarted." can still show).

## What changed and why

- **Status lines (backend `services/agent_status.py`).** An identified agent sets one line about what it is working on, optionally on a node. In memory, like cursors: it lasts until replaced or cleared, or until 10 minutes pass with no sign of that agent (any identified request counts; `RequestHeadersContext` calls the book's `saw` for each one). Each status belongs to the project open when it was set. A node delete or any graph replace drops the node and keeps the text. Every change is an `agentStatus` socket event with a rising `rev`; expiry runs on a `call_later` timer, no polling.
- **The roster (`build_roster`, `GET /api/canvas/agents`).** One entry per agent around in the open project (live cursor, live status, or an open question set or proposal there), Needs you first (longest wait), then Working (most recent first). Counts only: never another agent's questions, the person's answers, a proposal's note or a cursor's `say`.
- **What the last action was.** Cursor events now carry `projectId` and `did: {verb, nodeId, label}` at every edit call site (Added, Changed, Renamed, Moved, Removed, Wired, Unwired, Ran, Tried to run, Proposed, Replied on / Replied, and point_at's verbs). A single `nebula rename` / `nebula move` (label and layout routes) now moves the agent's cursor like any other edit, so its line can say Renamed / Moved; before, those two routes showed no cursor at all. The person's own renames and drags move nothing (tested).
- **Agent support (Justin: "Every feature we add needs to make sure we include MCP support for agents").** MCP `set_status(text, node_id?)` and `list_agents()` (in INSTRUCTIONS, the Krea MCP allow-list and the in-app primer), the CLI twins `nebula status "<text>" [--node nX] [--clear] [--as NAME]` and `nebula agents [--json]` (the same read the panel makes), docs in `docs/MCP-SETUP.md` ("The Agents panel") and `skills/nebula/SKILL.md` ("Say what you're working on").
- **The panel (frontend `components/agent-notes/AgentRoster.tsx`).** At the top of the opened Updates list, under its header. Collapsed: "Agents", then "Needs you" and "Working" with count badges (a group with none is left out; no agents, no panel). Open: the two groups as real lists. Working rows are buttons ("Show on canvas") that bring the node into view the way Show does; with no place on the canvas the row is plain text. Needs-you rows open the oldest item: the question form over the list (Escape gives focus back to the row) or the proposal where it is decided (the same Review an Update's button runs). Status text is one line with an ellipsis and the full text as its tooltip. GM's copy is used verbatim, all of it.
- **Live, no polling.** A small store (`agentRosterStore.ts`) keeps status lines from the socket and reads the roster when the panel mounts, when the socket reconnects and when the graph is replaced. Questions and proposals come from their own stores; node names from the graph store.
- **The unverified ring.** `AuthorDot` takes `verified`; false draws a hollow ring in the agent's colour with the tooltip "This agent named itself." (the panel's rows and the question form's author dot). "unverified" follows the name in each row's accessible name.
- **Lazy.** The panel, its model, its store and `lib/agentRoster.ts` are their own chunk inside the corner's (listed in `DEFERRED_MODULES`), preloaded when the corner mounts.
- **Item A (GM copy batch).** A copy too big for the browser to download (the string cap) now says GM's line: heading "Couldn't download your edits." / "Couldn't download a copy.", body "It's too big to download in a browser." (`TOO_BIG_TO_DOWNLOAD` in `lib/graphFileShared.ts`, raised as `BrowserStringLimitError`).
- **Item B.** "Closed when Nebula restarted." is still reachable, so it stays: a stored question set that can't be read back after a restart (a damaged or hand-edited record, or one from a build whose shape this one refuses) closes its Update with that line (`test_agent_questions_persist.py::test_a_record_that_cannot_be_read_closes_its_update_with_gm_line`).

## Decisions not in the spec

- Badges count agents, not items: "Needs you 2" is two agents; each row's count line says how many questions and proposals.
- The Needs-you badge is drawn in `unreadRingColor` of the longest-waiting agent's colour (the chip's unread ring is the newest unread author's colour, made to clear 3:1). Working's badge is neutral.
- Needs-you counts come from this tab's own stores (sets and proposals it holds a key for). A tab that isn't connected as the person shows those agents in Working; the person's tab, the one that can answer, shows Needs you.
- The panel's open/closed state is remembered while the app runs; opening the list with no agents around closes it (the empty line is only for the last agent leaving while it is open).
- Live cursors this tab heard before the latest roster read are ignored: the read already reports any the backend still has. Without this, after a restart the question agent's stale cursor showed "Looked at …" instead of GM's "Waiting for your answer." (found in the live check).
- The route names: `POST /api/canvas/status` and `GET /api/canvas/agents`. A bare `nebula status` still prints the run state.
- The roster read fails quietly (the panel keeps what it has); there is no GM copy for it, so none is shown.

## Tradeoffs

- Statuses are memory-only, like cursors: a restart clears them by design (GM's restart case).
- Any graph replace drops a status's node (ids restart per graph); the text stays.
- The badge colour follows one agent; two agents waiting show the longest wait's colour.

## Surprises

- The roster's asset-proposal count needed the proposal's own project (its Update's), not the open one.
- The label and layout routes never moved an agent's cursor, so `nebula rename`/`nebula move` were invisible on the canvas too.
- In the live check the page discovers the backend at `localhost:8793`, not `127.0.0.1`, so the dead-proxy bypass list needs both spellings.

## For GM (copy without GM text)

- Verbs used in the last-action line beyond GM's "Moved" and "Ran": Added, Changed, Renamed, Removed, Wired, Unwired, Tried to run, Proposed, Replied on, Replied; and for a bare point_at: at a node Pointed at / Clicked / Dragged to / Looked at, at a spot Moved / Clicked / Dragged / Looked around.
- Agent-facing only (not on the person's screen): the status route's refusals ("A status says what an agent is working on: the person doesn't set one", "Name yourself with NEBULA_AGENT_NAME or --as (an X-Nebula-Agent header) to set your status", the 422s) and the `nebula agents` text layout.
- A second "Closed when Nebula restarted." path that reads wrong: a closed set whose Update could not be resolved (a note or project store error) and that was pruned after 30 minutes would also get the restart line.

## Tests

- Tests first. Backend: `test_agent_status.py` and `test_agent_status_agents.py` failed at collection first (no `services.agent_status`), then per behaviour; the rename/move test failed first with `Added` where `Renamed` was expected. Frontend: `agentRosterModel.test.ts` failed first (module missing); `AgentRosterCorner.test.tsx` was written before the component, and on its first run 2 of 7 failed (statuses emitted before the panel's first read were replaced by that read: the tests now emit after it, as a real read includes them); the stale-cursor case failed first, then passed with the read-time rule. Item A: 6 failures first (missing exports, the generic line, the heading).
- Existing corner tests mock the roster read (the setup refuses unmocked requests).
- The first full backend run caught two of mine: a second `_ago` in `cli/formatter.py` shadowed the pins' helper (renamed `_seconds_ago`), and a SKILL.md example `nebula point --say` with no text failed the examples parser.
- Gates: backend 10750 passed, 71 skipped; frontend 5591 passed and 25 failed in the full run (10 files, timeouts under machine load), those 10 files alone 200/200; errorCopy ratchet 14 files, 173 passed; `tsc -b`, lint clean; build budget 390,616 bytes raw of 512,000.

## Live check

- Isolated backend on 8793 (temp HOME and NEBULA_* roots under the scratchpad, no keys, a person token piped in on stdin and never printed) and Vite on 5793 with `VITE_NEBULA_BACKEND_PORT=8793`; `/api/health` through Vite matched the isolated backend. Chrome with Network.setBlockedURLs for 8000-8010 and 5173 and a dead proxy; canaries (8794, 8000) failed as they should. Blocked requests: 2, both canaries; none toward 8000-8010 or 5173.
- 16 of 16 checks at 1440x900 (and the groups at 1280x800): collapsed line with both badges; both groups open; the Working row's long status clipped with its tooltip; the unverified ring on rows and the form; the Working row flew the canvas to an off-screen node; the Needs-you row opened "A question from Claude Code" and Escape returned focus to the row; clearing the status fell back to "Renamed “Hero shots” · just now"; `nebula agents --json` listed both, counts only; after a backend restart Claude Code stayed in Needs you with "Waiting for your answer." and Codex was gone; answering left "No agents are connected right now."; collapsing then hid the panel.
- Servers stopped by PID, state folder deleted.

## Review

- Review fixes (four confirmed findings; Justin: "go with your recs"). Tests first, each failing on the old code:
  - **Needs-you counted question sets, not questions.** One set of two questions read "1 question" right above "Claude Code has 2 questions." Now the panel (`agentRosterModel.rowFor`) and the roster read (`Waiting.count`, set by `main._waiting_in` from `len(spec.questions)`) both count the questions. GM's "2 questions" counts questions. Failed first: the model test (got 1, wanted 2), `test_the_roster_counts_what_needs_the_person` (now expects 2) and `test_a_question_set_counts_its_questions` (no `count` field yet). The CLI test that pinned "1 question" for the TWO set now expects "2 questions".
  - **An asset proposal with no Update** (made while no project was open) was counted in different places: the panel counted it in whichever project was open, the roster read counted it in its target project (a cover) or in none (a board or Commons). Two findings proposed opposite fixes. I chose the panel's rule for both: such a proposal waits wherever the person is, so it never drops out of every project's Needs you. The other rule would hide a board or Commons proposal from every project. `_waiting_in` now uses `ref.projectId or the open project`. Failed first: `test_an_asset_proposal_with_no_update_counts_in_the_open_project` (the agent wasn't in the roster). A model test pins the panel's side.
  - **Needs-you order** sorted on the wait rounded to 0.1 s, so waits a few ms apart tied and fell back to name order. It now sorts on the exact start time, as the panel does, and rounds only for display. Failed first: `test_needs_you_sorts_on_the_exact_wait` (got Claude Code before Gem). A model test pins the panel's side.
  - docs/MCP-SETUP.md says what `needsYou` counts.
- Review live check (8793/5793, same isolated setup, the same script with a two-question set): 14 of 16 checks passed. The Needs-you row read "2 questions" (aria-label "Claude Code, unverified, 2 questions. Open questions"), matching the Update "Claude Code has 2 questions." under it, and `nebula agents --json` said 2. After a backend restart the row still said 2 questions with "Waiting for your answer." Of the two failures, one was my script expecting the one-question heading; a set of two opens as "Questions from Claude Code", the existing copy. The other: the run stopped on a screenshot timeout after the restart check (load average about 25), so the answer-and-empty-state part didn't run this time. Nothing it covers changed. Blocked requests: 2, both canaries; none toward 8000-8010 or 5173. Servers stopped and state deleted.
- Review gates: backend 10753 passed, 71 skipped. Frontend full run: 5466 passed, 153 failed in 45 files (118 timeouts at load average 14-28). Those 45 files alone: 706 passed, 16 failed in 7 files. Those 7 files run one at a time: 171/171. `tsc -b` and lint clean. Build budget 390,616 bytes raw of 512,000. No user-facing copy or error handling changed, so I didn't run the errorCopy ratchet on its own (it passed inside the full run).

## Open items

- GM: the verbs above, and the second restart-line path.
- The canvas still draws a cursor the browser heard before a backend restart until it expires (2 minutes); the panel no longer lists it. Pre-existing.
