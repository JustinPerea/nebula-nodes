import { describe, expect, it } from 'vitest';
import { countsAsReply, type ChannelListener, type ThreadRow } from './personThread';
import {
  ANSWERED_ELSEWHERE_LINE,
  CLOSED_ELSEWHERE_LINE,
  GONE_ELSEWHERE_LINE,
  NEW_REPLY_PILL,
  NOT_CONNECTED_LINE,
  answerGoneCause,
  answerGoneLine,
  answeredLine,
  answeredQuote,
  closingPeriod,
  availability,
  availabilityLabel,
  cutAtWord,
  cutParts,
  pillFor,
  runOrigin,
  stoppedListeningLine,
  withdrawnLine,
} from './personThreadBox';

/** GM r89 on #225 review 2 (items 1, 3, 4, 5) and review 2's NIT-1 and F10: the pure parts. */

const CLAUDE_CODE = { id: 'a1', name: 'Claude Code', color: '#E8825A', verified: true };
const KEY = '0123456789ab';
const KEY2 = 'ba9876543210';
const byLength = (max: number) => (candidate: string) => candidate.length <= max;
const KINDS: ThreadRow['kind'][] = ['message', 'reply', 'question', 'proposal', 'note', 'pin', 'pinReply'];

function listener(over: Partial<ChannelListener> = {}): ChannelListener {
  return { listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE_CODE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: { key: KEY, ordinal: 1 }, ...over };
}

describe('r89.1: one rule for what counts as a reply', () => {
  it('a reply and a pin answer count; the person’s rows, pins, questions, proposals and notes don’t', () => {
    expect(KINDS.filter((kind) => countsAsReply({ kind }))).toEqual(['reply', 'pinReply']);
  });

  it('the pill reads "New reply" for exactly the rows that count', () => {
    for (const kind of KINDS) {
      const row = { id: kind, kind, at: 1 } as ThreadRow;
      expect(pillFor(row) === NEW_REPLY_PILL, kind).toBe(countsAsReply(row));
    }
    expect(pillFor({ id: 'q', kind: 'question', at: 1 })).toBe('New question');
    expect(pillFor({ id: 'm', kind: 'message', at: 1 })).toBeNull();
    expect(pillFor({ id: 'p', kind: 'pin', at: 1 })).toBeNull();
  });
});

describe('r89.3: why the "Answering" chip went', () => {
  it('the cause from the set’s status; none while open or for a set this tab no longer holds (F13)', () => {
    expect(answerGoneCause('withdrawn')).toBe('withdrawn');
    expect(answerGoneCause('answered')).toBe('answered');
    expect(answerGoneCause('dismissed')).toBe('closed');
    expect(answerGoneCause('open')).toBeNull();
    expect(answerGoneCause(undefined)).toBeNull();
  });

  it('GM r89.3’s lines, word for word; the withdrawn one names the asker', () => {
    expect(ANSWERED_ELSEWHERE_LINE).toBe('You answered this question in another tab. Send again to post your text as a message every agent can read.');
    expect(CLOSED_ELSEWHERE_LINE).toBe('You closed this question in another tab. Send again to post your text as a message every agent can read.');
    expect(answerGoneLine({ cause: 'answered', label: 'Claude' })).toBe(ANSWERED_ELSEWHERE_LINE);
    expect(answerGoneLine({ cause: 'closed', label: 'Claude' })).toBe(CLOSED_ELSEWHERE_LINE);
    expect(answerGoneLine({ cause: 'withdrawn', label: 'Claude Code · 2' })).toBe(withdrawnLine('Claude Code · 2'));
    // GM r94.1 (F13): a set this tab no longer holds, true whatever the cause.
    expect(GONE_ELSEWHERE_LINE).toBe('This question is closed. Send again to post your text as a message every agent can read.');
    expect(answerGoneLine({ cause: 'gone', label: 'Claude' })).toBe(GONE_ELSEWHERE_LINE);
  });
});

describe('r89.4: one label for the field and the lock line', () => {
  it('ready: the recipient; stopped: the listener that stopped; not connected: the product', () => {
    expect(availabilityLabel(availability([listener()], false, null, {}))).toBe('Claude Code');
    expect(availabilityLabel(availability([listener({ session: { key: KEY, ordinal: 2 } })], false, null, {}))).toBe('Claude Code · 2');
    const stopped = availability([listener({ state: 'stopped' })], false, null, {});
    expect(availabilityLabel(stopped)).toBe('Claude Code');
    expect(stoppedListeningLine(availabilityLabel(stopped))).toMatch(/^Claude Code stopped listening\./);
    expect(availabilityLabel(availability([], false, null, {}))).toBe('Claude Code');
    expect(NOT_CONNECTED_LINE).toBe('Connect Claude Code with the Nebula channel to message it here.');
  });

  it('offline: the listener active most recently, else the product', () => {
    const two = [listener(), listener({ listenerId: 'ch_2', sessionKey: KEY2, session: { key: KEY2, ordinal: 2 }, since: 50 })];
    expect(availabilityLabel(availability(two, true, null, { [KEY2]: 900 }))).toBe('Claude Code · 2');
    expect(availabilityLabel(availability(two, true, null, {}))).toBe('Claude Code');
    expect(availabilityLabel(availability([], true, null, {}))).toBe('Claude Code');
  });
});

describe('r89.5: the shared cut keeps the closers of what its words open', () => {
  const FOLD = 'Claude Code is working · Changed “Prompt” on “Hero shot”';

  it('the working fold: “Changed “Prompt” on “Hero…””', () => {
    const cut = cutAtWord(FOLD, byLength(52));
    expect(cut).toBe('Claude Code is working · Changed “Prompt” on “Hero…”');
    expect(cutParts(cut, FOLD)).toEqual({ words: 'Claude Code is working · Changed “Prompt” on “Hero', ellipsis: '…”' });
    // The closer counts toward what fits.
    expect(cutAtWord(FOLD, byLength(51))).toBe('Claude Code is working · Changed “Prompt” on…');
  });

  it('mid-word only when the first word alone doesn’t fit', () => {
    expect(cutAtWord(FOLD, byLength(3))).toBe('Claude…');
    expect(cutAtWord('Supercalifragilistic', byLength(3))).toBe('Supercalifragilistic');
  });

  it('every opener left open gets its closer, innermost first; brackets too', () => {
    expect(cutAtWord('Use (the “warm one” and the cool) light', byLength(17))).toBe('Use (the “warm…”)');
    expect(cutAtWord('A «quote with more words» here', byLength(12))).toBe('A «quote…»');
  });

  it('a caller’s own quotes (the chip, "You answered"): their closer stays theirs', () => {
    // “Use “warm” or “cool tones” for…” with the chip’s “ and ” around it.
    expect(cutAtWord('Use “warm” or “cool tones” for the hero', byLength(22), '“')).toBe('Use “warm” or “cool…”');
    expect(cutAtWord('Use the same palette on the other three shots, please', byLength(30), '“')).toBe('Use the same palette on the…');
    // Joined answers close the caller’s quote early: the caller’s ” then closes the last one.
    expect(cutAtWord('Warm”, “Cool tones” and “Neutral', byLength(14), '“')).toBe('Warm”, “Cool…');
  });

  it('a whole text that fits is never touched', () => {
    expect(cutAtWord('Changed “Prompt”', byLength(80))).toBe('Changed “Prompt”');
    expect(cutParts('Changed “Prompt”', 'Changed “Prompt”')).toEqual({ words: 'Changed “Prompt”', ellipsis: '' });
  });
});

describe('review 2, NIT-1: straight quotes pair with themselves', () => {
  it('keeps "warm" whole; an open one gets its closer', () => {
    expect(cutAtWord('Use the "warm" palette for the hero shot please', byLength(16))).toBe('Use the "warm"…');
    expect(cutAtWord('Use the "warm palette" for the hero', byLength(16))).toBe('Use the "warm…"');
    expect(cutAtWord("Use the 'warm' palette for the hero", byLength(16))).toBe("Use the 'warm'…");
  });

  it('an apostrophe inside a word is not a quote', () => {
    expect(cutAtWord("Don't use it's palette, keep the hero", byLength(24))).toBe("Don't use it's palette…");
    expect(cutAtWord('Don’t use ‘warm’ light on the hero', byLength(18))).toBe('Don’t use ‘warm’…');
    expect(cutAtWord('Don’t use ‘warm light on the hero', byLength(18))).toBe('Don’t use ‘warm…’');
  });
});

describe('review 2, F10: a pin’s run ends on a reply on that pin only', () => {
  it('a pin answer on another pin leaves the run going', () => {
    const pin: ThreadRow = { id: 'pin1', kind: 'pin', at: 1_000, text: 'warmer', pinId: 'pin_1' };
    const other: ThreadRow = { id: 'pr2', kind: 'pinReply', at: 2_000, text: 'ok', pinId: 'pin_2', agent: CLAUDE_CODE };
    expect(runOrigin([pin, other], [])?.id).toBe('pin1');
    const own: ThreadRow = { ...other, id: 'pr1', pinId: 'pin_1' };
    expect(runOrigin([pin, own], [])).toBeNull();
  });
});

describe('GM r94: a quote that ends in its own mark takes no period after it', () => {
  it.each(['.', '?', '!'])('typed words ending in “%s”', (mark) => {
    const words = `From the other tab${mark}`;
    expect(answeredLine([{ choices: [], text: words }])).toBe(`You answered “${words}”`);
    expect(answeredQuote([{ choices: [], text: words }])).toEqual(
      { before: 'You answered “', words, after: '”', afterCut: '”.' });
  });

  it.each(['.', '?', '!'])('a choice ending in “%s”, and only the last quote counts', (mark) => {
    expect(answeredLine([{ choices: [`Keep it${mark}`], text: null }])).toBe(`You chose “Keep it${mark}”`);
    expect(answeredLine([{ choices: [`Warm${mark}`, 'Cool'], text: null }])).toBe(`You chose “Warm${mark}” and “Cool”.`);
    expect(answeredLine([{ choices: ['Warm', `Cool${mark}`], text: null }])).toBe(`You chose “Warm” and “Cool${mark}”`);
  });

  it('other endings keep the period', () => {
    for (const words of ['From the other tab', 'Wait…', 'Use 1:1;', 'Done.)', 'ok,']) {
      expect(answeredLine([{ choices: [], text: words }])).toBe(`You answered “${words}”.`);
    }
    expect(closingPeriod('Really?  ')).toBe('');
  });
});

