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
- **The 41 px narrowing (GM r8 4).** A demote and a promote remount the header, and "Saved"
  replayed its fold (`--settled`'s animation, 41 px of label) from the start. `settleDelay`
  (lib/saveSettle.ts) keeps when "Saved" settled across remounts and starts the animation
  that far in (a negative delay), so a header that comes back long after the save shows it
  folded. The width is pinned across a demote and a promote in `presenceRound7.header.test.tsx`
  and measured live.
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
    so it can't be reached; with both removed, the tests fail. The first pass left five
    alive (close_session's ref, a scene retry for another refusal, the switch verb, the
    cluster's kept states, and two trace forwarder rules); each now has a test that kills
    it. Writing the forwarder probe found the leading-trivia leak above.
  - tsc and lint are clean.
  - vitest: the full run had 8,796 tests in 699 files: 8,741 passed and 55 failed in 25
    files, with the backend suite, the mutants and other lanes beside it (load about 27).
    Four files were real: tests that still expected the old lines or lacked `notify` in a
    mock, and the new lib file missing from the ratchet's list. They are fixed. The 25 files
    rerun alone: 430 of 451 passed, the rest timeouts; those 18 files run one at a time: 335
    of 335 passed.
  - build: 451,185 B raw, within budget. Backend: 12,354 passed in a full isolated run.
  - Live on 8795/5795: 21 of 21, 12 distinct shots (md5 checked). Staged, and flagged: the
    isolated backend takes this tab's Save style and run starts (no gate on them), so their
    refusals are answered in the page with the gate's 403; the demotes and promotes in the
    person's tab are the frontend's own `reportPersonRequired`/`notePersonPromoted`; the
    permission ask is delivered on the tab's own chat socket (no ACP agent here), and the
    chat turn before it stays in the page. In an early harness run, before the run starts
    were staged, one Generate reached the isolated backend and stopped at its missing Gemini
    key (no keys there, nothing paid); a Style was saved to that scratch state once. Nothing
    was accepted, rejected, answered or dismissed.
  - Placement, measured: Styles ends at y 648 and the notice band starts at 656 in Creator
    Studio (composer top 711); notices sit 774-820 on Canvas and Commons (bar clearance 72),
    656-702 in Creator Studio (190), and 830-876 on Moodboard, Cinema and Projects (no bar).
  - The header's left group stayed 180 px through the demote and the promote.
