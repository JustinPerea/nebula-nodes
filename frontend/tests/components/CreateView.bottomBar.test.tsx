/**
 * GM - Design, 2026-10-23 (answer 4): "Yes, the composer publishes its top
 * edge the way the canvas bar does, and notices sit 8 px above it on Creator
 * Studio." The composer area (the reference tray, the reuse line and the
 * composer card) is Creator Studio's bottom bar: it carries
 * `data-bottom-bar` and writes `--bottom-bar-clearance`, which the notice
 * region reads (8 px above it), and clears it when the Studio closes.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { CreateView } from '../../src/components/create-studio/CreateView';
import { CREATE_DRAFT_STORAGE_KEY, useCreateDraftStore } from '../../src/store/createDraftStore';

interface CreateOrigin {
  genId: string; prompt: string; ts: number; sessionId: string; modelNodeIds: string[]; allNodeIds: string[];
}
interface FakeRun { id: string; status: string; createOrigin: CreateOrigin }
interface FakeGraph {
  nodes: Node<NodeData>[]; edges: []; runHistory: FakeRun[]; createLaunchingIds: string[]; createCancelledLaunchIds: string[]; activeRuns: { id: string; status: string }[];
  authorGenerationCluster: (...args: unknown[]) => Promise<{ modelNodeIds: string[]; allNodeIds: string[] }>;
  executeClusterConcurrent: (ids: string[], origin: CreateOrigin) => Promise<void>;
  reserveCreateGeneration: (id: string) => boolean;
  releaseCreateGeneration: (id: string) => void;
  cancelCreateGeneration: (id: string) => void;
  cancelRun: (id: string) => Promise<void>;
}
const mocks = vi.hoisted(() => ({
  store: null as UseBoundStore<StoreApi<FakeGraph>> | null,
  author: vi.fn(), execute: vi.fn(), cancel: vi.fn(), exit: vi.fn(), dock: vi.fn(),
  ui: { createSessionId: 'session', settingsCache: { apiKeys: {} }, consumePendingPreset: vi.fn() },
}));
vi.mock('../../src/store/uiStore', () => ({
  useUIStore: Object.assign((selector: (state: unknown) => unknown) => selector({ ...mocks.ui, exitCreateView: mocks.exit, setLeftDock: mocks.dock }),
    { getState: () => ({ ...mocks.ui, exitCreateView: mocks.exit, setLeftDock: mocks.dock }) }),
}));
vi.mock('../../src/store/graphStore', async () => {
  const { create } = await import('zustand');
  const store = create<FakeGraph>(() => ({
    nodes: [], edges: [], runHistory: [], createLaunchingIds: [], createCancelledLaunchIds: [], unsavedScenes: {}, activeRuns: [],
    authorGenerationCluster: (...args) => mocks.author(...args),
    executeClusterConcurrent: async (ids, origin) => {
      mocks.execute(ids, origin);
      store.setState((state) => ({
        runHistory: [{ id: origin.genId, status: 'running', createOrigin: origin }, ...state.runHistory],
        createLaunchingIds: state.createLaunchingIds.filter((id) => id !== origin.genId),
      }));
    },
    reserveCreateGeneration: (id) => {
      const state = store.getState();
      if (state.createLaunchingIds.length + state.runHistory.filter((run) => run.status === 'running').length >= 2) return false;
      store.setState({ createLaunchingIds: [...state.createLaunchingIds, id] });
      return true;
    },
    releaseCreateGeneration: (id) => store.setState((state) => ({
      createLaunchingIds: state.createLaunchingIds.filter((existing) => existing !== id),
      createCancelledLaunchIds: state.createCancelledLaunchIds.filter((existing) => existing !== id),
    })),
    cancelCreateGeneration: (id) => store.setState((state) => ({ createCancelledLaunchIds: [...state.createCancelledLaunchIds, id] })),
    cancelRun: async (id) => { mocks.cancel(id); },
  }));
  mocks.store = store;
  return { useGraphStore: store };
});
vi.mock('../../src/components/create-studio/CreateComposer', () => ({
  CreateComposer: ({ onGenerate, activeCount, maxConcurrent, isLaunching }: {
    onGenerate: () => void; activeCount: number; maxConcurrent: number; isLaunching?: boolean;
  }) => <><button onClick={onGenerate} disabled={activeCount >= maxConcurrent || isLaunching}>Generate</button><span>{activeCount} active</span></>,
}));
vi.mock('../../src/components/create-studio/ReferenceTray', () => ({ ReferenceTray: () => null }));
vi.mock('../../src/components/create-studio/ResultsGallery', () => ({
  ResultsGallery: ({ records, nodes }: { records: CreateOrigin[]; nodes: Node<NodeData>[] }) => <div aria-label="Generations">{records.map((record) => <span key={record.genId}>{record.genId}</span>)}{nodes.map((node) => <span key={node.id} data-testid={`state-${node.id}`}>{node.data.state}</span>)}</div>,
}));

beforeEach(() => {
  useCreateDraftStore.setState({ drafts: {} });
  localStorage.removeItem(CREATE_DRAFT_STORAGE_KEY);
  mocks.author.mockReset().mockResolvedValue({ modelNodeIds: ['model'], allNodeIds: ['model'] });
  mocks.execute.mockReset(); mocks.cancel.mockReset(); mocks.exit.mockReset(); mocks.dock.mockReset();
  mocks.ui.consumePendingPreset.mockReset().mockReturnValue(null);
  mocks.store!.setState({ nodes: [], edges: [], runHistory: [], createLaunchingIds: [], createCancelledLaunchIds: [], activeRuns: [] });
});


afterEach(() => {
  document.documentElement.style.removeProperty('--bottom-bar-clearance');
  vi.unstubAllGlobals();
});

describe("Creator Studio's composer is its bottom bar", () => {
  it('publishes its top edge for the notices, and clears it when the Studio closes', () => {
    vi.stubGlobal('innerHeight', 800);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('create-view__composer-area') ? new DOMRect(218, 612, 844, 172) : new DOMRect();
    });
    try {
      const view = render(<CreateView />);
      const area = view.container.querySelector('.create-view__composer-area')!;
      expect(area).toHaveAttribute('data-bottom-bar', '');
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('188px');
      view.unmount();
      expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
    } finally {
      spy.mockRestore();
    }
  });
});
