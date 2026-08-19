import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { type SkinId, loadSkin, persistSkin, applySkinBodyClass } from '../lib/skins';
import {
  getNotificationPrefs,
  setNotificationPrefs as persistNotificationPrefs,
  ensureNotificationPermission,
  primeAudio,
  type NotificationPrefs,
} from '../lib/jobNotifications';
import type { Preset } from '../lib/createPresets';
import { useGraphStore } from './graphStore';

const AGENT_LOG_ENABLED_KEY = 'nebula:agentLog:enabled';
const CANVAS_PERF_MODE_KEY = 'nebula:canvas:perfMode';
const CANVAS_LOW_DETAIL_KEY = 'nebula:canvas:lowDetail';
const ONBOARDED_KEY = 'nebula:onboarded';
const PANEL_EDGE_MARGIN = 16;
const RUN_HISTORY_WIDTH = 276;

export type AssetScope = 'global' | 'project';

export function defaultRunHistoryPosition(viewportWidth?: number): { x: number; y: number } {
  const width = viewportWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : 1280);
  return {
    x: Math.max(PANEL_EDGE_MARGIN, width - RUN_HISTORY_WIDTH - PANEL_EDGE_MARGIN),
    y: 60,
  };
}

function loadOnboarded(): boolean {
  if (typeof window === 'undefined') return true; // SSR: treat as done (never auto-open)
  return window.localStorage.getItem(ONBOARDED_KEY) === '1';
}

function persistOnboarded(done: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ONBOARDED_KEY, done ? '1' : '0');
}

const DEFAULT_PANELS = {
  library: { visible: true, position: { x: 16, y: 16 } },
  inspector: { visible: false, position: { x: -280, y: 16 } },
  settings: { visible: false, position: { x: -340, y: 60 } },
  // Chat opens from the bottom-right launcher. Width seed (300) is ignored
  // until chatResized flips, so the CSS clamp drives the rendered width.
  chat: { visible: false, position: { x: 16, y: 16 }, width: 300 },
  moodboard: { visible: false, position: { x: 16, y: 16 } },
  character: { visible: false, position: { x: 16, y: 360 } },
  // Unified Assets panel (Characters · Moodboards · Styles) — replaces the
  // separate character/moodboard library panels. Opened from its launcher.
  assets: { visible: false, position: { x: 16, y: 360 } },
  // Run History panel — persistent record of graph/node/cluster runs.
  history: { visible: false, position: { x: 16, y: 60 } },
};

function createDefaultPanels(): UIState['panels'] {
  return {
    library: { ...DEFAULT_PANELS.library, position: { ...DEFAULT_PANELS.library.position } },
    inspector: { ...DEFAULT_PANELS.inspector, position: { ...DEFAULT_PANELS.inspector.position } },
    settings: { ...DEFAULT_PANELS.settings, position: { ...DEFAULT_PANELS.settings.position } },
    chat: { ...DEFAULT_PANELS.chat, position: { ...DEFAULT_PANELS.chat.position } },
    moodboard: { ...DEFAULT_PANELS.moodboard, position: { ...DEFAULT_PANELS.moodboard.position } },
    character: { ...DEFAULT_PANELS.character, position: { ...DEFAULT_PANELS.character.position } },
    assets: { ...DEFAULT_PANELS.assets, position: { ...DEFAULT_PANELS.assets.position } },
    history: { ...DEFAULT_PANELS.history, position: defaultRunHistoryPosition() },
  };
}

function loadAgentLogEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(AGENT_LOG_ENABLED_KEY) === '1';
}

function persistAgentLogEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(AGENT_LOG_ENABLED_KEY, enabled ? '1' : '0');
}

// Canvas performance prefs default ON (perf win with negligible visual cost for
// render-culling; the minimap/controls chrome and zoom LOD are the visible part).
function loadCanvasPref(key: string): boolean {
  if (typeof window === 'undefined') return true;
  const raw = window.localStorage.getItem(key);
  return raw === null ? true : raw === '1';
}

function persistCanvasPref(key: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, enabled ? '1' : '0');
}

interface PanelState {
  visible: boolean;
  position: { x: number; y: number };
}

interface ChatPanelState extends PanelState {
  width: number;
  height?: number;
  // When the user drags the panel, we switch from the default top-right
  // anchoring to explicit left/top coordinates. Until then these are null.
  left?: number | null;
  top?: number | null;
}

interface ConnectionPopupState {
  visible: boolean;
  position: { x: number; y: number };
  nodeId: string;
  handleId: string;
  handleType: 'source' | 'target';
}

interface UIState {
  selectedNodeId: string | null;

  // Editor view state — Phase 1 video-editor pivot
  viewMode: 'canvas' | 'editor' | 'remotion-editor' | 'cinema-editor' | 'character-editor' | 'moodboard-editor' | 'create' | 'brand-showcase';
  editorTargetNodeId: string | null;
  // Phase 2 Remotion editor
  remotionEditorTargetNodeId: string | null;
  // Soul Cinema Studio editor — which cinema-scene node is being edited.
  // Mirrors remotionEditorTargetNodeId. App.tsx mounts CinemaStudioView (Wave 5)
  // when this is set.
  cinemaEditorNodeId: string | null;
  // Nebula Character editor — which Character (by id) is open for editing.
  // Mirrors cinemaEditorNodeId. App.tsx mounts CharacterStudioView when this is
  // set (viewMode 'character-editor'). The 'new' sentinel opens a fresh draft.
  characterEditorId: string | null;
  characterEditorScope: AssetScope;
  // Nebula Moodboard editor — provider-neutral creative-direction assets.
  // App.tsx mounts MoodboardStudioView when this is set.
  moodboardEditorId: string | null;
  moodboardEditorScope: AssetScope;
  // Create view — Higgsfield-style graph-builder surface. App.tsx mounts CreateView
  // when viewMode === 'create'. createSessionId tags nodes authored this session.
  createSessionId: string | null;
  selectedTrackItemId: string | null;
  selectedTrackItemIds: string[];
  isKeyframeRecording: boolean;
  selectedClipId: string | null;
  playheadOutputTime: number;
  timelineZoom: number;
  // Lifted from VideoPreview so EditorTransport's Play button can drive the
  // same state and flip its icon between Play and Pause. The actual playback
  // loop still lives in VideoPreview — this is just the toggle.
  isPlaying: boolean;
  // Set by Render Preview / Re-render in EditorTransport so VideoPreview
  // can swap its <video src> from the source pass-through to the actual
  // ffmpeg-rendered output. Cleared on editor enter/exit so a fresh session
  // never shows a stale render from a prior edit node.
  renderedPreviewUrl: string | null;
  // True after the user manually resizes/drags the chat panel. While false,
  // ChatPanel skips its inline width/height so CSS-driven sizing
  // (clamp + viewport units) drives the chat width and lines it up with the
  // agent log. Cleared by the toolbar's Reset button.
  chatResized: boolean;
  panels: {
    library: PanelState;
    inspector: PanelState;
    settings: PanelState;
    chat: ChatPanelState;
    moodboard: PanelState;
    character: PanelState;
    assets: PanelState;
    history: PanelState;
  };
  librarySearch: string;
  libraryCollapsed: Record<string, boolean>;
  contextMenu: {
    visible: boolean;
    position: { x: number; y: number };
    nodeId: string | null;
  };
  connectionPopup: ConnectionPopupState;
  settingsCache: {
    apiKeys: Record<string, string>;
    loaded: boolean;
  };
  skin: SkinId;
  agentLogEnabled: boolean;
  canvasPerfMode: boolean;
  canvasLowDetail: boolean;
  notificationPrefs: NotificationPrefs;
  hasOnboarded: boolean;
  onboardingActive: boolean;
  onboardingStep: number;
  /** A preset handed from the Assets panel's Styles tab to the Create view,
   *  consumed (and cleared) by CreateView on mount. */
  pendingPreset: Preset | null;
  inspectorPinned: boolean;
  canvasTool: 'pan' | 'select';

  enterEditor: (sourceNodeId: string) => void;
  exitEditor: () => void;
  enterRemotionEditor: (remotionNodeId: string) => void;
  exitRemotionEditor: () => void;
  enterCinemaEditor: (cinemaSceneNodeId: string) => void;
  exitCinemaEditor: () => void;
  enterCharacterEditor: (characterId: string, scope?: AssetScope) => void;
  exitCharacterEditor: () => void;
  enterMoodboardEditor: (moodboardId: string, scope?: AssetScope) => void;
  exitMoodboardEditor: () => void;
  enterCreateView: () => void;
  exitCreateView: () => void;
  // Brand / Dynamic Mark showcase — a standalone reference + demo surface
  // (not product chrome). Reachable via the `#brand` hash route.
  enterBrandShowcase: () => void;
  exitBrandShowcase: () => void;
  setSelectedTrackItem: (id: string | null) => void;
  setSelectedTrackItems: (ids: string[], primaryId?: string | null) => void;
  toggleSelectedTrackItem: (id: string) => void;
  toggleKeyframeRecording: () => void;
  setSelectedClip: (id: string | null) => void;
  setPlayheadOutputTime: (t: number) => void;
  setIsPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setRenderedPreviewUrl: (url: string | null) => void;
  setTimelineZoom: (zoom: number) => void;
  zoomTimelineIn: () => void;
  zoomTimelineOut: () => void;
  resetTimelineZoom: () => void;

  selectNode: (nodeId: string | null) => void;
  setInspectorVisible: (visible: boolean) => void;
  setInspectorPinned: (pinned: boolean) => void;
  togglePanel: (panel: 'library' | 'inspector' | 'settings' | 'chat' | 'moodboard' | 'character' | 'assets' | 'history') => void;
  setPanelPosition: (panel: 'library' | 'inspector' | 'settings' | 'chat' | 'moodboard' | 'character' | 'assets' | 'history', position: { x: number; y: number }) => void;
  setLibrarySearch: (search: string) => void;
  toggleLibraryCategory: (category: string) => void;
  setAllLibraryCategories: (collapsed: boolean, categories: string[]) => void;
  setChatWidth: (width: number) => void;
  setChatHeight: (height: number) => void;
  setChatPosition: (left: number, top: number) => void;
  showContextMenu: (position: { x: number; y: number }, nodeId: string | null) => void;
  hideContextMenu: () => void;
  showConnectionPopup: (popup: Omit<ConnectionPopupState, 'visible'>) => void;
  hideConnectionPopup: () => void;
  setSettingsCache: (apiKeys: Record<string, string>) => void;
  setSkin: (skin: SkinId) => void;
  setAgentLogEnabled: (enabled: boolean) => void;
  setCanvasPerfMode: (enabled: boolean) => void;
  setCanvasLowDetail: (enabled: boolean) => void;
  setNotificationPrefs: (partial: Partial<NotificationPrefs>) => void;
  startOnboarding: () => void;
  nextOnboardingStep: () => void;
  prevOnboardingStep: () => void;
  finishOnboarding: () => void;
  setPendingPreset: (preset: Preset | null) => void;
  consumePendingPreset: () => Preset | null;
  setCanvasTool: (tool: 'pan' | 'select') => void;
  resetPanelLayout: () => void;
  resetPanelsForFreshCanvas: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  selectedNodeId: null,
  viewMode: 'canvas',
  editorTargetNodeId: null,
  remotionEditorTargetNodeId: null,
  cinemaEditorNodeId: null,
  characterEditorId: null,
  characterEditorScope: 'global',
  moodboardEditorId: null,
  moodboardEditorScope: 'global',
  createSessionId: null,
  selectedTrackItemId: null,
  selectedTrackItemIds: [],
  isKeyframeRecording: false,
  selectedClipId: null,
  playheadOutputTime: 0,
  timelineZoom: 1,
  isPlaying: false,
  renderedPreviewUrl: null,
  chatResized: false,
  panels: createDefaultPanels(),
  librarySearch: '',
  libraryCollapsed: {},
  contextMenu: {
    visible: false,
    position: { x: 0, y: 0 },
    nodeId: null,
  },
  connectionPopup: {
    visible: false,
    position: { x: 0, y: 0 },
    nodeId: '',
    handleId: '',
    handleType: 'source',
  },
  settingsCache: { apiKeys: {}, loaded: false },
  skin: loadSkin(),
  agentLogEnabled: loadAgentLogEnabled(),
  canvasPerfMode: loadCanvasPref(CANVAS_PERF_MODE_KEY),
  canvasLowDetail: loadCanvasPref(CANVAS_LOW_DETAIL_KEY),
  notificationPrefs: getNotificationPrefs(),
  hasOnboarded: loadOnboarded(),
  onboardingActive: false,
  onboardingStep: 0,
  pendingPreset: null,
  inspectorPinned: false,
  canvasTool: 'pan',

  enterEditor: (sourceNodeId) => {
    const editNodeId = useGraphStore.getState().getOrCreateEditNodeDownstream(sourceNodeId);
    set({
      viewMode: 'editor',
      editorTargetNodeId: editNodeId,
      selectedClipId: null,
      playheadOutputTime: 0,
      isPlaying: false,
      renderedPreviewUrl: null,
    });
  },

  exitEditor: () => {
    const state = get();
    if (state.editorTargetNodeId) {
      useGraphStore.getState().removeEmptyEditNode(state.editorTargetNodeId);
    }
    set({ viewMode: 'canvas', editorTargetNodeId: null, selectedClipId: null, isPlaying: false, renderedPreviewUrl: null });
  },

  // Phase 2's RemotionEditor playback state is owned by @remotion/player's
  // PlayerRef, not Zustand. We only track which RemotionNode is being edited.
  enterRemotionEditor: (remotionNodeId) => {
    set({
      viewMode: 'remotion-editor',
      remotionEditorTargetNodeId: remotionNodeId,
    });
  },

  exitRemotionEditor: () => {
    set({
      viewMode: 'canvas',
      remotionEditorTargetNodeId: null,
      selectedTrackItemId: null,
      selectedTrackItemIds: [],
      isKeyframeRecording: false,
      isPlaying: false,
    });
  },

  // Soul Cinema Studio — mirrors enterRemotionEditor. We only track which
  // cinema-scene node is being edited; the Studio view (Wave 5) reads the
  // node's data.params.scene and writes back through graphStore.updateScene.
  enterCinemaEditor: (cinemaSceneNodeId) => {
    set({
      viewMode: 'cinema-editor',
      cinemaEditorNodeId: cinemaSceneNodeId,
    });
  },

  exitCinemaEditor: () => {
    set({
      viewMode: 'canvas',
      cinemaEditorNodeId: null,
    });
  },

  // Nebula Character editor — mirrors enterCinemaEditor. Flips into the
  // full-screen Character Studio (App.tsx mounts CharacterStudioView on
  // viewMode 'character-editor') and tracks which Character is open. The
  // sentinel id 'new' opens a fresh local draft (the Studio treats any id that
  // doesn't resolve to a stored Character as a draft).
  enterCharacterEditor: (characterId, scope = 'global') => {
    set({
      viewMode: 'character-editor',
      characterEditorId: characterId,
      characterEditorScope: scope,
    });
  },

  exitCharacterEditor: () => {
    set({
      viewMode: 'canvas',
      characterEditorId: null,
    });
  },

  enterMoodboardEditor: (moodboardId, scope = 'global') => {
    set({
      viewMode: 'moodboard-editor',
      moodboardEditorId: moodboardId,
      moodboardEditorScope: scope,
    });
  },

  exitMoodboardEditor: () => {
    set({
      viewMode: 'canvas',
      moodboardEditorId: null,
    });
  },

  enterCreateView: () => {
    set({ viewMode: 'create', createSessionId: uuidv4() });
  },
  exitCreateView: () => {
    // Clear any un-consumed Styles-tab preset so it can't leak into a later visit.
    set({ viewMode: 'canvas', createSessionId: null, pendingPreset: null });
  },

  enterBrandShowcase: () => {
    set({ viewMode: 'brand-showcase' });
  },
  exitBrandShowcase: () => {
    set({ viewMode: 'canvas' });
  },

  setSelectedTrackItem: (id) => {
    set({ selectedTrackItemId: id, selectedTrackItemIds: id ? [id] : [] });
  },

  setSelectedTrackItems: (ids, primaryId) => {
    const uniqueIds = Array.from(new Set(ids));
    const primary =
      primaryId && uniqueIds.includes(primaryId)
        ? primaryId
        : uniqueIds[uniqueIds.length - 1] ?? null;
    set({ selectedTrackItemId: primary, selectedTrackItemIds: uniqueIds });
  },

  toggleSelectedTrackItem: (id) => {
    set((state) => {
      const currentIds =
        state.selectedTrackItemIds.length > 0
          ? state.selectedTrackItemIds
          : state.selectedTrackItemId
            ? [state.selectedTrackItemId]
            : [];
      const isSelected = currentIds.includes(id);
      const selectedTrackItemIds = isSelected
        ? currentIds.filter((selectedId) => selectedId !== id)
        : [...currentIds, id];
      const selectedTrackItemId = isSelected
        ? state.selectedTrackItemId === id
          ? selectedTrackItemIds[selectedTrackItemIds.length - 1] ?? null
          : state.selectedTrackItemId
        : id;
      return {
        selectedTrackItemId,
        selectedTrackItemIds,
      };
    });
  },

  toggleKeyframeRecording: () => {
    set((s) => ({ isKeyframeRecording: !s.isKeyframeRecording }));
  },

  setSelectedClip: (id) => set({ selectedClipId: id }),

  setPlayheadOutputTime: (t) => set({ playheadOutputTime: t }),

  setIsPlaying: (playing) => set({ isPlaying: playing }),

  togglePlaying: () => set((s) => ({ isPlaying: !s.isPlaying })),

  setRenderedPreviewUrl: (url) => set({ renderedPreviewUrl: url }),

  setTimelineZoom: (zoom) => set({ timelineZoom: Math.max(1, Math.min(10, zoom)) }),
  zoomTimelineIn: () => set((s) => ({ timelineZoom: Math.min(10, s.timelineZoom * 2) })),
  zoomTimelineOut: () => set((s) => ({ timelineZoom: Math.max(1, s.timelineZoom / 2) })),
  resetTimelineZoom: () => set({ timelineZoom: 1 }),

  selectNode: (nodeId) =>
    set((state) => ({
      selectedNodeId: nodeId,
      inspectorPinned: nodeId === null ? false : state.inspectorPinned,
      panels: {
        ...state.panels,
        library: state.panels.library,
        inspector: {
          ...state.panels.inspector,
          visible: nodeId !== null && state.inspectorPinned ? state.panels.inspector.visible : false,
        },
      },
    })),

  setInspectorVisible: (visible) =>
    set((state) => ({
      inspectorPinned: visible ? state.inspectorPinned : false,
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible },
      },
    })),

  setInspectorPinned: (pinned) =>
    set((state) => ({
      inspectorPinned: pinned,
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible: pinned ? true : state.panels.inspector.visible },
      },
    })),

  togglePanel: (panel) =>
    set((state) => {
      const opening = !state.panels[panel].visible;
      const panels = {
        ...state.panels,
        [panel]: { ...state.panels[panel], visible: opening },
      };

      // Nodes and Assets own the same left rail. Opening one closes the other
      // so neither can obscure the other while both launchers claim active.
      if (opening && panel === 'library') {
        panels.assets = { ...panels.assets, visible: false };
      } else if (opening && panel === 'assets') {
        panels.library = { ...panels.library, visible: false };
      }

      return { panels };
    }),

  setPanelPosition: (panel, position) =>
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: { ...state.panels[panel], position },
      },
    })),

  setLibrarySearch: (search) => set({ librarySearch: search }),

  toggleLibraryCategory: (category) =>
    set((state) => ({
      libraryCollapsed: {
        ...state.libraryCollapsed,
        [category]: !state.libraryCollapsed[category],
      },
    })),

  setAllLibraryCategories: (collapsed, categories) =>
    set(() => ({
      libraryCollapsed: Object.fromEntries(categories.map((c) => [c, collapsed])),
    })),

  setChatWidth: (width) =>
    set((state) => ({
      chatResized: true,
      panels: {
        ...state.panels,
        chat: { ...state.panels.chat, width: Math.max(260, Math.min(720, width)) },
      },
    })),

  setChatHeight: (height) =>
    set((state) => ({
      chatResized: true,
      panels: {
        ...state.panels,
        chat: { ...state.panels.chat, height: Math.max(240, Math.min(2000, height)) },
      },
    })),

  setChatPosition: (left, top) =>
    set((state) => {
      // Keep at least 40px of the panel inside the viewport on each side
      // so the user can always grab it back.
      const clampedLeft = Math.max(-state.panels.chat.width + 40, Math.min(window.innerWidth - 40, left));
      const clampedTop = Math.max(0, Math.min(window.innerHeight - 40, top));
      return {
        panels: {
          ...state.panels,
          chat: { ...state.panels.chat, left: clampedLeft, top: clampedTop },
        },
      };
    }),

  showContextMenu: (position, nodeId) =>
    set({
      contextMenu: { visible: true, position, nodeId },
    }),

  hideContextMenu: () =>
    set({
      contextMenu: { visible: false, position: { x: 0, y: 0 }, nodeId: null },
    }),

  showConnectionPopup: (popup) =>
    set({
      connectionPopup: { ...popup, visible: true },
    }),

  hideConnectionPopup: () =>
    set((state) => ({
      connectionPopup: { ...state.connectionPopup, visible: false },
    })),

  setSettingsCache: (apiKeys) =>
    set({ settingsCache: { apiKeys, loaded: true } }),

  setSkin: (skin) => {
    persistSkin(skin);
    applySkinBodyClass(skin);
    set({ skin });
  },

  setAgentLogEnabled: (enabled) => {
    persistAgentLogEnabled(enabled);
    set({ agentLogEnabled: enabled });
  },

  setCanvasPerfMode: (enabled) => {
    persistCanvasPref(CANVAS_PERF_MODE_KEY, enabled);
    set({ canvasPerfMode: enabled });
  },

  setCanvasLowDetail: (enabled) => {
    persistCanvasPref(CANVAS_LOW_DETAIL_KEY, enabled);
    set({ canvasLowDetail: enabled });
  },

  setNotificationPrefs: (partial) => {
    const next = { ...get().notificationPrefs, ...partial };
    persistNotificationPrefs(next);
    set({ notificationPrefs: next });
    // Enabling is a user gesture — the moment to request permission and unlock audio.
    if (partial.enabled) {
      void ensureNotificationPermission();
      primeAudio();
    }
  },

  startOnboarding: () => set({ onboardingActive: true, onboardingStep: 0 }),
  nextOnboardingStep: () => set((s) => ({ onboardingStep: s.onboardingStep + 1 })),
  prevOnboardingStep: () => set((s) => ({ onboardingStep: Math.max(0, s.onboardingStep - 1) })),
  finishOnboarding: () => {
    persistOnboarded(true);
    set({ hasOnboarded: true, onboardingActive: false, onboardingStep: 0 });
  },

  setPendingPreset: (preset) => set({ pendingPreset: preset }),
  consumePendingPreset: () => {
    const p = get().pendingPreset;
    if (p) set({ pendingPreset: null });
    return p;
  },

  setCanvasTool: (tool) => set({ canvasTool: tool }),

  resetPanelLayout: () => {
    const defaults = createDefaultPanels();
    set((state) => ({
      chatResized: false,
      panels: {
        library: { ...state.panels.library, position: defaults.library.position },
        inspector: { ...state.panels.inspector, position: defaults.inspector.position },
        settings: { ...state.panels.settings, position: defaults.settings.position },
        chat: {
          ...state.panels.chat,
          position: defaults.chat.position,
          width: defaults.chat.width,
          height: undefined,
          left: undefined,
          top: undefined,
        },
        moodboard: { ...state.panels.moodboard, position: defaults.moodboard.position },
        character: { ...state.panels.character, position: defaults.character.position },
        assets: { ...state.panels.assets, position: defaults.assets.position },
        history: { ...state.panels.history, position: defaults.history.position },
      },
    }));
  },

  resetPanelsForFreshCanvas: () => {
    set({
      selectedNodeId: null,
      chatResized: false,
      inspectorPinned: false,
      pendingPreset: null,
      panels: createDefaultPanels(),
      contextMenu: { visible: false, position: { x: 0, y: 0 }, nodeId: null },
      connectionPopup: {
        visible: false,
        position: { x: 0, y: 0 },
        nodeId: '',
        handleId: '',
        handleType: 'source',
      },
    });
  },
}));

// Apply the persisted skin's body class on module load so the first paint
// is already correct (no flash of unskinned content). The store's setSkin
// keeps it in sync after that.
if (typeof document !== 'undefined') {
  applySkinBodyClass(useUIStore.getState().skin, { animate: false });
}

// Expose store globally for puppeteer-driven demo scripts (mirrors the
// __nebulaGraphStore + __nebulaCanvas + __nebulaChat exports). Lets demo
// scripts move panels, toggle visibility, etc. without simulated drag.
if (typeof window !== 'undefined') {
  (window as unknown as { __nebulaUIStore?: typeof useUIStore }).__nebulaUIStore = useUIStore;
}
