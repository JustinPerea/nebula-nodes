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

A board is one JSON file under the moodboard root (`NEBULA_MOODBOARD_ROOT`, default `~/.nebula/moodboards/<scope>/<id>.json`; scope is `_global` or a canvas project's id, see 1.8).

### 1.1 Saved fields

| Field | Type | Who writes it | Notes |
|-------|------|---------------|-------|
| `id`, `createdAt`, `projectId` | string | store | Fixed after create |
| `name`, `notes`, `mode`, `strength`, `images` | — | person or agent | `mode` is `look`, `world` or `subject`; each image has `id`, `url`, `weight`, `notes`, `privateNote` and `excluded` |
| `images[].privateNote` | string | person or agent | The person's own label for the image ("PAINTERLY (liked)"), up to 2000 characters. Shown wherever the board is inspected (Moodboard Studio, `nebula moodboard show`, `moodboard_get`), never sent anywhere: it isn't in `source_hash`, the analysis, `brief`, the negative prompt or the Moodboard node's outputs (`moodboard_store.without_private`). Changing it keeps the analysis. A board saved before it existed reads with `""`. `images[].notes` is the note that steers |
| `analysis` | object or null | Analyze | Colour reading of the images. Set to null when the images, weights, mode, strength or notes change (not an image's `privateNote`). Its own `styleBrief` and `negativePrompt` are the analyzer's; generators get `brief` (1.2), so change the brief through `briefOverride`, not here |
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
| `POST /api/moodboards/{id}/analyze/dry-run` | optional `{thresholds: {accentMinChroma, accentSeparation, mergeDeltaE}}` | What Analyze would give, saving nothing (1.8). 422 for a threshold out of range or an unknown key |

The board keeps no history, so replacing or removing the person's hand-written brief can't be undone. A `PUT` that would replace or remove an override with `by: "person"` (or no `by`), or a Keep of one, is refused unless it comes from the person: 403 with the person gate's `code` (`agent_refused` for an agent marker, `person_required` without this launch's person token), and nothing in that request is saved. An agent may still change every other field, which marks the override stale for the person to answer, and may change an override an agent wrote.

Sending the same override text again keeps its original `basis`, so a client that saves the whole board on every change doesn't hide the "changed since you edited this" state. New text is stamped with the board as it is after the update.

### 1.3a The analysis's colours (version 4)

`analysis.palette` and `analysis.accents` are hex lists in rank order. `analysis.colors` holds the same colours with detail:

| Key | Meaning |
|-----|---------|
| `hex`, `role` | The colour, `dominant` (palette) or `accent` |
| `share` | The part of the weighted board it covers: the sum over images of (image weight ÷ total weight) × its share of the image |
| `images` | How many images it comes from |
| `sources` | Each image it comes from, largest contribution first (then board number): `number` (the image's place among all the board's images, 1-based, excluded ones included, as Moodboard Studio and `nebula moodboard show` number them), `id`, `share` (the colour's share of that image; two colours of one image that merge add up) and `contribution` (that image's part of `share`) |

`analysis.images[]` lists each analyzed image (excluded ones are left out) with its `number`, `colors` (`hex`, `share`, `accent`), `palette` and `accents`. Weight-0 images are analyzed but never appear in `sources`.

Analyses before version 4 have no `sources` or `number`. They stay current (the source hash didn't change), so a board isn't marked out of date; the Studio and CLI say to analyze again to see the sources.

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

`nebula moodboard set` and `moodboard_update` change the brief fields: Direction (`""` clears), Avoid (replace, add, remove), pinned colours (replace both lists, add to either, remove from either), the override (set, or `""` for the generated brief), and Keep (`--keep-brief` / `keep_brief`, then `POST .../brief-override/keep`). Values are checked against the limits in 1.1 before anything is sent; nothing is cut short. Brief fields keep the analysis; changes to images, notes, mode or strength that change a value clear it. A 403 for the person's override (the person wrote it after the call read the board) comes back in the CLI and MCP's own words, naming the argument to leave out; any other 403 comes back as the backend's sentence, without the canvas-tab advice in the gate's `person_required` text.

The result's `previous` puts the board back when passed as the same call's arguments: settings, image settings, `direction`, `avoid`, `pinned_colors` and `brief_override` (the agent's own text, or `""` for none). `brief_override` is there only when the change touched the override, so undoing anything else never touches a brief the person wrote since. A call that would replace, clear or Keep the person's override, or Keep with no override, is refused before anything is sent and changes nothing; the message says to leave that argument out. Keep loses nothing, so its refusal gives its own reason: keeping clears the person's notice that the board changed, which is theirs to answer. If the person writes or removes their brief while the call runs, a Keep refused after the other changes were saved says so and hands back `previous` for them (`MoodboardError.previous`; in the MCP error's text; on the CLI's stderr). `nebula moodboard set --restore <file>` sends a saved `previous` (or the whole `set --json` output) back as one change; it refuses other flags with it and keys `previous` never has. Images the change removed aren't in `previous` (it only sets images on the board); the result's `removed` URLs add them back. A Keep that got no answer (connect or timeout) says the brief may or may not have been kept, not that it wasn't.

Each image carries `privateNote` (1.1). `--private-note IMAGE=TEXT` and `{"image": ..., "privateNote": ...}` in `moodboard_update` set it, `show` prints it marked private, `--json` and `previous` include it, and a change to it alone keeps the analysis. On a backend whose images have no `privateNote`, setting one is refused before anything is sent, and `previous` has none.

### 1.7 Opening a board in Moodboard Studio

`#moodboard/<id>` opens Moodboard Studio on that board (`frontend/src/hooks/useMoodboardDeepLink.ts`). The scope it opens with is a hint; the board's own `projectId` decides where the Studio and its rail land. While the Studio shows a saved board the hash names it (replaced in place, no history entries), and leaving the Studio clears it. Loading the app with the link goes into the open project; with none it waits on Projects. Double-clicking a Moodboard (or Character) node, double-clicking an item in the Assets panel, the node's Open button and the Studio's rail all open a board without changing the graph; only "Add to canvas" or a drag from the Assets panel adds a node.

### 1.8 Dry run

`POST /api/moodboards/{id}/analyze/dry-run` (`moodboard_analysis.dry_run`) runs the same analysis as Analyze and saves nothing: no board write, no `updatedAt` or `version` change, no broadcast. Anyone may call it, agents included. It returns:

| Key | Meaning |
|-----|---------|
| `dryRun`, `id`, `name` | `true`, and the board |
| `thresholds`, `defaults` | The thresholds used and the defaults |
| `saved` | `{analyzed, current}`: whether the board has a saved analysis and whether it still describes the board. When it is out of date, `changes` include edits to the board, not only the thresholds |
| `analysis` | The analysis it would save (1.3a) |
| `brief` | `compose` (1.2) with that analysis: what generators would get |
| `changes.palette`, `changes.accents` | `{before, after, added, removed, nudged, reordered, changed}`. `nudged` pairs a removed and an added colour within dE00 2 (`{from, to}`); `reordered` compares the colours on both lists |
| `changes.brief`, `changes.generatedBrief`, `changes.negativePrompt` | `{before, after, changed}` against the saved board's `brief` |

`thresholds` are Commons' measurement constants (`commons/measure.py`), for this call only: `accentMinChroma` (CIELAB chroma 0–150, default 40), `accentSeparation` (dE00 0–100, default 10) and `mergeDeltaE` (dE00 0–50, default 5; it also sets the board roll-up's merge). One left out or null keeps its default. Nothing saves custom thresholds, and Analyze always uses the defaults. The pinned-colour rule ("within dE00 5 of a kept-out colour") is not a threshold here.

It is a route of its own, not a flag on `/analyze`: an older backend ignores a body it doesn't know and would analyze and save; this route is missing there (404), and the CLI and MCP then say so rather than analyze.

`nebula moodboard analyze <board> --dry-run [--accent-min-chroma N --accent-separation N --merge-delta-e N] [--json]` and `moodboard_analyze(dry_run=True, accent_min_chroma=…, accent_separation=…, merge_delta_e=…)` call it; thresholds without the dry run are refused. `nebula moodboard show` prints each palette and accent colour with its share and source images (`#4 0.35%, #5 0.26%`: image number and the colour's share of it).

### 1.9 Projects: which project an asset is in

Moodboards, Characters and project Styles share one meaning of "project": a **canvas project** from the project catalog (`GET /api/projects`), never the backend's working folder. "This project" or "current" is the one open on the canvas (the catalog's `activeProjectId`).

- `GET /api/project` returns `{id, name}` of the open canvas project, or 404 `"No project is open."`. The app doesn't call it: it reads the open project from its own project store (`frontend/src/lib/currentProject.ts`), which the CLI's and MCP's `current` also resolve to.
- `POST /api/moodboards`, `POST /api/characters`, and `POST /api/presets` with `scope: "project"` take a `projectId` only if it's a canvas project: an unknown id is 422 (`"No project has the id '<id>'. Use the id of a project from GET /api/projects ..."`), a project in Recently deleted is 422 (`"The project “<name>” is in Recently deleted. Restore it first, ..."`), an unsafe id is 400. Leaving `projectId` out saves the asset as Global. Lists still take any safe id.
- An asset never refuses to work outside its project. A Moodboard or Character node names its asset by id, so a node copied, pasted or imported into another project shows the asset, runs, and opens the Studio on it. Saving it from there keeps its `projectId`: it stays where it lives.
- In the app the Project tabs (Assets panel, both Studio rails, the Styles library, Recently deleted, the node pickers) list the open project's assets and relist when the project changes or a `storedAssetChanged` event arrives. With no project open the Project tab says `"Open a project to see its moodboards."` (or Characters, Styles) and New is off. A Studio opened on an asset from another project lands on the Project tab with `"This board is in <name>."` (`"This Character is in <name>."`) above the open project's list (`frontend/src/lib/assetHome.ts`). A draft started in one project is never saved into another: the save is dropped if the open project changed.

**Re-home of old-style assets (every start; `backend/services/asset_project_rehome.py`).** Before this, project assets were filed under the working-folder project (`nebula_nodes`, `NEBULA_PROJECT_ID`, ...), which no canvas project could see, and an older build or the desktop app on the same `~/.nebula` can still write one. Every folder under the moodboard, Character and preset roots (each store's own `store_root()`) that isn't `_global`, a canvas project's id or a project in Recently deleted is old-style. Each asset in one is moved by use (Justin picked this rule on 2026-10-19):

| Asset | Goes to |
|-------|---------|
| A Moodboard or Character used by nodes in exactly one canvas project (saved snapshots, and the open canvas for the open project; trashed projects don't count) | That project |
| One used in no project, or in two or more | Global |
| A Style (preset) | Global |

Assets in Recently deleted move too (their trash record's `projectId` and `scopeDir` change, so a restore lands in the new place). Only `projectId` changes (and a preset's `scope`, to `global`). It runs on every start; a start with nothing old-style writes nothing. Each moved file is first copied to `<root>/../<kind>-backups/project-rehome-<UTC time>/`, with `migration-log.json` listing every asset, where it went and why. An id already present in the target is skipped and logged once: `<state dir>/migrations/asset-project-rehome.json` remembers each skip by path, size and mtime, so the same skip isn't logged again, a changed file is, and the move happens on the first start after the collision is gone. Nothing changes while the catalog can't be read, or while there are old-style assets and an open canvas but no projects yet. It never stops the backend from starting, and prints one line only when it moved something or found a new skip; `NEBULA_NO_ASSET_REHOME=1` turns it off. To undo a re-home, stop the backend, copy the backup folder's files back over the root, delete the moved copies the log names (`file`), and start with `NEBULA_NO_ASSET_REHOME=1` (otherwise it moves them again). `move_asset(kind, root, source, target)` in the same module moves one asset between scopes with the same checks.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-10-18 | Moodboard: brief fields, computed `brief`, override and Keep, migration |
| 2026-10-19 | Moodboard: `images[].privateNote`, `#moodboard/<id>` links, opening a board never edits the canvas |
| 2026-10-19 | Moodboard: brief fields and the computed brief from the CLI and MCP (1.6) |
| 2026-10-19 | Moodboard: colour sources in the analysis (1.3a, analysis version 4) and the dry run (1.8) |
| 2026-10-19 | Moodboards, Characters and Styles: "project" is the canvas project everywhere, create routes check it, re-home of old-style assets at every start (1.9), nodes copy between projects |
