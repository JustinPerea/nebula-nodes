import { describe, expect, it } from 'vitest';
import type { ChannelListener, ThreadRow } from './personThread';
import {
  LISTENER_DROPPED_LINE,
  STOPPED_LISTENING_LINE,
  WAITING_LINE,
  WORKING_LINE,
  answeredLine,
  availability,
  foldActions,
  joinQuoted,
  listenerDroppedLine,
  messageStatus,
  oneLine,
  runOrigin,
  statusLeadsRun,
  stoppedListeningLine,
  waitingLine,
  withRun,
  workingLine,
} from './personThreadBox';

/** GM - Design r61 on #225: the pure parts of A, 3 and 4. */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';

function message(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'm1', kind: 'message', at: 1_000, text: 'Warmer', state: 'accepted',
    to: { listenerId: 'ch_1', agent: CLAUDE, session: { key: KEY, ordinal: 1 }, sessionKey: KEY }, ...over,
  };
}

function reply(at: number, over: Partial<ThreadRow> = {}): ThreadRow {
  return { id: `r${at}`, kind: 'reply', at, text: 'Done.', agent: CLAUDE, sessionKey: KEY, ...over };
}

function listener(over: Partial<ChannelListener> = {}): ChannelListener {
  return {
    listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: { key: KEY, ordinal: 1 }, ...over,
  };
}

describe('r61 answer 3: names', () => {
  it('a session by its cursor label; one session reads as r50 did', () => {
    expect(waitingLine('Claude · 2')).toBe('Waiting for Claude · 2');
    expect(workingLine('Claude · 2', 'Cooler sky')).toBe('Claude · 2 is working · Cooler sky');
    expect(workingLine('Claude · 2')).toBe('Claude · 2 is working');
    expect(stoppedListeningLine('Claude · 2')).toBe('Claude · 2 stopped listening. Reconnect nebula-listen with /mcp in its terminal to message it here.');
    expect(listenerDroppedLine('Claude · 2')).toBe('Nebula couldn’t send your message because Claude · 2 stopped listening. Reconnect it in the terminal, then send it again.');
    expect(WAITING_LINE).toBe('Waiting for Claude');
    expect(WORKING_LINE).toBe('Claude is working');
    expect(STOPPED_LISTENING_LINE).toBe('Claude stopped listening. Reconnect nebula-listen with /mcp in its terminal to message it here.');
    expect(LISTENER_DROPPED_LINE).toBe('Nebula couldn’t send your message because Claude stopped listening. Reconnect it in the terminal, then send it again.');
  });

  it('the status lines carry the label they are given', () => {
    const row = message();
    expect(messageStatus(row, 2_000, { replied: false, activity: null, label: 'Claude · 2' })).toEqual({ kind: 'waiting', text: 'Waiting for Claude · 2' });
    expect(messageStatus(row, 2_000, { replied: false, activity: { at: 1_500, line: 'Cooler sky' }, label: 'Claude · 2' }))
      .toEqual({ kind: 'working', text: 'Claude · 2 is working · Cooler sky' });
  });

  it('stopped names the session that stopped last', () => {
    const old = listener({ listenerId: 'ch_1', state: 'stopped', since: 100 });
    const recent = listener({ listenerId: 'ch_2', state: 'stopped', since: 500, sessionKey: 'bbbbbbbbbbbb', session: { key: 'bbbbbbbbbbbb', ordinal: 2 } });
    const state = availability([old, recent], false, null, {});
    expect(state.kind).toBe('stopped');
    expect(state.kind === 'stopped' && state.listener.listenerId).toBe('ch_2');
  });
});

describe('r61 answer 4: answered lines', () => {
  it('one choice, several joined, and words typed', () => {
    expect(answeredLine([{ choices: ['Only this one'], text: null }])).toBe('You chose “Only this one”.');
    expect(answeredLine([{ choices: ['All three'], text: null }, { choices: ['Keep 1:1'], text: null }]))
      .toBe('You chose “All three” and “Keep 1:1”.');
    expect(answeredLine([{ choices: ['A', 'B'], text: null }, { choices: ['C'], text: null }])).toBe('You chose “A”, “B” and “C”.');
    expect(answeredLine([{ choices: [], text: 'Keep the warm one' }])).toBe('You answered “Keep the warm one”.');
    expect(answeredLine([{ choices: [], text: '  ' }])).toBeNull();
    expect(answeredLine([])).toBeNull();
    // Never counted, unlike node names: every answer is named.
    expect(joinQuoted(['a', 'b', 'c', 'd'])).toBe('“a”, “b”, “c” and “d”');
  });

  it('the chip’s question is one line', () => {
    expect(oneLine('Use the same\n palette   on the others?')).toBe('Use the same palette on the others?');
  });
});

describe('r61 A: the run', () => {
  const entry = (id: string, ts: number) => ({ id, ts });

  it('the run is the latest message with no reply', () => {
    expect(runOrigin([message()], [])?.id).toBe('m1');
    expect(runOrigin([message(), reply(2_000)], [])).toBeNull();
    expect(runOrigin([message(), reply(2_000), message({ id: 'm2', at: 3_000 })], [])?.id).toBe('m2');
    // A later reference row doesn't end the run.
    expect(runOrigin([message(), { id: 'p', kind: 'proposal', at: 2_000, agent: CLAUDE }], [])?.id).toBe('m1');
    expect(runOrigin([], [])).toBeNull();
  });

  it('only working and waiting lead the fold', () => {
    expect(statusLeadsRun({ kind: 'working', text: '' })).toBe(true);
    expect(statusLeadsRun({ kind: 'waiting', text: '' })).toBe(true);
    expect(statusLeadsRun({ kind: 'sent', text: '' })).toBe(false);
    expect(statusLeadsRun({ kind: 'held', text: '' })).toBe(false);
    expect(statusLeadsRun(null)).toBe(false);
  });

  it('the trailing actions become the run’s fold, keeping their id; none: a status item at the end', () => {
    const run = message();
    const origin = runOrigin([run], [])!;
    const items = foldActions([run], [entry('e1', 1_500), entry('e2', 1_600)]);
    const marked = withRun(items, origin);
    expect(marked.map((item) => item.kind)).toEqual(['row', 'run']);
    expect(marked[1]).toMatchObject({ kind: 'run', id: 'actions-e1', entries: [{ id: 'e1' }, { id: 'e2' }] });
    // The reply lands: the same id, now a plain fold above it.
    const after = foldActions([run, reply(2_000)], [entry('e1', 1_500), entry('e2', 1_600)]);
    expect(after.map((item) => (item.kind === 'row' ? item.row.id : item.kind === 'answer' ? item.answer.id : item.id))).toEqual(['m1', 'actions-e1', 'r2000']);
    expect(withRun(foldActions([run], []), origin)).toEqual([{ kind: 'row', row: run }, { kind: 'run', id: 'run-m1', origin, entries: [] }]);
    expect(withRun(items, null)).toEqual(items);
  });
});

describe('GM r112.3: a pin answer’s cursor say folds into the pin reply row', () => {
  const pinReply: ThreadRow = { id: 'pr1', kind: 'pinReply', at: 5_000, text: 'Pin fold check answered. The sky is warmer.',
    pinId: 'pin1', agent: CLAUDE, session: null };
  const say = (over: Partial<{ id: string; ts: number; message: string; agent: { id: string; name: string } }> = {}) => ({
    id: 'e1', ts: 5_200, message: 'Pin fold check answered.', agent: { id: CLAUDE.id, name: CLAUDE.name }, ...over });

  it('never a trailing "1 action" after the pin reply row', () => {
    expect(foldActions([pinReply], [say()]).map((item) => item.kind)).toEqual(['row']);
    expect(foldActions([pinReply], [say({ message: 'Pin fold check answered. The sky is warmer.' })]).map((item) => item.kind)).toEqual(['row']);
  });

  it('another agent, another sentence or a late say still folds', () => {
    expect(foldActions([pinReply], [say({ agent: { id: 'a2', name: 'Codex' } })]).at(-1)?.kind).toBe('actions');
    // Another agent with the same name (two apps both called Claude): still its own action.
    expect(foldActions([pinReply], [say({ agent: { id: 'a2', name: CLAUDE.name } })]).at(-1)?.kind).toBe('actions');
    expect(foldActions([pinReply], [say({ message: 'Moved the sun.' })]).at(-1)?.kind).toBe('actions');
    expect(foldActions([pinReply], [say({ ts: 16_000 })]).at(-1)?.kind).toBe('actions');
  });
});
