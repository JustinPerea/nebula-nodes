import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ViewMode } from '../src/store/uiStore';

/**
 * Q107 a (2026-10-21): the Updates corner mounts on every screen, not only
 * the canvas, and each screen's header keeps a slot for it so it never sits
 * over that screen's own top-right controls. The canvas keeps its own
 * corner (its header is the centred pill).
 */

const notesApi = vi.hoisted(() => ({ fetchAgentNotes: vi.fn() }));
vi.mock('../src/lib/agentNotes', async (original) => ({
  ...await original<typeof import('../src/lib/agentNotes')>(),
  ...notesApi,
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({ runCostConfirmUsd: 1 }), fetchCLIGraph: () => new Promise(() => {}),
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
vi.mock('../src/components/WorkspaceRail', () => ({ WorkspaceRail: () => null }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => null }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => null }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({ NodeInspectorPopover: () => null }));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/panels/Settings', () => ({ Settings: () => null }));
vi.mock('../src/components/panels/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../src/components/brand/BrandShowcaseView', () => ({ BrandShowcaseView: () => <div data-testid="studio">Brand fixture</div> }));
const studio = (title: string) => async () => {
  const { WorkspaceHeader } = await import('../src/components/WorkspaceHeader');
  return () => <div data-testid="studio"><WorkspaceHeader title={title}><button type="button">{title} action</button></WorkspaceHeader></div>;
};
vi.mock('../src/components/create-studio/CreateView', async () => ({ CreateView: await studio('Creator Studio')() }));
vi.mock('../src/components/cinema-studio/CinemaStudioView', async () => ({ CinemaStudioView: await studio('Cinema')() }));
vi.mock('../src/components/character-studio/CharacterStudioView', async () => ({ CharacterStudioView: await studio('Character')() }));
vi.mock('../src/components/moodboard-studio/MoodboardStudioView', async () => ({ MoodboardStudioView: await studio('Moodboard')() }));
vi.mock('../src/components/video-editor/RemotionEditorView', async () => ({ RemotionEditorView: await studio('Composition')() }));
vi.mock('../src/components/editor/EditorView', async () => ({ EditorView: await studio('Video editor')() }));
vi.mock('../src/components/commons/CommonsView', async () => ({ CommonsView: await studio('Commons')() }));
import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useAgentNotesStore } from '../src/store/agentNotesStore';

const note = {
  id: 'an_1', author: { kind: 'agent', id: 'claude', name: 'Claude Code', color: '#E8825A' }, source: 'agent',
  about: 'other', at: '2026-10-21T12:00:00.000Z', text: 'Seeds differ', parts: [{ text: 'Seeds differ' }], refs: [],
  actions: [], readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
};

// The corner and the studios are lazy chunks: under a loaded machine their
// import alone can take longer than findBy's 1 s default.
const LAZY = { timeout: 10_000 };
const SLOW = 20_000;

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProjects = useProjectStore.getState();
beforeEach(() => {
  useUIStore.setState({ ...initialUI, commonsEnabled: true, hasOnboarded: true }, true);
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], activeRuns: [] });
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false,
    activeProject: { id: 'p1', name: 'Harbor' } as never }, true);
  usePricingStore.setState({ table: { currencies: {}, nodes: {} }, loading: false });
  useAgentNotesStore.getState().reset();
  notesApi.fetchAgentNotes.mockReset().mockResolvedValue({ projectId: 'p1', notes: [note], unread: 1, keptWith: 'project' });
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useProjectStore.setState(initialProjects, true);
});

it.each<ViewMode>(['create', 'cinema-editor', 'character-editor', 'moodboard-editor', 'remotion-editor', 'editor', 'commons'])(
  'shows the Updates chip in %s, over the header\'s slot', async (viewMode) => {
    useUIStore.setState({ viewMode });
    render(<App />);
    await screen.findByTestId('studio', {}, LAZY);
    const chip = await screen.findByRole('button', { name: 'Updates, 1 unread' }, LAZY);
    expect(chip).toBeTruthy();
    const header = screen.getByRole('banner', { name: 'Workspace' });
    const slot = header.querySelector('.agent-notes-slot');
    expect(slot).not.toBeNull();
    expect(slot!.getAttribute('aria-hidden')).toBe('true');
    // Last in the header: the screen's own controls stay left of it.
    expect(header.lastElementChild).toBe(slot);
    // The header keeps the corner in its padding (workspace-header.css).
    expect(header.classList.contains('workspace-header--updates-slot')).toBe(true);
  },
  SLOW,
);

it('shows the chip on Projects, with a slot beside Settings', async () => {
  useProjectStore.setState({ screen: 'home' });
  render(<App />);
  await screen.findByRole('button', { name: 'Updates, 1 unread' }, LAZY);
  const slot = document.querySelector('.project-home__header .agent-notes-slot');
  expect(slot).not.toBeNull();
}, SLOW);

it('shows the chip on the canvas in its own corner (the pill gets no slot)', async () => {
  render(<App />);
  await screen.findByRole('button', { name: 'Updates, 1 unread' }, LAZY);
  expect(document.querySelector('.workspace-header--canvas .agent-notes-slot')).toBeNull();
  expect(document.querySelector('.workspace-header--canvas.workspace-header--updates-slot')).toBeNull();
}, SLOW);

it('keeps one corner across a screen switch: no second chip, the count carries over', async () => {
  render(<App />);
  await screen.findByRole('button', { name: 'Updates, 1 unread' }, LAZY);
  act(() => useUIStore.setState({ viewMode: 'moodboard-editor' }));
  await screen.findByTestId('studio', {}, LAZY);
  expect(screen.getAllByRole('button', { name: /^Updates/ })).toHaveLength(1);
  act(() => useProjectStore.setState({ screen: 'home' }));
  expect(screen.getAllByRole('button', { name: /^Updates/ })).toHaveLength(1);
}, SLOW);

it('has no corner on the brand showcase (a demo page, not a product screen)', async () => {
  window.location.hash = '#brand';
  try {
    render(<App />);
    await screen.findByTestId('studio', {}, LAZY);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('button', { name: /^Updates/ })).toBeNull();
  } finally {
    window.location.hash = '';
  }
}, SLOW);
