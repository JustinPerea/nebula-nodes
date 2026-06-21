# Implementation Notes — Unified Assets Library (Phase 1)

Branch: `unified-assets-library`. Plan source: `docs/research-2026-06/flora-comfyui-gap-analysis.md` (§3 Global, build step 1 — the #1 structural gap).

## Decision (user-chosen): "Panel, collapse the 3"
One dockable Assets panel with Characters · Moodboards · Styles tabs; the existing Character + Moodboard library panels (and their launchers) are **removed** and replaced by a single "Assets" launcher. True collapse-3-into-1. Canvas-chrome panel so drag-to-canvas keeps working. (Full-screen `viewMode 'assets'` + per-card usage history deferred to a later phase.)

## What shipped
- **NEW `components/panels/AssetsPanel.tsx`** — tabbed panel (Characters/Moodboards/Styles), shared scope toggle (Project/Global) + search. Reuses the existing `fetchCharacters`/`fetchMoodboards`/`fetchPresets`, `addCharacterNode`/`addMoodboardNode`, the `character-palette__*` item styles, and `backendAssetUrlSync`. Drag-to-canvas reuses the existing MIMEs; Characters/Moodboards also support click-to-add + double-click-to-edit (routes to the right Studio).
- **NEW `lib/dragMime.ts`** — `CHARACTER_DRAG_MIME` / `MOODBOARD_DRAG_MIME` moved here so the Canvas drop handler doesn't depend on the (now-deleted) library components.
- **Styles tab → Create (cross-surface)** — clicking a Style sets `uiStore.pendingPreset` and enters Create; `CreateView` consumes it on mount (race-free, no event-timing hack) via the existing `handleApplyPreset`. The Create `PresetLibrary` modal is unchanged (the Assets Styles tab is an additional entry point, not a removal).
- **Removed** `CharacterLibrary.tsx` + `MoodboardLibrary.tsx`; repointed `PanelLaunchers` (Moodboard + Character buttons → one "Assets" `FolderHeart` button at the +104px slot); `App.tsx` mounts `AssetsPanel` on `panels.assets.visible`.
- **uiStore** — added `panels.assets`, `'assets'` to the togglePanel/setPanelPosition unions, and `pendingPreset` + `setPendingPreset`/`consumePendingPreset`. Set the (now-unused) `character` panel default to `visible:false`.
- **Onboarding tour** — consolidated the moodboard+character steps into one "Assets" step (the old launcher selectors no longer exist), so the just-shipped tour still highlights real targets.
- **CSS** — `.panel--assets` mirrors `.panel--character-library` (Slava-scoped, the only maintained skin); new `.assets-panel__tabs/__tab/__search` (structural unscoped, visual Slava-scoped to pass `check:slava-css-scope`). Launcher layout: replaced the `--moodboard`/`--character` position rules with `--assets`.

## Verification
- tsc clean · eslint clean on changed files · `check:slava-css-scope` clean · 355 frontend tests pass · production build OK.
- **Browser-verified** (Playwright, real Chromium): exactly 4 launchers (Assets present; moodboard/character gone); panel opens with all 3 tabs; Characters tab renders saved items; Styles tab lists the 12 seeded presets; clicking **Cinematic Noir** entered Create with `pendingPreset` consumed and the composer prompt set to the preset's prompt.

## Notes / deferred
- The Assets panel sits at `top:360` (same slot the old Character library used) so it can overlap the Node Library panel when both are open — pre-existing behavior, not introduced here.
- Reused `character-palette__*` item classes across all three tabs for visual parity (semantically generic enough); a dedicated `.assets-panel__item` set could replace them later.
- Phase 2 (separate): generic `/api/elements` store for loose reference images + "Save to library" on result cards; `@`-mention in the composer + Daedalus readability; full-screen AssetsView with usage history.
