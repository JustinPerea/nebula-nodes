import { useEffect, useSyncExternalStore } from 'react';
import { currentPersonBannerLine, onPersonRequired, personRequiredMessage, setPersonBannerLine,
  subscribePersonBanner } from '../lib/personSession';
import { clearsOnPromote } from '../lib/clearsOnPromote';
import { InNoticeRegion } from './InNoticeRegion';
import { useLeave } from '../lib/noticeLeave';

/**
 * Says why Settings, proposals and chats are locked in this tab: it isn't
 * connected as the person (no launch token; see lib/personSession.ts). Shown
 * when the backend refuses a person-only action or the canvas socket can't
 * say hello as the person. Dismissible; the next refusal shows it again.
 * Hidden again when the server promotes this tab as the person (GM r29
 * item 3: the UI follows the server's state both ways; a link taken in isn't
 * proof by itself).
 *
 * GM r24 (PR #200 fix round 15): whether it shows is shared
 * (personSession's banner line), so the note dialog can hold Send note while
 * it shows and leave the fix to it. Neutral, in the shared notice colours.
 */
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

  // It leaves as it entered, a surface (fix round 7, GM r11 answer 2).
  const leave = useLeave(message);
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
