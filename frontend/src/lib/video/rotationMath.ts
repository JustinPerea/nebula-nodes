interface RotationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function computeRotationZ(rect: RotationRect, clientX: number, clientY: number): number {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const angleRad = Math.atan2(clientY - centerY, clientX - centerX);
  return normalizeDegrees((angleRad * 180) / Math.PI + 90);
}
