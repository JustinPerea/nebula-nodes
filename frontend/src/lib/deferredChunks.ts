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

// The Agent log shows on the canvas by default (Q38) but isn't needed for the
// first paint; its store (store/agentLogStore.ts) is imported eagerly by
// App.tsx so no entry is missed before the panel arrives.
export const DeferredAgentLog = lazyWithPreload(
  () => import('../components/panels/AgentLog'),
  (module) => module.AgentLog,
);

// The Updates corner (PR9a; on every screen since Q107 a): the chip shows at
// once but isn't needed for the first paint. Its store
// (store/agentNotesStore.ts) is imported eagerly by App.tsx, so no update is
// missed before the chip arrives. The node outlines mount inside Canvas,
// beside the agent cursors.
export const DeferredAgentNotes = lazyWithPreload(
  () => import('../components/agent-notes/AgentNotesCorner'),
  (module) => module.AppAgentNotes,
);

export const DeferredAgentNoteOutlineLayer = lazyWithPreload(
  () => import('../components/agent-notes/AgentNoteOutlineLayer'),
  (module) => module.AgentNoteOutlineLayer,
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

// The Moodboard line on a node card (components/nodes/MoodboardAdapterRow.tsx
// draws its empty box until it arrives), with the adapter table's store.
export const DeferredMoodboardAdapterLine = lazyWithPreload(
  () => import('../components/nodes/MoodboardAdapterLine'),
  (module) => module.MoodboardAdapterLine,
);

/** Fetch every deferred chunk; called once the canvas is idle after first paint. */
export const DEFERRED_PRELOADS: readonly (() => Promise<unknown>)[] = [
  DeferredAgentLog.preload,
  DeferredAgentNotes.preload,
  DeferredAgentNoteOutlineLayer.preload,
  DeferredRunHistoryPanel.preload,
  DeferredOnboardingOverlay.preload,
  DeferredConnectionPopup.preload,
  DeferredMeshPreview.preload,
  DeferredWorldPreview.preload,
  DeferredMaskPainterModal.preload,
  DeferredMoodboardAdapterLine.preload,
];

/** Source paths (relative to src/) that must stay out of the startup entry. */
export const DEFERRED_MODULES: readonly string[] = [
  'components/panels/AgentLog.tsx',
  'components/agent-notes/AgentNotesCorner.tsx',
  'components/agent-notes/AgentNoteCard.tsx',
  'components/agent-notes/AgentNotesList.tsx',
  'components/agent-notes/AgentNoteParts.tsx',
  'components/agent-notes/AgentNoteOutlineLayer.tsx',
  'lib/agentNotesView.ts',
  'lib/agentNotesBoard.ts',
  'lib/assetProposalReview.ts',
  'lib/canvasProposalReview.ts',
  'lib/goToCanvas.ts',
  'lib/commonsUnsaved.ts',
  'store/assetProposalReviewRequest.ts',
  'components/panels/RunHistoryPanel.tsx',
  'components/onboarding/OnboardingOverlay.tsx',
  'components/ConnectionPopup.tsx',
  'components/panels/MaskPainterModal.tsx',
  'components/nodes/MeshPreview.tsx',
  'components/nodes/WorldPreview.tsx',
  'components/nodes/MoodboardAdapterLine.tsx',
  'lib/moodboardAdapters.ts',
  'store/moodboardAdapterStore.ts',
];
