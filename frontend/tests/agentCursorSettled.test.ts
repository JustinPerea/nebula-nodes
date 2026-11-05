import { describe, expect, it } from 'vitest';
import { isSettled, type SettledWorld } from '../src/lib/agentCursorSettled';
import { fieldTextChanged } from '../src/lib/agentCursorField';
import { onSettled, type Expression } from '../src/lib/agentCursorExpression';

const agent = { id: 'claude' };
const world = (over: Partial<SettledWorld> = {}): SettledWorld => ({ proposalsSynced: true, proposals: {}, questionSets: {}, ...over });
const cursor = (over = {}) => ({ action: 'propose' as const, id: 'claude', proposalId: 'p1', receivedAt: 1000, ...over });
const open = (id: string, agentId = 'claude', closing?: string) => ({ [id]: { view: { agent: { id: agentId } }, closing } });
const set = (status: string, closedAt: number | null, agentId = 'claude') => ({ view: { agent: { id: agentId }, status, closedAt } });

describe('isSettled', () => {
  it('propose holds while its proposal is open, and ends once it is gone or closing', () => {
    expect(isSettled(cursor(), world({ proposals: open('p1') }))).toBe(false);
    expect(isSettled(cursor(), world({ proposals: open('p1', 'claude', 'accepted') }))).toBe(true);
    expect(isSettled(cursor(), world())).toBe(true);
  });
  it('before the canvas knows its proposals, nothing is settled', () => {
    expect(isSettled(cursor(), world({ proposalsSynced: false }))).toBe(false);
  });
  it('another proposal of the agent does not hold this one', () => {
    expect(isSettled(cursor(), world({ proposals: open('p2') }))).toBe(true);
  });
  it('a propose with no proposal id waits on the agent’s open proposals', () => {
    expect(isSettled(cursor({ proposalId: null }), world({ proposals: open('p2') }))).toBe(false);
    expect(isSettled(cursor({ proposalId: null }), world({ proposals: open('p2', 'other') }))).toBe(true);
    expect(isSettled(cursor({ proposalId: null }), world())).toBe(true);
  });
  it('wait: a question closed since the event settles it, an open one holds', () => {
    const w = (s: Record<string, ReturnType<typeof set>>) => world({ questionSets: s });
    expect(isSettled(cursor({ action: 'wait' }), w({}))).toBe(false);
    expect(isSettled(cursor({ action: 'wait' }), w({ q: set('open', null) }))).toBe(false);
    expect(isSettled(cursor({ action: 'wait' }), w({ q: set('answered', 2000) }))).toBe(true);
    expect(isSettled(cursor({ action: 'wait' }), w({ q: set('answered', 500) }))).toBe(false);
    expect(isSettled(cursor({ action: 'wait' }), w({ q: set('answered', 2000, 'other') }))).toBe(false);
    expect(isSettled(cursor({ action: 'wait' }), w({ a: set('answered', 2000), b: set('open', null) }))).toBe(false);
  });
  it('no other action is ever settled', () => {
    expect(isSettled(cursor({ action: 'think' }), world())).toBe(false);
    void agent;
  });
});

describe('onSettled', () => {
  const held = (action: Expression['action'], seq = 3): Expression => ({ action, seq, startedAt: 0, endsAt: null, gesture: true, keystrokeAt: 0 });
  it('ends its own propose or wait at once', () => {
    expect(onSettled(held('propose'), 3, 500)?.endsAt).toBe(500);
    expect(onSettled(held('wait'), 3, 500)?.endsAt).toBe(500);
  });
  it('leaves another event’s state, another action and an ended state alone', () => {
    expect(onSettled(held('propose'), 4, 500)?.endsAt).toBeNull();
    expect(onSettled(held('think'), 3, 500)?.endsAt).toBeNull();
    expect(onSettled({ ...held('propose'), endsAt: 100 }, 3, 500)?.endsAt).toBe(100);
    expect(onSettled(null, 3, 500)).toBeNull();
  });
});

describe('fieldTextChanged', () => {
  it('a status change is not text', () => {
    const params = { prompt: 'a' };
    expect(fieldTextChanged({ state: 'idle', params }, { state: 'running', params: { ...params } })).toBe(false);
  });
  it('a text param changing is', () => {
    expect(fieldTextChanged({ params: { prompt: 'a' } }, { params: { prompt: 'ab' } })).toBe(true);
  });
  it('with a port, only its param counts', () => {
    expect(fieldTextChanged({ params: { a: '1', b: 'x' } }, { params: { a: '1', b: 'y' } }, 'a')).toBe(false);
    expect(fieldTextChanged({ params: { a: '1' } }, { params: { a: '2' } }, 'a')).toBe(true);
  });
});
