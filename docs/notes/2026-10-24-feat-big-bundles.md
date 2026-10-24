# 2026-10-24 — Bundles with a graph over 16 MiB open and save (Q121 a)

Branch `feat/big-bundles`, from main at df4ac48e (#182 merged).

Justin, Q121 (option a), verbatim: "Bundles work like plain files: Load graph opens a bundle whose graph is over 16 MiB as a new project, up to the bundle limit, and Save graph can write a bundle for a project over the limit."

## What changed and why

- **The restore's graph limit is the bundle's ceiling.** `RESTORE_MAX_GRAPH_BYTES` (backend/main.py) goes from 16 MiB to 528 MiB, the frontend's `GRAPH_BUNDLE_MAX_IMPORT_BYTES` (512 MiB of files plus 16 MiB), which is also what a plain `.nebula` opens up to since Q118. The restore only bounds and validates the bundle. The save limit stays the import's to check: Load graph's flagged import (Q120) refuses a graph over the limit on its own, and the tab opens it as a new project named after the file. So nothing in Load graph's frontend changed; a bundle's graph took the plain file's path once the restore let it through.
- **Save graph writes a bundle for a project over the limit.** `saveToFile` refused a graph.json over 16 MiB (`GRAPH_JSON_MAX_IMPORT_BYTES`). It now refuses only a graph past the bundle's ceiling, before any asset is fetched; the whole bundle's existing ceiling check after the zip is built stays. `GRAPH_JSON_MAX_IMPORT_BYTES` is gone: a graph's size has no limit of its own any more, only the shape walk's counts (10,000 nodes, 50,000 wires, depth 64, 1,000,000 values), which stay.
- **`nebula load` on a bundle says where bundles open.** It read the file as text and stopped with a UnicodeDecodeError traceback. It now checks the zip signature and says: "`nebula load` reads plain .nebula files. Ask the person to open it with Load graph on the canvas." skills/nebula/SKILL.md says the same.

## Decisions not in the spec

- **"Download a copy" stays a plain `.nebula`.** My Q121 page said Save graph *and* Download a copy could write a bundle; Justin's option names Save graph. The copy is the over-limit panel's safety net: it must write whatever happens. A bundle can refuse (past the ceiling) or skip files whose fetch fails, and the copy's images are still in output/ on this machine, where its links point. Save graph, in the same menu, now writes the bundle when you want the images inside the file.
- **Agents still can't open a bundle.** The restore route isn't person-only, but neither MCP nor the CLI has ever opened one: the canvas rewrites the restored files' links (`rewriteAssetUrls`), and an agent path would need that rewrite in Python. That's a new feature, not this change, so it's an open item rather than built here. Agents build graphs with `nebula apply` and make new projects with `new_project`.
- **Memory.** A 528 MiB graph.json is read whole and parsed, as a 528 MiB plain `.nebula` already is by `/api/graph/import`. The shape walk's value cap bounds how many objects it can hold.

## Tests (failed first)

- backend/tests/test_cli_api.py `test_restore_opens_a_bundle_whose_graph_is_over_the_save_limit`: a STORED bundle with a 16 MiB + 1 text value and one asset. Failed first with 413 "graph.json is too large"; passes with the graph and the asset's mapping. It also pins the limit at 528 MiB. The existing over-limit test (limit patched to 64 bytes) still pins the 413.
- backend/tests/test_graph_file_access.py `test_cli_load_of_a_bundle_says_where_bundles_open`: failed first with UnicodeDecodeError; passes with exit 1, the line, and no backend call.
- frontend/tests/graphFile.test.ts: "saves a bundle whose graph is over the 16 MiB save limit" (failed first: null) and "refuses a graph past the bundle ceiling before asset fetch or compression" (failed first: the old "up to 16 MB" line). The plain-file Q118 tests now build their 16 MiB values from `PROJECT_SAVE_LIMIT_BYTES`.
- frontend/tests/graphFile.unsavedEdits.test.ts: the re-export check names `GRAPH_BUNDLE_MAX_IMPORT_BYTES`.

## Review and live check

- One adversarial review with a live check (isolated backend 8796 and Vite 5796, person link, 1280x800; one blocked request, the reviewer's own probe of 8000): PASS, no high or medium findings. Live: an 18 MB bundle opened as a new project "Big bundle" with "Saving paused · 17.3 MB" and GM's line, its picture restored (200), and "Open one" kept only its Text node. Save graph wrote an 18 MB stored bundle with the picture, and Load graph opened that as another new project.
- **Fixed from the review: Save graph named every bundle "Untitled Graph.nebula.zip".** With Q120 naming the new project after the file, a save and reopen came back as "Untitled Graph". `saveToFile` takes the open project's name now: the file is `projectFileName(name)` + `.zip` (the same safe name "Download a copy" uses) and graph.json's `name` is the project's. With no project open it's "Untitled Graph", as before. Tests in graphFile.test.ts and GraphFileActions.test.tsx failed first.
- Memory measured by the reviewer: a 256 MiB graph grew the backend by about 550 MiB through the restore and its answer (about 2.1 times the graph), so about 1.1 GiB at the ceiling. A bundle parses the graph twice (restore, then import); a plain file once.

## Open items

- Agents can't open a `.nebula.zip` (above). Ask Justin before building it.
- **The browser's real ceiling is about 512 MiB, not 528.** Chrome caps a string at 536,870,888 characters, so `JSON.stringify` of a graph past that fails with the generic save line, not the "up to 528 MB" one; reading a restore answer or a plain file that large hits the same cap (since Q118). The ceiling's copy would need GM.
- Each save and reopen nests the restored files one folder deeper (`restored-x/.../restored-y/...`), toward the 1,024-byte path limit. Older than this change.
