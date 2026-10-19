import { useState, type ImgHTMLAttributes } from 'react';
import { useUIStore } from '../../store/uiStore';
import { overviewThumbnailUrl } from '../../lib/canvasOverview';

type OverviewImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string };

/** The thumbnail to show for `src` while the canvas is zoomed out, or null. */
function useOverviewThumbnail(src: string): { thumb: string | null; fail: () => void } {
  const zoomedOut = useUIStore((state) => state.canvasZoomedOut);
  const [failed, setFailed] = useState<string | null>(null);
  const candidate = zoomedOut ? overviewThumbnailUrl(src) : null;
  const thumb = candidate && candidate !== failed ? candidate : null;
  return { thumb, fail: () => setFailed(candidate) };
}

/** A node's image. Zoomed out, its small thumbnail; if that can't load, the file itself. */
export function OverviewImage({ src, onError, ...rest }: OverviewImageProps) {
  const { thumb, fail } = useOverviewThumbnail(src);
  return (
    <img
      {...rest}
      src={thumb ?? src}
      onError={(event) => {
        if (thumb) fail();
        onError?.(event);
      }}
    />
  );
}

/** A still over a node's video while zoomed out (its player hides then).
 * Nothing when the video has no thumbnail. */
export function OverviewVideoStill({ src }: { src: string }) {
  const { thumb, fail } = useOverviewThumbnail(src);
  if (!thumb) return null;
  return (
    <img
      src={thumb}
      alt=""
      aria-hidden="true"
      className="model-node__preview-still"
      loading="lazy"
      draggable={false}
      onError={fail}
    />
  );
}
