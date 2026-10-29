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

## Fix round 1

From review 1 of PR #200 (6 LOW, 4 nits) and GM's visual review 1 with its
2026-10-27 answers (draft tied to its canvas; one colour treatment, not one
shape; canvas order on both placeholder-run lines).

### What changed

1. **The agent bar (GM bug 1).** The bar was held to the width it had as the
   follow started (`width` and `max-width` inline, `overflow: hidden`, and
   an ellipsis on the name), so "Second canvas" read "Secon…". Now it only
   never gets narrower (`min-width`) and grows to fit. `canvasFollow
   openingName` cuts a name past 24 characters in script (23 + "…"); the
   title and aria-label keep it whole. Live at 1280 and 1440: "Opening
   “Second canvas”…", nothing cut.
2. **The kept-note dialog (GM bug 2, review L-1, N-1).**
   - `PromptDialog` takes `multiline` and `confirmLabel`. The note uses an
     `AutoGrowTextarea` (one line, up to about 4, then it scrolls), opens
     with the caret at the end and nothing selected, Enter sends and
     Shift+Enter is a new line. Other prompts still select on open.
   - "OK" is "Send note"; "Cancel" stays.
   - The app-wide `::selection` rule painted the accent: removed, so text
     selection is the platform's own colour everywhere.
   - Draft scope (GM confirmed): when the canvas goes, a draft left closed
     (by ×, Esc or a failed send) becomes the kept note with its line, so it
     never starts another canvas's dialog unseen. The failed-send toast is
     cleared at the same moment.
3. **Cinema with a failed reference (GM bug 3).** Generate 2 was already
   disabled with the reason, but its outline style had no disabled look, so
   it read as live. It is now in the shared look; Generate shot and
   Generate N share one `blockedReason` tooltip, and the one reason line sits
   under their row.
4. **Offline tooltips (GM answer 1).** `errorCopy.offlineDisabledReason(verb?)`
   with GM's two strings (local until #198's shared helper lands; reconcile
   at merge). `canvasLock.act({ offline })` and `lock.title()` give it while
   offline (the following tooltip still wins). Cinema: Generate shot /
   Generate N / Generate all "generate", Send to motion "send to motion",
   + Add shot "add shots", the arrows "reorder shots", Remove shot "remove
   shots", the prompt "edit the prompt"; the rest the generic line. Opt-in
   per control: the app-wide offline tooltip is #198's.
5. **Chat Apply (GM answer 4).** Apply stays, disabled, with GM's tooltip.
   `noteCanvasReplaced(cause)` records what replaced the canvas (`opened`
   with the agent and project while following, `opened` with no agent for
   a person's own open, `cleared`, `changed`); `replacedSinceWrittenLine`
   gives "Codex opened “Second canvas” after this was written.", "Nebula
   opened …" and "The canvas was cleared after this was written.". An
   import or a file load has no GM line yet: "The canvas changed after this
   was written." (asked of GM).
6. **Full note on hover (GM answer 5).** The app has no shared tooltip
   component (only the rail's own CSS one), so the `title` stays.
7. **One disabled colour treatment (GM answer 6, review L-2, L-3).**
   `styles/disabled-buttons.css` has two lists:
   - unfilled (ghost and outline): transparent, label grey, outline at the
     edge's strength. The toolbar's Run, Ask, Duplicate and Delete, Cinema's
     outlined and rail buttons, Apply, the prompt dialog's buttons, the
     header Back, the Inspector's actions, the proposal bar.
   - filled: a grey fill (white at 0.10) and a grey label. The accent
     buttons, the danger confirms (`project-home__danger`,
     `prompt-dialog__danger`), white primaries (`project-home__new`,
     `project-switch-toast__back`, `project-home__edits-primary`), the mask
     painter's blue Save, and other solid fills.
   - Both set `opacity: 1 !important`, so neither each style's own dimming
     nor the lock's 0.6 stacks on them. Cinema's locked prompt is grey too.
   - Decided here: the outline is `rgba(255,255,255,0.12)`, not the label's
     grey. In the label grey (0.55) the disabled outlines outshone the live
     buttons beside them (Generate all against Run history). Asked of GM.
   - Measured live (label against what's behind it, opacity included):
     disabled labels 6.04:1 on the grey fill, 6.19-6.27:1 unfilled;
     enabled labels 17.55:1 (white primaries and Generate 2), 12.6:1
     (toolbar Ask). The disabled grey is about a third of the enabled
     label's contrast: clearly dimmer, still above 4.5:1.
   - The ratchet: every solid-filled button style must be in a list (two
     Commons light-theme buttons are excepted with the reason), and any
     button style with a disabled look of its own outside the shared file
     fails unless it is on `SWEEP_LATER`. That list holds the 42 rules this
     round didn't fold in, and it can only shrink.
8. **The selected shot card (GM note).** `.cinema-shots-rail__shot--selected`
   uses the node card's selected colour, `--node-category-color` (the rail
   sets the Cinema node's, cinematic #d9a441), never the accent.
9. **Canvas order and grouping (GM answer 3, review L-6).**
   - `CutOffSave.order` (the node's index on its canvas) orders the failed-save
     lines.
   - The delete lines sort by the canvas the delete was made on.
   - Both placeholder-run lines ("… changed while this was open" and the
     replay's "… changed … after the run was saved") use `nodeNameList`, in
     canvas order (`PlaceholderRunConfirm.canvasOrder`).
   - This replaces GM's round 11 item 1 (row order) and round 12 item 3 (a
     free node after the rows). Those two tests were changed to say so.
10. **A recovered copy is always named (review L-4, N-2).**
    - A copy that lands after another replacement shows its own line with
      Open copy (`showReplacementReport(report)`).
    - The saves that didn't land are added to it (each `PendingLanding`
      carries its saves).
    - A save that never answers releases the copy after 15 s
      (`landingsWithin`), the undo hold's rule.
11. **The ratchet (review L-5).**
    - Uses the TypeScript parser: comments and strings are not code, and
      bracket access by a string counts.
    - Store aliases are followed through re-exports.
    - New check G: in a file that reads the lock, a control whose handler
      reaches a gated action (through the file's own functions) must carry
      the lock, or sit in a locked fieldset. It found ModelNode's "Rerun with
      latest source", which is now locked. A drag handle may refuse in its
      handler. The palette's search input is allowlisted with a reason.
    - EditNode's Open Editor takes the lock.
    - The uiStore and cinemaUploads reasons are corrected.
12. **Curly ’.** The kept-note lines now use ’, as does every new string
    here. The failed-save and delete lines this PR regrouped keep their
    wording: their "Couldn't …" sentences are shared with dozens of
    siblings, so they belong to the app-wide sweep.

Agent-visible: nothing. No MCP tool, CLI command or agent-facing text
changed (the note, Apply and disabled looks are the person's UI), so
mcp_server.py, the CLI, MCP-SETUP.md and SKILL.md are unchanged.

### Tests that failed first (on ed7edaf5)

The four test files were run against ed7edaf5's `frontend/` (exported with
git archive into scratch, sharing node_modules): 37 of 60 failed. The rest
were controls, and the ratchet's own parser probes, which carry their own
scanner.
- r1: 21 of 24 failed (the bar, the dialog, selection, ’, the offline
  reason and lock, the disabled rules, the shot card, canvas order,
  EditNode).
- surfaces: 4 failed (Apply kept with its three tooltips, and its look).
- store: 7 failed (2 on ’, the draft scope ×2, the replacement cause,
  COPY-TWICE, COPY-HANG).
- ratchet: 5 failed (G found ModelNode; EditNode not locked; the two-rule
  look; filled styles uncovered; disabled looks outside the shared file).

### Surprises

- A reconnect after a backend restart can reload the page. The live script
  waits for it before going on.
- A fresh canvas closes the chat dock, but its messages stay (the panel
  stays mounted), so Apply with its tooltip is there when the dock is
  opened again.
- The live tooltips in the sign-off shots are drawn from each button's real
  `title`. Headless Chrome doesn't paint native tooltips.

### Fix round 1 gates

- Backend full suite: 11,686 passed, 71 skipped.
- Focused files: 225/225. errorCopy files: 173/173.
- tsc -b and lint: clean. Build: entry 405,787 B raw (limit 512,000).
- Full vitest under machine load: 7,009 passed and 116 failed in 48 files (95 were 5 s timeouts). Each of the 48 files rerun alone: 588/588 passed.
- Live (backend 8795, Vite 5795): 22/22 passed. 2 requests were blocked, both canaries, and none went toward 8000-8010 or 5173.

## Fix round 2

Review 2 of PR #200, built with GM's r3 answers (msgs/gm-pr200-r3.md).

### What changed

- **M-1, one grey.** Every listed dim label is raised to the normal ink
  (`--sr-ink`): the Cinema rail's add and remove, the shared and shot
  ref-add, swatch-add, chat Apply and the inspector button. "+ Add shot" keeps
  its faint dashed outline, but its label is normal ink. `--sr-disabled-edge`
  is now 0.06, the plain edge, so a disabled outline is never brighter than an
  enabled one. The ratchet measures every listed class (`disabledLooks()`):
  disabled label contrast must be lower than enabled, and the outline never
  brighter. `NO_LABEL` holds the image buttons (the variation and the Remotion
  anchor). `FILL_SHOWS_STATE` holds the four filled buttons whose fill carries
  the state (GM r2 answer 6). A test keeps each of them failing the label
  check, so the list can't hide a real miss.
- **M-2, the kept note and the draft belong to their canvas.** `kept` and
  `drafts` are keyed by project id. The dialog prefills only on that project;
  elsewhere it opens empty, and the interrupted note's notice (with Copy note)
  stays beside it until dismissed. A draft closed on purpose gets no line, and
  `DRAFT_LEFT_LINE` is gone. A send that had already failed keeps its own
  error line. A whitespace-only draft is dropped.
- **M-3.** `.canvas-undo-notice__action` and `.moodboard-board-toast__action`
  are in the filled list, and their hover is gated with `:not(:disabled)`. The
  ratchet's fill parser reads hex, rgb(), rgba(), hsl(), hsla() and gradients
  (first stop). A translucent surface (alpha under 0.5) is not a fill.
- **L-1.** `lib/imeComposing.ts` `composing()` covers `isComposing` and
  keyCode 229. CommandPalette and PromptDialog share it. The one-line prompt
  calls preventDefault on that Enter.
- **L-2.** Newlines survive end to end: `clean_text(multiline=True)` for pin
  text, `_cut_note` in agent_start, and `quote_note` in the CLI formatter. The
  canvas pin uses `white-space: pre-line`. Documented in MCP-SETUP.md,
  SKILL.md and the mcp_server docstrings. A reply stays one line.
- **L-3.** When the undo slot already names another recovered copy, the
  second copy's line goes to the message slot. Both copies stay named.
- **L-4.** The selected film-look chip and the selected variation use
  `--node-category-color`, which CinemaStudioView sets from
  `lib/cinemaCategoryColor.ts`. Disabled, they use the shared unfilled look.
  The checked Settings switch, disabled, uses the shared fill.
- **L-5.** The G check is rewritten to follow scope: binding elements,
  assignments, imports and one level into relative modules. The 17 bypass
  forms from review 2 are a corpus test, with the quiet controls as controls.
  The provider-switcher rows, the mask painter's Save and the Forget confirm
  take the lock.
- **L-6.** EditNode's Open Editor calls the new `uiStore.openEditNode`, which
  makes no graph writes. It stays enabled while following or offline. Inside
  the editor, the keys, clips and transport keep the lock. Live, the follow bar
  (in WorkspaceHeader) and the offline row (fixed, z-index 10000) both show
  above the editor. GM made the one-line read-only note conditional on both
  being covered, so it isn't added.
- **Nits:**
  - The opening name is a `<bdi>`, so in RTL the "…" lands at the logical end.
  - Names are cut by grapheme (Intl.Segmenter).
  - The tabs stay put: the follow bar's growth is published as `--follow-grow`,
    and the tabs offset by half of it.
  - A 200 that lands after the 15 s limit withdraws the "Couldn't save" line.
  - Apply's offline tooltip is offlineDisabledReason.
  - Run History's Rerun and Retry show the wait or reconnect tooltip.
- **Run history** stays live offline (checked live).

### Decisions

- The draft and kept keys are the project id, not the canvas revision, so a
  clear on the same project keeps the draft. That matches "remember their
  canvas" as a place.
- The channel wake line stays one line. Only the pin text keeps its newlines.
- BUTTONISH was not widened: it flagged swatches and dots.
- The Rerun offline tooltip uses the generic verb.

### Tests that failed first (on 4ba2e6b1)

- Frontend: 33 of 95 failed across the 6 focused files. Among them: EditNode
  enabled, 5 M-2 store tests, COPY-TWICE-BOTH, HANG-THEN-200, IME 229, the
  one-line prompt, the shared helper (ENOENT), the 3 L-4 tests, provider rows,
  mask Save, Forget, Run History, L-6, N-1/N-2/N-3 ('SPAN' vs 'BDI'), Apply
  offline and ink, G, locked-components, filled-covered, the M-1 contrast
  (disabled label 6.27 vs enabled 3.66) and the edge/hover test.
- Backend: 3 failed (TypeError on `multiline`; text flattened twice).
- Passed on head as controls: isComposing, the 409 refusal, hang-then-409.

### Surprises

- Under load, the M-1 contrast test passed alone but timed out in the full run
  (7.9 s). Its describe now has the same 120 s timeout as the G describe.
- In the editor, the offline row has `pointer-events: none`, so an
  elementFromPoint probe reports it as covered. The screenshot shows it on top.

### Fix round 2 gates

- Backend full suite: 11,689 passed, 71 skipped.
- Focused files: 95/95 (6 files). Wider focused set: 321/323 (the 2 pass
  alone). errorCopy: 474/474 across 21 files.
- tsc -b and lint: clean. Build: entry 406,778 B raw (limit 512,000).
- Full vitest at load ~24-35: 7,133 passed and 28 failed in 13 files. The 13
  files rerun serially: 208/222 (12 of the 14 were 5 s timeouts). Each
  remaining file rerun alone with a 30 s timeout: all passed.
- Live (backend 8795, Vite 5795): 13 of 16 checks passed, and all 3 misses
  were probe artefacts:
  - The variation buttons are images with no text, so their label contrast
    reads 1.
  - The first `.cinema-studio-toolbar__action` is Run history, which stays
    live on purpose.
  - The offline row has `pointer-events: none`, so elementFromPoint reports it
    as covered. The shot shows it on top of the editor.
- Blocked requests: 2, both canaries. None went toward 8000-8010 or 5173.

## Fix round 3

Inputs: review 3 and GM's rulings r1-r4 (build the M-2 and M-3 answers as
written). Base 7434346a.

### What changed, per item

- **M-1, newlines in pins.** `clean_text(..., multiline=True)` splits on
  `str.splitlines()`, so every Unicode break (U+2028, U+2029, NEL, \v, \f)
  reads as `\n`, and each line keeps its inner spacing. The channel pushes a
  pin's text with its lines inside `<pin>` (GM: "keep the break").
- **M-2, kept notes per project.** `kept` is now a list, one note per
  project, newest last. On another project a notice names the note's
  project ("Your note for “Alpha” wasn't sent because Codex started opening
  “Second canvas”."); on its own project the line is unchanged. Each notice
  has its own Copy note and ×. A failed send's error shows only on the project
  that sent it (N-3).
- **M-3, image-only buttons.** A disabled variation dims its thumbnail
  (opacity 0.45, grayscale) and its selected outline turns the shared grey.
  The selected Cinema chip uses the same grey. This is the image-only
  disabled look app-wide (GM).
- **LOW-1.** Run history's offline verbs: Rerun, Retry (failed) and Recover.
  GM approved the tooltips.
- **LOW-2, red Delete.** The shared grey disables it. The enabled red is now
  `--sr-danger-ink: #ffa395`, used by Delete and the dialog's destructive
  label. The first value, #ff968a, cleared the ratchet's 1.5x floor on black,
  but live on the toolbar's own surface it drew 8.8:1 against the grey's
  6.2:1 (0.70). The ratchet now measures the toolbar surface too. Live now:
  9.65 against 6.2.
- **LOW-3, the mask painter during a follow.** Brush, Erase, Size and Clear
  lock offline and while following, and a stroke is refused. The project
  bar sits above the painter's scrim: `.canvas-tabs-wrap[data-following]`
  has z-index 1002. The first live run caught a gap: the skin's more specific
  `body.app-slava-restraint .canvas-tabs-wrap` rule still won, so the scrim
  covered the bar. That rule now has its own `[data-following]` twin, and a
  test checks that every rule which layers the wrap has one.
- **LOW-4, trim editor.** Render Preview, Export… and the final export's
  Start lock offline and while following. GM's "Trim editor: fine" was read
  as approval of this.
- **LOW-5.**
  - `nebula watch` and event summaries stay on one line: a break shows as
    ` ⏎ `, and `data.text` keeps the note whole. `pin.resolved` gets a
    one-line summary too.
  - A pin card's text scrolls past about 12 lines (`nowheel`, so the canvas
    doesn't zoom).
  - The selected chip goes grey offline.
- **LOW-6, ratchet.**
  - Review 3's 17 bypass forms are caught, and 9 quiet forms stay quiet.
  - Components are identified by file.
  - Lock coverage is tracked per state (following or offline).
  - G now runs on every .tsx file.
  - The fill parser reads named colours, `color-mix`, `oklch`/`oklab`, `:is`
    and `:where`, layers and `var()` fallbacks.
- **Nits.**
  - N-5: the 1.5x margin applies to unfilled controls; filled ones show their
    state in the fill (GM r4). `prompt-dialog__confirm` (orange label) is
    exempt pending GM.
  - N-6: `start_here` keeps spacing, as `look_at_canvas` does.
  - The Cinema banner over Palette Strength belongs to #198, so it is left
    alone.
- **Presence pill on Projects home** (coordinator). It sat fixed at the top
  right and covered "New project" once the page scrolled. It now follows its
  header slot and scrolls away with the header. A reserved band was the other
  option, but it would keep an empty strip over the page and leave the chip
  floating over cards. The header owns the slot, so following it is the
  consistent choice, and the slot also reserves the chip's width. Live: home
  scrolled at 1280 and 1440 and to the bottom, then back to the top; the
  Cinema studio and Create view; no overlaps. Commons is off in this config.

### Doc correction

The brief's "nebula events / nebula wait" don't exist. The docs say
`nebula watch` (test_skill_examples_parse failed until they did).

### Left unchanged

Unfiled and '' project keys keep their round-2 behaviour. A note composed
with no project id is kept under '' and shows only on a screen with no
project, which is where it was typed.

### Surprises

- The ratchet's G check takes 4.8 s alone. In the full run at load ~28 it
  took 195 s and hit its 120 s timeout. It passes alone.
- A notice previews a multi-line note on one line. Copy note copies it whole.

### Fix round 3 gates

- Backend full suite: 11,694 passed, 71 skipped.
- Focused files plus every errorCopy test: 1,042 of 1,042 across 61 files.
- tsc -b, eslint, the inline-style and Slava scope guards: clean.
- Build: entry 407,758 B raw and 123,382 B gzip (limit 512,000).
- Full vitest at load ~20-28: 7,130 passed and 58 failed in 21 files.
  - The 20 files other than the ratchet, rerun serially: 294 of 294.
  - The ratchet with r3 alone: 39 of 39, with G at 4.8 s.
- Live (backend 8795, Vite 5795): 25 of 26 checks passed.
  - The miss is a harness error, not a failed check. The variations
    section's checks all passed first. Then the page reloaded on reconnect
    while the script was leaving the studio.
  - Blocked requests: 2, both canaries. None went toward 8000-8010 or 5173.

## Fix round 4

From review 4 (clean: 0 HIGH, 0 MEDIUM, 4 LOW, 7 nits) and GM's round 5
rulings and answers (scratchpad msgs/gm-pr200-r5.md).

### What changed, per item

- **GM 1, Send note.** It already greyed through the ghost rule
  (`prompt-dialog__confirm` is in the unfilled list); live it goes from the
  orange label (6.73:1) and orange outline (rgba(255, 90, 31, 0.34)) to the
  shared grey label (0.55, 6.26:1) and edge (0.06), opacity 1. The ratchet's
  "asked GM" exemption is now GM's rule: `ACCENT_GHOSTS` keeps the brand
  orange and requires the outline to carry the change (enabled edge at least
  1.25× the disabled edge; Send note's is 1.60 against 1.10). No other ghost
  or outline button changes only hue: every unfilled control's disabled label
  is at most 0.69× its enabled label, except Send note (0.93, the outline
  carries it). The rest above 0.8 are filled, where the fill shows the state.
- **GM 2, the red.** `--sr-danger-ink` is #ff887d (hue 5°, full saturation,
  lightness 74.5%): 8.03:1 on the selection toolbar's surface
  (rgba(20, 20, 22, 0.94) over black), 8.75:1 on a dialog
  (`--sr-canvas-elevated`), 9.07:1 on black. The shared grey is 6.19:1 on
  the toolbar and 6.26:1 on a dialog, so enabled is 1.30× the grey. Hover is
  #ff9a91 (same hue, L 78%): a brighter label, 7.86:1 against its own red
  tint. Drawn live: 8.01, 7.85 and 6.20. The dialog's destructive label uses
  the same token. #ffa395 (hue 8°, 9.7:1) is gone. The ratchet's
  "clearly dimmer" floor goes from 1.5× to 1.25× (GM: about 8:1 against
  6.2:1 is clearly above). It also checks the red's hue (6° or less), its
  ratio on the toolbar (7.8 to 8.5) and that hover is brighter.
- **GM 5, kept notices.** The note shows its own line breaks
  (`white-space: pre-line`), clamped to 2 lines. Runs of blank lines (and
  lines of only spaces) fold to one break for display (`keptNoteDisplay`), so
  the two lines show text. Copy note copies the note whole.
- **LOW-1, the stack.** The newest two show. "Show 7 more" (the real count,
  sentence case, no period, GM's answer) sits above them and opens the whole
  list. The list scrolls inside `min(40vh, 360px)`, opens on the newest, and
  each note keeps Copy note and ×. "Show fewer" closes it. The list closes
  itself once nothing is hidden, so a new note starts collapsed. Live with
  nine notes: collapsed top 523 (1280) and 623 (1440); open top 369 and 429.
  The project bar ends at 64 and the selection toolbar at 142.
- **LOW-2, mask stroke.** `onPointerMove` asks `canvasLockNow()`. A locked
  move ends the stroke and releases capture, and an effect ends it when the
  lock renders. Live: 6,024 painted pixels at the lock, still 6,024 after
  twelve more moves and the release, at 1280 and 1440.
- **LOW-3, swatches.** Cinema's palette inputs and the Inspector's palette
  colours keep their hue (GM's answer: the colour is the content). Locked,
  they get the rest of the image-only look: 0.45, the disabled edge, no
  filter, the default cursor, no hover change. Clicks were already inert
  (`disabled`). Variations stay greyscale. Live: following and offline in
  Cinema, offline in the Inspector, hover identical, and a click changes
  nothing.
- **LOW-4, the lock check (G).**
  - `aria-disabled` counts only with the handler's own refusal
    (`refuseCanvasEdit`, or `canvasLockNow()` in a gesture's move).
  - `readOnly` counts only on a textarea or a text-like input.
  - `disabled` counts only where it disables: a native control, a fieldset,
    or a component.
  - A fieldset covers only native controls outside its first `<legend>`.
  - A trusted parent prop (`disabled`, `readOnly`, `locked`, `props.locked`,
    `lock`) must really be a parameter, never a global.
  - `disable[A-Z]…` no longer counts.
  - A component or a non-control passes on a refusal only when every handler
    that reaches a gated action refuses on its own.
  - CommandPalette's two tag-wide entries are now `CONTROL_AT` entries, one
    per control, matched by a snippet of the control's own tag. A new palette
    button fails.
  - Review 4's corpus is caught: 15 forms, including a spread
    `aria-disabled`, a `<div disabled>` and a global `lock`. Seven locked
    forms stay quiet.
  - The tighter check found three real gaps, all fixed in code rather than
    allowlisted:
    - NodeLibrary's click refused only offline; it refuses while following
      too.
    - The Remotion timeline's drag ends wrote while locked (`disableDrag`
      was trusted by its name); each now refuses.
    - The Remotion selection box kept moving a layer mid-gesture after the
      lock started (LOW-2's twin); its move now ends the drag.
    - `SpatialAxisInput` takes `disabled`, which the properties panel passes
      along with its fieldset.
- **Nits.**
  - N-3: the store keeps one blank line of a run (`clean_text`), so agents
    see `a\n\nb`, not 278 lines.
  - N-4: the channel indents each later line of a pin two spaces (as the CLI
    does). A typed `‹/pin›` followed by "Nebula: …" can't start a line of
    the push. MCP-SETUP.md says so.
  - N-5: a kept note names its project as it is called now (from the project
    list); a deleted project keeps the name it had.
  - N-6: leaving the project a send failed on clears its error, so it never
    comes back later; the note waits there as its draft.
  - N-7: the Projects cover picker's image buttons get the image-only look
    while busy (greyscale 0.45; the edge stays transparent, since it is
    transparent at rest; the pinned one keeps a grey mark).

### Left

- N-1 (the presence chip's one-frame lag on Projects home): left. The chip
  is fixed and placed from script, so a compositor scroll always moves the
  header a frame before the chip. Placing on the scroll event instead of a
  frame later changes nothing measurable: the review's sampler reads before
  the scroll event fires either way. The real fix is to render the chip
  inside the header slot, which moves its card and list placement too. That
  is a separate change (offered).
- N-2 (a pin card under the Inspector) predates this PR (the card's layering
  is unchanged since 53e976c1). Issue draft: scratchpad
  msgs/issue-pin-card-under-inspector.md.

### Surprises

- The tighter G found SelectionBox's mid-gesture write, the same bug as
  LOW-2 in another editor.
- PinComposer now reads project names, so its test's wsClient mock needed
  `connect` (projectStore loads graphStore).

### Fix round 4 gates

- tsc -b: clean. Lint (eslint plus the inline-style and Slava scope guards):
  clean.
- Focused frontend: 540 of 540 in 41 files. This covers the PR's own files,
  every suite that renders PinComposer, the video-editor files and the new
  r4 file. errorCopy: 445 of 445 in 19 files.
- The new r4 tests fail on the old code: 8 of 13 fail with PinComposer and
  MaskPainterModal reverted.
- Backend (iso_presence.sh): 459 passed across the pin, channel,
  agent_start, round22/23 and CLI suites.
- vite build plus check-build-budget: 408,568 B raw and 124,024 B gzip
  (limit 512,000).
- Live (backend 8795, Vite 5795 with VITE_NEBULA_BACKEND_PORT=8795, real
  mouse and keyboard, nothing paid): every check passed across the final
  runs (Send note, Delete, kept, swatches, Inspector, mask). The first run's
  kept and Cinema misses were harness errors (the stack state carried over
  between widths; a stale selection). Blocked requests: 2 per run, both
  canaries; none toward 8000-8010 or 5173.

## Fix round 5

Review 5 (LOW-1 to LOW-4, N-1 to N-5) with GM's r6 bug and r7 answers.

### What changed, per item

- **LOW-1, the open kept list under a toast.** PinComposer sizes the open list
  to the newest whole notes under its cap (min(40vh, 360px)), writing
  `--kept-list-h`, and rests it on a note's top. canvasPins.css snaps each note
  to its top, so no position cuts a note at the top edge. The toast's 7 px
  crossing came from its `translateY(16px)` entrance. GM r7 asked for one
  motion app-wide, so all five notice-region toasts (project switch, asset
  trash, canvas undo, moodboard, project home) now enter with the same spring
  as a scale inside their own slot, with no slide.
- **LOW-2.** The Cinema swatch × offline: "You can remove swatches when Nebula
  reconnects." (+: "add swatches"; reference ×: "remove references"). The
  Inspector palette × takes `lock.act()`: following gives the follow reason
  ("Wait for “…” to open."), offline the remove verb, and it uses the shared
  grey. There is no run reason for it, so the order is follow then offline,
  as lock.act gives. Its enabled ink was ink-faint (0.2), dimmer than the
  disabled grey, so it rises to `--sr-ink`; hover goes red. The swatch × keeps
  its rgba(0,0,0,.7) bubble locked; only the × goes grey.
- **LOW-3, ratchet G.**
  - A refusal now counts per handler, and only when its result gates the
    handler: `if (refuse…()) return`, an if block ending in return, or
    `if (!refuse…()) call()`. It is followed through the file's own functions
    and imports. A guard after a gated call doesn't count.
  - `canvasLockNow().offline/.following` covers only that state.
  - `readOnly` in a spread counts only on a text-like field.
  - A `disabled`/`locked` name is trusted only as a parameter of the outermost
    function.
  - The first legend is found through fragments and expressions.
  - `onPointer*` on a native control needs its own refusal.
  - A component's `disabled`/`readOnly`/`locked`/`lock` (or a lock spread)
    counts only when the component resolves and reads that prop, or forwards
    its props onto an element.
  - Review 5's 21 forms and 2 more are caught, and 12 locked forms stay quiet.
    Review 2's `passed_down` form now has a local Toolbar that reads `lock`;
    review 4's quiet `component_disabled` is now caught (its quiet twin has a
    Fancy that reads `disabled`).
  - Real code: the same 22 findings, all covered by components that lock
    themselves or the listed per-control entries. No new allowlist entry.
- **LOW-4, the channel push.** A note of several lines goes on its own lines
  after `<pin …>`, every line indented two spaces, blank lines empty, and
  `</pin>` on its own line. A one-line note stays inline. The CLI's `pin_line`
  prints the same shape under the pin's line (`nebula pins`, `look`, `start`).
  Both share `note_block` (the channel keeps its own copy, `_note_block`, to
  stay standalone). MCP-SETUP.md and SKILL.md are updated.
- **N-1.** × moves focus to the next note's ×, else the previous one's, else
  back to whatever had focus before the notes (never `<body>`), else the
  canvas.
- **N-2.** Send note offline: "You can send notes when Nebula reconnects."
- **N-3, decision: store as typed.** Round 4's blank-run fold in
  `canvas_pins.clean_text` is reverted. The store keeps blank lines inside a
  note, so agents read what was typed. The 280-character cap bounds them, and
  only the canvas display (`keptNoteDisplay`) folds runs. Newline
  normalisation, trailing-space trim and control-character dropping stay.
- **N-4.** The context menu, the Inspector and project home Delete go to
  `--sr-danger-ink` (#ff887d) with a red tint on hover, and #ff9a91 when
  pressed. A shot's ×, a keyframe's Delete and a pin's Delete hover to
  #ff887d. None uses `--sr-danger` (the accent orange) on hover. The toolbar and dialog Delete
  are unchanged (rest #ff887d, hover #ff9a91).
- **N-5, the Remotion timeline.** The live drive found two desyncs. First, a
  drop ending while locked: the library writes it into the rows in place, and
  each block keeps its dragged position in its own state. Second, a drag under
  way when the lock starts: the library turns dragging off and drops the
  gesture without calling onActionMoveEnd, so the block stayed 96 px off.
  Nothing was written in either case. The timeline is now keyed on a redraw
  count (bumped on a refused drop) and on the lock state, and redrawn from the
  manifest. Live, the block returns to 180 px with startFrame 30.

### Left

- The filled destructive confirms (`project-home__danger`,
  `prompt-dialog__danger`, `asset-trash__button--danger`) still fill with
  `--sr-danger` (orange) at rest and on hover, per GM r2 answer 6 ("white on
  danger"). This is a question for GM, since r7 says orange is never
  destructive.
- A timeline lock start or end remounts the timeline, which resets its
  horizontal scroll.

### Fix round 5 gates

- tsc -b: clean. Full lint: clean.
- Focused frontend: 138 files (the PR's suites, everything that renders the
  changed components or reads the changed CSS, and errorCopy). 2007 passed;
  58 failed under load in 26 files, all timeouts or load-dependent waits.
  Those 26 files rerun alone: 477 of 477. The ratchet, r5 and round23Surfaces
  after the final timeline change: 82 of 82.
- Backend (iso_presence.sh): 337 passed across followups, channel, pins,
  proposals, agent_start and the CLI commands.
- vite build plus check-build-budget: 409,786 B raw and 124,477 B gzip
  (limit 512,000).
- Live (backend 8795, Vite 5795 with VITE_NEBULA_BACKEND_PORT=8795, nothing
  paid):
  - Kept list at 1280×800 with the "Codex opened" toast entering: 0 px cut,
    0 px overlap, and the toast never closer than 7.98 px across 228 frames.
  - Swatch ×, Inspector ×, Send note offline, every Delete hover and the
    timeline all passed.
  - Blocked requests: the 2 canaries only.

## Fix round 6

CI's red ratchet, review 6 (LOW-1 to LOW-3, N-1 to N-5), GM r8 (filled
destructive confirms) and GM r9's three answers.

### What changed, per item

- **CI, ratchet G over 120 s.** Each file is parsed once; `reachOf` is
  memoised per statement node (keyed by depth, own names and resolver), and
  the guard walk (`refuseCoverage`) per node and resolver. The whole ratchet
  file runs in about 10.5 s alone. The timeout is unchanged.
- **LOW-3, ratchet G misses and false positives.** A refusal now covers a
  gated call by where it sits, not only by a top `if (refuse()) return`:
  an earlier `if (G) exit` sibling, the else of `if (!G)`, the then of
  `if (G)` when the gate is negated, the false side of `G ? … : …`, the right
  of `G || …` and `!G && …`. G reads `!!`, `await`, `||`/`&&`, one-line local
  helpers, aliases (`const off = refuse()`, a binding of `canvasLockNow()`)
  and a lock's `.following`/`.offline`. Component forwarding counts only from
  a spread of the whole props or of a rest binding (minus the names pulled out
  beside it), onto a control, a fieldset or a component; type annotations no
  longer count as reads. The corpus test holds review 6's 5 misses and 10 more
  that must flag, and its 6 false positives (the helper form included) and 9
  more that must stay quiet.
  - Two real findings: Canvas `onDrop` had no handler guard (library,
    character and moodboard drops relied on the store gate alone); it now
    refuses first. RemotionTimeline's multi-statement `refused()` helper is
    inlined, so the guard is read where it gates.
- **LOW-1 and GM r9 answer 3, the Inspector's locked pickers.** "+ Add" takes
  `lock.act` ("Add a swatch" live, the follow reason, "You can add swatches
  when Nebula reconnects."). "Extract from reference" and every "Choose File"
  are labels around a disabled input: locked they carry `aria-disabled`, the
  lock mark (no pointer) and the lock's reason ("You can extract a palette
  …", "You can choose a file when Nebula reconnects."). `.inspector__file-button`
  is in the shared ghost grey, and its slava hover is off while
  `aria-disabled`. The order is follow, then offline: the Inspector has no
  run state, so there is no run form to put first (the run copy elsewhere is
  "Wait for the run to finish first.").
- **GM r8, filled destructive confirms.** Home's Delete, Delete forever and
  "Continue without them" rest on `--sr-danger-fill` (#ff887d) with
  `--sr-on-danger` (#1f1f1f, 7.1:1) ink, hover `--sr-danger-fill-hover`
  (#ff9a91, 8.1:1); disabled is the shared grey fill. Round 2's white on the
  orange is gone, and so are its three ratchet exceptions.
- **LOW-2 and N-1, accepted by design (GM r9 answer 1).** A note cut at the
  bottom edge of the open list while it rests mid-list stays: it is the
  usual sign there's more below. Only the top edge snaps. The list is sized
  once on open and when a note is added, never after a scroll and with no
  fade. So N-1's height change when a new note arrives in the open list is
  that re-size, by design.
- **GM r9 answer 2, motion by kind.** noticeRegion.css holds the toasts'
  spring (`--notice-spring`) and three keyframes:
  - `notice-surface-in` (scale 0.96 and fade, 420 ms): the proposal bar (and
    the run-later notice, which is one), the person-required notice, the pin
    error (now `.canvas-pin-toast--error`) and the kept stack when its first
    note arrives. The review flash keeps the entrance first in its list, so
    it neither restarts nor cuts it.
  - `notice-row-in` (height, padding, border and the gap above from nothing,
    with opacity; never a scale): a note kept while the stack shows, and the
    proposal bar's inline error line. PinComposer marks only newly kept
    notes (`data-entering`, until that row's own animationend), not the
    notes "Show N more" reveals; while it measures the open list it holds
    the expand, so the list is sized to whole rows.
  - `notice-fade-in`: under reduced motion every one of these and the five
    toasts fade (opacity only) instead of `animation: none`.
  - agentPresenceFollowups.r6 pins each surface to its kind and the
    reduced-motion fade.
- **N-2.** A multi-line note keeps its first line's leading spaces (only
  blank lines at either end go), in the store and the channel.
- **N-3.** The CLI's answered note: one line keeps
  `pin_1 on n4: "warmer" — resolved by Claude: "done"`; a multi-line note puts
  `— resolved by …` on its own line after the note, at the row's indent.
  MCP-SETUP.md and SKILL.md show both.
- **N-4.** ANSI and OSC escape sequences (and 8-bit CSI) are dropped whole
  before control characters are, so no `[31m` is left.
- **N-5.** The timeline keeps its horizontal scroll across a redraw (its key
  changes on a refused drop and on the lock). The old timeline's scroll is
  taken as it unmounts and set on the new one; the new grid's own report of
  0 as it mounts is ignored. Surprise, live: restoring from the last
  `onScroll` alone found 0, because the new grid reports before the parent's
  layout effect runs. The r6 test's mock now reports 0 on mount too.

### Left

- The wording batch from GM r8 ("Run This Node" → "Run this node", platform
  shortcut labels) is not in this PR.

### Fix round 6 gates

- tsc -b: clean. Full lint (inline-styles, slava scope, eslint): clean.
- Focused frontend: 118 files (the PR's suites, everything that renders the
  changed components or reads the changed CSS, Canvas, errorCopy). 1647 of
  1650 passed; the 3 failures were Settings.test.tsx under load, and that
  file passes alone (75 of 75). After the last timeline change the ratchet,
  r5, r6 and the timeline suites: 52 of 52.
- Ratchet file alone: about 10.5 s.
- Backend (iso_presence.sh): 339 passed across followups, channel, pins,
  CLI commands, agent_start and proposals.
- vite build plus check-build-budget: 410,355 B raw and 124,675 B gzip
  (limit 512,000); the built CSS keeps `interpolate-size` and the keyframes.
- Live (backend 8795, Vite 5795 with VITE_NEBULA_BACKEND_PORT=8795, nothing
  paid, the proposal dismissed): pickers, confirms, motion (frozen mid-spring
  with the Web Animations API) and timeline sections, 17 of 17; blocked
  requests the 2 canaries only.

## Fix round 7

Review 7 (LOW-1 to LOW-3, N-1 to N-4) with GM's r10 approval and r11
answers. GM r10 approved round 6 from the design side ("You can extract a
palette when Nebula reconnects." included).

### What changed, per item

- **GM r11 answer 2 and LOW-1, every leave.** `lib/noticeLeave.ts` is the one
  place a notice-region item leaves:
  - `useLeave(value, kind)` keeps the last value drawn after it goes, the
    element `inert` and marked `data-leaving="surface"` or `"row"`, until an
    animation whose name ends in `-out` ends on it; with none running (no
    region CSS, jsdom) it goes in the same commit, as before. A new value
    mid-leave brings it straight back.
  - `NoticeLeave` does the same for a toast its parent draws as
    `{x && <Toast />}` (project home's Undo, the asset trash's Undo in the
    Assets panel, Character and Moodboard studios, the board's Undo).
  - `useLeavingRows` keeps a row that went in its place among the rest, and
    re-renders when its collapse ends; `hold` keeps rows unmarked while their
    surface leaves with them.
  - noticeRegion.css draws every leave from three rules: a surface runs
    `notice-surface-out` (to scale 0.96 and opacity 0) on `--notice-exit`, a
    critically damped curve x(t) = 1 - (1 + 7t)e^(-7t) over 294 ms (70% of
    the 420 ms entry, no overshoot); a row runs `notice-row-out` (height,
    padding, border and the gap above to 0, with opacity), so the rows
    around it close up on the same curve; reduced motion runs
    `notice-fade-out` (140 ms) for both.
  - Wired: the proposal bar (and its error line, as a row), the run-later
    notice, person-required, the canvas notice and its late, message and
    save-paused lines (and the Studio notice, which is the canvas notice),
    the project-switch toast, the pin error, the kept stack (a surface when
    its last note goes, with that note still in it) and each kept note (a
    row), project home's, the asset trash's and the board's Undo toasts.
    Timed toasts leave the same way as ones closed with ×: the leave starts
    from the value going, whatever made it go.
  - Focus moves at the start: a leaving item is inert from its first frame,
    and the kept notes' × moves focus in the same commit.
  - The open kept list re-sizes when a note's leave ends (its row count
    changes then), never at its start. In the open list a note leaves as it
    arrives there, the mirror of answer 1: it fades out in place, then goes
    and the list is re-placed in the same layout pass. Surprise, live: a
    collapse there shrank the content under the list's fixed height, and the
    scroll, held at the bottom, slid the top row under the edge for most of
    the spring (up to 78 px at 1280x800). Outside the open list a note
    collapses.
- **GM r11 answer 1 and LOW-2, a note kept into the open list.** It fades in
  place (`notice-fade-in`, 200 ms, no height change) and PinComposer
  re-places the list in the same layout pass, so the list rests on whole
  rows in the frame the note appears. Outside the open list a new note
  still expands.
- **GM r11 answer 3, LOW-3 and N-4, destructive colours.**
  - "Clear canvas…" is neutral at rest, `--sr-danger-ink` (#ff887d) on a red
    tint on hover, #ff9a91 pressed (it was `--sr-error`, the accent orange).
  - Commons "Delete and purge" is a neutral outline at rest, its edge and
    label #ff887d on hover (over the accent hover every Commons button has),
    #ff9a91 pressed.
  - A result card's Delete hovers #ff887d (edge and icon) on the tint,
    #ff9a91 pressed (it was rgba(220, 50, 50, .45)).
  - The sweep found more and fixed them: the asset trash's buttons hovered
    amber (#f59e0b), now neutral; a character reference's × hovered the
    accent; the moodboard panel's remove #e0796b; the Remotion toolbar's
    Delete the accent; Settings' armed Remove key the accent; the legacy
    theme's three #F44336 rules; and the hard-coded tint and edge
    (rgba(255, 70, 60, .14 and .34)) are now `--sr-danger-tint` and
    `--sr-danger-edge`.
  - Two more surfaced late, both missed by a class-only scan because their
    class named no destructive word: a Commons keyword chip's × hovered
    `--sr-danger` (an alias of the accent orange), and the Assets panel's
    Delete shared `.assets-item__action`, whose hover is the accent. The
    chip's × is now `.commons-chip__remove` (danger ink on hover, ink-hover
    pressed); Delete adds `.assets-item__action--delete` (tint, danger
    ink). Every other button labelled Remove, Delete, Clear, Discard, Purge
    or Trash now names it in its class too (moodboard chips, the results
    comparison, a personal agent's Remove).
  - The ratchet holds it: every rule on a destructive class (danger,
    destructive, delete, purge, remove, trash, discard, clear) draws its red
    only from the danger tokens; a hard-coded red or orange, or
    `--sr-danger`, `--sr-error` or `--sr-accent`, fails. A second check
    reads the components: a button labelled with one of those verbs must
    carry a class naming it, so the stylesheet check can see its rules.
- **N-1, ratchet G.** A helper of several statements counts as a refusal
  when every truthy return happens only when G holds; `switch (G) { case
  true: return; }` guards what follows. Corpus: those two (and two more
  quiet twins) stay quiet; five wrong twins are caught. Review 7 is right
  that round 6's RemotionTimeline "finding" was a false flag: the old
  `refused()` helper was correct, and inlining it changed no behaviour.
- **N-2.** Both Inspector pickers refuse in their own onChange, so a file
  set on the input from outside, or picked just before the lock, uploads
  and extracts nothing.
- **N-3.** DCS sequences (ESC P … ST, and 8-bit 0x90 … 0x9c) are dropped
  whole, like CSI and OSC.

### Left

- The wording batch (not this PR): "Run This Node" → "Run this node",
  platform shortcut labels, toasts built as sentences end with a period,
  "Choose File" → "Choose file".
- A destructive button still takes the colours of any shared class it
  carries; the Assets Delete overrides the shared accent hover, but the
  ratchet doesn't check that a shared rule is overridden.
- Whole-folder md5 check: five pairs from earlier rounds are byte-identical
  (fix4 mask-stroke before/after at 1280 and at 1440, which suggests the
  stroke never drew in those shots; fix5 delete-inspector-hover 1280/1440,
  the same crop; r14 chat-clear failed/no-answer 1440; r11 modal
  Lightbox/ModelPicker 1440). Reported, not deleted. Round 7's 82 shots
  have none.

### Fix round 7 gates

- tsc -b: clean. Full lint (inline-styles, slava scope, eslint): clean.
- Focused frontend: 199 files, 2818 of 2833 passed; the 15 failures were
  in 10 files under load, and those files pass alone (267 of 267). After the
  late chip and Assets Delete change: the ratchet, r7 and the 35 suites that
  render or read the touched components, 608 of 608.
- Ratchet file alone: about 10.7 s.
- Backend (iso_presence.sh): 340 passed across followups, channel, pins,
  CLI commands, agent_start and proposals.
- vite build plus check-build-budget: 412,833 B raw and 125,537 B gzip
  (limit 512,000).
- Live (backend 8795, Vite 5795 with VITE_NEBULA_BACKEND_PORT=8795, nothing
  paid): exits 5 of 5 (surfaces scale 1 to 0.96 monotonically by 294 ms,
  inert from the first frame; a row collapses 80 to under 1 px with no
  transform; reduced motion fades at full height), open list 3 of 3 (0 px
  cut in every frame, on arrival and on leave), colours 4 of 4; blocked
  requests the 2 canaries only.

## Fix round 8

GM r12 approved round 7's exits and sweep, kept the open list's fade-out in
place, approved the asset trash's neutral Restore, and set the rule for red.

### What changed, per item

- **The rule (GM r12 answer 3).** Red: Delete, Delete forever, Purge,
  Clear, Discard, Trash, which remove something you can't get back just by
  adding it again. Neutral: a × that takes an item out of a field or list
  you're editing (chips, swatches, tags, references), because adding it
  again or Undo puts it back.
- **Ratchet.** "remove" is off the destructive list. A class naming
  "remove" takes no red, no orange, no danger token and no accent (new
  `removeColours`). The component check now reads a button's text when it
  has no aria-label: a button named Delete, Clear, Discard, Purge or Trash
  needs a destructive class, and one labelled Remove needs a remove class.
  The two forms it found that the round 7 check missed: Character Studio's
  Delete wore its Retry look (accent hover), and the mask painter's Clear
  was neutral.
- **Neutral now:** a Commons keyword chip's × (back from round 7's red) and
  a moodboard chip's ×, the same at rest, on hover (white) and pressed; the
  keyword ×s in Commons Evaluation and Review (they hovered the accent every
  Commons button takes; now `commons-button--remove`, and each is labelled
  "Remove <keyword>"); the Inspector palette × (--sr-ink, the ghost hover),
  which reverses round 6, in both themes; a shot's ×, a character view's ×
  and the board's "Remove from board", all of which Undo puts back (the
  shot through canvas Undo, the board through its Undo toast). r5's test
  that pinned a shot's × red now pins it and the palette × neutral.
- **Red now:** Commons "Discard unsaved changes" and "Discard changes"
  (`commons-button--danger`, they hovered the accent), the mask painter's
  Clear, Character Studio's Delete. The Settings confirm that removes an API
  key or revokes a connected app stays red (the key or the token can't come
  back by adding again); its class is now `settings__confirm--danger`, so
  the remove rule doesn't hold it, and it takes the lighter red pressed like
  every other red.
- **The square × beside "Delete and purge".** It isn't Commons: Commons'
  actions are Re-analyze and Delete and purge only. In round 7's shot it was
  the probe's result-card Delete, drawn beside the purge button with a "✕"
  instead of the card's own trash icon. That Delete removes the result, so
  it stays red. The harness now draws each control alone, with its real
  icon, and crops it alone.
- **Sweep.** Every button showing ×, ✕ or an X or Trash icon (68), and
  every one named with Delete, Clear, Discard, Purge, Trash, Remove or
  Revoke, checked against the rule. The rest are Close or Dismiss (neutral,
  not removers) or already right.

### Left

- The wording batch (not this PR) gains GM r12's Graph menu "Ctrl / ⌘ S" →
  one label per platform.
- A personal agent's Remove deletes a custom agent's settings and is
  neutral; it isn't a × in a field, and GM's lists don't name it.

### Fix round 8 gates

- tsc -b: clean. Full lint: clean.
- Focused frontend: 189 files (everything that renders a touched component
  or reads a touched stylesheet), 2802 of 2802. After the last CSS fix the
  ratchet and r5 to r7: 70 of 70.
- vite build plus check-build-budget: 412,833 B raw and 125,558 B gzip.
- Live (backend 8795, Vite 5795, nothing paid): colours 11 of 11 at 1280
  and 1440. Seven reds go #ff887d on hover and #ff9a91 pressed, seven
  neutrals take no red or accent at rest, on hover or pressed, the two chips
  match, and only the 2 blocked test requests went toward the dev ports.
  Surprise: the moodboard chip's hover never applied, because the base rule
  `.moodboard-analysis .moodboard-chip button` outranked it. The hover now
  has the same reach.
- Shots: 14, one per control (a cell crop is the same picture at every
  width, so it is shot once and measured at both). No duplicates; the
  whole-folder duplicates are round 7's five pairs from earlier rounds.

## Fix round 9

From 9936a2b3. GM r13 (the rule by action), GM r14 (review 8's calls and
the reduced-motion ruling), and review 8's LOW-1, LOW-2 and NIT-1 to NIT-4.

- **The rule (GM r13), verbatim at the head of the ratchet.** Red: it
  deletes a standalone thing (project, node, asset, result, agent, API key,
  app token), or wipes a whole surface (Clear, Purge, Discard). Undo doesn't
  change this. Neutral: it takes an item out of a list inside the thing
  you're editing.
- **Calls.** Red: a personal agent's Remove and Remove download (it deletes
  files), Moodboard Studio's Delete, the Commons region Delete, Discard and
  leave, Clear run history, the mask painter's Clear. The Projects and
  asset-trash "Delete forever" triggers and the Settings key and app Revoke
  triggers now carry the red class too (their look was already red or
  approved). Neutral: the shot and upload ×, Remove from board, chat Remove
  image, Remove accent N, and the clear-search and filter resets, each with
  a `__remove` or `__reset` class so the ratchet can read the kind.
- **Shot Undo (GM r13 item 3), a real bug.** Undo of a shot's × brought the
  shot back without its image or variations: shot media is the backend's,
  and the write that dropped the shot dropped it. `CLIGraph.removed_shot_media`
  now keeps what a dropped shot had (128, oldest out first, reset by clear
  and load, carried by clone and replace_with); the same shot id coming back
  gets it back. A client can't supply media for a new shot. Cmd+Z did
  nothing in Cinema Studio at all (the canvas's handler isn't mounted
  there); the studio now binds Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z outside text
  fields and dialogs. MCP-SETUP.md says what an agent now sees.
- **The ratchet (LOW-2)** is `tests/helpers/destructiveRule.ts`: controls by
  their words (text, aria-label, title, any case; button, Button,
  role=button; consts and forwarded labels), a kind from the class, every CSS
  rule checked by its last compound (attributes and nesting too) for hsl,
  oklch, named colours, every `--sr-accent*`, custom properties and orange
  fallbacks inside danger tokens, and each control through the cascade.
  Review 8's bypasses and false flags are corpus fixtures. 61 controls on
  the real tree.
- **NIT-1.** A leave also ends on `animationcancel` (a style change), on the
  Animation's own `cancel` event, or after its time plus 250 ms. Surprise:
  live, Chrome fires no `animationcancel` for `Animation.cancel()` from
  script, only the animation's `cancel`, so both are heard.
- **NIT-2.** When a leaving notice holds focus, focus goes to the next
  notice's first control, else the one before, else the canvas or the
  screen's `<main>` (given `tabindex=-1`), as the leave starts, before
  `inert` drops it.
- **NIT-3.** OSC, DCS, APC, PM and SOS (7- and 8-bit) go whole, past an
  inner ESC, ended by ST or BEL. Decision: one left unterminated runs to the
  end of its line, not the whole note, so the person's later lines stay
  (`say \x1bPlease` reads "say ").
- **NIT-4 (GM r14).** The CSS already did it (the reduced-motion leave is
  opacity only; the item unmounts at animationend). Now stated in
  noticeRegion.css, pinned by tests, and checked live frame by frame.

### Fix round 9 gates

- tsc -b: clean. Full lint: clean.
- Full vitest, three runs on a machine other sessions kept at load 25 to
  81. Run 1: 7226 of 7269; 33 of the 43 were 5 s timeouts, and all 20 files
  pass alone. The new ratchet block's cascade test (about 1 s alone) was
  one, so its describe now has the file's usual 120 s timeout. Run 2 (load
  81): workers failed to start and 8 files never ran, so it doesn't count.
  Run 3 (`--maxWorkers=6`, after the timeout fix): 7242 of 7269; 23 of the
  27 are timeouts, plus heldUndo.property seeds 31 and 32 and
  MaskPainterPortal's 50 ms chunk wait. All 13 files pass alone, and the
  property test passes 3 times of 3 alone. It reads only the graph store,
  which this diff doesn't touch.
- vite build plus check-build-budget and check-built-fonts: 414,784 B raw
  (+1,951 on round 8, noticeLeave's focus and fallback in the startup
  entry) and 126,183 B gzip; 13 woff2, no font CDN.
- Backend, every file that touches canvas_pins, the graph, undo or cinema
  (28 files): 1224 of 1225. The one,
  `test_graph_apply::test_an_edit_can_ask_the_canvas_to_arrange_its_new_nodes`,
  depends on test order and passes alone; neither it nor its code is in this
  diff.
- Live (backend 8795, Vite 5795, nothing paid; exits, openlist, undo,
  colours and leave9): 32 of 33, then leave9 alone 9 of 9 after the cancel
  fix. Undo of a shot's × brings it back whole after a reload and on the
  backend; 17 reds go #ff887d on hover and #ff9a91 pressed, 12 neutrals take
  no red or accent; a cancelled leave goes in 10 ms; × focus goes to the next
  notice's × or the canvas; under reduced motion the row holds 80 px and the
  stack top doesn't move for every frame to 148 ms, then the stack moves
  554 → 640 in one frame (165 ms); an entering row has its 80 px on its first
  frame.
- Shots: 24 fix9, each looked at. Cell crops are taken only for the controls
  this round changed. One new byte-identical pair: the reduced-motion "row
  gone" shot and round 7's stack at 0 ms show the same state (one kept
  note at 1280), and that is correct. The rest of the whole-folder pairs are
  earlier rounds'.

## Fix round 10

From 5e9df5ac. Review 9 (0 HIGH, 1 MEDIUM, 4 LOW, 3 NIT), GM r15 and GM
r16 (built as written).

- **MEDIUM-1, store raw, show stripped (GM r15 condition 1, r16 answer 3).**
  A note and an agent's reply are stored exactly as typed
  (`canvas_pins.typed_text`); `shown_text` strips them on every output: the
  API's pins (`public_pin`, note and reply), the journal and its summaries,
  the CLI (`pin_line`, `format_pin`'s answer, `note_block`, `one_line`), the
  channel push, and the canvas display (`pinDisplayText` in
  `lib/canvasPins.ts`: the card, the reply, the badge's label, the kept
  note's title, plus the display's blank-line fold). The 280 cap counts the
  shown text; the typed text may be 4× that (`RAW_TEXT_FACTOR`), so pasted
  escape codes can't grow the store without bound. Going back to "store
  stripped" is one line: `typed_text` returns `raw`. Review 9's fuzz is now
  `test_pin_text_as_typed.py` (12 output paths × 3,000 cases, plus the store
  byte for byte); the display's half is in the r10 frontend test.
  Surprise: there is no edit field for a stored note. The note dialog and a
  kept (unsent) note hold the person's own typed text, and Copy note copies
  it raw; if an edit field comes, it should load the stored raw text.
- **LOW-1 (GM r16 answer 4).** A kept shot carries a fingerprint of every
  field but its media (`_shot_authoring`, sorted JSON). A returning shot id
  gets its media back only on an equal fingerprint; otherwise it comes back
  idle, and the kept entry is dropped either way. "Dropped" is only the
  link: a test runs the whole loop and checks every file under the outputs
  folder is still there. MCP-SETUP.md says so, and (NIT-1) that kept media
  is lost when Nebula restarts.
- **LOW-2 (GM r16 answer 2).** × from the keyboard puts focus on the next
  notice's × (else the one before's), never on Undo, Run, Restore or
  Delete. A notice with no × takes focus itself (`tabindex=-1`). An empty
  stack goes to the "Recent projects" heading, else the canvas, else
  `<main>`. The r17 keyboard ring is unchanged. A test presses Enter twice
  and checks no action fires. #198's Projects stack needs the same rule
  ("first control: [Restore]" goes); that is #198's change, not made here.
- **LOW-3.** The leave fallback re-arms while an animation is still running
  or pending (up to 8 times, each for the time it has left), so a busy main
  thread can't cut an exit short. Tested with a fake clock and live with the
  thread blocked for 400 ms at ×.
- **LOW-4, the ratchet.** A control's words decide its kind first
  (`wordKind`: RED_SAYS, NEUTRAL_SAYS, and a reviewed list for words that
  mislead, like "Reset"); the class only confirms it. Added: `:focus` rules,
  hwb, lab, lch and `color()`, logical border properties, accent-color,
  -webkit-text-fill-color, colour inherited from a parent or a sibling or
  descendant rule, i18n keys, labels from another file and spread props,
  IconButton, MenuItem, `input type=button`, and labels where the action
  word isn't first. It sees review 9's 10 controls: six Resets and the
  Erase tool (neutral; the ones without a class saying so now have one,
  like `toolbar__zoom-reset` and `mask-painter__tool--erase`), the
  favourite toggle, Krea's Disconnect (red, GM r16 answer 1: the class was
  ghost) and an agent's Sign out (neutral). 72 controls on the real tree.
- **Sign out, checked.** `antigravity_agent.sign_out` stops Nebula using the
  Google login, stops that agent's running sessions, and asks Google's
  server to delete its stored login, the one thing signing in brings back.
  No settings, history, sessions' records or files are deleted. So neutral
  (`settings__button--neutral`).
- **For GM.** The favourite star is a toggle: its on state and hover use the
  accent, and the ratchet allows the accent for a neutral `aria-pressed`
  toggle's state. Run History's "Forget ID" trigger is now red (it deletes
  a recovery ID Nebula can't restore, like the key Remove trigger).
- **NIT-2.** Remotion's toolbar Delete and keyframe Delete go to #ff9a91
  pressed; so does the pin card's Delete note.
- **NIT-3.** The three trivially passing tests now fail on the old code:
  the two Cinema key tests check the handler fired before their negative
  checks, and the "value coming back mid-leave" test drives a real leave.

### Fix round 10 gates

- tsc -b: clean. Full lint: clean (after dropping an unused `createPortal`
  import left in the r9 leave test).
- Full vitest (`--maxWorkers=6`, load 34 to 41 from other sessions):
  7213 of 7279. The 66 failures were in 24 files, and 58 of them were
  timeouts; all 24 files pass when rerun on their own (427 of 427). One was
  this round's own: the r10 PinLayer render of 200 pins (about 1 s alone)
  now has a 60 s timeout.
- Full backend suite (no xdist): 11,726 passed, 71 skipped, 0 failed, in
  54 min. The order-dependent `test_cli_apply` arrange test passed in this
  order.
- vite build plus check-build-budget and check-built-fonts: 415,464 B raw
  (+680 on round 9) and 126,564 B gzip; 13 woff2 files, no font CDN.
- Live (backend 8795, Vite 5795, nothing paid; exits, openlist, undo,
  colours, leave9 and the new r10). Run 1: 36 of 40. Exits at 1440, the
  open-list frame check and NIT-4's paused frames failed because the
  harness pauses an exit's animation and steps through it, and under load
  the stepping ran past the fallback, which (as in round 9) doesn't wait
  for a paused animation. Undo stopped on two upload PNGs that an earlier
  cleanup had deleted. Reruns: exits, openlist, undo and leave9 21 of 21
  (exits needed a second try because the switch toast was slow to appear),
  then r10 12 of 12.
  - The stored note and reply match what was typed, byte for byte, in
    `state/projects/catalog.json`. Create, list and resolve answers have no
    control bytes. The card reads "Warmer sky at dusk / keep the beam crisp
    / end" with the blank lines folded, and the reply reads "Done bold and
    bell next line".
  - After the person deletes a node, "Deleted the node." [Undo] [×] shows
    beside the pin error. × then Enter puts focus on that notice's ×, with
    the ring. The second Enter dismisses the notice, the node stays
    deleted, and focus goes to the canvas.
  - With the main thread blocked for 419 ms at ×, the exit still reaches
    scale 0.96 and opacity 0 at 872 ms. The toast goes at 916 ms.
  - Krea Disconnect, Forget ID, both Remotion Deletes and the pin's Delete
    note are #ff887d on hover and #ff9a91 when pressed. Sign out, Erase,
    the camera, editor and toolbar zoom resets, and Reset panels stay
    neutral.
  - Shot Undo still brings back the backend's image and variations: the
    fingerprint matches the payload the canvas sends.
- Shots: 60 fix10, each looked at (contact sheets). Within round 10, only
  one pair is byte-identical: the key row's Remove and the armed Remove
  confirm, which look the same. The other matches across the whole folder
  are the same unchanged controls in round 8 and 9 crops, plus the shot
  removed state, which is the same as round 9's.

## Fix round 11

From ecb54ad4. Review 10 (1 MEDIUM, 2 LOW, 4 NIT) and GM's answers to its
questions (gm-r12r10-answers.md items 3 to 5), built as written.

- **MEDIUM-1, the journal's own fields.** `pin.detached` and
  `pin.reattached` put the stored (raw) note in `data.text`: `_detach` and
  `reattach` handed back the stored pin. They now hand back `public_pin`
  (shown text, no undo keys); the store keeps the raw note and its undo
  keys. The fuzz now covers both through the store (300 cases), and every
  pin event (added, resolved, detached, reattached, removed) through the
  routes, the journal and `GET /api/canvas/events` (60 cases each). Live:
  the events route, `nebula watch --json` and MCP `wait_for_canvas_change`
  return all four events for a raw note with no control byte, raw or
  escaped.
- **NIT-3.** `agent_start.pins_part` strips on its own (`shown_text`); in
  the fuzz with raw pins.
- **NIT-2, the cap (GM r12 answer 3).** Only what shows counts: characters
  as a person sees them (a base and its marks, a flag of two regional
  indicators, a skin tone) of the stripped text. The backend
  (`canvas_pins.text_length`) and the dialog (`lib/canvasPins.ts
  textLength`, `fitNote`) are the same rule, code point for code point,
  with one shared table of cases. Decision: a character takes at most 32
  marks, so 280 characters also bound the stored size (a Zalgo note can't
  hide in one character). Past 1,120 bytes of hidden text (what the strip
  drops, in UTF-8) the note is refused with GM's line, and the answer
  carries `code: note_hidden_too_long`, `rawBytes`, `hiddenBytes` and
  `limitBytes` beside `detail`. Over 280 shown keeps "280 characters or
  fewer". Surprise: the store cut every note at 280 UTF-16 code units, sent
  and received (a note of 280 flags arrived as 140, and a note with pasted
  codes was cut before the backend could refuse it); both now go by what
  shows. The dialog has no native maxLength now (it counted escape codes);
  it trims a paste to 280 shown characters, the way maxLength did.
- **LOW-1 (GM r17 item 1).** The off star hovers in neutral ink
  (`--sr-ink-bold`, as the other icon buttons do); the on star is the
  accent at rest and hovered. The ratchet checks a toggle twice: on, the
  accent may mark its state; off (its state class gone), not in any state.
  Round 10's shared rule is a corpus case it catches.
- **LOW-2 (GM r12 answer 4).** The fingerprint compares by value: integral
  floats are ints (exact, no epsilon; `true` stays `true`), a null, `{}` or
  `[]` is the field missing, key order never counts, and a missing
  `prompt`, `refImageUrls` or `overrides` is its default. Decision: an
  override inside `overrides` has no default of its own (missing means "the
  scene's"), so a set contrast never matches a missing one; GM's "contrast
  defaults to 1" example has no shot-level default to apply. Live: the
  reviewer's agent shot with `contrast: 1.0`, × then Cmd+Z, comes back done
  with its 2 variations; nothing on disk is deleted.
- **NIT-1 (GM r12 answer 5).** A hidden tab finishes a leave at once (at
  its start, or the moment the tab hides). A visible, stalled leave
  (late, paused, endless) waits out what it has left, up to 2.3 s from its
  start, then finishes with the reduced-motion fade (140 ms, ease-out) from
  where it stands, never a hard cut; the item unmounts and the space closes
  when that fade ends. Decision: focus still moves as the leave starts (GM
  r16 answer 2, review 8 NIT-2): the leaving item is inert from its first
  frame, so focus left on it would drop to `<body>`; the layout hand-off
  (unmount, the stack closing up) is what waits for the exit to finish.
- **NIT-4, the ratchet's label forms.** It reads an object's property
  (`L.del`), a function's return (`label()`, the call that is the label
  itself, not its arguments, and only on a button), an i18n key's words
  with short forms spelled out (`btn.rm` is "btn remove"), markup in
  `dangerouslySetInnerHTML`, an icon-only control's icon and handler names
  (`<Trash2 />`, `deleteProject`), a component imported from a file outside
  the set (read from disk), and menu item objects with any label form and
  any handler name. 72 controls on the real tree, no new findings. Not
  done: a colour that reaches a control only through `inherit` from an
  accented parent in a static rule; the cascade pass checks the real
  controls that way.
- **#198 follow-up (from round 10).** The Projects stack needs GM r16 answer
  2's focus rule; that is #198's change.

### Fix round 11 gates

- tsc -b: clean. Full lint: clean.
- Full vitest (`--maxWorkers=6`): 7294 of 7298. All 4 failures were
  timeouts, in 3 files (commonsEvaluation, modalStyles.round11,
  PlaceholderRunDialog.round12), none touched here; rerun alone, the 3
  files pass (14 of 14).
- Full backend suite (no xdist): 11,746 passed, 71 skipped, 0 failed
  (26 min).
- vite build plus check-build-budget and check-built-fonts: 416,723 B raw
  (+1,234 on ecb54ad4, as review 10 measured it: the note count and the
  stalled-leave fade) and
  127,110 B gzip; 13 woff2 files, no font CDN.
- Live (backend 8795, Vite 5795, nothing paid). r11: 12 of 12 after two
  fixes to the harness and one to the code. The hidden-tab check timed
  the timer, not the removal (it now polls frames: gone 17 ms after the
  tab hid). The refusal toast was missing because the store cut the note
  at 280 code units before sending it (the store fix above). Then exits,
  openlist, undo, colours, leave9 and r10: 42 of 42.
  - Events route, `nebula watch --json` and MCP `wait_for_canvas_change`
    all return pin.added, resolved, detached and reattached for a raw note
    with no control byte, raw or escaped. pin.detached `data.text` reads
    "look red and / c1  end / … / line  two".
  - Hidden-text refusal: 422 with the code, rawBytes 1,207, hiddenBytes
    1,205 and limitBytes 1,120 beside the detail. The toast reads
    "Couldn't save the note. This note has too much hidden text to save.
    Paste it as plain text, then try again."
  - The dialog keeps 280 flags (560 code units), keeps 60 escape codes
    plus 280 letters, and stops plain text at 280. It has no native
    maxLength.
  - Star: off is rgba(255,255,255,0.2) at rest and white on hover; on is
    the accent at rest and on hover.
  - Paused leave: gone at 2,495 ms, fading from 0.34 to 0 at a held scale
    over its last frames, not cut. A hidden tab finishes the exit at once.
  - The reviewer's contrast 1.0 shot, × then Cmd+Z: done, 2 variations,
    contrast 1. No file on disk is gone.
- Shots: 66 fix11 shots, each looked at. Byte-identical pairs:
  - The float shot before and after Undo. The scene is the same state,
    and the header reads "Saved" in both.
  - The neutral resets' hover and pressed crops. Nothing changes when
    pressed.
  - The key row's Remove and the armed Remove. They look the same.
