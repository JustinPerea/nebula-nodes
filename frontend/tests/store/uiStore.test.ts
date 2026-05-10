import { describe, expect, it } from 'vitest';
import { useUIStore } from '../../src/store/uiStore';

describe('uiStore', () => {
  it('resets transient panels for a fresh empty canvas', () => {
    useUIStore.setState((state) => ({
      selectedNodeId: 'n1',
      chatResized: true,
      panels: {
        ...state.panels,
        library: { visible: false, position: { x: 100, y: 120 } },
        inspector: { visible: true, position: { x: 200, y: 220 } },
        settings: { visible: true, position: { x: 300, y: 320 } },
        chat: { visible: true, position: { x: 400, y: 420 }, width: 640, height: 500, left: 500, top: 40 },
      },
      contextMenu: { visible: true, position: { x: 9, y: 9 }, nodeId: 'n1' },
      connectionPopup: {
        visible: true,
        position: { x: 8, y: 8 },
        nodeId: 'n1',
        handleId: 'out',
        handleType: 'source',
      },
    }));

    useUIStore.getState().resetPanelsForFreshCanvas();

    const state = useUIStore.getState();
    expect(state.selectedNodeId).toBeNull();
    expect(state.chatResized).toBe(false);
    expect(state.panels.library.visible).toBe(true);
    expect(state.panels.inspector.visible).toBe(false);
    expect(state.panels.settings.visible).toBe(false);
    expect(state.panels.chat.visible).toBe(false);
    expect(state.panels.chat.left).toBeUndefined();
    expect(state.panels.chat.top).toBeUndefined();
    expect(state.contextMenu.visible).toBe(false);
    expect(state.connectionPopup.visible).toBe(false);
  });
});
