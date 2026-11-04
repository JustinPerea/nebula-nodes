import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../lib/apiRequest', () => ({ apiRequest }));

import { mergeRows, sanitizeRow, syncRows, type ThreadRow } from './personThread';
import { answerRows, cutAtWord, repliedAfter } from './personThreadBox';
import { springScrollTo } from './scrollSpring';
import { receiveRows, receiveSync, usePersonThreadStore } from '../store/personThreadStore';
import { useUIStore } from '../store/uiStore';

/** #225 review 3 and GM r100: the possessive cut (NIT-1), the pinned
 * survivors F5/F6 (LOW-6), sync by row version (LOW-4), a reply saved in
 * another project's thread (r100.3) and the scroll spring (r100.2). */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';
const SESSION = { key: KEY, ordinal: 1 };
const byLength = (max: number) => (candidate: string) => candidate.length <= max;

function message(id: string, at: number, over: Partial<ThreadRow> = {}): ThreadRow {
  return { id, kind: 'message', at, text: 'Make it warmer', state: 'accepted',
    to: { listenerId: 'ch_1', agent: CLAUDE, session: SESSION, sessionKey: KEY }, ...over };
}

function reply(id: string, at: number, over: Partial<ThreadRow> = {}): ThreadRow {
  return { id, kind: 'reply', at, text: 'Done.', agent: CLAUDE, session: SESSION, sessionKey: KEY, ...over };
}

beforeEach(() => {
  usePersonThreadStore.getState().reset();
  useUIStore.setState({ agentLogOpen: false });
  apiRequest.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('review 3 NIT-1: cutAtWord keeps a possessive apostrophe', () => {
  it('“the dogs’…”, straight or curly, and still drops a closing quote with no opener', () => {
    expect(cutAtWord("Feed the dogs' bowl first", byLength(15))).toBe("Feed the dogs'…");
    expect(cutAtWord('Feed the dogs’ bowl first', byLength(15))).toBe('Feed the dogs’…');
    // A quote the words opened is still closed after the ellipsis, never doubled.
    expect(cutAtWord("Use 'warm tones' and more", byLength(17))).toBe("Use 'warm tones'…");
    // A stray closer after punctuation is still dropped.
    expect(cutAtWord("Done, ' then more words", byLength(9))).toBe('Done…');
  });
});

describe('review 3 LOW-6 F5: a reply that names a later message clears the ones before it', () => {
  it('m1 and m2 are cleared by a reply to m2; m3 after it is not', () => {
    const m1 = message('m1', 1_000);
    const m2 = message('m2', 2_000);
    const m3 = message('m3', 3_000);
    const rows = [m1, m2, m3, reply('r1', 4_000, { replyTo: 'm2' })];
    expect(repliedAfter(m1, rows)).toBe(true);
    expect(repliedAfter(m2, rows)).toBe(true);
    expect(repliedAfter(m3, rows)).toBe(false);
  });
});

describe('review 3 LOW-6 F6: the You row sits at the later of closedAt and the row', () => {
  it('a set closed before its row arrived is placed at the row', () => {
    const row: ThreadRow = { id: 'row-q', kind: 'question', at: 5_000, questionId: 'q', agent: CLAUDE };
    const view = { status: 'answered', closedAt: 4_000, answers: [{ choices: [], text: 'Warm' }] };
    expect(answerRows([row], { q: { view } })[0].at).toBe(5_000);
    expect(answerRows([row], { q: { view: { ...view, closedAt: 6_000 } } })[0].at).toBe(6_000);
  });
});

describe('review 3 LOW-4: rows merge by version', () => {
  it('a lower rev never replaces the copy held; an equal or higher one does', () => {
    const held = message('m1', 1_000, { state: 'accepted', rev: 2 });
    expect(mergeRows([held], [message('m1', 1_000, { state: 'sent', rev: 1 })])[0].state).toBe('accepted');
    expect(mergeRows([held], [message('m1', 1_000, { state: 'held', rev: 3 })])[0].state).toBe('held');
  });

  it('the socket’s row keeps its rev; a bad one is dropped', () => {
    expect(sanitizeRow({ ...message('m1', 1_000), rev: 3 })?.rev).toBe(3);
    expect(sanitizeRow({ ...message('m1', 1_000), rev: 'x' })?.rev).toBeUndefined();
  });

  it('a stale sync keeps a reply that came after its snapshot, and drops what the snapshot no longer has', () => {
    const current = [message('m1', 1_000, { rev: 2 }), reply('r-old', 1_500), reply('r-new', 3_000)];
    const snapshot = [message('m1', 1_000, { state: 'sent', rev: 1 }), message('m2', 2_000, { rev: 1 })];
    const out = syncRows(current, snapshot);
    expect(out.map((row) => row.id)).toEqual(['m1', 'm2', 'r-new']);
    expect(out[0].state).toBe('accepted');
  });

  it('the store merges a sync of the same project, never moving a row back', () => {
    receiveSync('p1', [message('m1', 1_000, { rev: 1, state: 'sent' })]);
    receiveRows('p1', [message('m1', 1_000, { rev: 2, state: 'accepted' }), reply('r1', 2_000)]);
    receiveSync('p1', [message('m1', 1_000, { rev: 1, state: 'sent' })]);
    const rows = usePersonThreadStore.getState().rows;
    expect(rows.map((row) => row.id)).toEqual(['m1', 'r1']);
    expect(rows[0].state).toBe('accepted');
  });
});

describe('GM r100.3: a reply saved in another project’s thread is unread there', () => {
  it('both ways: p2’s reply while p1 is open, then p1’s while p2 is open', () => {
    receiveSync('p1', [message('m1', 1_000)]);
    receiveRows('p2', [reply('r2', 2_000)]);
    let state = usePersonThreadStore.getState();
    expect(state.rows.map((row) => row.id)).toEqual(['m1']);
    expect(state.unread).toBe(0);
    expect(state.unreadElsewhere).toEqual({ p2: 1 });
    // Opening p2: its reply is unread there; p1's count is gone with it.
    receiveSync('p2', [message('m2', 1_500), reply('r2', 2_000)]);
    state = usePersonThreadStore.getState();
    expect(state.unread).toBe(1);
    expect(state.unreadElsewhere).toEqual({});
    // The other way: a reply for p1 while p2 is open.
    receiveRows('p1', [reply('r1', 3_000)]);
    expect(usePersonThreadStore.getState().unreadElsewhere).toEqual({ p1: 1 });
    receiveSync('p1', [message('m1', 1_000), reply('r1', 3_000)]);
    state = usePersonThreadStore.getState();
    expect(state.unread).toBe(1);
    expect(state.unreadElsewhere).toEqual({});
  });

  it('opening that thread with the log already open leaves nothing unread; a message is never counted', () => {
    receiveSync('p1', []);
    receiveRows('p2', [message('m9', 1_000), reply('r2', 2_000)]);
    expect(usePersonThreadStore.getState().unreadElsewhere).toEqual({ p2: 1 });
    useUIStore.setState({ agentLogOpen: true });
    receiveSync('p2', [reply('r2', 2_000)]);
    expect(usePersonThreadStore.getState().unread).toBe(0);
  });
});

describe('GM r100.2: the scroll spring', () => {
  function box(): HTMLElement {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
  }

  function reduced(on: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: on && query.includes('reduce'), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);
  }

  it('jumps under reduced motion', () => {
    reduced(true);
    const element = box();
    const done = vi.fn();
    springScrollTo(element, () => 400, done);
    expect(element.scrollTop).toBe(400);
    expect(done).toHaveBeenCalledTimes(1);
    element.remove();
  });

  it('springs over frames to the target, read each frame', () => {
    reduced(false);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const element = box();
    let target = 300;
    const done = vi.fn();
    springScrollTo(element, () => target, done);
    expect(element.scrollTop).toBe(0);
    frames.shift()!(0);
    frames.shift()!(50);
    const midway = element.scrollTop;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(300);
    target = 360;
    let now = 50;
    while (frames.length > 0 && now < 5_000) { now += 16; frames.shift()!(now); }
    expect(element.scrollTop).toBe(360);
    expect(done).toHaveBeenCalledTimes(1);
    element.remove();
  });

  it('the person’s own input ends it where it is (rigid wins)', () => {
    reduced(false);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const element = box();
    const done = vi.fn();
    springScrollTo(element, () => 300, done);
    frames.shift()!(0);
    frames.shift()!(40);
    const held = element.scrollTop;
    element.dispatchEvent(new Event('wheel'));
    expect(done).toHaveBeenCalledTimes(1);
    for (const frame of frames.splice(0)) frame(5_000);
    expect(element.scrollTop).toBe(held);
    element.remove();
  });
});
