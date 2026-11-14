# Cursor on Characters and Styles: backend notes

## What changed

- `services/cursor_actions.py` holds a per-surface table (`SURFACE_TABLE`, one `SurfaceInfo` row per surface):
  the key its names are stored under (`board`, `character`, `style`), the sub-item key (`image`, `view`, none),
  the words for the item and its sub-item, its parts and its labels. `SURFACES` is now
  `("moodboard", "character", "style")`. `PART_LABELS` is unchanged (moodboard only), so the frontend's
  `AGENT_SURFACE_PART_LABELS` pin still reads one object; the Character labels are `CHARACTER_LABELS`.
- `moodboard_clash` is now `surface_clash` (the old name stays as an alias), and its refusal takes the surface
  (`surface_clash_refusal(names, surface)`); the moodboard wording is byte-identical. New: `surface_exclusive`
  (at most one of moodboard / character / style).
- `services/agent_presence.py`: `parse_surface_target` is table-driven (`_find_item`, `_find_image`, `_find_view`);
  `rename_item`, `forget_item` and `forget_subs` replace the board-shaped bodies, and `rename_board`,
  `forget_board` and `forget_image` call them. `surface_ids` splits any surface's `itemId`; `_ids_on` filters by
  surface so a character id can never match a board id.
- `main.py`: `_characters_to_point_at` and `_styles_to_point_at` beside `_boards_to_point_at` (open project, then
  Global; read through `asyncio.to_thread`, and only the list the target's surface needs). `_broadcast_stored_asset`
  renames cursors for any of the three kinds. `DELETE /api/characters/{id}` and `DELETE /api/presets/{id}` call
  `_forget_item_cursors` (cursors leave, tabs get `agentPresenceLeave`). `PUT /api/characters/{id}` calls
  `_forget_removed_views` when `referenceViews` got shorter (cursors on a view past the new count fall back to the
  Character, tabs get `agentPresenceRetarget`). `_style_written` sends an agent's create and update through
  `_say_agent_action` with a target. `_pointed` reads the label from any surface's names.
- `services/style_actions.py`: `style_where` now reads `the style “Name”`; `style_anchor` builds the target and names;
  `FIELD_PARTS` maps a field to its part.
- Agent entry points: route docstring and branch, MCP `point_at(character, view, style)`, CLI
  `nebula point --character/--view/--style`, `run_point`'s printed line, `_surface_words`. `agent_status` and
  `agent_start` already copy `anchorNames` whole, so they needed no change.
- Reads: `character_client.list_characters`, `get_character`, `brief`; MCP `character_list`, `character_get`;
  CLI `nebula character list|show`. They use the existing `GET /api/characters` routes, which carry no agent gate,
  so no read boundary was touched. Both tools are in `NEBULA_MCP_TOOLS` and in the gated turn's read list
  (`mcp_channel.CHANGE_TURN_TOOLS`, as `style_list` and `style_get` are).

## Decisions not in the brief

- Part text in `nebula look` and `agents` is the part id in parentheses, as for a moodboard (`character “Mara”
  (traits)`), not the label. A view takes no part, so the brief's "view 2 (Seed)" example cannot occur.
- A view given a part is refused (wording below), rather than dropped; `consistency` on the Character is
  dropped, as the brief says.
- A Character or Style target with the other surface's sub-item key (`image` on a Character, `view` or `image` on a
  Style) is refused. A moodboard target with a stray `view` is still ignored, as before.
- A Style's `part` is stored as its id in `anchorNames` (`{"style", "part"}`).
- A Character moved between Project and Global keeps its id, so a cursor on it is still true and is left alone. A
  cursor on a Character moved to a project that isn't open stays stored; the tabs find no item and park at the
  launcher. Nothing is cleared (a moodboard move is the same).
- A Style write gets a target only when its project is the open one or it is Global (`_board_point`'s rule).
  Restore and purge send the line with no target.
- The "Use … alone" refusals: `point_at` with `part` and no surface now says "part needs moodboard, character or
  style (an id or exact name)"; `image` with no board keeps its old text. The CLI's `--part` alone says the same in
  flag words. Two existing tests changed for it (below).
- `mcp_server.INSTRUCTIONS` could not take a Characters line: with the channel paragraph it sits exactly at the
  4,096-character cut, and the tools describe themselves.

## Existing tests changed

- `test_cursor_anywhere_protocol.py`: the two refusals that pin the surface list now end "Use moodboard, character
  or style." (the still-unknown name is `characters`). `{"part": "note"}` over MCP and `--part note` on the CLI
  expect the new three-surface wording, since `part` alone no longer means a moodboard.
- `test_style_trash_and_tools.py`: the two journal summaries use the new Style words.

## Style sentences (GM - Design's wording, 2026-11-14)

The Agent log, the journal summary (lower case first) and the cursor's say share one helper
(`style_actions.describe`). A cursor's default lines ("Renaming “Dusk grain”", "Writing the prompt for …") show
only for a point with no `say`; a Style write sends the sentence below as its say, as board writes send theirs.

| Write | Before | Now |
|---|---|---|
| new Style | Made Style Dusk grain | Made the style “Dusk grain” |
| one to three fields | Changed the prompt of Style Dusk grain | Changed the prompt of the style “Dusk grain”; Changed the prompt, the settings and the model of the style “Dusk grain” |
| four or more fields | (listed every field) | Made 4 changes to the style “Dusk grain” |
| rename | Changed the name of Style Dusk grain | Renamed the style “Dusk” to “Dusk grain” |
| rename with other fields | Changed the name and the settings of Style Dusk grain | Renamed the style “Dusk” to “Dusk grain” and changed its prompt, settings and model; from four others, … and made 4 other changes |
| nothing changed | Saved Style Dusk grain | Saved the style “Dusk grain” with no changes |
| delete | Deleted Style Dusk grain (in Recently deleted) | Moved the style “Dusk grain” to “Recently deleted” |
| restore | Restored Style Dusk grain | Restored the style “Dusk grain” |
| purge | Deleted Style Dusk grain for good | Deleted the style “Dusk grain” for good |

Names are cut to 60 characters, or to 30 when the line would pass a say's 140 characters, so the three places
keep one line and the say keeps its end. A view given a part is refused with "Nebula couldn’t point at view 2
because a view has no parts. Leave out the part." ("point at", since any action can send it).

## Flags

- The frontend test that pins labels reads `PART_LABELS = {...}` from `cursor_actions.py` with a regex; the
  Character labels live in `CHARACTER_LABELS` so that regex still sees one object. The frontend can mirror
  `CHARACTER_LABELS` separately.

## Review round (two reviewers, backend and frontend)

Neither found a high finding. What changed:

- **A rename whose two names shorten to the same text.** Two long names that share their first 59 (or 29) characters were both cut to the same text, so the line read "renamed the style “XXX…” to “XXX…”". That rename now takes the plain form, "changed the name[, the prompt and the settings] of the style “XXX…”". Names are cut with `text_cut.safe_cut`, so a joined emoji is never split.
- **The project boundary is tested for real.** The earlier test never left the open project. It now opens another project and checks that a project's Character and Style can't be named by name or by id, that the refusal lists none of them, and that Global's still can. A second test checks that an item in "Recently deleted" can't be pointed at.
- **A Style delete clears its cursors before its line is said**, as a board delete does, so a tab never draws the delete's line on a cursor that is about to leave.
- **Items that go with a project deleted for good take their cursors.** `_broadcast_assets_gone` now forgets the cursors on each board, Character and Style it reports, and tells the tabs. Before, `look`, `context` and `agents` went on naming them. This gap was on main for boards.
- **A retarget works the default line out again.** When the backend moves a cursor off a removed view or image (`agentPresenceRetarget`, same event number), the cursor's default line used to keep its old words for the few seconds it shows: "Looking at view 3 of “Mara”" on a cursor now at the Character. It now reads "Looking at “Mara”". An agent's own say is left as it is. This also changes boards: a cursor that falls back from a removed image reads "Looking at “Desert light”".
- `character_get` and `nebula character show` echo a name they can't find cut to 40 characters, as a cursor refusal does. `nebula point --character ""` (or `--style`, `--moodboard`) says "--character needs an id or an exact name".
- Part lookups on the frontend read own keys only, so a part named "constructor" or "toString" reads as an unknown part.

Left as they are, with the reason:

- **A view is a position.** Views have no ids, so removing view 1 of 3 leaves a cursor on view 2 over what was view 3. The backend's contract is the position, and a saved cut moves cursors past the new end back to the Character.
- **The Studio publishes its draft's view count.** The count describes what is drawn. A cursor on a view the draft no longer shows holds its spot until the draft is saved or reloaded, when the backend's retarget moves it.
- **A Character or Style moved to a project that isn't open keeps its cursors** (they park at the launcher), as the build notes above say.
- **Two cursors on one row step down in a column**, so the second sits over the next row. Board rows on main do the same (design signed that off in PR #233).
- **In the Studio a Character's cursor lands on the definition panel, not the rail row**: of several matches the resolver takes the largest visible one, as it takes an open board over its row.

## GM round 1 (design rulings, final review items)

- **A Character rests on its cover thumbnail in the Studio.** The thumbnail carries `data-agent-aim="character:<id>"`
  (`CharacterDefinitionPanel`). For an item with no part and no sub-item, the resolver first looks for a visible aim
  element of that value and rests the tip at its lower right (`cornerPoint`, `CORNER_INSET_PX` = 6 in). A part, a view, or
  no thumbnail on screen resolves as before. A retarget back to the Character lands on the same spot, since it resolves
  the same anchor.
- **A Character node on the canvas rests in its title row.** `screenSpace` takes `launcherRest`: for a step-2 launcher
  whose element is inside a `.react-flow__node`, the tip is the canvas's `launcherRest` for that node
  (`agentCursorMotion.launcherRestPoint`): the icon or first glyph of the card's own title row, read from the page. The
  first build used the wait rest's fallback (18 px in, 44 px down), which assumes the category label above a model card;
  a Character node has none, so the tip landed on the thumbnail (found by the re-shoot). The fallback is used only when
  there is nothing to measure. The element and box stay the launcher's, so the corner dot does not move.
- **The Moodboard node rests the same way.** The ruling names Characters, but its reason holds for the Moodboard node on
  main: beside the node the tip touched the same output port. Both read their own title row
  (`.character-node__title`, `.moodboard-node__title`). GM was told.
- **`type` and `click` at a Character are `look`.** Frontend: `shownAction` in `agentPresenceStore` (applies to `apply`
  and `replay`; every reader reads `cursor.action`). Backend: `POST /api/canvas/cursor` stores and sends `look`; the
  result's `action` says so; `nebula point` prints "(shown as look)"; one line each in `point_at`, MCP-SETUP.md, SKILL.md.
  The MCP server instructions are untouched.
- **A park that would cover a control goes inside its host.** Decided by the resolver from measurements: for a
  non-rail `surface` launcher, if the beside spot (6 px right, middle) lies on, or within 6 px of, the visible box of another
  button, tab, link or field in the host's parent (the arrow's body hangs past its tip; the composer's Enhance is 8 px
  from Styles), the tip goes inside the host at its lower right. No host list or attribute. The
  rail's parks and item rows stay beside. The spot on the host's other side (6 px left) counts too, so the last tab
  of a row, which has a neighbour only on its left, parks inside as the others do (GM ruled for all three tabs). A
  host with no control within reach on either side stays beside.
- **R1 (delete during the point's lookup).** The route looks the target up a second time in a thread, by its ids; if
  the item, view or image is gone it refuses the point with the first lookup's refusal (the agent's own reference when
  it still fails, else the id's). A rename in the window passes. This round stored the cursor first and undid it on a
  refusal; the round checks below replaced that.
- **R2 (80-character cut).** `_shown_name` (`safe_cut`) in `parse_surface_target`, `rename_item` and `_clean_did`; also
  `moodboard_actions.board_point`'s board name. No other name slices in the surface code.
- **R3 (checked, no change).** `useAssetStudioDraft` returns `draft` and `savedId` from one store entry
  (`entries[key]`), replaced by one `patch`/`initialize`; a switch to another Character reads the new key's entry whole
  (or the empty fallback, which publishes null). No render sees one Character's id with another's count.

## Round checks (one reviewer each on the GM round 1 commit and on the first fix)

Both rounds are backend only and change nothing that is drawn. The first check found that a point refused because its item was deleted could put the agent's earlier cursor back on
the deleted item, that the roster and the tabs then disagreed about the session, and that a name of one long character
was stored as no name. The first fix (a449bf49) restored the earlier cursor and then ran a forget on what was missing.
The second check found two more orders of events that still left a cursor on something removed: the earlier cursor is
out of the store while the point is in flight, so a cut of views or a delete that lands then can't fix it up; and the
session's cursor, written after the second look, could be written just after a delete's forget had run.

Both came from storing a cursor before knowing its item is there and undoing it later. The second fix stores nothing
until the item is verified:

- **Watch, look, then store (`_settled_surface_names`).** After the first lookup the route registers a watch on the
  item (`AgentPresence.watch`: surface, item id, and the image or view if the target is on one) and reads the item
  again in a thread (`_look_again`). `forget_item` and `rename_item` of that item, and a `forget_subs` that takes that
  image or view, count on the watch. If the read finds the item gone, the point is refused. If a write counted during
  the read, the item is read again, up to four reads. Otherwise the agent's cursor and the session's are stored
  with no await between the read's return and the two stores.
- **Four reads, then a refusal.** Any save of an item counts on the watch (`_broadcast_stored_asset` calls
  `rename_item` on every write), so an item that is being edited can count during each read. A third check showed
  that storing after the fourth read left a cursor on a Character deleted during that read. The route now refuses
  with "Nebula couldn’t point at the character “Mara” because it kept changing while Nebula checked it. Point at it
  again." (likewise "the moodboard" and "the style") and stores nothing. The words are GM - Design's.
- **Why this closes the window.** A write that finished before the read shows in the read. A write after the read
  runs its forget either before the route goes on, which the watch sees, or after both cursors are stored, where the
  forget finds them like any others.
- **A refused point writes nothing.** The agent's cursor and the session's stay where they were and the tabs are sent
  nothing, so there is no undo, and the earlier cursor never leaves the store. `forget_cursor`, `plain_cursor`,
  `undo_point` and `_forget_missing_cursors` are gone.
- **Names come from the last read.** A rename that lands during the looks is in the names the cursor stores; the part
  stays the first lookup's.
- **`_shown_name`** cuts a name that has no safe cut (a letter under more than 80 combining marks) with a plain
  slice at 80.

Limits:

- The check relies on every write that removes an item, an image or a view calling its forget after its store write,
  on the event loop. The routes on this branch do (`_forget_item_cursors`, `_forget_removed_images`,
  `_forget_removed_views`, `_broadcast_assets_gone`); the third check read each of them.
- A project switch between the last read and the store stamps the cursor with the new project's id while its item is
  in the old one. Nothing is removed, and the first lookup had the same gap before this PR.
- `forget_subs` keeps the cursor of the agent that removed the image (the PR #233 rule). A second point from the same
  agent and session, sent while its own removal is between its store write and its forget, is kept on the removed
  image. One agent sending one call at a time can't do this.
