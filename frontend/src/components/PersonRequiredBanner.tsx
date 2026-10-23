import { useEffect, useState } from 'react';
import { onPersonConnected, onPersonRequired, personRequiredMessage } from '../lib/personSession';
import { InNoticeRegion } from './InNoticeRegion';

/**
 * Says why Settings, proposals and chats are locked in this tab: it isn't
 * connected as the person (no launch token; see lib/personSession.ts). Shown
 * when the backend refuses a person-only action or the canvas socket can't
 * say hello as the person. Dismissible; the next refusal shows it again.
 * Hidden again when a person link connects the tab.
 */
export function PersonRequiredBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const stopRequired = onPersonRequired(() => setMessage(personRequiredMessage()));
    // A fresh person link connected this tab: nothing is locked any more.
    const stopConnected = onPersonConnected(() => setMessage(null));
    return () => { stopRequired(); stopConnected(); };
  }, []);

  if (!message) return null;

  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="person-required">
      <div className="person-required" role="status" aria-live="polite">
        <span>{message}</span>
        <button type="button" className="person-required__dismiss" aria-label="Dismiss" onClick={() => setMessage(null)}>
          ×
        </button>
      </div>
    </InNoticeRegion>
  );
}
