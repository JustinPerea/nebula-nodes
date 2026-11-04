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
