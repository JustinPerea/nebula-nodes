// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Design: the quoted comment's date is --sr-ink-light (5.5:1 on the comment's fill), not
// --sr-ink-meta (3.6:1). Dates elsewhere keep the meta ink.
const css = readFileSync(join(__dirname, '../src/styles/commons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const color = (selector: string) => {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector);
  return rule?.[2].match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1].trim();
};

describe('the Commons quoted comment', () => {
  it('reads its date at --sr-ink-light', () => {
    expect(color('body.app-slava-restraint .commons-comment .commons-meta')).toBe('var(--sr-ink-light)');
  });
  it('leaves every other date at --sr-ink-meta', () => {
    expect(color('body.app-slava-restraint .commons-meta')).toBe('var(--sr-ink-meta)');
  });
});
