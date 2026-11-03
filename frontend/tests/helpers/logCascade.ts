import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A small cascade model for jsdom, which neither resolves var() nor weighs
 * !important against an inline style (the model #216's round 3k test
 * reads layouts.css with, for any list of stylesheets in load order): every
 * rule outside an at-rule whose selector the element matches (jsdom's
 * matches), !important over the inline style over the rest, specificity then
 * order, and var(), calc(), min(), max() and clamp() in px and vh.
 */
export function cascade(files: string[], viewHeight: number) {
  type Decl = { prop: string; value: string; important: boolean; spec: number; order: number };
  type Rule = { selectors: string[]; decls: Array<Omit<Decl, 'spec' | 'order'>> };

  const css = files.map((file) => readFileSync(resolve(__dirname, '../../src', file), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  function splitTop(text: string, by: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '(' || text[i] === '[') depth += 1;
      else if (text[i] === ')' || text[i] === ']') depth -= 1;
      else if (text[i] === by && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
    }
    parts.push(text.slice(from).trim());
    return parts.filter(Boolean);
  }

  const rules: Rule[] = [];
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf('{', at);
    if (open < 0) break;
    const head = css.slice(at, open).trim();
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth > 0) { if (css[end] === '{') depth += 1; else if (css[end] === '}') depth -= 1; end += 1; }
    const body = css.slice(open + 1, end - 1);
    if (!head.startsWith('@')) {
      rules.push({
        selectors: splitTop(head, ','),
        decls: splitTop(body, ';').filter((part) => part.includes(':')).map((part) => {
          const colon = part.indexOf(':');
          const raw = part.slice(colon + 1).trim();
          return { prop: part.slice(0, colon).trim(), value: raw.replace(/\s*!important$/, ''), important: /!important$/.test(raw) };
        }),
      });
    }
    at = end;
  }

  function specificity(selector: string): number {
    const bare = selector.replace(/:not\(/g, '(');
    const ids = (bare.match(/#[\w-]+/g) ?? []).length;
    const classes = (bare.match(/\.[\w-]+|\[[^\]]+\]|:(?!not)[\w-]+/g) ?? []).length;
    const types = (bare.replace(/\[[^\]]+\]|\.[\w-]+|#[\w-]+|:[\w-]+/g, ' ').match(/(^|[\s>+~(])[a-z][\w-]*/g) ?? []).length;
    return ids * 10000 + classes * 100 + types;
  }

  /** An element's declared value for `prop`, by the cascade. */
  function declared(el: Element, prop: string): string | null {
    const found: Decl[] = [];
    let order = 0;
    for (const rule of rules) {
      for (const selector of rule.selectors) {
        let matches = false;
        try { matches = el.matches(selector); } catch { matches = false; }
        if (!matches) continue;
        for (const decl of rule.decls) if (decl.prop === prop) found.push({ ...decl, spec: specificity(selector), order: order += 1 });
      }
    }
    const best = (list: Decl[]) => list.sort((a, b) => a.spec - b.spec || a.order - b.order).pop()?.value ?? null;
    const important = found.filter((decl) => decl.important);
    if (important.length) return best(important);
    const inline = (el as HTMLElement).style?.getPropertyValue(prop);
    if (inline) return inline;
    return best(found);
  }

  function variable(el: Element, name: string): string | null {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const value = declared(node, name);
      if (value !== null) return value;
    }
    return null;
  }

  /** A length in px: var() resolved on `el`, then calc/min/max/clamp evaluated. */
  function px(el: Element, value: string): number {
    let text = value;
    for (let guard = 0; guard < 30 && text.includes('var('); guard += 1) {
      text = text.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/, (_m, name: string, fallback?: string) => {
        const found = variable(el, name);
        return `(${found ?? fallback ?? '0px'})`;
      });
    }
    const js = text
      .replace(/clamp\(/g, 'C(').replace(/\bmax\(/g, 'Math.max(').replace(/\bmin\(/g, 'Math.min(').replace(/calc\(/g, '(')
      .replace(/(-?\d*\.?\d+)px/g, '($1)').replace(/(-?\d*\.?\d+)vh/g, `($1*${viewHeight}/100)`);
    return new Function('C', `return ${js};`)((lo: number, v: number, hi: number) => Math.max(lo, Math.min(v, hi))) as number;
  }

  /** The box's height as the cascade lays it out, `content` standing for
   * height: auto: its height between its min-height and max-height (min wins). */
  function boxHeight(el: HTMLElement, content: number): number {
    const raw = declared(el, 'height') ?? 'auto';
    const height = raw === 'auto' ? content : px(el, raw);
    const max = px(el, declared(el, 'max-height') ?? '100000px');
    const min = px(el, declared(el, 'min-height') ?? '0px');
    return Math.max(min, Math.min(height, max));
  }

  /** Every declaration for `prop` in rules whose selector list holds `selector` exactly. */
  function ruleValue(selector: string, prop: string): string | null {
    const rule = [...rules].reverse().find((r) => r.selectors.includes(selector) && r.decls.some((d) => d.prop === prop));
    return rule?.decls.find((d) => d.prop === prop)?.value ?? null;
  }

  return { declared, px, boxHeight, ruleValue, rules };
}
