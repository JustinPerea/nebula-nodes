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
