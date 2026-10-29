// PR #200 fix round 21, GM r31 nit: in a script that puts spaces between
// words, a heading cut that lands inside a word steps back to that word's
// start when it is within about 8 graphemes, so the name reads "A lighthouse
// prompt…”", never "A lighthouse prompt wit…”", with no space before "…".
// Further back than that, a name of one word, CJK and emoji keep the grapheme
// cut. Word boundaries come from Intl.Segmenter('word').
import { describe, expect, it } from 'vitest';
import { fitNoteHeading, graphemesOf, noteHeading, WORD_STEP_BACK } from '../src/lib/noteHeading';

const WIDE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const graphemeWidth = (g: string) => (EMOJI.test(g) ? 20 : WIDE.test(g) ? 16 : 8);
const TEST_SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const textWidth = (text: string) => Array.from(TEST_SEG.segment(text)).reduce((sum, { segment }) => sum + graphemeWidth(segment), 0);
const fits = (title: string, available: number) => fitNoteHeading(title, available, textWidth);
/** The width that holds the heading cut after `keep` graphemes by grapheme. */
const roomFor = (title: string, keep: number) => textWidth(noteHeading(title, keep));

describe('GM r31 nit: the heading cut steps back to a near word boundary', () => {
  it('a Latin cut inside a word, its start within 8 graphemes: "A lighthouse prompt…”", no space before "…"', () => {
    const title = 'A lighthouse prompt with warm light on the rocks at dusk';
    // Room for "A lighthouse prompt wit": the cut lands 3 graphemes into "with".
    const available = roomFor(title, 'A lighthouse prompt wit'.length);
    expect(fits(title, available)).toBe('Note for agents on “A lighthouse prompt…”');
    expect(fits(title, available)).not.toMatch(/\s…/u);
    // Into "lighthouse" by 8 graphemes ("lighthou"): still within reach.
    expect(fits(title, roomFor(title, 'A lighthou'.length + 0))).toBe('Note for agents on “A…”');
    expect(WORD_STEP_BACK).toBe(8);
  });

  it('a boundary further back than 8 graphemes: the grapheme cut as before', () => {
    const title = 'Lights extraordinarilyluminous over the bay';
    // 12 graphemes into the long word.
    const available = roomFor(title, 'Lights extraordinaril'.length);
    expect(fits(title, available)).toBe('Note for agents on “Lights extraordinaril…”');
    // Exactly 9 back: still a grapheme cut; 8 back: steps back.
    expect(fits(title, roomFor(title, 'Lights extraordi'.length))).toBe('Note for agents on “Lights extraordi…”');
    expect(fits(title, roomFor(title, 'Lights extraord'.length))).toBe('Note for agents on “Lights…”');
  });

  it('a single long word has no boundary to step back to: the grapheme cut', () => {
    const title = 'Supercalifragilisticexpialidociouslighthouse';
    const available = roomFor(title, 12);
    expect(fits(title, available)).toBe('Note for agents on “Supercalifra…”');
    // And a cut a few graphemes into a second word steps back to it.
    expect(fits('Lighthouse dusk', roomFor('Lighthouse dusk', 'Lighthouse du'.length))).toBe('Note for agents on “Lighthouse…”');
  });

  it('unspaced CJK and emoji stay grapheme cuts; a mixed name steps back only inside its spaced words', () => {
    // (Korean, which spaces its words, steps back like Latin since GM r32: r32's tests.)
    // Review 18 NIT-2 (fix round 22): literal expectations.
    for (const [title, expected] of [["灯台のプロンプト、夕暮れの岩に暖かい光が差し込む長い説明文です", { 200: 'Note for agents on “灯…”', 260: 'Note for agents on “灯台のプロ…”', 330: 'Note for agents on “灯台のプロンプト、夕…”', 420: 'Note for agents on “灯台のプロンプト、夕暮れの岩に…”' }],
      ["👨‍👩‍👧‍👦👍🏽🇯🇵🏴󠁧󠁢󠁳󠁣󠁴󠁿🧑🏾‍🚀🌅🌊🗼🏮🎐🎑🌙⭐️🌌🛶", { 200: 'Note for agents on “👨‍👩‍👧‍👦…”', 260: 'Note for agents on “👨‍👩‍👧‍👦👍🏽🇯🇵🏴󠁧󠁢󠁳󠁣󠁴󠁿…”', 330: 'Note for agents on “👨‍👩‍👧‍👦👍🏽🇯🇵🏴󠁧󠁢󠁳󠁣󠁴󠁿🧑🏾‍🚀🌅🌊…”', 420: 'Note for agents on “👨‍👩‍👧‍👦👍🏽🇯🇵🏴󠁧󠁢󠁳󠁣󠁴󠁿🧑🏾‍🚀🌅🌊🗼🏮🎐🎑🌙…”' }]] as Array<[string, Record<number, string>]>) {
      for (const [available, heading] of Object.entries(expected)) expect(fits(title, Number(available)), title).toBe(heading);
    }
    const mixed = '灯台 lighthouse prompt with 🇯🇵 flags and warm light';
    // Inside "with": back to "prompt".
    expect(fits(mixed, roomFor(mixed, graphemesOf('灯台 lighthouse prompt wi').length))).toBe('Note for agents on “灯台 lighthouse prompt…”');
    // Inside "and", after the flag: back to the flag.
    expect(fits(mixed, roomFor(mixed, graphemesOf('灯台 lighthouse prompt with 🇯🇵 flags an').length))).toBe('Note for agents on “灯台 lighthouse prompt with 🇯🇵 flags…”');
    // Inside the CJK word: a grapheme cut.
    expect(fits(mixed, roomFor(mixed, 1))).toBe('Note for agents on “灯…”');
  });
});
