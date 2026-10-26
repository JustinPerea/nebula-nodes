/**
 * GM - Design, 2026-10-23 (round 3, answer 4): "Yes, the Remotion tray
 * publishes its top edge, the same as the canvas bar and the composer." The
 * Remotion editor's timeline tray (320 px along the bottom) carries
 * `data-bottom-bar` and writes `--bottom-bar-clearance` through the same hook
 * (hooks/useBottomBarClearance.ts), so the notices sit 8 px above it, and the
 * value clears when the editor closes.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('@remotion/player', () => ({ Player: () => <div data-testid="player" /> }));
vi.mock('../../src/components/video-editor/RemotionTimeline', () => ({ RemotionTimeline: () => <div>Timeline</div> }));
vi.mock('../../src/components/video-editor/RemotionPropertiesPanel', () => ({ RemotionPropertiesPanel: () => null }));
vi.mock('../../src/components/video-editor/RemotionEditorToolbar', () => ({ RemotionEditorToolbar: () => null }));
vi.mock('../../src/components/video-editor/PlayerOverlay', () => ({ PlayerOverlay: () => null }));
vi.mock('../../src/components/video-editor/RemotionComposition', () => ({ RemotionComposition: () => null }));
vi.mock('../../src/components/video-editor/useRemotionKeyboard', () => ({ useRemotionKeyboard: () => {} }));

import { RemotionEditorView } from '../../src/components/video-editor/RemotionEditorView';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const composition: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Composition', definitionId: 'remotion-composition', params: {}, state: 'idle', outputs: {} } };

beforeEach(() => {
  useGraphStore.setState({ nodes: [composition], edges: [] });
  useUIStore.setState({ remotionEditorTargetNodeId: 'n1' });
});
afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--bottom-bar-clearance');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("the Remotion editor's timeline tray is its bottom bar", () => {
  it('publishes its top edge for the notices, and clears it when the editor closes', () => {
    vi.stubGlobal('innerHeight', 800);
    // The tray: the grid's last 320 px row, under the player, left of the 320 px panel.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('remotion-editor-view__timeline') ? new DOMRect(0, 480, 960, 320) : new DOMRect();
    });
    const view = render(<RemotionEditorView />);
    const tray = view.container.querySelector('.remotion-editor-view__timeline')!;
    expect(tray).toHaveAttribute('data-bottom-bar', '');
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('320px');
    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
  });

  it('with no composition open there is no tray, and nothing is published', () => {
    useUIStore.setState({ remotionEditorTargetNodeId: null });
    document.documentElement.style.setProperty('--bottom-bar-clearance', '72px');
    const view = render(<RemotionEditorView />);
    expect(view.container.querySelector('[data-bottom-bar]')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
  });
});
