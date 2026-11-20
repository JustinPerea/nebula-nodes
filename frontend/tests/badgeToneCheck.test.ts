// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findAccentBadges, findAccentEyebrows, findCapsBadges } from '../scripts/check-badge-tone.mjs';

/**
 * scripts/check-badge-tone.mjs runs in `npm run lint`: no state badge or source tag is painted
 * in the brand accent (design: orange is the brand accent, not a status). Each fixture is one
 * rule; `accented` must be caught (one hit each), `fine` must pass.
 */
const hits = (css: string) => findAccentBadges(css, 'fixture.css');

describe('check-badge-tone', () => {
  const accented = [
    '.commons-badge--inbox { color: var(--sr-accent); }',
    'body .commons-badge--missing { border-color: var(--sr-accent-border); }',
    '.commons-badge--x { color: var(--sr-danger); }',
    '.commons-badge--x { border: 1px solid var(--sr-accent-border); }',
    '.commons-source--corrected { color: #FF5A1F; }',
    '.commons-badge--x { background: rgba(255, 90, 31, 0.1); }',
    '.commons-badge--a, .commons-badge--b { color: var(--sr-danger, red); }',
    '.commons-badge--role-attract { color: var(--sr-success); }',
    '.commons-badge--role-avoid { border-color: var(--sr-warning-border); }',
    '.commons-badge--x:hover { border-color: var(--sr-accent-hover); }',
    '.commons-badge--x { color: #FF5A1FCC; }',
    '.commons-badge--x { box-shadow: inset 0 0 0 1px var(--sr-accent); }',
    '.commons-badge--x { text-decoration-color: var(--sr-accent); }',
    '.commons-badge--x { border-image: linear-gradient(var(--sr-accent), transparent) 1; }',
    '.commons-badge--role-attract { box-shadow: 0 0 0 1px var(--sr-success); }',
    '.commons-badge { color: var(--sr-accent); }',
    '.commons-source { border-color: var(--sr-accent-border); }',
    '.commons-badge { &--inbox { color: var(--sr-accent); } }',
    '.commons-badge { &.commons-badge--inbox { color: var(--sr-accent); } }',
  ];
  accented.push(
    '.moodboard-studio-toolbar__state--saved { color: #FF5A1F; }',
    '.character-studio-toolbar__state--saved { color: var(--sr-accent); }',
    '.character-def__ref-badge { color: var(--sr-accent); }',
    'body.app-slava-restraint .reference-set-node__role-badge { border-color: var(--sr-accent-border); }',
    '.world-preview__badge { background: var(--sr-accent-soft); }',
    '.moodboard-tile__cover { color: var(--sr-accent); }',
    'body.app-slava-restraint .moodboard-tile__cover { border-color: var(--sr-accent-border); }',
    '.moodboard-color__flag { background: rgba(255, 90, 31, 0.1); }',
    'body.app-slava-restraint .cinema-shots-rail__badge--running { background: var(--sr-accent); }',
    '.edit-node__speed-badge { color: var(--sr-accent); }',
    '.commons-badge--inbox { -webkit-text-fill-color: var(--sr-accent); }',
    'body.app-slava-restraint .edit-node__speed-badge { border-color: #FF5A1F; }',
  );
  for (const css of accented) {
    it(`fails: ${css}`, () => expect(hits(css)).toHaveLength(1));
  }

  const fine = [
    '.commons-badge--analysis_failed { color: var(--sr-warning); border-color: var(--sr-warning-border); }',
    '.commons-badge--analysis_failed { color: var(--sr-error); border-color: var(--sr-error-border); }',
    '.commons-badge--inbox { color: var(--sr-ink-light); border-color: var(--sr-edge); }',
    '.commons-source--corrected { color: var(--sr-ink-light); }',
    '.commons-badge--ready { color: var(--sr-success); }',
    '.commons-badge--x { transition: color 200ms; --x: var(--sr-accent); }',
    '.commons-button--primary { color: var(--sr-accent); }',
    '.commons-badge--role-attract { transition: color 200ms; }',
    '.commons-badge { color: var(--sr-ink-light); box-shadow: none; }',
    '.commons-badge--x { color: #FF5A1E; }',
    '.commons-badges-list { color: var(--sr-accent); }',
    '.moodboard-studio-toolbar__state--saved { color: var(--sr-ink-light); }',
    '.moodboard-studio-toolbar__state--error { color: var(--sr-error); }',
    '.character-def__ref-badge { color: var(--sr-ink-light); }',
    '.character-def__ref-badge-list { color: var(--sr-accent); }',
    '.character-def__ref-button { color: var(--sr-accent); }',
    '/* .commons-badge--x { color: var(--sr-accent); } */',
    '.moodboard-tile__cover { color: var(--sr-ink-light); background: rgba(0, 0, 0, 0.76); }',
    '.moodboard-tile__cover-button { color: var(--sr-accent); }',
    '.moodboard-color__flag { color: var(--sr-ink-light); }',
    'body.app-slava-restraint .cinema-shots-rail__badge--running { background: var(--sr-surface-control); color: var(--sr-ink-light); }',
    // The unread count keeps the accent (design).
    'body.app-slava-restraint .cinema-shots-rail__badge { background: var(--sr-accent); color: var(--sr-on-accent); }',
    '.edit-node__speed-badge { color: var(--sr-ink-light); border-color: var(--sr-edge); }',
  ];
  for (const css of fine) {
    it(`passes: ${css}`, () => expect(hits(css)).toHaveLength(0));
  }
});

/** Design: a badge or tag reads in sentence case, a state or a kind alike; a field label keeps its caps. */
describe('check-badge-tone: capitals', () => {
  const caps = (css: string) => findCapsBadges(css, 'fixture.css');
  const capitalised = [
    '.world-modal__status { text-transform: uppercase; }',
    'body.app-slava-restraint .moodboard-studio-toolbar__state { font-size: 11px; text-transform: uppercase; }',
    '.moodboard-view-switch__badge { text-transform: uppercase; }',
    '.world-preview__badge { text-transform: uppercase; }',
    '.jev-result__badge { text-transform: uppercase; }',
    '.character-def__ref-badge { text-transform: uppercase; }',
    '.reference-set-node__role-badge { text-transform: uppercase; }',
    '.commons-unsaved { letter-spacing: 1.5px; text-transform: uppercase; }',
    '.commons-badge { text-transform: uppercase; }',
    '.commons-source--corrected { text-transform: uppercase; }',
    '.run-history__tag { text-transform: uppercase; }',
    '.thing__status--ready { text-transform: uppercase; }',
    '.thing__state { font-variant: small-caps; }',
    '.thing__state { font-variant-caps: all-small-caps; }',
    '.pill-badge { text-transform: UPPERCASE; }',
    '.a, .thing__badge { text-transform: uppercase; }',
    '.permission-card__kind { text-transform: uppercase; }',
    '.permission-card__kind { text-transform: lowercase; }',
    '.permission-card__kind { text-transform: capitalize; }',
    'body.app-slava-restraint .permission-card__kind { font-size: 10px; text-transform: LOWERCASE; }',
    '.permission-card__kind { font-variant: small-caps; }',
    // text-transform is inherited: a forced case on an ancestor of the tag reaches it.
    '.permission-card { text-transform: lowercase; }',
    '.permission-card { text-transform: uppercase; }',
    '.permission-card { text-transform: capitalize; }',
    '.permission-card--pending { text-transform: lowercase; }',
    '.permission-card__head { text-transform: lowercase; }',
    '.permission-card__head > span { text-transform: lowercase; }',
    '.permission-card .permission-card__head { text-transform: capitalize; }',
  ];
  it.each(capitalised)('catches %s', (css) => {
    expect(caps(css)).toHaveLength(1);
  });

  const fine = [
    '.world-modal__status { text-transform: none; }',
    '.thing__badge { font-variant-numeric: tabular-nums; }',
    '.moodboard-studio__field-label { text-transform: uppercase; }',
    '.inspector__section-title { text-transform: uppercase; letter-spacing: 0.08em; }',
    '.thing__statement { text-transform: uppercase; }',
    '.thing__badge { text-transform: capitalize; }',
    '.permission-card__kind { text-transform: none; font-size: 10px; }',
    '.permission-card__title { text-transform: lowercase; }',
    '.permission-card .permission-card__title { text-transform: uppercase; }',
    '.permission-card { text-transform: lowercase; } .permission-card__kind { text-transform: none; }',
    '.permission-card__head { text-transform: uppercase; } .permission-card__kind { text-transform: none !important; }',
    '.permission-card { color: red; }',
  ];
  it.each(fine)('passes %s', (css) => {
    expect(caps(css)).toHaveLength(0);
  });

  const nested = [
    '.x__badge { &--y { text-transform: uppercase; } }',
    '.card { .x__badge { text-transform: uppercase; } }',
    '.card { .inner { .x__badge { text-transform: uppercase; } } }',
    '.permission-card__head { .permission-card__kind { text-transform: lowercase; } }',
    '.permission-card__head { .permission-card__kind { text-transform: capitalize; } }',
    '.permission-card__head { .permission-card__kind { text-transform: uppercase; } }',
    '.permission-card { text-transform: lowercase; .permission-card__note { color: red; } }',
    '.card { .permission-card__head { text-transform: lowercase; } }',
  ];
  it.each(nested)('fails nested CSS: %s', (css) => {
    const found = caps(css);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toMatch(/nested CSS isn't read/);
  });

  it('lets nested CSS that touches no badge capitals pass', () => {
    expect(caps('.card { .x__label { text-transform: uppercase; } }')).toHaveLength(0);
    expect(caps('.card { .x__badge { color: red; } }')).toHaveLength(0);
  });

  it('reports the line and the selector', () => {
    const [hit] = caps('.a { color: red; }\n\n.x__badge {\n  color: red;\n  text-transform: uppercase;\n}\n');
    expect(hit).toMatchObject({ file: 'fixture.css', line: 5, selector: '.x__badge' });
  });
});

describe('check-badge-tone: eyebrows', () => {
  const eyebrows = (css: string) => findAccentEyebrows(css, 'fixture.css');
  const failing = [
    '.world-modal__eyebrow { color: var(--sr-accent); }',
    'body.app-slava-restraint .world-modal__eyebrow { color: var(--sr-accent); font-size: 11px; }',
    '.panel__eyebrow:hover { color: var(--sr-accent-hover); }',
    '.page-kicker { color: #FF5A1F; }',
    '.x__overline { border-bottom: 1px solid rgba(255, 90, 31, 0.4); }',
    '.x__eyebrow { -webkit-text-fill-color: var(--sr-accent); }',
    '.a { .a__eyebrow { color: var(--sr-accent); } }',
    '.a { .b { .a__kicker { color: #FF5A1F; } } }',
    '.a { &__eyebrow { color: var(--sr-accent); } }',
    '.page { &-kicker { color: #FF5A1F; } }',
    '.a__eyebrow { &:hover { color: var(--sr-ink-light); } }',
  ];
  for (const css of failing) it(`fails: ${css}`, () => expect(eyebrows(css)).toHaveLength(1));
  const passing = [
    'body.app-slava-restraint .world-modal__eyebrow { color: var(--sr-ink-light); }',
    '.world-modal__eyebrow { font-weight: 700; text-transform: uppercase; }',
    '.eyebrowish { color: var(--sr-accent); }',
    '.world-modal__title { color: var(--sr-accent); }',
    '.a { .a__eyebrow { color: var(--sr-ink-light); } }',
    '.a { .a__title { color: var(--sr-accent); } }',
    '.a { &__title { color: var(--sr-accent); } }',
    '.a { &__eyebrow { color: var(--sr-ink-light); } }',
  ];
  for (const css of passing) it(`passes: ${css}`, () => expect(eyebrows(css)).toHaveLength(0));
});
