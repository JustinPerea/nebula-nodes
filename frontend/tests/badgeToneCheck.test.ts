// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findAccentBadges } from '../scripts/check-badge-tone.mjs';

/**
 * scripts/check-badge-tone.mjs runs in `npm run lint`: no state badge or source tag is painted
 * in the brand accent (design: orange is the brand accent, not a status). Each fixture is one
 * rule; `accented` must be caught (one hit each), `fine` must pass.
 */
const hits = (css: string) => findAccentBadges(css, 'fixture.css');

describe('check-badge-tone', () => {
  const accented = [
    '.commons-badge--inbox { color: var(--sr-accent); }',
    'body .commons-badge--missing { border-color: var(--sr-error-border); }',
    '.commons-badge--x { color: var(--sr-danger); }',
    '.commons-badge--x { border: 1px solid var(--sr-accent-border); }',
    '.commons-source--corrected { color: #FF5A1F; }',
    '.commons-badge--x { background: rgba(255, 90, 31, 0.1); }',
    '.commons-badge--a, .commons-badge--b { color: var(--sr-error, red); }',
    '.commons-badge--role-attract { color: var(--sr-success); }',
    '.commons-badge--role-avoid { border-color: var(--sr-warning-border); }',
    '.commons-badge--x:hover { border-color: var(--sr-accent-hover); }',
  ];
  for (const css of accented) {
    it(`fails: ${css}`, () => expect(hits(css)).toHaveLength(1));
  }

  const fine = [
    '.commons-badge--analysis_failed { color: var(--sr-warning); border-color: var(--sr-warning-border); }',
    '.commons-badge--inbox { color: var(--sr-ink-light); border-color: var(--sr-edge); }',
    '.commons-source--corrected { color: var(--sr-ink-light); }',
    '.commons-badge--ready { color: var(--sr-success); }',
    '.commons-badge--x { transition: color 200ms; --x: var(--sr-accent); }',
    '.commons-button--primary { color: var(--sr-accent); }',
    '.commons-badge--role-attract { transition: color 200ms; }',
    '.commons-badge { color: var(--sr-accent); }',
    '/* .commons-badge--x { color: var(--sr-accent); } */',
  ];
  for (const css of fine) {
    it(`passes: ${css}`, () => expect(hits(css)).toHaveLength(0));
  }
});
