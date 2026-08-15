// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  REFERENCE_ROLES,
  REFERENCE_ROLE_IDS,
  REFERENCE_WEIGHT_DEFAULT,
  REFERENCE_WEIGHT_MIN,
  REFERENCE_WEIGHT_MAX,
  clampReferenceWeight,
} from '../../src/lib/referenceRoles';
import type {
  PortDefinition,
  DynamicPortDefinition,
  ReferenceSetBundle,
} from '../../src/types';

describe('REFERENCE_ROLES', () => {
  it('defines exactly 7 standard roles', () => {
    expect(REFERENCE_ROLE_IDS).toHaveLength(7);
    expect(Object.keys(REFERENCE_ROLES)).toHaveLength(7);
    expect(REFERENCE_ROLE_IDS).toEqual([
      'style',
      'identity',
      'composition',
      'pose',
      'lighting',
      'subject',
      'background',
    ]);
  });

  it('every role has a label, hex color, and description', () => {
    for (const id of REFERENCE_ROLE_IDS) {
      const role = REFERENCE_ROLES[id];
      expect(typeof role.label).toBe('string');
      expect(role.label.length).toBeGreaterThan(0);
      expect(role.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(typeof role.description).toBe('string');
      expect(role.description.length).toBeGreaterThan(0);
    }
  });

  it('matches the architecture-specified colors exactly', () => {
    expect(REFERENCE_ROLES.style.color).toBe('#e8a87c');
    expect(REFERENCE_ROLES.identity.color).toBe('#c38d9e');
    expect(REFERENCE_ROLES.composition.color).toBe('#85cdca');
    expect(REFERENCE_ROLES.pose.color).toBe('#e27d60');
    expect(REFERENCE_ROLES.lighting.color).toBe('#41b3a3');
    expect(REFERENCE_ROLES.subject.color).toBe('#fce38a');
    expect(REFERENCE_ROLES.background.color).toBe('#a8d8ea');
  });

  it('uses human-readable labels', () => {
    expect(REFERENCE_ROLES.style.label).toBe('Style');
    expect(REFERENCE_ROLES.identity.label).toBe('Identity');
    expect(REFERENCE_ROLES.composition.label).toBe('Composition');
    expect(REFERENCE_ROLES.pose.label).toBe('Pose');
    expect(REFERENCE_ROLES.lighting.label).toBe('Lighting');
    expect(REFERENCE_ROLES.subject.label).toBe('Subject');
    expect(REFERENCE_ROLES.background.label).toBe('Background');
  });
});

describe('reference weight contract', () => {
  it('defaults to 1.0', () => {
    expect(REFERENCE_WEIGHT_DEFAULT).toBe(1.0);
  });

  it('declares the 0.0-1.0 slider range', () => {
    expect(REFERENCE_WEIGHT_MIN).toBe(0);
    expect(REFERENCE_WEIGHT_MAX).toBe(1);
  });

  it('clamps out-of-range values to the nearest bound', () => {
    expect(clampReferenceWeight(-0.5)).toBe(0);
    expect(clampReferenceWeight(1.7)).toBe(1);
    expect(clampReferenceWeight(0)).toBe(0);
    expect(clampReferenceWeight(1)).toBe(1);
    expect(clampReferenceWeight(0.5)).toBe(0.5);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampReferenceWeight(NaN)).toBe(REFERENCE_WEIGHT_DEFAULT);
    expect(clampReferenceWeight(Number.POSITIVE_INFINITY)).toBe(REFERENCE_WEIGHT_DEFAULT);
  });
});

describe('PortDefinition role/weight fields', () => {
  it('accepts optional role and weight on PortDefinition', () => {
    const port: PortDefinition = {
      id: 'images',
      label: 'Reference Images',
      dataType: 'Image',
      required: false,
      role: 'identity',
      weight: 0.8,
    };
    expect(port.role).toBe('identity');
    expect(port.weight).toBe(0.8);
  });

  it('accepts optional role and weight on DynamicPortDefinition', () => {
    const port: DynamicPortDefinition = {
      id: 'image',
      label: 'Image',
      dataType: 'Image',
      required: true,
      role: 'subject',
      weight: 1,
    };
    expect(port.role).toBe('subject');
    expect(port.weight).toBe(1);
  });

  it('a port without weight behaves as if weight === 1.0', () => {
    const port: PortDefinition = {
      id: 'image',
      label: 'Image',
      dataType: 'Image',
      required: false,
    };
    expect(port.weight ?? REFERENCE_WEIGHT_DEFAULT).toBe(1.0);
    expect(port.role).toBeUndefined();
  });

  it('role and weight are additive only — existing fields are untouched', () => {
    const base = {
      id: 'character_refs',
      label: 'Character Refs',
      dataType: 'Image' as const,
      required: false,
      multiple: true,
      maxConnections: 4,
    };
    const withRole: PortDefinition = { ...base, role: 'identity', weight: 0.65 };
    expect(withRole.id).toBe(base.id);
    expect(withRole.label).toBe(base.label);
    expect(withRole.dataType).toBe(base.dataType);
    expect(withRole.required).toBe(base.required);
    expect(withRole.multiple).toBe(base.multiple);
    expect(withRole.maxConnections).toBe(base.maxConnections);
  });
});

describe('ReferenceSetBundle', () => {
  it('holds items with url, role, and weight', () => {
    const bundle: ReferenceSetBundle = {
      items: [
        { url: '/api/uploads/a.png', role: 'identity', weight: 1.0 },
        { url: '/api/uploads/b.png', role: 'style', weight: 0.5 },
      ],
    };
    expect(bundle.items).toHaveLength(2);
    expect(bundle.items[0]).toEqual({
      url: '/api/uploads/a.png',
      role: 'identity',
      weight: 1.0,
    });
  });

  it('supports an empty bundle', () => {
    const bundle: ReferenceSetBundle = { items: [] };
    expect(bundle.items).toEqual([]);
  });
});
