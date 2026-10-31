import { useEffect, useState } from 'react';

/** A live region's text, set only after the region is in the page (review 20
 * NIT-2 on PR #199). Screen readers commonly skip a region that arrives
 * already holding its text, so the region renders empty first and gets its
 * text once mounted: one announcement, when the line appears. Null or empty
 * empties it. */
export function useAnnounced(text: string | null | undefined): string {
  const [shown, setShown] = useState('');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the second render is the point: the region is in the page, empty, before its text arrives
    setShown(text ?? '');
  }, [text]);
  return shown;
}
