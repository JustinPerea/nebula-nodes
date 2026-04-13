import { create } from 'zustand';

interface PanelState {
  visible: boolean;
  position: { x: number; y: number };
}

interface UIState {
  selectedNodeId: string | null;
  panels: {
    library: PanelState;
    inspector: PanelState;
  };
  librarySearch: string;

  selectNode: (nodeId: string | null) => void;
  togglePanel: (panel: 'library' | 'inspector') => void;
  setPanelPosition: (panel: 'library' | 'inspector', position: { x: number; y: number }) => void;
  setLibrarySearch: (search: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedNodeId: null,
  panels: {
    library: { visible: true, position: { x: 16, y: 16 } },
    inspector: { visible: false, position: { x: -280, y: 16 } },
  },
  librarySearch: '',

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
}));
