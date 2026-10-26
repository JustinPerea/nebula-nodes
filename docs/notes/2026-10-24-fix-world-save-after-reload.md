# 2026-10-24 — A project with a World saves after the tab reloads it

Branch `fix/world-save-after-reload`, from main at a568205b (#184 merged).

No question went to Justin for this one: it is a bug from #185's live review, fixed inside the existing rules (the backend's relative-only World contract stays as strict as it is).

## What was wrong

- **The cause.** The tab turns every backend-relative asset link (`/api/outputs/...`, preset thumbnails, Paper snapshots) into `http://<backend>/api/...` for display: `applyProject` runs `rewriteBackendAssetUrls` over the whole project snapshot, the CLI graph sync does the same, and run results go through `rewriteExecutionAssetUrls`. Those absolute links then stayed in the tab's state, and every path that sends the graph back sent them as they were. A World's asset uris must be relative `/api/outputs/...` paths (`LocalAssetReference.validate_local_output_uri`), so the next project save was refused 400 and the header showed "Save failed · Retry".
- **Who hits it.** Only a tab whose backend address is absolute: the person's tab opened from the person link (as Justin's is), and the desktop app. A plain browser tab on the Vite proxy resolves the backend to "" (same origin), so its display links stay relative and it saves fine. That is why the first live run on unfixed code didn't reproduce it, and why "Load graph saves fine" was a timing detail, not a different path.
- **A second symptom of the same cause.** The World card itself showed "World unavailable · This value does not match Nebula's versioned spatial contract" after a reload in the person tab: the card's strict parser (`lib/spatialValue.ts`) mirrors the backend and refuses the absolute uris too. A World a run had just made had the same problem (`normalizedExecutionOutputs` sends World ports through `rewriteExecutionAssetUrls`). So "a World made live saves today" was also false in a person tab.

## What changed

- **One shared inverse, `canonicalBackendAssetUrls` (frontend/src/lib/backend.ts).** It turns every string that is one of this backend's asset links made absolute (a loopback host on any port, or the resolved backend origin, with an `/api/outputs/`, `/api/presets/thumbnails/` or `/api/paper/snapshots/` path) back into the relative link, keeping the path exactly as written. Whole strings only, like the display rewrite: text that mentions a link, provider links, look-alike hosts and non-asset paths are left alone.
- **Applied at every exit, not per field (option a).**
  - `apiFetch` sends the JSON body of every request under the backend's params-gated graph prefixes (`/api/graph`, `/api/execute`, `/api/cinema`, `/api/quick`, `/api/projects`, `/api/presets`) through it. That one place covers the project save PUT and autosave, recover, the followed-switch save, graph edits (node PUT/POST, restore, layout, connect), Load graph's `/api/graph/import`, runs (`/api/execute`, `/api/execute-node`) and cinema scene writes. Every outbound request in the app goes through `apiFetch` (checked: the only raw `fetch` calls are asset GETs and the health probe).
  - `captureProjectSnapshot` returns the canonical snapshot, so "Download a copy", "Download your edits", the size panel and the saved-fingerprint comparison all see what the backend will store.
  - `serializeGraph` (Save graph) writes canonical params, outputs and edge data; the bundle's asset collector already reads relative links.
- **Display skips versioned spatial values (option b, for the card).** `rewriteBackendAssetUrls` and `rewriteExecutionAssetUrls` now leave any value with a numeric `schemaVersion` and a spatial `kind` (`world`, `point-cloud`, `camera-pose`, ... the ten kinds in models/spatial.py) exactly as the backend gave it. It is recognised by its own `kind`, so a World on an Any port (Spatial Value Validate) counts too. Every viewer already resolves each link when it draws or fetches it (`RepresentationViewer`, `worldSplat`, `worldDownload`, `canvasSelection`, `worldCard`), so nothing needed the pre-made absolute link. Legacy World v1 values (no `kind`) keep the old display rewrite; their parser accepts both spellings and the exit canonicalizer covers their saves.

## Decisions not in the brief

- **a and b together, c rejected.** (a) alone fixes saving everywhere but leaves the card refusing its own World after a reload. (b) alone fixes World values but leaves every other structured value, and any future strict contract, one display rewrite away from the same 400. (c) would make the backend accept a loopback absolute uri; it isn't needed, and the strict relative rule stays a security boundary untouched.
- **Scoped to graph-carrying requests, not every body.** Settings, moodboards, characters and other endpoints keep their bodies byte for byte. They don't carry graph content, and I didn't audit whether each accepts a relative link where a person might paste an absolute one.
- **A cheap pre-check before parsing.** Autosave sends the whole project on every edit, so `apiFetch` parses a body only when it contains `://`.

## Tradeoffs

- A body that has any `://` under those prefixes is parsed and re-serialized once more on its way out. Bodies are already JSON we just stringified; the cost is one parse per save.
- A prompt that is exactly an absolute local asset link (nothing else in the field) goes back as the relative link. The load-time display rewrite already did the reverse to such a string, so this is symmetric with what the tab did before.

## Surprises

- The bug needs the person link to show. Without it the live check on unfixed code saved fine (200, relative links); with it, every save after open was a 400 and the card read "World unavailable".
- A tab with unsaved edits now raises a `beforeunload` prompt, which is what stalled the first reload in the unfixed run.

## Agents, CLI and saved projects

- **Agents are unaffected.** MCP tools and the `nebula` CLI read projects and the graph from the backend, which never sees the tab's display spelling. After this fix, newly saved projects hold relative links for images too, so agents see the same `/api/outputs/...` links the backend made. No MCP tool, CLI command or doc changes.
- **No saved project can hold an absolute World uri from this bug.** Every project write (PUT, recover, the switch handoff) goes through `_stage_project_snapshot` -> `_stage_graph_nodes(include_outputs=True)` -> `_normalize_outputs_for_storage` -> `parse_spatial_value`, which refused them; that is the 400. (Only a node whose definition is no longer registered keeps raw outputs, and `worldlabs-environment` is registered.) I did not read `~/.nebula` (off limits); this is from the code.
- **Older projects may hold absolute loopback links for plain media** (images, video) saved from a person tab before this fix. The backend accepted those. They show fine (the load rewrite maps any loopback port to the current backend) and become relative on the next save of that project.

## Tests (written first)

- `frontend/tests/worldSaveAfterReload.test.ts` (3): reload -> open -> move a node saves the World's relative links and the card's strict parser accepts the in-tab World; a World a run just made stays relative in the tab and is captured relative; Save graph writes relative links.
- `frontend/tests/lib/backendAssetCanonical.test.ts` (13): the canonicalizer undoes the display rewrite (nested, both loopback spellings, any port, all three asset prefixes) and leaves provider links, look-alike hosts, non-asset paths and prose alone; the display rewrites leave spatial values (by `kind`, Any ports too) alone; `apiFetch` sends relative links for project PUT, recover, execute, execute-node, graph restore, node PUT and graph import, and leaves `/api/settings` bodies untouched.
- Failing first, on main's code: the first draft failed 13 of 14 (3 with "canonicalBackendAssetUrls is not a function", 10 on assertions: the save and every request body carried `http://localhost:8000/api/outputs/...`). After the save fix, the display tests added for the card failed 3 of 16 (the in-tab World was absolute and didn't match) until the spatial skip landed.

## Live check

- Isolated backend on 8801 (temp HOME, every NEBULA_* root under scratch, no provider keys, a test person token on stdin) and Vite on 5801 pinned with `VITE_NEBULA_BACKEND_PORT=8801`. Headless Chrome via Puppeteer with CDP `Network.setBlockedURLs` for 8000-8010 and 5173 on 127.0.0.1, localhost and [::1], plus a dead proxy that only lets 5801/8801 through (a canary on 8899 was unreachable). The page was opened with the person link, which is what reproduces it.
- The World came from a fixture: a valid World v2 (one SPZ splat, panorama, thumbnail written as local files) imported with `/api/graph/import`. No generation ran.
- **Unfixed code (main, same setup):** opening the project and moving the World node -> PUT 400 "asset uri must not contain a scheme, authority, query, or fragment"; the header showed "Save failed · Retry"; after reload, two more moves, two more 400s; the card read "World unavailable".
- **Fixed code:** open + move -> 200; reload + reopen + move -> 200; a third move at 1440x900 -> 200. Every save sent `"uri":"/api/outputs/run-w/world.spz"` and no absolute local link. The header never showed "Save failed" and read "Saved"; no beforeunload prompt. The card shows "World · Contract v2 · Fixture studio" with its three local assets, and each asset link (`http://127.0.0.1:8801/api/outputs/run-w/{world.spz,pano.png,thumb.png}`) answered 200. The stored project on the backend holds only relative links.
- Blocked requests: 0 (no request reached 8000-8010 or 5173). Checked at 1280x800 and 1440x900.

## Review

- **Two confirmed findings, both fixed, tests first.** (1) A plain `.nebula` that an older Save graph wrote from a person or desktop tab holds loopback display links, and Load graph dropped its World ("1 invalid World output was made unavailable."), because only the `.nebula.zip` path remapped links on the way in. `readGraphSelection` now runs `canonicalBackendAssetUrls` over the plain file's nodes before the strict World check, so the way in matches the way out. (2) Load graph put the backend's relative links into the tab without the display rewrite every other graph read runs (applyProject, fetchCLIGraph, CLI sync), and with this change Download a copy files are relative, so a packaged desktop tab (a file:// page) would draw `file:///api/outputs/...`. `GraphFileActions` now runs `rewriteBackendAssetUrls` over the imported nodes and edges; a World keeps its relative links (spatial skip), and saves canonicalize the rest again. Failing first: `graphFile.test.ts` "keeps a World whose file holds loopback display links" got the invalid-World warning; the new `GraphFileActions.displayUrls.test.tsx` got `/api/outputs/run-a/image.png` instead of `http://localhost:8000/...`. The second test lives in its own file because it sets the module's cached backend base, which would leak into the other GraphFileActions tests.
- **Review live check (8801/5801, person link, same blocking).** Loaded a plain file whose links were `http://127.0.0.1:8000/api/outputs/...` into a new project with Load graph (only the picker stubbed): no invalid-World notice, the card shows "World · Contract v2 · Fixture studio", the store holds the thumbnail as `http://127.0.0.1:8801/...` and the World splat as `/api/outputs/run-w/world.spz`; the move saved 200 with relative links; reload + reopen + move 200, and again at 1440x900 200; "Save failed" never shown; World assets answered 200 from 8801. Nothing reached 8000 (the old file's port): blocked requests 0. The desktop file:// case itself was not run (no packaged build here); the unit test covers it.

## Open items

- None for this fix. The legacy absolute media links in older saved projects clear themselves on their next save; a one-off backend migration is possible but not needed.
