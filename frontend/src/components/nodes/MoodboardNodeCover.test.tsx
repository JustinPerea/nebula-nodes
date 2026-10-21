import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

// The canvas card opens on the board's cover (its `thumbnail`, which the
// backend makes the cover image's url, else #1's), and follows a cover set
// by an agent or another tab without a reload: on `storedAssetChanged`, and
// after a socket reconnect (#110's socketReconnected).

const api = vi.hoisted(() => ({ lookupStoredAsset: vi.fn() }));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => { socket.handlers.add(handler); return () => socket.handlers.delete(handler); },
    connect: () => {},
    send: () => {},
  },
}));

import { MoodboardNode } from './MoodboardNode';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';
import { setOpenProject } from '../../test/projectState';

const images = ['i1', 'i2', 'i3'].map((id) => ({ id, url: `/api/outputs/${id}.png`, weight: 1, excluded: false }));
const board = (coverImageId: string | null) => ({
  id: 'b1', name: 'Painterly space', mode: 'look', projectId: 'p1', images, coverImageId,
  thumbnail: images.find((img) => img.id === coverImageId)?.url ?? images[0].url,
});

beforeEach(() => {
  api.lookupStoredAsset.mockReset();
  useStoredAssetsStore.setState({ entries: {} });
  setOpenProject(['p1', 'Project']);
});

const cardImage = () => document.querySelector('.moodboard-node__preview img')?.getAttribute('src');
const say = (event: unknown) => act(() => { for (const handler of socket.handlers) handler(event); });

describe('the Moodboard card opens on the cover', () => {
  it('shows the cover, and a cover set elsewhere without a reload', async () => {
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: board('i3') });
    const props = { id: 'n1', data: { params: { moodboard: 'b1' } }, selected: false } as unknown as NodeProps;
    render(<ReactFlowProvider><MoodboardNode {...props} /></ReactFlowProvider>);
    await screen.findByText('Painterly space');
    expect(cardImage()).toBe('/api/outputs/i3.png');
    // The count is the same with any cover: nothing moved.
    expect(screen.getByText('3 images · look')).toBeTruthy();

    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: board('i2') });
    say({ type: 'storedAssetChanged', kind: 'moodboard', id: 'b1', deleted: false, version: 5,
      edit: { actor: { kind: 'agent', name: 'Claude' } }, touched: { images: ['i2', 'i3'], frames: [], looks: [] } });
    await waitFor(() => expect(cardImage()).toBe('/api/outputs/i2.png'));

    // Set while the socket was down: read again when it comes back.
    api.lookupStoredAsset.mockResolvedValue({ status: 'ready', asset: board(null) });
    say({ type: 'socketReconnected' });
    await waitFor(() => expect(cardImage()).toBe('/api/outputs/i1.png'));
  });
});
