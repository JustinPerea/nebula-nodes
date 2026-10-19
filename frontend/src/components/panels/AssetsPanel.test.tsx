import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Character, Moodboard } from '../../types';

const api = vi.hoisted(() => ({ fetchMoodboards: vi.fn(), fetchCharacters: vi.fn() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/createPresets', () => ({ fetchPresets: vi.fn().mockResolvedValue([]) }));
vi.mock('../../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

import { AssetsPanel } from './AssetsPanel';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';

const board = { id: 'b1', name: 'Warm editorial', thumbnail: '/api/outputs/a.png', images: [{}], mode: 'look' } as unknown as Moodboard;
const character = { id: 'c1', name: 'Nari', thumbnail: '/api/outputs/n.png', referenceViews: ['a', 'b', 'c'] } as unknown as Character;

const addMoodboardNode = vi.fn();
const addCharacterNode = vi.fn();
const enterMoodboardEditor = vi.fn();
const enterCharacterEditor = vi.fn();

beforeEach(() => {
  api.fetchMoodboards.mockReset().mockResolvedValue([board]);
  api.fetchCharacters.mockReset().mockResolvedValue([character]);
  [addMoodboardNode, addCharacterNode, enterMoodboardEditor, enterCharacterEditor].forEach((mock) => mock.mockReset());
  useGraphStore.setState({ addMoodboardNode, addCharacterNode, nodes: [] } as never);
  useUIStore.setState({ enterMoodboardEditor, enterCharacterEditor } as never);
});

function renderPanel() {
  return render(<ReactFlowProvider><AssetsPanel /></ReactFlowProvider>);
}

async function openTab(name: 'Moodboards' | 'Characters') {
  renderPanel();
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe.each([
  { tab: 'Moodboards' as const, item: 'Warm editorial', add: addMoodboardNode, open: enterMoodboardEditor, id: 'b1' },
  { tab: 'Characters' as const, item: 'Nari', add: addCharacterNode, open: enterCharacterEditor, id: 'c1' },
])('Assets panel $tab', ({ tab, item, add, open, id }) => {
  it('a click only selects: nothing is added to the canvas', async () => {
    await openTab(tab);
    const row = await screen.findByRole('button', { name: new RegExp(`^${item}`) });
    fireEvent.click(row);
    expect(add).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: new RegExp(`^${item}`), pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Add ${item} to canvas` })).toBeTruthy();
  });

  it('a double-click opens the Studio and adds nothing', async () => {
    await openTab(tab);
    const row = await screen.findByRole('button', { name: new RegExp(`^${item}`) });
    // A double-click is two clicks, then dblclick.
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.doubleClick(row);
    expect(open).toHaveBeenCalledWith(id, 'global');
    expect(add).not.toHaveBeenCalled();
  });

  it('"Add to canvas" adds one node; the Open button opens', async () => {
    await openTab(tab);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${item}`) }));
    fireEvent.click(screen.getByRole('button', { name: `Add ${item} to canvas` }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe(id);
    fireEvent.click(screen.getByRole('button', { name: `Open ${item}` }));
    expect(open).toHaveBeenCalledWith(id, 'global');
  });

  it('dragging still carries the item onto the canvas', async () => {
    await openTab(tab);
    const row = await screen.findByRole('button', { name: new RegExp(`^${item}`) });
    expect(row.getAttribute('draggable')).toBe('true');
    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(expect.stringContaining('application/'), expect.stringContaining(`"id":"${id}"`));
    expect(add).not.toHaveBeenCalled();
  });
});
