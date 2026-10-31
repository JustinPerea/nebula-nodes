# Paste images into a moodboard with Cmd+V (feat/moodboard-paste, 2026-10-31)

Justin decided it: Cmd+V in Moodboard Studio adds the image files on the clipboard to the open board.

## What it does

- One `paste` listener on the document, bound while Moodboard Studio is mounted (App mounts it only when the Studio is the main view) and acting only while `isCurrent()` holds. A `paste` event covers Cmd+V, Ctrl+V and the desktop app's Edit > Paste.
- It never takes a paste meant for a text field or a dialog (`isStudioPasteTarget`, the same check as the Studio's Cmd+Z): Name, Direction, Avoid, the colour fields, image notes and private notes keep their normal paste.
- It listens in the bubble phase and skips a paste something already refused (`defaultPrevented`). So a tab following an agent's switch (`hooks/useFollowingReadOnly`, capture phase) refuses a paste exactly as it refuses a drop.
- **Files.** `image/*` files from `clipboardData.files`, or from `items` when a source puts the image only there. They go through the drop path unchanged (`uploadFiles` -> `POST /api/uploads`, its type and size checks, and its error lines):
  - Board view: `dropFiles` at the point the board reports, which is the last pointer position over the board, or the middle of the view when the pointer has left. Several files fan out with `dropLayout`, as a multi-file drop does.
  - List view: `handleFiles`, appended in clipboard order.
- **A browser copy** (the file and HTML with an `<img>`): the file is taken and the HTML ignored.
- **Nothing to add:** text that isn't a list of http(s) links, a `data:`, `file:`, `blob:` or `javascript:` link, or an empty clipboard. It shows GM's draft line through the board toast: "There’s no image or image link on the clipboard to add." Nothing is fetched.
- **Undo:** one step per paste, the same step a drop records (`commitOps` with one label).
- **Tab not connected as the person:** no new route and no new gate. A paste makes the same `/api/uploads` call as a drop, so it gets the same answer. A test checks that the line a paste shows on a `person_required` refusal is the one the Add Images button shows.

## Not built: http(s) links (needs a decision)

The brief asked for http(s) image links to be added "through the exact backend fetch `nebula moodboard add <url>` uses". That fetch isn't in the backend. `backend/moodboard_client.py` downloads links in the CLI/MCP process, through `commons.net.safe_fetch`, then uploads the bytes. That's decision D6 (implementation-notes.md, 2026-10-18: "the backend never fetches URLs for boards"). `tests/test_moodboard_cli.py::test_the_backend_has_no_url_fetching_for_boards` checks that the backend has no such route.

Adding links from the browser means one of these:

- a new backend route that fetches a link for a board, which reverses D6 and fails that test; or
- a browser fetch, which the brief rules out; or
- a route over Commons' person-side add (`routes/commons.py`, `intake.add_url`), which puts the link in Commons, not on the board.

Each changes who fetches what, which the brief says to stop on. So for now a clipboard of http(s) links is left alone: no preventDefault and no line. `readClipboardImages` already parses those links (`webLinks`: http and https only, one per line, every line must be one), so the handler only needs a call once the fetch path is decided.

## Files

- `frontend/src/components/moodboard-studio/pasteImages.ts` (new): reads the clipboard, parses links, checks the target, and holds the line.
- `MoodboardStudioView.tsx`: the paste listener.
- `BoardCanvas.tsx`: tracks the pointer over the board and exposes `pastePoint`. Add images now shares `viewPoint()` with it, with no change in behaviour.
- Tests: `MoodboardStudioPaste.test.tsx` (new, 16 tests) and `BoardCanvas.test.tsx` (3 new).

## Docs

`docs/MCP-SETUP.md` only describes how agents add images, and agents get no new tool here, so it's unchanged.
