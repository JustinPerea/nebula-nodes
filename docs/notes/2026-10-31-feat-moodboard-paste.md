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
- Speed, measured with `performance.now` on this Mac (scratchpad `timing.txt`): the worst 500-tile board (jittered, no room in view) takes 17 ms for five files and about 3.3 ms for one. A packed grid takes 2.7 ms for five, and open boards take 1.6 to 2.1 ms. Round 3's test pinned a work counter (rows plus spans read) at 265,103 for that worst case. That counter and its 300,000 bound are gone: round 4 counts every block read, and round 5 adds building the grid (see Round 5 for today's bounds). A board with room near the pointer reads fewer than 50.
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

## Round 5 (review 4, GM r6)

**Focus on a tile being replaced (HIGH-1, MEDIUM-2, GM r6 answer 2).** React Flow adds and drops node elements a commit after the board's own effects, so focus on a placeholder or a provisional card fell to the page body when the element went. `BoardCanvas` now hands focus on (`handOff`):
- Focus on a filled placeholder, or on a provisional card, moves to its image's card as soon as that card is drawn. A saved card is preferred, and a saved card that has focus keeps it.
- If the focused tile's element goes first, focus waits on the board, never the body, and moves to the card when it is drawn. The wait lasts at most 2 s.
- The tile's image is read from the board as it is when it goes, so a placeholder that is filled in the same commit that drops its element still counts.
- Focus anywhere else stays where the person put it. That includes a tile they had left and a click on nothing.
- GM's rule: no late move. Focus on the placeholder moves to the card however long the upload took, past the 10 s follow too. Focus elsewhere is never pulled.
- It runs from a layout effect on the board's nodes, a MutationObserver on the board's DOM, `focusin`, and a frame retry after a `focusout` to nowhere.
- The 10 s follow lands on the card at the spot before the placeholder (NIT-2).

**The chip leaving with focus on it (MEDIUM-3).** When the person's own pan or zoom brings the tiles into view, or the board loses its size, `OutsideChip` hands focus to the board in a layout effect, while the button is still on the page. It also renders one more commit while it holds focus, so focus is never left on a removed element. This covers both paths: in view, and no view.

**Live, round 5** (scratchpad `paste/live5/drive5.mjs`):
- Setup:
  - The backend ran on 8797 through `serve_isolated.py`, with the person token on stdin. Its blocked log shows only canary lines and "canary ok".
  - Vite ran on 5797 with #209's styles applied uncommitted and reverted afterwards.
  - The browser blocked 8000-8010, 5173, 8840, 5840 and outside hosts, canary first. No request left the lane.
  - The board is a 221-tile wall, 13 by 17. `activeElement` was sampled every frame, and every `focusout` to nowhere was logged.
- Before (0979afd3), each repro reached BODY:
  - Space on the chip during a held upload: placeholder, then `focusout->null`, then BODY.
  - A provisional card under a held save: `new-…`, then BODY.
  - An 11 s upload with focus on the placeholder: BODY at 14.9 s.
  - A pan that clears the chip: CHIP, then BODY.
- After, all 17 checks pass:
  - Space on the chip during a held upload: placeholder, `new-…` card, saved card.
  - A provisional card under a held save: saved card.
  - An 11 s upload: the card, with no BODY.
  - Focus moved to Zoom out during a 10 s upload: it stayed there, with one log entry.
  - A pan that clears the chip: CHIP, then BOARD.

**Fill keyed by image id (MEDIUM-1/4, GM r6 answer 3).** The Studio makes the new image's id before it commits (`createDraftImage(url).id`). The holder is marked `filled: {imageId, url}`, and the card carries `data-fill-id` only while it fills. `BoardFillContext` is now just `{progress(imageId)}`. Each card's node gets `data.filling`, so a fill re-renders only the filling card's node (LOW-5).

The fade waits until the card's image has decoded, and never more than 1.5 s (NIT-3). An older tile showing the same url never blinks. The fade's cancel stops both the decode wait and the spring.

**Placement (LOW-1).**
- Blocks over 64 cells are filed in row bands. A band is a quarter of the big blocks' median height (or a cell row, if that is taller). So a row reads its band once, instead of every big block on each step.
- The work counter now also counts building the grid (`built`).
- Review 4's shapes:
  - The bimodal board at 2,000 tiles went from 172M reads to 353k (about 9 ms).
  - The collage reads 3.57M, plus 121k built.
  - The pile reads 2.42M.
- Bounds (`cells + built`):
  - Review 3's four shapes: 450,000 at 500 tiles and 2,600,000 at 2,000.
  - Review 4's bimodal and collage: 80,000 and 950,000 at 500 tiles, and 600,000 and 4,000,000 at 2,000.
- A four-sided edge test kills X3, X4 and X8. A 100 by 100 tile, with a 50 by 50 file wished one pixel inside either end, lands at 124 or -74, in x and in y.

**A spot the board took (LOW-2, LOW-3).**
- The batch's spots that are still free keep their place and are counted first. Only the spots now on a tile move, each to the nearest free spot in the paste-time view, so a moved spot never pushes a sibling.
- The chip follows the moved spots (LOW-3). A spot that moved out of view joins the chip, or starts one. A spot that moved into view leaves it.

**An add whose person left the board (GM r6): it lands.** Held spots and List rows now live per board in a module store (`boardAdds.ts`), not in the open Studio. So they outlive a board switch and the Studio closing: placement still counts them, and they show again if the person comes back while the upload runs. The open Studio registers its board.

When the upload finishes:
- **If the add's board is open** (the same visit or a later one), the add lands as that board's own step, with its Undo and the fade.
- **If not, and the board is saved,** it goes as a checked edit with no base version (`editMoodboard(id, ops)`), so it lands on the board as it is now. If that board's draft is loaded, clean and not saving, the draft is updated too; otherwise the next open's follow reads it.
- **If not, and the board is unsaved,** the add is queued in its draft, as an edit made there.

Either way it is placed at the spot it held, as if the person had stayed. It is never written to the board open now. Live, a paste with its upload held, then a switch to another board in the app, landed at the held spot (2790, -318) on its own board, and the open board was untouched. A second add, then leaving Moodboard Studio for the canvas, landed too.

The cost: an add that lands while the person is away has no Undo step, because the step belongs to the visit that's gone. The fallback line wasn't needed.

**Toolbar and List (GM carry-over).** "Add images" stays live and the "Uploading" status is gone, in Board and in List. Adds at once go through placement and the backstop. Concurrent paste, drop and Add images each hold their own spots, and a repeat file is caught. In List, each uploading file is a row of its own: `role="status"`, `aria-busy`, "river.png, uploading". The row shows its placeholder thumb with the file's name and the row's "Uploading" state. A Board paste shows as a List row while it uploads. See the shots in scratchpad `paste/shots5/`.

**Mutants.**
- Focus: F1-F13 and C1-C3.
- Fill keying: K1-K7.
- Bands: P1-P3.
- Moves: S1-S3.
- Review 4's survivors: X3, X4, X7, X8, X9, X10, X11, X13, X19 and X21.
- Each of these fails at least one test now. For each one that survived the first pass, a test was added: the successor without a stop on the board, the park expiring, a card drawn by React Flow alone, no MutationObserver, focus moved off the tile, the follow onto the card, the chip with a slow parent, a placeholder filled as it went, two moved spots, a no-url file, a tile within the gap, another add's spot, the paste-time view, and a second fade.

**For #213 (view insets).** Placement reads the view only through `BoardCanvas.viewRect()` (`VIEW_INSET` = 16 px plus the toolbar). That one rect reaches three places: the first placement (`placeTiles` in `addFiles`), the move of a spot the board took (the same `target.view`), and the chip (`viewOf={viewRect}`, and `followMovedSpots`). Whichever of #210 and #213 lands second points `viewRect` at the shared insets.

**Merged with main (#209, board fit-follow).**
- #209 added its own `follow` ref (`BoardFitFollow`), so the paste's 10 s focus follow is now `focusFollow`.
- The chip's press frames the tiles through `springTo` without `fitted`, so it leaves the fitted state. A person's pan also leaves it, through #209's `onCameraMove`.
- Fit bounds read the cards only, not the placeholders. (Round 6 changes this: Fit counts held spots, GM r8 answer 4.)
- `BoardCanvas.test.tsx`'s mock store now hands listeners the previous state too, which #209's subscriber reads.
- Live on 8797/5797, 18 of 18 checks passed:
  - The paste repros again.
  - A fitted board refits when the window narrows, with an upload held, and the held spot doesn't move on the board.
  - After a pan, a resize keeps the camera.
  - After Fit, a resize refits again.

## Round 6 (review 5, GM r7 and r8)

The rule under GM's r8 answers: a paste the person made is never lost silently.

**An add belongs to a draft instance, not a key (MEDIUM-1).** Every unsaved board shares the draft key `new`, and New or a delete resets that key, so an add tied to the key string could land on the fresh draft. Each add and each held spot now holds a `BoardRef` (`boardAdds.ts`):
- The ref holds the key, the draft's `epoch` and, once the board is saved, its id. `reset` bumps the epoch; `copyTo` keeps it.
- `isBoard(ref, key)` matches the same draft instance, or the same saved board. The saved-board match covers a delete undone: the restored board's draft is a new instance with the same id.
- A draft-store subscription re-files refs when a draft is copied on (its first save, a move to a project), and picks up the saved id when the first save lands. It covers the refs of adds in flight and of spots still held after their add ended.
- `boardStanding(ref)`: `draft` (its draft is still there), `saved` (only the saved board is left), or `gone` (a discarded unsaved draft).

**GM 1, Delete.** A board deleted mid-upload: its edit answers 404 and the add is cancelled, silently. A delete undone before the upload finishes: the board is restored with its id and the add lands on it. If the person is back on it, as a step with the fade.

**GM 1, New, and GM 2.** An unsaved board with images or with an add in flight counts as content. New (and a delete, which also opens a fresh draft) saves it first under its name, or "Untitled Moodboard" if it has none, so it shows in the rail. Then it opens a fresh draft. If that save fails, the board stays open with "Couldn't save the board." and New doesn't reset it. An add whose unsaved board the person left lands in that board's draft, and the board is saved then (`saveAway`, the same create the Studio's first save sends). If its first save is already out, the add waits for it and then goes as an edit of the saved board.

**Away landings on saved boards.** The add goes as a checked edit with no base version. The board's draft takes the result if it is loaded, clean, has no save out, and is behind the result's version. A save out is waited out first. A save that reached the server after the add already holds it. Unsent edits rebase on the board when they are sent, and a kept draft reads its board again on each open. This replaces round 5's "landed away" flag, which missed a save that ended on a version before the add's.
- LOW-3: the spots of an away landing stay held, filled, and marked `away`. Back on the board, the images fade in over them, with the edge chip for any outside the view. In the List they go at once. No new line.
- LOW-4: a failed away write (not a 404) keeps the image. The add is queued in that board's draft, and the board shows "Couldn't save the board." with Retry. It is not reported as an upload failure.
- LOW-5: away from a saved board, the spot check reads the board from the server, so a tile added meanwhile moves the add off it.
- An upload that fails after its unsaved draft was discarded says nothing on the fresh draft at that key.

**M17 and M18.** The open board's `commit` now reports whether the step was taken (`commitOps(...) !== null`). A Studio still drawn but no longer current takes nothing, and the add lands through the server instead of being lost. The open board is registered only once its draft has loaded: an add landing while its board loads goes to the server, and the load reads it.

**GM 3: the backstop is per board.** `claimFiles(board, …)` checks claims by `sameBoard`. The same image on another board goes; on the same board it is caught, across the Studio closing and a delete undone.

**GM 4: Fit counts held spots.** `BoardCanvas` keeps the placeholder nodes in `heldNodesRef`, and Fit's bounds include them.
- Live, Fit didn't make the chip go at first. Fit framed into the whole column, so a held spot at the bottom of the bounds sat in the 16 px inset above the toolbar, which the chip (and placement) count as outside.
- Fit, an Update's Show and the chip's press now frame into `viewRect`'s area through `frameFor`: the column less the inset and the toolbar. A tile they bring in is in view by placement's rule, and never under the toolbar.
- `BoardCanvas.fitFollow.test.tsx`'s expected fit is updated to match (#209's tests), and a new test checks Fit clears a toolbar.
- For #213: `frameFor` is the one place a framing reads the insets, next to `viewRect`. (Round 6b: both now read #213's `lib/boardViewInsets`, and `frameFor` became #213's `frame`.)

**GM 5: a reload mid-upload.** Adds on their way to a saved board are recorded in `localStorage` (round 6b moved them to `sessionStorage`, per tab; see below) (`nebula:moodboard-adds-in-flight`): holder id, board id, file name, and a page-load id. Each record goes when its add lands or fails. On a board's open, records from an earlier page load are taken once and said in one neutral line:
- one file: “river.png” wasn’t added because the page reloaded while it uploaded. Paste it again.
- two or three: named, "… weren’t added because the page reloaded while they uploaded. Paste them again."
- four or more: "N images weren’t added because …".
Storage is read and written in try/catch: with none, nothing is kept and nothing said. Limitation: an unsaved board doesn't survive a reload, so only adds to a saved board are recorded.

Live found a real gap here. On a reload, Chrome cancels the upload and still runs the add's failure on the way out, and that cleared the record, so the next open said nothing. Records are now kept once `pagehide` has fired (`pageshow` resets it), and a test covers it.

**GM 6: the placeholder's spoken name.** "river.png, uploading" (a link: "example.com, uploading"), through React Flow's `ariaLabel`. A placeholder can't be selected, moved or deleted, so React Flow's description of those keys is dropped (`domAttributes: { 'aria-describedby': undefined }`).

**GM r7 chip answers.**
- Answer 1: `seenIn` applies the centre rule only to a tile bigger than the view. The code says so, and a test covers a smaller tile across the centre.
- Answer 2: a drop aimed under the toolbar band moves out of it by the smallest move that puts it wholly in view, keeping the aim otherwise, then off any tile as before, with no chip (`placeTiles` `band`).
  - The toolbar sits at the bottom, so the move is up. GM's answer says "down", but the move that brings the tile into view is up, so I took that as the intent.
  - A tile taller than the view keeps its aim.
  - If no free spot in view is left and the tile still reaches into the band, it is reported, so the chip points at it ("it doesn't stay hidden"). A spot the board later moves into the band gets the chip the same way.

**NITs.** NIT-6: if the board can't take focus (hidden, or with no size), `focusBoard` falls back to the view switch, so focus never falls to the body. NIT-1: the chip's comment names every camera move that can bring the tiles into view.

**An old test, updated to GM's rule.** `tests/components/AssetStudioDrafts.test.tsx` had "rejects a Moodboard upload belonging to an explicitly replaced new draft": New dropped the upload. GM r8 answer 1 reverses that. The test now checks that New saves that board first and the upload lands there (`editMoodboard` on the created board), while the fresh draft stays empty.

**MCP.** An add saved on landing goes through the same endpoints as any add: `POST /api/moodboards` for an unsaved board's first save, `POST /api/moodboards/{id}/edits` for a saved one. Both write as the person, are journaled, and are broadcast (`_broadcast_stored_asset`), so agents see the board and the image exactly as they see a normal add. Held spots and adds in flight are client-only: agents see nothing of them, or of an unsaved board, until the board is saved. No tool changed, so `docs/MCP-SETUP.md` is unchanged.

**Mutants.** 55 mutants of round 6's code (scratchpad `paste/mutate-r6.py`), each run against its covering test file. 52 fail a test. For each one that survived the first pass, a test was added:
- a spot held after its add ended that follows a moved draft;
- a return to the board mid-upload, which says no reload line;
- the same file after a delete undone;
- New when the save fails;
- a delete with an unsaved board that has content;
- a board deleted by someone else while the person is away;
- an upload failure after a discard;
- a save out when an away add lands;
- a draft already past the add's version;
- a return in the List;
- a tile taller than the view under the band.
The M18 test now also checks the loading draft takes nothing, and the M20 test checks focus goes straight to the saved card.

Review 5's survivors:
- M2 is replaced by re-filing (A3 and A6 are killed).
- M6, M7 and M8 are killed (V8, V9b and V5).
- M17 is killed (V23).
- M20 is killed (B6).

Five more cover the fixes live found (N1-N5: Fit clears the toolbar, Fit in the inset view, a tile left in the band is reported, a moved aimed spot in the band takes the chip, a leaving page keeps its records). All five are killed, so 57 of 60 fail a test.

Three survivors are equivalent:
- V9: the `pendingSaveId` re-check right after `whenNotSaving` only guards a save started in the same tick.
- V22 (review 5's M18): registering the open board before it loads. A reset draft doesn't match the add's board until its load brings the saved id. A Studio whose project isn't ready isn't current, so since M17 its commit takes nothing and the add goes to the server.
- V27: an unsaved-content check that skips the saved-id test. `saveAway` returns the saved id at once.

A test-harness fix: holder ids now keep counting across tests, as they do in a page. One test's late fade release (3 s) used to take a later test's `placeholder-1`, which hid V16.

**Live, round 6.** Scratchpad `paste/live6/drive6.mjs`, on 8797/5797:
- Setup:
  - The backend ran through `serve_isolated.py` with the person token on stdin. Its blocked log holds only canary lines.
  - The browser blocked 8000-8010, 5173, 8840, 5840 and outside hosts, canary first. No request left the lane.
  - Uploads were held with CDP Fetch on `/api/uploads` only. Pausing every request through the driver made the app go offline under the machine's load (about 20).
- Final run (run5, then run6 for run-g and run-h with a stricter rail check): every scenario passed. Band failed once in run5, when the page went offline under load (its health checks failed), and passed on its own (5/5), as it had in run3.
- run-g (New, a paste held, New again, directly and after another board): the fresh board shows no placeholder. New saved the first board, so the rail gained one "Untitled Moodboard" row, and the paste landed there (1 image). The fresh draft holds nothing.
- run-h (New, a paste held, another board, release): the board was saved with the image and is one more rail row. The next New opens empty, the board keeps its image, and it reopens from the rail with it.
- Delete mid-upload: the board stays in the trash (404), with no line and no placeholder. Delete, then Undo, then release: the image lands on the restored board (2 images), with no line.
- Reload mid-upload: the add is recorded. After the reload the board's open says “river.png” wasn’t added because the page reloaded while it uploaded. Paste it again. The record is then taken, the line doesn't come back on the next open, and nothing was added.
- Fit with a held spot outside the view: the chip is up. After Fit the spot is in view and the chip has gone.
- A drop aimed into the toolbar band: the spot sits wholly above the band with no chip, and the image lands there.
- Shots: scratchpad `paste/shots6/` (18). Two md5 groups repeat, both expected frames of the same unchanged screen:
  - the fresh empty board after New, in run-g and run-h. The new rail rows are below the fold, since the rail lists boards by id.
  - a deleted board's fresh draft before and after the cancelled add's release. Nothing changes on screen, which is the point.

**Gates, round 6.**
- tsc 0, and `npm run lint` 0.
- Focused vitest over 141 files, two workers: 2234 of 2235 passed. The one miss was a 120 s timeout in `agentPresenceFollowups.ratchet.test.ts` under load, and it passed alone (50 of 50).
- The build passes, and the budget is 444,301 B raw of 512,000.

## Round 6b (review 6, GM r10)

Merged origin/main twice: e51f789f (#215) at the start (local merge 5fbd749a), then 53318ca6 (#213) once it landed (local merge c5f7c362). #210 lands second, so it takes #213's shared insets.

**One view for every framing and placement (#213's insets).** `BoardCanvas` no longer has its own 16 px inset or `frameFor`.
- Fit, an Update's Show and the chip's press all go through #213's `frame()`, the column inside `lib/boardViewInsets` (the control bar's band at the bottom, measured from the bar, `BOARD_BAR_BAND_PX` when it can't be).
- `viewRect()` (placement's view for paste, drop and Add images, and the chip's "in view") is that same area, in board coordinates.
- Fit still counts held spots (GM r8 answer 4): with spots held it frames cards and spots; with none it is #213's `fitFor`, so its person-intent rules (the fitted flag read from the camera, a move end with a source event, the relative zoom tolerance) are unchanged.
- The merge conflicted in `BoardCanvas.tsx` and its two test files; `boardFitFollow.ts` merged cleanly. #213's side was kept whole; #210's held-spot Fit, `BOTTOM_BAR_ATTR` on the bar and the chip's framing were laid on it.
- Placement's view lost the 16 px inset: #213's rule (GM) is the column less the insets. A tile can now land flush with the column's side edges; the 24 px gap still keeps it off other tiles.
- A new test in `BoardCanvas.test.tsx` lays out a 1000 x 700 column with the bar's top 50 px up and checks that Fit, Show and the chip's press spring to the same camera, and that placement's view and the chip's view are that same area. The view expectations in the placement tests now read the insets.

**Autosave waits from the draft's change, not the last render.** Found through a flaky R6-E: the Studio's `draft` was `withBriefFields(storedDraft)`, a new object every render, and it is an autosave dependency, so any re-render inside the 600 ms wait (a held spot changing, an upload row) restarted it. In the full test file, timers left by earlier tests re-rendered the Studio often enough that the List add's save never went. It's on main too. The draft is now memoized on the stored draft, and a test re-renders the Studio every 200 ms and checks the save still goes (it fails without the fix).

**MEDIUM-1: the open board's commit reports what it applied.** Round 6's M17 fix made `commit` report `commitOps(...) !== null`. But `commitOps` returns the undo step, which is null on an unsaved board (no undo there), so every Board add on a new board also went the away path: a second, unversioned edit of the same image, and its spots marked `away` on the board the person was on.
- `commit` now returns true whenever the ops were applied: the Studio is current and there were ops. A Studio no longer current still takes nothing (M17 holds).
- Fixing that alone loses an add (review 6's R6-A): New pressed with an add in flight, the upload ends while New's create is out, the open unsaved board takes the add, the create answers without it, the draft moves to the saved key dirty, and New opens a fresh draft. Nothing sent the saved board's draft.
- `saveAway` now ends as the Studio's own save does: after the draft moves to the saved key, `sendQueued` sends what the draft took meanwhile. The image ops go as one checked edit on the version the create answered, a 409 reads the board and replays (three tries), and a board field changed meanwhile goes on a PUT after. The draft is clean once the server holds it all. A change made while that send is out goes the same way when it lands. A failure is the saved board's own line, "Couldn't save the board.", with Retry, and the image stays in its draft.
- No undo steps are made: an unsaved board records none, and the person may be on a fresh draft by then.

**MEDIUM-2 (GM r10 2): reload records are per tab.** They live in `sessionStorage`, which is per tab and survives a reload of that tab, the case the line names. Another tab never sees or takes them, so tab 2 opening a board no longer says tab 1's live add was lost (and no longer deletes tab 1's record). The page-load id stays: after a reload, holder ids restart at 1, and an add of the new page must not clear the old page's record with the same id (R8, now tested). Follow-up, not this round: Duplicate Tab copies session storage, so the copy could say the original's add was lost while it still lands (per-page id plus a BroadcastChannel "still open?" ping).

**LOW-3 (GM r10 1): the line shows on its own board.** New's empty board stays (GM: the person pressed New). An add on an unsaved board is recorded in memory against its board ref, and written under the board's id when the ref gets one (`follow()` in `boardAdds.ts`, as the first save lands). That covers New saving the board mid-upload and an away landing saving it while another add still uploads. The record says the board id, so the next open of that board says the line, and an open of any other board says nothing. An add that ends first leaves no record.

**NIT-5.** New and a delete await saving the unsaved board. Afterwards they still reset the `new` key (that's right whatever the person did), but they navigate to the fresh draft only if the person is still where they started, or on the board that save just made (the Studio follows a first save). Not `isCurrent()`: after the save moves the draft to its saved key, the Studio's own `isCurrent()` is false (its key's entry moved), which would skip New's navigation every time. A delete takes its route before its own awaits.

**NIT-6.** Each record carries its time. Records older than 24 h are dropped when read, and the list keeps the newest 50.

**LOW-4: review 6's 14 surviving mutants.**
- Now killed by new tests:
  - R3 and R5: an unsaved draft discarded mid-upload, then the same image pasted on the fresh draft (a later epoch). It is its own add: it shows, isn't refused as "already being added", and lands.
  - R8: an add that ends clears only its own page load's record, not an earlier load's record with the same holder id.
  - R12 and R13: New while the open new board's own first save is out waits for it and keeps that board: one create, and a fresh draft.
  - R14: a failed away write for a board whose draft was reset meanwhile writes nothing into the fresh draft.
  - R16: away spots on a board being read again wait for the load before they fade in.
  - R17: the reload line waits for its board to load.
  - R21: Show frames in the same view as Fit (the one-view test).
- Equivalent, or gone:
  - R6 (`follow` re-files any instance on an alias): a re-filed ref of another instance never matches. `isBoard`, `boardStanding` and the saved-id pickup all check the epoch, and epochs only rise along an alias chain (`reset` bumps from the resolved entry, `copyTo` keeps it). Kept as a guard.
  - R11 (the unsaved-content check without `at !== key`): an aliased key resolves to a saved entry, which the saved-id test already returns on. The reviewer marked it equivalent too.
  - R18 (`landAway`'s draft patch without the saved-id check): the draft at the ref's key is loaded with a null saved id only for an unsaved board, whose adds take the draft path, never this one. A saved board's reset draft isn't loaded. Kept as a guard.
  - R20 (`frameFor`'s degenerate-view fallback): gone with the merge. #213's `insideInsets` keeps at least 1 px each way, so a framing never gets a negative area.
  - R23 (the upload-failure line through `here()`): `isCurrent()` is the paste-time render's check, tied to that board's key and epoch, so when it holds, the open board is the add's board. The two branches then write the same entry.

**MCP.** No tool changed. `sendQueued` uses `POST /api/moodboards/{id}/edits` and `PUT /api/moodboards/{id}` as the person, the same routes as the Studio's save, so agents see the board and its image as soon as the server holds it. Reload records are client-only. `docs/MCP-SETUP.md` is unchanged.

**Mutants, round 6b.** Scratchpad `paste/mutate-r6b.py` (the round 6 list with its strings brought up to date, review 6's R1-R24, and the new ones). 64 were run: round 6 mutants whose code changed (A4, A10, A11, V1, V1b, V2, V19, V25, B2-B6), review 6's R mutants, and the new ones: the commit report and the queued send (C1-C9), the records (S1-S8), NIT-5 (N5a-N5e), the insets (I1-I3) and the autosave (D1). 58 are killed.
- Six survive, each equivalent or a guard:
  - R6, R11, R18 and R23 (see LOW-4).
  - S7: an add that ends leaves its in-memory record of an unsaved board. Its ref is untracked as it ends, so `follow()` never writes it; the only cost is the entry staying in memory, which is what the cleanup prevents.
  - N5d swapped the delete's route snapshot for the same values read another way. N5e, which takes the route after the delete's awaits, is killed by a new test (the person picks another board while the trash move is out).

**Gates, round 6b.**
- tsc 0, and `npm run lint` 0.
- Focused vitest, two workers, over 145 files: round 6's 141 plus #213's `BoardCanvas.unmount`, `boardViewInsets`, `useScrollPanel` and `useTextCut` tests. 2372 of 2372 passed. Before the #213 merge, 141 files: 2256 of 2256.
- The build passes, and the budget is 444,782 B raw of 512,000.

**Live, round 6b.** Scratchpad `paste/live6/drive6b.mjs`, at 1440 x 900, on 8797/5797, after the #213 merge (Vite restarted on it):
- Setup:
  - The backend ran through `serve_isolated.py` with a fresh person token on stdin. Its blocked log holds only canary lines.
  - The browser blocked 8000-8010, 5173, 8840, 5840 and outside hosts, canary first. No request left the lane.
  - Only `/api/uploads` was held (CDP Fetch).
- Final run (run3): 19 of 19.
- New with an add in flight, then a reload:
  - While the board was unsaved, its add had no record.
  - New saved it as an empty "Untitled Moodboard", and the record appeared in session storage under that board's id, with nothing in local storage.
  - The reload cut the upload and landed on the projects screen (an unsaved board has no URL to come back to).
  - Opening another board first: no line, and the record stayed.
  - Opening the saved board: “river.png” wasn’t added because the page reloaded while it uploaded. Paste it again. The record was taken, and the empty board stays in the rail.
- Two tabs on one board:
  - Tab 1 pasted with the upload held, and its record went to its own session storage.
  - Tab 2 opened the same board: no line, no record seen.
  - Released, tab 1's add landed (server 2), its record went, and tab 2 never showed a line.
- Earlier runs failed in the driver, not the app. After the reload, it waited for a board on the projects screen, and the next scenario then ran in a half-open page. The driver now opens the other board by URL after the reload.
- Shots: scratchpad `paste/shots6b/` (9), each opened. md5 `uniq -d` finds no repeats.

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
- Round 5: `boardAdds.ts` (new: adds held per board, the open board), `MoodboardListView.tsx` (uploading rows), `OutsideChip.tsx`, `styles/moodboard-studio.css` (the uploading row).
- Round 6b: `MoodboardStudioView.tsx` (the commit report, `sendQueued`, `keepUnsaved`'s saved id, the route check after New and a delete, the memoized draft), `boardAdds.ts` (records in session storage, written under the saved id when a ref gets one, aged and capped), `BoardCanvas.tsx` (the merge onto `lib/boardViewInsets`), and their tests.
- Round 6: `boardAdds.ts` (board refs, re-filing, the per-board backstop, the reload record), `boardPlaceholder.ts` (`placeholderSpokenName`), `pasteImages.ts` (`reloadLostLine`), `MoodboardStudioView.tsx` (`saveAway`, `landAway`, `keepUnsaved`, the return effects), `BoardCanvas.tsx` (Fit, the spoken name, the band, the focus fallback), `outsideChipText.ts`, `OutsideChip.tsx`, `lib/boardPlacement.ts` (`band`), and their tests; `BoardCanvas.fitFollow.test.tsx` and `tests/components/AssetStudioDrafts.test.tsx` updated.

## Docs

`docs/MCP-SETUP.md` only describes how agents add images, and agents get no new tool here, so it's unchanged.
