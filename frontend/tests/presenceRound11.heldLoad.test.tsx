/**
 * PR #204 round 11: a held tab sends no person-only request on its own. The app loads as a tab
 * that isn't connected as the person (its socket refused), with every request recorded at the
 * transport (lib/backend apiFetch). Then each surface opens the way a person would: Settings
 * (each tab), the chat, the Updates corner with its Agents panel, the Commons, Creator Studio,
 * Projects. No click changes anything. Any request to a route the gate refuses to anyone but the
 * person (tests/personGateRoutes.py, `personOnly`) fails the test: that work waits for the
 * promote (lib/personWork, hooks/useTabHeld usePersonView). On f93f2968 the run-cost migration's
 * PUT /api/settings went out at load and again on Settings, and the agent apps and personal
 * agents lists were read and refused.
 *
 * Round 13 (review 10 held-calls LOW-1): the walk runs as three tabs, each held: one that never
 * connected (no token), one demoted (promoted on this page, then refused), and one that kept a
 * token across a reload after a backend restart (a stored token, never promoted on this page).
 * The project has an unread update when the Updates corner opens, and another arrives while it is
 * open (review 10 MEDIUM-1: each sent the mark-read, refused). The stale-token tab's Commons sent
 * its reads with the old token (review 10 MEDIUM-2): any request a held tab sends with the
 * person's token fails the test too (the Commons' reads take any actor, so the gate's list
 * doesn't name them; the token is what the backend refuses).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { personOnlyRoutes } from './personGatedCallers';

const UNREAD = vi.hoisted(() => ({
  id: 'an_1', author: { kind: 'agent', id: 'claude', name: 'Claude', color: '#E8825A' }, source: 'agent', about: 'other',
  at: '2026-10-31T12:00:00.000Z', text: 'Moved the key light.', parts: [{ text: 'Moved the key light.' }], refs: [], actions: [],
  readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
}));
const net = vi.hoisted(() => ({
  sent: [] as string[], asPerson: [] as string[], personOnly: [] as RegExp[], saved: {} as Record<string, unknown>, notes: [] as unknown[],
}));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  return {
    ...real,
    apiFetch: async (path: string, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      const bare = path.split('?')[0];
      net.sent.push(`${method} ${bare}`);
      // The gate refuses a person-only route while this tab isn't the person's (held).
      const { personGateHeld } = await import('../src/lib/personSession');
      // Round 13: a request carrying the person's token (the Commons' reads) from a held tab is
      // one the backend refuses too (401: it no longer knows the token).
      const bearer = /^Bearer /.test(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
      if (bearer && personGateHeld()) {
        net.asPerson.push(`${method} ${bare}`);
        return new Response(JSON.stringify({ detail: 'invalid token' }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      const refused = personGateHeld() && net.personOnly.some((route) => route.test(`${method} ${bare}`));
      if (refused) {
        return new Response(JSON.stringify({ detail: 'Only the person can do this.', code: 'person_required' }),
          { status: 403, headers: { 'content-type': 'application/json' } });
      }
      // A fresh settings.json: no run-cost choice saved yet, so the carry-over has work to do.
      // The open project has one unread update (round 13).
      const body = bare.endsWith('/projects') ? { projects: [], activeProjectId: null }
        : method === 'GET' && bare === '/api/settings' ? { apiKeys: {}, routing: {}, ...net.saved }
          : method === 'GET' && bare === '/api/canvas/agent-notes' ? { projectId: 'p1', notes: net.notes, unread: net.notes.length, keptWith: 'project' }
            : {};
      if (method === 'PUT' && bare === '/api/settings') Object.assign(net.saved, JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify(body),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
});
// React Flow's store, for the Updates corner's canvas adapter (the canvas itself is mocked).
const flow = vi.hoisted(() => ({
  state: { transform: [0, 0, 1], width: 1440, height: 900, minZoom: 0.1, nodes: [], userSelectionActive: false, nodeLookup: new Map() },
}));
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  useReactFlow: () => ({ fitView: vi.fn(), setViewport: vi.fn() }),
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/components/projects/ProjectCoordinator', () => ({ ProjectCoordinator: () => null }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => <div>Canvas</div> }));
vi.mock('../src/components/CanvasTabs', async (original) => ({ ...await original<typeof import('../src/components/CanvasTabs')>(), CanvasTabs: () => null }));
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => null }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => null }));
// Canvas-bound chrome (React Flow's store); none of it reads a person-only route.
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => null }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({ NodeInspectorPopover: () => null }));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { default: App } = await import('../src/App');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const session = await import('../src/lib/personSession');
const { resetPersonWorkForTests } = await import('../src/lib/personWork');
const { resetRunCostConfirmMigration } = await import('../src/lib/runCostConfirm');
const { lockPlacementProblems } = await import('../src/lib/lockPlacement');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');

/** GM r18 c: every because line on screen sits in the shared box (components/LineBox, or a
 * surface's own `data-line-box`). GM r18: every lock line follows the one placement rule. */
const screenProblems = (where: string) => [
  ...[...document.querySelectorAll('[data-line-because]')].filter((line) => !line.closest('[data-line-box]'))
    .map((line) => `${where}: because line outside a box: ${line.textContent?.trim()}`),
  ...lockPlacementProblems(document).map((problem) => `${where}: ${problem}`),
];

const routeRegex = (method: string, path: string) =>
  new RegExp(`^${method} ${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);

beforeAll(() => {
  net.personOnly = personOnlyRoutes().map((route) => routeRegex(route.method, route.path));
}, 60_000);

const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const settle = async (ms = 50) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const personOnlySent = () => net.sent.filter((request) => net.personOnly.some((route) => route.test(request)));
/** A person token kept in this tab's storage (a reload keeps it; the backend may not). */
const STORED = { token: 'stale-person-token-0123456789', backend: 'http://127.0.0.1:8000' };
const stored = () => window.sessionStorage.getItem('nebula.person');

beforeEach(() => {
  net.sent = [];
  net.asPerson = [];
  net.saved = {};
  net.notes = [UNREAD];
  window.sessionStorage.clear();
  resetPersonWorkForTests();
  resetRunCostConfirmMigration();
  resetCommonsSessionForTests();
  session.resetPersonSessionForTests();
  useAgentNotesStore.getState().reset();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false }, true);
});
afterEach(() => {
  cleanup();
  session.notePersonPromoted();
  resetPersonWorkForTests();
  window.sessionStorage.clear();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
});

type Held = 'never connected' | 'demoted' | 'stale token';
/** The tab, held as `held` before the app loads. */
function holdTab(held: Held) {
  if (held !== 'never connected') window.sessionStorage.setItem('nebula.person', JSON.stringify(STORED));
  act(() => {
    if (held === 'demoted') session.notePersonPromoted();
    session.reportPersonRequired(); // the socket's refusal: held
  });
}

/** Every surface, opened the way a person would; what each shows is checked as it goes. */
async function walk(): Promise<string[]> {
  render(<App />);
  await settle(300);
  const problems: string[] = [];
  for (const tab of ['providers', 'preferences', 'storage'] as const) {
    act(() => { useUIStore.getState().setLeftDock('settings'); });
    await settle(100);
    act(() => { useSettingsDraftStore.setState({ tab }); });
    // Each tab's code loads lazily: wait until its panel is on the page.
    const opened = () => document.querySelector(`#settings-panel-${tab} .settings__fieldset > *`)
      && !document.querySelector(`#settings-panel-${tab} .settings__loading`);
    for (let i = 0; i < 100 && !opened(); i++) await settle(100);
    expect(document.querySelector(`#settings-panel-${tab}`), `the ${tab} tab opened`).not.toBeNull();
    await settle(400); // past the held rule's first moment: the held look and lines show
    problems.push(...screenProblems(tab));
    if (tab === 'preferences') {
      // The sections that read person-only lists are on the page (and so had their chance to read).
      expect(document.querySelector('[data-testid="settings-personal-agents"]')).not.toBeNull();
      expect(document.getElementById('settings-agent-spend-heading')).not.toBeNull();
      expect(document.querySelector('[data-testid="settings-personal-agents"] [data-line-because]')?.textContent)
        .toMatch(/^Nebula couldn’t load your agents because/);
    }
  }
  act(() => { useUIStore.getState().setLeftDock(null); });
  act(() => { if (!useUIStore.getState().panels.chat.visible) useUIStore.getState().togglePanel('chat'); });
  await settle(600);
  problems.push(...screenProblems('chat'));
  act(() => { if (useUIStore.getState().panels.chat.visible) useUIStore.getState().togglePanel('chat'); });

  // Updates, with an unread update, then one more while the list is open; the Agents panel heads it.
  let chip: HTMLElement | null = null;
  for (let i = 0; i < 100 && !(chip = screen.queryByRole('button', { name: /^Updates/ })); i++) await settle(100);
  expect(chip, 'the Updates corner is on the page').not.toBeNull();
  for (let i = 0; i < 50 && useAgentNotesStore.getState().lists['canvas:p1']?.unread !== 1; i++) await settle(100);
  expect(chip!.getAttribute('aria-label')).toBe('Updates, 1 unread');
  act(() => { fireEvent.click(chip!); });
  await settle(400);
  expect(document.querySelector('[data-note-id="an_1"]'), 'the list is open').not.toBeNull();
  const arrival = { ...UNREAD, id: 'an_2', at: '2026-10-31T12:01:00.000Z', text: 'Added a rim light.', parts: [{ text: 'Added a rim light.' }] };
  net.notes = [arrival, UNREAD];
  act(() => {
    useAgentNotesStore.getState().apply({
      type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', unread: 2, at: Date.now(), removed: [], note: arrival,
    });
  });
  await settle(400);
  expect(document.querySelector('[data-note-id="an_2"]'), 'the arrival is in the open list').not.toBeNull();
  problems.push(...screenProblems('updates'));
  // Nothing went, and nothing says so (round 13: the updates stay unread until the tab connects).
  const notes = useAgentNotesStore.getState();
  if (notes.error !== null) problems.push(`updates: a line: ${notes.error}`);
  if (notes.lists['canvas:p1']?.unread !== 2) problems.push(`updates: ${notes.lists['canvas:p1']?.unread} unread, not 2`);
  act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
  await settle(100);

  // The Commons.
  act(() => { useUIStore.getState().setCommonsEnabled(true); useUIStore.getState().enterCommons(); });
  for (let i = 0; i < 100 && !document.querySelector('.commons-view-root'); i++) await settle(100);
  expect(document.querySelector('.commons-view-root'), 'the Commons opened').not.toBeNull();
  await settle(600);
  problems.push(...screenProblems('commons'));
  // The never-connected view: no worker Start, the not-connected line.
  if (screen.queryByRole('button', { name: 'Start' })) problems.push('commons: the worker\'s Start is live');
  const notConnected = document.querySelector('[data-commons-line="not-connected"]')?.textContent ?? '';
  if (!/because this tab isn’t connected as you\./.test(notConnected)) problems.push(`commons: no not-connected line (${notConnected})`);
  act(() => { useUIStore.getState().exitCommons(); });
  await settle(200);

  // Creator Studio.
  act(() => { useUIStore.getState().enterCreateView(); });
  for (let i = 0; i < 100 && !document.querySelector('.create-view'); i++) await settle(100);
  expect(document.querySelector('.create-view'), 'Creator Studio opened').not.toBeNull();
  await settle(600);
  problems.push(...screenProblems('create'));
  act(() => { useUIStore.getState().exitCreateView(); });
  await settle(200);

  // Projects.
  await act(async () => { await useProjectStore.getState().goHome().catch(() => {}); });
  await settle(400);
  problems.push(...screenProblems('projects'));
  return problems;
}

describe('a held tab sends no person-only request on its own (PR #204 round 11, round 13)', () => {
  for (const held of ['never connected', 'demoted', 'stale token'] as const) {
    it(`${held}: the load, Settings (each tab), the chat, Updates and its Agents panel, the Commons, Creator Studio and Projects: nothing the gate would refuse`,
      { timeout: 120_000 }, async () => {
        holdTab(held);
        expect(session.personWasPromoted()).toBe(held === 'demoted');
        const problems = await walk();
        expect(net.sent.length).toBeGreaterThan(0);
        expect(personOnlySent()).toEqual([]);
        expect(net.asPerson, 'sent with the person\'s token').toEqual([]);
        expect(problems).toEqual([]);
        // The stored token stays as it was (whether a tab drops a refused token is the person's call).
        expect(stored()).toBe(held === 'never connected' ? null : JSON.stringify(STORED));
      });
  }

  it('the run-cost carry-over waits for the promote, then reads again and goes out once', { timeout: 60_000 }, async () => {
    act(() => session.reportPersonRequired());
    render(<App />);
    await settle(300);
    act(() => { useUIStore.getState().setLeftDock('settings'); });
    await settle(400);
    expect(net.sent.filter((request) => request === 'PUT /api/settings')).toEqual([]);
    const reads = net.sent.filter((request) => request === 'GET /api/settings').length;
    act(() => session.notePersonPromoted());
    await settle(300);
    // Read again first (another tab may have carried it over), then one PUT.
    expect(net.sent.filter((request) => request === 'GET /api/settings').length).toBeGreaterThan(reads);
    expect(net.sent.filter((request) => request === 'PUT /api/settings')).toHaveLength(1);
  });
});
