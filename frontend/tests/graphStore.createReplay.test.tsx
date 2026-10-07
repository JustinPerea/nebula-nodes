import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import * as api from '../src/lib/api';
import { loadRunHistory } from '../src/lib/runHistory';
import { generationRecordsFromHistory } from '../src/lib/createGallery';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { CreateView } from '../src/components/create-studio/CreateView';
import { useCreateDraftStore } from '../src/store/createDraftStore';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
vi.mock('../src/components/create-studio/CreateComposer', () => ({
  CreateComposer: ({ activeCount, maxConcurrent, isLaunching }: {
    activeCount: number; maxConcurrent: number; isLaunching?: boolean;
  }) => <button disabled={isLaunching || activeCount >= maxConcurrent}>Generate</button>,
}));
vi.mock('../src/components/create-studio/ReferenceTray', () => ({ ReferenceTray: () => null }));
vi.mock('../src/components/create-studio/ResultsGallery', () => ({ ResultsGallery: () => null }));

const model: Node<NodeData> = { id: 'model', position: { x: 10, y: 20 }, data: {
  label: 'Fixture', definitionId: 'nano-banana', params: { aspect_ratio: '1:1' },
  state: 'complete', outputs: { image: { type: 'Image', value: '/api/outputs/previous.png' } },
} };
const origin = { genId: 'original-generation', sessionId: 'fixture-session', prompt: 'Saved fixture prompt', ts: 123,
  modelNodeIds: ['model'], allNodeIds: ['model'] };
const initialUI = { ...useUIStore.getState() };

beforeEach(() => {
  vi.useFakeTimers();
  useGraphStore.getState().resetExecution();
  useGraphStore.getState().releaseGraphImport();
  localStorage.clear();
  useCreateDraftStore.setState({ drafts: {} });
  useGraphStore.setState({ nodes: [model], edges: [], runHistory: [], providerStartAmbiguities: [] });
  useUIStore.setState({ createSessionId: origin.sessionId, viewMode: 'create' });
  vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
  vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ status: 'running', runId: '' });
  vi.spyOn(api, 'cancelExecution').mockResolvedValue({ status: 'cancelled', runId: '' });
});
afterEach(() => {
  cleanup();
  useGraphStore.getState().resetExecution();
  useGraphStore.getState().releaseGraphImport();
  useUIStore.setState(initialUI, true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('saved Create generation replay ownership', () => {
  it.each(['rerun', 'retry'] as const)('retains immutable identity, job capacity and scoped Stop for %s', async (action) => {
    const store = useGraphStore.getState();
    expect(store.reserveCreateGeneration(origin.genId)).toBe(true);
    await store.executeClusterConcurrent(['model'], origin);
    const sourceId = useGraphStore.getState().runHistory[0].id;
    store.hydrateExecutionStatuses([{ runId: sourceId, status: action === 'retry' ? 'failed' : 'completed' }]);
    const source = useGraphStore.getState().runHistory[0];
    store.updateNodeData('model', { params: { aspect_ratio: '9:16' } });
    await (action === 'retry' ? store.retryFailedRun(source.id) : store.rerunHistoryRecord(source.id));
    const replay = useGraphStore.getState().runHistory[0];
    expect(replay).toMatchObject({ sourceRunId: source.id, status: 'running', createOrigin: origin });
    expect(replay.createOrigin).not.toBe(source.createOrigin);
    expect(Object.isFrozen(replay.createOrigin?.modelNodeIds)).toBe(true);
    expect(vi.mocked(api.executeGraph).mock.calls[1][0]).toEqual(source.snapshot.nodes);
    expect(useGraphStore.getState().runHistory[1]).toBe(source);
    expect(generationRecordsFromHistory(useGraphStore.getState().runHistory, origin.sessionId)).toHaveLength(1);
    expect(store.reserveCreateGeneration('second-job')).toBe(true);
    expect(store.reserveCreateGeneration('third-job')).toBe(false);

    render(<CreateView />);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop generation 1' })); });
    expect(api.cancelExecution).toHaveBeenCalledExactlyOnceWith(replay.id);
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({ id: replay.id, status: 'cancelled', createOrigin: origin });
    expect(useGraphStore.getState().runHistory[1]).toBe(source);
    expect(screen.queryByRole('button', { name: 'Stop generation 1' })).toBeNull();
    expect(loadRunHistory()[0]).toMatchObject({ id: replay.id, status: 'cancelled', createOrigin: origin });
    expect(store.reserveCreateGeneration('third-job')).toBe(true);
  });
});
