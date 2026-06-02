import { create } from 'zustand';
import { type SkinId, loadSkin, persistSkin, applySkinBodyClass } from '../lib/skins';
import { useGraphStore } from './graphStore';

const AGENT_LOG_ENABLED_KEY = 'nebula:agentLog:enabled';

const DEFAULT_PANELS = {
  library: { visible: true, position: { x: 16, y: 16 } },
  inspector: { visible: false, position: { x: -280, y: 16 } },
  settings: { visible: false, position: { x: -340, y: 60 } },
  // Chat opens from the bottom-right launcher. Width seed (300) is ignored
  // until chatResized flips, so the CSS clamp drives the rendered width.
  chat: { visible: false, position: { x: 16, y: 16 }, width: 300 },
};

function createDefaultPanels(): UIState['panels'] {
  return {
    library: { ...DEFAULT_PANELS.library, position: { ...DEFAULT_PANELS.library.position } },
    inspector: { ...DEFAULT_PANELS.inspector, position: { ...DEFAULT_PANELS.inspector.position } },
    settings: { ...DEFAULT_PANELS.settings, position: { ...DEFAULT_PANELS.settings.position } },
    chat: { ...DEFAULT_PANELS.chat, position: { ...DEFAULT_PANELS.chat.position } },
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
  viewMode: 'canvas' | 'editor' | 'remotion-editor' | 'cinema-editor' | 'character-editor' | 'moodboard-editor';
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
  // Nebula Moodboard editor — provider-neutral creative-direction assets.
  // App.tsx mounts MoodboardStudioView when this is set.
  moodboardEditorId: string | null;
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
  inspectorPinned: boolean;

  enterEditor: (sourceNodeId: string) => void;
  exitEditor: () => void;
  enterRemotionEditor: (remotionNodeId: string) => void;
  exitRemotionEditor: () => void;
  enterCinemaEditor: (cinemaSceneNodeId: string) => void;
  exitCinemaEditor: () => void;
  enterCharacterEditor: (characterId: string) => void;
  exitCharacterEditor: () => void;
  enterMoodboardEditor: (moodboardId: string) => void;
  exitMoodboardEditor: () => void;
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
  togglePanel: (panel: 'library' | 'inspector' | 'settings' | 'chat') => void;
  setPanelPosition: (panel: 'library' | 'inspector' | 'settings' | 'chat', position: { x: number; y: number }) => void;
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
  resetPanelsForFreshCanvas: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  selectedNodeId: null,
  viewMode: 'canvas',
  editorTargetNodeId: null,
  remotionEditorTargetNodeId: null,
  cinemaEditorNodeId: null,
  characterEditorId: null,
  moodboardEditorId: null,
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
  inspectorPinned: false,

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
  enterCharacterEditor: (characterId) => {
    set({
      viewMode: 'character-editor',
      characterEditorId: characterId,
    });
  },

  exitCharacterEditor: () => {
    set({
      viewMode: 'canvas',
      characterEditorId: null,
    });
  },

  enterMoodboardEditor: (moodboardId) => {
    set({
      viewMode: 'moodboard-editor',
      moodboardEditorId: moodboardId,
    });
  },

  exitMoodboardEditor: () => {
    set({
      viewMode: 'canvas',
      moodboardEditorId: null,
    });
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
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: { ...state.panels[panel], visible: !state.panels[panel].visible },
      },
    })),

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

  resetPanelsForFreshCanvas: () => {
    set({
      selectedNodeId: null,
      chatResized: false,
      inspectorPinned: false,
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
