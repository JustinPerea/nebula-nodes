import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
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
 * PR #204 round 13 (review 10 LOW-3, GM r17 item 1: one line per group): the lock line of the
 * group Undo belongs to (Providers, "change provider settings") when that line is on screen in
 * this panel. Its id, for Undo to point at; null when it isn't there (another tab is open, or a
 * search hides every provider), and Undo shows its own line under it. Watched only while Undo is
 * locked, so the panel isn't observed otherwise.
 */
function groupLineIn(slot: HTMLElement | null, line: string): string | null {
  const found = [...(slot?.closest('.panel--settings')?.querySelectorAll<HTMLElement>('.person-lock-line') ?? [])]
    .find((element) => !slot!.contains(element) && element.textContent?.trim() === line);
  return found?.id || null;
}

function useGroupLine(slot: RefObject<HTMLElement | null>, line: string, watch: boolean): string | null {
  const subscribe = useCallback((onChange: () => void) => {
    const root = watch ? slot.current?.closest('.panel--settings') : null;
    if (!root) return () => {};
    const observer = new MutationObserver(onChange);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [slot, watch]);
  return useSyncExternalStore(subscribe, () => (watch ? groupLineIn(slot.current, line) : null), () => null);
}

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
  // Round 13 (review 10 LOW-3): with the Providers line on screen, Undo points at it and shows no
  // second copy, so nothing is said twice, nor again inside this live region.
  const slot = useRef<HTMLDivElement>(null);
  const groupLine = useGroupLine(slot, undoLock.line, undoLock.shown);

  useEffect(() => {
    if (!notice || held) return;
    const timer = window.setTimeout(() => dismissNotice(notice.id), notice.undoKey ? UNDO_NOTICE_MS : NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, held]);

  return (
    <div ref={slot} className="settings-notice-slot" role="status" aria-live="polite">
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
