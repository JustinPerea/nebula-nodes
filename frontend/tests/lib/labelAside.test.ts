import { describe, expect, it } from 'vitest';
import { snapParamDefaults } from '../../src/lib/paramDefaults';
import type { ModelNodeDefinition } from '../../src/types';

// An option label may carry an aside after " · " ("Claude Fable 5.1 · flagship")
// or in parentheses; a line that quotes the option names it without the aside.
const def = {
  params: [
    {
      key: 'model',
      label: 'Model',
      type: 'enum',
      default: 'a',
      options: [
        { label: 'A · b', value: 'a' },
        { label: 'C · d, e', value: 'c' },
        { label: 'F (g)', value: 'f' },
      ],
    },
    { key: 'limit', label: 'Limit', type: 'integer', default: 1, defaultBy: { model: { a: 1, c: 2, f: 3 } } },
  ],
} as unknown as ModelNodeDefinition;

describe('an option label quoted in a line', () => {
  it('reads as the name before the middle dot', () => {
    const snap = snapParamDefaults(def, { model: 'a' }, { model: 'c' });
    expect(snap.notes[0].text).toBe('Limit moved to 2, the C default.');
  });

  it('still drops a note in parentheses', () => {
    const snap = snapParamDefaults(def, { model: 'a' }, { model: 'f' });
    expect(snap.notes[0].text).toBe('Limit moved to 3, the F default.');
  });
});
