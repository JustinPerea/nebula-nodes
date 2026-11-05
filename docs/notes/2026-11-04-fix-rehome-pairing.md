# fix/rehome-pairing (2026-11-04)

Gates the start-up re-home with the purge's pairing rule and closes the four LOWs and the NIT left from the review of the purge PR.

## Decisions not in the spec

- One rule, one function. `asset_project_rehome` imports `roots_paired` from `project_asset_purge` and calls it per root. `AssetRoot` gained `explicit` (default False; `default_roots()` fills it from the same NEBULA_*_ROOT check the purge uses). Tests that build `AssetRoot`s by hand in the desktop layout now pass `explicit=True`.
- An unpaired root is only listed, never read for a move or written. The start logs how many old-style assets it left, once per kind, with no path; zero means no line.
- B: any link in a paired store (its `.trash`, a side folder, `<root>/P`) keeps the id listed. This includes a side folder, which the re-home never reads: the brief said "any part", and the cost of a permanently linked `.notes` is one log line per start.
- C: evidence a folder is the store = a real (non-link) folder inside it. The stores only put folders at their root, so a stray `.DS_Store` doesn't count. Evidence is taken before the pass; the purge then makes the stores' own `_global` folder so a store emptied by its last purge keeps showing evidence (a crash before the id is cleared would otherwise leave the id listed for good). A root that doesn't exist at all is done (nothing can be there). An entirely empty store keeps the id listed until it holds a folder; nothing is lost by that.
- E: bind mounts. The brief's check (stat of the store's parent against the catalog's folder) cannot differ when the resolved paths are already equal, so it is kept as a cheap second check but is not what catches anything. What can be seen from Python is a store on another device than its folder (container volume, FUSE, any mount of another filesystem); that check is added. A same-filesystem Linux bind mount is invisible without parsing /proc/self/mountinfo and is not caught: documented in the docstring, not claimed. Side effect: a disk mounted on the store folder is unpaired, the same accepted cost as a store linked on its own.
- D: no `nebula doctor` exists, and `/api/health` is a hot, shape-pinned probe, so no surface was added. The stray catalog is logged once per start with the action ("remove it by hand"), no path, and never deleted. Agents can't read the log; if a health surface for the person appears, it should read `_pairing(...) == "another catalog"`.
- F: `goes_with_project(kind, record, purging)` and `purging_trash_kinds(state_dir)` replace the inline check in `GET /api/trash`.

## Surprises

- A test file imports nothing from the real home: every new test sets HOME and the roots under `tmp_path`.
- The brief's "a store is paired only when explicit" case (desktop layout) needed `explicit` threaded through `AssetRoot`; without it every desktop re-home would have stopped.

## Mutation check

31 mutants over the guards (script: scratchpad `rg-mutate.py`); all killed. Equivalent survivors: none. The first run had two survivors (a link counted as evidence; the evidence read per id rather than up front), both closed with tests.

## Round 2 (the final review's two MEDIUMs and a NIT)

- MEDIUM-1: `_legacy_trash` followed a linked `.trash`, so a copy's re-home rewrote the real person's trash records (and wrote the backup in the copy). It now calls the purge's own `_linked` (no second check) and skips a linked `.trash`. Project folders were already skipped (`_legacy_folders`); the re-home never reads side folders (they are hidden, `.notes` and the like). Test: the reviewer's p1, real `.trash` byte-identical and no backup or log anywhere; a second test pins that the re-home goes through `_linked`.
- MEDIUM-2, decision (a) to (d):
  - (a) `desktop/paths.mjs` `ensureAppDataDirs` makes `characters/_global`, `moodboards/_global` and `presets/_global` with the stores (`APP_DATA_STORE_SUBDIRS`, `STORE_GLOBAL_DIR`); `node --test` on `path-migration.test.mjs` pins it, and a Python test reads `paths.mjs` so the layout the backend test assumes can't drift. The backend has no mkdir of a bare store root: each store's root appears only with a write (`scope_dir.mkdir(parents=True)` of `_global` or a project folder, or the trash's `.trash`), all real folders. So no backend creator needed a change; a parametrized test (3 kinds, global and project scope) pins that a save into a missing store makes evidence.
  - (b) An existing empty root with no `_global` stays unproven (ids stay pending, boards could only reach Global, never be deleted). Test: it clears after the first save into each of the three stores.
  - (c) `finish` decides pairing (`paired_stores`) and evidence once, passes both to `delete_project_assets` (new `split` argument), and an unproven store is skipped outright (no `delete_store_assets`, `_left`, `_linked`, no `roots_paired` per id). The other stores are still purged for the id as before, so a deleted project's moodboards go even while the character store is unproven. Test counts calls with monkeypatches: evidence 3 calls, pairing 3 calls for 20 ids, zero scans of the unproven store, and a second `finish` adds none for it.
  - (d) The false "(a disk that isn't mounted?)" is gone. One line per start, only when an unproven store holds waiting ids: `%d project(s) deleted for good keep their %s until that folder holds something Nebula saved` (counts and kinds only).
- NIT: the inode comparison could never fire (`home == expected` by then) and is removed with its test; the device check stays. `_ident` and the docstrings say it catches a store mounted on its folder and can't catch a same-filesystem bind mount. Round 1's note above that says the stat of the parent "is kept as a cheap second check" is out of date.
- Not touched: LOW-1 (the desktop migration's copied boards going to Global) belongs to the deferred desktop pass; NIT-2 (a case mismatch reads as unpaired) fails safe.
- Mutation check (round 2): no link guard, unproven store scanned, pairing per id, the old guessing warning, and the desktop `_global` creation each fail a named test (desktop: 5 failures in `path-migration.test.mjs`, 1 in the Python pin).

## After round 2 (coordinator)
- The re-home never writes into a linked destination either. A linked `_global` or project folder in a paired store is skipped with "not moved: its destination is a link", so a copy's old board can't land in the real store (round 2 check, probes p6 and p7).
- The desktop app's `_global` marker is best-effort. A store folder Nebula can't write, such as a read-only link or volume, no longer stops the launch; that store stays unproven.
- The purge docstring now says what the desktop app does. Its launch makes `_global` in its own stores, so an empty desktop store counts as proven. The device check still keeps a remounted disk's boards where they are.
- A root whose `<kind>-backups` folder is a link is left alone, logged once. Otherwise its backups and the run log would be written through the link (round 3 check, LOW-1).
- A destination file that is itself a link is never moved onto. Otherwise a link already holding the moved content would read as "finished", and the copy's own board would be dropped, leaving only a link into another store (round 3 check, LOW-2).
