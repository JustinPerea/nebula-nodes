# 2026-11-04 fix/purge-project-boards

Justin's call (2026-11-04): "Deleted for good" means gone. A project deleted
for good (Delete forever, Empty on either route, or the 30-day expiry) takes its
moodboards with it.

## How boards belong to a project

- `<board root>/<projectId>/<id>.json`, each with its own `projectId` field;
  `_global/` for Global boards.
- A deleted board sits in `<board root>/.trash/<id>.json` with a record
  (`projectId`, `scopeDir`).
- Side files by board id: `.notes/<id>.json` (Updates). Now listed once in
  `moodboard_store.BOARD_SIDE_FOLDERS`, which both a single board's purge and
  this purge use.
- Board images are `/api/outputs/...` files in the shared outputs folder.

## Decisions

- **What goes:** each board in `<P>/` whose own `projectId` is P, each trashed
  board whose record says P (both `projectId` and `scopeDir`), and their
  `.notes` file unless another copy of that board id is still on disk (a
  re-home collision can leave one; notes are kept by id). A board in `<P>/` that
  names another project, or can't be read, is left alone (provable only).
- **Images are not deleted.** The outputs folder is shared by canvases, run
  history, other boards, Characters, Styles and Commons, and nothing records who
  uses a file, so "nothing else references it" can't be proven. The single-board
  Delete forever never deleted images either, and the Projects screen already
  says "Generated files stay in your outputs folder either way."
- **Crash safety: a journal in the catalog.** The commit that drops P from the
  trash also adds P to `catalog["boardPurges"]` in the same atomic write.
  Boards are deleted only after that commit, and P comes off the list (a second
  commit) only after its boards are gone. If the commit fails, nothing changes.
  If it stops after the commit, the next purge, project listing, trash listing,
  restore or start finishes the job (`main._purge_noted_boards`). The route still
  answers 200 because its own change is saved; the failure is logged.
- **The re-home skips listed ids.** `asset_project_rehome` treats any folder
  that isn't a catalog project as old-style and moves its boards to Global or a
  using project. Without this exclusion, a purge that stopped part way would be
  "rescued" at the next start.
- **Answer shape:** a purged board answers `GET /api/moodboards/{id}` with 404
  and no `code`, exactly like a board that never existed. `storedAssetChanged`
  (`deleted: true`) goes out for each board before `projectsChanged`.
- **Characters and project Styles are not touched**; they weren't in the call.

## The one-time sweep (please read, Justin)

Purges before this change left boards behind. Once per install, at start-up
(before the re-home), boards whose project is in neither the catalog nor its
trash nor `boardPurges` are deleted under the same rules. It runs only when all
of these hold:

1. the catalog file exists and reads;
2. the catalog has at least one project, live or trashed (so a fresh or reset
   catalog never sweeps);
3. the board root is paired with the state folder: `~/.nebula/moodboards` next
   to `~/.nebula`, or the desktop layout `<data>/state` + `<data>/moodboards`.
   This keeps a backend pointed at another catalog with the real HOME from
   wiping the person's boards;
4. the folder name is a catalog id (32 hex), so old-style folders like
   `nebula_nodes` are left to the re-home;
5. the board names that project itself.

It logs `Boards left by projects deleted for good earlier: N removed` at info
(never a name) and writes `<state>/migrations/purged-project-boards.json`.

**Surprise:** on main, every start re-homes a purged project's boards to Global
(or to the one live project that uses them), because its folder looks old-style.
So on any install that restarted after a purge, those boards already live in
Global and the sweep can't tell them apart. The sweep only catches purges since
the last start. I left the re-homed ones alone because they're live Global boards
now and may have been edited. The re-home's `moodboard-backups/project-rehome-*/
migration-log.json` lists them (`from` = the purged id) if you want them gone too.

Residual risk: if catalog.json were replaced by a different catalog that has
projects, while the board root stays paired, the old projects' boards would
count as orphans. Before this change the re-home would have moved them to Global.

## Not changed

- `services/person_gate.py` is untouched; the purge routes stay person-only.
- Frontend: no change. The Projects copy ("This can't be undone.", "Delete all
  N projects for good?") doesn't list what goes. A line for GM is in the PR body.
- #210 needs no change: a purged board reads `missing` in its re-check effect.
