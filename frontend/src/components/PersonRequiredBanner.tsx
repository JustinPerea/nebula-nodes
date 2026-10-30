import { useEffect, useSyncExternalStore } from 'react';
import { currentPersonBannerLine, onPersonRequired, personRequiredMessage, setPersonBannerLine,
  subscribePersonBanner } from '../lib/personSession';
import { clearsOnPromote } from '../lib/clearsOnPromote';
import { InNoticeRegion } from './InNoticeRegion';
import { useLeave } from '../lib/noticeLeave';
import { notConnectedLineShown, subscribeToLines } from '../lib/notConnectedLine';

const subscribeToNothing = () => () => {};

/** notConnectedLineShown, kept current while `watching` (read again at most once a frame). */
function useNotConnectedLineShown(watching: boolean): boolean {
  return useSyncExternalStore(watching ? subscribeToLines : subscribeToNothing,
    () => watching && notConnectedLineShown(), () => false);
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

  // GM r8 (1): while a specific line says it, the general notice steps out (and comes back when
  // that line goes). The line stays set, so what defers to it (the note dialog) still does.
  const specific = useNotConnectedLineShown(message !== null);
  // It leaves as it entered, a surface (fix round 7, GM r11 answer 2).
  const leave = useLeave(specific ? null : message);
  if (!leave.shown) return null;

  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="person-required">
      <div className="person-required" role="status" aria-live="polite" {...leave.props}>
        <span>{leave.shown}</span>
        <button type="button" className="person-required__dismiss" aria-label="Dismiss" onClick={() => setPersonBannerLine(null)}>
          ×
        </button>
      </div>
    </InNoticeRegion>
  );
}
