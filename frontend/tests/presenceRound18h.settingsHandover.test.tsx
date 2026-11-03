/**
 * PR #204 round 18h (review 16 MEDIUM-1): Settings' own handovers, AgentSpendSection and
 * PersonalAgentsSection, the same way as the Commons: a save or other work in flight disables the
 * focused control in place (Chrome then drops focus to <body>), so focus goes to the section's
 * heading, and back to that control once the work answers, unless the person moved it meanwhile.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { resetPersonSessionForTests } = await import('../src/lib/personSession');
const { PersonalAgentsSection } = await import('../src/components/panels/settings/PersonalAgentsSection');
const { AgentSpendSection } = await import('../src/components/panels/settings/AgentSpendSection');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');

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

describe('a control disabled in place while work runs hands focus to the heading and back', () => {
  it('Agent spending: a save in flight', async () => {
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
    });
    render(<AgentSpendSection />);
    await flush();
    const select = screen.getAllByRole('combobox').find((el) => !el.closest('.settings-apps'))!;
    act(() => select.focus());
    act(() => useSettingsDraftStore.setState((s) => ({ pending: { ...s.pending, agentSpend: true } })));
    expect((select as HTMLSelectElement).disabled).toBe(true);
    act(() => select.blur()); // Chrome's focus fixup
    expect(document.activeElement).toBe(document.getElementById('settings-agent-spend-heading'));
    act(() => useSettingsDraftStore.setState({ pending: {} }));
    expect(document.activeElement).toBe(select);
  });

  it('Agent spending: no handback when the person moved focus meanwhile', async () => {
    useSettingsDraftStore.setState({
      saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
    });
    render(<><AgentSpendSection /><button type="button">Elsewhere</button></>);
    await flush();
    const select = screen.getAllByRole('combobox').find((el) => !el.closest('.settings-apps'))!;
    act(() => select.focus());
    act(() => useSettingsDraftStore.setState((s) => ({ pending: { ...s.pending, agentSpend: true } })));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());
    act(() => useSettingsDraftStore.setState({ pending: {} }));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('Personal agents: a change in flight', async () => {
    let finish = () => {};
    api.updatePersonalAgent.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<PersonalAgentsSection />);
    await flush();
    const toggle = screen.getByRole('switch', { name: 'Use Mine in chat' });
    act(() => toggle.focus());
    fireEvent.click(toggle);
    await flush();
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    act(() => toggle.blur());
    expect(document.activeElement).toBe(document.getElementById('settings-personal-agents-heading'));
    await act(async () => { finish(); });
    await flush();
    await flush();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Use Mine in chat' }));
  });
});
