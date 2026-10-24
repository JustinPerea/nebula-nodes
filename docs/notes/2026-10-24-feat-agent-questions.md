# 2026-10-24 — Agents ask the person questions and wait for the answers

Branch `feat/agent-questions`, from main at c9e1ff3d (#189 merged). Q125 item 1, the first of four PRs on "an agent's state as the person sees it". Justin, 2026-10-24: "Yes, all four, in that order", then "go with your suggestions". Nothing of items 2 to 4 is built here. The coordinator asks Justin before merging.

## What changed and why

- **Backend, `services/agent_questions.py` (new).** A `QuestionBook` held in memory only. A set has 1 to 5 questions from one agent. Each question has text (200 max) and optionally 2 to 6 unique options (80 max), `multiple` and `allowText`. A question with no options must allow text. A set also takes an optional note (160 max) and node ids (unknown ones are dropped and listed). Caps: 3 open sets per agent, 12 in all. The 429 lists the open sets and the withdraw call, in the caller's own words (HTTP, MCP or CLI). Nothing expires on a timer. A set closes on answer, dismiss, withdraw or restart. Closed sets are kept 30 minutes (50 at most). A lost id is a 404 that says to ask again.
- **Routes (`main.py`).**
  - `POST /api/canvas/questions` asks. A person is refused, a request with no agent name is 400, and with no project open it is 409.
  - `GET /api/canvas/questions/{id}?wait=` reads. Owner-only: another agent gets 404.
  - `DELETE /api/canvas/questions/{id}` withdraws.
  - `POST /{id}/answer` and `/{id}/dismiss` are the person's: `require_person` first, then the set's answer key in `X-Nebula-Proposal-Key` (compared with `compare_digest`), then a check that the set is still open.
  - The key goes out only on browser sockets (`questionsOpened`, `questionsSync` after hello). Agents follow along through journal events (`question.asked/answered/dismissed/withdrawn`), which carry ids and counts and never any text.
- **Updates.**
  - Asking posts a Nebula-template Update ("{agent} has a question." / "{agent} has {n} questions.") with one Answer action, about `question`. It never holds the questions or the answers.
  - Closing settles it with the outcome: "Answered." "Dismissed." "Withdrawn by {agent}." On restart it reads "Closed when Nebula restarted." Proposals keep their own line.
  - One Update per set, and no double-posting: if the Update can't post, the set is dropped and the ask fails with 409.
- **Agent support (every feature ships it).**
  - MCP: `ask_person`, `get_answers` (waits up to 300 s in 25 s polls) and `withdraw_questions`. They are listed in `NEBULA_MCP_TOOLS`, in the INSTRUCTIONS paragraph and in the in-app primer.
  - CLI: `nebula ask` (repeatable `--question/--option/--multiple/--no-text`, `--note`, `--node`, `--file`, `--wait`), `nebula answers <id> [--wait N]` (with `--wait`: exit 0 answered, 2 timed out, 3 dismissed, 4 closed otherwise; without it, always 0, as `nebula proposal <id>` does) and `nebula questions withdraw <id>`.
  - Docs: `docs/MCP-SETUP.md` ("Questions for the person") and `skills/nebula/SKILL.md` ("Ask the person").
  - No surface lets an agent answer or dismiss. Tests check this for MCP, the CLI and the HTTP routes.
- **Frontend.**
  - `store/agentQuestionsStore.ts` (eager, in `STARTUP_STATE`) is fed by the socket and keeps sets by id, with `openByAgent` for item 2. It also keeps the person's drafts per set until Send or Dismiss (they don't survive a reload).
  - The Update's Answer opens `AgentQuestionsForm` as a popover over the Updates list, at the list's place and width (`placeCorner` places it). It is lazy-loaded in its own 3.3 KB chunk, preloaded once a set is open.
  - The answered Update shows each question with its answer, or "No answer." (`AgentQuestionsAnswers`).
  - All copy is GM's, verbatim.

## Decisions not in the spec

- **The key header.** The answer key reuses the proposals' `X-Nebula-Proposal-Key` header, so the desktop CORS allow-list stays as it is.
- **Owner scoping.** Read and withdraw by another agent return 404 (proposals' withdraw gives 403), because a set holds the person's answers.
- **Project switches.** Questions survive a project switch (canvas proposals are invalidated by one). Answering doesn't check which project is open.
- **No agent list route.** Agents read their own sets by id and get no list route ("expose nothing new"). The book can list each agent's open sets for item 2.
- **Text handling.** Answer text keeps its newlines. `multiple` without options is refused. The private-note guard isn't applied to question text, since no other agent ever sees it.
- **`start_here` budget.** Its MCP `next` hint has no room (1186 of 1200), so MCP agents get the INSTRUCTIONS line instead. The CLI hint ends with "A decision only they can make: `nebula ask`."
- **INSTRUCTIONS cap.** The paragraph was at 2999 of a 3000 cap. Three unpinned phrases were trimmed to fit the new line. It is now 2988.
- **Picked options.** They use the proposal review's selection: the agent's colour ring with a faint fill, and `aria-pressed`. They never use the `--sr-accent` orange. An agent whose own colour is orange will still look orange; flagged for GM below.
- **Buttons.** Answer is a plain list button; Send is the primary (ink) button.
- **Escape.** It closes only the popover (the draft stays) and focus goes back to the Update's Answer. Answer from a dropped card opens the list under the popover, so focus has somewhere to return to.
- **A tab with no key.** Answer there raises the person-required banner, and the list shows the backend's own line: "These questions can only be answered from the Nebula canvas."
- **Ctrl/Cmd+Enter** in a typed answer sends. Plain Enter types a new line; Enter on Send sends.

## Tradeoffs and surprises

- Each question is a `div role="group"`, not a fieldset. A fieldset's legend sits on its border, outside the padding, and crowded the divider (seen in the live screenshots).
- The live check's width comparison has to wait for the drop-in spring to finish, because its scale is part of the measured box.
- Moodboard Studio's board Updates don't carry questions. Questions post to the project's list only, as proposals do.
- **The closed view is temporary.** The view of each question and its answer is held in memory only. It lasts until the set is pruned (at least 30 minutes after it closes, at most 50 closed sets) or Nebula restarts. After that a reload shows only "Answered." The answers are never put on the project's Update, because `list_notes` can be read by every agent.
- **The card's x on a question Update.** It only drops the card (its title says "it stays in Updates"). Unlike other Updates it doesn't grey the Update to "Not now": the Update is the person's only way into an open set (no expiry, no canvas bar), so Answer stays until the set closes and the outcome replaces it.

## Tests (tests first)

- **Backend.** `tests/test_agent_questions.py` (53) and `tests/test_agent_questions_agents.py` (15). They first failed at collection with `ModuleNotFoundError: services.agent_questions`.
  - Fixes along the way: an invalid `Authorization: Agent` token gets 401 from the middleware, so that one case accepts 401 or 403. A doc line wrap split "`nebula answers`", so the doc was rewrapped. INSTRUCTIONS went over the cap (3156, then trimmed), and `start_here`'s budget took 1270 of 1200 (the MCP hint was dropped).
- **Frontend.** `tests/agentQuestionsStore.test.ts` (8) and `tests/AgentQuestionsForm.test.tsx` (9) first failed with "Failed to resolve import" (the modules didn't exist). `tests/AgentQuestionsCorner.test.tsx` (4) then failed 4 of 4: no dialog opened, and Answer threw "can't run from here".
- **Gates.**
  - Backend, 21 files: 505 passed.
  - Vitest, 15 files: 453 passed (241 + 212).
  - `tsc -b` and lint are clean.
  - Build budget: 389,512 bytes raw entry of 512,000. `dist/` was deleted afterwards.

## Live check

- **Setup.** An isolated backend on 8797 and Vite on 5797 (`VITE_NEBULA_BACKEND_PORT=8797`), with a temp HOME and every NEBULA_* root under scratch. The backend refuses any non-loopback request. A headless tab was connected with a person link.
- **Blocking.** 8000-8010 and 5173 were blocked with CDP and a dead proxy. A canary port was unreachable. Blocked attempts: 0.
- **Run.** A real MCP stdio session (`mcp_server.py --url`, app token file) called `ask_person` with 2 questions (one with Square/Wide/Tall, one text-only), plus an unknown node id, which was dropped. `get_answers` with a 1 s wait came back timedOut while the set was open.
- **What showed.**
  - The card dropped: "Claude Code has 2 questions." with Answer and Show on canvas.
  - The form opened over the list, same left, right, top and width (371 px at 1280), not inside the canvas. It showed GM's heading, skip line, "Other" and both placeholders.
  - Focus started on Square, and Send was off until something was answered.
  - Escape closed only the form and focus went back to Answer. Enter reopened it.
  - The picked option ring was the agent's colour, never `255, 90, 31`.
  - After Send (Enter on it), the Update said "Answered." and showed both answers.
  - `get_answers` returned exactly the two answers.
- **Refusals and leaks.** An agent's POST to the answer route got 403. The journal held `question.asked` and `question.answered` with no text. There was no token in the MCP transcript and no answer text in the backend log. 26/26 checks passed.
- **Screenshots** (1280 and 1440) are in the session scratchpad under `agent-questions/shots/`: the card, the list with the Update, the form, and the closed Update.

## Review

- **Fixes after the adversarial review (four confirmed findings).**
  - The card's x on a question Update greyed it to "Not now" for good (dismissedAt is saved on the project) and took Answer away while the set stayed open. Now `noteDone`/`stateLabel` (`lib/agentNotesView.ts`) ignore dismissedAt for `about: 'question'`; only the set's close greys it. Tests first: a corner test (x, then the list still offers Answer and it opens the form) failed on "Not now", and a unit test in `src/lib/agentNotes.test.ts` failed with `expected true to be false` on `noteDone`.
  - The temporary closed view is now written down above (Tradeoffs) and in Open items for GM. No code change.
  - `get_answers` cancellation and wake-on-answer had no tests. Added a `get_answers` row to `test_a_cancelled_call_ends_cleanly` (plus a questions route in its fake Nebula) and `test_a_wait_returns_as_soon_as_the_person_answers`. The code was already right, so both passed at once; to see them fail I mutated the code for one run and put it back: without `_stop_if_cancelled` in `get_answers` the cancelled call held its thread 5.0 s, and with the route waiting on `kinds={"proposal"}` the wait ran the full 10.0 s.
  - The docs listed `nebula answers` exit codes 2/3/4 without saying they need `--wait`. Kept the code (it matches `nebula proposal <id>`) and fixed both docs. A new docs test failed first on MCP-SETUP.md.
- **Live re-check** on 8797/5797, same isolation: asked 2 questions over a real MCP stdio session, clicked the card's x (dismissedAt saved), reloaded, and the list still showed the Update ungreyed with Answer; the form opened, Send closed it as "Answered." with both answers, and `get_answers` returned them. 17/17 checks, 0 blocked requests. Screenshots under `agent-questions/shots-review/` in the session scratchpad.
- **Gates after the review fixes.** Backend: `test_agent_questions.py` (54), `test_agent_questions_agents.py` (16), `test_mcp_nonblocking.py` (10): 80 passed. Vitest, 13 files covering Updates and questions: 303 passed. `tsc -b` and lint clean. Build budget 389,512 bytes raw of 512,000; `dist/` deleted.

## Open items

- **For GM.** The picked-option style is the agent's colour ring (proposal review's selection), so an orange agent's pick looks orange. Is that right? The "Other" label uses the list's mono meta style.
- **Moodboard Studio.** Its Updates can't carry questions yet, since board proposals don't work there either.
- **Item 2 (Agents panel).** It reads `openByAgent` from the store; the backend's `QuestionBook.open_for_agent` is ready for it.
- **For GM: a temporary closed view.** The answered Update shows each answer only while the set is in memory (see Tradeoffs). Is that acceptable, or should Updates later keep the answers in a person-only store?
