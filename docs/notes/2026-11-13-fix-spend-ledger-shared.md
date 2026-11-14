# Spend ledger: one truth for every backend on a data folder

Follow-up to PR #212's final review: two Nebula backends can run on one `~/.nebula`, and before this
change each kept its own idea of what agents had spent. This note describes the ledger as it stands
after PR #242's review rounds (1 to 3). Code: `backend/services/agent_spend.py` (`SpendLedger`,
`LedgerBusy`, `_counted`, `ledger_unreadable()`, `LEDGER_CANT_READ`), `backend/main.py`
(`_reserve_spend`, the spend views), `frontend/src/lib/ledgerHold.ts`, `frontend/src/hooks/useBefore.ts`,
`frontend/src/components/panels/settings/AgentSpendSection.tsx`. Tests:
`backend/tests/test_spend_ledger_shared.py`, `frontend/tests/ledgerHold.test.ts`,
`frontend/tests/ledgerHold.ui.test.tsx`, `frontend/tests/settingsDraftStore.dailyCap.test.ts`.

## The file and its lock

`agent-spend.json` is the one record for every backend on the data folder. `reserve`, `record` and
`refund` take an exclusive `fcntl.flock` on a sibling `.agent-spend.json.lock` (0600, the shape
provider_start_guard uses), re-read the file under it, change what they read and save with one
`os.replace` before letting go. The wait is bounded: `LOCK_WAIT_SECONDS` (2 s), polling every 10 ms.
Past it the call raises `LedgerBusy`, and `main._reserve_spend` answers 503, so the run is refused
and the check never runs. A filesystem that takes no flock also raises `LedgerBusy`; unlike
settings, which saves without a lock there, the ledger fails closed.

Lock order inside one process: `_reserve_lock`, then `_io_lock` (an RLock, also bounded) with the
flock, then `_lock`. Nothing takes `_io_lock` while holding `_lock`. The thread holding the file
lock reads the snapshot it re-read; other threads read the file.

A shared lock module would have meant touching two high-tier files, so the ledger has its own helper.

## Runs in flight

A run is counted in the file when `reserve` passes (`record` inside it), so another backend sees it
at once. Only the give-back plan (`main._spend_holds`, `_SpendHold`) lives in memory. A backend that
dies loses that plan, and its runs stay counted until they age out of the 24-hour window (a chat
session's running total has no window and keeps them). This is the strict side: a request may have
gone out before the backend died, and nothing records whether it did.

## Display reads

Reads outside a check (Settings, `nebula spend`, `get_spend_limits`, the proposal views) read the
file as it is and never wait. When one of them needs the lock, it tries once (`_locked(wait=False)`)
and goes on without it if another backend holds it. The lock is tried in three cases: the first
read through a ledger object (to migrate a legacy file and save), unreadable content (to set it
aside), and a file that needs a repair or migration it didn't need at the first load (a malformed or
future-dated mark written by hand or by an older backend). When the read gets the lock, the change
is saved once, as `reserve` would save it. When it doesn't, or the save fails, the read works on its
own repaired copy, which is strict (the hold is on) and is never $0, and nothing is saved.

Each `Spent` a read returns carries the hold's end (`until`) and whether that end is real
(`known`), both from the same read, so a view never pairs one read's end with another read's state.

## Three file states

- **Missing**: a new install, $0.
- **Unreadable** (the content was read and isn't a ledger: not UTF-8, not JSON, not
  `{"sessions": {...}}`, or empty): under the lock it is hard-linked to
  `agent-spend.unreadable-<UTC yyyymmddThhmmssZ>[-n].json` (a link never replaces a file already
  there), and a new file with `"unreadable": {"since", "keptAs"}` takes the ledger's name in one
  rename. The ledger's name is never removed first, since a crash between an unlink and the new
  file would leave no ledger, which reads as a new install at $0. A save that fails leaves the
  unreadable file in place and refuses (`LedgerBusy`); the next check finds the kept copy by its
  inode and makes no second one.
- **Unopenable** (something is at the path that can't be opened or read: permissions, an I/O error,
  a symlink to nothing): it may read again in a moment, so it is never set aside or replaced. A
  check raises `LedgerBusy` and the run is refused. A display read counts every limit as used up
  with a stand-in end of now + 24 hours and `known=False`; no line ever names that end as a time.

## The hold

For 24 hours from the mark's `since`, every `Spent` has `until` set and `full` is true, and
`session_budgets`/`daily_budget` count each budget as at least its own limit (`_counted`: USD, plan
runs, per-model session limits), so `decide()`'s existing comparisons put any priced run over. The
comparisons themselves are unchanged. A mark that can't be read becomes `since = now` (a string
`keptAs` is kept), and a `since` later than now also becomes now; either way the repair is saved
once, so the 24 hours start once. After 24 hours the mark is dropped. The windowed totals the lost
file held (daily total, outside budget, apps) have aged out by then.

## What each surface gets

- `GET /api/agent/spend` (`nebula spend`, `nebula context`, `get_spend_limits`) counts the daily
  total as a check does, so it shows the total used up with $0.00 left. During the hold it carries
  `ledgerNote` (the weekday sentence) and `ledgerHold: {until}`. While the file can't be opened it
  carries `ledgerNote` with the can't-open sentence and `ledgerBlocked: true`, with no time.
  `agent_start.spend_part` passes the same fields.
- Settings (`_outside_view`) gets `ledgerHold: {until}` or `ledgerBlocked: true`. While either is
  on it shows a line under the intro in the live form and reads "Counted as used up" in each row
  with a limit and "Amount unknown" in each row without one (every row while blocked). It reads the
  view again every 30 seconds and when the window is shown again, keeping the last view until the
  next one arrives, and stops when neither state is on. The live line drops "tomorrow" at local
  midnight and goes at the hold's end without a read.
- A waiting proposal's `wait` keeps `barLine` (the bar's line, with no time) and, when the run waits
  because of the hold, `ledgerHold: {until, line}`. `main._proposal_view` and `_proposal_brief`
  refresh it with `ledger_hold_now`: while a hold is on, its current end and line, otherwise what
  was stored. The bar and the Updates card add `line` after their own text until `until`; so does a
  waiting node's header description for screen readers (`lib/nodeWait.ts`). The CLI prints it
  after a waiting proposal while `until` is ahead (`formatter.ledger_hold_note`).
- One-time lines (the agent line, refusals, the nameless line) carry the weekday sentence inline.

## Sentences as shipped (GM - Design)

- Refused because the ledger couldn't be locked or read: "Nebula couldn’t check this run’s cost
  because {why}. Try again in a moment. {hint}", where {why} is one of "another Nebula on this
  computer is updating the spending record", "it can’t lock the spending record", "it can’t read
  the spending record or set it aside", or "the spending record is busy".
- Refused because the pricing table can't be read (agents only): "Nebula couldn’t check this run’s
  cost because it can’t read the pricing table. Error: {error}. {hint}", with the final period only
  when the error has none and no Error part when the error is empty.
- The hold, for lines written once: "Nebula couldn’t read its record of what agents have spent, so
  it counts every spending limit as used up until 3:40 PM on Sunday." The time is the computer's
  local time, 12-hour, minutes truncated, built by hand so the locale doesn't change it.
- The hold, live in Settings: the same sentence ending "until 3:40 PM." on the day it ends and
  "until 3:40 PM tomorrow." before that.
- Can't open: "Nebula can’t open its record of what agents have spent, so agents can’t start paid
  runs until it can."
- Row figures: "Counted as used up", "Amount unknown"; inside the outside agents' paragraph, "This
  limit is counted as used up." and "The amount spent isn’t known."

## Frontend cap

A saved `dailyTotalUsd` over `MAX_DAILY_TOTAL_USD` reads as unset (the $5 default), which is what
the backend enforces (`validate_daily_total` raises, `caps_from_settings` falls back to $5).
Settings then saves without the field and the 400 goes away. The constant lives in
`lib/spendLimits.ts` (no imports, so the settings store doesn't pull in pricing), and a backend
test compares it with the backend's.

## Known limits

- When the hold ends, a chat session's running total restarts from $0. Only the daily total still
  caps that chat's day.
- A display read that can't get the lock while a newly malformed mark is in the file shows an end
  that moves with each read, until a read or a check gets the lock and saves the repair.
- The person acts on a hold by accepting proposals (their runs aren't counted) or by deleting
  `agent-spend.json` by hand. There is no new surface for it.
- The Updates card's stored text (`canvas_proposals.update_text`) has no hold field of its own; the
  app finds the hold through the proposal's `wait.ledgerHold`.
- A hold that starts while Settings is open with neither state on shows the next time the panel
  opens: the 30-second reads run only while a state is on.
