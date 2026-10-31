/**
 * PR #204 round 11 (review 9 lock-sweep MEDIUM-3, GM r19 item 2): a demote that takes away the
 * focused personal agent row (the list goes to what a never-connected tab shows) moves focus to
 * the section's not-connected line (tabIndex -1), never to the page; a demote while focus is on a
 * control that stays (the Add form) leaves it there.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchPersonalAgents: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  fetchPersonalAgents: (...args: unknown[]) => api.fetchPersonalAgents(...args),
}));

const session = await import('../src/lib/personSession');
const { PersonalAgentsSection } = await import('../src/components/panels/settings/PersonalAgentsSection');

const AGENTS = {
  warningAcknowledged: true,
  agents: [{
    id: 'mine', displayName: 'Mine', kind: 'custom', status: 'ready', enabled: true, startable: true,
    command: '/bin/mine', args: [], color: '#88f', note: null,
  }],
};

const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
const demote = () => act(() => { session.notePersonPromoted(); session.reportPersonRequired(); });
const passFrames = async () => { await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  session.resetPersonSessionForTests();
  api.fetchPersonalAgents.mockReset().mockResolvedValue(AGENTS);
});
afterEach(() => { cleanup(); act(() => session.notePersonPromoted()); vi.useRealTimers(); });

describe('focus across a demote in Personal agents (GM r19 item 2)', () => {
  it('the focused row goes: focus moves to the section\'s line, which can take it', async () => {
    render(<PersonalAgentsSection />);
    await flush();
    const row = screen.getByRole('switch', { name: 'Use Mine in chat' });
    act(() => row.focus());
    demote();
    await passFrames();
    expect(screen.queryByRole('switch', { name: 'Use Mine in chat' })).toBeNull();
    const focused = document.activeElement as HTMLElement;
    expect(focused).not.toBe(document.body);
    expect(focused.hasAttribute('data-focus-line')).toBe(true);
    expect(focused.getAttribute('tabindex')).toBe('-1');
    expect(focused.textContent).toMatch(/^Nebula couldn’t load your agents because|^You can /);
  });

  it('focus on a control that stays (the Add form) is left where it is', async () => {
    render(<PersonalAgentsSection />);
    await flush();
    const field = screen.getByRole('textbox', { name: 'Custom agent id' });
    act(() => field.focus());
    demote();
    await passFrames();
    expect(document.activeElement).toBe(field);
  });
});
