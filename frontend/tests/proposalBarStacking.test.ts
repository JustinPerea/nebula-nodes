import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cascaded } from './helpers/cssCascade';

/**
 * The proposal bar's layer, PR #203. GM r7: every modal sits above the bar,
 * which stays visible under the modal's scrim, dimmed like the rest of the
 * canvas. GM r9 item 2 and r10 (round 6), the rule: anything the person
 * opened draws above the proposal bar (every panel, Settings, context menus,
 * popovers, the chat model picker, the drag layer, the viewers, the palette
 * and every other modal), and lasting chrome they didn't open draws under it
 * (the bottom bar, the canvas tabs, the following bar). GM r25 still holds:
 * the notices sit above every dialog's backdrop.
 *
 * The notice region takes no layer of its own (a fixed box would make one
 * layer of all its items), so each item carries its own: the notices
 * --sr-layer-notice, the proposal bar --sr-layer-proposal, one under
 * --sr-layer-panel, the lowest layer the person opens anything on; the
 * lasting chrome is on --sr-layer-ambient, one under that.
 */

const SRC = join(__dirname, '..', 'src');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

const CSS = cssFiles(SRC).map((file) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');

function rules(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(CSS); match; match = pattern.exec(CSS)) out.push([match[1].trim(), match[2]]);
  return out;
}

const TOKENS: Record<string, string> = Object.fromEntries(
  [...CSS.matchAll(/(--sr-layer-[a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
);

/** A z-index value as a number: a number, a layer token (its fallback when
 * it has none), or a calc of those. */
function resolve(value: string): number {
  const text = value.trim();
  const token = /^var\((--[a-z-]+)(?:,\s*([^)]+))?\)$/.exec(text);
  if (token) return resolve(TOKENS[token[1]] ?? token[2]);
  const calc = /^calc\((.+)\)$/.exec(text);
  if (calc) {
    // A sum of terms (`a - b`, `a + b`), each a number or a layer token.
    const terms = calc[1].replace(/var\((--[a-z-]+)(?:,\s*[^)]+)?\)/g, (_, name: string) => String(resolve(`var(${name})`)))
      .trim().split(/\s+/);
    let total = resolve(terms[0]);
    for (let index = 1; index < terms.length; index += 2) {
      const term = resolve(terms[index + 1]);
      if (terms[index] === '+') total += term;
      else if (terms[index] === '-') total -= term;
      else throw new Error(`unreadable calc ${value}`);
    }
    return total;
  }
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`unreadable z-index ${value}`);
  return number;
}

/** Every z-index a rule whose selector ends on `rootClass` sets (the skin
 * that is shown: the legacy body:not(.app-slava-restraint) look never is). */
function layersOf(rootClass: string): number[] {
  const ending = new RegExp(`\\.${rootClass}(?![\\w-])(\\[[^\\]]*\\]|:[\\w-]+(\\([^)]*\\))?)*$`);
  return rules()
    .filter(([selector]) => selector.split(',').some((part) => ending.test(part.trim()) && !/:not\(\.app-slava-restraint\)/.test(part)))
    .flatMap(([, body]) => [...body.matchAll(/z-index:\s*([^;]+);/g)].map((match) => resolve(match[1])));
}

/** The z-index the app's sheets give `element` (in the shown skin), resolved. */
function layerOf(element: Element): number {
  const value = cascaded(element).get('|z-index')?.value;
  if (!value) throw new Error(`no z-index for ${element.outerHTML.slice(0, 80)}`);
  return resolve(value);
}

const RAW_CSS = cssFiles(SRC).map((file) => readFileSync(file, 'utf8')).join('\n');

/** The first class of each JSX className, in source order, with its line. */
function classNames(source: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  const pattern = /className=(?:"([\w-]+)|\{`([\w-]+))/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    out.push({ name: match[1] ?? match[2], line: source.slice(0, match.index).split('\n').length });
  }
  return out;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * Review r5 NIT-1: the modal roots, derived, not hand-kept. Every dialog that
 * renders through ModalPortal, and every element marked aria-modal="true":
 * its root is the first element after `<ModalPortal>` (or, from the
 * aria-modal element, the nearest one at or before it) whose class the
 * sheets give a z-index. A ModalPortal whose child is a component (the mask
 * painter's DeferredBoundary) takes its root from that component's own
 * aria-modal element.
 */
function modalRoots(): Array<{ file: string; root: string | null }> {
  const found: Array<{ file: string; root: string | null }> = [];
  const layered = (name: string) => layersOf(name).length > 0;
  for (const path of tsxFiles(join(SRC, 'components'))) {
    const source = readFileSync(path, 'utf8');
    const file = relative(SRC, path);
    const names = classNames(source);
    const lines = source.split('\n');
    lines.forEach((text, index) => {
      const line = index + 1;
      if (/<ModalPortal>/.test(text)) {
        const root = names.find((entry) => entry.line >= line && layered(entry.name))?.name ?? null;
        // A component child (no layered class of its own): its aria-modal element counts instead.
        if (root || !/<[A-Z]/.test(lines.slice(index + 1, index + 3).join(' '))) found.push({ file, root });
      }
      if (/(^|\s)aria-modal(="true"|=\{true\}|\s*$|\s)/.test(text) && !/aria-modal="false"/.test(text)) {
        const root = [...names].reverse().find((entry) => entry.line <= line && layered(entry.name))?.name ?? null;
        found.push({ file, root });
      }
    });
  }
  return found;
}

describe('the proposal bar between what the person opened and the lasting chrome (GM r7, r9 item 2, r10)', () => {
  const proposal = resolve('var(--sr-layer-proposal)');
  const ambient = resolve('var(--sr-layer-ambient)');
  const notice = resolve('var(--sr-layer-notice)');

  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('GM r10\'s rule is written next to the token, so the next floating surface follows it', () => {
    const at = RAW_CSS.indexOf('--sr-layer-proposal:');
    const before = RAW_CSS.slice(Math.max(0, at - 2500), at);
    expect(before).toMatch(/anything\s+\*?\s*the person opened draws above the proposal bar/);
    expect(before).toMatch(/lasting chrome they\s+\*?\s*didn't open draws under it/);
  });

  it('reads its layer from the shared token: one under every panel, the lasting chrome one under that', () => {
    expect(TOKENS['--sr-layer-proposal']).toBe('calc(var(--sr-layer-panel) - 1)');
    expect(TOKENS['--sr-layer-ambient']).toBe('calc(var(--sr-layer-proposal) - 1)');
    expect(proposal).toBe(resolve('var(--sr-layer-panel)') - 1);
    expect(ambient).toBe(proposal - 1);
    // Above the canvas itself (React Flow's own layer is 0 at the root).
    expect(ambient).toBeGreaterThan(0);
    const slot = rules().filter(([selector]) => selector.startsWith('.notice-region__slot') && selector.includes("[data-notice-slot='proposal']"));
    expect(slot.flatMap(([, body]) => [...body.matchAll(/z-index:\s*([^;]+);/g)].map((match) => match[1].trim())))
      .toEqual([`var(--sr-layer-proposal, ${proposal})`]);
  });

  it('every layer the person opens is above it: panels, the Agent log, Settings, popovers, the Studios, modals', () => {
    for (const token of ['--sr-layer-panel', '--sr-layer-agent-log', '--sr-layer-settings', '--sr-layer-popover',
      '--sr-layer-workspace', '--sr-layer-workspace-overlay', '--sr-layer-modal', '--sr-layer-modal-control', '--sr-layer-drag']) {
      expect(resolve(`var(${token})`), token).toBeGreaterThan(proposal);
    }
  });

  // GM r10, by name: context menus, Settings, popovers, the model picker, the viewer and the palette; GM r9: the drag layer.
  it.each([
    'context-menu', 'connection-popup', 'panel--settings', 'panel', 'chat-panel', 'panel--library', 'node-inspector-popover',
    'agent-log', 'provider-switcher__popover', 'final-export__popover', 'chat-model-picker__dialog', 'slava-library-drag-preview',
    'toolbar--actions-open', 'command-palette', 'world-modal-overlay', 'mesh-modal-overlay', 'agent-notes-panel',
  ])('.%s (the person opened it) draws above the bar', (root) => {
    const layers = layersOf(root);
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) expect(layer).toBeGreaterThan(proposal);
  });

  it('Settings at its own layer, not stopped at the bar: no rule caps it by the notice region', () => {
    document.body.className = 'app-slava-restraint';
    const settings = document.createElement('div');
    settings.className = 'panel panel--settings';
    document.body.append(settings);
    expect(layerOf(settings)).toBeGreaterThan(proposal);
    const styles = cascaded(settings);
    for (const prop of ['max-height', 'bottom', 'height']) {
      expect(styles.get(`|${prop}`)?.value ?? '', prop).not.toMatch(/notice|proposal/);
    }
  });

  it('the lasting chrome is under it: the bottom bar and the canvas tabs, as the shown skin cascades them', () => {
    document.body.className = 'app-slava-restraint';
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar toolbar--grouped';
    const tabs = document.createElement('div');
    tabs.className = 'canvas-tabs-wrap';
    document.body.append(toolbar, tabs);
    expect(layerOf(toolbar)).toBe(ambient);
    expect(layerOf(tabs)).toBe(ambient);
    // Opened, the bottom bar's Canvas actions panel is the person's: above.
    toolbar.classList.add('toolbar--actions-open');
    expect(layerOf(toolbar)).toBeGreaterThan(proposal);
  });

  it('the following bar: under the bar while a proposal shows; with a modal open, its raise over the scrim holds (GM r9 item 2)', () => {
    document.body.className = 'app-slava-restraint';
    document.body.innerHTML = `
      <div class="notice-region" data-notice-region><div class="notice-region__stack">
        <div class="notice-region__slot" data-notice-slot="proposal"></div></div></div>
      <div class="canvas-tabs-wrap" data-following></div>`;
    const tabs = document.querySelector('.canvas-tabs-wrap')!;
    const slot = document.querySelector('[data-notice-slot="proposal"]')!;
    const painter = resolve(/z-index:\s*([^;]+);/.exec(rules().find(([selector]) => selector === '.mask-painter__overlay')![1])![1]);
    // No proposal: raised as before (over the mask painter's scrim, review 3 LOW-3 of PR #200).
    expect(layerOf(tabs)).toBeGreaterThan(painter);
    const bar = document.createElement('div');
    bar.className = 'proposal-bar';
    slot.append(bar);
    expect(layerOf(tabs)).toBe(ambient);
    expect(layerOf(tabs)).toBeLessThan(layerOf(bar));
    // A leaving bar no longer holds it down.
    bar.setAttribute('data-leaving', 'surface');
    expect(layerOf(tabs)).toBeGreaterThan(painter);
    bar.removeAttribute('data-leaving');
    // The mask painter open (a modal portal): over its scrim again; the bar is under that scrim.
    const portal = document.createElement('div');
    portal.className = 'modal-portal';
    document.body.append(portal);
    expect(layerOf(tabs)).toBeGreaterThan(painter);
    expect(layerOf(bar)).toBeLessThan(painter);
  });

  it('the modal roots are derived from the components (review r5 NIT-1), and include every one the old list named', () => {
    const roots = modalRoots();
    const missing = roots.filter(({ root }) => root === null).map(({ file }) => file);
    expect(missing, 'a modal with no layered root').toEqual([]);
    const names = new Set(roots.map(({ root }) => root));
    for (const known of ['world-modal-overlay', 'mesh-modal-overlay', 'prompt-dialog', 'command-palette', 'keyboard-shortcuts',
      'model-picker-overlay', 'result-comparison', 'lightbox', 'commons-prompt', 'personal-warning', 'onboarding',
      'mask-painter__overlay']) {
      expect(names.has(known), known).toBe(true);
    }
  });

  it('every modal root draws above the proposal bar and under the notices', () => {
    for (const root of new Set(modalRoots().map((entry) => entry.root!))) {
      const layers = layersOf(root);
      expect(layers.length, root).toBeGreaterThan(0);
      for (const layer of layers) {
        expect(layer, root).toBeGreaterThan(proposal);
        expect(layer, root).toBeLessThan(notice);
      }
    }
  });

  it('the region itself takes no layer, so each item keeps its own', () => {
    const region = rules().filter(([selector]) => selector === '.notice-region');
    const body = region.map(([, text]) => text).join('\n');
    expect(body).toMatch(/position:\s*absolute;/);
    expect(body).toMatch(/z-index:\s*auto;/);
    const items = rules().filter(([selector]) => selector === '.notice-region__slot > *');
    expect(items.map(([, text]) => /z-index:\s*var\(--sr-layer-notice, 20010\);/.test(text))).toEqual([true]);
  });

  // Review r5 LOW-3: the notices are above every dialog, and the bar under
  // them, only because none of the three makes a stacking context.
  it('no stacking context on .notice-region, its __stack or its __slot (and the reason is written in the CSS)', () => {
    const subjects = /\.notice-region(__stack|__slot)?(?![\w-])(\[[^\]]*\]|:[\w-]+(\([^)]*\))?)*$/;
    const ours = rules().filter(([selector]) => selector.split(',').some((part) => subjects.test(part.trim())));
    expect(ours.length).toBeGreaterThanOrEqual(4);
    const traps: string[] = [];
    for (const [selector, body] of ours) {
      for (const [, prop, value] of body.matchAll(/(?:^|;|\s)([a-z-]+)\s*:\s*([^;]+)/g)) {
        const v = value.trim();
        const trap = (['transform', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'perspective', 'clip-path', 'mask'].includes(prop) && !/^none\b/.test(v))
          || (prop === 'opacity' && Number.parseFloat(v) < 1)
          || (prop === 'isolation' && v !== 'auto')
          || (prop === 'contain' && v !== 'none')
          || (prop === 'will-change' && v !== 'auto')
          || (prop === 'mix-blend-mode' && v !== 'normal')
          || (prop === 'z-index' && v !== 'auto')
          || (prop === 'container-type' && v !== 'normal');
        if (trap) traps.push(`${selector}: ${prop}: ${v}`);
      }
    }
    expect(traps).toEqual([]);
    const regionCss = readFileSync(join(SRC, 'styles/noticeRegion.css'), 'utf8');
    expect(regionCss).toMatch(/No stacking context on the region, the stack or the slots/);
  });

  it('the stack never grows into the top bars (GM r9 item 2): capped by its measured room, scrolling past it, items never shrinking', () => {
    const stack = rules().filter(([selector]) => selector === '.notice-region__stack').map(([, body]) => body).join('\n');
    expect(stack).toMatch(/max-height:\s*var\(--notice-room, none\)/);
    const crowded = rules().find(([selector]) => selector === '.notice-region[data-notice-crowded] .notice-region__stack');
    expect(crowded?.[1]).toMatch(/overflow-y:\s*auto/);
    expect(rules().find(([selector]) => selector === '.notice-region__slot > *')?.[1]).toMatch(/flex-shrink:\s*0/);
  });
});

describe("a dialog's Tab order skips the proposal bar under its scrim (GM r7, PR #203)", () => {
  it('reaches the notices above the scrim, never the bar under it', async () => {
    const { noticeTabbables } = await import('../src/lib/modalFocus');
    document.body.innerHTML = `
      <div data-notice-region>
        <div class="notice-region__slot" data-notice-slot="proposal"><div><button>Accept and run</button></div></div>
        <div class="notice-region__slot" data-notice-slot="toast"><div><button aria-label="Dismiss">×</button></div></div>
      </div>`;
    try {
      expect(noticeTabbables().map((element) => element.textContent)).toEqual(['×']);
    } finally {
      document.body.innerHTML = '';
    }
  });
});
