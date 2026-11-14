# Spend ledger: one truth for every backend on a data folder

Follow-up to PR #212's final review (three findings). Code: `backend/services/agent_spend.py`
(`SpendLedger`, `LedgerBusy`, `_counted`, `LEDGER_UNREADABLE`), `backend/main.py` (`_reserve_spend`),
`frontend/src/store/settingsDraftStore.ts`, `frontend/src/lib/spendLimits.ts`.

## Decisions not in the brief

- **Lock helper.** No existing helper fits: settings' `_locked` locks the settings file itself and
  follows its inode across replaces; provider_start_guard's `_journal_lock` waits without limit; its
  lifecycle lock doesn't wait at all. The ledger uses the provider guard's shape (a sibling
  `.agent-spend.json.lock`, `fcntl.flock`, 0600) with settings' bounded loop (`LOCK_NB`, 10 ms steps,
  a deadline). A shared module would have meant touching both high-tier files; not done here.
- **Wait: 2 seconds** (`LOCK_WAIT_SECONDS`). A hold is one read, check and save (milliseconds). Past
  it, `LedgerBusy`; `main._reserve_spend` answers 503 in the pricing-table-unavailable shape, so
  `_require_run_spend_approval` forgets the run as for any refusal. The check never runs. The wait
  blocks the calling thread (the run routes call the check synchronously, as before).
- **A filesystem that takes no flock** fails closed (LedgerBusy, "the spending record can't be
  locked"), unlike settings, which saves without a lock there. Flagged.
- **In-process locks kept.** Order: `_reserve_lock` → `_io_lock` (RLock, also bounded) + flock →
  `_lock`. Nothing takes `_io_lock` while holding `_lock`. The thread holding the file lock reads the
  snapshot it re-read; other threads' reads go to the file.
- **Display reads** (`spent*` outside `reserve`) read the file as it is, without the lock (each save is
  one `os.replace`), applying the migrations in memory. The first read through a ledger object takes
  the lock once so a legacy file is migrated and saved (the old first-load save).
- **Migrations once per file.** `_migrate` and `_seed_chats_daily` run under the lock on the fresh read
  and save at once; the next backend reads a migrated, seeded file and does nothing.

## Runs in flight

A run is counted in the file when `reserve` passes (`record` inside it), so the other backend sees it
at once. Only the give-back plan (`main._spend_holds`, `_SpendHold`) lives in memory. A backend that
dies loses that plan: its runs **stay counted** and age out with the 24-hour window (chat session
totals, which have no window, keep them). Chosen as the strict side: a request may have gone out
before the backend died, and nothing records whether it did. Pinned by
`test_a_run_whose_backend_died_stays_counted_until_it_ages_out` (a real process that `os._exit`s).

## Unreadable ledger

Exists but can't be read, isn't JSON, or isn't `{"sessions": {...}}` (an empty file too): hard-linked
to `agent-spend.unreadable-<UTC yyyymmddThhmmssZ>[-n].json` (a link never replaces a file already
there); a new file with `"unreadable": {"since", "keptAs"}` then takes the ledger's name in one
rename. The ledger's name is never removed first (coordinator review): a crash or a failed save
between an unlink and the new file would have left no ledger, which reads as a new install at $0.
A save that fails leaves the unreadable file in place and refuses (LedgerBusy); the next check finds
the kept name by its inode and adds no second copy. For 24 hours from
`since`, every `Spent` is `full`, and `session_budgets`/`daily_budget` count each budget as at least
its own limit (`_counted`: USD, plan runs, per-model session limits), so `decide`'s existing
comparisons put any priced run over. Nothing in `decide`'s checks changed. Then the mark is dropped.
The windowed totals the lost file held (daily total, outside budget, apps) have aged out by then, but
a chat session's running total has no window: it restarts from $0 when the hold ends, and only the
daily total still caps that chat's day (corrected in round 2: an earlier version of this note said
everything ages out). If the file can't be kept aside, LedgerBusy.

The person "acts" today by accepting proposals (their runs aren't counted) or deleting
`agent-spend.json` by hand. No new surface was added.

## What agents read while it holds (coordinator review)

`GET /api/agent/spend` (`nebula spend`, `nebula context`, `get_spend_limits`) counts the daily total
as a run is checked (`agent_spend.daily_budget`), so it shows the total used up with $0.00 left, and
carries the sentence as `ledgerNote`. Before, it showed "$5.00 left" beside runs that waited. The
person's Settings numbers are unchanged (what the file counts); a Settings line is GM's call.

## Frontend cap

A saved `dailyTotalUsd` over `MAX_DAILY_TOTAL_USD` reads as unset (the $5 default), which is what the
backend enforces (`validate_daily_total` raises, `caps_from_settings` falls back to $5), rather than
being clamped to $100,000. Settings then saves without the field and the 400 goes away. The constant
moved to `lib/spendLimits.ts` (no imports, so the settings store doesn't pull in pricing);
`dailyTotal.ts` re-exports it. A backend test reads that file and compares it with the backend's.

## Draft lines for GM - Design

- Busy (503, agent): "Can't check this run's cost (another Nebula on this computer is updating the
  spending record). Try again in a moment." + the surface's proposal hint. Variants for the cause:
  "(the spending record can't be locked)", "(the spending record can't be read or kept aside)",
  "(the spending record is busy)" (this backend's own lock past the wait).
- Unreadable (agent and person): "Nebula couldn’t read its record of what agents have spent, so it
  counts every spending limit as used up for 24 hours." Appended to the budget refusals and to a
  waiting run's bar line, agent line, refusal and nameless line. Not on the slots-full / total-full
  lines, and Settings' usage line still shows the file's numbers (e.g. "$0.00 of $5 used") while runs
  wait.

## Gates (2026-11-14, load average 30 to 106)

- New: `test_spend_ledger_shared.py` 20 passed; `settingsDraftStore.dailyCap.test.ts` 3 passed.
- Existing spend tests: `test_agent_spend`, `test_daily_total`, `test_daily_total_review1` 197 passed, none
  changed. The other 83 files naming spend, one pytest per file: 4,442 passed, 8 failed. Every failure
  was a timing test that passed when re-run alone or failed the same way on an untouched copy of
  `main`: `test_chat_real_runners` (fails on main too), `test_input_size_security` x3 (fails on
  main too), `test_agent_connect` x2, `test_krea_gateway`, `test_provider_start_admission` (each
  passed alone on this branch).
- Backend tests that read SKILL.md or MCP-SETUP.md (38 more files): 1,424 passed, 2 failed, both
  timing (`test_agent_presence_agents` passed alone, `test_mcp_channel` fuzz deadline).
- Frontend: `tsc -b --noEmit` OK, `npm run lint` OK. `check:ratchets` and `npm run build` were
  stopped at 1,500 s twice under load, so neither finished; CI runs both. The apostrophe ratchet
  passed when run on its own.

## Round 2 (review of PR #242, GM - Design rulings)

Backend:

- **Three states for the file** (review M1, L3). `_read_file` now returns `unopenable` for a file that
  exists but can't be opened or read (permissions, an I/O error, a dangling symlink, found with
  `os.path.lexists`). Under the lock that raises LedgerBusy ("it can’t read the spending record or set
  it aside"); nothing is kept aside or replaced, and the run works again once the file reads. A display
  read returns nothing spent with the hold on. Only content that was read and isn't a ledger (not UTF-8,
  not JSON, wrong shape, empty) is kept aside.
- **Marks repaired once** (L1, L2). A malformed `unreadable` mark, or a `since` later than now, becomes
  `since = now` (a string `keptAs` is kept) and `_parsed` reports a change, so the next locked read
  saves it and the 24 hours start once.
- **Display reads never wait.** The first read through a ledger object and the unreadable-file branch
  in `_view` try the lock once (`_locked(wait=False)`) instead of waiting up to 2 s. A read that
  can't take it works on its own copy and saves nothing; the next read tries again. This also shortens
  review L4's worst case for display reads (checks and refunds still wait up to 2 s).
- **The hold's end travels.** `Spent.full` is now a property of `Spent.until` (epoch seconds, None with
  no hold). For a file that can't be read at all the start is unknown, so a display read reports
  `until = now + 24 h` (it moves with each read until the file reads again).
- **Sentence with a time.** `ledger_unreadable(until, tz=None)` builds GM's weekday form by hand
  (fixed English weekday names, 12-hour clock, no leading zero), in the computer's local zone or `tz`.
  Minutes are truncated ("3:40 PM" for 15:40:59), as a clock shows them; the app's live form should
  do the same so both name one minute.
- **Stored lines carry no time.** `DailyWait.bar_line` (the proposal's note, `barLine`, `updateLine`)
  no longer has the sentence. `as_dict` adds `ledgerHold: {until, line}` when the run is over the
  total during a hold. `main._proposal_view` (every canvas, HTTP, MCP and websocket view) and the new
  `main._proposal_brief` (`nebula look`, `nebula context`, start_here) refresh it with
  `agent_spend.ledger_hold_now`: while a hold is on, its current end and line; otherwise the stored
  pair. The CLI prints the line after a waiting proposal only while `until` is ahead
  (`formatter.ledger_hold_note`). The one-time lines (agent line, refusals, nameless line) keep the
  sentence inline.
- **Contract fields.** `_outside_view` (Settings) has `ledgerHold: {until}` while the hold is on;
  `/api/agent/spend` keeps `ledgerNote` (weekday form) and adds `ledgerHold: {until}`;
  `agent_start.spend_part` passes both.
- **Refusal wording.** `LedgerBusy.why` holds the clause after "because" (`BUSY_OTHER`, `BUSY_LOCK`,
  `BUSY_READ`, `BUSY_HERE`); `agent_spend.busy_refusal` and `pricing_refusal` build the lines. The
  pricing line gives the reason in plain words and then the raw error as its own sentence: "… because
  it can’t read the pricing table. Error: <error>." (a final period only when the error has none; no
  Error part when there is no error text). Only agents get it.
- **A record that can't be opened (coordinator review).** While the file can't be opened at all,
  `SpendLedger.cant_read()` is true and `hold_until()` is None: the stand-in end a display read uses
  to keep the limits strict is never shown as a time. `/api/agent/spend` and Settings' view carry
  `ledgerBlocked` with GM's line "Nebula can’t open its record of what agents have spent, so agents
  can’t start paid runs until it can."; Settings shows "Amount unknown" in every row. No proposal
  stores that sentence, because a run is refused in this state and never waits.

Not done here: the Updates card's stored text (`canvas_proposals.update_text`) has no hold field of
its own; the app finds the hold through the proposal's `wait.ledgerHold`.
