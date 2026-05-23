import type { TrackItem } from '../../types/video';

export type ResizeHandle =
  | 'corner-tl'
  | 'corner-tr'
  | 'corner-bl'
  | 'corner-br'
  | 'edge-top'
  | 'edge-right'
  | 'edge-bottom'
  | 'edge-left';

interface ResizeRect {
  width: number;
  height: number;
}

interface ComputeResizeScaleArgs {
  handle: ResizeHandle;
  startScale: TrackItem['spatial']['scale'];
  rect: ResizeRect;
  dxScreen: number;
  dyScreen: number;
  shiftKey: boolean;
}

function signedWidthDelta(handle: ResizeHandle, dxScreen: number): number {
  if (handle.endsWith('-right') || handle.endsWith('-tr') || handle.endsWith('-br')) return dxScreen;
  if (handle.endsWith('-left') || handle.endsWith('-tl') || handle.endsWith('-bl')) return -dxScreen;
  return 0;
}

function signedHeightDelta(handle: ResizeHandle, dyScreen: number): number {
  if (handle.endsWith('-bottom') || handle.endsWith('-bl') || handle.endsWith('-br')) return dyScreen;
  if (handle.endsWith('-top') || handle.endsWith('-tl') || handle.endsWith('-tr')) return -dyScreen;
  return 0;
}

function isCornerHandle(handle: ResizeHandle): boolean {
  return handle.startsWith('corner-');
}

export function computeResizeScale({
  handle,
  startScale,
  rect,
  dxScreen,
  dyScreen,
  shiftKey,
}: ComputeResizeScaleArgs): TrackItem['spatial']['scale'] {
  if (rect.width === 0 || rect.height === 0) return startScale;

  const ratioX = (rect.width + signedWidthDelta(handle, dxScreen)) / rect.width;
  const ratioY = (rect.height + signedHeightDelta(handle, dyScreen)) / rect.height;

  if (isCornerHandle(handle)) {
    if (shiftKey) {
      return [startScale[0] * ratioX, startScale[1] * ratioY, startScale[2]];
    }
    const ratio = Math.max(ratioX, ratioY);
    return [startScale[0] * ratio, startScale[1] * ratio, startScale[2]];
  }

  if (handle === 'edge-left' || handle === 'edge-right') {
    return [startScale[0] * ratioX, startScale[1], startScale[2]];
  }

  return [startScale[0], startScale[1] * ratioY, startScale[2]];
}
