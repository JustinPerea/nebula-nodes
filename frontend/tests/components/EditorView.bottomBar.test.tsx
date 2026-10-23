/**
 * GM - Design, 2026-10-23 (round 4): "TRIM EDITOR TIMELINE: yes, it publishes
 * its top edge. A notice should never sit over a timeline being edited, even
 * one that shares its column."
 *
 * The trim video editor (EditorView, not the Remotion editor) has its
 * timeline along the bottom, sharing the column with the preview. Like the
 * canvas bar, Creator Studio's composer and the Remotion tray, it carries
 * `data-bottom-bar` and writes `--bottom-bar-clearance` through the same hook
 * (hooks/useBottomBarClearance.ts), so the notices sit 8 px above it. The
 * value clears when the editor closes, and the empty editor (no video
 * upstream) has no timeline and publishes nothing.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('../../src/components/editor/VideoPreview', () => ({ VideoPreview: () => <div>Preview</div> }));
vi.mock('../../src/components/editor/EditorTransport', () => ({ EditorTransport: () => <div>Transport</div> }));
vi.mock('../../src/components/editor/EditorBreadcrumb', () => ({ EditorBreadcrumb: () => null }));
vi.mock('../../src/components/editor/TimelineRuler', () => ({ TimelineRuler: () => <div>Ruler</div> }));
vi.mock('../../src/components/editor/TimelineTrack', () => ({ TimelineTrack: () => <div>Track</div> }));
vi.mock('../../src/components/editor/TimelinePlayhead', () => ({ TimelinePlayhead: () => null }));

import { EditorView } from '../../src/components/editor/EditorView';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const source: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Clip', definitionId: 'video-upload', params: {}, state: 'complete',
    outputs: { video: { type: 'Video', value: '/api/outputs/clip.mp4' } } } };
const edit: Node<NodeData> = { id: 'n2', type: 'model-node', position: { x: 300, y: 0 },
  data: { label: 'Edit', definitionId: 'video-edit', params: { clips: [], sourceDuration: 10, sourceFps: 30 },
    state: 'idle', outputs: {} } };
const wire: Edge = { id: 'e1', source: 'n1', sourceHandle: 'video', target: 'n2', targetHandle: 'video_in' };

beforeEach(() => {
  useGraphStore.setState({ nodes: [source, edit], edges: [wire] });
  useUIStore.setState({ editorTargetNodeId: 'n2' });
});
afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--bottom-bar-clearance');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("the trim editor's timeline is its bottom bar", () => {
  it('publishes its top edge for the notices, and clears it when the editor closes', () => {
    vi.stubGlobal('innerHeight', 800);
    // The timeline: the column's lower part, under the preview and the transport.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('editor-tl') ? new DOMRect(24, 520, 1232, 256) : new DOMRect();
    });
    const view = render(<EditorView />);
    const timeline = view.container.querySelector('.editor-tl')!;
    expect(timeline).toHaveAttribute('data-bottom-bar', '');
    // The only bar on this screen.
    expect(view.container.querySelectorAll('[data-bottom-bar]')).toHaveLength(1);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('280px');
    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
  });

  it('with no video upstream there is no timeline, and nothing is published', () => {
    useGraphStore.setState({ edges: [] });
    document.documentElement.style.setProperty('--bottom-bar-clearance', '72px');
    const view = render(<EditorView />);
    expect(view.container.querySelector('.editor-view--empty')).not.toBeNull();
    expect(view.container.querySelector('[data-bottom-bar]')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
  });
});
