/**
 * PR #204 round 18b (CI on d3c9e79e): the held rule's 150 ms timer told the views once, reading
 * Date.now. A timer can fire up to a millisecond before Date.now shows its full delay, and then
 * personHeldSettled was still false, nothing told the views again, and a held view (the chat's
 * agent list) stayed unswitched. Here Date.now runs a millisecond behind the timers, as then.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const session = await import('../src/lib/personSession');

beforeEach(() => { vi.useFakeTimers(); session.resetPersonSessionForTests(); });
afterEach(() => { session.notePersonPromoted(); vi.useRealTimers(); });

it('a settle timer that fires before Date.now shows 150 ms waits the rest, then tells the views', () => {
  const told: boolean[] = [];
  const stop = session.subscribePersonGate(() => told.push(session.personHeldSettled()));
  session.reportPersonRequired();
  expect(told).toEqual([false]);
  vi.advanceTimersByTime(100);
  vi.setSystemTime(Date.now() - 1); // Date.now a millisecond behind the timers
  vi.advanceTimersByTime(50); // the timer's 150 ms: Date.now says 149
  expect(session.personHeldSettled()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(session.personHeldSettled()).toBe(true);
  expect(told.at(-1)).toBe(true);
  stop();
});

it('on time, it tells the views once, settled', () => {
  const told: boolean[] = [];
  const stop = session.subscribePersonGate(() => told.push(session.personHeldSettled()));
  session.reportPersonRequired();
  vi.advanceTimersByTime(150);
  expect(told).toEqual([false, true]);
  stop();
});
