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
