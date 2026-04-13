import { describe, it, expect } from 'vitest';
import { isPortCompatible, PORT_COLORS } from '../../src/lib/portCompatibility';

describe('isPortCompatible', () => {
  it('allows same-type connections', () => {
    expect(isPortCompatible('Text', 'Text')).toBe(true);
    expect(isPortCompatible('Image', 'Image')).toBe(true);
    expect(isPortCompatible('Video', 'Video')).toBe(true);
    expect(isPortCompatible('Audio', 'Audio')).toBe(true);
  });

  it('allows any type to connect to Any port', () => {
    expect(isPortCompatible('Text', 'Any')).toBe(true);
    expect(isPortCompatible('Image', 'Any')).toBe(true);
    expect(isPortCompatible('Video', 'Any')).toBe(true);
  });

  it('allows Any output to connect to any input', () => {
    expect(isPortCompatible('Any', 'Text')).toBe(true);
    expect(isPortCompatible('Any', 'Image')).toBe(true);
  });

  it('allows Image to Mask with warning', () => {
    expect(isPortCompatible('Image', 'Mask')).toBe(true);
  });

  it('allows Mask to Image with warning', () => {
    expect(isPortCompatible('Mask', 'Image')).toBe(true);
  });

  it('allows SVG to Any', () => {
    expect(isPortCompatible('SVG', 'Any')).toBe(true);
  });

  it('blocks Video to Image', () => {
    expect(isPortCompatible('Video', 'Image')).toBe(false);
  });

  it('blocks Audio to Image', () => {
    expect(isPortCompatible('Audio', 'Image')).toBe(false);
  });

  it('blocks Text to Image', () => {
    expect(isPortCompatible('Text', 'Image')).toBe(false);
  });

  it('blocks Image to Text', () => {
    expect(isPortCompatible('Image', 'Text')).toBe(false);
  });

  it('blocks Video to Audio', () => {
    expect(isPortCompatible('Video', 'Audio')).toBe(false);
  });
});

describe('PORT_COLORS', () => {
  it('has a color for every port type', () => {
    const types = ['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Any'];
    for (const type of types) {
      expect(PORT_COLORS[type as keyof typeof PORT_COLORS]).toBeDefined();
      expect(PORT_COLORS[type as keyof typeof PORT_COLORS]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
