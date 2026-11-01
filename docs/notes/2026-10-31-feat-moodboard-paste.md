# Paste images into a moodboard with Cmd+V (feat/moodboard-paste, 2026-10-31)

Justin decided it: Cmd+V in Moodboard Studio adds the image files on the clipboard to the open board.

## What it does

- One `paste` listener on the document, bound while Moodboard Studio is mounted (App mounts it only when the Studio is the main view) and acting only while `isCurrent()` holds and the board has loaded. A `paste` event covers Cmd+V, Ctrl+V and the desktop app's Edit > Paste.
- It never takes a paste meant for a text field or a dialog (`isStudioPasteTarget`, the same check as the Studio's Cmd+Z). The board's notes, Name, Direction, Avoid, the colour fields, Image notes and private notes keep their normal paste. A modal dialog anywhere, a non-modal dialog inside the Studio, and a control outside the Studio's tree (the chat dock) all keep theirs.
- A paste another listener already handled (`defaultPrevented`) is left alone. Round 1 said a tab following an agent's switch refuses a paste this way. That was wrong: `hooks/useFollowingReadOnly` is mounted only by the canvas, never with the Studio. In the Studio nothing refuses either a drop or a paste while following. Paste behaves as a drop does. Whether the Studio should be read-only while following is Justin's question.
- **Files.** `image/*` files from `clipboardData.files`, or from `items` when a source puts the image only there (Chrome's screenshot path). They go through the drop path unchanged: `uploadFiles` -> `POST /api/uploads`, with its type and size checks and its error lines.
  - Board view: `dropFiles` with the board's paste target, placed by `lib/boardPlacement` (see Round 2).
  - List view: `handleFiles`, appended in clipboard order, one undo step.
- **A browser copy** (the file and HTML with an `<img>`): the file is taken and the HTML ignored. Pasted HTML, uri-lists and links are never fetched, stored or rendered.
- **Undo:** one step per paste, the same step a drop records.
- **A tab not connected as the person:** its paste is written, as its drop and Add Images are. `/api/uploads` reads the person gate only for `create_node`, and the board edits route takes anyone's edits. Without the person token the add is recorded as an agent's (`placedBy: "agent"`). Paste has exactly Add Images' lock state. The live check has both tabs adding with each (round 2 shots `r2-9a`, `r2-9b`; review 1's `09-unconnected-tab-paste.png`). Whether an unconnected tab's adds should be refused, or attributed differently, is Justin's question. No gate changed.

## Links: not built (their own PR)

The brief asked for http(s) image links to be added "through the exact backend fetch `nebula moodboard add <url>` uses". That fetch isn't in the backend. `backend/moodboard_client.py` downloads links in the CLI/MCP process through `commons.net.safe_fetch`, then uploads the bytes (decision D6; `test_the_backend_has_no_url_fetching_for_boards` guards it). Pasting a link would need a backend fetch route (reversing D6), a browser fetch (ruled out), or Commons' add. Justin decided it: a person-only route will download a pasted link through `commons.net.safe_fetch` (public http/https hosts only, the upload's checks) and add it like a pasted file, in its own PR after this one.

Until then, a clipboard that holds only http(s) links, as `text/plain` or only as `text/uri-list`, shows GM's line: "Nebula can’t add images from links. Copy the image itself, then paste it." Nothing is fetched or added. `webLinks` and `uriListLinks` take http and https only, with a `//` authority (`http:foo` is not a link). They take one per line and need every line to be one; a uri-list's `#` lines are comments.

## Round 2 (GM's rulings r1-r3, review 1)

**Copy.**
- Nothing to add: "There’s no image on the clipboard to add."
- Links only: the line above.
- An info line never replaces a toast with an action (GM r3 answer 1). With "Removed #n · Undo" up, the line isn't shown and isn't queued. It is still announced through a polite live region (`spokenLine`). The rule lives in `showInfoLine`, which both paste lines use. The Undo/Redo result toasts are the action's own and still use `showToast`.

**Placement: one helper, `lib/boardPlacement.ts`, for paste, Add images and drop (GM r2).**
- A tile never lands on another. Every tile keeps `DROP_GAP` (24) from every other, the batch's earlier tiles included.
- Paste and Add images (`aim: false`): each tile goes to the nearest free spot to the point (the pointer, or the middle of the view) where the whole tile fits in the visible board. The visible board is the board's rect at the current zoom, less a 16 px inset and less the toolbar row.
- When nothing fits, the tile goes to `nearestFreeAnywhere` (named `nearestFreeOutsideView` until round 3), the nearest free spot with no view to stay in, so it can straddle the edge. It is reported for the edge chip, and the view never moves on its own.
- Drop (`aim: true`): the first file stays where it was aimed if that is free. If it would cover a tile, it slides to the nearest free spot, even one partly past the view (round 3). That tile gets the chip only when it ends up wholly out of view. Its other files follow the free-spot rule, with the chip if any land not wholly in view.
- Sizes are the real tile sizes: `sizeFor(1, aspect)` from the aspect read before upload.
- The search is exact on any board (round 3 replaced round 2's 60-nearest-tiles cap, review 2 M1). See round 3 below.
- `BoardCanvas` hands every add a `BoardTarget` (`at`, `view`, `aim`): the drop handler, the Add images button and the `pasteTarget` ref.

**The edge chip (GM r2 answer 1), `OutsideChip.tsx`.**
- It sits on the view's edge nearest the first outside tile, with an arrow pointing at it, the tile's thumbnail, and "Added outside the view" or "N images added outside the view".
- It is a button. Its aria-label is the text plus ", show it" or ", show them". Pressing it frames the tiles on the board's fit spring (`springTo`), a pan the person asked for.
- It slides 8 px in from its edge on `--mb-board-spring`. With reduced motion it simply appears.
- There is no timer. It goes when pressed, when the person's pan or zoom puts every outside tile in view, on Esc (not Esc typed in a text field), or at the next paste or add.
- One polite announcement with the same words and a full stop.
- It stays whole inside the board, above the toolbar, the notice band and whatever notices are up. It measures `floatingBottomLimit` and the notice stack, and re-measures when the stack resizes.
- Pasted tiles are not selected. Today a paste can't select: an added card's placement id is provisional (`new-<id>`) until the server's comes back. GM asked to be told rather than have it built here.

**Toasts above the board toolbar (GM r1 item 6).** The board's toolbar Panel is now a bottom bar: it carries `data-bottom-bar`, and `useBottomBarClearance` publishes `--bottom-bar-clearance` from its measured top. The notice region's own CSS (`bottom: calc(var(--bottom-bar-clearance) + var(--notice-gap))`) then stacks every toast the gap above it, as the canvas bar, the composer and the timelines already do. Main had the overlap: the toolbar published nothing, so the region sat 24 px from the window's bottom, over Fit and Add images (round 1 shots 1 and 3). The List view and the other studios are unchanged. The hook clears the variable when the Board view unmounts, and only the Board view mounts it.

**One physical press is one paste (GM r3 answer 2).**
- A Cmd/Ctrl+V keydown with `event.repeat` makes the paste events that follow ignored. They are prevented and add nothing. The flag resets on keyup of V, Meta or Control, and a keydown without repeat clears it.
- Edit > Paste from the menu sends a paste with no keydown, so it always adds. So do separate presses.
- Backstop, in case the shell's key events aren't reliable: each pasted file's signature is its size, type and SHA-256 of the bytes (`fileSignature`). A file identical to one still uploading from an earlier paste is dropped from the new paste, and a different file always goes through. Signatures are released when that upload ends.
- The desktop shell (`desktop/main.mjs`) sets no application menu, so Electron's default menu is the one in use. Its Edit > Paste has role `paste`, which calls `webContents.paste()`: a trusted paste event at the focused element, with no keydown. It is not intercepted by `before-input-event` or a global shortcut. I checked this by reading the code; the desktop app was not launched.

**The toast's deadline survives the Board/List switch (GM's round 2 check).**
- GM saw the links line still up in shots r2-6 to r2-8d. A traced live rerun showed why. The field pastes reached the paste listener but stopped at the text-field guard: none called `showInfoLine` or `showToast`.
- The line came from the r2-5 paste (toast 2, shown at 9.3 s). Each view renders its own `BoardUndoToast`, so the switch to List at 14.9 s remounted it, and the remount restarted the 6 s timer. r2-8d (19.7 s) still showed it.
- Now the deadline belongs to the toast: a WeakMap keyed by the toast object the Studio holds. A remount keeps the time left. A new toast, or leaving one after holding it, gets the full `BOARD_TOAST_MS`.
- On the rerun after the fix, the line is gone from r2-8a on.

**Review 1's other items.**
- Tests were added for the five unguarded paths: items-only clipboard, a control outside the Studio, a modal, loading, and List undo. Tests were also added for a non-modal dialog, ftp:// and ws://, `http:foo`, uri-list links, and a listener-leak check that spies on add/removeEventListener.
- The List append test now waits on the draft state, not the save debounce.

**Pre-existing, not in this PR:**
- The Board view grid breaks under `app-slava-restraint`: the board and side panel overlap, and the rail is 0 px tall. #209 fixes it. It shows in every Board shot.
- The header title breaks inside the word ("Moodbo / ard"). That one goes on GM's follow-up list.

## Round 3 (review 2, GM's r4 answers)

**Exact placement on any board (review 2 M1).** Round 2 took candidate edges only from the 60 tiles nearest the wish. On a big irregular board the edges around the real gap in view belonged to other tiles, so a paste went outside with the chip although the view had room. Now the search reads rows. Each tile rules out an open rectangle of top-lefts (its box grown by the gap and the new tile's size). The nearest allowed point has its y on the wish's row or a rectangle's top or bottom, clamped into the view. On that row, its x is the wish's own or a side of the merged ruled-out span the wish falls in. Rows are tried nearest first and the search stops once a row is farther than the best spot. Only the rectangles over a row are read, found by binary search on y.
- It is exact: a brute force over every whole pixel agrees on 40 random boards, in view and anywhere. Both of review 2's repros are tests (231 irregular tiles; a packed board whose only room is one 600 x 600 gap).
- Speed, measured with `performance.now` on this Mac (scratchpad `timing.txt`): the worst 500-tile board (jittered, no room in view) takes 17 ms for five files and about 3.3 ms for one. A packed grid takes 2.7 ms for five, and open boards take 1.6 to 2.1 ms. The test pins a work counter (rows plus spans read): 265,103 for that worst case, under a bound of 300,000. A board with room near the pointer reads fewer than 50.
- The view's edges need no candidates of their own: when the bound is what stops the point, the wish lies past it, and the clamped wish is that edge. That makes review 2's R9 moot. The far-right fallback is gone (R7): the row search always finds a spot when nothing bounds it.

**One "in view" (review 2 M2, L4; GM r4 answer 2).** The chip judges "in view" with placement's own rect: `BoardCanvas` hands it `viewRect`, a live getter for the pane less the 16 px inset and less everything below the toolbar's top. A tile partly under the toolbar keeps the chip.

**Placeholders (GM r4 answer 1).** A file pasted, added or dropped on the Board is placed in the view the person had at that moment. A placeholder tile holds the spot at once while the upload runs, and the upload fills it there. If the person pans away meanwhile, no chip comes later.
- The placeholder is client-only (`BoardPlaceholder`: id, x, y, width, height), the shape a pasted link's spot will use. It is drawn as a React Flow node of type `placeholder`: not dragged, not selected, but focusable, labelled "Adding an image". Placement counts it as occupied.
- It is never in the draft, so it is never saved. The undo step is the add the upload makes: one step per paste, as before. A failed upload removes its placeholders and the chip that pointed at them.
- The tile's size comes from the aspect read before the upload (`readImageAspect`, local). So "at once" means after that read, not before it.
- The chip shows at paste time, with no thumbnail until the upload answers.
- The placeholder style is a faint fill and a 1 px ring, with no motion. Zoomed out it is hard to see. GM may want it stronger.

**The chip.**
- Focus (GM r4 answer 6). Enter or Space hands focus to the board, then to the first tile once it is drawn in view. If the placeholder becomes the card meanwhile, focus moves on to the card. Esc gives focus back to where it was before the chip had it, or to the board. If the chip goes any other way while it has focus, focus goes to the board. The board has `tabIndex={-1}` and the token focus ring.
- It goes on any view switch (GM r4 answer 8), not only a board switch.
- A tile bigger than the view (GM r4 answer 9): the chip also goes once the tile covers the view's centre (`seenIn`). Pressing it zooms out on the fit spring until the tile is whole.

**Toasts (GM r4 answer 5).** "Undid…" is an info line. It never replaces a live "Removed · Undo" toast; it is announced instead. The exception is when the step undone is that removal itself, through the toast's Undo or Cmd+Z, because the toast's offer is used up. A removal's toast carries the step it undoes (`undoOf`). The toast's state is read from a ref, since an undo's line is decided after an await. The "Undid: X" labels go to GM for the wording batch.

**Held key (review 2 L1).** Only a repeat keydown of the paste key sets the held state. Any keydown without repeat clears it, as do the window's blur and the page being hidden, so a keyup that went elsewhere can't swallow a later Edit > Paste. Cmd+V is also recognised by `code === 'KeyV'`, for non-Latin layouts.

**Backstop (review 2's race; GM r4 answer 7).**
- Pastes take turns. Each paste's files are hashed and checked only after the paste before it has claimed its own, so a slow hash can't let a later paste overtake.
- Signatures are released when the add ends, upload failure included.
- A dropped duplicate shows nothing on screen and is announced politely: "That image is already being added."
- The count per signature became a Set (review 2's R21).

**Mutants.** 42 of 42 killed (`scratchpad/paste/mut3/mutate.py`). Review 2's survivors:
- R3 (the cap) and R7 (the fallback) are gone with the code they mutated. R9 is moot (see above). R21 is gone with the Set.
- R11, R13, R15, R16, R17, R18 and R22 each have a killing test, as do the chip floor's `noticesTop`, its `floatingBottomLimit` and its reduced-motion CSS.

**Live, round 3** (scratchpad `live3/drive-r3.mjs`, 17 of 17 checks).
- Setup: the backend through `serve_isolated.py` on 8796; its blocked log holds only canary lines and "canary ok". Vite on 5796, with #209's style changes applied uncommitted (an 870 px board column) and reverted afterwards. The browser blocked shared ports and outside hosts, checked by a canary first.
- M1: on a board of 80 tiles zoomed out to 0.117, three pasted files all landed in view with no chip.
- M2: on a wall of 221 tiles, the pasted tile landed at y 828-875 with the toolbar's top at 847, inside the pane. The chip showed, above the toolbar. Enter put focus on that tile.
- The placeholder held its spot during a 2.5 s upload, through a pan, and the card filled it there.
- The shots show "This tab isn't connected as you". The tab used the Vite origin as its backend, so requests stayed same-origin; the moodboard routes don't need the person.

## Round 4 (GM r5, review 3)

**The placeholder's look (GM r5).** A fill at white 0.06, a 1 px dashed edge at white 0.28, and the file's name in the top-left corner at 12 screen px, cut by grapheme to 32 characters (`boardPlaceholder.ts`, `clipGraphemes`). The source is typed, `{kind: 'file', name} | {kind: 'link', host}`, so a pasted link's placeholder (its own PR) reads its host. `BoardCanvas` writes the zoom to `--mb-board-zoom` on the board through a `flowStore.subscribe` layout effect, so a zoom frame re-renders nothing; the CSS divides by it.

**Why the edge is an SVG stroke whose width divides by the zoom.**
- A CSS border of `calc(1px / zoom)` doesn't work: Chrome snaps a border's width to whole device pixels before the node's `scale()` applies, so it drew 3 px at zoom 3 and 0.75 px at zoom 0.25 (live, measured).
- `vector-effect: non-scaling-stroke` doesn't either. Chrome undoes only the transforms inside the SVG, not the CSS `scale()` on the React Flow viewport above it. The first live run passed because it read the computed style, not the pixels. The pixel crops showed about 2.6 px of ink at zoom 3 and about 0.2 px at 0.25.
- An SVG stroke isn't snapped. So the rect's `stroke-width` is `calc(1px / zoom)` and the dashes are `calc(4px / zoom) calc(3px / zoom)`. It is inset half a stroke, so the line sits inside the tile's box. Measured live by pixels (the ink across the edge's rows, against the fill between dashes): 0.98 px at zoom 0.25, 0.95 px at zoom 1 and 0.95 px at zoom 3, dashed 4 on 3 at each. Before this change the same count gave about 0.3 px and 2.6 px at 0.25 and 3.

**The fill rides the board's spring (GM r5, a spring, not a timed fade).** On upload success the Studio marks the placeholder `filled: url`. `BoardCanvas` runs `springProgress` (new in `lib/viewportSpring.ts`; `springViewport` is now built on it) and writes the card's opacity each frame. The card is marked `data-fill-url` and the CSS holds it at opacity 0 with no transition. When the spring settles, `onPlaceholdersFilled` fires and the Studio drops the placeholder. A 3 s fallback timer drops it if no board ran the spring (List meanwhile). Under reduced motion the image swaps straight in.

**The redraw fix.** Live, React Flow redrew the card mid-fade (a new element), and the new one started at the stylesheet's opacity 0 for a frame: a flash. Now `BoardFillContext` is `{has, progress}`: the spring's progress is kept per url, and a card applies the current progress in a layout effect when it mounts, before paint. Once the fill is over the card clears its inline opacity, so it can't be left part-faded if the spring stopped short. The live check samples the opacity every frame and found no drop across the redraw.

**Esc on the chip doesn't move the view.** Rerunning r3-6's sequence, the viewport transform was `translate(-3939px, -921.626px) scale(4)` before and after Esc, unchanged over 1 s. Esc only dismisses and returns focus. The camera in r3-6 followed the driver's five "Zoom in" clicks in its section E, not Esc and not an Enter. Tests pin it: Esc leaves the board's transform unchanged and calls no spring, `setViewport` or `fitView`. They pass on c9477f76 too, since the behaviour was already right.

**Progress bar: not built (a follow-up, its own PR).** GM asked for a 2 px bar that grows with the real upload progress, or nothing. The shared upload path can't report it: `uploadFiles` -> `apiRequest` -> `apiFetch` -> `fetch`, and fetch has no upload progress events. A real bar needs an XMLHttpRequest transport (`upload.onprogress`) in `lib/backend.ts`. That is a second transport in the module every upload caller uses (Commons, Cinema and the rest), which GM ruled out for this PR, so there is no bar and nothing fakes one. The follow-up: add an XHR upload branch to `lib/backend.ts` with the same headers, person token and error mapping as `apiFetch`, used only by callers that ask for progress; then draw the bar on the placeholder on the board's spring. It would also let a stalled upload be told from a slow one (see NIT-3 below).

**Live, round 4** (scratchpad `live4/drive-r4.mjs`, 17 of 17; then `live4b/drive-r4b.mjs`, 9 of 9, for the edge after the stroke change). The backend ran only through `serve_isolated.py` on 8796 with the person token on stdin; its blocked log holds only canary lines and "canary ok". Vite ran on 5796 with #209's style changes applied uncommitted and reverted afterwards; the browser blocked shared ports and outside hosts, canary first, and no request left the lane. The zoom 3 shot has the tile's corner just inside the board's left edge, so its label is cut at the start.

**Review 3 (placement-placeholder lens).**
- LOW-1, the work bound. The counter now counts every block the search reads, and rows. The search no longer scans back over the tallest block on each row. Blocks are filed in a grid of cells (a few blocks wide, a quarter of one tall); a row walks the run of ruled-out spans out from the wish cell by cell, and stops once its end is past the view or farther than the best spot. A block too big to file (over 64 cells) sits in one short list every step reads. The outermost rows are tried first, so on a crowded board the best spot starts close and the walk keeps within reach of it. Exactness is unchanged: review 3's own brute-force oracle (300 random boards, 736 files) gives 0 mismatches against it, and the builder's brute-force test still passes. Measured on review 3's boards (five files, this Mac, wall time varies with load):

  | Board | n | blocks read, before (review 3) | read now | ms before | ms now |
  |---|---|---|---|---|---|
  | jittered grid, no room | 500 | 288,306 | 400,191 | 45 | 14 |
  | band of tall tiles | 500 | 344,300 | 19,863 | 33-46 | 2.5 |
  | very tall tile + field | 500 | 686,669 | 216,222 | 10 | 10 |
  | jittered grid, no room | 2,000 | 1,766,773 | 2,332,411 | 118-187 | 28 |
  | band of tall tiles | 2,000 | 1,403,656 | 17,424 | 156-262 | 8 |
  | very tall tile + field | 2,000 | 7,466,814 | 630,625 | 43-51 | 18 |

  The full-grid board reads more blocks than before (a block sits in one or two cells per row) but runs three to six times faster, since rows no longer allocate and sort their spans. Its cost is the view with no room: every row of it must be shown covered. The test pins all four of review 3's shapes at 500 tiles (under 450,000) and 2,000 tiles (under 2,500,000), the band under 40,000, and a far tall tile adding under a quarter.
- LOW-2, a held spot the board changed under. When the upload fills, each held spot is checked against the board as it is now plus the other placeholders. A spot now on a tile (an Undo brought one back, an agent added one, the person dragged one there) moves to the nearest free spot, from its own centre, in the view the person had at paste time, and its placeholder moves with it. That keeps "a tile never lands on another". Review 3 asked GM whether to move or overlap; this follows the existing rule and is easy to change. The chip isn't recomputed for a moved spot.
- LOW-3, a board switch and back mid-upload. Each opening of a board counts as a visit, and an add only lands on the visit it started on. Leaving the board already drops its placeholders, so the add gives up rather than land where nothing holds a spot, the same as leaving and not coming back.
- NIT-4, a toast held past its deadline and remounted. Holding the toast now clears its deadline, so a remount meanwhile gets the full 6 s.
- Test gaps: each of review 3's twelve real survivors, and the drop one only its oracle caught, has a test now (an extra drop file keeps to the view; a touching edge is wholly outside; an early refusal is handled; another board shows none of this board's placeholders; a mixed paste is announced; another board's toast holds nothing back; a dismissed toast lets "Undid…" show; every tile must be in view for the chip to go; the placeholder is focusable; focus follows for 10 s only and never off a control; another add's thumbnail or failure leaves this chip alone).
- Not changed, with the reason:
  - NIT-1 (the chip's centre rule for a tile smaller than the view) and NIT-2 (the chip for an aimed tile under the toolbar) are review 3's questions 1 and 2 for GM. The code keeps its current reading of GM r4 answers 9 and 3.
  - NIT-3 (a hung upload keeps its placeholder): `apiRequest` has no timeout, and that is the shared transport. A timer can't tell a stalled upload from a big one on a slow link. The XHR follow-up above can, through its progress events.
  - NIT-5 (the placeholder too faint) is GM r5's new look.
  - Three of review 3's surviving mutants are equivalent: two in the span merge (as review 3 found), and the dropped `isCurrent()` before the commit (`commitOps` checks it itself).

## Files

- `frontend/src/lib/boardPlacement.ts` (new) and its test.
- `frontend/src/components/moodboard-studio/`:
  - `pasteImages.ts` (new): reads the clipboard, parses links and uri-lists, signs files, checks the target, and holds the lines.
  - `OutsideChip.tsx` and `outsideChipText.ts` (new), with tests.
  - `MoodboardStudioView.tsx`: the paste listener, the held-key guard, the backstop, info-line priority, placement, and the chip state.
  - `BoardCanvas.tsx`: targets, the view rect, the toolbar as a bottom bar, and the chip.
  - `MoodboardStudioPaste.test.tsx` (new) and `BoardCanvas.test.tsx`.
- `frontend/src/styles/moodboard-board.css`: the chip, the placeholder tile, the board's focus ring.
- Round 4: `boardPlaceholder.ts` (new, with a test), `boardNodes.ts` (`BoardFillContext`), `BoardCardNode.tsx`, `lib/viewportSpring.ts` (`springProgress`, with a new test), `BoardUndoToast.tsx`.
- `frontend/tests/focusRingCss.test.ts`: the placeholder's ring is listed with the card's.

## Docs

`docs/MCP-SETUP.md` only describes how agents add images, and agents get no new tool here, so it's unchanged.
