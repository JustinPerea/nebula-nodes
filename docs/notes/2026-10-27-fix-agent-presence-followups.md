# fix/agent-presence-followups (follow-up to PR #195)

From review 23 of #195 (5 LOW) and GM's r24 rulings plus the 2026-10-27
answers. Base: main at cd593dea (the #195 merge).

## What changed

### L-1: the pin race (backend/main.py)

- `graph_write` now wraps every FENCE_BEFORE_ROUTE route in an async wrapper
  (`functools.wraps`, so FastAPI reads the same signature) that calls
  `_check_workspace_revision()` and then awaits the route. Awaiting a
  coroutine runs it up to its first await, so the check and everything the
  route does before its first await run in one synchronous step. The pin
  routes call `canvas_pins.add_in` / `remove_in` before any await, so a
  switch can't commit between the check and the write.
- No route can rely on the middleware's marker alone: the wrapper is how a
  route gets FENCE_BEFORE_ROUTE (it sets `GRAPH_FENCE_RECHECK_ATTR`), and
  `graph_write` refuses a sync route (it would run on a worker thread after
  an unknown wait).
- Routes that await before they write still check again in the step that
  writes, as before. The route-entry check is extra for them.
- Agents send no revision headers, so the extra check passes for them as
  before.
- docs/MCP-SETUP.md says the check runs twice. mcp_server.py, the CLI and
  SKILL.md are unchanged: agents never create or delete pins, and nothing
  else an agent sees changed.

### L-2: landings belong to their canvas (graphStore.ts)

- `PendingLanding.graph` is set to `canvasReplacementRevision` when the
  landing is sent.
- `lastSavedView` takes only landings from the canvas being cleared. It is
  read before the revision moves.
- `forgetLandingsOfReplacedCanvas()` runs at each of the four replacement
  sites (clear, sync replacement, `loadGraph`, `loadProjectGraph`), next to
  `noteCanvasReplaced()`.
- A step already held for a landing keeps its own reference, so its
  `settled` still answers.

### L-3: the kept note (canvasPinsStore, canvasPins, PinComposer, canvasPins.css)

The wording is GM's r24 item 1, verbatim and with the ASCII apostrophe as
GM wrote it:

- "Your note wasn't sent because the canvas changed first."
- "Your note wasn't sent because <agent> started opening “<project>”."
  ("an agent" when the agent isn't known)

How it works:

- `kept` is `{ text, line }`. The line comes from the follow that closed the
  dialog: a replacement, or Nebula's 409, gives "the canvas changed first".
- In the notice, the note sits on its own line inside a `<q>`, clamped to 2
  lines with an ellipsis (`-webkit-line-clamp`). Its `title` holds the full
  text. "Copy note" copies the full text.

GM's 2026-10-27 answers, as built:

- `compose` starts the dialog with `kept.text` (or else the draft), then
  clears `kept`, so the notice closes.
- × or Esc (`cancelCompose`) keeps the draft.
- An emptied field leaves an empty draft.
- Sending clears the draft.
- The notice's own × drops the note.
- Decided here, not by GM: a send that fails for another reason (not the
  409) keeps the text as the draft. GM said only sending drops it, and that
  send didn't go through.

### L-4: the ratchet, widened (tests/agentPresenceFollowups.ratchet.test.ts)

- Any name of a gated action (from `gatedGraphActions()`) counts in any file
  under src that imports useGraphStore (graphStore itself excepted). The
  file's comments and plain string literals are removed first.
- Each such file must do one of three things:
  - read the lock (`useCanvasLock(` / `refuseCanvasEdit(`);
  - be a DELEGATES entry (CinemaStudioView, CreateView);
  - be an ALLOWLIST entry with a reason (5 entries: chatCanvasClear,
    cinemaMotion, cinemaUploads, canvasProposalsStore, uiStore).
- The ALLOWLIST and DELEGATES entries are themselves checked: each still
  names a gated action and gives a reason.
- Review 23's six forms (A-F) are asserted to be seen.

Newly locked:

- EditorView's B, ⌘K, Delete/Backspace, M, I and O keys. The key is still
  taken, and nothing changes.
- useRemotionKeyboard's Delete and ⌘D. On cd593dea the ratchet found this
  third miss, which review 23's scan (.tsx only) couldn't see.
- ChatPanel's "Apply to @n2" uses `lock.act` and `refuseCanvasEdit`.
- ChatPanel's `/clear` uses `refuseCanvasEdit` (offline and following).

### L-5: a save already sent at a no-agent replacement (graphStore, projectStore)

- The keeper now takes the snapshot and returns the call that sends the
  copy.
- When typing was cut off, the copy is sent at once, as before.
- When only saves already sent on that canvas are left, the copy is sent
  once one of them is refused or unanswered.
- If they all land, no copy is made and no line is shown. Nebula had them
  before the replacement.

### GM r24 item 2: one disabled rule (styles/disabled-buttons.css)

- One rule for every button style that fills with the accent (or with
  danger, which is the accent), imported by App.tsx after
  slava-restraint.css.
- On `:disabled` or `[aria-disabled='true']`, hover included, it sets
  `--sr-surface-control` / `--sr-edge` / `--sr-ink-light` with
  `!important`.
- Round 23's per-reason overrides were removed from cinema-studio.css and
  create-studio.css. The rule now covers every reason.
- Ratchet: any CSS rule whose resting fill is the accent, on a button-like
  class (by name), must be listed in the shared rule. 15 classes today.
- The two GM named (Generate shot, Create's Generate) are asserted by name.
- PR #198 adds `[data-offline-neutral]` with the same tokens. Both can
  stand; when #198 merges, its offline-only rule is a subset of this one.

### GM MERGE ORDER: the offline banner

- #195 sets no banner position. `git diff cd593dea^1 cd593dea` touches no
  `.backend-connection` rule and no `BackendConnectionStatus` placement.
- The floating spot in r23-cinema-offline is main's
  `.backend-connection { position: fixed; top: 150px }` from PR #114 (App.css,
  rounds 13-16), which PR #198's studio row replaces.
- Nothing to remove here, and #198's row isn't built here.
- Live: the banner has no inline style and no placement of #195's
  (`data-placement="workspace"`, the stylesheet's fixed 150px).

### Review 23 GM items

- Same-title names: GM answered on 2026-10-27, so there is no node id.
  - `errorCopy.nodeNameList` groups same titles with a count and counts
    nodes, not groups: from 4 nodes in total, "4 nodes".
  - The failed-save lines (`changesNotSavedLine`, and through it
    `changesSavedAsCopyLine`) and both multi-delete toasts
    (`deleteNoAnswerLine`, `deleteServerErrorLine`) use it.
  - Groups keep the order their first node came in.
- The NOTE_KEPT constants are GM's r24 wording (above).

### Out of scope, fixed: chat Apply's `enhanceTargetId`

- `lib/canvasReplaced` counts replacements (`canvasReplacements()`).
- Enhance stamps the node id with the count when it is pressed, and the
  message carries `enhanceCanvas`.
- Apply shows only while the count is the same. After a clear, a load or a
  switch the button goes, and nothing is written into another canvas's n2.
- No new copy.
- Conservative: Undo of a clear brings the node back, but not the button.

## Tests that failed first (on cd593dea)

- Backend, tests/test_agent_presence_followups.py: 3 of 5 failed.
  - WINDOW: 201, pinned on B.
  - The delete in the window: 404.
  - The recheck attribute: missing.
- Frontend, 4 new files run on cd593dea's src (restored from a tarball
  after):
  - store: 6 of 10 failed. TWOCLEARS restored "typed for the OLD n1"; the
    4 KEPT cases failed; COPY-INFLIGHT made 0 copies.
  - surfaces: 5 of 7 failed. EditorView keys, Remotion keys, Apply
    following, Apply after a replacement, /clear following.
  - ratchet: 6 of 8 failed. L-4 found EditorView, ChatPanel and
    useRemotionKeyboard; the disabled rule was missing.
  - nodeNameList: 12 of 12 failed.

## Notes and surprises

- The live pin race over real HTTP (30 races, the note sent 0-29 ms into an
  agent's open of B): 25 landed on A, 5 refused, 0 on B. The exact window is
  proven in-process by the probe test; over HTTP, which of the two checks
  refused a given note can't be told apart.
- Thirty rapid agent switches make the canvas give up following ("couldn't
  follow it"), which is existing behaviour. The live script runs the race
  before the page opens.
- Offline, a disabled Generate shot has no tooltip: the lock gives a title
  only while following. GM's rule says the tooltip gives the reason. That is
  a question for GM, overlapping #198's offline actions.
