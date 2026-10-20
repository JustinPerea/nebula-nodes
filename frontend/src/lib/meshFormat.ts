/** Label and kind of a mesh output URL. Shared by MeshPreview and its
 * deferred-load fallback (components/nodes/DeferredViewers.tsx), so the
 * placeholder card reads the same before the viewer chunk arrives. */
export function meshFormatLabel(src: string) {
  const cleanSrc = src.split(/[?#]/)[0] ?? '';
  const filename = cleanSrc.split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  if (extension && ['ply', 'spz', 'splat', 'ksplat', 'sog'].includes(extension.toLowerCase())) {
    return `${extension.toUpperCase()} splat export`;
  }
  return extension ? `${extension.toUpperCase()} model` : '3D model';
}

export function isSplatExport(src: string): boolean {
  return /\.(?:ply|spz|splat|ksplat|sog)(?:[?#]|$)/i.test(src);
}
