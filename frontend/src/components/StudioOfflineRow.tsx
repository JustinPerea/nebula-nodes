import { useEffect, useRef, useState } from 'react';
import { isBackendOffline, subscribeBackendConnection } from '../lib/backendConnection';
import { useOfflinePulse } from '../hooks/useOfflinePulse';
import { OFFLINE_LINE } from './BackendConnectionStatus';

/** How long Nebula is offline before a studio's row opens (GM, PR #198 r2:
 * "keep the existing offline delay"). The app had none: the canvas's banner
 * shows on the first failed probe. A row that opens moves the whole studio
 * down, so a blip (one probe lost while the backend reloads) must not open
 * it; 1 s is under the 3 s probe interval, so a real outage still shows on
 * the first failed probe's answer plus a second. Builder's value, for GM. */
export const STUDIO_BANNER_DELAY_MS = 1_000;

/** The close runs on --workspace-dock-spring (420ms); the line stays in the
 * row until then, so the row closes with its words in it. */
const CLOSE_MS = 420;

/**
 * The offline banner on every screen but the canvas (GM, PR #198 r2): a row
 * of the studio's own layout, right under its top header, centred with 8px
 * above and below, that pushes the studio's content down instead of floating
 * over it. It opens and closes on the panel spring (App.css
 * .studio-offline-row: grid-template-rows 0fr → 1fr). WorkspaceHeader renders
 * it as the header's next sibling; each studio's grid names it `offline`
 * (styles/workspace-header.css). The canvas keeps its floating banner.
 */
export function StudioOfflineRow() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const pill = useRef<HTMLDivElement>(null);
  const pulse = useOfflinePulse(pill, open);

  // Follows the connection as it changes (a subscription, so a drop shorter
  // than the delay never opens the row and a reconnect closes it at once).
  useEffect(() => {
    let timer: number | undefined;
    let shown = false;
    const arm = () => {
      if (timer !== undefined || shown) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        shown = true;
        setClosing(false);
        setOpen(true);
      }, STUDIO_BANNER_DELAY_MS);
    };
    const follow = () => {
      if (isBackendOffline()) { arm(); return; }
      window.clearTimeout(timer);
      timer = undefined;
      if (!shown) return;
      shown = false;
      setOpen(false);
      setClosing(true);
    };
    if (isBackendOffline()) arm();
    const unsubscribe = subscribeBackendConnection(follow);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  return (
    <div className="studio-offline-row" data-open={open ? 'true' : 'false'}>
      <div className="studio-offline-row__clip">
        <div className="studio-offline-row__pad">
          {(open || closing) && (
            <div ref={pill} className="studio-offline-row__pill" role={open ? 'status' : undefined}
              aria-live={open ? 'polite' : undefined} aria-hidden={open ? undefined : true}
              data-pulse-seq={pulse?.seq} onAnimationEnd={() => pill.current?.removeAttribute('data-pulse')}>
              {OFFLINE_LINE}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
