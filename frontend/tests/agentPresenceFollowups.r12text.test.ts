// PR #200 fix round 12 (review 11 MEDIUM-1 and NIT-3, GM r19 answer 1): the
// dialog's strip and count give exactly what the backend's do, case for case,
// over the shared corpus (backend/tests/fixtures/pin_text_cases.json: the
// named cases GM asked for and a seeded fuzz; the backend's half is
// test_pin_text_as_typed.py).
import { describe, expect, it } from 'vitest';
import corpus from '../../backend/tests/fixtures/pin_text_cases.json';
import { MAX_PIN_TEXT, noteLength, pinDisplayText, textLength } from '../src/lib/canvasPins';

type Case = { name: string; typed: string; note: string; noteLength: number; reply: string; replyLength: number };
const cases = (corpus as { cases: Case[] }).cases;

describe('the shared pin-text corpus', () => {
  it('has the cases GM asked for and the fuzz', () => {
    const names = cases.map((c) => c.name);
    for (const name of ['family emoji', 'England flag', 'text and emoji hearts', '32 selectors on a letter', 'only whitespace']) expect(names).toContain(name);
    expect(cases.length).toBeGreaterThan(400);
  });

  it('every case shows and counts as the backend does, as a note and as a reply', () => {
    const off = cases.filter((c) => pinDisplayText(c.typed, { fold: false }) !== c.note || textLength(c.note) !== c.noteLength
      || pinDisplayText(c.typed, { multiline: false }) !== c.reply || textLength(c.reply) !== c.replyLength)
      .map((c) => ({ name: c.name, typed: c.typed, note: pinDisplayText(c.typed, { fold: false }), want: c.note, reply: pinDisplayText(c.typed, { multiline: false }), wantReply: c.reply }));
    expect(off).toEqual([]);
  });

  it('the real emoji stay whole and count one', () => {
    const one = (name: string) => cases.find((c) => c.name === name)!;
    for (const name of ['family emoji', 'England flag', 'a scientist with a skin tone', 'a keycap']) {
      expect(one(name).note, name).toBe(one(name).typed);
      expect(one(name).noteLength, name).toBe(1);
    }
    expect(one('text and emoji hearts').note).toBe('♥︎♥️');
    expect(one('text and emoji hearts').noteLength).toBe(2);
    expect(one('only whitespace').note).toBe('');
  });

  it('the 36 KB note: 280 letters each with 32 selectors shows the letters alone', () => {
    const typed = Array.from({ length: MAX_PIN_TEXT }, (_, i) => String.fromCharCode(97 + (i % 26))
      + Array.from({ length: 32 }, (_, j) => String.fromCodePoint(0xe0100 + ((i * 32 + j) % 240))).join('')).join('');
    expect(new TextEncoder().encode(typed).length).toBeGreaterThan(36_000);
    expect(pinDisplayText(typed)).toBe(Array.from({ length: MAX_PIN_TEXT }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''));
    expect(noteLength(typed)).toBe(MAX_PIN_TEXT);
  });

  it('a seeded fuzz: no output keeps a selector that isn\'t right after a character that takes it, a stray joiner, or a stray tag', () => {
    let seed = 20261028;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const pool = ['a', ' ', '\n', '́', '︎', '️', '︀', '͏', '‍', '\u{1F468}', '\u{1F3FD}', '\u{1F3F4}',
      '\u{E0067}', '\u{E007F}', '\u{E0100}', '♥', '1', '葛', '\x1b[1m'];
    for (let n = 0; n < 2000; n += 1) {
      const typed = Array.from({ length: 1 + Math.floor(rand() * 20) }, () => pool[Math.floor(rand() * pool.length)]).join('');
      const points = Array.from(pinDisplayText(typed, { fold: false }));
      points.forEach((char, i) => {
        const code = char.codePointAt(0)!;
        if ((code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef) || code === 0x34f) {
          expect([0xfe0e, 0xfe0f], JSON.stringify(typed)).toContain(code);
          expect(points[i - 1], JSON.stringify(typed)).toBeDefined();
          expect([0xfe0e, 0xfe0f, 0x200d]).not.toContain(points[i - 1].codePointAt(0));
        }
        if (char === '‍') expect(i > 0 && i < points.length - 1, JSON.stringify(typed)).toBe(true);
        if (code >= 0xe0020 && code <= 0xe007f) expect(points.slice(0, i).reverse().find((p) => (p.codePointAt(0)! < 0xe0020)), JSON.stringify(typed)).toBe('\u{1F3F4}');
      });
    }
  });
});
