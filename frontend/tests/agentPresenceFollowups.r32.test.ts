// PR #200 fix round 22, GM r32 (verbatim): "any name with spaces between
// words steps back to the last space within 8 graphemes; scripts without
// spaces (Chinese, Japanese, Thai) cut by grapheme. Key it on whether there's
// a space before the cut (within 8 graphemes), NOT on the script, so mixed
// names work." Within 8: the cut drops at most 8 graphemes of the word.
import { describe, expect, it } from 'vitest';
import { fitNoteHeading, graphemesOf, noteHeading, wordCut } from '../src/lib/noteHeading';

const WIDE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const graphemeWidth = (g: string) => (EMOJI.test(g) ? 20 : WIDE.test(g) ? 16 : 8);
const TEST_SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const textWidth = (text: string) => Array.from(TEST_SEG.segment(text)).reduce((sum, { segment }) => sum + graphemeWidth(segment), 0);
const fits = (title: string, available: number) => fitNoteHeading(title, available, textWidth);
/** The width that holds `title` cut by grapheme after the graphemes of `start`. */
const cutAfter = (title: string, start: string) => fits(title, textWidth(noteHeading(title, graphemesOf(start).length)));
const heading = (kept: string) => `Note for agents on “${kept}…”`;

describe('GM r32: the cut steps back to a space within 8 graphemes, whatever the script', () => {
  it('Korean steps back like Latin', () => {
    const title = '등대 프롬프트 저녁 바위 위의 따뜻한 빛';
    expect(cutAfter(title, '등대 프롬프트 저녁 바')).toBe(heading('등대 프롬프트 저녁'));
    expect(cutAfter(title, '등대 프롬')).toBe(heading('등대'));
  });

  it('Japanese and Chinese with no spaces cut by grapheme; a full-width space before the cut steps back', () => {
    expect(cutAfter('灯台のプロンプト夕暮れの岩に暖かい光', '灯台のプロンプト夕暮')).toBe(heading('灯台のプロンプト夕暮'));
    expect(cutAfter('灯塔提示黄昏时分温暖的光照在岩石上', '灯塔提示黄昏')).toBe(heading('灯塔提示黄昏'));
    expect(cutAfter('灯台のプロンプト　夕暮れの岩', '灯台のプロンプト　夕暮')).toBe(heading('灯台のプロンプト'));
  });

  it('Thai: no space, a grapheme cut; a space between phrases within 8, a step back', () => {
    expect(cutAfter('ประภาคารยามเย็นบนโขดหินริมทะเล', 'ประภาคารยาม')).toBe(heading('ประภาคารยาม'));
    const phrased = 'ประภาคาร ยามเย็นบนโขดหิน';
    expect(cutAfter(phrased, 'ประภาคาร ยามเ')).toBe(heading('ประภาคาร'));
  });

  it('a mixed name: a space within 8 before a cut in its CJK run steps back too', () => {
    const mixed = 'Lighthouse 灯台 夕暮れの岩 warm light';
    expect(cutAfter(mixed, 'Lighthouse 灯台 夕暮れ')).toBe(heading('Lighthouse 灯台'));
    expect(cutAfter(mixed, 'Lighthouse 灯台 夕暮れの岩 wa')).toBe(heading('Lighthouse 灯台 夕暮れの岩'));
  });

  it('a space exactly 8 graphemes back steps back; 9 back cuts by grapheme', () => {
    const title = '등대 가나다라마바사아자차카 빛';
    // 8 graphemes of the word dropped: back to the space.
    expect(cutAfter(title, '등대 가나다라마바사아')).toBe(heading('등대'));
    // 9: the grapheme cut.
    expect(cutAfter(title, '등대 가나다라마바사아자')).toBe(heading('등대 가나다라마바사아자'));
    const g = graphemesOf('ab cdefghijklm');
    expect(wordCut(3 + 8, g)).toBe(2);
    expect(wordCut(3 + 9, g)).toBe(12);
  });
});
