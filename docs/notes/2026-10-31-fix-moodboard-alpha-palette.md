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
| `services/qc_common.open_rgb`, `create_annotated_frame` | frames for QC | left: video frames, no alpha. Round 3 (review 2 M1): `open_rgb` is for frames only; QC Camera Geometry's reference opens with `open_seen` (alpha kept, EXIF-turned, onto #0a0a0a), so its metrics and the Jev extra see the node's surface, not the hidden colour |
| `commons/review.py`, `commons/evaluation.py` (snapshot PNG + palette) | the labelled evaluation batch | left: the batch's PNG, palette and labels must match each other, and the stored batches are frozen. Round 2 (F8): the manifest records `measure-1`, which is what measures an RGB snapshot, not `CODE_VERSION` |
| `commons/measure.phash` | perceptual hash, not colour | left (intake passes RGB) |
| `services/output_preview.image_preview`, `output_thumbnail.py` | previews | left: alpha already kept |
| `services/output_preview.contact_sheet` (the agent's preview of image arrays and frames) | image an agent looks at | fixed in round 3 (review 2 L4): each tile onto the node surface #0a0a0a with `seen_on`; opaque tiles unchanged |
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

## Round 3 (base 7886a137)

### GM r3: Extract from reference shows each colour once

GM: "the After row is five identical #1e5adc swatches and one orange. The
image has two colors, so it should show two swatches." There were three
causes, in `frontend/src/lib/paletteExtract.ts`:

1. **Seeds of one colour.** k-means seeded at evenly spaced pixels, and on
   a striped or banded image several seeds landed on the same colour. A
   six-colour striped image gave one swatch of a mix plus five copies of
   red. Now a seed with exactly the colour of a seed already taken moves to
   the next pixel with a new colour. Seeds that already differ are the
   same as before.
2. **Near-identical swatches.** `mergeNearColors` merges the closest pair
   under `MERGE_DELTA_E` (OKLab distance 0.03), weight-averaging the colour
   (the weights add up), and repeats. Empty clusters are dropped. The
   result is ordered by weight.
3. **Edge mixes.** A swatch under 5% of the image that lies on the line
   between two bigger swatches is their antialiased edge, not a colour of
   its own. The glow's purple ring at 1.4% is one. It folds into the nearer
   of the two. The line is drawn in sRGB values, where the canvas mixes
   them; the distance from it is read in OKLab. A small swatch that isn't
   such a mix (a real accent) stays.

**How the thresholds were picked.** I ran 27 real images: the 12 preset
thumbnails, the 10 golden board images and 5 character-smoke JPEGs. Each
was read at the Inspector's 96 px, alongside the synthetic cases.
- k-means's copies of one flat colour sit 0.0017 to 0.0075 apart. Those are
  the risograph print, the studio product, the line art, and the logo's
  dark edge shades.
- The closest pair of real, different swatches k-means keeps on a photo is
  0.025 to 0.05 apart. Paper-studio's two paper whites are 0.025 apart; the
  rest are above 0.03.
- 0.03 is about one and a half just-noticeable steps in OKLab. It merges
  every copy and, of the real images, only those two paper whites.
- Folding at a 2%, 5% or 8% share changed no real image. 5% catches a 1 px
  ring around a shape at 96 px.

**What changed on those images.**
- The line art goes from 6 swatches to 2, the risograph print from 6 to 4,
  the studio product from 6 to 4, and paper-studio from 6 to 5.
- Two preset thumbnails had seeds of one colour, so their hexes move by one
  level (#0d0d0d to #0e0e0e) while the count stays the same.
- Every other real image gives exactly what it gave before.

**Tests** are in `frontend/tests/paletteMerge.test.ts`. Each image-level
test fails on 7886a137's extract (checked against a copy of that file).
- A two-colour logo with soft edges gives exactly 2, charcoal first.
- The glow gives 2: #1e5adc, then #e8593c.
- Six colours give 6, in stripes and in bands.
- A grey gradient gives 6, with no near pair, and a colour gradient gives at
  least 3.
- A 2% green accent stays.
- An opaque image with no near-identical swatches gives exactly 7886a137's
  colours.
- `mergeNearColors` adds the weights, averages the colour by weight, orders
  by the merged weight, and splits at the threshold (written as a literal).
- An edge mix folds at 4% and stays at 6%.

**Mutants:** 11 frontend, all killed:
- the threshold;
- no merge;
- weights not added;
- no sort (killed once the merged-order test was added);
- empty clusters kept;
- seeds of one colour kept;
- no fold;
- the fold share;
- the fold's between-the-ends check;
- folding into the wrong end;
- the merge average weighting.

### Backend palettes: measured, not changed

Same images, through the code the backend runs:
- the moodboard analysis (palette plus accents);
- Commons `measure_image`;
- Cinema Color's `extract_palette`.

For each, the minimum CIEDE2000 and OKLab distance between swatches, and
the count of pairs under the frontend's 0.03:

| image | moodboard | Commons | Cinema `extract_palette` (k=6) |
|---|---|---|---|
| mark, 74% clear | 2, min ΔE00 49.6 | same | 6: five identical #111413 and #e8593c |
| sprite, 49% clear | 1 | 1 | 6 identical #3caa5a |
| soft-edged disc | 1 | 1 | 6 identical #e8593c |
| minimal-line-art | 5, min ΔE00 12.0 | same | 6, three pairs under 0.03 (#f1f1f1, #f6f6f6, #f9f9f9) |
| risograph-print | 8, min ΔE00 11.5 | same | 6, none |
| studio-product | 7, min ΔE00 6.7 | same | 6, none |
| cinematic-noir | 7, min ΔE00 7.7 | same | 6, none |
| golden-hour-portrait | 8, min ΔE00 8.9 | same | 6, none |

- **The moodboard and Commons have no near-duplicates.** They already
  merge swatches under ΔE00 5 (`commons/measure._merge`), so the closest
  pair is ΔE00 6.7.
- **Cinema Color's `extract_palette` repeats colours** (k=6, no merge). The
  repeats are never shown: the swatches are only the transfer target. In
  the transfer each swatch counts once, so a repeated colour counts as its
  coverage (the mark's target is five parts charcoal to one orange).
  Merging them would change every graded output from such a source,
  unless the transfer learned to weigh each swatch by its coverage, which
  is a bigger change for no visible gain. So my
  recommendation is to leave all three as they are, and that is what I
  did. If the swatches are ever shown, merge them with weights then.

### Review 2, fixed (round 3, section 2)

- **M1, QC Camera Geometry's reference.** `open_rgb` dropped alpha before
  `seen_on` saw it. The reference now opens with `qc_common.open_seen`. A
  handler test checks the measured reference and the Jev extra, and the
  `open_rgb` mutant fails it. Out of scope, on purpose: an opaque reference
  with an EXIF turn is now turned, as `vision_llm` already does.
- **M2, the reader's decode.**
  - A stored `hasTransparency: False` or `hasClearPixels: False` means not
    clear, with no decode.
  - `Target.clear` holds the answer, so the estimate and the read work it
    out once.
  - Both routes run `_reader_plan` in `asyncio.to_thread`, and `run()`
    covers any target left over off the loop too.
- **The outdated line is only true where it is (surfaces M1, L2).**
  - A new additive `hasClearPixels` fact: any alpha under 16. It is stored
    next to `hasTransparency`, from the same single decode, and cached by
    path, mtime and size; a failure isn't cached.
  - `predates_alpha` counts only images the saved analysis measured
    (matched by id and url), and only when one has clear pixels. An
    analysis with no image list counts every image.
  - Images that are only semi-transparent get no line (GM r5 4).
  - The startup pass stamps whichever fact is missing. An image already
    stored as opaque gets `hasClearPixels: False` with no decode.
  - The CLI dry run prints both lines when both hold.
- **L1:** `_keep_brief_override` reads with `_read_for_write`. It's in the
  never-written-to-disk test.
- **L2, decodes off the loop and outside the lock.**
  - `create`, `update_with_before` and `apply_edits` decode a write's new
    files (`_warm_new_files`) before they take the board lock. Under the
    lock, the stamp is only a stat.
  - The three routes call the store in `asyncio.to_thread`.
  - The startup pass reads each pre-v6 board, decodes outside the lock,
    then re-reads and stamps under it.
  - Tests check that no real decode happens on the loop or under any board
    lock, and that the startup write holds the lock.
- **L3:** each of the seven survivors now has a test that fails when it is
  mutated: `seen_on` clear, the Cinema weights at `ALPHA_MIN`, the
  weighted std, the all-clear guard, `_file_is_clear` on an unreadable
  file, the startup lock, and the frontend's weighted `finalCounts`.
- **L4:** `contact_sheet` (see the audit table above).
- **L5:** a too-transparent Commons asset gets its own kind, `transparent`.
  The worker writes it, and `classify_text` maps an older row's
  `last_error` to it. Commons shows GM's line in the muted colour, with no
  error heading and no Retry (retrying can't change it). That Retry choice
  is mine; ask GM if it should stay. The grid badge still says "failed",
  out of scope.
- **Surfaces L3:** the Moodboard node puts its "analyzed it again" warning
  first, and the preview shows every warning.
- **N1:** MCP-SETUP documents both facts (on the HTTP board only, not in
  MCP image views). `_area_pixels` now sums in uint64. That one has no test:
  an overflow needs an image over about 65,800 px wide.

### GM r5 (round 3, section 3), built verbatim

1. Commons: "This image is too transparent to analyze." (neutral, muted).
2. Extract from reference: "This image is too transparent to pull colors
   from." for clear and faint images alike. A faint image now gives
   `transparent`, not `other`.
3. The brief line:
   - "This brief uses the old colors. The next run sends it with the
     updated ones." on a hand-written brief.
   - None at strength 0. It comes back above 0, because it's worked out on
     every read.
   - It sits right after the brief's text and before its controls, in
     Studio, `moodboard show` and MCP.
4. No line for semi-transparent-only boards (above).
5. The CLI estimate says "#N wasn’t read because it’s too transparent.",
   one line per image. The reader trace says "#N is unsorted because it’s
   too transparent." and the `why` is "It’s too transparent to add colors."

### Mutants, round 3 section 2

- 32 backend (B2–B33) and 7 frontend (F1–F7), all killed.
- B21 (the rerun warning appended last) and B33 (only `hasTransparency`
  popped on a new url) survived at first. Their tests now use a board with
  a per-image warning, and a replacement file that can't be read.
- The new backend tests were also run against 7886a137's code: 19 fail
  there. The L3 guard tests pass there, as they should, since they pin
  guards that already held.


## Round 4 (base b972eb9d)

### Review 3 M1: Extract measures colour with CIEDE2000

Plain OKLab has no lightness toe, so it overstated differences near black:
#000000 and #010101 were 0.067 apart, twice the 0.03 threshold, and an
orange disc on a JPEG-like black (values 0-7) gave four swatches, three of
them black.

- **The metric.** `paletteExtract.ts` now ports the backend's CIEDE2000
  (`commons/colour.delta_e00` on `cinema.color.rgb_to_lab`), the moodboard
  palette's own distance. `contracts/fixtures/colour/delta_e00.json` holds
  27 sRGB pairs (with their Lab) and 15 Sharma Lab pairs, written by
  `scripts/generate-colour-delta-e00-fixture.py`.
  `backend/tests/test_colour_delta_e00_contract.py` checks the backend
  against it, including that the generator writes exactly that file;
  `frontend/tests/colourDeltaE00Contract.test.ts` checks the port to 1e-5.
  Neither side can drift.
- **The threshold.** The brief said to retune only if GM's r3 and r4 shots
  changed. At the backend's 5 they did. studio-product.webp went from the
  four swatches GM signed off to two, because its three whites are
  ΔE00 2.5 to 5.5 apart. Eleven more of the 22 preset and golden images
  lost one to three tones (peach-skin 6 to 4, paper-studio 5 to 3, neon-alley
  6 to 4). So Extract merges under ΔE00 2 (`MERGE_DELTA_E`). That's about
  two noticeable steps. On the same 27 images:
  - The only count changes are near-blacks. cinematic-noir goes 6 to 4 (its
    #020202, #070707 and #0e0e0e are one black), editorial-flash 6 to 5,
    the noisy-black disc 4 to 2, and the grey ramp test 6 to 5 (#000000 and
    #070707).
  - risograph-print's lightest swatch moves one level (#eff9fe to #f0f9ff),
    because its two near-whites now average differently.
  - Every other image, studio-product included, gives exactly what it gave
    on b972eb9d.
  - The 1-to-2 window is safe on both sides: noisy-black centroids sit 0.2
    to 1.2 apart, and the closest pair GM signed off is 2.52.
- **A limit, for GM:** blacks with independent per-channel noise (each of
  R, G, B 0-7 on its own) give centroids about ΔE00 2.05 apart. CIEDE2000
  doesn't shrink chroma near black, so at 2 those stay two or three black
  swatches. At 3 they merge in 40 of 40 random images, but studio-product's
  two lightest whites (2.52) merge too (4 to 3). The tests use grey noise,
  as review 3's repro did. Real dark photos (noir, editorial-flash) merge
  at 2. Raising it is one constant.
- **Specks.** At 2, mark74 grew a third swatch: 0.007% of the image, a few
  faint pixels k-means gave their own cluster, ΔE00 2.4 from the teal. OKLab
  0.03 had merged it. A swatch under 0.1% of the image (`SPECK_SHARE`, the
  backend's `ACCENT_MIN_SHARE`: the moodboard shows no colour that small)
  now joins the nearest bigger swatch within ΔE00 5. A far speck (a real
  one-pixel accent) stays.
- **The edge line** uses ΔE00 5 (`EDGE_LINE_DELTA_E`, held equal to the
  backend's `MERGE_DELTA_E` by the fixture) for how near a swatch must be
  to the line between two bigger ones.

### GM r6 item 1: the edge fold goes by evidence

- `paletteFromPixels` now takes the image width and keeps each pixel's
  k-means cluster. A swatch under 5% that lies on the line between two
  bigger ones folds only when at least 70% of its pixels
  (`EDGE_EVIDENCE_SHARE`) have a pixel of each within 2 px
  (`EDGE_REACH`, a 5x5 window).
- Merged and folded swatches carry their clusters (`members`), so evidence
  for the next fold counts them.
- Two pixels, so a two-pixel ramp (two mixes, each beside one end) still
  counts as edge. A band three or more pixels wide has an interior row.
- `mergeNearColors` without evidence (a bare colour list) folds nothing.
- Pixels count once, whatever their alpha.
- The cost is one pass over the 96 px labels per candidate line, only for
  swatches under 5%. It's not heavy, so the under-2% fallback wasn't
  needed.
- On the 27 images, only the black-and-white logo with a grey caption
  changes (2 to 3, the grey kept). Glow, logo, stripes, bands and
  studio-product are unchanged.

### Review 3, LOW and NIT (section 2)

- **FC L1: stored facts carry the file's stat.**
  - Each board image stores `alphaFileStat` (`[mtime_ns, size]` of the file
    the facts were read from) beside `hasTransparency` and
    `hasClearPixels`.
  - Every use trusts the facts only while the current stat matches. That
    covers the reader's clear check and `predates_alpha` (so the
    out-of-date line, the dry run and the node). It costs one stat per
    image and no decode.
  - A file replaced in place is read again, decoded once per file version
    through the existing cache.
  - A client can't send the stamp. `_normalize_images` builds the entry from
    the stored one, and `MoodboardImageModel` accepts `alphaFileStat` only
    so an echoed board doesn't get a 422.
  - Facts stored without a stamp exist only in the round 1-3 dev builds;
    main never had them. They count as untrusted: they're read again on
    use, and the startup pass now also runs on any board that holds them,
    stamping them once. The old "stored opaque, so no clear pixels, no
    decode" shortcut is gone, because it trusted an unstamped fact.
  - Tradeoff: a list or get can now decode, but only for an image whose
    stored facts no longer match its file, under a pre-v6 analysis.
    Missing facts still never decode or mark a board out of date. A file
    that's gone keeps its stored facts.
- **FC L2:** `skills/nebula/SKILL.md` lists `transparent` as the fourth
  Commons error kind.
- **FC L3:** R4 (id and url), R5 and R6 (the cache key's mtime and size),
  R12 (changed plus pre-alpha gets "board changed"), R21 (a truncated PNG
  at intake is unknown, not a 500), R1 (`open_seen` turns EXIF) and R18
  (`contact_sheet` turns EXIF) each have a test, and each is killed by its
  mutant. Tests are in `test_moodboard_alpha_facts.py`,
  `test_qc_infrastructure.py` and `test_output_preview.py`.
- **FC N1, kept:** QC Camera Geometry turns an EXIF-rotated opaque reference
  upright (`open_seen`), as the node shows it. That changes
  `reference_match_score` for such references, so "opaque unchanged" in
  the PR body doesn't cover QC. A handler test pins it.
- **FC N3:** `_file_alpha_facts` reads both facts from one `getextrema`. An
  opaque file still isn't converted.

### GM r6 items 2-4

- **The "Not analyzed" badge.**
  - A too-transparent Commons asset wears the neutral muted badge
    (`commons-badge--not-analyzed`, the archived rule, `--sr-ink-faint`)
    with "Not analyzed", on the grid and in the detail. It shows uppercase,
    like every badge.
  - Search rows now carry `last_error_kind`, so the grid can tell.
  - The detail's line is unchanged.
- **No Re-analyze.**
  - The detail hides Re-analyze for that asset.
  - The person's route (`POST /assets/{id}/reanalyze`, `records.reanalyze`)
    answers the transparent state (`queued: false`, the kind, `last_error`,
    the line) instead of requeuing. The check and the requeue are one
    transaction. Every other failure still requeues.
  - "It comes back if the file changes" holds by design. Assets are stored
    by sha256 and nothing rewrites one, so a changed file is a new asset
    with its own state.
  - Agents have no re-analyze: the route is person-only (403), and there's
    no MCP tool or CLI command for it. So there was no agent surface to
    change, and opening one is a separate decision.
- **The brief holds its place.**
  - `useHoldBottom` watches `.moodboard-analysis__outdated`. When a commit
    removes those lines and the shorter content would clamp the scroll
    position, a bottom spacer (`.moodboard-hold-spacer`, sized by
    `--moodboard-hold-h`) takes the missing height before paint. It's
    measured from the real layout, so flex gaps count.
  - It collapses on a scroll that leaves the held position, or on the
    panel's next DOM change.
  - It's in both scroll panels (the list column and the board side panel).
  - If a forced layout already clamped the scroll position, it's put back
    to the same value before paint. That's the only scroll write.
  - Live at 1440 on Mark and Mixed, scrolled to the bottom: the brief moved
    0 px, the spacer held 37.6 px, and the next wheel scroll collapsed it
    with no jump.

### Mutants, round 4

- **Frontend, 21:**
  - The thresholds (merge at 5 and at 1, the edge line at 2).
  - Each CIEDE2000 term (SL, G, the hue wrap, RT), CIE76 in its place,
    and Lab without its toe.
  - The evidence (share 0 and 0.9, reach 1 and 4, either side instead of
    both).
  - The speck share and the speck fold.
  - The width ignored, in `paletteFromPixels` and in
    `extractPaletteFromImage`.
  - Members not carried through a merge and through a fold.
  - All killed but one: dropping `hbp = hsum` for a zero-chroma pair. It's
    equivalent, because with zero chroma `dhp` is 0, so every term that
    reads `hbp` is multiplied by `dHp = 0`.
  - Four survived the first run (reach 4, either side, the width, members).
    They're now killed by four new tests: a 3 px line between black and
    white is kept, a 1 px horizontal seam folds (also through
    `extractPaletteFromImage` with a mocked canvas), and evidence is asked
    about every cluster a merged or folded swatch holds.
- **Backend, 16:** 14 killed. One is equivalent: adding the fact keys to
  `IMAGE_KEYS` changes nothing, because `_normalize_images` builds entries
  from a fixed list, and the mutant that merges raw client keys is killed.
- **Commons and the spacer, 10:** all killed.
- **On b972eb9d:**
  - Fail there: the new behaviour tests. That's 12 in `paletteMerge` (the grey
    ramp now giving 5, noisy black, the mid-tone threshold pair, cinematic-noir, the caption, the
    purple band, the 3 px line, the seam with a caption, the merge
    threshold, the speck, the evidence fold and evidence members), the
    contract's threshold test, 5 of the backend facts tests, and every
    Commons and spacer test.
  - Pass there by design, as guards: noisy white stays 2, studio-product
    stays GM's 4, a 1 px seam folds, and the GM r3 glow, logo and stripes.

### Gates, round 4

- Round 3's CI on b972eb9d: green, all eight jobs.
- tsc, lint, check:inline-styles and check:slava-css-scope: rc 0.
- Vitest `--maxWorkers=2` on 118 files (the changed tests and every test
  that reads `src/` or `styles/`): 1936 passed, 0 errors.
- Pytest, isolated, on 30 files (colour, moodboard, QC, output preview and
  Commons): 787 passed.
- `npm run build` and the budget: 444,224 bytes raw.
- Live (isolated backend on 8792, Vite on 5792, canaries only off-lane):
  - Extract: noisy-black disc 4 to 2; bwgrey 2 to 3, with the caption kept;
    studio-product 4 and 4, identical hexes.
  - The hold, as above.

## Round 5 (base b2de5877): Extract merges under ΔE00 3

GM ruled on round 4's open question: "Move to 3. Duplicate blacks look
broken, and noisy blacks are common in photos and renders. Studio-product
going from three near-whites to two is a subtle loss by comparison." It's
one threshold, with nothing special for near-black. `MERGE_DELTA_E` is now
3. Nothing else changed.

**Which near-whites merged.** studio-product.webp at 96 px gave #ededee,
#f9f9f9, #e1e0dd and #b49d71 in round 4. #ededee and #f9f9f9 are ΔE00 2.52
apart, so they now merge into #f2f2f3. #e1e0dd stays: it is 4.41 from the
merged white, and the pairs were 3.53 and 5.53 before. Live in the
Inspector the browser's resample gives #eeeeee and #f9f9f9 merging into
#f2f2f3, with #e2e0de and #b29b6d kept.

**The 27 real images.** studio-product is the only one that changes (4 to
3). The other 21 preset and golden images, and the five probes (noisyblack,
bwgrey, mark74, softlogo, sprite49), give exactly round 4's swatches.
paper-studio's closest pair is 3.12, so it stays at 5. For comparison, at
3.5 paper-studio drops to 3, and cyberpunk-neon, neon-alley and
rust-portrait each lose one.

**Blacks noisy on each channel apart.** This means R, G and B each 0-7 on
their own, under an orange disc.
- At 2, none of these gave two swatches.
- At 3, most do, but not all. Round 4's count of 40 of 40 was a lucky
  sample.
- With a larger sample, 196 of 200 merge with `Math.random` noise, and 37
  of 40 numpy seeds (0-39) do. The test's 40 xoshiro seeds give 39 of 40.
  So about 2 to 8% of such images keep two blacks.
- The two blacks left are about ΔE00 3.5 apart: #030403 and #050106 on
  seed 167299; #040304 and #020602 on numpy seed 7.
- 3.5 merges all 200, but costs paper-studio and three photos (above).
- Grey-noise blacks (review 3's repro) always merge.

**Mid-tones.** Round 4's 1.96, 2.14 and 2.35 pairs now each merge into
one. The threshold test pairs are now 2.73 and 2.93 (merge) against 3.12
and 3.31 (stay apart).

**The speck rule** is unchanged. Its test speck moved from ΔE00 2.4 to 4.0
from the teal, so it still tests the fold between the merge threshold and
5 rather than an ordinary merge. mark74's 0.007% speck (2.4) now merges
directly.

**Tests:**
- The threshold is 3, with the pairs above.
- studio-product gives #f2f2f3, #e1e0dd and #b49d71.
- Blacks noisy on each channel merge in exactly 39 of the 40 seeds. The
  remaining seed is named, and its two blacks are pinned as more than 3
  apart.
- The contract test expects 3.

**Mutants:** 26 frontend. Killed: the threshold at 2, 2.9, 3.2, 4 and 5,
plus round 4's 21 again. Survivors:
- `hbp` at zero chroma, equivalent as in round 4.
- The merge's `<` written as `<=`. It differs only for a pair exactly
  3.000 apart, or in which of two equal-distance pairs merges first.

**Gates, round 5:**
- tsc, lint, check:inline-styles (256 files) and check:slava-css-scope:
  rc 0.
- Vitest `--maxWorkers=2` from an explicit zsh array of 119 files. That's
  round 4's list, plus `studioGridAreas.test.ts`, which reads `src/` and
  came in with main. 1966 passed, 0 errors.
- The backend isn't touched, so there was no pytest.
- **Live (isolated backend on 8792, Vite on 5792):**
  - studio-product went from 4 to 3, as above.
  - A per-channel noisy black went from 3 to 2 on numpy seed 0, and from 4
    to 3 on seed 7.
  - The shots were retaken after the session move (same values) and
    opened, with no md5 duplicates.
