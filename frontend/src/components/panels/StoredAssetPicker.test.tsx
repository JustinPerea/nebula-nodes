import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  fetchMoodboards: vi.fn(),
  fetchCharacters: vi.fn(),
  lookupStoredAsset: vi.fn(),
}));
const trash = vi.hoisted(() => ({ restoreTrashed: vi.fn() }));

vi.mock('../../lib/api', () => api);
vi.mock('../../lib/trash', () => trash);
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../../store/uiStore', () => {
  const state = { enterMoodboardEditor: () => {}, enterCharacterEditor: () => {} };
  return { useUIStore: (select: (s: typeof state) => unknown) => select(state) };
});

import { StoredAssetPicker } from './StoredAssetPicker';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';

beforeEach(() => {
  api.fetchMoodboards.mockReset().mockResolvedValue([]);
  api.fetchCharacters.mockReset().mockResolvedValue([]);
  api.lookupStoredAsset.mockReset();
  trash.restoreTrashed.mockReset().mockResolvedValue(undefined);
  useStoredAssetsStore.setState({ entries: {} });
});

describe('StoredAssetPicker with a board in Recently deleted', () => {
  it('says it is in Recently deleted and restores it, instead of "not found"', async () => {
    api.lookupStoredAsset.mockResolvedValueOnce({ status: 'trashed', trashed: {
      kind: 'moodboard', id: 'b1', name: 'Warm editorial', deletedAt: '2026-10-18T12:00:00Z' } });
    render(<StoredAssetPicker kind="moodboard" label="Moodboard" value="b1" onChange={() => {}} />);

    expect(await screen.findByText('This board is in Recently deleted. Restore it to use it again.')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Warm editorial (in Recently deleted)' })).toBeTruthy();
    expect(screen.queryByText(/never existed/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Open Moodboard/ })).toBeNull();

    api.lookupStoredAsset.mockResolvedValueOnce({ status: 'ready', asset: {
      id: 'b1', name: 'Warm editorial', thumbnail: '', images: [], mode: 'look' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Open Moodboard/ })).toBeTruthy());
    expect(trash.restoreTrashed).toHaveBeenCalledWith('moodboard', 'b1');
  });
});
