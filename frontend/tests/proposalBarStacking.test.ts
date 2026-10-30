import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GM r7 (PR #203): every modal sits above the proposal bar, which stays
 * visible under the modal's scrim, dimmed like the rest of the canvas; one
 * rule for every modal (the Idol and World v1 viewers included), on a shared
 * layer token. GM r25 still holds: the notices sit above every dialog's
 * backdrop.
 *
 * The notice region takes no layer of its own (a fixed box would make one
 * layer of all its items), so each item carries its own: the notices
 * --sr-layer-notice, the proposal bar --sr-layer-proposal, which is one under
 * --sr-layer-modal, the lowest layer any modal draws on.
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

/** Every z-index a rule whose selector ends on `rootClass` sets. */
function layersOf(rootClass: string): number[] {
  const ending = new RegExp(`\\.${rootClass}(?![\\w-])(\\[[^\\]]*\\]|:[\\w-]+(\\([^)]*\\))?)*$`);
  return rules()
    .filter(([selector]) => selector.split(',').some((part) => ending.test(part.trim())))
    .flatMap(([, body]) => [...body.matchAll(/z-index:\s*([^;]+);/g)].map((match) => resolve(match[1])));
}

/** The root of each dialog rendered through ModalPortal, and the mask
 * painter, which takes the modal rules itself (maskPainterDialog.ts). */
const MODAL_ROOTS = [
  'world-modal-overlay', // the Idol (World v2) and World v1 viewers
  'mesh-modal-overlay',
  'prompt-dialog', // the prompt, placeholder run, unsaved edits and forget-recovery dialogs
  'command-palette',
  'keyboard-shortcuts',
  'model-picker-overlay',
  'result-comparison',
  'lightbox',
  'commons-prompt',
  'personal-warning',
  'onboarding',
  'mask-painter__overlay',
];

describe('the proposal bar under every modal (GM r7, PR #203)', () => {
  const proposal = resolve('var(--sr-layer-proposal)');
  const notice = resolve('var(--sr-layer-notice)');

  it('reads its layer from the shared token, one under the lowest modal layer', () => {
    expect(TOKENS['--sr-layer-proposal']).toBe('calc(var(--sr-layer-modal) - 1)');
    expect(proposal).toBe(resolve('var(--sr-layer-modal)') - 1);
    const slot = rules().filter(([selector]) => selector.includes("[data-notice-slot='proposal']"));
    expect(slot.flatMap(([, body]) => [...body.matchAll(/z-index:\s*([^;]+);/g)].map((match) => match[1].trim())))
      .toEqual(['var(--sr-layer-proposal, 59)']);
  });

  it.each(MODAL_ROOTS)('.%s draws above the proposal bar and under the notices', (root) => {
    const layers = layersOf(root);
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      expect(layer).toBeGreaterThan(proposal);
      expect(layer).toBeLessThan(notice);
    }
  });

  it('above every panel, the Agent log, popovers and the Studios with their docks', () => {
    for (const token of ['--sr-layer-panel', '--sr-layer-agent-log', '--sr-layer-settings', '--sr-layer-popover',
      '--sr-layer-workspace', '--sr-layer-workspace-overlay']) {
      expect(proposal).toBeGreaterThan(resolve(`var(${token})`));
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
