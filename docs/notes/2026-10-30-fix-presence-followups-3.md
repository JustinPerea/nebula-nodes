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

## Round 4 (review 2 on 24e7ebc7; GM 2026-10-30, `gm-pr204-r3`)

### GM item 1: a truthful header

- Marking read is no longer optimistic. `sendRead` sets `readAt` only on the
  ids the server's answer lists, and takes `unread` from it. A refused read
  leaves every Update unread.
- The header leads with the server's count: "N unread" while any is unread,
  then "N new" for arrivals, then "all read". "all read" now means the server
  has them read. GM didn't word it, so I chose "N unread"; it matches the
  chip's count.
- On a person refusal the write registers `retryOnPromote` (in
  `lib/clearsOnPromote.ts`, keyed per list and per read, so a later refusal
  of the same read replaces the earlier one). The promote's sweep clears the
  lines first and then runs the retries, once each. A retry that fails again
  says nothing new (`retry = false`).
- Another reason (a 500, offline) keeps its line and isn't retried.

### GM item 2: Review and Answer locked in a held tab, on every surface

- `components/agent-notes/heldLock.ts` is the one rule:
  - `holdsAskIn` (shared with the Agents panel rows and the badge's count);
  - `heldLockFor(note, holds, tabHeld)` built on `heldAsks`;
  - `HELD_OPS` (`proposal.review`, `question.answer`);
  - `useHeldLock`.
- `NoteButtons` (used by the opened list and the arrival card) greys those
  two buttons through `BusyButton`'s `locked`. They stay in place with the
  same words and are still focusable. They carry `aria-disabled` and their
  lock reason as the tooltip, and a click does nothing. Show on canvas and
  Not now stay live.
- Every Review and Answer goes through `NoteButtons`, so that is the one
  place the lock is checked. A second check I'd put in the corner's
  `runAction` survived mutation (nothing reaches it except through
  `NoteButtons`), so I took it out.
- The grey is the shared ghost rule: `.agent-notes-btn--held` joins both
  lists in `disabled-buttons.css`, which use `--disabled-label`.
- The lock asks whether the tab is held, using assetProposalsStore
  `awaitingSync`, the flag the held placeholders read. Without that check, a
  connected tab locked Review on an Update whose ask it had no proposal for
  (an orphan), which broke `AgentNotesEveryScreen`. The roster's `locked`
  got the same check (`RosterInput.tabHeld`, default true). Counting is
  unchanged.
- The arrival card line (`AgentNoteCard.tsx:79` in the brief) goes through
  `NoteButtons`, so it is covered by the same change.

### GM item 3: the stale line's words

- `MARK_READ_REFUSED_COPY`: "Nebula couldn’t mark the updates as read because
  this tab isn’t connected as you. Open the link Nebula printed when it
  started." It has no "try again", because the promote retries.
- `markReadRefusedCopy(desktop, reason)` also has a desktop variant and a dev
  variant, following `PERSON_REQUIRED_COPY`'s. GM worded only the browser
  line, so the other two are my extrapolation; flagged for GM.
- Each is a single literal, so the named-line ratchet reads it.

### Review 2 MEDIUM: every line registered; the ratchet sees every gate

- Registered: the Krea row (`useKreaConnection`, `KreaSignInRow`) and the
  project save line (`projectStore`).
- The live run found the Krea registration didn't work. `kreaJson` throws a
  `FailureNotice`, which carried no `code`, so `isPersonRefusal` never
  matched a real refusal. The unit test had mocked a `RequestFailedError`.
  `FailureNotice` now takes an optional `code`, and `kreaJson` passes the
  refusal's. A test runs connect, check and disconnect through the real
  request path. No other `FailureNotice` is built from a server refusal; the
  run and shot starts throw `ExecutionStartRejectedError`, which keeps its
  code.
- The widened ratchet found two more surfaces:
  - a run start refused for the person (`markNodesErrored`, which now puts
    the nodes back as they were at the refusal: `withoutRefusedStart`);
  - a shot start (`clearShotRefusal`: the shot goes back to `done` if it has
    an image, else `idle`).
- `gatedFunctions()` now finds all four gate forms:
  - `require_person(`;
  - Krea's `person_only` routes (`krea_connector.*`);
  - `_person_only_refusal(` callers;
  - `stop_refusal`.
- Every registration line carries `// clears-on-promote: <site>`.
  - SITES lists each site with its file.
  - GATED maps each gated function to its sites, or to NO_LINE.
  - OTHER_SITES lists the registrations not tied to one gate.
  - The test checks each site once, in its file, on a real call into the
    mechanism, and checks that no call into the mechanism goes unmarked.
- No line to clear:
  - `krea_connector.person_only`: the dependency itself; its four routes are
    listed by name;
  - `_reader_spend_hold`: `POST /api/moodboards/{id}/read`, which no tab
    calls (agents and the CLI only);
  - `_refuse_stopping_the_persons_run`: a refused Stop shows no line, since
    `requestTrackedCancellation` keeps the intent and asks again.
- Mutation sweep of the registrations: 39 of 39 caught (each marker line
  removed in turn). Changing any gate form's source in the test is caught
  too.

### Review 2 LOW: `_post_asset_update` reads the share inside the write

- `post_proposal(..., share=)` calls the reader inside the notes write, so a
  close that lands before the write is never counted.
- A close after the write but before the new ask joins the Update lands on
  the old Update. So after the "added" broadcast, the post counts again with
  a targeted `retarget_proposal` onto the posted ask, and broadcasts
  "changed" only if that wrote something.
- Tests use a fixed interleave: the close and its follow run inside the
  patched notes call, on the loop, with no sleeps. One test closes before
  the write (one "added" with 1), one after (a "changed" with 1), and one
  checks that nothing closing writes once.
- A probe found an orphan. p1 closes, the same agent's p2 replaces its
  Update, and an undo reopens p1. p1 reopened its old, resolved Update next
  to p2's live one. Now a reopened ask whose agent already has a live Update
  on that target joins it, so the Update counts both, and p2 closing falls
  back to p1.

### Cross-agent visibility of `asks` and `firstSince` (Justin's decision)

- Showing these counts across agents changes what agents can see of each
  other, so the coordinator took it to Justin. He chose this option on
  2026-10-30: only the agent that made the asks, and the person's tabs, see
  the count and time; other agents see the Update as before.
- Who sees them:
  - `is_person`;
  - a request that has the tab claim and no agent marker (a held tab);
  - a marked reader whose `identify_agent(...).id` is the Update's author.
- Every other reader gets the Update without the two keys, as on main.
  That includes another agent, an unnamed unmarked CLI, and a request with
  both a tab claim and a marker.
- The tab claim reuses #195's existing `X-Nebula-Tab` header (present and
  non-empty), so the tab sends nothing new over HTTP. The socket carries
  `?tab=1` (`withTabClaim`), because a browser can't set a socket's headers.
  The claim is not in `AGENT_MARKER_HEADERS`, and `is_person` and the gate
  are untouched. `canvas_open()`'s socket classification is unchanged.
- `agent_notes.for_reader` strips the keys from a note, a `notes` list, or a
  message's `note`. It is applied on:
  - the canvas and board list endpoints (MCP `list_notes` and `nebula notes`
    read these);
  - the socket's first sync;
  - `broadcast_raw` for `agentNotes` messages, per socket (each socket's
    view is set at connect).
- Residual risk, in the code comment and in MCP-SETUP: a local program that
  claims to be a tab sees the two counts. That's the same unsandboxed case
  `person_gate.py` describes, and it reaches nothing else.

### NITs

- MCP-SETUP's op wording now says a new ask posts a new Update (`added`,
  with the replaced one `removed`). A close or an undo reopen changes it in
  place (`changed`).
- `refresh_oldest` (the refresh retargeting the oldest open ask instead of
  the newest) is killed by a test that reopens the newer of two.
- The frontend `firstSince >= 0` bound has its own test.
- One equivalent survivor: `sharers_any_update` (dropping the
  `p.update == ref` filter in `_open_sharers`). Every open ask of one agent
  on one target now shares that agent's one live Update, and the reopen joins
  it. So "open, same agent, same target" already implies the same Update,
  and no reachable state tells the two apart. I kept the filter as a guard
  in case that invariant ever breaks.

### Round 4 verification

- On 24e7ebc7:
  - Backend: 8 of 12 new tests fail. The other 4 are guards: two catch
    mutants (`refresh_oldest`, `reopen_no_share`), one checks that the
    recount writes once, and one checks that the claim is not a marker.
  - Frontend (`presenceRound4`, with the base given `heldLock.ts`, since the
    test imports it): 10 of 14 fail. The other 4 are the post-promote
    companion, the helper's unit test, the "another reason stays" guard, and
    the `firstSince` bound (coverage of existing behaviour, as review 2
    asked).
  - The ratchet: 2 of 6 fail.
  - The new Krea `code` test and the roster `tabHeld` test fail too.
- Mutations:
  - backend: 18 of 19 caught; `sharers_any_update` is equivalent (above);
  - frontend: 25 of 25 caught, plus the Krea `code` mutant;
  - registration markers: 39 of 39 caught.
- Live on 8795/5795: 11 of 11.
  - In a held tab, the arrival card's Answer is locked. In the list, Review
    and Answer are locked, the header reads "2 · 2 unread", and GM's line
    shows.
  - On the promote: one retried read, "2 · all read" from the server, the
    line gone, and the buttons live in the same boxes.
  - The Krea row's line is gone after the promote.
  - Nothing reached 8000-8010 or 5173; nothing was accepted, rejected,
    answered or executed.
- Gates:
  - tsc and lint are clean.
  - vitest: 8,594 passed in 674 files.
  - build: 449,127 B raw (limit 512,000).
  - backend: 12,338 passed in a full isolated run.

## Round 5 (review 3 and its security review on 5916653e; GM `gm-pr204-r4`, `gm-pr204-r5`)

- **Header (GM r4).** "N · all unread" when every Update is unread, "N · M unread"
  when some are. Both numbers are the server's.
- **Create's two lines (review 3 MEDIUM-1).**
  - Generate's cluster FailureNotice now carries the refusal's code, and when the
    request was sent.
  - CreateView registers Save style (`create.style`) and Generate
    (`create.generate`).
  - The structural fix is `tests/personGatedCallers.ts`. It finds every backend
    route behind a gate form (directly, or through same-file helpers) and every
    frontend function that sends one. It traces by path literal and method, through
    lib/ helpers and their imports, to the first store action or component.
  - Each caller keeps its line with the mechanism (a marked call in its body, or a
    call to a same-file function that has one) or is declared in CALLERS: sites,
    NO_LINE, or KEEPS, each with a reason. Routes it can't find by path are in
    COMPOSED (agent notes' `base(surface)`) or NO_FRONTEND.
  - Heuristic limits: references are by name plus import; a call whose method it
    can't read counts as any method; "calls a keeper" doesn't know which branch.
- **Late refusal (review 3 LOW-1).**
  - apiFetch stamps an answer whose request went out before the latest promote
    (`personPromotions`, a WeakSet of responses). `requestError` and `readRefusal`
    carry the stamp as `sentBeforePromote`.
  - The mechanism runs the clear or retry for such a refusal on the next microtask.
  - Such an answer no longer re-holds the tab (`notePersonRequired`). This touches
    #200's demote path: only a refusal of a request sent under the current promote
    demotes.
  - The project, canvas-proposal and asset-proposal error wrappers now keep the
    stamp.
- **Reopen-join expiry (review 3 LOW-2).** `_schedule_asset_expiry` runs on both
  reopen branches.
- **NITs.**
  - A refused run puts each node back to how it was before the start queued it
    (`beforeQueued`), not `idle`. Before, the snapshot was taken after queueing, so
    it restored `queued`; the new test caught that. Only nodes still showing that
    line are restored.
  - Tests for the tab-claim edges, the board list, `for_reader` leaving its input
    unchanged, and keyFor.
- **Security review.**
  - Every Updates broadcast goes through the per-socket `for_reader`
    (`ConnectionManager._form`), including `others=` forms and `broadcast_others`.
  - MCP-SETUP and the main.py comment now say the claim needs no secret: a
    localhost page or a sandboxed agent with localhost access can send it, but an
    MCP/CLI-only agent can't.
  - "Your own" means by name for an unverified agent.
- **GM r5 item 1.** A project save refused as not connected is retried on the
  promote through `retryOnPromote` (the same mechanism mark-read uses).
  - During the retry the header shows its normal "Saving…".
  - A retry that fails keeps "Save failed · Retry" with the new reason.
  - The ratchet's RETRIES test allows exactly these two retries.
- **GM r5 item 2.** Held is a state: `personUnconfirmed = held || !answered`.
  - "Answered" turns true on the socket's first promote or refusal. In test mode it
    defaults to true.
  - Every lock reads it: Updates buttons, roster rows (all asks lock while
    unconfirmed; `heldLockFor` no longer looks at what the tab holds; the roster's
    `tabHeld` defaults to false), the arrival card, and ProposalBar and
    AssetProposalStrip Accept/Reject.
  - Before the first answer a lock keeps its own look for 150 ms
    (`data-held-pending`: aria-disabled, no grey, no reason, clicks do nothing).
    The grey comes after that. A refusal greys at once.
- **Server side of 2a: reported, not changed.** See the PR body.
- **Verification.**
  - On 5916653e, 17 of 29 frontend and 2 of 7 backend new tests fail. The tests
    that pass there cover existing behaviour, as the NITs asked.
  - Mutations: 17 of 17 frontend, 3 of 3 backend, and 4 of 4 for the ratchet.
  - Gates: tsc and lint clean; vitest 8,617 in 677 files; build 449,567 B raw;
    backend 12,345 passed.
  - Live on 8795/5795: 12 of 12.
  - The first live attempts failed for harness reasons: the backend and the browser
    timed out starting while the full pytest ran, the canvas once didn't open on the
    first try, and the prompt input selector was wrong. None of these was a product
    failure.

## Round 6 (review 4 on 6e130e26; GM `gm-pr204-r6`, `gm-pr204-r7`)

- **Save style (GM r6 1).** A Save style the gate refused as "not connected" is sent
  again on the promote, once, through `retryOnPromote` (`create.style-retry`), only
  while the project it was made in is still open.
  - Its line is the "because" form: "Nebula couldn’t save the style because this tab
    isn’t connected as you. Open the link Nebula printed when it started."
  - Every Save style line now shows in the app's notice region (graphStore `notify`,
    with the error, so it clears on the promote), not in Creator Studio's toolbar row.
    The toolbar's span and its CSS are gone; New draft and History don't move.
  - Flagged, not changed: Generate's run error still sits in the toolbar row
    (`create-view__run-error`). GM's rule ("a refusal sentence doesn't belong in a
    toolbar") reads as covering it too; that's GM's call.
- **The shared-line rule (GM r6 2).** A "not connected" refusal of anything that
  retries on the promote uses the because form (`notConnectedBecause`, errorCopy).
  `saysPersonRequired` recognises it.
  - Changed to the because form, because each retries on the promote:
    - mark-read (`markReadRefusedCopy`, already);
    - the project save ("save the project");
    - Save style ("save the style");
    - the first load ("load your work"), the update reload's recovered copy ("save your
      unsaved edits": GM said to fit the verb to the screen, and that screen saves the
      edits as a copy) and an agent's switch ("switch projects");
    - Settings' connected apps ("load the connected apps") and your agents ("load your
      agents").
  - Kept on the generic line ("… then try again" / "This change needs your OK"),
    because each is one-shot: the person presses it again, nothing retries. These are
    every other site in the ratchet's SITES table: Settings writes, pins, chat, canvas
    edits, proposals' Accept and Reject, question Send and Dismiss, project rename,
    cover, delete and trash, Commons, Krea, Moodboard and Cinema writes, run starts.
  - Ratchet (`presenceRound6.ratchet.test.ts`): every `retryOnPromote(` call's
    enclosing function words its line with `notConnectedBecause(` or
    `markReadRefusedCopy(`; a fixture mutant with the generic line fails it.
- **Check a (GM r6 3).** Both paths try mark-read: `openList` calls `markRead` whenever
  the list opens with unread Updates, held or not. Fresh held and demoted-after-reading
  were already the same in code; the new tests pin both (the line and one retry). The
  r5 live shot was taken before the refusal landed: its wait returned on the header
  text alone. The round 6 harness waits for the line.
- **Question form on demotion (GM r7 1).** The form stays open with its draft and caret,
  and typing stays live. Send and Dismiss lock in place (aria-disabled, focusable, "You
  can answer this when this tab is connected as you." as their tooltip, the 150 ms
  rule through `useTabHeld`/`useLockPending`) and unlock in place on the promote.
  `agentQuestionsStore` send and dismiss refuse while `personUnconfirmed()`.
- **Load screens (GM r7 2).** `showNotConnectedLoad` in the three catches
  (`initialize`, the params reload, `followProjectSwitch`): the because line, no Try
  again (`errorRetry: null`), and `retryOnPromote('project.load', …)` runs what Try
  again's 'load' does, only while that line is still the screen's. Any other failure
  keeps its own line and Try again. `recoverPendingWork` and `followProjectSwitch`
  left KEEPS (the kind is gone); the ratchet's KEEPS entries are replaced by
  `project.load-retry`.
- **The pin's Send note (GM r7 3).** PinComposer reads `useTabHeld` and
  `useLockPending` (PromptDialog's confirm takes the pending look and does nothing on a
  press). No component reads `personGateHeld` any more. Remaining readers, all store
  bookkeeping, not locks: `clearsOnPromote` (a refusal after the promote clears at once
  only if the tab isn't held again), `assetProposalsStore` (`awaitingSync` after a
  refusal), `canvasProposalsStore` (a release held while refused).
- **Review 4 gates-security.**
  - MEDIUM-1: the trace reads what the catch on each call does (`outcomeAt`): it
    registers ('keeps'), throws on ('passes': followed to the callers, a store action
    by property name through `getState().x()` and selectors `useStore((s) => s.x)`),
    or neither ('drops': must be declared). A Response-returning call reads the try's
    own `throw` of `!res.ok`, or else the function's handling. Keeper calls are matched
    as calls (`console.error` no longer counts as `error(`). Mutants: CreateView's
    `create.generate` removed, and a new component calling
    `getState().authorGenerationCluster()` with `failureMessage`, both fail. The new
    precision found `fencePaidUnknownRun` (declared) and moved the declarations onto
    the functions that keep: `cancelWithinTimeLimit` and `recoverPendingWork` throw on.
  - LOW-1: the frontend trace now finds `${BASE}/api/…`, a top-level const path,
    `'/api/' + 'x'`, a written `?query`, a renamed re-export, `export *`, a default
    export, an object-property helper (`styles.save()`) and a lib class method on an
    imported instance. It fails closed: a lib helper it reaches but can't follow (a
    class built with `new`) is returned as a caller, and /api/ text it can't place is
    listed and must be declared (UNTRACED: prefix lists and prose).
  - LOW-2: backend discovery is `tests/personGateRoutes.py` (Python ast, run from the
    test): multi-line decorators, either quote, `api_route`, helpers in services/ and
    other modules, aliases, a class's static method, PersonGateError and
    PERSON_REQUIRED written inline, `Depends(person_only)` in a parameter or a
    router's `dependencies=`. It finds the same 66 routes the line scan did; ten
    fixture probes pin the forms.
  - LOW-3: the seven server surfaces are named in the PR body. The server doesn't
    change: Justin decided reads stay as they are.
  - LOW-4: `cancelWithinTimeLimit`'s reason now names its two callers; the
    `followProjectSwitch` reason went with KEEPS.
  - NIT-1: the broadcast test has a distinct `others=` payload and a claimed socket
    with the person's view, which must get the others form.
  - NIT-2: one stamp and one check for every answer: apiFetch's discovery replay now
    goes through the same `answered()` (it skipped the person-gate check before), and
    the chat socket's person_required error is stamped with the promote count its
    message went out under (`personRefusalSentAt`). `presenceRound6.stamp.test.tsx` pins
    the chat case and LOW-2's `showNotice` case.
- **Review 4 held-state-ui.**
  - LOW-1: the stamp is the promote count at send (`noteSentUnder`, a
    WeakMap<Response, number>). Errors carry `sentAt`; `sentBeforePromote` is a getter
    read against the promotes so far, so a promote during parsing or before
    registration counts. `notePersonRequired` checks again after the body is read.
  - LOW-2: `notify` uses the error's own stamp when given; `showNotice` takes the error
    and its callers pass it. A line built from a refusal's words (`backendRejectionReason`,
    cinemaMotion's `refusalReason`) gets the latest person-gate refusal's stamp
    (`lastPersonRefusalSentAt`). That is the latest one read, not necessarily this
    line's; since the clear runs only when the tab isn't held, the worst case is a
    "not connected" line clearing while the tab is connected.
  - LOW-3: Settings' two reloads moved onto `retryOnPromote` (`settings.spend-load-retry`,
    `settings.agents-load-retry`, in RETRIES), with because lines. A ratchet fails any
    clear callback that makes a request (retry, save, send, dismiss, load, fetch,
    flush, refresh, hydrate, setAttempt…), inline or by name; a fixture with
    `setAttempt` in a clear (M18) fails it.
  - LOW-4: a refused run restores the state the node last settled in. A node queued
    again while queued or executing keeps the earlier settled snapshot, or goes back
    idle; a refusal takes its nodes' entries, and the map is capped at 500. Found while
    testing: the run, node and cluster paths call `resetExecution()` before they queue,
    which already turns queued and executing nodes idle, so on those paths a node never
    reads queued or executing when `queuedFrom` sees it; the two tests for it pass on
    6e130e26 for that reason. (Corrected in round 7, gates NIT-3: `executeClusterConcurrent`,
    Creator Studio's start, queues with no reset first, so that branch is live there.) The consume and the cap are new
    and are what the tests pin.
  - NIT-1: tests kill M2 (a press in the lock's first moment sends nothing), M9 (the
    save retry skips another open project), M16 (the discovery replay is stamped and
    checked) and M18.
  - NIT-2, not done: the header total stays the list's length. The server sends no
    total; adding one touches every agent-notes op the backend sends (about 20 return
    sites and the socket messages) and the store's handling of each. There is no cap in
    `list_canvas_agent_notes`, so the two agree today. Flagged for a decision.
  - NIT-3: the header count is a polite, atomic status; the promote changes it once.
- **MCP, CLI and docs.** No agent-visible behaviour changed: every change is in the
  tab (lines, retries, locks) or in tests. The server, MCP tools, the CLI and
  MCP-SETUP are unchanged, and MCP-SETUP's security wording is still accurate.
- **Round 6 gates.**
  - On 6e130e26 (round 6's test helpers copied in), 25 of the 69 new frontend tests fail;
    with round 5's trace, 52. 12 changed tests fail there too, because they expect the new
    lines. The 2 backend tests pass there: they strengthen a test, and the server is unchanged.
  - Mutants: 23 of 23 frontend and 1 of 1 backend caught. The cap mutant survived until the
    cap test was added.
  - tsc and lint are clean.
  - vitest: 8,686 passed in 686 files. The first full run, beside the backend suite, timed
    out in four heavy files; all four passed alone (212 of 212).
  - build: 450,270 B raw. Backend: 12,347 passed.
  - Live on 8795/5795: 27 of 27, with four distinct shots. The load screen shot is staged.
  - Seen live, not changed: in Creator Studio the header's left group narrowed by 41 px
    between entering and the demote, with the same text. New draft, History and Updates
    didn't move.


## Round 7 (review 5 on df92135b; GM r8, r9)

- **One notice, not two (GM r8 1).** The general "This tab isn’t connected as you…" notice
  steps out while any other line on the page says the same thing (a because line, a row's
  or a card's own line), and comes back when that line goes. One derived state drives it:
  `notConnectedLineShown` (lib/notConnectedLine.ts) walks the page's text with
  `saysPersonRequired`, skipping the notice itself and hidden parts; a tooltip (`title`)
  doesn't count. The banner reads it through `useSyncExternalStore` and a MutationObserver
  (once a frame), and leaves through its usual `useLeave`. Its line stays set, so what defers
  to it still does. Beside the locked question form, whose lock says it only in a tooltip,
  the notice stays.
- **Placement (GM r8 2).** Creator Studio's region was already anchored at the bottom over the
  composer (`--bottom-bar-clearance`). What landed on content was Styles: the picker sat at a
  fixed `bottom: 96px`, inside the region's band, so the because line under a refused Save
  covered its cards. Styles now stops above the reserved band like every floating panel
  (`floatingBottomLimit`, lib/presetLibraryPlacement.ts), follows the composer's height and
  a resize, and caps its height under the header's line. Measured live on Canvas, Creator
  Studio, Projects, Commons, Moodboard and Cinema (below).
- **Generate's run error (GM r8 3).** Its lines go through the notice region (`runLine`, graphStore
  `notify` with the error, so a refusal clears on the promote by its own stamp); the toolbar
  span, its state and `.create-view__run-error` are gone, and the `create.generate` site with
  them. A new Generate, a new draft or a reuse takes back the line it showed, only that
  line, as the span cleared then. Ratchet: `presenceRound7.toolbar.test.ts` fails a
  `role="alert"` or an error, refusal or failure expression inside a toolbar row
  (WorkspaceHeader, or a class naming a toolbar, topbar or header bar), skipping dialogs,
  menus and listboxes opened from it. The grep found no other refusal sentence in a toolbar
  row. Creator Studio's `styleNote` (a Style's applied/changed note) stays in the row: it is
  an info line, not a refusal or error.
- **The 41 px narrowing (GM r8 4).** A header mounted long after the save replayed "Saved"'s
  fold (`--settled`'s animation, 41 px of label) from the start. `settleDelay`
  (lib/saveSettle.ts) keeps when "Saved" settled across remounts and starts the animation
  that far in (a negative delay), so a header that comes back long after the save shows it
  folded. (Corrected in round 8, review 6 LOW-2: the cause written here first, "a demote and a
  promote remount the header", didn't hold; they re-render it in place. What mounts a new
  header is entering Creator Studio, which is where the narrowing was seen. The round 7 test
  pinned the delay string, not a width; round 8 says what it pins.)
- **GM r9 1, the permission card.** Allow once and Deny read the one held state and lock in
  place (aria-disabled, focusable, "You can answer this when this tab is connected as you.",
  the 150 ms rule); a press while held sends nothing, and the panel's handler refuses too.
  'sent' is set when the answer goes, and rolled back to waiting if the socket closed before
  it was written or if the gate refused it (the backend echoes the answer's `ref`, which names
  the request). The agent's own timeout keeps running; "Denied: no answer in time" stays if it
  runs out while held.
- **GM r9 2, the load verb.** The first load that is saving the recovered edits says "save your
  unsaved edits", as the update reload does; an agent's switch whose recovered copy is
  refused says it too. The load itself keeps "load your work", a switch "switch projects".
- **GM r9 3, old Accept and Reject.** A stored Update's `proposal.accept` / `proposal.reject` is
  read as one Review of that canvas proposal (lib/agentNotes `sanitizeActions`, `legacy: true`),
  greyed as Expired when the proposal isn't waiting; the corner no longer decides from a row.
  `docs/contracts/07-studios-and-resources.md` and `docs/moodboard-canvas-plan.md` say so;
  MCP-SETUP, SKILL.md and the tool docstrings already said Review.
- **Review 5 held-state-ui.**
  - MEDIUM-1: a refused connection (POST connect, DELETE edge), node add, undo and scene save carry
    the refusal into `notify` (or `clearsOnPromoteIf`) with its own stamp (`refusalError`).
    A scene save refused by the gate gets the because line and goes again on the promote,
    only while that entry is still refused for that reason (`cinema.scene-save-retry`). The
    trace requires a marker or a registering call in the `!res.ok` branch, and a keeper is a
    function that registers in its own body or always forwards to one (every function of
    that name, a statement of its own body). The reviewer's connection probe is a test.
  - MEDIUM-2: as GM r9 1 above.
  - LOW-1: the no-request-in-a-clear rule is inverted: a clear callback, and
    `clearSetterOnPromote`'s setter, may call only setters and pure reads (a setter that only
    bumps an effect, `setAttempt`, counts as a request). Same-file helpers are read in turn,
    and a function that hands its callback to a clear (graphStore's `clearsOnPromoteIf`) is a
    clear too. K1 (`markRead`), K2 (`runAll` through `clearsOnPromoteIf`) and K3 (the setter)
    each fail it as fixtures.
  - LOW-2: the because ratchet reads each `retryOnPromote` call site: in the block it runs in,
    every call that shows a line passes a because-form line (`notConnectedBecause(…)`,
    `markReadRefusedCopy()`, a const bound to one, or the refusal branch of an
    `isPersonRefusal` conditional), and there is at least one. A retry whose line another
    function words names it (`// because-line: sceneRefusal`), and that function must call
    `notConnectedBecause`. K4 fails it.
  - LOW-3: a refused shot goes back to the output it last settled with (`clearShotRefusal`).
  - LOW-4: each line carries its own refusal (`refusalError`); `lastPersonRefusal` is gone. A
    line that says the gate held with no error gets a bare code and waits for the next
    promote. The text path is tested; Inspector's upload passes `{ error }`.
  - LOW-5: `canvasProposalsStore` accept/reject and `assetProposalsStore` decide refuse while
    `personUnconfirmed()`: nothing is sent or marked. Tab-side only; agents are unaffected.
  - LOW-6 / gates LOW-2: `personGateRoutes.py` fails closed: a path it can't read, a route
    with no methods, an unknown router or owner and a deeper `Name.attr` chain are errors,
    and every module under backend/ is read. The 66 routes are pinned by count and by a list
    snapshot (`personGateRoutes.snapshot.json`) that must be updated on purpose.
  - LOW-7 / gates LOW-1: the trace fails closed in every unit, not only lib/: a store action
    destructured from `getState()`, `sendsTo`, and the `outcomeAt` keepsLine fallback. The
    reviewers' probes are tests (P1–P12, P1–P7). P6 documents a limit that stays: a catch that
    registers another line counts as keeping this one.
  - LOW-8: after Not now the header shows the server's count (the answer's `unread`); the
    optimistic set and the revert no longer recount.
  - NITs: a ref per chat message (the backend echoes it on person_required); the discovery
    replay takes its own promote count at send; the load retry reads the screen's state
    (`initialized`), not its line; a start's queued scope is recorded when it queues and used
    at the refusal, and a start Nebula took leaves no kept state (`startTaken`), the cluster
    path included.
- **Review 5 gates-security.** LOW-1 and LOW-2 above. LOW-3: the PR body's read-boundary item
  for the journal now says every proposal entry carries the agent's note: `proposal.created`,
  `accepted`, `reopened`, and the closed entries (`withdrawn`, `expired`, `rejected`,
  `invalidated`). NIT-1: close_session carries its own ref too, and the send-time stamp is
  pinned. NIT-2: the replay's check (`retryBaseUrl !== baseUrl`) and its own stamp are pinned.
  NIT-3: the round 6 note is corrected above, and the cluster path consumes its kept states.
  (Corrected in round 8, review 6 gates LOW-2: NIT-2 wasn't pinned by anything committed. The
  test that killed its mutant was in a file never added; round 8 commits it in
  `tests/lib/backend.round6.test.ts`.)
- **Found in this round.** The trace read a marker in a node's leading trivia, so a marker
  ending the line before a function or a branch counted for it. It now reads a node's own
  text and the comment ending its last line (`ownText`); probe P12 pins it.
- **MCP, CLI and docs.** One agent-visible change, on the tab-only chat socket: a
  `person_required` error echoes the frame's `ref` (a string of 1 to 64 characters; anything
  else is left out). Agents don't use `/ws/chat`; MCP-SETUP's person-only bullet says it. The
  proposal stores' refusal is tab-side only. No MCP tool, CLI command or server route
  changed.
- **Round 7 gates.**
  - On df92135b, with round 7's tests copied in, 85 of the 109 new frontend tests fail
    (77 fail, and the banner and header files can't load there: their helpers are new). The
    24 that pass pin what already held: a refusal for another reason keeps its line, the
    connected decision goes, a forwarder that always forwards keeps, and the like. With round
    7's trace and ratchets on df92135b's source, the ratchets fail on its dropped lines. Of the
    7 new backend tests, 2 fail there (the ref echo); the other 5 check what is left out.
  - Mutants: 50 of 51 frontend mutants are caught, and 3 of 3 backend ones. The one left is
    the chat panel's own unconfirmed check alone: the card's lock already stops every press,
    so it can't be reached; with both removed, the tests fail. (Corrected in round 8: the
    card's own guard alone survived too, review 6 M3; each of the pair covered the other.
    Round 8 renders the card alone and kills it.) The first pass left five
    alive (close_session's ref, a scene retry for another refusal, the switch verb, the
    cluster's kept states, and two trace forwarder rules); each now has a test that kills
    it. Writing the forwarder probe found the leading-trivia leak above.
  - tsc and lint are clean.
  - vitest: the full run had 8,796 tests in 699 files: 8,741 passed and 55 failed in 25
    files, with the backend suite, the mutants and other lanes beside it (load about 27).
    Four files were real: tests that still expected the old lines or lacked `notify` in a
    mock, and the new lib file missing from the ratchet's list. They are fixed. The 25 files
    rerun alone: 430 of 451 passed, the rest timeouts; those 18 files run one at a time: 335
    of 335 passed. (Corrected in round 8, review 6 gates LOW-3: CI on e8e64f8c then failed on
    one unhandled error, a store mock in `CreateView.reuse.test.tsx` without `notify`; this
    count didn't report unhandled errors. c8876ef9 fixed the mock and asserts the line, and CI
    is green on it. From round 8 on, vitest's Errors count is a gate and must be 0.)
  - build: 451,185 B raw, within budget. Backend: 12,354 passed in a full isolated run.
  - Live on 8795/5795: 21 of 21, 12 distinct shots (md5 checked). Staged, and flagged: the
    refusals of this tab's Save style and run starts are answered in the page with the gate's
    403. (Corrected in round 8, review 6 gates LOW-1: the backend here is configured as in real
    use, with the person token set. Save style, a cluster and a run start from a caller that
    isn't the person are refused only when they change who bills, carry a run approval or
    break a spending limit, or (a cluster) would change a run the person approved that hasn't
    started (409 `approved_run`) or leave the open project over its save limit (a
    `person_required` 403); otherwise they go through, as for any agent (round 9, review 7
    gates LOW-1). The because line
    shows only for a Style that changes who bills. The shots show those refusals, staged); the demotes and promotes in the
    person's tab are the frontend's own `reportPersonRequired`/`notePersonPromoted`; the
    permission ask is delivered on the tab's own chat socket (no ACP agent here), and the
    chat turn before it stays in the page. In an early harness run, before the run starts
    were staged, one Generate reached the isolated backend and stopped at its missing Gemini
    key (no keys there, nothing paid); a Style was saved to that scratch state once. Nothing
    was accepted, rejected, answered or dismissed.
  - Placement, measured: Styles ends at y 648 and the notice band starts at 656 in Creator
    Studio (composer top 711); notices sit 774-820 on Canvas and "Commons" (bar clearance 72;
    corrected in round 8: that shot showed the canvas, since the Commons was off in that
    backend; round 8 turns it on and shoots it open),
    656-702 in Creator Studio (190), and 830-876 on Moodboard, Cinema and Projects (no bar).
  - The header's left group stayed 180 px through the demote and the promote.

## Round 8 (review 6 on e8e64f8c; GM r10, r11; base c8876ef9)

- **CI on round 7.** e8e64f8c failed CI on one unhandled error: `CreateView.reuse.test.tsx`
  mocked the graph store without `notify`. c8876ef9 forwards it and asserts the line, and CI
  is green there. vitest's Errors count is a gate from this round on.
- **GM r11, the rule for the one notice, in the code (lib/notConnectedLine).** The general notice
  steps out only beside a line that carries the fix itself. A line on the page is one of three
  kinds: `fix` (a "because" line, or the general words "…Open the link Nebula printed when it
  started…"), `defers` (the desktop app's dev setups, ending "The notice below says why."), or
  `lock` ("You can … when this tab is connected as you."). Only `fix` takes the notice's place.
  This settles review 6 MEDIUM-2 (the dev setups keep the notice) and LOW-3 (the held proposal
  card's line is a lock line, so both show). `DEFERS_TO_NOTICE` names the dev ending once in
  errorCopy.
- **Review 6 MEDIUM-1: only a rendered line counts.** The derived state still reads the page's
  text, kept rather than registration on purpose: about fifty files render these lines, and a
  site that forgot to register would leave the notice out, while one that forgot to unregister
  would hide it everywhere. A line counts only while it's rendered: not under `hidden`,
  `aria-hidden` or `inert`, and `checkVisibility` (CSS display, visibility and opacity) in the
  browser, computed styles in jsdom. The observer now watches `class`, `style` and `inert`, and
  an animation's or transition's end (a line that fades in starts at opacity 0). On the
  Commons, Settings and Chat stay mounted in a `display: none`, inert group; their lines no
  longer count, so the notice shows there. Tested with the app's own group, and checked live.
- **Review 6 NIT-2.** No walk of every text node per style change: while subscribed, a text
  change finds the lines again (after a quick check that the page says "connected as you" at
  all), and an attribute change only re-checks the lines already found. The answer is cached.
- **Review 6 NIT-3.** The banner keeps one polite live region mounted, empty until there is
  something to say. It says the notice's words when the notice comes, the line that took its
  place when that line isn't a live region itself, and the words again when the notice comes
  back: one change per swap, with no empty step between. The visible notice is no longer a
  second live region.
- **GM r10 1, the held cards.** The permission card shows "You can answer this when this tab is
  connected as you." on its own row under Allow once and Deny; the buttons have no tooltip and
  point at the line (`aria-describedby`); the countdown stays. The question form does the same
  under Dismiss and Send. The general notice stays beside both (lock lines, GM r11).
- **GM r10 5, Dismiss.** Both buttons are locked on a held tab and both take the app's shared
  locked look (`agent-notes-btn--held`, in disabled-buttons.css's ghost list; Send also in the
  filled list). A test pins both. Measured live: Dismiss's label goes from white at 0.92 to
  0.55 and its edge from 0.12 to 0.06; Send's fill goes from 0.92 to 0.42 and its label to
  near-black at 0.62. Dismiss takes the app's ghost-disabled look, the one every ghost button
  uses; if GM finds it still reads live, that is a question about the shared look, not this
  form, so it isn't changed here.
- **GM r10 2, the tool kind.** One table (lib/acpToolKind) maps every ACP ToolKind
  (agentclientprotocol.com, "Tool calls") to the card's tag: read → read, edit → edit, delete →
  delete, move → move, search → search, execute → run, think → think, fetch → fetch,
  switch_mode → switch mode, other → no tag. A kind ACP adds later gets no tag, never a raw
  protocol word. Person-side only: agents send ACP's kinds and never see the tag.
- **GM r10 3, Generate's line.** Generate is one-shot (review 6 confirmed: no retryOnPromote), so
  refused only for this tab it says GM's line: "Nebula couldn’t start the generation. Its nodes
  weren’t added to the canvas. This change needs your OK, and this tab isn’t connected as you.
  Open the link Nebula printed when it started, then try again." (`generateRefusedCopy`; the
  desktop app's forms follow personRequiredCopy). When the cluster was added and the start was
  refused, the nodes are on the canvas, so that sentence is left out. Generate's other lines
  keep the round 3f heading ("Couldn't start the generation."), straight apostrophes
  included: GM's change named the refusal; flagged for GM if it was meant for every line.
- **GM r10 4.** Round 7's 06-placement-commons showed the canvas: the Commons was off in that
  backend. This round turns it on (in scratch, `NEBULA_COMMONS_CALL_BUDGET=0`, no keys) and
  shoots it open.
- **Review 6 MEDIUM-3: the model picker.** A centred modal, it stopped over the notice band.
  `useNoticeClearance` gives a modal's overlay `--notice-clearance`, the line Styles and every
  floating panel stop at (floatingBottomLimit: above the bar and the band, shown or not), and
  the picker centres above it with its height capped to fit. The Lightbox (its media and the
  counter) and the comparison do the same. Measured live for the picker; the Lightbox and the
  comparison are covered by tests (no results exist in a keyless live state).
- **Review 6 LOW-1.** "Saved"'s delay is taken once per settle (`useSettleDelay`, memoised on
  `settled`), not on every render, so a re-render during the 2.6 s fold leaves it running.
- **Review 6 LOW-2.** The cause in the round 7 notes is corrected above. The header test now
  says it pins the fold resuming on a remount (a screen change), and a new test pins that a
  demote and a promote leave the group's elements and markup unchanged. Measured live: the left group stays at
  180 px entering Creator Studio long after the save, on a second entry, and through a demote
  and a promote. In one earlier harness run the person's tab saved the project as it entered
  Creator Studio, and the group went 282, 234, 221, then 180 px: a fresh save's own "Saved"
  and fold, not a replay (that run didn't log the labels, so this is read from the save
  request and the widths).
- **Review 6 LOW-4: the toolbar ratchet.** It reads a component rendered in a row as the row
  (found by name in the app, through `memo` aliases), and fails closed on one it can't find
  (a package's component is fine: it renders only what the row passes it, which is read). It
  reads JSX passed as an attribute and a self-closing row's attributes; treats
  `notConnectedBecause`, `personRequiredCopy`, `markReadRefusedCopy`, `failureMessage`,
  `failureCopy`, `failureUnder` and `generateRefusedCopy` calls as sentences; follows a neutral
  name to its value (a local, a state's setter calls, the prop every use of its component
  passes; a prop with no use fails closed), reading only the value's path, not a condition or
  a key; and reads `aria-live="assertive"` and a role from an expression. The reviewer's six
  forms are tests. The app's rows pass. Its timeout is 120 s (NIT-1).
- **Review 6 held LOW-5 and gates LOW-4: markers.** The trace reads markers only from `//`
  comments the scanner reports (leading and trailing comment ranges of the node's tokens),
  never the node's text: a marker's words in a string, a template, a block comment, a JSX
  comment or JSX text aren't one. A path made by a helper call (`apiFetch(presetsPath(), …)`)
  is the transport's call, so its `!res.ok` branch is what's read. The reviewers' probes are
  tests (Q1-Q15, R1-R12, and J1 for JSX text).
- **Review 6 gates NIT-1: specific probes.** Every probe is pinned to its exact outcome (which
  function the line drops at, how many paths are untraced), in presenceRound8.trace. Pinning
  them showed two round 7 fixes had never run: a store action destructured from `getState()`
  wasn't followed (the store's file was only reached through a property), and a store alias
  two hops away wasn't either; both were passing by the fail-closed rule. Both are fixed. The
  probe worlds are shared in tests/traceProbes.ts.
- **Review 6 gates LOW-5: `/ws/chat` in the gated list.** Route discovery counts a literal
  `"person_required"` refusal code (outside person_gate.py), so `WS /ws/chat` is in the snapshot
  (67 routes). The trace's ratchet lists it as a socket: its refusals come back as frames, not
  answers to a request, so the check is that ChatPanel opens it, reads the code, and that
  presenceRound7.chat pins what it does. A gate read by subscript is listed as unreadable.
- **Review 6 gates NIT-2.** `except PersonGateError` and `isinstance` aren't gates; only building
  or raising one is. A mounted sub-app's routes are listed as unreadable, with probes.
- **Review 6 gates NIT-4.** CI's frontend job sets up Python 3.12 (the backend job's pinned
  action) before the tests that run the scanner.
- **Review 6 gates LOW-2.** Review 5 NIT-2 is pinned in a committed test now
  (`tests/lib/backend.round6.test.ts`): a promote between the lost first try and the replay
  leaves the replay's refusal stamped after it, so it holds; and discovery that finds the same
  backend sends nothing again, in the catch path and the proxy-503 path. The round 7 note is
  corrected above.
- **Review 6 LOW-6.** M3 (the card's own guard) is killed by rendering the card alone. M18
  (Generate's line without its error) is killed by a refusal sent before the promote and
  answered after it: the line goes at once. M20 (a legacy Review never Expired) is killed by
  both states of the proposal. M9 is caught (the reviewer's rerun, M9b, and this round's run).
- **Review 6 gates LOW-1, NIT-3.** The round 7 notes and the PR body now say what the backend
  does in real use (above). The PR body's read-boundary item: a Commons asset proposal's
  journal entries leave the note out, and `proposalClosed` is a `/ws` message every listener
  gets, not a journal entry.
- **MCP, CLI and docs.** No agent-visible behaviour changed this round: the tool-kind tag is the
  tab's, the notice rule and the placement are the tab's, and `/ws/chat` joins the gated list
  of the tests, not the server. MCP-SETUP already says Save style, cluster and run starts are
  refused for a caller that isn't the person only for a billing change, a run approval, a
  spending limit or (its coded refusals, :2728-2731) an edit that would leave the open project
  over the save limit ("Who bills is the person's call", the billing-change list, and
  "Everything else, including running nodes, is open to agents and held to the spending
  limits"); it is unchanged. (Round 9, review 7 gates LOW-1: this paraphrase first left the
  save limit and the approved-run check out.) The proposal reads: Justin decided: reads stay as they are. A default daily dollar total for runs not started by the person isn't part of this PR.
- **Live on 8795/5795** (isolated backend, every root in scratch, no keys, the Commons on with a
  call budget of 0; 8000-8010 and 5173 blocked, canary refused): 26 of 27 in the full run, and
  the one miss was the harness cutting the notice's text at 140 characters; Generate's section
  run again with the whole text: 7 of 7, GM's line exactly. 7 shots, no two alike.
  - Settings on a tab that isn't connected: two because lines ("load the connected apps", "load
    your agents") show, the general notice steps out, and since both lines are alerts, the
    notice's live region says nothing for them. On the Commons with Settings left open, the
    group is `workspace-overlays--hidden` and inert, both lines are mounted and not on screen,
    and the notice shows and is announced. The Commons screen with Settings left open and with
    it closed is the same picture, pixel for pixel, so only the closed one is kept.
  - 06-placement-commons is the Commons itself; the notice and a second toast sit at the
    bottom. (The Commons' own "session expired" line shows: no Commons link in a scratch run.)
  - The model picker ends at y 592 (CSS px, 1440x900) and the band starts at 648; the refused
    Save's because line sits at 654-702, under it.
  - The permission card's line sits at 445, under the buttons' row (439); the tag reads "run";
    the countdown runs. The question form's line sits under Dismiss and Send; both locked.
  - Staged, not real: the Generate refusal (the page answered the cluster POST with the gate's
    403; its preflight went to the isolated backend), the demotes and promotes (the frontend's
    own calls), the permission ask (over the tab's chat socket, no ACP agent), and the dev
    setup's line (put on the page as Settings shows one). Nothing reached 8000-8010 or 5173
    besides the canary; nothing was accepted, rejected, answered, dismissed, executed or run.
  - Harness notes: the first runs failed to load (a cloned `node_modules` held a second copy
    of itself, so the page had two Reacts); the copy was removed and the worktree's
    `node_modules` is the shared link again.
- **Tests on c8876ef9, with round 8's tests copied in.** The notice file fails 13 of 15 (the two
  that pass pin what round 7 already did); the cards and placement files can't load (their
  modules are new); the trace's exact outcomes fail 11 of 40; round 7's toolbar ratchet
  misses the reviewer's six forms (7 probe tests fail); the routes: 14 of the new tests and
  the snapshot; one each in the header (the structural test), the chat test, the socket ratchet,
  two in the round 6 look test, two in CreateView.lifecycle, two in the banner test. The
  Generate stamp test (M18), the legacy Review test (M20) and the three replay tests pass on
  c8876ef9: they pin behaviour that existed and kill a mutant each.
- **Mutations.** 60 frontend mutants (the notice rule and its visibility checks, the banner's
  region, the cards, the tool kinds, Generate's line, the clearance, the save delay, every
  toolbar and trace change, the replay, the socket entry) and 20 scanner mutants. The first
  pass left four: the region's own copy counting as a line (a sequence test kills it now);
  class and style not watched, and an attribute change not re-checking (the class/style test
  toggled before the last swap's scan had run, so that scan did the work; it now waits for
  the page to settle before each change); and `a && b` read as nothing in the toolbar ratchet
  (a probe now). All 80 are caught.
- **Gates.** tsc and lint are clean. vitest's full run had 8,913 tests in 705 files, beside
  the backend suite and other lanes (load average 41 to 52): 8,657 passed, 256 failed in 87
  files, 200 of them timeouts, and Errors 0. Three were real: the banner test still read the
  notice as the live region (two tests), and the named-line ratchet didn't list
  `generateRefusedCopy`; all three are fixed. Rerun on their own, the 87 files ran 1,425
  tests: 1,240 passed and 185 failed, 127 of them timeouts; Errors 0. The 59 files with a
  failure then ran one at a time on one worker: 56 passed in full, and 3 had one failure each
  (two timeouts and a CommonsDetail wait), which passed when run again. Build: 453,007 B raw
  (139,459 gzip), within budget. Backend: the first full isolated run hit its 100-minute
  limit at about 80%; the second ran to the end, 12,352 passed and 2 failed, both event-loop
  timing tests (an ACP open and an autosave), which passed on their own. No backend code
  changed this round.

## Round 9 (review 7 on 0a29f1d0; GM r12, r13)

### The one notice reads registrations (review 7 MEDIUM-1, NIT-2, NIT-3)
- `lib/notConnectedLine.ts` no longer reads the page's text. A line registers its element and
  the kind its words give (fix, defers, lock; GM r11) through `components/LineText.tsx`, and
  unregisters when it unmounts (StrictMode's double mount leaves one; the same element
  re-registering replaces its entry). `FailureLines` and the new `commons/CommonsErrorLine`
  render through it.
- `LineText` with no class renders the words as bare text in the surface's own element, plus
  an empty anchor (`display: none` inline, so no stylesheet can show it or make it a flex item)
  whose parent is what registers. So every surface keeps its role, class and test selectors
  (`getByText` still finds the surface's element). With a class it renders its own span.
- A registered line counts only while one IntersectionObserver (root: the window, thresholds
  0 and 0.01, any part in view) says it intersects, and nothing IO can't see hides it
  (`hidden`, `aria-hidden`, `inert`, visibility, opacity: `checkVisibility`, or computed
  styles in jsdom). A change of those attributes, class or style anywhere, or an animation's or
  transition's end, re-checks. A line scrolled out of Settings' scroll box doesn't count, and
  scrolling re-checks (IO fires). Without IO (jsdom) a line counts as in view.
- An agent's note or chat text quoting the words never counts: it doesn't register. A line is
  found however it is split, since it registers by its words, not its text nodes.
- **The ratchet** (`tests/lineRegistration.ratchet.test.ts`) replaces the scan's "every surface
  counts". (1) From the trace: every `// clears-on-promote:` site is in HOLDERS with where its
  line shows and the expression it hands a registering component there; the Commons surfaces
  too. A new site fails until it says where its line shows. (2) Structurally: no JSX text
  child anywhere reads a value named for an error, refusal, failure, notice or problem, or calls
  a sentence helper, without a registering component; `dangerouslySetInnerHTML` fails too. One
  exemption (Moodboard's `notices`, a block of FailureLines). 47 component files moved to
  `LineText` (most by a codemod over the ratchet's own findings), including lines that can't be
  not-connected today: cheaper than a reviewed exemption each, and a later gate covers them.
- Out of scope but done with it: three-dot strings in those files' visible text became "…"
  (Rendering, Loading Moodboard, Loading, Enter text, Opening ChatGPT, Loading models, Search
  models, Extracting, Fetching, the connection search placeholder).

### GM r12
- (1) Every Generate line opens "Nebula couldn’t start the generation." (`GENERATE_HEADING`,
  now in `lib/errorCopy` with `CLUSTER_NOT_ADDED`; graphStore re-exports them, so the
  CreateView tests' graphStore mocks don't need them).
- (2) The Commons. Traced: the person session is one per launch and never expires on its own
  (`services/person_session.py`; `commons/actors.py` checks the Bearer against it). "Your
  session expired" was shown when this tab had no person token, or a 401 after the backend
  restarted with a new one: both mean the tab isn't connected as the person. So it is the
  because form, under the call's own heading (`commonsNotConnectedCopy`: "Couldn’t load the
  references." gives "Nebula couldn’t load the references because this tab isn’t connected as
  you. Open the link Nebula printed when it started."), the desktop window's forms as
  `notConnectedBecause`. No session line to propose to GM. No "backend terminal". It is a
  person refusal (`person_required`, stamped with the promotes so far: `commonsNotConnected`).
  `CommonsErrorLine` draws a not-connected line neutral (`commons-notice`, a status) and any
  other failure red (an alert). The Commons screens have no Try again button, and the line
  carries no "try again". Every Commons "Couldn't" became "Couldn’t" (commonsApi's 42
  headings, the screens, the leave popover's save line).
  - A Commons line clears on the promote, and the Commons loads again: see "The Commons on the
    promote" below.
- (3) "Connecting…" was already U+2026 in source (CommonsView's StatusLine). Checked live:
  see below.
- (4) The desktop dev notice. `personRequiredMessage` gives the dev text for 'debug-port' and
  'dev-renderer' whenever the shell's answer set the reason: round 8's shot 07 was staged in a
  browser with only the line forced to desktop, so the notice was the tab's. Pinned in
  `presenceRound9.desktop.test.tsx` with the shell's own `decidePersonToken` and
  `registerPersonTokenHandler` (desktop/person-token.mjs) answering the bridge. An unstaged
  packaged shot isn't possible inside this round's rules: `npm run package -- --validation`
  rebuilds the renderer with `npm run build:desktop` when sources changed (they did), and a
  vite build is off-limits on this Mac. So the shot is the real app in the browser with the
  bridge answering as the shell does for a debug-port launch, named "-component".

### GM r13
- (1) Generate after its nodes were added: GM's line exactly. The desktop forms follow
  `notConnectedBecause` (the dev setups defer to the notice; the packaged app: "Quit Nebula and
  open it again, then run them from the canvas.", confirmed by GM r14 (2)). Where it shows:
  live, a start refusal never reached CreateView, because `executeClusterConcurrent` catches
  it and marks the nodes errored. So the store now marks a Generate cluster's nodes with this
  line when the start is a person refusal (`markNodesErrored(..., ownLine)`, no "details"
  toggle under it), and the result cards show it; CreateView's notice path stays for a start
  that throws. Neither takes an action, and nothing retries Generate on the promote (the
  RETRIES list has only Style's); a test promotes after the refusal and sees no second cluster
  or start.
- (2) The band. `--notice-tallest-h` (three lines) sets the band's height. `lib/noticeWaiting`
  counts the open capped popovers (`useCappedPopover`): every modal that reads the clearance
  (the hook holds it), Styles, the context menu, the connection menu and the provider menu.
  While one is open, NoticeRegion marks every slot item but the newest (by the order its slot
  gained the element) `data-notice-waiting`, drawn as nothing; it comes back when the newest
  goes or the popover closes. Timed notices hold their timers while waiting (`useNoticeHold`
  takes the slot; the four toasts read `useSlotWaiting`), and start a full hold when shown, so
  none is lost. The proposal bar is an item like any other.
  - The Inspector popover and the size panel stop at the band too but are docked panels a person
    keeps open, so they don't hold the band to one notice (listed with why in
    `presenceRound9.band.test.tsx`). GM r14 (1) confirmed: not popovers, the rule doesn't apply.

### Review 7, the rest
- notice-rule-ui LOW-3: the toolbar ratchet is structural now: no line component (LineText,
  FailureLines, CommonsErrorLine) in a row at all, no literal sentence, no
  `dangerouslySetInnerHTML`, no alert role through a spread, a local helper read through its
  returns, and a row class read from a constant, a helper's literals and a template. The
  reviewer's T7, T10, T13-T15, T17 and T18 each have a probe.
- LOW-4 (N7): an `inert`-only toggle test; the `inert` mutant fails it.
- gates-trace LOW-1, NIT-3: docs (the "only when" list now names the cluster's approved-run and
  save-limit refusals; closed entries also drop a Commons proposal's reason). LOW-2, LOW-3,
  NIT-1, NIT-2: the trace lane (below).
- **MCP and docs.** Agent-visible: nothing. The Commons refusal's code and status are what
  the API already answered; only the tab's words changed. MCP-SETUP unchanged.

### The trace lane (gates-trace LOW-2, LOW-3, NIT-1, NIT-2)
- LOW-2: the caller trace follows a helper call. It climbs through templates, `await`, `as`,
  `satisfies`, `!` and `<T>x`, and through any call that isn't a transport (`String`,
  `backendUrl`, `joinBackendPath`, ...) until it reaches one; a lib helper returning
  `apiFetch(String(...))` hands its Response to its caller. Fail closed: a wrapped path, or a
  path helper's call, held somewhere the trace can't read (a local through `as`, a template or
  `await`, `let x; x = ...`, an array) is listed as untraced and its caller drops. The real
  app's untraced list is unchanged.
- LOW-3: the new probes are `ROUND9_PROBES` in `traceProbes.ts`, each outcome pinned in
  `presenceRound9.trace.test.ts`. O4 is the keeper whose marker sits on its own line in the
  catch.
- NIT-1: route discovery (`personGateRoutes.py`) counts `"person_required"` anywhere outside a
  comparison or docstring (a constant, an f-string, a `+`), follows an error's subclasses, and
  lists a gate read out of a container (looped, `.get`, handed on, built inline) as unreadable.
  The real backend's output is byte-identical: 67 routes, none unreadable. 21 forms are pinned
  in `presenceRound9.routes.test.ts`, with negative controls.
- NIT-2: the socket check is structural (`socketRefusalGaps`): a `new WebSocket` on the path,
  that socket's message handler, a branch on `code === PERSON_REQUIRED_CODE`, and a marked
  registration inside the branch. `clearsOnPromote.ratchet`'s SOCKETS uses it.
- Left as is: a bare literal path in a local (`const u = '/api/x'; apiFetch(u)`) still lets the
  catch decide, as before; failing it closed would add entries to the untraced list
  `presenceRound6.ratchet` pins. `PATH_WRAPPERS` is a named list. The path may sit in any
  transport argument (errs towards drops).

### Round 9 verification
- **A rule broken, by accident.** One gate run meant for the focused files ran the whole frontend
  suite on this Mac: zsh doesn't split an unquoted `$CH`, so the file list came out empty and
  vitest ran everything (714 files, 9,034 of 9,035 passed; the one failure was the round 6
  retry-wording ratchet, fixed below). Later runs pass an explicit array.
- Gates after the Commons promote and GM r14: `tsc` (app and node configs, `--noEmit`, no shared
  build info) and lint clean; the touched area again (14 files, 141 of 141, Errors 0). npm and npx
  ran with the update notifier off from the coordinator's rule on.
- Gates (no full suites on this Mac this round; CI runs them): `tsc -b` and lint clean. The
  focused vitest set (31 files: every new and changed test file plus the trace, route and socket
  ratchets): 439 of 440, Errors 0; the one failure was the ratchet's "round 5" test timing out
  at 30 s under load about 19, and it passed alone (9 of 9). Earlier this round the related set
  (254 files) ran 3,067 passed, its 5 failures fixed or timeouts that passed alone.
- New tests on 0a29f1d0 fail: the round 9 notice, band, desktop and ratchet files, the GM r13
  store and CreateView tests, and the copy pins; the trace lane's 48 of 72 (the 24 that pass
  pin behaviour that already existed, to kill mutants).
- Mutants: 34 of 34 frontend mutants killed (the 34th: the hook's refused line not in the because
  form, killed by `presenceRound6.ratchet`; the hook's mutants were run again on its final form).
  The 13 added with the Commons promote and GM r14:
  the Commons marker, its retry, a screen bypassing the hook, the poll registering each time, the
  refusal stamped at failure, LineText marking nothing, a token left out of the sheet, a literal
  warning colour back on a line rule, CommonsErrorLine's per-screen neutral class, Connect not
  locked, Connect submitting while held, "tab" in the app, the debug notice's old lead. The
  first 20 (registration and IO, `inert` observed and hiding,
  the anchor's parent, a holder rendered bare, a site dropped from the ratchet, newest-only,
  the held timers, a popover not holding, the band's height, the Commons line's colour and
  registration, the Generate line's words, the card line for Generate's start only, the card
  keeping the run-start line, `ownLine`, and two toolbar-ratchet mutants). The trace lane's:
  N1-N17, S_a-S_h and the scanner's N1-N14 killed, the reviewer's T4, T5, T10, T16 killed;
  the scanner's N15 survives (dropping the `ctx` Load restriction; errs safe).
- Live on 8795/5795 (isolated HOME, settings, state and outputs; 8000-8010 and 5173 blocked,
  the canary to 8001 refused, nothing reached them; keys unset; nothing accepted, rejected,
  answered, executed or run against a provider). All pass across three runs:
  - Settings: scrolled out, the notice shows; scrolled in, it steps out; back, it returns.
  - Commons: the because line, neutral, a status; the notice steps out; "Connecting…" is one
    U+2026 and not cut off.
  - Generate: the curly heading on the refused cluster; nodes added and start refused, the cards
    say GM r13's line exactly, the nodes are on the canvas (0 to 2), no button on the line or
    cards, and the general notice steps out.
  - An agent's note quoting the general words leaves the notice showing.
  - Band at 1280×800 and 1440×900: with the model picker open only the newest notice shows,
    below the picker; a three-line notice (64 px) fits the band (74 px); closing the picker
    shows all, none lost.
  - Desktop (component): the debug-port line and the dev notice.
  - GM r14 and the Commons promote (two more runs): Connect from a caller that isn't the person
    answers 403 `person_required` and makes no token; Settings' two because lines are the light
    ink (`rgba(255, 255, 255, 0.55)`), marked, while a settings error line for another reason
    stays `rgb(255, 90, 31)`; Connect is aria-disabled, not disabled, no title, with GM's line,
    and a click sends nothing; a held page's Commons shows the because line and no references,
    then the person link opened in that tab (`#view=commons&nebula-person=…`) promotes it: the
    line goes, the reference loads, the status reads "Stopped · 1 queued" and the link leaves the
    address bar; desktop (component): the reworded notice, Connect's line says "window". One
    reference was added to the scratch library with the person token (no keys, call budget 0).
  - Settings 01 and 02 were taken again after the colour change.
- Shots in the session scratchpad's `agent-presence/fu3i/` (16, no duplicate md5s, each opened):
  12 is Settings with the neutral because lines and Connect locked, 13 the Commons after the
  promote, 10 the reworded debug notice.

### The Commons on the promote (round 9, after GM r12 (2))
- Every Commons screen's failure line goes through `components/commons/useCommonsLine`: the
  view (its loads and its actions), a reference's detail, the settings, blind labeling (its load,
  its scan, its label writes, each reference's image), agent review (its load and refresh, its
  proposals, its accepts, each reference's image), closing a review, and a tile's media. A line
  refused only because this tab isn't connected as the person registers with
  `lib/clearsOnPromote` (one marker, `commons.line`) and clears on the promote; a load also runs
  again then (`commons.reload-retry`, one retry per screen and load: the view runs the
  collections, the status and the search again), so the references load and the status line
  reads as it normally does. An action isn't done again. Any other line stays.
- The hook words a refusal for this tab itself, in the because form under the request's own
  words (`notConnectedBecause`, the same words lib/commonsApi's refusal carries), so
  `presenceRound6.ratchet`'s rule (what retries on the promote says why in the because form) reads
  it at the retry; a label write's own line (`saveFailure`) goes through `keep`, without a retry.
- The status poll (every 5 s) and the review's refresh keep failing while the tab waits; a line
  already waiting isn't registered again (a set per screen), so nothing piles up.
- `lib/commonsApi` stamps the refusal with the promotes counted when the call started, not when it
  failed: a call sent before the promote and refused after it (a 401 for the forgotten token,
  refused again on its resend) is the old state's answer, so its line clears and its load runs
  at once (`clearsOnPromote`'s existing "sent before this promote" path).
- Ratchets: both markers are in `clearsOnPromote.ratchet` (SITES, OTHER_SITES, RETRIES) and
  `commons.line` in `lineRegistration.ratchet` (HOLDERS: the Commons places, now with the
  labeling image and the media). `presenceRound9.commons.test.tsx` fails a Commons screen that
  sets a failure line itself (a line setter handed anything but a literal, `failureMessage`
  anywhere but a scan outcome that carries its `cause`, a line put in another state object).
- Tests: a held page (no token) and a normal page (a 401: the backend forgot the token) each show
  the because line, then on the promote the line goes, the reference tile loads and the status
  isn't "Connecting…"; a line for another reason stays; the poll keeps three registrations
  (collections, status, search) over 16 s; the send-time stamp.

### GM r14
- (1) The docked panels stay exempt from newest-only. No change.
- (2) The packaged-app Generate card line was already GM's exact words ("…because this window
  isn’t connected as you. Quit Nebula and open it again, then run them from the canvas.").
- (3) The debug-port notice is "A debugging port is open, so Settings, proposals and chats are
  off." (`personSession.personRequiredMessage`). Pinned in `presenceRound9.desktop`,
  `personRequiredLines` and `lib/backend.test`. Checked every place it shows: the notice only;
  no backend, desktop shell, MCP or docs copy says it (only old dated notes quote the old words).
  Not agent-visible.
- (4) Because lines are neutral on every surface, through one shared style. `LineText` marks the
  element a because line registers on (`data-line-because`; "own" on a span of its own), and
  `styles/becauseLine.css` (imported by `LineText`) turns every warning token inside it into the
  neutral ink (`--sr-ink-light`), edge and surface. A surface keeps its own error rule; its
  token resolves neutral there. Surfaces whose warning was a literal colour now read it through
  `var(--line-warning, <the same literal>)` (and `-soft`, `-edge`), unset anywhere else, so their
  look is unchanged for other failures. `CommonsErrorLine` no longer picks a neutral class; every
  Commons line has the error class and takes the shared style. `becauseLine.ratchet.test.tsx`:
  the mark (and only for because lines, and gone when the words change), the sheet ships with
  `LineText` and covers every warning token the app defines (four button-only and five node-card
  layout tokens listed with why), nothing else styles the mark, and every CSS rule for an element
  a line renders in (found from the JSX) colours it only through covered tokens or neutral values
  (a warning-hued literal, an uncovered warning token, or a warning literal as another token's
  fallback fails). Its first run found 17 rules (Settings' was a token; the literal ones are in
  batch-node, canvasProposals, character-studio, moodboard-studio, nodes, panels,
  personal-agents and slava-restraint), all now through the hook.
- (5) GM's question. Connect does not work from a tab that isn't connected as the person: the
  route (`POST /api/agent/spend/apps`, `create_agent_app`) calls `require_person`, and live the
  server answers a caller with no person token 403 `person_required` and makes nothing. So
  Connect (and "Create token", the same button when no client setup is available) locks in place
  like the held cards' buttons (aria-disabled, focusable, the first-moment rule), with "You can
  connect an agent when this tab is connected as you." on its own row under the controls
  ("window" in the app, `connectAgentLockCopy`), no tooltip, and unlocks on the promote. The
  gate is unchanged. Revoke, a limit and a colour change hit the same gate; refused, they show the
  refusal's line, which clears on the promote (`settings.apps`). They aren't locked (not asked).
- Not built: GM's batch item (the save-board heading's missing "Nebula"), left for the wording
  batch.

## Round 10 (review 8 on 343abb99; GM r15, r16, r17)

### The person-only control sweep (GM r15, r16 (2) and (4), r17)
- One lock for every control whose route is the person's alone: `hooks/usePersonLock` and
  `components/PersonLock` (`PersonLockLine`). The control stays in place and focusable
  (`aria-disabled`, the first-moment rule), its line sits under it, or once under its group's
  heading with every control pointing at it (`aria-describedby`), there is no tooltip, and both
  lift on the promote. A demoted tab locks too. `guard()` wraps a handler, since `aria-disabled`
  doesn't stop a click; where a section sends through one `run`, the check sits in `run` itself
  (ConnectedApps, PersonalAgentsSection) so the caller trace still sees the call and its catch.
- The words: "You can <verb> when this tab is connected as you.", "window" in the app through one
  word (`errorCopy.lockPlace`, `personLockLine`). The old constants (`HELD_PROPOSAL_LINE`,
  `HELD_QUESTIONS_LINE`, `PROPOSAL_GATE_COPY`, the pin's send line) go through it, so the app's
  word reaches them too.
- What locks, by GM r17's list (the full map is `tests/personLockSweep.ratchet.test.ts` CALLERS):
  Providers' keys (one line), the Krea sign-in and trial, Agent spending (one line), connected
  agents ("change connected agents": limit, colour, Revoke), personal agents and Antigravity
  ("change your agents"), Add under "Add an ACP agent", Storage ("change storage settings"),
  Preferences' run cost, the Codex sign-in, the personal-agent warning, the proposal bar and the
  asset strip ("review this", one line for Accept and Reject), the question form and permission
  card, Send note, Delete note, Dismiss on an Update and on the deferred-run notice, the
  Inspector's model and Fetch Schema, its favorite star ("save favorites"), Enhance, and both
  trash views ("delete projects for good", "delete items for good").
- The star's refused save used to drop silently: the star now goes back and the line says why
  (`clears-on-promote: inspector.favorite`, in both ratchets).
- The agent apps list, personal agents and the Commons on a demote (GM r17 (6), option b): once a
  demote lasts the 150 ms held rule (`useTabHeld.useDemotedView`), each shows what a tab that
  never connected shows: no rows and the not-connected load line; the Commons holds every call
  (`lib/commonsHold`, read by `commonsApi.send`: the not-connected line under the call's heading,
  nothing sent) and mounts afresh. The promote reads them again. "Demoted" is held after a
  promote in this session (`personSession.personWasPromoted`, reset with the session in tests;
  the promote count never resets, since its stamps compare against it).
- The ratchet: `tests/personGateRoutes.py` now also lists the routes that are the person's in
  every case (`require_person` called unconditionally, `person_only`, or the Commons'
  `human_dep`): 73, 40 main and Krea plus 33 Commons. `personLockSweep.ratchet` maps each
  frontend caller to its lock verb and host file (the host must call `usePersonLock('<verb>'`
  and render its line), or says why it has none; a stale entry fails. The Commons check pins
  the send guard, the view's wrapper, and that only `commonsApi` sends to `/api/commons`.
- The tracer gap the sweep list named (lib/agentNotes builds `${base(surface)}/read` and
  `/dismiss`) is not fixed in the tracer: the sweep ratchet lists those four routes by sender
  and path tail (`UNTRACED`) and fails if either changes. The sweep list's "fixed" was
  inexact; this is what was done.
- Boundary: no route changes access or spends without the person gate. `/api/krea/tools/call`
  accepts only `KREA_READONLY_TOOLS`. The 22 conditional routes stay live (GM r17 (7)).
- Seen live, not changed: a held tab's load sends the run-cost migration's `PUT /api/settings`
  (`lib/runCostConfirm`), which the gate refuses with 403, three times in one session.

### Review 8
- MEDIUM-1: the box a because line sits in goes neutral (GM r16 (1)): text, rail, border and
  fill. Each box that draws a warning carries `data-line-box` (NodeError, Projects' error,
  UnsavedEditsNotice, ProviderRecoveryStatus, the Commons detail's analysis failure and upload
  failures, both pin toasts), and `styles/becauseLine.css` turns `[data-line-box]:has([data-line-because])`
  neutral. `becauseLine.ratchet` now walks every element around a line up to its component's
  root, through callbacks, and resolves `className` props, defaults and what callers pass
  (NodeError's default, NodeRunError's template); a box that draws a warning must carry the
  mark. Live: the card's box reads ink 0.55 on a neutral rail and fill, and Projects' box the
  same. The PR body's "neutral on every surface" now names the boxes too.
- MEDIUM-2: a line covered by something opaque doesn't count. When the lines settle,
  `lineUncovered` samples `elementFromPoint` at five points of the line's rect clipped to the
  window; one landing inside the line (or on what holds it) counts. A dock opening or closing
  (child list changes), a panel moving (class or style), a resize or a scroll settles them
  again. Not IntersectionObserver v2. Live: the card's line under Settings brings the notice
  back, and closing Settings sends it away.
- MEDIUM-3: a line registers once and updates its words in place (`registerLine` returns
  `update`). The notice's live region says something new only when the swap changes (notice,
  line, nothing), not when a line's words change. Live: one because line swapped for another, no
  flash and nothing announced (the region had said the line twice before this).
- LOW-1: the runtime ratchet (`tests/helpers/bareLines.ts`, run after every test from
  `tests/setup.ts`): a "connected as you" text outside a registered element fails the test,
  whatever form put it there. `presenceRound10.bareLines` pins F1-F6. The general notice, its
  live region and an agent's quoted words (`data-agent-text`, on an Update's text in
  AgentNoteCard and AgentNotesList) are exempt. The lock helpers are in the scan's sentence list
  (M22's probe now pins each helper).
- LOW-2: a Generate start that fails for another reason: "Nebula added the nodes to the canvas
  but couldn’t start the generation. <reason>", where a fix ending "try again" becomes "then run
  them from the canvas" (GM r16 (3)). One rule (`errorCopy.thenRunFromCanvas`) words this and
  the not-connected case.
- LOW-3: the ratio guard, the unregister guard, and two lines in one element (both orders) are
  tested.
- NIT-1: `noticeWaiting.ts` cites `presenceRound9.band.test.tsx`. NIT-2: "window" in every lock
  line, through `personLockLine`.

### Gates-trace (review 8)
- LOW-1 (`tests/personGatedCallers.ts`): a path argument that names a `const` in the same
  function is read as that path wherever it's used (a template part, a `+` part, a const of a
  const, a conditional only when both branches read). Listed untraced instead, failing closed: a
  `let` or `var`, any reassignment, a conditional or `??` with an unreadable branch, a path held
  in an object property, and a path helper handed uncalled to another call (`send(presetsPath)`).
  `x['name']()` reads like `x.name()`. `presenceRound10.trace` pins B1, B6, B24 and J5 (`drops`),
  B2 and B10 (untraced 1), B23 (`drops`, untraced 1), with resolved, fail-closed and `keeps`
  controls. The trace of the real src is unchanged (21 untraced).
- LOW-2: `joinBackendPath` stays in `PATH_WRAPPERS` (lib/backend calls it) and W1 needs it; an
  inline `"person_" + "required"` code and the add_api_route and `app.api_route(...)(fn)`
  unreadable labels are pinned in `presenceRound10.routes`.
- NIT-1 (`tests/personGateRoutes.py`): a code built by `%`, `"_".join([...])` or `.format` is
  read; a gate container held as a class attribute is listed unreadable; a module container
  filled by `.append`, `.extend`, an item assignment or `+=` counts as holding the gate (inside a
  handler, `.append(require_person)` was already gated). Negative controls stay empty. The real
  backend: 67 routes, 0 unreadable, 73 person-only, byte-identical before and after.
- NIT-2: the PR body's Tests line is fixed.

### Agent-visible
Nothing. The locks, the lines and the demoted views are the tab's own; every route answers as
before, and the Generate card line is set in the tab when no run started (no run record carries
it). No MCP tool, CLI command, route or server response changed.

### Round 10 verification
- Gates: `tsc` (app and node configs, no incremental) and lint on the 79 changed files are clean.
- vitest, focused (explicit lists, two workers; full suites are left to CI):
  - The 68 files nearest the change, then 150 more that import a changed module or read the lock
    or line copy: the first runs found 30 tests still expecting the tooltip and `disabled` (now
    the line and `aria-disabled`, read through `tests/helpers/personLock.ts`), 69 in 8 Commons
    files whose API mocks lacked the new hold (moved to `lib/commonsHold`, so no mock needs it),
    and a demote check that read the never-reset promote count. All fixed and rerun clean.
  - The final set, 71 files: 718 of 721 passed, Errors 0; the 3 were timeouts. Rerun with the
    trace and route files (14 files): 383 of 384; the one timeout, the round 5 gated-route
    ratchet, passes alone (9 of 9). Its test takes 9.9 s alone against 4.4 s on 343abb99, since
    the trace now reads local consts, so its timeout is 60 s.
- On 343abb99 with the new tests copied in: 29 of 49 fail in the eight round 10 files; the 20
  that pass are controls (the not-connected Generate line, a canvas start, a quick reconnect,
  the ratio guard, the scan's own probes). The trace file fails 25 of 28 and the routes file 16
  of 29; the rest are controls and pins of existing behaviour.
- Mutations: 28 frontend mutants, 27 caught. The one left (Add's own submit check) is
  equivalent: the section's `run` refuses too, and removing that one is caught by the switch
  test. The trace lane: 43 mutants plus review 8's three survivors, all caught.
- Live on 8795/5795 (backend from the worktree in an isolated state; Vite from a scratch copy of
  the frontend with its own node_modules), 28 of 28 over two runs, after the harness was fixed
  (a fit-to-view that hid the card, and an awaited `goHome` that lost its page):
  - Blocked by interception (any host but these two ports fails) and a dead proxy behind it;
    canaries to 8000, 8001, 5173, `canary.invalid` and example.com were refused, and nothing else
    left after them.
  - The card's box and Projects' box compute neutral (ink 0.55, a neutral rail, border and fill).
  - A because line swapped for another: no flash, nothing announced (before the fix the region
    said the new line).
  - The card's line under Settings brings the notice back; closing Settings sends it away.
  - Providers: one line for the keys, every key control pointing at it, a click sending nothing;
    the Krea sign-in, the run cost, Storage and Add under "Add an ACP agent" lock with their
    lines and no tooltip.
  - The Commons on a demoted tab shows the never-connected line and no references; the promote
    reads it again. The demote and promote are the frontend's own calls (staged).
  - Nothing was accepted, rejected, answered, executed, or run against a provider.

## Round 11 (review 9 on f93f2968; GM r18, r19)

### A held tab sent person-only calls on its own (section 1)
- Root cause. `GET /api/settings` is open to every tab. When settings.json has no
  `runCostConfirmUsd` (a fresh or older file), `lib/runCostConfirm.applySavedRunCostConfirm`
  carries this browser's stored threshold over with `PUT /api/settings`, from every read that
  lacks it: the app's load, each Settings open, `nebula:settings-saved` and the run dialog's
  refresh. It had no person check, and `PUT /api/settings` is `require_person`, so a held tab got
  403 `person_required`. Its `.catch` reset `migration = null` on any error, so every later read
  sent it again (3 to 5 times a session live). The result wasn't lost, but the promote didn't
  redo it either: it waited for the next settings read made as the person.
- The same shape, found by loading a held tab live and opening every surface (Settings' three
  tabs, the Updates panel, the Agents list, the chat, Creator Studio, the Commons, Projects, then
  20 s idle): Settings' connected agent apps (`GET /api/agent/spend/apps`) and personal agents
  (`GET /api/personal-agents`), and the chat's agent list (`GET /api/personal-agents`, on open),
  each read only to be refused and show the not-connected line. Nothing else was refused when
  there were no unread updates: the Commons sends nothing on a never-connected tab, and
  Creator Studio and Projects read only open routes. (Corrected in round 13, review 10: with
  unread updates, opening Updates, and each update that arrived while it was open, sent the
  person-only mark-read and was refused; and the Commons on a tab reloaded with a stale token
  sent its reads with that token.)
- The fix. Person-only work the app starts on its own runs only on a tab connected as the
  person (`lib/personWork`: `whenPerson` runs it now, or keeps it by key and runs it once on the
  promote; `afterPersonRefusal` waits for the next promote after a refusal, never retrying on
  the next read; only a refusal of a request sent before a promote that already happened goes
  again at once). The carry-over: while the tab isn't confirmed, it is marked waiting; on the
  promote it reads the settings again first (another tab may have carried it over: then it only
  applies the value) and sends the PUT once. A refusal while sending waits for the next promote;
  another failure (offline) still goes again on the next read. Two tabs: the re-read means the
  second finds the value and writes nothing. The wait is silent (GM r19 item 5).
- The three lists read only on a tab connected as the person (`hooks/useTabHeld usePersonView`
  and `useReadAsPerson`: read once per held view that ended), and show the not-connected line
  locally on a held tab, with no request (GM r19 item 4). The chat's list waits for the same.
- Ratchet: `tests/presenceRound11.heldLoad.test.tsx` renders the app as a held tab, with every
  request recorded at `apiFetch` and the person-only routes from the route scan refused, opens
  each Settings tab, the chat and Projects, and fails on any request the gate would refuse. On
  f93f2968 it fails with two `PUT /api/settings`, `GET /api/agent/spend/apps` and two
  `GET /api/personal-agents`. A second test pins the promote: one more read, then exactly one
  PUT. `tests/runCostConfirm.round11.test.ts` covers the person tab, the held tab, an unanswered
  load, two tabs, a refusal while sending (no retry on reads, once on the promote), a stale
  refusal and an offline failure.
- No change for agents: no route, gate or answer changed; only when this tab sends.

### GM r18
- One placement rule, in the shared code: `PersonLockLine` takes a required `place`
  ('heading': right under its group's heading; 'tab': first in the tab; 'control': right under
  the control it locks, or closing the row of controls it locks), and `lib/lockPlacement
  lockPlacementProblems` reads it back from the page: the place, that a control points at the
  line, and that every locked control past its first moment points at a line on screen. The
  held-load test and the live check run it on every screen they open.
- a. Providers: one lock, "You can change provider settings when this tab is connected as you.",
  under the first heading ("Connect a provider · 23", or "Connected · N" when a provider is
  connected). It replaces the keys line and the Krea sign-in line; every key row and the Krea
  row point at it (KreaSignInRow takes the lock from ProvidersTab).
- b. Preferences: Job notifications lives in this browser only (`lib/jobNotifications`,
  localStorage), so it stays live; the run cost's line is "You can change this when this tab is
  connected as you.", inside the box right under it, the select described by it.
- c. Personal agents' and the connected apps' load lines go in the shared box
  (`components/LineBox`: `data-line-box`, neutral with a because line, the warning look for any
  other failure). Why the ratchet missed it: `becauseLine.ratchet` checks that a box drawing a
  warning carries the mark; a line with no box at all passed. The held-load test now fails any
  because line on its screens outside a `data-line-box`. The shared because style sets the sans
  face on the line and its box (`styles/becauseLine.css`); raw details and code keep mono.
  The shared cascade helper (`tests/helpers/cssCascade`) no longer drops `data-line-because`
  in its loose match: it marks a line's words, not a state a control takes, so that sans rule
  isn't read as the pin edge's own font.
- d. "Connecting…" shows only while a read of the status is on its way: not on a held tab
  (it makes no attempt) and not once the read was refused.
- Projects: a card shows no counts while this tab couldn't load the work
  (`ProjectHome workLoaded`, from the store's `initialized`). New project, rename and the card's
  trash are open routes (POST /api/projects, PATCH and DELETE /api/projects/{id}), so they stay
  live; only Delete forever and Empty are the person's, and they lock already. Live on a held
  tab whose work loaded: rename sent `PUT /api/projects/{id}`, New project sent `POST
  /api/projects` and opened it, the card's trash sent `DELETE /api/projects/{id}` with its Undo
  toast; nothing was refused. In two of the live runs the work didn't load at all, and not
  because of the hold: the store said "Couldn't load your projects. Nebula's backend isn't
  running. Start it, then reload." while the isolated backend was up (the app's first load
  raced it at a load average near 20). There the screen had no cards, so rename and trash had
  nothing to act on, and New project sent nothing: the store's create waits for the load
  (`initialized`), by design since round 3b, with Try again beside the error. Once the check
  had gone home through `goHome` the error was gone (`error: null`, `initialized: false`), and
  the screen showed "Your first project starts here" with a New project that does nothing.
  That is any tab whose first load failed, held or not; it isn't changed in this round and is
  reported to main.
- The Commons: adding (intake/files, intake/url, intake/moodboards: `human_dep`) locks Add with
  "You can add references when this tab is connected as you." under it; "New collection…" in
  "Add to" is disabled while locked and does nothing (the select stays live; no new line,
  GM-confirmed). A drop onto the grid is taken (the browser doesn't open the file), with no
  highlight and nothing sent, and the empty-state line is gone while locked. Add's line hangs under Add,
  ending at its right edge (it ran off screen and under Updates starting from its left). The
  toolbar ratchet (`presenceRound7.toolbar`) now lets a plain `PersonLockLine` (its lock, place
  and class, nothing else) sit in a row: it is the control's own description, made from its
  verb, never a refusal; anything more on it still fails. The Commons' own error line
  (`CommonsErrorLine`) is the shared box (`data-line-box`): its rail and fill drew one, and the
  live check found its because line outside a box.

### Review 9 and GM r19
- Locked controls look locked (MEDIUM-1, GM r19 1): one rule set in `styles/disabled-buttons.css`
  keyed on `[data-person-lock]:not([data-held-pending])`, held through hover, press and focus:
  buttons take the shared grey label and edge with no fill (a listed filled style keeps its grey
  fill), a select or input keeps its value in `--disabled-label`, a switch takes the 0.06 edge
  and a grey knob (on still reads by the knob's side and a faint fill). Locked controls stay
  `aria-disabled` and focusable. `lockPlacementProblems` fails a locked element no rule covers;
  `tests/presenceRound11.lockLook.test.ts` reads the rules; the live check computes them.
- The handover flash (MEDIUM-2 → LOW): while a newly registered fix line waits for its first
  observer entry, the answer on screen holds (`notConnectedLine settle`), so A → B across
  elements, and a ternary swapping two LineTexts on one element, neither flash the notice nor
  announce. The entry always comes; a line out of view then brings the notice back.
- Drafts and focus (MEDIUM-3, GM r19 2): the Commons keeps the search, filters, URL draft, open
  Add menu, section, open reference, membership notes and keyword drafts across the demote's and
  the promote's remount (`commons/commonsDrafts`, above the keyed body). When a remount or a
  demote takes away the focused control, `hooks/useFocusHandover` moves focus to the same control
  if it is back (by its label), else the section's lock or not-connected line (`tabIndex -1`,
  `data-focus-line`), else its heading; never while focus is on a control that's still there.
  Used by the Commons, Personal agents and Agent spending.
- The demote's 150 ms (gates-trace MEDIUM-1): `personSession` stamps when the hold began and
  tells subscribers when 150 ms have passed (`personHeldSettled`, `personDemotedSettled`), so a
  view that mounts on a tab demoted long ago is demoted from its first frame. `commonsApi.send`
  reads it directly, so a call sent before the view renders is held too, and the view's own flag
  clears when it unmounts (a test found it outliving the view). `usePersonView` uses the same
  clock. The other `useHeldLook` users time a moment of their own (a retry, a clash answer).
- The key-added Undo (LOW-1) locks with the providers' words, its line under it.
- The Update arrival card with an open ask has one line, "You can review or dismiss this…" (or
  "answer", following the card's own button), both its buttons described by it; with no ask, ×'s
  own line sits right under ×. Two older tests expected "answer this" on the card and follow it.
- Trace and scan (gates-trace LOW-1 to LOW-3, NITs; lock-sweep LOW-2, LOW-3, LOW-6):
  - The route scan (`tests/personGateRoutes.py`) caches its fill lookups and keys a function's
    own containers by that function (another handler's local `checks` no longer pools by bare
    name; `self.x`, aliases and `global` names resolve). Its output is byte-identical; it takes
    3.8 s, not 7.6 to 9.9 s (the Python scan was the slow part). The round 5 timeout is back to
    30 s and COMPOSED is empty.
  - `POST /api/trash/empty` is person-only: the scan now reads past an `if` whose branches can't
    return. Exact counts: 67 gated main and Krea routes, 41 of them person-only (40 before) and
    26 not; 33 Commons routes (`human_dep`); 74 person-only in all.
  - The tracer (`tests/personGatedCallers.ts`) reads a helper call inside a longer path, an
    imported or re-exported const, a namespace member, a parameter wrapper (same file in round 11; round 13 adds imported ones, object members, and a
    const or helper call handed to one) and an imported
    `/api` prefix; a `let` holding a const, an unreadable `/api` join, a held composed call and a
    wrapper that reads the answer itself are listed as untraced, each with its reason. A
    self-referential const no longer overflows the stack. The four agent-notes routes now trace
    to `agentNotesStore`, so UNTRACED is gone.
  - Controls, not host files (lock-sweep LOW-3): `lockReach()` walks from each sending unit to
    every JSX control that reaches it and reads how it is locked; `personLockSweep.ratchet`
    fails any control on the way that isn't. It found two: the held run's Run, which with every
    node deleted only releases the approval (`DELETE /api/canvas/approvals/{id}`), and Projects'
    Try again after a failed Delete forever or Empty. Run now locks with Dismiss in that case
    (pointing at its line; with nodes left it runs, which isn't person-only, and stays live), and
    every release the store sends goes through `releaseOrHold`, which keeps it for the promote
    on a held tab as Dismiss already did. Try again locks with "You can delete projects for good
    when this tab is connected as you." when it would redo either (`projectRetryPersonOnly`).
    `tests/presenceRound11.heldRetry.test.tsx` covers both. The App and Settings CALLERS reasons
    are rewritten.
  - Bare lines (lock-sweep LOW-6): P1 needs the words to be the LineText's own; P2 exempts only
    the two Update text classes; P3 fails a `title` or `aria-label` with "connected as you",
    set at render or after. Two older fixtures used the forms these now fail (round 7's locked
    form with its line in a tooltip, round 9's agent note without its class) and follow src.
  - New: `presenceRound11.routes`, `.trace`, `.bareLines`; 39 of their 52 tests fail on
    f93f2968 (the rest are negative controls and pins); 38 of 39 mutants killed (the survivor is
    a redundant cross-file walk `callersOf` already covers).
- Behaviour tests for each swept control (LOW-4): `presenceRound11.sweptSettings` (11) and
  `.sweptSurfaces` (9). Each control, held past its first moment, is aria-disabled and
  focusable, has no tooltip, points at one line with its verb, and sends nothing on click,
  change or submit; after the promote the same action sends. Covered: Add key, Save key (a draft
  typed before the demote doesn't save), Krea sign-in and default, the providers' one line,
  the storage folder (a held draft doesn't save on Enter or blur), the telemetry switch, the run
  cost, the connected apps' limit and colour, the personal agent warning's accept, Enhance, both
  trashes' Empty and Delete forever (a confirm armed before the demote sends nothing), the
  Inspector's model picker and star (a refused save puts the star back). The 12 named surviving
  mutants (M5, M13 to M22, M25) are killed.

### Agent-visible
Nothing. Every route, gate and answer is unchanged; only when this tab sends, how its locks look,
and where its lines sit changed.

### Round 11 verification
- Base: f93f2968. Nothing committed, pushed or stashed; full suites left to CI.
- On f93f2968 the new tests fail: the held-load ratchet (five refused requests); 27 of 46 in the
  run-cost, demote, focus, handover, lock-look (it can't load), held-retry and swept files (the
  swept surfaces file passes 9 of 9 there: it pins locks that already existed, to kill
  mutants); and 39 of the 52 trace, route and bare-line tests (the rest are controls and pins).
- Mutations: every new guard was mutated and each mutant caught (the run-cost wait, the lists'
  held reads, placement, the lock look, the handover hold, drafts, focus, the 150 ms clock,
  Commons' Add, New collection, drop and flag reset (corrected in round 13: the flag reset had no
  test until round 13's `presenceRound13.heldCommons`), the Undo lock, the Update card's line, the
  card counts, the held run's Run and release, Try again and its rule, the Commons line's box);
  the swept lane's 12 and the trace lane's 38 of 39 (the one left is redundant).
- Gates: `tsc -b --noEmit` and eslint on the 66 changed files are clean. Focused vitest on two
  workers over 136 affected files: 1,756 of 1,760 with Errors 0; three were timeouts at a load
  average near 20 and passed alone, and one was real (the toolbar ratchet and Add's line, fixed
  as above). The 21 files changed after that ran again: 233 passed, 3 timed out and one file's
  setup hook timed out (load average near 36); each of the four files passed alone. The copy
  ratchets (`tests/lib/errorCopy.namedLine`, `.sweep`, `errorCopy`, `.typeError`) and the lib
  tests that name a touched file (27 files) pass 645 of 645; no new hand-built heading and
  reason line was added.
- Live on 8795/5795 (8000-8010, 5173 and every other host blocked, canaries to 8000, 8001,
  5173 and a `.invalid` host refused, keys unset): 30 of 30 in the last full run, after fixes
  the runs found (Add's line cut off under the header, the Commons line outside a box, the
  preferences line's inset, and harness steps). A held tab's load sent no person-only request;
  the promote sent exactly one `PUT /api/settings` (an 8 s wait missed it once at a load
  average near 40; with up to 30 s it passed in every run). Nothing was accepted, rejected,
  answered, executed or run against a provider. Shots: `agent-presence/fu3k/` in the scratch
  folder, 11, no two alike; the Projects shot shows counts because the held tab's work loaded
  (the no-counts state is in the unit tests).

## Round 12 (CI on 622c55d0; GM r20)

### The focus ring on a locked control (section 0)
- CI failed `tests/focusRingCss.test.ts` on `styles/disabled-buttons.css`: the round 11 lock
  rules held `:focus` to the locked look, and the checkbox's look is an inset box-shadow, so the
  sweep read it as a second focus ring. `:focus` is out of all three lock rules (button, field,
  checkbox); hover and press still hold the look. A locked control stays focusable, so it takes
  the shared `--sr-focus-outline` like any other. No exception was added to the sweep.
  `tests/presenceRound11.lockLook` now fails any `[data-person-lock]` selector with `:focus`.
- Checked in a real browser: on every screen the live check opens, each locked control gets
  keyboard focus and must compute `2px solid` in `--sr-ink` with the same box-shadow focused as
  not. Buttons (Providers, the Update card, the Commons' Add), selects (Preferences), text
  fields and the switch (Storage) all pass; the switch keeps its 0.06 inset edge and gains the
  outline. A control disabled for its own reason (Personal agents' Add with an empty draft)
  takes no focus at all and is left out.

### Add's lock line moves to the Commons' line row (GM r20 1)
- `tests/presenceRound7.toolbar.test.ts` is back to its f93f2968 form (no diff). The header
  holds no lock line.
- `components/commons/CommonsPageLines` is the one row under the header for page-level lines:
  the because line (or error) first, then Add's lock line as its own sentence, then the other
  messages. With no because line the lock line takes the row alone; with nothing to show there
  is no row. Add's `aria-describedby` points at the line. `PersonLockLine` has a fourth place,
  `page`, and `lib/lockPlacement` checks it: inside the row (`data-page-lines`), after no
  control in it.
- The header measures 49 px at 1280, 1366 and 1440, with and without the line, and with the
  line alone: `min-height: 48px` is met and the tallest child is 32 px plus 8 px padding each
  side and a 1 px rule. A connected tab's header (no lock line, the same header markup as on
  f93f2968) is 49 px too, so the line adds nothing to it.
- `tests/lineRegistration.ratchet` counts `CommonsPageLines` as a component that registers its
  line (it hands it to `CommonsErrorLine`).

### One rule for the general notice (GM r20 3)
- Shot 09 (round 11) was taken 0.9 s after a staged demote at a load average near 40, before
  the handover settled. Recorded live each frame from the demote: the because line arrives
  0.6-0.7 s after it (the held read answers after the 150 ms hold, under load), the registry
  counts it one frame after its first observer entry, and the notice then leaves with its fade.
  The notice and the because line were on screen together for 0.16 s and 0.27 s in two runs
  (the last of it while fading), and never after 1.2 s. Once settled, only the because line
  shows, in every run. No change to the registry or the demote path was needed.
- `tests/presenceRound12.oneNotice` pins it: a demote, then the Commons, and after the handover
  only the because line (with Add's lock line beside it); Personal agents' because line sends
  the notice away; a lock line alone keeps it. Its ratchet fails whenever the notice shows
  beside a registered because line in view, and a test shows it catching that. The live check
  runs the same rule on every screen it opens.

### The locked look (GM r20 4)
- Waiting for review 10's measure (section 2), which hadn't arrived. Measured live: a locked
  button's label is `rgba(255, 255, 255, 0.55)` (`--disabled-label`).

### Tests and checks
- New tests fail on 622c55d0: `presenceRound12.commonsRow` can't load, and the restored
  toolbar ratchet and `focusRingCss` fail there. `presenceRound12.oneNotice` passes there,
  since the rule already held once settled; it is a ratchet against regressions. Mutations
  caught: the `page` place check, the row's render condition, the row's order, `:focus` back on
  the checkbox rule, and the banner ignoring the because line.
- The live check's harness: the "no banner" case stages offline by refusing this check's own
  backend requests at the interception (a paused backend left the app online), and the
  header check reads the box against the connected one.
- Gates: tsc and eslint clean. Focused vitest (90 files: the 66 that read `styles/`,
  `focusRingCss`, the presence ratchets, the copy ratchets and the lib tests naming a touched
  file) on two workers: 1,267 of 1,278, 2 skipped, Errors 0. Eight failures were timeouts at a
  load average of 30-50; one was real (`lineRegistration` didn't count the new row, fixed).
  Alone, everything passed but three tests with their own 30 s and 120 s limits (the gated-route
  scan, the person-only caller map, the GM r18 frame corpus), which pass with the limit raised
  in a temporary copy (110 s, 71 s, 312 s at that load).
- Live on 8795/5795 (8000-8010, 5173 and every other host blocked, canaries refused, keys
  unset): 41 of 41 in the last full run. Shots: `agent-presence/fu3l/` in the scratch folder
  (01 the held Commons with both lines, 02 Add's line alone, 03 after a demote, settled), no two
  alike.

## Round 13 (GM r21; review 10 on 622c55d0; base 8651112c)

### Add's line lines up with the because line's words (GM r21 1)
- A Commons line's rail and padding are tokens (`--commons-line-rail`, `--commons-line-pad-x`
  in `styles/commons.css`), and `--commons-line-text-x` is their sum. `.commons-notice` draws
  with the first two, and Add's lock line in the row is inset by the sum, so it starts where
  the because line's words start, not at the rail, and at the same x when it stands alone. No
  second offset. It keeps the lock-line style (11 px, 0.55).
- Live, measured with a Range over each line's text: 28 px for both at 1280 and 1440, with the
  because line and alone (the rail at 16). The header stays 49 px (GM r21 2).
- `tests/presenceRound13.commonsAlign` pins the tokens, the sum and that nothing else moves
  the lock line sideways; it fails on 8651112c and catches five mutants (a literal inset, a
  literal padding, a literal rail, a wrong sum, an extra margin).

### Held calls (review 10 held-calls)
- Updates' mark-read (MEDIUM-1). `POST /api/canvas/agent-notes/read` is person-only, and
  `sendRead` sent it whenever the list opened or an update arrived while it was open. While the
  tab is unconfirmed it sends nothing and says nothing: one read per list key waits (the
  newest `upTo` and the union of ids) under `whenPerson('agentNotes.read:<key>')` and goes once
  on the promote, for what is still unread. A read refused in flight joins the same wait. The
  updates stay unread until the tab connects (GM's default while GM rules).
- A stale token (MEDIUM-2). `commonsApi.send` and `useDemotedView` held on
  `personDemotedSettled`, which only covers a demote seen on this page; a tab reloaded after a
  backend restart kept its token and sent the Commons' reads with it. Both now hold on
  `personHeldSettled()`. No other code used the per-page check. That round left main's
  Commons 401 path as it was (a second 401 dropped the token whatever it said, review 11
  held-calls LOW-3); round 14 puts it through the one drop rule (Justin's decision).
- After a refused load, Settings' agent apps and personal agents read once on the promote, not
  twice (`usePersonView`'s `readsOnPromote`). Releases (`releaseOrHold`, `dismissDeferred`)
  wait on `personUnconfirmed()`, as accept and reject do.
- The tracer resolves imported wrappers, object members and a const or helper handed to one;
  a callee in Nebula's own files it can't read is listed with that reason. Its output on the
  real source is unchanged.
- `presenceRound11.heldLoad` now loads the app as a never-connected, a demoted and a
  stale-token tab and opens Settings' tabs, the chat, Updates (an unread update, the corner, an
  arrival, the Agents panel), the Commons, Creator Studio and Projects; it fails on any request
  the gate refuses or any request sent with the person's token. Two mocks had hidden the
  Updates corner and Creator Studio; they render now.

### Lock look and Commons focus (review 10 lock-look-ui)
- A locked filled button keeps GM's grey fill again (MEDIUM-1). The lock rule tied the filled
  list at (0,3,0) and came later. Its element part is now `:where(...)` (0,2,0), and the block
  sits above the filled list so the list also wins a keyboard press. Ghosts keep the ghost
  tokens. `presenceRound13.lookCascade` resolves every filled and ghost class through the
  cascade; that needed a fix to `tests/helpers/cssCascade`, whose specificity stopped counting
  at the first `:is()`. The live check now requires the grey fill on filled classes.
- A demote no longer remounts the Commons (MEDIUM-2): the body takes a `view` and empties its
  loaded data on a new one; only the panes that load their own data are keyed. Focus and an IME
  composition stay put. The handover also finds a field by its label's words.
- The key-added Undo points at the Providers line when it is on screen and shows its own line
  only when it isn't (LOW-3).
- Held and demoted Commons show one because line chosen by state, the status line first
  (NIT-2; the builder's choice, for GM). Overruled by GM r22 in round 14: one page line, no
  ranking (below).
- Review 10's surviving mutants L4, L7, L10, L13 and L20 have tests; L9 is equivalent and
  L18's code went in round 12. Round 12's moot LOW-1 and LOW-2 still hold on this head.
- GM r20 4 is settled by review 10's measure: locked ghost labels 0.55 with a 0.06 edge,
  against 0.92 and 0.12 live.

### Round 13 tests and checks
- The load line's rank first went into `show` as an if/else, which hid `setLine(line)` from
  `presenceRound6.ratchet` (it reads the statements beside each `retryOnPromote`). A ranked
  setter in CommonsView instead broke `presenceRound9.commons` (no screen sets a line itself).
  The rank now lives in `useCommonsLine` as a `showLine` helper; both ratchets pass, and
  dropping the rank fails both state tests.
- Gates: tsc and eslint clean; vite build and the build budget pass (457,017 bytes raw);
  isolated backend tests 114 of 114 (no backend file changed). Focused vitest over 233 files
  (every touched test, the tests of every changed module, and the ratchets that read `src/` and
  `styles/`): 3,013 of 3,014, Errors 0; the one failure was the ratchet above, and the 51
  Commons and ratchet files then passed 575 of 575. The lanes' timeouts at a load average of
  25-50 each passed alone (two with a raised limit).
- Live on 8795/5795: 44 of 44. The check now requires the grey fill (0.42, dark 0.62 label) on
  the filled classes and 0.55 with no fill on ghosts, and measures the alignment.

## Round 14 (GM r22; base bf71ccd6)

### One page line on a held tab, no ranking (GM r22)
- GM overruled round 13's status-first rank: "Commons status" is Nebula's word, and what the
  person sees is an empty page. The rank (`showLine` in `useCommonsLine`, `notConnectedLoadRank`
  in CommonsView) is gone.
- `useCommonsLoadLines` (in `components/commons/useCommonsLine.ts`) keeps the page's loads
  (status, references, collections, in that order) and their failures, and `pageLoadLines`
  says what shows, one rule:
  - refused because this tab isn't connected as you (never connected, demoted, a stale token):
    "Nebula couldn’t load the Commons because this tab isn’t connected as you. Open the link
    Nebula printed when it started.", and never a load's own line;
  - a connected tab with one load failing alone: that load's own line;
  - two or more loads failing for the same reason: the page line with that reason
    ("Couldn’t load the Commons." over the reason); different reasons: one line per failed
    load, in the page's order (GM confirmed both).
- A load that answers clears its own failure and every "not connected" one (the tab is
  connected now); a new view or a reconnect clears all. Refused loads clear on the promote and
  run again once (`commons.load-lines`, `commons.load-lines-retry`, registered in the
  clears-on-promote and line-registration ratchets). The screen still never sets a line itself:
  `presenceRound9.commons` and `presenceRound6.ratchet` pass unchanged.
- `CommonsPageLines` takes one line or several, each in its own box; Add's line follows them.
- Tests: `presenceRound14.pageLine` (held, demoted and stale-token tabs show only the page line,
  watched for the whole test; a connected tab's one failure, one reason, two reasons in page
  order; the rule itself). Round 13's NIT-2 tests now expect the page line. On bf71ccd6 six of
  eight fail; the two that pass pin the connected tab's specific lines. Mutants caught: no
  person branch, no same-reason branch, success keeping the person line, the page line under
  the request's heading, arrival order instead of the page's (caught once the status answers
  last), and no promote clear.

### A token the backend says is invalid is dropped (Justin, 2026-10-31)
- `dropRefusedPersonToken(sent)` in `lib/personSession.ts` forgets the stored token only when
  the token the refused call carried is still the tab's and Nebula's health has answered
  online. `browserPersonCredential()` is null in the desktop app, so the one comparison also
  keeps the desktop case.
- A refusal before the first health answer waits for it (`afterHealthAnswer` in
  `lib/backendConnection.ts`). A fresh tab says hello as soon as its socket opens, so on the
  live check the refusal came before the first probe answered; a first build that just ignored
  such a refusal never dropped anything on a real load. It is dropped only if that answer is
  online and no promote came in between; an offline answer or a promote keeps it, and the
  next explicit refusal decides again.
- Two callers, each only on the explicit invalid answer:
  - `wsClient`: the socket's `personRequired` answer, with the token that socket's hello carried
    (kept per socket in a WeakMap, never logged).
  - `commonsApi.send`: the second 401, after the token was looked up again (the response's token
    is kept in a WeakMap), and only with the backend's `invalid UI session token` detail
    (`INVALID_PERSON_TOKEN_DETAIL`; a test reads commons/actors.py to keep the two in step).
    "no UI session" (a launch whose desktop token pipe failed) and an agent token's refusal keep
    it. The socket's `personRequired` can't tell an invalid token from a launch with no session;
    a browser token only ever comes from a link a launch with a session printed, so that is left. Before this round that 401 forgot the token at once, health or not;
    `commonsApi.test`'s forgotten-session case now answers health first.
- Other tabs: the token lives in each tab's session storage and in memory, so this drop never
  reaches another tab. Each drops its own copy only on its own explicit refusal, and a tab that
  holds a newer token keeps it (the comparison), so the person's live tab doesn't flicker.
  (Round 15: until review 12, a new link taken while the old hello's answer was on its way was
  the exception; one entry per hello closes it. A duplicated tab copies session storage once, at
  duplication, and is independent after that.)
- Never on a close, an error, a 5xx, 403, 404, 408, a network error or a timeout.
- Live (8795/5795): a tab holding a made-up token says hello with it, the real backend answers
  `personRequired`, and the tab drops the token and holds none. The check first failed twice:
  the harness's dead proxy refused the app's `localhost:<backend>` health probe, so the first
  health answer was offline and the token was kept, as designed. With localhost on our two ports
  let through (every other host still blocked, canaries still refused) it passes. The tradeoff
  this shows: if a tab's first health answer is offline, a refusal before it keeps the token
  until the next hello (a reload or a reconnect) is refused again.
- Tests: `presenceRound14.tokenDrop` (25): the drop on each explicit answer, before and after
  the first health answer; each keep case (no answer yet, offline, a promote or a new link
  before the answer, the other answers); after the drop no token, no hello and no Commons
  call; the new link stores the new token and the next socket says hello with it; no console
  call or event carries the token. On bf71ccd6 seven fail (every drop case and the 401 while
  starting). Mutants caught, 10 of 10: no wait, no flush on the answer, the answer read as
  online, the immediate path ignoring offline, the online check, the promote check, the token
  comparison, the desktop app reading storage, either caller removed. An earlier `!sent` and
  in-function desktop check were equivalent mutants, covered by the comparison, and are gone.

### The proposal reads
- Justin decided: reads stay as they are. The earlier "still with Justin" lines now say so.

### Review 11 and GM r23 (sections 2 and 3)
Built in three lanes (A: the Commons and focus; B: the held mark-read, the tracer and the Commons hold window; C: Undo and the chat picker), then joined by the builder.

#### Lane A: the Commons, focus, the one shift, the ring, the prompt
#### Focus handover (review 11 MEDIUM-1)
useFocusHandover now takes a snapshot when focus is taken: a WeakSet of the scope's named elements, the control's pane and its ancestors. "The same control" must be an element not in that snapshot, with the same label in the same pane. The pane is the nearest data-focus-scope or labelled region (aria-label, or aria-labelledby read as text, since useId values could change on a remount). A look-alike that was there all along is never taken, so focus goes to a line instead. When the handover moves focus it takes a new snapshot but keeps the lost control's key, so on the promote focus goes back to the control's new twin, never to a look-alike.

The line is now the one nearest the lost control. First a line in the control's own pane. If there is none, the handover goes outward from the nearest ancestor still on the page and takes a line inside it, or a line that a control inside it points at. Otherwise it takes the first line in the scope. This was needed because Add's line and the page line now land in the same frame (GM r23 1). The first line in document order was the page line, but the URL field's focus belongs on Add's line (presenceRound13.commonsFocus pins that).

New attribute FOCUS_SCOPE_ATTR (data-focus-scope), for a pane whose region has no aria-label. No pane uses it yet; the Commons panes already have labelled regions ("Asset detail", "Commons filters").

#### One shift on a demote (GM r23 1)
components/commons/useLockLineHold.ts, with ADD_LINE_HOLD_MS = 1500 exported. Add locks at once (aria-disabled, the guard, the look). Only its line and Add's aria-describedby to it wait. They show in the same render as the page line, or alone after 1.5 s. The wait starts when the line could first show: the lock taking hold, or Nebula coming back online while the tab is still not connected. On reconnect the loads clear and read again, so their line comes again and it is still one shift. Once shown, Add's line stays as long as the lock does. While held back, Add carries data-lock-line-held (see the lockPlacement change below).

The because line itself isn't held, as GM asked. On a demote both wait out the same 150 ms (useDemotedView, and the lock's pending moment), so neither comes much ahead of the other.

#### The ring hugs the sentence (GM r23 2)
.commons-messages__lock-line is now width: fit-content, with max-width calc(100% - inset) and margin-left var(--commons-line-text-x) in place of padding-left. The words stay at x 28 by the same shared measure, and the global token ring (2 px at a 2 px offset) draws around the words. The row's padding stays on .commons-messages. No rule draws its own ring on a lock line (pinned in presenceRound13.commonsAlign). The builder's live shot should confirm the ring box starts about 26 px from the page edge (28 minus the 2 px offset), not 12.

#### Offline comes first (GM r23 3)
I put the rule in usePersonLock itself, so every lock line in the app follows it from one place. While offline the control stays locked, its line is hidden and nothing points at it, and it carries data-lock-line-held. Back online the line shows again. One helper now holds the rule for because lines: hooks/useOfflineFirstBecause.ts (lane C's separate wrapper and helper were folded into it).

Commons because lines: hooks/useOfflineFirstBecause.ts hides a not-connected line (isBecauseLine) while offline and keeps any other failure's line. It is used in CommonsErrorLine (the page row, the action line, and every pane's line: Detail, Settings, Review, Evaluation, CloseBatch), the detail's not-loaded state, the review and evaluation image lines, and CommonsMedia. The line-registration ratchet's Commons entries now name what those places pass on (shownImageError, CommonsMedia shownError, CommonsReview shownError).

#### Every place a not-connected line and the offline notice can be on screen together
The offline notice (BackendConnectionStatus) is app-wide, so any of these can coexist with it.
1. Every usePersonLock line through PersonLockLine. Done centrally in usePersonLock. The users are CreateComposer, CommonsView (Add, and the new create collections lock), ProjectHome, Inspector, ChatPanel, PersonalAgentWarning, PermissionCard, Settings (ProvidersTab, SettingsNoticeBar Undo, PersonalAgentsSection, PreferencesTab, StorageTab, KreaSignInRow, ConnectedApps, AgentSpendSection), PinLayer, DeferredRunNotice, AgentQuestionsForm, ProposalBar, AgentNoteCard, AssetProposalStrip and AssetTrash.
2. The Commons page line (useOfflineHiddenNotice, already) and every Commons pane line. Done (useOfflineFirstBecause).
3. Settings held lines in AgentSpendSection and PersonalAgentsSection. Lane C already uses useOfflineFirstLine. Lane C should check that the load-failure because lines at AgentSpendSection.tsx:55 and PersonalAgentsSection.tsx:150 go through the same rule.
4. PersonRequiredBanner (the general bottom notice). Not done, not my file. Change below.
5. PinComposer.tsx:84 `gateBanner = bannerUp || sendLock.shown`. bannerUp shows the hand-built Send line even offline. Not done. Change below.
6. AssetProposalStrip.tsx:254, the held proposal line `heldProposalLine()` rendered by hand. Not done. Change below.
7. agentRosterModel.ts:220 and heldLock.ts heldLockFor, the held ask's lock reason. It is a tooltip, not an on-screen line, so I left it and list it for the builder.
8. Because lines from actions: Inspector.tsx:535 (save the favorite), CreateView.tsx:193 (save the style), projectStore.ts:591 and :1933 (projects), graphStore.ts:4718 (save your changes). Each renders where its surface shows the line. Change below.
9. Chat: ChatPanel.tsx:1292 personRequiredCopy() as a system message, and commonsChatAuthority.ts:20. These are entries in the transcript, not status lines, so I would leave them. Lane C owns ChatPanel.
10. Lane B: agentNotesStore and the Updates panel lines (mark-read refusals, markReadRefusedCopy). Lane B should hide a because line there while offline by the same rule.

#### The New collection prompt (GM r23 4)
The prompt stays mounted at a demote. CommonsView gives it a lock through components/commons/promptLock.ts PromptLockContext, so hooks/useCommonsPrompt is unchanged. The lock is usePersonLock('create collections'), which gives "You can create collections when this tab is connected as you." No line for creating collections existed before. The verb form matches the others ("add references", "change provider settings"). OK takes lock.control() and the submit is guarded, so Enter in the field does nothing either. The line goes right under the buttons row (place control), right-aligned so it ends under OK; that is a look choice for the builder's shot. Cancel and Escape stay live. The typed name is the dialog's own state, which survives because nothing unmounts it. Focus stays in the field, since autoFocus runs only on mount. On the promote OK unlocks in place.

One thing left as it was: offline with the tab connected, OK still sends, createCollection is refused offline without a line, and the prompt closes with the name lost. That is older behaviour and not part of this round.

#### Lane B: the held mark-read, the tracer, the Commons hold window
#### The held mark-read (store/agentNotesStore.ts)

- Review 11 LOW-1. A held read now also keeps `covered`: the unread updates its `upTo` covered at the moment it was held. On the promote, if the `upTo` is still listed, one `upTo` read goes, as before. If it has left the list (an agent's next "since its last turn" update replaced it, or the cap pruned it), the read goes by id for the covered updates still listed and still unread. The newer update that replaced it is never read, since the person never saw it. I sent ids, not "the newest still listed as upTo", because ids are exact. An `upTo` would also read anything older that arrived by a sync in between. Pinned by A1 and two neighbours in tests/presenceRound14.heldMarkRead.test.ts.
- GM r23 item 5. A mark-read refused in flight now shows nothing. The person-refusal branch sits first in the catch: it re-joins the list's one wait (holdRead plus lib/personWork afterPersonRefusal, the same `agentNotes.read:<list>` key that whenPerson uses) and returns. So a second refusal, or a third, never drops it (A8 now sends 3, not 2) and never shows a line (A3). Both of GM's conditions are pinned: the tab marks nothing read (readAt stays null and the count stays the server's), and no line, clear or retry is registered. The canvas list is no longer fetched again after a person refusal, since nothing changed in the tab. A failure for any other reason still shows "Couldn’t mark the notes read." and still fetches the list again.
- The `retry` flag is gone. It existed only so a second person refusal would add no line. With no line for any person refusal, one path is left.
- Is there a person-pressed "Mark all read"? No. The corner reads in three places: on open (openList), on an arrival into the open list, and when a card is used (onRead on the card's text, Show or an action). None is a "Mark all read" control, so none gets the line. The card read is a press, but it reads as a side effect of opening or using the card, not as a request to mark it read. I treated it like the others: it shows nothing (a test pins that). If GM reads the card click as the person's own press, it's a small change: a flag on markReadIds that keeps today's line for that path.
- The mark-read now goes through lib/personWork, not retryOnPromote. A retryOnPromote call must sit beside a because line (presenceRound6.ratchet), and this path has none now. The ratchets changed to match, in my own entries only:
  - tests/clearsOnPromote.ratchet.test.ts: read_canvas_agent_notes and read_board_agent_notes are now NO_LINE with the reason. The SITES entries notes.read and notes.read-retry are gone, the RETRIES entry notes.read-retry is gone, and `store/agentNotesStore.ts#sendRead` is in CALLERS as NO_LINE.
  - tests/lineRegistration.ratchet.test.ts: the HOLDERS entries notes.read and notes.read-retry are gone. notes.corner and notes.dismiss still show their lines in AgentNotesList.
- markReadRefusedCopy and MARK_READ_REFUSED_COPY in lib/errorCopy.ts have no caller in src now. I left them because errorCopy.ts isn't in my set and several ratchets name the helper in their sentence lists. They can go in a cleanup.
- Review 11 NIT-3. The same read already on its way isn't sent again: the key is the list plus its upTo, its sorted ids, or "all". The second ask waits for the first one's handling. The entry leaves the map as soon as the answer arrives, before it is handled. Without that, a refusal of a read sent before the promote (retried at once) would find itself still on its way and be dropped. presenceRound5's "refused after the promote … retries at once" caught that during the build. A newer upTo, or the same read after the first has answered, still goes. Pinned by A4 and two neighbours.
- Review 11 NIT-2. A reload drops a pending held read: heldReads lives in memory only. I left it, as the brief asks. It's the conservative side: nothing extra is read, and the updates show unread after the reload until the list is opened on a connected tab.
- LOW-5 N4. A7 is now a real test: held on p1, p2 opens, then the promote comes, and nothing is sent.
- LOW-5 N10. It's pinned, not left: a card read held for the promote and then read by the person's other tab isn't sent. A9 didn't catch it because there the upTo covered the id.

#### Older tests changed (each one pinned the in-flight line for the automatic read)

- presenceRound4, "GM r3 items 1 and 3":
  - "a refused read … says GM’s line" now asserts no line, no error, the header "2 · all unread", nothing read in the tab, and the read waiting.
  - "the promote retries the read once" now waits on personWorkWaiting instead of the line and pendingPromoteRetries.
  - "a retry that fails … shows no new line" now also asserts that the read is held again and goes on the next promote (it used to be dropped).
  - The 500 test is unchanged.
- presenceRound5:
  - "a refusal of a request sent after the promote …" asserts the read waits, with no line.
  - "the retry checks it is still the project it read (keyFor)" waits on personWorkWaiting instead of the line. Its assertions after the promote are unchanged.
- presenceRound6:
  - The polite-count test's comment no longer says the list is fetched again on the refusal.
  - "fresh held … the promote reads once" now checks again after a flush that no second read follows. Review 11's soft spot: the check inside waitFor passed at the first call.
- clearsOnPromote.test, "the Updates list: Couldn’t mark the updates as read … goes on the promote", now asserts no line and nothing registered.

#### The tracer (tests/personGatedCallers.ts), review 11 LOW-4

- A default import (`import post from …`) resolves through `export default`. That covers `export default function`, an arrow or function expression, an object literal, and a name that points to a top-level function or object. Any other default export is 'unknown', so it is listed. `export { a as default }` was already read with the other export lists.
- A wrapper whose body hands its parameter on to another of the trace's functions is followed there, five levels at most, then 'unknown'. If that function can't be read, the result is 'unknown'.
- A handed-on call that isn't returned counts as a direct send that isn't returned: unread, unless every failure throws.
- A callee that is a call to one of the trace's own (`usePost()(…)`) is 'unknown'.
- The real source's output is byte-identical before and after. I ran review 11's dump (zzR11Dump) with the old tracer and then the new one, against the same source snapshot in a copy with the backend linked (11,832 bytes each).
- tests/presenceRound14.traceForms.test.ts has P1, P1b, P1c (a name), P1d (unreadable), P3, P3b (a chain to an unreadable function) and P13, plus one control: a throwing wrapper chain still keeps. All seven probes fail on the old tracer and pass now.

#### The Commons hold window (LOW-5 C3 and C4; tests only, lib/commonsApi.ts unchanged)

- tests/presenceRound14.commonsHoldWindow.test.ts pins two cases where a Commons call reaches apiFetch with the stored token: before the socket's first answer (unconfirmed, not held), and 100 ms into a hold. Once the hold has lasted 150 ms the same call is held and the token stays. The desktop shell's 401 retry relies on both windows.

#### Lane C: Undo's line and the chat picker
#### Undo's line (review 11 NIT-1 and LOW-4)
- The key-added Undo no longer reads the page to find the Providers line. A small registry, `settings/groupLockLines.ts`, holds the Settings group lines by verb. ProvidersTab registers its line ("change provider settings", its lock id) in a layout effect while any provider row is listed, whether or not the tab is locked. SettingsNoticeBar reads it while rendering: when Undo's lock shows and a group line is registered, Undo points at it and renders no copy.
- On a demote both locks flip in the same render, so the decision comes from state before anything is committed, and the live region never gets the copy. `presenceRound14.undoLine` records every insert into the live region with a MutationObserver and fails on the round 13 code.
- I took the MutationObserver out instead of testing its guards. It existed only to find the group line in the DOM, and the registry replaces it. So LOW-4's test now pins the stronger property: nothing observes the Settings panel at all, promoted, locked, on the promote or after unmount. Run against the round 13 code, the test fails, and so do R15 and R16 applied to that code. R15 and R16 can't be applied to the new code, because the observer is gone.
- Tradeoff: registration happens in a layout effect. When a search brings the rows back while Undo is locked, there is one commit, before paint, where the group line is back and Undo's own copy hasn't gone yet. That copy was already in the live region, so nothing new enters it. Mounting the whole Settings panel already held with a notice up puts Undo's copy in for one commit, as the live region itself is being inserted. Screen readers don't announce content a region has when it's inserted.
- Edge case left: before the socket's first answer, each lock runs its own 150 ms first-moment timer. If Undo's line could show while the Providers line was still pending, Undo would point at a line that isn't drawn yet for under 150 ms. A notice only follows a key the person just added, so this isn't reachable in practice.

#### cssCascade.specificityOf (NIT-2)
- Not changed this round, as the brief said. #209 (fix/moodboard-board-layout at d1621291) carries the helper fix, and whichever PR merges second takes the other's version. No sheet under src/ uses the two edge forms.

#### The chat picker's line (GM r23 answer 6)
- The picker says "You can pick your agents when this tab is connected as you." directly under its heading ("Model & thinking", now `role="heading"` `aria-level=2`, so the placement rule can read it), through `usePersonLock('pick your agents')` and PersonLockLine with place 'heading'. The provider group (`role="group"`, "Chat provider") points at the line with aria-describedby while it shows. The picker doesn't use the words "personal agents" anywhere. It says "Your own agent", and Settings calls them "your agents" ("load your agents", "change your agents"), so the verb is GM's "pick your agents".
- The line follows the lock: held, demoted and stale-token tabs show it, a connected tab doesn't, and the promote takes it away. PersonLockLine renders through LineText, so it registers. No lineRegistration or clearsOnPromote entry was needed: it isn't a clears-on-promote site and no JSX text child was added.
- A decision beyond the brief: a held tab's picker also stops listing the person's agents (ChatPanel passes `agentsHeld` from usePersonView's settled `held`). Before, a demoted tab kept the agents it had read, so the line would have said "you can pick your agents when…" over a list of agents you could click. This matches Settings > Personal agents, where a demoted tab shows what a never-connected tab shows (GM r17 item 6 b). The trigger's label for a selected personal agent is unchanged, since it still reads the full list.
- Agents see nothing new: no route, gate, MCP tool, CLI or answer changed. The line exists only in the person-facing picker.

#### Offline comes first (GM r23 answer 3)
- Lane A made it the rule for every lock line inside usePersonLock: offline, `shown` is false, nothing points at the line, and the control carries `data-lock-line-held`. I first built a per-site wrapper, then took it out when I saw lane A's change: the wrapper also broke personLockSweep, whose lock trace reads only `const x = usePersonLock(...)`. So every lock line in Settings and the picker now follows lane A's rule with no code of mine at those sites.
- What I added is for the two held views' not-connected lines, which aren't lock lines: the shared `hooks/useOfflineFirstBecause.ts` hides them while offline (the builder folded lane C's `useOfflineFirstLine` into it), and now also the same sections' load lines refused as not the person.
- Places in my files where a not-connected line and the offline notice can both show, each now hidden offline and shown again back online while still not connected:
  1. The chat picker's line ("pick your agents"): lock line, lane A's rule.
  2. Settings > Providers group line, and the key-added Undo's own line ("change provider settings"): lock lines, lane A's rule.
  3. Settings > Providers > Krea Start a trial, Storage, Preferences (run cost), Agent spending, Connected apps (rows and Connect), Personal agents (rows and Add): lock lines, lane A's rule.
  4. Settings > Personal agents, the held view's line ("Nebula couldn’t load your agents because…"): useOfflineFirstBecause.
  5. Settings > Connected apps, the held view's line ("Nebula couldn’t load the connected apps because…"): useOfflineFirstBecause.
- Outside my files, for lane A's inventory: PersonalAgentWarning's "use your agents" line is a lock line, so lane A's rule already covers it.
- Tests: `presenceRound14.pickerLine` pins the picker's line, the Providers line (it hides, the rows stay aria-disabled, and nothing points at a missing id), and both held-view lines, offline and back online.

#### Offline first, the places outside the lanes' files (builder)
- The general notice (PersonRequiredBanner) steps out while offline and comes back online.
- Pins' Send line from the general notice (PinComposer `gateBanner`) waits while offline; its
  own lock line already follows usePersonLock.
- The held asset proposal's line (AssetProposalStrip) waits while offline (`useCanvasLock().offline`).
- The canvas notice region's undo slot, where error lines go (the refused style save, the refused
  graph save, every `notify` because line), hides a because line while offline
  (CanvasUndoNotice); the message slot never carries one.
- Inspector's favorite line and Projects' load line go through the shared helper.
- `lockPlacement`: a control whose line is held back on purpose (`data-lock-line-held`) is not
  flagged for a missing line; its look is still checked. `round22Surfaces` lists the four new
  files that read the backend's offline state directly (they edit nothing on the canvas).
- Left as they are: the held ask's lock reason in the Agents roster (a tooltip), the project
  save's Retry tooltip, and the chat transcript's system messages (entries, not status lines).
- Tests: `presenceRound14.offlineFirst` (the general notice, the undo slot with a because line
  and with another failure, and a source pin for the other places). Mutants caught: the banner,
  the undo slot, the helper passing through, the helper hiding every line, Pins, the strip.

#### The Commons 401 rule (builder; review 11 held-calls LOW-3)
- Covered under "A token the backend says is invalid is dropped" above: only the
  `invalid UI session token` answer drops the token.


#### Focus when offline hides a focused line (builder, found live)
- Going offline hides Add's line, which can hold focus after a demote. The handover ran only when
  the view changed, so focus fell to the page, and the promote no longer brought it back to the
  URL field. CommonsView now passes the offline state with the view as the handover's change, and
  a handed-over focus (a line or the heading standing in for a control) may move on at a later
  change: to the control once it is back, else to a line that came meanwhile. Focus the person
  moved elsewhere stays put.
- Tests: `presenceRound14.focusOffline` (the URL field through demote, offline, online and the
  promote: the line, the heading, the line, the field; and focus moved by the person stays).
  Mutants caught: the offline state left out of the change, no re-entry for a handed focus, the
  lost check ignoring it, the handed mark missing.

## Round 15 (CI on d2040a0f; GM r24)

#### The one-shift test no longer races the machine (CI on d2040a0f)
- `presenceRound14.commonsLock` "Add locks at once …" waited for the page line with waitFor's 1 s
  default on real time, while the product's own cap is 1.5 s; under CI load the line came late
  and the test failed. Raising the timeout would not have fixed it (past 1.5 s the product
  correctly shows Add's line alone, which the old test also rejected).
- The test now runs on fake time and holds the page's three loads (status, collections, search)
  in the API until it lets them answer, so it says when the because line is ready:
  - fast path: the loads answer at 1.4 s; both lines land in the same commit, and no commit
    showed Add's line without the page line above it;
  - slow path: no answer by 1.5 s; Add's line shows alone at exactly 1500 ms (not at 1499), and
    the page line joins above it when the loads answer. The commits read: nothing, Add's line,
    then both.
- The other Commons renders in round 14's tests (the offline Commons test, the New collection
  prompt tests, `usePersonLock` offline, and all of `presenceRound14.pageLine`) moved to fake time
  too, with an `until` that moves the clock 50 ms at a time up to a fixed bound, so no line's
  arrival depends on real time. `tokenDrop` (health answers driven by the test) and
  `offlineFirst` (no timer in the path) had no real-time race and are unchanged.
- Mutants caught: no hold (both paths), no cap (slow path), the cap at 1000 ms (both), `ready`
  ignored (fast path).
- Five runs in a row with four CPU burners beside them (load average 24 to 29), round 14's five
  timing files together: 56/56 each time.

#### a. A because line sends the general notice away under the prompt's backdrop (GM r24 a)
- Cause: the New collection prompt's backdrop (`.commons-prompt`: `position: fixed; inset: 0`,
  `rgba(0, 0, 0, 0.4)`) covers the whole window. The shared rule's hit test (`lineUncovered`)
  got the backdrop for every point of the page line, so the line read as covered, didn't count,
  and the general notice stayed. Held, demoted and stale-token states without the prompt were
  already right; the live check confirms 01's bottom (no notice).
- Fix, in the shared rule (lib/notConnectedLine `lineUncovered`): when the topmost element at a
  point isn't the line, it looks down the stack (`elementsFromPoint`) past layers the line shows
  through, and stops at the first one it doesn't. See-through: a background alpha under
  `SEE_THROUGH_ALPHA` (0.85), or `visibility: hidden`, with no background image, no backdrop
  blur, no text of its own and not a replaced element (img, video, canvas, svg, iframe, a form
  control). A browser with no `elementsFromPoint` keeps the topmost answer, as before. The
  Settings dock and any opaque or nearly opaque panel still cover a line (review 8 MEDIUM-2).
- Tests: `presenceRound15.noticeCover`: the rule's cases (the prompt's own backdrop with the
  rule read from commons.css, dims at 0.4 and 0.8, transparent, hidden; opaque and 0.85+;
  words, a picture, img/video/canvas, a blur; an opaque layer under a dim; a stack that never
  reaches the line; no `elementsFromPoint`), and the Commons with the general notice mounted:
  held, demoted, a stale token, and the prompt open at a demote all show no general notice; a
  control case with an opaque layer under the backdrop brings it back. On d2040a0f four fail,
  the prompt-open state among them. Mutants caught (12): always see-through, the threshold at
  1.01 and at 0.3, the text, replaced, image, blur and hidden checks removed, the stack's end
  counted, no-`elementsFromPoint` counted, an opaque layer skipped, the alpha not parsed.

#### b. No empty state where nothing was read (GM r24 b)
- Each list's empty state now shows only when its last read answered:
  - the references grid ("No matches. Drop images or videos here, or use Add." and the Inbox's
    "Nothing waiting in the inbox. …"): CommonsView keeps which tab the last search answered for
    (`answered.references`), cleared by a failed search and by a new view. A failed search shows
    only its line; offline, and back online before the search reads again, nothing claims the
    library is empty; the Inbox's empty state never stands on All's answer (found by the test:
    the switch showed it for the search's 250 ms debounce).
  - the Add to menu's "No collections" option: only after the collections answered with none.
  - Settings' "No folders linked. …" and "No new terms proposed yet.": only after the settings
    load answered (before it, too, nothing was read).
- A held tab already showed no grid empty state (round 11); it now shows no "No collections"
  either (its collections read is refused).
- Left as they are: CommonsDetail's "Loading…" is not an empty state. (Corrected in round 17:
  this said CommonsReview and CommonsEvaluation showed no empty state on a failure. They did:
  "Prepare the reference set in Blind labeling first." with "0 / 15 reviewed", and the held-out
  set form, since their `batch` was null after a failed load too. Review 13 MEDIUM-1; fixed in
  round 17.)
- Tests: `presenceRound15.emptyState` (a failed search, a real empty search, the Inbox, a failed
  refresh after an answer, offline then online before the search answers, collections failed /
  read and empty / read then failed on the reconnect, a held tab, Settings failed / before the
  read / read and empty). On d2040a0f eight of eleven fail. Mutants caught: the option ungated,
  folders and terms ungated, Settings counted as loaded from the start, any tab's answer counting,
  a failed search or collections read not clearing the answer.

#### c. "because it didn’t respond" for the Commons loads (GM r24 c)
- `noResponseBecause(what)` in lib/errorCopy: "Nebula couldn’t {what} because it didn’t respond.
  Try again." (curly apostrophes). `useCommonsLoadLines` uses it when a load's reason is the
  no-answer reason (a 5xx, 408 or 429 with no reason: NO_RESPONSE_COPY), so each is one sentence
  with Nebula the subject. The lines:
  - references: "Nebula couldn’t load the references because it didn’t respond. Try again."
    (GM's words, verbatim)
  - status: "Nebula couldn’t check the Commons status because it didn’t respond. Try again."
  - collections: "Nebula couldn’t load the collections because it didn’t respond. Try again."
  - the page line (every load failing for that reason): "Nebula couldn’t load the Commons because
    it didn’t respond. Try again."
- Another reason (the backend's own words, a refusal) keeps the heading form ("Couldn’t load the
  references. {reason}").
- HAND_BUILT (tests/lib/errorCopy.namedLine) and the copy ratchets had no entry quoting the old
  Commons load lines; they pass unchanged. `presenceRound14.pageLine` now pins the new lines
  verbatim (three fail on d2040a0f); the live harness's 02 check reads the new line.
- The panes' own loads were left for GM here; GM r25 answered (below, 2c).

#### Section 0 and the chunk-aa failures (round 15 leftovers)
- The three files that failed in round 15's first union chunk (`App.commonsLifecycle`,
  `agentPresenceFollowups.ratchet`, `CommonsDetail.test`) pass alone, 59 of 59, on the worktree
  with section 1's changes. They failed at a load average of 41 to 44 (a button not found in
  time, a 120 s limit, a group not found in time), so they were load; no base run was needed.
- Review 12 NIT-2 is section 0's one-shift test: it runs on fake time with the loads held, so
  it no longer depends on the machine.

#### 2a.1 A new link taken while the old hello is answered keeps the new token (review 12 MEDIUM-1)
- Cause: a canvas socket can carry two hellos. A link taken in an open, unpromoted tab says hello
  again on the same socket, and the server answers hellos in order, one answer each. `wsClient`
  kept one token per socket (the newest), so the refusal of the old hello was read against the
  new token, which is the tab's, and the drop rule forgot it. Round 14's regression, inside
  Justin's token drop.
- Fix, inside `wsClient`'s per-hello bookkeeping only: `helloTokens` is
  `WeakMap<WebSocket, string[]>`, one entry per hello, pushed when the hello is sent. A
  `personRequired` takes the oldest entry (`shift()`) and passes only that token to
  `dropRefusedPersonToken`; the promote's `proposalSync` takes its hello's entry too. The drop
  rule, the gate and every read boundary are unchanged.
- Why not close and reconnect on every new link: it would also work (one hello per socket), but
  it tears down a live socket and its graph sync for every link opened, and it moves the problem
  to the close and reopen ordering. Keeping the server's own one-answer-per-hello contract in
  the client is the smaller change and keeps today's reconnect paths as they are.
- The backend sends `proposalSync` only on a verified hello (`main.py` websocket loop), and
  ignores hellos on a socket it already promoted, so no other message consumes an entry.
- Tests: `presenceRound15.tokenRace`: the reviewer's R1 (the old hello refused, then the new one
  promoted: the new token is stored and held, one promote); two hellos both refused (the second
  refusal drops the second token); a promote then a refusal (the refusal names the second
  hello's token: a pin on the bookkeeping, since today's backend never answers a promoted
  socket again); a refusal with no hello waiting drops nothing. On d2040a0f three fail, R1
  among them. Mutants caught: the refusal takes the newest (`pop`), the promote takes no entry,
  one entry per socket (overwrite), the refusal reads without taking (`[0]`).
- Live (8795/5795): our own backend paused with SIGSTOP, a stale link then the real link taken
  in the open canvas tab, then resumed. The tab keeps the real token, is promoted and not held,
  shows no general notice, and its next person-only reads (Settings, Agents) are answered
  (shot 10). (Corrected in round 17: this said the two-hellos-on-one-socket order couldn't be
  staged live. It can, and the fix holds: review 13 ran it on 8951/5951, where the canvas socket
  is `ws://127.0.0.1:8951/ws`, direct to the backend. With the backend paused, a tab took a stale
  link and then the real one, and in 3 of 3 trials the one socket carried a hello with the stale
  token, a hello with the real one, `personRequired`, then `proposalSync`. The tab kept the real
  token, was promoted and not held, and the other tab was untouched. My run's socket went through
  Vite's proxy; the review's guess is that my tab opened without a link first. Either way it was
  my setup, not a limit of the app.) The
  unit test (the reviewer's R1) pins the order too.

#### 2a.2 Focus never lands on a look-alike in the same pane (review 12 MEDIUM-1)
- Cause: each membership in an open reference is an unlabelled section, so the second
  membership's Role select and Why field had the same key as the first's; the promote remounts
  both, and the handover took the first new match. An arrow key then changed the wrong
  collection's role, a person write.
- Fix, structural (`hooks/useFocusHandover`): the snapshot records how many of the scope's
  elements share the control's key and which one (document order) it was. Coming back, the
  hook takes the element at that place only if the count is the same, it is new, and it isn't
  disabled; otherwise it goes to the line (then the heading). It never takes the first match.
  A handed-over focus keeps the ordinal and count. Locally, each Membership section carries
  `data-focus-scope={membership.id}`, so the two are two panes anyway.
- Tests: `presenceRound15.twoMemberships`: the hook alone (three look-alikes in one pane, each
  comes back to itself; a direct remount; a changed count goes to the line, or to the heading
  with no line; a look-alike that stayed sits at the lost control's place, so focus goes to the
  line), and the reviewer's probe in the real CommonsView (one reference in Refs and Moodboard,
  the second's Role and Why come back to Moodboard). On d2040a0f seven fail. Mutants caught:
  the count not checked, the first look-alike taken, no scope on Membership, the "new" check
  removed, a handed-over focus losing its ordinal.
- Live: two collections and one image uploaded to both in the isolated backend (the person's
  tab, no model call: the call budget is 0 and no key exists), the reference opened, focus on
  Moodboard's Role, demote, promote: focus is on Moodboard's Role again. Shots 11 and 11b.

#### 2b Review 12 LOW and NIT
- TD LOW-1, as built. Justin's call: keep until the next refusal or reload. A refusal that
  arrives while the tab's last health answer says offline keeps the token, and a later online
  answer doesn't drop it; the next refusal with online answered does. After a restart this keeps
  the old token until the socket reconnects or the tab reloads with an online first probe (5 of
  12 restarts live in review 12). It never drops while Nebula is starting. Pinned by
  `presenceRound15.tokenRace` "after a restart".
- TD LOW-2: the Commons drop's comparison is pinned (the 401 for the old token after a new link
  was taken keeps the new one). Mutant D12 (the current token in place of the sent one) is
  caught.
- TD NIT-1: the body and the notes say each tab's token is its own, a duplicated tab copies it
  once, and MEDIUM-1's exception is closed.
- CL LOW-1, offline first for every because line: one rule in `components/LineText` instead of
  call sites. While Nebula is offline a because line renders no words; with no `className` the
  surface's element is hidden too when the line is all it holds (no empty alert box), and with
  one its span is hidden. A surface the screen already hid stays hidden. Back online the line
  shows again if it still applies. Every surface that draws a not-connected line goes through
  LineText (the line-registration ratchet), so this covers the places review 12 found unfiltered:
  the Updates list's dismiss and corner lines, Settings writes (Preferences' cost line, the
  providers' key lines), Connected apps, Trash, Pins add/remove, the canvas and asset proposal
  decide lines, the questions form, CreateComposer, KreaSignInRow, PersonalAgentWarning and the
  asset studio draft. `useOfflineFirstBecause` stays where it was (the Commons, Inspector's
  favorite, Settings' held views, the canvas undo slot); applying both is harmless.
  Tests: `presenceRound15.offlineLines` (alone in its surface, beside other content, with a
  className, a surface already hidden, another failure line kept, and the reviewer's Updates
  probe). On d2040a0f four fail. Mutants caught, 7 of 7.
- CL LOW-2, replaced by GM r25 1 (2c below).
- CL NIT-3: shot 04 is now a filmstrip of the demote (CDP screencast frames: before, the first
  frame with the lines, +200 ms, +600 ms, settled), with the rAF row log beside it in the live
  log.
- CL NIT-5, two ratchet blind spots closed in `presenceRound15.ratchetGaps`:
  - in a function that retries on the promote, every line variable worded from a failure
    (`line`, `page`, `…Line`) must branch on `isPersonRefusal` to the because form. Round 6's
    rule passed a block when one line had it, so a load's own line could lose it beside the page
    line (mutant X21); the new rule catches X21 in the real hook;
  - `pageLoadLines` is used only by `useCommonsLine.ts`, so no screen draws its own words
    through it.
- CL NIT-6: curly apostrophes in the five headings this PR wrote that render as written ("Couldn’t
  mark the notes read.", "Couldn’t dismiss the note.", "Couldn’t update the note.", "Couldn’t
  update the connected apps.", "Couldn’t update your agents."), pinned. Left for the wording
  batch: the headings this PR only moved whose words are also a request heading in
  `lib/api.ts` (main, straight), since the request's heading is what renders and a partial
  change would mix spellings and rewrite about 30 tests; and `NO_RESPONSE_COPY` ("Nebula didn't
  respond. Try again."), used across the app.

#### 2c GM r25
1. A load's own line waits like Add's. `useCommonsLoadLines` now knows which loads are on
   their way (`start(load)`, called by CommonsView when each load is sent: the collections, each
   status poll, the search from its debounce's start). A failed load's line waits until the
   page's other loads sent meanwhile have answered or failed, capped at `LOAD_LINE_HOLD_MS`
   (1.5 s, equal to `ADD_LINE_HOLD_MS`, pinned). So a connected tab whose loads fail for one
   reason shows one line, the page line, in one change; past the cap the first load's line shows
   alone, then the page line replaces it. A not-connected page line never waits (Add's line
   waits on it). Once shown, lines stay while any load still fails (a later poll on its way
   doesn't hide them), and the hold starts again after they have gone. A failed load sent again
   (the next status poll) isn't one the others wait for.
   Tests: `presenceRound15.loadHold`, deterministic (fake time, each load answers only when the
   test releases it): fast path (one change, the page line), slow path (nothing at 1499 ms after
   the first failure, the status line at 1500, then the page line), one failure with the others
   answering, a failure with nothing on its way (at once), a shown line kept through a poll, and
   the hook alone (a person line never waits, the hold re-arms, a load cleared by the promote is
   no longer on its way, a failed load sent again). Mutants caught, 8 of 8: no hold, no cap,
   the cap at 1000 ms, the person line held, the hold never re-arming, a failed load sent again
   holding itself, the search never said sent, a failure not settling its load.
2. The connected page line was already "Nebula couldn’t load the Commons because it didn’t
   respond. Try again." (section 1 c); `presenceRound14.pageLine` pins it.
3. and 4. Confirmed as built (r24 a and b).
5. The pane loads take the same form. In `useCommonsLine.show`, a load (`{ reload: true }`) is
   named by the pane's own words, whichever of its requests failed, and no answer (a 5xx, 408 or
   429 with no reason) is the because form:
   - Agent review: "Nebula couldn’t load Agent review because it didn’t respond. Try again."
   - reference detail: "Nebula couldn’t load this reference because it didn’t respond. Try again."
     (CommonsDetail's heading is now "Couldn’t load this reference.", as the media and review
     image loads already said)
   - Blind labeling: "Nebula couldn’t load Blind labeling because it didn’t respond. Try again."
   - Commons Settings: "Nebula couldn’t load the Commons settings because it didn’t respond. Try
     again." (it reads three requests; before, whichever failed first named the line)
   - The not-connected form of these lines uses the same words ("Nebula couldn’t load the
     Commons settings because this tab isn’t connected as you. …").
   - Any other cause: a refusal with the backend's own reason keeps the heading form ("Couldn’t
     load Agent review. The review set is closed."), pinned. A lost connection ("Nebula's server
     isn't answering. …") has no because clause yet; GM's "any other cause gets its own because
     clause" needs words for it, so it is a question for GM rather than words I made up.
   - HAND_BUILT and the copy ratchets quote none of these lines; `noResponseBecause` is a helper,
     not a hand-built line. Tests: `presenceRound15.paneLoads` pins each line verbatim (Agent
     review at 503, 500, 408 and 429; Settings for each of its three reads). Mutants caught: the
     request's words over the pane's, no because form for a pane, the detail's old heading.

#### Round 15 gates (sections 1 and 2)
- tsc and eslint clean; `check:inline-styles` and `check:slava-css-scope` pass. `vite build`
  passes; the build budget passes at 458,677 bytes raw (512,000 allowed).
- Focused vitest on two workers, 79 files (round 14 and 15 tests, the Commons tests, the tests
  that pair offline with a because line, the ratchets reading `src/` and `styles/`): 1,139 of
  1,139, Errors 0. Per the round's gate rule no full union and no backend run (no backend file
  changed).
- Live (8795/5795, the backend only through the shared guarded launcher, canaries first):
  section 2's run 9 of 10 plus a membership-only rerun 6 of 6; the one miss is the two-hellos
  staging explained in 2a.1. Shots 04 (filmstrip), 10, 11 and 11b; `md5 | uniq -d` empty.

## Round 16 (CI on 4b21f101; GM r26; base 4b21f101)

### LineText takes offline first from the one rule (CI)
- `tests/round22Surfaces` failed on 4b21f101: round 15's offline-first rule in `LineText` called
  `useBackendOffline()` itself, and that ratchet allows only listed surfaces to read offline on
  their own. Its round 15 file list missed this ratchet, which reads `src/` from disk.
- Fix: `LineText` asks `hooks/useOfflineFirstBecause` (null for a because line while offline), the
  single offline-first rule that was already on the allowlist, and hides when it says null. So
  every line takes the one rule, through LineText or directly for the state a screen keeps, and
  `OFFLINE_ONLY` is unchanged. Rules of hooks: the hook is called on every render, before the
  check on `words`.
- `presenceRound15.offlineLines` still pins the behaviour; mutants (never hides, hides every
  line) are caught through the hook.

### "Searching…" goes with the because line (GM r26)
- On the demote's filmstrip, "Searching…" stayed in the results for about 200 ms after the page's
  because line landed: status and collections are refused at once, while the search still waits
  for its 250 ms debounce. A search can't succeed in that state.
- CommonsView passes the grid `loading` only while no because line is in the page's lines, so it
  clears in the same render as the line.
- Test: `presenceRound16.searching` (section 0's harness, fake time): a demote, 10 ms at a time;
  the new view shows "Searching…" before the line, and no commit shows the page line with it; a
  connected tab still shows "Searching…" while its search is out. The first fails on 4b21f101
  (one commit with both); "Searching…" never shown is caught by the second.
- Shot 04's filmstrip retaken: "Searching…" in the frames before, gone in the frame the lines land.

### The `key.split is not a function` logs (not this PR)
- CI's "A deferred part of the app failed while drawing. TypeError: key.split is not a function"
  (`components/canvas/AgentNodeMarkLayer.tsx` `useBoxes`) comes from `tests/Canvas.fileDrop.test.tsx`,
  whose `@xyflow/react` mock has `useStore: () => 1`, so `useBoxes` gets a number. Main's CI on
  1944d052 logs the same (60 lines); neither file changed in this PR. Left for its owner: the mock
  should run the selector over a fake state.

### Round 16 gates
- tsc and eslint clean; `check:inline-styles` and `check:slava-css-scope` pass.
- vitest on two workers: `round22Surfaces`, every test under `frontend/tests` and `src` that
  reads files from disk (`readFileSync`/`readdirSync`), the round 15 and 16 tests and the Commons
  tests: 127 files, 1,828 of 1,828, Errors 0.
- Live (8795/5795, guarded launcher, canaries first; `blocked.log` only canary lines): the row
  changes once on the demote; the filmstrip retaken.

## Round 17 (review 13 on 146a05e8; GM r27)

### Agent review and Blind labeling after a failed load (review 13 MEDIUM-1, GM r27 1)
- Both panes kept `batch` null after a failed load as well as after a read that answered "no
  batch", so a failure showed "Prepare the reference set in Blind labeling first." with
  "0 / 15 reviewed · 0 grades ready", and Blind labeling showed the whole held-out set form.
  Nothing had been read, and the form invited a second batch the backend would refuse.
- Each pane now keeps `answered`, set only when a read resolves (`api.get()`, the return-from-
  section read, and in Blind labeling any batch the pane is handed, a finished scan included).
  Until then, after a failure, the pane shows its eyebrow, its heading (title and intro) and the
  failure line, nothing else: no counts, no Generate, no footer, no setup form (GM r27 1). A
  panel that takes up a running scan starts answered: the scan came from a form shown after a
  read that answered no batch.
- Once a read has answered, a later failed poll keeps what that read showed, with the line.
- Tests in `presenceRound15.emptyState` (the real panes): a failed load leaves only the header
  and the line; an answered null shows the setup state and the counts; failed, then the next
  poll answers, and the setup state comes then.

### The comment field stays its membership's (review 13 token-focus LOW-1)
- A membership's comment field sits in its thread, `aria-label="Comments in <collection>"`,
  which was the nearest pane and shadowed the membership's `data-focus-scope`. Two manual
  collections may share a name, so two memberships' comment fields were look-alikes told apart
  only by their place: a same-count reorder while demoted (m1 gone, m3 "Refs" after m2) handed
  m2's field to m3's, where Enter posts to the wrong collection.
- Structural fix in `useFocusHandover` `paneOf`: the pane is its nearest scope or labelled
  region, led by every `data-focus-scope` above it (`m2 › Comments in Refs`). Only explicit
  scopes join the chain (ids, stable across a remount), not every labelled ancestor, so a
  region's changing label can't break a match.
- Tests in `presenceRound15.twoMemberships` (the real CommonsView, review 13's probes P1, P2,
  P5, P3 as tests): nothing changed, the same-count reorder, a same-named membership inserted
  before (now back in m2 rather than at the heading), and m2 gone.

### A cancelled search no longer holds later lines (review 13 commons-lines LOW-1)
- A search cancelled before it answered (the person went to Settings, Blind labeling or Agent
  review, which search nothing) stayed "on its way", so every later Commons failure waited the
  full 1.5 s.
- `useCommonsLoadLines` returns `abandon(load)`; the search, collections and status effects call
  it in their cleanup. A load re-sent by the next run of the effect is started again in the same
  commit, so it is still waited for.
- Tests in `presenceRound15.loadHold`: Inbox then Settings 50 ms later (inside the debounce)
  and after the search answered, then a failed status poll: the line shows at once in both; the
  hook alone; abandon then start in one commit still holds.

### The general notice waits for the because line on a demote (review 13 LOW-2, GM r27 2)
- Live, the notice slid in about 140 ms before the Commons' page line, then out.
- `lib/notConnectedLine` gains `expectBecauseLine()`: a screen whose demote brings its own
  because line says so while it is up. The Commons does, from mount. `PersonRequiredBanner`
  holds the notice's entrance while one is expected, until a line it can count is up or
  `BECAUSE_LINE_WAIT_MS` (1500, Add's hold) passes. When the line lands within the cap the
  notice never shows. Only the entrance waits: a notice already up stays, one coming back when a
  line goes isn't held, and if the Commons closes during the wait the notice enters then.
  Nothing is announced while it waits.
- Live caught a bug the first build had: the wait was decided by a render-phase state update,
  and `useLeave` had already queued the notice in the pass before it, so the notice mounted at
  once in its leave (drawn at full opacity, then fading out at about 210 ms). jsdom runs no
  leave animation, so the element was gone before any test frame read it. The wait is now
  decided in the same pass, and the frame test also records any notice mounted at all
  (a MutationObserver with `takeRecords`). The first build fails it.
- Tests in `presenceRound15.noticeCover`, 10 ms frames from the demote: no frame shows the
  notice (also with the prompt open); with the line covered by an opaque layer the notice enters
  at the cap and not before; no Commons, at once; Commons closed mid-wait, at once; a notice
  already up isn't taken away. The round 15 control test now waits out the cap.
  `agentPresenceFollowups.r7`'s leave ratchet reads the new `useLeave` line.

### See-through below 0.6 (GM r27 3)
- `SEE_THROUGH_ALPHA` is 0.6 (was 0.85). The prompt (0.4) and a dialog's dim (0.45) still let the
  line count beneath them; the mask painter's overlay (0.72, read from mask-painter.css) and an
  0.8 toast now cover it. Tests pin 0.4, 0.45, `45%`, 0.59 as see-through and 0.6, 0.72, 0.8 as
  covers.

### No empty toast offline (review 13 LOW-3)
- The pin toast and Settings' notice bar wrap their line in a span beside a control (× or Undo),
  so LineText's offline-first hide left an empty box. Both now ask `useOfflineFirstBecause` for
  the line before they show: offline the toast or bar isn't there at all (the pin toast goes at
  once, not through a leave that would draw it empty); back online it is, if the line still
  applies. Another failure line keeps its toast offline.
- Tests in `presenceRound15.offlineLines`: both surfaces, offline and back, no leave drawn, the
  non-because cases, and a sweep: every `<span><LineText` wrapper in src (these two) asks the
  rule itself.

### NITs
- Review 13 NIT-1 (token-focus): the Round 15 note and the PR body said the two-hellos order
  couldn't be staged live. Corrected in both: review 13 staged it (3 of 3) and the fix holds.
- NIT-2 (token-focus): `studioGridAreas` matches each child's class as a whole token; renaming
  the row's `commons-messages` now fails (it passed through `commons-messages__lock-line`).
- NIT-3 (token-focus): `presenceRound15.paneLoads` runs on fake time with a bounded `until`.
- NIT-1 (commons-lines, mutant M26): `presenceRound16.searching` adds a connected tab whose status
  got no answer while its search is out: "Searching…" stays.
- NIT-2 (commons-lines, review 12 NIT-4): `tests/helpers/cssCascade.ts` `specificityOf`, checked
  by hand against Selectors Level 4 section 16: the one-colon pseudo-elements (`:before`, `:after`,
  `:first-line`, `:first-letter`) count as types, and `:nth-child`/`:nth-last-child(An+B of S)` add
  S's most specific selector to the pseudo-class. `a:before` (0,0,2), `li:nth-child(2 of .x, #y)`
  (1,1,1), `li:nth-last-child(odd of .a.b)` (0,3,1), pinned in `studioGridAreas`.
- NIT-3 (commons-lines, first load): `lib/lineAttrs.ts` holds `FOCUS_LINE_ATTR`,
  `FOCUS_SCOPE_ATTR`, `PAGE_LINES_ATTR`, `LOCK_PLACE_ATTR` and `LockPlace`. PersonLock, LineBox,
  CommonsErrorLine and CommonsPageLines import them from there, so `hooks/useFocusHandover` and
  `lib/lockPlacement` leave the entry chunk (both modules re-export them). A ratchet in
  `presenceRound15.ratchetGaps` keeps it. Entry, same tree before and after the move: 459,301 B
  raw, 456,484 B after (-2,817 B; gzip -9 141,144 to 140,192). The final build's budget check:
  456,457 B raw / 140,725 B gzip, against CI's 458,625 / 141,501 on 146a05e8.

### Round 17 gates
- tsc and eslint clean; `check:inline-styles` and `check:slava-css-scope` pass.
- vitest on two workers, an explicit zsh array of 291 files (checked non-empty): every test under
  `tests` and `src` that reads files from disk, all presenceRound files, the ratchets, the Commons,
  focus, notice, settings, pin, offline, wsClient, personSession, errorCopy and failureLines
  tests, and every test that names a file this round changed.
  - Run 1: 290 of 291 files, 3,428 of 3,429. The one failure was `agentPresenceFollowups.r7`'s
    leave ratchet, which pins the banner's `useLeave` line; updated for the wait.
  - Run 2, the final tree: 291 of 291 files, 3,431 of 3,431, Errors 0, no timeouts.
- `npm run build` with the budget check: 456,457 B raw / 140,725 B gzip.
- Mutations (an rsync copy, each mutant against the files that cover it): 26 run, 25 killed. The
  one survivor is equivalent: the notice's first-pass wait without `expected` is undone in the
  next render, in the same commit. Killed: the panes' `answered` gate (4), the pane chain, the
  search's abandon (2), the threshold at 0.85, at 0.5 and as `<=`, the notice never waiting,
  the cap at 3000, no cap timer, the Commons never expecting, waiting on after the Commons closes,
  waiting on a change of words, the first build's late decision, the pin toast and the Settings bar
  ungated, the pin toast leaving through an animation, the row class renamed, M26, both
  specificity forms, and LineBox back on useFocusHandover.
- Live (8951/5951; backend only through `harness/serve_isolated.py` with the person token on
  stdin, temp roots, call budget 0, no key; CDP blocks 8000-8010, 5173, 8840, 5840; Fetch
  interception fails every other host, with a dead proxy behind; canaries refused first and
  `blocked.log` holds only canary lines): 22 of 23.
  - Both panes at a 500: the header and the line only (no counts, footer or form).
  - Demote, 3 trials: the because line at 177-188 ms, no frame shows the general notice; the
    prompt open at a demote, the same.
  - The cancelled search: a later status failure on Settings shows 52 ms (cancelled) and 99 ms
    (answered) after it is sent, not 1.5 s.
  - The pin toast: shown online, absent for 2 s of 100 ms samples offline, back online.
  - The one failure is the harness's held-tab prompt check: on a never-connected tab
    "New collection…" is disabled, so the prompt can't open there (review 13 said the same);
    the demote case covers it.
  - Shots at 1440 in the scratchpad (`fu3r/shots`), md5 `uniq -d` empty, each one opened.

## Round 18 (GM r28; base 7377ccf4)

GM's three fixes; with them the PR is signed off on design.

### 1. "Nebula couldn’t load …" lines are neutral
- Only a load says a line in `noResponseBecause`'s form ("Nebula couldn’t X because it didn’t
  respond. Try again."). `errorCopy.isNoResponseLine` reads that form; `CommonsErrorLine` marks
  such a line's box `data-line-neutral` (never for a person-only reason line).
- `styles/becauseLine.css` adds `[data-line-neutral]` to the token swap and the sans face, not
  to the box rule: the because line's own element resolves its rule to `currentColor`
  (ink-light), and the box rule would have made it edge-strong. Same look, checked by resolving
  both through the app's sheets.
- One component for every such line: the reference detail drew its failure as bare
  `.commons-empty` text, and the review and labeling reference images and `CommonsMedia` as bare
  LineText or text. All now go through `CommonsErrorLine` (`as="span"` in a media tile).
- A failure with a reason the backend wrote ("Couldn’t load Agent review. The review set is
  closed.") keeps the error look; it isn't in the no-answer form.
- `tests/helpers/cssCascade.ts`: `data-line-neutral` joins `data-line-because` as a line mark,
  not a control state, in the loose cascade. Without it the ratchet's pin-edge corpus read the
  because sheet's sans face as the edge's own font.

### 2. Toasts keep clear of side panels
- The fix is in the notice region (every toast), not the pin toast. `lib/noticeSides.ts`
  measures the open side panels (dock drawers, Chat, the Inspector panel, Agent notes) where they
  reach the toast band, skips a panel on its way out, and writes `--notice-left-clearance` /
  `--notice-right-clearance` on the region. It watches (MutationObserver, ResizeObserver,
  resize, animation and transition ends, one rAF) only while a slot holds a notice; the first
  measure lands without a transition.
- `styles/noticeRegion.css`: the region stays symmetric about the window centre while a 420 px
  slot (`--notice-centred-min-w`) fits between the panels, then narrows into the free space. At
  first the threshold was the 560 px cap, which moved the toast 38 px off centre with Settings
  open although it fitted.
- `pr198Fix7Ui`'s regex pinned the old `right:`; it now pins `--notice-r` and the new `right`.

### 3. The Commons header holds its place
- Not connected, the status keeps an empty slot the size of "Stopped / Start"
  (`commons-status--held`, `visibility: hidden`, `aria-hidden`, nothing focusable). Nothing was
  read, so a visible "Stopped" would be a claim.
- The "Add to" select shows "No collections" when held and is in the person-lock disabled look
  (`addLine.control()`). `presenceRound11.demote` and `presenceRound15.emptyState` asserted the
  earlier rules and are updated.

### Gates
- tsc and eslint clean; check:inline-styles and check:slava-css-scope pass.
- vitest on two workers, an explicit zsh array of 312 files (every test that reads `src/` or
  `styles/` from disk, all presence rounds, the ratchets, Commons, focus, notice, settings, pin,
  offline, wsClient, personSession, errorCopy and failureLines tests, and every test naming a file
  this round changed). Run 1: 310 of 312 (the pin-edge corpus and the region regex above). Final
  tree: 312 of 312, 4,145 of 4,145, Errors 0.
- `npm run build` with the budget check: 458,384 B raw / 141,241 B gzip (from 456,457; the
  watcher is in the entry with the region).
- Mutations (rsync copy): 21 run, 21 killed. Lines: the sheet selector, never marked, the form
  never read, every failure marked, the detail, the review image and the media back to bare text
  (the media one first survived; `presenceRound18.mediaLine` added). Region: left as before,
  right not symmetric, left panels ignored, the band check, exiting panels counted, never
  watching, the region not running it, the 560 threshold, the log ignored. Header: the slot
  dropped, the slot visible, no "No collections", the select unlocked, a real Start in the slot.
- Live (8951/5951, backend only through `harness/serve_isolated.py` with the person token on
  stdin; canaries first; `blocked.log` holds only canary lines): 25 of 25.
  - Lines: Agent review, Blind labeling, Commons settings and the page line at
    rgba(255,255,255,0.55) ink and rule, the because line's look.
  - Headers: tab x the same connected, not connected and never connected (All 399.7, Inbox
    437.8, Agent review 493, Blind labeling 591.3, Settings 691.1); the select at 817.7 and Add
    at 956.7 in both.
  - Toast at 1440: 510..930, y 772..820, centre 720 over the bar's 720 with nothing open, Nodes
    (panel 70..416; region 424..1016), Assets, History, Settings (panel 70..470; region
    478..962), Chat (1050..1424; region 399..1041) and the Agent log open. No overlap in any.
  - Shots at 1440 in the scratchpad (`fu3r/shots-r18`), md5 `uniq -d` empty, opened.

## Round 18b (GM r29; CI on d3c9e79e; base d3c9e79e)

### 1. A failed settings read shows no form
- Commons settings rendered its whole form under a failed read: the Folder path field and Link
  folder, the Meter's empty fields and Save, Re-analyze stale, Import moodboards, Export zip. Now,
  until the read answers (or after it failed), it renders only its heading and the line, as Agent
  review and Blind labeling do. `loaded` was already set only by a read that answered; the empty
  states' own `loaded &&` checks went with it.
- Before the read answers the pane is the heading alone, as the panes are; it was the empty form.
- The other Commons surfaces with fields or actions, checked:
  - The reference detail: a failed read already shows only Close and the line (now pinned in
    `paneLoads`). A failed re-read after a write keeps the reference that was read.
  - The search and filters: they are the read itself (BAD_FILTERS tells the person to clear them),
    nothing writes over what wasn't read.
  - The collections: after a failed collections read the Add to select has no rows and
    "New collection…"; Add asks for a target ("Pick or create a collection first."), so nothing is
    written over unread values. Not changed; listed for GM (the select's wording when the
    collections didn't load is copy).
- Tests: `presenceRound15.paneLoads` (no button, input, select, textarea, form or fieldset in the
  pane while any of its three reads failed, and none before the read answers; the form once it
  does). `commonsDrafts` waits for the form.

### 2. Every load line is the because form, neutral
- `errorCopy.loadFailedLine(what, reason)`: no answer is `noResponseBecause`; a reason in
  `LOAD_BECAUSE` reads "Nebula couldn’t X because <clause>"; any other reason "Nebula couldn’t X."
  and the reason as it is (through `headedLine`). The panes' loads (`useCommonsLine` with
  `reload`) and the page's (`useCommonsLoadLines`, the line and the page line) use it.
- `isLoadLine` (was `isNoResponseLine`): a line that starts "Nebula couldn’t load " or
  "Nebula couldn’t check " is a load's, whatever its reason; CommonsErrorLine marks it neutral. An
  action's line ("Couldn’t save the settings. …") keeps the error look.
- Every reason a Commons load can get, read from `backend/routes/commons.py` (GET status,
  collections, assets/{id}, blobs, folders, settings, vocabulary/candidates, evaluation,
  evaluation/items/{n}/image, review; POST search), and how it reads now (X is the load's words):

  | Reason (code) | Where | Line |
  |---|---|---|
  | No answer: 5xx, 408, 429 | any | Nebula couldn’t X because it didn’t respond. Try again. |
  | Not connected as you (403 `person_required`) | any | Nebula couldn’t X because this tab isn’t connected as you. Open the link Nebula printed when it started. (as before) |
  | 404 "That reference isn't there anymore. Reload to get the latest references." | reference detail | Nebula couldn’t load this reference because it isn’t there anymore. Reload to get the latest references. |
  | 409 "That reference isn't in this held-out set. Reload to get the latest references." | a labeling image | Nebula couldn’t load this reference because it isn’t in this held-out set. Reload to get the latest references. |
  | 422 "Those filters didn't work. Clear them and try again." | the references (search) | Nebula couldn’t load the references because those filters didn’t work. Clear them and try again. |
  | 401/403 with no reason ("You don't have access to this anymore. Reload to sign in again.") | any | Nebula couldn’t X because you don’t have access to this anymore. Reload to sign in again. |

  "Try again." stays only where it can help (no answer; filters the person can clear).

- **For GM's wording batch** (no clause that reads well; each says "Nebula couldn’t X." and the
  backend's message as it is, neutral):

  | Reason (code) | Where | Line now |
  |---|---|---|
  | 404 "Commons is disabled" | every load, when the Commons is off | Nebula couldn’t X. Commons is disabled |
  | 404 "not found" | a reference's image or video (blobs) | Nebula couldn’t load this reference. not found |
  | 401 "no UI session: open Nebula from the desktop app or use the dev link" | any | Nebula couldn’t X. no UI session: … |
  | 401 "invalid UI session token" | any | Nebula couldn’t X. invalid UI session token |
  | 403 "only the human UI session can do this" | folders, settings, candidates, evaluation, review | Nebula couldn’t X. only the human UI session can do this |
  | 4xx with no readable reason (FastAPI field errors): "Try again, or reload if it keeps happening." | any | Nebula couldn’t X. Try again, or reload if it keeps happening. |
  | No answer at all (ConnectionLost): "Nebula's server isn't answering. Make sure it's running, then try again." | any, when not already offline | Nebula couldn’t X. Nebula's server isn't answering. Make sure it's running, then try again. |

  GM's example, "the review set is closed", isn't a load's reason: the backend says
  "This held-out set is closed, so the agent can't grade it again." only for a grade request
  (review/propose), an action. The tests use it as an unmapped reason.

### 3. The header slot
- Unchanged, as GM ruled: empty and hidden.

### CI on d3c9e79e: `presenceRound14.pickerLine`, "a stored token the backend no longer takes"
- Not round 18: the test renders only the picker (no notice region, no side panels).
- Cause, a race in `lib/personSession`: the held rule's settle timer told the views once, after
  150 ms, and the views read `personHeldSettled()`, which measures with Date.now. A Node timer can
  fire up to a millisecond before Date.now shows its full delay (the timer's clock and Date.now
  round different clocks: 2 of 800 20 ms timers in a probe). Then the views read "not settled",
  nothing told them again, and a held view stayed unswitched: the agents stayed listed under the
  line. Fix: the timer waits the rest when it isn't settled yet (`settleWhenDue`). Test:
  `presenceRound18b.heldSettle` runs Date.now a millisecond behind the timers.
- The product also had a 150 ms frame with the line and the agents both showing: the line shows
  the moment the tab is held (usePersonLock), the list waited the held rule. The picker now hides
  the agents whenever the line shows too. Test: "the line and the agents change in one frame".
- The test's `hold()` waits on `personHeldSettled()` and a flush, not a fixed time.
- Mutations: the early timer told no one (killed), the agents back behind the line (killed).
- Loop: the picker test and the settle test, 50 runs in a row, 50 of 50, with six CPU-bound
  node processes beside them for the first 15 minutes of the run (they had a 15-minute cap and
  ended before the last runs).

### Gates
- tsc and eslint clean; check:inline-styles and check:slava-css-scope pass.
- vitest on two workers, an explicit zsh array of 350 files (round 18's set, plus every test
  naming CommonsSettings, useCommonsLine, personSession or ChatModelPicker): 350 of 350,
  4,647 of 4,647, Errors 0, no timeouts.
- `npm run build` with the budget check: 458,350 B raw / 141,247 B gzip.
- Mutations (rsync copy): 15 run, 15 killed. Settings: the form back on a failed read, a
  maintenance action in the held pane. Lines: the gone clause dropped, clauses never used, the
  pane load back to the heading line, the page line back to failureUnder, the page's own line back
  to the heading line, neutral only for no answer, a line offline, neutral for actions too, the
  access, filters and held-out clauses dropped. CI: the early timer telling no one, the agents
  back behind the line.
- Live (8951/5951, backend only through `harness/serve_isolated.py` with the person token on
  stdin; canaries first; `blocked.log` holds only canary lines): 9 of 9.
  - F-settings-500: the pane holds only its h2 and the line; no button, input, select, form or
    fieldset.
  - A real backend reason: the references' search sent with filters the backend can't read; the
    backend answered 422 with its own line, shown as "Nebula couldn’t load the references because
    those filters didn’t work. Clear them and try again.", neutral (ink and rule
    rgba(255,255,255,0.55), as the because line).
  - Agent review, Blind labeling and the page line stay neutral.
  - Shots at 1440 in the scratchpad (`fu3r/shots-r18b`), md5 `uniq -d` empty, opened.

## Round 18c (GM r30; base 9bd4a245)

### 1. One look for every neutral Commons line
- The line was one component everywhere, but its fill (`--sr-surface-control`, black at 0.3) read
  as a box on Agent review's and Blind labeling's lighter heading and as nothing on the page's
  black. Every neutral Commons line, a load's and a because line, now draws the bare rail with no
  fill (styles/becauseLine.css, `[data-commons-line][data-line-box][data-line-neutral]`).
  CommonsErrorLine marks a because line `data-line-neutral` too, so one rule covers both. An
  action's failure keeps its filled box.
- Test: every load line, the because line and the Commons-off line, in the page row, both panes'
  headings, the settings and the detail, resolve to one look (class, ink, rule, no fill)
  (`tests/helpers/lineLook.ts lineFill`).

### 2. Add to and Add while the collections haven't loaded
- Failed or pending collections read (`answered.collections` false, on a connected tab): the
  select is aria-disabled, holds one option, "Not loaded", and is labelled "Add to, not loaded.
  It works again once the collections load."; Add is aria-disabled, labelled "Add, not loaded. It
  works again once the collections load.", opens nothing, and the grid's drop and a page's
  candidates add nothing, so "Pick or create a collection first." never shows. Both take the lock's
  grey (`data-not-loaded`, styles/disabled-buttons.css, a block of its own beside the lock's).
- Loaded with none: "No collections" in the disabled grey (`data-no-choice`); the select stays
  live, since its "New collection…" is how one is made. Add stays live: its menu's Import
  moodboards makes collections. (GM's "Add enabled only if it creates one", read that way; for
  GM.)
- A tab not connected as you keeps round 18's lock: "No collections", locked, with Add's line
  (GM r28 3). Nothing was read there either; whether it should say "Not loaded" is for GM.
- About the shots GM compared: in F, I and K only the pane's read failed; the collections loaded,
  with none, so "No collections" was true there. D's collections read failed. Now D says
  "Not loaded" with both disabled; F, I and K show "No collections" in the grey.
- Tests: on every tab, a 503, a 500 and a pending read leave both disabled with the words above,
  and a click opens nothing; loaded with none, the grey "No collections" and a live Add.
  `presenceRound13.commonsFocus`, `presenceRound14.focusOffline` and `presenceRound11.demote`
  now answer the collections read (it never answered, which is now "Not loaded").

### 3 and 4. The wording batch, as GM wrote it
- `errorCopy.loadFailedLine(what, error)` reads the status and the backend's detail, not the
  reason's words:

  | Failure | Line |
  |---|---|
  | No answer at all | Nebula couldn’t X because Nebula’s server isn’t answering. Check that it’s running, then try again. |
  | 500, 501, 505+ | Nebula couldn’t X because Nebula’s server hit an error. Try again. |
  | 408, 429, 502-504 | Nebula couldn’t X because it didn’t respond. Try again. |
  | 404 "Commons is disabled" | Commons is turned off for this Nebula. (one page line; below) |
  | 404 "not found" (blobs) | Nebula couldn’t load this image because the file isn’t there anymore. (or "this video") |
  | 401 "invalid UI session token", "no UI session: …" | Nebula couldn’t X because this window’s session ended. Reload to sign in again. |
  | 403 "only the human UI session can do this" | Nebula couldn’t X because this window isn’t signed in as you. Reload to sign in again. |
  | 401/403 with no reason | Nebula couldn’t X because you don’t have access to this anymore. Reload to sign in again. |
  | 404 reference gone, 409 not in the held-out set, 422 filters | as round 18b |
  | Any other 4xx, with no reason or one not listed | Nebula couldn’t X because Nebula’s server didn’t accept it. Try again. |

- No backend message shows as it is: an unlisted reason's words go to the console
  (`[nebula] Couldn’t X: the backend said "…" (not shown).`), and `warnFailure` logs the answer as
  before.
- The gateway statuses (502-504) keep "didn't respond": the dev proxy answers 502 for a backend
  that isn't there (errorCopy GATEWAY_STATUSES). For GM if that should read otherwise.
- A Commons 401 reaches the screen as the not-connected line (lib/commonsApi turns every 401 into
  it after one retry), so the session-ended clause is in place for any other path.
- The Commons turned off: the Commons is on only when the backend starts with
  `NEBULA_COMMONS_ENABLED=1` (backend commons/activation.py); no setting turns it on, so the line
  ends after "Nebula". When the page's loads say so, the page line "Commons is turned off for
  this Nebula." stands in place of every tab's content (no filters, grid, panes or settings).
- CommonsMedia names what it loads: "load this image", "load this video".
- Tests: every row above (`presenceRound18.neutralLines`, `paneLoads`, `mediaLine`), the raw text
  only in the console, the Commons-off page on every tab (`presenceRound15.emptyState`), and each
  backend string the mapping keys on read from the backend's own files.
- Tests that used 500 for the no-response case now use 503 (`pageLine`, `emptyState`).

### Gates
- tsc and eslint clean; check:inline-styles and check:slava-css-scope pass.
- vitest on two workers, an explicit array of 352 files: 350 of 352 files, 4,672 of 4,674 tests.
  The two were timeouts under the run's load (`clearsOnPromote.ratchet` round 5 at 30 s and
  `savePaused.store` at 5 s); rerun alone, both pass (32 of 32).
- `npm run build` with the budget check: 458,377 B raw / 141,243 B gzip.
- Mutations (rsync copy): 20 run, 20 killed. The fill back, because lines unmarked; the select
  not disabled, Add opening, never "not loaded", Add unmarked, "No collections" for not loaded,
  the grey dropped; 500 as "didn't respond", the file, session and signed-in clauses dropped, a
  raw reason shown, no console line, no answer's old line, Commons off not read, its content kept,
  its line not neutral, the media's words, the 4xx line's old words. The held status slot's test
  timed out (5 s) on its cold import in five of the mutant runs; it now has 30 s.
- Live (8951/5951, backend only through `harness/serve_isolated.py` with the person token on
  stdin; canaries first; `blocked.log` holds only canary lines): 23 of 23.
  - D (status, references and collections at 500), F-agent-review (503), I (500), F-settings
    (500), K (a real backend 422): one look, `commons-notice commons-notice--error`, ink and rule
    rgba(255,255,255,0.55), 2 px rail, no fill (rgba(0,0,0,0)).
  - D on every tab: "Not loaded", both aria-disabled in the grey, the two labels; a click on Add
    opens nothing and never says "Pick or create a collection first.".
  - F, I, K: "No collections" grey, the select and Add live.
  - M: every Commons call answered with the backend's own 404 body for a disabled Commons; on
    every tab one line, "Commons is turned off for this Nebula.", and no content.
  - Shots at 1440 in the scratchpad (`fu3r/shots-r18c`), md5 `uniq -d` empty, opened.

## Round 18d (GM r31, GM r32, review 14; base 00089609 plus main e51f789f)

### 1. GM r31's wording and the not-connected tab
- Every load reason has the server as its subject (`errorCopy.loadFailedClause`):

  | Failure | Line |
  |---|---|
  | No answer at all | Nebula couldn’t X because the server isn’t answering. Check that Nebula is running, then try again. |
  | 500, 501, 505+ | Nebula couldn’t X because the server hit an error. Try again. |
  | 408, 502-504 | Nebula couldn’t X because the server didn’t respond. Try again. |
  | 429 | Nebula couldn’t X because the server is busy. Try again in a moment. |
  | Any other 4xx, unlisted | Nebula couldn’t X because the server didn’t accept it. Try again. |

- A tab not connected as you: Add to holds one option, "Not loaded", labelled "Add to, not loaded.
  It works once this tab is connected as you."; Add is labelled "Add, not loaded. It works once
  this tab is connected as you." Both keep the person lock's look and Add's lock line.
- `tests/helpers/bareLines` (review 9's P3: "connected as you" in an aria-label is never right)
  now lets exactly these two names, and only on a control with `data-person-lock`. GM r31 asked
  for them verbatim; the line on screen is still the page's because line and Add's lock line, which
  register. Flagged for the reviewer: this is the one exception to P3.
- Tests that queried "Add" / "Add to" by name now use `tests/helpers/commonsAddNames` (connected
  or not).

### 2. The Commons turned off (GM r31 layout M, GM r32 1)
- `lib/commonsOff` holds whether this window last heard the Commons is off. `lib/commonsApi`
  sets it on any Commons call's 404 "Commons is disabled" (a load's or an action's) and clears it on
  any call that answers OK. So "off" comes from the failures, never from the lines shown (which
  hide offline), and going offline never brings the sections back (review 14 LOW-2).
- That 404 is thrown with GM's line as its reason, so no surface can show "Commons is disabled".
  An action refused that way puts up no line at all; the off view says it.
- CommonsView, while off: the header keeps only the way back, the title and Updates (no tabs, More,
  Add to, Add, status, Start or Stop); the page row shows only "Commons is turned off for this
  Nebula." (hidden offline, as every load line); the status read before, any action line, notice,
  upload failures and page candidates are dropped; an open Add menu closes. When a call answers
  again, the loads all read again.
- A reload: `lib/commonsCapability.fetchCommonsCapability` now says `on`, `off` or `unknown`.
  When the backend says `off` and the address asks for the Commons, `uiStore.commonsOffShown`
  opens `CommonsOffView` over whatever screen would show (the Projects home after a reload). It
  reads and sends nothing of the Commons (the capability test's rule), and the Commons stays
  unavailable (`commonsEnabled` false). "← Canvas" (and Projects) leave it and take #commons off
  the address; a hash edit leaves it too. No answer, an older backend's 404 or an unreadable answer
  say nothing about the Commons: no off view. After a reload there is no project open, so
  "← Canvas" lands on the Projects home; for GM if it should read otherwise there.
- The off route mounts none of the canvas's or a project's parts (graph file actions, the zoom
  recorder, the chat and settings overlays).

### 3. Add to after a failed re-read (GM r32 2, review 14 LOW-3)
- A failed collections read no longer marks the collections unread: Add to keeps the last good
  list, live, beside the load's neutral line. "Not loaded" is only for a view whose collections
  never answered (a new view starts the data again, round 13).
- The list's read-back after New collection… or Import moodboards is a load (its neutral line, the
  list kept), not the action's line.
- An open Add menu: with the list kept, Add never stops working under it, so it never comes back by
  itself. A demote and going offline still hide it and bring it back with its URL and focus (GM r19
  2, `presenceRound13.commonsFocus`, `presenceRound14.focusOffline`); the Commons turned off closes
  it.

### 4. A settings write that landed, whose read-back failed (GM r32 3, review 14 LOW-1)
- `CommonsSettings.run` is two steps. A failed write keeps the action's line. A failed read-back
  says "Saved. Nebula couldn’t load the settings back because {cause}. Reload to see them."
  (`savedReadBackLine`), where {cause} is the shared clause's first sentence without its own next
  step (`loadFailedCause`). It is neutral (`isLoadLine` reads the "Saved. " form), has no Try
  again, and never the backend's words. A read-back refused because the tab isn't connected gets
  the settings load's because line, which loads them again on the promote.
- Probe P3 is a test (409 with raw words, 503, 500, 429).

### 5. The grid while the collections haven't loaded (GM r32 4)
- `emptyHint` is empty while they haven't: no "No matches", no drop hint.

### 6. One loading look (GM r32 5)
- `CommonsLoadingLine`: a plain muted line (`.commons-loading`, `--sr-ink-meta`, no box or rail)
  where the content will appear, only after 300 ms. "Loading agent reviews…", "Loading settings…"
  (under Settings' heading), "Loading details…", and Blind labeling's "Loading held-out
  references…" in the same look.

### 7. Offline
- CommonsErrorLine hides a load line (`isLoadLine`) while Nebula is offline, so no pane shows a
  second "isn’t answering" beside "Nebula is offline" (live LOW-1). Back online the line shows
  again if it still applies.

### 8. Review 14's remaining items
- LOW-4: the backend-string test pins `detail="not found"`.
- NIT-1:
  - X6 (`person ||`): an action's because line in the one-look test.
  - X4 (the `^` anchor): an action line naming a load later in its text.
  - X11 (aria-expanded): a menu open across a demote, promoted with the collections not read yet.
  - X13 (return from a section): a failed load, away, then back; the setup state before the next poll.
  - X16 (zero-size panels): a hidden panel in the band takes nothing.
  - X2 (drop lock): a drag over the grid while not loaded isn't taken, and a drop sends nothing.
  - X8 (`requireTarget`'s guard): equivalent now. With a failed re-read keeping the list, the
    collections are "not loaded" only before a view's first answer, when no page candidates can
    exist and the drop is already locked (X2). Kept as a guard.
  - `isNoAnswer(error) ||` in the load clause: equivalent for Commons calls (`lostConnection`
    always carries status 0); only a bare AbortError would differ. Kept.
- Live NIT-3: `presenceRound15.paneLoads` has a 30 s test timeout.
- Ratchet lists: `round22Surfaces` lists CommonsErrorLine and CommonsOffView as offline-only
  readers; `studioGridAreas` lists the Commons-off screen.

### Gates
- tsc and eslint clean; check:inline-styles and check:slava-css-scope pass. No backend file
  changed, so no pytest ran (the backend-string test reads the backend's files).
- vitest on two workers, an explicit array of 354 files (every test that reads `src/` or
  `styles/`, every presenceRound*, Commons, errorCopy, failureLines, capability and App test):
  4,702 of 4,706. The four were real and are fixed: two ratchet lists (`round22Surfaces`,
  `studioGridAreas`) didn't know the new files, and two capability tests saw the off state an
  earlier test left (the capability answering "on" now clears it). The 13 files that touch them,
  rerun: 153 of 153. The new 18d tests, added after: 27 and 7, passing.
- `npm run build` with the budget check: 469,802 B raw / 144,746 B gzip.
- Mutations (rsync copy, the backend's five read files copied beside it): 41 run, 40 killed. The
  wording (5), the off view (10: offline, the header, the line, the action line, the API's off and
  answered marks, the offline row, the reload when back, the menu, the stale status), the reload
  route (4), the kept list and the read-back (2), the settings read-back (3), the grid (2), the
  loading look (3), the offline hide, review 14's X6, X11, X13, X16, the not-connected names (3),
  the blob detail in the backend, and the bare-lines exception's lock check. The survivor is
  `requireTarget`'s guard, equivalent (section 8).
- Live (8951/5951, backend only through `harness/serve_isolated.py` with the person token on
  stdin; canaries first; `blocked.log` holds only canary lines): 18 of 18.
  - Add to after a failed re-read (offline, then the collections read at 503): "Refs" kept, Add to
    and Add live, the neutral rail line.
  - Settings: a real Link folder with the folders read-back at 503: "Saved. Nebula couldn’t load
    the settings back because the server didn’t respond. Reload to see them.", neutral, alone; no
    "Try again" anywhere.
  - Agent review's read held: nothing at 150 ms, then "Loading agent reviews…" with no fill or rail
    (rgba(255,255,255,0.4)).
  - The real Commons off: the backend started again through the harness with the same token and
    without `NEBULA_COMMONS_ENABLED`. Mid-visit: no tabs, Add to, Add, status or content, the one
    line. Then a real reload (a new document) on #commons: the off view with only "← Canvas",
    "Commons" and Updates (no project controls: nothing is open), the one line, never "Commons is
    disabled"; "← Canvas" takes #commons off the address and shows the Projects home.
  - Shots at 1440 in the scratchpad (`fu3r/shots-r18d`: M after a reload, M mid-visit, N Add to
    keeping its list, S the settings read-back, L the loading line, and after ← Canvas), md5
    `uniq -d` empty, opened.

## Round 18e

GM r33 on #204: two copy fixes and one shot.

### The way back from the Commons-off view
- With no project open, the button reads "← Projects", its aria-label is "Projects", and it goes
  to the Projects home. With a project open it stays "← Canvas" (aria-label "Back to Canvas") and
  returns to the canvas.
- One helper, `backTarget(returnView, projectOpen)` in `lib/workspaceLabel.ts`, returns the label,
  the aria-label and where the button goes, so the words and the destination can't disagree.
  `WorkspaceHeader` takes an optional `backAriaLabel`; without it the label stays
  "Back to {label}".
- "Project open" means `screen === 'workspace'` with an active project. After a reload on
  #commons with the Commons off, nothing is open, so the button reads "← Projects".
- CommonsView keeps "← Canvas": the app shows it only with a project open (App's `isCommons`
  needs `!isHome`), and many tests render it without one. A comment in it says this.

### The linked-folder notice
- It now reads: Linked “moodboards”. Scanning it now. The name is the folder's last path segment
  in curly quotes, and the full path is the notice's title attribute.
- `folderName(path)` and `linkedFolderNotice(path)` live in `lib/commonsFormat.ts`.
  - Trailing slashes or backslashes are dropped first.
  - Both separators split, so Windows paths work.
  - The input is trimmed.
  - A root keeps its own text: "/" stays "/", and "C:\" becomes "C:".
  - The name is never empty.
- The Re-analyze and Import notices clear the title.
- Agent wording: only a person can link a folder (the backend's `link_folder` route is
  person-only and answers with the link, its path resolved; corrected in round 18f, which had
  said `{"status": "scanning"}`, Rescan's answer). No MCP tool or CLI command links a folder, so
  there's no agent-facing string to match.

### Left alone
- The meter's "resets …" line is unchanged. It is queued for the wording batch.

### Gates
- tsc and eslint are clean.
- vitest ran on an explicit list of 356 files: 4,755 of 4,755 passed. The 18d test files grew:
  the reload file has 8 tests and the Commons file has 29.
- `npm run build` is within budget at 470,302 B raw / 144,914 B gzip.
- Mutations: 12 of 12 killed.
  - The back target, the aria-label and the project-open read: 5.
  - The folder name and notice: 7 (trailing separators, the Windows separator, a root, the trim,
    the curly quotes, the title, and the old wording coming back).
- Live on 8951/5951, backend only through `harness/serve_isolated.py`, with canaries first: 12 of 12.
  - A real Link folder shows Linked “moodboards”. Scanning it now., with the full path as its
    title.
  - The Commons off mid-visit with a project open shows "← Canvas".
  - After a real reload on #commons there is one "Projects" button and the off line.
    "← Projects" opens the Projects home and takes #commons off the address.
  - Nothing reached a blocked host.
- Shots at 1440 are in the scratchpad (`fu3r/shots-r18e`): M after a reload, M mid-visit, and
  S the linked notice. md5 `uniq -d` was empty and each shot was opened.

## Round 18f

Review 15 (one MEDIUM and one LOW) and GM r35's answers on #204.

### Focus when the Commons turns off mid-visit (review 15 MEDIUM-1, GM r35 1)
- The off state is now part of CommonsView's handover key (`{ view, offline, off }`), so turning
  off hands focus on by the same rule as a demote or going offline. A section tab, a Settings
  field or the detail's Close moves to the heading "Commons", not `<body>`. The off line is
  announced through the existing polite region.

### A collection made while the list's re-read failed (review 15 logic MEDIUM-1, probe P6)
- `loadCollections` now says whether it read the list. After New collection…, a failed re-read
  merges the created collection into the kept list (`withCollection` in `lib/commonsFormat.ts`,
  added once) before `setTarget`. The select's shown option and the POST's `collection_id` now
  always agree.

### What clears the off line (GM r35 2, review 15 LOW-1)
- Only a 404 "Commons is disabled" sets it.
- Any other answer from a Commons route proves the Commons is on, because `activation_dep` runs
  first, so it clears the off line: a 500, a 401 (cleared before the token rule runs), a 403, a
  plain 404, even a 500 or 409 carrying the words "Commons is disabled".
- No answer, or a gateway 502–504 with no reason of the backend's (`isBackendUnreachable`), says
  nothing, so the off line stays.
- The real line then replaces the off line: the load's neutral line on a 500, the not-connected
  line on a 401.

### The linked folder's own name (GM r35 3, review 15 NIT-2)
- Settings' `run` takes a `readBack(result, read)` step. Link folder finds the new link (by the id
  the POST answered) in the folders read back and words the notice from its resolved path:
  Linked “~” becomes Linked “home”, with the resolved path in the title.
- Until the read-back answers, the notice shows the typed text. If the read-back fails, the typed
  text stays.
- Re-analyze and Import clearing the title are now pinned (NIT-2's surviving mutant).
- The 18e notes said linking answers `{"status": "scanning"}`. That is Rescan's answer; linking
  answers with the link. Corrected above.

### "Try again" as a button (GM r35 4)
- One shared pattern: `CommonsErrorLine` takes `onRetry`. A load line (`isLoadLine`) that ends
  " Try again." renders its words up to there, a `commons-retry` text button "Try again", and the
  period, so the line reads exactly as before and stays one sentence.
  - `retryStem` in `lib/errorCopy.ts` decides this.
  - The button takes the line's own neutral ink, underlined, and wraps with the text.
  - Chrome lays out any `<button>` as inline-block, so the CSS doesn't set a display.
- No timer re-reads. The line goes once a re-read succeeds. Focus on its button then goes to the
  heading "Commons" (the button hands it on as its line unmounts), so it never drops to the page.
- The page row's load lines (collections, status, references) re-read through `reloadAll`, and
  only when the row shows load lines, never an action's line. The reconnect re-read was already
  there (`useOfflineHiddenNotice`) and is now pinned.
- The other load lines on the Commons page that end "Try again." get the same button:
  - the Settings pane;
  - Agent review;
  - Blind labeling;
  - a reference's detail;
  - Agent review's and Blind labeling's reference images.

  Each one's success now clears its line (Settings, Blind labeling and both image lines didn't
  clear it before, because nothing re-read them).
- Lines without the button, and why:
  - "…the server isn’t answering. Check that Nebula is running, then try again." This asks the
    person to check Nebula first. It shows only until the banner says Nebula is offline, and the
    reconnect re-reads by itself.
  - "…the server is busy. Try again in a moment." This asks the person to wait.
  - `CommonsMedia`'s line. It renders inside a grid tile, which is a `<button>`, and a button
    can't sit inside a button. The tile's detail re-reads when it opens.
  - Any action's line. Pressing it would send the action again.

### The capability on reconnect (GM r35 5, review 15 NIT-1)
- While the off view shows, `useCommonsCapability` re-reads `/api/capabilities/commons` once each
  time Nebula comes back from offline. It never polls.
- If the answer is on, the off view opens into the Commons with no reload:
  - The project this tab loaded opens (a reload lands on the Projects home with the project
    loaded but not shown).
  - The Commons is enabled and entered in the same update.
  - The view springs its sections and page in on the Commons' spring (`data-commons-opening`,
    `commons-open`, 220 ms; off under reduced motion). The header's way back and title stay put.
- Focus goes to the heading, or to "← Canvas" when it was on "← Projects". `lib/commonsOpening`
  carries the mark. It is read as the view renders and cleared after it commits, so a render
  React drops while part of the view loads can't lose it.
- With no project to show it over, the Commons coming back leaves for the Projects home, as
  "← Projects" would.
- The Commons coming back mid-visit springs the sections back in the same way.

### Review 15 NIT-3's survivors
- M1/M14: a 500 or 409 carrying "Commons is disabled" proves the Commons is on (pinned).
- M13: App's off route with the Commons enabled shows the Commons.
- M15: the standalone Settings pane, with a read-back refused off, shows no "Saved…" line.
- M17: the loading line leaves no timer behind.
- M19: a project loaded but not shown (always so after a reload) reads "← Projects".

All five are pinned and killed.

### Gates
- tsc and eslint are clean; the inline-style and Slava CSS guards pass.
- vitest on two workers, 360 listed files (359 run): every test that reads `src/` or `styles/`,
  every Commons, capability, App and presence test, and the two new 18f files. 4,809 of 4,810
  passed. The one failure was `clearsOnPromote.ratchet`'s route scan timing out at 30 s under
  load; alone it passes 9 of 9 in 7 s.
- New tests: `presenceRound18f.commons` (30) and `presenceRound18f.commonsReconnect` (8). Both
  now take a 30 s test timeout and 10 s waits for the views loaded on demand, because a cold first
  render under the mutation run took more than 5 s. Three runs in a row, alone: 38 of 38.
  `presenceRound15.paneLoads` reads a line by its text across the button, and doesn't count the
  line's own button as a form control.
- `vite build` plus the budget check: 471,025 B raw / 145,152 B gzip.
- Mutations: 33 of 33 killed (25 new guards, including the Try again focus hand-off, the five
  NIT-3 survivors, and the detail's and Agent review's buttons).
  - The mutation library keeps the first 8 matching lines of vitest output, and React Flow's own
    error lines from the App tests filled them. The runs for the App-level mutants were therefore
    repeated with those lines filtered out.
- Live (8951/5951, backend only through `harness/serve_isolated.py` with the token on stdin,
  canaries first, every restart through the harness with the same token): 13 of 13.
  - Linked “~” while the read-back was held, then Linked “home” with the resolved path.
  - The collections line's Try again: neutral, inside the line. Pressed while still failing, the
    list was read again and the line stayed. Pressed once it answered, the line went.
  - Off mid-visit (the backend restarted without the flag) from a focused Inbox tab: focus on the
    heading.
  - Back on with the status, collections and search at 500: the neutral "…the server hit an
    error. Try again." replaced the off line. Its Try again, once answered, cleared it.
  - A reload with the Commons off showed "← Projects". The backend then restarted with the flag,
    and the off view opened into the Commons: same document, `#commons` kept, the opening mark
    seen, focus on the heading.
  - Nothing reached a blocked host; `blocked.log` holds only canary lines.
  - The puppeteer cache's Chrome had been removed since 18e, so the run used the installed Chrome
    with a throwaway profile in the run's state dir.
- Shots at 1440 (`fu3r/shots-r18f`): M off then 500, N collections Try again, R off opens into
  Commons, S1 Linked “~”, S2 Linked “home”. md5 `uniq -d` empty; each opened.

### Left alone
- The meter's "resets …" copy (queued for the wording batch).

## Round 18g

GM r36 on #204 (18f's design signed off): two small notes.

### "Commons", not "the Commons", in the because and load lines
- Changed (the person's copy, frontend only):
  - The page line, `useCommonsLine` (`COMMONS_PAGE_HEADING`, `COMMONS_PAGE_WHAT`, the
    not-connected page line): "Nebula couldn’t load Commons because the server hit an error. Try
    again."
  - The request headings in `lib/commonsApi.ts` that become because lines: "Couldn’t check
    Commons status.", "Couldn’t load Commons settings.", "Couldn’t save Commons settings."
  - CommonsSettings' own headings: "Couldn’t load Commons settings." and "Couldn’t export
    Commons."
  - Their tests: 16 files, the strings only.
- Left, and why:
  - The backend's "… asks to change a reference in the Commons" (asset proposal and Updates text)
    and "an image in the Commons". Agents read them too, and they name a place, not a because or
    load line.
  - The backend's misfit reason "the Commons was turned off". Agent-facing, and not a because or
    load line.
  - The CLI and MCP help ("the person decides in the Commons"). Agent-facing.
  - The frontend's "Turn on the Commons in Settings to review this proposal." (assetProposalReview)
    and the offline refusal's "Stop the Commons worker". Neither is a because or load line. The
    first is also stale, because no setting turns the Commons on. Both are for the wording batch.
  - Comments that quote GM's earlier wording.

### No ring on a heading or a line that takes focus from code
- One rule, app-wide, in `slava-restraint.css`, right after the baseline ring:
  `body.app-slava-restraint :is(h1, h2, h3, h4, h5, h6, [data-focus-line], [data-line-box], [role="status"], [role="alert"])[tabindex="-1"]:focus-visible { outline: none !important; }`
- These are the handover targets: the page heading, the section headings, and the lines that say
  why (the Commons and person-lock lines, the line boxes, the Projects home's notices). A person
  can never Tab to them (tabindex -1), so the ring only marked where code put focus. Chrome counts
  focus moved by code after a key press as `:focus-visible`, which is why the 18f shots showed the
  ring on "Commons".
- Screen readers still announce them: focus still moves.
- Everything a person tabs to keeps its ring. A heading or a line at tabindex 0 is outside the
  rule.
- `workspace-header.css` no longer rings the title.
- It holds for every handover: a demote, going offline, the Commons turning off, the Commons back
  with a 500, Try again's line going, and the off view opening into the Commons.
- Left with their ring, for GM: other tabindex -1 targets that code focuses but that aren't a
  heading or a line.
  - The proposal bar and the asset-proposal strip. #161's sweep (098f9eea) chose the neutral ring
    for them from the keyboard, and this round doesn't reverse a merged decision.
  - Dialogs and panels focused on open (Lightbox, the result comparison, the leave popover, the
    model pickers, the onboarding card, the Updates list).
  - Menu items moved through with the arrow keys. These need their ring.
- The ratchet is in `tests/focusRingCss.test.ts`:
  - the rule exists, comes after the baseline, is `!important`, and is limited to tabindex -1;
  - no other rule rings a heading or a line on focus;
  - every `tabIndex={-1}` in the app is a covered heading or line, or is listed with why it keeps
    its ring (a new one has to be placed);
  - the handover's targets are the control that came back, a focus line, or the heading.
  - The existing "never clears the outline without the token ring" sweep lists the rule as an
    intended exception.

### Gates
- tsc and eslint are clean; the inline-style and Slava CSS guards pass.
- vitest on two workers, 437 files (18f's list plus every test that names focus or the Commons):
  5,794 of 5,796.
  - `presenceRound15.emptyState` still matched "the Commons" in a regex. Fixed; with
    `graphStore.fix17`, 33 of 33.
  - `graphStore.fix17` failed only under load. It doesn't touch these files and passes alone.
- `vite build` plus the budget check: 471,025 B raw / 145,131 B gzip.
- Mutations on the ratchet: 8 of 8 killed.
  - no rule;
  - not important;
  - headings only;
  - not limited to tabindex -1;
  - the title's ring back;
  - a new heading ring;
  - an unplaced tabindex -1;
  - the rule before the baseline.
- Live at 1440 (8951/5951, guarded launcher, canaries first, real restarts): 12 of 12. Shift was
  pressed before each handover, so the heading matched `:focus-visible` in Chrome and the missing
  ring is the rule's doing.
  - Off mid-visit from a focused Inbox tab: focus on "Commons", visible, outline none.
  - Back on with the reads at 500: "Nebula couldn’t load Commons because the server hit an error.
    Try again.", focus on the heading, no ring.
  - The off view opening into the Commons on reconnect: the heading, no ring.
  - Then Tab: "All", 2px solid token ring.
  - Nothing reached a blocked host.
- Shots (`fu3r/shots-r18g`): M off then 500, R off opens into Commons, T Tab after the heading.
  md5 `uniq -d` empty; each opened.

## Round 18h

Review 16 (the commons-reconnect logic lens and the focus-ring live lens) and GM r37 and r38.

### Copy (GM r37, r38 1)
- `lib/assetProposalReview.ts`, Review on a Commons proposal while the Commons is off: "Commons is
  turned off because Nebula started without it. Restart Nebula with NEBULA_COMMONS_ENABLED=1 to
  review this proposal."
  - It now shows both when the tab loaded with the Commons off and when its Commons calls have
    heard since that it is off (`commonsOffNow()`). The live check found the second case opening
    the Commons' off view instead.
- `backend/commons/review.py`, Agent review with no call budget: "Agent review is off on this
  Nebula. Start Nebula with NEBULA_COMMONS_REVIEW_CALL_BUDGET set to a call budget, then try
  again."
- No test pinned either line. The 10-22 notes quote the old ones as history and stay unchanged.
- Ratchets so person copy never puts a NEBULA_ flag in parens:
  - `frontend/tests/flagParensCopy.ratchet.test.ts` covers strings, templates and JSX text in src;
  - `backend/tests/test_flag_parens_copy.py` covers every string constant except docstrings.

### Disabled or inert focus counts as gone (review 16 MEDIUM-1, GM r38 2 and 3e, LOW-2)
- `hooks/useFocusHandover.ts`:
  - `focusGone()` covers left the page, `:disabled`, or under `[inert]`.
  - A control disabled in place hands focus to the heading at once. The line is heard through
    its polite region; the studio row opens after its 1 s delay.
  - The control is kept as `origin`, and the next change hands focus back to it once it is
    enabled. That happens only while focus is still where the hook put it.
- LOW-2: focus never waits on `<body>`. The heading holds focus at once, and a line that arrives
  within the 30 frames still takes it from there.
- Settings uses the same rule:
  - AgentSpendSection's change key adds `pending`, since a save disables the limits;
  - PersonalAgentsSection's adds `busy`.

### Races (review 16 logic LOW-1, LOW-2)
- CommonsSettings numbers its notices (`showMessage`). A link's late read-back renames only the
  notice it wrote.
- CommonsView numbers its collection reads. An answer older than one already applied, or older
  than a failed newer read (whose write was merged in), is dropped.
  - Add to and Add share one value, `chosen`: the target when the list has it, else the list's
    first.

### Try again (GM r38 3a, 3b, 3c, 3f)
- Every Commons load line ending "Try again." has the button, including the loaded-state lines:
  - Agent review (its 5 s poll stays, and the button reads at once);
  - Blind labeling;
  - Settings;
  - the detail;
  - the stage media.
- `tests/commonsRetryButton.ratchet.test.tsx`: every `<CommonsErrorLine>` passes `onRetry`, with
  three exceptions:
  - the off view's line, which never ends "Try again.";
  - CommonsCloseBatch's, an action's line, where a button would send the close again;
  - media inside a tile or keyframe tab (`inControl`), since a button can't go inside a button.
- After a Try again whose re-read fails for another reason, RetryButton's hand-off focuses the new
  line's button in the same row. It goes to the heading only when there is none.
- A pane's load line reads again quietly on reconnect (`useLoadLineQuietOnReconnect`), in
  Settings, the detail, Blind labeling and Agent review.
- The ring covers "Try again" only:
  - `outline-offset: 0` and a 2 px end margin;
  - it outranks commons-evaluation.css's 3 px offset in the panes. The live check caught that
    offset.

### Rings (GM r37, r38 3d)
- noticeLeave's last fallback (the canvas or a screen's `<main>`) gets `data-focus-start` until it
  blurs, so no ring draws there. The provider row keeps its `:focus-visible` ring.
- Dialogs and panels focused on open: every one rings only on `:focus-visible`, and none rings on
  plain `:focus`.
  - Live: Updates opened by pointer has no ring; opened from the keyboard it has the 2 px token
    ring.
  - Not reached live, since each needs generated outputs, a scene, unsaved labels or a size
    limit: ResultComparison, Lightbox, ModelPicker, ChatModelPicker, ProjectSizePanel,
    SceneUnsavedMark, CommonsLeavePopover, Mesh/WorldPreview. The CSS audit found only
    `:focus-visible` rings on them.
- `focusRingCss.test.ts` changes:
  - It scans the syntax tree in .ts and .tsx (`tests/helpers/tabIndexSites.ts`), so it finds
    `"-1"`, `{ -1 }`, `cond ? -1 : undefined`, spreads, `.tabIndex =` and `setAttribute`.
  - KEEPS_RING is counted per file.
  - What counts as covered is read from the rule's own `:is()` list.
  - Roving tab stops (0 or -1) keep their ring.

### Capability (review 16 logic LOW-4)
- `useCommonsCapability` asks again on reconnect and on a boot-id change
  (`subscribeBackendRestart`), and still doesn't poll.
- It also asks while the tab is without the Commons. A canvas tab that loaded with it off learns
  that it is on, and the entry appears without a reload.

### Tests and the observer
- `tests/helpers/bareLines.ts`: the observer is disconnected in `afterAll`, and its callback
  checks for `document`. The teardown trace is gone from the gate.
- New test files:
  - `presenceRound18h.disabledHandover`, `.settingsHandover`, `.commonsRaces` (PA, PB, PB2, PC,
    PF, H8);
  - `.paneLines`, `.commons` (N12, N20, N21, N22);
  - `.capabilityRestart` (PD, PE, N8, N9, N13);
  - `.noticeLeaveStart`, `.commonsOffReview`;
  - `commonsRetryButton.ratchet` (N5, N6, N7), `flagParensCopy.ratchet`.

### Gates
- tsc and eslint: clean. `person_gate.py` is byte-identical to main.
- vitest, 2 workers, 444 files (18g's list plus every test that names the changed modules):
  5,839 of 5,839, with no teardown trace. After the late fixes, 77 files: 897 of 897.
- Backend: `test_flag_parens_copy`, `test_commons_review` and `test_commons_dispatch_review`, 16
  of 16.
- Build budget: 471,273 B raw / 145,248 B gzip (18g: 471,025).
- Mutations: 42 run, 40 killed. Two equivalent mutants survive:
  - N19: the page row's button with an action line. `retryStem` already refuses action lines.
  - N21: `off` dropped from the handover key object. Its memo deps still list `offNow`, so the
    key changes identity anyway. N21b, which drops it from the deps too, is killed (6 tests).
- Live at 1440 (8951/5951, guarded launcher, canaries first, real restarts): 15 of 15.
  - Offline with the Folder path field focused: the field went to the heading with no ring, then
    back to the field on reconnect. Focus was never on `<body>`.
  - A loaded-state Try again: the ring ends at the full stop (509.47 vs 509.47).
  - A second failure keeps focus on the new Try again.
  - A restart turning the Commons off: 0 ms on `<body>`.
  - GM's Commons-off line on an Update's Review.
  - Updates: pointer opens with no ring, keyboard opens with a ring.
  - Nothing reached a blocked host.
- Shots (`fu3r/shots-r18h`): H1, H2, B, E, F1, F2. The md5 `uniq -d` check is empty, and each was
  opened.

## Round 18i

GM r39: the Agent review line, 1(b), 1(c), Fix E and Fix B.

### Copy (GM r39, the Agent review line)
- `backend/commons/review.py`, Agent review with no call budget: "Agent review is turned off
  because Nebula started without a call budget. Restart Nebula with
  NEBULA_COMMONS_REVIEW_CALL_BUDGET set to the number of calls to allow."
- `backend/tests/test_commons_review.py` now pins it exactly. Both parens ratchets pass.
- The wording batch's "Agree, or change the parts you see differently." → "Agree or change the
  parts you see differently." (GM r39) is left for that batch, not done here.

### Close-batch line (GM r39 1(b)): the exception stays
- Measured live (installed Chrome, 1440 × 900) with a staged open batch and a close answering 500:
  - Blind labeling: the confirm dialog lays out as a row. The line (364–504 px, 706–807 px)
    sits directly left of "Close without sealing" (504–647 px, 715–740 px): same row, 0 px
    between, nothing between them in the DOM.
  - Agent review: the line (731–765 px) sits directly above "Close as assisted review"
    (765–790 px), with left edges aligned and 0 px between.
- So "Try again." points at the control right beside it. CommonsCloseBatch stays in the
  ratchet's NO_RETRY list, and its reason now cites the measurement.
- Seen in passing, not changed here: in Blind labeling the confirm dialog's row layout squeezes
  the heading, the list and the line into narrow columns (shot B1). That is a layout question
  for GM. The line's copy is the shared action copy, "Couldn’t close the batch. Nebula didn't
  respond. Try again.", and its straight apostrophe comes from the app-wide failureMessage.

### Media inside a tile or a keyframe tab (GM r39 1(c))
- `CommonsErrorLine`: a load line given no `onRetry` ends at its reason. "Try again." goes,
  since it always means a button. This is central, so the ratchet is exact; exception (c) is
  gone.
- `CommonsMedia` with `inControl`:
  - the line reads again quietly on reconnect (`useLoadLineQuietOnReconnect`, as the panes do);
  - it reads again once each time it comes back into view. An IntersectionObserver on the line
    waits for it to leave the view, then reads once on the next entry and disconnects. A read
    that fails again while in view waits for the next leave and enter. No polling, no loop.
  - The tile's click still opens the reference.
- Media outside a control keeps its Try again button and no observer.

### Updates "Review" while the Commons is off (Fix E)
- `hooks/usePersonLock.ts` `useLineLock(line, locked)`: the PersonLock shape for a lock whose
  reason isn't the person's. It gives aria-disabled (still focusable), aria-describedby to the
  line's id, and the guard.
- `AgentNoteParts` NoteButtons:
  - a Commons proposal's Review while `useCommonsOff()` is locked by it;
  - the reason renders under it through the shared `PersonLockLine`, with the same text as
    the refusal, `COMMONS_OFF_REVIEW_LINE` (`lib/commonsOff.ts`, used by
    `lib/assetProposalReview.ts` too);
  - a click does nothing;
  - a project's or a board's Review is untouched.
- `useCommonsCapability` notes the backend's "off" on any tab now, not only on a Commons route,
  so a canvas tab knows before the click. No answer notes nothing.

### Panes show only the line while the latest read failed (Fix B, GM r32)
- Agent review (`CommonsReview`): its 5 s poll can fail after a read answered. While the latest
  read's line is a load line, the pane shows only the eyebrow, the heading and the line. That
  drops "Prepare the reference set in Blind labeling first.", "0 / 15 reviewed · 0 grades
  ready", and with a batch, the references and their form. The poll never reads while a draft
  is being edited, so no draft is hidden. The next good read brings it all back.
  - The read on returning from another section now clears the line on success too, as the
    poll's does. Before, it left a failed load's line standing, which with this guard kept the
    pane on that line alone (found by tests/presenceRound18d.commons.test.tsx).
- The other panes, checked:
  - Blind labeling: once answered it never re-reads by itself. Its reconnect re-read needs a
    batch and ignores failures, and a promote retry exists only for a load that was refused,
    which was never answered. No stale state is reachable. I tried a guard and a test and
    dropped both, since the test could only stage it by faking an impossible order.
  - Commons Settings: keeps its saved values on a failed re-read (GM r32 3's design).
  - Reference detail: shows only the line until it reads.
  - Agent review's per-reference image and Blind labeling's image: they show the line in place
    of the image.

### Tests
- `tests/presenceRound18i.mediaRead.test.tsx` (4): no "Try again." and no button inside a tile,
  and its click still opens; scrolling back reads once per entry, never while it stays in view;
  reconnect re-reads quietly; outside a control the button stays and nothing observes.
- `tests/presenceRound18i.staleLoads.test.tsx` (2): Agent review's failed poll shows only the
  line, without a batch and with one, until a read succeeds (by the poll and by Try again).
- `tests/AgentNotesCorner.test.tsx` (+1): the locked Review has aria-disabled, aria-describedby
  pointing to GM's line, does nothing on click, leaves a project's Review alone, and unlocks
  when the Commons answers on.
- `tests/commonsCapability.test.tsx` (+1): a canvas tab notes the backend's off; no answer
  notes nothing.
- `tests/commonsRetryButton.ratchet.test.tsx`: without onRetry, the line has no "Try again."
- Mutations: 14 of 16 killed. The two survivors are equivalent:
  - I3, the observer's disconnect before the re-read: the effect's cleanup disconnects it when
    loadEpoch changes;
  - I8, the lock checking every action of the note: a proposal's Update carries only its Review
    (services/agent_notes.py).
- Gates: tsc -b, npm run lint, vitest on the explicit list (446 files, 5,853 of 5,853, ratchets
  included), backend test_commons_review.py and test_flag_parens_copy.py (9 of 9), vite build
  with the budget at 471,728 B raw / 145,416 B gzip.
- Live (installed Chrome, throwaway profile, 8951/5951 through serve_isolated, canaries refused):
  15 of 15. Shots A, B1, B2, C1, C2 and D in the scratchpad's fu3r/shots-r18i, all md5-distinct.
  A tile image is read twice on the first load in dev; that is the StrictMode double mount, not
  the observer.

## Round 18j

GM r40: the close-batch line (B1, B2), its ratchet, and the stacked dialog.

### The failed close's line (GM r40 B1, B2)
- Both panes share CommonsCloseBatch, so Blind labeling and Agent review read the same.
- A failed close destroyed nothing, so the line uses the because form. It is neutral, has
  curly apostrophes and never shows the server's words. It is built by `closeBatchFailedLine` in
  `lib/errorCopy.ts`, which runs the loads' status mapping over `CLOSE_BECAUSE`. That map is the
  loads' session reasons plus the close's own 409s.
- Each exact string, by cause:
  - 503, 502, 504, 408: "Nebula couldn’t close the batch because the server didn’t respond. Try again."
  - 500, 501: "Nebula couldn’t close the batch because the server hit an error. Try again."
  - 429: "Nebula couldn’t close the batch because the server is busy. Try again in a moment."
  - No answer: "Nebula couldn’t close the batch because the server isn’t answering. Check that
    Nebula is running, then try again."
  - 409, a grade running: "Nebula couldn’t close the batch because a grade is still running.
    Close the batch again when it finishes."
  - 409, sealed meanwhile: "Nebula couldn’t close the batch because its labels are sealed as
    blind ground truth, so there’s nothing to close. Reload to see them."
  - 409, stale revision: "Nebula couldn’t close the batch because it changed in another window.
    Reload, then close the batch again."
  - 409, no set: "Nebula couldn’t close the batch because there’s no held-out set anymore.
    Reload to get the latest."
  - 409, integrity: "Nebula couldn’t close the batch because the held-out set doesn’t match what
    was saved, so Nebula stopped and changed nothing."
  - Any other 4xx, or a reason not listed (its words go to the console): "Nebula couldn’t close
    the batch because the server didn’t accept it. Try again."
  - 401 session ended: "Nebula couldn’t close the batch because this window’s session ended.
    Reload to sign in again."
  - 403 with no reason: "Nebula couldn’t close the batch because you don’t have access to this
    anymore. Reload to sign in again."
  - Commons off: "Commons is turned off for this Nebula." The off view takes over.
  - This tab not connected as you: `notConnectedBecause('close the batch')`.
  - Offline: no line; the offline row says it.
- `CommonsErrorLine` treats any line in the because form as neutral (`isBecauseFailure`), as a
  load's line is. It still has no Try again button, and "Try again." keeps the exception for
  the Close button beside it.
- The 409 wordings that weren't given are mine, for GM to rule on.

### Ratchet (GM r40)
- `tests/commonsCopy.ratchet.test.tsx`:
  - every close reason above renders in both panes as listed, neutral in the app's own cascade,
    never with a straight apostrophe, "Couldn…" or "Nebula didn…";
  - the person refusal says `notConnectedBecause`;
  - CommonsCloseBatch's source has no `failureMessage` or `copyForStatus`, and its one
    `line.show` is the person refusal's;
  - the stacked dialog's order, display and button row are checked there too.

### The stacked dialog (GM r40 1)
- The cause: `.evaluation-review>div` (a reference's row, flex) also caught the dialog, which
  sits among the rows in Blind labeling. It is now `:not(.evaluation-close)`.
- The dialog is a block: the heading, the list at the dialog's full width, the line, then one
  row of buttons, Cancel then the close.
- The close keeps `commons-button--primary`. The row's flex now lives in
  commons-evaluation.css; before, it came only from commons-review.css, which Blind labeling
  didn't load.
- Cancel moved before the close in both panes, the order GM gave. Focus still opens on Cancel.
- Live at 1024, 1280 and 1440 in both panes, 33 of 33 checks:
  - the dialog is 620 px at every width, and the list fills its 582 px inner width;
  - the line sits 12 px above the button row;
  - Cancel and the close share one row, 10 px apart.
- Shots B1-close-blind-{1024,1280,1440} and B2-close-review-{1024,1280,1440} are in the
  scratchpad's fu3r/shots-r18j, all md5-distinct.

### Tests
- `tests/commonsCopy.ratchet.test.tsx` (6, new).
- `tests/commonsCloseBatch.test.tsx`: the 409 refusal now uses the real `detail` shape and
  expects the because line.
- Mutations: 7 of 7 killed (J1–J4, J6, J8, J9). Not run as a unit mutant: dropping the
  dialog's own row flex. jsdom's cascade still finds commons-review.css, so only the live check
  catches it.
- Gates:
  - tsc -b and npm run lint are clean.
  - vitest on the explicit list: 447 files, 5,865 of 5,868. The 3 failures were 5 s timeouts
    under load in files this round doesn't touch (GraphFileActions, ModelPicker,
    graphStore.fix18), and they passed 54 of 54 on a rerun of the three alone.
  - Backend named tests: 9 of 9.
  - Build: 474,676 B raw / 147,143 B gzip, after merging main with #211.

## Round 18k

GM r41: the close strings verbatim, the 403's cause, the lock rule and two wording fixes.

- **Merge.** The worktree already contained origin/main (062fb370: #218 and #211), merged in at
  f53ef9be, so there was nothing to merge or stage. No test here stands in for
  `broadcast_raw` or reads pin text.
- **Strings.** `closeBatchFailedLine` (lib/errorCopy) now maps each cause on its own, with GM's
  words. The full table, generated from the ratchet's CLOSE_LINES, is in the scratchpad's
  pr204-r18k-strings.md.
  - 401, and any refusal for this tab: lib/commonsApi turns every 401 into one, so all of them
    read "…you’re signed out. Open the link Nebula printed when it started.". That includes a
    held tab, which used to get the not-connected line.
  - Commons off: GM's restart line. It is neutral (`isBecauseFailure` now matches it).
- **403.** On this route a 403 means one of two things:
  - routes/commons `human_dep`: no person token (the CLI, an agent token, an MCP client);
  - services/local_guard: a foreign Origin or Host.
  - Both are origin or token problems, so GM's line applies. The person gate isn't on the
    Commons routes, and an unknown token gets a 401.
  - Checked live against the isolated backend: no token and `X-Nebula-Client` got 403 "only the
    human UI session can do this"; a foreign Origin got 403 "Origin not allowed"; a bad token
    got 401; the person got 409.
  - In the person's own window neither can show. lib/commonsApi never sends a Commons call
    without the token, and local_guard's 403 has no CORS headers, so the browser sees no answer.
- **Lock rule (GM r41).**
  - A close line that doesn't end in "Try again." or "Try again in a moment." (`closeLineRetries`)
    makes the close button aria-disabled. The line (CommonsErrorLine's new `id`) is its
    aria-describedby; focus stays on the button, a press does nothing, and Cancel stays live.
  - A locked `.commons-button` dims like a disabled one and keeps its rest look on hover. That
    look comes from the `--commons-rest-*` custom properties, so no new disabled rule is needed
    outside the shared sheet.
  - Grade running: while that line shows, the dialog reads Agent review every 5 s
    (`GRADE_WAIT_MS`). When no grade is running, the line clears itself and the button is live
    again. It asks at no other time.
  - Offline: no line; the button is aria-disabled with the studio offline row's line as its
    aria-describedby. `STUDIO_OFFLINE_LINE_ID` is in lib/useBackendOffline, and StudioOfflineRow
    gives its pill that id. Before, the button was natively disabled.
- **Wording.** The B2 bullet now reads "You can keep agreeing with or correcting grades after
  closing. You’ve reviewed 0 of 15 so far. No new grades will be requested." Both dialogs say
  "This can’t be undone." CommonsDetail's "Delete … This cannot be undone." confirm is a
  different dialog and is left for the app-wide copy PR.
- **Tests.**
  - `tests/commonsCopy.ratchet.test.tsx` (9): every row in both panes is exact, neutral and in
    the right state, and the rule "live ⇔ ends in a retry" is checked per row. Also the 401 case,
    the grade wait (locked, still locked, then cleared and live with focus kept), a retry line
    never starting the wait, and offline.
  - `tests/commonsCloseBatch.test.tsx`: the new bullet and "can’t".
- **Mutations.** 19 of 19 killed (K1–K19). K11 first survived, because a test advanced fake
  time in the same act as the failure. It now settles first.
- **Live** (installed Chrome, throwaway profile, 8951/5951, canaries refused): 16 of 16. That
  covers the 403 probes, and in Blind labeling a 503 left live, a 403 locked (opacity 0.48), the
  grade wait, offline locked by the offline row, and both dialogs' wording. One shot,
  K-403-locked, is in the scratchpad's fu3r/shots-r18k.
- The first gate run caught one problem: the grade wait cleared its line with an updater
  function, which presenceRound9's scan reads as a screen setting a failure line itself. It now
  calls `setError('')`. That is safe because any other line cancels the wait first. K9 was
  re-run against the new code and is killed.
- **Gates.**
  - tsc -b and npm run lint are clean.
  - vitest on the explicit list: 447 files, 5,871 of 5,871.
  - Backend named tests: 9 of 9.
  - Build: 474,675 B raw / 147,169 B gzip.

## Round 18l

Review 17 (two MEDIUMs, LOWs, NITs) and GM r42/r43.

- **Correction to round 18k's 403 note.** Round 18k said local_guard's 403 can't reach the
  person's window, because it carries no CORS headers. That holds only when the page and the
  backend are different origins. When the page is opened by a non-loopback name through the Vite
  proxy (same origin), the guard's 403 "Host not allowed" reaches the window as an answer, so
  GM's "this sign-in isn’t allowed to do that" line does show there. No code change.
- **401 split on the held state (GM r42).** `closeBatchFailedLine(error, held = personGateHeld())`:
  - held: "Nebula couldn’t close the batch because this tab isn’t connected as you. Open the link
    Nebula printed when it started." It locks the close and clears on the promote (useCommonsLine
    registers it), and the close is live again;
  - not held: "…because you’re signed out. Open the link Nebula printed when it started.";
  - one ratchet row each (`CLOSE_401_LINES`).
- **While the close is out (MEDIUM-1, GM r43 Q1).** Nothing in the dialog is natively disabled
  any more, so Chrome's focus fixup never drops focus to the page.
  - The close is aria-disabled and aria-busy, stays focusable, and ignores presses.
  - Its label reads "Closing…" after 300 ms (`CLOSING_LABEL_MS`); an answer inside that never
    shows it.
  - Cancel is aria-disabled with aria-describedby the close (whose busy state is the reason);
    Escape does nothing while closing.
  - A 30 s client timeout (`CLOSE_TIMEOUT_MS`, an AbortSignal through
    `commonsEvaluationApi.close`). Then the dialog reads the batch: closed is a success
    (`onClosed`); otherwise, or if the read fails, "Nebula couldn’t close the batch because the
    server didn’t respond. Try again." with the close and Cancel live.
  - Backend: the close was already idempotent (`evaluation.close` returns the closed view before
    any revision check), so no backend code change. `test_close_retry_after_a_lost_answer_succeeds`
    pins it: the same close twice, both 200 with the same hash and revision, and still 403
    without the person's token.
- **Parent busy state inside the dialog (MEDIUM-2).** `lock: 'grade' | 'edits' | null` is an aria
  lock with its reason; native `disabled` stays only on the opener outside the dialog. The
  opener's `disabled`, if a parent sets it with no `lock`, also locks the close (aria).
  - Agent review, a grade running: the existing grade line.
  - Unsaved label edits: GM's line names "Save" and "Discard", but the controls are "Save
    labels", "Save accents & reveal labels" and "Discard unsaved changes" (Blind labeling) and
    "Save corrections & next" / "Discard changes" (Agent review). So `EDITS_LOCK_LINE` is null:
    the close locks with no line, and the ratchet has an `it.todo` row for GM's wording.
  - In Blind labeling the edits lock is likely unreachable with the dialog open: its opener and
    the "Review batch" toggle are disabled while busy or dirty, and the label form isn't shown in
    review mode.
- **Q3.** A lock line plus offline: aria-describedby is "<line> studio-offline-line", line first.
  The offline row's id is used only once the row shows its line (`useOfflineRowShown`, a small
  store StudioOfflineRow sets), so nothing points at a missing element in the first second
  (LOW-1).
- **Q4.** A retry line goes when Nebula goes offline and doesn't come back after the reconnect;
  a lock line stays.
- **Q5.** The "Commons off" row stays in the ratchet, marked tested-only.
  `presenceRound18l.closeOff` shows that in the app a close answered 404 "Commons is disabled"
  switches to the off view: the dialog unmounts with the pane and focus is on the Commons heading.
- **Q6.** Escape is Cancel (it stops at the dialog). Cancel and Escape both give focus back to the
  opener (live LOW-4).
- **Q7.** In Agent review the grade wait follows the pane's 5 s poll (`gradePoll`: running, and a
  read count): the line goes on the first read after it that sees no grade running. Blind
  labeling keeps the dialog's own check, which stops while offline (LOW-2).
- **Focus fixup helper.** `tests/helpers/focusFixup.ts`: a MutationObserver on `disabled` and
  `inert` that blurs the active element as Chrome does (`withFocusFixup()` per file;
  `installFocusFixup()` returns `flush()` and `disconnect()`).
  - jsdom's `blur()` does nothing on a disabled element, so the helper lifts `disabled` from the
    control (or its disabled fieldset) for the blur and puts it back. The 18h tests' hand-written
    `field.blur()` "as Chrome would" were no-ops for that reason; they now call the helper.
  - Installed in 22 files: every test file that asserts document.activeElement and renders from
    components/commons, uses useFocusHandover, renders AgentSpendSection or
    PersonalAgentsSection, or speaks of the fixup. All passed unchanged with it installed.
  - Ratchet (`focusFixup.ratchet`): that narrower rule. The literal rule ("any test asserting
    activeElement after an async action") covers 61 of the 78 files that assert focus, mostly
    canvas, menus and dialogs where nothing is disabled in place; requiring the helper there is
    noise. The ratchet also forbids hand-written blurs "as Chrome would".
- **LOWs and NITs.**
  - Tile reconnect re-read count pinned: 6 failed tiles, offline and back, read once each, and
    nothing more while they stay in view (live NIT-2). The observer is disconnected on unmount
    (N19).
  - Flag-parens ratchet: `/\([^)]*\bNEBULA_[A-Z0-9_]+/` in both the frontend and backend. In the
    backend it found 17 strings, all terminal text for the CLI, the dev server and the MCP
    server ("(default: $NEBULA_URL)", "(or set $NEBULA_APP_TOKEN)"), none in what the app shows.
    Those three are set aside by file (`TERMINAL_COPY`), for GM to decide in a separate copy
    pass. The frontend had none.
  - NIT-1: an exception from Nebula's own code keeps "…didn’t accept the request. Try again."
    (the step is still right) and logs `console.error` as the bug it is. How the app words its
    own failures belongs to the app-wide failure-copy PR.
  - The 8 survivors (N4, N5, N8, N12, N14, N15, N19, N22) have tests.
  - The lineRegistration ratchet now names `shownLine` as CommonsCloseBatch's registered line.
- **Try-again ratchet.** #208's shared `tryAgainLine` helper and `tryAgainLines.ratchet` aren't
  on origin/main yet (still 062fb370), so the close lines keep their own retry assert here and
  move into the shared ratchet after #208 merges.
- **Live** (installed Chrome, throwaway profile, 8951/5951, canaries refused, nothing reached a
  blocked host): 21 of 21, with real key presses (Tab from Cancel to the close, Enter, Space,
  Escape). Focus stays on the close and is :focus-visible after a 503, through "Closing…", after
  the answer, and after the 30 s timeout. Escape and Cancel hand focus to the opener. A 401 on a
  tab not held reads "…signed out…" and locks. Q3 gave reasons [the sealed line, the offline row],
  and back online only the line. Q4 cleared the retry line offline for good. Agent review's grade
  lock and its release kept focus.
  - Finding: demoting the tab with the dialog open replaces the whole pane with its held view, so
    the dialog unmounts. The held 401 line shows only in the 150 ms before the hold settles; like
    the Commons-off row, it is in practice tested-only. GM may want that noted on the row.
  - Shots in the scratchpad's fu3r/shots-r18l: a-close-after-failure, b-closing,
    c-grade-lock-agent-review. Shot (c) is Agent review's grade lock, because the Blind labeling
    edits line isn't set.
- **Mutations.** 47 of 47 killed (L1–L47), covering every new branch and the 8 review survivors.
  L25 (own check despite the pane's poll) and L44 (the opener's offline disabled) first
  survived; each now has a test.
- **Gates.**
  - tsc -b and npm run lint are clean.
  - vitest on the explicit list: 450 files, 5,907 passed and 2 failed on the first run
    (commonsReview expected the old close call without a signal; lineRegistration named `error`
    as the close's registered line, now `shownLine`). Both were fixed, and their files pass,
    along with the new tests added after.
  - Backend named tests (test_commons_evaluation_close, test_flag_parens_copy,
    test_commons_review), isolated: 21 of 21.
  - Build: 474,749 B raw / 147,176 B gzip.

## Round 18m

GM r44: the unsaved-edits line and the opener's lock, the held row tested-only, the flag ratchet's
exemption by surface, and the close lines in the shared Try-again ratchet.

- **Merge.** origin/main (26bdd988, #208) is merged and staged, not committed. Six files
  conflicted, and each was resolved to keep both sides:
  - CommonsDetail: #208's muted too-transparent reason, plus #204's `data-line-box` on the
    error box. failureMessage stays dropped.
  - CommonsGrid: #208's badges and tile names, plus #204's `dropLocked` and `inControl` media.
  - Inspector: #208's palette imports and "Extract" label, plus #204's person-lock imports.
  - commonsFormat imports, commons.css (#204's retry rules and #208's muted notice), and
    focusRingCss's allow-list.
  - Two #204 ratchets then caught #208 code:
    - the palette's "Extracting colors…" line (tabindex -1, no ring by its own :focus rule) is
      listed in focusRingCss;
    - CommonsDetail's muted reason is exempt in lineRegistration: it comes from the asset's own
      analysis, never a refusal.
- **1. The unsaved-edits line (GM r44 1).**
  - `EDITS_LINE_LABELING` "Save or discard your label changes to close this batch." and
    `EDITS_LINE_REVIEW` "Save or discard your corrections to close this batch."
    (CommonsCloseBatch). Each pane passes its own (`editsLine`).
  - The opener, while edits are unsaved: aria-disabled, focusable, presses ignored, the line right
    under it as its aria-describedby (a `person-lock-line`, `data-lock-place="control"`, so
    lib/lockPlacement checks it).
  - Native `disabled` stays for the busy moment: a save in flight, and in Agent review a grade
    running, plus offline. Making that aria too would need a line for it, and GM gave none, so it
    stays native.
  - Inside the dialog the edits line shows neutral (`CommonsErrorLine neutral`). It is
    tested-only: the opener locks first.
  - In Blind labeling the opener sits in review mode, which can't be entered with unsaved labels,
    so its edits lock is unreachable too. The panes pass `disabled={busy}` and
    `lock={dirty ? 'edits' : …}`, and the M20 mutant (Blind labeling passing dirty as busy)
    survives as equivalent for that reason.
  - The "Review batch" toggle was natively disabled for the same reason. It is now aria-disabled
    while labels are unsaved, its aria-describedby the form's own status line ("Save before
    changing reference", now with an id); natively disabled only while a save runs. GM may want
    its own line for it.
  - A busy lock hides an older retry line in the dialog (`shownLine`), since the close can't retry.
- **2.** The held 401 row is marked tested-only and kept.
- **3. Flag ratchet by surface.** `_help_text` exempts any string under a `help`, `description`,
  `epilog` or `usage` keyword in any call: argparse help and usage, and MCP tool and parameter
  descriptions (docstrings were already skipped). Nothing is exempt by file.
  - Now checked: the CLI's own messages and the startup lines for the person (person_session's
    "Open Nebula as you: …" and its warnings, devserver's announce lines and "ignoring …").
    `test_the_startup_lines_for_the_person_are_checked` pins that they are scanned.
  - Changed for GM (cli/commands/mcp_connect.py; none are startup lines):
    - "Pass Nebula's address with --url (or NEBULA_URL_FILE for the desktop app)." →
      "Pass Nebula's address with --url; for the desktop app, set NEBULA_URL_FILE instead."
    - "(A token made before token files: set NEBULA_APP_TOKEN or pass --paste-token.)" →
      "For a token made before token files, set NEBULA_APP_TOKEN or pass --paste-token."
    - "…pass its address with --url (the desktop app: set NEBULA_URL_FILE to the file Settings >
      Connect your agent names)." → "…pass its address with --url; for the desktop app, set
      NEBULA_URL_FILE to the file Settings > Connect your agent names."
  - The startup lines needed no change for this rule. They still use straight apostrophes
    ("isn't loopback"); that is outside this ratchet, for GM.
- **4. Shared Try-again ratchet.** tryAgainLines.ratchet has 11 close rows, built from
  `closeBatchFailedLine` and `CLOSE_NO_RESPONSE` (503, 502, 504, 408, 500, 501, no answer, an
  unlisted 409, 422, 415, the 30 s timeout), each checked with `expectTryAgainLine` and as a retry
  by `closeLineRetries`. #204's own "ends in a retry" regex is gone; the lock rule (live ⇔
  `closeLineRetries`) stays in commonsCopy.ratchet. The 429 line ends "Try again in a moment.",
  outside the house form, so it isn't a shared row; it stays pinned in commonsCopy.ratchet.
- **Tests.** commonsCopy.ratchet: both panes' opener lock (line under, focus kept with the fixup,
  presses ignored, placement clean, dims), the busy and offline native moment, the in-dialog
  edits line neutral. commonsReview: unsaved corrections lock the opener and Discard frees it; a
  save in flight is native with no line. commonsEvaluation: the toggle's lock.
- **Mutations.** Frontend 19 of 20 killed (M1–M20; M20 equivalent, above). Backend 4 of 4 (a CLI
  message back in parens, a startup line with a flag in parens in person_session and in devserver,
  a startup line dropping out of the scan).
- **Live** (installed Chrome, throwaway profile, 8951/5951, canaries refused): 8 of 8. Agent
  review with a correction made: the opener aria-disabled (not native), reached by Tab, GM's line
  right under it as its reason, dimmed; Enter and Space open nothing; lockPlacementProblems
  empty; Discard frees it. Shot: fu3r/shots-r18m/opener-locked-with-line-1440.png.
- **Gates.** tsc -b and npm run lint clean. vitest on an explicit list of 497 files: 6,505 passed
  and 2 failed on the first run (the two #208 interactions above); both fixed and their files
  re-run, 58 of 58. Backend isolated: test_flag_parens_copy, test_agent_connect,
  test_commons_evaluation_close, 88 of 88. Build 474,722 B raw / 147,190 B gzip.
