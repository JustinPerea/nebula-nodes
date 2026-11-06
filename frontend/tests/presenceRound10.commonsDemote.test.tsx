/**
 * PR #204 round 10 (GM r17 item 6, option b): the Commons on a demoted tab shows exactly what a
 * tab that never connected shows. A demote that lasts the held rule's 150 ms holds every Commons
 * call (lib/commonsHold: the not-connected line, nothing sent) and mounts the view
 * afresh; the promote mounts it again, which reads everything again; a quick reconnect never
 * switches.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const held = vi.hoisted(() => ({ calls: [] as boolean[], mounts: 0 }));
vi.mock('../src/lib/commonsApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/commonsApi')>();
  const never = () => new Promise(() => {});
  // Every read waits forever: the test counts mounts by the status read each mount makes.
  const api = new Proxy({}, { get: (_t, name) => (name === 'status' ? () => { held.mounts += 1; return never(); } : never) });
  return {
    ...real,
    commonsApi: api, commonsEvaluationApi: api, commonsReviewApi: api,
  };
});
vi.mock('../src/lib/commonsHold', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/commonsHold')>();
  return { ...real, holdCommonsCalls: (value: boolean) => { held.calls.push(value); real.holdCommonsCalls(value); } };
});

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');

beforeEach(() => { resetPersonSessionForTests(); held.calls = []; held.mounts = 0; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const demote = () => act(() => { notePersonPromoted(); reportPersonRequired(); });
const last = () => held.calls[held.calls.length - 1];

describe('the Commons on a demote (GM r17 item 6)', () => {
  it('past 150 ms: calls are held and the view mounts afresh; the promote mounts it again', () => {
    render(<CommonsView />);
    const first = held.mounts;
    expect(first).toBeGreaterThan(0);
    expect(last()).toBe(false);
    demote();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS + 1); });
    expect(last()).toBe(true);
    expect(held.mounts).toBe(first * 2);
    act(() => notePersonPromoted());
    expect(last()).toBe(false);
    expect(held.mounts).toBe(first * 3);
  });

  it('inside 150 ms: nothing switches and nothing reads again', () => {
    render(<CommonsView />);
    const first = held.mounts;
    demote();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS - 50); });
    act(() => notePersonPromoted());
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS * 2); });
    expect(held.calls.every((value) => value === false)).toBe(true);
    expect(held.mounts).toBe(first);
  });
});

describe('a held call (lib/commonsApi)', () => {
  it('answers with the not-connected line under its heading and sends nothing', async () => {
    const real = await vi.importActual<typeof import('../src/lib/commonsApi')>('../src/lib/commonsApi');
    const hold = await vi.importActual<typeof import('../src/lib/commonsHold')>('../src/lib/commonsHold');
    vi.useRealTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    hold.holdCommonsCalls(true);
    try {
      await expect(real.commonsApi.collections()).rejects.toMatchObject({
        message: expect.stringMatching(/^Nebula couldn’t load the collections because this tab isn’t connected as you\./),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      hold.holdCommonsCalls(false);
      fetchSpy.mockRestore();
    }
  });
});
