# 2026-10-24 — Agents ask the person questions and wait for the answers

Branch `feat/agent-questions`, from main at c9e1ff3d (#189 merged). Q125 item 1, the first of four PRs on "an agent's state as the person sees it". Justin, 2026-10-24: "Yes, all four, in that order", then "go with your suggestions". Nothing of items 2 to 4 is built here. The coordinator asks Justin before merging.

## What changed and why

- **Backend, `services/agent_questions.py` (new).** A `QuestionBook` held in memory only (changed by the follow-up below: sets are now kept with the project). A set has 1 to 5 questions from one agent. Each question has text (200 max) and optionally 2 to 6 unique options (80 max), `multiple` and `allowText`. A question with no options must allow text. A set also takes an optional note (160 max) and node ids (unknown ones are dropped and listed). Caps: 3 open sets per agent, 12 in all. The 429 lists the open sets and the withdraw call, in the caller's own words (HTTP, MCP or CLI). Nothing expires on a timer. A set closes on answer, dismiss, withdraw or restart. Closed sets are kept 30 minutes (50 at most). A lost id is a 404 that says to ask again.
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
- **The closed view is temporary** (resolved by the follow-up below). The view of each question and its answer is held in memory only. It lasts until the set is pruned (at least 30 minutes after it closes, at most 50 closed sets) or Nebula restarts. After that a reload shows only "Answered." The answers are never put on the project's Update, because `list_notes` can be read by every agent.
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

## 2026-10-24 — Follow-up: question sets survive a restart

Same branch (`feat/agent-questions`), on top of dfae32f3.

- **Why.** A side agent pointed out that open sets lived in memory only, so a restart closed them and the person's unsent answers were lost. Justin was told it would change before the merge OK. Unlike proposals (staged against the live graph, 15-minute expiry), a set depends on nothing in the graph, has no time limit, and matters most while the person is away during a long run; an outside agent (Claude Code in a terminal) outlives a Nebula restart. GM - Design agreed: "drop 'Closed when Nebula restarted.' if nothing reaches it any more".
- **Where they live.** On the project record, `catalog["projects"][id]["agentQuestions"]`, next to `pins` and `agentNotes`, outside `snapshot` (agent_notes.py's rules): autosave never drops them, each project keeps its own, and Recently deleted keeps them because it moves the whole record. Open and closed sets are both kept, with the same pruning (closed ones 30 minutes, at most 50), now across restarts too, so the closed view (each question and its answer) no longer vanishes on a restart.
- **Same locking and atomic write as the notes.** Every write goes through `ProjectStore.transaction()` and `commit()` (temp file, fsync, `os.replace`). A new set is saved in the same commit as its Update (`AgentNotes.post_questions(save_set=...)`), so there is never a kept set without its Update or the other way round. Answer, dismiss and withdraw save before they answer (off the event loop); if the save fails the set stays open, nothing is announced, and the person can send again.
- **Lock order.** The catalog's lock first, then the book's. Nothing that holds the book's lock waits for the catalog, so a commit inside a transaction (the Update's) and a close in a worker thread can't deadlock.
- **Whose set it is.** A set belongs to the project it was asked in: its Update lives there. Answering, dismissing, withdrawing and `get_answers` don't check which project is open (as before); every write goes to the set's own project, open or not, and to its record in Recently deleted while it is there.
- **After a restart.** The book loads every project's sets (and those in Recently deleted) on first use. An open set keeps its id and owner (the `AgentIdentity` id: `ext:<name>` for a named agent, `app:<id>` for an app token, both stable); `get_answers`, `withdraw_questions`, answer and dismiss all work, and the Update keeps Answer.
- **The key.** Never stored. A new one is made for each set when the book loads, and goes only to the person's sockets after hello (`questionsSync`), as before. The previous launch's key is refused.
- **The person's words.** On disk only inside the set's own record. No agent route reads that key: `project_store.metadata`/`public_project`, `trash_metadata` and `project_view.agent_project` list their keys explicitly, and the Update keeps template words only. Tested across 19 agent-readable routes (Updates, journal, pins, proposals, snapshot, graph and export, project, projects list, a project with and without `view=agent`, size, covers, trash listings, `start_here` for MCP and CLI), as two agents, before and after the project goes to Recently deleted and after a switch back.
- **Deleted for good.** Purging a project (one, the whole trash, or trash past 30 days on a list or restore) also drops its sets from memory (`QuestionBook.keep_projects`), so they don't count against the caps and the asker gets the 404 that says to ask again.
- **"Closed when Nebula restarted."** A restart alone no longer reaches it. One path still does: an Update whose set can't be read back (a damaged or unknown record, or a set from a build that didn't keep them, such as dfae32f3). That Update still needs closing, so GM's line stays for it (tested). Unreadable entries are dropped from the record when the book loads.
- **Caps.** 3 open per agent and 12 in all count kept sets, including ones in Recently deleted; the refusal still lists them with the withdraw call.
- **Frontend.** No code change needed: `synced` already keeps a draft while its set is still open, and takes the new key. Pinned with two store tests; only the store's comment changed.
- **Docs.** MCP-SETUP.md ("No expiry; sets survive a restart"), SKILL.md, `get_answers`' docstring, `nebula ask`'s module doc and the 404's wording now say sets survive a restart; nothing says they don't.

### Decisions not in the spec

- The store is loaded lazily (first use) rather than at boot, and reloaded if `main.project_store` changes (tests swap it).
- A set in a trashed project stays open and comes back with the project on restore. It counts toward its own agent's cap of 3 (the refusal lists it with its withdraw call) but not toward the 12 in all (changed in review, below).
- An answered set's stored answers are checked on load with the same parse as a new answer; anything that doesn't parse makes the whole entry unreadable rather than half-loaded.
- `get_answers` doesn't retry while Nebula is down mid-wait (open item below).

### Tradeoffs and surprises

- Each ask is one catalog commit (set and Update together) and each close is two (the set, then its Update's outcome), as the notes already do. The catalog is rewritten whole on each commit, which is how pins and Updates already work.
- The load order needed a stable sort: sets asked in the same millisecond kept their stored order only with `created_at` as the only key (the cap refusal's list order depends on it).
- The live check's draft reader first read the wrong textarea (the "Other" box); the draft itself was fine.

### Tests (tests first)

- **Backend, new `tests/test_agent_questions_persist.py` (15).** Run against the old code (with a one-line shim so the old book accepted `store=`), 13 failed: an open set gone after a restart (`ValueError: not enough values to unpack` on the stored list, `KeyError` on the set id in the resync), withdraw 404 "a restart of Nebula closes open ones", the cap `assert 201 == 429`, nothing on the record (`KeyError: 'agentQuestions'`), the failed-save test `assert 200 >= 500`, and the private-answers test found no answer for the asker after a restart. Two passed on old code because they check an absence (pruning after a restart, answers private after a switch).
- **Changed.** The old `test_a_restart_closes_the_update_and_get_answers_says_ask_again` pinned the old behaviour and was removed; the unreadable-record test keeps GM's line. The `asked` fixture now uses a book kept on the project store. `test_the_docs_say_sets_survive_a_restart` (new) failed first on `('MCP-SETUP.md', 'memory only')`; the old docs assertion on the restart line was dropped.
- **Frontend.** Two new store tests (reconnect + resync with a new key keeps the open set, the open form and the draft; a Send on the old key fails and keeps the draft, then works on the new one). They passed on the current code: the store already did this.

### Live check

- Isolated backend on 8797 and Vite on 5797 (`VITE_NEBULA_BACKEND_PORT=8797`), temp HOME and every NEBULA_* root under the scratch dir, keys and tokens dropped, outside network refused in the backend. The person token goes in on stdin, the same one both launches, so the tab stays the person's.
- A real MCP stdio session (`mcp_server.py --url`, app token file) asked 2 questions. In the tab: Answer, picked Wide, typed a draft in the second question.
- Killed the backend process (pid changed after the restart) and started it again on the same state. While it was down and after it came back: the form stayed open with Wide picked and the draft text intact, the page didn't reload, the Update had no outcome and still offered Answer (not "Closed when Nebula restarted."), and reopening Answer showed the same draft.
- Send worked, which needs the new launch's key from the resync; the Update said "Answered." with both answers. `get_answers` in the same MCP session returned them (Wide, and the typed text).
- On disk the answers were only in the set's record, no answer key anywhere; no question or answer text in the journal, the backend log or the MCP log; no token in the agent's output.
- 23/23 checks. Blocked requests to 8000-8010 and 5173: 0. Screenshots at 1280 and 1440 (draft before and after the restart, the list after it, the answered Update) are in the session scratchpad under `questions-persist/shots/`; the servers are stopped and the state dir is deleted.

### Gates

- Backend, 17 files (the three question files, agent notes, projects, switching, projects changed, asset trash, canvas proposals and their Updates, the restart outcome, asset and Commons proposal Updates, MCP non-blocking, MCP tools, first-turn fixes, MCP projects and reads): 452 passed.
- Vitest, 4 files (store, form, corner, `agentNotes`): 49 passed. `tsc -b` and lint clean. Build budget 389,512 bytes raw of 512,000; `dist/` deleted.

### Open items

- **`get_answers` across a restart mid-wait.** A wait that spans the restart ends with a connection error; the agent has to call again (the set is still there). Retrying within the wait budget, in MCP and `nebula answers --wait`, would make it seamless.
- **An open set whose Update was pruned** (a project past 200 Updates) now goes (review, below); before, a restart cleared it. Whether the 200-Update prune should skip an Update that still offers Answer is a product call (GM / Justin): today the oldest read one goes, even an unanswered question.

### Review

- Four confirmed findings, each pinned by a test that failed first, then fixed.
- **Two purge paths never told the book** (findings 1 and 4). `POST /api/trash/empty` and the 30-day expiry run by `GET /api/trash` (`_project_trash_items`) deleted project records for good without `agent_questions.keep_projects`, so the sets stayed open in memory, held the caps, and `get_answers` kept saying open until a restart. Both now call it after their transaction, like the other three sites; `/api/trash/empty` also calls `node_errors.keep_projects`, which it had skipped too. One correction to the finding: the person's Projects screen empties through `/api/projects/trash/empty` (already covered); `/api/trash` with projects in it is reached by agents (`list_trash`, `nebula trash`) and direct calls, so the expiry is the likelier way in. Those were all five places a record leaves the catalog for good (`purge_expired_trash` x3, the two trash deletes). As a backstop, `create()` now also forgets open sets whose project is gone, so a future purge route that forgets can't hold the caps.
- **An open set without its Update** (finding 2). One rule, `_has_update`, used on load, on every write and in `create()`: an open set is kept only while its Update is on its project's list. That covers the 200-Update prune (the post that prunes it drops the set in the same commit) and the failed-commit race (a concurrent save sees no such note, so it never writes the set). Decision: a closed set is kept for its 30 minutes even if its Update went, so the asker still gets the answers.
- **Unreachable sets held the total cap** (finding 3). The 12 in all now count only sets in live projects (and ones still being posted); the per-agent 3 count all the agent's sets, since the refusal lists them with withdraw calls. MCP-SETUP.md and the module doc say so.
- **Failed first** (7 new tests in `test_agent_questions_persist.py`): `/api/trash/empty` left the set in `open_list()`; emptying only what the list showed left `get(set_id)`; `GET /api/trash` expiry left it in `open_list()`; an Update-less set after a restart `['lost', 'still'] == ['still']`; a pruned Update's set still in `open_list()`; a never-committed Update's set written by a later save (`[asked, ghost] == [asked]`); a new agent behind 12 trashed sets `assert 429 == 201`.
- **Live check** (backend only: nothing the person sees in the canvas changed). Real backend on 8797 with the same isolation, a real MCP stdio session as Claude Code: 3 asks then the cap; project trashed and `POST /api/trash/empty` as the person, then `get_answers` in the same session said gone/ask again and a new ask worked; that set's project trashed and backdated past 30 days, an agent's `list_trash` purged it and its set went too; 12 sets from four agents filled the total, their project trashed, a new agent could ask; a real restart (new pid), and Claude Code in the same MCP session could still ask, the trashed project still held its 12 sets on disk, and a helper still met its own cap with 3 withdraw calls listed. 15/15 checks; no browser this time, so no blocked-request count (the backend's outside-network guard refused nothing). State deleted, port freed.

## 2026-10-24 — Final pass: neutral pick, past-tense line, no pruning of open sets, waits through a restart

Same branch (`feat/agent-questions`), on top of 9f9fc459.

### What changed and why

- **Picked option: a neutral ring (GM - Design).** "the light ink ring with a faint fill, the same weight as now, just not the agent's color. The pick is the person's choice, not the agent's. And an orange agent would put orange on a selection." `.agent-questions-form__option[aria-pressed='true']` now uses the existing `--an-ink` token (in the app's theme that is `--sr-ink`) for the 1px border and the 1px ring, with an 8% fill of the same ink. No new colour. The agent's colour stays on the form's left edge and its dot.
- **The closed line is past tense (GM - Design).** While open: "{agent} has a question." / "{agent} has {n} questions.". Once closed, for every outcome (Answered, Dismissed, Withdrawn, and the restart line): "{agent} asked a question." / "{agent} asked {n} questions.". The line is stored on the project's Update, so it is changed at the source: `AgentNotes.resolve_questions` rewrites the stored text when it settles the Update (`agent_questions.closed_update_text`, which only changes the template's own end, whatever the agent is called). Every path that closes a set goes through it (answer, dismiss, withdraw, the unreadable-record restart line), including sets loaded from the record after a restart. `note_view` applies the same rule to a resolved question Update whose stored text still says "has" (one closed by the earlier build of this branch), so the person's list, socket messages and `list_notes` all read the same words.
- **Agents see it.** `list_notes` (MCP), `nebula notes` and `GET /api/canvas/agent-notes` return the stored Update through `note_view`, so an agent reading the list sees "asked" once the set closes, the same as the person. The answers themselves are still never on the Update.
- **An open set's Update is never pruned.** `agent_notes._prune` takes a `keep` set: the Updates whose sets are open on the same project record (`agent_questions.open_update_ids`, read inside the same catalog transaction as the prune, never from the book, whose loader would take the catalog's file lock again and deadlock). Every write that adds to a project's list passes it (`_write_project(keep_open=True)`): an agent's Update, Nebula's own, a proposal's and a question set's. Once the set closes its record says so and its Update is prunable again.
- **The bound.** An ask always goes to the open project, and the 12-in-all cap counts every open set in live projects (plus any still being posted). So after any ask, no project holds more than 12 open sets, and a project in Recently deleted can't be asked into (restoring it brings back what it had, which was within 12 when asked). At most 12 of the 200 are kept, so at least 188 others are always prunable and the cap holds exactly as before. A backstop: if only kept ones were over the cap (a hand-edited record), the cap still holds.
- **Waits ride through a restart.** MCP `get_answers(wait_seconds)` and `nebula answers --wait` (and `nebula ask --wait`) now retry a poll Nebula never answered (refused, reset, closed mid-request, no answer in time; `nebula_api.unanswered`: no HTTP status, kind connect or timeout) with a backoff of 0.25 s doubling to 2 s (`nebula_api.next_backoff`), within the wait's own budget, then keep waiting. A real HTTP answer (404, 403, a 5xx with a body) is never retried and ends the call as before. MCP sleeps the backoff in 50 ms slices with the cancel check (`_sleep_unless_cancelled`), so a cancelled call ends within a slice; in the CLI Ctrl-C raises out of the sleep. `get_proposal` is unchanged. get_answers is a read, so a retry repeats nothing.
- **Docs.** MCP-SETUP.md (get_answers line, the closed line, the prune rule, the retry), SKILL.md (the closed line, `--wait` through a restart), get_answers' docstring and `nebula ask`'s module doc. The INSTRUCTIONS paragraph is unchanged.

### Decisions not in the spec

- **Retry only once Nebula was there in this call.** A wait whose first connect is refused fails at once (as today): a wrong URL or a Nebula that was never started shouldn't hold an agent for 5 minutes. A restart mid-wait is the case retried, and since the review that includes Nebula dropping the call's first long poll (see Review).
- **Out of time while Nebula is still down: the connection error, not "timed out".** The last view would be a stale "open". Both surfaces make one last try at the deadline, then report the connection error (MCP raises it; the CLI prints "cannot connect…" and exits 1).
- **The protected ids come from the project record**, not from the book and not from the Update alone, so they are exactly "the set is open" and read in the same transaction as the prune.
- **The old review test** that pruned an open set's Update (`test_an_open_set_whose_update_was_pruned_stops_counting_at_once`) now takes the Update off by hand (renamed `..._left_the_list_...`): the prune can't do it any more, but the book's backstop for a damaged record is still tested.
- The picked fill is 8% (it was 14% of the agent colour); 14% of near-white ink read as a filled button.

### Tradeoffs and surprises

- The proposal bar's neutral ring (#161) is an outline; this is a border plus a 1px ring, the same weight as before, so the pick doesn't jump.
- `tests/test_first_turn_cli.py::test_skill_examples_parse` parses every `` `nebula …` `` span in SKILL.md: "`nebula answers <id> --wait N`" can't parse (N), and `test_the_docs_tie_the_answers_exit_codes_to_wait` wants "with --wait" next to the codes. The line is now "With --wait (`nebula answers <id> --wait 300`) it exits 0 …".
- In the first live run the screenshot showed Square ringed too: that was the keyboard focus outline (focus starts on the first option), not a pick. The shots now move focus off the options first, and a check asserts only Wide has a ring.
- The CLI's old `except httpx.TimeoutException` in the wait loop was dead code (nebula_api wraps every httpx error), so a timeout ended the CLI with exit 1 before too; the unused `httpx` import went.

### Tests (tests first)

- **New `tests/test_agent_questions_final.py` (18)** and **`tests/test_agent_questions_waits.py` (15)**. Run against 9f9fc459 (with a one-line identity stub for `closed_update_text` so the file could be collected; without it collection failed with `ImportError: cannot import name 'closed_update_text'`): 23 failed, 8 errored, 2 passed.
  - Past tense: every outcome and both counts failed with `'Claude Code has 2 questions.' == 'Claude Code asked 2 questions.'` (and "has a question."), in the socket message, `list_notes` and on disk; the restart line and a set closed after a restart the same; the legacy record too.
  - Prune: `_prune() got an unexpected keyword argument 'keep'`; through each write path `assert ['an_…'] == ['filler0000']` (the open set's Update was the one pruned).
  - Waits: the 8 fake-Nebula tests errored on the missing `nebula_api.RETRY_FIRST_SECONDS`; the real-restart test failed with `NebulaAPIError: GET /api/canvas/questions/… failed: Server disconnected without sending a response.` (today's behaviour); the CLI tests failed (`run_answers` took no `sleep` and had no retry); the cancel-during-backoff test failed, since the call ended on the connection error instead of waiting.
  - The two that passed check absences (an open set still says "has" after a restart; a closed set's Update is prunable).
- **Frontend, new `tests/agentQuestionsPickCss.test.ts` (3).** Failed 2 of 3 first: the pressed rule matched `/--an-author/` and had no ink fill. The left-edge test passed (unchanged).
- My first expectations had one wrong case ("Has has 3 questions." gives "Has asked 3 questions.", the agent being "Has"), fixed in the test; the CLI's end-of-budget case first returned "timed out" with the stale view, fixed in the code (one last try, then the connection error).

### Live check

- Isolated backend on 8797 and Vite on 5797 (`VITE_NEBULA_BACKEND_PORT=8797`), temp HOME and every NEBULA_* root under the scratch dir, keys and tokens dropped, the backend refusing any non-loopback request. A headless tab connected as the person; a real MCP stdio session (`mcp_server.py --url`, app token file) as Claude Code (colour #3FC1A5).
- **Neutral pick.** Picked Wide: border and ring `rgba(255, 255, 255, 0.92)` (the theme's `--an-ink`), fill 7% white, never the agent colour (`rgb(63, 193, 165)`) or the orange; the form's left edge still carries the agent colour. Only Wide ringed in the shot.
- **Wait through a restart.** `get_answers(wait_seconds=120)` started; 2.5 s later the backend was killed (new pid after, down about 8 s). While down and after it came back the call stayed pending, with no connection error. The person then sent (Wide plus typed text); the same call returned both answers (4.4 s after Send in this run, 0.8 s in the first run; the machine is loaded), 25 s after it started.
- **Past tense.** While open `list_notes` read "Claude Code has 2 questions."; after Send the person's list showed "Claude Code asked 2 questions." with "Answered.", `list_notes` the same, and the stored Update the same. A one-question set withdrawn read "Claude Code asked a question." / "Withdrawn by Claude Code.".
- No answer key on disk, no answer text in the backend or MCP logs, no token in the agent's output. 22/22 checks. Blocked requests to 8000-8010 and 5173: 0 (canary unreachable). Screenshots at 1280 and 1440 (open form with the pick, closed Update) are in the session scratchpad under `questions-final/shots/`; servers stopped, state deleted.

### Review

- **Two confirmed findings, one cause: a dropped first long poll ended the MCP wait.** `get_answers` only counted Nebula as "there" after a poll succeeded, and the first poll is already a long poll of up to 25 s. If Nebula went away while holding it (a crash, a SIGKILL, or the desktop sidecar, which sends SIGKILL 5 s after SIGTERM), httpx raised `RemoteProtocolError`/`ReadError`, `NebulaAPI.send` mapped that to kind connect, and the call failed at once. Fixed at the cause: a new `nebula_api.dropped_mid_request` says Nebula took the request and went away (the `__cause__` is `RemoteProtocolError`, `ReadError`, `WriteError`, `ReadTimeout` or `WriteTimeout`), and `get_answers` counts that as having reached Nebula, so the wait retries within its budget. A refused or timed-out connect (`ConnectError`, `ConnectTimeout`) on the first poll still fails at once. The CLI didn't have the gap: `nebula answers --wait` and `nebula ask --wait` make a plain request before they start waiting. `get_proposal` unchanged.
- **Tests first.** 7 new tests in `tests/test_agent_questions_waits.py`: a first poll dropped as `RemoteProtocolError`, `ReadError` or `ReadTimeout` rides through (3); a real local server that accepts the first GET and closes it with no answer, then answers (1); a first connect refused as `ConnectError` or `ConnectTimeout` still fails at once (2); a real refused port fails at once (1). Before the fix 4 failed (the three dropped cases with `NebulaAPIError: ... Server disconnected without sending a response.` and the real-server one) and the 3 refused ones passed, as they should.
- **Live check again (8797/5797), this time with SIGKILL.** The earlier run's SIGTERM let uvicorn finish the in-flight poll, so it never hit this path. This run killed the backend with SIGKILL 2.7 s into the first 25 s poll; it was down 7.2 s and came back as a new pid; the same MCP stdio `get_answers` call stayed pending, then returned the answers 0.1 s after the person sent (19.4 s after the call). The neutral-ring and past-tense checks passed again, with shots at 1280 and 1440. 22/22 checks, 0 blocked requests to 8000-8010 or 5173. Servers stopped, state deleted.

### Gates

- Backend, 15 files (the five question files, agent notes, canvas proposal Updates, asset proposal Updates, board Updates in studio, MCP non-blocking, MCP tools, first-turn CLI, agent start, MCP projects and reads, canvas proposals): 368 passed.
- Vitest, 7 files (pick CSS, form, corner, store, `agentNotes`, Updates layout CSS, focus ring CSS): 122 passed. `tsc -b` and lint clean. Build budget 389,871 bytes raw of 512,000; `dist/` deleted.

### Open items

- None new. The picked-option question for GM is settled (neutral ring); the earlier "pruned Update" open item is closed by this pass, as is the restart-mid-wait one.
