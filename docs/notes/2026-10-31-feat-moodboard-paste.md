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

## Round 6c (review 7, GM r11)

Main had nothing new (still 53318ca6), so nothing to merge.

- **Undo after New (review 7 MEDIUM-1, GM r11 1).** `sendQueued`, the queued send `saveAway` starts, now sends only what the draft held when it began: those ops, and the fields that differed from the base then. On a 409 replay it still sends only those, rebased. A change made after it began (a paste, a rename on the saved board, opened from the rail) is its own step. When the send lands with more to send, a board open in the Studio (`boardAdds.isOpenBoard`, which resolves aliases) gets no second `sendQueued`: its autosave sends each step's batch and PUT and records that step's Undo. A board no Studio has open still gets the second send. Tests: R7-U1, its control, the rename, the 409 replay with a paste, the away case.
- **Fit with a held spot (review 7 MEDIUM-2, GM r11 2).** `fitFor` is the one fit computation: cards plus held spots, null only when both are empty. `fit()` calls it, and so does #213's follower, so a Fit with a held spot is "on the fit": fitted, and it follows a resize. A spot that goes later doesn't unfit it (the anchor holds until the camera moves), and the next resize refits to the cards there are then. Tests: R7-F1, R7-F2, and a spot outside the cards, then Fit, a narrower column, then a person's pan that unfits it.
- **An add replayed after a 409 (live LOW-1, GM r11 3).** `lib/boardPlacement.respot` is the one rule for a spot the board took meanwhile: from the spot moved up off the band (when the view had one), the nearest free spot in the person's view, else anywhere. The held-spot check in `addFiles` uses it, and so does `freeQueuedAdds`. After a 409, the draft is rebased, then each queued add whose spot is taken (by the server's tiles, the person's cards, or spots other uploads hold) moves, in order, and the draft is rebased again. The paste-time view, band and card size come from a WeakMap keyed by the op (a rebase sizes a queued card without its aspect). The op moves in place, so its Undo step and the send that owns it still know it. Both the Studio's `persist` and `sendQueued` do this. Tests: a paste and a band drop on the open board, an add left alone, and the queued send with another tab's tile at its spot.
- **Offline background sends (live LOW-2, GM r11 4).**
  - A write refused while offline (`OfflineRefusal`) isn't a failure. `sendQueued`, `persist`, `saveAway` and `keepFailedAway` let the save go with the draft still dirty and no line; the banner already says Nebula is offline. The empty error box can't happen from these paths now.
  - The Studio's autosave doesn't run while offline (`useBackendOffline` in its effect), so a refused save isn't retried in a loop; on reconnect, what waited goes.
  - A background send (`sendQueued`, or an away add that `keepFailedAway` put in its draft) waits for `waitUntilOnline()` and is sent once more. Only if that fails does the board say "Nebula couldn’t save the board because {cause}. Try again.", with Retry (the toolbar's, which runs `persist`). The cause clause (`boardSaveLine.ts`) copies #204's wording, with the server as subject (busy, didn't respond, hit an error, isn't answering, didn't accept it, access), plus "the board changed in another window" for a 409 that kept coming back. #204 isn't on main yet, so this is local; when it lands it can take #204's `loadFailedCause`.
  - An add that saves an unsaved board the person left (`saveAway('background')`) is created again once on reconnect, unless the person is back on that board, whose autosave sends it.
  - The waiting send is kept in this tab's session storage (`nebula:moodboard-sends-waiting`, beside the reload records, aged and capped the same way): the board's id, its queued ops and its unsent fields. The board's next open in this tab, after a reload, takes it back into the draft (skipping adds the board already holds), and the autosave sends it. An add whose image only that page held (a `blob:` or `data:` URL) can't be kept: it goes into the reload records under the board, so the existing reload line names it. A send that lands drops its record (`sendQueued` and `persist`).
  - Not covered: an unsaved board's add refused offline has no id to be kept under, so a reload before reconnect loses it (as any unsaved draft is lost on reload).
- **Review 7's surviving mutants (LOW-3).** Killed with tests: X2 (the send stops when the board's key holds another draft), X3 (three tries, then the line), X6 (a field the server cleans is the person's as sent), X7 (a project board's PUT names its project), X8 (the edit's thumbnail), X9 (a delete whose save of the unsaved board fails keeps that draft), X10 (another scope's new board isn't "still on").
- **NIT-4.** The 50-record cap drops earlier page loads' records first, oldest first, and never this page's: their uploads are still running.
- **Live NIT-1.** An info line (no action: the reload line, "Undid…") ends when the person leaves its board, so a quick return doesn't show or read it again. Undo toasts, which have an action, still come back as before.
- **A guard test's allow list.** `tests/round22Surfaces.test.tsx` lets only listed files call `useBackendOffline` (canvas surfaces read `useCanvasLock`). The Studio's autosave wait is a network wait, not a canvas edit, and following an agent's switch mustn't stop it, so the Studio is listed there with that reason.
- **Mutants:** 52 run (scratchpad `paste/mutate-r6c.py`): 41 for this round's code and review 7's seven survivors, plus 11 round 6b mutants re-expressed where their code changed. 51 are killed. Eight survived a first pass and each got a test: a field the send owns changed again on the board (U5), spots other uploads hold during a replay (R3), the band for a replay and for a held spot when a band drop had no room in view (R6, R7), an add placed partly out of its view keeping its spot (R8), a waiting add the board already holds (O13), and a waiting send's age. F2 is equivalent: `fit()` and the follower both call `fitFor`, so the old split computes the same camera. F1 (fitFor without held spots), the real regression, is killed.
  - `dropWaitingSend` dropped its `leaving` guard: it runs only after a send landed, so the record should go even on a page's way out.
- **Gates:** tsc 0; lint 0; focused vitest over 146 files, two workers (round 6b's 145 plus `boardSaveLine.test.ts`): 2414 of 2415 passed; the one miss was the guard above, which passes with the Studio listed (32 of 32); vite build; the build budget 444,782 B raw of 512,000 (unchanged: the Studio is a lazy chunk).
- **Live (8797/5797, `serve_isolated.py`, a fresh token on stdin, canary first, 1440, Restraint):** Run 1: 27 of 29, both misses from the driver's faked 429 (below); run 2, the failed-resend scenario again: 10 of 10. CDP Fetch held uploads, board creates and edits, and refused `/api/health` while "offline", so the tab went offline as it does when the backend is away.
  - Undo after New: New with an add in flight, the create held, then the queued edit held. The saved board opened from the rail, lake pasted on it, the edit released: both on the server, and Cmd+Z took lake back ("Undid: Added #2"), leaving one.
  - Fit with a held spot below and right of three cards: Fit framed all four, `fitted` true; at 1000 x 700 it refit (scale 0.44 to 0.22) with all in view, still fitted.
  - Offline: the queued send was refused; the entry was dirty with no error, no error box showed, the waiting record was in session storage, the server had nothing. Back online: one edit, the image landed, the record went, clean.
  - Offline, then the resend answered 429: one resend only, then "Nebula couldn’t save the board because the server is busy. Try again." on that board with Retry (shot); Retry landed it and the line and record went. The first run's 429 was faked without CORS headers, so Chrome failed it and the app said, correctly, "the server isn’t answering"; the driver now sends the headers.
  - Shots: scratchpad `paste/shots6c/` (6), no md5 repeats. The blocked log holds only canaries; no request left the lane.

## Round 6d (GM r12, review 8)

Main had nothing new (still 53318ca6), so nothing to merge.

- **Resends keep Undo (review 8 MEDIUM-1, the structural fix).** A send now carries what it owns, `SendOwns`: its ops (by identity) and its fields with the values it sends. A first `sendQueued` owns the draft as it began (`ownsOf`). A resend on reconnect is handed what the refused send owned, never the draft as it is by then: `waitToResend` passes the refused attempt's owns (those ops still pending, and its fields), and `keepFailedAway` passes just the away add's ops. What the person did meanwhile on a board open in the Studio (a rename, a drag, a paste) stays with the autosave, which sends each step with its Undo. `finishSave` can't know the draft still holds the person's steps (the revision didn't move after the resend began), so after a send lands the draft is marked dirty again when it still has ops or fields to send; the open board's autosave sends them, and a board no Studio has open gets the second send as before. GM's line still shows when a resend fails, open board or not. The record kept for a reload holds the same as the resend. Tests: R8-A, R8-O1 (the resend's edit holds only the add; the rename is its own PUT and step) and R8-B, made deterministic by letting the board's own refused save finish offline before reconnect, so the away add's resend goes first.
- **A network drop is offline (review 8 MEDIUM-2).** `notSentYet(err, send)`: an `OfflineRefusal` isn't sent; a background send's no-answer failure (`isBackendUnreachable`: no answer at all, or a gateway's 502-504 with no reason, which is what the dev proxy answers once the backend is gone) asks for a health probe now and waits for its answer (`backendConnection.probeOffline`, new: `requestHealthProbe()`, then resolves on the next probe answer or the tab going offline, or after 5 s with no banner to probe). If the tab is then offline, it waits as a refused send does: no line, kept for a reload, sent once on reconnect. If not, and for any resend, the board says why. The queued send, an away add (`keepFailedAway`, now decided after the probe; it says nothing if the board's own save sent the add meanwhile) and an unsaved board an add saves (`saveAway('background')`) all do this. New's own save (`saveAway` with no `away`) is the person's and fails as before. `noteProbeAnswer` notifies probe-answer listeners even for a stale answer (applying it is unchanged).
  - Flag: a create that got no answer may have been made on the server. Resending it after reconnect can make a second board. An edit's resend is safe: the add carries its id and the server skips an image already on the board. The brief asked for `saveAway` too, so it's built; if a duplicate board is worse than a line, `saveAway` should keep failing on no-answer. That's GM's or Justin's call.
- **The failed-resend line is neutral (GM r12 1).** `boardSaveLine.isBoardNotSavedLine` knows GM's line by its fixed opening. The notice gets `moodboard-studio__notice--neutral`, `data-line-neutral` (#204's mark, so its sheet applies when it lands) and `role="status"`: #204's neutral ink, control fill and strong edge. The sentence is as written, with no button of its own. The header chip reads "Not saved" (`--not-saved`, neutral ink), and the header's Retry is the one retry. Any other save failure keeps the error look and "Error".
- **The offline empty board (GM r12 2).** The Studio hands `offline` to `BoardCanvas` and `MoodboardListView` (no new `useBackendOffline` caller). While offline, an empty board shows only "No references yet" (the title as it was, without a period), and the List drops "Drag images here or add files.". Add images (Board) and Add Images (List) are disabled with `offlineDisabledReason('add images')`, "You can add images when Nebula reconnects.", the shared offline line, with the offline mark and the dimmed control. Both come back on reconnect. A paste or drop while offline is refused by apiFetch before it is sent: its `OfflineRefusal` now shows no line (before, it gave an empty "Couldn't upload" box).
- **The chip follows its tiles (review 8 LOW-1, NIT-3).** The chip keeps only the tiles a card or a held spot still covers, so an Undo or a remove of its add takes that tile off it, and the chip goes with the last. A filled spot counts until its fade ends, so a returning add's chip isn't dropped before the board reads the image. `freeQueuedAdds` returns the adds it moved; the open board's 409 replay gives the ones now outside the view they were made in the edge chip, as a moved held spot gets. The off-board queued send has no Studio to show a chip.
- **NIT-1 (review 8): no change.** Live, a portrait paste at the centre of a board whose one card filled the middle of the view had no room in view (the space above, beside and below the card was 214-252 px against a 294 x 441 tile), so it went below the card, reaching past the column's bottom and under the toolbar band. That's outside by placement's rule, so the chip is right. It sits over the visible top of that card, which may look odd; if GM wants a chip only for a tile mostly out of view, that's a change to the rule, not a bug.
- **Review 8's LOW-2 mutants.** Tests for Y3 (a List row still uploading holds no spot in a replay), Y4 (two adds moved in one replay keep a gap), Y10, Y19 and Y27 (a refusal that comes back after the board's draft was reset leaves the fresh draft alone), Y11 (a fields-only waiting send is kept), Y13 (a send that landed drops its lost-image records), Y15 (a waiting add the board holds under another id), Y20 (an Undo toast is back on its board), Y21 (an info line about the board the person just came back to stays: an Undo answered as they return), Y23 (a `data:` image isn't stored) and Y24 (Fit with only a held spot).
  - The guard tests throw the refusal only while offline. A mock that refuses while online loops a resend forever (it waits for online, which is already true); a real `OfflineRefusal` only happens offline.
- **NIT-4.** `readWaiting` checks each op's shape (`isOpShape`, per op kind) and drops a malformed op; a record left with no ops and no fields goes.
- **Tests:** session storage's waiting key is now cleared before each test (a failed resend's record leaked into the next test).
- **Mutants:** 43 run (scratchpad `paste/mutate-r6d.py`): review 8's twelve listed survivors, with their patterns moved where 6d changed the code, and 31 for this round (the owns, the resends, the re-mark, the record, the probe, New's own save, the neutral line and chip, the offline board and List, the silent upload, the chip's tiles, the replay chip, the op shape, the probe listeners). All 43 are killed. Five needed a test after the first pass: Y4 (a view where both moved adds would take the same spot), Y21 (the line has to land in the microtask before React draws the board again, so the test switches back outside act), D5 (a change while the send is out isn't in the record), D13 (only GM's line is neutral) and D30 (an emptied record isn't written back).
- **Gates:** tsc 0; lint 0; focused vitest over 146 files, two workers: 2450 of 2450 (then the three touched files again after the last tests: 272 of 272); vite build; the build budget 444,788 B raw of 512,000.
- **Live (8797/5797, `serve_isolated.py`, a fresh token on stdin, canary first, 1440, Restraint):** 37 of 37. The driver is review 8's offline-live one (CDP `Network.emulateNetworkConditions` for offline, the in-page fetch wrapper for holds and the faked 429), with its two scenarios and o-1, o-2 and NIT-1 added.
  - o-1: offline, the new empty board showed only "No references yet"; Add images was disabled (opacity 0.45) with "You can add images when Nebula reconnects."; a real paste offline showed no line and held no spot. Back online, the hint and the button came back.
  - o-2: offline, then the resend answered 429: one resend; the line verbatim in ink rgba(255,255,255,0.55), edge 0.12, fill rgba(0,0,0,0.3), no button; the chip "NOT SAVED" in the same ink; one Retry (the header's), which landed it.
  - Review 8's undo-offline-rename: the record held only the add; after reconnect the writes were the resend's edit and then the rename's own PUT; the step was saved, and Cmd+Z put the name back on the server ("Undid: Name", Redo).
  - Review 8's net-offline: the edit failed with the network down; the probe took the tab offline; after 5 s the entry was a clean draft with no line and the record was kept. On reconnect it was sent once, landed, and the record went; the board showed no line.
  - Shots: scratchpad `paste/shots6d/` (9), each opened, no md5 repeats. The blocked log holds only canaries; no request left the lane.

## Round 6e (GM r13, the create resend)

Main had nothing new (still 53318ca6, already in 1d9ac159), so nothing to merge.

- **A create sent again makes one board (my 6d flag, closed).** An unsaved board's draft entry gets a create id at its first create (`createRequestId` on the entry, `crypto.randomUUID()`), and every create of that draft sends it as `requestId`: New's save, its Retry, the autosave, and the add-saved board's resend on reconnect. A new draft (reset) starts without one. The server (`MoodboardStore.create_once`) keeps each id as a small file in a side folder of the board store, `<moodboards>/.creates/<requestId>.json` holding the board id, so it holds across a restart; the scans already skip dot folders. A create whose id names a live board returns that board as it is now (same id, same version), writes nothing, isn't broadcast or said in the Agent log again, and is marked `repeated: true`. A check and a write share one lock, so two sends racing make one board. Without an id every create makes a board, as before; the id must be 8 to 128 letters, digits, `-` or `_` (else 422). A record whose board is gone (deleted, purged) is ignored and the create goes ahead (it then names the new board).
  - Decision: the id lives on the board store's side folder, not on the board. On the board it would come back in every GET and a GET-then-PUT would carry it into a route that refuses unknown fields.
  - Decision: `repeated` matters to the Studio. The repeat's board is the first send's; when the draft moved on between the two sends (an image landed or the name changed while the create was out), the second send's content isn't on it. Read as a normal answer, the rebase would count all of the draft's ops and fields as sent, and those images would vanish from the draft. On a repeat the Studio rebases with nothing counted as sent: its ops replay on the board (an add of an image the board has is skipped locally, and on the server by id) and its fields that differ go on a PUT; the draft is marked dirty again (`markLeftToSend`, now shared with `sendQueued`) so they're sent.
  - Out of scope, noted: a card move (`place`) made between the two sends, on a card the first create placed, is dropped on the repeat (its provisional placement id isn't on the board). Rare (a drag while a lost create is out).
  - Deviation from the brief: it said the id is "kept with the waiting record in sessionStorage". An unsaved board's draft lives only in memory: a reload drops it, and with it anything that could resend its create. So a copy in session storage would have no reader. The id lives on the draft's entry, which is what every resend reads. If an unsaved draft is ever kept across a reload, its id should go with it.
  - Agents: `moodboard_create` (MCP) takes `request_id`, `nebula moodboard new` takes `--request-id`, and `moodboard_client.create_board` takes `request_id`; each sends `requestId` only when given one, so an older Nebula sees the same body as before. Documented in the MCP docstring, the CLI help, `docs/MCP-SETUP.md` and the nebula skill.
- **The outside-view chip (GM r13).** One rule, `lib/boardPlacement.outsideForChip`: the chip points at a tile only while less than half its area is in view (`visibleShare` under `CHIP_SHARE`, 0.5). A tile bigger than the view still counts as seen while it covers the view's centre (GM r4 answer 9, r7 answer 1), since it may never get half its area in. Every chip site uses it: a paste's placement (`placeTiles`), a held spot that moved (`followMovedSpots`), the return to a board an add landed on (`chipFor`), a 409 replay's moved add (`chipMovedAdds`), and the chip's own going (it goes once every tile it points at is half in view).
  - A drop's chip rule is unchanged but filtered by the same rule: an aimed tile still gets the chip only when wholly out of view or reaching into the band with no spot left, and now only while less than half of it is in view. So a drop aimed mostly into the band keeps its chip; one that only clips the band doesn't. GM listed pastes, held spots and moved adds; I applied "only when" to drops too, since a chip over a mostly visible tile contradicts what the person sees whichever way it got there. Flag for GM if drops should differ.
  - Where it sits (`outsideChipText.placeChip`): on the view's edge nearest the first tile (judged against the view, not the pane), centred on that edge, 12 px in. The view is placement's: inside the insets, above the toolbar and the notices. Never on a tile: if the centred chip would cover a tile it points at (one poking into the view at the edge's middle), it slides along the edge to the nearest place clear of them, and with no room along it, steps in past them. GM said both "centred" and "never on the tile"; the slide only happens when the two conflict.
  - The arrow: one → glyph turned (`--outside-turn`) to point from the chip's centre at the first tile's centre, so a tile off to one side gets a slanted arrow, not a straight one out of the edge. It sits before the words when the tile is to the chip's left, after them otherwise. The chip enters by sliding 8 px in from its edge on the board's spring, as before.
  - Clicking it still frames the tiles (unchanged).
- **Tests.** Backend (`tests/test_moodboard_create_request_id.py`, 19): the lost answer sent again (one board, same id and version, `repeated`, nothing broadcast or said twice); a repeat returns the board as it is now; two drafts, two boards; no id, every create; bad ids refused; a repeat after the board was deleted; across a restart (each create in its own Python process); two racing sends; the side file the scans skip; a record naming no board; the client sends the id only when given; MCP and the CLI with the id; the CLI help. Frontend: the add-saved board's create made but its answer lost, sent on reconnect (one board, one id); New's save whose answer was lost with an image landing while it was out, then Retry (the image goes as an edit); a rename while the create was out (sent as a PUT after the repeat); every send of a draft carries its id and a fresh draft gets its own; a saved board's PUT never carries one. The chip: 49% and 50% past each edge, a corner's area, the big-tile rule, the band (49% stays, 50% goes), a tile half in view gets no chip, each edge's place and the arrow's turn, the slant toward a tile off to one side, never on the tile (slide, then step in), the view not the pane, the stylesheet's turn; placement at 49% and 50%; a band drop a third and a half in view; the return to a board at 49% and 50%.
- **Mutants:** 30 frontend (scratchpad `paste/mutate-r6e.py`: the id on each create path, a new id per send, the repeat rebase and re-mark in both paths, a reset keeping the id; the share threshold, the share's area, the big-tile rule, each chip site going back to the old rule, the aimed rule, the chip's going, centring, never-on-tile, the slide's order, the step-in, the arrow's turn and side, the view not the pane, the CSS turn, the zoom, the edge) and 13 backend (`paste/py6e/mutate-be.py`: the repeat, the lock, the record, a gone board, id checks, the broadcast, `repeated`, the client, MCP, the CLI, the route, a bad record). All 43 killed. Two needed a test after the first pass: C13 (the slide's test tile sat equally far from both stops, so the order didn't matter) and C19 (no mounted test zoomed).
- **Gates:** tsc 0; lint 0; focused vitest over 152 files (6d's 146 plus the six that use the draft store), two workers: 2537 of 2537; isolated pytest over the moodboard, MCP, CLI, asset-trash, rehome, skill and canvas-undo tests (41 files): 1867 passed; vite build; the build budget 444,788 B raw of 512,000 (unchanged: the Studio is lazy).
- **Live (8797/5797, `serve_isolated.py`, a fresh token on stdin, canary first, 1440, Restraint):** 17 of 18, then the one miss (the driver's check) again: 9 of 9.
  - The lost answer: New, a paste, the autosave's create made on the server but its answer dropped in the page (the in-page fetch wrapper's new `lose` mode). The line "Couldn't create the board." showed and the rail listed the board (the server's broadcast). Retry sent the same `requestId` (both sends logged); one board on the server and one row on the rail, with its image, and no line left.
  - nit-1, two-thirds: a 221-tile wall framed so a paste with no room in view lands just below it; the tile was 61% in view (placement's view): no chip.
  - nit-1, about a quarter: the tile 29% in view, pasted left of centre: the chip on the bottom edge, centred on the view (x 685 = the view's middle), clear of the tile, its arrow turned 155° toward the tile (measured 154.7°) and before the words. Its foot sits 12 px above the line clear of the toolbar and the notice band (785), which is 62 px above the view's bottom (847): the floor rule from review 2, unchanged. The first run's check expected the view's bottom; the chip was right and the check was fixed. A press framed the tile wholly in view and the chip went.
  - Shots: scratchpad `paste/shots6e/` (5), each opened, no md5 repeats. The blocked log holds only canaries; no request left the lane.

## Round 6f (GM r14, the failed create's line)

Main had nothing new (still 53318ca6), so nothing to merge.

- **A failed create says the save line (GM r14).** A new board's create that fails loses nothing: the draft keeps it all, and since 6e the create carries its id, so Retry after a lost answer makes no second board. It now says r12's line from `boardSaveLine.ts`, "Nebula couldn’t save the board because {cause}. Try again.": neutral, a status, the header chip "Not saved", the header's Retry only, and never "create" (after a lost answer the server may have made the board). No new string.
  - One helper, `boardSaveFailure(err)`, for every create path: New's save, its Retry and the autosave (`persist`'s create branch), and the save of an unsaved board an add landed on (`saveAway`'s first send and its resend). The paste flow's other background writes use it too: the queued send of a board New just saved (`sendQueued`'s first send, which was on the old look) and an add that couldn't reach a board the person left (`keepFailedAway`). Each of those also loses nothing (the draft keeps the image, Retry sends it), so the board says one thing whichever write failed.
  - Causes, each the same in the create and the save: no answer and a bare 502 ("the server isn’t answering"), 429 ("is busy"), 408/503/504 with words ("didn’t respond"), 500 ("hit an error"), 400 and a 422 on the content ("didn’t accept it"), 401/403 ("you don’t have access to this anymore"). Offline at send shows nothing in either path: the write waits under the banner and goes on reconnect (unchanged).
  - Kept out, the one destructive case: a 422 refusing the create's id (`isCreateIdRefusal`: a 422 whose detail names `requestId`). The id is one Nebula made, so this only happens if the id itself is broken; Retry sends the same id and fails the same way, so "Try again" would be wrong. It keeps the error look under the save heading ("Couldn't save the board.", the backend's reason under it). No other create failure is destructive: the draft is kept in every case.
  - `lib/api` `createMoodboard`'s heading is now the save heading; "Couldn't create the board." is gone from the app. It still shows on the id 422 only as "Couldn't save the board.".
  - Left as is (outside the rule): a saved board's own save (`persist` with a saved id: an edit, a rename) keeps the Studio's error look, "Couldn't save the board." over GM's short line, as GM's error-copy rounds 2-3f pinned it (`MoodboardStudioErrorCopy.test.tsx`). It loses nothing either, so GM may want it on the neutral line too; that changes GM's own pinned lines, so I flag it rather than change it.
- **The chip's in-view area leaves out the notice band.** It didn't before: 6e judged a tile against placement's view (the board less the toolbar's band), which runs down to the toolbar's top, while the chip's floor stands higher, above the notice region's reserved band. The 6e live run showed the gap: view bottom 847, floor line 785.
  - Now `BoardCanvas` gives every target a `seen` rect, placement's view cut at `floatingBottomLimit(0)` (lib/bottomBar: the bar's top less its gap and the reserved notice band, the line the chip's floor is measured from), in board coordinates. The chip's `viewOf` is that rect, so its going uses it too. `placeTiles` judges its outside list by `seen ?? view`; the Studio keeps `seen` with each add (`addViews`) and uses it for a moved held spot, the return to a board an add landed on, and a 409 replay's moved add. Placement itself still uses the whole view: a tile may still land in the band's strip, and then it gets the chip.
  - The band is the reserved one (there whether or not a notice is up), not the notices on screen, so a notice coming or going never changes what counts as seen, as the floor rule does for panels.
  - A drop aimed into the strip keeps its aim with no chip (unchanged: the aimed rule reports only a tile wholly out of view or under the toolbar's band); the person put it there.
- **The 29% shot.** The 6e quarter tile was 29.5% in placement's view, the view's bottom at 847. Measured again live in 6f, the same layout: the seen area stops at 785, so the strip of the tile in view (785 to 847) is all under the notice band, and the tile is 0% seen. The chip was right to show; 6e's area simply counted the band. A second live case shows the new rule: a tile 57% in placement's view, 0% in the seen area, now gets the chip (6e would have given none).
- **Sweep of the Studio's old red heading-plus-reason look:**
  - On this board's flow, fixed: the queued send's first failure and the failed away add (above).
  - On this board's flow, left: a failed upload of a pasted or dropped image ("Couldn't upload p.png." over the reason). The image isn't added, so it isn't the nothing-lost case; the error look is right by r12's own rule. A saved board's own save (above).
  - Elsewhere in the Studio, left (not the paste flow): "Couldn't load the board.", "Couldn't load the boards.", "Couldn't analyze the board.", "Couldn't save your brief.", "Couldn't undo the change." / "Couldn't redo the change.". Character Studio's lines are in the wording batch.
- **Tests.** Paste: for each of the 11 causes, the create path (New's save) and the save path (made1's resend on reconnect) give the same line, the same neutral notice with no button, the same "Not saved" chip and one Retry, and neither says "create"; offline at send says nothing in both; the id 422 keeps the error look. Six 6c-6e tests moved from the old look to the line. The per-cause test also presses the create's Retry (the same line again), and the autosave's create has its own test. ErrorCopy (the real lib/api and apiFetch, only fetch stubbed): a new board's create with no answer shows the line and the chip; the id 422 shows "Couldn't save the board." over the backend's reason with the "Error" chip. boardSaveLine: the helper is the save line for each cause, and the id refusal's edges (a field list naming it, another status, a word that only starts with it). The seen area: BoardCanvas targets carry it (the bar's gap, a 60 px notice band), the chip judges by it; placement reports a tile placed in the band's strip; the Studio's paste and away return under the band get the chip.
- **Mutants:** 24 (scratchpad `paste/mutate-r6f.py`): each failure site back to the old look (saveAway, sendQueued, keepFailedAway, persist's create), a saved board's save put on the line too, the id refusal never or always kept out, any status kept out, the word boundary, the field list, the api heading saying create, the chip not reading the line; the seen rect as the view, the band ignored, the chip judged by the view, each target without `seen`, `placeTiles` ignoring it, the Studio not passing it, `addViews` not keeping it, and each of the three Studio chip sites by the view. All 24 killed. Two needed a test after the first pass: F4 (New's save goes through `keepUnsaved`, not `persist`, so the per-cause test now presses Retry, which is `persist`'s create, and a new test covers the autosave's create) and S9 (a 409 replay's moved add judged by the seen area).
- **Gates:** tsc 0; lint 0; focused vitest over the same 152 files, two workers: 2559 of 2561, the two misses timeouts under a machine load of 23 (`pr198Fix2Money`'s 20,000-case property test and `errorCopy.namedLine`'s file scan), both passing alone (84 of 84); `npm run build` with the budget: 444,788 B raw of 512,000 (unchanged), dist deleted. The backend didn't change, so no pytest.
- **Live (8797/5797, `serve_isolated.py`, a fresh token on stdin, canary first, 1440, Restraint):** 14 of 14. New, a real paste, the autosave's create made on the server and its answer dropped in the page: the one line on the board was "Nebula couldn’t save the board because the server isn’t answering. Try again.", neutral (no error class, a status, no button), the header chip "Not saved" in ink 0.55, one Retry (the header's), no "create" anywhere. Retry sent the same id: one board, no line left. The 29% case and the band cut as above. Shot: scratchpad `paste/shots6f/r6f-lost-create-not-saved-line.png`, opened, no md5 repeat against 6e's. The blocked log holds only canaries; no request left the lane.

## Round 6g (GM r15, review 9)

Main had nothing new (still 53318ca6), so nothing to merge.

- **A repeat rebases on the attempt that made the board (GM r15 1, review 9 MEDIUM-1).** In 6e a repeat counted none of its send as landed, so every op replayed and every changed field went on a PUT, even over what the board had done since: a rename on the rail, a removed image, an agent's edit (R9-A, R9-B).
  - Each create now sends an attempt number beside its `requestId` (`createAttemptFor`). The entry keeps the last 10 attempts, each with the queued ops it sent and its fields as sent.
  - The server records which attempt made the board and the version then (1). A repeat answers `repeated`, `madeAttempt` and `madeVersion`.
  - `repeatOnBoard` rebases the draft on the board as it is now, counting that attempt's sent ops and fields as on it. So the board's own later changes win, and only what the draft did after that attempt replays. With no record of the attempt (an older server), it falls back to 6e's replay-all.
  - A field both sides changed goes to the later edit: the draft's edit time (`fieldEditedAt`, stamped per top-level field by the store's `edit`) against the board's `updatedAt`. Both clocks are this machine's (the backend is local), so they compare. With the board unchanged since it was made (`version == madeVersion`), the draft's edits all go, whatever the clocks say.
  - When the board's value wins over a draft edit, one neutral line says so: "Kept the name “Rivers” from the board." (GM's wording). It's a status with no button, and the next edit takes it away. For other fields I built "Kept the notes from the board." and the like (`KEPT_FIELD_NAMES`, behind `KEPT_FIELD_PENDING_GM`); that wording waits on GM.
  - R9-B: the made board was open from the rail with its own draft and Undo. The create's answer used to `copyTo` over it, so its epoch and Undo went. Now `handOver` folds the unsaved draft's leftover ops and fields into the open board's entry, which keeps its epoch and steps. A board not loaded still takes `copyTo`.
- **The chip by what is actually seen (GM r15 2, review 9 MEDIUM-1).** 6f cut a full-width strip at the toolbar's line, so a tile wholly on screen beside the pill read as 44% seen and got the chip (`r9-area-045`).
  - `BoardCanvas.seenArea()` is `{ view, covers }`. `view` is the board pane clipped to the window. `covers` are the boxes really over it, each clipped the same way: every `[data-bottom-bar]` (the toolbar pill), every `[data-notice-band]` (across that element's own width, not the column's), and the notices on screen now (`.notice-region__stack > *`, `.moodboard-studio__notice`).
  - `visibleShare` takes the tile ∩ view less the exact union of the covers inside it (`unionArea`, a grid over the edges, so overlapping covers count once). `outsideForChip`'s big-tile rule still uses the view.
  - Every chip site uses it: placement's outside list, the chip's own going (`OutsideChip seenOf`), a moved held spot, the return to a board an add landed on, and a 409 replay's moved add. Placement keeps its own view and band.
  - The brief's "the pane inside its insets": #213's insets are only the bar's full-width band, which is the strip MEDIUM-1 is about. So the pane is taken whole and the pill's real box is taken off instead.
  - Unlike 6f, a notice coming or going now changes what counts as seen (GM r15 2: "the notices on screen now").
- **The unsaved draft survives a reload (GM r15 3, review 9 LOW-2).** `unsavedDrafts.ts` keeps each unsaved board's draft in this tab's session storage (`nebula:moodboard-unsaved-drafts`), the way the waiting sends are kept.
  - What's kept: the images a later page can show, their queued adds, the create id, the attempts (sent ops as indices into the kept ops), the edit times, and the failure (line, Retry) if it had one.
  - An image only that page held (a `blob:` or `data:` url, not uploaded yet) can't be kept, and its add goes with it.
  - Entries more than a day old, or of no known shape (key, images, ops by `isOpShape`, attempts, line, id), are dropped when read. At most 10 are kept. Storage that throws keeps nothing and breaks nothing.
  - Restored once at module load, before the first render, unless the key holds a loaded draft. It comes back with the error look, its line and Retry (or as a draft to send). Retry sends the same id as the next attempt, so a create whose answer was lost before the reload still makes one board.
  - The page asks before unload only when the last write failed (storage full or blocked) and an unsaved board with images is open. Otherwise it never asks.
  - An entry this page held and whose draft is gone (discarded, or handed over to its saved board) goes. One this page never held stays.
- **A create cut off by a network drop is a background send (GM r15 4, review 9 LOW-1).** Since it carries its id, a resend is safe.
  - `persist`'s create and `saveAway`'s first send ask for a health probe after no answer (`createWaits`). If Nebula is offline then, the draft waits with no line under the banner, and the autosave sends it once on reconnect with the same id as the next attempt.
  - If that resend is cut off too, it doesn't wait again: it says the neutral line with "Not saved".
  - A 5xx is an answer, so it says its line at once with no probe. The waited set lives in `boardAdds` so `resetBoardAdds` clears it.
- **Server (GM r15 5).** Built by a helper agent to my contract; I checked it against the Studio.
  - Write order, documented above `_CREATES_DIR`: the record as "pending", then the board, then the record as "made". A crash between them leaves a pending record whose board is live (read as the repeat, and marked made then) or one naming no board (ignored and overwritten).
  - Records expire after 7 days (`CREATE_RECORD_DAYS`). They're pruned at startup and on at most one create a day, and purged with their board, through the single purge and empty-trash routes. Kept while the board is in Recently deleted, since a restore brings the same id back.
  - A project's purge removes only its catalog entry, not its board files, so there are no records to drop on that path. They expire.
  - Every scan, export, zip and import path was checked for `.creates`. Commons' `intake._moodboards` reaches it and refuses it as a project id; the others skip dot folders or never read the moodboard root.
  - An id from another scope gets a 409 with `code: "request_id_scope"` and never returns the other scope's board. A board behind a record that can't be read gets a plain 500 ("Nebula couldn't read the board this request id made. Use a new request id."), never the parser's text and never a second board.
  - The Studio treats that 409 as it treats the id 422 (`isCreateIdRefusal`): it drops the id and its Retry goes without one.
- **The agent repeat (GM r15 6).** `moodboard_create` (MCP) and `nebula moodboard new` say "Board “X” was already made by an earlier call with this request id." and return that board. The client skips its image-count check on a repeat. The docstrings, the CLI help, `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md` now say: an id is unique per board; a reused id returns the first board whatever the rest says; an id from another project is refused; ids are kept 7 days. The copy sweep passes.
- **7(a): a saved board's own failed save stays.** `failSave` never rolls back: the edit stays in the draft, dirty, and Retry resends it. So it moved to `boardSaveFailure`'s neutral line with "Not saved", as the create did in 6f.
  - What GM loses, listed for them: the backend's own reason (a 409 "This board is locked while it is being moved.", a full disk), the short lines, the 413 "That's too large to save.", the 403 "Reload to sign in again", and the three-conflicts "Reload to get the latest version". Each now reads its cause clause and "Try again.", the same as the create already did in 6f.
  - The not-loaded saved board in `keepFailedAway` (review 9 NIT-2) is the one exception. Its add went in no draft, so something is lost: the red save line, with no Retry.
- **7(b): the id refusal's line, behind one constant.** `CREATE_ID_REFUSED_LINE` = "Nebula couldn’t save the board because the server refused its save id. Retry saves it without one." It's the because form, with no "Try again". It ends with the step that works, since after the refusal the Studio drops the id (`createRequestId: null`) and its Retry sends the create without one. It shows in the error look (`isBoardNotSavedLine` now also needs the ". Try again." ending). It's held behind `CREATE_ID_REFUSED_PENDING_GM` until GM confirms. GM's guess ("Copy the board’s images to a new board.") names a step the Studio doesn't offer.
- **Review 9's other items.**
  - NIT-1: a held spot moved out of view takes its tile's thumbnail.
  - NIT-2: as above.
  - LOW-4 test gaps, each now killed: backend R1-R7 by the helper; frontend R10 (a card that only touches the chip's tile), R23 and R24 (an owned name another window already set: the record keeps no field, and the resend PUTs none), and R27 (saveAway's repeat with an image added while it was out).
- **A reload found in the live run.** Run 1 left the reload scenario's kept draft in the tab, and the next scenario's New saved it before opening a fresh board, as New does for any unsaved board with images. That is the intended behaviour; the driver now finishes each scenario clean.
- **Tests.**
  - `unsavedDrafts.test.ts` (new, 22): write and restore with the line, Retry, id and attempts; restore at install; blob images and their adds dropped; nine kinds of bad entry ignored; never over a loaded draft; gone once saved, emptied or discarded; another page load's entry kept; the unload warning only after a failed write.
  - Paste (new or changed, about 25):
    - R9-A and R9-B, including the open board's rename still out when the repeat lands, and what the unsaved board still had (an image, notes) folded in and sent;
    - the later-edit rule both ways; the board unchanged since it was made; a field the server keeps differently; a name sent with a space;
    - a repeat naming no attempt of this draft's;
    - the cut-off create waiting offline and resending once, and its failed resend;
    - the 422 and its id-less Retry; a reload after a 5xx;
    - NIT-1, NIT-2, R10, R23 and R24, R27.
  - ErrorCopy: a saved board's failed save on the neutral line for each cause (an image edit and a rename); the scope 409. boardSaveLine: the constant and the 409. boardPlacement, BoardCanvas and OutsideChip: the seen area, its covers, the window cut.
- **Mutants:** 68 frontend (scratchpad `paste/mutate-r6g.py`), 66 killed.
  - Two are equivalent. A14: the asSent name standing in for the board's trimmed one; every compare trims the name. The R27 variant counts saveAway's sent ops as unsent on a plain create; the rebase skips an add whose image the board has.
  - Eleven needed a test after the first pass: A6, A8, A15, H1-H4, R23 (a `toMatchObject({ fields: {} })` that matched anything), U1, U4, C3 and C7.
  - The backend's 44 (R1-R7 and G1-G37) are all killed (the helper's `py6g/mutate-be.py`).
- **Gates:**
  - tsc 0; lint 0.
  - Focused vitest over 153 files, two workers: 2608 of 2608.
  - Isolated pytest: 945 over the 23 moodboard, MCP, CLI, copy-sweep and ratchet files, then the request-id and copy-sweep files again after the last change (148 passed).
  - Build budget: 444,797 B raw of 512,000. dist deleted.
- **Live (8797/5797, `serve_isolated.py`, a fresh token on stdin, canary first, 1440, Restraint, the cached Chrome 131 headless shell):** 33 of 33 on run 2, after run 1's two driver fixes (the reload landing on Projects home; a too-strict "wholly seen" check).
  - The lost create, then Dusk typed into the unsaved draft, then Rivers typed on the board opened from the rail, then Retry. The board keeps "Rivers", Dusk is never PUT, and the one neutral status says "Kept the name “Rivers” from the board.". Three creates, one id, attempts 1, 2, 3.
  - The area-0.45 case, the tile clear of the pill: 74% seen (the notice band's reserved strip takes 12 px), no chip. The same frac under the pill: 17% seen, the chip. Beside the pill: 91% seen, no chip.
  - A reload after two 5xx creates: no leave prompt; both images, the "didn’t respond" line, "Not saved" and Retry back. Retry made one board with both images under the first id, and the kept entry went.
  - A create cut off by a network drop: no line, "Draft" under the offline banner. On reconnect it was sent once more with the same id as attempt 2: one board, no line.
  - The CLI, twice with one `--request-id`: "Made Dusk CLI …", then "Board “Dusk CLI” was already made by an earlier call with this request id. Its id is 809aa7d6c8bc, with 1 image. It's in Moodboard Studio.". The same id with `--project current` was refused with the 409's sentence, exit 1. The repeat still uploads its files before the create answers; those uploads stay unused, like any upload not added.
  - No request left the lane.
  - Shots: scratchpad `paste/shots6g/` (7), each opened, no md5 repeats.

## Round 6h (GM r16)

Main had nothing new (still 53318ca6), so nothing to merge.

- **Each failed board save says its own cause and the step that works (GM r16 7a, 7b).** `boardSaveLine(err)` returns the line and what the header offers. It reads only the answer's status and structured fields (`code`, `storage: "full"`), never its words, so no backend wording reaches the person.
  - The server isn't answering, is busy, didn't respond, hit an error: ". Try again.", with Retry.
  - The disk is full (a 507 with `storage: "full"`): ". Free up some space, then try again.", with Retry.
  - Too large (413): ". Remove some images, then try again.", with Retry.
  - Signed out (401/403): ". Reload to sign in again." Changed somewhere else (a conflict the rebase gave up on after three tries, or a 409 `version_conflict`): ". Reload to get the latest version." Neither has a Retry: a new `StudioRetry`, `'reload'`, which `canRetry` and `saveOwed` both leave out.
  - Any other refusal, the create id's 422 and its 409 `request_id_scope` included: "…because the server didn’t accept this save. Try again." (7(b)). `CREATE_ID_REFUSED_LINE` and its pending flag are gone; the Studio still drops a refused id, so Retry creates without it.
  - All of them are neutral with "Not saved", since the edit stays in the draft. `isBoardNotSavedLine` now checks only the opening.
  - The ratchet (`boardSaveLine.test.ts`) sends every status from 400 to 599, with 9 codes, storage full or not, and a sentinel detail and reason. Every line must be one of GM's, with none of the sentinel.
- **"Being moved": not built.** The 6g list took it from a frontend test fixture ("This board is locked while it is being moved."), not from the backend. No board save is refused for a move: there is no move lock, `store.move` keeps the version, the PUT addresses the board by id wherever it lives, and the Studio's own move holds the draft's save slot (`beginSave`), so a save waits for it rather than failing. There is no refusal to map the line from, so I flagged it instead of inventing a code. The fixture's words now read "The store refused this write.".
- **The red lost add (GM r16 7a).** `lostAddLine(names)`: "Nebula couldn’t add “river.png” and “dune.png” because the board hadn’t loaded. Add them again." Up to three names (each the placeholder's label, clipped as the tile shows it), joined like the Kept line, then "4 images". The ending is "Add it again." for one file and "Add them again." for two or more, the count form included ("Add it again." after "4 images" reads wrong). No Retry: nothing is left to send.
- **The lost add was never seen.** The live run found that `keepFailedAway` set the line on the board's entry while its draft wasn't loaded, and the board's own load (`patch({ saveError: null })`, then `initialize`) wiped it the moment the person opened the board. That has been true since 6g's NIT-2. The load now keeps a lost-add line (`isLostAddLine`) through both, so the person sees it when they open the board. The next edit clears it, as with any line.
- **Kept lines (GM r16).** "Kept the name from the board.", "Kept the name and notes from the board.", "Kept the name, notes and mode from the board.", then from four fields "Kept 4 changes from the board.". The join is "and" with no serial comma (`joinWithAnd`, shared with the lost add). The field names are nouns after one "the": name, notes, mode, strength, direction, avoid list, pinned colors, brief, clash setting, color choices, notes setting, analysis. The board's name is no longer quoted, per GM's examples. `KEPT_FIELD_PENDING_GM` is gone.
- **One board per Retry scenario, on a clean rail (GM's check).** Each live scenario ran on its own backend home and token, made and deleted per scenario, with its own browser profile. Every home was empty before its seed (checked). The server's boards after each:
  - rename: "Rivers" (1 image) and the seeded board;
  - name and notes: "Rivers" (1) and the seed;
  - reload-restore: one "Untitled Moodboard" (2) and the seed;
  - network drop: one "Untitled Moodboard" (1) and the seed;
  - 7(b): one "Untitled Moodboard" (1) and the seed; signed out: the seed only; lost add: the seed and a second seeded board.

  So 6g's duplicate rail rows came from run 1 sharing its home, not from a second board per Retry.
- **For GM.**
  - "Reload" drops a saved board's kept edit. Only unsaved boards are kept for a reload (session storage), and nothing asks before unload for a saved board. That fits "Reload to get the latest version"; it may not be what GM wants for "signed out".
  - On the signed-out shot, the app's own banner says "This tab isn't connected as you. Open the link Nebula printed when it started." With a stale token, that link is the real fix, and a plain reload keeps the stale token. GM may want the board line's step to match the banner.
- **Tests.** `boardSaveLine.test.ts` rewritten (17 causes with each one's Retry or none, the ratchet, lost add 0-4, Kept 0-4 and every field, the join). ErrorCopy: each refusal through the real lib/api, its chip and Retry; both id refusals on 7(b). Paste: the signed-out create and save; "Kept the name and notes"; the lost add named, and shown once the board loads; an away write signed out. View: the Move test's 409 shows 7(b)'s line and not its words.
- **Mutants:** 32 (scratchpad `paste/mutate-r6h.py`), all killed. H25 (an away failure always offering Retry) survived the first pass and is killed by the signed-out away test.
- **Gates:** tsc 0 (the build's `tsc -b`); lint 0; focused vitest over 153 files, two workers: 2632 of 2632; the build budget 444,797 B raw of 512,000 (the Studio is a deferred chunk; dist deleted). No backend change, so no pytest.
- **Live (8797/5797, the installed Chrome 156 with a throwaway profile per scenario, canary first, 1440):** 68 of 68 over 7 scenarios, after the lost-add fix (the first lost-add run was 4 of 5). The 7(b) line came from the real server's 422 for a malformed id (the page rewrote the id), and the signed-out line from its real 403 `person_required` for a stale token while turning on "Send these notes to generators". The lost add came from the real server's 422 for an edit body it refuses, with the draft let go as the NIT-2 test does. No request left the lane. Shots: scratchpad `paste/shots6h/` (6), each opened, no md5 repeats.

## Round 6i (GM r17)

Main had nothing new since 6h's merge of #217 (02b291ba), so nothing to merge.

- **"Being moved": nothing to remove.** 6h never built it; no code or test maps to it.
- **A saved board's kept edit survives a reload (GM r17 2+3).** Before, only unsaved boards were kept. A saved board's unsent edit (a failed save, one still out, one waiting for Nebula) lived only in memory, so "Reload" in the conflict line dropped it.
  - What is kept (`keptEditOf`, in `unsavedDrafts.ts`, session storage `nebula:moodboard-kept-edits`): each board field the draft holds differently from what it last read (a name differing only by spaces doesn't count), what it was changed from (`base`), the edit times (`fieldEditedAt`), and the queued ops whose images are on the server. Keyed by the board's id, not the draft key, so a project switch or a move still finds it. Never the board itself. It is written with every change of the draft, and dropped once the draft holds nothing unsent.
  - An earlier page load's edit stays in storage until its board loads (`syncEdits` keeps another load's record while this page neither holds it nor has the board loaded). The board's load takes it once (`takeKeptEdit`), never this page's own.
  - The replay (`replayKeptFields`, then `replayKeptEdit` in the Studio) works on the board as the server has it then. A field the board already holds as the edit has it is left alone. One the board didn't change since the edit read it takes the edit's value. One it did change goes to the later edit, the edit's time against the board's `updatedAt` (no time: the board's), and a board win is named in the "Kept …" line. Ops replay on the board's images: an add whose image the board has is dropped (a save that landed before the reload), a remove keeps only images still there, and `rebaseDraft` drops ops on images that are gone. The draft is marked unsent (`markLeftToSend`), so the autosave sends it, and its edit times carry over (so a second failure and reload weigh it the same).
  - A send that waited for Nebula (`takeWaitingSend`) is taken and dropped when a kept edit replays, since the kept edit holds it. Left alone, its fields would overrule the replay (a mutant showed it).
  - Cases the brief asked about:
    - Two tabs on one board: each keeps and replays only its own edit (per-tab storage). The server's version decides between them as it does live. A duplicated tab copies session storage, so both copies would replay it: the existing Duplicate Tab follow-up.
    - Board deleted before the reload: nothing replays ("Moodboard not found" or the Recently deleted line, as before), and the edit stays for a day. Restored and opened in that tab within the day, it replays. (Round 6j now says so when the Studio opens, below.)
    - Every field older than the board's change: the board's values all stay, nothing is sent, and the line names them ("Kept 4 changes from the board." from four).
    - A project switch: found by board id wherever the board is opened.
  - The page asks before unload only when that storage write failed (`unsavedWouldBeLost` covers both kinds).
  - Found live: a change the open tab sees (the board's live update) is folded into its draft at once, the person's unsent edit kept over it, as before this round. So its `base` moves on, and after a reload that edit goes on. The "Kept …" line after a reload is for changes the tab never saw (made while it was closed or reloading). If GM wants the later-edit rule live too, that's the existing follow path, not this round's.
- **Lines (GM r17).**
  - Signed out: "Nebula couldn’t save the board because you’re signed out. Open the link Nebula printed when it started.", matching the banner, with no Retry.
  - Conflict: "Nebula couldn’t save the board because it changed somewhere else. Reload to get the latest version.", with no Retry. It is now true, since the edit survives the reload.
- **The one-field Kept line (GM r17, addendum).** Only the name shows its value: "Kept the name “Rivers” from the board.". It is trimmed and clipped past 40 grapheme clusters (`KEPT_NAME_MAX`, `clipGraphemes`: 39 and an ellipsis), with the full name in the line's `title`. The notice became `StudioNotice` (text, or text and title). Every other field, free text included, never shows a value, and several fields stay without values.
- **The lost add's chip (GM r17).** `keepFailedAway`'s not-loaded branch and the load that keeps its line no longer set `saveState: 'error'`. The board saved, so its chip stays "Saved", and the red line carries the loss. It still offers no Retry and goes with the next edit.
- **Tests.**
  - `unsavedDrafts.test.ts`, 11 new: what a kept edit holds and doesn't; written and dropped with the draft; an earlier load's edit waiting for its board, taken once, never this page's own; another board's write leaving it alone; bad or old entries; the unload warning; the replay rule each way, every field older included.
  - Paste, 8 new: through a reload; conflict then reload; renamed elsewhere after the edit (name and title) and before it; ops replayed and deduped; refused again with its first edit time; a waiting send beside it; the board deleted first. The lost add's chip.
  - boardSaveLine: the signed-out step, Retry exactly where the line says try again, the clipped name and its title.
- **Mutants:** 29 (scratchpad `paste/mutate-r6i.py`), all killed. K6 (another board's write dropping a stored edit), K16 (the waiting send left beside the replay) and K21 (edit times lost after a replay) survived the first pass and needed the tests above.
- **Gates:** tsc 0 (the build's `tsc -b`); lint 0; focused vitest over 153 files, two workers: 2652 of 2652; the build budget 444,797 B raw of 512,000 (dist deleted). No backend change.
- **Live (8797/5797, the installed Chrome 156 with a throwaway profile, a fresh home and token per scenario, canary first, 1440):** 28 of 28 over 4 scenarios.
  - A rename whose PUT failed (the page's 503), then a reload: no prompt, "Dusk" back in the field and saved (version 2), storage empty, no line.
  - The real server's 409 three times (the page sent an old base version): the neutral conflict line, "Not saved", no Retry. The notes were then changed elsewhere, and after a reload the name replayed on the newer version (3 to 4) with "agent notes" kept.
  - The tab away, the board renamed elsewhere to a 56-character name, then opened again: "Kept the name “Rivers at dusk over the long valley, se…” from the board.", its title the full name, and Dusk never sent.
  - Two named files lost on a board not loaded: the red line, "Saved", no Retry.
  - No request left the lane. Shots: scratchpad `paste/shots6i/` (4), each opened, no md5 repeats.

## Round 6j (GM r18)

Merged origin/main at 062fb370 (#218, #211) with no conflicts. `broadcast_raw` now takes `others=`, so the create request-id test's broadcast stand-in takes `**_`.

- **A kept edit whose board was deleted (GM r18).** Before, a board deleted before its kept edit could replay said nothing, and the edit waited a day (6i). Now it is said when the Studio opens.
  - What is looked up: `keptEditsWaiting()` (in `unsavedDrafts.ts`) lists the kept edits an earlier page load of this tab left and this page doesn't hold. The Studio looks up each one's board (`lookupStoredAsset`, whose 404 says `in_trash` with the trash record) on mount, and again when it opens another board or a delete lands (`deleting.refreshKey`). A board that is there says nothing (its own load replays the edit), and so does one Nebula didn't answer about.
  - In Recently deleted: the neutral line in the Studio's notice region with Restore. For one board, Restore calls the existing trash restore route (`restoreTrashed`, `POST /api/trash/moodboard/{id}/restore`). That route isn't person-gated, since a restore undoes a delete, so nothing about the gate changed. Restore then opens the board where it lives (the trash record's `projectId`), and its load takes and replays the edit by the 6g rule, with a Kept line when the board's side wins. When the board was already open (as "in Recently deleted"), the same route wouldn't reload it, so Restore bumps its revision. A restore that fails gives a red line under it ("Couldn't restore the board.", the because form from `failureCopy`), and the Restore line stays.
  - Several boards in Recently deleted: Restore opens the rail's Recently deleted instead, on the first board's scope (`MoodboardRail`'s new `trashRequest`, `RecentlyDeletedAssets`'s new `openRequest`). A request opens the list only if made after it mounted, so a later rail remount doesn't reopen it.
  - Gone for good (a plain 404): the red line, with no Retry or Restore. The stored edit is dropped as the line goes up (`dropKeptEdit`, which never drops this page's own). The line stays while the Studio is open and isn't said again.
  - Names: a kept edit now records the board's saved name (`name`, trimmed; the draft's when the board has none). That is the name Recently deleted and the rail show, not a rename that never saved, so a purged board can still be named. A trashed board is named from its trash record first.
- **The lines (`deletedBoardsLine` in `boardSaveLine.ts`).** Names are quoted, each clipped past 40 grapheme clusters as in the Kept lines, up to three joined with "and" (no serial comma), then a count. The line's `title` holds every full name. A blank name reads "Untitled".
  - In Recently deleted:
    - 1: "Nebula couldn’t save your change to “Rivers” because the board was deleted. Restore it to keep the change."
    - 2: "Nebula couldn’t save your changes to “Rivers” and “Dusk” because they were deleted. Restore them to keep the changes."
    - 3: "Nebula couldn’t save your changes to “Rivers”, “Dusk” and “Sea” because they were deleted. Restore them to keep the changes."
    - 4+: "Nebula couldn’t save your changes to 4 boards because they were deleted. Restore them to keep the changes."
  - Gone for good:
    - 1: "Nebula couldn’t save your change to “Rivers” because the board was deleted somewhere else."
    - 2: "Nebula couldn’t save your changes to “Rivers” and “Dusk” because they were deleted somewhere else."
    - 3: "Nebula couldn’t save your changes to “Rivers”, “Dusk” and “Sea” because they were deleted somewhere else."
    - 4+: "Nebula couldn’t save your changes to 4 boards because they were deleted somewhere else."
  - Both at once: two lines, the Restore one first, each with its own names or count.
- **Style.** The Restore line is a flex row with its button at the end (`.moodboard-studio__notice--action`, `.moodboard-studio__notice-action`, Restraint-scoped). The button is the toolbar's button.
- **Found while building.**
  - The repo's hand-built-line ratchet (`tests/lib/errorCopy.namedLine.test.ts`) caught the first version, which pieced the Restore step onto the sentence from a slot. Each of the four forms is now written out whole, so it reads as GM wrote it and passes without an allow-list entry.
  - When a deleted board is itself the one open (its route reloaded), "This board is in Recently deleted. Restore it from the list on the left." still shows above the new line. Both are true and the new line has the button, but GM may want only one.
- **Tests.**
  - `boardSaveLine.test.ts`, 3 new: each form from 1 to 4+ names in both kinds, the 40-character clip with full names in the title, and blank names as Untitled.
  - `unsavedDrafts.test.ts`, 2 new and 1 extended: the saved name recorded (not the unsaved rename, the draft's as fallback, none when blank); edits waiting vs this page's own; dropping one (never this page's, nothing written when it isn't there).
  - Paste, 11 new and 1 rewritten:
    - In Recently deleted: the neutral line with Restore, the edit kept.
    - Restore on the open board: the trash route, the reload, the edit replayed and sent, the line gone.
    - Restore of a board not open: it opens where it lives.
    - A failed restore: red, the Restore line stays.
    - Gone for good: red with no buttons, storage cleared. The 6i "deleted before the reload" test now expects this.
    - Mixed: two lines, neutral first, each titled.
    - Several: Restore opens the rail's list, in a project's scope too.
    - No answer, or the board there: nothing said, edits kept.
    - Looked up again on a board change.
    - This page's own edit never looked up.
  - `AssetTrash.test.tsx`, 1 new: `openRequest` opens the list only for a request made after mount, and again for each new one.
  - The Paste file's lookup stand-in now answers as the route does (the board when it's there), not always "missing".
- **Mutants:** 33 on the lines, the storage, the lookup, Restore, the rail and the list (scratchpad `paste/mutate-r6j.py`), all killed. The line and name mutants were run again after their code changed.
- **Gates:**
  - tsc 0 (the build's `tsc -b`); lint 0.
  - Focused vitest over 154 files (6i's 153 plus `AssetTrash.test.tsx`), two workers: 2685 of 2685.
  - The build budget: 447,725 B raw of 512,000 (main's merge included; dist deleted).
  - Isolated pytest over the 23 backend files 6g used (the merge, the stand-in): 947 passed.
- **Live (8797/5797, the installed Chrome with a throwaway profile, a fresh home and token per scenario, canary first, 1440):** 28 of 28 over 3 scenarios.
  - Trashed: a rename to "Dusk" whose PUT failed (the page's 503), with the kept edit naming "Rivers". The tab went away, the board was deleted through the route (to Recently deleted), and the Studio opened on another board. It showed the neutral line naming “Rivers” with Restore (title “Rivers”), and the edit was still stored. Restore brought the board back, opened it, and replayed and saved "Dusk"; the line was gone and storage empty.
  - Purged: the same, then deleted for good. The red line named “Rivers” with no buttons or Retry, and storage was cleared. The next open didn't say it again.
  - Mixed: Rivers and Harbor in Recently deleted, Sea deleted for good. The two lines showed, neutral first: "…your changes to “Rivers” and “Harbor” because they were deleted. Restore them to keep the changes." and then "…your change to “Sea” because the board was deleted somewhere else.". Restore opened the rail's Recently deleted listing both boards, and restored nothing.
  - No request left the lane. Shots: scratchpad `paste/shots6j/` (5), each opened at 1000 px, no md5 repeats.

## Round 6k (GM r19)

Main hadn't moved past 062fb370, so nothing to merge. GM signed off 6j's design, agreed to naming a board by its saved name, and asked for four fixes and one answer.

- **GM's answer: one line for the open board.** When the open board is in Recently deleted and has a kept edit waiting, the load's "This board is in Recently deleted. Restore it from the list on the left." is dropped for it, and only the kept edit's line shows. With no kept edit, that line stays as it was.
- **1. The red line (deleted for good).**
  - It has a × (`aria-label="Dismiss"`, `.moodboard-studio__notice-close`).
  - It clears when another board opens: a render-time check on `moodboardEditorId`, so it is gone before the new board's lookup answers.
  - It is a `status` line, and a re-check adds nothing to it. Its edit was dropped the first time, so the same element and text stay and it isn't said again.
- **2. Restore's confirmation.** Recently deleted's own Restore gives none, so both paths get GM's neutral status line: "Restored “Dusk” and saved your change."
  - It shows once each restored board is loaded (so it's back and its kept edit replayed) and clean. A save out leaves the draft dirty, so clean means saved.
  - It names the board as it is now (the replayed name), each name clipped at 40 with the full names in the title.
  - It goes when another board opens. A "Kept …" line from the replay follows it.
  - A failed save shows its own line instead, and no confirmation.
  - A board the line names that is restored from Recently deleted gets the same confirmation (`boardRestored`). A board no line named gets none.
- **3. Restore for several.**
  - Recently deleted opens on the first board's scope. `RecentlyDeletedAssets`'s `openRequest` is now `{ n, focus, keyboard }`: focus goes to the Restore button of the first of the line's boards in that scope's list. That is the line's order, so Rivers here, though the list shows Harbor first. The focus waits for that scope's list, and it is moved once, never again on a reload.
  - The ring shows only when Restore was pressed from the keyboard (`event.detail === 0`, then `focus({ focusVisible })`), as `SceneClashNotice` does.
  - As each board is restored there, the line names the ones left (the one-board form at one). When all are back and saved, it goes and one confirmation names them by the same rule:
    - "Restored “Rivers” and “Harbor” and saved your changes."
    - "Restored “Rivers”, “Harbor” and “Sea” and saved your changes."
    - "Restored 4 boards and saved your changes."
- **4. Empty in the list a line opened: kept and scoped (no change).**
  - The list the line opens is the rail's ordinary Recently deleted for that scope, not a narrower one, and every board in it is on screen.
  - Empty sends exactly the listed ids (`emptyTrash(filter, items)`), and `POST /api/trash/empty` deletes only those (`test_emptying_deletes_only_what_the_person_saw`).
  - So it already empties only what the list shows. A test pins it for a list a request opened. No shot is needed.
- **5. Rivers and Dusk: one setup, and Restore opened the board it named.** The board's saved name was "Rivers", and its kept edit renamed it "Dusk" (a failed save). The line names the saved name, as GM agreed. Restore opened that board (6j live checked the id), and its replay renamed it Dusk. So no bug. 6k's confirmation now says "Restored “Dusk” …", and the test checks the same id.
- **Found and fixed on the way.**
  - A board restored from the rail's Recently deleted while it was the open route (as not found or in Recently deleted) didn't reload: the same route doesn't change, and the live update skips an entry with no saved id. `openBoard` now loads it again. The line's Restore uses it too.
  - Recently deleted wiped a Restore or delete refusal at once: the list reads itself again after every action, and that read cleared the line. That made `asks before deleting for good` flaky under load. A load's line and an action's line are now kept apart, and the read clears only a load's.
  - The confirmation and the deleted-board lines share their naming (`namedBoards`). Each sentence is written whole, so the hand-built-line check passes.
- **Tests.**
  - `boardSaveLine.test.ts`, +1: the confirmation's 1/2/3/4+ forms, the clip, the title and Untitled.
  - Paste, +7 new and 6 changed:
    - The open board's one line, and the old line kept with no kept edit.
    - The confirmation only after the held save lands, and gone on another board.
    - The Kept line after the confirmation.
    - No confirmation on a failed save.
    - A rail restore of the open board: reload, replay, confirmation.
    - A rail restore no line named: no confirmation.
    - The red line's ×, a board change (before the new lookup answers) and a re-check.
    - Several restored from the rail: the line counting down, then one confirmation.
    - The keyboard flag and the focus ids (only the scope's boards).
  - `AssetTrash.test.tsx`, +4: focus on the first asked-for Restore with and without the ring, never pulled back on a reload; a scope switch focusing the new list; Empty sending only the listed boards; a refusal kept through the list's reload.
- **Mutants:** 29 (scratchpad `paste/mutate-r6k.py`), all killed. On the first pass 7 survived:
  - Two were code that did nothing: the save-out check (a save out leaves the draft dirty) and a dedupe. They are removed.
  - The red line's board check became a clear on board change, after a held-lookup test showed it would come back when returning to the board.
  - The rest needed tests: a board switch while not found, a sync check after a rail restore, a mixed-scope focus, and a scope switch in the list.
  - Changed code was run again, then all 29 in a final pass.
- **Gates:** tsc 0, lint 0, focused vitest over 154 files 2697 of 2697, the build budget 447,725 B raw (dist deleted). No backend change, so no pytest.
- **Live (8797/5797, the installed Chrome with a throwaway profile, a fresh home and token per scenario, canary first, 1440):** 31 of 31 over 4 scenarios.
  - The open board deleted with a kept edit shows only the new line. Restore opened that board (same id), saved "Dusk", and confirmed "Restored “Dusk” and saved your change." (neutral, status, titled). The confirmation went when another board opened.
  - Deleted with no kept edit: the old line stays.
  - Deleted for good: red, a status line whose only button is × "Dismiss"; × closes it, and a second one clears when another board opens.
  - Two deleted:
    - With the pointer, the line's Restore focused the rail's "Restore Rivers" with no ring; from the keyboard, the same button with the ring.
    - Restoring Rivers there left the one-board line for Harbor. Restoring Harbor ended with "Restored “Dusk” and “Port” and saved your changes."
  - No request left the lane. Shots: scratchpad `paste/shots6k/` (5), each opened at 1000 px, no md5 repeats.

## Round 6l (GM r20, GM r21, review 10)

GM signed off 6k with three fixes (r20) and answered review 10's questions (r21).

Main had moved to bee7ebe0 (#208's colour extract and #220's pins), so it is merged, staged and not committed. Two conflicts:
- `backend/main.py`, the startup hook: it now prunes the create request-id records (this branch) and stamps transparency in the background (#208).
- `backend/main.py`, the create route: `create_or_repeat` (this branch) now runs in a worker thread, as #208 made `create` do, since a new image's file is decoded there. The store's `_create` calls `_warm_new_files` after the merge, so the request-id path decodes too.
- `focusRingCss.test.ts`: the placeholder's entries (this branch) and #208's palette line are both kept.
`MoodboardStudioView.tsx` merged cleanly (#208's `AnalysisOutdated` and the hold spacer).

- **r20 A, r21 Q6: the confirmation.**
  - It names boards by their saved names, the names the line and Recently deleted showed (`restoredBoardsLine(names, saved)`).
  - The second sentence counts the boards whose kept edit was sent: 1 gives "Your change is saved.", 2+ gives "Your changes are saved.", and 0 leaves it out ("Restored “Rivers”."). A plain Restore from Recently deleted, or one with nothing left to send, says the first sentence alone; a Kept line from the replay follows it.
  - `restoring` holds `{ id, name, sent }`, and the load path marks `sent` when it sends.
- **r20 B: the order.** The line sorts its boards as Recently deleted does, newest deleted first (`newestFirst` on `deletedAt`), in one place (`trashedShown`), so the several-board focus asks for the top row first.
- **r20 C: the orange outline.** Live, with the pointer resting on the line's Restore after focus moved to the rail:
  - Its border and text are amber (`rgb(245, 158, 11)`), from `.moodboard-studio-toolbar__button:hover`.
  - It isn't `:focus`, `:focus-visible` or `:active`. With the pointer moved away it is the resting style again.
  - So it's the toolbar buttons' hover, as intended. Nothing changed; one shot.
- **r21 Q1, review MEDIUM-1: kept image changes.**
  - `stampNewOps` (in `syncEdits`) records each new queued op's time and the value its target had in the draft before it, kept beside the ops as `opMeta`. An op on a target an earlier unsent op holds inherits that op's from-value. A kept Undo (`restore`) records `draft.version`.
  - On replay (`replayKeptEdit`), per op:
    - The board already has the op's value: skipped.
    - The board still has the from-value, or the op is later than the board's `updatedAt`: replayed.
    - Otherwise dropped, and named in the Kept line.
  - Names: "the changes to “<label>”" or "the changes to image N", and "the cover".
    - What the board shows: no file name anywhere. The side panel says "Reference #N" and the List view "#N". The one per-image label is the Private note ("A label for you, like Liked"), so the line uses it when set, else "image N" by board position.
    - Labels are clipped at 40 with the full label in the title. Items join the board fields' items with "and", no serial comma, names up to 3, a count from 4. One name field alone still shows its value.
  - A kept Undo replays only when `board.version` equals the version it was made on. Otherwise `undoDropped` shows "Nebula couldn’t apply your Undo because the board changed after it." (neutral, status, no button), which goes on a board change.
  - Undos aren't queued in `pendingOps` today (a failed Undo uses the toolbar's Retry), so this guards the record's shape.
- **r21 Q2, review live MEDIUM-1: Delete forever and Empty.**
  - `RecentlyDeletedAssets` takes `atStake(items)` and `onPurged(ids)`.
  - The confirm adds `lostTooLine(names)`: "Your unsaved change to “Rivers” will be lost too." / "Your unsaved changes to “Rivers” and “Harbor” will be lost too." / "Your unsaved changes to 4 boards will be lost too."
  - After the purge succeeds, `forgetEdits` drops those kept edits, clears them from the line at once, takes them out of `restoring`, and reloads the open board if it was one. No red line follows.
  - The rail's `onTrashChanged` re-checks the line (`recheckGone`), as do ws events: a stored-asset change for a waiting id, and a projects change or reconnect while edits wait.
- **r21 Q3, review live MEDIUM-2: the tab holding the edit.**
  - `failBoardSave` and `keepFailedAway` pass the saved name and call `markGone`, which sets the draft entry's `saveGone` (`trashed` with `deletedAt`, or `purged`).
  - Trashed: the board joins the line as `heldTrashed` (the r18 line with Restore, the same string as after a reload). The header's Retry is hidden, and the chip stays "Not saved". Restore restores it, then `resumeHeld` sends the held draft, and the confirmation follows once saved.
  - Purged: the red line.
  - `boardSaveLine` maps a 404 that is in_trash, or plain, to the deleted-board line with `retry: 'reload'`; tests pin that neither is ever "refused".
- **r21 Q4.** The not-found line is hidden while the red line names the open board, and back once it is dismissed or cleared.
- **r21 Q5.** Restore records the route. If the person opened another board meanwhile, they stay there: the line drops the board, the confirmation names it ("Restored “Rivers”."), and the rail lists it.
- **r21 Q7.**
  - After a single Restore, `railFocus` asks the rail to focus the board's row (`button[data-board-id]`), with `focusVisible` only from the keyboard.
  - The red line's × calls `focusAfterLine`: the next enabled button in the notices after it, else `main` (given `tabindex=-1`), with no ring. The red line is usually last, so in practice that's `main`.
- **r21 Q8: a project in Recently deleted.**
  - Where a project is restored today: Project home's Recently deleted (`projectStore.restore`, `POST /api/projects/{id}/restore`).
  - The lookup reads `listProjects().trash` for ready boards in a project. A trashed project's boards still read as ready, as checked live.
  - The line: "Nebula couldn’t save your change to “Shore” because its project was deleted. Restore the project to keep the change." The Studio can call that route in place, unchanged (not person-gated), so the line has "Restore project".
  - It restores the project without opening it, then `replayAway` replays the kept edit into that board's draft and sends it.
  - Nothing confirms it: the line goes. That's a question for GM. A failure shows "Couldn't restore the project." in red, and the line stays.
- **r21 expiry.** The day was `UNSAVED_MAX_AGE`, shared with unsaved new-board drafts: a kept edit was dropped a day after its last write. A cap of 10 (`slice(-10)`) also dropped the oldest silently.
  - Both are gone for kept edits. A kept edit now lives while its board or project can be restored (boards stay until deleted for good; projects 30 days, round 6m). After that, the lookup finds the board gone and the red line shows.
  - No hard cap stays. A failed write still sets `lastEditsWriteFailed`, and the unload warning covers it.
  - Still on a day:
    - Unsaved new-board drafts (`UNSAVED_MAX_AGE`, cap 10): they have no board to restore.
    - `boardAdds.ts`'s adds on their way and waiting sends (`PENDING_MAX_AGE`, cap 50). A waiting send older than a day, for a board whose kept edit lives on, is still dropped silently. That is outside this brief; flagged. (Round 6m: fixed, GM r53 Q2.)
- **Review no-ruling fixes.**
  - Purged while the trashed line is up: the re-check turns it red.
  - A purged board's edit is dropped once its red line has mounted (`DropOnShow`), never before (logic LOW-1).
  - `role=status` lines mount empty and get their text a frame later (`LiveText`), so they're announced (NIT-4).
  - A refusal in Recently deleted clears when its scope or project changes (`where`).
  - The several-board list stays open across a remount while boards are left (`keepTrashOpen`, NIT-3).
  - The namedLine ratchet reads a top-level string constant that opens a template as its text (NIT-5). It then flagged the two board save lines (listed: GM's fixed pairs) and two older lines, `cinemaMotion` and `graphFile` (fixed heading over fixed tail, reviewed and listed).
  - Tests for V15, B1/B2 (the backend's empty shown list), V8, V17, V20, V16 and V4.
- **Found live and fixed.** `queueOps` keeps one op per target, so a slider's second step replaces the first. The new op took its from-value from the draft before it: the first step's 0.95, not the board's 1. Then an agent's unrelated change would have dropped it. `stampNewOps` now inherits the from-value of an op the queue just replaced.
- **Tests.**
  - `boardSaveLine.test.ts` +10: confirmations, the image items, `lostTooLine`, `projectDeletedLine`, and gone 404s never refused.
  - `unsavedDrafts.test.ts` +4: op meta, the replaced op, any age and no cap, and shape checks.
  - Paste +28, one replacing a 6k test: B order, `LiveText`, K1, label and field, the replay rule, Undo dropped or replayed, Q2 Delete forever, Empty, count and partial batch, NIT-3, purged while up, a restore 404, V8, V17, V20, K2, Q3 trashed, purged and a red line arriving mid-restore, Q5, Q7 rail focus and ×, and Q8 restore, failure and silence.
  - `AssetTrash.test.tsx` +5. `tests/lib/trash.empty.test.ts` (new, 2). The ratchet's own cases. Backend `test_asset_trash.py` +1 (an empty shown list deletes nothing).
- **Mutants:** 66 (scratchpad `paste/mutate-r6l.py`), all killed.
  - On the first pass two survived. One was a redundant second sort (removed). The other was a restore reading the lines from its render, now covered by a test where a red line comes up while the held Restore is out.
  - One mutant didn't compile and was fixed and re-run.
  - The live fix has its own mutant (U8).
- **Gates.**
  - Before the merge: tsc 0, lint 0, focused vitest over 155 files 2742 of 2742, the build budget 447,743 B raw, isolated pytest over 23 backend files 948 passed.
  - On the merge: tsc 0, lint 0, the build budget 447,881 B raw (dist deleted), isolated pytest over 31 backend files (main's moodboard and colour tests added) 1104 passed.
  - Focused vitest over 157 files gave 2760 of 2764. The 4 were 5 s timeouts at a load average of 26 from other sessions (three Paste tests and `readOnlyCues`); the two files re-run gave 309 of 309.
- **Live (8797/5797, the installed Chrome with a throwaway profile, a fresh home and token per scenario, canary first, 1440):** 45 of 45 over 4 scenarios, before the merge and again on it. The shots are from the run on the merge.
  - Q1: Rivers' image 2 has the private note "sunset.jpg". With saves failing, a rename to Dusk and two Weight steps from the keyboard (0.9, from 1) were kept. An agent then renamed the board Tide and set the weight to 0.5. The reload showed "Kept the name “Tide” and the changes to “sunset.jpg” from the board.", titled "“Tide” and “sunset.jpg”". Nothing was sent over the agent's values.
  - Q2 and C:
    - Two kept, both deleted: "…to “Harbor” and “Rivers”…". The line's Restore, pressed with the pointer, focused the rail's "Restore Harbor" with no ring.
    - C measured as above.
    - Delete forever on Harbor: "This can’t be undone. Your unsaved change to “Harbor” will be lost too." On confirm the line became Rivers alone, with no red line at any point, and Harbor's edit went. Empty's confirm named Rivers.
    - Restore Rivers: "Restored “Rivers”. Your change is saved."
  - Q3:
    - Deleted while open, then renamed: the r18 line with Restore, no Retry, "Not saved", never "refused". Restore gave "Restored “Rivers”. Your change is saved.", the board was Dusk, and focus was on the rail row with no ring.
    - Deleted for good while open, then renamed: the red line, no "Moodboard not found".
  - Q8: the project line with "Restore project". Pressing it restored Coast (the open project stays the same) and replayed Shore's rename (Cliff); the line went and the edit was spent.
  - No request left the lane. Shots: scratchpad `paste/shots6l/` (5), each opened at 1000 px, no md5 repeats.

## Round 6m (GM r53)

GM passed 6l's Q2 confirm, the Q3 in-tab line, the Q8 line and the C hover answer, and asked for one label change, one fact check, then Q1 and Q2. Main was already in the branch (bee7ebe0), so nothing was merged.

- **The image label (GM r53).**
  - A kept image change is named by the label the person sees on the board, "Reference #N" (the side panel's title and each card's name, its place in the board + 1), never the private note. A note is private text, and a status line can end up in a screen share or a demo.
  - "Kept the changes to Reference #3 from the board." / "Kept the name “Tide” and the changes to Reference #3 from the board." The cover stays "the cover"; four items or more still count.
  - No 40-character clip and no title for an image. A shown name keeps its clip, and its title is the name alone.
  - `KeptImage` is `{ n }` only, so a note can't reach the line. A ratchet in `boardSaveLine.test.ts` feeds images carrying a private note and a label and checks neither shows.
- **The 30 days (GM's check).** Nothing purges deleted boards on a timer, so the helper stays: "Deleted boards stay here until you delete them for good."
  - Boards (and characters and Styles): `backend/services/asset_trash.py:23` says "Nothing is purged on a timer". `docs/MCP-SETUP.md:3169-3170` says the same.
  - The 30 days are projects' only: `backend/services/project_store.py:25-26` (`TRASH_RETENTION = timedelta(days=30)`), applied by `purge_expired_trash` (`project_store.py:155`) on `GET /api/projects` (`main.py:16964`), before a project restore (`main.py:17885`) and on `GET /api/trash` (`main.py:20134`). Project home says it: "Deleted projects stay here for 30 days." (`ProjectHome.tsx:331`).
  - Round 6l's notes said "Recently deleted keeps 30 days" for kept edits. That was wrong for boards and is corrected above.
- **Q1: Restore project.**
  - Success: the line goes, and the confirmation shows in a board Restore's slot (`data-restored`), naming the project: "Restored “Shore”. Your change is saved." With nothing replayed, "Restored “Shore”." alone. It waits for the replayed edits to save (`projectRestoring`), as a board's Restore does.
  - "Shore" is the project in GM's examples (the purged line restores “Shore” and loses the change to “Rivers”), so every Restore project line names the project. The name comes from the project list's Recently deleted entry (`ProjectGoneBoard.projectName`).
  - Focus follows r21 Q7: `focusAfterLine`, so the next notice control, else `<main>`, never body, with no ring from the pointer.
  - Another tab restored it first: a 409 counts as success, and so does a 404 when the project list then shows the project live. The backend answers 404 for a project no longer in Recently deleted, so that is the real "restored elsewhere" case. The edit replays and the same confirmation shows.
  - Failures, in the because form, from the error's kind and status, never its words:
    - "Nebula couldn’t restore “Shore” because the server isn’t answering. Try again." (neutral, status, a real Try again; in `tryAgainLines.ratchet.test.ts`). It's any no-answer or gateway error (`isBackendUnreachable`).
    - "Nebula couldn’t restore “Shore” because it was deleted for good. Your change to “Rivers” can’t be kept." (red, status, × "Dismiss", inserted empty and filled a frame later so it's announced once, like the 6k red line). It's a 404 with the project in neither list. Several boards: "Your changes to “Rivers” and “Harbor”", then "to 4 boards". Focus moves to its ×, since the button pressed is gone. The kept edits go once it has shown (`DropOnShow`).
    - "Nebula couldn’t restore “Shore” because the server didn’t accept the request. Try again." (neutral, Try again): anything else, a 404 with the project still in Recently deleted included.
  - The failure takes the project's line in place, and its button becomes Try again: the same element, so focus stays on it. A project's other boards' lines wait under it.
  - The old red "Couldn't restore the project." (straight apostrophe, role alert) is gone.
- **The straight-apostrophe check.** None existed, so the namedLine copy ratchet (`tests/lib/errorCopy.namedLine.test.ts`) gains one.
  - It reads src/ with the TypeScript parser: string literals, template text and JSX text where a straight apostrophe sits inside a word.
  - Exempt by surface: tests (`*.test.*`, `src/test/`), comments, module specifiers, console calls and RegExp sources.
  - Most older copy is straight still (534 in 130 files, the app's "Couldn't …" headings among them), so each file's count is pinned in `tests/lib/straightApostrophes.baseline.json`. A file over its count fails, naming the strings; a file under it fails until the count is lowered. `NEBULA_WRITE_APOSTROPHE_BASELINE=1` rewrites the file.
  - This PR's own lines are curly. Its two older failure headings, "Couldn't restore the board." and "Couldn't load Recently deleted.", follow the app-wide straight headings in `lib/trash.ts` and the error-copy sweep, and stay pinned. Sweeping the headings is its own change.
- **Q2: a waiting send lives with its board's kept edit.** `boardAdds.ts`'s `readWaiting` keeps a send past the day while its board holds a kept edit, waiting or in a draft here (`keepWaitingWhile`, registered by `unsavedDrafts.ts`, which imports `boardAdds.ts`, so there's no import cycle). A send with no kept edit behind it still ages out after a day, and the adds on their way keep their day.
  - In today's code a board's kept edit holds every op its waiting send does, and the board's load takes the kept edit and drops the send. So the send no longer vanishes while its board can come back, and on restore the add lands once.
- **MCP and CLI.** Nothing new for agents: restoring a project is `restore_from_trash` (MCP) and `nebula trash restore`, unchanged. Kept edits, waiting sends and these lines are the person's tab's own state, so there's no agent action to add.
- **Tests.**
  - `boardSaveLine.test.ts`: the image-label cases rewritten (2), the no-note ratchet (new), and Restore project's lines and kinds (3 new).
  - Paste: K1 and the label test now expect "Reference #N" with no image title and no note anywhere; the Q8 success test expects the confirmation; the old red-failure test is replaced by six: success with focus on `<main>` and the confirmation waiting for the save, nothing replayed, another tab first (409 and 404), no answer with the same button as Try again, anything else, and deleted for good (red, inserted once, × focused, edit dropped). Q2: a two-day-old send on a board in Recently deleted survives a rewrite of the list, then lands once on Restore.
  - `unsavedDrafts.test.ts` +1 (a send kept by a waiting or held kept edit, aged out without one). `tryAgainLines.ratchet.test.ts` +2 rows and a pin. The namedLine file +2 (the scanner's own cases, the baseline).
- **Mutants:** 34 (scratchpad `paste/mutate-r6m.py`, log `paste/mutate-r6m.log`), all killed: the label (4), the line kinds and copy (5, one a straight apostrophe the new ratchet catches), the Studio's outcomes, confirmation, focus and red line (19), the waiting send's life (4, one through the Studio), and the apostrophe baseline both ways (2).
- **Gates.** tsc 0; lint 0; the build budget 447,881 B raw, 138,296 B gzip (unchanged: the Studio is deferred; dist deleted); focused vitest over 197 files (every test that reads src/ or styles/ from disk included): 3724 of 3724; isolated pytest over 34 backend files (the PR's and every trash or moodboard file): 1811 passed; `person_gate.py` byte-identical to origin/main. No backend change this round.
- **Live (8797/5797, the installed Chrome with a throwaway profile, a fresh home and token per scenario, canary first, 1440):** 23 of 23 over 2 scenarios.
  - Q1: image 2 with the private note "sunset.jpg", a kept rename and weight, then an agent's rename to Tide and weight 0.5. The reload showed "Kept the name “Tide” and the changes to Reference #2 from the board.", titled "Tide"; "sunset" nowhere on screen or in any title; the card's own name "Reference #2"; nothing sent over the agent's values.
  - Q8: Shore's kept rename in project Coast, Coast in Recently deleted. Restore project, pressed with the pointer: Coast restored (not opened), Shore renamed Cliff, the line gone, then "Restored “Coast”. Your change is saved." in the confirmation slot (neutral, status). Focus on `<main>`, no ring.
  - No request left the lane. Shots: scratchpad `paste/shots6m/` (2), each opened at 1000 px, distinct md5s.

## Round 6n (GM r71)

GM signed off 6m's design after one string change, with no reshoot: every Restore project line names the board(s) as well as the project. The 30-day correction, the 404 re-read, the waiting send living with a kept edit and the apostrophe ratchet were approved as built.

- **The success line** (`projectRestoredLine`, new in `boardSaveLine.ts`) names the project, then the boards whose replayed edit was sent and saved, by the names rule the purged line uses (`namedBoards`): one name; two or three joined with "and"; from four, a count.
  - "Restored “Coast”. Your change to “Rivers” is saved." / "…Your changes to “Rivers” and “Tide” are saved." / "…Your changes to “Rivers”, “Tide” and “Harbor” are saved." / "…Your changes to 4 boards are saved."
  - With nothing saved (the boards kept every change), "Restored “Coast”." alone, as before.
  - The title is the project's full name, then every board's: "“Coast”: “Rivers” and “Tide”", as the purged line's is.
  - `MoodboardStudioView.tsx`'s `projectRestoring` now holds each sending board's id and name, not ids only. A board whose draft is gone before its save lands isn't named, as it wasn't counted before.
- **The purged line** was already as GM wrote it ("Your change to “Rivers” can’t be kept."); unchanged, with its three-name count now tested.
- **Left as they are:** the straight headings "Couldn't restore the board." and "Couldn't load Recently deleted." stay here and go on the app-wide copy PR's list.
- **MCP and CLI.** Nothing new: these lines are the tab's own state.
- **Tests.** `boardSaveLine.test.ts`: success for 1, 2, 3, 4 and 5 boards, none, a clipped name and a blank one (1 new test); purged gains 3 and 5. Paste: the five single-board confirmations now expect the board's name; +3: two boards restored with their project (both named, the title too), two boards whose project was deleted for good (both named), and a board whose draft goes before its save lands (not named).
- **Mutants:** 8, all killed: the success line dropping the board, one and several swapped, four named instead of counted, the title losing the boards, the Studio back on the old line, the Studio naming only the first board, the Studio naming a board whose draft is gone, and the purged line counting three.
- **Gates.** tsc -b --noEmit 0; lint 0; the build budget 447,881 B raw, 138,303 B gzip (raw unchanged; the Studio is deferred; dist deleted); focused vitest over 198 files (every test that reads src/ or styles/ from disk included): 3738 of 3738; `person_gate.py` byte-identical to origin/main. No backend change, so no pytest this round.

## Round 6o (GM r74)

GM approved 6n's lines (the 1, 2–3 and 4+ forms, "Restored “Coast”." alone, leaving out a board whose draft is gone, the 1–5 count tests) and signed off on the design once the title changes.

- **The title has no colon.** `projectRestoredLine` and the purged form of `projectRestoreFailedLine` (`boardSaveLine.ts`) now title the line with every board, then the project: "“Rivers” and “Tide” in “Coast”"; from four boards the line counts but the title still lists them all, with no serial comma: "“Rivers”, “Tide”, “Harbor” and “Quiet” in “Coast”". 6n's "“Coast”: “Rivers” and “Tide”" is gone. A line naming only the project ("Restored “Coast”.", the two Try again lines) keeps the project alone.
- **A colon ratchet** joins the copy ratchets in `tests/lib/errorCopy.namedLine.test.ts`: across `src/components/moodboard-studio/`, read with the TypeScript parser, a colon in any literal or template text that reaches a title or an aria-label fails. That is a JSX `title` / `aria-label` / `ariaLabel` value, an object property of those names (`{ text, title: … }`, React Flow's `ariaLabel`), `setAttribute('title' | 'aria-label', …)`, and a variable so named or passed as one, read through its initializer in its own scope. A ternary's own `:` is syntax, not text; `line.title` is checked where its title is written; a function's body isn't read, its arguments are.
  - Three older colons are listed as reviewed, each to go to GM for words: the color field's `aria-label`s "<label>: pick" and "<label>: hex" (`MoodboardBrief.tsx`) and the cover button's title "…Nothing moves: no image changes number." (`MoodboardListView.tsx`). A new one fails; a listed one that's gone fails as stale.
  - Proved by planting: 6n's colon back in either title, a colon in a JSX title (`MoodboardStudioView.tsx`) and in React Flow's `ariaLabel` (`boardNodes.ts`) each fail it. No false fails on the current files (the 3 reviewed hits are the only ones).
- **MCP and CLI.** Nothing new: these are the tab's own lines.
- **Tests.** `boardSaveLine.test.ts`: the title asserted at 1, 2, 3, 4 and 5 boards for both lines (4 with GM's own names), the clipped and blank cases too. Paste: the two-board titles (restored, purged) now expect GM's form. The namedLine file +2 (the scanner's cases; current files reviewed and none stale).
- **Mutants:** 8 on the lines (either title back to a colon, losing the project, losing the boards, the order swapped, counting from 4) and 6 on the scanner (no object property, no JSX attribute, no template text, no names resolved, scope ignored, property reads resolved), all 14 killed.
- **Gates.** tsc -b --noEmit 0; lint 0; the build budget 447,881 B raw, 138,291 B gzip (raw unchanged; dist deleted); focused vitest over 201 files (198 as 6n, plus the three ratchets that read test files from disk, since test files changed): 3843 of 3843; `person_gate.py` byte-identical to origin/main. No backend change, so no pytest.

## Round 6p (review 11, GM r90 and its addendum)

Review 11's two lenses (kept-edits logic, Restore project live) and GM r90 (binding strings), with Justin's 2026-11-04 calls: the agent read-only view of kept edits is a follow-up PR, and a permanent project delete removing its boards is its own PR. The Studio fix below works either way (today the boards stay on disk, answering 200 with a dead `projectId`).

- **A. Focus never on body (review 11 MEDIUM-1, both lenses).** `focusAfterLine` (MoodboardStudioView.tsx) takes the project being restored and skips every control inside that project's line; its fallback is `<main>` with no ring (`focusMain`). The target is chosen at the outcome while the old DOM is still there. A Restore project press is remembered (`projectPress`); if a re-check takes the line while the request is out (another tab restored or purged the project), a layout effect moves focus from body to `<main>` at once, and the outcome does not re-focus a detached line (an extra outcome fallback for that case was taken out: a mutant showed the layout effect already covers it).
- **B. A project deleted for good elsewhere (MEDIUM-2, GM r90.1).** When `listProjects` answered and a kept board's `projectId` is in neither list, the re-check shows GM's red project line once, wherever the board line showed (`projectGoneLine` in boardSaveLine.ts; `projectsPurged` entries now carry `kind: 'restore' | 'keep'`). Its kept edits are dropped once it has been seen: `DropOnShow` now waits for a visible tab (`visibilitychange`), and the × dismisses it. "Say nothing" stays only for a `listProjects` failure. The project's name comes from the kept edit: `KeptEdit.project` is set when the edit is kept (the open project) and refreshed by every look-up that finds the project listed (`noteKeptProject`), so a reload after the purge still names it. A board whose project this tab never saw by name gets the board's existing red line (deletedBoardsLine 'purged'); for GM.
- **C. One line per project (GM r90.2).** `projectDeletedLine(project, boards)` names the project and its boards by the names rule, with the title listing every board then the project. The Studio groups `goneEdits.project` by project (`goneProjects`), keyed by project id, so the Restore project / Try again button stays the same element. The count form says "moodboards" (GM r90 addendum, matching PR #228), in this line and the B line only; the r71 confirmations and the press-purged line keep "boards" as GM wrote them.
- **D. Offline (GM r90.3).** The button is `aria-disabled` with `offlineMark` while offline; a press (keyboard or pointer) only pulses the banner (`refuseEditWhileOffline`), focus stays, no line. A request whose connection drops (no answer, then a probe finds Nebula offline: `projectRestoreFailureOf`) says "Nebula couldn’t restore “Coast” because it lost the connection. Try again." with the same button as Try again (aria-disabled until reconnect). An `OfflineRefusal` race changes nothing. The server line stays for a real refusal; "the server isn’t answering" stays for no answer while still online.
- **E. Restored elsewhere (GM r90.4).** The re-check compares with the lines as last rendered (`goneShown`): a project they named now listed live, or a trashed board now ready, replays at once through the same code path as Restore project (`replayRestoredProject`, `replayRestoredBoards`), or on the next `visibilitychange` in a hidden tab. Projects confirm with the r71 line; boards with the board Restore line ("Restored “Rivers”. Your change is saved."). Restores this tab started (a press here, the line's Restore, a Recently deleted row: new `onRestoring` prop on `RecentlyDeletedAssets`) are left to their own path for 30 s (`restoresHere`), so nothing replays twice.
- **F. Removes follow the later-edit rule (GM r90.5).** A queued remove now records each image's state at removal (`imageState`: weight, set-aside, notes, private note, card spots) in its op meta. On replay, an image whose state differs and whose board changed after the remove stays; the confirmation adds `changedAfterRemoveLine` ("Claude changed #3 after you removed it, so it’s still on the board."; "#3 and #5"; from 4, or across boards, "4 images"). The changer's name comes from the socket's `storedAssetChanged` events while the tab listens (`noteKeptChange`, stored per board under `nebula:moodboard-kept-changes`): the agent's own name, never a fixed "Claude". No single known agent (a person, another client, a change made while the tab was closed): the image is the subject ("#3 changed after you removed it, …"); for GM. On a board's own load (no confirmation), a stayed image is named in the Kept line instead.
- **G. Review 11 LOWs and NITs.**
  - LOW-1: a press while that project's restore is out is ignored (`restoresHere`); confirmations are keyed by slot (`confirming`, one per project), so a second project never replaces the first's. Merging a second restore of the same project into its slot (the reviewer's other option) was built, then taken out: a mutant showed it unreachable, since one restore of a project runs at a time.
  - LOW-2: superseded by D.
  - LOW-3: the Kept line numbers images by the replayed draft, not the server board.
  - LOW-4: W3, W4, W7 and W8 pinned by tests. W15 is equivalent: a loaded draft that holds unsent edits makes this page hold the board's kept edit (`writtenEdits`), so `takeKeptEdit` already returns null; one with nothing unsent makes `syncEdits` drop the waiting edit. The guard stays as defence.
  - LOW-5: Delete forever and Empty hide the lines at once, then drop only the kept edits whose boards a look-up finds missing; a board restored meanwhile keeps its edit, and the re-check puts its line back if it is still deleted. A re-check skips boards being confirmed.
  - NIT-1 / live LOW-2: the colon ratchet reads inline callbacks passed to a call (expression body or their own returns), chained calls, and `el.title =` / `el.ariaLabel =` assignments. Proved by planting `Board: “${name}”` inside `namedBoards`' map callback.
  - NIT-2: the apostrophe scanner counts `'[a-z]` at the start of template middle/tail text. It found 3 pre-existing hits the old one missed (`lib/placeholderRunConfirm.ts` "`${x}'s changes?`", `lib/pricing.ts` "`'s size when you run it`", `lib/providerReadiness.ts` "`'s own API doesn’t take`"); their baselines go up by one each (5, 1, 6), regenerated by the test's own writer. No new straight apostrophe.
  - NIT-3: the PR body's 6l expiry bullet corrected.
  - Live NIT-1: covered by LOW-1's keyed confirmations.
- **MCP and CLI.** Nothing agent-facing changed: the restore routes, MCP `restore_from_trash`, `nebula trash restore` and docs are untouched. `person_gate.py` byte-identical. No backend change.
- **Tests.** `boardSaveLine.test.ts` +2 describes (the project line at 1, 2, 3, 4, 5 boards with "moodboards" and the title; the red keep line at 1–4; `changedAfterRemoveLine` at 1, 2, 3, 4, across boards, by name and with none; the sentence after each confirmation; the lost-connection line). Paste: the Q8 lines updated to name the project; +26 (four boards one line, R11-A two-board focus, focus to the next project, focus not back up from the last line, R11-B mid-request focus, R11-D, reload after a purge and the unseen-project fallback, the hidden-tab drop, offline aria-disabled, lost connection, agent project restore, hidden-tab replay, agent board restore, two r90.5 confirmations, double press, two projects, W7, R11-E, W3, W4, the remove rule on load, an unsent-only difference, the remove's recorded state, LOW-5, W8). namedLine: the scanner's new cases.
- **Mutants: 36 run, all addressed.** 32 killed at once. 4 survived: the focus target ignoring position and the remove rule ignoring time (each killed by a new test), and two pieces of code they showed unreachable (the detached-line outcome fallback and the same-project merge), which were taken out. Planted proofs: a colon inside `namedBoards`' map callback and a `${name}'s` in `boardSaveLine.ts` each fail their ratchet. Script and log: scratchpad `r6p_mut.py`, `r6p_mut.log`.
- **Gates.** tsc -b --noEmit 0; lint 0; the build budget 447,881 B raw, 138,300 B gzip (raw unchanged: the Studio is deferred; dist deleted); focused vitest over 133 files (every test that reads src/ or styles/ from disk, every moodboard-studio and asset-trash test, the namedLine, tryAgainLines, regionNoticesReady, deleteLanded, sceneEditsReset, pinTextReady and agentPresenceFollowups ratchets, trash.empty): 2987 of 2987 (list length printed, 133, and checked non-zero); `person_gate.py` byte-identical to origin/main. No backend change, so no backend tests.
- **Live (8797/5797, serve_isolated.py with the token on stdin, a fresh home per scenario, the installed Chrome with a throwaway profile, 8000-8010/5173/8840/5840 and outside hosts blocked, canary first) at 1440×900 and 1024×640: 80 of 80 over 10 runs**, after one harness fix (the focus log first started before the button had focus and logged the page's initial body; restarted after focusing, p4 at 1440 re-ran clean).
  - p4: four boards in Coast, one line "…your changes to 4 moodboards because their project “Coast” was deleted…", one Restore project, the title listing all four; the board card clear of the line at both sizes (overlap 0; at 1024×640 the line ends at y 124, the card starts at 138). Restore project from the keyboard: all four renames replayed, "Restored “Coast”. Your changes to 4 boards are saved.", focus BUTTON then MAIN, never body.
  - purge: tab 2 purges Coast while the line is up: one red "Nebula couldn’t keep your changes to “Rivers” and “Tide” because their project “Coast” was deleted for good.", the edits dropped, nothing after a reload.
  - offline: Restore project aria-disabled (not disabled), Enter sends nothing, focus stays, no line; a restore whose connection drops: "…because it lost the connection. Try again.", focus on Try again; back online Try again restores and confirms.
  - agent: `X-Nebula-Agent: Claude` restores Coast: the rename replays at once, "Restored “Coast”. Your change to “Rivers” is saved.", this tab sends no restore of its own.
  - changed3: a kept rename and a kept remove of #3; Claude sets #3's weight; Restore project: "Restored “Coast”. Your change to “Rivers” is saved. Claude changed #3 after you removed it, so it’s still on the board."; #3 on the board with weight 0.3.
  - No request left the lane; each blocked log holds only canary lines. Shots: scratchpad `pr210r6p/shots/` (14, md5-distinct). The last two code changes (the two unreachable pieces taken out) came after the live runs; unit tests cover them.

## Round 6q (GM r95)

GM r95 signs 6p off once the bug and r95.5 are in; r95.1 and r95.4 approved as built. The reserved-name rule (agents can't be called "You", "Nebula" or a person's name) is a separate PR, not here.

- **A. The card under the line at 1024×640 offline (GM r95 bug).** The cause: the notices float over the board's top and were never part of the view insets (GM #213 round 3: "they come and go, so they don't move the camera"), so a fit centred the cards in the column less only the toolbar's band. Shot 1's clearance (line ends y 124, card starts 138) was the one-card fit's centring, not a rule. When the offline row opened, the column lost 49 px, the fitted board refit (boardFitFollow, as it should), and the card centred 25 px higher, under the three-line line (ends 172, card 163).
  - `lib/boardViewInsets.ts`: `measureBoardViewInsets(board, bar, notices)` adds a top band while a line shows: the board's top down to the stack's bottom plus `BOARD_NOTICE_GAP_PX` (12, the stack's own offset from the top). An empty stack (0 tall) adds none. `frameInInsets` is the fit's one computation (Fit, the fit on open, a refit, an Update's Show), moved out of BoardCanvas so the fuzz runs the real thing.
  - `BoardCanvas` takes the Studio's notice stack (`notices` ref, new prop) and measures it at each fit. Placement's view (paste, drop, Add images) uses the same insets, so a new tile doesn't land under a line either.
  - The #213 rule still holds: a line coming or going never moves the camera by itself; the next fit, refit (a resize, the offline row opening or closing), Show or placement counts it. A line that appears over an already fitted board still covers it until one of those; changing that would move the camera when a line shows (for GM).
  - Fuzz (`boardViewInsets.test.ts`): 1024×640, 1280×800, 1440×900 and 1920×1080 × the offline row at 0, 49, 74 and 98 px × no line, one to three rows, two lines stacked × 15 boards (GM's one card, a 2000×1000 row, a tall column, 12 seeded random): every fitted board starts below the notice band and ends above the bar's band (1,440 cells). GM's named cell: 1024×640, the row up, a three-row line, one card: the card starts at or below y 184 (the line ends at 172).
  - BoardCanvas tests: the fit on open below a line; GM's case (the column 49 px shorter, the refit keeps the cards below the line); a line coming or going moves nothing, Fit then counts it; the Studio hands the board its stack.
- **B. Restore project offline looks paused (GM r95).** `.moodboard-studio__notice-action` joins the outline list in `styles/disabled-buttons.css`: aria-disabled, it takes the shared paused look (grey label `--disabled-label` 0.55, the faint edge, no fill, opacity 1, no hover change), and keeps focus and its ring. Enabled, it keeps its own look. `tests/moodboardPausedRestore.test.ts` compares its cascaded look, at rest and on hover, with the proposal card's paused button.
- **C. Across boards (GM r95.2).** `changedAfterRemoveLine(numbers, by, acrossBoards)`: kept removes that stayed on more than one board end "…so they’re still on their boards." ("Claude Code changed 2 images after you removed them, so they’re still on their boards."; with no single known agent, "2 images changed after you removed them, so they’re still on their boards.").
- **D. The agent's label (GM r95.3).** New `lib/agentActorLabel.ts`: the changer is named by the label its Agent log rows and cursor show, from the same source (`cursorLabel` over the agent's name and session). A board write carries the agent but not its session (sessions go only to the person's tabs, in presence events), so with one live cursor of that agent here its number is used as its log rows show it ("Claude Code · 2"); with none or several, the name alone, as the log names a session-less action. Never a raw name and never "Claude (agent)". The live runs name the agent as the MCP server does for Claude Code (`X-Nebula-Agent: Claude Code`); 6p's runs sent a bare "Claude".
- **E. "moodboards" in every count (GM r95.5).** `namedBoards` counts "moodboards" in every line (its noun parameter is gone): "Restored “Coast”. Your changes to 4 moodboards are saved.", the purged-on-Restore "…Your changes to 4 moodboards can’t be kept.", the deleted-board lines, the board Restore confirmation ("Restored 4 moodboards. …"), and "Your unsaved changes to 4 moodboards will be lost too.". Recently deleted's Empty confirm counts with a new `counted` noun: "Delete all 4 moodboards for good?"; "Recently deleted boards" and "Deleted boards stay here …" don't count and keep GM's words.
  - Ratchet (`tests/lib/errorCopy.namedLine.test.ts`): across src/, read with the TypeScript parser, person copy that counts boards fails: a number then "boards", text after an interpolation starting "boards" (`${n} boards`, `${n} board${s}`, JSX `{n} boards`), or a bare "boards" literal (a noun a count could take), each reviewed (two: Recently deleted's `many`, a confirmation slot key). Planted `${n} boards` in a line and a "Restored 4 boards." literal each fail it; no false fails across src/.
- **MCP and CLI.** Nothing agent-facing changed: no route, tool, CLI command or doc. `person_gate.py` byte-identical. No backend change.
- **Tests.** boardViewInsets +6 (the notice band, the gap pinned at 12, the fuzz's 1,440 cells and GM's named cell); BoardCanvas.fitFollow +4; boardSaveLine +1 describe (8 count forms) and the across-boards forms; Paste +2 (two boards "on their boards"; the label: one live session "Claude Code · 2", its first session, two sessions, none, another agent's cursor, no id); `moodboardPausedRestore` +2; namedLine +2 (the boards ratchet). Count strings updated in boardSaveLine, Paste and AssetTrash tests. The paused notice action also states its resting ink and edge in `moodboard-studio.css` (the toolbar button's, unchanged), so the shared look's contrast ratchet (agentPresenceFollowups M-1) can read them.
- **Mutants: 15 run, all killed.** 13 at once; 2 survived first and were killed by tightened tests: the gap set to 0 (the band's literal 86 px and the gap now pinned) and "several live sessions take the first" (the two-session case now uses sessions 2 and 3). Planted `${n} boards` in a line and a "Restored 4 boards." literal each fail the ratchet. Script and log: scratchpad `pr210r6q/mut.py`, `mut.log`.
- **Gates.** tsc -b --noEmit 0; lint 0; `pr_tests.sh` 117 files, 3870 of 3870; the moodboard-studio, asset-trash, boardViewInsets, boardPlacement and viewportSpring tests plus the new CSS test, 27 files, 970 of 970; `land_checks.sh` (tsc, main's three ratchets 161 of 161, backend source-walk pytest 1103 passed, 1 skipped, `person_gate.py` unchanged); build budget 471,140 B raw, 146,527 B gzip (dist deleted; the new code is in the Studio's deferred chunk).
- **Live (8797/5797, serve_isolated.py with the token on stdin, a fresh home per scenario, the installed Chrome with a throwaway profile, 8000-8010/5173/8840/5840 and outside hosts blocked, canary first) at 1024×640 and 1440×900: 58 of 58 over 8 runs.**
  - offline: at 1024×640 the three-row line ends at y 124 and the card starts at 138 before the banner; with the offline row up the line ends at 173 and the card starts at 206 (was 163 in 6p's shot 4), ending at 566 above the toolbar. At 1440×900, 158 and 328.5. Restore project aria-disabled, focused with its ring, label rgba(255,255,255,0.55) (live 0.92), edge 0.06, no fill, opacity 1; Enter sends nothing. Back online, still clear.
  - p4: "Restored “Coast”. Your changes to 4 moodboards are saved.", every rename replayed, no "N boards" on the page.
  - their: "Restored “Coast”. Your changes to “Rivers” and “Tide” are saved. Claude Code changed 2 images after you removed them, so they’re still on their boards."; each #3 still on its board.
  - agentlabel: "Restored “Coast”. Your change to “Rivers” is saved. Claude Code changed #3 after you removed it, so it’s still on the board."; the Agent log names the same agent "Claude Code".
  - No request left the lane; each blocked log holds only canary lines. Shots: scratchpad `pr210r6q/shots/` (8, md5-distinct).

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
- Round 6c: `MoodboardStudioView.tsx` (`sendQueued`'s own ops and fields, the open-board hand-off, `freeQueuedAdds`, the offline waits, the waiting send restored on open, info lines ending on a switch), `boardAdds.ts` (`isOpenBoard`, the waiting send in session storage, the cap), `boardSaveLine.ts` (new), `BoardCanvas.tsx` (`fitFor`), `lib/boardPlacement.ts` (`respot`), and their tests; `BoardCanvas.fitFollow.test.tsx`; `tests/round22Surfaces.test.tsx` (the allow list).
- Round 6d: `MoodboardStudioView.tsx` (`SendOwns`, `notSentYet`, the resends, the re-mark, the neutral line and chip, `offline` to the board and the List, the silent offline upload, the chip's tiles, `chipMovedAdds`), `boardSaveLine.ts` (`isBoardNotSavedLine`), `boardAdds.ts` (`isOpShape`), `BoardCanvas.tsx` and `MoodboardListView.tsx` (`offline`), `lib/backendConnection.ts` (`probeOffline`), `styles/moodboard-studio.css` and `styles/moodboard-board.css`, and their tests.
- Round 6e: `backend/services/moodboard_store.py` (`create_once`, the `.creates` side folder), `backend/main.py` (`requestId` on the create, `repeated`), `backend/moodboard_client.py`, `backend/mcp_server.py`, `backend/cli/commands/moodboard.py`, `backend/tests/test_moodboard_create_request_id.py` (new); `frontend/src/lib/api.ts`, `store/assetStudioDraftStore.ts` (`createRequestId`), `MoodboardStudioView.tsx` (`createRequestIdFor`, the repeat rebase, `markLeftToSend`, the chip rule at every site), `lib/boardPlacement.ts` (`visibleShare`, `outsideForChip`), `outsideChipText.ts` (`placeChip`), `OutsideChip.tsx`, `styles/moodboard-board.css`, and their tests.
- Round 6f: `boardSaveLine.ts` (`boardSaveFailure`, `isCreateIdRefusal`), `MoodboardStudioView.tsx` (every create and background write through it; `seen` kept and used at the chip sites), `lib/api.ts` (the create's heading), `BoardCanvas.tsx` (`seenRect`, `seen` on every target, the chip's `viewOf`), `lib/boardPlacement.ts` (`seen`), and their tests; `MoodboardStudioErrorCopy.test.tsx` (the create through the real lib/api).
- Round 6g: `unsavedDrafts.ts` (new, with a test), `MoodboardStudioView.tsx` (`createAttemptFor`, `repeatOnBoard`, `handOverDraft`, `createWaits`, the kept line, 7a), `store/assetStudioDraftStore.ts` (`createAttempts`, `fieldEditedAt`, `notice`, `handOver`), `boardSaveLine.ts` (`CREATE_ID_REFUSED_LINE`, `keptFromBoardLine`), `boardAdds.ts` (`createsWaited`, `isOpShape` exported), `lib/boardPlacement.ts` (`SeenArea`, `unionArea`), `BoardCanvas.tsx` (`seenArea`), `OutsideChip.tsx` (`seenOf`), `lib/api.ts`, and their tests; backend `services/moodboard_store.py`, `main.py`, `moodboard_client.py`, `mcp_server.py`, `cli/commands/moodboard.py`, `tests/test_moodboard_create_request_id.py`.
- Round 6h: `boardSaveLine.ts` (`boardSaveLine`, `lostAddLine`, `isLostAddLine`, `joinWithAnd`, `keptFromBoardLine`), `MoodboardStudioView.tsx` (`failBoardSave`, the lost add's names, the load keeping its line), `store/assetStudioDraftStore.ts` (`'reload'`), and their tests.
- Round 6i: `unsavedDrafts.ts` (`keptEditOf`, `syncEdits`, `takeKeptEdit`, `replayKeptFields`), `MoodboardStudioView.tsx` (`replayKeptEdit`, the load's replay, the lost add's chip, the notice's title), `boardSaveLine.ts` (the signed-out step, `KEPT_NAME_MAX`, the one name's value), `store/assetStudioDraftStore.ts` (`StudioNotice`), and their tests.
- Round 6j: `boardSaveLine.ts` (`deletedBoardsLine`), `unsavedDrafts.ts` (the kept edit's `name`, `keptEditsWaiting`, `dropKeptEdit`), `MoodboardStudioView.tsx` (the lookup, the two lines, Restore, `trashRequest`), `asset-trash/AssetTrash.tsx` (`openRequest`), `styles/moodboard-studio.css` (the Restore line), and their tests; `tests/test_moodboard_create_request_id.py` (the broadcast stand-in's `**_`).
- Round 6k: `boardSaveLine.ts` (`restoredBoardsLine`, `namedBoards`), `MoodboardStudioView.tsx` (the open board's one line, the red line's × and board-change clear, `restoring` and the confirmation, `boardRestored`, `openBoard`, the keyboard flag and focus ids), `asset-trash/AssetTrash.tsx` (`TrashOpenRequest`, the focus, load and action lines apart), `styles/moodboard-studio.css` (the ×), and their tests.
- Round 6l: `boardSaveLine.ts` (`boardGoneKind`, the gone save line, `restoredBoardsLine`'s two sentences, `projectDeletedLine`, `UNDO_DROPPED_LINE`, `lostTooLine`, `keptFromBoardLine`'s image items), `unsavedDrafts.ts` (`opMeta`, `stampNewOps`, `opTarget`, `valueOnBoard`, `valueOfOp`, `keptEditBoards`, no day or cap for kept edits), `store/assetStudioDraftStore.ts` (`saveGone`), `MoodboardStudioView.tsx` (the per-op replay, `undoDropped`, `markGone` and the held line, `LiveText`, `DropOnShow`, `focusAfterLine`, `railFocus`, the re-checks, `forgetEdits`, `unsavedAtStake`, the project line and `restoreGoneProject`), `asset-trash/AssetTrash.tsx` (`defaultOpen`, `atStake`, `onPurged`, the refusal cleared on `where`), and their tests; `tests/lib/trash.empty.test.ts` (new), `tests/lib/errorCopy.namedLine.test.ts` (a constant opening read as its text), backend `tests/test_asset_trash.py`.
- Round 6m: `boardSaveLine.ts` (`KeptImage` as `{ n }`, `projectRestoreFailure`, `projectRestoreFailedLine`), `MoodboardStudioView.tsx` (Reference #N, `ProjectGoneBoard.projectName`, `restoreGoneProject`'s outcomes, `projectRestoring`, `projectFailures`, `projectsPurged`, the × focus, `replayAway`'s `sends`), `boardAdds.ts` (`keepWaitingWhile`), `unsavedDrafts.ts` (its registration), and their tests; `tests/lib/errorCopy.namedLine.test.ts` (the straight-apostrophe ratchet) with `tests/lib/straightApostrophes.baseline.json` (new), `tests/tryAgainLines.ratchet.test.ts`.
- Round 6n: `boardSaveLine.ts` (`projectRestoredLine`), `MoodboardStudioView.tsx` (`projectRestoring`'s boards), and their tests.
- Round 6o: `boardSaveLine.ts` (the two titles), `boardSaveLine.test.ts`, `MoodboardStudioPaste.test.tsx`, `tests/lib/errorCopy.namedLine.test.ts` (the colon ratchet).
- Round 6q: `lib/boardViewInsets.ts` (the notice band, `frameInInsets`), `BoardCanvas.tsx` (`notices`), `MoodboardStudioView.tsx` (`noticesRef`, `agentActorLabel`), `lib/agentActorLabel.ts` (new), `lib/wsClient.ts` (the actor's `id`), `boardSaveLine.ts` ("moodboards", `acrossBoards`), `unsavedDrafts.ts` (doc), `asset-trash/AssetTrash.tsx` (`counted`), `styles/disabled-buttons.css` and `styles/moodboard-studio.css` (the paused notice action), and their tests; `tests/moodboardPausedRestore.test.ts` (new), `tests/lib/errorCopy.namedLine.test.ts` (the boards ratchet).
- Round 6: `boardAdds.ts` (board refs, re-filing, the per-board backstop, the reload record), `boardPlaceholder.ts` (`placeholderSpokenName`), `pasteImages.ts` (`reloadLostLine`), `MoodboardStudioView.tsx` (`saveAway`, `landAway`, `keepUnsaved`, the return effects), `BoardCanvas.tsx` (Fit, the spoken name, the band, the focus fallback), `outsideChipText.ts`, `OutsideChip.tsx`, `lib/boardPlacement.ts` (`band`), and their tests; `BoardCanvas.fitFollow.test.tsx` and `tests/components/AssetStudioDrafts.test.tsx` updated.

## Docs

`docs/MCP-SETUP.md` and the nebula skill (`skills/nebula/SKILL.md`) gain the `--request-id` line for `nebula moodboard new` (round 6e); `moodboard_create`'s docstring describes `request_id`. Round 6g: both say an id is unique per board, a reused id returns the first board whatever the rest of the call says, an id from another project is refused (409 `request_id_scope`), and ids are kept 7 days; the repeat's sentence is in both. Nothing else for agents changed.
