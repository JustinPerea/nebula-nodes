import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ViewMode } from '../src/store/uiStore';

vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({}), fetchCLIGraph: () => new Promise(() => {}),
}));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: vi.fn().mockResolvedValue({ status: 'disconnected' }),
}));
vi.mock('../src/hooks/useCommonsCapability', () => ({ useCommonsCapability: vi.fn() }));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/components/projects/ProjectCoordinator', () => ({ ProjectCoordinator: () => null }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => <div data-testid="canvas">Canvas contents</div> }));
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => null }));
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ProviderRecoveryStatus', () => ({ ProviderRecoveryStatus: () => null }));
vi.mock('../src/components/WorkspaceRail', () => ({ WorkspaceRail: () => <button>Canvas dock fixture</button> }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => null }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => null }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({ NodeInspectorPopover: () => null }));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => <button>Canvas run fixture</button> }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/panels/Settings', () => ({ Settings: () => null }));
vi.mock('../src/components/panels/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../src/components/create-studio/CreateView', async () => {
  const { WorkspaceHeader } = await import('../src/components/WorkspaceHeader');
  const { WorkspaceModeNavigation } = await import('../src/components/CanvasTabs');
  return { CreateView: () => <div data-testid="studio"><WorkspaceHeader title="Creator Studio"
    navigation={<WorkspaceModeNavigation />} />Create fixture</div> };
});
vi.mock('../src/components/cinema-studio/CinemaStudioView', () => ({ CinemaStudioView: () => <div data-testid="studio">Cinema fixture</div> }));
vi.mock('../src/components/character-studio/CharacterStudioView', () => ({ CharacterStudioView: () => <div data-testid="studio">Character fixture</div> }));
vi.mock('../src/components/moodboard-studio/MoodboardStudioView', () => ({ MoodboardStudioView: () => <div data-testid="studio">Moodboard fixture</div> }));
vi.mock('../src/components/video-editor/RemotionEditorView', () => ({ RemotionEditorView: () => <div data-testid="studio">Composition fixture</div> }));
vi.mock('../src/components/editor/EditorView', () => ({ EditorView: () => <div data-testid="studio">Video editor fixture</div> }));
vi.mock('../src/components/commons/CommonsView', () => ({ CommonsView: () => <div data-testid="studio">Commons fixture</div> }));
import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProjects = useProjectStore.getState();
beforeEach(() => {
  useUIStore.setState({ ...initialUI, commonsEnabled: true, hasOnboarded: true }, true);
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], activeRuns: [] });
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false }, true);
});
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); useGraphStore.setState(initialGraph, true); useProjectStore.setState(initialProjects, true); });

it.each<ViewMode>(['create', 'cinema-editor', 'character-editor', 'moodboard-editor', 'remotion-editor', 'editor', 'commons'])('removes covered Canvas controls from the DOM in %s and restores them on return', async (viewMode) => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Canvas', level: 1 })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Canvas', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('button', { name: 'Creator Studio', exact: true })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Edit selected video' })).toBeNull();
  act(() => useUIStore.setState({ viewMode }));
  await screen.findByTestId('studio');
  expect(screen.queryByRole('heading', { name: 'Canvas' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit selected video' })).toBeNull();
  if (viewMode === 'create') {
    expect(screen.getByRole('heading', { name: 'Creator Studio', level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('navigation', { name: 'Workspace views' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Creator Studio', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Canvas', exact: true })).toBeEnabled();
  } else expect(screen.queryByRole('navigation', { name: 'Workspace views' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Canvas run fixture' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Canvas dock fixture' })).toBeNull();
  act(() => useUIStore.setState({ viewMode: 'canvas' }));
  expect(screen.getAllByRole('heading', { name: 'Canvas', level: 1 })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Canvas dock fixture' })).toBeTruthy();
});

it('uses actual Canvas identity when Commons is unavailable', () => {
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: false });
  render(<App />);
  expect(screen.getByTestId('canvas')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Canvas', level: 1 })).toBeTruthy();
  expect(screen.queryByTestId('studio')).toBeNull();
});
