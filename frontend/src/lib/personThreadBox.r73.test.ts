import { describe, expect, it } from 'vitest';
import type { ThreadRow } from './personThread';
import { answerRows, cutAtWord, foldActions } from './personThreadBox';

/** GM - Design r73 on #225: the one word-boundary cut (item 3) and the
 * typed answer's You row, derived and never stored (item 2). */

const byLength = (max: number) => (candidate: string) => candidate.length <= max;
const R73 = 'Use the same palette on the other three shots, or keep the warm one only for the hero?';

describe('r73 item 3: cutAtWord', () => {
  it('the r73 example: cut at a word, the trailing comma dropped before the ellipsis', () => {
    expect(cutAtWord(R73, byLength(48))).toBe('Use the same palette on the other three shots…');
    // Every width that can't take ", or" lands on the same words.
    for (const max of [47, 48]) expect(cutAtWord(R73, byLength(max))).toBe('Use the same palette on the other three shots…');
    expect(`Answering “${cutAtWord(R73, byLength(48))}”`).toBe('Answering “Use the same palette on the other three shots…”');
  });

  it('never cuts inside a word, and never leaves a comma, space or other punctuation before the ellipsis', () => {
    for (let max = 6; max < R73.length; max += 1) {
      const cut = cutAtWord(R73, byLength(max));
      expect(cut.endsWith('…')).toBe(true);
      const words = cut.slice(0, -1);
      expect(R73.startsWith(words)).toBe(true);
      // Ends on a whole word: the next character of the source is a space or punctuation.
      expect(/[\s\p{P}]/u.test(R73[words.length])).toBe(true);
      expect(/[\s\p{P}]$/u.test(words)).toBe(false);
      expect(cut.length).toBeLessThanOrEqual(max);
    }
    expect(cutAtWord('Wide; or tall: pick one', byLength(14))).toBe('Wide; or tall…');
    expect(cutAtWord('Wide; or tall: pick one', byLength(10))).toBe('Wide; or…');
    expect(cutAtWord('One — two three', byLength(9))).toBe('One…');
    expect(cutAtWord('One — two three', byLength(10))).toBe('One — two…');
  });

  it('the whole text when it fits, on one line', () => {
    expect(cutAtWord('Keep the warm one', byLength(48))).toBe('Keep the warm one');
    expect(cutAtWord('Keep the\n warm   one', byLength(48))).toBe('Keep the warm one');
    expect(cutAtWord('', byLength(0))).toBe('');
  });

  it('when not even the first word fits: that word and its ellipsis; one long word stays whole (CSS cuts it)', () => {
    expect(cutAtWord('Supercalifragilistic and more', byLength(5))).toBe('Supercalifragilistic…');
    expect(cutAtWord('Supercalifragilistic', byLength(5))).toBe('Supercalifragilistic');
  });

  it('the joined answers of "You answered" cut the same way', () => {
    expect(cutAtWord('Warm”, “Cool” and “Neutral please', byLength(16))).toBe('Warm”, “Cool…');
  });

  it('asks about far fewer candidates than there are words (halving)', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    let calls = 0;
    const cut = cutAtWord(long, (candidate) => { calls += 1; return candidate.length <= 120; });
    expect(cut.length).toBeLessThanOrEqual(120);
    expect(calls).toBeLessThan(15);
  });
});

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };

function question(id: string, at: number): ThreadRow {
  return { id: `row-${id}`, kind: 'question', at, questionId: id, agent: CLAUDE };
}

function answered(closedAt: number, answers: { choices: string[]; text: string | null }[], status = 'answered') {
  return { view: { status, closedAt, answers } };
}

describe('r73 item 2: the typed answer is a derived You row', () => {
  it('only words with no option picked; at the set’s closedAt', () => {
    const rows = [question('q1', 1_000), question('q2', 2_000), question('q3', 3_000), question('q4', 4_000)];
    const sets = {
      q1: answered(5_000, [{ choices: [], text: '  Keep the warm one\nfor the hero ' }]),
      q2: answered(6_000, [{ choices: ['All three'], text: null }]),
      q3: answered(7_000, [{ choices: ['Wide'], text: 'and a bit taller' }]),
      q4: answered(8_000, [{ choices: [], text: null }], 'dismissed'),
    };
    expect(answerRows(rows, sets)).toEqual([
      { id: 'answer-q1', questionId: 'q1', at: 5_000, text: 'Keep the warm one\nfor the hero' },
    ]);
  });

  it('nothing for a set the tab doesn’t hold (closed long ago) or still open', () => {
    expect(answerRows([question('q1', 1_000)], {})).toEqual([]);
    expect(answerRows([question('q1', 1_000)], { q1: { view: { status: 'open', closedAt: null, answers: null } } })).toEqual([]);
  });

  it('sits among the thread rows by its time, after its question, with the actions before it folded', () => {
    const rows: ThreadRow[] = [
      question('q1', 1_000),
      { id: 'm1', kind: 'message', at: 9_000, text: 'Now the sky', state: 'accepted' },
    ];
    const answers = answerRows(rows, { q1: answered(5_000, [{ choices: [], text: 'Keep it' }]) });
    const items = foldActions(rows, [{ id: 'e1', ts: 2_000 }, { id: 'e2', ts: 6_000 }], answers);
    expect(items.map((item) => (item.kind === 'row' ? item.row.id : item.kind === 'answer' ? item.answer.id : item.id)))
      .toEqual(['row-q1', 'actions-e1', 'answer-q1', 'actions-e2', 'm1']);
    // Usually the latest thing: at the bottom.
    const last = foldActions([question('q1', 1_000)], [], answers);
    expect(last[last.length - 1]).toMatchObject({ kind: 'answer', answer: { text: 'Keep it' } });
  });
});
