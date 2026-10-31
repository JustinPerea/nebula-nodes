// PR #203 round 19, GM r37: the comma before every second action (item 1)
// and sizes from the option's own label, "768 × 768" (item 3), on the card
// and in the switcher, which read the same builder (directRoute).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeAction, routeUnavailable } from '../../src/lib/directRoute';
import { providerSwitchState } from '../../src/lib/providerSwitch';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../../src/types';

const KEY = 'fixture-only';
const FLUX3 = NODE_DEFINITIONS['flux-3-image'] as ModelNodeDefinition;

describe('every second action takes the comma (GM r37 item 1)', () => {
  it.each([
    [{ text: 'Pick 1K', options: 1 }, ['fal.ai'], 'Pick 1K, or switch to fal.ai.'],
    ['Add it in Settings', ['fal.ai'], 'Add it in Settings, or switch to fal.ai.'],
    [{ text: 'Turn “Raw” off', options: 1 }, ['Replicate'], 'Turn “Raw” off, or switch to Replicate.'],
    [{ text: 'Pick 1K, 2K or 4K', options: 3 }, ['fal.ai'], 'Pick 1K, 2K or 4K, or switch to fal.ai.'],
    [{ text: 'Pick 1K', options: 1 }, ['fal.ai', 'Replicate'], 'Pick 1K, or switch to fal.ai or Replicate.'],
  ] as const)('%o with %o', (fix, others, expected) => {
    expect(routeAction(fix, others, [], null)).toBe(expected);
  });

  it('a single switch on the card: "Add it in Settings, or switch to fal.ai."', () => {
    expect(routeUnavailable(FLUX3, { _provider: 'bfl' }, { FAL_KEY: KEY })?.message).toBe(
      '“FLUX 3 Image” is set to Black Forest Labs, which needs your Black Forest Labs API key. '
      + 'Add it in Settings, or switch to fal.ai.');
  });
});

const SIZE_LINE = '“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K. Pick 768 × 768, 1K, 2K or 4K, '
  + 'or switch to Black Forest Labs or Replicate.';
const KEYS = { FAL_KEY: KEY, REPLICATE_API_TOKEN: KEY, BFL_API_KEY: KEY };

describe('sizes read the option’s own label, "768 × 768" (GM r37 item 3)', () => {
  it('the card’s line', () => {
    expect(routeUnavailable(FLUX3, { _provider: 'fal', resolution: '1.5k' }, KEYS)?.message).toBe(SIZE_LINE);
  });

  it('the switcher shows the same line', () => {
    const state = providerSwitchState(FLUX3, { _provider: 'fal', resolution: '1.5k' },
      { apiKeys: KEYS, kreaSignedIn: false, pricing: null, wired: new Map() });
    expect(JSON.stringify(state)).toContain('Pick 768 × 768, 1K, 2K or 4K');
    expect(JSON.stringify(state)).not.toMatch(/\d ?x ?\d/);
  });

  it('every size option label is written "A × B"', () => {
    const labels = Object.values(NODE_DEFINITIONS).flatMap((definition) => [...(definition.params ?? []),
      ...((definition as ModelNodeDefinition).sharedParams ?? [])]
      .flatMap((param) => (param.options ?? []).map((option) => String(option.label ?? ''))))
      .filter((label) => /\d\s*[xX×]\s*\d/.test(label));
    expect(labels.length).toBeGreaterThan(150);
    expect(labels).toContain('768 × 768');
    expect(labels.filter((label) => /\d\s*[xX]\s*\d|\d×|×\d/.test(label))).toEqual([]);
  });

  it('no line builder formats a size itself: they read the label as it is', () => {
    const builders = ['lib/directRoute.ts', 'lib/providerSwitch.ts', 'lib/nodeErrorCopy.ts', 'lib/errorCopy.ts',
      'components/nodes/ProviderSwitcher.tsx'];
    for (const name of builders) {
      const code = readFileSync(join(__dirname, '../../src', name), 'utf8').split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      expect([name, code.match(/\}\s*[xX×]\s*\$\{|['`"][^'`"\n]*\d\s*[xX×]\s*\d[^'`"\n]*['`"]/g)]).toEqual([name, null]);
    }
  });
});
