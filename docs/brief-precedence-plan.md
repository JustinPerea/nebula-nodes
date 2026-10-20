# Moodboard brief precedence (design-canvas gap 18): build spec

From Justin's answers on https://reviews.justinperea.com/nebula/brief-conflicts/ (via GM - Design, 2026-10-19)
and the research note `Research/topics/colour-text-contradiction-detection-2026-10.md` (Obsidian vault). Brief
logic stays in `services/moodboard_brief.py` plus a new `services/moodboard_colour_words.py`; other files only
store, show or send what they return.

## 1. The rule as built

Order of precedence for everything a board sends. Where two levels disagree, the higher wins; where the higher
says nothing, the lower fills in.

1. The hand-written brief (`briefOverride`). Wins outright, as today. No check runs on it.
2. Pinned colours. "Must appear" colours always go, even against Avoid; the clash is flagged, never acted on.
   "Keep out" colours drop near measured colours (dE00 < 5) and join `avoidPrompt`, as today.
3. Direction and Avoid. The colour-word check (section 3) compares them with the measured colours.
4. Board notes. Sent only when opted in (board or node). Never trimmed by the check.
5. What Nebula measured: palette, accents, measured cues (and the reader's motifs/materials when it lands).

**Generators get by default:** Direction, mode intent, the measured palette and accents minus the colours the
check left out, pinned colours, measured cues only, reader fields, the Avoid list (negative field, plus
`avoidPrompt` for instruction-following models). No board notes, no cues lifted from the notes, no image notes.

**Advanced option, per board (`clashMode`):**

| value | Studio label | what happens |
|---|---|---|
| `leave-out` (default, P1 a) | Leave clashing colors out | Conflicts are left out and listed with the reason; Keep anyway puts one back. Warnings stay in and are listed as "may clash" with Leave out |
| `flag` (P1 b) | Flag clashes, leave nothing out | Nothing is left out by Nebula. Conflicts and warnings are listed; Leave out (one colour) and Leave out all flagged act on them |
| `no-measured` (P1 c) | Send no measured colors | With a Direction: no measured palette or accent goes; each is listed as left out ("Measured colors are off for this board"); Keep anyway still works. Pinned colours go. Without a Direction it behaves as `leave-out` |
| `keep-all` (P1 d) | Off: send every measured color | As before this change. The check still runs and is saved (agents can read it), but nothing is listed or applied; choices are ignored |

## 2. Data

New board fields, all optional: old boards read with the defaults and no file is rewritten (`BRIEF_FIELDS_VERSION`
stays 1, `migrate_board` untouched).

| field | default | validation (store, 422 on create/update) | lenient read (`board_fields`) |
|---|---|---|---|
| `clashMode` | `"leave-out"` | one of the four values | anything else reads as `leave-out` |
| `colorChoices` | `{"keep": [], "leaveOut": []}` | hex lists (normalized like pins), at most 24 each, a hex in only one list, a `keep` hex can't be a pinned "keep out" colour | bad shape reads as empty |
| `sendNotes` | `false` | boolean | anything but `true` reads as `false` |
| `colorCheck` | computed | written by the store only (`brief`/`briefVersion` treatment: a sent value is ignored) | missing or stale is recomputed in memory |

- `colorChoices.keep` = Keep anyway: the colour goes back where it was measured (palette or accents), and is
  not added to "Make sure these colors appear". `leaveOut` = Leave out (a warning, or anything in `flag` mode).
  A choice matches a measured colour within dE00 5 (`MERGE_DELTA_E`, as `without_excluded`), so it survives a
  re-analysis that shifts the hex slightly. Choices with no matching colour stay stored and do nothing.
- `colorCheck` = `{"version": 1, "basis": <16 hex>, "checks": {"words": {"version": LEXICON_VERSION}},
  "findings": [...]}`. Each finding: `hex` (or null for a whole-palette finding), `role`
  (`palette`/`accent`/`pinned`), `share`, `level` (`conflict`/`warning`), `source` (`avoid`/`direction`),
  `clause` (the person's words), `rule` (`hue`, `neutral`, `hex`, `cast`, `global`, `allowance-chroma`),
  `reason` (display text, e.g. `Avoid: red, orange or pink flowers`), `foundBy` (`"words"`).
- The check's `basis` hashes Direction, Avoid, pinned "must appear", the measured colours (hex, role, share) and
  `LEXICON_VERSION`. The store recomputes `colorCheck` on every create/update whose basis differs (one call in
  `MoodboardStore.create` and `.update`, so Analyze, Direction and Avoid edits all refresh it). `compose` uses
  the saved result when its basis matches, else computes the words check in memory (a hand-edited file, or the
  handler's in-memory re-analysis of a stale board) and never writes.
- **Room for a second check:** a later check (a text-only model for style words the lexicon can't resolve) adds
  `checks.<name> = {version, ...}` and findings with `foundBy: "<name>"` under the same basis. When the basis
  moves, the words check is recomputed and other checks' findings are set aside until they run again. The merge
  in `compose` takes the worst level per hex and keeps every reason. Not built now (GM is researching detection).
- **Per-node notes opt-in:** `nebula-moodboard` gets param `send_notes` (enum, label "Board notes to
  generators", options `board` "As the board says" (default), `yes` "Send", `no` "Don't send"). Add it to
  `frontend/src/constants/nodeDefinitions.ts` and by hand to `backend/data/node_definitions.json` (don't keep an
  `export-node-defs.ts` run: it undoes four JSON-only fixes), then regenerate `docs/MODEL_REFERENCE.md`. A saved
  node without the param reads `board`. `yes`/`no` override the board's `sendNotes` for that node's runs.
- **`brief_basis`** adds `clashMode`, `colorChoices` and `sendNotes` to its payload **only when they differ from
  the defaults**. Existing overrides keep their basis (not marked stale by the upgrade); changing one of these
  while an override is active marks it stale, as pins do today. `colorCheck` is derived, so it stays out.

## 3. The colour-word check (`services/moodboard_colour_words.py`)

Deterministic, free, always runs. No CLIP/SigLIP; no Lindner (CC BY-NC-SA), XKCD, c3 or LUX data. All values are
our own, in one table in the module with a comment naming the research note. Matching is in OKLCH (Ottosson);
CIEDE2000 only pairs a colour with a hex written in the text.

**Parse first.** Split Direction and each Avoid item into clauses on `. ;` and line breaks; a colon splits a
clause into a head and a list. In a clause, find
colour terms (whole words, case-insensitive, plural `-s`/`-es` stripped, hyphen compounds such as `blue-grey`
split into a hue plus a neutral). Each term gets its modifiers (the words just before it) and a scope:

- **object**: a noun follows the term or the comma/`and`/`or` list it's in ("red, orange or pink flowers",
  "pale blue-grey water"); a list item after a colon with no noun of its own takes the head's noun ("Flowers in
  cool jewel tones: cornflower blue, violet, lilac and white"), one with its own keeps it ("...: pale blue-grey water").
- **cast**: the clause holds `cast`, `tint`, `varnish`, `wash`, `glaze` or `toning`.
- **global**: the clause holds `palette` or a style word (`tonalist`, `muted`, `desaturated`, `monochrome`,
  `subdued`, `faded`), or the term stands alone.

Every term from an Avoid item is an exclusion. In the Direction, a term after `no`, `not`, `without`, `never`,
`avoid` or `minus` (up to the next clause break or `but`) is an exclusion too; it never becomes an allowance.
Every other Direction term is an **allowance**: it protects colours, never removes them. A hex in the text
(`#a6392d`) is a term that matches colours within dE00 5. Unknown words are ignored (no keyword matching).

**Lexicon (starting values; tune in the table).** Hue terms match only colours with C >= 0.03; anything below
is near-neutral and only neutral terms or a hex can match it.

```
term                        hue arc (deg)   extra gate                        reference (allowances)
red, crimson, scarlet       350-35          L < 0.80                          -
pink, salmon, rose-pink     340-35          L >= 0.65                         -
orange, rust, terracotta    35-70           -                                 -
brown                       20-75           L < 0.55, C 0.03-0.13             -
amber, gold, ochre          70-100          -                                 -
yellow                      70-115          L >= 0.60                         -
olive                       95-130          L < 0.60                          -
green                       115-165         -                                 -
sage                        115-165         C < 0.08                          -
teal, cyan, aqua            165-230         -                                 -
blue, azure, navy(L<0.40)   230-270         -                                 cornflower: #6495ED (C 0.141)
violet, purple              270-320         -                                 -
lilac, lavender             280-340         L >= 0.70, C < 0.12               -
magenta, fuchsia            320-350         C > 0.12                          -
warm (alone)                350-110         -                                 -
cool (alone)                165-320         -                                 -
white / black               -               C < 0.03, L >= 0.90 / L < 0.25    -
grey, gray / silver         -               C < 0.03, L 0.25-0.90 / 0.65-0.90 -
pearl, pearl-grey           -               L > 0.85, C < 0.04                -
cream, ivory                70-110          L > 0.88, C 0.02-0.06             -
```

Modifiers: `pale` L > 0.80 and C < 0.08; `light` L > 0.70; `dark`/`deep` L < 0.45; `muted`/`dusty`/`greyish`/
`-grey` compound C < 0.06 (grey compound) or < 0.08; `saturated`/`vivid`/`bright`/`neon`/`jewel` C > 0.12;
`warm`/`cool` before a hue term change nothing (yellow is already warm), before a neutral they set the hue side
(warm grey: hue 40-110, cool grey: 180-280, C 0.01-0.04). Global style words set a chroma ceiling: neutral
words (`silver`, `grey`, `monochrome`) C < 0.04, muted words (`tonalist`, `muted`, `desaturated`, `subdued`,
`faded`) C < 0.08; a clause with both takes the looser one (never leave out more than the words rule out).

**Matching.** A colour is *large* when its board share is >= 0.10, else *small* (accents are always small; an
analysis with no shares counts as small). For each measured colour and each pinned "must appear" colour:

- **Exclusion, hue/neutral/hex scope object or global:** inside the term's gates with C >= 0.08 (or any C for a
  neutral term or hex) is a **conflict**; 0.03 <= C < 0.08 in the arc is a **warning**.
- **Exclusion, cast scope:** tested on the share-weighted mean OKLab (a, b) of all measured colours. Mean chroma
  >= 0.015 with mean hue in the term's arc is a whole-palette **conflict**, and every colour with C >= 0.04 in
  that arc is a conflict with it. Otherwise a colour with C >= 0.08 in the arc is a **warning** ("may warm the
  image toward the cast you avoid"). Near-neutrals are never left out by a cast rule.
- **Global allowance with a ceiling** (e.g. "silver tonalist palette": C < 0.08): a large colour over the
  ceiling is a **conflict**. A small colour over it is exempt when an object allowance matches it (same arc and
  gates, and C <= reference C + 0.04 when the term has a reference); a **warning** when it's in an allowance's
  arc but over that chroma; a **conflict** when no allowance covers it.
- **Allowance vs exclusion:** a colour hitting both is a **warning** citing both (the Direction protects).
- Reasons quote the clause, Avoid before Direction. Pinned colours get findings but are never left out.

**Worked example: board 4df26f93ff63** (from GM's `nebula-moodboard-set-2026-10-19.json`; Direction, Avoid and
pin #e8593c as set that day, with its measured colours and shares).

| colour | share | OKLCH L/C/h | result | reason |
|---|---|---|---|---|
| #a6392d brick (accent) | 0.0015 | 0.499/0.146/29 | conflict, left out | Avoid: red, orange or pink flowers |
| #ef8172 salmon (accent) | 0.0019 | 0.722/0.138/29 | conflict, left out | Avoid: red, orange or pink flowers |
| #9b492b rust (accent) | 0.0006 | 0.504/0.118/40 | conflict, left out | Avoid: red, orange or pink flowers |
| #c8b03e ochre (accent) | 0.0005 | 0.757/0.133/97 | conflict, left out (not "orange") | Direction: silver tonalist palette (also a warning: warm yellow varnish cast) |
| #1c70f2 blue (palette) | 0.0232 | 0.575/0.210/260 | warning, stays, "may clash" | Direction: silver tonalist palette; blue is allowed for the flowers, but this one is more saturated than cornflower |
| #e8593c (pinned) | - | 0.647/0.183/33 | flagged, still sent | Avoid: red, orange or pink flowers |
| #f7f8f7 #111010 #2a2b28 #dce0e2 #16121f #98acac #e7e2d4 | 0.02-0.20 | C <= 0.026 | consistent | near-neutral |

The cast test doesn't fire: the share-weighted mean OKLab b is -0.009 (the board is cool). The research's
labelled cases also hold: the blue is a conflict at share >= 0.10; #6495ED, #C0C0C0, #EAE0C8, #E2DFD2 are consistent.

## 4. What shows where

**Moodboard Studio** (`frontend/src/components/moodboard-studio/`):
- Under "Brief sent to generators" (`BriefPanel`): **Left out of the brief**: swatch, hex, palette/accent, the
  reason, and **Keep anyway**. A kept colour moves to a "Kept anyway" row with **Undo**. **May clash** (warnings,
  still sent): reason and **Leave out**. In `flag` mode one list, "Flagged", with Leave out and **Leave out all
  flagged**. Pinned colours that clash: "Pinned, so it still goes" with the reason. `keep-all`: one line, "Clash
  check is off for this board."
- `BoardSwatches` dims a left-out swatch, reason in its tooltip, so the palette shows what generators get.
- `BriefFields` gets an **Advanced** disclosure: "When your words clash with a measured color" with the four
  options of section 1 (default marked "default").
- Under the Notes field: a **Send these notes to generators** switch, off. Hint: "Off: notes are for you, your
  team and agents." Placeholder: "Anything about the board, in your words."
- Rows enter and leave on the spring token of `styles/provider-switcher.css` (`linear()`), none under reduced motion.

**CLI** (`backend/cli/commands/moodboard.py`, `backend/moodboard_client.py`):
- `show` prints, after the brief: `Left out of the brief:` one line per colour with reason and
  `Keep it: nebula moodboard set <id> --keep-anyway "#a6392d"`; `May clash (still sent):` with `--leave-out`;
  `Pinned colors that clash (still sent):`; `Notes: not sent to generators` (or "sent"); the mode when not the
  default. `--json` carries `clashMode`, `colorChoices`, `sendNotes`, `colorCheck` and the new `brief` keys.
- `set` flags: `--keep-anyway HEX`, `--leave-out HEX`, `--leave-out-flagged`, `--reset-color HEX` (back to
  Nebula's call), `--clash-mode leave-out|flag|no-measured|keep-all`, `--send-notes` / `--no-send-notes`. All go
  into `previous` for `--restore`.

**MCP** (`backend/mcp_server.py`): `moodboard_update` gains `keep_anyway`, `leave_out`, `reset_colors`,
`clash_mode`, `send_notes`; `moodboard_get` documents `brief.leftOut`, `brief.mayClash`, `brief.pinnedClashes`
and `colorCheck`. INSTRUCTIONS adds: board notes are for the person, their team and agents; generators get them
only when the board or node opts in; `brief.leftOut` says which measured colours were left out and why.
Agents still read notes everywhere they do today. Same text in `skills/nebula/SKILL.md` and contract
`docs/contracts/07-studios-and-resources.md` (1.1 fields, 1.2 brief keys, 1.4 bundle, CLI/MCP section).

**`compose` adds to `brief`:** `leftOut` [{hex, role, level, reason, foundBy}], `mayClash` (same shape),
`kept`, `pinnedClashes` [{hex, reason}], `clashMode`, `notesSent`; `palette`/`accents` are what generators get.

## 5. What changes for existing boards' generator output

Every board, no opt-in set (the golden-file reconciliation checks these):

1. `styleBrief` / `generatedStyleBrief`: the `Notes: ...` sentence is gone; `Visual cues:` keeps only measured
   cues (`MEASURED_CUES` in `moodboard_analysis.py`: palette-led, the mode labels, the `_PALETTE_WORDS` labels)
   and the sentence is dropped when none remain.
2. Boards with a Direction or Avoid naming colours: conflicting measured colours leave `styleBrief`'s
   `Color palette:` / `Accent colors` sentences, `brief.palette`, `brief.accents`, the node's `palette` output
   and the bundle's `palette`/`accents`.
3. Moodboard node bundle: `notes` is `""`; `images[].notes` is `""`; `analysis` is the generator view:
   `keywords` measured only, `summary` without its "Notes emphasize:" tail, `tasteProfile` rebuilt with measured
   cues, `subjectBias` `[]`, `styleBrief` the analyzer brief without notes, `images[].notes` `""`.
   `providerHints.generic.palette`/`accents` now equal the brief's (today they carry the raw analysis, so a
   left-out colour would leak). New keys: `leftOut`, `mayClash`, `pinnedClashes`, `notesSent`.
4. Unchanged: the saved `analysis`, `negativePrompt`, `avoidPrompt`, override text and existing overrides' `basis`.
5. `backend/tests/fixtures/moodboard_defaults_pin.json`: only `composed.styleBrief` of `brand` and `busy`
   changes (their notes and note cues go). Re-pin with `NEBULA_REPIN_MOODBOARD=1` and check the diff is that.

## 6. Tests

Must fail on `main` first (run and record before the fix):

- `test_moodboard_colour_words.py`: the labelled table of section 3; perturbations: "no red" in the Direction
  is an exclusion, never an allowance; clauses reordered give the same findings; "Reds"/"RED FLOWER" match;
  Avoid "warm" alone conflicts with all four accents and leaves #e7e2d4; Avoid "warm yellow varnish cast" gives
  no conflict on this cool board and does on a board whose mean is warm yellow; `#a6392d` written in Avoid
  conflicts with brick only; "redwood", "Fred", "bored", "shredded" match nothing; Avoid "blue flowers" plus
  Direction "cornflower blue" gives a warning.
- `test_moodboard_brief_precedence.py`: the GM board (colours, shares, Direction, Avoid, pin; no notes text or
  image links in the fixture) composes with the four accents in `leftOut`, the blue in `mayClash`, #e8593c in
  `pinnedClashes` and still in "Make sure these colors appear", no left-out hex anywhere in `styleBrief`;
  each `clashMode`; Keep anyway and Leave out (including a dE00 < 5 shifted re-analysis); notes off by default
  with and without a Direction, on via `sendNotes`, node `yes` over board off, node `no` over board on; an
  override's basis from main still matches (not stale); changing each new field with an override marks it
  stale; a saved `colorCheck` with a fake `foundBy: "reader"` finding at the current basis is honoured and
  ignored at a stale one; reading an old board writes nothing.
- `test_moodboard_handler.py`: bundle without notes, generator-view analysis, `providerHints.generic` palette
  equals the brief's, node param `send_notes`.
- Store/routes: 422s, `colorCheck` saved on Direction/Avoid/Analyze and ignored when sent, the agent gate (open
  question 3). CLI and MCP: show sections, each `set` flag, `previous`/`--restore` round trip.
- Frontend vitest (`--testTimeout=60000`): `MoodboardBrief.test.tsx` (Left out list, Keep anyway, Undo, May
  clash/Leave out, Advanced options, notes switch off), `MoodboardColors.test.tsx`, `MoodboardStudioView.test.tsx`.

**Live check** (isolated backend + Vite on 879x/579x per CONTRIBUTING.md, 8000-8010 blocked): a board made via
the API with the GM colours as its analysis (right `sourceHash`), Direction, Avoid and pin; `nebula moodboard
show` on that port; in Studio, Keep anyway on brick then Undo, each advanced option, the notes switch; a Moodboard
node wired into a generator with no key, reading the folded prompt: no notes, no left-out hex. Screenshots.
After merge, GM reruns n2 on board 4df26f93ff63 with its Direction restored and reads the brief back.

## 7. Open questions (each with the recommendation the build uses)

1. **Warnings under the default mode.** Keep a warning in the brief, list it as "may clash" with one-click
   Leave out, since the Direction allows that hue (the coordinator's recommendation). *Build: yes.*
2. **A single warm-yellow colour vs a cast-scoped Avoid.** A cast is a whole-image tint, so the cast rule
   tests the palette mean; one ochre accent alone is a warning, not a conflict. On the GM board ochre is still
   left out, by the "silver tonalist palette" rule. *Build: as written in section 3.*
3. **Who may opt notes in.** Notes sent to a provider can't be taken back, so turning `sendNotes` on, or a
   node's `send_notes` to `yes`, is the person's: agents get a 403 that says to propose it (the
   `_is_person_request` gate the override and `_provider` use). Agents may turn it off. *Build: yes.*
4. **Image notes and graph nodes.** P4 names board notes; image `notes` are notes too, and the bundle can reach
   an LLM node through an Any port. Treat image notes with the same opt-in and strip both from the bundle and
   its analysis. *Build: yes.*
5. **Numbers.** The arcs, the 0.03/0.08/0.12 chroma gates, the 0.10 large-share line, the 0.015 cast line and
   the +0.04 reference headroom are our own first values. *Build: ship them in one table; retune against
   boards GM labels, bumping `LEXICON_VERSION` (which refreshes saved checks).*
