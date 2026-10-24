# 2026-10-24 — Files dropped on the canvas all land, where they were dropped

Branch `fix/canvas-drop-files`, from main at 86577271 (#187 merged).

Found 2026-10-24 while comparing Nebula to MagicOS. Justin's standing rule: "I want to do complete fixes as soon as we run into them."

## What was wrong

- `Canvas.tsx` onDrop kept only `image/*` and `video/*` files. A PDF, a text or markdown file or an audio file fell through to the character, moodboard and node-library branches and nothing happened, with no message.
- A failed upload was only `console.error`'d.
- The drop point was thrown away. The comment said "cli_graph export auto-lays-out": that was wrong. `_display_positions` (main.py) keeps any stored position; only nodes with no position are laid out. `/api/uploads` stored `max-x + 300, y = 100` itself, so every drop went to the far right in one row, and several files landed with no layout.
- `/api/uploads` refused audio with 415, though an `audio-input` node exists. The Inspector's own file control on an Audio Input hit the same 415, also silently.
- On a canvas that mounted empty (a new project), React Flow's own first fit (the `fitView` prop) waits for nodes. A first drop there was zoomed to 400% and away from the drop point. Seen in the live check, not in the brief.

## What changed

- **Backend `/api/uploads`** (main.py): new `_sniff_audio_type`. It checks signatures like the image, video and PDF sniffs do: WAV (`RIFF....WAVE`), MP3 (`ID3`, or an MPEG frame sync with a valid layer and version), AAC (ADTS sync), M4A (`ftyp` with an `M4A `/`M4B ` brand), FLAC (`fLaC`) and Ogg (`OggS`, Vorbis or Opus). Audio goes to `audio-input` with `{filePath, _previewUrl}`, the shape the Inspector's own upload writes (the engine reads `filePath`). The audio sniff runs after the image sniff, so a JPEG (`FF D8`) can't read as a frame sync, and before the video sniff, so an `.m4a` no longer becomes a Video Input. The 415 line now names audio.
- **Placement**: optional form fields `x` and `y`. Send both or neither, as finite numbers. Anything else is a 422 before a byte is written. A created node goes there. With neither, placement is the same as before.
- **Canvas** (`lib/canvasFileDrop.ts`, new): every file in a drop is handled. Images, video, audio, PDF and text upload with `create_node` at `screenToFlowPosition` of the drop point. Several files fan out on a 3-column grid from it: 300 px across, 420 px down, deterministic. Other files, and failed uploads, get a line in the canvas notice (`graphStore.notify`, the surface `lib/canvasNotice.ts` and the delete/undo notices already use).
- **Undo**: still one step per accepted file. A failed file gives its step back.
- **Camera**: a drop's own nodes don't trigger the canvas's fit-to-new-nodes (`fileDropInFlight()`, with a 1 s grace after the last upload settles). A drop also cancels React Flow's waiting first fit (the `fitView` prop is now state, set false on drop). Without these two, nodes placed under the cursor were immediately framed or zoomed somewhere else.
- **Inspector file control**: uses `apiRequest`, and a failure is now a canvas notice ("Couldn't upload {filename}." then the reason). The preview `<img>` is drawn only for image nodes. It drew a broken image for audio and video.
- **Notice CSS**: the no-button message notice uses `white-space: pre-line`, so a drop's failures each get their own line. Single-line notices look the same.
- **Agents**: MCP `upload_file(path, position=None)`, where `position` is `{"x","y"}` like edit_canvas. `nebula upload <file> --at x,y`. `upload_client.upload(..., position=)` checks the spot before reading the file. CLI prints `nebula connect nX:audio ...` for audio. Docs: docs/MCP-SETUP.md (`upload_file` entry) and skills/nebula/SKILL.md (types, `--at`, ports). INSTRUCTIONS is untouched: it doesn't list upload types.
- `/api/quick`'s file-to-input guess also takes `.aac`, `.flac` and `.ogg` as audio, to match.

## Copy (provisional, GM - Design owns it)

- Final copy from GM - Design (2026-10-24), applied by the coordinator after the lane. File names go in curly quotes, as the other labels do. There is one notice per drop, and files that went in get none.
  - One failure: "Couldn't add “{filename}”. Nebula takes images, video, audio, PDFs and text files." or "Couldn't upload “{filename}”." then the reason (`failureMessage`).
  - Two or more: "Couldn't add {n} of {total} files.", or "Couldn't add the {n} files." when none went in. The second line is the shared reason when every failure has the same one; otherwise it is "Not added: “a.zip”, “b.psd”." with "and {k} more" past two names, in drop order.
  - The notice now waits for the drop's uploads, so the one notice can name every failure. A drop with nothing to upload says so at once.
- Unsupported files are named right away. If an upload then fails, one notice restates every failure. The notice region has one slot, so it is one combined notice, not several.

## Decisions not in the brief

- Audio shares the 500 MB clip cap, not the 20 MB image/document cap. An hour of WAV is far over 20 MB.
- An audio upload is not probed with ffprobe. Nothing reads audio duration from params today. Video is still probed.
- The frontend decides "can Nebula take this?" by extension first, and by MIME type only for a name with no extension. A `.heic` gets the "Couldn't add" line, not an upload that comes back 415. The backend still checks the bytes. A renamed fake (`x.png` that isn't a PNG) gets "Couldn't upload x.png." with the backend's reason.
- Cancelling React Flow's waiting first fit applies to every drop onto the canvas (files, library node, character, moodboard), not just files. Every drop places something where the person chose.

## Tradeoffs and surprises

- The "auto-lays-out" comment was stale. Positions already survived export. The real cause was the backend's own `max-x + 300` placement plus the frontend sending no position.
- `fileDropInFlight` is a module counter, not tied to node ids: the graphSync for an upload arrives before its HTTP answer, so the ids aren't known yet when the fit would fire. If an agent adds a node during a drop's upload, that one fit is skipped too. That's minor.
- Not changed: the Inspector's "Extract from reference" palette upload still only logs a failure. It's a different feature, listed under open items.

## Tests (written first, seen failing on unchanged code)

- `backend/tests/test_upload_drop_files.py` (new, 30). On unchanged code 26 failed: audio 415s, 200 instead of 422 for bad spots, position ignored (`{'x': 0.0, 'y': 100.0}`), `upload() got an unexpected keyword argument 'position'`, `run() got an unexpected keyword argument 'at'`, MCP schema without `position`, docs without "Audio Input". The 4 guards passed (RIFF/AVI refused, MP4 still video, JPEG not MP3, default placement).
- `frontend/tests/Canvas.fileDrop.test.tsx` (new, 17). On unchanged code 15 failed: no upload for pdf/wav/mp3/txt/md, no position for png/mp4, no notices, no undo steps. The library-node guard passed. The first-fit test was added after the live check found the 400% zoom, and failed before that change.
- `frontend/tests/Inspector.fileUpload.test.tsx` (new, 3). On unchanged code 2 failed: no notice on failure, preview `<img>` drawn for audio. The audio-fill test passed: the frontend side already worked, only the backend refused audio.

## Live check

- Isolated backend on 8791 (temp HOME, every NEBULA_* root under scratch, no keys) and Vite on 5791 with `VITE_NEBULA_BACKEND_PORT=8791`. `/api/health` through Vite was 200 first. Chrome had a dead proxy plus loopback bypass for only 5791 and 8791, and CDP `Network.setBlockedURLs` for 8000-8010 and 5173. A canary port was blocked. **Blocked attempts at Justin's ports: 0.**
- New project, then a real `DataTransfer` drop at client (420, 300) with zoom 1, so the flow point was (420, 300): swatch.png, brief.pdf, tone.wav (ffmpeg sine, 0.3 s), notes.txt, bundle.zip.
- Result: n1 image-input (420, 300), n2 document-input (720, 300), n3 audio-input (1020, 300), n4 document-input (420, 720), matching on screen. The notice said "Couldn't add bundle.zip. Nebula takes images, video, audio, PDF and text files." Zoom stayed 100%. Checked at 1280x800 and 1440x900.
- The first run, before the first-fit fix, showed the 400% zoom on the empty canvas. That's what led to that change.

## Open items

- GM - Design to replace the three provisional lines.
- Audio and document cards don't show the file's name on the canvas (they never did). Worth a look with GM.
- The Inspector's palette "Extract from reference" upload failure is still console-only.

## Review

- Fixed four confirmed findings (six reports, two pairs were duplicates). Tests written first and seen failing on the code before each fix:
  - An .m4a with an isom/mp42 brand (ffmpeg `-f mp4`, Android recorders, many exporters) went down the video path and got a 415. `_sniff_audio_type` now also reads the tracks' `hdlr` boxes: sound tracks and no video track means audio. It gets the whole file, since `moov` sits at the end of a file that isn't faststart. 4 new cases failed first (415, "Could not probe video metadata"); a clip with a video and a sound track stays a Video Input.
  - A .txt/.csv/.md saved as UTF-16 (starts FF FE, an MPEG frame sync) or starting with "ID3" became an Audio Input holding an .mp3. A text filename extension now skips the audio sniff, as on main. 3 cases failed first ('audio-input' == 'document-input').
  - A multi-file drop of portrait photos overlapped: the fixed 420px row step is shorter than a 9:16 card (~500px) or a phone screenshot (~590px). Rows now stack under the tallest card of the row above plus 40px. The page reads each image's or clip's size before sending (an `<img>`/`<video>` on an object URL, 1.5 s cap); other kinds and unreadable files count as the old 380px card, so non-image drops land exactly as before. 2 tests failed first (row 2 at 470 instead of ≥640; a 1080x1920 clip estimated at 380).
  - `nebula upload --at -200,140` failed with "expected one argument" (argparse reads a dash-led word as an option). Fixed in the parser instead of only documenting `--at=`: `--at` followed by a negative x,y pair is joined before parsing (cli/parser.py). Help and SKILL.md show a negative example. 2 of 3 cases failed first.
- Surprise: the drop now waits for the size reads, and jsdom's Image never loads, so the canvas tests settle timers twice. The refit test advances past the 1.5 s cap first.
- Live re-check, 8791/5791, same isolation, 0 blocked attempts, canary blocked. Drop A (png, pdf, wav, txt, zip) as before: four nodes at the drop point, the .zip line shown. Drop B at (200, 120): four 1179x2556 PNGs, an isom .m4a and a UTF-16 .txt. Row 1 cards were 590px tall at y 120, row 2 at y 751 (41px gap, no overlap); the .m4a became an Audio Input (.m4a) and the UTF-16 file a Document Input (.txt). Checked at 1280x800 and 1440x900.
