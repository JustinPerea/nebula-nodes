import { useEffect, useSyncExternalStore } from 'react';
import { currentPersonBannerLine, onPersonConnected, onPersonRequired, personRequiredMessage, setPersonBannerLine,
  subscribePersonBanner } from '../lib/personSession';
import { InNoticeRegion } from './InNoticeRegion';
import { useLeave } from '../lib/noticeLeave';

/**
 * Says why Settings, proposals and chats are locked in this tab: it isn't
 * connected as the person (no launch token; see lib/personSession.ts). Shown
 * when the backend refuses a person-only action or the canvas socket can't
 * say hello as the person. Dismissible; the next refusal shows it again.
 * Hidden again when a person link connects the tab.
 *
 * GM r24 (PR #200 fix round 15): whether it shows is shared
 * (personSession's banner line), so the note dialog can hold Send note while
 * it shows and leave the fix to it. Neutral, in the shared notice colours.
 */
export function PersonRequiredBanner() {
  const message = useSyncExternalStore(subscribePersonBanner, currentPersonBannerLine);

  useEffect(() => {
    const stopRequired = onPersonRequired(() => setPersonBannerLine(personRequiredMessage()));
    // A fresh person link connected this tab: nothing is locked any more.
    const stopConnected = onPersonConnected(() => setPersonBannerLine(null));
    // No banner on screen, nothing for the dialog to defer to.
    return () => { stopRequired(); stopConnected(); setPersonBannerLine(null); };
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
