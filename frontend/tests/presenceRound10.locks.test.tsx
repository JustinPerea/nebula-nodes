/**
 * PR #204 round 10 (GM r15, r16 Q2 and Q4, r17): the person-only control sweep. One lock
 * (src/hooks/usePersonLock, components/PersonLock): aria-disabled in place, the line under the
 * control or once under its group's heading (each control points at it), no tooltip, unlocked on
 * the promote, a demoted tab locked too; "window" in the app through one word. The agent apps and
 * personal agents lists show the never-connected view on a demote that lasts the 150 ms rule.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockLine } from './helpers/personLock';

const api = vi.hoisted(() => ({
  getOutsideSpend: vi.fn(),
  fetchPersonalAgents: vi.fn(),
  createPersonalAgent: vi.fn(),
  updatePersonalAgent: vi.fn(),
  enhancePrompt: vi.fn(),
}));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  getOutsideSpend: (...args: unknown[]) => api.getOutsideSpend(...args),
  fetchPersonalAgents: (...args: unknown[]) => api.fetchPersonalAgents(...args),
  createPersonalAgent: (...args: unknown[]) => api.createPersonalAgent(...args),
  updatePersonalAgent: (...args: unknown[]) => api.updatePersonalAgent(...args),
}));
const saveField = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/lib/settingsWrites', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/settingsWrites')>(),
  saveField: (...args: unknown[]) => (saveField as (...a: unknown[]) => unknown)(...args),
}));

const { personLockLine, lockPlace } = await import('../src/lib/errorCopy');
const { heldProposalLine, heldQuestionsLine } = await import('../src/store/heldAssetProposals');
const { PIN_REFUSAL_COPY } = await import('../src/lib/canvasPins');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { PersonalAgentsSection } = await import('../src/components/panels/settings/PersonalAgentsSection');
const { AgentSpendSection } = await import('../src/components/panels/settings/AgentSpendSection');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');

const AGENTS = {
  warningAcknowledged: true,
  agents: [{
    id: 'mine', displayName: 'Mine', kind: 'custom', status: 'ready', enabled: true, startable: true,
    command: '/bin/mine', args: [], color: '#88f', note: null,
  }],
};
const SPEND = { outside: { spentUsd: 0, kreaPlanRuns: 0 }, apps: [{ id: 'a1', name: 'Hermes', client: null, color: null, dailyUsd: 5, spentUsd: 0, kreaPlanRuns: 0 }], connect: { available: false } };

beforeEach(() => {
  resetPersonSessionForTests();
  api.getOutsideSpend.mockReset().mockResolvedValue(SPEND);
  api.fetchPersonalAgents.mockReset().mockResolvedValue(AGENTS);
  api.createPersonalAgent.mockReset().mockResolvedValue({});
  api.updatePersonalAgent.mockReset().mockResolvedValue({});
  saveField.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).nebulaDesktop;
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
/** A tab the server promoted, then demoted (its socket's personRequired). */
const demote = () => act(() => { notePersonPromoted(); reportPersonRequired(); });

describe('one lock line, one word (GM r16 Q2, review 8 NIT-2)', () => {
  it('"tab" in a browser, "window" in the app, for every lock', () => {
    expect(personLockLine('change keys', false)).toBe('You can change keys when this tab is connected as you.');
    expect(personLockLine('change keys', true)).toBe('You can change keys when this window is connected as you.');
    expect([lockPlace(false), lockPlace(true)]).toEqual(['tab', 'window']);
    (window as unknown as Record<string, unknown>).nebulaDesktop = { apiBaseUrl: 'http://127.0.0.1:8795' };
    expect(heldProposalLine()).toBe('You can review this when this window is connected as you.');
    expect(heldQuestionsLine()).toBe('You can answer this when this window is connected as you.');
    expect(PIN_REFUSAL_COPY.sendWhenConnected).toBe('You can send notes when this window is connected as you.');
  });
});

describe('Add under "Add an ACP agent" (GM r15)', () => {
  it('locked in place with its own line; a submit sends nothing; the promote unlocks it', async () => {
    act(() => reportPersonRequired());
    render(<PersonalAgentsSection />);
    await flush();
    fireEvent.change(screen.getByLabelText('Custom agent id'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Custom agent command'), { target: { value: '/bin/x' } });
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.hasAttribute('title')).toBe(false);
    const line = document.getElementById(add.getAttribute('aria-describedby')!)!;
    expect(line.textContent).toBe('You can add an agent when this tab is connected as you.');
    fireEvent.submit(add.closest('form')!);
    expect(api.createPersonalAgent).not.toHaveBeenCalled();
    act(() => notePersonPromoted());
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('aria-disabled')).toBe(false);
    expect(screen.queryByText('You can add an agent when this tab is connected as you.')).toBeNull();
  });
});

describe('a listed agent locks as a group (GM r17 item 4)', () => {
  it('its switch points at "change your agents", and a change sends nothing until the promote', async () => {
    render(<PersonalAgentsSection />);
    await flush();
    act(() => reportPersonRequired());
    const toggle = screen.getAllByRole('switch').find((el) => el.closest('[data-testid="personal-agent-row"]'))!;
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(lockLine(toggle)).toBe('You can change your agents when this tab is connected as you.');
    fireEvent.click(toggle);
    await flush();
    expect(api.updatePersonalAgent).not.toHaveBeenCalled();
    act(() => notePersonPromoted());
    fireEvent.click(screen.getAllByRole('switch').find((el) => el.closest('[data-testid="personal-agent-row"]'))!);
    await flush();
    expect(api.updatePersonalAgent).toHaveBeenCalledTimes(1);
  });
});

describe('a group shares one line under its heading (GM r17 item 1)', () => {
  it('Agent spending: every limit points at the one line, and a change sends nothing', () => {
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
    });
    act(() => reportPersonRequired());
    render(<AgentSpendSection />);
    const lines = screen.getAllByText('You can change limits when this tab is connected as you.');
    expect(lines).toHaveLength(1);
    const id = lines[0].closest('p')!.id;
    // The limits, not Connect's form below them (its select is a draft until Connect).
    const selects = screen.getAllByRole('combobox').filter((select) => !select.closest('.settings-apps'));
    expect(selects.length).toBeGreaterThan(2);
    for (const select of selects) {
      expect(select.getAttribute('aria-disabled')).toBe('true');
      expect(select.getAttribute('aria-describedby')!.split(' ')).toContain(id);
    }
    fireEvent.change(selects[0], { target: { value: '10' } });
    expect(saveField).not.toHaveBeenCalled();
  });
});

describe('the person-only lists on a demote (GM r17 item 6)', () => {
  it('past 150 ms the personal agents list shows what a never-connected tab shows, and reads again on the promote', async () => {
    vi.useFakeTimers();
    render(<PersonalAgentsSection />);
    await flush();
    expect(screen.getAllByTestId('personal-agent-row')).toHaveLength(1);
    expect(api.fetchPersonalAgents).toHaveBeenCalledTimes(1);
    demote();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS + 1); });
    expect(screen.queryAllByTestId('personal-agent-row')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe(
      'Nebula couldn’t load your agents because this tab isn’t connected as you. Open the link Nebula printed when it started.');
    act(() => notePersonPromoted());
    await flush();
    expect(api.fetchPersonalAgents).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('personal-agent-row')).toHaveLength(1);
  });

  it('a demote inside 150 ms never switches the list (a quick reconnect)', async () => {
    vi.useFakeTimers();
    render(<PersonalAgentsSection />);
    await flush();
    demote();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS - 50); });
    expect(screen.getAllByTestId('personal-agent-row')).toHaveLength(1);
    act(() => notePersonPromoted());
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS * 2); });
    await flush();
    expect(screen.getAllByTestId('personal-agent-row')).toHaveLength(1);
    expect(api.fetchPersonalAgents).toHaveBeenCalledTimes(1);
  });

  it('the agent apps list too: past 150 ms its rows go and the never-connected line shows', async () => {
    vi.useFakeTimers();
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
    });
    render(<AgentSpendSection />);
    await flush();
    expect(screen.getAllByTestId('settings-app-row')).toHaveLength(1);
    demote();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS + 1); });
    expect(screen.queryAllByTestId('settings-app-row')).toHaveLength(0);
    expect(screen.getByText(/^Nebula couldn’t load the connected apps because this tab isn’t connected as you\./)).toBeTruthy();
    act(() => notePersonPromoted());
    await flush();
    expect(api.getOutsideSpend).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('settings-app-row')).toHaveLength(1);
  });
});
