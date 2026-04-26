import { create } from 'zustand';

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

  selectNode: (nodeId: string | null) => void;
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
}

export const useUIStore = create<UIState>((set) => ({
  selectedNodeId: null,
  chatResized: false,
  panels: {
    library: { visible: true, position: { x: 16, y: 16 } },
    inspector: { visible: false, position: { x: -280, y: 16 } },
    settings: { visible: false, position: { x: -340, y: 60 } },
    // Chat is the dominant right-column surface in the new layout — visible
    // by default. Width seed (300) is ignored until chatResized flips, so
    // the CSS clamp drives the actual rendered width.
    chat: { visible: true, position: { x: 16, y: 16 }, width: 300 },
  },
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

  selectNode: (nodeId) =>
    set((state) => ({
      selectedNodeId: nodeId,
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible: nodeId !== null },
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
}));
