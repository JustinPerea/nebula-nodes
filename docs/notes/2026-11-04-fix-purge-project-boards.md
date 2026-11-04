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
  only what provably belonged to P goes. Each file and trash record is read
  again under the asset's own lock (`_board_lock`, `_char_lock`,
  `_preset_lock`), which each store also holds while it updates, moves,
  trashes, restores or purges that id, so the purge only removes what still
  names P at that moment (see Round 3).
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
  are built from. It is computed once per listing: each store's trash is read
  once for every trashed project, plus each project's own folder.

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

## Projects deleted for good before this change

There is no sweep. An asset filed under a project id the catalog doesn't know
is left to the start-up re-home, which moves it to Global with a backup, as on
main. Only ids this catalog put on its own `assetPurges` list are ever
deleted. Accepted gap: a project deleted for good on main before upgrading has
its leftovers moved to Global, not deleted (consistent with Justin's call that
what main moved to Global stays there).

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
  (`emptyTrashLine`); "Its … are deleted with it." when one project is in
  Recently deleted.
- A moodboard, character or style with no name reads “Untitled”. When any two
  names in a kind match (several “Untitled” too), the line gives that kind's
  count instead of names.
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

## Round 3 (review 1)

- **No start-up sweep.** The first version deleted, once per install, every
  asset filed under a 32-hex id absent from the catalog. On a desktop install
  that is every migrated project asset: the migration copies the stores but
  not `projects/`, the first listing files the open canvas as "Recovered
  canvas", and the next start found every proof rule true. Dropped entirely
  (`sweep_orphans`, `orphaned_project_ids`, the marker file, the sweep half of
  the start-up hook). The start-up hook now only finishes ids on the list.
  Test: the desktop sequence (no catalog, then "Recovered canvas", then a
  second start) deletes nothing and moves all three kinds to Global with
  backups.
- **One pairing rule for every purge and replay.** `finish` skips a store
  whose root isn't beside the catalog's folder
  (`roots_paired(project_store.root.parent, store.root)`), keeps the id on the
  list for it, and logs a count once per start, never a name. Without it, a
  backend on a copy of the catalog (`NEBULA_STATE_DIR` set, `HOME` left real)
  would have deleted the person's boards for a project their own catalog
  still has, on Delete forever or simply on the 30-day expiry during a
  listing. `assetPurges` stays a plain list of ids, and the re-home still
  skips every id on it. `goesWith` lists only what a paired store holds.
  Not built: an allowance for stores set explicitly with `NEBULA_*_ROOT` away
  from the catalog. Such a store keeps its files (and the id stays listed);
  it can be added if anyone runs that way.
  Test: a copied catalog with default roots, then the expiry on a listing,
  leaves the real stores untouched, lists nothing in `goesWith`, logs once.
- **Locks.** Each store now holds the asset's lock while it updates, moves,
  trashes, restores or purges it (`preset_store` gained `_preset_lock`). The
  trash pass reads the record again under the lock and needs it to still name
  P, with its file still there. A move to Global writes `_global/<id>.json`
  and then unlinks the old file under the same lock, so the purge either finds
  the file still P's or doesn't find it.
- **Passes.** Live first, then the trash, again until a round finds nothing
  (at most 3), so a board moved to Recently deleted, or restored, between two
  passes still goes.
- **`goesWith`** is computed once per listing (`goes_with`), not one trash
  scan per project per store.
- **Projects screen.** Delete forever's armed confirm takes its own
  full-width row under the name, the date line and Restore: the line, then
  "This can’t be undone.", wrapping as needed, with Cancel and Delete forever
  right-aligned after it, or on their own line when the text needs the width.
  The name stays on one line (ellipsis) and the date line never wraps. The row
  opens on the layout spring (360 ms sampled spring, as the Inspector's) and
  closes back on Cancel; under reduced motion it jumps. Focus goes to Cancel
  on arm and back to the trigger on Cancel or Escape.
- **Focus after a purge** goes to the next row's Restore (the row before when
  it was the last), else the Recently deleted heading, else "Recent
  projects"; before, it fell to the page.
- **`nebula trash list`** names only the kinds a project has ("removed for
  good with its moodboards and styles after …") and has no "with its …" when
  it has none.
- Mutation check: every deletion guard and lock, 46 mutants; the one
  survivor (live pass before trash pass) is equivalent now that the passes
  repeat until a round finds nothing.

## Round 4 (review 2)

- **The desktop allowance needs explicit roots.** `roots_paired` counted any
  store whose folder sat beside a catalog folder named `state` as paired. A
  half-isolated backend with `NEBULA_STATE_DIR=~/.nebula/state` (a copied
  catalog) and default store roots therefore paired with the person's real
  `~/.nebula/moodboards`, characters and presets, and Delete forever, Empty
  or the expiry on a listing would have deleted them. The side-by-side case
  now applies only when the store's own `NEBULA_*_ROOT` is set
  (`AssetStore.explicit`, read in `default_stores`; the desktop sidecar sets
  all three, `desktop/paths.mjs`). A root at its `~/.nebula` default pairs
  only with `~/.nebula` itself.
- **Real folders on both sides.** Pairing compares the resolved catalog
  folder with the resolved folder the store's entry sits in
  (`store_root.parent.resolve()`), not the parent of the resolved store. A
  `~/.nebula/moodboards` that is a symlink to another disk now pairs and is
  purged like any other store; before, it was never paired, so a purged
  project's boards stayed in its folder with no project and nothing listing
  them. A catalog reached through a symlinked `~/.nebula` pairs too.
- **Symlink loops.** `Path.resolve()` raises `RuntimeError` on a loop in
  Python 3.12, which `roots_paired` didn't catch, so `GET /api/projects`,
  `GET /api/trash` and the purge routes returned 500. It now catches
  `(OSError, RuntimeError)`, treats the store as unpaired (the id stays
  listed) and logs once per start, with no path.
- **Leftovers keep the id listed.** When the last of the 3 passes still
  found something (a store busy the whole purge), the id was cleared and the
  rest was moved to Global at the next start. `delete_project_assets` now
  checks what is left of the project's, live or trashed, in every paired
  store after the passes; anything left keeps the id on the list for the
  next purge, listing or start.
- **Focus after a failed purge.** The `afterPurge` target was kept after a
  failed request, so a later expiry or another tab's purge moved focus.
  It is now dropped when `busy` comes and goes with the rows still there.
- **Empty with one project** confirms with "Delete forever", as the row
  does; with two or more it stays "Delete all" (GM r102).
- **One space after "for good?".** Empty's question and line were two spans
  laid out 6 px apart by the confirm's gap, and the DOM text had no space.
  They are now one text joined by a single space, the same as the
  `aria-label` (GM r102).
- **`nebula trash list`.** A trashed moodboard, character or style filed
  under a project now ends ", removed for good with its project", plus
  " after <date>" when that project is in the same listing. The MCP
  `list_trash` docstring and MCP-SETUP say the same.
- **Guards pinned.** Six guards survived review 2's mutation run; each now
  has a test: an unresolvable root is unpaired (the loop test), paths are
  compared resolved (a symlinked `~/.nebula`), one failing id doesn't hold up
  the others (an `OSError` on one asset), a malformed `assetPurges` entry is
  ignored, and a file in a project folder or the trash whose name isn't an
  asset id is left.
- The `agentPresenceFollowups` ratchet now expects three red "Delete forever"
  controls in `ProjectHome.tsx` (the row's trigger and confirm, and Empty's
  confirm with one project).

## Round 5 (review 3)

- **Pairing by real location only.** Round 4 compared the folder a store's
  link sits in, so an isolated backend (temp HOME, copied catalog) whose
  `.nebula/moodboards` linked to the person's real store paired with the
  copy, and Delete forever, Empty or the expiry on a listing deleted the real
  boards, trashed boards and `.notes` of a project the real catalog still
  had. `roots_paired` now follows the store to its real folder and requires
  that folder's parent to be the catalog's real folder (or, for an explicit
  root, the desktop data folder holding `state/`). The decision for this
  round (coordinator, 2026-11-04) accepts the cost: a store folder linked on
  its own to another disk keeps a purged project's files, logged; linking the
  whole `~/.nebula` or desktop data folder still purges.
- **No fallback to Global.** An unpaired store deletes nothing and keeps the
  id on `assetPurges`, so the re-home keeps skipping it. Moving its files to
  Global was considered and refuted: the re-home has no pairing check, so a
  copy's purge would move the real project's boards.
- **Another catalog beside the store.** A store whose real parent holds a
  `projects/catalog.json` or `state/projects/catalog.json` that isn't this
  catalog's is never paired. Closes `NEBULA_STATE_DIR=~/.nebula/state` with
  all three roots set to `~/.nebula/*` (the explicit allowance would have
  paired it) and the mirror, a copy at `<data>/projects` beside
  `<data>/state/projects`.
- **Dangling links and loops.** A store root that is a link but not a
  directory (an unmounted disk, a link to itself) is unpaired before
  anything is resolved, so the result doesn't depend on how a Python version
  reports a loop. The id stays listed, and when the disk comes back the
  store is still linked on its own, so its boards never reach Global.
- **Links inside a paired store.** A `.trash` or side folder (`.notes`)
  that is a link is never followed, as a linked `<root>/P` already wasn't.
- **The CLI's "removed for good with its project".** `GET /api/trash` now
  sets `goesWithProject: true` on a trashed moodboard, character or style
  deleted from its project's own folder (`scopeDir == projectId`) in a store
  paired with the catalog; `nebula trash list` adds the clause only for
  those and says nothing otherwise (an older backend sends no flag).
  `list_trash` and MCP-SETUP name the flag.
- **Review 3's five surviving mutants** each have a test: an id on the list
  that is back in Recently deleted, two ids through `_purge_noted_assets`
  with one unfinished, a `*.json.tmp` behind a linked project folder, the
  root setting read per kind, and the trashed file removed before its
  record.
- **Follow-up (not in this PR).** Main's start-up re-home should be gated
  with the same `roots_paired`: today a half-isolated copy re-homes the real
  projects missing from the copy to Global.
