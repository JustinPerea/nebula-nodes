# fix/ci-flakes (2026-11-02)

## 1. A closed canvas still counted as open (test_cli_apply arrange line)

**Cause.** `websocket_endpoint` in `backend/main.py` called
`manager.disconnect` only in `except WebSocketDisconnect`. Any other exit left
the socket in `manager.active_connections`, and `canvas_open()` (any socket
without an agent marker) went on saying a canvas was open. That's a real
product bug: `nebula apply --arrange` told the agent "The open canvas lays out
the 2 new nodes…" when no canvas was open. It lasted until the next broadcast
happened to fail on that socket.

The exit that leaked here is a **cancelled task**, not a failed send.
`test_websocket_sends_pins_after_graph_sync` reads graphSync and canvasPins and
leaves its `with` block while the handler is still in
`_settle_proposal_updates` / the canvas-notes send. Starlette's TestClient
then sends `websocket.disconnect` and cancels the task right after, so the
handler usually sees `CancelledError` inside `receive_text` (a probe printed
`CancelledError` from `starlette/websockets.py receive`). Builder #211's guess
("a socket that closes mid-send skips its disconnect") was close: the leak is
real, but it's the cancellation, not the send. Server shutdown and any
unexpected error take the same path in production.

**Fix.** `manager.disconnect(websocket)` moves into a `finally`, so every exit
leaves the manager.

**Proof.** `test_a_canvas_closed_mid_handshake_is_no_longer_counted_as_open`
(test_canvas_pins.py) holds the handler in `_settle_proposal_updates`
(`anyio.sleep_forever`) and closes the tab. That forces the cancellation
every time. Without the fix it fails; with the fix it passes.

**Repeats** (pair order `test_canvas_pins::test_websocket_sends_pins_after_graph_sync`
then `test_cli_apply::test_arrange_from_the_builder_and_in_the_reply`,
isolated): before **29 of 30 failed**, after **30 of 30 passed**. File order
(test_canvas_pins.py then test_cli_apply.py): 10 of 10 passed after.

## 2. Guard: no canvas socket survives a test

`tests/conftest.py`'s existing `pytest_runtest_teardown` hookwrapper (the
settings-path check) now also calls `_assert_no_canvas_socket_left`. After a
test and all of its fixtures (monkeypatch included) are torn down, it checks
that `main.manager` has no active or browser connections. If one is left, it
clears them and fails **the test that leaked**, not the next one that happens
to read `canvas_open()`. I chose it over a random-order CI job because it
costs nothing, runs in every shard and names the culprit. Without the fix it
flags `test_websocket_sends_pins_after_graph_sync` at once. With the fix, the
22 backend files that open `/ws` or build a ConnectionManager (740 tests) all
pass under it.

## 3. A descendant outlived Stop (test_agent_process sentinel)

**Cause.** `_freeze_and_kill_posix_tree` stopped only the root, then took a
`ps` snapshot before it stopped the descendants. Meanwhile the descendants ran
on. The test's grandchild wrote its sentinel after a fixed 0.8 s. A loaded CI
runner can take that long for the first `ps`, so the grandchild finished its
work before Stop froze it. Verification then passed, because the process was
gone by the time it checked. Repro: delay the first snapshot by 1 s, and the
old test fails every time with the CI message.

**Product fix** (`services/agent_process.py`). When the root leads its own
process group (every agent does: `spawn_agent_process` uses
`start_new_session`), one `killpg(SIGSTOP)` freezes the whole group before the
first snapshot. After the per-PID SIGKILL, a `killpg(SIGKILL)` makes sure a
group member that is no longer a descendant by PPID isn't left stopped. The
root isn't reaped yet, so its group ID can't have been reused. Both calls
tolerate a group that's already gone. They're skipped when the root shares our
own group (`_leads_own_group`). A setsid descendant is outside the group, so it
still relies on the snapshot loop, as before.

**Tests.** No timing anymore. Each descendant writes its PID file and then
waits for a `go` file before it writes the sentinel. The test waits for the
PID file (a state, not a sleep), runs Stop, creates `go`, then checks that the
PID is gone from `ps` (or is a zombie) and that there's no sentinel. A new
test, `test_stop_freezes_the_agent_group_before_the_first_slow_snapshot`,
releases the descendant as the first snapshot starts and makes that snapshot
take 0.5 s. It fails 3 of 3 without the product fix and passes with it.
test_agent_process.py: 30 of 30 isolated runs passed after.

## 4. Slow frontend ratchets

- **agentPresenceFollowups.ratchet G.** A count showed 38,956
  `resolveSource` calls, each a fresh `stat` and `readFileSync`, and 58,078
  `scopeOf` calls. Those, plus `parse`, keyed their caches on
  `` `${file}\0${source}` ``, which copies and hashes the whole text: about 3 GB
  of string hashing per run. I/O and memory pressure make that scale badly
  under load. Now each file is read once (`readSource`), `resolveSource` is
  memoized per import, and `parse`/`scopeOf` cache by file and then by the
  source string itself (`bySource`). `localsAt` is memoized per identifier
  node (a pure function of the node: one node, one parsed file, one scope).
  G went from 8.9 s to 4.4–4.6 s here, at load averages of 25–36. All 50
  tests still pass. What's left is the AST walk in `reachOf`, whose shared
  `seen` set makes it uncacheable without changing what it finds, so I left it
  alone. The 120 s limit stays, and its comment no longer claims 300 s.
- **clearsOnPromote.ratchet** exists only on PR #204's branch
  (fix/presence-followups-3), not on main, so it isn't changed here. The cause
  (profiled there): the first round-5 test pays for the shared scans inside its
  30 s limit. That's the Python backend scan `personGateRoutes.py` (about 4 s
  of CPU, 54% of samples) plus the whole-frontend parse in `callersOf`. Under
  load it passes 30 s; the later test, with the caches warm, takes 29 ms.
  Suggested fix for #204: warm both in a `beforeAll` with its own 180 s hook
  limit. The patch is in the coordinator's scratchpad,
  `pr204-clearsOnPromote-beforeAll.patch`. With it, the two tests take 248 ms
  and 26 ms.

## Out of scope / not changed

- services/person_gate.py, the read boundaries and the spend guard: untouched.
- /ws/chat already cleans up in a `finally`.
