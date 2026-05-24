export const SNAP_GUIDE_SCREEN_THRESHOLD_PX = 6;

interface SnapMovementToCenterArgs {
  anchorStartX: number;
  anchorStartY: number;
  dx: number;
  dy: number;
  thresholdX: number;
  thresholdY: number;
}

interface SnapMovementToCenterResult {
  dx: number;
  dy: number;
  snappedX: boolean;
  snappedY: boolean;
}

export function snapMovementToCenter({
  anchorStartX,
  anchorStartY,
  dx,
  dy,
  thresholdX,
  thresholdY,
}: SnapMovementToCenterArgs): SnapMovementToCenterResult {
  const anchorNextX = anchorStartX + dx;
  const anchorNextY = anchorStartY + dy;
  const snappedX = Math.abs(anchorNextX) <= thresholdX;
  const snappedY = Math.abs(anchorNextY) <= thresholdY;

  return {
    dx: snappedX ? -anchorStartX : dx,
    dy: snappedY ? -anchorStartY : dy,
    snappedX,
    snappedY,
  };
}
