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

## Links: not built (Justin's Q161)

The brief asked for http(s) image links to be added "through the exact backend fetch `nebula moodboard add <url>` uses". That fetch isn't in the backend. `backend/moodboard_client.py` downloads links in the CLI/MCP process through `commons.net.safe_fetch`, then uploads the bytes (decision D6; `test_the_backend_has_no_url_fetching_for_boards` guards it). Pasting a link would need a backend fetch route (reversing D6), a browser fetch (ruled out), or Commons' add. That is Justin's Q161.

Until then, a clipboard that holds only http(s) links, as `text/plain` or only as `text/uri-list`, shows GM's line: "Nebula can’t add images from links. Copy the image itself, then paste it." Nothing is fetched or added. `webLinks` and `uriListLinks` take http and https only, with a `//` authority (`http:foo` is not a link). They take one per line and need every line to be one; a uri-list's `#` lines are comments.

## Round 2 (GM's rulings r1-r3, review 1)

**Copy.**
- Nothing to add: "There’s no image on the clipboard to add."
- Links only: the line above.
- An info line never replaces a toast with an action (GM r3 answer 1). With "Removed #n · Undo" up, the line isn't shown and isn't queued. It is still announced through a polite live region (`spokenLine`). The rule lives in `showInfoLine`, which both paste lines use. The Undo/Redo result toasts are the action's own and still use `showToast`.

**Placement: one helper, `lib/boardPlacement.ts`, for paste, Add images and drop (GM r2).**
- A tile never lands on another. Every tile keeps `DROP_GAP` (24) from every other, the batch's earlier tiles included.
- Paste and Add images (`aim: false`): each tile goes to the nearest free spot to the point (the pointer, or the middle of the view) where the whole tile fits in the visible board. The visible board is the board's rect at the current zoom, less a 16 px inset and less the toolbar row.
- When nothing fits, the tile goes to `nearestFreeOutsideView`, the nearest free spot outside the view. It is reported for the edge chip, and the view never moves on its own.
- Drop (`aim: true`): the first file stays where it was aimed if that is free. If it would cover a tile, it slides to the nearest free spot. Its other files follow the free-spot rule, with the chip if any land outside the view.
- Sizes are the real tile sizes: `sizeFor(1, aspect)` from the aspect read before upload.
- The search is exact for the nearest spot. Candidate x and y values come from the wish, the tiles' edges with the gap, and the view's edges. Candidate edges come from the 60 tiles nearest the wish, which keeps a 300-tile board fast, and every candidate is checked against all tiles. Positions are whole pixels, clamped inside the view after rounding.
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

**Review 1's other items.**
- Tests were added for the five unguarded paths: items-only clipboard, a control outside the Studio, a modal, loading, and List undo. Tests were also added for a non-modal dialog, ftp:// and ws://, `http:foo`, uri-list links, and a listener-leak check that spies on add/removeEventListener.
- The List append test now waits on the draft state, not the save debounce.

**Pre-existing, not in this PR:**
- The Board view grid breaks under `app-slava-restraint`: the board and side panel overlap, and the rail is 0 px tall. #209 fixes it. It shows in every Board shot.
- The header title breaks inside the word ("Moodbo / ard"). That one goes on GM's follow-up list.

## Files

- `frontend/src/lib/boardPlacement.ts` (new) and its test.
- `frontend/src/components/moodboard-studio/`:
  - `pasteImages.ts` (new): reads the clipboard, parses links and uri-lists, signs files, checks the target, and holds the lines.
  - `OutsideChip.tsx` and `outsideChipText.ts` (new), with tests.
  - `MoodboardStudioView.tsx`: the paste listener, the held-key guard, the backstop, info-line priority, placement, and the chip state.
  - `BoardCanvas.tsx`: targets, the view rect, the toolbar as a bottom bar, and the chip.
  - `MoodboardStudioPaste.test.tsx` (new) and `BoardCanvas.test.tsx`.
- `frontend/src/styles/moodboard-board.css`: the chip.

## Docs

`docs/MCP-SETUP.md` only describes how agents add images, and agents get no new tool here, so it's unchanged.
