import { useEffect, useState } from 'react';

/** GM r32 5: a load quicker than this shows no loading line at all. */
export const LOADING_SHOW_AFTER_MS = 300;

/**
 * PR #204 round 18d (GM r32 5, review 14 live NIT-2): the Commons' one loading look. A plain
 * muted line where the content will appear, no box or rail, naming what is loading ("Loading
 * agent reviews…", "Loading settings…", "Loading details…"), and only once the load has taken
 * LOADING_SHOW_AFTER_MS.
 */
export function CommonsLoadingLine({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LOADING_SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return <p className="commons-loading" role="status">{text}</p>;
}
