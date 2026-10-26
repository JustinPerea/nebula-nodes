# 2026-10-24 — Agents open bundles: `nebula load` and `load_graph_file` (Q123 a)

Branch `feat/agent-open-bundle`, from main at 8246211f (#160 merged).

Justin, verbatim: "Q122 a) Keep the copy a plain .nebula. Save graph is there when you want the images inside." and "Q123 a) Yes: `nebula load` and an MCP tool open a bundle, restoring its files, as Load graph does. A big one opens as a new project."

## What changed and why

- **The canvas's link rewrite has a backend port.** New `backend/services/graph_file_links.py` ports `rewriteAssetUrls`, `parseLocalOutputReference`, `canonicalPortableOutputRelativePath` and `validatedRestoreMapping` from `frontend/src/lib/graphFile.ts`. It also ports a strict subset of `sanitizeImportedSpatialOutputs`. The restore preflight's component check (`_decoded_portable_component`) moved into this module. main.py now wraps it as a 400, so the restore and the link reader share one rule instead of keeping a third copy.
- **The restore takes `rewriteLinks=true`.** `POST /api/outputs/restore?rewriteLinks=true` answers with the graph already rewritten to the restored files, plus `warnings` (the canvas's own lines). Without the flag the answer is unchanged (`graph` and `urlMapping`), so the person's Load graph is untouched.
- **One client module for the CLI and MCP.** New `backend/graph_file_client.py` does the following:
  - Applies upload_file's path rules through `upload_client._local_path`, which is now parametrized on the error class.
  - Streams a zip in 1 MiB chunks to the restore with the agent's own headers: `X-Nebula-Agent`, or `X-Nebula-Client: nebula-cli`. A person token is never sent.
  - Converts canvas-shaped nodes to the import body the tab sends.
  - Applies Q120's rule: it imports with `refuseOverSaveLimit`. On a 413 with `limit: "size"`, it creates a project named by `project_name_for_file`, a Python port of `projectNameForFile`, then imports there.
  - Returns what happened: project, openedAsNewProject, previousProject, counts, filesRestored, warnings, savingPaused, size and a note.
- **`nebula load` uses it.** It replaces #184's refusal ("Ask the person to open it with Load graph").
- **New MCP tool `load_graph_file(path)`.** It is marked destructive (it replaces the open canvas when the file fits) and listed in `NEBULA_MCP_TOOLS`.
- **A file over the limit can open into an empty new project.** The import takes a new `newProjectForFile` flag. It skips the agent growth guard (Q118), but only when the canvas is empty: a canvas with nodes gets a 409. The on-its-own 413 now carries `scope: "graph"`, so the client can tell "this file is over" apart from "this would push the open project over".
- **Agent docs.** These were updated: docs/MCP-SETUP.md (the tool, the CLI line, a `nebula load` paragraph, and the newProjectForFile exception in the project_size bullet), skills/nebula/SKILL.md ("Save and load"), and the `nebula load` help. INSTRUCTIONS is unchanged: it is at 2999/3000 characters and doesn't list every tool (upload_file isn't there either).

## Decisions

- **The restore runs before any project is created.** A refused zip leaves nothing behind: no project and no restore folder.
- **The open project is never emptied or overwritten when a file is over the limit.** The refusal is checked before the import changes anything. The new project is made from a fresh listing with `workspaceRevision`.
- **The tab is not changed.** The live check showed it already follows an agent to the new project and shows the Q118 paused state. No new person-facing copy was written.
- **Notes are worded per caller.** Through the CLI, the note names `nebula project size`, `nebula apply`/`nebula delete` and `nebula project open <id>`. Through MCP, it names project_size, edit_canvas/remove_from_canvas and open_project('<id>').
- **The parity fixture is generated from the TS functions.** `backend/tests/fixtures/graph_file_links_cases.json` is read by pytest (`test_graph_file_links.py`) and vitest (`graphFileLinksParity.test.ts`). The vitest side calls the canvas's own functions through a new test-only export, `graphFileLinksForTests`, which adds no behaviour.

## Tradeoffs

- **The spatial check drops at least what the canvas drops (after review).** The full World/spatial parsers weren't ported. The canvas rebuilds each value from its known fields; the backend instead drops the whole output when it isn't an object, when a World slot the canvas checks holds an outside asset, when a spatial `uri` isn't a relative `/api/outputs/` path, or when any string anywhere in the value is a link (a fetchable scheme such as https/data/blob/javascript, or a leading `/`) that isn't a Nebula output or, for a World, its worldlabs.ai page. Plain text such as a caption "Scene: dusk" is not a link. So it can drop an output the canvas keeps (a World with an outside link in a field the canvas rebuilds away), never keep one it drops. The shared fixture's `spatial` cases pin both sides.
- **The URL parsing is a WHATWG subset in Python.** It covers special schemes, backslashes, the IPv4 parser, percent-decoded hosts, UTS #46 host mapping (the `idna` package, now pinned in requirements.txt at the 3.11 already installed through httpx/anyio) and dot segments. Where the idna package is stricter than a browser (its hyphen and empty-label checks), the host fails to parse, which is the canvas's "not a link" too; a host that maps to plain ASCII skips those checks, so a local host can't be misread.
- **A bundle's graph is parsed twice:** once by the restore and once by the client's shape check. This costs time on a 500 MB bundle but keeps one refusal path.

## Surprises

- **npx downloaded a package.** The worktree had no `frontend/node_modules`, so `npx vitest` downloaded vitest@5.0.5 into `~/.npm/_npx/69c381f8ad94b576`. I deleted it, APFS-cloned node_modules from the main checkout (`cp -cR`, identical lockfile), and from then on ran `node_modules/.bin/*` directly. Nothing was installed into the repo.
- **The fixture caught three places where I'd guessed the canvas wrong.** `A%2541.png` stays as is. `http://localhost/api/outputs/x\y.spz` is a safe World URL. A mapping error's message is the GM line, so the tests compare `.detail`.
- **Going back from a paused, unsaved project shows #178's screen.** When the agent called open_project to return to the previous project, the tab showed "These edits are too large for Nebula to save…" with "Continue without them". This is existing Q118 behaviour, and the new project kept its file.

## Tests

- **TDD reds came first:**
  - vitest failed with the missing export.
  - pytest failed with no `services.graph_file_links` and no `graph_file_client`.
  - The client tests went 25 failed, 1 passed: the agent import with the flag got 413 instead of 200, a canvas with nodes got 200 instead of 409, and there was a KeyError on `scope`.
- **Final gates:**
  - Focused pytest via iso.sh: 663 passed, 9 skipped.
  - vitest (graphFileLinksParity, graphFile, GraphFileActions): 239 passed.
  - `tsc -b`: rc 0. lint: rc 0.
  - vite build + budget: 379,873 bytes raw / 114,633 gzip, under 512,000. dist/ deleted.

## Live check

- **Setup:** isolated backend on 8797 and Vite on 5797, Puppeteer at 1280x800 and 1440x900, ports 8000-8010 and 5173 blocked, a real MCP stdio client using an app token from Settings, and the real `nebula` CLI.
- **Result:** 36 passed, 0 failed, 0 blocked requests, no page errors.
- **(a) Small bundle into "Glass campaign":** the canvas was replaced with 2 nodes, 1 connection and 1 file. The picture loaded from the restored file with a 200, and the tab saved.
- **(b) 17 MB bundle:** it opened as a new project, "Big campaign", in 4.7 s. The tab followed it and showed:
  - "Saving paused · 17.1 MB" in the header.
  - "Saving paused. This project is 17.1 MB, over the 16 MB limit." with See what's large.
  - The toast "Claude Code made and opened “Big campaign”." with Back.

  There were 0 PUTs to the paused project, Glass was unchanged, and project_size read it as paused.
- **(c) `nebula load` of a 17 MB plain file:** it made "Huge notes", paused, with the CLI-worded note. Glass was unchanged.
- **(d) Refusals:** these were refused cleanly through the CLI and MCP: a protected token file, a protected folder, and a zip without graph.json. No restore folder was left, and no token appeared in agent output.

## Review

- **Two confirmed findings fixed, tests first.** (1) The World/spatial check kept outside links off the slots it read (a DepthMap `preview`, a World's `assets.extra` or `caption`), which the canvas's Load graph drops; it now walks every string (see Tradeoffs). The canvas's own World warnings are matched too: a World dropped for an outside slot also counts as an invalid World, as the canvas's parser rejects it. (2) Non-ASCII hosts used Python's IDNA 2003 codec, so `http://🄻🄾🄲🄰🄻🄷🄾🅂🅃:8000/api/outputs/a.png` (squared letters a browser maps to localhost) read as "not local" and skipped the rewrite; `_domain_host` now maps hosts with UTS #46 (`idna.uts46_remap`, non-transitional, no STD3), as the browser does.
- **Red first:** the new shared cases failed 11 pytest cases (4 link spellings, 2 World URLs, 4 spatial cases, and the old World test's warnings) and 5 vitest cases (`sanitizeImportedSpatialOutputs` not exported); the TS link and World-URL cases passed at once, confirming the canvas reference. After: 179 pytest, 171 vitest in the parity pair.
- **Shared fixture:** new `spatial` section with what the canvas keeps (vitest runs its `sanitizeImportedSpatialOutputs`, now in `graphFileLinksForTests`) and what the backend keeps (pytest checks it, plus that it never keeps more); new link cases for squared, percent-encoded squared, fullwidth, soft-hyphen and fullwidth-IPv4 localhost, and ZWJ (`none` in both).
- **Live check (8797/5797, 1280x800 and 1440x900, 0 blocked requests, no page errors):** an MCP load of a bundle with a squared-localhost picture link, a World with an outside link and a World as Nebula writes it: the squared link loaded the restored picture, the outside World arrived without its output with the canvas's "1 invalid World output was made unavailable.", the Nebula World landed. `nebula load` of a plain file printed the same note. The person's own Load graph of the same bundle keeps the outside World rebuilt (the documented drops-more case). The "Save failed" the tab showed is the pre-existing World save bug in Open items.
- **Review gates:** focused pytest (graph_file_links, graph_file_client, graph_file_access, cli_api, error_copy_round3, provider_start_admission) 544 passed; vitest (the 8 graphFile* and GraphFileActions files) 278 passed (3 timed out at load average ~30 and passed on a one-worker rerun, 93/93); `tsc -b` 0; lint 0; vite build + budget 379,873 bytes raw / 114,625 gzip, dist/ deleted.

## Open items

- **GM:** should the switch-back screen get its own line when an *agent* leaves a paused project? Today it shows #178's "too large to save" choice to the person.
- The new project is stored with an empty snapshot until the tab saves or a switch happens. When it is over the limit, the file lives only in the live canvas and the restore folder until it is trimmed (same as Q120's tab path).
- Porting the full World/spatial parsers would let the backend keep (rebuilt) the Worlds it now drops whole; see Tradeoffs.
- **Not this branch, seen in the review's live check: a project holding a World fails to save after the tab loads it from the backend.** `applyProject` runs `rewriteBackendAssetUrls` over the snapshot, which turns the World's nested splat link into `http://127.0.0.1:<port>/api/outputs/...`; the next PUT gets 400 "asset uri must not contain a scheme…" and the header shows "Save failed · Retry". Reproduced with no agent at all: the person's own Load graph saved, then reload, reopen and move a node gave the same 400. An agent's load shows it at once because the tab applies the backend's project. Needs its own fix (relativize World asset links before save, or keep them relative on load); not touched here.
- INSTRUCTIONS is at its 3000-character cap, so it doesn't mention load_graph_file.
