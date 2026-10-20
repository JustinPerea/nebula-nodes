import { lazyWithPreload } from './lazyWithPreload';

/**
 * Code that is not needed for the first paint of the canvas, split out of the
 * startup entry (the 512 kB budget in scripts/check-build-budget.mjs).
 *
 * Every split module is listed in `DEFERRED_MODULES` below, and
 * `tests/entrySplit.test.ts` walks the static import graph from src/main.tsx
 * to prove none of them is pulled back in. Import these lazy components (or
 * their wrappers with fallbacks) instead of the modules themselves.
 */

// Docks, overlays and modals: rendered only once opened, preloaded on idle (or
// on intent) so the first open renders synchronously with no fallback.
export const DeferredRunHistoryPanel = lazyWithPreload(
  () => import('../components/panels/RunHistoryPanel'),
  (module) => module.RunHistoryPanel,
);

export const DeferredOnboardingOverlay = lazyWithPreload(
  () => import('../components/onboarding/OnboardingOverlay'),
  (module) => module.OnboardingOverlay,
);

export const DeferredConnectionPopup = lazyWithPreload(
  () => import('../components/ConnectionPopup'),
  (module) => module.ConnectionPopup,
);

export const DeferredMaskPainterModal = lazyWithPreload(
  () => import('../components/panels/MaskPainterModal'),
  (module) => module.MaskPainterModal,
);

// Node-card media viewers: only mount once a node has a mesh / world output.
// Their fallbacks (components/nodes/DeferredViewers.tsx) hold the same box.
export const DeferredMeshPreview = lazyWithPreload(
  () => import('../components/nodes/MeshPreview'),
  (module) => module.MeshPreview,
);

export const DeferredWorldPreview = lazyWithPreload(
  () => import('../components/nodes/WorldPreview'),
  (module) => module.WorldPreview,
);

/** Fetch every deferred chunk; called once the canvas is idle after first paint. */
export const DEFERRED_PRELOADS: readonly (() => Promise<unknown>)[] = [
  DeferredRunHistoryPanel.preload,
  DeferredOnboardingOverlay.preload,
  DeferredConnectionPopup.preload,
  DeferredMeshPreview.preload,
  DeferredWorldPreview.preload,
  DeferredMaskPainterModal.preload,
];

/** Source paths (relative to src/) that must stay out of the startup entry. */
export const DEFERRED_MODULES: readonly string[] = [
  'components/panels/RunHistoryPanel.tsx',
  'components/onboarding/OnboardingOverlay.tsx',
  'components/ConnectionPopup.tsx',
  'components/panels/MaskPainterModal.tsx',
  'components/nodes/MeshPreview.tsx',
  'components/nodes/WorldPreview.tsx',
];
