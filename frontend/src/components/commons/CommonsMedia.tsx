import { useEffect, useState } from 'react';
import { commonsApi } from '../../lib/commonsApi';

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
  const [media, setMedia] = useState<{ path: string; url?: string; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    void commonsApi.blob(path, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setMedia({ path, url });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setMedia({ path, error: error instanceof Error ? error.message : 'Could not load reference' });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  const current = media?.path === path ? media : undefined;
  if (current?.error) return <span role="alert">{current.error}</span>;
  return video ? <video {...props} src={current?.url} /> :
    <img {...props} src={current?.url} alt={alt} loading={loading} />;
}
