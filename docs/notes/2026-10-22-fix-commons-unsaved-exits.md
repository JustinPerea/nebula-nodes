# 2026-10-21 — Unsaved Commons labels survive every in-app exit

Branch `fix/commons-unsaved-exits`, from main `8246211f` (after #160 and #161). Uncommitted (the coordinator commits). No paid provider call, no package installed, no backend file changed.

## What changed and why

- **The bug.** When Blind labeling or Agent review holds unsaved labels (or is saving or generating), the Commons disables its own Back, tabs and More, and the Updates corner refuses to leave (#157's p157 review). But App unmounts `CommonsView` as soon as uiStore's `viewMode` leaves `'commons'`, the Commons capability goes off, or projectStore's `screen` goes to `'home'`. Several other exits did that without asking, and the labels were lost. Justin asked for complete fixes and the correct choice over the easy one: while the Commons holds unsaved work the person can't leave until they save or discard (GM - Design's pattern), and any refusal reuses "The Commons has unsaved changes: save or discard them first."
- **Each exit, checked on main, now held:**
  1. **A project opened elsewhere.** An agent's `open_project` (MCP or CLI) arrives as a graphSync with `projectSwitch`. The tab follows it (`followProjectSwitch` → `loadWorkspace` → `applyProject`), and `applyProject` set `viewMode: 'canvas'`. Now the project still opens (the backend's open project is the truth; nothing waits or refuses on the agent's side), the canvas loads behind the Commons, the person stays in the Commons with their labels, and `commonsReturnView` is `'canvas'`, so the Commons' Back then lands on the new project's canvas.
  2. **A second tab opening a project.** This isn't a switch the tab follows. The backend marks only switches by agents and scripts (`_switch_actor` returns None for the person), so the tab stops with "The active project changed in another window …" (`preserveWorkspaceConflict`) and goes to Projects. With unsaved labels, going to Projects now waits until the Commons is clean, then happens, just as it would have for a clean Commons. The conflict's error and stopped saves apply at once; only the screen waits.
  3. **The browser Back button or a hash edit.** `useCommonsCapability` called `exitCommons()` when the hash stopped saying `#commons`. The same went for `#brand` (App) and `#moodboard/<id>` (`useMoodboardDeepLink`), which switch views themselves. Now the view stays, and `CommonsView` puts the URL back (`history.pushState` of the hashchange's `oldURL`) while it's dirty, so the URL matches what's shown. The hook stays "routed" when the Commons held, so Back after a save leaves as usual. Before, it forgot it had routed, and the next Back would have done nothing.
  4. **Projects (`goHome`).** The Projects (home) button sits in the Commons header (`WorkspaceHeader` → `ProjectWorkspaceControls`) and was enabled while dirty. `goHome` now refuses with the reason, as the corner's Review already does, and the button is disabled with the reason as its title (`WorkspaceHeader`'s new `homeBlocked` prop, set by `CommonsView`).
  5. **The capability turning off** (`setCommonsEnabled(false)`). It used to leave at once, and `commonsEnabled: false` alone was enough to unmount the Commons (App shows the canvas for `'commons'` when it's off). Now it waits until the Commons is clean, then leaves to where the Commons was opened from. If the capability comes back on before then, nothing happens.
  6. **Found in the sweep** (every `viewMode` write, every `screen` write): a graph import (Cmd+O works in the Commons, because `GraphFileActions` is mounted on every workspace screen), `requestCanvasNodeFocus` (cinema, connection popup), `startOnboarding`, `enterCreateView`, the studio enter actions, `goToCanvas`'s own write, a lost agent-switch follow (`followProjectSwitch`'s catch) and a params-version stop. Each of these wrote `viewMode` or `screen` directly and is held by the same rule. The command palette and the canvas keyboard shortcuts don't render in the Commons; the Settings and Chat docks are `inert` there.

## Decisions not in the spec

- **One chokepoint per store, not a patch per caller.** `lib/commonsUnsaved.ts` gains `holdCommonsExits`, a small zustand middleware. Both stores are created through it, so every write goes through the rule while the Commons is dirty: the store's own `set` and `useXStore.setState` from outside alike, because the middleware replaces `api.setState` before zustand copies it onto the hook. A future caller can't reintroduce the bug. The rules:
  - uiStore (`holdCommons`, in uiStore.ts): drop a write's `viewMode` when it leaves `'commons'`; hold `commonsEnabled: false` and run `setCommonsEnabled(false)` once the Commons is clean, unless a later write turned it back on.
  - projectStore (`holdProjects`, in commonsUnsaved.ts): hold `screen: 'home'` and apply it once the Commons is clean, unless a later write shows the workspace again. `goHome`, the person's own way there, refuses first instead.
  - I rejected keeping `CommonsView` mounted from App while dirty. The stores would then say "canvas" or "Projects" while the Commons showed, and App may not render from the flag (Justin's brief).
- **Only the leaving part of a write is held.** The rest of the write lands: the project load's canvas, camera and session, an import's cleared editor ids. That keeps the canvas behind the Commons truthful. One extra rule: a held exit *to the canvas* also sets `commonsReturnView: 'canvas'`. The writers that send the canvas (a project load, an import, a node focus) are the ones that make the studio the Commons was opened from stale. Back to an editor whose target was just cleared would open an empty studio. Back that was itself refused keeps its destination.
- **A replacing write (`setState(x, true)`, tests resetting a store) is let through.**
- **`commonsUnsaved.ts` stays a plain module**: no store field, nothing renders from it. Exits that wait go in a list it runs when `setCommonsUnsaved(false)` arrives. That is the moment `CommonsView`'s effect sees the panels clean, and also when it unmounts. It is no longer deferred: uiStore imports it, so it's on the static startup graph. I removed it from `DEFERRED_MODULES` (entrySplit). The bundler puts it in the shared `graphStore-*` chunk with uiStore, not in `index-*`.
- **No new copy.** The reason string is the existing one, now exported as `COMMONS_UNSAVED_REASON` and used by `CommonsView` for the Projects button's title.

## Budget

- `npx vite build && node scripts/check-build-budget.mjs`: main **511,697** raw / 149,710 gzip; this branch **511,781** raw / 149,740 gzip (**+84 bytes** in `index-*`, 219 under 512,000). uiStore and the middleware's code are in the `graphStore-*` chunk, which the budget doesn't count. The entry grew only by projectStore's import and wrapper call, `goHome`'s refusal, the hook's routed check and the header's `homeBlocked` prop.

## Tradeoffs

- The other-tab case moves the person to Projects once their labels are saved or discarded, not on their next Back. That is what a clean Commons does at once, and the same rule as the capability turning off.
- A held hash route (`#moodboard/<id>`) still sets the store's `moodboardEditorId` (only `viewMode` is dropped). If the Commons had been opened from Moodboard Studio, Back after saving opens the Studio on the linked board instead of the earlier one. This is rare and harmless; I left it.
- The hash is put back with `pushState`, not `replaceState` (changed after review, see Review). When Back is refused, the browser has already moved to the earlier entry (the canvas), so `replaceState` would overwrite that entry. `pushState` leaves it alone and adds a `#commons` entry on top. That entry replaces the forward entry, which was the old `#commons` anyway, so history doesn't grow, however many times Back is refused. One side effect: when a typed hash edit is refused, the typed URL stays one entry below. After a save, Back visits that hash first. That's harmless.

## Surprises

- In this app a second tab's open isn't "followed". Only agent and script switches carry `projectSwitch`, so the second-tab case is a conflict stop, not a follow (point 2 above).
- `setCommonsEnabled` has a single caller, `useCommonsCapability`, and only at mount and on the first capability read. Nothing propagates Settings changes from another tab live today. The hold covers any future caller.
- Projects keeps `viewMode` and the `#commons` hash (on main too), so reopening the project from Projects goes back to the Commons, the screen the person left.

## Agent support

- Nothing agents can call changed: no MCP tool, CLI command or doc change. Live, a real MCP stdio session's `open_project` returned as before while the person's Commons was unsaved (`project`, `previousProject`, no error), and the backend had the new project open at once. The person's tab kept the labels, the header showed the new project, and the canvas loaded behind the Commons. `skills/nebula/SKILL.md` and `docs/MCP-SETUP.md` already say the person's canvas follows. It still does; the person just finishes saving first.

## Tests (written first)

- New `frontend/tests/commonsUnsavedExits.test.ts` (27 tests: stores, the agent switch and the second-tab conflict through the real projectStore socket handling) and `frontend/tests/commonsUnsavedExitsView.test.tsx` (5 tests: the real `CommonsView` with the hash hook, and the Projects button; 6 after the review added the refused-Back history case).
- On main, **19 of 32 failed**. The agent switch left `viewMode` at `'canvas'`; the second tab went to `screen: 'home'`; `goHome` resolved instead of rejecting; the capability-off case and all 7 other exits left the Commons; the 3 hash cases ended at `'canvas'` (`expected 'canvas' to be 'commons'`); the Projects button wasn't disabled. 13 passed on main: the clean-Commons regression checks (an agent's open still takes a clean Commons to the canvas, the second tab still shows Projects, `goHome`, the capability, Back and all 7 exits still leave) and "a held Projects is dropped when a later write shows the workspace".
- After the fix: those 2 files plus `commonsUnsavedFlag` and `entrySplit`, 57 passed.

## Live check

- Isolated backend on 8797 (temp HOME, every NEBULA_* root under the scratch dir, no inherited keys or tokens; `NEBULA_COMMONS_ENABLED=1`, and a throwaway person token through the stdin pipe), and Vite on 5797 with `VITE_NEBULA_BACKEND_PORT=8797` (I checked that the proxy reached the isolated listing). Chrome had a dead proxy with a bypass for only those two ports (a canary on 8799 was unreachable), plus CDP `setBlockedURLs` for 8000-8010 and 5173. **Blocked attempts: 0.**
- I seeded two projects and a Blind labeling batch from 54 local generated images (no analysis, no keys). At 1440×900, after saving accents on Reference 01, I set "type style: humanist sans" and left it unsaved. Then:
  - (a) A real MCP stdio session called `open_project` on the other project: it succeeded. The labels stayed, the header now named the new project, and the Back label read Canvas.
  - (b) `history.back()`: the Commons stayed, with the label and `#commons`.
  - (c) Projects was disabled with the reason as its title; a click did nothing.
- After **Save labels**: the Commons' Back landed on the agent-opened project's canvas. The browser's Back left the Commons, Projects went to Projects, and an agent's `open_project` took a clean Commons to that project's canvas. 17/17 checks, no page errors. I also took one screenshot of the dirty Commons at 1280×800 (Blind labeling folds into More there).
- Screenshots: `scratchpad/commons-exits/shots/` (`a-agent-open-unsaved-1440.png`, `b-back-unsaved-1440.png`, `c-projects-unsaved-1440.png`, `d-saved-1440.png`, `e-back-to-beta-canvas-1440.png`, `f-back-clean-1440.png`, `g-projects-clean-1440.png`, `h-agent-open-clean-1440.png`, `0-unsaved-1280.png`).

## Review

- **A refused browser Back overwrote the canvas history entry** (two reviewers, confirmed). The guard used `replaceState(oldURL)`. On a Back, the current entry is already the canvas entry when hashchange fires, so the guard rewrote the canvas entry to `#commons`. After a save, the next Back then skipped the canvas: in the reviewer's live run it went to about:blank, and in the desktop app it would do nothing. My own live check missed this because it set `location.hash = '#commons'` before the post-save Back, which pushed a fresh entry. Fix: `pushState(oldURL)` in `CommonsView`'s hashchange guard, and the hook comment now says so.
  - Test first: a new case in `commonsUnsavedExitsView.test.tsx` starts from a canvas entry (`/?entry=canvas`) with `#commons` pushed on top. It makes labeling dirty and calls the real `history.back()` (refused). Then it saves and calls `history.back()` again, with no hash pushed in between, and expects the canvas entry and the canvas view. On the old code it failed with `expected '' to be '?entry=canvas'`: the second Back skipped past the canvas entry. With the fix, the 4 focused files (the two exits files, `commonsUnsavedFlag`, `entrySplit`) pass, 58/58.
  - Live re-check on 8797/5797 (same isolation; 70 generated local images, since the batch needs 45 distinct clusters). Back was refused twice while dirty, and `history.length` stayed 3. After **Save labels**, the browser Back with no fresh hash landed on Beta's canvas inside the app (origin 127.0.0.1:5797, no hash). Forward went back into the Commons. The Commons' Back reached Beta's canvas, Projects worked, and an agent's `open_project` took a clean Commons to Alpha's canvas. (a) and (c) are unchanged. 20/20 checks, no page errors, **0 blocked requests**. New screenshots: `scratchpad/commons-exits/shots/e-back-after-save-1440.png`, `f-commons-back-beta-canvas-1440.png` (the others re-taken).

## Open items

- For GM: the disabled Projects button explains itself only through its title (a hover tooltip), the same as the Commons' disabled Back, which has no title at all. If GM wants a visible line, or the reason on Back too, that's new copy or a new treatment for them to decide.
- A Commons opened from a studio and then switched by an agent (or another tab) goes back to the canvas, not the studio. That's deliberate (the studio's target may be gone), but GM may want to confirm it.

## Gates

- Backend, the whole suite (iso.sh): **9496 passed, 61 skipped, 1 failed**. The failure, `test_agent_guardian.py::test_registration_racing_the_backend_kill_is_still_reaped`, is a timing race under load; that file alone passed 5/5. No backend file changed.
- Frontend `npx vitest run`, the whole suite: **4170 passed, 25 failed in 9 files**, all timeouts under the machine's load. Run alone, those 9 files (CommonsDetail, CommandPalette, ModelDiscovery.integration, ModelPicker, ResultsGallery, ConnectionPopup, GraphFileActions, NodeLibrary, Settings) passed **156/156**.
- `npx tsc -b`: clean. `npm run -s lint`: clean.
- `npx vite build && node scripts/check-build-budget.mjs`: passed, 511,781 bytes raw / 149,740 gzip (main 511,697).
- **After the review fix:**
  - Backend: **9496 passed, 61 skipped, 1 failed**. It was the same `test_agent_guardian` race; that file alone passed 5/5.
  - Frontend whole suite: **4183 passed, 13 failed in 7 files**, all load flakes: 8 timeouts, 2 `toHaveFocus` checks and 1 slow `findBy`. Run alone, those 7 files (CommonsDetail, CommandPalette, ModelPicker, ResultsGallery, GraphFileActions, NodeLibrary, Settings) passed **136/136**.
  - `tsc -b` and lint: clean.
  - Budget: passed at **511,781** raw / 149,733 gzip. That's the same raw size as before the fix, because `CommonsView` is in a lazy chunk.
