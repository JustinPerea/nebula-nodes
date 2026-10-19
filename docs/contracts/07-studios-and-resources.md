---
title: Nebula Contracts — Studios and Resources (Volume 7)
status: draft
contract_version: 1
updated: 2026-10-18
---

# Studios and resources (Volume 7)

Saved assets that studios edit and bridge nodes read. This volume starts with the Moodboard; Character, Cinema and the video editors are not written up yet.

**Oracle:** `backend/services/moodboard_store.py`, `backend/services/moodboard_brief.py`, `backend/services/moodboard_analysis.py`, `backend/handlers/moodboard.py`, `/api/moodboards/*` in `backend/main.py`

---

## 1. Moodboard

A board is one JSON file under the moodboard root (`NEBULA_MOODBOARD_ROOT`, default `~/.nebula/moodboards/<scope>/<id>.json`; scope is `_global` or a project id).

### 1.1 Saved fields

| Field | Type | Who writes it | Notes |
|-------|------|---------------|-------|
| `id`, `createdAt`, `projectId` | string | store | Fixed after create |
| `name`, `notes`, `mode`, `strength`, `images` | — | person or agent | `mode` is `look`, `world` or `subject`; each image has `weight` and `excluded` |
| `analysis` | object or null | Analyze | Colour reading of the images. Set to null when the images, weights, mode, strength or notes change. Its own `styleBrief` and `negativePrompt` are the analyzer's; generators get `brief` (1.2), so change the brief through `briefOverride`, not here |
| `direction` | string | person or agent | What the board is for, in positive words. Up to 4000 characters |
| `avoid` | string[] | person or agent | Things to keep out of the image. Trimmed, de-duplicated (case-insensitive), at most 40 items of 200 characters |
| `pinnedColors` | `{include: hex[], exclude: hex[]}` | person or agent | Colours that must appear or must stay out. Hex is stored as `#rrggbb`; at most 12 per list; a colour can't be in both |
| `briefOverride` | `{text, basis, updatedAt, by}` or null | person or agent (text); store (`basis`, `updatedAt`, `by`) | A hand-written brief that replaces the generated one. `by` is `person` or `agent`, from the person gate (`services/person_gate.py`); none (an override the migration moved) counts as `person`. Only the person may replace, remove or Keep text the person wrote (1.3) |
| `briefVersion` | integer | store | `1` once the board has the fields above (see 1.5) |
| `version`, `updatedAt`, `thumbnail` | — | store | |

`direction`, `avoid`, `pinnedColors` and `briefOverride` live on the board, not inside `analysis`, so analyzing again never drops them. Changing them does not clear the analysis.

### 1.2 The brief (`brief`, computed)

Every moodboard API response adds `brief`, computed on each read and never saved (`moodboard_brief.compose`):

| Key | Meaning |
|-----|---------|
| `styleBrief` | The override text when there is one, else `generatedStyleBrief` |
| `generatedStyleBrief` | Direction first, then mode intent, palette (minus kept-out colours), accents, "Make sure these colors appear", visual cues, any reader fields (`motifs`, `materials`, `textures`), notes. Empty until the board is analyzed |
| `negativePrompt` | `blurry, low-detail artifacts` plus the Avoid list. Defects only: content intent goes in the brief as positive words |
| `avoid`, `direction`, `pinnedColors` | The saved fields |
| `avoidPrompt` | `Keep these out of the image: <avoid>, colors close to <kept-out hex>.` or empty |
| `palette`, `accents` | The analysis colours, minus any within dE00 5 of a kept-out colour |
| `override` | `{active, stale}`: `stale` is true when the board changed after the override was written |
| `needsAnalysis` | No saved analysis yet |

### 1.3 API

| Call | Body | Effect |
|------|------|--------|
| `POST /api/moodboards` | `name`, `images`, … plus optional `direction`, `avoid`, `pinnedColors`, `briefOverride: {text}` | Create |
| `PUT /api/moodboards/{id}` | Any subset, including the four brief fields | Update. `briefOverride: {text}` sets the override; `briefOverride: null` removes it (the brief goes back to generated). Send only `text`: `basis` and `updatedAt` are refused (422) |
| `POST /api/moodboards/{id}/brief-override/keep` | — | Keep the override for the board as it is now (clears `stale`). 404 for an unknown board; 409 when there is no override (the message says to set one with `PUT`); 403 when an agent asks to keep the person's text |
| `POST /api/moodboards/{id}/analyze` | — | Analyze again. Keeps the brief fields and the override |

The board keeps no history, so replacing or removing the person's hand-written brief can't be undone. A `PUT` that would replace or remove an override with `by: "person"` (or no `by`), or a Keep of one, is refused unless it comes from the person: 403 with the person gate's `code` (`agent_refused` for an agent marker, `person_required` without this launch's person token), and nothing in that request is saved. An agent may still change every other field, which marks the override stale for the person to answer, and may change an override an agent wrote.

Sending the same override text again keeps its original `basis`, so a client that saves the whole board on every change doesn't hide the "changed since you edited this" state. New text is stamped with the board as it is after the update.

### 1.4 How a board reaches a generator

The `nebula-moodboard` node emits a `Moodboard` bundle (`kind: "nebula_moodboard"`) carrying `styleBrief`, `negativePrompt`, `avoid`, `avoidPrompt`, `direction`, `pinnedColors`, `briefOverride` (`{active, stale}`), `palette`, `accents`, `images`, `representativeImages`, `analysis` and `providerHints`. A stale override is still used, and the run gets a note saying so. The node is not output-cached: its params name the board, not its contents.

Image generators take it on an optional `moodboard` input port. The engine folds it in before the handler runs (Volume 2, section 7a, "Moodboard fold").

### 1.5 Migration of older boards

Boards saved before the brief fields (no `briefVersion`) are migrated once at backend startup, and in memory on any read before that:

- Negatives in `analysis.negativePrompt` beyond the old defaults move to `avoid`.
- An `analysis.styleBrief` that differs from what that analysis generated becomes `briefOverride`. If the board changed since that analysis, the override starts out stale.
- Each changed file is copied first to `<moodboard root>/../moodboard-backups/brief-fields-<UTC time>/<scope>/`, with `migration-log.json` listing what moved. A file that can't be backed up is not rewritten.
- Moved text is kept within the limits in 1.1, so the board can still be saved. Anything cut is in the log (`avoidClipped`, `overrideClipped`) and whole in the backup.
- Nothing is lost: the saved `analysis` keeps its old `styleBrief` and `negativePrompt`, and the backup holds the file as it was. A backup copied back is migrated again on the next start, with the same result.
- Running the migration again changes nothing. A file that can't be read is logged and left alone. A board with a higher `briefVersion` (saved by a newer Nebula) is left as it is. A board file edited by hand into an odd shape still lists and opens (its `brief` is `null` if it can't be composed), and a failing migration never stops the backend from starting.

### 1.6 From the CLI and MCP

`nebula moodboard` and the `moodboard_*` MCP tools (`backend/moodboard_client.py`) return each board with `direction`, `avoid`, `pinnedColors`, `briefOverride` (`{text, by, updatedAt, stale}` or null; `by` is `agent` only when stamped so, else `person`) and `brief`, the backend's computed brief from 1.2 passed on as it came. On a backend that doesn't send `brief`, it is `null`: the client never rebuilds it, and never offers `analysis.styleBrief` in its place.

`nebula moodboard set` and `moodboard_update` change the brief fields: Direction (`""` clears), Avoid (replace, add, remove), pinned colours (replace both lists, add to either, remove from either), the override (set, or `""` for the generated brief), and Keep (`--keep-brief` / `keep_brief`, then `POST .../brief-override/keep`). Values are checked against the limits in 1.1 before anything is sent; nothing is cut short. Brief fields keep the analysis; changes to images, notes, mode or strength that change a value clear it. A 403 for the person's override comes back as the store's sentence, without the canvas-tab advice in the gate's `person_required` text.

The result's `previous` puts the board back when passed as the same call's arguments: settings, image settings, `direction`, `avoid`, `pinned_colors` and `brief_override` (the agent's own text, or `""` for none). It leaves `brief_override` out when the person wrote the override, so a restore doesn't trip on text the agent can't change.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-10-18 | Moodboard: brief fields, computed `brief`, override and Keep, migration |
| 2026-10-19 | Moodboard: brief fields and the computed brief from the CLI and MCP (1.6) |
