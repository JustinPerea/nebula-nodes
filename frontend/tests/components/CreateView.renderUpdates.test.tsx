import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Switching to Creator Studio logged React's "Cannot update a component
// (`App`) while rendering a different component (`CreateView`)": CreateView
// wrote its first draft into the draft store while rendering, the autosave
// coordinator's draft subscriber marked the project unsaved, and App (which
// reads the project store) was told to re-render mid-render. This runs that
// path with the real stores and the real autosave subscription.

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { setViewing: () => {}, connect: vi.fn(), send: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../../src/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/projects')>()),
  saveProject: vi.fn(async () => new Promise(() => {})), listProjects: vi.fn(), recoverProject: vi.fn(),
}));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/backend')>()),
  apiFetch: vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })),
  backendAssetUrlSync: (path: string) => path,
}));
// The gallery has its own tests; it isn't part of the draft path.
vi.mock('../../src/components/create-studio/ResultsGallery', () => ({ ResultsGallery: () => null }));

import { CreateView } from '../../src/components/create-studio/CreateView';
import { useCreateDraftStore } from '../../src/store/createDraftStore';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../../src/store/projectStore';
import { setProjectContext } from '../../src/lib/projectContext';

const summary = { id: 'p1', name: 'Shoot', createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null };

/** Stands in for App: it reads the project store (the save label) and shows
 * Creator Studio when the view mode says so. */
function Shell() {
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const viewMode = useUIStore((state) => state.viewMode);
  return <>
    <span data-testid="save-status">{saveStatus}</span>
    {viewMode === 'create' ? <CreateView /> : <div>Canvas</div>}
  </>;
}

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProjects = useProjectStore.getState();
let unsubscribe: () => void = () => {};
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetProjectStoreForTests();
  localStorage.clear();
  useCreateDraftStore.setState({ drafts: {} });
  useUIStore.setState({ ...initialUI, viewMode: 'canvas', createSessionId: null, hasOnboarded: true }, true);
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], activeRuns: [] });
  setProjectContext({ id: 'p1', revision: 'r1' });
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false, busy: false,
    activeProject: summary, dirty: false, saveStatus: 'saved', error: null }, true);
  unsubscribe = subscribeProjectAutosave();
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  cleanup();
  unsubscribe();
  consoleError.mockRestore();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useProjectStore.setState(initialProjects, true);
  useCreateDraftStore.setState({ drafts: {} });
});

const renderUpdateWarnings = () => consoleError.mock.calls.filter((args: unknown[]) => args.some((arg: unknown) => typeof arg === 'string' && arg.includes('Cannot update a component')));

describe('switching to Creator Studio', () => {
  it('updates no other component while CreateView renders, on a first visit and on a return', async () => {
    render(<Shell />);
    expect(screen.getByText('Canvas')).toBeTruthy();

    act(() => useUIStore.getState().enterCreateView());
    expect(await screen.findByRole('heading', { name: 'Creator Studio' })).toBeTruthy();
    expect(renderUpdateWarnings()).toEqual([]);
    // The new draft is still stored (and so saved with the project), after the render.
    const sessionId = useUIStore.getState().createSessionId!;
    expect(useCreateDraftStore.getState().drafts[sessionId]).toMatchObject({ modelId: 'nano-banana', prompt: '' });
    // The autosave noticed it ("saving" once its 600 ms wait has passed on a slow run).
    expect(['unsaved', 'saving']).toContain(screen.getByTestId('save-status').textContent);

    act(() => useUIStore.getState().exitCreateView());
    act(() => useUIStore.getState().enterCreateView());
    expect(await screen.findByRole('heading', { name: 'Creator Studio' })).toBeTruthy();
    expect(renderUpdateWarnings()).toEqual([]);
  });

  it('keeps the draft revision it rendered with, so the composer is not remounted after the store write', async () => {
    render(<Shell />);
    act(() => useUIStore.getState().enterCreateView());
    const prompt = await screen.findByPlaceholderText('Describe what you want to create…');
    const sessionId = useUIStore.getState().createSessionId!;
    const revision = useCreateDraftStore.getState().drafts[sessionId].revision;
    // The same element: the stored draft is the one CreateView first rendered.
    expect(screen.getByPlaceholderText('Describe what you want to create…')).toBe(prompt);
    expect(useCreateDraftStore.getState().drafts[sessionId].revision).toBe(revision);
  });
});
