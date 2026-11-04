import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Recently deleted's Delete forever confirm takes a full row under the name
// (ProjectHome.tsx TrashRow): the name and the date line keep their one line
// however long the confirm's line is.
const css = readFileSync(resolve(__dirname, '../src/styles/project-home.css'), 'utf8');
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

describe('the armed Delete forever confirm', () => {
  it('the name stays on one line with an ellipsis, and the date line never wraps', () => {
    for (const selector of ['body.app-slava-restraint .project-home__trash-name', 'body.app-slava-restraint .project-home__trash-meta']) {
      const body = rule(selector);
      expect(body).toContain('white-space: nowrap');
      expect(body).toContain('text-overflow: ellipsis');
      expect(body).toContain('min-width: 0');
    }
  });

  it('is a full-width row of its own, growing on the layout spring, with no room taken when closed', () => {
    const body = rule('body.app-slava-restraint .project-home__trash-confirm');
    expect(body).toContain('grid-column: 1 / -1');
    expect(body).toContain('grid-row: 3');
    expect(body).toMatch(/transition: height var\(--project-home-layout-spring\)/);
    expect(body).toContain('360ms linear(0, 0.079');
    expect(rule("body.app-slava-restraint .project-home__trash-confirm[data-open='false']")).toContain('height: 0');
    expect(css).toMatch(/@starting-style \{ body\.app-slava-restraint \.project-home__trash-confirm \{ height: 0; \} \}/);
    // No row gap, so a closed (height 0) row adds nothing.
    expect(rule('body.app-slava-restraint .project-home__trash-row')).toContain('gap: 0 16px');
  });

  it('buttons go right-aligned after the text, or to their own line when it needs the width', () => {
    expect(rule('body.app-slava-restraint .project-home__confirm.project-home__trash-confirm-body')).toContain('flex-wrap: wrap');
    expect(rule('body.app-slava-restraint .project-home__trash-confirm-text')).toContain('flex: 1 1 auto');
    expect(rule('body.app-slava-restraint .project-home__trash-confirm-buttons')).toContain('margin-left: auto');
  });

  it('jumps under reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.project-home__trash-confirm \{ transition: none; \}/);
  });
});
