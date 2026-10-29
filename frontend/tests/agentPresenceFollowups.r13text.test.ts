// PR #200 fix round 13 (review 12 M-1, L-1, L-2; GM r21): the canvas's strip
// and count read the same generated Unicode data as the backend
// (backend/data/pin_text_unicode.json; the backend's half is
// tests/test_pin_text_r13.py), and a cut never leaves half an escape code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitNote, noteLength, pinDisplayText, textLength } from '../src/lib/canvasPins';

const tags = (spec: string) => Array.from(spec).map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join('');
const FLAG = '\u{1F3F4}';
const CANCEL = '\u{E007F}';
const THUMB = '\u{1F44D}';
const ZWJ = '‍';
const bytes = (text: string) => new TextEncoder().encode(text).length;
const hidden = (typed: string) => bytes(typed) - bytes(pinDisplayText(typed, { fold: false }));

describe('the generated Unicode data', () => {
  it('is the same bytes on both sides', () => {
    const canvas = readFileSync(join(__dirname, '../src/lib/pinTextUnicode.json'));
    const backend = readFileSync(join(__dirname, '../../backend/data/pin_text_unicode.json'));
    expect(canvas.equals(backend)).toBe(true);
  });
});

describe('review 12 M-1: only the three subdivision flags keep their tags', () => {
  it.each(['gbeng', 'gbsct', 'gbwls'])('%s stays whole and counts one', (spec) => {
    const flag = FLAG + tags(spec) + CANCEL;
    expect(pinDisplayText(flag)).toBe(flag);
    expect(noteLength(flag)).toBe(1);
  });

  it.each([
    ['seven ASCII tags', FLAG + tags('ignorea') + CANCEL],
    ['a valid flag with an extra tag', FLAG + tags('gbengg') + CANCEL],
    ['a truncated flag', FLAG + tags('gben') + CANCEL],
    ['no cancel tag', FLAG + tags('gbeng')],
    ['upper case', FLAG + tags('GBENG') + CANCEL],
  ])('%s: the tags are hidden, a plain black flag shows', (_name, typed) => {
    expect(pinDisplayText(typed)).toBe(FLAG);
    expect(noteLength(typed)).toBe(1);
  });

  it('the reviewer\'s 280 flags of 7 ASCII tags are 2,240 hidden characters, far past the 1,120 (GM r22: characters, not bytes)', () => {
    const typed = (FLAG + tags('ignorea') + CANCEL).repeat(280);
    expect(Array.from(typed).length - Array.from(pinDisplayText(typed)).length).toBe(280 * 8);
  });
});

describe('review 12 L-2: a ZWJ chain is one character only as an RGI sequence', () => {
  it('11 thumbs joined are 11, and 140 such chains are far past 280', () => {
    const eleven = Array(11).fill(THUMB).join(ZWJ);
    expect(noteLength(eleven)).toBe(11);
    expect(noteLength(`${eleven} `.repeat(140))).toBeGreaterThan(280);
  });

  it.each([
    ['a family', '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', 1],
    ['a kiss', '\u{1F469}‍❤️‍\u{1F48B}‍\u{1F468}', 1],
    ['a scientist with a skin tone', '\u{1F469}\u{1F3FD}‍\u{1F52C}', 1],
    ['a handshake with two tones', '\u{1FAF1}\u{1F3FB}‍\u{1FAF2}\u{1F3FC}', 1],
    ['a rainbow flag', '\u{1F3F3}️‍\u{1F308}', 1],
    ['a family then a thumb', '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}‍\u{1F44D}', 2],
    ['two scientists joined', '\u{1F469}\u{1F3FD}‍\u{1F52C}‍\u{1F469}\u{1F3FD}‍\u{1F52C}', 2],
    ['two thumbs', '\u{1F44D}‍\u{1F44D}', 2],
  ])('%s counts %s', (_name, typed, length) => {
    expect(textLength(pinDisplayText(typed as string))).toBe(length);
  });
});

describe('GM r21: one variation selector, kept only when Unicode lists it for its base', () => {
  it.each([
    ['葛 + E0100 is kept, one visible', '葛\u{E0100}', '葛\u{E0100}', 1, 0],
    ['葛 + 20 E0100: one visible, 19 hidden', `葛${'\u{E0100}'.repeat(20)}`, '葛\u{E0100}', 1, 19 * 4],
    ['an extension-B ideograph + E0101', '\u{20000}\u{E0101}', '\u{20000}\u{E0101}', 1, 0],
    ['Latin a + E0100 is hidden', 'a\u{E0100}', 'a', 1, 4],
    ['a Mongolian letter + FVS1 is kept', 'ᠠ᠋', 'ᠠ᠋', 1, 0],
    ['a Latin letter + FVS1 is hidden', 'a᠋', 'a', 1, 3],
    ['a Mongolian letter + two FVS: one kept', 'ᠠ᠋᠌', 'ᠠ᠋', 1, 3],
    ['a listed FE00 (∩)', '∩︀', '∩︀', 1, 0],
    ['FE00 after a letter it isn\'t listed for', 'a︀', 'a', 1, 3],
    ['text and emoji hearts', '♥︎♥️', '♥︎♥️', 2, 0],
    ['a keycap', '1️⃣', '1️⃣', 1, 0],
    ['FE0F after an emoji with no text form', '\u{1F600}️', '\u{1F600}', 1, 3],
    ['a second FE0F', '❤️️', '❤️', 1, 3],
  ])('%s', (_name, typed, shown, length, hiddenBytes) => {
    expect(pinDisplayText(typed as string)).toBe(shown);
    expect(noteLength(typed as string)).toBe(length);
    expect(hidden(typed as string)).toBe(hiddenBytes);
  });
});

describe('review 12 L-1: a cut never leaves half an escape code', () => {
  it('a cut inside a colour code drops the partial code whole, so the next character can\'t complete it', () => {
    const cut = fitNote(`${'c'.repeat(278)}\x1b[31mRED\x1b[0m`);
    // 278 c, the whole red code, "RE", then "\x1b[0" would be cut: it goes.
    expect(cut).toBe(`${'c'.repeat(278)}\x1b[31mRE`);
    // A whole code that shows nothing still fits; a lone ESC at the cut goes.
    expect(fitNote(`${'c'.repeat(280)}\x1b[0m`)).toBe(`${'c'.repeat(280)}\x1b[0m`);
    expect(fitNote(`${'c'.repeat(280)}\x1b[0éé`)).toBe('c'.repeat(280));
    // Text that fits is never cut, so nothing can follow its last code.
    expect(fitNote(`${'c'.repeat(280)}\x1b`)).toBe(`${'c'.repeat(280)}\x1b`);
    // eslint-disable-next-line no-control-regex -- the escape bytes it looks for
    for (const text of [cut, fitNote(`${'c'.repeat(279)}\x1b[38;5;1mxy`)]) expect(/\x1b(?:\[[0-?]*[ -/]*)?$/.test(text)).toBe(false);
  });
});
