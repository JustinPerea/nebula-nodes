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

interface SheetRule {
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
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

function specificityOf(selector: selectorParser.Selector): [number, number, number] {
  let a = 0; let b = 0; let c = 0;
  selector.walk((node) => {
    if (node.type === 'id') a += 1;
    else if (node.type === 'class' || node.type === 'attribute') b += 1;
    else if (node.type === 'tag' && node.value !== '*') c += 1;
    else if (node.type === 'pseudo') {
      if (node.value.startsWith('::')) c += 1;
      else if (node.value === ':where') return false;
      else if ([':not', ':is', ':has'].includes(node.value)) {
        const inner = node.nodes.map(specificityOf);
        const max = inner.reduce((best, next) => (next[0] > best[0] || (next[0] === best[0] && (next[1] > best[1]
          || (next[1] === best[1] && next[2] > best[2])))) ? next : best, [0, 0, 0] as [number, number, number]);
        a += max[0]; b += max[1]; c += max[2];
        return false;
      } else b += 1;
    }
    return undefined;
  });
  return [a, b, c];
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
    const decls = rule.nodes.flatMap((node) => node.type === 'decl'
      ? [{ prop: node.prop.toLowerCase(), value: node.value.replace(/\s+/g, ' ').trim(), important: Boolean(node.important) }]
      : []);
    if (decls.length === 0) return;
    order.next += 1;
    for (const selector of rule.selectors) {
      let state = '';
      let base = selector;
      let specificity: [number, number, number] = [0, 0, 0];
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
          base = sel.toString().trim() || '*';
          if (/[\s>+~]$/.test(base)) base = `${base}*`;
        }).processSync(selector);
      } catch {
        continue;
      }
      let loose = base;
      try {
        selectorParser((root) => {
          root.walkAttributes((attribute) => { attribute.remove(); });
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
      rules.push({ file, selector, base, state, loose, specificity, order: order.next, decls });
    }
  });
  return rules;
}

/** Every style rule in the app's stylesheets, once per selector in its list. */
export function appRules(): SheetRule[] {
  if (cached) return cached;
  const order = { next: 0 };
  cached = cssFiles(SRC).sort().flatMap((path) => rulesOf(readFileSync(path, 'utf8'), relative(SRC, path), order, path));
  return cached;
}

function wins(a: { important: boolean; specificity: [number, number, number]; order: number },
  b: { important: boolean; specificity: [number, number, number]; order: number }): boolean {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i += 1) if (a.specificity[i] !== b.specificity[i]) return a.specificity[i] > b.specificity[i];
  return a.order >= b.order;
}

type Winner = { value: string; important: boolean; specificity: [number, number, number]; order: number; selector: string };

/** The rules that match `element` (any state), with the winning declaration per state|property. */
export function cascaded(element: Element, extraCss?: string, { loose = false }: { loose?: boolean } = {}): Map<string, Winner> {
  const out = new Map<string, Winner>();
  // A test's own stylesheet comes after the app's, as a later sheet would.
  const extra = extraCss ? rulesOf(extraCss, 'extra.css', { next: appRules().length + 1 }) : [];
  for (const rule of [...appRules(), ...extra]) {
    let hit = false;
    try { hit = element.matches(loose ? rule.loose : rule.base); } catch { hit = false; }
    if (!hit) continue;
    for (const decl of rule.decls) {
      const key = `${rule.state}|${decl.prop}`;
      const next = { value: decl.value, important: decl.important, specificity: rule.specificity, order: rule.order, selector: rule.selector };
      const prev = out.get(key);
      if (!prev || wins(next, prev)) out.set(key, next);
    }
  }
  const inline = (element as HTMLElement).style;
  if (inline) {
    for (let i = 0; i < inline.length; i += 1) {
      const prop = inline[i];
      out.set(`|${prop}`, { value: inline.getPropertyValue(prop), important: true, specificity: [1, 0, 0], order: Infinity, selector: 'style=""' });
    }
  }
  return out;
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
