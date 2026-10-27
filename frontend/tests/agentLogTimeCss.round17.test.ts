import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Round 17 (GM): an Agent log time never wraps ("03:46:22 / PM" read as two
// lines at 1280 and 1440). jsdom has no layout, so these pin the rules; the
// live check looks at both widths.
const read = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');

function rule(css: string, selector: string): string {
  // The rule that starts a line (not a longer selector ending in this one).
  const at = css.indexOf(`\n${selector} {`);
  const start = at < 0 ? -1 : at + 1;
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('the Agent log time stays on one line', () => {
  it('in the app theme: the time keeps to one line in a column as wide as it is', () => {
    const css = read('slava-restraint.css');
    expect(rule(css, 'body.app-slava-restraint .agent-log__time')).toMatch(/white-space:\s*nowrap/);
    const columns = /grid-template-columns:\s*([^;]+);/.exec(rule(css, 'body.app-slava-restraint .agent-log__entry'))?.[1] ?? '';
    // marker, time, source, message: the time's column fits its text.
    expect(columns.trim().split(/\s+/)[1]).toBe('max-content');
  });

  it('in the plain theme', () => {
    expect(rule(read('layouts.css'), '.agent-log__time')).toMatch(/white-space:\s*nowrap/);
  });
});
