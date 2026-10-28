import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import postcss, { type AtRule, type Container, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { cascaded } from './cssCascade';

/**
 * GM r13 and r14's rule for red, enforced by what controls say and do, not
 * how they're named (fix round 9 of PR #200, review 8 LOW-2):
 * - Red: it deletes a standalone thing (project, node, asset, result, agent, API key, app token), or wipes a whole surface (Clear, Purge, Discard). Undo doesn't change this (node Delete stays red).
 * - Neutral: it takes an item out of a list inside the thing you're editing (chips, swatches, tags, a shot in a scene, an item on a board, a character view).
 *
 * A control is found by its words (its aria-label, title or visible text,
 * any case) on a <button>, a <Button> or anything with role="button". Its
 * class says its kind: a class ending in a red word (danger, delete, clear …)
 * or a neutral one (remove, reset). The colours are then checked twice: every
 * rule whose own element (the last compound) carries a kind class, and, per
 * control, the rule that wins the cascade at rest, on hover and pressed, built
 * with its JSX ancestors, so a shared class's accent hover can't win over it.
 */

const SRC = join(__dirname, '..', '..', 'src');

export const ACTION_WORD = /^\s*(delete|clear|discard|purge|trash|remove|erase|empty|revoke|forget|wipe)\b/i;
const RED_WORDS = 'danger|destructive|delete|purge|trash|discard|clear|erase|wipe|revoke|forget|bin';
const NEUTRAL_WORDS = 'remove|reset';
const RED_CLASS = new RegExp(`(?:^|[_-])(?:${RED_WORDS})$`, 'i');
const NEUTRAL_CLASS = new RegExp(`(?:^|[_-])(?:${NEUTRAL_WORDS})$`, 'i');
const RED_TEXT = new RegExp(`(?:^|[^a-z])(?:${RED_WORDS}|delete forever)`, 'i');

export type Kind = 'red' | 'neutral';

/** The kind a set of class names declares (red wins if both). */
export function kindOf(classes: readonly string[]): Kind | null {
  if (classes.some((name) => RED_CLASS.test(name))) return 'red';
  if (classes.some((name) => NEUTRAL_CLASS.test(name))) return 'neutral';
  return null;
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

/** The literal red or orange colours in a value (hex, rgb, hsl, oklch, named). */
export function warmColours(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    const hex = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1].slice(0, 6);
    if (warmRgb(...([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]))) out.push(m[0]);
  }
  for (const m of value.matchAll(/rgba?\(([^)]*)\)/gi)) {
    const [r, g, b] = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((part) => (part.endsWith('%') ? parseFloat(part) * 2.55 : Number(part)));
    if (warmRgb(r, g, b)) out.push(m[0]);
  }
  for (const m of value.matchAll(/hsla?\(([^)]*)\)/gi)) {
    const [h, s] = m[1].split(/[\s,/]+/).filter(Boolean).map((part) => parseFloat(part));
    const hue = ((h % 360) + 360) % 360;
    if (s > 35 && (hue <= 45 || hue >= 340)) out.push(m[0]);
  }
  for (const m of value.matchAll(/oklch\(([^)]*)\)/gi)) {
    const [, c, h] = m[1].split(/[\s,/]+/).filter(Boolean).map((part) => parseFloat(part));
    if (c > 0.08 && (h <= 80 || h >= 350)) out.push(m[0]);
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

const COLOUR_PROPERTY = /^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|filter|text-decoration(-color)?|caret-color)$/;

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

/** A rule's full selectors, nesting resolved (`&__delete` under `.x` is `.x__delete`). */
function fullSelectors(rule: Rule): string[] {
  const own = rule.selectors;
  let parent: Container | undefined = rule.parent as Container | undefined;
  while (parent && parent.type === 'atrule') parent = parent.parent as Container | undefined;
  if (!parent || parent.type !== 'rule') return own;
  const outer = fullSelectors(parent as Rule);
  return outer.flatMap((p) => own.map((s) => (s.includes('&') ? s.replace(/&/g, p) : `${p} ${s}`)));
}

/** The kind the targeted element (the last compound) declares by class or attribute, and whether the rule is a focus ring. */
function targetOf(selector: string): { kind: Kind | null; focus: boolean } {
  let kind: Kind | null = null; let focus = false;
  try {
    selectorParser((root) => {
      const sel = root.first;
      const nodes = sel.nodes;
      let start = nodes.length;
      while (start > 0 && nodes[start - 1].type !== 'combinator') start -= 1;
      const classes: string[] = []; const attrs: string[] = [];
      for (const node of nodes.slice(start)) {
        if (node.type === 'class') classes.push(node.value);
        else if (node.type === 'attribute') attrs.push(`${node.attribute}=${node.value ?? ''}`);
        else if (node.type === 'pseudo') {
          if (/^:focus/.test(node.value)) focus = true;
          if ([':is', ':where'].includes(node.value)) node.walkClasses((c) => { classes.push(c.value); });
        }
      }
      kind = kindOf(classes);
      if (!kind) {
        const words = attrs.join(' ').replace(/[^a-z]+/gi, ' ');
        if (new RegExp(`\\b(${RED_WORDS})\\b`, 'i').test(words)) kind = 'red';
        else if (new RegExp(`\\b(${NEUTRAL_WORDS})\\b`, 'i').test(words)) kind = 'neutral';
      }
    }).processSync(selector);
  } catch { /* an unparsable selector targets nothing we check */ }
  return { kind, focus };
}

/** Every rule whose own element declares a kind and whose colours break it. */
export function ruleFindings(css: string, file: string, vars: Vars): string[] {
  const found: string[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule' && /keyframes|font-face/.test((p as AtRule).name)) return;
    }
    for (const selector of fullSelectors(rule)) {
      const { kind, focus } = targetOf(selector);
      if (!kind || focus) continue;
      rule.each((node) => {
        if (node.type !== 'decl' || !COLOUR_PROPERTY.test(node.prop)) return;
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
  /** The JSX elements around it, outermost first: [tag, classes]. */
  ancestors: Array<[string, string[]]>;
}

function strings(node: ts.Node, source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) out.push(n.head.text + n.templateSpans.map((span) => `…${span.literal.text}`).join(''));
    else if (ts.isJsxText(n)) { if (n.text.trim()) out.push(n.text.trim()); }
    else if (ts.isIdentifier(n) && ts.isJsxExpression(n.parent)) out.push(...constStrings(n.text, source));
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

function identifiersIn(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => { if (ts.isIdentifier(n)) out.push(n.text); else ts.forEachChild(n, visit); };
  if (ts.isJsxExpression(node) || ts.isJsxAttribute(node)) ts.forEachChild(node, visit);
  else if (ts.isIdentifier(node)) out.push(node.text);
  return out;
}

/** The component a JSX element sits in, and the names its first parameter destructures. */
function componentProps(node: ts.Node): { component: string; names: Set<string> } | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    const fn = ts.isFunctionDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p) ? p : null;
    if (!fn) continue;
    const param = fn.parameters[0];
    if (!param || !ts.isObjectBindingPattern(param.name)) return null;
    const names = new Set(param.name.elements.map((e) => (ts.isIdentifier(e.name) ? e.name.text : '')).filter(Boolean));
    const component = ts.isFunctionDeclaration(fn) ? fn.name?.text
      : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined;
    return component ? { component, names } : null;
  }
  return null;
}

function tagOf(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, source: ts.SourceFile): string {
  return node.tagName.getText(source);
}
function attr(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string, source: ts.SourceFile): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name);
}
function attrStrings(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string, source: ts.SourceFile): string[] {
  const a = attr(node, name, source);
  return a?.initializer ? strings(a.initializer, source) : [];
}
function classesOf(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, source: ts.SourceFile): string[] {
  return [...new Set(attrStrings(node, 'className', source).flatMap((s) => s.split(/[\s…]+/)).filter((c) => /^[\w-]+$/.test(c)))];
}

/** Every control that names an action (Delete, Clear, Remove …) in a TSX source. */
export function controlsIn(tsx: string, file: string): Control[] {
  const source = ts.createSourceFile(file, tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Control[] = [];
  const check = (open: ts.JsxOpeningElement | ts.JsxSelfClosingElement, children: readonly ts.JsxChild[]) => {
    const tag = tagOf(open, source);
    const role = attrStrings(open, 'role', source);
    if (!(tag === 'button' || tag === 'Button' || role.includes('button'))) return;
    // A toggle (aria-pressed, a favourite star, a tool mode) is a state, not an action.
    if (attr(open, 'aria-pressed', source)) return;
    const said = [...attrStrings(open, 'aria-label', source), ...attrStrings(open, 'title', source),
      children.flatMap((child) => strings(child, source)).join(' ').replace(/\s+/g, ' ').trim(),
      ...children.flatMap((child) => strings(child, source))];
    const ancestors: Array<[string, string[]]> = [];
    for (let p: ts.Node | undefined = open.parent?.parent; p; p = p.parent) {
      if (ts.isJsxElement(p)) {
        const t = tagOf(p.openingElement, source);
        ancestors.unshift([/^[a-z]/.test(t) ? t : 'div', classesOf(p.openingElement, source)]);
      }
    }
    const classes = classesOf(open, source);
    const name = said.find((text) => ACTION_WORD.test(text));
    if (name) {
      found.push({ file, line: source.getLineAndCharacterOfPosition(open.getStart(source)).line + 1, name, kind: kindOf(classes), classes, ancestors });
      return;
    }
    // Its words come from its component's caller (<ConfirmInline label="Delete forever" />): read them at each call in this file.
    const props = componentProps(open);
    if (!props) return;
    const used = [...['aria-label', 'title'].flatMap((a) => { const at = attr(open, a, source); return at?.initializer ? identifiersIn(at.initializer) : []; }),
      ...children.flatMap((child) => identifiersIn(child))].filter((id) => props.names.has(id));
    const classProp = (() => { const at = attr(open, 'className', source); const ids = at?.initializer ? identifiersIn(at.initializer) : []; return ids.find((id) => props.names.has(id)); })();
    if (!used.length) return;
    const visitCalls = (node: ts.Node): void => {
      const call = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
      if (call && tagOf(call, source) === props.component) {
        const callerWords = used.flatMap((id) => attrStrings(call, id, source));
        const callerName = callerWords.find((text) => ACTION_WORD.test(text));
        if (callerName) {
          const own = [...classes, ...(classProp ? attrStrings(call, classProp, source).flatMap((c) => c.split(/\s+/)) : [])].filter((c) => /^[\w-]+$/.test(c));
          // Where it renders: around the call, then inside the component.
          const around: Array<[string, string[]]> = [];
          for (let p: ts.Node | undefined = call.parent?.parent; p; p = p.parent) {
            if (ts.isJsxElement(p)) {
              const t = tagOf(p.openingElement, source);
              around.unshift([/^[a-z]/.test(t) ? t : 'div', classesOf(p.openingElement, source)]);
            }
          }
          found.push({ file, line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1, name: callerName,
            kind: kindOf(own), classes: [...new Set(own)], ancestors: [...around, ...ancestors] });
        }
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(source);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) check(node.openingElement, node.children);
    else if (ts.isJsxSelfClosingElement(node)) check(node, []);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

export function appControls(): Control[] {
  return tsxFiles(SRC).sort().flatMap((path) => controlsIn(readFileSync(path, 'utf8'), relative(SRC, path)));
}

/** Whether a red-kind control's own words say red (so a red class on "Clear search" is caught too). */
export function saysRed(name: string): boolean {
  return RED_TEXT.test(name) && !/^\s*clear (search|filters?)\b/i.test(name);
}

/**
 * The colours that win on a control at rest, on hover and pressed, built in
 * the app's theme with its JSX ancestors, that break its kind.
 */
export function cascadeFindings(control: Control, vars: Vars): string[] {
  if (!control.kind) return [];
  document.body.className = 'app-slava-restraint';
  let parent: Element = document.body;
  const made: Element[] = [];
  for (const [tag, classes] of control.ancestors) {
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(' ');
    parent.appendChild(el); made.push(el); parent = el;
  }
  const el = document.createElement('button');
  el.className = control.classes.join(' ');
  parent.appendChild(el);
  const found: string[] = [];
  try {
    for (const [key, winner] of cascaded(el)) {
      const [state, prop] = key.split('|');
      if (!['', ':hover', ':active'].includes(state) || !COLOUR_PROPERTY.test(prop)) continue;
      const bad = badColours(winner.value, control.kind, vars);
      if (bad.length) found.push(`${control.file}:${control.line} "${control.name}" ${state || 'rest'} ${prop}: ${bad.join(' ')} (from ${winner.selector}, ${control.kind})`);
    }
  } finally {
    (made[0] ?? el).remove();
    document.body.className = '';
  }
  return found;
}

/**
 * A red control has to look red somewhere: at rest or on hover, its text,
 * edge or fill draws on a danger token. (A red class with nothing behind it
 * would pass the checks above while still hovering neutral, or the accent of
 * a shared class.)
 */
export function notRedFindings(control: Control): string[] {
  if (control.kind !== 'red') return [];
  document.body.className = 'app-slava-restraint';
  let parent: Element = document.body;
  const made: Element[] = [];
  for (const [tag, classes] of control.ancestors) {
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(' ');
    parent.appendChild(el); made.push(el); parent = el;
  }
  const el = document.createElement('button');
  el.className = control.classes.join(' ');
  parent.appendChild(el);
  try {
    for (const [key, winner] of cascaded(el)) {
      const [state, prop] = key.split('|');
      if (!['', ':hover'].includes(state) || !/^(color|background(-color)?|border(-color)?)$/.test(prop)) continue;
      if (/var\(--sr-(danger-(ink|ink-hover|fill|fill-hover|tint|edge)|on-danger)\b/.test(winner.value)) return [];
    }
    return [`${control.file}:${control.line} "${control.name}" is red by its class but no danger token wins at rest or on hover`];
  } finally {
    (made[0] ?? el).remove();
    document.body.className = '';
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
      const label = prop('label');
      const text = label && (ts.isStringLiteral(label.initializer) || ts.isNoSubstitutionTemplateLiteral(label.initializer)) ? label.initializer.text : null;
      if (text && /^\s*(delete|clear|discard|purge|trash|erase|empty|revoke|forget|wipe)\b/i.test(text) && prop('action')
        && prop('danger')?.initializer.kind !== ts.SyntaxKind.TrueKeyword) {
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
