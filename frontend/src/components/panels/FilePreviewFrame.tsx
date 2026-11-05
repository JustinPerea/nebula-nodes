import { useState } from 'react';
import { previewSizeAttributes } from '../../lib/previewSize';

/**
 * The image under a file param's control (GM r46 Q2 on #222). With no
 * preview (an agent set a file Nebula can't show) the frame collapses on
 * the layout spring, never an empty box; it jumps under reduced motion
 * (panels.css). The last image stays inside while it collapses, so the
 * glide shows it closing, not a blank. A frame that never had an image is
 * not drawn at all.
 */
export function FilePreviewFrame({ src, size }: { src: string | null; size?: unknown }) {
  const [last, setLast] = useState(src);
  if (src && src !== last) setLast(src);
  if (!src && !last) return null;
  return (
    <div className="inspector__file-preview-frame" data-collapsed={src ? undefined : 'true'}>
      <div className="inspector__file-preview-clip">
        <img
          src={src ?? last ?? undefined}
          alt={src ? 'Preview' : ''}
          aria-hidden={src ? undefined : true}
          className="inspector__file-preview"
          // Its aspect ratio before it decodes (#226, GM r82).
          {...previewSizeAttributes(size)}
        />
      </div>
    </div>
  );
}
