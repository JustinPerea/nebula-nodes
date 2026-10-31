# Moodboard Studio's Board view layout (fix/moodboard-board-layout, 2026-10-31)

A regression from #198. Open a board (`#moodboard/<id>`) and switch to Board (PREVIEW):

- at 1000 px the toolbar squeezed into one column, "Moodboard" wrapped one letter per line, and the rail and side panel collapsed;
- at 1600 px the toolbar still wrapped to two rows.

## Root cause (confirmed live on 1944d052)

#198 gave every studio its offline row (StudioOfflineRow, a grid row named `offline` under the top header). It did that with overrides in `styles/workspace-header.css`, not in each studio's own stylesheet. One of them covered two studios:

```css
body.app-slava-restraint .character-studio-view.character-studio-view,
body.app-slava-restraint .moodboard-studio-view.moodboard-studio-view {
  grid-template-rows: auto auto minmax(0, 1fr);
  grid-template-areas: "toolbar toolbar" "offline offline" "rail main";
}
```

- **Specificity.** At (0,3,1) it also matched the Board view (`.moodboard-studio-view.moodboard-studio-view--board`). It beat the Board view's own template in `moodboard-board.css` (`html body …--board`, (0,2,2)), whose comment says `html body` was there to beat the Slava skin.
- **Slava skin.** The winning template had no `board` or `panel` area, so the canvas and the side panel went into implicit tracks.
  - Chrome's computed grid at 1440 was `rows=127px 0 0 0 773px cols=250px 238px 320px 0 632px`: five row tracks and five column tracks for a template of 3×2.
  - The toolbar sat in a 488 px wide column, 127 px tall.
- **Skin class removed.** The Board view's own template had no `offline` area either. The offline row (App.css `.studio-offline-row { grid-area: offline }`, unscoped) went into an implicit row at the bottom, so it was broken there too.

The other studios were fine on 1944d052: the List view, Character Studio, Commons, Create, Cinema, Composition and the video editor. Each override in workspace-header.css matched only its own studio, and none of them has a variant with a template of its own. The Board view was the one variant.

## Design: each view's template is written once, in its own stylesheet, and only one template matches each variant

- **The overrides are gone.** workspace-header.css no longer sets a grid template on any studio root. Each studio's base rule now holds its full grid, offline row included:
  - character-studio.css, commons.css, create-studio.css, cinema-studio.css and remotion-editor.css;
  - moodboard-studio.css for the List view and moodboard-board.css for the Board view.
- **Studio children moved too.** Composition's toolbar row and its empty state's row (`grid-row: 4 / -1`) moved into remotion-editor.css, and so did Create's child areas into create-studio.css.
- **Values are what users saw on main.** The template values are those from the overrides, for example the `auto` header row in place of 44px. The only layout that changes is the Board view's.
- **The variants never compete.** The List view's template is `body.app-slava-restraint .moodboard-studio-view:not(.moodboard-studio-view--board)`, and its 760 px rule is scoped the same way. The Board view's template (`.moodboard-studio-view.moodboard-studio-view--board`, unscoped so it holds in either skin) is the only one that matches the Board view. `html body` is gone: there's nothing to outrank.
- **Board view grid.** It is now `"toolbar toolbar toolbar" "offline offline offline" "rail board panel"`, `auto auto minmax(0, 1fr)`. The header row is `auto` because the Slava workspace header is at least 48 px tall and wraps. The old 44px clipped it.

**Why this design and not "the skin rule sets only the row tracks":**

- A shared rule that sets only `grid-template-rows` still has to know each variant's row count. The Board view and the List view both have 3 rows today, but nothing would keep them in step.
- `grid-template-areas` can't be set per row, so the shared rule would have to stop at rows and leave the areas to each view anyway. That gives two places per view that must agree.
- With one owner per template, and a selector that matches exactly one variant, there is no cascade contest left to lose. The ownership ratchet below makes a new generic override fail CI.

**Left as it was:**

- The video editor is a flex column. Its offline-row margin rules stay in workspace-header.css, since they set no grid template.
- The StudioBoundary grid also stays there, because workspace-header.css is that component's own stylesheet.

## Ratchet: tests/studioGridAreas.test.ts

- **Resolution.** For each of 11 studio layouts, the test builds the root and its direct children as the app renders them (each child's class is looked up in its component's source). The layouts are:
  - Board view and List view;
  - Character Studio;
  - Commons, Commons with a reference open, and Commons Settings;
  - Create and Cinema;
  - Composition and Composition with no node;
  - StudioBoundary.

  At 1000, 1440, 1600 and 700 px, with the Slava skin class and without it, it cascades the app's stylesheets (helpers/cssCascade) and checks:
  - the winning template names an `offline` area;
  - it has as many row and column tracks as its areas have rows and columns;
  - every child that names an area finds it, a numeric `grid-row` starts inside the template, and no child is left to auto-placement.

  The Board view must also be a grid without the skin class, since its rules are unscoped.
- **Ownership.** Any rule whose subject is a studio root and that sets `grid-template-*`, `grid-template` or `grid` must sit in that studio's own stylesheet. A Moodboard Studio template must name its variant: `--board` in moodboard-board.css, `:not(.moodboard-studio-view--board)` in moodboard-studio.css.
- **helpers/cssCascade.**
  - `specificityOf` gets #204's fix. It now reads the selector's own nodes rather than calling `walk()`, which stopped the whole walk at the first `:is()`, `:not()` or `:where()`, so `.a:where(.b) .c` read (0,1,0).
  - Rules now record their `@media` queries. `cascaded(el, css, { viewport })` drops the ones that don't hold at that viewport (min/max width and height, with reduced motion, forced colours and anything unknown reading as off). Without `viewport`, nothing changes for existing callers.
  - Both have unit checks.
- **On 1944d052** (styles reverted, test kept), 3 tests fail: the Board view's resolution, ownership, and variant naming.
- **The old assertions moved.** tests/pr198Fix2Ui and pr198Fix3Ui read the offline row from workspace-header.css. They now read each studio's own stylesheet, and the Board view was added.

**Mutants.** Each one was applied to the fixed tree and then restored. Every one failed the ratchet:

| Mutant | Fails |
|---|---|
| M1: the #198 generic rule added back to workspace-header.css | Board resolution, List resolution (at 700 it beats the narrow template), ownership, variant naming |
| M2: `offline` dropped from the Board template | Board resolution |
| M3: `:not(--board)` dropped from the List template | Board resolution, variant naming |
| M4: `specificityOf` stops at `:where()` (the old walk) | specificity unit check |
| M5: `max-width` media always holds | media unit check |
| M6: Create's `stage` area rule removed | Create resolution |
| M7: `offline` dropped from Character Studio | Character Studio resolution |
| M9 (review 1): a `--board` variant template added to workspace-header.css | ownership (every root class and variant), view ownership, variant naming, Board paint |
| M10 (review 1): a `.commons-scope` template added to workspace-header.css | ownership (second root class), view ownership |
| M11 (review 1): a `grid-template` shorthand without `offline` in character-studio.css | Character Studio resolution (shorthands expanded), the no-shorthand rule |
| M12 (review 1): a 1200–1300 px List template without `offline` | List resolution (widths from the app's breakpoints) |
| M13 (review 1): a new `.foo-studio-view` with a #198-shaped override | view ownership (workspace-header.css sets no view template) |
| M13b: a new component rendering `<WorkspaceHeader>` that STUDIOS doesn't list | derived roots |
| M15 (review 1): cssCascade ignores `!important` | cascade unit check |
| M16 (review 1): cssCascade ties go to the earlier rule | cascade unit check |
| M17: a shared frame and paint rule on `.moodboard-studio-view` again | Board paint owned by moodboard-board.css |
| M18: an inline `gridTemplateAreas` on Character Studio's root | no inline grid on a studio root (and check:inline-styles) |
| M19: a same-specificity Board template in moodboard-studio.css | Board resolution (cross-sheet tie), variant naming, Board paint |

## Live check (isolated backend 8794, Vite 5794)

- **Isolation.**
  - Temp HOME, plus every NEBULA_* path: settings, state, output, moodboard, character, preset and Commons roots.
  - Key, token and secret variables were dropped. `VITE_NEBULA_BACKEND_PORT=8794`, and the Vite proxy was checked against the backend before the page opened.
  - Chrome ran with a dead proxy and a bypass for only 5794 and 8794. CDP blocked 8000–8010, 5173, 8840 and 5840.
  - Canaries first: 8000, 5173 and example.com failed, 8794 answered. No request left the two ports.
  - Puppeteer request interception wasn't used, because it breaks the page's cross-origin calls to the backend.
- **Data.** A project, five local PNGs uploaded through `/api/uploads`, one board, a Character, and a Cinema scene, Composition and video input node.
- **Grid check.** Every studio root's computed `grid-template-*` and its direct children came from `getComputedStyle`, with the same tests as the ratchet, under both skins:
  - Board view at 1000, 1440 and 1600, and at 1440 with the offline row open;
  - List view and Character Studio at 1000 and 1440;
  - Commons, Create, Cinema, Composition and the video editor (empty) at 1440.
- **Results.**
  - Before (1944d052): the Board view failed at every width under both skins.
  - After: 40/40 checks pass.
  - The offline row opens (health probe blocked) at 49 px and pushes the canvas down 49 px. It moves on `grid-template-rows 0.42s linear(…)`, the dock spring, and closes back to 0 in the Board and List views.
  - At 1440, the Board toolbar is 1440×49 (it was 488×127).
- **Shots** (scratchpad, `before-*` / `after-*`):
  - Board view at 1000, 1440 and 1600 under Slava; Board at 1440 without the skin; Board at 1440 with the offline row open;
  - List view at 1440 with the row open (after only);
  - Character Studio and List view at 1440.

  The md5 check found two duplicate pairs. They are the before/after shots of Character Studio and of the List view, byte-identical because those layouts did not change.
- **Without the skin class** the whole app is unstyled, since only Slava is supported (lib/skins.ts always adds it). The Board grid still holds there, but its unstyled header row is 186 px tall. Before, it was clipped to 44 px.
- **One transient.** In the first after-run, the Updates chip showed in the rail in the offline-open shot. The second run logged it in the header slot (1292,4) at 0.9 s and 2.9 s after the row opened, in both the Board and List views, and the shot shows it there. It was the chip re-placing itself while the shot was taken, not a layout fault.

## Gates

- `tsc -b --noEmit`: 0 errors.
- `npm run lint` (check:inline-styles, check:slava-css-scope, eslint): passed.
- Focused vitest, `--maxWorkers=2`, 111 files: every test that reads `src/` or styles from disk or uses cssCascade (focusRingCss, the error-copy sweep, the agent-presence ratchets and rounds, the pr198 UI tests, the line tests, Moodboard Studio's tests and the new ratchet). Result: 111 files, 1761 tests passed, Errors 0.
- `vite build` plus `scripts/check-build-budget.mjs`: passed at 444,245 bytes raw entry (limit 512,000).

## Round 2

### Fit already fitted the column; the round-1 1000 px shot was a narrowed window

- Fit on open (React Flow's `fitView`, BoardCanvas.tsx), the Fit button and Shift+1 (`fit()`), and an Update's Show all fit into the size React Flow measures for its own element. That element fills `.moodboard-studio-view__board`, the board's grid area. Measured live, the flow box equals the column box at every width.
- On d1621291, fresh opens at 1000, 1280 and 1440 (Slava) and 1440 (no skin), Fit after zooming away, and Fit with the offline row open all kept 9 cards of mixed aspect inside the column with room (17/17).
- On 1944d052, Fit also fitted the flow's own box; the broken grid put that box in the wrong place.
- The round-1 shot that GM read as cards under the panel at 1000 px was a board fitted at 1440 whose window was then narrowed: nothing refit on a resize. It is renamed `after-board-1440-then-narrowed-1000-slava.png`.

### GM (a): a fitted board refits when its column resizes

GM's ruling: refit on a column resize only while the camera is still where the last fit left it, so anyone who has panned or zoomed keeps their view; the existing fit spring; instant under reduced motion.

- **Fitted state** (`components/moodboard-studio/boardFitFollow.ts`). A whole-board fit (fit on open, the Fit button, Shift+1, a refit) makes the board fitted. Any other camera move ends it:
  - a person's pan, wheel, pinch or drag: React Flow 12.10.2 calls `onMoveStart` with the d3 source event for input and with `null` for programmatic moves (`createPanZoomStartHandler` in @xyflow/system; pan-on-scroll passes the wheel event). The camera's own spring frames and fit on open have no event, so they never count. This needs no comparison of numbers while the spring moves.
  - the zoom buttons and an Update's Show, which call `springTo(…, fitted = false)`. A Show frames only its cards, so a later resize keeps the Show's framing.
- **Column resize.** The size React Flow already measures (its ResizeObserver on its own element), read through `useStoreApi().subscribe`. No window events. The first size only records it (fit on open uses it). A new size while fitted schedules one refit on the next frame; more sizes in that frame join it, and the refit reads the size when it runs. Same size: nothing. A refit moves the camera, not the column, so it can't call itself.
- **During a continuous resize** each refit stops the running spring and starts the next from where the camera is, so there is only ever one spring. Live, over 20 steps from 1440 to 1000, the zoom only ever fell and ended fitted.
- **Not refit:** adding, removing or pasting cards, or an agent's add (as on main).
- **Kept for the visit.** boardCanvasStore keeps `fitted[boardKey]` beside the viewport: `springTo` stores its own flag, and `onMoveEnd` stores the follower's current state (a person's move has already cleared it at its start). A board that comes back from the List view starts fitted only if it was kept fitted.
- **Motion.** The existing fit spring (`springViewport`) and padding; under reduced motion `springViewport` applies the target at once.
- **Agents.** No agent surface reports or uses the board camera: `mcp_server.py`'s view tool and the CLI's viewport line are the main canvas's. An agent Update's Show goes through the same `springTo` as a person's Show, so it follows the Show rule.

Tests: `boardFitFollow.test.ts` (9) and `BoardCanvas.fitFollow.test.tsx` (13). 10 of the latter fail on d1621291; the other 3 (zoom buttons, Show and a restored not-fitted board keep the view) are guards.

| Fit mutant | Caught by |
|---|---|
| every move start counts as the person's | 2 tests (fit spring keeps fitted, pan then Fit) |
| a person's move is ignored | 2 tests |
| a Show counts as a whole-board fit | Show keeps its framing |
| no coalescing (refit on every size) | 6 tests |
| a restored camera always fitted | restored not fitted keeps it |
| a restored camera never fitted | restored fitted refits |
| reduced motion ignored | instant refit under reduced motion |
| refit without the spring | refit springs over several frames |
| the first size refits | 3 tests |

One mutant survived: `onMoveEnd` saving `!event && fitted` instead of `fitted`. The `!event` was redundant (a person's move has already cleared the state at its start), so it was removed.

Live (8794/5794, isolated, canary first; the 9-image board), 24/24:
1. Open at 1440, narrow to 1000: all cards inside the column, fitted. On d1621291 the same case leaves the rightmost card 176 px past the column.
2. Open at 1000, widen to 1440: refits.
3. Open, pan (wheel), narrow: the panned viewport is kept exactly.
4. Pan, Fit, narrow: refits.
5. Fitted at 1000, the offline row opens: refits into the shorter column; it closes: refits again.
6. Reduced motion: case 1 has landed 150 ms after the resize.
7. A continuous narrow over 20 steps: the zoom only falls, and it ends fitted.

### Review 1 (section 2)

1. **MEDIUM-1, shorthands.** The ratchet resolves each template longhand against the `grid-template` and `grid` declarations that also set it, in cascade order, and parses their areas, rows and columns (including `"a b" auto / 1fr 1fr`, line names and `auto-flow`). It also forbids both shorthands on studio roots outright: no root uses them, and longhands keep each template readable. M11 is killed by both.
2. **MEDIUM-2.** (a) Every component under src/components that renders `<WorkspaceHeader>` (other than with `offlineRow={false}`), `<StudioOfflineRow>` or `<SafeHeader>` must be one STUDIOS lists, or a flex screen in `NOT_A_GRID` (the video editor and the brand showcase, both checked to be `display: flex`). (b) Ownership is inverted: any template rule whose subject carries a `*-view`, `*-view--*` or `*-scope` class must sit in that family's owner sheet; a family no studio owns must keep its templates in one sheet; workspace-header.css writes none on any view. M13 and M13b are killed.
3. **LOW-1.** Ownership matches every class of a studio's root and any `--variant` of it (M9, M10). check-inline-styles now refuses inline grid props (`grid`, `gridArea`, `gridRow*`, `gridColumn*`, `gridTemplate*`). The video-editor/ exemption stays, since Remotion renderers need inline styles, so the ratchet also checks that no studio component sets a grid inline (M18).
4. **LOW-2.** moodboard-studio.css's shared `.moodboard-studio-view` frame-and-paint rule is now part of the List-only `:not(--board)` rule. The Board root is framed and painted by moodboard-board.css alone, under both skins, and a ratchet checks every one of those properties' winning sheet (M17, M19). Live, the List view and Character Studio are md5-identical to round 1; the Board at 1440 differs in 496 pixels, all inside the Updates chip (x 1307–1417, y 18–32), none on the board.
5. **LOW-3.** Unit checks for `!important` against a more specific normal declaration, and for a later rule winning a same-specificity tie (M15, M16). The helper documents that order across sheets is alphabetical, not the bundle's, and the ratchet fails when a studio template's top two declarations tie from different sheets.
6. **LOW-4.** Widths come from the app's own media queries: both sides of every min-width and max-width breakpoint, plus 700, 1000, 1440 and 1600, one width per distinct set of matching queries. M12 is killed. The ratchet now takes about 24 s (was about 3 s).
7. **NIT-2.** pr198Fix2's per-view regex was dropped: it passed for any rule naming the class, and the cascade check covers it for every studio, variant, skin and breakpoint.
8. **NIT-1** (no Board layout under 760 px) is GM's question. Nothing changed for it.

### Round 2 gates

- `tsc -b --noEmit`: 0 errors. `npm run lint` (check:inline-styles, check:slava-css-scope, eslint): passed.
- Focused vitest, `--maxWorkers=2`, 115 files (round 1's set plus Moodboard Studio's tests and every test that reads boardCanvasStore or BoardCanvas): 1817 tests passed, Errors 0.
- `vite build` plus the budget check: 444,245 bytes raw entry (limit 512,000).
- Round 1's live layout check on the final tree: 40/40.
