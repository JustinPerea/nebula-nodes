// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { COMPATIBILITY, isPortCompatible, PORT_COLORS } from '../../src/lib/portCompatibility';
import { PORT_DATA_TYPES } from '../../src/constants/ports';

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

describe('ReferenceSet compatibility', () => {
  it('allows ReferenceSet to ReferenceSet', () => {
    expect(isPortCompatible('ReferenceSet', 'ReferenceSet')).toBe(true);
  });

  it('allows ReferenceSet to Any', () => {
    expect(isPortCompatible('ReferenceSet', 'Any')).toBe(true);
  });

  it('allows Any to ReferenceSet', () => {
    expect(isPortCompatible('Any', 'ReferenceSet')).toBe(true);
  });

  it('blocks ReferenceSet to Image', () => {
    expect(isPortCompatible('ReferenceSet', 'Image')).toBe(false);
  });

  it('blocks Image to ReferenceSet', () => {
    expect(isPortCompatible('Image', 'ReferenceSet')).toBe(false);
  });

  it('blocks ReferenceSet to every non-ReferenceSet, non-Any type', () => {
    const blocked = ['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Mesh', 'Character', 'Moodboard', 'CameraRig'] as const;
    for (const type of blocked) {
      expect(isPortCompatible('ReferenceSet', type)).toBe(false);
    }
  });

  it('registers ReferenceSet in the COMPATIBILITY table exactly as specified', () => {
    expect(COMPATIBILITY.ReferenceSet).toEqual(['ReferenceSet', 'Any']);
    expect(COMPATIBILITY.Any).toContain('ReferenceSet');
  });

  it('keeps role metadata advisory — compatibility keys are data types only', () => {
    // Roles (style/identity/...) are presentation metadata on PortDefinition,
    // never compatibility dimensions. The table must stay keyed by data type.
    expect(Object.keys(COMPATIBILITY).sort()).toEqual([...PORT_DATA_TYPES].sort());
    expect(isPortCompatible('Image', 'Image')).toBe(true);
    expect(isPortCompatible('Image', 'Mask')).toBe(true);
    expect(isPortCompatible('Image', 'Any')).toBe(true);
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

  it('has a color for ReferenceSet', () => {
    expect(PORT_COLORS.ReferenceSet).toBeDefined();
    expect(PORT_COLORS.ReferenceSet).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('covers every registered PORT_DATA_TYPES entry', () => {
    for (const type of PORT_DATA_TYPES) {
      expect(PORT_COLORS[type]).toBeDefined();
    }
  });
});
