# fix/presence-followups-2 (follow-up 2 to PR #200)

Base: main at a8798dc4 (the #200 merge). Scope: review 20's NITs 1, 3, 4, 5
and 6, its untested colour branch, review 19's NIT-5 and NIT-6 (the pin-edge
ratchet), and GM's rulings on NIT-6 and GM-Q1 (`gm-pr200-fu1`).

## What changed

### NIT-6 (GM): the swap on promote moves nothing (asset-proposals.css)

- `.asset-proposal--held` now has `padding-left: 14px`. Its content starts
  1px edge + 14px = 15px in, the same as the real card's 3px edge + 12px.
- Vertical: both cards already had a 1px top edge and 10px top padding
  (`padding: 10px 10px 10px 12px` on `.asset-proposal`; the placeholder sets
  only its left side). The right side is the same too, so the `who` row is
  the same width and wraps the same way. Nothing else needed changing.
- Live, at 1440 and 1280, in one scene with no scroll between: the card's
  top-left and width, the dot, the name and the header have the same
  `getBoundingClientRect` before and after the promote.

### GM-Q1: the Update says which cover kind (backend + heldAssetProposals)

- `asset_proposals.update_detail(proposal)`: for a cover, `{"cover":
  "automatic" | "image"}`; for a Commons ask, `{"changes": N}`; for a board,
  nothing. Never the image, the asset or a field value.
- `_post_asset_update` passes it in the Update's structured ref
  (`note["proposal"]`), next to `id`, `kind` and `targetId`.
  `agent_notes.post_proposal` keeps only a checked `cover` (one of the two
  words) and `changes` (a whole number from 0 to 999); anything else is
  dropped (`proposal_detail`).
- When one of an agent's two proposals on a target closes and the Update
  retargets the other, or an undo reopens one, the ref carries that
  proposal's detail (`retarget_proposal` / `reopen_proposal` take `detail`;
  `_retargeted_ref` drops the closed one's).
- The frontend's `sanitizeNote` reads `proposal.cover` and
  `proposal.changes` only, on `about: "proposal"` Updates. The placeholder
  says "proposes the automatic cover" when the ref says `automatic`, and
  "proposes a new cover" otherwise (an `image` ref, or a ref without it).
- **Stop condition checked:** this touches neither the person gate,
  `require_person`, the person-only broadcast (`broadcast_browser`) nor the
  release path. The Update was already broadcast to every tab, and it now
  has one more exact word.

### Review 20 NIT-3: the Commons count from the ref (heldAssetProposals)

- The regex on the Update's text is gone. The count is `proposal.changes`,
  and the header uses the real card's rule (`count === 1`: "a change"; else
  "N changes"). An agent named "Mallory asks to make 9 changes" can't
  change it.
- Old Updates without the field can't be open: proposals are memory-only,
  so a restart resolves every open one ("Closed: Nebula restarted"). A
  missing count reads as 1.

### Review 20 NIT-4: focus follows the swap (AssetProposalStrip)

- `HeldCard` records, in a layout-effect cleanup (it runs before React
  removes the node), whether it still held focus as it left. The strip's
  layout effect then focuses the real card with that id
  (`data-proposal-id`), in the same commit.
- Only when focus would otherwise be on the page: if something else took
  focus in the same commit, it stays there. A placeholder without focus
  gives none.

### Review 20 NIT-5: never a run of "…" (noteHeading.ts)

- In the branch for a cut that keeps nothing visible, the name's own "…"
  runs fold into one, and a kept part that already ends on "…" takes no
  second. A name made only of "…" now shows one: “…”.
- Decision: that single "…" is the name's own character, not the cut
  mark. "Never a bare …" (GM r33) and "never a run of …" (review 20) can't
  both hold for a name with nothing else in it; this shows one, and the
  tooltip has the whole name. r34's old `['…………', 2, '………']` row pinned
  the old output, so it moved to the new test file with the new expectation.

### Review 20 NIT-1 (canvasProposalsStore.ts)

A comment: a duplicated tab copies sessionStorage, so both tabs release the
same held approval on their promotes, and the second gets `not_found`,
which is harmless.

### Review 20's untested branch

`AssetProposalStrip.fu2.test.tsx` feeds `author.color` values `red`,
`#fff`, `url(x)`, `#5b9dffzz` and `''`, and expects `#5B9DFF` from the
store helper and on the rendered placeholder. Both surviving mutations of
review 20 (`held_color_unvalidated`, `fallback_differs`) are now killed.

### Review 19 NIT-5 and NIT-6: the pin-edge ratchet (tests/helpers/destructiveRule.ts)

- **Root font size (NIT-6).** `rootFontPx(extraCss)` reads `:root` / `html`
  `font-size` and the `font` shorthand in every state (the largest
  counts; one it can't read, such as `var()`, makes every rem unknown, so
  a finding). `narrowLeftEdge`, `resolveFontPx` and `inheritedFontPx` use it
  for rem instead of a fixed 16.
- **Paint past the glyph (NIT-5).** The narrow-glyph exemption no longer
  applies when `text-shadow` or `-webkit-text-stroke(-width)` paints past
  the glyph: on the pseudo-element, on the edge in any state, or on any
  ancestor in any state (`inheritedGlyphPaint`; both inherit). `none` and a
  0 stroke width are fine.
- **Wide graphemes (NIT-5).** The exemption now trusts one printable ASCII
  character only (U+0021–U+007E). jsdom has no layout, so the width of
  ﷽ (U+FDFD), 𒐫 (U+1242B), a fullwidth letter or an enclosing mark can't be
  measured; those now fail closed rather than being guessed at. This also
  turns review 19's "a combining stack passes" into a finding, which is
  stricter, not looser.
- **Font face.** A `font-family` (or a `font` shorthand's family) on the
  pseudo-element or the edge must be a plain generic one (serif,
  sans-serif, monospace, system-ui). A named face could map even ASCII to a
  wide glyph.
- **What it can't check, and doesn't pretend to:** a custom face set on an
  ancestor that maps an ASCII character to a glyph wider than 1em. That
  needs real glyph metrics. The app's own UI fonts are known and narrow,
  and the app has no pseudo-element text on the edge at all.
- Corpus: 25 new failing probes and 8 new passing ones. On a8798dc4 all 25
  failing probes passed (were missed), and 2 of the passing ones
  (`:root { font-size: 12px } … width: 0.3rem`, `html { font-size: 50% } …
  width: 0.5rem`) were false findings there.

## MCP and CLI

- The Update's ref has two more optional keys. `list_notes` (MCP) and
  `GET /api/canvas/agent-notes` return them as they are; agents see the
  kind of their own proposal and its edit count, which they sent.
- The CLI (`cli/commands/notes.py`) reads `about`, `text` and `outcome`,
  not the ref, so it is unchanged. No MCP tool reads the ref.
- docs/MCP-SETUP.md ("The Update" under proposals outside the canvas) now
  documents `cover` and `changes`.

## Surprises

- The project card's real card is taller (thumbnails and buttons), and at
  1440×900 the Projects grid recentres when it grows. Measured across a
  resize, that looked like an 89px move. Measured in one viewport with no
  scroll between, nothing in or at the card's top moves.
- In the Commons, the promote also brings the Commons proposals line
  ("Codex asks to make 3 changes to a reference · Review") above the
  detail, because it reads the person-only proposal list. So the whole
  detail moves down 35px at the promote. Inside the card nothing moves
  (each part keeps its offset from the card). This is outside this PR's
  scope; a held version of that line would need GM's wording.
- The reject route needs the accept key, so the live script withdraws as
  the agent instead.

## Tests that fail on a8798dc4

- Backend: 8 of the 9 new or changed tests fail (the moodboard "no detail"
  one passes, as it should: boards carry no detail before or after).
- Frontend: `AssetProposalStrip.fu2.test.tsx` 10 of 21 fail there (NIT-6
  geometry, Q1, sanitizeNote, NIT-3, NIT-4); the colour fallback cases and
  the cases that pin unchanged behaviour pass. Two NIT-4 controls fail there
  only because `data-proposal-id` doesn't exist yet.
- `presenceFollowups2.noteHeading.test.ts`: 6 of 7 fail.
- Ratchet: the GM r18 corpus test fails (its first new probe).

## Mutations

- Frontend: 16 of 16 killed (padding back to 10px, top padding differing,
  kind ignored, missing ref read as automatic, regex back, colour unchecked,
  fallback changed, sanitize: any cover, ref dropped, fractions allowed;
  focus: no handoff, steals focus, unfocused placeholder hands it over,
  passive cleanup; ellipsis: no fold, always append). One extra mutation I
  wrote was equivalent (it still fell back to `ref.changes`) and is not
  counted.
- Backend: 7 of 7 killed (cover always image, count fixed, any cover word,
  post drops detail, retarget without detail, reopen without detail,
  retarget keeps the stale detail).
- Ratchet: 10 of 10 killed (root always 16, rem fixed in `resolveFontPx`,
  rem fixed in `length`, unknown root read as 16, text-shadow ignored,
  stroke ignored, ancestors ignored, the old grapheme rule, font-family
  ignored, a 0 stroke counted as paint).

## Gates (`lg run --gate`)

- `tsc -b`: clean. `npm run lint`: clean.
- Vitest, the full run: 598 files, 7,553 tests, all passed.
- Backend, the full suite (isolated: temp HOME, NEBULA_SETTINGS_PATH,
  NEBULA_STATE_DIR, NEBULA_OUTPUT_ROOT): 11,882 passed.
- Build budget: 421,139 bytes raw (129,418 gzip); 101 JS assets eval-free;
  fonts OK. dist removed after.
- Live (8795/5795, 8000-8010 and 5173 blocked, nothing run): 14 of 14.
