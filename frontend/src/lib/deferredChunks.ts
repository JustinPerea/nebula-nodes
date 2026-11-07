import { deferredModule, lazyWithPreload } from './lazyWithPreload';
import { placeholderRunDialogModule } from './placeholderRunDialogModule';

/**
 * Code that is not needed for the first paint of the canvas, split out of the
 * startup entry (the 512 kB budget in scripts/check-build-budget.mjs, which
 * also budgets the startup set: the entry plus the chunks it loads statically).
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

// A World v2 card's "Explore in 3D" button and its viewer dialog (Idol's
// splats). Spark still loads only when the dialog opens.
export const DeferredWorldSplatPreview = lazyWithPreload(
  () => import('../components/nodes/WorldSplatPreview'),
  (module) => module.WorldSplatPreview,
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
// The "?" dialog: the keys stay eager (components/KeyboardShortcuts.tsx), the dialog
// and the focus machinery it brings in (ModalPortal) load on first open.
export const DeferredKeyboardShortcutsDialog = lazyWithPreload(
  () => import('../components/KeyboardShortcutsDialog'),
  (module) => module.KeyboardShortcutsDialog,
);

export const DeferredCommandPalette = lazyWithPreload(
  () => import('../components/CommandPalette'),
  (module) => module.CommandPalette,
);

// Canvas overlays that draw only what the socket or a fetch brings in (an
// agent's proposal and its decision bar, pins, agent cursors); mounted at once
// inside Canvas by components/canvas/DeferredCanvasOverlays.tsx.
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

// The note dialog and the kept-notes stack (components/canvas/PinComposer.tsx):
// both draw only after a person's action (a note opened, a send refused or
// kept), never at the first paint, so it is mounted at once and appears when
// its chunk lands. It brings the prompt dialog (PromptDialog) with it.
export const DeferredPinComposer = lazyWithPreload(
  () => import('../components/canvas/PinComposer'),
  (module) => module.PinComposer,
);

export const DeferredAgentCursorLayer = lazyWithPreload(
  () => import('../components/canvas/AgentCursorLayer'),
  (module) => module.AgentCursorLayer,
);

// Agents on the nodes (Q125 item 3): the mark above a node an agent is on
// and the placeholder outline. It reads the roster when it mounts, so it
// draws nothing before its chunk and misses nothing.
export const DeferredAgentNodeMarkLayer = lazyWithPreload(
  () => import('../components/canvas/AgentNodeMarkLayer'),
  (module) => module.AgentNodeMarkLayer,
);

// The notice region's own notices (RegionNotices; the region itself,
// components/NoticeRegion.tsx, is a few boxes in the entry so a toast always
// has its slot): a notice arrives only after an edit, an undo or a failure,
// never at the first paint.
export const DeferredRegionNotices = lazyWithPreload(
  () => import('../components/RegionNotices'),
  (module) => module.RegionNotices,
);

// Graph save / open (lib/graphFile.ts): used only inside those two actions,
// so GraphFileActions.tsx awaits it at the moment of use.
export const graphFileModule = deferredModule(() => import('./graphFile'));

// Settings' writes (lib/settingsWrites.ts): the notice bar the Settings dock
// draws at once uses them only when a notice times out or Undo is pressed, so
// it awaits them at that moment; the tabs, loaded on open, import them as
// usual.
export const settingsWritesModule = deferredModule(() => import('./settingsWrites'));

// Settings' "restored at start" line (components/panels/settings/SettingsTopNotice.tsx):
// it draws only what a fetch brings in (never at the first paint), so
// Settings mounts it at once (deferredAtOnce) and it appears when it lands.
export const DeferredSettingsTopNotice = lazyWithPreload(
  () => import('../components/panels/settings/SettingsTopNotice'),
  (module) => module.SettingsTopNotice,
);

// jszip, for the selection toolbar's download zip (lib/canvasSelection.ts): only
// inside that action, so it loads at the moment of use, with the chunk retry.
export const jszipModule = deferredModule(() => import('jszip'));

// The dialog before the person's direct run of agents' paid placeholders
// (Q133): lib/placeholderRunDialogModule.ts, preloaded with the rest.
export { placeholderRunDialogModule } from './placeholderRunDialogModule';

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
  DeferredWorldSplatPreview.preload,
  DeferredMaskPainterModal.preload,
  DeferredMoodboardAdapterLine.preload,
  DeferredChatPanel.preload,
  DeferredNodeInspectorPopover.preload,
  DeferredAssetsPanel.preload,
  DeferredCommandPalette.preload,
  DeferredKeyboardShortcutsDialog.preload,
  DeferredProposalBar.preload,
  DeferredProposalLayer.preload,
  DeferredPinLayer.preload,
  DeferredPinComposer.preload,
  DeferredAgentCursorLayer.preload,
  DeferredAgentNodeMarkLayer.preload,
  DeferredRegionNotices.preload,
  graphFileModule.preload,
  settingsWritesModule.preload,
  placeholderRunDialogModule.preload,
  DeferredSettingsTopNotice.preload,
];

/** Source paths (relative to src/) that must stay out of the startup entry. */
export const DEFERRED_MODULES: readonly string[] = [
  'lib/settingsWrites.ts',
  // Every key's URL, notes and token instructions: Settings' rows and search read them.
  'lib/providerCatalog.ts',
  'components/panels/settings/SettingsTopNotice.tsx',
  'lib/settingsNotice.ts',
  'components/KeyboardShortcutsDialog.tsx',
  'components/PlaceholderRunDialog.tsx',
  'components/askPlaceholderRun.tsx',
  'components/panels/AgentLog.tsx',
  'components/agent-notes/AgentNotesCorner.tsx',
  'components/agent-notes/AgentNoteCard.tsx',
  'components/agent-notes/AgentNotesList.tsx',
  'components/agent-notes/AgentNoteParts.tsx',
  'components/agent-notes/AgentNoteOutlineLayer.tsx',
  // Agents on the nodes (Q125 item 3).
  'components/canvas/AgentNodeMarkLayer.tsx',
  'components/canvas/agentNodeMarks.ts',
  'components/canvas/nodeCardBox.ts',
  'components/agent-notes/AgentQuestionsForm.tsx',
  'components/agent-notes/AgentQuestionsAnswers.tsx',
  // The Agents panel (Q125 item 2): its own chunk inside the corner's.
  'components/agent-notes/AgentRoster.tsx',
  // The Needs-you rule the chip's badge shares with the panel (in the corner's chunk).
  'components/agent-notes/agentNeedsYou.ts',
  'components/agent-notes/agentRosterModel.ts',
  'components/agent-notes/agentRosterStore.ts',
  'lib/agentRoster.ts',
  'lib/agentNotesView.ts',
  'lib/agentNotesBoard.ts',
  'lib/unreadRing.ts',
  'lib/assetProposalReview.ts',
  'lib/canvasProposalReview.ts',
  'lib/goToCanvas.ts',
  'store/assetProposalReviewRequest.ts',
  'components/panels/RunHistoryPanel.tsx',
  'components/onboarding/OnboardingOverlay.tsx',
  'components/ConnectionPopup.tsx',
  'components/panels/MaskPainterModal.tsx',
  // The mask painter's wrapper and the shell it draws while its chunk loads.
  'components/panels/DeferredMaskPainter.tsx',
  'components/nodes/MeshPreview.tsx',
  'components/nodes/WorldPreview.tsx',
  'components/nodes/WorldSplatPreview.tsx',
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
  'components/canvas/StudioNotice.tsx',
  'components/canvas/DeferredRunNotice.tsx',
  'components/RegionNotices.tsx',
  'hooks/useProposalReadiness.ts',
  'components/canvas/PinLayer.tsx',
  'components/canvas/PinComposer.tsx',
  'components/canvas/AgentCursorLayer.tsx',
  // The agent cursor's motion and look, only in the cursor layer's chunk.
  'lib/agentCursorPlanner.ts',
  'lib/agentCursorLook.ts',
  // Phase 2's expression, default lines, field marks and tuning (lazy too).
  'lib/agentCursorExpression.ts',
  'lib/agentCursorSays.ts',
  'lib/agentCursorField.ts',
  'lib/agentCursorTuning.ts',
  // Its store: the normalising and the replay load with their readers; the
  // entry keeps only the socket feed (store/agentPresenceFeed.ts).
  'store/agentPresenceStore.ts',
];
