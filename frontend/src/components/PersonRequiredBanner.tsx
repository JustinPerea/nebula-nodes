import { useEffect, useState, useSyncExternalStore } from 'react';
import { currentPersonBannerLine, onPersonRequired, personRequiredMessage, setPersonBannerLine,
  subscribePersonBanner } from '../lib/personSession';
import { clearsOnPromote } from '../lib/clearsOnPromote';
import { InNoticeRegion } from './InNoticeRegion';
import { useLeave } from '../lib/noticeLeave';
import { currentFixLine, subscribeToLines, type FixLine } from '../lib/notConnectedLine';

const subscribeToNothing = () => () => {};

/** The rendered line that carries the fix itself (lib/notConnectedLine), kept current while
 * `watching` (read again at most once a frame). */
function useFixLine(watching: boolean): FixLine | null {
  return useSyncExternalStore(watching ? subscribeToLines : subscribeToNothing,
    () => (watching ? currentFixLine() : null), () => null);
}

export function PersonRequiredBanner() {
  const message = useSyncExternalStore(subscribePersonBanner, currentPersonBannerLine);

  useEffect(() => {
    // The server promoted this tab as the person: nothing is locked any more.
    // Through the one mechanism (GM, #204 round 3), swept with every other
    // line whose only reason was this tab.
    let stopSweep = () => {};
    const stopRequired = onPersonRequired(() => {
      const line = personRequiredMessage();
      setPersonBannerLine(line);
      stopSweep();
      stopSweep = clearsOnPromote(() => { if (currentPersonBannerLine() === line) setPersonBannerLine(null); }); // clears-on-promote: banner
    });
    // No banner on screen, nothing for the dialog to defer to.
    return () => { stopRequired(); stopSweep(); setPersonBannerLine(null); };
  }, []);

  // GM r8 (1), r11: beside a line that carries the fix itself, the general notice steps out (and
  // comes back when that line goes); beside a lock line or one that defers to it, it stays
  // (lib/notConnectedLine). The line stays set, so what defers to it (the note dialog) still does.
  const fixLine = useFixLine(message !== null);
  const specific = fixLine !== null;
  // It leaves as it entered, a surface (fix round 7, GM r11 answer 2).
  const leave = useLeave(specific ? null : message);
  // Review 6 NIT-3: one polite live region, mounted while the app is, and empty until there is
  // something to say. A notice that mounts with its text in place often goes unannounced, and a
  // Settings row isn't a live region, so the swap is said here, once: the notice's words, or the
  // line that took its place (unless that line already announces itself).
  const saying = message === null ? '' : specific ? (fixLine.live ? '' : fixLine.text) : message;
  // Review 8 MEDIUM-3 (round 10): a line whose words change in place is not a swap, so nothing new
  // is said. What is said changes only when the swap does (notice, line, or nothing).
  const swap = message === null ? 'none' : specific ? `line:${fixLine.live}` : `notice:${message}`;
  const [said, setSaid] = useState({ swap, text: saying });
  if (said.swap !== swap) setSaid({ swap, text: saying });
  const announced = said.swap === swap ? said.text : saying;

  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <>
      <span className="person-required__announce" role="status" aria-live="polite">{announced}</span>
      {leave.shown && (
        <InNoticeRegion slot="person-required">
          <div className="person-required" {...leave.props}>
            <span>{leave.shown}</span>
            <button type="button" className="person-required__dismiss" aria-label="Dismiss" onClick={() => setPersonBannerLine(null)}>
              ×
            </button>
          </div>
        </InNoticeRegion>
      )}
    </>
  );
}
