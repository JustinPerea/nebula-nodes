/**
 * PR #204 round 13, Settings' person-only lists (the agent apps, personal agents):
 * - Review 10 held-calls LOW-2 (M10): useReadAsPerson reads once per epoch. A quick reconnect
 *   (a hold shorter than the held rule's 150 ms) ends no held view, so it reads nothing again.
 * - Review 10 held-calls NIT-1: a load refused just as the tab lost the person registers its
 *   retry, and a held view that then settles reads again on the promote too. The promote reads
 *   once: the view's new epoch when the held view settled, the retry when it didn't.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getOutsideSpend: vi.fn(), fetchPersonalAgents: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  getOutsideSpend: (...args: unknown[]) => api.getOutsideSpend(...args),
  fetchPersonalAgents: (...args: unknown[]) => api.fetchPersonalAgents(...args),
}));

const session = await import('../src/lib/personSession');
const { PersonalAgentsSection } = await import('../src/components/panels/settings/PersonalAgentsSection');
const { AgentSpendSection } = await import('../src/components/panels/settings/AgentSpendSection');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');

const AGENTS = { warningAcknowledged: true, agents: [] };
const SPEND = { outside: { spentUsd: 0, kreaPlanRuns: 0 }, apps: [], connect: { available: false } };
const refusal = () => Object.assign(new Error('Only the person can do this.'), { status: 403, code: 'person_required' });
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const pass = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
const reads = () => ({ apps: api.getOutsideSpend.mock.calls.length, agents: api.fetchPersonalAgents.mock.calls.length });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  session.resetPersonSessionForTests();
  api.getOutsideSpend.mockReset().mockResolvedValue(SPEND);
  api.fetchPersonalAgents.mockReset().mockResolvedValue(AGENTS);
  useSettingsDraftStore.setState({
    saved: { ...(useSettingsDraftStore.getState().saved ?? {}), agentSpend: { sessionUsd: 5, models: {} } } as never,
  });
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  vi.useRealTimers();
});

const mount = async () => {
  render(<><AgentSpendSection /><PersonalAgentsSection /></>);
  await flush();
};

describe('useReadAsPerson reads once per epoch (review 10 LOW-2, M10)', () => {
  it('a quick reconnect (held 100 ms, then promoted) reads nothing again', async () => {
    await mount();
    expect(reads()).toEqual({ apps: 1, agents: 1 });
    act(() => session.reportPersonRequired());
    await pass(100);
    act(() => session.notePersonPromoted());
    await flush();
    await pass(200);
    expect(reads()).toEqual({ apps: 1, agents: 1 });
  });

  it('a held view that settled reads once on the promote', async () => {
    await mount();
    act(() => session.reportPersonRequired());
    await pass(300);
    act(() => session.notePersonPromoted());
    await flush();
    await pass(200);
    expect(reads()).toEqual({ apps: 2, agents: 2 });
  });
});

describe('a refused load reads once on the promote (review 10 NIT-1)', () => {
  /** The first read of each list is refused as the tab loses the person (a backend restart). */
  const refuseFirst = () => {
    for (const read of [api.getOutsideSpend, api.fetchPersonalAgents]) {
      read.mockImplementationOnce(async () => {
        session.reportPersonRequired();
        throw refusal();
      });
    }
  };

  it('the held view settles, then the promote: one read each (the view\'s, not the retry\'s too)', async () => {
    refuseFirst();
    await mount();
    expect(reads()).toEqual({ apps: 1, agents: 1 });
    await pass(300); // the held view settles
    act(() => session.notePersonPromoted());
    await flush();
    await pass(200);
    await flush();
    expect(reads()).toEqual({ apps: 2, agents: 2 });
  });

  it('a quick reconnect after the refusal: the retry reads, once', async () => {
    refuseFirst();
    await mount();
    await pass(50);
    act(() => session.notePersonPromoted());
    await flush();
    await pass(200);
    await flush();
    expect(reads()).toEqual({ apps: 2, agents: 2 });
  });
});
