/**
 * PR #204 round 14 (GM r23 answers 6 and 3):
 * - The chat's agent picker, on a tab that isn't connected as the person (held, demoted, or a
 *   stored token the backend no longer takes), says under its heading "You can pick your agents
 *   when this tab is connected as you.", and lists none of the person's agents. A connected tab
 *   shows no line and lists them. The promote takes the line away.
 * - Offline comes first: offline, the line is hidden (only the offline notice says anything);
 *   back online and still not connected, it shows.
 * - The same precedence for the Settings lock lines (useOfflineFirst) and the held views'
 *   not-connected lines: Providers, Personal agents.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: () => new Promise<Response>(() => {}),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: vi.fn(async () => ({ status: 'disconnected' })),
}));
const api = vi.hoisted(() => ({ fetchPersonalAgents: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchPersonalAgents: (...args: unknown[]) => api.fetchPersonalAgents(...args),
}));

const session = await import('../src/lib/personSession');
const connection = await import('../src/lib/backendConnection');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');
const { usePersonView } = await import('../src/hooks/useTabHeld');
const { ChatModelPicker } = await import('../src/components/panels/ChatModelPicker');
const { ProvidersTab } = await import('../src/components/panels/settings/ProvidersTab');
const { PersonalAgentsSection } = await import('../src/components/panels/settings/PersonalAgentsSection');
const { AgentSpendSection } = await import('../src/components/panels/settings/AgentSpendSection');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const { lockPlacementProblems } = await import('../src/lib/lockPlacement');
type PersonalAgent = import('../src/lib/api').PersonalAgent;
type SettingsDraft = NonNullable<ReturnType<typeof useSettingsDraftStore.getState>['saved']>;

const LINE = 'You can pick your agents when this tab is connected as you.';
const AGENT = {
  id: 'fake', kind: 'custom', displayName: 'Fake Agent', color: '#123456', enabled: true, command: '/bin/fake',
  args: [], status: 'ready', resolvedPath: '/bin/fake', note: '', startable: true,
} as unknown as PersonalAgent;
const CATALOG = { agent: 'claude', status: 'ready', auth: { mode: 'claudeai' }, models: [], error: null } as never;

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const pastFirstMoment = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, HELD_LOOK_DELAY_MS + 20); }));
/** Holds the tab and waits for what the views wait on: the hold settled (the held rule's 150 ms,
 * personHeldSettled) and its render committed. Round 18b (CI): a fixed wait raced the settle. */
const hold = async () => {
  act(() => session.reportPersonRequired());
  await pastFirstMoment();
  for (let waited = 0; !session.personHeldSettled(); waited += 10) {
    if (waited > 2000) throw new Error('the hold never settled');
    await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
  }
  await flush();
};
/** The frame the line first shows in: the agents are gone in it too (no 150 ms with both). */
const lineFrame = async () => {
  act(() => session.reportPersonRequired());
  await flush();
};

/** The picker as the chat panel hands it its agents (ChatPanel: agentsHeld = usePersonView held). */
function Picker() {
  const { held } = usePersonView();
  return (
    <ChatModelPicker agent="claude" personalAgents={[AGENT]} agentsHeld={held} model={null} effort={null}
      catalog={CATALOG} loading={false} error={null} disabled={false}
      onAgentChange={() => {}} onModelChange={() => {}} onEffortChange={() => {}} onRetry={() => {}} />
  );
}

function openPicker() {
  render(<Picker />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' }));
  return screen.getByRole('dialog', { name: 'Chat model settings' });
}

const pickerLine = () => [...document.querySelectorAll('.person-lock-line')].find((node) => node.textContent === LINE) ?? null;
const agentButton = () => screen.queryByRole('button', { name: 'Fake Agent' });

beforeEach(() => {
  session.resetPersonSessionForTests();
  connection.resetBackendConnectionForTests();
  sessionStorage.clear();
  localStorage.clear();
  api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [AGENT] });
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  act(() => connection.noteBackendConnection('online'));
});

describe('the chat agent picker on a tab not connected as the person (GM r23 answer 6)', () => {
  it('a connected tab: no line, the agents listed', async () => {
    act(() => session.notePersonPromoted());
    openPicker();
    await flush();
    expect(pickerLine()).toBeNull();
    expect(agentButton()).not.toBeNull();
  });

  it('a held tab (never connected): the line under the heading, no agents; the promote takes it away', async () => {
    const dialog = openPicker();
    await hold();
    const line = pickerLine();
    expect(line).not.toBeNull();
    expect(line!.previousElementSibling!.querySelector('[role="heading"]')!.textContent).toBe('Model & thinking');
    expect(dialog.querySelector('[role="group"][aria-label="Chat provider"]')!.getAttribute('aria-describedby')).toBe(line!.id);
    expect(agentButton()).toBeNull();
    expect(lockPlacementProblems(document)).toEqual([]);
    act(() => session.notePersonPromoted());
    await flush();
    expect(pickerLine()).toBeNull();
    expect(agentButton()).not.toBeNull();
    expect(dialog.querySelector('[role="group"][aria-label="Chat provider"]')!.getAttribute('aria-describedby')).toBeNull();
  });

  it('a demoted tab: the line shows and the agents go', async () => {
    act(() => session.notePersonPromoted());
    openPicker();
    await flush();
    expect(agentButton()).not.toBeNull();
    await hold();
    expect(pickerLine()).not.toBeNull();
    expect(agentButton()).toBeNull();
  });

  it('the line and the agents change in one frame: never the line with the agents still listed', async () => {
    act(() => session.notePersonPromoted());
    openPicker();
    await flush();
    expect(agentButton()).not.toBeNull();
    await lineFrame();
    expect(session.personHeldSettled()).toBe(false);
    expect(pickerLine()).not.toBeNull();
    expect(agentButton()).toBeNull();
  });

  it('a tab holding a stored token the backend no longer takes: the line shows', async () => {
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: 'stale-person-token-0123456789', backend: 'http://127.0.0.1:8000' }));
    openPicker();
    await hold();
    expect(pickerLine()).not.toBeNull();
    expect(agentButton()).toBeNull();
  });

  it('offline comes first: offline the line is hidden; back online, still not connected, it shows', async () => {
    const dialog = openPicker();
    await hold();
    expect(pickerLine()).not.toBeNull();
    act(() => connection.noteBackendConnection('offline'));
    await flush();
    expect(pickerLine()).toBeNull();
    expect(dialog.querySelector('[role="group"][aria-label="Chat provider"]')!.getAttribute('aria-describedby')).toBeNull();
    act(() => connection.noteBackendConnection('online'));
    await flush();
    expect(pickerLine()).not.toBeNull();
  });
});

describe('offline comes first in Settings too (GM r23 answer 3)', () => {
  const initialDraft = useSettingsDraftStore.getState();
  const SAVED = {
    apiKeys: {}, routing: {}, kreaConnectionMode: 'mcp', outputPath: '/out', exportFolder: '/exports',
    zoomTelemetryEnabled: false, agentSpend: { sessionUsd: 5, models: {} },
  } as unknown as SettingsDraft;
  beforeEach(() => {
    useSettingsDraftStore.setState({ ...initialDraft, saved: SAVED, keyDrafts: {}, fieldDrafts: {}, openRow: null, pending: {}, errors: {} });
  });
  afterEach(() => { useSettingsDraftStore.setState(initialDraft, true); });

  it('Providers: the lock line hides offline, the rows stay locked, and it comes back online', async () => {
    render(<ProvidersTab saved={SAVED} />);
    await hold();
    const words = 'You can change provider settings when this tab is connected as you.';
    const shown = () => [...document.querySelectorAll('.person-lock-line')].filter((node) => node.textContent === words);
    expect(shown()).toHaveLength(1);
    act(() => connection.noteBackendConnection('offline'));
    await flush();
    expect(shown()).toHaveLength(0);
    const locked = [...document.querySelectorAll('[data-person-lock="change provider settings"]')];
    expect(locked.length).toBeGreaterThan(0);
    for (const control of locked) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      // Nothing points at the hidden line.
      for (const id of (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    }
    act(() => connection.noteBackendConnection('online'));
    await flush();
    expect(shown()).toHaveLength(1);
  });

  it('Personal agents and connected apps: the held views\' not-connected lines hide offline and come back online', async () => {
    render(<><AgentSpendSection /><PersonalAgentsSection /></>);
    await hold();
    const because = (what: string) => [...document.querySelectorAll('[data-line-box], [role="alert"]')]
      .find((node) => node.textContent?.includes(`couldn’t ${what} because`)) ?? null;
    expect(because('load your agents')).not.toBeNull();
    expect(because('load the connected apps')).not.toBeNull();
    act(() => connection.noteBackendConnection('offline'));
    await flush();
    expect(because('load your agents')).toBeNull();
    expect(because('load the connected apps')).toBeNull();
    act(() => connection.noteBackendConnection('online'));
    await flush();
    expect(because('load your agents')).not.toBeNull();
    expect(because('load the connected apps')).not.toBeNull();
  });
});
