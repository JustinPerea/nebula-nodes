import { describe, expect, it } from 'vitest';
import {
  SENDING_AFTER_MS,
  SENDING_HOLD_MS,
  mergeMissing,
  mergeRows,
  otherFailureLine,
  sanitizeListener,
  sanitizeRow,
  sendFailure,
  sendingSettleDelay,
  type ChannelListener,
  type ThreadRow,
} from './personThread';
import {
  HELD_LINE,
  LISTENER_DROPPED_LINE,
  NOT_CONNECTED_LINE,
  SERVER_FAILED_LINE,
  QUIET_SENT_MS,
  STOPPED_LISTENING_LINE,
  WAITING_LINE,
  WORKING_SETTLE_MS,
  actionsLabel,
  availability,
  contextChipLabel,
  contextRemoveLabel,
  counterAnnouncement,
  counterLine,
  foldActions,
  messageStatus,
  nextStatusChange,
  repliedAfter,
  unreadLabel,
} from './personThreadBox';
import { RequestFailedError, failureMessage } from './errorCopy';

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';

function message(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'm1', kind: 'message', at: 1_000, text: 'Make the sky warmer', state: 'sent',
    to: { listenerId: 'ch_1', agent: CLAUDE, session: { key: KEY, ordinal: 1 }, sessionKey: KEY },
    ...over,
  };
}

function listener(over: Partial<ChannelListener> = {}): ChannelListener {
  return {
    listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: { key: KEY, ordinal: 1 }, ...over,
  };
}

describe('the r50 strings, verbatim', () => {
  it('pins every line', () => {
    expect(NOT_CONNECTED_LINE).toBe('Connect Claude Code with the Nebula channel to message it here.');
    expect(STOPPED_LISTENING_LINE).toBe('Claude stopped listening. Reconnect nebula-listen with /mcp in its terminal to message it here.');
    expect(SERVER_FAILED_LINE).toBe('Nebula couldn’t send your message because the server isn’t answering. Try again.');
    expect(LISTENER_DROPPED_LINE).toBe('Nebula couldn’t send your message because Claude stopped listening. Reconnect it in the terminal, then send it again.');
    // r55 replaced r50's cap failure with a neutral hold.
    expect(HELD_LINE).toBe('Sends in a few minutes because you’ve sent 200 this hour.');
  });

  it('pins r50’s times: Sending… after 300 ms held 400, working settles at 20 s, "Sent" at 60 s', () => {
    expect([SENDING_AFTER_MS, SENDING_HOLD_MS, WORKING_SETTLE_MS, QUIET_SENT_MS]).toEqual([300, 400, 20_000, 60_000]);
  });

  it('labels the chip, its ×, the badge and the folded actions', () => {
    expect(contextChipLabel(['Hero shot'])).toBe('About “Hero shot”');
    expect(contextChipLabel(['Hero shot', 'Sky'])).toBe('About “Hero shot” and “Sky”');
    expect(contextChipLabel(['Hero shot', 'Sky', 'Sea'])).toBe('About “Hero shot”, “Sky” and “Sea”');
    expect(contextChipLabel(['a', 'b', 'c', 'd'])).toBe('About 4 nodes');
    expect(contextRemoveLabel(['Hero shot'])).toBe('Remove “Hero shot”');
    expect(contextRemoveLabel(['Hero shot', 'Sky'])).toBe('Remove the nodes');
    expect(unreadLabel(1)).toBe('1 unread reply');
    expect(unreadLabel(2)).toBe('2 unread replies');
    expect(actionsLabel(1)).toBe('1 action');
    expect(actionsLabel(3)).toBe('3 actions');
  });
});

describe('a message’s state comes only from what Nebula saw', () => {
  const none = { replied: false, activity: null };

  it('says nothing while sent and not yet pushed, then "Sent" after 60 s', () => {
    expect(messageStatus(message(), 1_500, none)).toBeNull();
    expect(messageStatus(message(), 1_000 + QUIET_SENT_MS, none)).toEqual({ kind: 'sent', text: 'Sent' });
  });

  it('waits once the listener accepted the push', () => {
    const row = message({ state: 'accepted' });
    expect(messageStatus(row, 2_000, none)).toEqual({ kind: 'waiting', text: WAITING_LINE });
    expect(messageStatus(row, 1_000 + QUIET_SENT_MS - 1, none)?.kind).toBe('waiting');
    expect(messageStatus(row, 1_000 + QUIET_SENT_MS, none)?.kind).toBe('sent');
  });

  it('works with the session’s latest action line, and settles back after 20 s', () => {
    const row = message({ state: 'accepted' });
    const activity = { at: 5_000, line: 'Changing “Prompt” on “Hero shot”' };
    expect(messageStatus(row, 6_000, { replied: false, activity }))
      .toEqual({ kind: 'working', text: 'Claude is working · Changing “Prompt” on “Hero shot”' });
    expect(messageStatus(row, 5_000 + WORKING_SETTLE_MS - 1, { replied: false, activity })?.kind).toBe('working');
    expect(messageStatus(row, 5_000 + WORKING_SETTLE_MS, { replied: false, activity })?.kind).toBe('waiting');
    // 60 s with nothing back counts from the last event.
    expect(messageStatus(row, 5_000 + QUIET_SENT_MS, { replied: false, activity })?.kind).toBe('sent');
    expect(messageStatus(row, 1_000 + QUIET_SENT_MS, { replied: false, activity })?.kind).toBe('waiting');
  });

  it('ignores an event from before the message', () => {
    const row = message({ state: 'accepted', at: 9_000 });
    expect(messageStatus(row, 9_500, { replied: false, activity: { at: 8_000, line: 'x' } })?.kind).toBe('waiting');
  });

  it('works without a line when the event had none', () => {
    const row = message({ state: 'accepted' });
    expect(messageStatus(row, 2_000, { replied: false, activity: { at: 1_500, line: null } })?.text).toBe('Claude is working');
  });

  it('holds with r55’s neutral line, whatever else happened', () => {
    const row = message({ state: 'held' });
    expect(messageStatus(row, 1_000 + 10 * QUIET_SENT_MS, { replied: false, activity: { at: 2_000, line: 'x' } }))
      .toEqual({ kind: 'held', text: HELD_LINE });
    expect(nextStatusChange(row, 2_000, null)).toBeNull();
  });

  it('clears once a reply came', () => {
    expect(messageStatus(message({ state: 'accepted' }), 2_000, { replied: true, activity: null })).toBeNull();
  });

  it('knows when to look again', () => {
    const row = message({ state: 'accepted' });
    expect(nextStatusChange(row, 2_000, null)).toBe(1_000 + QUIET_SENT_MS);
    expect(nextStatusChange(row, 6_000, { at: 5_000, line: 'x' })).toBe(5_000 + WORKING_SETTLE_MS);
    expect(nextStatusChange(row, 5_000 + WORKING_SETTLE_MS, { at: 5_000, line: 'x' })).toBe(5_000 + QUIET_SENT_MS);
    expect(nextStatusChange(row, 5_000 + QUIET_SENT_MS, { at: 5_000, line: 'x' })).toBeNull();
  });

  it('a reply counts for its own agent and session only', () => {
    const row = message();
    const reply = (over: Partial<ThreadRow>): ThreadRow => ({ id: 'r', kind: 'reply', at: 2_000, agent: CLAUDE, sessionKey: KEY, ...over });
    expect(repliedAfter(row, [row, reply({})])).toBe(true);
    expect(repliedAfter(row, [row, reply({ at: 500 })])).toBe(false);
    expect(repliedAfter(row, [row, reply({ sessionKey: 'ffffffffffff' })])).toBe(false);
    expect(repliedAfter(row, [row, reply({ agent: { ...CLAUDE, id: 'other' } })])).toBe(false);
  });
});

describe('Sending… shows after 300 ms and holds 400 ms', () => {
  it('settles at once when answered before it showed', () => {
    expect(sendingSettleDelay(0, 0)).toBe(0);
    expect(sendingSettleDelay(0, 299)).toBe(0);
  });

  it('holds the line 400 ms once shown', () => {
    expect(sendingSettleDelay(0, 300)).toBe(400);
    expect(sendingSettleDelay(0, 500)).toBe(200);
    expect(sendingSettleDelay(0, 700)).toBe(0);
    expect(sendingSettleDelay(0, 5_000)).toBe(0);
  });
});

describe('availability and the recipient', () => {
  it('locks with the right line', () => {
    expect(availability([], false, null, {}).kind).toBe('notConnected');
    expect(availability([listener({ state: 'stopped' })], false, null, {}).kind).toBe('stopped');
    expect(availability([listener()], true, null, {}).kind).toBe('offline');
    expect(availability([listener()], false, null, {}).kind).toBe('ready');
  });

  it('goes to the session active most recently, unless the person chose one', () => {
    const one = listener();
    const two = listener({ listenerId: 'ch_2', sessionKey: 'bbbbbbbbbbbb', since: 50, session: { key: 'bbbbbbbbbbbb', ordinal: 2 } });
    const pick = (chosen: string | null, seen: Record<string, number>) => {
      const state = availability([one, two], false, chosen, seen);
      return state.kind === 'ready' ? state.recipient.listenerId : null;
    };
    expect(pick(null, {})).toBe('ch_1');
    expect(pick(null, { bbbbbbbbbbbb: 900 })).toBe('ch_2');
    expect(pick('ch_2', {})).toBe('ch_2');
    expect(pick('gone', {})).toBe('ch_1');
  });
});

describe('the counter', () => {
  it('shows "N left" from 200 left', () => {
    expect(counterLine(1_799)).toBeNull();
    expect(counterLine(1_800)).toBe('200 left');
    expect(counterLine(2_000)).toBe('0 left');
  });

  it('speaks only past 30, 10 and 0', () => {
    expect(counterAnnouncement(1_969, 1_970)).toBe('30 characters left');
    expect(counterAnnouncement(1_970, 1_971)).toBeNull();
    expect(counterAnnouncement(1_989, 1_990)).toBe('10 characters left');
    expect(counterAnnouncement(1_999, 2_000)).toBe('0 characters left');
    expect(counterAnnouncement(1_900, 1_995)).toBe('5 characters left');
    expect(counterAnnouncement(1_990, 1_980)).toBeNull();
  });
});

describe('failures', () => {
  it('tells the listener dropping from the server not answering', () => {
    const stopped = new RequestFailedError("Couldn't send your message.", 409, { code: 'listener_stopped' });
    expect(sendFailure(stopped)).toBe('stopped');
    expect(sendFailure(new RequestFailedError('x', 503))).toBe('server');
    expect(sendFailure(new TypeError('Failed to fetch'))).toBe('server');
    const refused = new RequestFailedError("Couldn't send your message.", 422, { detail: 'too long' });
    expect(sendFailure(refused)).toBe('other');
    // failureMessage's words under the send's heading, never the Error's raw message.
    expect(otherFailureLine(refused)).toBe(failureMessage(refused, "Couldn't send your message."));
  });
});

describe('rows', () => {
  it('reads the backend’s rows and drops anything else', () => {
    const row = sanitizeRow({
      id: 'm1', kind: 'message', at: 5, text: 'hi', state: 'accepted', clientId: 'c-1', nodeIds: ['n1', 3],
      to: { listenerId: 'ch_1', agent: CLAUDE, session: { key: KEY, ordinal: null } },
    });
    expect(row).toMatchObject({ id: 'm1', state: 'accepted', clientId: 'c-1', nodeIds: ['n1'] });
    // A session with no live cursor still names its key.
    expect(row?.to).toMatchObject({ listenerId: 'ch_1', session: null, sessionKey: KEY });
    expect(sanitizeRow({ id: 'x', kind: 'nope', at: 1 })).toBeNull();
    expect(sanitizeRow(null)).toBeNull();
    expect(sanitizeListener({ listenerId: 'ch_1', agent: CLAUDE, state: 'stopped', session: { key: KEY, ordinal: 1 } }))
      .toMatchObject({ state: 'stopped', sessionKey: KEY, session: { key: KEY, ordinal: 1 } });
  });

  it('merges by id, in time order, and keeps a newer copy over the POST’s', () => {
    const sent = message({ state: 'sent' });
    const accepted = message({ state: 'accepted' });
    expect(mergeRows([sent], [accepted])[0].state).toBe('accepted');
    expect(mergeMissing([accepted], [sent])[0].state).toBe('accepted');
    const later = message({ id: 'm2', at: 3_000 });
    expect(mergeRows([later], [sent]).map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('folds the actions between rows', () => {
    const rows = [message({ at: 10 }), { id: 'r1', kind: 'reply' as const, at: 40, agent: CLAUDE }];
    const entries = [{ id: 'e1', ts: 5 }, { id: 'e2', ts: 20 }, { id: 'e3', ts: 30 }, { id: 'e4', ts: 50 }];
    const items = foldActions(rows, entries);
    expect(items.map((item) => (item.kind === 'row' ? item.row.id : item.entries.map((e) => e.id).join('+'))))
      .toEqual(['e1', 'm1', 'e2+e3', 'r1', 'e4']);
  });
});
