import { create } from 'zustand';

interface PanelState {
  visible: boolean;
  position: { x: number; y: number };
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
  panels: {
    library: PanelState;
    inspector: PanelState;
    settings: PanelState;
  };
  librarySearch: string;
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
  togglePanel: (panel: 'library' | 'inspector' | 'settings') => void;
  setPanelPosition: (panel: 'library' | 'inspector' | 'settings', position: { x: number; y: number }) => void;
  setLibrarySearch: (search: string) => void;
  showContextMenu: (position: { x: number; y: number }, nodeId: string | null) => void;
  hideContextMenu: () => void;
  showConnectionPopup: (popup: Omit<ConnectionPopupState, 'visible'>) => void;
  hideConnectionPopup: () => void;
  setSettingsCache: (apiKeys: Record<string, string>) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedNodeId: null,
  panels: {
    library: { visible: true, position: { x: 16, y: 16 } },
    inspector: { visible: false, position: { x: -280, y: 16 } },
    settings: { visible: false, position: { x: -340, y: 60 } },
  },
  librarySearch: '',
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
