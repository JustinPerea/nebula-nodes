import { SelectionMode, type ReactFlowProps } from '@xyflow/react';

type CanvasInteractionProps = Pick<
  ReactFlowProps,
  | 'panOnScroll'
  | 'zoomOnScroll'
  | 'zoomOnPinch'
  | 'zoomActivationKeyCode'
  | 'panOnDrag'
  | 'panActivationKeyCode'
  | 'selectionOnDrag'
  | 'selectionMode'
  | 'selectionKeyCode'
  | 'multiSelectionKeyCode'
>;

/**
 * Flora-style, mode-free canvas interaction:
 * - left-drag empty canvas selects;
 * - middle/right-drag or Space+left-drag pans;
 * - two-finger scroll pans and pinch zooms;
 * - Shift extends the current node selection.
 */
export const CANVAS_INTERACTION_PROPS = {
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
} as const satisfies CanvasInteractionProps;
