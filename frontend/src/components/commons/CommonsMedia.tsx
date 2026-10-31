import { useEffect, useState } from 'react';
import { commonsApi } from '../../lib/commonsApi';
import { LineText } from '../LineText';
import { useCommonsLine, useReloadEpoch } from './useCommonsLine';
import { useOfflineFirstBecause } from '../../hooks/useOfflineFirstBecause';

type Props = {
  path: string;
  video?: boolean;
  className?: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
  draggable?: boolean;
  muted?: boolean;
  controls?: boolean;
  preload?: string;
};

/** Media elements cannot send the Commons bearer header themselves. */
export function CommonsMedia({ path, video, alt = '', loading, ...props }: Props) {
  const [media, setMedia] = useState<{ path: string; url?: string }>();
  // PR #204 round 9: a not-connected line clears on the promote, and the file loads again.
  const [error, setError] = useState<string | null>(null);
  const [errorPath, setErrorPath] = useState<string | null>(null);
  const [loadEpoch, loadAgain] = useReloadEpoch();
  const line = useCommonsLine(setError, null, `commons.media-${path}`, loadAgain);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    void commonsApi.blob(path, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setMedia({ path, url });
      setError(null);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setErrorPath(path);
      line.show(failure, "Couldn’t load this reference.", { reload: true });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, loadEpoch, line]);
  const current = media?.path === path ? media : undefined;
  // Offline comes first (GM r23 3): a because line hides while offline (the media stays empty).
  const shownError = useOfflineFirstBecause(error);
  if (error && errorPath === path) return shownError ? <span role="alert"><LineText text={shownError} /></span> : null;
  return video ? <video {...props} src={current?.url} /> :
    <img {...props} src={current?.url} alt={alt} loading={loading} />;
}
