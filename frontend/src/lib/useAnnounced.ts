import { useEffect, useState } from 'react';

/** A live region's text, set only after the region has been painted empty
 * (review 20 NIT-2 and review 21 LOW-1 on PR #199). Screen readers commonly
 * skip a region that arrives already holding its text. Setting the text in
 * an effect is not enough: React flushes that effect, and the re-render it
 * causes, before the browser paints, so the empty region is never drawn and
 * never reaches the accessibility tree. The text therefore arrives from the
 * second animation frame after the commit: the first frame's paint carries
 * the region empty, the second frame's callback sets the text. A change
 * cancels a pending set; unmount cancels it too. Null or empty empties the
 * region at once. */
export function useAnnounced(text: string | null | undefined): string {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!text) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- emptying is immediate: nothing is announced for a line that is gone
      setShown('');
      return undefined;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setShown(text));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [text]);
  return shown;
}
