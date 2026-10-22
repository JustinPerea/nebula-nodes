import { deferredModule, lazyWithPreload } from './lazyWithPreload';

/**
 * Code that is not needed for the first paint of the canvas, split out of the
 * startup entry (the 512 kB budget in scripts/check-build-budget.mjs).
 *
 * Every split module is listed in `DEFERRED_MODULES` below, and
 * `tests/entrySplit.test.ts` walks the static import graph from src/main.tsx
 * to prove none of them is pulled back in. Import these lazy components (or
 * their wrappers with fallbacks) instead of the modules themselves.
 *
 * New panels, menus, pickers and modals are deferred by default, so the entry
 * stops growing on its own: anything the person opens (or that shows only
 * what the socket or a fetch brings in) gets a lazyWithPreload here, a
 * preload in DEFERRED_PRELOADS (or on intent, like Paint Mask's hover), a
 * wrapper with a DeferredBoundary (components/DeferredPanels.tsx; mounted at
 * once with components/deferredAtOnce.tsx when its closed state draws
 * nothing), and its files in DEFERRED_MODULES. Code used only inside an
 * action goes through deferredModule (graphFileModule below). It stays eager
 * only if it is drawn at the first paint of the canvas or Projects home and a
 * fallback cannot hold its exact box, or if it sets up startup-time state at
 * import (a store that subscribes to the socket, a hotkey or window-event
 * listener): split that part into a small eager module (store/*, the
 * lib/heldIntents.ts pattern) and list it in tests/entrySplit.test.ts's
 * STARTUP_STATE.
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

// Second pass (2026-10-22). Panels and menus closed at every start: wrappers
// in components/DeferredPanels.tsx.
// The chat: mounted at once like the Agent log (it checks the agent's login
// while closed, so the first open shows the status); a chat-send that beats
// the chunk is held by the wrapper (lib/heldIntents.ts).
export const DeferredChatPanel = lazyWithPreload(
  () => import('../components/panels/ChatPanel'),
  (module) => module.ChatPanel,
);

// The node Inspector popover, with the Inspector inside: mounted on first open.
export const DeferredNodeInspectorPopover = lazyWithPreload(
  () => import('../components/panels/NodeInspectorPopover'),
  (module) => module.NodeInspectorPopover,
);

// The Assets dock (Characters · Moodboards · Styles), with its trash and move menu.
export const DeferredAssetsPanel = lazyWithPreload(
  () => import('../components/panels/AssetsPanel'),
  (module) => module.AssetsPanel,
);

// The ⌘K palette: mounted at once, draws nothing until opened; a ⌘K or a rail
// open that beats the chunk is held by the wrapper (lib/heldIntents.ts).
export const DeferredCommandPalette = lazyWithPreload(
  () => import('../components/CommandPalette'),
  (module) => module.CommandPalette,
);

// Canvas overlays that draw only what the socket or a fetch brings in (an
// agent's proposal and the undo notice that shares its bar, pins, agent
// cursors); mounted at once inside Canvas by components/canvas/DeferredCanvasOverlays.tsx.
// Their stores stay in the entry, so nothing is missed before they arrive.
export const DeferredProposalBar = lazyWithPreload(
  () => import('../components/canvas/ProposalBar'),
  (module) => module.ProposalBar,
);

export const DeferredProposalLayer = lazyWithPreload(
  () => import('../components/canvas/ProposalLayer'),
  (module) => module.ProposalLayer,
);

export const DeferredPinLayer = lazyWithPreload(
  () => import('../components/canvas/PinLayer'),
  (module) => module.PinLayer,
);

export const DeferredAgentCursorLayer = lazyWithPreload(
  () => import('../components/canvas/AgentCursorLayer'),
  (module) => module.AgentCursorLayer,
);

// Graph save / open (lib/graphFile.ts): used only inside those two actions,
// so GraphFileActions.tsx awaits it at the moment of use.
export const graphFileModule = deferredModule(() => import('./graphFile'));

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
  DeferredChatPanel.preload,
  DeferredNodeInspectorPopover.preload,
  DeferredAssetsPanel.preload,
  DeferredCommandPalette.preload,
  DeferredProposalBar.preload,
  DeferredProposalLayer.preload,
  DeferredPinLayer.preload,
  DeferredAgentCursorLayer.preload,
  graphFileModule.preload,
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
  // Settings' tabs load with their own dynamic import (Settings.tsx).
  'components/panels/settings/PersonalAgentsSection.tsx',
  // Second pass (2026-10-22, docs/notes/2026-10-22-perf-entry-split-2.md).
  // Chat: closed at every start; its chat-send listener stays eager
  // (lib/heldIntents.ts holds a send until the panel is in).
  'components/panels/ChatPanel.tsx',
  'components/panels/ChatModelPicker.tsx',
  'components/panels/PermissionCard.tsx',
  'components/panels/PersonalAgentWarning.tsx',
  'lib/chatCancellation.ts',
  'lib/commonsChatAuthority.ts',
  'lib/personalAgentsEvents.ts',
  // The node Inspector: hidden at every start, opens on a node's intent.
  'components/panels/NodeInspectorPopover.tsx',
  'components/panels/Inspector.tsx',
  'components/panels/StoredAssetPicker.tsx',
  'components/panels/JevResultDetails.tsx',
  'lib/makerSizes.ts',
  // The Assets dock: closed at every start (the rail opens it).
  'components/panels/AssetsPanel.tsx',
  'components/asset-trash/AssetTrash.tsx',
  'components/asset-move/AssetMoveMenu.tsx',
  'lib/createPresets.ts',
  'lib/assetMove.ts',
  'store/assetStudioDraftStore.ts',
  'hooks/useAssetDelete.ts',
  // The command palette: drawn only once ⌘K or the rail opens it.
  'components/CommandPalette.tsx',
  'lib/commandPalette.ts',
  // Graph save / open: imported at the moment of use (GraphFileActions.tsx).
  'lib/graphFile.ts',
  // Canvas overlays that draw only what the socket or a fetch brings in, so
  // nothing they show can be on screen at the first paint.
  'components/canvas/ProposalBar.tsx',
  'components/canvas/ProposalLayer.tsx',
  'components/canvas/CanvasUndoNotice.tsx',
  'hooks/useProposalReadiness.ts',
  'components/canvas/PinLayer.tsx',
  'components/canvas/AgentCursorLayer.tsx',
];
