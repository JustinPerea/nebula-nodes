/**
 * "Open image", and "Open image · mask" only when the port says something the kind doesn't
 * (design: "Open image · image" repeats the kind). SVG keeps its capitals.
 */
export function openOutputLabel(type: string, portId: string): string {
  const kind = type === 'SVG' ? 'SVG' : type.toLowerCase();
  return portId.toLowerCase() === type.toLowerCase() ? `Open ${kind}` : `Open ${kind} · ${portId}`;
}
