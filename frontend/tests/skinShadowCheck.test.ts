// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSkinShadows, readLegacyBodyClasses } from '../scripts/check-skin-shadows.mjs';

/**
 * scripts/check-skin-shadows.mjs runs in `npm run lint` (design: the app has one appearance, so a
 * rule that needs a legacy body class, or a declaration an equal `body.app-slava-restraint` rule
 * always overrides, never applies). Each bad fixture must report; each fine one must not.
 */
const LEGACY = ['app-hermes', 'tone-verdant'];
const P = 'body.app-slava-restraint';
const hits = (css: string) => findSkinShadows([{ file: 'fixture.css', source: css }], LEGACY);

describe('check-skin-shadows: dead selectors (a)', () => {
  it('fails a rule that requires body:not(.app-slava-restraint)', () => {
    const found = hits('body:not(.app-slava-restraint) .a { color: red; }');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'a', line: 1 });
  });

  it('fails a rule that requires a legacy body class', () => {
    expect(hits('body.app-hermes .a { color: red; }')).toHaveLength(1);
    expect(hits('.tone-verdant .a { color: red; }')).toHaveLength(1);
  });

  it('passes a :not() of a legacy class (always true) and the live prefix', () => {
    expect(hits('body:not(.app-hermes) .a { color: red; }')).toEqual([]);
    expect(hits(`${P} .a { color: red; }`)).toEqual([]);
  });

  it('reports each part of a comma list on its own', () => {
    const found = hits('.live, body.app-hermes .dead { color: red; }');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'a', partial: true, selector: 'body.app-hermes .dead' });
    expect(hits('body.app-hermes .a, .tone-verdant .b { color: red; }')).toHaveLength(1);
  });

  it('fails a dead rule inside an @media block', () => {
    expect(hits('@media (min-width: 1px) {\n  body.app-hermes .a { color: red; }\n}')).toHaveLength(1);
  });
});

describe('check-skin-shadows: overridden declarations (b)', () => {
  it('fails an unprefixed declaration a prefixed rule always overrides, naming both rules', () => {
    const found = hits(`.a { color: red; }\n${P} .a { color: blue; }`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'b', line: 1, prop: 'color', shadow: { line: 2 } });
  });

  it('passes when the prefixed rule sets a different property', () => {
    expect(hits(`.a { color: red; }\n${P} .a { background: blue; }`)).toEqual([]);
  });

  it('passes an !important declaration', () => {
    expect(hits(`.a { color: red !important; }\n${P} .a { color: blue; }`)).toEqual([]);
  });

  it('passes when the prefixed selector text differs', () => {
    expect(hits(`.a { color: red; }\n${P} .a:hover { color: blue; }\n${P} .b .a { color: blue; }`)).toEqual([]);
  });

  it('passes a prefixed rule inside @media over a top-level base (the base still applies outside the media)', () => {
    expect(hits(`.a { color: red; }\n@media (min-width: 1px) {\n  ${P} .a { color: blue; }\n}`)).toEqual([]);
  });

  it('fails when the prefixed rule is at the top level over a base inside @media', () => {
    expect(hits(`@media (min-width: 1px) {\n  .a { color: red; }\n}\n${P} .a { color: blue; }`)).toHaveLength(1);
  });

  it('fails when both rules sit in the same @media block, and passes in different blocks', () => {
    expect(hits(`@media (min-width: 1px) {\n  .a { color: red; }\n  ${P} .a { color: blue; }\n}`)).toHaveLength(1);
    expect(hits(`@media (min-width: 1px) {\n  .a { color: red; }\n}\n@media (max-width: 9px) {\n  ${P} .a { color: blue; }\n}`)).toEqual([]);
  });

  it('checks each part of a comma list on its own', () => {
    const found = hits(`.a, .b { color: red; }\n${P} .a { color: blue; }`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: '.a' });
  });

  it('does not count a prefixed part of the same rule as an override', () => {
    expect(hits(`.a, ${P} .a { color: red; }`)).toEqual([]);
  });

  it('lets a prefixed shorthand cover the longhand, not the other way round', () => {
    expect(hits(`.a { background-color: red; }\n${P} .a { background: blue; }`)).toHaveLength(1);
    expect(hits(`.a { border-color: red; }\n${P} .a { border: 1px solid blue; }`)).toHaveLength(1);
    expect(hits(`.a { background: red; }\n${P} .a { background-color: blue; }`)).toEqual([]);
    expect(hits(`.a { border: 1px solid red; }\n${P} .a { border-color: blue; }`)).toEqual([]);
  });

  it('covers custom properties like any other property', () => {
    expect(hits(`.a { --x: 1; }\n${P} .a { --x: 2; }`)).toHaveLength(1);
  });
});

describe('check-skin-shadows: exemption', () => {
  it('skips a rule exempted on its selector line or the line above', () => {
    expect(hits(`/* skin-shadow-exempt: standalone page */\n.a { color: red; }\n${P} .a { color: blue; }`)).toEqual([]);
    expect(hits(`.a { /* skin-shadow-exempt: kept */ color: red; }\n${P} .a { color: blue; }`)).toEqual([]);
    expect(hits('/* skin-shadow-exempt: kept */\nbody.app-hermes .a { color: red; }')).toEqual([]);
  });

  it('does not skip a rule the comment is not next to', () => {
    expect(hits(`/* skin-shadow-exempt: other */\n\n.b { color: red; }\n.a { color: red; }\n${P} .a { color: blue; }`)).toHaveLength(1);
  });
});

describe('check-skin-shadows: legacy class list', () => {
  it('reads LEGACY_BODY_CLASSES from skins.ts', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'skins.ts'), 'utf8');
    const classes = readLegacyBodyClasses(source);
    expect(classes).toContain('app-hermes');
    expect(classes.length).toBeGreaterThanOrEqual(6);
  });
});
