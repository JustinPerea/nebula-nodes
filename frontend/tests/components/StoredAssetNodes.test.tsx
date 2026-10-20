import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeProps } from '@xyflow/react';
import type { Moodboard } from '../../src/types';

/**
 * A Moodboard or Character node keeps only its asset's id, in the public
 * `moodboard` / `character` param that agents set too (gap 13). The card shows
 * the asset as it is now and follows renames and deletes.
 */

const net = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  handlers: [] as Array<(event: unknown) => void>,
}));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  apiFetch: net.apiFetch,
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler: (event: unknown) => void) => {
    net.handlers.push(handler);
    return () => { net.handlers = net.handlers.filter((h) => h !== handler); };
  }),
} }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id }: { id?: string }) => <span data-testid={`handle-${id}`} />,
}));

import { MoodboardNode } from '../../src/components/nodes/MoodboardNode';
import { CharacterNode } from '../../src/components/nodes/CharacterNode';
import { Inspector } from '../../src/components/panels/Inspector';
import { useGraphStore } from '../../src/store/graphStore';
import { useStoredAssetsStore } from '../../src/store/storedAssetsStore';
import { useUIStore } from '../../src/store/uiStore';
import { setSelectionActionSlot } from '../../src/lib/selectionActionSlot';
import { setOpenProject } from '../../src/test/projectState';

function board(id: string, name: string, images: number): Moodboard {
  return {
    id, name, version: 1, notes: '', mode: 'look', strength: 0.7, analysis: null,
    thumbnail: `/api/outputs/${id}.png`, createdAt: '', updatedAt: '',
    images: Array.from({ length: images }, (_, i) => ({ id: `i${i}`, url: `/api/outputs/${id}-${i}.png`, weight: 1, notes: '', excluded: false })),
  };
}

let boards: Record<string, Moodboard>;
/** Boards in Recently deleted: GET answers 404 with code "in_trash" (backend main.py _asset_not_found). */
let trashedBoards: Record<string, Moodboard>;
let posted: Array<{ path: string; body: unknown }>;

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  setOpenProject(['project-1', 'Project one']);
  boards = { gm: board('gm', 'Good Machines', 3), other: board('other', 'Other board', 1) };
  trashedBoards = {};
  posted = [];
  net.apiFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const restore = /^\/api\/trash\/moodboard\/([^/]+)\/restore$/.exec(path);
    if (method === 'POST' && restore && trashedBoards[restore[1]]) {
      boards[restore[1]] = trashedBoards[restore[1]];
      delete trashedBoards[restore[1]];
      return reply({ status: 'restored' });
    }
    if (method !== 'GET') {
      posted.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return reply({ id: 'n9' });
    }
    const one = /^\/api\/moodboards\/([^?]+)$/.exec(path);
    if (one) {
      if (boards[one[1]]) return reply(boards[one[1]]);
      const gone = trashedBoards[one[1]];
      if (gone) {
        return reply({ detail: 'in Recently deleted', code: 'in_trash', trashed: {
          kind: 'moodboard', id: gone.id, name: gone.name, thumbnail: gone.thumbnail,
          deletedAt: '2026-10-18T00:00:00Z', deletedBy: { kind: 'agent', name: 'Claude' } } }, 404);
      }
      return reply({ detail: 'not found' }, 404);
    }
    if (path.startsWith('/api/moodboards?scope=global')) return reply(Object.values(boards));
    if (path.startsWith('/api/moodboards?scope=project')) return reply([]);
    if (path === '/api/characters/c1') {
      return reply({ id: 'c1', name: 'Rina', thumbnail: '/api/outputs/rina.png', referenceViews: [] });
    }
    if (path.startsWith('/api/settings')) return reply({ favorites: {} });
    return reply({});
  });
  useStoredAssetsStore.setState({ entries: {} });
});

afterEach(() => {
  cleanup();
});

function emit(event: unknown) {
  act(() => { for (const handler of net.handlers) handler(event); });
}

function card(Component: typeof MoodboardNode, params: Record<string, unknown>, selected = false) {
  const props = { id: 'n2', data: { params }, selected } as unknown as NodeProps;
  return render(<Component {...props} />);
}

const fetchesOf = (path: string) => net.apiFetch.mock.calls.filter(([p]) => p === path).length;

describe('Moodboard card', () => {
  it('shows the board the moodboard param names, as it is now', async () => {
    card(MoodboardNode, { moodboard: 'gm' });
    expect(await screen.findByText('Good Machines')).toBeVisible();
    expect(screen.getByText('3 images · look')).toBeVisible();
  });

  it('follows a rename and a new image without the node changing', async () => {
    card(MoodboardNode, { moodboard: 'gm' });
    await screen.findByText('Good Machines');
    boards.gm = board('gm', 'GM references', 4);
    emit({ type: 'storedAssetChanged', kind: 'moodboard', id: 'gm', deleted: false });
    expect(await screen.findByText('GM references')).toBeVisible();
    expect(screen.getByText('4 images · look')).toBeVisible();
  });

  it('says a deleted board is in Recently deleted, offers Restore and no Open button', async () => {
    card(MoodboardNode, { moodboard: 'gm' }, true);
    await screen.findByText('Good Machines');
    expect(screen.getByRole('button', { name: 'Open Moodboard' })).toBeVisible();
    trashedBoards.gm = boards.gm;
    delete boards.gm;
    emit({ type: 'storedAssetChanged', kind: 'moodboard', id: 'gm', deleted: true });
    expect(await screen.findByText('In Recently deleted')).toBeVisible();
    expect(screen.getByText('Good Machines')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open Moodboard' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('3 images · look')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open Moodboard' })).toBeVisible();
  });

  it('says the board is gone when it is deleted for good, and offers no Open button', async () => {
    card(MoodboardNode, { moodboard: 'gm' }, true);
    await screen.findByText('Good Machines');
    delete boards.gm;
    emit({ type: 'storedAssetChanged', kind: 'moodboard', id: 'gm', deleted: true });
    expect(await screen.findByText('Board not found')).toBeVisible();
    expect(screen.getByText('#gm was deleted for good or never existed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open Moodboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('asks for a board when none is chosen', () => {
    card(MoodboardNode, {});
    expect(screen.getByText('No board chosen')).toBeVisible();
    expect(screen.getByText('Choose one in the Inspector')).toBeVisible();
    expect(net.apiFetch).not.toHaveBeenCalled();
  });

  it('reads a node the canvas still holds with the old internal id', async () => {
    card(MoodboardNode, { _moodboardId: 'gm', _moodboardName: 'Stale copy' });
    expect(await screen.findByText('Good Machines')).toBeVisible();
    expect(screen.queryByText('Stale copy')).toBeNull();
  });

  it('fetches a board once however many cards show it', async () => {
    card(MoodboardNode, { moodboard: 'gm' });
    card(MoodboardNode, { moodboard: 'gm' });
    await waitFor(() => expect(screen.getAllByText('Good Machines')).toHaveLength(2));
    expect(fetchesOf('/api/moodboards/gm')).toBe(1);
  });
});

describe('Moodboard card wording', () => {
  it('counts one image as one image', async () => {
    card(MoodboardNode, { moodboard: 'other' });
    expect(await screen.findByText('1 image · look')).toBeVisible();
  });
});

describe('Settings in the selection toolbar', () => {
  it('opens the Inspector for a selected Moodboard card', async () => {
    const slot = document.createElement('span');
    slot.dataset.nodeId = 'n2';
    document.body.appendChild(slot);
    setSelectionActionSlot(slot);
    useUIStore.setState({ selectedNodeId: null });
    useUIStore.getState().setInspectorVisible(false);
    try {
      card(MoodboardNode, { moodboard: 'gm' }, true);
      fireEvent.click(await screen.findByRole('button', { name: 'Show node settings' }));
      expect(useUIStore.getState().selectedNodeId).toBe('n2');
      expect(useUIStore.getState().panels.inspector.visible).toBe(true);
    } finally {
      act(() => setSelectionActionSlot(null));
      slot.remove();
    }
  });
});

describe('Character card', () => {
  it('shows the character the character param names', async () => {
    const { container } = card(CharacterNode, { character: 'c1' });
    expect(await screen.findByText('◐ Rina')).toBeVisible();
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/api/outputs/rina.png');
  });
});

describe('adding a node from the Assets panel', () => {
  it('writes the board id and the notes default, and shows the panel copy until the fetch lands', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n1', position: { x: 0, y: 0 },
      data: { definitionId: 'text-input', label: 'Text', params: {}, outputs: {}, state: 'idle' } }],
    edges: [], backendFreshStartPending: false });
    await useGraphStore.getState().addMoodboardNode('gm', { x: 10, y: 20 },
      { name: 'Good Machines', thumbnail: '/api/outputs/gm.png', imageCount: 3, mode: 'look' });
    expect(posted).toEqual([{ path: '/api/graph/node',
      body: { definitionId: 'nebula-moodboard', params: { moodboard: 'gm', send_notes: 'board' }, position: { x: 10, y: 20 } } }]);
    expect(useStoredAssetsStore.getState().entries['moodboard:gm']?.summary?.name).toBe('Good Machines');
  });
});

describe('Inspector', () => {
  it('picks a board from a list and stores its id in the moodboard param', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n2', position: { x: 0, y: 0 },
      data: { definitionId: 'nebula-moodboard', label: 'Moodboard', params: { moodboard: 'gm' }, outputs: {}, state: 'idle' } }],
    edges: [] });
    useUIStore.setState({ selectedNodeId: 'n2' });
    render(<Inspector embedded />);
    const select = await screen.findByRole('combobox', { name: 'Moodboard' });
    await screen.findByRole('option', { name: 'Other board' });
    expect((select as HTMLSelectElement).value).toBe('gm');
    fireEvent.change(select, { target: { value: 'other' } });
    expect(useGraphStore.getState().nodes[0].data.params.moodboard).toBe('other');
    expect(screen.queryByRole('textbox', { name: 'Moodboard' })).toBeNull();
  });

  it('names a board that no longer exists instead of showing a blank choice', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n2', position: { x: 0, y: 0 },
      data: { definitionId: 'nebula-moodboard', label: 'Moodboard', params: { moodboard: 'gone' }, outputs: {}, state: 'idle' } }],
    edges: [] });
    useUIStore.setState({ selectedNodeId: 'n2' });
    render(<Inspector embedded />);
    expect(await screen.findByRole('option', { name: 'Not found (#gone)' })).toBeInTheDocument();
    expect(screen.getByText('This board was deleted for good or never existed. Pick another.')).toBeVisible();
  });
});
