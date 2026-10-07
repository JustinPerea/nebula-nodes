import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import type { Preset } from '../../src/lib/createPresets';
import { CreateView } from '../../src/components/create-studio/CreateView';
import { CREATE_DRAFT_STORAGE_KEY, useCreateDraftStore } from '../../src/store/createDraftStore';

const mocks = vi.hoisted(() => ({
  createPreset: vi.fn(), fetchPresets: vi.fn(),
  saveToFolder: vi.fn(), revealInFinder: vi.fn(),
  ui: { createSessionId: 'test-session', settingsCache: { apiKeys: {} }, consumePendingPreset: () => null },
  graph: { nodes: [] as Node<NodeData>[], edges: [], runHistory: [], activeRuns: [],
    createLaunchingIds: [], createCancelledLaunchIds: [], isImportingGraph: false },
}));

vi.mock('../../src/store/uiStore', () => ({
  useUIStore: Object.assign((selector: (state: typeof mocks.ui) => unknown) => selector(mocks.ui), { getState: () => mocks.ui }),
}));
vi.mock('../../src/store/graphStore', () => ({
  useGraphStore: Object.assign((selector: (state: typeof mocks.graph) => unknown) => selector(mocks.graph), { getState: () => mocks.graph }),
}));
vi.mock('../../src/lib/createPresets', () => ({ createPreset: mocks.createPreset, fetchPresets: mocks.fetchPresets }));
vi.mock('../../src/lib/createFiles', () => ({ saveToFolder: mocks.saveToFolder, revealInFinder: mocks.revealInFinder }));
vi.mock('../../src/components/create-studio/CreateComposer', () => ({
  CreateComposer: ({ onOpenStyles }: { onOpenStyles: () => void }) => <button onClick={onOpenStyles}>Styles</button>,
}));
vi.mock('../../src/components/create-studio/ReferenceTray', () => ({ ReferenceTray: () => null }));

beforeEach(() => {
  useCreateDraftStore.setState({ drafts: {} });
  localStorage.removeItem(CREATE_DRAFT_STORAGE_KEY);
  mocks.createPreset.mockReset().mockResolvedValue({ id: 'saved' });
  mocks.fetchPresets.mockReset().mockResolvedValue([]);
  mocks.saveToFolder.mockReset().mockResolvedValue({ savedPath: '/tmp/synthetic-result.png' });
  mocks.revealInFinder.mockReset();
  mocks.graph.nodes = [];
});
afterEach(() => vi.restoreAllMocks());

async function openSave(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'Styles' }));
  fireEvent.click(await view.findByRole('button', { name: 'Save current' }));
  return view.findByRole('dialog', { name: 'Name this style:' });
}

describe('Create style saving', () => {
  it('uses an in-app text dialog without invoking native prompt', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('prompt() is not supported.'); });
    const view = render(<CreateView />);
    await openSave(view);
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.change(view.getByRole('textbox', { name: 'Name this style:' }), { target: { value: '  Warm grain  ' } });
    fireEvent.click(view.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mocks.createPreset).toHaveBeenCalledWith(expect.objectContaining({ name: 'Warm grain', scope: 'project' })));
    prompt.mockRestore();
  });

  it('does not create a style on Cancel, Escape, or a blank name', async () => {
    const view = render(<CreateView />);
    await openSave(view);
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Name this style:' })).toBeNull());
    fireEvent.click(view.getByRole('button', { name: 'Save current' }));
    const input = await view.findByRole('textbox', { name: 'Name this style:' });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Name this style:' })).toBeNull());
    expect(view.getByRole('dialog', { name: 'Styles' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Save current' }));
    fireEvent.change(await view.findByRole('textbox', { name: 'Name this style:' }), { target: { value: '  ' } });
    fireEvent.click(view.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Save current' })).toBeEnabled());
    expect(mocks.createPreset).not.toHaveBeenCalled();
  });

  it('shows provider/storage failures, blocks duplicate saves, and lets the user retry', async () => {
    let reject!: (error: Error) => void;
    mocks.createPreset.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const view = render(<CreateView />);
    await openSave(view);
    fireEvent.change(view.getByRole('textbox', { name: 'Name this style:' }), { target: { value: 'Retry name' } });
    fireEvent.click(view.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mocks.createPreset).toHaveBeenCalledTimes(1));
    expect(view.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => { reject(new Error('Preset storage unavailable')); });
    expect(view.getByRole('alert')).toHaveTextContent('Preset storage unavailable');
    fireEvent.click(view.getByRole('button', { name: 'Save current' }));
    expect(await view.findByRole('textbox', { name: 'Name this style:' })).toHaveValue('Retry name');
    fireEvent.click(await view.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mocks.createPreset).toHaveBeenCalledTimes(2));
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('refreshes the real preset library only after persistence resolves', async () => {
    let finish!: (preset: Preset) => void;
    let persisted: Preset | null = null;
    mocks.createPreset.mockImplementationOnce(() => new Promise<Preset>((resolve) => { finish = resolve; }));
    mocks.fetchPresets.mockImplementation(async (scope: 'global' | 'project') =>
      scope === 'project' && persisted ? [persisted] : []);
    const view = render(<CreateView />);
    await openSave(view);
    fireEvent.change(view.getByRole('textbox', { name: 'Name this style:' }), { target: { value: 'Persisted style' } });
    fireEvent.click(view.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mocks.createPreset).toHaveBeenCalledTimes(1));
    expect(view.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(view.queryByText('Persisted style')).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.fetchPresets.mock.calls.map(([scope]) => scope)).toEqual(['global', 'project']);
    const savedPreset: Preset = {
      id: 'saved-style', name: 'Persisted style', category: 'My Styles', prompt: '', params: {},
      modelId: 'nano-banana', refImages: [], thumbnail: '', version: 1, scope: 'project',
      projectId: 'synthetic-project', createdAt: '', updatedAt: '',
    };
    persisted = savedPreset;
    await act(async () => { finish(savedPreset); });
    expect(await view.findByText('Persisted style')).toBeInTheDocument();
    expect(mocks.fetchPresets.mock.calls.map(([scope]) => scope)).toEqual(['global', 'project', 'global', 'project']);
    expect(view.getByRole('button', { name: 'Save current' })).toBeEnabled();
  });
});

describe('Create result save delegation', () => {
  it('passes export rejection to the real result card and allows retry after acknowledgement', async () => {
    let reject!: (error: Error) => void;
    mocks.saveToFolder.mockImplementationOnce(() => new Promise<{ savedPath: string }>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    mocks.graph.nodes = [{ id: 'synthetic-result', position: { x: 0, y: 0 }, data: {
      label: 'Synthetic result', definitionId: 'nano-banana', params: {}, state: 'complete',
      outputs: { image: { type: 'Image', value: '/api/outputs/result.png' } },
    } }];
    const view = render(<CreateView />);
    fireEvent.click(view.getByTitle('Save to folder'));
    expect(mocks.saveToFolder).toHaveBeenCalledExactlyOnceWith('/api/outputs/result.png');
    expect(view.getByTitle('Saving…')).toBeDisabled();
    expect(view.queryByTitle('Saved!')).toBeNull();
    await act(async () => { reject(new Error('Export storage unavailable')); });
    expect(view.getByRole('alert')).toHaveTextContent('Export storage unavailable');
    expect(view.getByTitle('Save to folder')).toBeEnabled();
    expect(view.queryByTitle('Saved!')).toBeNull();
    fireEvent.click(view.getByTitle('Save to folder'));
    await waitFor(() => expect(view.getByTitle('Saved!')).toBeEnabled());
    expect(mocks.saveToFolder).toHaveBeenCalledTimes(2);
    expect(view.queryByRole('alert')).toBeNull();
  });
});
