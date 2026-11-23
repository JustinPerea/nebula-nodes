# chore/structural-test-budgets (2026-11-22)

Replaced wall-clock timing assertions in tests with structural checks that verify the same behavior without depending on host speed or scheduler latency. No product code changed.

## Sites updated

### 1. `backend/tests/test_mcp_channel.py`

- **`test_a_run_end_never_abandons_the_events_long_poll`**:
  - **What the old budget guarded**: `took < 1.0` after setting `ends["run_1"]` guarded that a finished tracked run nudges the pusher out of its idle wait and sends a `wake="run"` push promptly, rather than waiting for the 25 s events long-poll or `idle_off`.
  - **Replacement**: In `_listener_rig`, `fetch_events` now blocks on `anyio.Event().wait()` so it cannot return on a timer, `push` records `record["open"]` at the moment the push fires (`open_at_push`), and a tracked `sleep` wrapper records `(seconds, cancelled)` for every listener sleep. The test waits until `"run_1"` is in `listener._watching` and the pusher is parked in its idle wait (`seconds > 60`), then ends the run and asserts that `params["wait"] == mcp_channel.POLL_SECONDS`, `open_at_push == [1]`, `cancelled == 0`, `polls == 1`, the idle wait was cancelled by the nudge, and every completed sleep before the push stayed within `max(limits.run_gather, limits.agent_quiet, mcp_channel.MIN_POLL) + 0.01`.
- **`test_listening_never_blocks_a_tool_and_shutdown_leaves_nothing_running`** (same file, same pattern):
  - **What the old budget guarded**: `looked < 1.0` guarded that `look_at_canvas` does not wait behind an active 25 s events long-poll; `stopped < 2.0` guarded that closing the session stops the listener mid long-poll instead of waiting for the 25 s poll to expire.
  - **Replacement**: `_Journal` now tracks `events_open` and `events_timed_out`. The test waits until `nebula.events_open == 1`, calls `look_at_canvas`, and asserts `open_after_look == 1 and timed_out_after_look == 0`. After closing the session, it asserts `done and open_after_close == 1 and timed_out_after_close == 0`.

### 2. `backend/tests/test_agent_questions.py`

- **`test_a_wait_returns_as_soon_as_the_person_answers`**:
  - **What the old budget guarded**: `took < 3.0` on `?wait=10` guarded that posting the person's answers wakes the long-poll on the `question.answered` event instead of letting the wait run out its deadline.
  - **Replacement**: Wraps `asked.main._journal_wait` to record its return payloads, waits until `asked.journal.waiting >= 1` before posting the answer (replacing `asyncio.sleep(0.3)`), raises the request wait to `?wait=25`, and asserts `len(waits) == 1`, `waits[0]["timedOut"] is False`, and `[event["kind"] for event in waits[0]["events"]] == ["question.answered"]`.

### 3. `backend/tests/test_agent_questions_waits.py`

- **`test_nebula_down_from_the_start_fails_at_once`** and **`test_a_refused_first_connect_still_fails_at_once`**:
  - **What the old budgets guarded**: `time.monotonic() - started < 1` guarded that an initial connection refusal fails immediately without entering the retry backoff loop.
  - **Replacement**: Monkeypatches `mcp_server._sleep_unless_cancelled` to append durations to `sleeps`, and asserts `sleeps == []` alongside `api.calls == 1`.
- **`test_a_real_refused_first_connect_fails_at_once`**:
  - **What the old budget guarded**: `time.monotonic() - started < 1` against a closed local port guarded that a real `ConnectError` on the first poll fails immediately without retrying or sleeping.
  - **Replacement**: Counts calls to `mcp_server._canvas_call` and spies on `mcp_server._sleep_unless_cancelled`, asserting `calls == 1 and sleeps == []`.
- **`test_the_retries_stop_at_the_wait_budget`**:
  - **What the old budget guarded**: `0.9 <= took < 2.0` guarded that retries after an initial `OPEN` response continue up to `wait_seconds=1.0` and then stop.
  - **Replacement**: Injects the file's existing fake `Clock` into `mcp_server._time` (`SimpleNamespace(monotonic=clock, sleep=clock.sleep)`) and asserts `api.calls > 2`, `clock.now - 1000.0 == pytest.approx(1.0)`, and `sum(clock.slept) == pytest.approx(1.0)`.
- **`test_a_cancel_during_the_backoff_ends_the_call_at_once`**:
  - **What the old budget guarded**: `freed < 1.0` with a 3 s backoff guarded that cancelling an MCP `get_answers` call during retry backoff interrupts `_sleep_unless_cancelled` and releases the worker thread slot promptly.
  - **Replacement**: Sets `RETRY_FIRST_SECONDS` and `RETRY_MAX_SECONDS` to `60.0` (`wait_seconds=120`), wraps `mcp_server._sleep_unless_cancelled` to signal `in_backoff` on entry (replacing `anyio.sleep(0.4)`) and record whether the sleep exited via the event loop's cancellation exception (`"cancelled"`) or returned normally (`"returned"`), then asserts `sleep_outcomes == ["cancelled"]`, `_borrowed() == 0`, `alive`, and `api.calls == 2`.

### 4. `backend/tests/test_acp_session.py`

- **`test_opening_a_gemini_agent_never_blocks_the_event_loop`**:
  - **What the old budget guarded**: A heartbeat coroutine checked `longest < 0.75` while a fake `gemini` binary slept 1.5 s, guarding that `env.manager.open` runs the CLI probe off the asyncio event loop.
  - **Replacement**: Once setup finishes, a gate file causes the fake `gemini` script to wait until a release file appears (with a 200 x 0.05 s safety cap) and log `<arg>:released` or `<arg>:timed_out` to a trace file. Concurrently on the event loop, the test waits until `--help` has started, yields on the event loop five times (`while_probing == 5`), and then writes the release file. If the probe blocks the event loop, the coroutine cannot run to release it before the probe exits. The test asserts `while_probing == 5` and `"--help:released" in recorded and "timed_out" not in recorded`.

### 5. `backend/tests/test_iterator_execution.py`

- **`test_cancelled_batch_cancels_active_handler_and_keeps_completed_items`**:
  - **What the old budget guarded**: `asyncio.wait_for(started.wait(), timeout=1)` guarded against hanging if item 2 never started, but failed when item 1's image and manifest writes took over 1 s on a busy host.
  - **Replacement**: Races `started.wait()` against the `execute_graph` task using `asyncio.wait({waiting, task}, return_when=asyncio.FIRST_COMPLETED, timeout=30)`. If `execute_graph` finishes or raises before item 2 starts, the test fails immediately with the exception or `pytest.fail` instead of waiting for a timeout; if it stalls, the 30 s hang guard catches it and cancels `task` cleanly.

### 6. `backend/tests/test_agent_presence_agents.py`

- **`test_run_nodes_reports_skipped_placeholders`**:
  - **What the old budget guarded**: `mcp_server.run_nodes(wait_seconds=5)` gave `/api/graph/run` a 5 s window; if a busy host took longer than 5 s, the route returned `status="running"` without `skipped` or `outputs`, causing a `KeyError`.
  - **Replacement**: Passes `wait_seconds=mcp_server.MAX_RUN_WAIT` (300 s; `/api/graph/run` returns as soon as the task finishes) and explicitly asserts `payload["status"] == "finished"` and `tools.ran == [[free]]` before checking `payload["skipped"]` and `payload["outputs"]`.

### 7. `frontend/tests/pr198Fix25Held.test.tsx`

- **Tests 1 and 2 (`no answer for 150 ms` and `an answer at 149 ms`)**: Already converted to fake timers (`fakeClock`, `step`, `settleNoAdvance`) in commits `92b8cdad` and `ad58568d`. Under fake timers, `setTimeout`, `clearTimeout`, `performance`, and `Date` share one controlled clock, so `grey.at - held.at` is exact at 150 ms. Left as is.
- **Test 3 (`a slow try that fails again`)**: Previously remained on real timers with `vi.waitFor` and `sleep(HELD_LOOK_DELAY_MS * 2)`. Moved onto the same `fakeClock` / `step` / `settleNoAdvance` pattern and checks `log.events.slice(greyIndex + 1).find((event) => event.at >= h.timing.answered && !event.held)` so all three tests in the block are deterministic and free of real-timer sleeps.

### Additional site matching the same pattern: `backend/tests/test_moodboard_field_journal.py`

- **`test_a_long_poll_on_board_events_wakes_on_a_field_change`** and **`test_mcp_wait_for_canvas_change_returns_on_the_persons_field_change`**:
  - **What the old budgets guarded**: `result["at"] - written < 1.0` on a 20 s wait guarded that a board field write wakes the journal waiter rather than timing out.
  - **Replacement**: Both tests already wait for `journal.waiting >= 1` before writing and assert `not timedOut` and `events == ["board.fields"]`. Removed the redundant `< 1.0` wall-clock assertions.

## Sites left as is

No requested site had to be left unfixed for lack of a product hook. In `frontend/tests/pr198Fix25Held.test.tsx`, tests 1 and 2 were already using fake timers on `origin/main` and needed no further change. Other wall-clock checks found across `backend/tests/` and `frontend/tests/` (performance bounds, relative speedups, and subprocess timeouts) were left untouched. They are listed in a comment on the pull request that made this change.

---

# chore/structural-test-budgets-2 (2026-11-22)

Second batch of the same change: replaced wall-clock assertions that proved non-blocking, prompt, concurrent, or cancellation behavior with structural checks (event ordering, explicit gates, marker files, call counts, cancellation state, fake timers). No product code changed. The patterns below follow the first batch's: a health or look request that can only answer while a provable hold is in place, subprocesses that wait on each other's marker files, and hang guards labeled as hang guards rather than budgets.

## Sites updated

### 1. `backend/tests/test_mcp_nonblocking.py`

- **`test_a_wait_in_flight_does_not_block_another_call`**:
  - **What the old budget guarded**: `times["look"] < 1.5` guarded that an ordinary `look_at_canvas` answers while a 3 s `wait_for_canvas_change` is in flight — the wait does not run on the event loop and starve other calls.
  - **Replacement**: Order instead of a bound, as `_assert_look_never_queued_behind_the_waits` already does for the many-waits case: the test asserts `times["wait0"] >= 2.9` (the wait genuinely stayed in flight long enough to order against) and `times["look"] < times["wait0"]` (the look answered before the wait ended — impossible if it ran on the same loop).
- **`test_a_cancelled_call_ends_cleanly`** (parametrized over `wait_for_canvas_change`, `get_proposal`, `get_answers`, `describe_node`):
  - **What the old budget guarded**: `freed < freed_within` (1.5 s) guarded that a cancelled call gives its worker-thread slot back promptly instead of polling on to the wait's own deadline, and that it ends cancelled (a normal return makes the SDK answer twice and take the whole server down).
  - **Replacement**: `_FakeNebula` gained a server-level `gate`: every GET waits on `gate.wait(30)` when set, so the cancel notification provably lands while a request is in flight. The test counts `mcp_server._canvas_call` paths, asserts the cancelled answer is `"Request cancelled"`, asserts `_borrowed() == 1` (the worker still owns its slot while the gated request is held), then releases the gate and asserts the slot returns and `made <= 1` — the request already in flight may finish, but starting another would be polling past the cancel. The final `look_at_canvas` (`alive`) still proves the session survived. The 30 s monotonic loop is labeled a hang guard.

### 2. `backend/tests/test_project_open_event_loop.py`

- **The four ping tests** (`..._a_large_project_opens`, `..._is_reopened`, `..._a_stale_tab_is_recovered`, `..._a_graph_file_is_imported`):
  - **What the old budgets guarded**: `latency < PING_LIMIT` guarded that `/api/health` answers while a whole-graph validation holds — the check runs off the event loop.
  - **Replacement**: `slow_check` now carries `.started`, a `threading.Event` set while a slow check holds, and `.release`, which ends the hold. `_ping_during` raises the hold to 30 s (the hang guard), waits for `.started` in a worker thread, sends the ping, and only then sets `.release`. The check therefore holds until the ping has answered, so a ping that answers at all answered during the hold; there is no time window left. Other tests that use `slow_check` keep the 1.2 s hold. The tests assert `in_flight` (the open had not completed when the ping answered) and `during` (the check still held), plus the existing `not any(slow_check)` proof that validation ran off the loop. `PING_LIMIT` and `gc.collect()` are gone; the event wait's 30 s bound is a hang guard.
- **`test_an_open_that_will_be_refused_does_not_wait_for_the_check`**:
  - **What the old budget guarded**: `took < DELAY / 2` guarded that a refused open (stale revision, active run) does not wait out a whole-graph check it did not need.
  - **Replacement**: Removed. `assert not slow_check` already proves the structural fact directly — no whole-graph check ran, so there was nothing for the refusal to wait on; the wall-clock bound added nothing.
- **`test_the_unlocked_read_does_not_wait_for_the_catalog_lock`**:
  - **What the old budget guarded**: `time.monotonic() - started < 1` guarded that `read_unlocked()` returns while another thread holds the catalog lock — the open's threaded check must not wait on the lock the loop takes.
  - **Replacement**: The holder thread now sets `released` inside the lock before letting go (its `release.wait(30)` is a hang guard). The test asserts `not released.is_set()` when the read returns — a read that waited for the lock would always find `released` set. `holder.join(30)` bounds the cleanup.

### 3. `backend/tests/test_project_catalog_restore_fix2.py`

- **`test_a_loop_reader_never_restores_on_the_loop_or_waits_for_a_restore`**:
  - **What the old budget guarded**: `waited < 0.5` guarded that `_workspace_context()` answers while another thread holds `store._locked()` (a 1.5 s Timer released it) — a loop reader must not block behind a restore's lock.
  - **Replacement**: Same shape as the catalog-lock site above: the holder sets `released` inside the lock and waits on `release.wait(30)` (hang guard). The test reads `waited_on_lock = released.is_set()` right after `_workspace_context()` returns, then releases the holder, waits out the async catalog-reading task (`asyncio.wait_for(..., 30)`), and asserts `not waited_on_lock` plus the unchanged structural checks (old active project observed while restoration was pending, restore ran off the loop, workspace revision advanced).

### 4. `backend/tests/test_gemini_cli_setup.py`

- **`test_version_and_help_run_side_by_side`**:
  - **What the old budget guarded**: `time.monotonic() - started < 1.8` with two `sleep 1` probes guarded that `--version` and `--help` run side by side, not in series.
  - **Replacement**: A barrier in the fake `gemini` script: each invocation writes `started-<flag>` and exits only once the other's marker exists (its own 400 x 0.05 s bound fails a run that queued instead of overlapping). The test asserts `result.ran`, `acp_flag == "--acp"`, and that both `started-version` and `started-help` exist — neither subprocess could have answered before the other started.
- **`test_a_probe_already_running_is_not_started_again`**:
  - **What the old budget guarded**: `time.sleep(0.4)` hoped the first probe was running before the second look; `waited < 0.5` guarded that a second `g.probe` while one is in flight returns `checking` instead of starting another pair of subprocesses.
  - **Replacement**: The fake script writes `started-<flag>` for each subprocess and holds on a `release` file (own bound covers a hang). The test polls for both markers — `time.monotonic() + 30` labeled a hang guard — so the second `g.probe` provably lands while the first is running, then asserts `not second.ran and second.checking`, `"still checking" in note`, and `sorted(count) == ["--help", "--version"]` (exactly one probe's two subprocesses, never a third). `first.join(timeout=60)` bounds the cleanup.

### 5. `backend/tests/test_input_size_security.py`

- **`test_quick_measures_off_the_event_loop`, `test_a_graph_run_measures_off_the_event_loop`, `test_a_proposal_estimate_measures_off_the_event_loop`**:
  - **What the old budgets guarded**: `still_going and waited < 0.8` guarded that `/api/health` answers while an input measure's slow ffprobe holds — the measure runs off the event loop.
  - **Replacement**: `_slow_store_clip`'s fake probe sets `running` while it holds and waits on `release` (30 s hang guard). `_while_slow` waits for `probe_running` in a worker thread before the health request, so the health check can only answer during the probe's hold. The tests assert `held and still_going` (the probe still held, the measured request still in flight, when health answered).
- **`test_the_packet_pass_stops_at_the_deadline`**:
  - **What the old budget guarded**: `time.monotonic() - started < 3` guarded that the packet pass stops at `SIZE_PROBE_TIMEOUT_SECONDS` (0.5 s) instead of reading the whole fake stream (~5M lines for a million packets); `killed` checked ffprobe died.
  - **Replacement**: The fake's `delay=0.01` per line floors the read rate, so `process.read <= 75` is a deterministic bound on "stopped early" — the deadline plus slack — while `process.killed` keeps the enforcement check. A `read_after_deadline` counter was tried first and removed: a wall-clock deadline against timer-thread scheduling jittered the count by lines, the same flake this change removes.

### 6. `frontend/tests/saveFixStep.pr205r9.test.ts`

- **`a 10,000-node canvas with 50 snapshot steps: each node is measured once, within budget`**:
  - **What the old budget guarded**: `expect(took).toBeLessThan(1_500)` guarded that the undo walk measures each node once per content version (memoized), not once per snapshot step — a per-step measure would take minutes.
  - **Replacement**: Removed the timer; the check already in the test is the structural one: `measureShape.mock.calls.length === 1 + nodes.length + edges.length` (the root, each node, each connection, once). A measure-per-step regression makes it 50 calls a node — the comment now says so.

### 7. `frontend/tests/Inspector.paletteLoadFail.test.tsx`

- **`keeps Try again mounted and focused across a second failure, held 400 ms, and re-announces`**:
  - **What the old budget guarded**: A real-timer lower bound (`>= ~400 ms` around `wait`s) guarded that Try again holds `aria-disabled` for `PALETTE_LINE_MIN_MS` after a retry starts, so the failure line can't be tapped through while a second extract runs.
  - **Replacement**: The `pr198Fix25Held` fake-clock pattern (`vi.useFakeTimers` over `setTimeout`, `clearTimeout`, `performance`, `Date`; `step` / `settleNoAdvance` on `setImmediate`). The test asserts `aria-disabled` at `PALETTE_LINE_MIN_MS - 1` and its removal at exactly `PALETTE_LINE_MIN_MS` (`Date.now() - started === PALETTE_LINE_MIN_MS`), so the hold is proven against one controlled clock — no real-time window.

## Sites left as is (second batch)

No requested site needed product code. Out of scope per the task and untouched: performance and DoS bounds (`test_item_name_controls.py`, `test_agent_canvas_limits_r9.py`, the median in `test_canvas_pins.py`), the lower bounds in `test_mcp_nonblocking.py` (~line 200) and `test_mcp_channel.py` (~line 2491), `test_parent_watch.py` (~line 86), and `frontend/tests/agentPresenceFollowups.ratchet.test.ts`.
