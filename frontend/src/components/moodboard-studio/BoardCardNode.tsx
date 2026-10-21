import { memo, useContext, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { backendAssetUrlSync } from '../../lib/backend';
import { overviewThumbnailUrl } from '../../lib/canvasOverview';
import { BoardWideContext, type BoardCardNodeType } from './boardNodes';

export type { BoardCardData } from './boardNodes';
export { BOARD_THUMB_MAX_CSS_PX } from './boardNodes';

/**
 * One reference on the Board view: the image, filling a card whose size the
 * server set from its weight and aspect. Badges, the weight readout and the
 * set-aside dim come with the next part of the canvas (PR6).
 */
function BoardCard({ data, width, selected }: NodeProps<BoardCardNodeType>) {
  // The canvas says which widths are wide at this zoom (one check per zoom, not one per card).
  const wide = (width ?? 0) >= useContext(BoardWideContext);
  const [failedThumb, setFailedThumb] = useState<string | null>(null);
  const thumb = wide ? null : overviewThumbnailUrl(data.url);
  const useThumb = thumb !== null && thumb !== failedThumb;
  const src = backendAssetUrlSync(useThumb ? thumb : data.url);
  return (
    <div className={`moodboard-card${selected ? ' moodboard-card--selected' : ''}`} data-image-id={data.imageId}>
      <img
        className="moodboard-card__image"
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => { if (useThumb) setFailedThumb(thumb); }}
      />
    </div>
  );
}

export const BoardCardNode = memo(BoardCard);
