import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import type { Moodboard } from '../../src/types';

const api = vi.hoisted(() => ({ characters: vi.fn(), boards: vi.fn(), presets: vi.fn() }));
vi.mock('../../src/lib/api', async (original) => ({ ...await original<typeof import('../../src/lib/api')>(),
  fetchCharacters: api.characters, fetchMoodboards: api.boards }));
vi.mock('../../src/lib/createPresets', async (original) => ({ ...await original<typeof import('../../src/lib/createPresets')>(),
  fetchPresets: api.presets }));

import { AssetsPanel } from '../../src/components/panels/AssetsPanel';
import { useUIStore } from '../../src/store/uiStore';
import { publishOpenProject } from '../../src/lib/currentProject';

const initialUI = useUIStore.getState();
const board = (id: string, name: string, projectId?: string): Moodboard => ({ id, name, version: 1,
  images: [{ id: 'image-one', url: '/one.png', weight: 1, notes: '', excluded: false }],
  notes: '', mode: 'look', strength: 0.7, analysis: null, thumbnail: '', createdAt: '', updatedAt: '',
  ...(projectId ? { projectId } : {}) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.characters.mockResolvedValue([]);
  api.presets.mockResolvedValue([]);
  publishOpenProject({ id: 'project-one', name: 'First project' });
});
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); });

describe('AssetsPanel', () => {
  it('drops a list that arrives after the scope changed', async () => {
    const globalList = deferred<Moodboard[]>();
    api.boards.mockImplementation((scope: string) => scope === 'global'
      ? globalList.promise : Promise.resolve([board('project-board', 'Project board', 'project-one')]));
    // The panel places "Add to canvas" nodes in the canvas view, so it lives in the flow's provider (App.tsx).
    render(<ReactFlowProvider><AssetsPanel /></ReactFlowProvider>);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Moodboards' })); });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Project' })); });
    expect(await screen.findByText('Project board')).toBeTruthy();
    // The Global list lands late: it must not replace the Project list.
    await act(async () => { globalList.resolve([board('global-board', 'Global board')]); });
    expect(screen.queryByText('Global board')).toBeNull();
    fireEvent.doubleClick(screen.getByText('Project board'));
    expect(useUIStore.getState()).toMatchObject({ moodboardEditorId: 'project-board', moodboardEditorScope: 'project' });
  });
});
