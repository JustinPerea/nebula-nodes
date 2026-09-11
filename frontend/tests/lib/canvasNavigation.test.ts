import { describe, expect, it } from 'vitest';
import { SelectionMode } from '@xyflow/react';
import { CANVAS_INTERACTION_PROPS } from '../../src/lib/canvasNavigation';

describe('Flora-style canvas interaction', () => {
  it('makes left drag select while mouse alternatives and trackpad scroll pan', () => {
    expect(CANVAS_INTERACTION_PROPS).toEqual({
      panOnScroll: true,
      zoomOnScroll: false,
      zoomOnPinch: true,
      zoomActivationKeyCode: ['Meta', 'Control'],
      panOnDrag: [1, 2],
      panActivationKeyCode: 'Space',
      selectionOnDrag: true,
      selectionMode: SelectionMode.Partial,
      selectionKeyCode: null,
      multiSelectionKeyCode: 'Shift',
    });
  });
});
