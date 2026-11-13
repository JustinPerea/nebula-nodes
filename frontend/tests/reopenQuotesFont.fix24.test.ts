// @vitest-environment node
/**
 * PR #199 round 25, GM r24 (d): in the World Labs banner "You can reopen
 * “Delta” … press “I’ve checked Marble”." showed closing quotes on both
 * sides. The codepoints were right (U+201C opens, U+201D closes, in every line
 * of the table); the face was not the cause alone: Inter draws both as
 * slanted ticks, the system face draws them apart. So the codepoints are
 * pinned here, and every surface that says a held-reopen line draws it in the
 * one notice face (:root --notice-font, the system face the notices use).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reopenHoldLine } from '../src/lib/reopenHoldLines';
import type { ReopenHold } from '../src/lib/reopenHold';

const OPEN = '“';
const CLOSE = '”';
const holds: ReopenHold[] = [
  { state: 'tabRun' }, { state: 'uncertain' },
  { state: 'active', projectId: 'alpha', projectName: 'Alpha', nodeName: 'World', count: 1, fields: [] } as never,
  { state: 'ambiguity', projectId: 'alpha', projectName: 'Alpha', nodeName: 'World', count: 1, fields: [] } as never,
  { state: 'ambiguity', projectId: 'beta', projectName: 'Beta', nodeName: 'World', count: 1, fields: [] } as never,
  { state: 'recovery', projectId: 'beta', projectName: 'Beta', nodeName: 'World', count: 1, fields: [] } as never,
  { state: 'recovery', projectId: 'beta', projectName: 'Beta', nodeName: null, count: 3, fields: [] } as never,
  { state: 'params', projectId: 'alpha', projectName: 'Alpha', nodeName: 'World', count: 1, fields: ['Resume Operation ID', 'Existing World ID'] } as never,
  { state: 'bootstrap', count: 0, fields: [] } as never,
];

describe('GM r24 (d): the held-reopen lines’ quotes', () => {
  it('the uncertain line, verbatim, by codepoint: U+201C opens each quote and U+201D closes it', () => {
    const line = reopenHoldLine('Delta', 'delta', { state: 'uncertain' }, false);
    expect(line).toBe(`You can reopen ${OPEN}Delta${CLOSE} after you check its World Labs run in Marble and press ${OPEN}I’ve checked Marble${CLOSE}.`);
    expect([...line].filter((c) => c === OPEN || c === CLOSE).map((c) => c.codePointAt(0)!.toString(16))).toEqual(['201c', '201d', '201c', '201d']);
  });

  it('in every line of the table, quotes alternate open then close, an opening one never ends a word and a closing one never starts one', () => {
    for (const hold of holds) {
      for (const desktop of [false, true]) {
        const line = reopenHoldLine('Delta', 'delta', hold, desktop);
        const marks = [...line].filter((c) => c === OPEN || c === CLOSE);
        expect(marks.length % 2, line).toBe(0);
        marks.forEach((mark, index) => expect(mark, line).toBe(index % 2 === 0 ? OPEN : CLOSE));
        expect(line, 'an opening quote before a space').not.toMatch(new RegExp(`${OPEN}(\\s|$)`));
        expect(line, 'a closing quote after a space').not.toMatch(new RegExp(`(^|\\s)${CLOSE}`));
        expect(line, 'a straight quote').not.toContain('"');
      }
    }
  });
});

const css = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8');
/** The declarations of the first rule whose selector (before the `{`) ends with `selector`. */
function rule(text: string, selector: string): string {
  const pattern = new RegExp(`(?:^|\\n)([^{}]*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*\\{([^}]*)\\}`);
  const match = text.match(pattern);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[2];
}

describe('GM r24 (d): every surface that says a held-reopen line draws it in the notice face', () => {
  it('the face is one :root token, the system face', () => {
    expect(rule(css('App.css'), ':root')).toMatch(/--notice-font:\s*-apple-system,/);
  });
  it.each([
    ['App.css', '.provider-recovery-status'],
    ['App.css', '.reopen-hold-callout'],
    ['styles/run-history.css', '.run-history__safeguards p.run-history__reopen-line'],
    ['styles/project-home.css', 'body.app-slava-restraint .project-home__card-lock'],
  ])('%s %s uses it', (file, selector) => {
    expect(rule(css(file), selector)).toMatch(/font-family:\s*var\(--notice-font\)/);
  });
});
