# Item names: control and bidi characters cleaned (2026-11-14)

From PR #243's final review. The names of stored items (moodboards, Characters,
Styles, a board's looks) are free text and an agent can set one. They are echoed
into lines other agents and the person read, and only had a length cut.

## The rule

`services/text_cut.clean_name(value, limit=None, *, fallback="", ellipsis=False)`,
beside `safe_cut`.

- Whitespace-like characters become one space: TAB, CR, LF, VT, FF, U+001C to
  U+001F, NEL, U+2028, U+2029 and the Unicode spaces. Two words never fuse, and
  U+2028/U+2029 can't forge a log line. (VT, FF, the C0 separators and NEL are
  added to the brief's list because `str.split()` already treats them as line
  breaks, which is how the cursor's names were folded before.)
- Dropped: every other category Cc character (ESC and its sequences, NUL, DEL,
  backspace, the rest of C1), the bidi embeddings and overrides U+202A to U+202E,
  the isolates U+2066 to U+2069, and lone surrogates (the result always encodes as
  UTF-8). A space for these would split a word ("Du<ESC>sk").
- Kept: ZWJ, ZWNJ, LRM, RLM, ALM, variation selectors, emoji tag characters,
  combining marks, every letter. This is why `cursor_actions._shown` (every
  category C* becomes U+FFFD) is not reused for names; it still cleans the
  agent's own echoed refusals.
- Runs of spaces collapse and the ends are stripped. The cut runs after the
  cleaning through `safe_cut`; `ellipsis=True` ends a cut name with U+2026 inside
  the limit. A name empty once cleaned gives the caller's `fallback` (the item's
  id at every site, as before).
- Pure, total, linear. With a `limit` only the first `16 * limit + 256` characters
  are read, so a 100 KB name is not walked whole.

## Surfaces

Cleaned (all through `clean_name`):

- Cursor: `agent_presence._shown_name` (stored `anchorNames`, point target names,
  a rename's names, the Agents panel's `did.label`); `_quoted_name` for the
  refusal lines (a board's, Character's or Style's name in "has no image", "has no
  view", the "The styles here: ..." list, `changing_refusal`).
- Journal and Agent log lines: `moodboard_edits.board_where` (journal summaries,
  Agent log, cursor say), `moodboard_edits._Batch.frame_label` (a look's name in an
  undo message), `moodboard_actions.board_anchor`, `style_actions._name`,
  `style_actions.style_anchor`, `style_actions.journal_data`, and in
  `canvas_events.CanvasEventJournal.publish` every event's summary plus the data
  keys `boardName`, `characterName` and `styleName`, so no publisher can skip it.
- Asset proposals: `asset_proposals.summary` and `update_text` (a board's or a
  project's name in "Asks to ...", the journal and the Update); `main.py`'s 409
  "Send notes ... is already on for board" detail.
- Agent start: `agent_start.boards_part` (each board's `name` row).
- Moodboard brief text sent to a generator: `moodboard_brief._brief_text`.
- MCP and CLI text: `moodboard_client.shown_name` and `repeated_line`,
  `style_client` conflict message, the "no board / no Style" refusals echo the
  agent's text cleaned; CLI `moodboard`, `style`, `character` list, show, set,
  delete, move lines, `nebula point` and `formatter._surface_words`.

Lookup by name: `agent_presence._find_item`, `moodboard_client.get_board`,
`style_client.find_style` and `character_client.find_character` match the name as
stored or as every line shows it, so a name read from a line and sent back finds
the item. Ids are unchanged everywhere.

## Not changed

- What is stored: no migration, no rewriting of saved names, and nothing cleans a
  name at save time (see Flags).
- Structured JSON `name` fields (MCP results, `--json`, `/api` lists): an agent
  matches and passes these back, and JSON escapes control characters.
- The person's own UI text fields (React renders names as text).
- Read boundaries, the person gate, tokens and spend.
- Project names in the same lines ("project Shoot A", `moodboard_client`'s
  project refusals): projects are not an item kind in this brief; same function
  would apply.
- Characters have no journal or Agent log line (an agent can't write one); they
  are covered at the cursor and CLI.

## Tests

`backend/tests/test_item_name_controls.py`: the function's table, every removed
character in every position, idempotence, bounded input, and one test per kind
and surface listed above.

## Raw bidi characters in source (coordinator's review)

The first draft held the nine bidi controls as raw characters in `_BIDI_CONTROLS` and in the new test file. A raw bidi control in source reorders the code a reviewer sees and an editor can drop it without showing a change, so they are now written as `\uXXXX` escapes. Seven older test files held raw ones too (`test_mcp_channel.py`, `test_canvas_pins.py`, `test_agent_cursor_review2.py`, `test_agent_notes.py`, `test_agent_presence_followups.py`, `test_pin_text_as_typed.py`, `fixtures/gen_pin_text_cases.py`). Each was rewritten to escapes only where the parsed AST stayed identical, which held for all seven.

`test_no_source_file_holds_a_raw_bidi_control` in `backend/tests/test_item_name_controls.py` scans `backend`, `frontend/src`, `frontend/scripts`, `scripts`, `desktop` and `cli` and fails with the file and line. It caught one in the check's own pattern while it was being written.

## Security review round (Opus, read-only)

The review found no HIGH, two MEDIUM and nine LOW. What changed:

- **M1, the trash CLI.** `nebula trash list` and `nebula trash restore` printed a deleted item's stored name raw. An agent can name an item and then delete it. Both now print the cleaned name (`cli/commands/trash.py`).
- **M2, hidden text.** `clean_name` kept every format character except the nine bidi controls, so a name could carry tag characters that spell a sentence a model reads and a person never sees, or a zero-width space that makes two names look the same. It now drops category Cf, keeping ZWNJ, ZWJ, LRM, RLM and ALM, and keeps tag characters only inside the flags of England, Scotland and Wales, as a pin's text already did.
- **L1.** A ref that cleans to nothing (a lone ESC) matched an unnamed item in the cursor's lookup. It is refused again.
- **L2.** Four more echoes are cleaned: a look's name in a card refusal (`moodboard_client._card_of`), the move answer's detail and the Style label in `main.py`, and an asset proposal's `targetName` in journal data.
- **L3.** A terminal escape sequence now goes whole, so `Dusk` followed by a colour code is `Dusk` and not `Dusk[31m`. The pattern moved from `canvas_pins` to `text_cut.ANSI_SEQUENCE` and both use it. It is unchanged: the review fix compared it with the one on main.
- **L4.** A call with no limit reads the first 4,096 characters. The journal passes its summary cap as the limit.
- **L5.** With an ellipsis, a name that is one long character keeps its start before the ellipsis.
- **L8.** The source scan asserts each root exists and now also covers `frontend/tests`, `skills`, `contracts`, `nebula`, `docs` and `.github`, and `.yml`, `.yaml`, `.toml`, `.md` and `.html` files. That found four raw bidi characters in two frontend test files, inside single-quoted strings; they are escapes now.

Known and not changed:

- **The moodboard brief (L6).** `_brief_text` now folds whitespace and strips the ends of the board's name, so a name with two spaces, a non-breaking space or a full-width space changes the generator prompt slightly, not only a name with control characters.
- **The journal (L7).** Every summary is cleaned, and a summary is not only a name. A `settings.restored` line that quotes a file path holding a control or bidi character shows the path without it.
- **Other agent-set text in the CLI.** `nebula moodboard show` prints a board's notes, direction and image notes raw. That is free text an agent can set, and cleaning names does not cover it. A follow-up should clean human-mode CLI output at the print layer.

## Check of the fix round (Sonnet, read-only)

Verdict "merge", with three LOWs, all applied: the whole tag block U+E0000 to U+E007F is dropped outside the three flags (U+E0000 and U+E0002 to U+E001F are unassigned, so the category test let them through); a test for an asset proposal's `targetName`; blank lines in `cli/commands/trash.py`.

Not tested: the Style label in `_check_style_write` (`main.py`). It reaches a refusal only when an agent changes a Krea Style's billing mode, which needs a read-back state the test fixture does not set up. The line is one `clean_name` call.
