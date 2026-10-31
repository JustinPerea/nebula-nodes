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
