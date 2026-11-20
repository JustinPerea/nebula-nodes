// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findStatusLiteralHits } from '../scripts/check-status-literals.mjs';

/**
 * scripts/check-status-literals.mjs runs in `npm run lint` (design: a status is a token, not a
 * colour). Each `bad` fixture names the rule (1-5) it must trip; each `fine` fixture must pass.
 */
const css = (...sources: string[]) => ({ css: sources.map((source, i) => ({ file: `fixture${i}.css`, source })), ts: [] });
const script = (source: string, file = 'fixture.ts') => ({ css: [], ts: [{ file, source }] });
const run = (input: ReturnType<typeof css>, allowlist: unknown[] = []) => findStatusLiteralHits(input, allowlist, allowlist, {});
const PINS = { 'fixture0.css': ['.mask-painter__save', '.world-environment-viewer__spinner'] };
const runPinned = (input: ReturnType<typeof css>) => findStatusLiteralHits(input, [], [], PINS);

describe('check-status-literals: bad', () => {
  const bad: Array<[string, number, ReturnType<typeof css>]> = [
    // Rule 1: a status selector paints a literal colour.
    ['status selector with a hex', 1, css('.row--error { color: #e0796b; }')],
    ['a saved state in amber', 1, css('.toolbar__state--saved { color: #f59e0b; }')],
    ['a selected state in blue', 1, css('.tool--active { background: rgba(102, 187, 255, 0.14); }')],
    ['a status selector with a space-syntax rgb', 1, css('.pill--paused { border-color: rgb(217 164 65 / 50%); }')],
    ['aria-current with a literal', 1, css('nav button[aria-current] { background: #3b4b2e; }')],
    ['aria-pressed with a literal', 1, css('button[aria-pressed="true"] { color: #5d70cc; }')],
    ['a keyframe named for a state', 1, css('@keyframes backend-offline-flash { 0% { background: rgb(92 36 26 / 98%); } }')],
    ['a status selector with a color-mix literal', 1, css('.chip--stale { background: color-mix(in srgb, #5d70cc 20%, transparent); }')],
    ['a status selector with a named colour', 1, css('.chip--failed { color: red; }')],
    ['a custom property named for a colour in a status rule', 1, css('.row--done { --row-ink: #34d399; }')],
    ['a state word on an ancestor compound', 1, css('.x--selected .x__label { color: #66bbff; }')],
    ['a state word on an ancestor with a child combinator', 1, css('.tool--active > .tool__icon { background: rgba(102, 187, 255, 0.14); }')],
    // Rule 2: --line-warning falls back to a literal.
    ['line-warning falls back to a literal', 2, css('.x { color: var(--line-warning, #fff000); }')],
    ['line-warning-soft falls back to a literal', 2, css('.x { background: var(--line-warning-soft, rgb(255 0 0 / 10%)); }')],
    ['line-warning-edge falls back to a name', 2, css('.x { border-color: var(--line-warning-edge, salmon); }')],
    // Rule 3: a palette family written as a literal outside a token definition.
    ['the accent as a space-syntax rgb', 3, css('.x { background: rgb(255 90 31 / 10%); }')],
    ['the accent as an rgba glow', 3, css('.editor__playhead { box-shadow: 0 0 8px rgba(255, 90, 31, 0.58); }')],
    ['the warning hex', 3, css('.x { color: #F5C518; }')],
    ['the success rgba', 3, css('.dot { box-shadow: 0 0 6px rgba(110, 231, 183, 0.45); }')],
    ['the danger red outside a fallback', 3, css('.x { color: #ff887d; }')],
    ['a family inside color-mix', 3, css('.x { background: color-mix(in srgb, #F5C518 10%, transparent); }')],
    ['a family in a script string', 3, script("const dot = '#F5C518';")],
    ['a family in a script rgba string', 3, script("const c = 'rgba(255, 90, 31, 0.60)';")],
    // Rule 4: a chromatic fallback behind a token, or behind a variable declared nowhere.
    ['a token with a gold fallback', 4, css('.x { color: var(--sr-accent, #e8c46a); }')],
    ['a token with a blue fallback', 4, css('.x { color: var(--sr-accent, #5d70cc); }')],
    ['the danger fallback on a token that is not the danger pair', 4, css('.x { color: var(--sr-error, #ff887d); }')],
    ['the focus outline with a blue fallback', 4, css('.x { outline: var(--sr-focus-outline, 2px solid #9ab8ff); }')],
    ['a variable declared nowhere with a literal fallback', 4, css('.x { color: var(--accent, #b9a8ff); }')],
    ['a fallback inside color-mix', 4, css('.x { background: color-mix(in srgb, var(--sr-warning, #f5c518) 10%, transparent); }')],
    // Rule 5: red, orange, yellow and green anywhere.
    ['a new pill painted amber', 5, css('.pill { background: #e6a395; }')],
    ['a chip painted green', 5, css('.chip { color: #86efac; }')],
    ['an orange hsl', 5, css('.x { color: hsl(30 80% 55%); }')],
    ['a red in a script string', 5, script("const row = { color: '#F44336' };")],
    ['a yellow in a script string', 5, script("const row = { color: '#FFC107' };", 'lib/other.ts')],
  ];
  const pinned: Array<[string, ReturnType<typeof css>]> = [
    ['a pinned selector with a blue background', css('.mask-painter__save { background: #4da3ff; }')],
    ['a pinned selector with a cyan border-top-color', css('.world-environment-viewer__spinner { border-top-color: #67e8f9; }')],
    ['a pinned selector under the body.app-slava-restraint prefix', css('body.app-slava-restraint .mask-painter__save { color: #4da3ff; }')],
  ];
  for (const [name, input] of pinned) {
    it(`fails rule 6: ${name}`, () => {
      expect(runPinned(input).some((hit: { rules: number[] }) => hit.rules.includes(6))).toBe(true);
    });
  }
  for (const [name, rule, input] of bad) {
    it(`fails rule ${rule}: ${name}`, () => {
      const hits = run(input);
      expect(hits.some((hit: { rules: number[] }) => hit.rules.includes(rule))).toBe(true);
    });
  }
});

describe('check-status-literals: fine', () => {
  const fine: Record<string, ReturnType<typeof css>> = {
    'a status selector reads tokens': css('.row--error { color: var(--sr-error); border-color: var(--sr-error-border); background: var(--sr-error-soft); }'),
    'a status selector reads a token with a neutral fallback': css('.row--active { color: var(--sr-ink, #fff); }'),
    'a neutral rgba in a status rule': css('.row--active { background: rgba(255, 255, 255, 0.08); }'),
    'black and grey literals': css('.x { background: #000; color: #8a8a8a; border-color: rgb(255 255 255 / 12%); }'),
    'line-warning falls back to a token': css('.x { color: var(--line-warning, var(--sr-error)); }'),
    'a color-mix of tokens': css('.x { background: color-mix(in srgb, var(--sr-accent) 26%, transparent); }'),
    'the danger pair on a destructive control': css('.thing--delete { color: var(--sr-danger-ink, #ff887d); background: var(--sr-danger-fill-hover, #ff9a91); }'),
    'a pressed pseudo-class is not a status': css('.button:active { background: rgba(255, 255, 255, 0.1); }'),
    'an active-users class is not a status': css('.active-users { color: #5d70cc; }'),
    'blue, cyan and violet are not guarded': css('.panel { border-color: #67e8f9; color: #b392f0; }'),
    'a classic-skin rule matches nothing': css('body:not(.app-slava-restraint) .row--error { color: #F44336; }'),
    'a comment-exempt declaration': css('.pill {\n  /* palette-exempt: the moodboard category colour */\n  color: #f59e0b;\n}'),
    'a comment-exempt rule': css('/* palette-exempt: category tint */\n.pill:hover { color: #f59e0b; border-color: #f59e0b; }'),
    'a literal in a comment': css('/* .x--error { color: #e0796b; } */ .y { color: var(--sr-ink); }'),
    'a variable defined elsewhere with a literal fallback': css('.x { --mine: red; }', '.y { color: var(--mine, #888888); }'),
    'a token definition when the entry allows it': css('.x { color: var(--sr-ink); }'),
  };
  for (const [name, input] of Object.entries(fine)) {
    it(`passes: ${name}`, () => expect(run(input)).toEqual([]));
  }

  it('passes a pinned selector that reads a token, and an unpinned one with a blue', () => {
    expect(runPinned(css('.mask-painter__save { background: var(--sr-accent); color: var(--sr-on-accent); }'))).toEqual([]);
    expect(runPinned(css('.mask-painter__other { background: #4da3ff; }'))).toEqual([]);
  });
  it('passes an ancestor state word on a non-colour property', () => {
    expect(run(css('.x--selected .x__label { padding: 4px; font-weight: 600; }'))).toEqual([]);
    expect(run(css('.x--selected .x__label { color: var(--sr-ink); }'))).toEqual([]);
  });
  it('passes a script PR number and a comment', () => {
    expect(run(script("// fixes #203 and #E8825A\nconst label = 'PR #203';"))).toEqual([]);
  });
  it('passes a script literal under an exempt comment', () => {
    expect(run(script("// palette-exempt: agent identity colour\nconst c = '#E8825A';"))).toEqual([]);
    expect(run(script("const c = '#E8825A'; // palette-exempt: agent identity colour"))).toEqual([]);
  });
  it('passes a neutral script colour', () => {
    expect(run(script("const c = 'rgba(255, 255, 255, 0.4)'; const d = '#c9cac8';"))).toEqual([]);
  });
  it('passes an allowlisted selector and fails the next one in the same file', () => {
    const entry = [{ file: 'fixture0.css', selector: '.debug-handles', reason: 'debug' }];
    expect(run(css('.debug-handles .h { outline: 1px solid red; }'), entry)).toEqual([]);
    expect(run(css('.debug-handles .h { outline: 1px solid red; } .pill { color: #e6a395; }'), entry)).toHaveLength(1);
  });
  it('passes an allowlisted token definition by property', () => {
    const entry = [{ file: 'fixture0.css', selector: ':root', prop: '--sr-danger', reason: 'token' }];
    expect(run(css(':root { --sr-danger: #ff887d; }'), entry)).toEqual([]);
    expect(run(css(':root { --sr-other: #e6a395; }'), entry)).toHaveLength(1);
  });
  it('a whole-file entry covers the file and no other', () => {
    const entry = [{ file: 'fixture0.css', whole: true, reason: 'theme' }];
    expect(run(css('.pill { color: #e6a395; }'), entry)).toEqual([]);
    expect(run(css('', '.pill { color: #e6a395; }'), entry)).toHaveLength(1);
  });
  // Design: a whole-file entry exempts the hue guard (rule 5) only; rules 1-4 still run on the file.
  it('a whole-file entry still fails a status selector (rule 1)', () => {
    const entry = [{ file: 'fixture0.css', whole: true, reason: 'theme' }];
    const hits = run(css('.row--error { color: #e6a395; }'), entry);
    expect(hits).toHaveLength(1);
    expect(hits[0].rules).toContain(1);
  });
  it('a whole-file entry still fails a literal fallback (rule 4) and a palette family (rule 3)', () => {
    const entry = [{ file: 'fixture0.css', whole: true, reason: 'theme' }];
    expect(run(css('.x { color: var(--sr-accent, #e8c46a); }'), entry).some((h: { rules: number[] }) => h.rules.includes(4))).toBe(true);
    expect(run(css('.x { background: rgb(255 90 31 / 10%); }'), entry).some((h: { rules: number[] }) => h.rules.includes(3))).toBe(true);
  });
  it('a whole-file entry still fails --line-warning with a literal fallback (rule 2)', () => {
    const entry = [{ file: 'fixture0.css', whole: true, reason: 'theme' }];
    expect(run(css('.x { color: var(--line-warning, #e0796b); }'), entry).some((h: { rules: number[] }) => h.rules.includes(2))).toBe(true);
  });
  it('a whole-file entry still passes the same file\'s hue literals', () => {
    const entry = [{ file: 'fixture0.css', whole: true, reason: 'theme' }];
    expect(run(css('.pill { background: #e6a395; } .chip { color: #86efac; } .x { color: hsl(30 80% 55%); }'), entry)).toEqual([]);
  });
});
