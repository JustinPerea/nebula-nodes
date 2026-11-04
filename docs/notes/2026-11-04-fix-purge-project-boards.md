# 2026-11-04 fix/purge-project-boards (#228)

Justin's calls (2026-11-04):

- "Deleted for good" means gone. A project deleted for good (Delete forever,
  Empty on either route, or the 30-day expiry) takes its moodboards with it.
- Then: its Characters and project Styles go too, under the same rule.
- What main already moved to Global stays there.

## How assets belong to a project

All three stores (`moodboard_store`, `character_store`, `preset_store`) use the
same layout:

- `<root>/<projectId>/<id>.json`, where each file also carries its own
  `projectId`. Global assets live in `_global/`.
- Recently deleted is `<root>/.trash/<id>.json` plus a record
  (`projectId`, `scopeDir`) (`services/asset_trash.py`).
- Boards also have side files keyed by id: `.notes/<id>.json` (Updates). They
  are listed once in `moodboard_store.BOARD_SIDE_FOLDERS`.
- Images are `/api/outputs/...` files in the shared outputs folder.

**Surprise:** on main, every start treats a purged project's leftover
folder as an old-style folder. The re-home then moves its assets to Global, or
to the one live project that uses them.

## Decisions

- **One module for all three kinds:** `services/project_asset_purge.py`. It
  replaces the first version's `project_board_purge.py`, and the journal key is
  `assetPurges` (renamed from `boardPurges`, which was never on main).
- **What goes:** each asset in `<P>/` whose own `projectId` is P, and each
  trashed asset whose record names P (both `projectId` and `scopeDir`). A
  board's Updates go too, unless another copy of that board id is still on
  disk. A file that names another project, or can't be read, is left alone:
  only what provably belonged to P goes. The live check is repeated under the
  asset's own lock (`_board_lock`, `_char_lock`), so a move to Global that
  lands mid-purge keeps the asset.
- **Image files are never deleted.** The outputs folder is shared and nothing
  records who uses a file.
- **Crash safety, via a journal in the catalog:**
  1. The commit that drops P from the trash adds P to
     `catalog["assetPurges"]` in the same atomic write.
  2. The files are deleted after that commit.
  3. P comes off the list (a second commit) only after its files are gone in
     all three stores.
  
  A failed commit changes nothing. A failure after it leaves P on the list,
  and the next purge, project or trash listing, restore or start finishes the
  job. The route still answers 200 because its own change is saved. The
  start-up re-home treats ids on the list as project folders.
- **What a lookup answers:** 404 without `code`, the same as never existed.
  `storedAssetChanged` (`deleted: true`) goes out for each asset (kind
  `moodboard`, `character` or `style`) before `projectsChanged`. A style also
  journals `style.purged`, as a Style purged from Recently deleted does.
- **`goesWith` on each trashed project** (`GET /api/projects` `trash`,
  `GET /api/trash` project items, `DELETE /api/projects/{id}`
  `trashedProject`): the names of its `moodboards`, `characters` and
  `styles`, live and trashed, sorted. This is what the Projects screen's lines
  are built from. It is computed per listing, which means one folder read per
  trashed project per store.

## What can still name a deleted character, style or board by id

- **A Character or Moodboard node in another project's graph, or in run
  history.** Lists accept any id, so a node can point at an asset filed in
  another project. The asset goes anyway (deleted for good means gone). The
  card shows "#id was deleted for good or never existed", a run says "This
  node's character can't be found. It may have been deleted for good. Pick
  another character for this node." (boards likewise), and `edit_canvas`
  refuses to point a node at it. Tested (a character run after the purge).
- **Styles:** nothing stores a Style's id. Applying one copies its prompt and
  settings, and Cinema's look presets are built-in ids, not Styles.
- **Asset proposals:** only boards can have them (characters and styles are
  `LATER_KINDS`). A proposal on a purged board is invalidated on the next
  sweep (`_sweep_asset_proposals`).
- **Commons** imports board images by url, not by board id.

## The one-time sweep (please read, Justin)

Once per install, at start-up before the re-home, it deletes what earlier
purges left behind, since the last start. That covers all three stores, under
the same rules. Proof rules:

1. the catalog exists and reads;
2. the catalog has at least one project, live or trashed;
3. the store root sits with the catalog's state folder (`~/.nebula/<store>`,
   or the desktop app's `<data>/state` beside `<data>/<store>`), checked per
   store, so one unpaired store is skipped and the others still run;
4. the folder name is a 32-hex catalog id;
5. the asset names that project itself.

It logs counts only ("Left by projects deleted for good earlier: N
moodboards, N characters, N styles removed") and writes
`<state>/migrations/purged-project-assets.json`. What earlier starts moved to
Global stays there (Justin, 2026-11-04).

Residual risk: if catalog.json were replaced by a different catalog that has
projects, while the roots stay paired, the old projects' files would count as
orphans.

## Copy (agreed with design)

- Trash note: "Deleted projects stay here for 30 days. Deleting one for good
  also deletes its moodboards, characters and styles. Generated files stay in
  your outputs folder."
- Delete forever: a line before "This can’t be undone." (`deleteForeverLine`,
  `frontend/src/lib/projectPurgeCopy.ts`):
  - one kind: names, one to three, then a count from 4;
  - two or three kinds: counts only;
  - none of the three: no line.
- Empty: a line after its heading, naming the kinds present, without counts
  (`emptyTrashLine`).
- The kinds always come in the order moodboards, characters, styles, with no
  serial comma. The headings are unchanged.
- An older backend sends no `goesWith`, so no line is shown.

## Not changed

- `services/person_gate.py` is byte-identical to main, so the person-only
  gating is unchanged.
- #210 needs no change: a purged board reads as `missing` in its re-check
  effect.
- A board restored from its own trash into a project that is itself in
  Recently deleted shows an outdated `goesWith` until the list is fetched
  again. That only affects the line's names, not what goes.
