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
comparisons put any priced run over. Nothing in `decide`'s checks changed. Then the mark is dropped:
everything the lost file held would have aged out. If the file can't be kept aside, LedgerBusy.

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
