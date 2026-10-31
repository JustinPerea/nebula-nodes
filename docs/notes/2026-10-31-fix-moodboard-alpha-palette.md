# fix/moodboard-alpha-palette: transparent pixels aren't a colour

Base: main at 1944d052. Reported by the portable-agent brand session: a board
of one logo mark (182×182 RGBA, about 74% transparent, opaque colours only a
charcoal and an orange) analyzed as "near-black 98%, orange 2.4%", and a
64×64 sprite at about 49% alpha as "near-black 49%".

## Root cause

Every colour measurement started with `convert("RGB")`, which drops the alpha
channel and keeps the colour stored under each pixel. In most PNG exports a
fully transparent pixel stores black, so the transparent background was
counted as a large near-black colour:

- `services/moodboard_analysis._measure_file` opened the file and passed
  `pil.convert("RGB")` to Commons' `measure_image` and to `_image_stats`.
- `commons/measure._downsampled_rgb` converted to RGB again.
- `commons/media.load_image` (Commons intake and the borrow fidelity check)
  returned RGB.
- `cinema/color.extract_palette`, and Cinema Color's handler, which called it
  with `src_img.convert("RGB")`.

## The fix: one alpha-aware way in

`cinema/color.py` (the lowest layer, which Commons already imports):

- `visible_pixels(img, max_dim=256)` returns the pixels that count and their
  weights. An opaque image is read as before (NEAREST resize to 256 on the
  longest edge). Round 2 (review 1 F2): an image with transparency is read
  by an area reduce instead, see "Round 2" below.
- `has_transparency(img)` checks for an alpha channel that isn't all 255, a
  palette transparency index or a tRNS chunk.
- `_kmeans_lab(..., weights=)` adds weighted k-means++ seeding and weighted
  centres. With `weights=None` it runs the old code path unchanged.

**Threshold: alpha 16 of 255 (`ALPHA_MIN`).** A pixel below about 6% coverage
doesn't count. Pixels that faint are the fringe of an antialiased edge or a
haze, and once stored in 8 bits their colour says little about what's seen.

**Weighting: alpha / 255.** A pixel counts as much as it covers: a half-alpha
pixel is half a pixel. Shares are of the visible, alpha-weighted pixels, so
the mark reads 90% charcoal and 10% orange. The weights apply to the k-means
seeding, the cluster centres, the shares, the accent pass and its minimum,
the value-range percentiles (numpy's weighted `inverted_cdf`) and the
moodboard's mean lightness and saturation.

**Straight colour, never flattened.** PNG and Pillow's RGBA store straight
(not premultiplied) alpha. `convert("RGBA")` un-premultiplies RGBa. Round 1
said it did La too: it doesn't, Pillow raises "conversion from La to L not
supported" (base raised the same way in `convert("RGB")`). Round 2 reads La
through LA (`as_rgba`, `as_rgb`), which un-premultiplies it, with a test. A file that stores darkened edge colours under
straight alpha (a broken export) still counts those pixels, but only by
their alpha.

**Opaque images don't change.** With no transparency, `visible_pixels`
returns the old pixels and `weights=None`, and every weighted step falls
back to the old expression. The gradient golden in `tests/test_colour_alpha.py`
is measure-1's output on 1944d052, byte for byte, for RGB and for an RGBA
image that is fully opaque.

**Fully transparent image.** No visible pixels gives an empty palette, with
`value_range` None and lightness/saturation None. It doesn't invent a colour:

- moodboard: the image's entry has `transparent: true` and `colors: []`, and
  it takes no part of the board's weight. Its line (GM r2: "#N is too
  transparent to add colors.", one line for clear and faint images) goes in
  the summary (Studio, CLI, MCP, and since round 2 the node's bundle) and in
  `warnings`. A board where every image is clear says "no local palette
  extracted" as before, plus that line.
- Cinema Color with a clear Palette Source (GM r2): "The image in “Palette
  Source” is too transparent to match colors from. Choose another image, or
  add hex swatches to “Palette”." Before, this was either a black palette or
  the generic "needs a target palette".
- borrow fidelity on a clear output: `unverifiable`, "output is too
  transparent, so it has no palette". Before, `min()` over an empty palette
  raised.

## Stale analyses

- `ANALYSIS_VERSION` 5 → 6 (`ALPHA_VERSION`). `source_hash` doesn't change,
  so `brief_basis` and the overrides don't move.
- `predates_alpha(board, analysis)`: an analysis older than version 6, on a
  board where any image (set-aside ones included, since they are measured
  too) has a pixel less than opaque. Round 2 (review 1 F3): it reads only
  each image's stored `hasTransparency`, never the file (see "Round 2").
- Round 2 (review 1 F5): `analysis_is_current` means only "describes this
  board" again, as on base. `colours_current` (current and not
  `predates_alpha`) is the Moodboard node's test: it analyzes the board
  again and says why (GM r1: "The board’s saved colors counted transparent
  areas as dark, so this run analyzed it again. Analyze it in Moodboard
  Studio to save the new analysis."). The dry run's `saved.current` is
  `analysis_is_current`, with `saved.outdated` beside it.
- `with_alpha_outdated` runs on every store read (beside
  `with_steering_count`). It adds `analysis.outdated` (GM r1: "These colors
  counted transparent areas as dark. Analyze again to update them."), so
  Moodboard Studio (`AnalysisOutdated`), `nebula moodboard show` and MCP
  `moodboard_get`/`moodboard_list` all say it's out of date. Round 2: it
  also removes a stale one, and the store strips it before every write.
- An older analysis of an opaque board stays current: its colours are the
  same, so it isn't flagged as falsely stale and keeps hand edits.
- Studio doesn't re-analyze on open; no surface did before, and it would be a
  write the person didn't ask for. Analyze, the CLI, MCP and a node run all
  re-analyze.

Commons:

- `CODE_VERSION` "measure-1" → "measure-2". New intakes record it.
- The analysis rows now record the asset's own `code_version` (the worker
  passed nothing, so every row said "measure-1").
- Assets measured before this keep their stored measure-1 palette. Nothing
  re-measures a stored asset, and the reader's roles point at palette
  indices, so re-measuring means a new paid read. That is Justin's call
  (coordinator, round 2): nothing is built for it.

## Audit: every place Nebula reads colour from pixels

| Site | Measures or composites | Verdict |
|---|---|---|
| `services/moodboard_analysis._measure_file` | measures (palette) | fixed: RGBA kept when there's transparency |
| `services/moodboard_analysis._image_stats` | measures (lightness, saturation) | fixed: alpha-weighted, ALPHA_MIN |
| `commons/measure.measure_image` (+ `_palette`, value range) | measures | fixed: `visible_pixels`, weighted; measure-2 |
| `commons/media.load_image` | decode for both | `keep_alpha=True` opt-in for measuring; default RGB kept |
| `commons/intake._image_columns` | measures | fixed: `keep_alpha=True`; phash still from RGB (unchanged) |
| `commons/borrow.run_fidelity` (palette) | measures | fixed: `keep_alpha=True`, plus the empty-palette guard |
| `cinema/color.extract_palette` | measures | fixed: `visible_pixels`, weighted k-means |
| `handlers/cinema_color` source palette | measures | fixed: no RGB flatten, plus the clear-source error |
| `handlers/cinema_color` transfer, `cinema/color.transfer_to_palette`, `_to_rgb_array` | grades output | fixed in round 2: the colour channels are graded, the source alpha is carried through, and the statistics count only what is seen; opaque output byte-identical |
| `cinema/look.py`, `handlers/cinema_look.py`, `handlers/cinema_scene.py` | composite output | left |
| `commons/worker` (`encode_png(load_image)` for the reader) | image for the vision model | fixed in round 2: composited onto #0a0a0a; a too-transparent one is never sent |
| `services/moodboard_reader.encode_image` (JPEG for the vision reader) | image for the vision model | fixed in round 2: composited onto #080808; a too-transparent one is never sent or priced |
| `services/vision_llm._encoded_images` (the Vision node) | image for the vision model | fixed in round 2 (review 1 F7): composited onto the canvas node surface #0a0a0a; a clear image is sent as the bare surface (the node must send something) |
| `services/qc_jev._data_uri` (Jev QC frames and reference) | image for the vision model | fixed in round 2 (F7): same surface; frames are opaque, so unchanged |
| `services/qc_common.normalized_rgb` (`qc_metrics` histograms, `color_drift_score`, `reference_match`) | measures | fixed in round 2 (F7): composited onto #0a0a0a. Frames are video and opaque, so their scores don't move; a transparent reference no longer reads as black |
| `services/qc_common.open_rgb`, `create_annotated_frame` | frames for QC | left: video frames, no alpha |
| `commons/review.py`, `commons/evaluation.py` (snapshot PNG + palette) | the labelled evaluation batch | left: the batch's PNG, palette and labels must match each other, and the stored batches are frozen. Round 2 (F8): the manifest records `measure-1`, which is what measures an RGB snapshot, not `CODE_VERSION` |
| `commons/measure.phash` | perceptual hash, not colour | left (intake passes RGB) |
| `services/output_preview.py`, `output_thumbnail.py` | previews | left: alpha already kept |
| `services/image_transcode.py` | JPEG output, flattened onto white | left: output |
| `services/edit_masks.py`, `scripts/smoke_ideogram_live.py` | masks | left: not colour |
| `handlers/jev_box.py`, `handlers/veo.py` | output encoding | left: alpha already kept |
| `scripts/generate_preset_thumbnails.py` | thumbnails | left: output |
| `frontend/src/lib/paletteExtract.ts` (Inspector "Extract from reference") | measures | fixed in round 2: the backend's rule (under 16 out, the rest by alpha), from `contracts/fixtures/colour/alpha.json`; opaque results unchanged |
| `frontend/src/components/panels/MaskPainterModal.tsx` | mask painting | left: not colour |

`getcolors`, `quantize` and a "mean colour" helper don't exist in the code.

## Tests

- `backend/tests/test_colour_alpha.py` (23): synthetic images only. They cover:
  - the mark (74% clear, 90/10);
  - a 64×64 sprite at 49% alpha;
  - a soft-edged antialiased disc;
  - a fully transparent image;
  - an opaque image (the byte golden, as RGB and as opaque RGBA);
  - a P PNG with a transparency index;
  - an LA image;
  - alpha weighting of shares, of k-means centres and of the value range;
  - the threshold;
  - Commons intake (palette and phash);
  - `extract_palette`, and Cinema Color with a sprite source and a clear one;
  - the moodboard analysis: the mark, sprites, the clear image's line and
    entry;
  - staleness: a v5 analysis is out of date on a transparent board, current
    on an opaque one, the store read adds `outdated`, and the dry run says
    so.
- `test_moodboard_cli.py`: `nebula moodboard analyze` gives "#111413 90%,
  #e8593c 10%" and the clear-image line. MCP `moodboard_analyze` returns the
  same palette and shares. After a v5 analysis is stored: MCP `moodboard_get`
  has `outdated`, `show` prints it with the command, and `--dry-run` prints
  it instead of "changes include edits to the board".
- `test_commons_borrow.py`: palette fidelity on a clear output is
  unverifiable. `test_commons_worker.py`: the analysis records the asset's
  measure version (measure-2 new, measure-1 old).
- Frontend `MoodboardColors.test.tsx` (+2): the outdated line shows, alone
  (the "sources" hint gives way to it), and version 1 keeps the older
  analyzer note.
- 18 of the 20 new backend tests in `test_colour_alpha.py`, and the CLI/MCP
  test, fail on 1944d052 (run against a `git archive` of it). The two that
  pass there are the "must not change" guards: the opaque byte golden and
  "an older analysis of an opaque board stays current". The three added
  later (weighting of shares, centres, value range) were seen killing their
  mutants.
- Version pins 5 → 6 in `test_moodboard_analysis`, `_provenance`, `_routes`
  and `_set_aside`.
- Golden (`test_moodboard_golden.py`): one path moved,
  `prebrief_unanalyzed.sourceHash.version` 5 → 6 (today's analyzer's, as the
  4 → 5 bump did). Its hash is the same. It is recorded in the golden's
  change list, and `_without_krea_refs` reads that path as 5, so the
  Q21b pin hash is unchanged. No golden board image has transparency.

## Mutants (each guard was mutated and seen failing)

All 23 were killed. Backend (21): threshold off, alpha unweighted, the
moodboard flattening again, no transparency detection, weighted k-means
ignoring weights, stats unweighted, a clear image taking part of the board,
no summary line, current ignoring alpha, predates never, the store hook off,
the CLI outdated line off, the CLI dry-run reason off, intake dropping alpha,
borrow dropping alpha, borrow's empty guard off, Cinema Color flattening,
Cinema's clear-source guard off, the worker version fixed, the value range
unweighted, the dry run's outdated off. Frontend (2): `AnalysisOutdated`
ignoring `outdated`, and `SourcesOutdated` showing beside it.

## Gates (2026-10-31)

- Backend, isolated (temp HOME, NEBULA_SETTINGS_PATH, NEBULA_STATE_DIR,
  NEBULA_OUTPUT_ROOT), 68 files: test_colour_alpha, the cinema tests, every
  test_commons_*, every test_moodboard_*, error_copy_round3,
  krea_board_strengths, media_consumer_file_access, test_unprivileged_marker
  and test_ci_shard. **2458 passed, 0 failed, 0 errors.**
- The 39 test files that read SKILL.md or MCP-SETUP.md: **1168 passed**.
- Frontend:
  - `tsc -b --noEmit` rc 0, `npm run lint` rc 0 (inline styles, Slava scope,
    eslint);
  - vitest (`--maxWorkers=2`): the 13 moodboard-studio files plus the 3
    ratchets that read src from disk, **16 files, 240 passed**;
  - `vite build` and the budget: **444,245 bytes raw** / 136,420 gzip (limit
    512,000).
- Live on 8792/5792:
  - Setup: backend from `devserver.py` with a temp HOME and every NEBULA_*
    root in scratch, no keys or tokens. Vite has
    `VITE_NEBULA_BACKEND_PORT=8792`. Headless Chrome uses a dead proxy plus
    CDP `setBlockedURLs` for 8000-8010, 5173, 8840 and 5840.
  - The canary blocked 8000, 5173, 8840, 8791 and example.com, with 0
    reached. No request went outside 5792/8792 during the runs.
  - "Before" is a `git archive` of 1944d052 (backend and frontend). The mark
    board read #040605 97%, accent #e8593c 2.6%. The sprite board read
    #3caa5a 52%, #000000 48%.
  - "After" ran on a copy of the before state. The old analysis showed the
    outdated line in Studio and `show`, and in the `--json`/MCP view. After
    `nebula moodboard analyze`: the mark read #111413 90%, #e8593c 10%; the
    sprite #3caa5a 100%. The seven-image board said "#4 is fully
    transparent, so it adds no colors."
  - Shots: scratchpad `alpha/shots/` (01-before-*, 02-after-*), 1440x900,
    no duplicate md5.

## Round 2 (base affb9b25)

The coordinator's round 2 brief, GM r1 and r2, and review 1 (colour
correctness, surfaces and agents). Everything above is corrected in place
where round 2 changed it.

### Decisions

- **Stored Commons assets keep their measure-1 palettes.** Re-measuring one
  means a new paid read, so it is Justin's call. Nothing is built for it.
- **What a vision reader sees.** A reference with transparency is sent
  composited onto the surface the app shows behind it, never onto the colour
  hidden under its alpha. The surfaces come from the CSS and live in
  `contracts/fixtures/colour/alpha.json`; tests on both sides check them
  against the CSS:
  - Commons (tile and detail stage): `--sr-node-media-bg`
    rgba(255, 255, 255, 0.04) over `--sr-canvas` #000000, so #0a0a0a.
  - Moodboard reader: the board card, rgba(255, 255, 255, 0.03) over
    #000000, so #080808. The list tile and side panel draw the same images
    on rgba(0, 0, 0, 0.22) over their panel, which is near black too. I
    chose the board card because that is where the person lays the
    references out. The coordinator can still swap it for neutral grey,
    since there is more than one surface.
  - The Vision node and QC (review 1 F7): a canvas node's image,
    `.model-node__preview-image` on `--sr-node-media-bg`, so #0a0a0a.
  An opaque image is sent byte for byte as before (`composite_on` returns
  `convert("RGB")`), and the request count and model don't change.
- **Too transparent: one line** (GM r2): "#N is too transparent to add
  colors." It covers an image with no pixel at alpha 16 or above, decided
  at full resolution. That is a clear image or a faint haze. Such a
  reference is never sent to a reader:
  - The Moodboard reader drops it from `estimate` and `read_estimate`,
    which list it under `transparent`; the CLI prints "Too transparent, so
    not read: #N".
  - In a read it gets a skip trace line with that text, and its result
    line reads "#N Unsorted: it's too transparent" (why: "It's too
    transparent to add colors.").
  - The Commons worker marks it failed, `unreadable`, "too transparent to
    add colors; not sent to the reader", before the meter or any call.
    The Commons shows its existing unreadable copy for it.
  - The frontend notice keeps GM's 2026-10-24 wording ("The image is fully
    transparent." only when every alpha is 0; heading only otherwise), and
    that is still true.
- **Cinema Color keeps the source alpha.** The colour channels are graded,
  with statistics weighted like the palette, and the alpha is put back.
  A source where nothing is seen comes back unchanged. Opaque output is
  byte-identical (pinned by hash). GM r2's clear-source line: "The image in
  “Palette Source” is too transparent to match colors from. Choose another
  image, or add hex swatches to “Palette”."
- **Frontend "Extract from reference"** follows the backend rule: pixels
  under 16 don't count, the rest count by alpha. `ALPHA_MIN` and the weight
  cases come from the contract file, and a test fails if either side
  drifts. The opaque golden is computed on 1944d052's code.
- **The summary has a real plural** (GM r1): "1 reference image analyzed
  as look." and "7 reference images analyzed as look.". A summary saved with
  "(s)" reads in today's form. This re-pinned 13 golden summaries and 4 in
  `moodboard_defaults_pin.json`; the golden change list records it, and the
  hashes are unchanged.
- **An image's board weight** stays one reference each, measured by its
  visible pixels (coordinator's call). A sparse logo on a big canvas is
  still one full reference; canvas padding doesn't shrink it. Opaque RGBA,
  with every alpha at 255, is opaque everywhere.

### Review 1, fixed

1. **F1 (HIGH): analyze crashed on sparse or faint images.** The stats now
   come from the same `visible_pixels` output the palette uses, so "no
   visible pixels" means one thing. `_weighted_mean`, the keywords and the
   lighting hint skip None. The tests (2048² line art, one pixel at alpha
   16) crash on affb9b25.
2. **F2: thin strokes read as fully transparent.** An image with
   transparency is now reduced with an area filter, `_area_pixels`.
   - Pixels under 16 are zeroed first.
   - Each `f`×`f` block's colour is its alpha-weighted mean, so it is
     premultiplied: no dark fringe.
   - Its weight is the block's alpha over a full block (`f·f·255`), so it
     carries its coverage.
   - A block with any pixel seen stays, so nothing seen at full resolution
     is lost.
   - Integers, strip by strip, so a large image never holds a float copy.
   - Opaque images stay NEAREST, so they are byte-identical.
   - "Too transparent" is `is_clear`: full-resolution alpha, `max < 16`.
3. **F3: the alpha check decoded images on the event loop.** Whether each
   image has transparency is now a stored fact on its entry,
   `hasTransparency`:
   - Intake writes it when an image's file is new to the board (a new
     image, or a changed url), in `_normalize_images`.
   - For older images, `stamp_transparency_once` runs once at startup, as a
     background task in a thread. It covers only boards whose analysis is
     older than version 6, and adds only that key (no backup, the version
     stays).
   - Reads look only at the flag. A board list or get never decodes an
     image (tested with `Image.open` patched to fail).
   - A missing or unreadable file stays unknown. Unknown never marks a
     board out of date, and only the unknown files are tried again on the
     next start.
   - The lru caches are gone. Until the pass stores the flag, an old board
     reads as current, as on base.
   - The image request model accepts the flag back from a client and
     ignores it, since Studio sends the images as it read them.
4. **M1: an outdated board showed the old brief as current.** While
   `analysis.outdated` is set, `with_brief` sets `brief.outdated` (GM r2:
   "This brief uses the old colors. The next run analyzes the board again
   and sends an updated one."). Studio shows it under the "Brief sent to
   generators" header, in the outdated line's warning style. `show` prints
   it under its header, MCP get and list return it, and the docstrings and
   MCP-SETUP describe it. No dry run on open.
5. **F4: `analysis.outdated` was written to disk.** `_read_for_write` and
   `_normalize_analysis` strip it, so a write never keeps it, even when a
   client sends the analysis back. `with_alpha_outdated` works it out again
   on every read and removes a stale one.
6. **F5: `analysis_is_current` changed meaning.** It is base's again. The
   new `colours_current` is used only where the node re-analyzes; the
   outdated surfaces use `predates_alpha`. `with_steering_count` and the
   brief migration are tested on a pre-v6 board, transparent and opaque.
   The node's alpha warning now needs the analysis to still describe the
   board. A board that changed gets the "board changed" line instead.
7. **F6: pins, with real numbers.**
   - The threshold: 15 is out, 16 is in, written as literals.
   - An alpha-254 pixel is transparency.
   - Lightness on a two-alpha image is 255 / (1 + 64/255).
   - The accent pass, with the main clusters fixed on eight greys: three
     opaque pixels give share 0.0059 (weighted, not 3/2000), and at alpha
     64 there is no accent (0.75 of a pixel is under the minimum).
   - A set-aside or weight-0 transparent image still dates the colours.
   - A new url re-reads the flag.
   - A pinned palette for a transparent ramp moves with any change to the
     weights, the reduce or the weighted seeding.
8. **F7: the missed sites.** `vision_llm`, `qc_jev` and
   `qc_common.normalized_rgb` composite onto the canvas node surface, and
   opaque output is byte-identical (tested). `open_rgb` and
   `create_annotated_frame` are left: video frames have no alpha.
9. **F8:** the Commons evaluation manifest records `measure-1`.
10. **F9:** the golden normalisation applies only to
    `prebrief_unanalyzed.sourceHash.version`, and only from 6 to 5.
11. **F10:** La is handled, with a test, and the notes are corrected
    (above).
12. **L1:** the node's bundle summary carries the too-transparent line.
13. **L4: survivors.** Each one is now killed; see "Mutants, round 2".
14. **N1:** the CLI, MCP docstrings, MCP-SETUP, SKILL and the node warning
    say the same thing. The CLI no longer prints a second "Analyze again"
    (for sources) under an outdated analysis, as Studio already didn't.

### Round 2 surprise

- I made a bare `import main` once without the isolated environment while
  checking imports. It printed "restored graph from ~/.nebula/state.json".
  That file's mtime didn't change (it was last written about 43 hours
  earlier), so nothing was written. Every later run went through an
  isolated wrapper.

### Mutants, round 2

Each mutant changed one guard; it counts as killed only when the focused
tests fail.

- First half of round 2 (readers, Cinema alpha, frontend rule, GM lines):
  19 backend and 4 frontend, all killed (baseline 146 passed).
- Review 1 section, 41 backend, all killed. The first run killed 38. Three
  survived, and each one exposed a weak test:
  - the accent share counted unweighted: three opaque pixels weigh the
    same either way, so a case with six pixels at alpha 128 was added;
  - `_read_for_write` not stripping `outdated`: the test checked the file
    only after the last write, which strips it anyway, so the file is now
    checked after every write;
  - the startup pass ignoring the analysis version: the v6 board in the
    test already had its flags, so they are now removed first.
  Re-run, all three are killed.
- The 41 cover:
  - the threshold (16 to 1 and to 17);
  - the 254 transparency check;
  - the reduce (no pre-zeroing, weight not over the full block);
  - `is_clear` on the minimum;
  - La;
  - weighted seeding (first pick and mass);
  - `as_rgb` returning the caller's image;
  - the accent gate and share;
  - stats unweighted, stats from a 64 px BILINEAR sample, `_weighted_mean`
    not skipping None;
  - `predates_alpha` skipping set-aside images, treating unknown as
    transparent, and its version edge;
  - `analysis_is_current` taking alpha again;
  - a stale `outdated` not removed;
  - unknown files stamped;
  - the node using `analysis_is_current`, and its alpha warning off;
  - the two strips;
  - intake stamping off, url change keeping the flag, the startup version
    filter;
  - `brief.outdated` off, the CLI brief line off, the CLI double line;
  - the bundle summary's line;
  - the Vision node, Jev QC and QC metrics flattening;
  - the evaluation version;
  - the four GM lines.
- Frontend, 2 more, killed by `MoodboardStudioOutdated.test.tsx`: removing
  `<AnalysisOutdated>` from the Studio view (review 1's survivor), and
  removing the brief's outdated line.

### Gates, round 2

- Backend, isolated, 137 files: test_colour_alpha, the cinema tests,
  every test_commons_* and test_moodboard_*, error_copy_round3,
  krea_board_strengths, media_consumer_file_access, unprivileged_marker,
  ci_shard, every test that reads MCP-SETUP, SKILL or mcp_server, and every
  test that touches vision_llm, qc_*, commons.evaluation or main.py.
  **4859 passed, 0 failed, 0 errors.**
  - After the three test fixes: test_colour_alpha (56), test_graph_file_links
    (which reads the notes), unprivileged_marker and ci_shard, **268
    passed**.
- Frontend:
  - `tsc -b --noEmit`, `npm run lint` and `check:inline-styles` all rc 0;
  - vitest `--maxWorkers=2`, 106 files: the moodboard-studio tests,
    colourAlphaContract, paletteExtract, Inspector.paletteExtract, and every
    ratchet that reads src or styles from disk. **1658 passed.**
  - `vite build` plus the budget: **444,245 bytes raw** (limit 512,000).
- Shots, at 1440 wide, in scratchpad `alpha/shots2/`, with no duplicate md5,
  each opened:
  - 01: what each reader is sent for the RGBA mark, decoded from the
    request body;
  - 02: the frontend extract before and after, on the same pixels;
  - 03: Cinema Color's RGBA output over a checkerboard, with its alpha.
