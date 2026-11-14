import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * GM - Design, PR #212 round 5, ruling 2: on a card whose header sits over
 * media (a preview pulled up under the title) the header's wait tint is a pill
 * behind the label only, where the model chip sits, so the preview stays
 * visible; a header row on the card surface keeps the full-row tint.
 *
 * jsdom does not run the cascade, so the rule's own selector is read from
 * node-wait.css and matched against the card structures the cards draw.
 */
const wait = readFileSync(join(__dirname, '../src/styles/node-wait.css'), 'utf8');
const blocks = [...wait.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const pillRule = blocks.find((b) => b.selector.endsWith('.node-wait-swap__label::before'))!;
const rowRule = blocks.find((b) => b.selector.endsWith("> .model-node__header[data-waiting='true']"))!;
const fullRow = blocks.find((b) => b.selector.includes("model-node__header[data-waiting='true'],"))!;
const strip = (selector: string) => selector.replace(/^body\.app-slava-restraint /, '');

const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>('.model-node')!;
};
const labelOf = (root: HTMLElement) => root.querySelector<HTMLElement>('.node-wait-swap__label')!;
const header = (cls = '') => `<div class="model-node__header" data-waiting="true"><span class="node-wait-swap"><span class="node-wait-swap__label">Waiting for your OK</span></span></div>${cls}`;
const card = (inner: string, surface = '') => `<div class="model-node ${surface}"><div class="model-node__card">${inner}</div></div>`;

afterEach(() => { document.body.innerHTML = ''; });

describe('the wait over media', () => {
  it('the rule is the one place the pill lives: a ::before on the label, out of flow, on the same opaque tint as the full row', () => {
    expect(pillRule).toBeDefined();
    expect(pillRule.body).toMatch(/position:\s*absolute/);
    expect(pillRule.body).toMatch(/border-radius:\s*999px/);
    expect(pillRule.body).toMatch(/z-index:\s*-1/);
    // Same mix as the row: the label's ground, hence its contrast, is unchanged.
    const mix = 'color-mix(in srgb, var(--agent-color) var(--sr-wait-tint), var(--sr-wait-base))';
    expect(pillRule.body).toContain(`background-color: ${mix}`);
    expect(fullRow.body).toContain(`background-color: ${mix}`);
    // The header keeps no tint of its own over media, only the legibility gradient it has at rest.
    expect(rowRule.body).toMatch(/background-color:\s*transparent/);
    expect(rowRule.body).toMatch(/background-image:\s*var\(--sr-node-header-gradient\)/);
  });

  it('a header over a preview takes the pill (the label matches) and no row tint', () => {
    const selector = strip(pillRule.selector).replace(/::before$/, '');
    for (const preview of ['model-node__preview', 'model-node__preview model-node__preview--overview']) {
      const root = mount(card(header() + `<div class="${preview}"><video></video></div>`));
      expect(labelOf(root).matches(selector), preview).toBe(true);
    }
    // Other settings hold in between: a provider note or a stale-source note between the header and the preview.
    const withNote = mount(card(header() + '<div class="model-node__provider-note"></div><div class="model-node__preview"></div>'));
    expect(labelOf(withNote).matches(selector)).toBe(true);
  });

  it('a header on the card surface keeps the full-row tint (no pill): no preview, input ports above the preview, or a surface card', () => {
    const selector = strip(pillRule.selector).replace(/::before$/, '');
    const cases: Record<string, string> = {
      'no preview (an idle card)': card(header()),
      'input ports above the preview': card(header() + '<div class="model-node__ports model-node__ports--input"></div><div class="model-node__preview"></div>'),
      'a spatial preview that starts below the title': card(header() + '<div class="model-node__preview model-node__preview--spatial"></div>'),
      'a structured preview': card(header() + '<div class="model-node__preview model-node__preview--structured"></div>'),
      'a text surface': card(header() + '<div class="model-node__preview"></div>', 'model-node--text-surface'),
      'an image surface (the title is above the picture)': card(header() + '<div class="model-node__preview"></div>', 'model-node--image-surface'),
      'a world surface': card(header() + '<div class="model-node__preview model-node__preview--world"></div>', 'model-node--world-surface'),
      'a structured surface': card(header() + '<div class="model-node__preview"></div>', 'model-node--structured-surface'),
      'a Jev result': card(header() + '<div class="model-node__preview"></div>', 'model-node--jev-surface'),
    };
    for (const [name, html] of Object.entries(cases)) expect(labelOf(mount(html)).matches(selector), name).toBe(false);
    // The full-row tint rule still covers every model card's header and the Cinema title.
    expect(fullRow.selector).toContain(".model-node__card .model-node__header[data-waiting='true']");
    expect(fullRow.selector).toContain(".cinema-scene-node__title[data-waiting='true']");
    expect(fullRow.body).toMatch(/background-image:\s*none/);
  });

  it('the over-media row rule comes after the full-row rule and has the more specific selector, so it wins on a media card', () => {
    expect(rowRule.selector).toContain(':has(');
    expect(wait.indexOf(rowRule.selector)).toBeGreaterThan(wait.indexOf(fullRow.selector));
  });
});
