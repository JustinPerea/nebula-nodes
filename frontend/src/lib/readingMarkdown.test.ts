import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './readingMarkdown';

// Gemini's markdown as plain data: headings, paragraphs, lists, bold,
// italics, code and citations, and nothing that could load or leave.

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, lists and rules', () => {
    const blocks = parseMarkdown('## The look\n\nWarm and\nquiet.\n\n- one\n- two\n  more\n\n1. first\n2) second\n\n---\n');
    expect(blocks).toEqual([
      { t: 'heading', c: [{ t: 'text', v: 'The look' }] },
      { t: 'paragraph', c: [{ t: 'text', v: 'Warm and quiet.' }] },
      { t: 'list', ordered: false, items: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two more' }]] },
      { t: 'list', ordered: true, items: [[{ t: 'text', v: 'first' }], [{ t: 'text', v: 'second' }]] },
      { t: 'rule' },
    ]);
  });

  it('keeps a fenced block as code text', () => {
    expect(parseMarkdown('```\n<b>x</b>\n```')).toEqual([{ t: 'paragraph', c: [{ t: 'code', v: '<b>x</b>' }] }]);
  });

  it('drops quote marks but keeps their words', () => {
    expect(parseMarkdown('> quoted')).toEqual([{ t: 'paragraph', c: [{ t: 'text', v: 'quoted' }] }]);
  });
});

describe('parseInline', () => {
  it('reads bold, italics and code', () => {
    expect(parseInline('**bold** and *soft* and `x`')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'bold' }] }, { t: 'text', v: ' and ' },
      { t: 'em', c: [{ t: 'text', v: 'soft' }] }, { t: 'text', v: ' and ' }, { t: 'code', v: 'x' },
    ]);
  });

  it('finds citations plain, in code, with images/ and in any case', () => {
    expect(parseInline('see tile-a1.png, `images/tile-b_2.JPG` and **tile-c.webp**')).toEqual([
      { t: 'text', v: 'see ' }, { t: 'cite', file: 'tile-a1.png', raw: 'tile-a1.png' }, { t: 'text', v: ', ' },
      { t: 'cite', file: 'tile-b_2.jpg', raw: '`images/tile-b_2.JPG`' }, { t: 'text', v: ' and ' },
      { t: 'strong', c: [{ t: 'cite', file: 'tile-c.webp', raw: 'tile-c.webp' }] },
    ]);
  });

  it('keeps a link’s words only: nothing leaves Nebula', () => {
    expect(parseInline('a [site](https://evil.example/x) b <https://evil.example>')).toEqual([
      { t: 'text', v: 'a site b https://evil.example' },
    ]);
  });

  it('keeps an image’s alt text only: nothing is loaded', () => {
    expect(parseInline('![a tracker](https://evil.example/p.png)')).toEqual([{ t: 'text', v: 'a tracker' }]);
  });

  it('keeps raw HTML as the text it is', () => {
    expect(parseInline('<img src=x onerror=alert(1)><script>x</script>')).toEqual([
      { t: 'text', v: '<img src=x onerror=alert(1)><script>x</script>' },
    ]);
  });

  it('stops nesting at a depth and keeps the rest as text', () => {
    const deep = `${'**'.repeat(1)}*${'[a](b)'}*${'**'}`;
    expect(() => parseInline(deep.repeat(200))).not.toThrow();
  });
});
