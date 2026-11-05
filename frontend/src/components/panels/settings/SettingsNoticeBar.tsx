import { useEffect, useState } from 'react';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { dismissNotice, undoAddedKey } from '../../../lib/settingsWrites';
import { focusRowAfterMove } from './rowHelpers';
import { LineText } from '../../LineText';
import { useOfflineFirstBecause } from '../../../hooks/useOfflineFirstBecause';
import { usePersonLock } from '../../../hooks/usePersonLock';
import { PersonLockLine } from '../../PersonLock';
import { useGroupLockLineId } from './groupLockLines';

/** Plain confirmations go quickly; one you can undo stays long enough to read the row's check first. */
const NOTICE_MS = 6000;
const UNDO_NOTICE_MS = 10000;

/**
 * Confirms key changes at the bottom of the panel. A newly added key can be
 * undone from here; the notice waits while the pointer or focus is on it.
 */
export function SettingsNoticeBar() {
  const stored = useSettingsDraftStore((s) => s.notice);
  // Round 17 (review 13 LOW-3): offline first, the bar with it. A because line hidden offline
  // (hooks/useOfflineFirstBecause) would leave an empty bar, so the notice doesn't show; back
  // online it does, if it is still there.
  const shownMessage = useOfflineFirstBecause(stored?.message ?? null);
  const notice = stored && shownMessage !== null ? stored : null;
  // Held per notice, so a notice that vanished under the pointer can't pin the next one.
  const [heldId, setHeldId] = useState<number | null>(null);
  const held = !!notice && heldId === notice.id;
  // PR #204 round 11 (review 9 LOW-1): Undo removes the key (DELETE /api/settings/api-keys/…,
  // the person's alone), so it locks with the providers' words, its line under it.
  const undoLock = usePersonLock('change provider settings', !!notice?.undoKey);
  // Round 13 (review 10 LOW-3): with the Providers line on screen, Undo points at it and shows no
  // second copy, so nothing is said twice, nor again inside this live region. Round 14 (review 11
  // NIT-1, LOW-4): decided from state while rendering (groupLockLines, which ProvidersTab's line
  // registers), not by reading the page after a commit, so a demote never puts the copy in the
  // live region even for one commit, and the panel is never observed.
  const groupLineId = useGroupLockLineId('change provider settings');
  const groupLine = undoLock.shown ? groupLineId : null;

  useEffect(() => {
    if (!notice || held) return;
    const timer = window.setTimeout(() => dismissNotice(notice.id), notice.undoKey ? UNDO_NOTICE_MS : NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, held]);

  return (
    <div className="settings-notice-slot" role="status" aria-live="polite">
      {notice && (
        <div key={notice.id} className="settings-notice"
          onPointerEnter={() => setHeldId(notice.id)} onPointerLeave={() => setHeldId(null)}
          onFocus={() => setHeldId(notice.id)} onBlur={() => setHeldId(null)}>
          <span><LineText text={notice.message} /></span>
          {notice.undoKey && (
            <button type="button" className="settings-notice__undo" {...undoLock.control()}
              aria-describedby={groupLine ?? undoLock.control()['aria-describedby']} onClick={undoLock.guard(() => {
              focusRowAfterMove(notice.undoKey!);
              void undoAddedKey(notice.id);
            })}>Undo</button>
          )}
          {notice.undoKey && !groupLine && <PersonLockLine lock={undoLock} place="control" />}
        </div>
      )}
    </div>
  );
}
