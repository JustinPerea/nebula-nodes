# Startup set: the Settings dock loads on idle (2026-11-20)

Branch perf/startup-trim, from main 386fefd7. Main's startup set sat 2,254 bytes under the raw limit (1,867,746 of 1,870,000), so a feature PR that added a few hundred bytes could fail the budget check. This change takes 12,066 bytes raw and 3,683 gzip out of the set and leaves the limits as they are.

## Measurement

Built with `npm run build`, then read each member of the startup set (scripts/lib/startupChunks.mjs) for its size. To see which modules sit in the entry, a throwaway vite config (deleted afterwards) merged the real config and wrote Rollup's `chunk.modules` from `generateBundle`; a script then walked the static import graph from src/main.tsx and reported, for each module, the bytes that become unreachable when that module is cut.

| | entry raw | entry gzip | startup raw | startup gzip | chunks |
|---|---|---|---|---|---|
| main (386fefd7) | 410,679 | 131,387 | 1,867,746 | 490,322 | 45 |
| with the Settings dock deferred | 398,613 | 127,703 | 1,855,680 | 486,639 | 45 |
| change | -12,066 | -3,684 | -12,066 | -3,683 | 0 |

The set is now 14,320 bytes raw and 4,761 gzip under its limits.

## What moved

`components/panels/Settings.tsx` and the modules only it imports: store/settingsDraftStore.ts, components/panels/settings/SettingsTabs.tsx, SettingsNoticeBar.tsx, rowHelpers.ts, groupLockLines.ts, DeferredSettingsTopNotice.tsx, lib/spendLimits.ts, hooks/usePanelFocus.ts, and settings.css, which now arrives with the chunk. About 22 KB of source as Rollup reports it before minifying.

It follows the pattern in lib/deferredChunks.ts: `DeferredSettings` is a `lazyWithPreload`, App.tsx's idle preload list starts it after the first paint, and `SettingsPanel` in components/DeferredPanels.tsx mounts it on the first open (`useOpens`) and keeps it mounted from then on, like Run history. The Settings dock draws nothing while closed and starts closed on every screen, so nothing on the first frame of Projects home or the canvas changes. The component's own exit animation, focus handling and settings read run unchanged once it is mounted. A chunk that fails closes the dock again (`closeSettings`) and retries on the next open, on focus or when the browser is back online.

The five modules whose only importer is Settings are listed in DEFERRED_MODULES, so tests/entrySplit.test.ts fails if a later static import pulls them back.

## Left alone

Candidates measured in the entry (rendered bytes before minifying) and why they stay:

- lib/spatialValue.ts and lib/worldValue.ts (37 KB): lib/representationViewerRegistry.ts parses a card's output with them to decide which result view a card mounts, and the cards decide synchronously.
- ProviderSwitcher.tsx and lib/providerSwitch.ts (31 KB): the chip is in the Model card header at first render; GraphFileActions also reads `providerKeyWarnings`.
- lib/noticeStackPlace.ts (39 KB): NoticeRegion places at mount.
- NodeLibrary.tsx (22 KB): the library is the open dock on a new canvas (`leftDock: 'library'`).
- GraphFileActions.tsx (9 KB): renders nothing but owns the save and load shortcuts and events; a late mount would miss an early one.
- UnsavedEditsNotice.tsx with ModalPortal.tsx (9 KB), ProjectWorkspaceControls.tsx (10 KB): drawn in Projects home or the workspace header at first paint.
- CrabMarkAnimated.tsx and crabModes.ts (6 KB): the empty canvas's splash at first paint.
- ContextMenu.tsx (5 KB): a right-click opening it before the chunk lands would show the menu late; the saving was too small for that.
- canvasPins.ts and canvasPinsStore.ts (23 KB): SelectionToolbar and ContextMenu read the store, and ModelNode needs only `isBackendNodeId` from canvasPins; moving that function out frees nothing until SelectionToolbar (see the 2026-11-14 note) is deferred too.
- runHistory.ts (30 KB, in graphStore.js): graphStore's run path reads it synchronously.

## Tests

tests/components/DeferredPanels.test.tsx gained a Settings case (nothing mounted or preloaded while closed, the first dock open brings the dialog in). tests/App.canvasFocus.test.tsx used a Settings fixture that always rendered; the real dock draws nothing while closed, so that test now checks the fixture is absent, opens Settings from Projects home's header button and awaits it.
