/**
 * PR #204 round 11, review 9 lock-sweep LOW-4: a behaviour test for each swept person-lock
 * control in Settings. On a held tab each one is aria-disabled in place (still focusable), carries
 * data-person-lock, points at one `.person-lock-line` with its verb, has no tooltip, and a click,
 * change or submit sends nothing. The promote lifts all of it and the same action sends. Per group
 * (GM r17 item 1): every grouped control points at the one line, and no line shows twice.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => {
    net.sent.push(`${String(init?.method ?? 'GET').toUpperCase()} ${path}`);
    return new Promise<Response>(() => {});
  },
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));

const api = vi.hoisted(() => ({
  getOutsideSpend: vi.fn(),
  fetchPersonalAgents: vi.fn(),
  setConnectedAppLimit: vi.fn(),
  setConnectedAppColor: vi.fn(),
  revokeConnectedApp: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getOutsideSpend: (...args: unknown[]) => api.getOutsideSpend(...args),
  fetchPersonalAgents: (...args: unknown[]) => api.fetchPersonalAgents(...args),
  setConnectedAppLimit: (...args: unknown[]) => api.setConnectedAppLimit(...args),
  setConnectedAppColor: (...args: unknown[]) => api.setConnectedAppColor(...args),
  revokeConnectedApp: (...args: unknown[]) => api.revokeConnectedApp(...args),
}));
const writes = vi.hoisted(() => ({
  saveKey: vi.fn(async () => true),
  saveField: vi.fn(async () => true),
  saveRunCostConfirm: vi.fn(async () => true),
}));
vi.mock('../src/lib/settingsWrites', async (original) => ({
  ...await original<typeof import('../src/lib/settingsWrites')>(),
  saveKey: (...args: unknown[]) => (writes.saveKey as (...a: unknown[]) => unknown)(...args),
  saveField: (...args: unknown[]) => (writes.saveField as (...a: unknown[]) => unknown)(...args),
  saveRunCostConfirm: (...args: unknown[]) => (writes.saveRunCostConfirm as (...a: unknown[]) => unknown)(...args),
}));
const krea = vi.hoisted(() => ({ getKreaConnection: vi.fn(), connectKrea: vi.fn() }));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: (...args: unknown[]) => krea.getKreaConnection(...args),
  connectKrea: (...args: unknown[]) => krea.connectKrea(...args),
}));

const session = await import('../src/lib/personSession');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');
const { ProvidersTab } = await import('../src/components/panels/settings/ProvidersTab');
const { StorageTab } = await import('../src/components/panels/settings/StorageTab');
const { PreferencesTab } = await import('../src/components/panels/settings/PreferencesTab');
const { ConnectedApps } = await import('../src/components/panels/settings/ConnectedApps');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
type SettingsDraft = NonNullable<ReturnType<typeof useSettingsDraftStore.getState>['saved']>;

const initialDraft = useSettingsDraftStore.getState();
const SAVED: SettingsDraft = {
  apiKeys: {}, routing: {}, kreaConnectionMode: 'mcp', outputPath: '/out', exportFolder: '/exports',
  zoomTelemetryEnabled: false, agentSpend: { sessionUsd: 5, models: {} },
} as unknown as SettingsDraft;
const APPS = { outside: { spentUsd: 0, kreaPlanRuns: 0 }, connect: { available: false },
  apps: [{ id: 'a1', name: 'Hermes', client: null, color: null, dailyUsd: 5, spentUsd: 0, kreaPlanRuns: 0 }] };

const line = (verb: string) => `You can ${verb} when this tab is connected as you.`;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
/** Past the first moment (the 150 ms held rule), so every line that will show has shown. */
const pastFirstMoment = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, HELD_LOOK_DELAY_MS + 20); }));
const hold = async () => { act(() => session.reportPersonRequired()); await pastFirstMoment(); };
const promote = () => act(() => session.notePersonPromoted());

/** The `.person-lock-line`s this control points at. */
function lockLinesOf(element: Element): HTMLElement[] {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id))
    .filter((node): node is HTMLElement => !!node && node.classList.contains('person-lock-line'));
}

/** Locked in place: aria-disabled, marked, focusable, one line with these words, no tooltip. */
function expectLocked(element: HTMLElement, words: string): HTMLElement {
  expect(element.getAttribute('aria-disabled')).toBe('true');
  expect(element.hasAttribute('data-person-lock')).toBe(true);
  expect(element.hasAttribute('title')).toBe(false);
  expect((element as HTMLButtonElement).disabled).toBe(false);
  act(() => element.focus());
  expect(document.activeElement).toBe(element);
  const lines = lockLinesOf(element);
  expect(lines).toHaveLength(1);
  expect(lines[0].textContent).toBe(words);
  return lines[0];
}

function expectUnlocked(element: HTMLElement) {
  expect(element.hasAttribute('aria-disabled')).toBe(false);
  expect(element.hasAttribute('data-person-lock')).toBe(false);
  expect(lockLinesOf(element)).toHaveLength(0);
}

/** GM r17 item 1: no section (nor the page) shows the same lock line twice. */
function expectNoLineTwice() {
  const texts = [...document.querySelectorAll('.person-lock-line')].map((node) => node.textContent);
  expect(new Set(texts).size).toBe(texts.length);
  for (const section of document.querySelectorAll('section, [role="group"]')) {
    const inside = [...section.querySelectorAll('.person-lock-line')].map((node) => node.textContent);
    expect(new Set(inside).size).toBe(inside.length);
  }
}

const shownLines = (words: string) => [...document.querySelectorAll('.person-lock-line')].filter((node) => node.textContent === words);

beforeEach(() => {
  session.resetPersonSessionForTests();
  net.sent = [];
  useSettingsDraftStore.setState({ ...initialDraft, saved: SAVED, keyDrafts: {}, fieldDrafts: {}, openRow: null, pending: {}, errors: {} });
  api.getOutsideSpend.mockReset().mockResolvedValue(APPS);
  api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [] });
  api.setConnectedAppLimit.mockReset().mockResolvedValue({});
  api.setConnectedAppColor.mockReset().mockResolvedValue({});
  api.revokeConnectedApp.mockReset().mockResolvedValue({});
  writes.saveKey.mockClear();
  writes.saveField.mockClear();
  writes.saveRunCostConfirm.mockClear();
  krea.getKreaConnection.mockReset().mockResolvedValue({ status: 'disconnected' });
  krea.connectKrea.mockReset().mockResolvedValue({ status: 'connecting' });
});
afterEach(() => {
  cleanup();
  promote();
  useSettingsDraftStore.setState(initialDraft, true);
});

describe('Providers: keys and the Krea sign-in share "change provider settings"', () => {
  const words = line('change provider settings');

  it('Add key: locked in place, a click opens nothing; the promote unlocks it and it opens', async () => {
    render(<ProvidersTab saved={SAVED} />);
    await flush();
    await hold();
    const add = screen.getByRole('button', { name: 'Add OpenAI key' });
    expectLocked(add, words);
    fireEvent.click(add);
    expect(useSettingsDraftStore.getState().openRow).toBeNull();
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull();
    promote();
    expect(shownLines(words)).toHaveLength(0);
    expectUnlocked(screen.getByRole('button', { name: 'Add OpenAI key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add OpenAI key' }));
    expect(useSettingsDraftStore.getState().openRow).toEqual({ id: 'OPENAI_API_KEY', mode: 'edit' });
  });

  it('Save key: a typed key held by a demote sends nothing on submit; after the promote it saves', async () => {
    useSettingsDraftStore.setState({ openRow: { id: 'OPENAI_API_KEY', mode: 'edit' }, keyDrafts: { OPENAI_API_KEY: 'sk-test' } });
    render(<ProvidersTab saved={SAVED} />);
    await flush();
    await hold();
    const save = screen.getByRole('button', { name: 'Save key' });
    expectLocked(save, words);
    fireEvent.click(save);
    fireEvent.submit(save.closest('form')!);
    expect(writes.saveKey).not.toHaveBeenCalled();
    promote();
    expectUnlocked(screen.getByRole('button', { name: 'Save key' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Save key' }).closest('form')!);
    expect(writes.saveKey).toHaveBeenCalledWith('OPENAI_API_KEY', 'sk-test');
  });

  it('Krea: Sign in and the default for new nodes lock; a change sends nothing; the promote sends', async () => {
    render(<ProvidersTab saved={SAVED} />);
    await flush();
    await hold();
    const signIn = screen.getByRole('button', { name: 'Sign in to Krea' });
    expectLocked(signIn, words);
    fireEvent.click(signIn);
    await flush();
    expect(krea.connectKrea).not.toHaveBeenCalled();
    const select = screen.getByRole('combobox', { name: 'Default Krea connection for new nodes' });
    expectLocked(select, words);
    fireEvent.change(select, { target: { value: 'api-token' } });
    expect(writes.saveField).not.toHaveBeenCalled();
    promote();
    expectUnlocked(screen.getByRole('button', { name: 'Sign in to Krea' }));
    const live = screen.getByRole('combobox', { name: 'Default Krea connection for new nodes' });
    expectUnlocked(live);
    fireEvent.change(live, { target: { value: 'api-token' } });
    expect(writes.saveField).toHaveBeenCalledWith('kreaConnectionMode', 'api-token');
  });

  it('every key and Krea control points at the one line, under the heading, shown once', async () => {
    render(<ProvidersTab saved={SAVED} />);
    await flush();
    await hold();
    const lines = shownLines(words);
    expect(lines).toHaveLength(1);
    const section = lines[0].closest('section')!;
    expect(section.querySelector('h3')!.textContent).toMatch(/^Connect a provider/);
    const locked = [...section.querySelectorAll<HTMLElement>('[data-person-lock]')];
    expect(locked.length).toBeGreaterThan(5);
    expect(locked).toContain(screen.getByRole('button', { name: 'Sign in to Krea' }));
    expect(locked).toContain(screen.getByRole('combobox', { name: 'Default Krea connection for new nodes' }));
    for (const control of locked) {
      expect(control.getAttribute('aria-describedby')!.split(' ')).toContain(lines[0].id);
      expect(control.hasAttribute('title')).toBe(false);
    }
    expectNoLineTwice();
  });
});

describe('Storage: "change storage settings" covers the folders and the telemetry switch', () => {
  const words = line('change storage settings');

  it('a folder draft held by a demote sends nothing on leaving or Enter; after the promote it saves', async () => {
    useSettingsDraftStore.setState({ fieldDrafts: { outputPath: '/new' } });
    render(<StorageTab saved={SAVED} />);
    await hold();
    const field = screen.getByLabelText('Generated files');
    expectLocked(field, words);
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    expect(writes.saveField).not.toHaveBeenCalled();
    promote();
    expect(shownLines(words)).toHaveLength(0);
    expectUnlocked(screen.getByLabelText('Generated files'));
    fireEvent.keyDown(screen.getByLabelText('Generated files'), { key: 'Enter' });
    expect(writes.saveField).toHaveBeenCalledWith('outputPath', '/new');
  });

  it('the telemetry switch: a click sends nothing while locked; the promote lets it save', async () => {
    render(<StorageTab saved={SAVED} />);
    await hold();
    const toggle = screen.getByRole('switch', { name: /Demo zoom telemetry/ });
    expectLocked(toggle, words);
    fireEvent.click(toggle);
    expect(writes.saveField).not.toHaveBeenCalled();
    promote();
    expectUnlocked(screen.getByRole('switch', { name: /Demo zoom telemetry/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Demo zoom telemetry/ }));
    expect(writes.saveField).toHaveBeenCalledWith('zoomTelemetryEnabled', true);
  });

  it('every control points at the one line at the top of the tab, shown once', async () => {
    render(<StorageTab saved={SAVED} />);
    await hold();
    const lines = shownLines(words);
    expect(lines).toHaveLength(1);
    expect(document.querySelector('.settings-storage')!.firstElementChild).toBe(lines[0]);
    const locked = [...document.querySelectorAll<HTMLElement>('[data-person-lock]')];
    expect(locked).toHaveLength(3); // two folders and the switch
    for (const control of locked) expect(control.getAttribute('aria-describedby')!.split(' ')).toContain(lines[0].id);
    expectNoLineTwice();
  });
});

describe('Preferences: the run cost says "change this"', () => {
  it('a change sends nothing while locked, keeps its own help, and saves after the promote', async () => {
    render(<PreferencesTab />);
    await flush();
    await hold();
    const select = screen.getByRole('combobox', { name: 'Ask before costly runs' });
    expectLocked(select, line('change this'));
    expect(select.getAttribute('aria-describedby')!.split(' ')).toContain('settings-run-cost-confirm-help');
    fireEvent.change(select, { target: { value: 'off' } });
    expect(writes.saveRunCostConfirm).not.toHaveBeenCalled();
    expectNoLineTwice();
    promote();
    expect(shownLines(line('change this'))).toHaveLength(0);
    const live = screen.getByRole('combobox', { name: 'Ask before costly runs' });
    expectUnlocked(live);
    fireEvent.change(live, { target: { value: 'off' } });
    expect(writes.saveRunCostConfirm).toHaveBeenCalledWith(null);
  });
});

describe('Connected apps: a listed app locks as a group under "change connected agents"', () => {
  const words = line('change connected agents');
  const renderApps = () => render(<ConnectedApps view={APPS as never} loadError={null} onChanged={() => {}} />);

  it('the daily limit: a change sends nothing while locked; after the promote it sends', async () => {
    renderApps();
    await hold();
    const limit = screen.getByRole('combobox', { name: 'Hermes daily limit' });
    expectLocked(limit, words);
    fireEvent.change(limit, { target: { value: '10' } });
    await flush();
    expect(api.setConnectedAppLimit).not.toHaveBeenCalled();
    promote();
    expectUnlocked(screen.getByRole('combobox', { name: 'Hermes daily limit' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Hermes daily limit' }), { target: { value: '10' } });
    await flush();
    expect(api.setConnectedAppLimit).toHaveBeenCalledWith('a1', 10);
  });

  it('a colour picker opened before a demote sends nothing; after the promote a colour sends', async () => {
    renderApps();
    fireEvent.click(screen.getByRole('button', { name: 'Change the cursor color for Hermes' }));
    const picker = screen.getByRole('group', { name: 'Cursor color for Hermes' });
    await hold();
    const swatch = within(picker).getByRole('radio', { name: 'Color #3FC1A5' });
    expectLocked(swatch, words);
    fireEvent.click(swatch);
    await flush();
    expect(api.setConnectedAppColor).not.toHaveBeenCalled();
    promote();
    const live = within(screen.getByRole('group', { name: 'Cursor color for Hermes' })).getByRole('radio', { name: 'Color #3FC1A5' });
    expectUnlocked(live);
    fireEvent.click(live);
    await flush();
    expect(api.setConnectedAppColor).toHaveBeenCalledWith('a1', '#3FC1A5');
  });

  it('every row control points at the one line under the heading; Connect has its own; none twice', async () => {
    renderApps();
    await hold();
    const lines = shownLines(words);
    expect(lines).toHaveLength(1);
    expect(lines[0].previousElementSibling?.id).toBe('settings-apps-heading');
    const row = screen.getByTestId('settings-app-row');
    const locked = [...row.querySelectorAll<HTMLElement>('[data-person-lock]')];
    expect(locked.length).toBe(3); // the dot, the limit and Revoke
    for (const control of locked) expect(control.getAttribute('aria-describedby')!.split(' ')).toContain(lines[0].id);
    expectLocked(screen.getByRole('button', { name: 'Create token' }), line('connect an agent'));
    expectNoLineTwice();
  });
});
