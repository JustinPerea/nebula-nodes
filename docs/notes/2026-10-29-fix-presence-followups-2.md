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

# PR #202 r1 (GM)

GM signed off the visuals with one change and one check
(`gm-pr202-r1.md`). Built on d8c366ce; nothing else pulled in.

## 1. A name made only of "…"

No code change. `noteHeadingName` already keeps the single "…" (the name
is "…") and never adds a cut "…" after it, at any width; a node labelled
"…" is titled "…", with no type-name fallback. Pinned in
`tests/presenceFollowups2.noteHeading.test.ts` (the "GM PR #202 r1" block)
and `src/components/canvas/noteHeadingTitle.fu2b.test.ts`. These pass on
d8c366ce, as they should: they pin what is already there.

## 2. The Commons proposals line while the tab is held

- A held tab gets no proposals (they are person-only), only their Updates.
  `heldCommonsLines` (store/heldAssetProposals.ts) makes one entry per open
  `about: 'proposal'` Update whose review op targets `commons`, skipping
  any proposal already in the store, only while `awaitingSync`.
  `CommonsProposalsLine` merges those entries with the known proposals per
  reference, counting one proposal per entry, the same way as before. A line
  known only from Updates has no Review; on promote the person's sync brings
  the same proposals, so the words stay and only Review is added.
  `CommonsView` shows its messages box when there are held lines too.
- The words come from the Update's ref, never its text and never the
  person-only list: `changes: N` gives "make N changes to a reference". An
  ask only to take a reference out of the inbox is worded that way on the
  promoted line, so the ref now carries `inbox: true` for it
  (`asset_proposals.update_detail`; `agent_notes.proposal_detail` keeps it
  only when it is exactly `true`; a retarget drops it with `cover` and
  `changes`; the frontend sanitizer keeps only `true`). The MCP-SETUP ref
  docs list it.
- GM asked for one line per ref where combining can't match. Decision: keep
  merging per reference, because the promoted line merges per reference and
  only the merge keeps the words the same. One case can't match: an agent
  asking twice about the same reference while held shares one Update, so
  the promote raises the count in place on that line. The held tab can't
  see that case. The code comment says so.
- Each agent gets a dot in its colour (`proposalAgentColor`, so 'red' falls
  back to #5B9DFF), on held and promoted lines alike.
- Review stays right-aligned, where it already was (the line's
  space-between layout), rather than an inline " · Review". Promoting
  doesn't move it.
- Not changed: on promote the grid tiles gain "PROPOSAL" badges. They are
  overlays and move nothing.

## Tests on d8c366ce

- `CommonsProposalsLine.held.test.tsx`: all 13 fail (the held line doesn't
  exist).
- `CommonsView.held.test.tsx`: fails (no messages box while held).
- Backend: `test_an_inbox_ask_says_so_in_the_ref_and_nothing_else_does` and
  `test_the_inbox_flag_is_only_ever_true` fail.
- The "…" pins pass (see 1).

## Mutations (GM r1 part): 17 of 17 killed

- Frontend (13):
  - the view's box ignoring held lines;
  - Review always shown;
  - the count read from the text;
  - `inbox` ignored;
  - no `awaitingSync` gate;
  - resolved Updates kept;
  - known proposals counted twice;
  - no dot;
  - the dot in a fixed colour;
  - counting per agent, not per proposal;
  - the sanitizer keeping a truthy `inbox`;
  - the sanitizer dropping `inbox`;
  - a "…" name taking a second "…".
- Backend (4): `inbox` always set, never set, `proposal_detail` taking a
  truthy `inbox`, a retarget keeping `inbox`.
- Two mutations survived the first pass: counting per agent, and the
  frontend `inbox` sanitizing. The tests added for them are "one agent
  asking twice" and "the inbox word reaches the line only from a ref that
  says inbox: true".

## Live (8795/5795, 8000-8010 and 5173 blocked, nothing run): 8 of 8

- The setup:
  - two references;
  - Codex makes a 3-change ask and Claude Code a region ask, both on the
    first reference;
  - Codex makes a role ask on the second reference.
- Held, at 1440 and 1280, two lines with no Review:
  - "Codex and Claude Code ask to change a reference (2 proposals)", with
    dots rgb(122, 211, 255) and rgb(195, 232, 107);
  - "Codex asks to change a reference".
- On promote only Review is added. These keep their boxes exactly
  (getBoundingClientRect):
  - the lines, their text and dots;
  - the messages box (h 68);
  - the detail bar;
  - the card's top-left and width.
  The card grows downward as the placeholder becomes the real card.
- A proposal withdrawn after the promote, and one withdrawn before it, take
  their lines with them.
- The harness waits until the Updates corner's arrival cards (queued, about
  4s each) have been gone for 3s before each shot, so the crops show the
  lines and Review.

# PR #202 review 1 (of d8c366ce), and GM's ruling on its Q1

Same round. Review 1 found 0 HIGH, 0 MEDIUM, 1 LOW and 7 NITs.

## LOW-1: the words follow the ref on a fallback

- When an agent's newer ask on a target closes and its Update falls back to
  the agent's older, still-open ask, `retarget_proposal` now rewrites the
  Update's text from `update_text` of that ask, as well as its ref.
  `reopen_proposal` (an undo reopening a proposal) does the same. The count
  and the words therefore always come from the same proposal.
- Only Commons words vary by ask: cover words don't depend on the kind.
- GM's ruling on Q1: the line changes in place to the older ask's words, with
  no motion, marker or toast.
  - In place: the "changed" op keeps the Update's id, its read state and
    the corner's count.
  - The store's "changed" branch adds no arrival card (it only drops a
    pending one for that id, as it already did). A frontend test pins
    this, and it held live: unread 1 → 1, arrivals 0 → 0.
- **Review open when the ask goes:** the existing close path, with no new
  path.
  - Live, with Review open on the reference: the withdrawn ask's card went
    open → closing → gone.
  - The older card and the detail stayed.
  - The line changed in place to "Codex asks to make 3 changes to a
    reference".
  - Focus was on the body before and after.
  - Shot: `fu2b-review-open-withdrawn-1440.png`.
- **The Agent log: not built, and flagged for GM.** No withdrawal reaches
  the Agent log today, for asset or canvas proposals. Live, the log added
  nothing on the withdraw. There is no existing withdraw wording to reuse:
  - the asset ask's log line is "Asks to {…} (decide {where})";
  - the Update's outcome is "Withdrawn by {agent}";
  - the CLI prints "Withdrew {id}.".

  GM's example ("Codex withdrew its request to change “Name”.") would be new
  copy. GM said no new copy, so this needs GM's wording before it is built.
  The mechanism would be one `_say_agent_action` call in
  `_withdraw_asset_proposal` (and the canvas withdraw).

## NITs

- **NIT-2:** `changes` is 1 to 999 on both sides; 0 reads as absent. The
  frontend readers (`changesOf`) also treat anything else as one change, so
  a raw ref with 0 can't say "0 changes".
- **NIT-5:** the "…" fold runs in every branch of the cut. A cut that reaches
  the name's end shows the name whole, with no "…" after it: `“……”` at 1 →
  `“…”`, `"……"x` at 2 → `"…"x`, `a……b c d e f` at 5 → `a…b…`. The whole
  name (keep undefined or past the end) and the tooltip stay unfolded. A
  name of only "…" stays "…".
- **NIT-1:** tests added for the review's survivors:
  - frontend `changes` bounds (0, -1, 1000, 1e9, 2.5, "3", true, null);
  - a Commons Update with no count, or 0 (never "0 changes");
  - focus with two real cards;
  - any padding on a `.asset-proposal--held` rule in any stylesheet other
    than its own `padding-left`;
  - `post_proposal` fed junk, through the real route;
  - float and 0 counts;
  - the five ratchet-corpus cases: two root states, an ancestor rem, a
    space glyph, a Latin-1 glyph, `serif, "Very Wide"`.
- **NIT-7:** the backend count below is passed only.
- **Follow-ups, not in this round** (per the coordinator):
  - NIT-3: the ratchet under-catches `font-size-adjust`, `text-emphasis`,
    `font-stretch`/`font-variation-settings`, and a media-conditioned
    root size.
  - NIT-4: the ratchet over-catches `calc()`/`clamp()` root sizes, zero
    shadows and strokes, generic family lists and `ui-sans-serif`.
  - NIT-6: Review on an Update focuses the strip's first card, not the
    card for its own proposal.
  - The Agent log withdraw line (above).

## Tests on d8c366ce (this part)

- Backend: these 4 fail:
  - both fallback tests;
  - `test_a_count_is_one_to_999_and_a_float_is_no_count`;
  - `test_a_reopened_proposals_update_says_its_words_again`.
- Frontend:
  - fail: the NIT-5 cases, `changes` 0, and the no-count Commons cases;
  - pass there by design, since they pin behaviour that is already right
    and exist to kill mutations: the two-card focus, the padding scan, the
    corner swap, the ratchet corpus lines and the `post_proposal` junk test.

## Mutations (this part): 21 of 21 killed

- LOW-1 (4):
  - retarget without the words;
  - reopen without the words;
  - `retarget_proposal` ignoring `text`;
  - `reopen_proposal` ignoring `text`.
- Backend bounds (3): 0 allowed, floats allowed, `post_proposal` unchecked.
- Frontend (9):
  - 0 allowed;
  - no upper bound;
  - no lower bound;
  - a missing count read as 0;
  - focus to the first card;
  - `padding-inline-start: 10px` after the 14px;
  - no fold in the main branch;
  - no fold in the visible branch;
  - a whole name still getting a cut.
- Ratchet (5): min over root states, an ancestor rem read as 16, a space
  allowed, Latin-1 allowed, a generic first word matching.

## Live (this part, 1440): 3 more checks, 11 of 11 in all

- **Held:** Codex makes a 3-edit ask, then a 1-edit ask, on one reference;
  then it withdraws the newer one.
  - The corner's Update goes from "Codex asks to change a reference in the
    Commons" (changes 1) to "Codex asks to make 3 changes to a reference in
    the Commons" (changes 3).
  - It keeps the same id.
  - The held line reads "Codex asks to make 3 changes to a reference".
  - The placeholder reads "proposes 3 changes to this reference".
- **Promoted with Review open:** see LOW-1 above.

## Gates for this round (`lg run --gate`, on the final tree)

- `tsc -b`: clean.
- `npm run lint`: clean.
- Vitest, the full run: 602 files, 7,594 tests passed.
  - An earlier full run, before the review-1 changes, had one failure under
    load: `noticeRegionScreenSwitch`, a frame-timing test that this work
    doesn't touch. It passed 3 of 3 times alone, and in this run.
- Backend, the full suite, isolated: 11,889 passed.
- Build budget: 422,073 bytes raw (129,674 gzip); 101 JS assets eval-free;
  fonts OK.
- `dist` removed.
