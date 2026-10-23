/**
 * GM - Design, 2026-10-23 (round 4): "TRIM EDITOR TIMELINE: yes, it publishes
 * its top edge. A notice should never sit over a timeline being edited, even
 * one that shares its column."
 *
 * Round 4b (GM, on #181): "Trim editor: yes, publish the transport's top edge
 * as well, so notices sit over the preview's bottom edge. Cut, Vol and zoom
 * are being used while someone edits."
 *
 * The trim video editor (EditorView, not the Remotion editor) has its
 * transport row (Play / Trim / Speed / Cut / Vol / zoom / Render Preview /
 * Export) and its timeline along the bottom, under the preview. Like the
 * canvas bar, Creator Studio's composer and the Remotion tray, both carry
 * `data-bottom-bar` and write `--bottom-bar-clearance` through the same hook
 * (hooks/useBottomBarClearance.ts), so the notices sit 8 px above the
 * transport, over the preview's bottom edge. The transport wraps to two rows
 * when a clip is selected, so it is measured again when it changes size and
 * on a resize. The value clears when the editor closes, and the empty editor
 * (no video upstream) has neither and publishes nothing.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('../../src/components/editor/VideoPreview', () => ({ VideoPreview: () => <div>Preview</div> }));
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
  data: { label: 'Edit', definitionId: 'video-edit', params: {
    clips: [{ id: 'c1', start: 0, duration: 10, sourceIn: 0, sourceOut: 10, volume: 1, mute: false }],
    sourceDuration: 10, sourceFps: 30 },
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

describe("the trim editor's transport and timeline are its bottom bar", () => {
  it('the transport and the timeline both publish; the transport is higher, so notices clear it', () => {
    vi.stubGlobal('innerHeight', 800);
    // The transport sits between the preview and the timeline.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-transport')) return new DOMRect(24, 476, 1232, 40);
      return this.classList.contains('editor-tl') ? new DOMRect(24, 520, 1232, 256) : new DOMRect();
    });
    const view = render(<EditorView />);
    expect(view.container.querySelector('.editor-tl')).toHaveAttribute('data-bottom-bar', '');
    expect(view.container.querySelector('.editor-transport')).toHaveAttribute('data-bottom-bar', '');
    // Both bands are full width: neither is the Canvas actions panel's "panel".
    expect(view.container.querySelectorAll('[data-bottom-bar=""]')).toHaveLength(2);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('324px');
    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
  });

  it('a selected clip wraps the transport to two rows: its new top edge is published', () => {
    vi.stubGlobal('innerHeight', 800);
    // Records what each observer watches, so only the one watching the
    // transport is told it changed size (other parts of the screen have their own).
    const observers: Array<{ callback: () => void; watched: Element[] }> = [];
    vi.stubGlobal('ResizeObserver', class {
      private entry: { callback: () => void; watched: Element[] };
      constructor(callback: () => void) { this.entry = { callback, watched: [] }; observers.push(this.entry); }
      observe(element: Element) { this.entry.watched.push(element); }
      unobserve() {}
      disconnect() { this.entry.watched = []; }
    });
    const watching = (element: Element) => observers.filter((observer) => observer.watched.includes(element));
    let transportTop = 476;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-transport')) return new DOMRect(24, transportTop, 1232, 516 - transportTop);
      return this.classList.contains('editor-tl') ? new DOMRect(24, 520, 1232, 256) : new DOMRect();
    });
    const view = render(<EditorView />);
    const transport = view.container.querySelector('.editor-transport')!;
    expect(watching(transport)).not.toHaveLength(0);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('324px');
    // Selecting the clip adds the Speed / Vol inspector, and the row wraps.
    act(() => { useUIStore.setState({ selectedClipId: 'c1' }); });
    expect(view.container.querySelector('.editor-transport__inspector')).not.toBeNull();
    transportTop = 436;
    act(() => { for (const observer of watching(transport)) observer.callback(); });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('364px');
  });

  it('a window resize measures the transport again', () => {
    vi.stubGlobal('innerHeight', 800);
    let transportTop = 476;
    let timelineTop = 520;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-transport')) return new DOMRect(24, transportTop, 1232, timelineTop - 4 - transportTop);
      return this.classList.contains('editor-tl') ? new DOMRect(24, timelineTop, 1232, 256) : new DOMRect();
    });
    render(<EditorView />);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('324px');
    // Taller window: the bottom rows move down with it.
    vi.stubGlobal('innerHeight', 900);
    transportTop = 576;
    timelineTop = 620;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('324px');
    // Narrower window: the transport wraps to two rows.
    transportTop = 536;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('364px');
  });

  it('with no video upstream there is no timeline, and nothing is published', () => {
    useGraphStore.setState({ edges: [] });
    document.documentElement.style.setProperty('--bottom-bar-clearance', '72px');
    const view = render(<EditorView />);
    expect(view.container.querySelector('.editor-view--empty')).not.toBeNull();
    expect(view.container.querySelector('[data-bottom-bar]')).toBeNull();
    expect(view.container.querySelector('.editor-transport')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
  });
});
