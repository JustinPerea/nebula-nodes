# Project home implementation notes

## 2026-10-09

- Startup will show a project home instead of immediately entering the last canvas. Preserve the existing canvas as a migrated saved project; opening home must not clear it or submit generation.
- Store project documents in the backend's existing per-user state directory, outside the repository. Include graph outputs, immutable run history and the canvas viewport. Local media stays in the existing output store; portable exports remain the existing file action.
- Project switches must save the outgoing project first, preserve node IDs and connections, reset transient editor/selection state, and honor the existing execution/import/paid-provider guards. Failed saves or activation must leave the current project available.
- Use the current monochrome interface, matching node corner radii. The home screen provides recent projects, search, names, and an explicit New project action; project workspaces have a clear return to Projects.
- New projects open immediately as blank canvases named Untitled project; the home card supports inline renaming. Every cold page load opens Home. Resuming the already loaded project can retain its studio; activating a different project always enters Canvas.
- Run history now uses a project-specific browser cache in addition to the authoritative project document. The legacy global cache is retired only after its migration save succeeds, preventing obsolete running records from recreating ownership on later reloads.
- A workspace revision fences delayed mutations and results. Switching waits for pending writes, uploads, creation acknowledgements, running jobs and unresolved paid-provider records. Opening a saved project never submits a provider operation.
- If another window changes the active project while this window has unsaved edits, Retry first saves an inactive recovered copy with an idempotency ID, then reloads Projects. Failed recovery leaves the local canvas available. Restored upload metadata reports interruption rather than an endless spinner.
- Storage is an owner-only atomic catalog with a 16 MiB limit per project and 128 MiB overall limit. The catalog and legacy CLI graph cache are separate atomic writes; switching prepares both and rolls back the cache on catalog failure before adopting live memory. A catastrophic rollback failure is surfaced explicitly. Local project saves retain media references in the existing output store; portable asset copies remain the .nebula.zip export.
- Validation: 1,953 frontend tests, affected backend regression suites, lint, TypeScript and production build/budget passed. Computer-use checks in a separate state directory confirmed blank creation, text editing, inline rename, Home on reload, restored prompt and Creator Studio draft, isolated histories, and reopening the seven-node/four-edge original with its prior history. No generation was submitted. The normal preview retains only the migrated original project; smoke-test projects never entered the user's project catalog.

- Merge preparation: preserve the newer Krea audio/enhance/3D/workspace and media-fetch protections from main alongside the previously reviewed UI stack. Resolve the duplicate Krea upload patch in favor of main's shared, validated upload helper; retain both README feature entries and both workstreams' implementation notes. Verify the combined tree before advancing main.
- Combined-tree validation: all 1,961 frontend tests and 695 backend regression tests passed, including project switching/execution fences, Chat discovery and Krea generation/workspace/media-fetch protections. Lint, TypeScript, production build and bundle budget passed; the 301-definition contract check passed. The live local backend responds to health and project listing without generation. The entire change from origin/main was scanned for credential-shaped additions and sensitive file paths, with no findings.

## 2026-10-10 — Deleting projects

- Each card has a trash button beside rename. (Superseded the same day: see Recently deleted below.)
- `DELETE /api/projects/{id}` requires the current `workspaceRevision`, so a stale view can't delete anything. Generated media stays in the output store; only the catalog entry goes.
- Deleting an inactive project leaves the live canvas and revision untouched and broadcasts nothing.
- Deleting the open project carries the same run and paid-start fences as switching. It empties the live graph (so `GET /api/projects` won't re-adopt it as a Recovered canvas), clears `activeProjectId`, issues a new revision and broadcasts `canvas.replaced` with reason `project-delete`. The browser skips the outgoing save (it's being thrown away), waits for any in-flight save, and drops that project's Creator draft.
- Recovery no longer needs the source project to exist. A tab with unsaved edits to a project deleted in another window saves them as "Deleted project (recovered)" instead of failing on every retry.

## 2026-10-10 — Recently deleted (trash and undo)

- Delete is now a soft delete. `move_to_trash` moves the whole project record, pins included, from `catalog["projects"]` to `catalog["trash"]` with a `deletedAt`, in the same atomic catalog commit. Restoring moves it back unchanged. It comes back closed, even if it was open when deleted.
- Trash lives in `catalog.json` beside projects, so it counts toward the 128 MiB catalog limit and survives restarts. Entries older than 30 days (`TRASH_RETENTION`) are swept on `GET /api/projects` and before any restore, so an expired entry can't be restored even before a sweep.
- Routes: `POST /api/projects/{id}/restore`, `DELETE /api/projects/trash/{id}` and `POST /api/projects/trash/empty`. None of them touch the live canvas, so unlike delete they don't take a workspace revision; a missing entry is a 404. Restore still honours the 500-project limit (413).
- `GET /api/projects` now returns `trash` (newest first, each with `deletedAt` and `purgeAt`). A corrupt trash entry fails the catalog read (507), the same as a corrupt project, instead of being dropped.
- UI: the trash button deletes in one click (it's reversible now) and shows an Undo toast for 8 s, held while the toast is hovered or focused. A collapsed **Recently deleted** section below the grid lists entries with Restore and a two-step Delete forever, plus Empty. The toast enters on a computed spring (`linear()` from k 380, c 30, m 1) and is static under reduced motion.
- Recovery of a stale tab's edits now names the copy after the trashed project when the source is still in the trash.

