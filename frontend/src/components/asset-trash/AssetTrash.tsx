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
import '../../styles/asset-trash.css';
import { useCurrentProjectId } from '../../lib/currentProject';
import type { LeaveProps } from '../../lib/noticeLeave';

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
function ConfirmInline({ label, confirmLabel, prompt, title, busy, onConfirm }: {
  label: string; confirmLabel: string; prompt: string; title?: string; busy: boolean; onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const disarm = () => { setArmed(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!armed) {
    // It arms a Delete forever or an Empty: red on hover (GM r13), neutral at rest.
    return <button type="button" ref={trigger} className="asset-trash__button asset-trash__trigger--danger" disabled={busy}
      onClick={() => setArmed(true)}>{label}</button>;
  }
  return (
    <span className="asset-trash__confirm" role="group" aria-label={prompt} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); disarm(); }
    }}>
      <span className="asset-trash__confirm-prompt" title={title}>{prompt}</span>
      <button type="button" className="asset-trash__button" autoFocus disabled={busy} onClick={disarm}>Cancel</button>
      <button type="button" className="asset-trash__button asset-trash__button--danger" disabled={busy}
        onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</button>
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
  /** A new `n` opens the list (a Studio line's Restore for several boards, round 6j), and focus goes to the
   *  Restore button of the first of `focus` it lists, with the keyboard ring only when `keyboard` (round 6k, GM r19 3). */
  openRequest?: TrashOpenRequest;
  /** The list starts open (a Studio's several-board Restore, kept open across a remount: round 6l, review 10 NIT-3). */
  defaultOpen?: boolean;
  /** What deleting these items for good would also lose (a Studio's unsaved edits, GM r21 Q2): a sentence the
   *  confirm adds, with the full names in its title; null when nothing. */
  atStake?: (items: readonly TrashedItem[]) => { text: string; title: string } | null;
  /** Items deleted for good from this list (its Delete forever or Empty, once it succeeded). */
  onPurged?: (ids: readonly string[]) => void;
}

export interface TrashOpenRequest { n: number; focus?: readonly string[]; keyboard?: boolean }

export function RecentlyDeletedAssets({ kind, scope, refreshKey, onRestored, onTrashChanged, openRequest, defaultOpen = false, atStake,
  onPurged }: RecentlyDeletedAssetsProps) {
  const [items, setItems] = useState<TrashedItem[]>([]);
  // Which tab and project `items` came from.
  const [itemsFor, setItemsFor] = useState('');
  const [open, setOpen] = useState(defaultOpen);
  // A request from outside opens the list: a new one, not one made before this list mounted.
  const [seenRequest, setSeenRequest] = useState(openRequest?.n);
  const [focusWanted, setFocusWanted] = useState<TrashOpenRequest | null>(null);
  if (openRequest?.n !== seenRequest) {
    setSeenRequest(openRequest?.n);
    if (openRequest?.n) {
      setOpen(true);
      setFocusWanted(openRequest);
    }
  }
  const focusDone = useRef<TrashOpenRequest | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const [busy, setBusy] = useState(false);
  // A failed load's line, and a failed Restore or delete's own (round 6k: the list read again after an
  // action, as it always is, clears only a load's line, so an action's refusal stays until the next action).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const error = actError ?? loadError;
  const [reload, setReload] = useState(0);
  const noun = NOUNS[kind];
  // A project's Recently deleted is the open canvas project's (lib/currentProject).
  const openProjectId = useCurrentProjectId();
  const projectId = scope === 'project' ? openProjectId : null;
  const noProject = scope === 'project' && !projectId;
  const where = `${scope}:${projectId ?? ''}`;
  // A refusal is about the list it came from: another tab or project's list doesn't show it (review 10 NIT-2).
  const [actErrorFor, setActErrorFor] = useState(where);
  if (actErrorFor !== where) {
    setActErrorFor(where);
    if (actError) setActError(null);
  }

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
        setLoadError(null);
        const ids = list.map((item) => item.id).join(',');
        const before = listed.current;
        listed.current = { where, ids };
        if (before && before.where === where && before.ids !== ids) trashChanged.current?.();
      })
      .catch((err) => {
        if (cancelled) return;
        setItemsFor(where);
        setLoadError(failureMessage(err, "Couldn't load Recently deleted."));
      });
    return () => { cancelled = true; };
  }, [kind, scope, projectId, noProject, where, refreshKey, reload]);

  // A delete or restore elsewhere (another tab, an agent) shows up here too.
  useEffect(() => wsClient.subscribe((event) => {
    if ((event.type === 'storedAssetChanged' && event.kind === kind) || event.type === 'socketReconnected') {
      setReload((value) => value + 1);
    }
  }), [kind]);

  // Once this scope's list is up: the first asked-for board's Restore takes focus (none listed: nothing moves).
  useEffect(() => {
    if (!focusWanted || focusDone.current === focusWanted || !open || itemsFor !== where) return;
    focusDone.current = focusWanted;
    const listed = new Set(items.map((item) => item.id));
    const first = focusWanted.focus?.find((id) => listed.has(id));
    const button = first ? Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button[data-restore-id]') ?? [])
      .find((it) => it.getAttribute('data-restore-id') === first) : undefined;
    button?.focus({ focusVisible: Boolean(focusWanted.keyboard) } as FocusOptions);
  }, [focusWanted, open, items, itemsFor, where]);

  const act = useCallback(async (work: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    setActError(null);
    try {
      await work();
      after?.();
    } catch (err) {
      // A request's own line; never another error's message (round 3b).
      setActError(failureMessage(err, ''));
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
        {open && items.length > 0 && (() => {
          const shown = items;
          const lost = atStake?.(shown) ?? null;
          const ask = shown.length === 1 ? `Delete this ${noun.one} for good?` : `Delete all ${shown.length} ${noun.many} for good?`;
          return <ConfirmInline label="Empty" confirmLabel="Delete all" busy={busy} prompt={lost ? `${ask} ${lost.text}` : ask} title={lost?.title}
            onConfirm={() => void act(() => emptyTrash({ kind, scope, projectId: projectId ?? undefined }, shown),
              () => onPurged?.(shown.map((item) => item.id)))} />;
        })()}
      </div>
      {error && <p className="asset-trash__error" role="alert">{error}</p>}
      {open && (
        <>
          <p className="asset-trash__note">Deleted {noun.many} stay here until you delete them for good.</p>
          <ul className="asset-trash__list" ref={list}>
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
                  <button type="button" className="asset-trash__button" disabled={busy} data-restore-id={item.id}
                    aria-label={`Restore ${item.name || 'Untitled'}`}
                    onClick={() => void act(() => restoreTrashed(kind, item.id), () => onRestored?.(item))}>
                    <RotateCcw aria-hidden="true" />Restore
                  </button>
                  {(() => {
                    const lost = atStake?.([item]) ?? null;
                    return <ConfirmInline label="Delete forever" confirmLabel="Delete forever"
                      prompt={lost ? `This can’t be undone. ${lost.text}` : 'This can’t be undone.'} title={lost?.title}
                      busy={busy} onConfirm={() => void act(() => purgeTrashed(kind, item.id), () => onPurged?.([item.id]))} />;
                  })()}
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
  useEffect(() => {
    if (paused || busy || error) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, busy, error, onDismiss]);
  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="asset-trash">
      <div className="asset-trash__toast" role="status" aria-live="polite" {...leave}
        onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span className="asset-trash__toast-text">{error ? (typeof error === 'string' ? error : oneLine({ ...error, reason: shortReason(error.reason) })) : `Moved “${name || 'Untitled'}” to Recently deleted`}</span>
        <button type="button" className="asset-trash__toast-undo" disabled={busy} onClick={onUndo}>Undo</button>
        <button type="button" className="asset-trash__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}
