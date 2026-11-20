/** A port data type in words: "DepthMap" reads "depth map", "SVG" keeps its capitals. */
function typeWords(type: string): string {
  if (type === 'SVG') return 'SVG';
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Lowercase letters and digits, separators dropped: "depth_map", "depthMap" and "DepthMap" are
 * the same name, while "image_2" stays distinct from "image". */
function letters(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * "Open image", and "Open image · mask" only when the port says something the kind doesn't
 * (design: "Open image · image" repeats the kind). SVG keeps its capitals, and a type that is
 * two words reads as words ("Open depth map", never "DepthMap").
 */
export function openOutputLabel(type: string, portId: string): string {
  const kind = typeWords(type);
  return letters(portId) === letters(type) ? `Open ${kind}` : `Open ${kind} · ${portId}`;
}
