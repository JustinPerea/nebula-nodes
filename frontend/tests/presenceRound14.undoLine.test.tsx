/**
 * PR #204 round 14, review 11 lock-look-ui:
 * - NIT-1: on a demote with the key-added notice up on the Providers tab, Undo's own copy of the
 *   Providers line never enters the notice's live region, not even for one commit. Undo decides
 *   from state while rendering (settings/groupLockLines, which ProvidersTab's line registers).
 * - LOW-4 (mutants R15, R16 of the old observer): the panel is never observed for it, in any
 *   state: promoted, locked, on the promote, on unmount.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
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

const session = await import('../src/lib/personSession');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');
const { ProvidersTab } = await import('../src/components/panels/settings/ProvidersTab');
const { SettingsNoticeBar } = await import('../src/components/panels/settings/SettingsNoticeBar');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
type SettingsDraft = NonNullable<ReturnType<typeof useSettingsDraftStore.getState>['saved']>;

const initialDraft = useSettingsDraftStore.getState();
const SAVED = {
  apiKeys: {}, routing: {}, kreaConnectionMode: 'mcp', outputPath: '/out', exportFolder: '/exports',
  zoomTelemetryEnabled: false, agentSpend: { sessionUsd: 5, models: {} },
} as unknown as SettingsDraft;
const WORDS = 'You can change provider settings when this tab is connected as you.';

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const pastFirstMoment = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, HELD_LOOK_DELAY_MS + 20); }));

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

const addedKeyNotice = () => act(() => useSettingsDraftStore.setState({ notice: { id: 7, message: 'Added your OpenAI key.', undoKey: 'openai' } }));
const lines = () => [...document.querySelectorAll('.person-lock-line')].filter((node) => node.textContent === WORDS);
const live = () => document.querySelector<HTMLElement>('[aria-live]')!;

/** Every text node or element added inside the live region, as it was added (even if removed again). */
function recordLiveInserts(): { added: string[]; stop: () => void } {
  const added: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) added.push(node.textContent ?? '');
  });
  observer.observe(live(), { childList: true, subtree: true, characterData: true });
  return { added, stop: () => { added.push(...observer.takeRecords().flatMap((record) => [...record.addedNodes].map((node) => node.textContent ?? ''))); observer.disconnect(); } };
}

beforeEach(() => {
  session.resetPersonSessionForTests();
  useSettingsDraftStore.setState({ ...initialDraft, saved: SAVED, keyDrafts: {}, fieldDrafts: {}, openRow: null, pending: {}, errors: {} });
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  useSettingsDraftStore.setState(initialDraft, true);
});

describe('a demote with the notice up on the Providers tab (review 11 NIT-1)', () => {
  it('the live region never gains the duplicate line; the one line is the group\'s', async () => {
    act(() => session.notePersonPromoted());
    render(<Panel providers />);
    addedKeyNotice();
    await flush();
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-disabled')).toBeNull();
    // Promoted, Undo points at no line (the group's isn't shown).
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-describedby')).toBeNull();
    const seen = recordLiveInserts();
    act(() => session.reportPersonRequired());
    await pastFirstMoment();
    await flush();
    seen.stop();
    expect(seen.added.filter((text) => text.includes(WORDS))).toEqual([]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].closest('[aria-live]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-describedby')).toBe(lines()[0].id);
  });

  it('off the Providers tab the demote does give Undo its own line (nothing else says it)', async () => {
    act(() => session.notePersonPromoted());
    render(<Panel providers={false} />);
    addedKeyNotice();
    await flush();
    const seen = recordLiveInserts();
    act(() => session.reportPersonRequired());
    await pastFirstMoment();
    await flush();
    seen.stop();
    expect(seen.added.filter((text) => text.includes(WORDS))).toHaveLength(1);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].closest('[aria-live]')).not.toBeNull();
  });
});

describe('the panel is never observed for Undo (review 11 LOW-4)', () => {
  it('no observer on the panel promoted, locked, on the promote or after unmount', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const panelObserves = () => observe.mock.calls.filter(([target]) => target instanceof Element && !!target.closest('.panel--settings')).length;
    act(() => session.notePersonPromoted());
    const view = render(<Panel providers />);
    addedKeyNotice();
    await flush();
    expect(panelObserves()).toBe(0);
    act(() => session.reportPersonRequired());
    await pastFirstMoment();
    await flush();
    expect(lines()).toHaveLength(1);
    expect(panelObserves()).toBe(0);
    act(() => session.notePersonPromoted());
    await flush();
    expect(lines()).toHaveLength(0);
    view.unmount();
    expect(panelObserves()).toBe(0);
    observe.mockRestore();
  });
});
