import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';

/**
 * Review 10, M-1: what the app's own stylesheets declare for an element,
 * resolved the way the browser cascades them, so a test can say a modal looks
 * the same wherever it renders. jsdom's getComputedStyle can't: it drops any
 * shorthand that holds a var() ("border: 1px solid var(--sr-edge)") and
 * mis-resolves `font: inherit`. This reads every .css file under src/ with
 * postcss, matches each selector with the element's own `matches`, and keeps
 * the winning value per property (importance, specificity, source order).
 * Interaction states (:hover, :focus, :focus-visible, :focus-within,
 * :active) and pseudo-elements are kept apart in the key
 * (":focus-visible|outline", "::placeholder|color"), so a focus ring is
 * checked without focusing anything. Inherited properties and custom
 * properties come from the nearest ancestor that sets them, as in CSS.
 */

const SRC = join(__dirname, '..', '..', 'src');
const STATES = new Set([':hover', ':focus', ':focus-visible', ':focus-within', ':active']);
const INHERITED = new Set([
  'color', 'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-stretch',
  'font-feature-settings', 'font-variant-numeric', 'font-kerning', 'line-height', 'letter-spacing', 'word-spacing',
  'text-transform', 'text-align', 'text-indent', 'text-shadow', 'text-rendering', 'white-space', 'word-break',
  'overflow-wrap', 'hyphens', 'tab-size', 'visibility', 'cursor', 'direction', 'list-style', 'list-style-type',
  'list-style-position', 'quotes', 'caret-color', 'accent-color', 'color-scheme', 'pointer-events',
  '-webkit-font-smoothing', '-moz-osx-font-smoothing',
]);

export interface SheetRule {
  file: string;
  selector: string;
  /** The selector without its interaction states and pseudo-element: what `matches` tests. */
  base: string;
  /** ":focus-visible", "::placeholder", "" for the element at rest. */
  state: string;
  /** `base` without attribute selectors or :not(): every state the element
   * can take ([data-open], [aria-expanded="true"] …), for a check that has
   * to see them all (review 12 NIT-2, the frame ratchet). */
  loose: string;
  specificity: [number, number, number];
  order: number;
  decls: Array<{ prop: string; value: string; important: boolean }>;
  /** The @media queries the rule sits in, outermost first (none: it always applies). */
  media: string[];
  /** The @container conditions the rule sits in, outermost first ("name (width < 970px)"). */
  container: string[];
  /** A class the element must carry for the rule to match it (one of its subject's own
   *  classes, outside any pseudo), or null: what the index looks rules up by. */
  key: string | null;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

type Specificity = [number, number, number];
const most = (all: Specificity[]): Specificity => all.reduce((best, next) => (next[0] > best[0] || (next[0] === best[0] && (next[1] > best[1]
  || (next[1] === best[1] && next[2] > best[2])))) ? next : best, [0, 0, 0] as Specificity);
/** The four pseudo-elements CSS 2 wrote with one colon: still pseudo-elements, counted as types. */
const LEGACY_ELEMENTS = new Set([':before', ':after', ':first-line', ':first-letter']);

/** The most specific selector of an `An+B of S` argument's S, or none (Selectors 4, 16). */
function ofListSpecificity(node: selectorParser.Pseudo): Specificity | null {
  const of = /^\s*[^]*?\bof\s+([^]+)$/i.exec(node.nodes.map(String).join(','));
  if (!of) return null;
  let out: Specificity = [0, 0, 0];
  selectorParser((root) => { out = most(root.nodes.map(specificityOf)); }).processSync(of[1]);
  return out;
}

function specificityOf(selector: selectorParser.Selector): [number, number, number] {
  let a = 0; let b = 0; let c = 0;
  // The selector's own nodes, one by one (the fix from PR #204 round 13, brought here by
  // fix/moodboard-board-layout: a walk() that returned false at an :is(), :not() or :where()
  // ended the whole walk, so nothing after it counted, and `.a:where(.b) .c` read (0,1,0)).
  // Combinators sit between the compounds in `nodes`; a pseudo's arguments are read only
  // where they count.
  for (const node of selector.nodes) {
    if (node.type === 'id') a += 1;
    else if (node.type === 'class' || node.type === 'attribute') b += 1;
    else if (node.type === 'tag' && node.value !== '*') c += 1;
    else if (node.type === 'pseudo') {
      const name = node.value.toLowerCase();
      // Round 17 (review 12 NIT-4, review 13 NIT-2), against Selectors Level 4 section 16: a
      // pseudo-element counts as a type, the CSS 2 one-colon forms too (`a:before` is (0,0,2)).
      if (name.startsWith('::') || LEGACY_ELEMENTS.has(name)) c += 1;
      else if (name === ':where') continue;
      else if ([':not', ':is', ':has'].includes(name)) {
        const max = most(node.nodes.map(specificityOf));
        a += max[0]; b += max[1]; c += max[2];
      } else {
        // `:nth-child(An+B of S)` and `:nth-last-child(An+B of S)`: the pseudo-class, plus the most
        // specific selector of S (`li:nth-child(2 of .x, #y)` is (1,1,1)).
        b += 1;
        const of = name === ':nth-child' || name === ':nth-last-child' ? ofListSpecificity(node) : null;
        if (of) { a += of[0]; b += of[1]; c += of[2]; }
      }
    }
  }
  return [a, b, c];
}

/** One selector's specificity, as the cascade here counts it (tests/studioGridAreas.test.ts checks it). */
/** Attributes that mark a line, not a state a control takes (see `loose` below). */
const LINE_MARKS = new Set(['data-line-because', 'data-line-neutral']);

export function selectorSpecificity(selector: string): [number, number, number] {
  let out: [number, number, number] = [0, 0, 0];
  selectorParser((root) => { out = specificityOf(root.first); }).processSync(selector);
  return out;
}

/** A viewport for the @media blocks: a rule inside one applies only where its query holds. */
export interface Viewport { width: number; height: number }

/** Whether a media query list holds at `viewport` on a screen with no preference set (no
 * reduced motion, no forced colours, a fine pointer that hovers). A feature this doesn't know
 * reads as not holding. */
export function mediaMatches(params: string, viewport: Viewport): boolean {
  return params.split(',').some((part) => {
    let query = part.trim().toLowerCase();
    if (query.startsWith('not ')) return false;
    query = query.replace(/^only\s+/, '');
    const conditions = query.split(/\s+and\s+/);
    return conditions.every((condition) => {
      if (condition === 'screen' || condition === 'all') return true;
      const feature = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(condition);
      if (!feature) return false;
      const [, name, raw = ''] = feature;
      const px = /^(\d+(?:\.\d+)?)px$/.exec(raw.trim());
      switch (name) {
        case 'min-width': return Boolean(px) && viewport.width >= Number(px![1]);
        case 'max-width': return Boolean(px) && viewport.width <= Number(px![1]);
        case 'min-height': return Boolean(px) && viewport.height >= Number(px![1]);
        case 'max-height': return Boolean(px) && viewport.height <= Number(px![1]);
        case 'prefers-reduced-motion': return raw.trim() === 'no-preference';
        case 'forced-colors': return raw.trim() === 'none';
        case 'hover': return raw.trim() === 'hover';
        case 'pointer': return raw.trim() === 'fine';
        default: return false;
      }
    });
  });
}

/** A `<length>` in px, or a calc() that adds and subtracts px ("calc(250px + 400px + 320px)"); NaN otherwise. */
export function pxLength(raw: string): number {
  const text = raw.trim();
  const calc = /^calc\((.*)\)$/.exec(text);
  const body = calc ? calc[1] : text;
  const terms = body.trim().split(/\s+([+-])\s+/);
  let total = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const px = /^(-?\d+(?:\.\d+)?)px$/.exec(terms[i].trim());
    if (!px || (!calc && terms.length > 1)) return NaN;
    total += (i > 0 && terms[i - 1] === '-' ? -1 : 1) * Number(px[1]);
  }
  return total;
}

/** An @container prelude: the container's name (if it names one) and its width condition. */
export function containerParts(prelude: string): { name: string | null; condition: string } {
  const match = /^\s*([a-zA-Z_][\w-]*)?\s*(\(.*\))\s*$/.exec(prelude);
  return match ? { name: match[1] ?? null, condition: match[2] } : { name: null, condition: prelude };
}

/** An @container condition's width tests: `width < N`-style ranges and min-/max-width, as
 * [operator, px]; null when a part is anything else (height, style queries, `or`, `not`). */
function widthTests(prelude: string): Array<[string, number]> | null {
  const { condition } = containerParts(prelude);
  const tests: Array<[string, number]> = [];
  for (const part of condition.split(/\s+and\s+/)) {
    const inner = /^\((.*)\)$/.exec(part.trim())?.[1].trim() ?? '';
    const range = /^(?:inline-size|width)\s*(<=|>=|<|>)\s*(.+)$/.exec(inner);
    const minmax = /^(min|max)-(?:inline-size|width)\s*:\s*(.+)$/.exec(inner);
    const n = pxLength((range ?? minmax)?.[2] ?? '');
    if (Number.isNaN(n)) return null;
    tests.push([range ? range[1] : minmax![1] === 'min' ? '>=' : '<=', n]);
  }
  return tests;
}

/** Whether an @container width condition holds for a container `width` px wide. Anything
 * else (height, style queries, `or`, `not`) reads as not holding. */
export function containerMatches(prelude: string, width: number): boolean {
  const tests = widthTests(prelude);
  return tests !== null && tests.every(([op, n]) => (op === '<' ? width < n : op === '<=' ? width <= n : op === '>' ? width > n : width >= n));
}

/** The widths an @container condition turns at: the first whole px on its upper side (for
 * `width < N`, N: N-1 and N are its two sides). */
export function containerBreakpoints(prelude: string): number[] {
  return (widthTests(prelude) ?? []).map(([op, n]) => (op === '<' || op === '>=' ? n : n + 1));
}

let cached: SheetRule[] | null = null;

/** The style rules of one stylesheet, once per selector in its list, ordered from `order`. */
function rulesOf(css: string, file: string, order: { next: number }, from?: string): SheetRule[] {
  const rules: SheetRule[] = [];
  const root = postcss.parse(css, from ? { from } : undefined);
  root.walkRules((rule: Rule) => {
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      if (parent.type === 'atrule' && /keyframes|font-face/.test((parent as AtRule).name)) return;
      // A forced-colors block is a mode of its own (GM PR #205 r8 item 4): the
      // cascade here is the normal one; tests read that block on its own.
      if (parent.type === 'atrule' && (parent as AtRule).name === 'media' && /forced-colors\s*:\s*active/.test((parent as AtRule).params)) return;
    }
    const media: string[] = [];
    const container: string[] = [];
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      if (parent.type === 'atrule' && (parent as AtRule).name === 'media') media.unshift((parent as AtRule).params);
      if (parent.type === 'atrule' && (parent as AtRule).name === 'container') container.unshift((parent as AtRule).params);
    }
    const decls = rule.nodes.flatMap((node) => node.type === 'decl'
      ? [{ prop: node.prop.toLowerCase(), value: node.value.replace(/\s+/g, ' ').trim(), important: Boolean(node.important) }]
      : []);
    if (decls.length === 0) return;
    order.next += 1;
    for (const selector of rule.selectors) {
      let state = '';
      let base = selector;
      let specificity: [number, number, number] = [0, 0, 0];
      let key: string | null = null;
      try {
        selectorParser((root) => {
          const sel = root.first;
          specificity = specificityOf(sel);
          const states: string[] = [];
          sel.walkPseudos((pseudo) => {
            const insideNot = pseudo.parent?.parent?.type === 'pseudo';
            if (pseudo.value.startsWith('::') || pseudo.value === ':before' || pseudo.value === ':after') {
              states.push(pseudo.value);
              pseudo.remove();
            } else if (STATES.has(pseudo.value)) {
              if (insideNot) {
                // ":not(:hover)": may match, so the whole :not goes.
                pseudo.parent?.parent?.remove();
              } else {
                states.push(pseudo.value);
                pseudo.remove();
              }
            }
          });
          state = states.join('');
          // The subject: the compound after the last combinator. Any class written
          // there directly (not inside :is(), :not() …) is one the element must carry.
          let at = sel.nodes.length - 1;
          while (at >= 0 && sel.nodes[at].type !== 'combinator') at -= 1;
          for (const node of sel.nodes.slice(at + 1)) if (node.type === 'class') key = node.value;
          base = sel.toString().trim() || '*';
          if (/[\s>+~]$/.test(base)) base = `${base}*`;
        }).processSync(selector);
      } catch {
        continue;
      }
      let loose = base;
      try {
        selectorParser((root) => {
          // PR #204 round 11: `data-line-because` marks a line's words (components/LineText), not
          // a state a control takes, so a rule for it reaches only an element that carries it:
          // the because sheet's sans face (styles/becauseLine.css) isn't a pin edge's own font.
          // Round 18 (GM r28 1): `data-line-neutral` marks a Commons load line's box the same way.
          root.walkAttributes((attribute) => { if (!LINE_MARKS.has(attribute.attribute)) attribute.remove(); });
          root.walkPseudos((pseudo) => { if (pseudo.value === ':not') pseudo.remove(); });
          // A compound left empty ("> [data-x]") matches anything: "*".
          root.each((sel) => {
            let empty = true;
            for (const node of [...sel.nodes]) {
              if (node.type === 'combinator') {
                if (empty) sel.insertBefore(node, selectorParser.universal());
                empty = true;
              } else if (node.type !== 'comment') empty = false;
            }
            if (empty) sel.append(selectorParser.universal());
          });
          loose = root.toString().trim() || '*';
        }).processSync(base);
      } catch {
        loose = base;
      }
      rules.push({ file, selector, base, state, loose, specificity, order: order.next, decls, media, container, key });
    }
  });
  return rules;
}

/**
 * Every style rule in the app's stylesheets, once per selector in its list.
 *
 * Order across files is an approximation: sheets are read in alphabetical
 * order of their path under src/, not the order the bundle loads them in
 * (import and chunk order). Within one sheet, order is the sheet's own. A
 * check whose answer turns on two files' order has to say so (the studio
 * grid ratchet fails on such a tie: tests/studioGridAreas.test.ts).
 */
export function appRules(): SheetRule[] {
  if (cached) return cached;
  const order = { next: 0 };
  cached = cssFiles(SRC).sort().flatMap((path) => rulesOf(readFileSync(path, 'utf8'), relative(SRC, path), order, path));
  return cached;
}

/** Rules parsed from `css` as one sheet named `file` (for the helper's own tests). */
export function parseRules(css: string, file = 'test.css'): SheetRule[] {
  return rulesOf(css, file, { next: 0 });
}

export interface RuleIndex { byClass: Map<string, SheetRule[]>; rest: SheetRule[]; position: Map<SheetRule, number> }

/** `rules` by a class each one's subject requires (none: `rest`), with each rule's place in `rules`. */
export function indexRules(rules: SheetRule[]): RuleIndex {
  const byClass = new Map<string, SheetRule[]>();
  const rest: SheetRule[] = [];
  const position = new Map<SheetRule, number>();
  rules.forEach((rule, at) => {
    position.set(rule, at);
    if (!rule.key) { rest.push(rule); return; }
    const bucket = byClass.get(rule.key);
    if (bucket) bucket.push(rule); else byClass.set(rule.key, [rule]);
  });
  return { byClass, rest, position };
}

/**
 * The rules of `index` that can match `element`, in their sheet order (as a
 * full scan meets them, so a tie between two selectors of one rule goes the
 * same way). The class lookup is an exact string match, which is how a
 * no-quirks document matches classes (case-sensitive); the tests check the
 * document is one.
 */
export function candidatesIn(index: RuleIndex, element: Element): SheetRule[] {
  const out = [...index.rest];
  for (const cls of new Set(element.classList)) out.push(...(index.byClass.get(cls) ?? []));
  return out.sort((a, b) => index.position.get(a)! - index.position.get(b)!);
}

let index: RuleIndex | null = null;

/**
 * The app's rules that can match `element`: those whose subject requires a
 * class the element carries, and those that require none. Built once; a
 * cascade then tests a few dozen selectors, not every rule in the app
 * (fix/moodboard-board-layout: the studio grid ratchet ran past CI's 5 s per
 * test when each cascade walked all of them).
 */
export function candidateRules(element: Element): SheetRule[] {
  index ??= indexRules(appRules());
  return candidatesIn(index, element);
}

export function wins(a: { important: boolean; specificity: [number, number, number]; order: number },
  b: { important: boolean; specificity: [number, number, number]; order: number }): boolean {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i += 1) if (a.specificity[i] !== b.specificity[i]) return a.specificity[i] > b.specificity[i];
  return a.order >= b.order;
}

/**
 * The query container an @container rule on `element` reads: its nearest
 * ancestor that the app's sheets make an inline-size (or size) container,
 * with that name when the rule names one. Null when there is none, and the
 * rule then never applies, as in a browser.
 */
export function queryContainer(element: Element, name: string | null, viewport: Viewport, extraCss?: string): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const own = cascaded(parent, extraCss, { viewport });
    const short = own.get('|container')?.value;
    const [names = '', type = 'normal'] = short ? short.split('/').map((part) => part.trim()) : [];
    const typeOf = (own.get('|container-type')?.value ?? (short ? type : 'normal')).trim();
    const namesOf = (own.get('|container-name')?.value ?? names).split(/\s+/).filter(Boolean);
    if (!/^(inline-size|size)$/.test(typeOf)) continue;
    if (name && !namesOf.includes(name)) continue;
    return parent;
  }
  return null;
}

/**
 * Whether a rule's @media and @container conditions hold for `element` at
 * `viewport`. A container's width is taken as the viewport's: the studio
 * roots that are containers are `position: fixed; inset: 0` (the studio grid
 * ratchet checks the Board root is), so they are exactly the window wide.
 */
function applies(rule: SheetRule, element: Element, viewport: Viewport, extraCss?: string): boolean {
  if (!rule.media.every((query) => mediaMatches(query, viewport))) return false;
  return rule.container.every((prelude) => queryContainer(element, containerParts(prelude).name, viewport, extraCss) !== null
    && containerMatches(prelude, viewport.width));
}

export type Winner = { value: string; important: boolean; specificity: [number, number, number]; order: number; selector: string; file: string };

/** The rules that match `element` (any state), with the winning declaration per state|property. */
export function cascaded(element: Element, extraCss?: string,
  { loose = false, viewport }: { loose?: boolean; viewport?: Viewport } = {}): Map<string, Winner> {
  const out = new Map<string, Winner>();
  // A test's own stylesheet comes after the app's, as a later sheet would.
  const extra = extraCss ? rulesOf(extraCss, 'extra.css', { next: appRules().length + 1 }) : [];
  for (const rule of [...candidateRules(element), ...extra]) {
    // With a viewport, a rule in an @media block applies only where its query holds; without
    // one, every rule counts, as before.
    if (viewport && !applies(rule, element, viewport, extraCss)) continue;
    let hit = false;
    try { hit = element.matches(loose ? rule.loose : rule.base); } catch { hit = false; }
    if (!hit) continue;
    for (const decl of rule.decls) {
      const key = `${rule.state}|${decl.prop}`;
      const next = { value: decl.value, important: decl.important, specificity: rule.specificity, order: rule.order, selector: rule.selector, file: rule.file };
      const prev = out.get(key);
      if (!prev || wins(next, prev)) out.set(key, next);
    }
  }
  const inline = (element as HTMLElement).style;
  if (inline) {
    for (let i = 0; i < inline.length; i += 1) {
      const prop = inline[i];
      out.set(`|${prop}`, { value: inline.getPropertyValue(prop), important: true, specificity: [1, 0, 0], order: Infinity, selector: 'style=""', file: 'inline' });
    }
  }
  return out;
}

/**
 * Every declaration of `prop` the app's stylesheets (or `rules`, for the
 * helper's own tests) give `element` at rest (no state), in cascade order,
 * winner last.
 */
export function declarationsOf(element: Element, prop: string,
  { viewport, rules }: { viewport?: Viewport; rules?: SheetRule[] } = {}): Winner[] {
  const out: Winner[] = [];
  for (const rule of rules ? candidatesIn(indexRules(rules), element) : candidateRules(element)) {
    if (rule.state) continue;
    if (viewport && !applies(rule, element, viewport)) continue;
    let hit = false;
    try { hit = element.matches(rule.base); } catch { hit = false; }
    if (!hit) continue;
    for (const decl of rule.decls) {
      if (decl.prop !== prop) continue;
      out.push({ value: decl.value, important: decl.important, specificity: rule.specificity, order: rule.order, selector: rule.selector, file: rule.file });
    }
  }
  return out.sort((a, b) => (wins(a, b) ? 1 : -1));
}

/** Every property the app's stylesheets give `element`, its own and those it inherits ("|color": "var(--sr-ink)"). */
export function resolvedStyle(element: Element): Record<string, string> {
  const own = cascaded(element);
  const result: Record<string, string> = {};
  for (const [key, winner] of own) result[key] = winner.value;
  // Inherited and custom properties at rest: from the nearest ancestor that sets them.
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    for (const [key, winner] of cascaded(parent)) {
      if (!key.startsWith('|')) continue;
      const prop = key.slice(1);
      if (!(INHERITED.has(prop) || prop.startsWith('--')) || key in result) continue;
      result[key] = winner.value;
    }
  }
  return result;
}

/** The resolved style of `root` and of every element inside it, in document order. */
export function subtreeStyles(root: Element): Array<{ path: string; style: Record<string, string> }> {
  return [root, ...root.querySelectorAll('*')].map((element) => ({
    path: `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string'
      ? `.${element.className.trim().split(/\s+/).join('.')}` : ''}`,
    style: resolvedStyle(element),
  }));
}

/**
 * The same subtree's styles in two places: where it renders now and, moved
 * there for the measurement and put back, under `elsewhere` (where it used to
 * render). Differences, by element and property.
 */
export function styleDifferences(root: Element, elsewhere: Element): string[] {
  const here = subtreeStyles(root);
  const parent = root.parentNode!;
  const next = root.nextSibling;
  elsewhere.appendChild(root);
  const there = subtreeStyles(root);
  parent.insertBefore(root, next);
  // A custom property counts only if something in the subtree reads it
  // (--commons-detail-w sizes the Commons view's own grid, never its prompt).
  const read = new Set<string>();
  for (const { style } of [...here, ...there]) {
    for (const value of Object.values(style)) for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) read.add(match[1]);
  }
  const counts = (key: string) => !key.startsWith('|--') || read.has(key.slice(1));
  const diffs: string[] = [];
  here.forEach(({ path, style }, index) => {
    const before = there[index].style;
    for (const key of new Set([...Object.keys(style), ...Object.keys(before)])) {
      if (counts(key) && style[key] !== before[key]) diffs.push(`${path} ${key}: was ${before[key] ?? '(none)'}, now ${style[key] ?? '(none)'}`);
    }
  });
  return diffs;
}
