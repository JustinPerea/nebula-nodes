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
