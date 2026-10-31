/**
 * PR #204 round 11: a held tab sends no person-only request on its own. The app loads as a tab
 * that isn't connected as the person (its socket refused), with every request recorded at the
 * transport (lib/backend apiFetch). Then each surface opens the way a person would: Settings
 * (each tab), the chat, the Updates corner, Projects. No click changes anything. Any request to a
 * route the gate refuses to anyone but the person (tests/personGateRoutes.py, `personOnly`)
 * fails the test: that work waits for the promote (lib/personWork, hooks/useTabHeld
 * usePersonView). On f93f2968 the run-cost migration's PUT /api/settings went out at load and
 * again on Settings, and the agent apps and personal agents lists were read and refused.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { personOnlyRoutes } from './personGatedCallers';

const net = vi.hoisted(() => ({ sent: [] as string[], personOnly: [] as RegExp[], saved: {} as Record<string, unknown> }));
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
      const refused = personGateHeld() && net.personOnly.some((route) => route.test(`${method} ${bare}`));
      if (refused) {
        return new Response(JSON.stringify({ detail: 'Only the person can do this.', code: 'person_required' }),
          { status: 403, headers: { 'content-type': 'application/json' } });
      }
      // A fresh settings.json: no run-cost choice saved yet, so the carry-over has work to do.
      const body = bare.endsWith('/projects') ? { projects: [], activeProjectId: null }
        : method === 'GET' && bare === '/api/settings' ? { apiKeys: {}, routing: {}, ...net.saved }
          : {};
      if (method === 'PUT' && bare === '/api/settings') Object.assign(net.saved, JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify(body),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
});
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/components/projects/ProjectCoordinator', () => ({ ProjectCoordinator: () => null }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => <div>Canvas</div> }));
vi.mock('../src/components/CanvasTabs', () => ({ CanvasTabs: () => null }));
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

const { default: App } = await import('../src/App');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const session = await import('../src/lib/personSession');
const { resetPersonWorkForTests } = await import('../src/lib/personWork');
const { resetRunCostConfirmMigration } = await import('../src/lib/runCostConfirm');
const { lockPlacementProblems } = await import('../src/lib/lockPlacement');

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

beforeEach(() => {
  net.sent = [];
  net.saved = {};
  resetPersonWorkForTests();
  resetRunCostConfirmMigration();
  session.resetPersonSessionForTests();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false }, true);
});
afterEach(() => {
  cleanup();
  session.notePersonPromoted();
  resetPersonWorkForTests();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
});

describe('a held tab sends no person-only request on its own (PR #204 round 11)', () => {
  it('the load, Settings (each tab), the chat and Projects: nothing the gate would refuse', { timeout: 60_000 }, async () => {
    act(() => session.reportPersonRequired()); // the socket's refusal: held
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
    await act(async () => { await useProjectStore.getState().goHome().catch(() => {}); });
    await settle(400);
    problems.push(...screenProblems('projects'));
    expect(net.sent.length).toBeGreaterThan(0);
    expect(personOnlySent()).toEqual([]);
    expect(problems).toEqual([]);
  });

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
