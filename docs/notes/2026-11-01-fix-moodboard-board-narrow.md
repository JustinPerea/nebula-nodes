# Moodboard Board view in a narrow window, plus #209's fit follow-ups (fix/moodboard-board-narrow)

Cut from main 529665ef (#209 merged). GM's ruling on #209 NIT-1 (b), and GM's answers to #209 review 4's two questions.

## 1. The narrow layout (moodboard-board.css)

At 700 px the Board view had a 130 px board between a 250 px rail and a 320 px panel. The List view already folded at 760 px.

- **(Round 1; round 2 below replaces the 900 px query with a container query at 970.)** **Under 900 px** (`max-width: 899px`) the side panel moves under the board, in the board's column: areas `"rail board" "rail panel"`, rows `auto auto minmax(0, 1fr) auto`. It's in the grid's flow, not a drawer, so no open/closed state is added and the settings stay visible.
  - The panel keeps its own scroll (`overflow-y: auto`, already there) and is capped at `max-height: 40vh`, so the board keeps the rest of the height. Its left edge becomes a top edge.
  - 900 itself keeps the panel beside the board: GM said "under 900".
- **At 760 px and under** (`max-width: 760px`, the List view's own query) the template is one column: `"toolbar" "offline" "rail" "board" "panel"`. The rail is capped at 150 px with a bottom edge, the same values as the List view's 760 rule. Those List rules are scoped to the Slava skin; the Board view's are unscoped like the rest of moodboard-board.css, so they hold with the skin class removed too.
- **Order and focus.** The DOM order is header, rail, board, panel, and every template puts the board above or left of the panel, so the screen order is the DOM order and Tab follows it. No `order` or reordering anywhere.
- **Fit.** React Flow measures the board itself (its own ResizeObserver), so a breakpoint that resizes the board's column is a resize like any other: a fitted board refits on the spring (#209's boardFitFollow), and a moved camera is kept. Nothing new was needed in the fit code for it. Live, a board fitted at 1000 refits at 880 and again at 700.
- **Why a 40vh cap and not a scrolling main column.** With the column scrolling, the board would need a fixed height and the panel would sit below the fold; the cap keeps both on screen, and the panel already scrolled inside itself.

### The Studio header title (GM, #210 r1)

`workspace-header__title` had `overflow-wrap: anywhere`, which broke "Moodboard" inside the word at a narrow window. It's now one line: `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto`. This is the shared WorkspaceHeader, so every studio's title gets it.

The Updates chip already keeps its width in the header's right padding while it shows (workspace-header.css), so header content wraps before it reaches the chip. Live at 1000, 900 and 700 with a long project name and the chip showing: the chip overlaps no header control or the title (see Live).

### Tests

`tests/studioGridAreas.test.ts`, "the Board view in a narrow window", under both skins:
- the exact template areas at 1000 and 900 (beside), 899 and 761 (under), 760 and 700 (folded);
- the rail at 700: `max-height: 150px`, no right edge;
- the panel at 899 and 700: a top edge, no left edge, `max-height: 40vh`, scrolling; at 1000 no cap;
- the board before the panel in MoodboardStudioView's Board markup and in every template.

"The Studio header title": nowrap, ellipsis, hidden overflow, `min-width: 0`, no `overflow-wrap`.

The existing resolution check picks up the new 899/900 breakpoint by itself (both sides of every max-width).

## 2. #209 review 4 follow-ups

### LOW-1: a press with no pan during a refit (GM: the refit carries on)

- **Cause.** d3-zoom emits `start` on a right or middle mousedown (and a left one with Space held), before any movement, and React Flow calls `onMoveStart` for it. BoardCanvas stopped the spring there, leaving the camera mid-spring, unfitted.
- **Fix.** A move counts only when the camera changed. BoardCanvas keeps `seen`, the camera as it last saw it: set after each of its own `setViewport`s, when React Flow makes its camera, and on each outside move. A move callback with the camera still on `seen` is ignored, so the spring keeps running and lands on the fit.
- **Why this holds for real moves.** React Flow writes the transform to its store before it calls back: the d3 `zoom` event runs `onTransformChange` and then `onPanZoom`; pan-on-scroll's first event translates (an `internal` d3 event, which updates the store) and then calls `onPanZoomStart` (@xyflow/system 0.0.76, index.mjs 2690-2790). So a drag pan is caught at its first moved frame (`onMove`), a lone wheel notch at its `onMoveStart`, a pinch at its first `zoom`.
- **The caveat review 4 named.** While a button is held, d3 keeps the press point in the camera it had then. If the spring moves the camera before the first drag frame, that frame puts the pressed board point back under the pointer, a jump of however far the spring went in between. That's a grab keeping hold of what was grabbed, and GM's ruling asks for it ("only a real camera move stops the spring").
- **Exact comparison, not `sameCamera`.** "The camera changed" is a fact; a 0.3 px pan is a real move even though it's still within the fitted tolerance.
- **Tests** (BoardCanvas.fitFollow): a right, a middle and a Space+click press during a refit, released with no drag, each lands on the fit, stays fitted in the store and refits on the next resize; the same presses at rest leave the board fitted; a press followed by a drag stops the spring at the first frame that moves the camera, not at the press. The stand-in's pan test now moves the camera before `onMoveStart` for a scroll event, as React Flow does.

### Zoom buttons (GM: landing on the exact fit by any route counts)

- `boardFitFollow.leave()` (dropped the fit target) is now `aside()`: no spring heads to the fit and a waiting refit is cancelled, but the target stays. Fitted is still `sameCamera(camera, target)`, so zoom in and back out (or out and in) is fitted again, as a pan back onto the fit already was.
- **The kept flag.** `springTo` stores `fitted || follow.onFit(to)` for where it lands, so a zoom that lands on the fit is kept fitted for List and back.
- An Update's Show goes through the same path: a Show that happens to frame exactly the whole board counts as fitted. The fitFollow stand-in's `getNodesBounds` now returns one card's bounds for a one-card Show (it used to return the whole board for any set, which only worked while Show dropped the target).
- **Tests:** zoom in then out refits on a resize and is kept fitted; out then in, List and back, reopens fitted to the new column; in, in, out isn't fitted and keeps the view; the follower unit test for `aside()`.

### LOW-2: a drag's end resets the drag (N10)

BoardCanvas.test: after a card drag and after a selection drag, an arrow-key move is sent after `KEY_MOVE_SETTLE_MS`. With `dragging.current = false` removed from `endDrag`, both fail (N10 killed). The product already did this, so they pass on 529665ef.

### NIT-3: the kept camera is written once a gesture

- **Who reads `viewports`/`fitted`:** only BoardCanvas, with `getState()`: when it mounts (the camera to reopen at) and when React Flow makes its camera again. Nothing reads them mid-gesture, and no `useBoardCanvasStore` selector subscribes to them.
- **So:** `onMove` frames no longer write. The camera is kept at `onMoveStart` (one wheel notch reports nothing else, ever) and at `onMoveEnd`. A drag pan writes once, at its end; a scroll pan twice (first event, end).
- **Not lost:** a gesture's camera still unkept is kept when the view closes (a scroll pan's end comes 150 ms later, so List within that window), and put back from `seen` if React Flow makes its camera again before it's kept.
- **Tests:** write counts for a 12-frame drag pan (0, then 1 at the end) and for a notch plus a stuck-flag pan (1, still 1, 2 at the end). The two older tests that read the store right after `onMove` now end the gesture first, as React Flow does.

### #209's notes and PR body (NIT-1, NIT-2, NIT-C)

- **NIT-1:** #209's notes still called R9 equivalent under P22's name. R9 (clearing `springTarget` on the spring's last frame) is P21 in round 4, and P21 is killed. P22 and P23 (`heading` on landing and on the open fit) are the equivalent ones, because every camera move reaches onMoveStart or onMove. Corrected in the #209 notes file too.
- **NIT-2:** #209's PR body said "React Flow 12 passes a source event only for input, so the camera's own moves never count." That was round 3's mechanism. From round 4 the view marks its own camera moves (`ownMove` around `setViewport`) and classifies no move by its event. #209 is merged, so the body stays; this is the correction.
- **NIT-C:** the round 2 line "No timeout raised" now says round 4 later set an explicit 60 s.

### Cascade contract (review 4 LOW-A, NIT-A)

- **LOW-A.** The tie pin used `.b, .a` on `class="b a"`, where class-bucket order and selector-list order agree, so sorting by `rule.order` (M07) passed it. A second element, `<i class="a b">`, is checked too: its buckets come `.a` first, so only a sort by sheet position gives `['.b', '.a']`. M07 is killed. (Test-only: the product code at 529665ef already sorted by position.)
- **NIT-A.** The synthetic table asserts exactly 26 parsed selectors (25 rules, `.b, .a` is two) and that the escaped ones (`.md\:grid`, `.a\.b`, `.\31 23`) are among them.

### NIT-B: "Undo pressed while a step is still saving" (MoodboardStudioBoard.test)

- It ran past 5 s under load: real-timer `waitFor` polling plus a 50 ms sleep.
- Now `/edits` is answered by hand: each call waits until the test answers it, and the test waits on the call itself (`called(n)`, `answer(n)`). Nothing sleeps or polls. The one real `setTimeout(0)` left lets the Studio's own `setTimeout(0)` save run before the test checks the undo is still waiting. No timeout raised.
- Both tests in that block (the second was collateral in review 4's run): 96 ms and 42 ms alone.

## Mutants

Each was applied to the finished tree and restored; BoardCanvas/follower mutants ran against the six fit and Board test files, layout and cascade mutants against studioGridAreas.

| Mutant | Killed by |
|---|---|
| B1 a move callback with the camera unchanged still counts | the three press tests, press then drag, drag-pan write count |
| B2 own moves don't update `seen` | the same five |
| B3 an outside move doesn't update `seen` | camera made again under a moved camera |
| B4 every onMove frame keeps the camera | both write-count tests |
| B5 no keep when the view closes mid-gesture | stuck-flag pan, List and back |
| B6 camera made again ignores an unkept move | camera made again under a moved camera |
| B7 `aside()` drops the target (the old `leave`) | zoom in/out, zoom out/in + List, follower unit |
| B8 `aside()` doesn't cancel a waiting refit | follower unit |
| B9 a non-fit spring always stored unfitted | zoom in/out, zoom out/in + List |
| B10 `aside()` leaves `heading` set | follower unit |
| B13 a drag's end doesn't reset `dragging` (N10) | both LOW-2 tests |
| B14 `seen` not set when React Flow makes its camera | a press on a reopened moved camera writes nothing |
| B15 an unkept onMove isn't marked | camera made again; stuck-flag pan, List and back |
| B16 `onFit` always false | zoom in/out, zoom out/in + List |
| L1 no 899 rule / L2 899 → 900 / L3 760 → 759 | the beside/under/folded template tests |
| L4 panel row above the board row | the template test |
| L5 no 40vh cap / L6 no top edge | the panel test |
| L7 no rail cap | the 760 test (no skin; under Slava the List view's skin rule caps it too) |
| L8 the folded template keeps two columns | the resolution ratchet |
| L9 the title wraps anywhere again / L10 title not shrinkable | the header title test |
| L11 rail after the board / L12 panel before the board in the markup | the DOM order test |
| C1 `candidatesIn` sorts by `rule.order` (M07) | the synthetic table (the `class="a b"` tie) |
| C2 the parser drops the `.\31 23` selector | the exact parse count |

**Equivalent, one survivor:** B11, `keepCamera` not clearing `unkept`. After a gesture is kept, the only readers of `unkept` (the close and camera-made paths) would keep or put back `seen`, which is then the same camera the store already holds. B12 (springTo clearing `unkept`) survived the same way, so the clears in springTo and the open fit were removed instead.

## Live

Isolated backend 8794 (scratchpad harness serve_isolated.py, canary first) and Vite 5794 with `VITE_NEBULA_BACKEND_PORT=8794`; Chrome with a dead proxy, CDP blocking 8000-8010, 5173, 8840 and 5840. A project with a long name ("Desert light references for the autumn campaign shoot"), nine local images on one board, and one agent update so the Updates chip shows.

**67/68 passed.** blocked.log holds only canary lines and `canary ok`; no request left the two ports.
- Board at 1000 and 900: the panel beside the board (columns 250/430/320 and 250/330/320). At 700: rows 85/0/150/305/360, the rail 150 tall above, the board 700 × 305, the panel under it at the board's width.
- The Updates chip shows at 1000, 900 and 700, and overlaps no header control or the title. The title is one line (19.6 px, nowrap, ellipsis); the long project name cuts with its own ellipsis.
- In DOM (focus) order the board's controls come before the panel's at each width.
- List at 700, 900 and 1000: its grid unchanged.
- Crossing: fitted at 1000, then 880 (panel under) refits with the cards 33 px from each side, then 700 (rail folded) refits again, then 1000 refits; Fit moves nothing at each. A panned board keeps its exact camera across 900.
- LOW-1 live (review 4's repro): open at 1440, narrow to 1000, a right (and a middle) press 40 ms later, released after 30 ms. The refit lands on the fit (23, 326.575, 0.157442), the store says fitted, and a later resize to 1200 refits.
- Zoom in, then out: the store says fitted, and 1000 → 880 refits.
- **The one failure is expected:** without the skin class at 700 the board is 204 px tall, under the script's 300 px bar, because the unstyled header is 186 px tall (#209's notes: only Slava is supported; the grid itself holds). Slava at 700 gives the board 305 px.

Shots (scratchpad `boardnarrow/shots1/`, 11; md5 `uniq -d` is empty, each opened): `r1-board-{1000,900,700}`, `r1-list-{1000,900,700}`, `r1-header-{1000,900,700}` (the header with the long project name and the chip), `r1-cross-900-to-880`, `r1-cross-760-to-700`. No 375 shot (no phone-width checks).

## Gates

- `tsc -b --noEmit`: 0.
- `npm run lint` (check:inline-styles, check:slava-css-scope, eslint): passed.
- Focused vitest, `--maxWorkers=2`, from a non-empty zsh array: 125 files (#209's round 2 set, every test that reads src/ or styles/ from disk or uses cssCascade, every Moodboard Studio test, every test naming WorkspaceHeader, the agent-notes tests, boardCanvasStore): 2046 tests passed, no Errors line.
- `npm run build` with check-build-budget.mjs: passed at 444,245 bytes raw entry (limit 512,000), unchanged.
- Tests that fail on 529665ef: 17 (the press tests, press then drag, the zoom tests, both write counts, the follower's two `aside()` tests, all six narrow-layout tests and the header title test). The rest pin behaviour that was already right (LOW-2, the DOM order, presses at rest) and kill their mutants.

## Round 2: the panel folds on the board's width, not a window number (GM)

GM's ruling after round 1: 900 was too low, and the rule should follow from the result. The panel moves under the board whenever side by side would leave the board column under 400 px. It's a container query on the studio, not a viewport number, and the rail fold stays at 760.

### The rule

- **The arithmetic.** Side by side, the board column is the studio's width less the rail (250) and the panel (320). It is at least 400 when the width is at least 250 + 400 + 320 = 970. So **the crossing is 970/969**: at 970 the panel is beside a 400 px board, and at 969 it's under the board.
- **GM's measurements don't match the live layout.** GM measured the side-by-side board at "about 160" at 900 and "about 210" at 1000. Live, the board column is 330 px at 900 and 430 at 1000, which is 250 + column + 320 = window width, under both skins (round 1's run, and this round's at 1000: `250px 430px 320px`). The rule as GM wrote it (board column under 400) gives 970. If GM meant a different measure (the cards' area inside the fit padding, say), the crossing would move; the 400 constant is the one place to change it.
- **The container.** The Board root is now `container: moodboard-board / inline-size`, and the fold is `@container moodboard-board (width < calc(250px + 400px + 320px))`, with the calc naming each term. Container conditions can't read `var()`, so the root now holds `--mb-board-rail-w: 250px` and `--mb-board-panel-w: 320px`. The template and the panel use those tokens, and a test checks the calc's terms are exactly rail, 400 and panel, read from the root's own tokens.
- **Why the container is the root and not the board.** A container query styles the container's descendants, never the container itself. Querying the board column to move its sibling isn't possible, and it would loop anyway: moving the panel changes the board's width. The root is the studio, and the condition subtracts the rail and the panel, so it reads exactly as "the board column would be under 400".
- **Containment is harmless here.** `inline-size` containment makes the root a containing block for fixed-position descendants and clips them to it. The root is already `position: fixed; inset: 0` with `overflow: hidden`, so its box is the window and nothing moves.

### One template at every width above 760

- A container query can't change the root's own `grid-template-*` (the root is the container). So the template now holds both places for the panel: `"rail board panel" "rail under under"`, columns `var(--mb-board-rail-w) minmax(0, 1fr) auto`, rows `auto auto minmax(0, 1fr) auto`.
  - The fold only moves the panel: `grid-area: under; width: auto`, with the 40vh cap and a top edge in place of the left one.
  - The third column is `auto` and the panel is `width: var(--mb-board-panel-w)` (border-box). So the column is 320 while the panel is in it and 0 once the panel has moved, and the board takes it.
  - The `under` row is `auto` and empty, so 0 tall, until the panel moves in.
  - The toolbar spans the `auto` column with a flexible one, so it doesn't size it (CSS grid leaves items spanning a flexible track out of intrinsic sizing). Live at 969: columns `250px 719px 0px`, rows `85px 0px 455px 360px`.
- **At 760 and under** the template is one column, `"toolbar" "offline" "rail" "board" "under"`, and the panel is already in `under` from the container query (760 < 970). The rail cap is unchanged.

### helpers/cssCascade reads @container

- Rules record their `@container` preludes (`container`).
- `containerMatches` handles `width`/`inline-size` ranges (`<`, `<=`, `>`, `>=`), min-/max-width, and px or calc() sums of px. Anything else reads as not holding.
- With a viewport, a container rule applies only when an ancestor is an `inline-size` or `size` container with that name, at the container's width. That width is taken as the viewport's: the studio roots are `position: fixed; inset: 0`, and the ratchet checks the Board root's position and inset.
- The ratchet's widths now include both sides of every container breakpoint (969 and 970), and the "both sides of the app's breakpoints" check keys on container conditions too.
- New unit checks cover the parsing, the name, outside a container, and either side of the threshold.

### Tests (studioGridAreas)

- The threshold is rail + 400 + panel, from the root's own tokens, in that order. The container is `moodboard-board / inline-size` on a `fixed`, `inset: 0` root.
- Under both skins:
  - 970, 1000, 1100 and 1440: the panel is in `panel`, 320 wide, and the board column is at least 400 (exactly 400 at 970);
  - 969, 900 and 761: the panel is in `under` with `width: auto`;
  - 760 and 700: the folded template, one column, the panel in `under`, and the rail at 150 px with no right edge;
  - 969 and 700: a top edge, no left edge, 40vh, scrolling; 970, 1000 and 1100: no cap, and a left edge.
- Board first: in the markup, and on screen in both templates (the panel's area is right of the board or below it).
- On 8a84207f's CSS, 7 of these fail.

### Mutants (round 2, against studioGridAreas)

15 mutants, all killed:

| Mutant | Killed by |
|---|---|
| R1 the board minimum 300 in place of 400 / R2 `<=` in place of `<` | the threshold test, the beside/under test |
| R3 the fold as a viewport `@media` / R4 the root not a container / R5 the query names another container | the resolution ratchet, the threshold test, the beside/under test |
| R6 the panel token 360 (the calc still says 320) | the threshold test, the beside/under test |
| R7 the folded panel keeps its 320 width | the beside/under test |
| R8 `under` spans only the board column (`"rail under ."`) | the template tests (at 760 the run once came back all skipped under load; it was rerun alone and failed 4) |
| R9 the 760 template names `panel`, not `under` | the resolution ratchet, the 760 test |
| R10 the third column fixed at the panel's width | the threshold test (column template) |
| R11 the calc terms in another order | the threshold test |
| R12 no 40vh cap | the panel test |
| H1 cssCascade ignores @container | the beside/under and panel tests |
| H2 cssCascade ignores the container's name | the @container unit check |
| H3 `<` read as `<=` | the beside/under and panel tests |

### Live (8794/5794, serve_isolated.py, canary first)

**59/59 passed.** blocked.log holds only canary lines and `canary ok`, and no request left the two ports. Chrome reads the calc() in the container condition (the panel moves at exactly 969).
- **970:** columns 250/400/320, the panel beside the board. **969:** columns 250/719/0, the panel under the board at its width, the rail beside it. Both hold with the skin class removed too.
- **1000:** board 430. **1100:** board 530. **700:** the rail folded above, board 700 × 305, the panel under it.
- At every width the root is the `moodboard-board` inline-size container, the Updates chip overlaps nothing, the title is one line, and List's grid is unchanged.
- **Crossing:** fitted at 1100, then 970 (beside) refits, then 969 (under) refits, then 700 refits, then back to 1100 refits; Fit moves nothing at each step. A board panned at 1100 keeps its exact camera across 970.
- **Shots** (scratchpad `boardnarrow/shots2/`, 11, md5 `uniq -d` empty, each opened): `r2-board-{970,969,1000,1100,700}`, `r2-list-{970,969,1000,1100,700}`, `r2-cross-970-to-969`.

### Gates (round 2)

- `tsc -b --noEmit`: clean. `npm run lint`: clean.
- Focused vitest, `--maxWorkers=2`, from a non-empty zsh array: 110 files, 1,439 tests passed (every test that reads `src/styles` or `cssCascade`, plus the moodboard, studio, workspace header, agent notes, board fit and board canvas store tests).
- `npm run build` with the budget check: passed, 444,245 bytes raw / 136,427 gzip (unchanged: the change is CSS only).

