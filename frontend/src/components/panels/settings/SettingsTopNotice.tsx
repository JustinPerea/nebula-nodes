import { useEffect, useState } from 'react';
import { FailureLines } from '../../failure/FailureLines';
import { PERSON_PROMOTED_EVENT } from '../../../lib/personSession';
import { clearRefusedOnPromote } from '../../../lib/clearsOnPromote';
import { whenPerson } from '../../../lib/personWork';
import { usePersonLock } from '../../../hooks/usePersonLock';
import { PersonLockLine } from '../../PersonLock';
import { DISMISS_FAILED, dismissSettingsNotice, getSettingsNotice, noticeParts, type SettingsNotice } from '../../../lib/settingsNotice';

/**
 * Nebula restored the settings at start: the person sees B6b's line once, at
 * the top of Settings, until they dismiss it (GM, PR #203 r38 item 5's
 * fallback while Updates takes no system card). Neutral, not an error.
 */
export function SettingsTopNotice({ visible }: { visible: boolean }) {
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const [dismissFailed, setDismissFailed] = useState(false);
  // The notice is the person's alone: dismissing locks on a tab that isn't connected as them.
  const lock = usePersonLock('dismiss this');

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = () => { getSettingsNotice().then((next) => { if (!cancelled) setNotice(next); }).catch(() => {}); };
    // A held tab asks on the promote, never to be refused (lib/personWork).
    whenPerson('settings.notice', load);
    // A tab that isn't the person yet is refused (403); it asks again once the
    // server promotes it, so the line still shows while Settings is open.
    window.addEventListener(PERSON_PROMOTED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(PERSON_PROMOTED_EVENT, load); };
  }, [visible]);

  if (!notice) return null;
  const { before, path, after } = noticeParts(notice);
  return (
    <div className="settings-top-notice" role="status">
      <div className="settings-top-notice__body">
        <p className="settings-top-notice__line">
          {before}{path && <code className="settings-top-notice__path">{path}</code>}{after}
        </p>
        {dismissFailed && (
          <p className="settings-row__error settings-top-notice__error" role="alert"><FailureLines failure={DISMISS_FAILED} /></p>
        )}
      </div>
      <button type="button" className="settings-top-notice__dismiss" {...lock.control()} onClick={lock.guard(() => {
        const shown = notice;
        setNotice(null);
        setDismissFailed(false);
        // Not dismissed: the line comes back with why (GM, PR #203 r40 item 4).
        void dismissSettingsNotice().catch((error: unknown) => {
          setNotice(shown);
          setDismissFailed(true);
          // A dismissal refused only because this tab isn't connected as the person: the line goes
          // when the server promotes it (GM, PR #204 round 3).
          clearRefusedOnPromote(error, () => setDismissFailed(false)); // clears-on-promote: settings.notice
        });
      })}>Dismiss</button>
      <PersonLockLine lock={lock} place="control" />
    </div>
  );
}
