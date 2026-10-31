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
  weights. It reads pixels the same way as before (NEAREST resize to 256 on
  the longest edge), so each pixel keeps its own colour and alpha.
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
(not premultiplied) alpha, and NEAREST doesn't blend. `convert("RGBA")`
un-premultiplies the premultiplied modes (RGBa, La). `_image_stats`
resizes with BILINEAR, which Pillow premultiplies internally for RGBA, so its
colours stay straight too. A file that stores darkened edge colours under
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
  it takes no part of the board's weight. Its line, "#N is fully transparent,
  so it adds no colors.", goes in the summary (Studio, CLI, MCP) and in
  `warnings`. A board where every image is clear says "no local palette
  extracted" as before, plus that line.
- Cinema Color with a clear Palette Source: "The image in “Palette Source” is
  fully transparent, so it has no colors to match. Choose another image, or
  add hex swatches to “Palette”." Before, this was either a black palette or
  the generic "needs a target palette".
- borrow fidelity on a clear output: `unverifiable`, "output is fully
  transparent, so it has no palette". Before, `min()` over an empty palette
  raised.

## Stale analyses

- `ANALYSIS_VERSION` 5 → 6 (`ALPHA_VERSION`). `source_hash` doesn't change,
  so `brief_basis` and the overrides don't move.
- `predates_alpha(board, analysis)`: an analysis older than version 6, on a
  board where any image file (set-aside ones included, since they are
  measured too) has a pixel less than opaque. It is cached by
  (path, mtime, size).
- `analysis_is_current` returns False in that case. The Moodboard node then
  analyzes the board again, and says why: "The board's saved analysis was
  made before Nebula left transparent pixels out of the colors, so this run
  analyzed it again." The dry run reports `saved.current: false` with
  `saved.outdated`.
- `with_alpha_outdated` runs on every store read (beside
  `with_steering_count`). It adds `analysis.outdated` with one line, so
  Moodboard Studio (`AnalysisOutdated`), `nebula moodboard show` and MCP
  `moodboard_get`/`moodboard_list` all say it's out of date.
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
  re-measures a stored asset, and the reader's roles point at palette indices,
  so re-measuring means a new read (see the questions below).

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
| `handlers/cinema_color` transfer, `cinema/color.transfer_to_palette`, `_to_rgb_array` | composites output | left: the output is RGB, as before |
| `cinema/look.py`, `handlers/cinema_look.py`, `handlers/cinema_scene.py` | composite output | left |
| `commons/worker` (`encode_png(load_image)` for the reader) | image for the vision model | left, flagged: the model sees a clear reference over its hidden colour |
| `services/moodboard_reader.encode_image` (JPEG for the vision reader) | image for the vision model | left, flagged: same |
| `commons/review.py`, `commons/evaluation.py` (snapshot PNG + palette) | the labelled evaluation batch | left: the batch's PNG, palette and labels must match each other, and the stored batches are frozen |
| `commons/measure.phash` | perceptual hash, not colour | left (intake passes RGB) |
| `services/output_preview.py`, `output_thumbnail.py` | previews | left: alpha already kept |
| `services/image_transcode.py` | JPEG output, flattened onto white | left: output |
| `services/edit_masks.py`, `scripts/smoke_ideogram_live.py` | masks | left: not colour |
| `handlers/jev_box.py`, `handlers/veo.py` | output encoding | left: alpha already kept |
| `scripts/generate_preset_thumbnails.py` | thumbnails | left: output |
| `frontend/src/lib/paletteExtract.ts` (Inspector "Extract from reference") | measures | left: already alpha-aware. Canvas `getImageData` is un-premultiplied, pixels under alpha 128 are dropped, the rest count fully, and fully transparent says so. Its threshold and weighting differ from the backend's (see questions). |
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
