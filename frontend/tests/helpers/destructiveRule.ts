import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import postcss, { type AtRule, type Container, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { cascaded } from './cssCascade';

/**
 * GM r13 and r14's rule for red, enforced by what controls say and do, not
 * how they're named (fix rounds 9 and 10 of PR #200, reviews 8 LOW-2 and 9
 * LOW-4):
 * - Red: it deletes a standalone thing (project, node, asset, result, agent, API key, app token), or wipes a whole surface (Clear, Purge, Discard). Undo doesn't change this (node Delete stays red).
 * - Neutral: it takes an item out of a list inside the thing you're editing (chips, swatches, tags, a shot in a scene, an item on a board, a character view).
 * GM r16: Krea Disconnect is red; an agent's Sign out, Resets and Erase are neutral.
 *
 * A control is found by its words (aria-label, title, visible text, an
 * input's value; any case, anywhere in the label; i18n keys read as words)
 * on a button, a Button, IconButton or MenuItem, an `input type=button`,
 * role="button", or anything with an onClick, toggles included. Its words
 * say its kind first (wordKind): a red word (Delete, Discard, Disconnect …)
 * on a neutral class fails unless it's a reviewed exception (Clear search);
 * a neutral word (Reset, Erase, Sign out) on a red class fails. "Remove" says
 * neither (a chip's × and an agent's Remove both say it), so its class
 * decides. The class must say the kind. The colours are then checked twice:
 * every rule whose element carries a kind class, focus rules included (all
 * but their outline and box-shadow ring), and, per control, the rule that
 * wins the cascade at rest, on hover, pressed and focused, built with its JSX
 * ancestors, its colour inherited from them when it sets none.
 */

const SRC = join(__dirname, '..', '..', 'src');

/** The words that make a control an action worth a kind. */
export const ACTION_WORD = /\b(?:delet(?:e|es|ed|ing)|clear(?:s|ed|ing)?|discard(?:s|ed|ing)?|purg(?:e|es|ed|ing)|trash(?:es|ed|ing)?|remov(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|empty|revok(?:e|es|ed|ing)|forget|wip(?:e|es|ed|ing)|reset(?:s|ting)?|uninstall(?:s|ed|ing)?|disconnect(?:s|ed|ing)?|sign out)\b/i;
const RED_SAYS = /\b(?:delet(?:e|es|ed|ing)|clear(?:s|ed|ing)?|discard(?:s|ed|ing)?|purg(?:e|es|ed|ing)|trash(?:es|ed|ing)?|empty|revok(?:e|es|ed|ing)|forget|wip(?:e|es|ed|ing)|uninstall(?:s|ed|ing)?|disconnect(?:s|ed|ing)?)\b/i;
const NEUTRAL_SAYS = /\b(?:reset(?:s|ting)?|eras(?:e|es|ed|ing)|sign out)\b/i;
/**
 * Red words on a control GM's rule makes neutral (GM r14: an edit inside the
 * thing): a search or a filter cleared, and the comparison emptied. Each was
 * reviewed; a new one is a finding until it is added here.
 */
export const REVIEWED_NEUTRAL: Array<{ file?: string; name: RegExp }> = [
  { name: /^\s*clear (?:the )?(?:search|filters?|selection)\b/i },
  { file: 'components/commons/CommonsFilters.tsx', name: /^clear$/ },
  { file: 'components/create-studio/ResultsGallery.tsx', name: /^Clear$/ },
];

const RED_WORDS = 'danger|destructive|delete|purge|trash|discard|clear|wipe|revoke|forget|bin|disconnect|uninstall';
// `--neutral` declares the kind where no word fits (an agent's Sign out, GM r16 answer 1).
const NEUTRAL_WORDS = 'remove|reset|erase|neutral';
const RED_CLASS = new RegExp(`(?:^|[_-])(?:${RED_WORDS})$`, 'i');
const NEUTRAL_CLASS = new RegExp(`(?:^|[_-])(?:${NEUTRAL_WORDS})$`, 'i');

export type Kind = 'red' | 'neutral';

/** The kind a set of class names declares (red wins if both). */
export function kindOf(classes: readonly string[]): Kind | null {
  if (classes.some((name) => RED_CLASS.test(name))) return 'red';
  if (classes.some((name) => NEUTRAL_CLASS.test(name))) return 'neutral';
  return null;
}

/** The kind a control's words say, if they say one ("Remove" says neither). */
export function wordKind(name: string, file?: string): Kind | null {
  if (REVIEWED_NEUTRAL.some((r) => (!r.file || r.file === file) && r.name.test(name))) return 'neutral';
  if (RED_SAYS.test(name)) return 'red';
  if (NEUTRAL_SAYS.test(name)) return 'neutral';
  return null;
}

/** A control whose class kind contradicts its words (review 9 LOW-4: `<button className="x__remove">Delete project</button>`). */
export function wordFindings(control: Control): string[] {
  const says = wordKind(control.name, control.file);
  if (!says || !control.kind || says === control.kind) return [];
  return [`${control.file}:${control.line} "${control.name}" says ${says} but its class says ${control.kind}`];
}

// ---------------------------------------------------------------- colours

/** Each danger token and the only fallbacks it may carry (styles/disabled-buttons.css). */
const DANGER_TOKENS: Record<string, string[]> = {
  '--sr-danger-ink': ['#ff887d'], '--sr-danger-ink-hover': ['#ff9a91'],
  '--sr-danger-fill': ['#ff887d'], '--sr-danger-fill-hover': ['#ff9a91'],
  '--sr-danger-tint': ['rgba(255,70,60,0.14)'], '--sr-danger-edge': ['rgba(255,70,60,0.34)'],
  '--sr-on-danger': ['#1f1f1f'],
};
/** The orange: the accent in every variant, the error ink, and the bare --sr-danger alias and its relatives. */
const ORANGE_VAR = /^--sr-(?:accent|error)(?:-[\w-]+)?$|^--sr-danger(?:-(?!(?:ink|ink-hover|fill|fill-hover|tint|edge)$)[\w-]+)?$/;
const WARM_NAMES = /\b(red|darkred|firebrick|crimson|indianred|tomato|orangered|orange|darkorange|coral|lightcoral|salmon|darksalmon|lightsalmon|maroon|brown)\b/i;

function warmRgb(r: number, g: number, b: number): boolean {
  const [R, G, B] = [r, g, b].map((v) => v / 255);
  const max = Math.max(R, G, B); const min = Math.min(R, G, B); const d = max - min;
  if (!d) return false;
  const l = (max + min) / 2; const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return s > 0.35 && (h <= 45 || h >= 340);
}

/** A hue in degrees from a CSS angle (deg, turn, rad, grad, or a bare number). */
function hueOf(part: string): number {
  const n = parseFloat(part);
  const deg = /turn$/i.test(part) ? n * 360 : /grad$/i.test(part) ? n * 0.9 : /rad$/i.test(part) ? (n * 180) / Math.PI : n;
  return ((deg % 360) + 360) % 360;
}
const warmHue = (h: number, upper = 45) => h <= upper || h >= 340;
const parts = (inner: string) => inner.split(/[\s,/]+/).filter(Boolean);
const pct = (part: string, scale = 1) => (part.endsWith('%') ? (parseFloat(part) / 100) * scale : parseFloat(part));

/** The literal red or orange colours in a value (hex, rgb, hsl, hwb, lab, lch, oklab, oklch, color(), named). */
export function warmColours(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    const hex = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1].slice(0, 6);
    if (warmRgb(...([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]))) out.push(m[0]);
  }
  for (const m of value.matchAll(/rgba?\(([^)]*)\)/gi)) {
    const [r, g, b] = parts(m[1]).slice(0, 3).map((part) => (part.endsWith('%') ? parseFloat(part) * 2.55 : Number(part)));
    if (warmRgb(r, g, b)) out.push(m[0]);
  }
  for (const m of value.matchAll(/hsla?\(([^)]*)\)/gi)) {
    const [h, s] = parts(m[1]);
    if (parseFloat(s) > 35 && warmHue(hueOf(h))) out.push(m[0]);
  }
  for (const m of value.matchAll(/hwb\(([^)]*)\)/gi)) {
    const [h, w, b] = parts(m[1]);
    if (1 - pct(w) - pct(b) > 0.35 && warmHue(hueOf(h))) out.push(m[0]);
  }
  for (const m of value.matchAll(/\b(ok)?lch\(([^)]*)\)/gi)) {
    const [, c, h] = parts(m[2]);
    const chroma = m[1] ? pct(c, 0.4) : pct(c, 150);
    if (chroma > (m[1] ? 0.08 : 20) && warmHue(hueOf(h), 80)) out.push(m[0]);
  }
  for (const m of value.matchAll(/\b(ok)?lab\(([^)]*)\)/gi)) {
    const [, a, b] = parts(m[2]).map((part) => pct(part, m[1] ? 0.4 : 125));
    const chroma = Math.hypot(a, b);
    const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    if (chroma > (m[1] ? 0.08 : 20) && warmHue(h, 80)) out.push(m[0]);
  }
  for (const m of value.matchAll(/color\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020)\s+([^)]*)\)/gi)) {
    const [r, g, b] = parts(m[1]).slice(0, 3).map((part) => pct(part) * 255);
    if (warmRgb(r, g, b)) out.push(m[0]);
  }
  const named = value.replace(/var\([^()]*\)/g, ' ').match(WARM_NAMES);
  if (named) out.push(named[0]);
  return out;
}

/** var(--name, fallback) occurrences, with nested parentheses. */
function varsIn(value: string): Array<{ text: string; name: string; fallback: string | null }> {
  const out: Array<{ text: string; name: string; fallback: string | null }> = [];
  for (let at = value.indexOf('var('); at >= 0; at = value.indexOf('var(', at + 4)) {
    let depth = 0; let end = at + 3;
    for (; end < value.length; end += 1) {
      if (value[end] === '(') depth += 1;
      else if (value[end] === ')') { depth -= 1; if (depth === 0) break; }
    }
    const inner = value.slice(at + 4, end);
    const comma = inner.indexOf(',');
    out.push({ text: value.slice(at, end + 1), name: (comma < 0 ? inner : inner.slice(0, comma)).trim(),
      fallback: comma < 0 ? null : inner.slice(comma + 1).trim() });
    at = end - 3;
  }
  return out;
}

export type Vars = Map<string, string[]>;

/** What in a value breaks the rule for a control of `kind`. */
export function badColours(value: string, kind: Kind, vars: Vars, depth = 0): string[] {
  const bad: string[] = [];
  let rest = value;
  for (const v of varsIn(value)) {
    rest = rest.replace(v.text, ' ');
    if (v.name in DANGER_TOKENS) {
      if (kind === 'neutral') bad.push(v.text);
      else if (v.fallback !== null && !DANGER_TOKENS[v.name].includes(v.fallback.toLowerCase().replace(/\s+/g, ''))) bad.push(v.text);
    } else if (ORANGE_VAR.test(v.name)) {
      bad.push(v.text);
    } else {
      if (depth < 4) for (const definition of vars.get(v.name) ?? []) bad.push(...badColours(definition, kind, vars, depth + 1).map((b) => `${v.name}: ${b}`));
      if (v.fallback) bad.push(...badColours(v.fallback, kind, vars, depth + 1));
    }
  }
  bad.push(...warmColours(rest));
  return bad;
}

/** Every property that can paint a colour (review 9 LOW-4: logical borders, accent-color, -webkit-text-fill-color …). */
const COLOUR_PROPERTY = /color|background|border|outline|shadow|fill|stroke|filter/;
/** A focus ring: the only colour a focus rule may give a control of any kind (the keyboard ring, r17). */
const FOCUS_RING = /^(outline|box-shadow)/;

// ---------------------------------------------------------------- stylesheets

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

export function appCss(): Array<{ file: string; css: string }> {
  return cssFiles(SRC).sort().map((path) => ({ file: relative(SRC, path), css: readFileSync(path, 'utf8') }));
}

/** Every custom property's definitions across the given stylesheets. */
export function customProperties(sheets: Array<{ css: string }>): Vars {
  const vars: Vars = new Map();
  for (const { css } of sheets) {
    postcss.parse(css).walkDecls((decl) => {
      if (!decl.prop.startsWith('--')) return;
      vars.set(decl.prop, [...(vars.get(decl.prop) ?? []), decl.value]);
    });
  }
  return vars;
}

/** A rule's full selectors: nesting resolved (`&__delete` under `.x` is `.x__delete`), and `@scope (.x)`'s `:scope` read as `.x`. */
function fullSelectors(rule: Rule): string[] {
  let own = rule.selectors;
  let parent: Container | undefined = rule.parent as Container | undefined;
  while (parent && parent.type === 'atrule') {
    const at = parent as unknown as AtRule;
    if (at.name === 'scope') {
      const root = (/^\(([^)]*)\)/.exec(at.params.trim())?.[1] ?? '').trim();
      if (root) own = own.map((s) => (s.includes(':scope') ? s.replace(/:scope/g, root) : `${root} ${s}`));
    }
    parent = parent.parent as Container | undefined;
  }
  if (!parent || parent.type !== 'rule') return own;
  const outer = fullSelectors(parent as Rule);
  return outer.flatMap((p) => own.map((s) => (s.includes('&') ? s.replace(/&/g, p) : `${p} ${s}`)));
}

/**
 * The kind of the element a rule paints, and whether the rule is a focus
 * rule. The element is the last compound; one with no class or attribute of
 * its own (`svg`, `span`, `*`) is part of the control before it
 * (`.x__delete:hover svg`), and so is a sibling it paints on its hover
 * (`.x__delete:hover + .label`). A classed descendant is its own control
 * (`.panel--danger .panel__run` is not the panel's).
 */
function targetOf(selector: string): { kind: Kind | null; focus: boolean } {
  let kind: Kind | null = null; let focus = false;
  try {
    selectorParser((root) => {
      const nodes = root.first.nodes;
      // Compounds, last first, each with the combinator that led to it.
      const compounds: Array<{ nodes: selectorParser.Node[]; via: string }> = [];
      let current: selectorParser.Node[] = [];
      for (const node of nodes) {
        if (node.type === 'combinator') { compounds.push({ nodes: current, via: node.value.trim() || ' ' }); current = []; }
        else current.push(node);
      }
      compounds.push({ nodes: current, via: '' });
      const read = (compound: selectorParser.Node[]) => {
        const classes: string[] = []; const attrs: string[] = [];
        for (const node of compound) {
          if (node.type === 'class') classes.push(node.value);
          else if (node.type === 'attribute') attrs.push(`${node.attribute}=${node.value ?? ''}`);
          else if (node.type === 'pseudo') {
            if (/^:focus/.test(node.value)) focus = true;
            if ([':is', ':where'].includes(node.value)) {
              node.walkClasses((c) => { classes.push(c.value); });
              node.walkPseudos((p) => { if (/^:focus/.test(p.value)) focus = true; });
            }
          }
        }
        let found = kindOf(classes);
        if (!found) {
          const words = attrs.join(' ').replace(/[^a-z]+/gi, ' ');
          if (new RegExp(`\\b(${RED_WORDS})\\b`, 'i').test(words)) found = 'red';
          else if (new RegExp(`\\b(${NEUTRAL_WORDS})\\b`, 'i').test(words)) found = 'neutral';
        }
        return { kind: found, own: classes.length + attrs.length > 0 };
      };
      for (let i = compounds.length - 1; i >= 0; i -= 1) {
        const { kind: here, own } = read(compounds[i].nodes);
        if (here) { kind = here; break; }
        const via = i > 0 ? compounds[i - 1].via : '';
        // A bare part of the control, or a sibling it paints: look at the compound before.
        if (i > 0 && (!own || via === '+' || via === '~')) continue;
        break;
      }
    }).processSync(selector);
  } catch { /* an unparsable selector targets nothing we check */ }
  return { kind, focus };
}

/** Every rule whose element declares a kind and whose colours break it. */
export function ruleFindings(css: string, file: string, vars: Vars): string[] {
  const found: string[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule' && /keyframes|font-face/.test((p as AtRule).name)) return;
    }
    for (const selector of fullSelectors(rule)) {
      const { kind, focus } = targetOf(selector);
      if (!kind) continue;
      rule.each((node) => {
        if (node.type !== 'decl' || !COLOUR_PROPERTY.test(node.prop)) return;
        if (focus && FOCUS_RING.test(node.prop)) return;
        const bad = badColours(node.value, kind, vars);
        if (bad.length) found.push(`${file} ${selector.replace(/\s+/g, ' ')} { ${node.prop}: ${bad.join(' ')} } (${kind})`);
      });
    }
  });
  return found;
}

// ---------------------------------------------------------------- controls

export interface Control {
  file: string; line: number; name: string; kind: Kind | null; classes: string[];
  /** A toggle (aria-pressed: a starred model, a selected tool): its accent marks its state, so a neutral one may take it. */
  toggle?: boolean;
  /** The JSX elements around it, outermost first: [tag, classes]. */
  ancestors: Array<[string, string[]]>;
  /** The other JSX elements inside its parent, with what they hold (GM r22
   * Q2, PR #200 fix round 14: a frame near a red control, not only round it). */
  near?: JsxTree[];
}

/** A JSX element as the ratchet builds it: [tag, classes, children]. */
export type JsxTree = [string, string[], JsxTree[]];

const camelWords = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]+/g, ' ');

function strings(node: ts.Node, source: ts.SourceFile, calls = true): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
      // A key read as words: 'actions.delete', and camelCase too (review 11 NIT-4: t("deleteProject")).
      if (KEY_LIKE.test(n.text) || CAMEL_KEY.test(n.text)) out.push(keyWords(n.text));
    }
    else if (ts.isTemplateExpression(n)) out.push(n.head.text + n.templateSpans.map((span) => `…${span.literal.text}`).join(''));
    else if (ts.isJsxText(n)) { if (n.text.trim()) out.push(n.text.trim()); }
    // A nested element's attributes (its className, its own label) aren't the control's words.
    else if (ts.isJsxAttributes(n)) return;
    // i18n read as words: strings.deleteProject, messages.actions.clear (review 9 LOW-4).
    else if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !ts.isCallExpression(n.parent)
      && (ts.isJsxExpression(n.parent) || ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent))) {
      const path = accessPath(n);
      if (path.length) out.push(camelWords(path[path.length - 1]));
      // An object's property (review 10 NIT-4): const L = { del: 'Delete' }; {L.del}; nested and
      // bracketed too (review 11 NIT-4): {L.a.del}, {L["del"]}. Only the whole access, once.
      if (path.length > 1 && !ts.isPropertyAccessExpression(n.parent) && !ts.isElementAccessExpression(n.parent)) {
        out.push(...objectStrings(path[0], path.slice(1), source));
      }
    }
    // A label from a function (review 10 NIT-4): {label()}, {labelFor(x)}; its arguments too (t('actions.delete')).
    // Only a call that is the label itself (its arguments are data, not the
    // label), and only on a button: a clickable card's text is content.
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (calls && ts.isJsxExpression(n.parent)) out.push(...functionStrings(n.expression.text, source));
      n.arguments.forEach((arg) => out.push(...strings(arg, source, false)));
    }
    else if (ts.isIdentifier(n) && ts.isJsxExpression(n.parent)) out.push(...constStrings(n.text, source));
    // Markup from a variable (review 11 NIT-4): dangerouslySetInnerHTML={{ __html: html }}.
    else if (ts.isIdentifier(n) && ts.isPropertyAssignment(n.parent) && n.parent.initializer === n
      && n.parent.name.getText(source) === '__html') out.push(...constStrings(n.text, source));
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The strings a `const name = …` holds (aria-label={label}): in the same file, or in the module it's imported from. */
function constStrings(name: string, source: ts.SourceFile, depth = 0): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer
      && !ts.isArrowFunction(n.initializer) && !ts.isFunctionExpression(n.initializer)) out.push(...strings(n.initializer, source));
    ts.forEachChild(n, visit);
  };
  visit(source);
  if (out.length || depth > 1) return out;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named) || !named.elements.some((e) => e.name.text === name)) continue;
    const spec = statement.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;
    const base = join(SRC, source.fileName, '..', spec);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      try {
        const text = readFileSync(candidate, 'utf8');
        const other = ts.createSourceFile(relative(SRC, candidate), text, ts.ScriptTarget.Latest, true,
          candidate.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        out.push(...constStrings(name, other, depth + 1));
        break;
      } catch { /* not this extension */ }
    }
  }
  return out;
}

/** A string that reads as an i18n key ('actions.delete', 'btn.rm', 'delete_project'). */
const KEY_LIKE = /^[a-z][\w-]*(?:[._][\w-]+)+$/i;
/** A camelCase key ('deleteProject'), review 11 NIT-4. */
const CAMEL_KEY = /^[a-z]+(?:[A-Z][a-z0-9]+)+$/;
/** Short forms a key uses for an action word (review 10 NIT-4: t("btn.rm")). */
const SHORT_FORMS: Record<string, string> = { rm: 'remove', del: 'delete', rmv: 'remove', clr: 'clear', disc: 'disconnect' };
/** A key's words: split on dots, underscores, dashes and case, short forms spelled out. */
function keyWords(key: string): string {
  return camelWords(key).split(/[\s.\-_]+/).filter(Boolean).map((w) => SHORT_FORMS[w.toLowerCase()] ?? w).join(' ');
}

/** A declaration of `name` in `source`, or in the module it's imported from (one hop). */
function declarationsOf(name: string, source: ts.SourceFile, depth = 0): Array<[ts.Node, ts.SourceFile]> {
  const out: Array<[ts.Node, ts.SourceFile]> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) out.push([n.initializer, source]);
    else if (ts.isFunctionDeclaration(n) && n.name?.text === name) out.push([n, source]);
    ts.forEachChild(n, visit);
  };
  visit(source);
  if (out.length || depth > 1) return out;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named) || !named.elements.some((e) => e.name.text === name)) continue;
    const spec = statement.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;
    const base = join(SRC, source.fileName, '..', spec);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      try {
        const text = readFileSync(candidate, 'utf8');
        out.push(...declarationsOf(name, ts.createSourceFile(relative(SRC, candidate), text, ts.ScriptTarget.Latest, true,
          candidate.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS), depth + 1));
        break;
      } catch { /* not this extension */ }
    }
  }
  return out;
}

/** `L.a.del` and `L["a"]["del"]` as ["L", "a", "del"]; [] for anything else (a computed key, a call). */
function accessPath(n: ts.Expression): string[] {
  if (ts.isIdentifier(n)) return [n.text];
  if (ts.isPropertyAccessExpression(n)) { const head = accessPath(n.expression); return head.length ? [...head, n.name.text] : []; }
  if (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression))) {
    const head = accessPath(n.expression);
    return head.length ? [...head, n.argumentExpression.text] : [];
  }
  return [];
}

/** The strings an object's property holds: `const L = { del: 'Delete' }` gives L.del "Delete"; a path goes down nested objects. */
function objectStrings(object: string, path: string | string[], source: ts.SourceFile): string[] {
  const keys = Array.isArray(path) ? path : [path];
  const down = (init: ts.Expression, file: ts.SourceFile, rest: string[]): string[] => {
    if (!rest.length) return strings(init, file);
    if (!ts.isObjectLiteralExpression(init)) return [];
    return init.properties.flatMap((p) => (ts.isPropertyAssignment(p) && p.name.getText(file).replace(/^['"]|['"]$/g, '') === rest[0]
      ? down(p.initializer, file, rest.slice(1)) : []));
  };
  return declarationsOf(object, source).flatMap(([init, file]) => (ts.isExpression(init) ? down(init, file, keys) : []));
}

/** The strings a function returns: `const label = () => 'Delete'`, `function label() { return 'Delete'; }`. */
function functionStrings(name: string, source: ts.SourceFile): string[] {
  return declarationsOf(name, source).flatMap(([decl, file]) => {
    const fn = ts.isArrowFunction(decl) || ts.isFunctionExpression(decl) || ts.isFunctionDeclaration(decl) ? decl : null;
    if (!fn?.body) return [];
    if (!ts.isBlock(fn.body)) return strings(fn.body, file);
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) out.push(...strings(n.expression, file));
      else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  });
}

/**
 * What an icon-only control (no words at all) does, read from its code
 * (review 10 NIT-4): its icons (<Trash2 /> is "Trash") and the handlers it
 * calls (onClick={() => deleteProject(id)} is "delete Project").
 */
/** Icons named for a tool, not its action (review 11 NIT-4: <Eraser /> erases). */
const ICON_WORDS: Record<string, string> = { Eraser: 'Erase', Trash: 'Trash', Delete: 'Delete', Remove: 'Remove' };

function codeWords(open: Opening, source: ts.SourceFile): string[] {
  const out: string[] = [];
  const icons = (n: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const tag = tagOf(n, source);
      if (/^[A-Z]/.test(tag)) {
        const icon = tag.replace(/Icon$|\d+$/g, '');
        out.push(camelWords(ICON_WORDS[icon] ?? icon));
      }
    }
    ts.forEachChild(n, icons);
  };
  childrenOf(open).forEach(icons);
  for (const handler of ['onClick', 'onSelect', 'onMouseDown', 'onPointerDown']) {
    const at = attr(open, handler, source);
    if (!at?.initializer) continue;
    const names = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) out.push(camelWords(n.text));
      else if (ts.isPropertyAccessExpression(n)) { out.push(camelWords(n.name.text)); names(n.expression); return; }
      ts.forEachChild(n, names);
    };
    names(at.initializer);
  }
  return out;
}

/** The identifiers a node reads. */
function namesIn(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => { if (ts.isIdentifier(n)) out.push(n.text); else ts.forEachChild(n, visit); };
  if (ts.isJsxExpression(node) || ts.isJsxAttribute(node)) ts.forEachChild(node, visit);
  else if (ts.isIdentifier(node)) out.push(node.text);
  return out;
}

/** The props a node reads off a `(props) =>` parameter: `props.label` is `label`. */
function propsRead(node: ts.Node, param: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === param) out.push(n.name.text);
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * The component a JSX element sits in: its name, the props its first
 * parameter destructures (or, for `(props) =>`, the parameter's name), and
 * whether it's exported.
 */
function componentOf(node: ts.Node): { component: string; names: Set<string>; param: string | null } | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    const fn = ts.isFunctionDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p) ? p : null;
    if (!fn) continue;
    const first = fn.parameters[0];
    if (!first) return null;
    const component = ts.isFunctionDeclaration(fn) ? fn.name?.text
      : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined;
    if (!component || !/^[A-Z]/.test(component)) return null;
    if (ts.isObjectBindingPattern(first.name)) {
      const names = new Set(first.name.elements.map((e) => (ts.isIdentifier(e.name) ? e.name.text : '')).filter(Boolean));
      return { component, names, param: null };
    }
    if (ts.isIdentifier(first.name)) return { component, names: new Set(), param: first.name.text };
    return null;
  }
  return null;
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function tagOf(node: Opening, source: ts.SourceFile): string {
  return node.tagName.getText(source);
}
function attr(node: Opening, name: string, source: ts.SourceFile): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name);
}
function attrStrings(node: Opening, name: string, source: ts.SourceFile): string[] {
  const a = attr(node, name, source);
  return a?.initializer ? strings(a.initializer, source) : [];
}
function classesOf(node: Opening, source: ts.SourceFile): string[] {
  return [...new Set(attrStrings(node, 'className', source).flatMap((s) => s.split(/[\s…]+/)).filter((c) => /^[\w-]+$/.test(c)))];
}
function childrenOf(open: Opening): readonly ts.JsxChild[] {
  return ts.isJsxOpeningElement(open) && ts.isJsxElement(open.parent) ? open.parent.children : [];
}
/**
 * What a control says: its labels, its value, its text (fragments joined,
 * `<>Del</>ete` is "Delete"). An element that is a control only by its
 * onClick (a span, a card) says only its own text, not its children's
 * controls'.
 */
function wordsOf(open: Opening, source: ts.SourceFile, direct = false): string[] {
  const children = childrenOf(open).filter((child) => !direct || ts.isJsxText(child) || ts.isJsxExpression(child) || ts.isJsxFragment(child));
  const texts = children.flatMap((child) => strings(child, source, !direct));
  // Markup set as HTML (review 10 NIT-4): its text, tags dropped.
  const html = attrStrings(open, 'dangerouslySetInnerHTML', source).map((h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  return [...attrStrings(open, 'aria-label', source), ...attrStrings(open, 'title', source), ...attrStrings(open, 'value', source),
    ...attrStrings(open, 'label', source), ...html, texts.join(' ').replace(/\s+/g, ' ').trim(), texts.join(''), ...texts];
}
function ancestorsOf(open: Opening, source: ts.SourceFile): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (let p: ts.Node | undefined = open.parent?.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) {
      const t = tagOf(p.openingElement, source);
      out.unshift([/^[a-z]/.test(t) ? t : 'div', classesOf(p.openingElement, source)]);
    }
  }
  return out;
}

/** The JSX elements a node holds that aren't controls, each with its own, through `{cond && (...)}` and maps. */
function treesIn(node: ts.Node, source: ts.SourceFile, skip?: ts.Node): JsxTree[] {
  const out: JsxTree[] = [];
  const visit = (n: ts.Node): void => {
    if (n === skip) return;
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    // Another control beside it (a toolbar's accent Export) is judged as a
    // control; `near` is what decorates the red one: an edge, a row, a text.
    if (open && (controlKind(open, source) || /^(a|Link|select|textarea|input)$/.test(tagOf(open, source)))) return;
    if (open) {
      const t = tagOf(open, source);
      const inner = ts.isJsxElement(n) ? n.children.flatMap((child) => treesIn(child, source, skip)) : [];
      out.push([/^[a-z]/.test(t) ? t : 'div', classesOf(open, source), inner]);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}
/** The other elements inside a control's parent element. */
function nearOf(open: Opening, source: ts.SourceFile): JsxTree[] {
  const element: ts.Node = ts.isJsxOpeningElement(open) ? open.parent : open;
  let parent: ts.Node | undefined = element.parent;
  while (parent && !ts.isJsxElement(parent)) parent = parent.parent;
  return parent && ts.isJsxElement(parent) ? parent.children.flatMap((child) => treesIn(child, source, element)) : [];
}

/** Whether an element is a control: buttons by any name, role=button, an input button ('button'), or anything clickable ('click'). */
function controlKind(open: Opening, source: ts.SourceFile): 'button' | 'click' | null {
  const tag = tagOf(open, source);
  if (/^(button|Button|IconButton|MenuItem)$/.test(tag) || /\.(Button|IconButton|MenuItem)$/.test(tag)) return 'button';
  if (attrStrings(open, 'role', source).some((role) => /^(button|menuitem)$/.test(role))) return 'button';
  if (tag === 'input') return attrStrings(open, 'type', source).some((type) => /^(button|submit|reset)$/.test(type)) ? 'button' : null;
  return attr(open, 'onClick', source) || attr(open, 'onSelect', source) ? 'click' : null;
}

/** A control whose words come from its component's caller (<ConfirmInline label="Delete forever" />). */
interface Forwarder {
  file: string; component: string; line: number;
  /** The props its words read; `*` for a spread (`{...p}`): aria-label, title, label and children of the call. */
  props: Set<string>;
  classes: string[]; classProp: string | null;
  ancestors: Array<[string, string[]]>;
}

function scan(tsx: string, file: string): { controls: Control[]; forwarders: Forwarder[]; source: ts.SourceFile } {
  const source = ts.createSourceFile(file, tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const controls: Control[] = [];
  const forwarders: Forwarder[] = [];
  const visit = (node: ts.Node): void => {
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    const how = open ? controlKind(open, source) : null;
    // A disclosure (aria-expanded: "Recently deleted ▾") opens a section; it is no action.
    if (open && how && !attr(open, 'aria-expanded', source)) {
      const classes = classesOf(open, source);
      const said = wordsOf(open, source, how === 'click');
      // No words a person reads at all (an icon, ×, a blank template): what its code does names it.
      const silent = !said.some((text) => /\p{L}/u.test(text.replace(/…/g, '')));
      const name = said.find((text) => ACTION_WORD.test(text))
        ?? (silent && how === 'button' ? codeWords(open, source).find((text) => ACTION_WORD.test(text)) : undefined);
      const line = source.getLineAndCharacterOfPosition(open.getStart(source)).line + 1;
      if (name) controls.push({ file, line, name, kind: kindOf(classes), classes, ancestors: ancestorsOf(open, source), near: nearOf(open, source),
        ...(attr(open, 'aria-pressed', source) ? { toggle: true } : {}) });
      else {
        const owner = how === 'button' ? componentOf(open) : null;
        if (owner) {
          // A destructured prop it reads, or `props.x` for a `(props) =>` component.
          const read = (n: ts.Node) => (owner.param ? propsRead(n, owner.param) : namesIn(n).filter((id) => owner.names.has(id)));
          const props = new Set([
            ...['aria-label', 'title', 'value', 'label'].flatMap((a) => { const at = attr(open, a, source); return at?.initializer ? read(at.initializer) : []; }),
            ...childrenOf(open).flatMap((child) => read(child)),
          ].filter((id) => id !== owner.param));
          // Its own props spread on it (`{...p}`, or a rest binding): the call's labels are its labels.
          if (open.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p) && ts.isIdentifier(p.expression)
            && (p.expression.text === owner.param || owner.names.has(p.expression.text)))) props.add('*');
          const at = attr(open, 'className', source);
          const classProp = (at?.initializer ? read(at.initializer) : []).find((id) => id !== owner.param) ?? null;
          if (props.size) forwarders.push({ file, component: owner.component, line, props, classes, classProp, ancestors: ancestorsOf(open, source) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { controls, forwarders, source };
}

/** The controls a forwarder makes at each call of its component in `source`. */
function callsOf(forwarder: Forwarder, source: ts.SourceFile, file: string): Control[] {
  const out: Control[] = [];
  const visit = (node: ts.Node): void => {
    const call = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (call && tagOf(call, source) === forwarder.component) {
      const spread = forwarder.props.has('*');
      const named = [...forwarder.props].filter((p) => p !== '*');
      const words = [
        ...named.flatMap((id) => (id === 'children' ? childrenOf(call).flatMap((c) => strings(c, source)) : attrStrings(call, id, source))),
        ...(spread ? [...['aria-label', 'title', 'label', 'value'].flatMap((a) => attrStrings(call, a, source)),
          ...childrenOf(call).flatMap((c) => strings(c, source))] : []),
      ];
      const name = words.find((text) => ACTION_WORD.test(text));
      if (name) {
        const own = [...forwarder.classes,
          ...(forwarder.classProp ? attrStrings(call, forwarder.classProp, source).flatMap((c) => c.split(/\s+/)) : []),
          ...(spread ? classesOf(call, source) : [])].filter((c) => /^[\w-]+$/.test(c));
        out.push({ file, line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1, name, kind: kindOf(own),
          classes: [...new Set(own)], ancestors: [...ancestorsOf(call, source), ...forwarder.ancestors] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Every control that names an action in a set of TSX sources: its own words,
 * or its caller's, in the same file or another one (a component imported by
 * name).
 */
export function controlsInFiles(files: Record<string, string>): Control[] {
  const scanned = Object.entries(files).map(([file, tsx]) => ({ file, ...scan(tsx, file) }));
  // A component imported from a file outside the set (review 10 NIT-4): read
  // from disk for its forwarders, so a label passed to it is still seen.
  const outside = new Map<string, Forwarder[]>();
  for (const { source } of scanned) {
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue;
      const base = join(source.fileName, '..', statement.moduleSpecifier.text);
      for (const candidate of [`${base}.tsx`, join(base, 'index.tsx')]) {
        if (candidate in files || outside.has(candidate)) break;
        try {
          outside.set(candidate, scan(readFileSync(join(SRC, candidate), 'utf8'), candidate).forwarders);
          break;
        } catch { /* not there */ }
      }
    }
  }
  const forwarders = [...scanned.flatMap((s) => s.forwarders), ...[...outside.values()].flat()];
  return scanned.flatMap(({ file, controls, source }) => [
    ...controls,
    ...forwarders.filter((f) => (f.file === file ? !importsName(source, f.component) : importsFrom(source, file, f.component, f.file)))
      .flatMap((f) => callsOf(f, source, file)),
  ]).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Whether `source` imports `name` at all (then its calls are the imported one's, not a same-named local). */
function importsName(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((st) => ts.isImportDeclaration(st) && st.importClause?.namedBindings
    && ts.isNamedImports(st.importClause.namedBindings) && st.importClause.namedBindings.elements.some((e) => e.name.text === name));
}

/** Whether `source` (at `file`) imports `name` from the module at `from` (paths relative to src/). */
function importsFrom(source: ts.SourceFile, file: string, name: string, from: string): boolean {
  const target = from.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
  return source.statements.some((st) => {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) return false;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named) || !named.elements.some((e) => e.name.text === name && (e.propertyName ?? e.name).text === name)) return false;
    return join(file, '..', st.moduleSpecifier.text).replace(/\/index$/, '') === target;
  });
}

/** Every control that names an action in one TSX source. */
export function controlsIn(tsx: string, file: string): Control[] {
  return controlsInFiles({ [file]: tsx });
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

export function appControls(): Control[] {
  return controlsInFiles(Object.fromEntries(tsxFiles(SRC).sort().map((path) => [relative(SRC, path), readFileSync(path, 'utf8')])));
}

/** The control built in the app's theme with its JSX ancestors: [the control, every ancestor nearest first, cleanup]. */
function built(control: Control, classes: readonly string[] = control.classes, pressed?: 'true' | 'false'): [HTMLElement, Element[], () => void] {
  document.body.className = 'app-slava-restraint';
  let parent: Element = document.body;
  const made: Element[] = [];
  for (const [tag, classes] of control.ancestors) {
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(' ');
    parent.appendChild(el); made.push(el); parent = el;
  }
  const el = document.createElement('button');
  el.className = classes.join(' ');
  // A toggle carries its state (review 11 NIT-4: [aria-pressed="false"]:hover),
  // and every control an icon (`:hover svg { fill }`).
  if (pressed) el.setAttribute('aria-pressed', pressed);
  el.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  parent.appendChild(el);
  return [el, [...made].reverse(), () => { (made[0] ?? el).remove(); document.body.className = ''; }];
}

const CHECKED_STATES = ['', ':hover', ':active', ':focus', ':focus-visible'];
const INHERITS = /^(color|caret-color|accent-color|-webkit-text-fill-color|text-shadow)$/;

/**
 * The colours that win on a control at rest, on hover, pressed and focused,
 * built in the app's theme with its JSX ancestors, that break its kind. A
 * colour it doesn't set (or sets to inherit or currentcolor) comes from the
 * nearest ancestor that does, in the same state: hovering the control hovers
 * its ancestors too. `extraCss` is a test's own stylesheet.
 */
export function cascadeFindings(control: Control, vars: Vars, extraCss?: string): string[] {
  if (!control.kind) return [];
  if (!control.toggle) return stateFindings(control, control.classes, vars, extraCss, false, '');
  // A toggle (review 10 LOW-1, GM r17 item 1): on, its accent marks its
  // state, so a neutral one may take it; off (its state class gone), it may
  // not, at rest or on hover, so hovering never looks like "on".
  const off = control.classes.filter((name) => !TOGGLE_STATE.test(name));
  return [...new Set([
    ...stateFindings(control, control.classes, vars, extraCss, true, ' (on)', 'true'),
    ...stateFindings(control, off, vars, extraCss, false, ' (off)', 'false'),
  ])];
}

/** A class that says a toggle is on. */
// Review 11 NIT-4: `is-on` and `--fav` too.
export const TOGGLE_STATE = /(?:--(?:active|on|selected|pressed|checked|current|starred|fav|favorite|favourite)|^is-(?:on|active|selected|pressed|checked))$/;

function stateFindings(control: Control, classes: readonly string[], vars: Vars, extraCss: string | undefined,
  accentAllowed: boolean, label: string, pressed?: 'true' | 'false'): string[] {
  const [el, ancestors, done] = built(control, classes, pressed);
  const found: string[] = [];
  try {
    const own = cascaded(el, extraCss);
    const lineage = ancestors.map((a) => cascaded(a, extraCss));
    const keys = new Set(own.keys());
    for (const state of CHECKED_STATES) for (const prop of ['color', 'accent-color', '-webkit-text-fill-color']) keys.add(`${state}|${prop}`);
    for (const key of keys) {
      const [state, prop] = key.split('|');
      if (!CHECKED_STATES.includes(state) || !COLOUR_PROPERTY.test(prop)) continue;
      if (/^:focus/.test(state) && FOCUS_RING.test(prop)) continue;
      let winner = own.get(key) ?? (state ? own.get(`|${prop}`) : undefined);
      let from = winner?.selector ?? '';
      if (INHERITS.test(prop) && (!winner || /^(inherit|currentcolor|unset)$/i.test(winner.value))) {
        winner = undefined;
        for (const styles of lineage) {
          const there = styles.get(key) ?? (state ? styles.get(`|${prop}`) : undefined);
          if (there && !/^(inherit|currentcolor|unset)$/i.test(there.value)) { winner = there; from = `${there.selector}, inherited`; break; }
        }
      }
      if (!winner) continue;
      const bad = badColours(winner.value, control.kind, vars)
        .filter((b) => !(accentAllowed && control.kind === 'neutral' && /^(?:[\w-]+: )*var\(--sr-accent[\w-]*[,)]/.test(b)));
      if (bad.length) found.push(`${control.file}:${control.line} "${control.name}"${label} ${state || 'rest'} ${prop}: ${bad.join(' ')} (from ${from}, ${control.kind})`);
    }
    // Its icon (review 11 NIT-4: `.x:hover svg { fill: accent }`): what a rule
    // gives the svg inside it, in each state, keeps its kind too.
    const icon = el.querySelector('svg');
    if (icon) {
      for (const [key, winner] of cascaded(icon, extraCss)) {
        const [state, prop] = key.split('|');
        if (!CHECKED_STATES.includes(state) || !COLOUR_PROPERTY.test(prop)) continue;
        if (/^:focus/.test(state) && FOCUS_RING.test(prop)) continue;
        // A rule for every svg (svg { fill: currentColor }) isn't the control's.
        if (!classes.some((c) => winner.selector.includes(`.${c}`))) continue;
        const bad = badColours(winner.value, control.kind, vars)
          .filter((b) => !(accentAllowed && control.kind === 'neutral' && /^(?:[\w-]+: )*var\(--sr-accent[\w-]*[,)]/.test(b)));
        if (bad.length) found.push(`${control.file}:${control.line} "${control.name}"${label} ${state || 'rest'} svg ${prop}: ${bad.join(' ')} (from ${winner.selector}, ${control.kind})`);
      }
    }
  } finally {
    done();
  }
  return [...new Set(found)];
}

/** The warning amber: a frame colour as loud as the accent (GM r18). */
const WARNING_VAR = /^--sr-warning(?:-[\w-]+)?$/;
/** Amber and yellow-orange hues the warm check leaves out (#f5c518 is 48 degrees). */
function amberRgb(red: number, green: number, blue: number): boolean {
  const [r, g, b] = [red, green, blue].map((n) => n / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  if (!d || [r, g, b].some((n) => Number.isNaN(n))) return false;
  const l = (max + min) / 2; const sat = d / (1 - Math.abs(2 * l - 1));
  const hue = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return sat > 0.35 && hue > 0 && hue <= 60;
}
function amberColours(value: string): string[] {
  const out: string[] = [];
  // Review 13 NIT-4: the 8- and 4-digit forms too (#f5c518cc, #fc1c).
  for (const match of value.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi)) {
    const short = match[1].length <= 4;
    const hex = short ? [...match[1].slice(0, 3)].map((c) => c + c).join('') : match[1].slice(0, 6);
    if (amberRgb(...([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]))) out.push(match[0]);
  }
  // Review 12 NIT-2: rgb() and rgba() too (a gradient of rgba(245,197,24,.2)).
  for (const match of value.matchAll(/rgba?\(([^)]*)\)/gi)) {
    const [r, g, b] = parts(match[1]).slice(0, 3).map((part) => (part.endsWith('%') ? parseFloat(part) * 2.55 : Number(part)));
    if (amberRgb(r, g, b)) out.push(match[0]);
  }
  return out;
}

/**
 * The one coloured element GM allows near a red control (r20 Q3, r22 Q2,
 * PR #200 fix round 14): the pin card's left status edge, its own element
 * (`.canvas-pin__edge`), full height, in the pin colour while open and the
 * author's once resolved. Keyed to that element and its fill in a presence
 * colour variable, never to a hue or a selector: amber anywhere else near a
 * red control, the card's own border or fill included, still fails.
 */
export const STATUS_EDGE_CLASS = 'canvas-pin__edge';
// Review 13 NIT-4: the pin colour with no fallback, the author's with only
// its blue one; a warm fallback (var(--pin-color, #ff5a1f)) isn't exempt.
export const PRESENCE_COLOUR = /^(?:var\(--pin-color\)|var\(--agent-color(?:,\s*#5b9dff)?\))$/i;
/** The rule that wins names the edge itself as its subject (review 13
 * NIT-4): a wrapper's rule, or one for a lookalike class, that happens to
 * reach the edge element isn't the edge's own fill. */
const EDGE_SUBJECT = new RegExp(`\\.${STATUS_EDGE_CLASS}(?![\\w-])[^\\s>+~]*$`);

/**
 * GM r18 (PR #200 fix round 12): orange never frames a destructive action.
 * Every element around a red control (its JSX ancestors, in the app's
 * theme) draws its edge, outline, shadow and fill, at rest and on hover,
 * without the accent, the warning amber, the error orange or any warm or
 * amber colour. (Forget ID sat in an amber warning box.)
 */
export function frameFindings(control: Control, vars: Vars, extraCss?: string): string[] {
  if (control.kind !== 'red' || !control.ancestors.length) return [];
  const [el, ancestors, done] = built(control);
  const found: string[] = [];
  // Review 12 NIT-2: a colour the test's own sheet aliases (--box-edge: var(--sr-accent)) resolves too.
  const allVars: Vars = new Map(vars);
  if (extraCss) for (const [name, values] of customProperties([{ css: extraCss }])) allVars.set(name, [...(allVars.get(name) ?? []), ...values]);
  const check = (element: Element, pseudoOnly: boolean) => {
    const edge = element.classList.contains(STATUS_EDGE_CLASS);
    // Every state an ancestor can take (focus, pressed, [data-*] …) and
    // every pseudo-element it draws, not only rest and hover (review 12 NIT-2).
    const styles = cascaded(element, extraCss, { loose: true });
    // Its `color` in a state, its own or the one it inherits.
    const colourOf = (state: string): string => {
      for (let at: Element | null = element; at; at = at.parentElement) {
        const map = at === element ? styles : cascaded(at, extraCss, { loose: true });
        const won = map.get(`${state}|color`) ?? map.get('|color');
        if (won) return won.value;
      }
      return '';
    };
    for (const [key, winner] of styles) {
      const [state, prop] = key.split('|');
      if (pseudoOnly && !/::?(before|after)\b/.test(state)) continue;
      if (!/^(border|outline|box-shadow|background|filter)/.test(prop)) continue;
      // An ancestor's own keyboard ring (:focus, :focus-visible) is the ring
      // rule's to judge; :focus-within, drawn round the focused control, is a frame.
      if (/^:focus(?:-visible)?$/.test(state) && FOCUS_RING.test(prop)) continue;
      // The one exemption (GM r22 Q2): the status edge's own fill, at rest,
      // in a presence colour. Its border, shadow or any other state isn't.
      if (edge && state === '' && /^background(?:-color)?$/.test(prop) && PRESENCE_COLOUR.test(winner.value.trim())
        && winner.selector.split(',').some((part) => EDGE_SUBJECT.test(part.trim()))) continue;
      // Review 13 NIT-4: currentColor is the element's own colour in that state.
      const value = /currentcolor/i.test(winner.value) ? `${winner.value} ${colourOf(state)}` : winner.value;
      const bad = [
        ...badColours(value, 'red', allVars),
        ...varsIn(value).filter((v) => WARNING_VAR.test(v.name)).map((v) => v.text),
        ...amberColours(value),
      ];
      if (bad.length) found.push(`${control.file}:${control.line} "${control.name}" is framed by ${winner.selector} ${state || 'rest'} ${prop}: ${[...new Set(bad)].join(' ')}`);
    }
  };
  try {
    ancestors.forEach((ancestor) => check(ancestor, false));
    // The control's own ::before and ::after can draw a frame round it too.
    check(el, true);
    // What sits beside it in its parent, and what that holds (GM r22 Q2:
    // amber anywhere near a red control, elsewhere on the pin card too).
    const add = (tree: JsxTree, parent: Element): void => {
      const made = document.createElement(tree[0]);
      if (tree[1].length) made.className = tree[1].join(' ');
      parent.appendChild(made);
      check(made, false);
      tree[2].forEach((child) => add(child, made));
    };
    if (el.parentElement) (control.near ?? []).forEach((tree) => add(tree, el.parentElement!));
  } finally {
    done();
  }
  return [...new Set(found)];
}

/**
 * A red control has to look red somewhere: at rest or on hover, its text,
 * edge or fill draws on a danger token. (A red class with nothing behind it
 * would pass the checks above while still hovering neutral, or the accent of
 * a shared class.)
 */
export function notRedFindings(control: Control): string[] {
  if (control.kind !== 'red') return [];
  const [el, , done] = built(control);
  try {
    for (const [key, winner] of cascaded(el)) {
      const [state, prop] = key.split('|');
      if (!['', ':hover'].includes(state) || !/^(color|background(-color)?|border(-color)?)$/.test(prop)) continue;
      if (/var\(--sr-(danger-(ink|ink-hover|fill|fill-hover|tint|edge)|on-danger)\b/.test(winner.value)) return [];
    }
    return [`${control.file}:${control.line} "${control.name}" is red by its class but no danger token wins at rest or on hover`];
  } finally {
    done();
  }
}

/**
 * Pressed, a red control's text goes to the lighter red (review 9 NIT-2: the
 * Remotion Delete stayed #ff887d): when its text is red on hover, the colour
 * that wins pressed is --sr-danger-ink-hover (or the fill's hover).
 */
export function pressedFindings(control: Control): string[] {
  if (control.kind !== 'red') return [];
  const [el, , done] = built(control);
  try {
    const styles = cascaded(el);
    const hover = styles.get(':hover|color')?.value ?? '';
    if (!/var\(--sr-danger-ink\s*[,)]/.test(hover)) return [];
    const pressed = styles.get(':active|color') ?? styles.get(':hover:active|color') ?? styles.get(':active:hover|color');
    if (pressed && /var\(--sr-danger-(ink-hover|fill-hover)\b/.test(pressed.value)) return [];
    return [`${control.file}:${control.line} "${control.name}" stays ${pressed?.value ?? hover} pressed, not the lighter red`];
  } finally {
    done();
  }
}

/**
 * Menus built from data (ContextMenu's `{ label: 'Delete', danger: true }`):
 * an item labelled with a red word carries `danger: true`, which its menu
 * draws as `--danger`.
 */
export function menuItemFindings(tsx: string, file: string): string[] {
  const source = ts.createSourceFile(file, tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name: string) => node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === name);
      // Any label form strings() reads (a const, an object's property, a function), review 10 NIT-4;
      // label, title or text, each of them (review 11 NIT-4: a `text:` beside a plain `title:`).
      const labels = ['label', 'title', 'text'].map(prop).filter((p): p is ts.PropertyAssignment => Boolean(p));
      const text = labels.flatMap((label) => strings(label.initializer, source)).find((t) => wordKind(t, file) === 'red') ?? null;
      const acts = ['action', 'onSelect', 'onClick', 'run', 'handler', 'perform'].some((name) => prop(name))
        || node.properties.some((p) => ts.isMethodDeclaration(p) && /^(action|onSelect|onClick|run)$/.test(p.name.getText(source)));
      if (text && acts && prop('danger')?.initializer.kind !== ts.SyntaxKind.TrueKeyword) {
        found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} menu item "${text}" without danger: true`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function appMenuItemFindings(): string[] {
  return [...tsxFiles(SRC), ...tsFiles(SRC)].sort().flatMap((path) => menuItemFindings(readFileSync(path, 'utf8'), relative(SRC, path)));
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}
