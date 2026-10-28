import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { chipEstimate, chipTitle, type PricingTable } from '../src/lib/pricing';
import { runChipTitle, summarizeRunScope } from '../src/lib/runScope';
import * as unpriced from '../src/lib/unpricedCopy';
import * as scene from '../src/lib/sceneSaveCopy';
import { studioBoundaryLogLine } from '../src/lib/studioBoundary';
import { OFFLINE_VERBS, offlineReason } from '../src/lib/useBackendOffline';
import type { NodeData } from '../src/types';

/**
 * PR #198 fix round 6: GM's words for round 5's placeholders (gm-pr198-r8),
 * verbatim, plus the Rerun verb (gm-pr200-r4 item 2) and the toast rule
 * ("Toasts wrap to 3 lines and never cut a sentence", app-wide).
 */

describe('GM r8: the scene save lines', () => {
  it('UNSAVED_MARK, CHANGED_ELSEWHERE and SWITCHED_UNNAMED', () => {
    expect(scene.UNSAVED_MARK).toBe('Not saved');
    expect(`${scene.sceneSaveHeading('X')} ${scene.CHANGED_ELSEWHERE}`)
      .toBe("Couldn't save your changes to “X”. It was changed in another window first, so your changes are kept on screen but not saved.");
    expect(`${scene.sceneSaveHeading('X')} ${scene.SWITCHED_UNNAMED}`)
      .toBe("Couldn't save your changes to “X”. The canvas switched to another project first.");
  });
});

describe('GM r8: the "+ unpriced" tooltip lines', () => {
  const one = (line: (names: string, several: boolean) => string) => line('“X”', false);
  const two = (line: (names: string, several: boolean) => string) => line('“A” and “B”', true);

  it('the plurals', () => {
    expect(two(unpriced.NO_LISTED_PRICE)).toBe('“A” and “B” have no listed price.');
    expect(unpriced.NO_LISTED_PRICE('4 nodes', true)).toBe('4 nodes have no listed price.');
    expect(unpriced.MISSING_KEY('“A” and “B”', true, 'fal.ai API key')).toBe('“A” and “B” can\'t be priced until their fal.ai API key is added.');
    expect(two(unpriced.AWAITING_INPUT)).toBe('“A” and “B” are priced from their inputs, which aren\'t ready yet.');
  });

  it('a missing key with no provider', () => {
    expect(unpriced.MISSING_KEY('“X”', false, unpriced.MISSING_KEY_UNNAMED)).toBe('“X” can\'t be priced until its API key is added.');
  });

  it('a route that can\'t run, and a size Nebula couldn\'t read', () => {
    expect(one(unpriced.ROUTE_CANT_RUN)).toBe('“X” can\'t run as it\'s set up now, so it has no price.');
    expect(one(unpriced.SIZE_UNREADABLE)).toBe('“X” is priced by its input size, which Nebula couldn\'t read.');
    // Builder's plurals of GM's singular lines, for GM to confirm.
    expect(two(unpriced.ROUTE_CANT_RUN)).toBe('“A” and “B” can\'t run as they\'re set up now, so they have no price.');
    expect(two(unpriced.SIZE_UNREADABLE)).toBe('“A” and “B” are priced by their input sizes, which Nebula couldn\'t read.');
  });

  it('each cost the estimate leaves out, by name', () => {
    expect(one(unpriced.LEFT_OUT['input images'])).toBe('“X” may cost more for its input images, which the estimate leaves out.');
    expect(one(unpriced.LEFT_OUT['thinking tokens'])).toBe('“X” may cost more for the model\'s thinking, which the estimate leaves out.');
    expect(one(unpriced.LEFT_OUT['input media and thinking tokens']))
      .toBe('“X” may cost more for its input media and the model\'s thinking, which the estimate leaves out.');
    expect(two(unpriced.LEFT_OUT['input images'])).toBe('“A” and “B” may cost more for their input images, which the estimate leaves out.');
    expect(two(unpriced.LEFT_OUT['thinking tokens'])).toBe('“A” and “B” may cost more for the models\' thinking, which the estimate leaves out.');
    expect(two(unpriced.LEFT_OUT['input media and thinking tokens']))
      .toBe('“A” and “B” may cost more for their input media and the models\' thinking, which the estimate leaves out.');
  });

  it('a free priced part has no line: $0 is a price, not unpriced', () => {
    expect(chipTitle(chipEstimate(0, 0, true))).toBe('');
    const title = runChipTitle({ total: 2, paid: ['Free', 'Writer'], cost: { low: 0, high: 0, lines: [{ name: 'Free', low: 0, high: 0, runs: [1, 1] }],
      unpriced: ['Writer'], plan: [], plus: [], sizeRefs: [],
      reasons: [{ name: 'Writer', reason: { kind: 'noPrice' }, at: { x: 0, y: 0 } }] } } as never);
    expect(title).toBe('“Writer” has no listed price.');
  });

  const pricing: PricingTable = { currencies: {}, nodes: {
    'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: { imageSize: '1K' }, price: 0.05 }] },
    'gpt-image-2-edit': { currency: 'usd', per: 'image', plus: 'input images', rows: [{ match: {}, price: [0.01, 0.2] }] },
  } } as unknown as PricingTable;
  const node = (id: string, definitionId: string, label: string, x: number): Node<NodeData> =>
    ({ id, position: { x, y: 0 }, data: { definitionId, label, params: {} } as unknown as NodeData });

  it('the left-out lines group with the name helper, in canvas order', () => {
    const graph = [node('a', 'nano-banana', 'Hero', 0), node('e1', 'gpt-image-2-edit', 'Edit A', 100), node('e2', 'gpt-image-2-edit', 'Edit B', 200)];
    const title = runChipTitle(summarizeRunScope(graph, [], { kind: 'graph' }, { pricing, apiKeys: {} }));
    expect(title).toBe('The priced part of this run costs between $0.07 and $0.45. '
      + '“Edit A” and “Edit B” may cost more for their input images, which the estimate leaves out.');
  });
});

describe('GM r8 deviation 3: the studio\'s Agent log line names the studio', () => {
  it('damaged data opened in Cinema', () => {
    expect(studioBoundaryLogLine('X', 'n4', { field: 'scene.base', state: 'missing' }, 'cinema-editor'))
      .toBe("Couldn't open “X” in Cinema, node n4. scene.base is missing.");
    expect(studioBoundaryLogLine(null, 'n4', null, 'cinema-editor')).toBe("Couldn't open a node in Cinema, node n4. Its data couldn't be read.");
    // A canvas card's line has no studio.
    expect(studioBoundaryLogLine('X', 'n4', { field: 'scene.base', state: 'damaged' })).toBe("Couldn't open “X”, node n4. scene.base is damaged.");
  });
});

describe('GM (#200 r4 item 2): the offline Rerun verb', () => {
  it('"You can rerun it when Nebula reconnects."', () => {
    expect(offlineReason(OFFLINE_VERBS.rerun)).toBe('You can rerun it when Nebula reconnects.');
  });
});

describe('GM r8: no toast cuts a sentence', () => {
  // Every stylesheet; a toast or notice's text never sits on one line with an
  // ellipsis, so it wraps (GM: up to 3 lines) instead of cutting. A toast's
  // buttons (its action, "Back to …", ×) keep their own one-line rules.
  const root = join(__dirname, '../src');
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path); else if (name.endsWith('.css')) files.push(path); } };
  walk(root);
  const rules = files.flatMap((file) => {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ file: file.slice(root.length + 1), selector: selector.trim(), body }));
  });

  it('finds the toasts', () => {
    expect(rules.some((rule) => /canvas-undo-notice__text/.test(rule.selector))).toBe(true);
    expect(rules.some((rule) => /project-home__toast-text/.test(rule.selector))).toBe(true);
  });

  it('no toast or notice text is cut with an ellipsis or kept to one line', () => {
    const cut = rules.filter((rule) => /(toast|notice)(?![\w-]*(dot|icon|close|action|button|dismiss|back))/i.test(rule.selector)
      && (/text-overflow:\s*ellipsis/.test(rule.body) || /white-space:\s*nowrap/.test(rule.body)))
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(cut).toEqual([]);
  });
});
