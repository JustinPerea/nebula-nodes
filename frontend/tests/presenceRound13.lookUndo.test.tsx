/**
 * PR #204 round 13, review 10 lock-look-ui:
 * - LOW-3 (GM r17 item 1: "no section shows the same line twice"): the key-added Undo locks with
 *   the Providers group's words. With the Providers tab open its line is already under the
 *   group's heading, so Undo points at that line and shows no second copy, and nothing new is
 *   said inside the notice's live region. Off the Providers tab Undo keeps its own line under it.
 * - LOW-4, mutant L13: a click on the locked Undo removes nothing (no DELETE); after the promote
 *   it does.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const krea = vi.hoisted(() => ({ getKreaConnection: vi.fn() }));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: (...args: unknown[]) => krea.getKreaConnection(...args),
}));
const writes = vi.hoisted(() => ({ undoAddedKey: vi.fn(async () => true) }));
vi.mock('../src/lib/settingsWrites', async (original) => ({
  ...await original<typeof import('../src/lib/settingsWrites')>(),
  undoAddedKey: (...args: unknown[]) => (writes.undoAddedKey as (...a: unknown[]) => unknown)(...args),
}));

const session = await import('../src/lib/personSession');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');
const { ProvidersTab } = await import('../src/components/panels/settings/ProvidersTab');
const { SettingsNoticeBar } = await import('../src/components/panels/settings/SettingsNoticeBar');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const { lockPlacementProblems } = await import('../src/lib/lockPlacement');
type SettingsDraft = NonNullable<ReturnType<typeof useSettingsDraftStore.getState>['saved']>;

const initialDraft = useSettingsDraftStore.getState();
const SAVED = {
  apiKeys: {}, routing: {}, kreaConnectionMode: 'mcp', outputPath: '/out', exportFolder: '/exports',
  zoomTelemetryEnabled: false, agentSpend: { sessionUsd: 5, models: {} },
} as unknown as SettingsDraft;
const WORDS = 'You can change provider settings when this tab is connected as you.';

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const pastFirstMoment = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, HELD_LOOK_DELAY_MS + 20); }));
const hold = async () => { act(() => session.reportPersonRequired()); await pastFirstMoment(); await flush(); };

function addedKeyNotice() {
  act(() => useSettingsDraftStore.setState({ notice: { id: 7, message: 'Added your OpenAI key.', undoKey: 'openai' } }));
}

/** The Settings panel's frame: the open tab and the notice bar under it (components/panels/Settings). */
function Panel({ providers }: { providers: boolean }) {
  return (
    <div className="panel panel--settings">
      <div role="tabpanel" aria-label="Settings tab">
        {providers ? <ProvidersTab saved={SAVED} /> : <p>Storage</p>}
      </div>
      <SettingsNoticeBar />
    </div>
  );
}

const lines = () => [...document.querySelectorAll('.person-lock-line')].filter((node) => node.textContent === WORDS);
const undo = () => screen.getByRole('button', { name: 'Undo' });

beforeEach(() => {
  session.resetPersonSessionForTests();
  net.sent = [];
  useSettingsDraftStore.setState({ ...initialDraft, saved: SAVED, keyDrafts: {}, fieldDrafts: {}, openRow: null, pending: {}, errors: {} });
  krea.getKreaConnection.mockReset().mockResolvedValue({ status: 'disconnected' });
  writes.undoAddedKey.mockClear();
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  useSettingsDraftStore.setState(initialDraft, true);
});

describe('the key-added Undo, locked (review 10 LOW-3)', () => {
  it('on the Providers tab: one line, the group\'s, under its heading; Undo points at it; nothing in the live region', async () => {
    render(<Panel providers />);
    addedKeyNotice();
    await hold();
    expect(lines()).toHaveLength(1);
    const [line] = lines();
    expect(line.closest('[aria-live]')).toBeNull();
    expect(line.getAttribute('data-lock-place')).toBe('heading');
    expect(undo().getAttribute('aria-disabled')).toBe('true');
    expect(undo().getAttribute('aria-describedby')).toBe(line.id);
    const live = document.querySelector('[aria-live]')!;
    expect(live.querySelector('.person-lock-line')).toBeNull();
    expect(live.textContent).not.toContain(WORDS);
    expect(lockPlacementProblems(document)).toEqual([]);
  });

  it('a notice that arrives on a held Providers tab finds the group line too', async () => {
    render(<Panel providers />);
    await hold();
    addedKeyNotice();
    await flush();
    expect(lines()).toHaveLength(1);
    expect(undo().getAttribute('aria-describedby')).toBe(lines()[0].id);
  });

  it('off the Providers tab: Undo keeps its own line, directly under it, one line', async () => {
    render(<Panel providers={false} />);
    addedKeyNotice();
    await hold();
    expect(lines()).toHaveLength(1);
    const [line] = lines();
    expect(line.getAttribute('data-lock-place')).toBe('control');
    expect(line.previousElementSibling).toBe(undo());
    expect(undo().getAttribute('aria-describedby')).toBe(line.id);
    expect(lockPlacementProblems(document)).toEqual([]);
  });

  it('switching to the Providers tab while the notice shows drops Undo\'s own copy', async () => {
    const view = render(<Panel providers={false} />);
    addedKeyNotice();
    await hold();
    expect(lines()[0].getAttribute('data-lock-place')).toBe('control');
    view.rerender(<Panel providers />);
    await flush();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].getAttribute('data-lock-place')).toBe('heading');
    expect(undo().getAttribute('aria-describedby')).toBe(lines()[0].id);
  });
});

describe('the group line coming and going under the notice (the panel is watched while Undo is locked)', () => {
  it('a Providers search that hides every row takes the group line: Undo shows its own; clearing it gives it back', async () => {
    render(<Panel providers />);
    addedKeyNotice();
    await hold();
    const search = screen.getByRole('searchbox', { name: 'Search providers and models' });
    fireEvent.change(search, { target: { value: 'no provider runs this' } });
    await flush();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].getAttribute('data-lock-place')).toBe('control');
    expect(undo().getAttribute('aria-describedby')).toBe(lines()[0].id);
    fireEvent.change(search, { target: { value: '' } });
    await flush();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].getAttribute('data-lock-place')).toBe('heading');
    expect(undo().getAttribute('aria-describedby')).toBe(lines()[0].id);
  });
});

describe('a click on the locked Undo removes nothing (review 10 LOW-4, mutant L13)', () => {
  it('held: no undo, no DELETE; promoted: the same click undoes the key', async () => {
    render(<Panel providers />);
    addedKeyNotice();
    await hold();
    fireEvent.click(undo());
    await flush();
    expect(writes.undoAddedKey).not.toHaveBeenCalled();
    expect(net.sent.filter((request) => request.startsWith('DELETE'))).toEqual([]);
    act(() => session.notePersonPromoted());
    await flush();
    fireEvent.click(undo());
    expect(writes.undoAddedKey).toHaveBeenCalledWith(7);
  });
});
