import { useEffect, useState } from 'react';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { dismissNotice, undoAddedKey } from '../../../lib/settingsWrites';
import { focusRowAfterMove } from './rowHelpers';
import { LineText } from '../../LineText';
import { usePersonLock } from '../../../hooks/usePersonLock';
import { PersonLockLine } from '../../PersonLock';

/** Plain confirmations go quickly; one you can undo stays long enough to read the row's check first. */
const NOTICE_MS = 6000;
const UNDO_NOTICE_MS = 10000;

/**
 * Confirms key changes at the bottom of the panel. A newly added key can be
 * undone from here; the notice waits while the pointer or focus is on it.
 */
export function SettingsNoticeBar() {
  const notice = useSettingsDraftStore((s) => s.notice);
  // Held per notice, so a notice that vanished under the pointer can't pin the next one.
  const [heldId, setHeldId] = useState<number | null>(null);
  const held = !!notice && heldId === notice.id;
  // PR #204 round 11 (review 9 LOW-1): Undo removes the key (DELETE /api/settings/api-keys/…,
  // the person's alone), so it locks with the providers' words, its line under it.
  const undoLock = usePersonLock('change provider settings', !!notice?.undoKey);

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
            <button type="button" className="settings-notice__undo" {...undoLock.control()} onClick={undoLock.guard(() => {
              focusRowAfterMove(notice.undoKey!);
              void undoAddedKey(notice.id);
            })}>Undo</button>
          )}
          {notice.undoKey && <PersonLockLine lock={undoLock} place="control" />}
        </div>
      )}
    </div>
  );
}
