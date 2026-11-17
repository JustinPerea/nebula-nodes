import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_STATES, VALUE_INITIALISMS, nodeStateWord, valueLabel } from '../../src/lib/valueLabel';

describe('valueLabel', () => {
  it.each([
    ['glb', 'GLB'],
    ['png', 'PNG'],
    ['3d_renders', '3D renders'],
    ['automatic', 'Automatic'],
    ['xhigh', 'Extra high'],
    ['hdr', 'HDR'],
  ])('%s reads %s', (value, shown) => {
    expect(valueLabel(value)).toBe(shown);
  });

  it('every initialism it writes in capitals is in the copy lint list, bar a few formats', () => {
    const rules = JSON.parse(readFileSync(resolve(process.cwd(), '../scripts/copy-lint-rules.json'), 'utf8'));
    const lint = new Set((rules.initialisms as string[]).map((word) => word.toLowerCase()));
    const outside = Object.keys(VALUE_INITIALISMS).filter((key) => !lint.has(key));
    expect(outside.sort()).toEqual(['fbx', 'hdr10', 'hlg', 'obj', 'ply', 'urls', 'usdz', 'glb'].sort());
  });
});

describe('the Inspector State row', () => {
  it('lists every state value with the word it shows', () => {
    expect(NODE_STATES.map((state) => [state, nodeStateWord(state)])).toEqual([
      ['idle', 'Idle'],
      ['queued', 'Queued'],
      ['executing', 'Executing'],
      ['complete', 'Complete'],
      ['error', 'Error'],
      ['skipped', 'Skipped'],
    ]);
  });
});
