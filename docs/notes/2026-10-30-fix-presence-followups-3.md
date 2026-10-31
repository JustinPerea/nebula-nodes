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
    change; it goes to Justin.
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
  - MEDIUM-1: a refused wire (POST connect, DELETE edge), node add, undo and scene save carry
    the refusal into `notify` (or `clearsOnPromoteIf`) with its own stamp (`refusalError`).
    A scene save refused by the gate gets the because line and goes again on the promote,
    only while that entry is still refused for that reason (`cinema.scene-save-retry`). The
    trace requires a marker or a registering call in the `!res.ok` branch, and a keeper is a
    function that registers in its own body or always forwards to one (every function of
    that name, a statement of its own body). The reviewer's wire probe is a test.
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
  save limit and the approved-run check out.) Still with Justin, not built: the proposal read boundary, and whether runs started
  by anything that isn't the person should have a default daily dollar total.
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
