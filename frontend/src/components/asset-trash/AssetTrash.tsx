import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, RotateCcw, X } from 'lucide-react';
import { storedImageView } from '../../lib/storedImage';
import { OutsideImageNote } from '../OutsideImageNote';
import { InNoticeRegion } from '../InNoticeRegion';
import {
  deletedByLabel, emptyTrash, fetchTrash, purgeTrashed, restoreTrashed,
  type TrashedItem,
} from '../../lib/trash';
import type { AssetScope } from '../../store/uiStore';
import { wsClient } from '../../lib/wsClient';
import { failureMessage, oneLine, shortReason, type FailureCopy } from '../../lib/errorCopy';
import { clearSetterOnPromote } from '../../lib/clearsOnPromote';
import '../../styles/asset-trash.css';
import { useCurrentProjectId } from '../../lib/currentProject';
import type { LeaveProps } from '../../lib/noticeLeave';
import { LineText } from '../LineText';
import { PersonLockLine, type PersonLock } from '../PersonLock';
import { usePersonLock } from '../../hooks/usePersonLock';
import { useSlotWaiting } from '../../lib/noticeWaiting';

/**
 * Recently deleted, inside Moodboard Studio and Character Studio, and under
 * the Assets panel's Styles.
 *
 * A deleted board or character waits here until the person deletes it for
 * good (no timer). Restore brings it back with the same id, so canvas nodes
 * that point at it work again. Delete forever is the person's alone; the
 * backend refuses agents.
 */

type AssetKind = 'moodboard' | 'character' | 'style';

const NOUNS: Record<AssetKind, { one: string; many: string }> = {
  moodboard: { one: 'board', many: 'boards' },
  character: { one: 'character', many: 'characters' },
  style: { one: 'style', many: 'styles' },
};

export const UNDO_VISIBLE_MS = 8000;

/** A deleted item's picture, only when it is one of Nebula's own files
 *  (lib/storedImage.ts): a Character's and, since Q98, a board's. */
function thumbnailOf(item: TrashedItem): string | null {
  return storedImageView(item.thumbnail).src;
}

function deletedLine(item: TrashedItem): string {
  const date = new Date(item.deletedAt);
  const when = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
    : '';
  const who = deletedByLabel(item);
  return ['Deleted', when, who ? `by ${who}` : ''].filter(Boolean).join(' ');
}

/** Two-step button for the one action that can't be undone. */
function ConfirmInline({ label, confirmLabel, prompt, busy, onConfirm, lock }: {
  label: string; confirmLabel: string; prompt: string; busy: boolean; onConfirm: () => void;
  /** The person-only lock (components/PersonLock): it never arms while locked. */
  lock: PersonLock;
}) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const disarm = () => { setArmed(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!armed) {
    // It arms a Delete forever or an Empty: red on hover (GM r13), neutral at rest.
    return <button type="button" ref={trigger} className="asset-trash__button asset-trash__trigger--danger" disabled={busy}
      {...lock.control()} onClick={() => { if (!lock.locked) setArmed(true); }}>{label}</button>;
  }
  return (
    <span className="asset-trash__confirm" role="group" aria-label={prompt} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); disarm(); }
    }}>
      <span className="asset-trash__confirm-prompt">{prompt}</span>
      <button type="button" className="asset-trash__button" autoFocus disabled={busy} onClick={disarm}>Cancel</button>
      <button type="button" className="asset-trash__button asset-trash__button--danger" disabled={busy}
        {...lock.control()} onClick={() => { setArmed(false); if (!lock.locked) onConfirm(); }}>{confirmLabel}</button>
    </span>
  );
}

export interface RecentlyDeletedAssetsProps {
  kind: AssetKind;
  scope: AssetScope;
  /** Change it to list again (after a delete in the Studio). */
  refreshKey?: unknown;
  onRestored?: (item: TrashedItem) => void;
  /** Something came into or left this list (often an agent's delete or
   * restore elsewhere), so the library above it should list again. */
  onTrashChanged?: () => void;
}

export function RecentlyDeletedAssets({ kind, scope, refreshKey, onRestored, onTrashChanged }: RecentlyDeletedAssetsProps) {
  const [items, setItems] = useState<TrashedItem[]>([]);
  // Which tab and project `items` came from.
  const [itemsFor, setItemsFor] = useState('');
  const [open, setOpen] = useState(false);
  // PR #204 round 10 (GM r15, r17 items 1 and 3): deleting for good is the person's alone (DELETE
  // /api/trash/{kind}/{id}, POST /api/trash/empty: require_person). Empty and every Delete
  // forever lock as one group with one line under the heading.
  const purgeLock = usePersonLock('delete items for good');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const noun = NOUNS[kind];
  // A project's Recently deleted is the open canvas project's (lib/currentProject).
  const openProjectId = useCurrentProjectId();
  const projectId = scope === 'project' ? openProjectId : null;
  const noProject = scope === 'project' && !projectId;
  const where = `${scope}:${projectId ?? ''}`;

  // The ids last listed for this scope, to tell when the list changed.
  const listed = useRef<{ where: string; ids: string } | null>(null);
  const trashChanged = useRef(onTrashChanged);
  useEffect(() => { trashChanged.current = onTrashChanged; }, [onTrashChanged]);

  useEffect(() => {
    if (noProject) return; // nothing is shown without an open project
    let cancelled = false;
    fetchTrash({ kind, scope, projectId: projectId ?? undefined })
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setItemsFor(where);
        setError(null);
        const ids = list.map((item) => item.id).join(',');
        const before = listed.current;
        listed.current = { where, ids };
        if (before && before.where === where && before.ids !== ids) trashChanged.current?.();
      })
      .catch((err) => {
        if (cancelled) return;
        setItemsFor(where);
        setError(failureMessage(err, "Couldn't load Recently deleted."));
      });
    return () => { cancelled = true; };
  }, [kind, scope, projectId, noProject, where, refreshKey, reload]);

  // A delete or restore elsewhere (another tab, an agent) shows up here too.
  useEffect(() => wsClient.subscribe((event) => {
    if ((event.type === 'storedAssetChanged' && event.kind === kind) || event.type === 'socketReconnected') {
      setReload((value) => value + 1);
    }
  }), [kind]);

  const act = useCallback(async (work: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      after?.();
    } catch (err) {
      // A request's own line; never another error's message (round 3b).
      const line = failureMessage(err, '');
      setError(line);
      clearSetterOnPromote(err, setError, line, null); // clears-on-promote: trash (GM, #204 r3)
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  }, []);

  // A list from another project or tab, until this one loads, isn't shown.
  if (noProject || itemsFor !== where || (items.length === 0 && !error)) return null;

  return (
    <section className="asset-trash" aria-label={`Recently deleted ${noun.many}`}>
      <div className="asset-trash__header">
        <button type="button" className="asset-trash__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight aria-hidden="true" />Recently deleted
          <span className="asset-trash__count" aria-hidden="true">{items.length}</span>
        </button>
        {open && items.length > 0 && (
          <ConfirmInline label="Empty" confirmLabel="Delete all" busy={busy} lock={purgeLock}
            prompt={items.length === 1 ? `Delete this ${noun.one} for good?` : `Delete all ${items.length} ${noun.many} for good?`}
            onConfirm={() => void act(() => emptyTrash({ kind, scope, projectId: projectId ?? undefined }, items))} />
        )}
      </div>
      {open && <PersonLockLine lock={purgeLock} place="control" />}
      {error && <p className="asset-trash__error" role="alert"><LineText text={error} /></p>}
      {open && (
        <>
          <p className="asset-trash__note">Deleted {noun.many} stay here until you delete them for good.</p>
          <ul className="asset-trash__list">
            {items.map((item) => (
              <li key={item.id} className="asset-trash__row" aria-label={item.name || 'Untitled'}>
                <span className="asset-trash__thumb">
                  {thumbnailOf(item) && <img src={thumbnailOf(item) ?? undefined} alt="" draggable={false} />}
                </span>
                <span className="asset-trash__meta">
                  <span className="asset-trash__name">{item.name || 'Untitled'}</span>
                  <span className="asset-trash__sub">{deletedLine(item)}</span>
                  {storedImageView(item.thumbnail).outside && <OutsideImageNote />}
                </span>
                <span className="asset-trash__actions">
                  <button type="button" className="asset-trash__button" disabled={busy}
                    aria-label={`Restore ${item.name || 'Untitled'}`}
                    onClick={() => void act(() => restoreTrashed(kind, item.id), () => onRestored?.(item))}>
                    <RotateCcw aria-hidden="true" />Restore
                  </button>
                  <ConfirmInline label="Delete forever" confirmLabel="Delete forever" prompt="This can’t be undone."
                    busy={busy} lock={purgeLock} onConfirm={() => void act(() => purgeTrashed(kind, item.id))} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export interface UndoDeleteToastProps {
  name: string;
  busy?: boolean;
  /** Undo's own failure, one line (GM: "Couldn't {verb} {object}. {reason}"
   * in one string), short: the Undo beside it redoes it (round 3b). */
  error?: string | FailureCopy | null;
  onUndo: () => void;
  onDismiss: () => void;
  /** Its leave (lib/noticeLeave NoticeLeave), when its parent draws one. */
  leave?: LeaveProps;
}

/** "Moved “X” to Recently deleted · Undo", for a few seconds after a delete. */
export function UndoDeleteToast({ name, busy = false, error = null, onUndo, onDismiss, leave }: UndoDeleteToastProps) {
  const [paused, setPaused] = useState(false);
  // Waiting behind a capped popover (GM r13 2): its timer holds, so it isn't lost.
  const waiting = useSlotWaiting('asset-trash');
  useEffect(() => {
    if (paused || busy || error || waiting) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, busy, error, waiting, onDismiss]);
  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="asset-trash">
      <div className="asset-trash__toast" role="status" aria-live="polite" {...leave}
        onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span className="asset-trash__toast-text">{error ? (typeof error === 'string' ? <LineText text={error} /> : <LineText text={oneLine({ ...error, reason: shortReason(error.reason) })} />) : `Moved “${name || 'Untitled'}” to Recently deleted`}</span>
        <button type="button" className="asset-trash__toast-undo" disabled={busy} onClick={onUndo}>Undo</button>
        <button type="button" className="asset-trash__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}
