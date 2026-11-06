import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLog } from '../src/components/panels/AgentLog';
import { useUIStore } from '../src/store/uiStore';

/**
 * PR #216 review 3, MEDIUM-1 and MEDIUM-2 (GM r57: fix as proposed): a log
 * the person resized with its native corner (an inline height) is its
 * header's height when collapsed, for the card's fold and for the person's
 * own collapse; and open, with no give in force, the person can resize it
 * taller than the height last measured.
 *
 * jsdom neither resolves var() nor weighs !important against an inline
 * style, so this resolves the cascade itself from layouts.css: every rule
 * outside an at-rule whose selector the element matches (jsdom's matches),
 * !important over the inline style over the rest, specificity then order,
 * and var(), calc(), min(), max() and clamp() in px and vh.
 */
const CSS = readFileSync(resolve(__dirname, '../src/styles/layouts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const VIEW_H = 900;

type Decl = { prop: string; value: string; important: boolean; spec: number; order: number };
type Rule = { selectors: string[]; decls: Array<Omit<Decl, 'spec' | 'order'>> };

/** The top-level rules (at-rules' blocks skipped). */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
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
      out.push({
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
  return out;
}

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

function specificity(selector: string): number {
  const bare = selector.replace(/:not\(/g, '(');
  const ids = (bare.match(/#[\w-]+/g) ?? []).length;
  const classes = (bare.match(/\.[\w-]+|\[[^\]]+\]|:(?!not)[\w-]+/g) ?? []).length;
  const types = (bare.replace(/\[[^\]]+\]|\.[\w-]+|#[\w-]+|:[\w-]+/g, ' ').match(/(^|[\s>+~(])[a-z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

const RULES = rules(CSS);

/** An element's declared value for `prop`, by the cascade. */
function declared(el: Element, prop: string): string | null {
  const found: Decl[] = [];
  let order = 0;
  for (const rule of RULES) {
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

/** A custom property's value: the element's own, else up its ancestors. */
function variable(el: Element, name: string): string | null {
  for (let at: Element | null = el; at; at = at.parentElement) {
    const value = declared(at, name);
    if (value !== null) return value;
  }
  return null;
}

/** A length in px: var() resolved on `el`, then calc/min/max/clamp evaluated. */
function px(el: Element, value: string): number {
  let text = value;
  for (let guard = 0; guard < 20 && text.includes('var('); guard += 1) {
    text = text.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/, (_m, name: string, fallback?: string) => {
      const found = variable(el, name);
      return `(${found ?? fallback ?? '0px'})`;
    });
  }
  const js = text
    .replace(/clamp\(/g, 'C(').replace(/\bmax\(/g, 'Math.max(').replace(/\bmin\(/g, 'Math.min(').replace(/calc\(/g, '(')
    .replace(/(-?\d*\.?\d+)px/g, '($1)').replace(/(-?\d*\.?\d+)vh/g, `($1*${VIEW_H}/100)`);
  return new Function('C', `return ${js};`)((lo: number, v: number, hi: number) => Math.max(lo, Math.min(v, hi))) as number;
}

/** The log's box height as the cascade lays it out: its height between its
 * min-height and max-height (the CSS order: min wins over max). */
function boxHeight(log: HTMLElement): number {
  const height = px(log, declared(log, 'height') ?? '0px');
  const max = px(log, declared(log, 'max-height') ?? '100000px');
  const min = px(log, declared(log, 'min-height') ?? '0px');
  return Math.max(min, Math.min(height, max));
}

const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.className = '';
  for (const name of ['--agent-log-squeeze', '--agent-log-natural-h']) document.documentElement.style.removeProperty(name);
  useUIStore.setState({ agentLogOpen: false, agentLogCardHold: 'none' } as never);
});

describe('the cascade model reads layouts.css as the browser does', () => {
  it('reads the closed header and the open log\'s tokens', () => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    expect(px(probe, 'var(--agent-h-closed)')).toBe(44);
    expect(px(probe, 'calc(80vh - 10px)')).toBe(710);
    expect(px(probe, 'max(10px, min(30px, 20px))')).toBe(20);
    probe.remove();
  });
});

describe('review 3 MEDIUM-1: a resized log collapses to its header', () => {
  const mount = () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW_H });
    // A floating log, mid-window, 600 wide (review 3's repro, p5 given-*).
    window.localStorage.setItem('nebula:agentLog:pos', JSON.stringify({ left: 212, top: 300, anchorX: 'left', anchorY: 'top' }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(212, 812, 300, 600));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    const { container } = render(<AgentLog />);
    const log = container.querySelector<HTMLElement>('.agent-log')!;
    // The person's native resize writes an inline height.
    act(() => { log.style.height = '300px'; window.dispatchEvent(new Event('resize')); });
    return log;
  };

  it('open, it is the height the person gave it', () => {
    const log = mount();
    expect(log.classList.contains('agent-log--open')).toBe(true);
    expect(boxHeight(log)).toBe(300);
    window.localStorage.removeItem('nebula:agentLog:pos');
  });

  it('folded for the card, with an inline height of 300: the header\'s height', () => {
    const log = mount();
    act(() => useUIStore.getState().holdAgentLogForCard(true, true));
    expect(log.hasAttribute('data-card-collapsed')).toBe(true);
    expect(log.style.height).toBe('300px');
    expect(boxHeight(log)).toBe(44);
    // The card leaves: it reopens at the height the person gave it.
    act(() => useUIStore.getState().holdAgentLogForCard(false, false));
    expect(boxHeight(log)).toBe(300);
    window.localStorage.removeItem('nebula:agentLog:pos');
  });

  it('collapsed by the person, with an inline height of 300: the header\'s height', () => {
    const log = mount();
    act(() => { fireEvent.click(log.querySelector('.agent-log__header')!); });
    expect(log.classList.contains('agent-log--open')).toBe(false);
    expect(log.hasAttribute('data-card-collapsed')).toBe(false);
    expect(boxHeight(log)).toBe(44);
    window.localStorage.removeItem('nebula:agentLog:pos');
  });
});

describe('review 3 MEDIUM-2: the person can resize the log taller', () => {
  const log = (attrs: Record<string, string>) => {
    const el = document.createElement('div');
    el.className = 'agent-log agent-log--open';
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    document.body.appendChild(el);
    return el;
  };

  for (const [name, attrs] of [['docked', { 'data-docked': 'true' }], ['floating', { 'data-floating': 'top' }]] as const) {
    it(`${name}: an inline height above the last measured one, with no give, leaves max-height at or above it`, () => {
      const el = log(attrs);
      // Last measured at 154; the native corner drags it to 234.
      document.documentElement.style.setProperty('--agent-log-natural-h', '154px');
      el.style.height = '234px';
      expect(px(el, declared(el, 'max-height')!)).toBeGreaterThanOrEqual(234);
      expect(boxHeight(el)).toBe(234);
      // Main's own cap still holds: 80vh.
      el.style.height = '2000px';
      expect(boxHeight(el)).toBe(0.8 * VIEW_H);
      el.remove();
    });

    it(`${name}: while a give is in force it is bounded by the shown height, as before`, () => {
      const el = log(attrs);
      document.documentElement.style.setProperty('--agent-log-natural-h', '154px');
      el.style.height = '154px';
      // The give is the squeeze the region writes (one registered length).
      document.documentElement.style.setProperty('--agent-log-squeeze', '40px');
      expect(boxHeight(el)).toBe(114);
      // Even the least give the spring passes through bounds it.
      document.documentElement.style.setProperty('--agent-log-squeeze', '0.01px');
      expect(px(el, declared(el, 'max-height')!)).toBeCloseTo(153.99, 2);
      el.remove();
    });
  }
});
