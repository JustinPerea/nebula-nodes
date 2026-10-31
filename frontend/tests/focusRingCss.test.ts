import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// GM - Design (sf, after #157): "Yes, fix the focus ring at the token,
// app-wide. But make it a light neutral, not --sr-accent. Orange already means
// two things in Nebula: the agent (its cursor, and the orange outline on the
// cards its notes name) and the primary action (Add, Start, Generate) ... A
// light neutral ring carries no meaning of its own: about #E8E6E1 or the app's
// primary text colour, at 2px with the 2px offset. It clears 3:1 easily on
// every dark surface and stays clear of orange and the lime unread ring."
// Before: --sr-focus-outline was 2px solid var(--sr-accent-soft), orange at 10%
// alpha (about 1.2:1 on the canvas), under the 3:1 a focus indicator needs
// (WCAG 2.2 1.4.11).

const SRC = join(__dirname, '../src');
const slava = readFileSync(join(SRC, 'styles/slava-restraint.css'), 'utf8');

// ── A small CSS reader: rules with their selectors and declarations ─────────

interface Rule { file: string; line: number; selectors: string[]; decls: Array<[string, string]> }

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

/** Split on `sep` outside parentheses, brackets and quotes. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === sep && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseCss(file: string, raw: string): Rule[] {
  // Comments become spaces so offsets (and line numbers) stay true.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const rules: Rule[] = [];
  const walk = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const open = css.indexOf('{', i);
      if (open < 0 || open >= to) return;
      let depth = 0;
      let close = open;
      for (; close < to; close += 1) {
        if (css[close] === '{') depth += 1;
        else if (css[close] === '}' && --depth === 0) break;
      }
      const prelude = css.slice(i, open).replace(/^[\s;}]+/, '').trim();
      if (/^@(media|supports|layer|container)\b/.test(prelude)) walk(open + 1, close);
      else if (!prelude.startsWith('@')) {
        const line = css.slice(0, i + css.slice(i, open).search(/\S/)).split('\n').length;
        const decls = splitTop(css.slice(open + 1, close), ';').map((d) => {
          const colon = d.indexOf(':');
          return [d.slice(0, colon).trim().toLowerCase(), d.slice(colon + 1).replace(/!important/, '').trim()] as [string, string];
        });
        rules.push({ file, line, selectors: splitTop(prelude, ',').map((s) => s.replace(/\s+/g, ' ')), decls });
      }
      i = close + 1;
    }
  };
  walk(0, css.length);
  return rules;
}

const files = cssFiles(SRC);
const rules = files.flatMap((path) => parseCss(relative(SRC, path), readFileSync(path, 'utf8')));
const where = (rule: Rule) => `${rule.file}:${rule.line} ${rule.selectors.join(', ')}`;
// The pre-Slava skin's rules never match: skins.ts adds .app-slava-restraint
// to <body> before the first paint, and it is the one supported appearance.
const LEGACY = /^body:not\(\.app-slava-restraint\)/;
const live = (rule: Rule) => rule.selectors.some((s) => !LEGACY.test(s));
const TOKEN_OUTLINE = /^var\(--sr-focus-outline(-on-light)?[,)]/;
const decl = (rule: Rule, prop: string) => rule.decls.find(([p]) => p === prop)?.[1] ?? null;

// ── The token ───────────────────────────────────────────────────────────────

function tokenBlock(): string {
  const start = slava.indexOf('body.app-slava-restraint {');
  return slava.slice(start, slava.indexOf('\n}', start));
}

function token(name: string): string {
  const match = tokenBlock().match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`));
  expect(match, `${name} is a Slava token`).toBeTruthy();
  return match![1].trim();
}

describe('the focus ring token (GM: a light neutral, 2px at a 2px offset)', () => {
  it('draws 2px solid in the primary text colour token, offset 2px', () => {
    expect(token('--sr-focus-outline')).toBe('2px solid var(--sr-ink)');
    expect(token('--sr-focus-offset')).toBe('2px');
    // --sr-ink is the primary type colour (white at 92 %: #EBEBEB on the
    // canvas, next to GM's #E8E6E1).
    expect(tokenBlock()).toMatch(/--sr-ink: rgba\(255, 255, 255, 0\.92\);\s*\/\* primary type \*\//);
  });

  it('has a dark twin for the one light surface a ring sits on (the evaluation form)', () => {
    expect(token('--sr-focus-outline-on-light')).toBe('2px solid var(--sr-canvas)');
  });

  it('is the ring wherever nothing else draws one (the browser default is replaced)', () => {
    const base = rules.find((r) => r.selectors.includes(':where(body.app-slava-restraint :focus-visible)'));
    expect(base, 'a zero-specificity baseline').toBeTruthy();
    expect(decl(base!, 'outline')).toBe('var(--sr-focus-outline)');
    expect(decl(base!, 'outline-offset')).toBe('var(--sr-focus-offset)');
  });

  it('rings a canvas node card that has keyboard focus (React Flow clears the wrapper\'s outline)', () => {
    const card = rules.find((r) => r.selectors.includes('body.app-slava-restraint .canvas-wrapper .react-flow__node:focus-visible .model-node__card'));
    expect(card).toBeTruthy();
    expect(decl(card!, 'outline')).toBe('var(--sr-focus-outline)');
    expect(decl(card!, 'outline-offset')).toBe('var(--sr-focus-offset)');
  });
});

// ── Contrast: the ring against every surface it sits on ─────────────────────

type RGBA = [number, number, number, number];

function resolve(value: string, seen = 0): string {
  const v = value.trim();
  const ref = v.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/);
  if (ref && seen < 8) return resolve(token(ref[1]), seen + 1);
  return v;
}

function parseColor(value: string): RGBA {
  const v = resolve(value);
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1)];
  throw new Error(`unparsed colour: ${value} -> ${v}`);
}

/** Paint `layers` (bottom first) over an opaque base, as the browser does. */
function over(...layers: string[]): RGBA {
  return layers.map(parseColor).reduce((below, [r, g, b, a]) => [
    r * a + below[0] * (1 - a), g * a + below[1] * (1 - a), b * a + below[2] * (1 - a), 1,
  ]);
}

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour a ring token draws in (its last part). */
const ringColor = (name: string) => token(name).split(/\s+/).slice(2).join(' ');
const canvas = 'var(--sr-canvas)';
// Each surface as the stack of layers under the ring, bottom first. Glass
// sits over the black canvas (its backdrop blur only averages that black).
const SURFACES: Array<[string, string[]]> = [
  ['the canvas and page background (--sr-canvas)', [canvas]],
  ['dialogs: prompt, keyboard shortcuts (--sr-canvas-elevated)', ['var(--sr-canvas-elevated)']],
  ['the workspace header and panels (--sr-glass)', [canvas, 'var(--sr-glass)']],
  ['popovers and menus (--sr-glass-raised)', [canvas, 'var(--sr-glass-raised)']],
  ['Commons panels, the composer, the Updates list (--sr-glass-strong)', [canvas, 'var(--sr-glass-strong)']],
  ['a control on the header (--sr-surface-control on --sr-glass)', [canvas, 'var(--sr-glass)', 'var(--sr-surface-control)']],
  ['a hovered control (--sr-surface-control-hover on --sr-glass-strong)', [canvas, 'var(--sr-glass-strong)', 'var(--sr-surface-control-hover)']],
  ['an input (--sr-surface-control-focus on --sr-glass-strong)', [canvas, 'var(--sr-glass-strong)', 'var(--sr-surface-control-focus)']],
  ['a node card (--sr-node-pill-bg, the lightest node chrome)', [canvas, 'var(--sr-node-pill-bg)']],
  ['the Commons evaluation panel (commons-evaluation.css)', ['#1c211d']],
  ['an evaluation nav button, current (commons-evaluation.css)', ['#3b4b2e']],
  ['the provider recovery banner (App.css)', [canvas, 'rgba(39, 23, 13, 0.97)']],
];

describe('the ring clears 3:1 on every surface it sits on (WCAG 2.2 1.4.11)', () => {
  it.each(SURFACES)('on %s', (_, layers) => {
    const surface = over(...layers);
    const drawn = over(...layers, ringColor('--sr-focus-outline'));
    expect(contrast(drawn, surface)).toBeGreaterThanOrEqual(3);
  });

  it('on the light evaluation form, its dark twin does', () => {
    for (const surface of ['#eff1e8', '#d9e1cf', '#f9faf5']) {
      expect(contrast(over(surface, ringColor('--sr-focus-outline-on-light')), over(surface))).toBeGreaterThanOrEqual(3);
    }
    // The light ring would not have (why the form needs the twin).
    expect(contrast(over('#eff1e8', ringColor('--sr-focus-outline')), over('#eff1e8'))).toBeLessThan(3);
  });

  it('is not orange: it differs from the accent and the agent outline in hue', () => {
    const [r, g, b] = over(canvas, ringColor('--sr-focus-outline'));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(8); // neutral
  });
});

// ── The sweep: no stylesheet draws its own focus ring ───────────────────────

// Focus rules that keep their own look, each with why. Keyed "file::selector".
const OWN_RING: Record<string, string> = {
  // The moodboard board draws focus on the card inside React Flow's wrapper
  // (the wrapper's box doesn't follow the card's radius). It is already the
  // token's colour (--mb-board-select is white at 92 %), 2px, plus a 5px halo
  // that tells it from the selected card's plain 2px ring.
  'styles/moodboard-board.css::.react-flow__node-card:focus-visible .moodboard-card': 'card ring in the token colour, with a halo against selected',
  // The Jev demo card's question field: "pink focus" in the TypeSafe brand
  // colour Justin chose for v6. It sits on that card only.
  'styles/jev-result.css::body.app-slava-restraint .model-node--jev .model-node__jev-field .model-node__jev-input:focus': 'Jev brand border',
  'styles/jev-result.css::body.app-slava-restraint .model-node--jev .model-node__jev-field .model-node__jev-input:focus-visible': 'Jev brand ring',
};

// `outline: none` on a focus selector, where something else shows focus.
const NO_OUTLINE: Record<string, string> = {
  // A text card's body is its field: the caret (ink-bold) shows where you type,
  // and the node's selected state rings the card. A second ring inside the
  // card would read as the node's own focus ring.
  'styles/slava-restraint.css::body.app-slava-restraint .model-node--text-surface .model-node__textarea:focus': 'text card body; caret + selected card',
  'styles/slava-restraint.css::body.app-slava-restraint .model-node--text-surface .model-node__textarea:focus-visible': 'text card body; caret + selected card',
  // The moodboard board's card wrapper: the ring is drawn on the card inside (OWN_RING).
  'styles/moodboard-board.css::.moodboard-board__flow .react-flow__node-card:focus': 'ring on the inner card',
  'styles/moodboard-board.css::.moodboard-board__flow .react-flow__node-card:focus-visible': 'ring on the inner card',
};

function focusSelectors(rule: Rule): string[] {
  return rule.selectors.filter((s) => /:focus/.test(s) && !LEGACY.test(s));
}

function tokenRingFor(selector: string): boolean {
  return rules.some((r) => r.selectors.includes(selector) && TOKEN_OUTLINE.test(decl(r, 'outline') ?? ''));
}

describe('every focus rule uses the token (the sweep)', () => {
  const focusRules = rules.filter((r) => live(r) && focusSelectors(r).length > 0);

  it('finds the focus rules (the reader works)', () => {
    expect(focusRules.length).toBeGreaterThan(100);
  });

  it('no focus rule colours focus with the accent (orange means the agent and the primary action)', () => {
    const bad = focusRules.filter((r) => !focusSelectors(r).every((s) => OWN_RING[`${r.file}::${s}`]))
      .filter((r) => r.decls.some(([, v]) => /--sr-accent/.test(v)));
    expect(bad.map(where)).toEqual([]);
  });

  it('every focus outline is the token; no other width, colour or box-shadow ring', () => {
    const bad: string[] = [];
    for (const r of focusRules) {
      if (focusSelectors(r).every((s) => OWN_RING[`${r.file}::${s}`])) continue;
      for (const [prop, value] of r.decls) {
        if (prop === 'outline' && !TOKEN_OUTLINE.test(value) && !/^(none|0)$/.test(value)) bad.push(`${where(r)} :: outline: ${value}`);
        if (/^outline-(color|width|style)$/.test(prop)) bad.push(`${where(r)} :: ${prop}: ${value}`);
        if (prop === 'box-shadow' && value !== 'none') bad.push(`${where(r)} :: box-shadow: ${value}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('never clears the outline on focus without putting the token ring back', () => {
    const bad: string[] = [];
    for (const r of focusRules) {
      if (!/^(none|0)$/.test(decl(r, 'outline') ?? '')) continue;
      for (const s of focusSelectors(r)) {
        if (NO_OUTLINE[`${r.file}::${s}`]) continue;
        // `:focus { outline: none }` is fine when `:focus-visible` brings the ring back.
        const visible = s.replace(/:focus(?![-\w])/g, ':focus-visible');
        if (visible === s || !tokenRingFor(visible)) bad.push(`${r.file}:${r.line} ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// A base rule that clears a field's outline, and the rule that shows its focus.
const CLEARED: Record<string, string> = {
  'components/projects/ProjectWorkspaceControls.css::body.app-slava-restraint .project-workspace-controls__name-input':
    'body.app-slava-restraint .project-workspace-controls__name-input:focus',
  'styles/character-studio.css::.assets-panel__search': 'body.app-slava-restraint .assets-panel__search:focus-visible',
  'styles/command-palette.css::.command-palette__input': 'body.app-slava-restraint .command-palette__input:focus-visible',
  'styles/create-gallery.css::body.app-slava-restraint .preset-library__search input':
    'body.app-slava-restraint .preset-library__search:has(input:focus-visible)',
  'styles/create-studio.css::body.app-slava-restraint .create-composer__prompt':
    'body.app-slava-restraint .create-composer:has(.create-composer__prompt:focus-visible)',
  'styles/create-studio.css::body.app-slava-restraint .param-pill__select':
    'body.app-slava-restraint .param-pill:has(:is(.param-pill__select, .param-pill__number):focus-visible)',
  'styles/create-studio.css::body.app-slava-restraint .param-pill__number':
    'body.app-slava-restraint .param-pill:has(:is(.param-pill__select, .param-pill__number):focus-visible)',
  'styles/create-studio.css::body.app-slava-restraint .model-picker__search input':
    'body.app-slava-restraint .model-picker input:focus-visible',
  'styles/jev-result.css::body.app-slava-restraint .model-node__jev-field .model-node__jev-input':
    'body.app-slava-restraint .model-node__jev-field .model-node__jev-input:focus-visible',
  'styles/moodboard-studio.css::body.app-slava-restraint .moodboard-color': 'body.app-slava-restraint .moodboard-color:focus-visible',
  'styles/nodes.css::.model-node__label-input': 'body.app-slava-restraint .model-node__label-input:focus-visible',
  'styles/panels.css::.panel__search': 'body.app-slava-restraint :is( .panel__search, .inspector__field, .inspector__action-button, .inspector__file-button, .inspector__favorite-button, .inspector__info-button, .panel__item, .panel-launcher, .toolbar__button ):focus-visible',
  'styles/panels.css::.inspector__field': 'body.app-slava-restraint :is( .panel__search, .inspector__field, .inspector__action-button, .inspector__file-button, .inspector__favorite-button, .inspector__info-button, .panel__item, .panel-launcher, .toolbar__button ):focus-visible',
  'styles/panels.css::.connection-popup__search': 'body.app-slava-restraint .connection-popup__search:focus-visible',
  'styles/panels.css::.chat-panel__textarea': 'body.app-slava-restraint .chat-panel__textarea:focus-visible',
  'styles/slava-restraint.css::body.app-slava-restraint .chat-panel__model-search': 'body.app-slava-restraint .chat-panel__model-search:focus-visible',
  'styles/slava-restraint.css::body.app-slava-restraint .chat-panel__textarea': 'body.app-slava-restraint .chat-panel__textarea:focus-visible',
  'styles/settings.css::body.app-slava-restraint .settings-search input': 'body.app-slava-restraint .settings-search:has(input:focus-visible)',
  'styles/settings.css::body.app-slava-restraint .settings-key__input': 'body.app-slava-restraint .settings-key:has(.settings-key__input:focus-visible)',
  'styles/settings.css::body.app-slava-restraint .settings-daily__input': 'body.app-slava-restraint .settings-daily__field:has(.settings-daily__input:focus-visible)',
  'styles/settings.css::body.app-slava-restraint .settings-sa__paste': 'body.app-slava-restraint .settings-sa__paste:focus',
  'styles/settings.css::body.app-slava-restraint .settings-folder__input': 'body.app-slava-restraint .settings-folder__input:focus',
  // The text card's body (see NO_OUTLINE): the caret and the selected card show it.
  'styles/slava-restraint.css::body.app-slava-restraint .model-node--text-surface .model-node__textarea': '',
};

describe('a field that clears its outline gets the token ring back on focus', () => {
  const cleared = rules.filter((r) => live(r) && /^(none|0)$/.test(decl(r, 'outline') ?? '')
    && r.selectors.some((s) => !/:focus/.test(s) && !LEGACY.test(s)));

  it.each(cleared.flatMap((r) => r.selectors.filter((s) => !/:focus/.test(s) && !LEGACY.test(s)).map((s) => [`${r.file}::${s}`])))('%s', (key) => {
    expect(key in CLEARED, `${key} clears the outline: name the rule that shows its focus`).toBe(true);
    const replacement = CLEARED[key];
    if (replacement) expect(tokenRingFor(replacement), `${replacement} draws the token ring`).toBe(true);
  });
});

// GM: the ring "stays clear of orange and the lime unread ring". The Updates
// chip draws its unread ring outside itself (::after at a negative inset), so
// a 2px ring at the 2px offset painted over half of it (review of sf). While
// the unread ring shows, the focus ring sits outside it with a 1px gap.
describe('the focus ring clears the Updates chip\'s unread ring', () => {
  const FILE = 'components/agent-notes/agentNotes.css';
  const find = (selector: string) => rules.find((r) => r.file === FILE && r.selectors.includes(selector));
  const px = (value: string | null) => Number.parseFloat(value ?? 'NaN');

  it('sits outside the unread ring, with a gap, only while the ring shows', () => {
    const ring = find('.agent-notes-chip::after');
    expect(ring, 'the unread ring rule').toBeTruthy();
    const outer = -px(decl(ring!, 'inset'));
    const width = px((decl(ring!, 'border') ?? '').split(/\s+/)[0]);
    expect(outer).toBeGreaterThan(0);
    expect(width).toBeGreaterThan(0);
    // The ring covers outer - width .. outer px outside the chip.
    const base = find('.agent-notes-chip:focus-visible');
    expect(decl(base!, 'outline')).toMatch(TOKEN_OUTLINE);
    expect(px(decl(base!, 'outline-offset')), 'the chip keeps GM\'s 2px offset without the unread ring').toBe(2);
    const ringed = find('.agent-notes-chip--ringed:focus-visible');
    expect(ringed, 'a ringed chip moves its focus ring out').toBeTruthy();
    expect(px(decl(ringed!, 'outline-offset'))).toBeGreaterThanOrEqual(outer + 1);
  });
});
