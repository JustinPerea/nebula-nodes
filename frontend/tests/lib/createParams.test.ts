import { describe, it, expect } from 'vitest';
import { matchesVisibleWhen, deriveVisibleParams } from '../../src/lib/createParams';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';

describe('matchesVisibleWhen', () => {
  it('is visible when undefined', () => {
    expect(matchesVisibleWhen(undefined, {})).toBe(true);
  });
  it('matches when every key value is in its allow-list', () => {
    expect(matchesVisibleWhen({ model: ['a', 'b'] }, { model: 'a' })).toBe(true);
    expect(matchesVisibleWhen({ model: ['a', 'b'] }, { model: 'c' })).toBe(false);
  });
});

describe('deriveVisibleParams', () => {
  it('drops hidden params and applies visibleWhen for nano-banana imageSize', () => {
    const def = NODE_DEFINITIONS['nano-banana'];
    // imageSize is only visible for the two flash/pro models
    const withFlash = deriveVisibleParams(def, { model: 'gemini-3.1-flash-image' });
    expect(withFlash.some((p) => p.key === 'imageSize')).toBe(true);

    const withLegacy = deriveVisibleParams(def, { model: 'gemini-2.5-flash-image' });
    expect(withLegacy.some((p) => p.key === 'imageSize')).toBe(false);
    // aspect_ratio is always visible
    expect(withLegacy.some((p) => p.key === 'aspect_ratio')).toBe(true);
  });
});
