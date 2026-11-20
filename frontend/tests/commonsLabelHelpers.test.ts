import { describe, expect, it } from 'vitest';
import {
  axisLabel, axisValue, capitalised, deviceStateLabel, enumFieldLabel, enumValueLabel, fidelityStatusLabel,
  madeBySentence, mediaLabel, paletteRoleLabel, regionStatusLabel, sourceKindLabel,
} from '../src/lib/commonsTypes';
import { actorLabel, analysisBadge } from '../src/lib/commonsFormat';

/** Every label helper takes a value the backend may omit: null, undefined and '' read as empty, never throw. */
const helpers: Array<[string, (v: string | null | undefined) => string]> = [
  ['capitalised', capitalised],
  ['paletteRoleLabel', paletteRoleLabel],
  ['sourceKindLabel', sourceKindLabel],
  ['regionStatusLabel', regionStatusLabel],
  ['fidelityStatusLabel', fidelityStatusLabel],
  ['deviceStateLabel', deviceStateLabel],
  ['mediaLabel', mediaLabel],
  ['madeBySentence', madeBySentence],
  ['axisLabel', axisLabel],
  ['enumFieldLabel', enumFieldLabel],
  ['enumValueLabel', (v) => enumValueLabel('layout', v)],
  ['actorLabel', (v) => actorLabel(v)],
  ['actorLabel mid-sentence', (v) => actorLabel(v, { midSentence: true })],
  ['analysisBadge', (v) => analysisBadge(v as never).label],
];

describe('Commons label helpers with a missing value', () => {
  it.each(helpers)('%s reads null, undefined and an empty string as empty', (_name, fn) => {
    expect(fn(null)).toBe('');
    expect(fn(undefined)).toBe('');
    expect(fn('')).toBe('');
  });
  it.each(helpers.filter(([n]) => n !== 'actorLabel' && n !== 'actorLabel mid-sentence'))(
    '%s does not return inherited properties for "constructor" or "toString"', (_name, fn) => {
      for (const key of ['constructor', 'toString']) {
        const out = fn(key);
        expect(typeof out).toBe('string');
        expect(out).not.toMatch(/function|native code/);
      }
    });
  it('looks up own labels only', () => {
    expect(axisLabel('constructor')).toBe('Constructor');
    expect(enumValueLabel('layout', 'constructor')).toBe('Constructor');
    expect(enumValueLabel('layout', 'toString')).toBe('ToString');
    expect(enumValueLabel('constructor' as never, 'x')).toBe('X');
  });
  it('gives a palette role the capitalised fallback', () => {
    expect(paletteRoleLabel('accent')).toBe('Accent');
    expect(paletteRoleLabel('highlight_tone')).toBe('Highlight tone');
  });
});

describe('axisValue', () => {
  it('uses a true minus for a negative and no sign for zero', () => {
    expect(axisValue(-0.4)).toBe('−0.40');
    expect(axisValue(0.25)).toBe('+0.25');
    expect(axisValue(1)).toBe('+1.00');
    expect(axisValue(0.001)).toBe('0.00');
    expect(axisValue(0)).toBe('0.00');
    expect(axisValue(-0)).toBe('0.00');
    expect(axisValue(-0.001)).toBe('0.00');
    expect(axisValue(null)).toBe('');
    expect(axisValue(undefined)).toBe('');
  });
});
