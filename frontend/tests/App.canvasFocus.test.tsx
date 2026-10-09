import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

const mocks = vi.hoisted(() => ({ open: vi.fn(), create: vi.fn(), retry: vi.fn() }));
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({ apiKeys: {}, kreaConnectionMode: 'api-token' }),
}));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: vi.fn().mockResolvedValue({ status: 'disconnected' }),
}));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/hooks/useCommonsCapability', () => ({ useCommonsCapability: vi.fn() }));
vi.mock('../src/components/projects/ProjectCoordinator', () => ({ ProjectCoordinator: () => null }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => <div data-testid="project-canvas">Project canvas fixture</div> }));
vi.mock('../src/components/CanvasTabs', () => ({ CanvasTabs: () => <nav aria-label="Canvas views">Canvas navigation fixture</nav> }));
vi.mock('../src/components/WorkspaceRail', () => ({ WorkspaceRail: () => <nav aria-label="Canvas tools">Canvas dock fixture</nav> }));
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => <button>Canvas import fixture</button> }));
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ProviderRecoveryStatus', () => ({ ProviderRecoveryStatus: () => null }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => <button>Canvas command fixture</button> }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => <div data-testid="canvas-onboarding">Canvas onboarding fixture</div> }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => <aside aria-label="Node library fixture" /> }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({ NodeInspectorPopover: () => null }));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => <button>Run project fixture</button> }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/panels/Settings', () => ({ Settings: () => <button>Canvas settings fixture</button> }));
vi.mock('../src/components/panels/ChatPanel', () => ({ ChatPanel: () => <button>Canvas chat fixture</button> }));
vi.mock('../src/components/create-studio/CreateView', () => ({ CreateView: () => <div data-testid="creator-studio">Studio fixture</div> }));

import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProjects = useProjectStore.getState();
const savedProject = {
  id: 'saved', name: 'Saved campaign', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-09T12:00:00Z',
  lastOpenedAt: '2026-10-09T14:00:00Z', nodeCount: 1, edgeCount: 0, thumbnail: null,
};
function savedNode(): Node<NodeData> {
  return { id: 'motion', position: { x: 1000, y: 1000 },
    data: { label: 'Motion', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } };
}

describe('App project startup and explicit workspace entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.open.mockResolvedValue(undefined);
    mocks.create.mockResolvedValue(undefined);
    mocks.retry.mockResolvedValue(undefined);
    useUIStore.setState({ ...initialUI, viewMode: 'canvas', hasOnboarded: false, onboardingActive: false }, true);
    useGraphStore.setState({ ...initialGraph, nodes: [savedNode()], edges: [], isExecuting: false, runHistory: [] }, true);
    useProjectStore.setState({ ...initialProjects, screen: 'home', initialized: true, loading: false, projects: [savedProject], activeProject: savedProject,
      open: mocks.open, createProject: mocks.create, retry: mocks.retry }, true);
  });
  afterEach(() => {
    cleanup();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
    useProjectStore.setState(initialProjects, true);
  });

  it('starts on recent projects while retaining the previous graph and hiding all workspace chrome', async () => {
    const authored = useGraphStore.getState().nodes;
    await act(async () => { render(<App />); });
    expect(screen.getByRole('heading', { name: 'Recent projects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Saved campaign' })).toBeTruthy();
    expect(screen.queryByTestId('project-canvas')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Canvas views' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Canvas tools' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Node library fixture' })).toBeNull();
    for (const name of ['Canvas import fixture', 'Canvas command fixture', 'Run project fixture', 'Canvas settings fixture', 'Canvas chat fixture']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByTestId('canvas-onboarding')).toBeNull();
    expect(useGraphStore.getState().nodes).toBe(authored);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(useUIStore.getState().onboardingActive).toBe(false);
  });

  it('passes an explicit saved-project selection to the project controller and shows canvas only after activation', async () => {
    await act(async () => { render(<App />); });
    fireEvent.click(screen.getByRole('button', { name: 'Open Saved campaign' }));
    expect(mocks.open).toHaveBeenCalledWith('saved');
    expect(screen.queryByTestId('project-canvas')).toBeNull();
    act(() => useProjectStore.setState({ screen: 'workspace' }));
    expect(screen.getByTestId('project-canvas')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Canvas tools' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run project fixture' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recent projects' })).toBeNull();
  });

  it('provides blank-project creation without opening the persisted canvas automatically', async () => {
    useProjectStore.setState({ projects: [], activeProject: null });
    await act(async () => { render(<App />); });
    expect(screen.getByRole('heading', { name: 'Your first project starts here.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(mocks.create).toHaveBeenCalledWith(undefined);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId('project-canvas')).toBeNull();
  });

  it('keeps startup on Projects even when the persisted workspace mode was Creator Studio', async () => {
    useUIStore.setState({ viewMode: 'create', createSessionId: 'saved-draft' });
    await act(async () => { render(<App />); });
    expect(screen.getByRole('heading', { name: 'Recent projects' })).toBeTruthy();
    expect(screen.queryByTestId('creator-studio')).toBeNull();
    expect(useUIStore.getState().createSessionId).toBe('saved-draft');
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('returning to Projects removes workspace controls while leaving saved authoring intact', async () => {
    useProjectStore.setState({ screen: 'workspace' });
    const authored = useGraphStore.getState().nodes;
    await act(async () => { render(<App />); });
    expect(screen.getByTestId('project-canvas')).toBeTruthy();
    act(() => useProjectStore.setState({ screen: 'home' }));
    expect(screen.getByRole('button', { name: 'Open Saved campaign' })).toBeTruthy();
    expect(screen.queryByTestId('project-canvas')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run project fixture' })).toBeNull();
    expect(useGraphStore.getState().nodes).toBe(authored);
  });

  it('keeps a load failure visible on home and delegates the explicit retry action', async () => {
    useProjectStore.setState({ loading: false, projects: [], error: 'Could not load saved projects.' });
    await act(async () => { render(<App />); });
    expect(screen.getByRole('alert').textContent).toContain('Could not load saved projects.');
    expect(screen.queryByTestId('project-canvas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });
});
