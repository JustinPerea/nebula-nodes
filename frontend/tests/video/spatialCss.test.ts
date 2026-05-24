import { describe, it, expect } from 'vitest';
import { transformOriginFromAnchor } from '../../src/lib/video/spatialCss';

describe('transformOriginFromAnchor', () => {
  it('defaults to center origin', () => {
    expect(transformOriginFromAnchor()).toBe('50% 50%');
  });

  it('converts normalized anchor coordinates to CSS percentages', () => {
    expect(transformOriginFromAnchor([0, 1])).toBe('0% 100%');
    expect(transformOriginFromAnchor([1, 0.5])).toBe('100% 50%');
  });
});
