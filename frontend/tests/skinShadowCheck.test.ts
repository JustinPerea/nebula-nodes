// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSkinShadows, findUnreadBodyClassWrites, readBodyClasses, readLegacyBodyClasses } from '../scripts/check-skin-shadows.mjs';

/**
 * scripts/check-skin-shadows.mjs runs in `npm run lint` (design: the app has one appearance, so a
 * rule that needs a legacy body class, or a declaration an equal `body.app-slava-restraint` rule
 * always overrides, never applies). Each bad fixture must report; each fine one must not.
 */
const LEGACY = ['app-hermes', 'tone-verdant'];
const P = 'body.app-slava-restraint';
const BODY_CLASSES = ['agent-log-open', 'lightbox-open'];
const hits = (css: string) => findSkinShadows([{ file: 'fixture.css', source: css }], LEGACY, BODY_CLASSES);

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

  it('anchors the :not() form to body in the leftmost compound', () => {
    expect(hits('.x:not(.app-slava-restraint) .a { color: red; }')).toEqual([]);
    expect(hits(':is(body:not(.app-slava-restraint), .y) .z { color: red; }')).toEqual([]);
    expect(hits('.wrap body:not(.app-slava-restraint) .a { color: red; }')).toEqual([]);
    expect(hits('body:not(.app-slava-restraint):not(.other) .a { color: red; }')).toHaveLength(1);
  });

  it('reads a legacy class only as a plain class in the leftmost compound', () => {
    expect(hits(':is(.app-hermes, .y) .a { color: red; }')).toEqual([]);
    expect(hits(':where(.tone-verdant, .y) .a { color: red; }')).toEqual([]);
    expect(hits('.wrap .tone-verdant { color: red; }')).toEqual([]);
    expect(hits('.a[data-x=".tone-verdant"] { color: red; }')).toEqual([]);
    expect(hits('.tone-verdant.y .a { color: red; }')).toHaveLength(1);
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

  it('reports an at-rule override under a top-level prefixed twin as its own case', () => {
    const found = hits(`${P} .a { color: blue; }\n@media (max-width: 9px) {\n  .a { color: red; }\n}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'c', line: 3, prop: 'color', shadow: { line: 1 } });
    expect(found[0].atRule).toContain('@media (max-width: 9px)');
  });

  it('passes the moved override: a prefixed rule inside the same at-rule', () => {
    expect(hits(`${P} .a { color: blue; }\n@media (max-width: 9px) {\n  ${P} .a { color: red; }\n}`)).toEqual([]);
  });

  it('keeps an override whose twin sits in the same at-rule as a plain case, not the move case', () => {
    const found = hits(`@media (max-width: 9px) {\n  .a { color: red; }\n  ${P} .a { color: blue; }\n}`);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('b');
  });

  it('skips a selector whose leftmost compound can be html or body', () => {
    const twin = (selector: string) => `${selector} { color: red; }\n${P} ${selector} { color: blue; }`;
    for (const selector of ['html', ':root', 'body', '*', '::-webkit-scrollbar', '[data-x] .a', 'html .a', ':root .a', '*::before', 'body .a', '.agent-log-open .a', '.lightbox-open']) {
      expect(hits(twin(selector))).toEqual([]);
    }
    expect(hits(twin('.a .agent-log-open'))).toHaveLength(1);
    expect(hits(twin('.a'))).toHaveLength(1);
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

describe('check-skin-shadows: empty exemption', () => {
  it('fails an exemption with no reason and does not honour it', () => {
    const found = hits(`/* skin-shadow-exempt: */\n.a { color: red; }\n${P} .a { color: blue; }`);
    expect(found.map((hit) => hit.kind).sort()).toEqual(['b', 'x']);
    expect(hits('/* skin-shadow-exempt:   */\n.a { color: red; }')).toHaveLength(1);
    expect(hits('/* skin-shadow-exempt: */\nbody.app-hermes .a { color: red; }').map((hit) => hit.kind).sort()).toEqual(['a', 'x']);
  });
});

describe('check-skin-shadows: body classes', () => {
  it('reads the classes components add to body or html', () => {
    const names = readBodyClasses([
      "document.body.classList.toggle('agent-log-open', visible && open);",
      "document.documentElement.classList.add('x-one', \"x-two\");",
      "document.body.classList.contains('not-this');",
      "el.classList.add('not-body');",
    ]);
    expect(names.sort()).toEqual(['agent-log-open', 'x-one', 'x-two']);
  });

  it('reads remove, replace and a string of several names', () => {
    const names = readBodyClasses([
      "document.body.classList.remove('gone');",
      "document.documentElement.classList.replace('old-one', 'new-one');",
      "document.body.classList.add('a-one b-two');",
    ]);
    expect(names.sort()).toEqual(['a-one', 'b-two', 'gone', 'new-one', 'old-one']);
  });

  it('fails on body or html class writes it cannot read', () => {
    const at = (source: string) => findUnreadBodyClassWrites([{ file: 'x.ts', source }]);
    expect(at("document.body.className = 'x';")).toHaveLength(1);
    expect(at("document.documentElement.className += ' x';")).toHaveLength(1);
    expect(at("document.body.setAttribute('class', 'x');")).toHaveLength(1);
    expect(at('document.body.classList.add(name);')).toHaveLength(1);
    expect(at('document.documentElement.classList.toggle(cls, on);')).toHaveLength(1);
    expect(at('document.body.classList.add(...names);')).toHaveLength(1);
  });

  it('passes the literal forms, removals of a list and comparisons', () => {
    const at = (source: string) => findUnreadBodyClassWrites([{ file: 'x.ts', source }]);
    expect(at("document.body.classList.add('x');")).toEqual([]);
    expect(at('document.body.classList.toggle(`y`, on);')).toEqual([]);
    expect(at('document.body.classList.remove(...LEGACY_BODY_CLASSES);')).toEqual([]);
    expect(at("if (document.body.className === 'x') {}")).toEqual([]);
    expect(at('if (active === document.body) {}')).toEqual([]);
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
