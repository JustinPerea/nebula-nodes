import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import type { ReactElement } from 'react';

const api = vi.hoisted(() => ({ lookupStoredAsset: vi.fn() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

import { MoodboardNode } from './MoodboardNode';
import { CharacterNode } from './CharacterNode';
import { useUIStore } from '../../store/uiStore';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';
import { setOpenProject } from '../../test/projectState';

const enterMoodboardEditor = vi.fn();
const enterCharacterEditor = vi.fn();

beforeEach(() => {
  api.lookupStoredAsset.mockReset();
  enterMoodboardEditor.mockReset();
  enterCharacterEditor.mockReset();
  useStoredAssetsStore.setState({ entries: {} });
  useUIStore.setState({ enterMoodboardEditor, enterCharacterEditor } as never);
  // The node was copied from Shoot A's canvas into Shoot B, which is open now.
  setOpenProject(['pB', 'Shoot B'], [['pA', 'Shoot A']]);
});

function renderNode(node: ReactElement) {
  return render(<ReactFlowProvider>{node}</ReactFlowProvider>);
}

/** A node points at a saved asset by id, whatever project it lives in: a
 * card pasted into another project shows it and opens it (Justin, 2026-10-19:
 * "we can copy the node moodboards live in to a different project"). */
describe("a card for another project's asset", () => {
  it('Moodboard: shows the board and opens it in the Studio', async () => {
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: {
      id: 'pa1', name: 'Shoot A board', thumbnail: '/api/outputs/a.png', images: [{}, {}], mode: 'look', projectId: 'pA' } });
    const props = { id: 'n1', data: { params: { moodboard: 'pa1' } }, selected: false } as unknown as NodeProps;
    renderNode(<MoodboardNode {...props} />);

    expect(await screen.findByText('Shoot A board')).toBeTruthy();
    expect(screen.getByText('2 images · look')).toBeTruthy();
    expect(api.lookupStoredAsset).toHaveBeenCalledWith('moodboard', 'pa1');
    fireEvent.doubleClick(screen.getByText('Shoot A board'));
    expect(enterMoodboardEditor).toHaveBeenCalledWith('pa1');
  });

  it('Moodboard: counts the set-aside images beside the image count', async () => {
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: {
      id: 'sa1', name: 'Summer Light', thumbnail: '/api/outputs/s.png', mode: 'look', projectId: 'pB',
      images: [1, 1, 1, 1].map((weight) => ({ weight, excluded: false })).concat({ weight: 1, excluded: true }) } });
    const props = { id: 'n3', data: { params: { moodboard: 'sa1' } }, selected: false } as unknown as NodeProps;
    renderNode(<MoodboardNode {...props} />);

    expect(await screen.findByText('5 images · 1 set aside · look')).toBeTruthy();
  });

  it('Moodboard: a long count keeps one line and reads whole on hover', async () => {
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: {
      id: 'sa2', name: 'Big board', thumbnail: '/api/outputs/s.png', mode: 'subject', projectId: 'pB',
      images: Array.from({ length: 124 }, (_, index) => ({ weight: 1, excluded: index < 112 })) } });
    const props = { id: 'n4', data: { params: { moodboard: 'sa2' } }, selected: false } as unknown as NodeProps;
    renderNode(<MoodboardNode {...props} />);

    const meta = await screen.findByText('124 images · 112 set aside · subject');
    // The card's line is cut with an ellipsis (moodboard-node.css) rather
    // than wrapping, so the card keeps its height; the whole line is its title.
    expect(meta.className).toBe('moodboard-node__meta moodboard-node__meta--count');
    expect(meta.getAttribute('title')).toBe('124 images · 112 set aside · subject');
  });

  it('Moodboard: a missing board says why in full, wrapping, not cut to one line', async () => {
    // Only the count is cut: "#<id> was deleted for good or never existed"
    // is about 280 px at 11 px, and cut to one line it would lose the why.
    api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
    const props = { id: 'n5', data: { params: { moodboard: '3f2a9b1c4d5e' } }, selected: false } as unknown as NodeProps;
    renderNode(<MoodboardNode {...props} />);

    const meta = await screen.findByText('#3f2a9b1c4d5e was deleted for good or never existed');
    expect(meta.className).toBe('moodboard-node__meta');
    expect(meta.getAttribute('title')).toBeNull();
  });

  it('Character: shows the Character and opens it in the Studio', async () => {
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: {
      id: 'ca', name: 'Shoot A hero', thumbnail: '/api/outputs/h.png', referenceViews: ['a', 'b', 'c'], projectId: 'pA' } });
    const props = { id: 'n2', data: { params: { character: 'ca' } }, selected: false } as unknown as NodeProps;
    renderNode(<CharacterNode {...props} />);

    expect(await screen.findByText('◐ Shoot A hero')).toBeTruthy();
    fireEvent.doubleClick(screen.getByText('◐ Shoot A hero'));
    expect(enterCharacterEditor).toHaveBeenCalledWith('ca');
  });

  it('Character: an outside thumbnail is never loaded; the card says why it has none', async () => {
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: {
      id: 'co', name: 'Old hero', thumbnail: 'https://images.example.com/face.png', referenceViews: ['a', 'b', 'c'], projectId: 'pB' } });
    const props = { id: 'n6', data: { params: { character: 'co' } }, selected: false } as unknown as NodeProps;
    const { container } = renderNode(<CharacterNode {...props} />);

    expect(await screen.findByText('◐ Old hero')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Image link from outside Nebula')).toBeTruthy();
  });
});
