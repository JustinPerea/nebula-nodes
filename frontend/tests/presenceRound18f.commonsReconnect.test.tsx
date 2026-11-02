/**
 * PR #204 round 18f (GM r35 5): a tab that opened on the Commons while the backend ran without it
 * asks the capability again when Nebula reconnects (no polling). Commons on: the off view opens
 * into the Commons with no reload, over the project this tab has loaded, and focus goes to the
 * heading, or stays on the way back when it was there. Off or no answer: the off view stays.
 * Review 15 NIT-3: App's off route needs the Commons off (M13); "a project open" needs the
 * workspace screen, not only a loaded project, which a reload has (M19).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({ ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch }));
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
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/components/projects/ProjectCoordinator', () => ({ ProjectCoordinator: () => null }));
vi.mock('../src/components/projects/ProjectHome', () => ({ ProjectHome: () => <p>Projects home</p> }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => <div>Current canvas</div> }));
vi.mock('../src/components/CanvasTabs', () => ({ CanvasTabs: () => null }));
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => null }));
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ProviderRecoveryStatus', () => ({ ProviderRecoveryStatus: () => null }));
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
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => <span>Updates</span> }));
import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { useProjectStore } from '../src/store/projectStore';
import { noteCommonsAnswered } from '../src/lib/commonsOff';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';

const OFF = 'Commons is turned off for this Nebula.';
// The views load on demand: a cold first load can take seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });
const LOAD = { timeout: 10_000 };
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const paths = () => api.fetch.mock.calls.map(([path]) => String(path));
const text = () => document.body.textContent ?? '';
const capability = { enabled: false as boolean | null };

function answer(path: string): Promise<Response> {
  if (path === '/api/capabilities/commons') {
    return capability.enabled === null ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(json({ enabled: capability.enabled }));
  }
  if (path.endsWith('/status')) return Promise.resolve(json({ worker: { running: false, state: 'idle' }, queue: {}, meter: { calls: 0, cap: 100, remaining: 100, resets_at: '2026-11-02T00:00:00Z' } }));
  if (path.endsWith('/collections')) return Promise.resolve(json([{ id: 'c1', name: 'Refs', kind: 'manual' }]));
  if (path.endsWith('/search')) return Promise.resolve(json({ results: [] }));
  return Promise.resolve(json({}));
}

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  // A reload: the Projects home, with the project this tab loaded (loadWorkspace) not shown yet.
  useProjectStore.setState({ ...initialProjects, screen: 'home', initialized: true, loading: false,
    activeProject: { id: 'p1', name: 'Lighthouse' } as never }, true);
  history.replaceState({}, '', '/#commons');
  noteCommonsAnswered();
  resetBackendConnectionForTests();
  capability.enabled = false;
  api.fetch.mockReset();
  api.fetch.mockImplementation((path: string) => answer(String(path)));
});
afterEach(() => {
  cleanup();
  act(() => resetBackendConnectionForTests());
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
  history.replaceState({}, '', '/');
  noteCommonsAnswered();
});

async function reconnect() {
  await act(async () => { noteBackendConnection('offline'); });
  await act(async () => { noteBackendConnection('online'); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => {});
}

it('a loaded project on the Projects home is not open: the off view reads "← Projects" (M19)', async () => {
  render(<App />);
  expect(await screen.findByText(OFF, {}, LOAD)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Projects' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Back to Canvas' })).toBeNull();
});

it('reconnected with the Commons on: the off view opens into the Commons, focus on the heading', async () => {
  render(<App />);
  await screen.findByText(OFF, {}, LOAD);
  const before = paths().length;
  capability.enabled = true;
  await reconnect();
  // One capability read on the reconnect, no reload, no polling.
  expect(paths().slice(before).filter((path) => path === '/api/capabilities/commons')).toEqual(['/api/capabilities/commons']);
  // The Commons view (loaded on demand) shows.
  expect(await screen.findByRole('tablist', { name: 'Commons sections' }, LOAD)).toBeTruthy();
  expect(text()).not.toContain(OFF);
  expect(useProjectStore.getState().screen).toBe('workspace');
  expect(useUIStore.getState()).toMatchObject({ viewMode: 'commons', commonsEnabled: true, commonsOffShown: false });
  expect(location.hash).toBe('#commons');
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Commons', level: 1 }));
  // Its way back is the canvas now, and the sections spring in (commons.css).
  expect(screen.getByRole('button', { name: 'Back to Canvas' })).toBeTruthy();
  expect(document.querySelector('.commons-view')?.hasAttribute('data-commons-opening')).toBe(true);
});

it('focus on "← Projects" stays on the way back', async () => {
  render(<App />);
  const back = await screen.findByRole('button', { name: 'Projects' }, LOAD);
  back.focus();
  capability.enabled = true;
  await reconnect();
  expect(await screen.findByRole('tablist', { name: 'Commons sections' }, LOAD)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to Canvas' }));
});

it.each([
  ['still off', () => { capability.enabled = false; }],
  ['no answer', () => { capability.enabled = null; }],
])('reconnected, %s: the off view stays', async (_, set) => {
  render(<App />);
  await screen.findByText(OFF, {}, LOAD);
  set();
  await reconnect();
  expect(screen.getByText(OFF)).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(useProjectStore.getState().screen).toBe('home');
  expect(paths().filter((path) => path.startsWith('/api/commons'))).toEqual([]);
});

it('no reconnect, no read: the off view never polls the capability', async () => {
  vi.useFakeTimers();
  try {
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const reads = paths().filter((path) => path === '/api/capabilities/commons').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(paths().filter((path) => path === '/api/capabilities/commons').length).toBe(reads);
  } finally { vi.useRealTimers(); }
});

it('with no project to show it over, the Commons coming back leaves for the Projects home', async () => {
  useProjectStore.setState({ activeProject: null });
  render(<App />);
  await screen.findByText(OFF, {}, LOAD);
  capability.enabled = true;
  await reconnect();
  expect(text()).not.toContain(OFF);
  expect(screen.getByText('Projects home')).toBeTruthy();
  expect(location.hash).toBe('');
  expect(useUIStore.getState().commonsOffShown).toBe(false);
});

it('the off route needs the Commons off: shown and enabled together is the Commons itself (M13)', async () => {
  useProjectStore.setState({ screen: 'workspace' });
  useUIStore.setState({ commonsOffShown: true, viewMode: 'commons' });
  capability.enabled = true;
  render(<App />);
  expect(await screen.findByRole('tablist', { name: 'Commons sections' }, LOAD)).toBeTruthy();
  expect(document.querySelector('[data-commons-off]')).toBeNull();
});
