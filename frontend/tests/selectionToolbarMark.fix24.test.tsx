/**
 * PR #199 fix round 24, found in the live check after the merge: React Flow marks a node
 * `selected` a render after the store says so, so the toolbar's first placement from no
 * selection ran before any node was marked and left the toolbar 'clear', over a node near
 * the top, until something else moved it (a real click did the same). A node gaining the
 * mark places the toolbar again.
 */
import { act, render, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeData } from '../src/types';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { useGraphStore } from '../src/store/graphStore';
import { SELECTION_TOOLBAR_PLACE_ATTR } from '../src/lib/bottomBar';

const rect = (el: Element, r: { top: number; bottom: number; left: number; right: number }) => {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r }) as DOMRect;
};
afterEach(() => { useGraphStore.setState({ nodes: [], edges: [] }); document.body.innerHTML = ''; });

describe('the toolbar places itself again when a node gains the selected mark', () => {
  it('first placement with no marked node stays clear; the mark flips it below a node near the top', async () => {
    const node = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
      data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'x' }, outputs: {}, state: 'idle' } } as Node<NodeData>;
    const flow = document.createElement('div');
    flow.className = 'react-flow';
    const layer = document.createElement('div');
    layer.className = 'react-flow__nodes';
    const dom = document.createElement('div');
    dom.className = 'react-flow__node'; // not marked yet: React Flow marks it a render later
    layer.append(dom);
    flow.append(layer);
    document.body.append(flow);
    rect(dom, { top: 140, bottom: 300, left: 600, right: 840 });
    useGraphStore.setState({ nodes: [node], edges: [] });
    const host = document.createElement('div');
    host.className = 'selection-toolbar-panel';
    flow.append(host);
    rect(host, { top: 128, bottom: 178, left: 420, right: 1020 });
    const view = render(<SelectionToolbar />, { container: host });
    const toolbar = host.querySelector<HTMLElement>('.selection-toolbar')!;
    rect(toolbar, { top: 128, bottom: 178, left: 420, right: 1020 });
    Object.defineProperty(toolbar, 'offsetHeight', { value: 50 });
    expect(host.getAttribute(SELECTION_TOOLBAR_PLACE_ATTR)).toBe('clear');
    act(() => { dom.classList.add('selected'); });
    await waitFor(() => expect(host.getAttribute(SELECTION_TOOLBAR_PLACE_ATTR)).toBe('below'), { timeout: 2000 });
    view.unmount();
  });
});
