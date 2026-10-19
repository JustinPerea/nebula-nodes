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

  it('Character: shows the Character and opens it in the Studio', async () => {
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: {
      id: 'ca', name: 'Shoot A hero', thumbnail: '/api/outputs/h.png', referenceViews: ['a', 'b', 'c'], projectId: 'pA' } });
    const props = { id: 'n2', data: { params: { character: 'ca' } }, selected: false } as unknown as NodeProps;
    renderNode(<CharacterNode {...props} />);

    expect(await screen.findByText('◐ Shoot A hero')).toBeTruthy();
    fireEvent.doubleClick(screen.getByText('◐ Shoot A hero'));
    expect(enterCharacterEditor).toHaveBeenCalledWith('ca');
  });
});
