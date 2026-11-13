import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');
const rule = (css: string, selector: string) =>
  css.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

// Round 22 of PR #203: the region is `position: absolute` (not fixed, so it is no stacking
// context: the proposal bar sits under modals while notices stay above). Absolute is placed
// against its containing block, so the body, where NoticeRegion portals it, is one explicit:
// full window, positioned, never scrolled. Live check (Puppeteer, 1440x900): with a body-level
// overflow the viewport scrolled and the region went with it (y 202, main's fixed one 702).
describe('the notice region is placed against the window', () => {
  const app = readFileSync(resolve(SRC, 'App.css'), 'utf8');
  const region = readFileSync(resolve(SRC, 'styles/noticeRegion.css'), 'utf8');

  it('the body is a positioned box that cannot scroll', () => {
    const body = rule(app, 'body');
    expect(body).toMatch(/position:\s*relative/);
    expect(body).toMatch(/overflow:\s*clip/);
  });

  it('the region is absolute with no layer of its own', () => {
    const own = rule(region, '\\.notice-region');
    expect(own).toMatch(/position:\s*absolute/);
    expect(own).toMatch(/z-index:\s*auto/);
  });
});
