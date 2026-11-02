/**
 * PR #204 round 18d (GM r32 1): a tab opened on the Commons (a reload on #commons) while the
 * backend runs without it opens to the Commons-off view, not the Projects home,
 * the same view the Commons turned off mid-visit shows (GM r31 layout M): only the way back, the
 * title and Updates, and the line "Commons is turned off for this Nebula.". Nothing of the
 * Commons is read or sent (the capability answered off). Only the backend's own "off" does this:
 * no answer says nothing about the Commons.
 * Round 18e (GM r33 3): with no project open (always so after a reload) its way back reads
 * "← Projects", named "Projects", and goes to the Projects home; with one open, "← Canvas".
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const OFF = 'Commons is turned off for this Nebula.';
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const paths = () => api.fetch.mock.calls.map(([path]) => String(path));
const text = () => document.body.textContent ?? '';

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  // A reload: the Projects home until a project opens.
  useProjectStore.setState({ ...initialProjects, screen: 'home', initialized: true, loading: false }, true);
  history.replaceState({}, '', '/#commons');
  noteCommonsAnswered();
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
  history.replaceState({}, '', '/');
  noteCommonsAnswered();
});

it('a reload on #commons with the Commons off opens to the off view, not the Projects home', async () => {
  api.fetch.mockResolvedValue(json({ enabled: false }));
  render(<App />);
  expect(await screen.findByText(OFF)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Commons', level: 1 })).toBeTruthy();
  const back = screen.getByRole('button', { name: 'Projects' });
  expect(back.textContent).toBe('Projects');
  expect(screen.queryByRole('button', { name: 'Back to Canvas' })).toBeNull();
  expect(screen.getByText('Updates')).toBeTruthy();
  expect(text()).not.toContain('Projects home');
  // Layout M: no sections, Add to, Add, status, Start or Stop.
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: /^(Add|Start|Stop|More)\b/ })).toBeNull();
  expect(document.querySelector('.commons-status, .commons-tabs, .commons-add')).toBeNull();
  expect(text()).not.toContain('Commons is disabled');
  // The line is the one neutral Commons line, alone in the page row.
  const lines = [...document.querySelectorAll('[data-commons-line]')];
  expect(lines.map((line) => line.textContent)).toEqual([OFF]);
  expect(lines[0].hasAttribute('data-line-neutral')).toBe(true);
  // The capability answered off: nothing of the Commons is read.
  expect(paths().filter((path) => path.startsWith('/api/commons'))).toEqual([]);
  // The Commons stays unavailable: no Open Commons, no entry.
  expect(useUIStore.getState().commonsEnabled).toBe(false);
});

it('← Projects leaves the off view for the Projects home and takes #commons off the address', async () => {
  api.fetch.mockResolvedValue(json({ enabled: false }));
  const goHome = vi.spyOn(useProjectStore.getState(), 'goHome');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Projects' }));
  await act(async () => {});
  expect(screen.queryByText(OFF)).toBeNull();
  expect(screen.getByText('Projects home')).toBeTruthy();
  expect(location.hash).toBe('');
  expect(useUIStore.getState().commonsOffShown).toBe(false);
  expect(goHome).toHaveBeenCalled();
});

it('with a project open the off view\'s way back reads "← Canvas" and goes back to the canvas', async () => {
  useProjectStore.setState({ screen: 'workspace', activeProject: { id: 'p1', name: 'Lighthouse' } as never });
  useUIStore.setState({ commonsOffShown: true });
  history.replaceState({}, '', '/#commons');
  api.fetch.mockReturnValue(new Promise(() => {}));
  const goHome = vi.spyOn(useProjectStore.getState(), 'goHome');
  render(<App />);
  const back = await screen.findByRole('button', { name: 'Back to Canvas' });
  expect(back.textContent).toBe('Canvas');
  expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  fireEvent.click(back);
  await act(async () => {});
  expect(screen.getByText('Current canvas')).toBeTruthy();
  expect(goHome).not.toHaveBeenCalled();
  expect(location.hash).toBe('');
});

it('a hash edit away from #commons leaves it too', async () => {
  api.fetch.mockResolvedValue(json({ enabled: false }));
  render(<App />);
  await screen.findByText(OFF);
  await act(async () => { location.hash = ''; window.dispatchEvent(new Event('hashchange')); });
  expect(screen.queryByText(OFF)).toBeNull();
  expect(useUIStore.getState().commonsOffShown).toBe(false);
});

it.each([
  ['no answer', () => api.fetch.mockRejectedValue(new TypeError('Failed to fetch'))],
  ['an older backend (404)', () => api.fetch.mockResolvedValue(json({ detail: 'Not Found' }, 404))],
  ['an unreadable answer', () => api.fetch.mockResolvedValue(json({ enabled: 'no' }))],
])('%s says nothing about the Commons: no off view', async (_, answer) => {
  answer();
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => {});
  expect(text()).not.toContain(OFF);
  expect(screen.getByText('Projects home')).toBeTruthy();
  expect(useUIStore.getState().commonsOffShown).toBe(false);
});

it('without #commons a Commons-off backend shows nothing of the Commons', async () => {
  history.replaceState({}, '', '/');
  api.fetch.mockResolvedValue(json({ enabled: false }));
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => {});
  expect(text()).not.toContain(OFF);
  expect(screen.getByText('Projects home')).toBeTruthy();
});
