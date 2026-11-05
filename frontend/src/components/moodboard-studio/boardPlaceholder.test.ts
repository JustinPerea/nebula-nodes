import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_LABEL_MAX, clipGraphemes, placeholderLabel } from './boardPlaceholder';

// A placeholder's label (GM r5): the file's name in its top-left corner, cut
// by grapheme cluster so an emoji, a flag or an accented letter stays whole.

describe('a placeholder\'s label', () => {
  it('is the file\'s name', () => {
    expect(placeholderLabel({ kind: 'file', name: 'river-at-dusk.png' })).toBe('river-at-dusk.png');
  });

  it('a long name is cut to PLACEHOLDER_LABEL_MAX clusters with an ellipsis', () => {
    const name = `${'a'.repeat(40)}.png`;
    const label = placeholderLabel({ kind: 'file', name });
    expect(label).toBe(`${'a'.repeat(PLACEHOLDER_LABEL_MAX - 1)}…`);
    expect(Array.from(label)).toHaveLength(PLACEHOLDER_LABEL_MAX);
  });

  it('a name exactly at the limit is left whole', () => {
    const name = 'b'.repeat(PLACEHOLDER_LABEL_MAX);
    expect(placeholderLabel({ kind: 'file', name })).toBe(name);
  });

  it('cuts between grapheme clusters, never inside an emoji, a flag or a letter with its accent', () => {
    const family = '👨‍👩‍👧‍👦';
    const flag = '🇯🇵';
    const accent = 'é';
    // Each is one cluster but several code points: a code-point cut would split them.
    expect(clipGraphemes(`${family}${flag}${accent}xyz`, 4)).toBe(`${family}${flag}${accent}…`);
    expect(clipGraphemes(`${flag.repeat(10)}`, 3)).toBe(`${flag}${flag}…`);
    expect(clipGraphemes(`${accent.repeat(5)}`, 5)).toBe(accent.repeat(5));
  });

  it('a link\'s placeholder (a later PR) reads its host', () => {
    expect(placeholderLabel({ kind: 'link', host: 'images.example.com' })).toBe('images.example.com');
  });
});
