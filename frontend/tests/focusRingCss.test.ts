import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tabIndexSites } from './helpers/tabIndexSites';

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
  // A placeholder tile (a file still uploading, #210) takes focus like a card, with the card's ring.
  'styles/moodboard-board.css::.react-flow__node-placeholder:focus-visible .moodboard-board__placeholder': 'the card ring, on a placeholder tile',
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
  // Projects home: a target the page moves focus to (tabindex -1: the heading
  // after a notice's ×, the held edits' saved line) is not a control; it never
  // shows a ring, from the keyboard either (GM - Design r6, bug 4).
  'styles/project-home.css::body.app-slava-restraint .project-home [tabindex="-1"]:focus': 'programmatic focus target, not a control (GM r6)',
  'styles/project-home.css::body.app-slava-restraint .project-home [tabindex="-1"]:focus-visible': 'programmatic focus target, not a control (GM r6)',
  // The canvas root takes focus after Projects > Open returns to the canvas
  // (PR #199 review 19, item 6), so focus doesn't fall to <body>. It is not in
  // the Tab order and not a control; a ring around the whole canvas would
  // read as a selection. Its nodes and controls keep their own rings.
  "App.css::.react-flow[tabindex='-1']:focus": 'programmatic focus target (the canvas root), not a control',
  // PR #204 round 18g (GM r36): a heading or a line focused from code (see the describe below).
  'styles/slava-restraint.css::body.app-slava-restraint :is(h1, h2, h3, h4, h5, h6, [data-focus-line], [data-line-box], [role="status"], [role="alert"])[tabindex="-1"]:focus-visible': 'focused only from code: no ring',
  // PR #204 round 18h (GM r38 3d): the start of the page a leaving notice hands focus to.
  'styles/slava-restraint.css::body.app-slava-restraint [data-focus-start]:focus-visible': 'focused only from code: no ring',
  'styles/moodboard-board.css::.moodboard-board__flow .react-flow__node-placeholder:focus': 'ring on the inner placeholder',
  'styles/moodboard-board.css::.moodboard-board__flow .react-flow__node-placeholder:focus-visible': 'ring on the inner placeholder',
  // The proposal card's scrolling body: its fade mask would clip its own ring,
  // so the wrapper draws the token ring instead (pinned below).
  'styles/canvasProposals.css::.proposal-bar__body:focus-visible': 'ring on the scroll wrapper',
  // #208 GM r23: the palette's "Extracting colors…" line, given focus by
  // code when it replaces the row a control had it in; a line, not a control.
  'styles/panels.css::body:not(.app-slava-restraint) .inspector__palette-pending:focus': 'code-moved focus on a line',
  'styles/panels.css::body.app-slava-restraint .inspector__palette-pending:focus': 'code-moved focus on a line',
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

  it('#216 round 3l (GM r69 Q2): the canvas draws the token ring inside its edge, on Tab arrival and after a keyboard decision', () => {
    // It fills the window, so the baseline's ring (outside its box, offset
    // 2px) was clipped away: Tab arrival showed nothing.
    for (const selector of ['body.app-slava-restraint .canvas-wrapper:focus-visible', 'body.app-slava-restraint .canvas-wrapper[data-focus-decided]:focus']) {
      const rule = rules.find((r) => r.selectors.includes(selector));
      expect(rule, selector).toBeTruthy();
      expect(decl(rule!, 'outline')).toBe('var(--sr-focus-outline)');
      expect(decl(rule!, 'outline-offset')).toBe('-2px');
    }
    // On the canvas (black), at well over 3:1.
    expect(contrast(over(canvas, ringColor('--sr-focus-outline')), over(canvas))).toBeGreaterThanOrEqual(3);
    // Nothing clears the canvas's ring any more (3k's quiet mark).
    expect(rules.filter((r) => r.selectors.some((sel) => /canvas-wrapper\[data-focus-quiet\]/.test(sel)))).toEqual([]);
  });

  it('the proposal card body\'s cleared ring is drawn on its scroll wrapper with the token', () => {
    expect(tokenRingFor('.proposal-bar__scroll:has(> .proposal-bar__body:focus-visible)')).toBe(true);
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
  // The Message box's field (#225): the row it sits in draws the ring.
  'styles/messageBox.css::.message-box__field': '.message-box__field-row:has(.message-box__field:focus-visible)',
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

// ── PR #204 round 18g (GM r36): focus from code draws no ring ────────────────
// A handover (a demote, going offline, the Commons turning off, Try again's line going, the off
// view opening into the Commons) moves focus to a heading, or to the line that says why, so a
// screen reader announces it. A person never Tabs there (tabindex -1), so the ring would only mark
// where code put focus. One rule in slava-restraint.css takes it off, app-wide; everything a person
// tabs to keeps its ring.

const CODE_FOCUS_RULE = 'body.app-slava-restraint :is(h1, h2, h3, h4, h5, h6, [data-focus-line], [data-line-box], [role="status"], [role="alert"])[tabindex="-1"]:focus-visible';
/** What the rule covers: a heading, or a line (a focus line, a line box, a status or alert line). */
const CODE_FOCUS_TARGET = /(^|[\s>+~(,])h[1-6](?![\w-])|\[data-focus-line\]|\[data-line-box\]|\[role="(status|alert)"\]|__title\b|-heading\b|\.line-box\b|\.person-lock-line\b/;

describe('a heading or a line focused from code draws no ring (GM r36)', () => {
  it('one rule takes the ring off them, important, after the baseline ring', () => {
    const rule = rules.find((r) => r.selectors.includes(CODE_FOCUS_RULE));
    expect(rule, 'the code-focus rule').toBeTruthy();
    expect(rule!.file).toBe('styles/slava-restraint.css');
    expect(rule!.selectors).toEqual([CODE_FOCUS_RULE]);
    expect(decl(rule!, 'outline')).toBe('none');
    // Important: no component's own ring can bring it back, whatever its specificity.
    const raw = slava.slice(slava.indexOf(CODE_FOCUS_RULE));
    expect(raw.slice(0, raw.indexOf('}'))).toMatch(/outline:\s*none\s*!important;/);
    // Only tabindex -1: a heading or a line a person can Tab to keeps its ring.
    expect(CODE_FOCUS_RULE).toContain('[tabindex="-1"]:focus-visible');
    const base = slava.indexOf(':where(body.app-slava-restraint :focus-visible)');
    expect(base).toBeGreaterThan(-1);
    expect(slava.indexOf(CODE_FOCUS_RULE)).toBeGreaterThan(base);
  });

  it('no other rule draws a ring on a heading or a line when it takes focus', () => {
    const bad: string[] = [];
    for (const r of rules.filter(live)) {
      if (r.selectors.includes(CODE_FOCUS_RULE)) continue;
      for (const sel of focusSelectors(r)) {
        // The focused element: the compound that carries :focus (not a :has() or a parent).
        const focused = sel.split(/\s+|>|\+|~/).filter((part) => /:focus/.test(part) && !/:has\(/.test(part));
        if (!focused.some((part) => CODE_FOCUS_TARGET.test(` ${part}`))) continue;
        const outline = decl(r, 'outline');
        if ((outline && !/^(none|0)$/.test(outline)) || (decl(r, 'box-shadow') ?? 'none') !== 'none') bad.push(`${where(r)} :: ${sel}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // Every element the app gives tabindex -1 is either a heading or a line (the rule covers it and
  // code focuses it), a roving tab stop (a control moved to with the arrow keys), or listed here
  // with why it keeps the ring. Round 18h (review 16 focus LOW-1): counted per file, so a new
  // element in a listed file still has to be placed; found from the syntax tree in .ts and .tsx
  // (helpers/tabIndexSites), whatever the spelling.
  const KEEPS_RING: Record<string, { count: number; why: string }> = {
    'components/create-studio/ResultCard.tsx': { count: 1, why: 'a button: a control keeps its ring' },
    'components/create-studio/ResultComparison.tsx': { count: 1, why: 'a dialog focused on open: a ring only from the keyboard (:focus-visible, GM r37)' },
    'components/create-studio/Lightbox.tsx': { count: 1, why: 'a dialog focused on open: a ring only from the keyboard (GM r37)' },
    'components/create-studio/ModelPicker.tsx': { count: 1, why: 'a picker panel focused on open: a ring only from the keyboard (GM r37)' },
    'components/nodes/SceneUnsavedMark.tsx': { count: 1, why: 'a popover focused on open: a ring only from the keyboard (GM r37)' },
    'components/nodes/ProviderSwitcher.tsx': { count: 3, why: 'menu items, moved through with the arrow keys' },
    'components/nodes/MeshPreview.tsx': { count: 1, why: 'a modal focused on open: a ring only from the keyboard (GM r37)' },
    'components/nodes/WorldSplatPreview.tsx': { count: 1, why: 'a modal focused on open: a ring only from the keyboard (GM r37), as WorldPreview' },
    'components/nodes/WorldPreview.tsx': { count: 1, why: 'a modal focused on open: a ring only from the keyboard (GM r37)' },
    'components/commons/CommonsLeavePopover.tsx': { count: 1, why: 'an alertdialog focused on open: a ring only from the keyboard (GM r37)' },
    'components/commons/CommonsView.tsx': { count: 1, why: 'a section tab folded into More: a control keeps its ring' },
    'components/projects/ProjectSizePanel.tsx': { count: 1, why: 'a panel focused on open: a ring only from the keyboard (GM r37)' },
    'components/panels/ChatModelPicker.tsx': { count: 1, why: 'a dialog focused on open: a ring only from the keyboard (GM r37)' },
    'components/panels/settings/ServiceAccountInput.tsx': { count: 1, why: 'a hidden file input, never focused' },
    'components/panels/settings/ProviderRow.tsx': { count: 1, why: 'a provider row a setup link moves focus to: keeps its :focus-visible ring (GM r38 3d)' },
    'components/canvas/ProposalBar.tsx': { count: 2, why: 'Review focuses the card, and a keyboard decision focuses the Undo notice it raised: the neutral ring from the keyboard (#161, GM r57)' },
    'components/moodboard-studio/BoardCanvas.tsx': { count: 1, why: 'the board itself, where focus rests when no tile can take it: the token ring from the keyboard (moodboard-board.css, GM #210 r4)' },
    'components/moodboard-studio/MoodboardStudioView.tsx': { count: 1, why: "the screen's <main>, focused from code with focusVisible: false, so it draws no ring" },
    'lib/threadOpen.ts': { count: 1, why: 'a thread row an Update opened, focused from code: its ring from the keyboard, and the tabindex goes on its blur (messageBox.css [data-focus-target])' },
    'components/agent-notes/AgentNotesList.tsx': { count: 1, why: 'the Updates list, focused on open: a ring only from the keyboard (GM r37)' },
    'components/onboarding/OnboardingOverlay.tsx': { count: 1, why: 'the onboarding panel, focused on open: a ring only from the keyboard (GM r37)' },
    'components/proposals/AssetProposalStrip.tsx': { count: 2, why: 'Review focuses it: the neutral ring from the keyboard (#161)' },
    'components/asset-move/AssetMoveMenu.tsx': { count: 1, why: 'menu items, moved through with the arrow keys' },
    'components/panels/Inspector.tsx': { count: 1, why: 'the palette\'s "Extracting colors…" line, focused from code: its own :focus rule draws no ring (#208, panels.css)' },
    'lib/canvasFocus.ts': { count: 1, why: 'the canvas root, focused after Projects > Open returns to it: no ring around the whole canvas (App.css .react-flow[tabindex="-1"]:focus, review 19 item 6 of PR #199)' },
    'lib/noticeLeave.ts': { count: 1, why: 'a notice with no ×, or the start of the page: a notice is a status or alert line; the start draws no ring (data-focus-start, GM r38 3d)' },
  };

  /** The code-focus rule's :is() list, read from the sheet: what it covers is what the scan
   * counts as covered, so the two can't drift (round 18h, review 16 focus LOW-1 R9/R10). */
  const coveredBy = (): Array<(tag: string, element: string) => boolean> => {
    const rule = rules.find((r) => r.file === 'styles/slava-restraint.css'
      && r.selectors.some((sel) => /^body\.app-slava-restraint :is\(.*\)\[tabindex="-1"\]:focus-visible$/.test(sel)));
    const sel = rule!.selectors[0];
    const list = splitTop(sel.slice(sel.indexOf(':is(') + 4, sel.lastIndexOf(')[tabindex')), ',');
    const attrs = readFileSync(join(SRC, 'lib/lineAttrs.ts'), 'utf8');
    return list.map((item) => {
      const tag = /^h[1-6]$/.exec(item)?.[0];
      if (tag) return (name: string) => name === tag;
      const role = /^\[role="(\w+)"\]$/.exec(item)?.[1];
      if (role) return (_: string, element: string) => new RegExp(`role="${role}"|role=\\{[^}]*'${role}'`).test(element);
      const attr = /^\[([\w-]+)\]$/.exec(item)?.[1];
      expect(attr, `a selector the scan can read: ${item}`).toBeTruthy();
      // The attribute, or the lineAttrs constant that names it.
      const constant = new RegExp(`export const (\\w+) = '${attr}'`).exec(attrs)?.[1];
      return (_: string, element: string) => element.includes(`${attr}=`) || (constant !== undefined && element.includes(constant));
    });
  };

  it('every tabindex -1 in the app is a covered heading or line, a roving stop, or keeps its ring for a reason', () => {
    const source = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return source(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
    const covers = coveredBy();
    const kept: Record<string, number> = {};
    let covered = 0;
    for (const path of source(SRC)) {
      const file = relative(SRC, path);
      for (const site of tabIndexSites(readFileSync(path, 'utf8'), path)) {
        if (covers.some((cover) => cover(site.tag, site.element))) { covered += 1; continue; }
        if (site.roving) continue;
        kept[file] = (kept[file] ?? 0) + 1;
      }
    }
    expect(kept).toEqual(Object.fromEntries(Object.entries(KEEPS_RING).map(([file, { count }]) => [file, count])));
    // The page heading, the section headings, the Commons and person-lock lines, the line boxes.
    expect(covered).toBeGreaterThanOrEqual(10);
  });

  it('the scan finds every spelling of tabindex -1, and tells a roving stop apart', () => {
    const one = (code: string, name = 'a.tsx') => tabIndexSites(code, name);
    expect(one('const a = <div tabIndex={-1} />;')).toHaveLength(1);
    expect(one('const a = <div tabIndex="-1" />;')).toHaveLength(1);
    expect(one('const a = <div tabIndex={ -1 } />;')).toHaveLength(1);
    expect(one('const a = <div tabIndex={open ? -1 : undefined} />;')[0]).toMatchObject({ tag: 'div', roving: false });
    expect(one('const a = <button tabIndex={on ? 0 : -1} />;')[0]).toMatchObject({ tag: 'button', roving: true });
    expect(one("const a = <p {...(x ? { tabIndex: -1, 'data-focus-line': '' } : {})} />;")[0].tag).toBe('p');
    expect(one("el.setAttribute('tabindex', '-1');", 'a.ts')).toHaveLength(1);
    expect(one('el.tabIndex = -1;', 'a.ts')).toHaveLength(1);
    expect(one('const a = <div tabIndex={0} />; const b = x - 1;')).toHaveLength(0);
  });

  it('the start of the page a leaving notice hands focus to draws no ring', () => {
    const rule = rules.find((r) => r.selectors.includes('body.app-slava-restraint [data-focus-start]:focus-visible'));
    expect(rule, 'the focus-start rule').toBeTruthy();
    const raw = slava.slice(slava.indexOf('body.app-slava-restraint [data-focus-start]:focus-visible'));
    expect(raw.slice(0, raw.indexOf('}'))).toMatch(/outline:\s*none\s*!important;/);
  });

  it('the Try again ring hugs the words, and a gap as wide as the ring keeps it off the full stop', () => {
    const base = rules.find((r) => r.selectors.includes('body.app-slava-restraint .commons-retry') && decl(r, 'margin-inline-end'));
    const ring = rules.find((r) => r.selectors.includes('body.app-slava-restraint .commons-retry:focus-visible'));
    expect(ring && decl(ring, 'outline-offset')).toBe('0');
    // The panes' own 3px offset (commons-evaluation.css) is outranked there too.
    expect(ring!.selectors).toContain('body.app-slava-restraint .commons-view .commons-evaluation .commons-retry:focus-visible');
    const width = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(slava.slice(slava.indexOf('--sr-focus-outline:')))![1]);
    expect(Number.parseFloat(decl(base!, 'margin-inline-end') ?? '0')).toBeGreaterThanOrEqual(width);
  });

  it('the handover only ever focuses a heading or a line', () => {
    const hook = readFileSync(join(SRC, 'hooks/useFocusHandover.ts'), 'utf8');
    // Its targets: the control come back (the person's own, ring kept), a line, or the heading.
    // Round 18h: a line in its place, else the heading at once (never <body>).
    expect(hook).toMatch(/const line = inPlace \|\| origin \? null : nearestLine\(was, scope\);/);
    expect(hook).toMatch(/const head = heading\(\);/);
    expect(hook.match(/\.focus\(/g)).toHaveLength(2);
    expect(hook).toMatch(/const LINE = `\[\$\{FOCUS_LINE_ATTR\}\]`;/);
  });
});
