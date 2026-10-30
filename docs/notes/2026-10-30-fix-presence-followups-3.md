# fix/presence-followups-3 (follow-up 3 to PR #202)

Base: main at deb5d6f5 (the #202 merge). Scope: GM's held "agents need you"
ruling (`gm-held-needsyou`), GM's Studio-across-a-promote ruling
(`gm-studio-promote`), and review 5's LOW-1 and NIT-1 on #202.

## What changed

### 1. A held tab counts who needs you from its Updates

- `agentNeedsYou.heldAsks(notes, holds)` turns the open project's unresolved
  ask Updates (`source: "nebula"`, agent-authored, `about` proposal or
  question) into asks. It skips any id the tab already holds as a real view
  (an answerable question set, a canvas proposal, an asset proposal).
- `waitingByAgent` takes `held` next to the views, deduped by id, so the
  corner badge (`useNeedsYouCount`) and the Agents panel's Needs-you group
  (`buildRosterRows`) still read one rule. There's no badge-only path.
- Question Updates now carry `{id, count, since}`, and canvas Updates carry
  `since`, so a held row shows "2 questions" and orders by the ask's own
  time, not the Update's. The values are checked server-side
  (`agent_notes.questions_detail`: count 1..5, since 0..max) and in
  `sanitizeNote`. The canvas undo-reopen keeps `since`.
- A held row keeps the dot, name, count and ask line. It is
  `aria-disabled`, still focusable, and its tooltip and aria-label give the
  reason: "You can review this when this tab is connected as you." for
  proposals, "You can answer this when this tab is connected as you." for
  questions. A click does nothing. `.agent-roster__row` joined the shared
  disabled style's ghost list (`disabled-buttons.css`).
- Round 2 (GM, #204 r1): a held row reads disabled. A new shared rule in
  `disabled-buttons.css`, for ghost controls whose label is several lines,
  gives every line of row text (name, count, ask line) the shared grey
  (`--sr-disabled-ink`, the app's disabled label ink; GM's message called it
  `--disabled-label`). It overrides the lines' own inks; the author dot and
  its letter keep their colours. In the restraint theme the ask line's
  enabled ink is already that grey, so the name and count are what dim.
  On promote the grey lifts and the action turns on. Boxes, order and words
  don't change, and the badge reads the same.

### 2. Moodboard Studio stays open across a promote

- Cause: the person link (`#nebula-person=…`) replaces the `#moodboard/<id>`
  hash. `personSession` strips it, and `useMoodboardDeepLink`'s hashchange
  handler (~71-80) read the now-empty hash as "leave the Studio".
- The hook now ignores a hashchange to or from a person link and puts the
  board's hash back (`personSession.isPersonLinkHash`).
- The open board is also kept in the tab's own `sessionStorage`
  (`nebula.studioBoard`). A same-tab load with no board hash (the hash empty,
  `#`, or a person link) restores the Studio from it, the same way the hash
  would. A board deleted meanwhile gets the Studio's existing "Moodboard not
  found", just like a `#moodboard/<id>` link to it (GM, #204 r1: one
  behaviour for a missing board however reached; "← Canvas" is the way out).
  Round 1 landed on the canvas instead; round 2 dropped that check.
- Live: the same board, the held placeholder at y=293 becomes the real card
  at y=293, the scroller stays at 40, the hash comes back, and a reload
  without the hash reopens the Studio.

### 3. Review 5 LOW-1 and NIT-1 (backend)

- LOW-1: `resolve_proposal` takes `closed`. Inside the notes lock it skips
  the resolve when the Update's current proposal is open again, as
  `reopen_proposal` already did. All three resolve sites pass
  `_proposal_closed`: the asset follow, the settle and the canvas follow.
- NIT-1: `retarget_proposal` writes nothing (and broadcasts no "changed")
  when the ref and text would be unchanged. With three asks, one close now
  sends one "changed".
- Tests make the race deterministic: the reopen runs inside the resolve's
  lock window, per site, plus a store-level unit test.

## MCP

Agents' view of "who is waiting" is unchanged: `/api/canvas/agents` (MCP
`list_agents`, CLI `nebula agents`) counts server-side from the books
(`_waiting_in`), not from Updates. `docs/MCP-SETUP.md` now documents the
question Update's `{id, count, since}`, the canvas Update's `since`, and that
a held tab counts from Updates with the row action locked.

## GM questions and their answers

- The roster has no separate "Review"/"Answer" button: the row is the
  action. GM ruled the row is the control, so its text goes grey (above).
- A missing board: GM ruled one behaviour, the Studio's "Moodboard not
  found" (above).
- "FU3 board" on the promoted Studio card is the proposal's own `note`: the
  agent's free text from the ask body, cleaned by `asset_proposals.clean_note`
  and rendered as `.asset-proposal__note` (`AssetProposalStrip.tsx`,
  `{view.note && …}`). The live script posted the ask with
  `note: "FU3 board"`. It isn't the board's name or a snapshot of one, so the
  live-name rule doesn't apply. It's unchanged; GM rules the wording.

## Verification

- On deb5d6f5, every new or changed test fails: backend 9 failed, 76 passed
  (the passing ones guard behaviour that's already right); frontend 9 of 20
  failed.
- Mutations: 23 of 23 killed (8 backend, 15 frontend).
- Review 5's r6 probe on this branch: the undo races and single reopen stay
  open, and three asks send one "changed".
- Live on 8795/5795 (isolated HOME, dev ports blocked, no accept, reject or
  execute): 21 of 21.
- Gates: tsc, lint, vitest (607 files, 7632 tests), vite build, budget
  (423,073 bytes raw). The full backend run gave 11,932 passed and 1 failed:
  `test_journal_write_project`'s `_reopen_update` stub took two arguments,
  and the canvas reopen now passes `since` as `detail`. The stub now forwards
  `*args, **kwargs`. That file and the related suites pass (66).

## Round 2 verification (GM, #204 r1)

- New tests fail on ffd33872. The held-row ink test reads computed colours
  from the real sheets. The Studio restore of a missing board must match the
  `#moodboard/<id>` link's state.
- Mutations on the grey rule are both caught: dropping it, and widening it to
  the dot.
- Live on 8795/5795: 22 of 22. Held rows' name, count and line compute to
  `rgba(255, 255, 255, 0.55)`. Promoted, the inks come back, and the dots,
  boxes, order and words don't change.
- Gates: tsc, lint, vitest (7,633), build, budget (422,896 bytes raw), and
  the full backend (11,933 passed).

## Round 3 (review 1 on ffd33872; GM 2026-10-30, `gm-pr204-r2`)

### MEDIUM-1: two asks that share one Update

- One agent's open asset asks on one target share one Update, whose ref
  named only the newest ask. A held tab read "Codex: 1 proposal", dated by
  the newest; the promote read "2 proposals", dated by the oldest, and the
  row moved.
- The shared Update's ref now carries `asks` (how many open asks share it,
  1 to `MAX_SHARED_ASKS`, which is `canvas_proposals.MAX_OPEN_PER_AGENT`) and
  `firstSince` (the oldest one's createdAt in ms). `main._asset_share_detail`
  computes both from the open sharers.
- They're written where an ask joins or leaves the Update: the post (all the
  agent's open asks on that target), the follow's retarget (the asks still
  waiting), and an undo's reopen. `_refresh_asset_update` re-counts after
  the reopen, because `reopen_proposal` leaves an Update another open ask
  holds as it was.
- `proposal_detail` checks both; `_retargeted_ref` drops them, so a caller
  passing none never keeps a stale count. The tab's `sanitizeNote` checks
  them too.
- `heldAsks` uses `asks` as the proposal count and `firstSince` as the time.
  `WaitingProposal.count` and `proposalCount` sum it, for the badge and the
  rows alike.
- MCP-SETUP documents both fields, which agents see too. `list_agents` is
  unchanged: it counts from the books.

### LOW-1: the Studio restore never overrides the person

- Round 2 already took out the request, so the restore opens synchronously
  once the project is ready.
- New: a restore still waiting (no project yet) is dropped if the view
  changes before it lands (another board, the canvas, any view).
- Tests cover:
  - no request is made;
  - another board, or another view, opened before the restore lands wins;
  - leaving after the restore stays left and forgets the board;
  - a 500 from the board read never clears the record.

### LOW-2 (GM): restore only on a reload

- `navigationType()` reads `performance.getEntriesByType('navigation')`. The
  tab's record restores only on `reload`.
- `navigate` (a typed address, a bookmark, a fresh link), `back_forward`,
  `prerender` or no entry all land where they point, and the tab forgets the
  board.
- A reconnect never navigates (the promote's hashchange, a socket coming
  back, a project re-sync), so the Studio just stays. Its test covers that.
- I read `back_forward` as not a reload: GM named reload and reconnect only.
- The first Back press is left alone, per GM.

### Stale "not connected" lines (GM, widened)

- One mechanism, `lib/clearsOnPromote.ts`:
  - `clearsOnPromote(clear)`;
  - `clearLineOnPromote(error, current, line, clear)` for store lines;
  - `clearSetterOnPromote(error, setLine, line, empty)` for component state.
  It registers only a person-gate refusal (`code: person_required`). On the
  promote (`notePersonPromoted`) every registered line goes in one sweep,
  but only while it is still the line shown, so a newer line with another
  reason stays.
- Moved onto it: the canvas pins' refusal, the canvas and asset proposal
  errors, and the person banner. They each had their own `onPersonPromoted`
  listener.
- Added for every surface of every person-gated backend function:
  - the Updates list (mark read, dismiss, the corner's step failures);
  - question answer and dismiss;
  - Settings: rows through `settingsWrites.fail`, Connected apps, Personal
    agents (load and changes), the personal-agent warning and the spend
    view's load;
  - the chat panel: the `person_required` transcript line, the turn's
    authority notice, Codex ChatGPT sign-in, Clear's refusal;
  - the model switch's toast (and any canvas toast that carries GM's
    person line);
  - the Projects screen line (cover pin, Delete for good, Empty);
  - Create's Enhance;
  - Recently deleted;
  - Moodboard Studio's brief and save failures (`_refuse_override_change`).
- Load errors (Personal agents, the spend view) also read again on the
  promote. A Studio save failure puts the draft back to unsaved, so it saves.
- Tooltips and locks that read the gate's live state needed nothing, since
  they follow it: the held rows, the proposal bar, Send note.
- `tests/clearsOnPromote.ratchet.test.ts` checks three things:
  - Every backend function that calls `require_person` is in its table, with
    the files that show its refusal, and each goes through the mechanism. A
    new gated function fails until it's listed.
  - Any file that recognises the refusal uses the mechanism or is a listed
    classifier.
  - No other `onPersonPromoted(` clears a line; the approval releases are
    listed as not a line.
- Found with no line to clear: `release_run_approval` (failures swallowed),
  the asset-proposal relist, and the permission card.
- "Couldn't mark the updates as read…" predates #204. The read route's gate
  and the heading are both on deb5d6f5; the heading dates to a42ef37a
  (2026-10-22).

### NIT-1, NIT-2

- Tests now kill the four surviving mutants:
  - `heldAsks` without its `holds` skip;
  - the question count bound;
  - `followStudio`'s person-link guard;
  - the no-op retarget ignoring the words.
- `MAX_REF_QUESTIONS` is now `agent_questions.MAX_QUESTIONS`.
- The frontend's `MAX_REF_QUESTIONS` and `MAX_SHARED_ASKS` are pinned to the
  backend's by a backend contract test that reads `lib/agentNotes.ts`. The
  same test checks that the backend source references the constants rather
  than copying the numbers.

### Round 3 verification

- On c1788d1f:
  - Backend: 8 of 11 new tests fail. The 3 that pass guard behaviour that
    was already right: the NIT-1 words, the question bound, and no stale
    share keys.
  - Frontend: the reviewer's repro, the undo reopen and the share bound
    fail (with the base given the two new constants, since the test file
    imports them).
  - The ratchet fails 3 of 4.
  - Every navigation-type and person-move restore test fails.
  - The mechanism's tests fail on import.
- Mutations: 26 of 26 caught (8 backend, 18 frontend).
- Live on 8795/5795: 15 of 15.
  - The review's repro reads [Codex: 2 proposals, Claude Code: 1 question],
    held and promoted, with the same boxes and badge.
  - Withdrawing one while held reads 1 in both states.
  - The stale line shows while held and is gone after the promote.
  - A reload restores the Studio; a typed address lands on the canvas and
    forgets the board.

### Merge of main (#198, 38bb573a)

Round 3 merges origin/main, which brings in #198.

- The merge itself had one conflict, in `frontend/src/styles/disabled-buttons.css`.
  - The roster row joins both of #198's ghost lists, with `:not([data-held-pending])` like the rest.
  - My multi-line row rule comes after #198's quiet-choice rule and uses #198's `--disabled-label`.
  - The dot is still excluded, so it keeps its colour.
  - The result matches Review 24's trial resolution byte for byte.
- Putting round 3 back on top hit four more conflicts, all in imports: `CreateComposer.tsx` (main added `lockedAction`), `AgentSpendSection.tsx` and `ConnectedApps.tsx` (main added `formatSpentUsd`), and `graphStore.ts` (main added `headedLine`, `isNamedLine` and `nodeNameList`). Each one keeps both sides.
- `AgentRosterHeld`'s grey now reads `var(--disabled-label, …)`.
- The ratchet passes on the merged tree, so #198 adds no `require_person` route that the mechanism doesn't cover.

### The full backend run found a stale count (MEDIUM-1 follow-up)

The first full backend run on the merged tree failed 9 tests.

- 8 checked an asset Update's exact ref, written before the ref carried `asks` and `firstSince`. Each one now expects them with the right count: 2 where two asks share the Update, 1 after one closes.
- 1 was a real bug: `test_a_move_onto_the_proposal_the_update_already_reviews_says_nothing`, from review 5's "three-one" race.
  - The outer follow counted p1 and p2. Before its write ran, p2 closed and p2's own follow wrote the right count, `asks: 1`.
  - The outer write then landed with the stale `asks: 2` and a second "changed".
- The fix: `retarget_proposal` and `reopen_proposal` take a `share` reader (`main._share_reader`) and call it inside the notes write. The follow, the refresh and the undo reopen all pass one, so the last writer counts the asks as they are.
- `ProposalBook.open_list` copies the book's items before filtering, because that reader now runs on the notes worker thread.
- The race test now also checks `asks` and `firstSince`. Computing the share before the write, as before, brings back `(2, p2's time)`, so the mutant is caught (27 of 27 overall).

### Gates on the merged tree

- tsc and lint are clean.
- vitest: 8,576 passed in 673 files.
- build: 445,644 B raw (limit 512,000).
- backend: 12,326 passed in a full isolated run, after the fix above.
- Live: 15 of 15 on 8795/5795.
  - An earlier live run, made while pytest was running, lost a puppeteer evaluate ("Promise was collected") at the start of part B.
  - The idle re-run passed every check.
