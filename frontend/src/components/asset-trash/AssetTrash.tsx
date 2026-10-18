import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, RotateCcw, X } from 'lucide-react';
import { backendAssetUrlSync } from '../../lib/backend';
import {
  deletedByLabel, emptyTrash, fetchTrash, purgeTrashed, restoreTrashed,
  type TrashedItem,
} from '../../lib/trash';
import type { AssetScope } from '../../store/uiStore';
import '../../styles/asset-trash.css';

/**
 * Recently deleted, inside Moodboard Studio and Character Studio.
 *
 * A deleted board or character waits here until the person deletes it for
 * good (no timer). Restore brings it back with the same id, so canvas nodes
 * that point at it work again. Delete forever is the person's alone; the
 * backend refuses agents.
 */

type AssetKind = 'moodboard' | 'character';

const NOUNS: Record<AssetKind, { one: string; many: string }> = {
  moodboard: { one: 'board', many: 'boards' },
  character: { one: 'character', many: 'characters' },
};

export const UNDO_VISIBLE_MS = 8000;

function deletedLine(item: TrashedItem): string {
  const date = new Date(item.deletedAt);
  const when = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
    : '';
  const who = deletedByLabel(item);
  return ['Deleted', when, who ? `by ${who}` : ''].filter(Boolean).join(' ');
}

/** Two-step button for the one action that can't be undone. */
function ConfirmInline({ label, confirmLabel, prompt, busy, onConfirm }: {
  label: string; confirmLabel: string; prompt: string; busy: boolean; onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const disarm = () => { setArmed(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!armed) {
    return <button type="button" ref={trigger} className="asset-trash__button" disabled={busy}
      onClick={() => setArmed(true)}>{label}</button>;
  }
  return (
    <span className="asset-trash__confirm" role="group" aria-label={prompt} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); disarm(); }
    }}>
      <span className="asset-trash__confirm-prompt">{prompt}</span>
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
}

export function RecentlyDeletedAssets({ kind, scope, refreshKey, onRestored }: RecentlyDeletedAssetsProps) {
  const [items, setItems] = useState<TrashedItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const noun = NOUNS[kind];

  useEffect(() => {
    let cancelled = false;
    fetchTrash({ kind, scope })
      .then((list) => { if (!cancelled) { setItems(list); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Couldn’t load Recently deleted.'); });
    return () => { cancelled = true; };
  }, [kind, scope, refreshKey, reload]);

  const act = useCallback(async (work: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  }, []);

  if (items.length === 0 && !error) return null;

  return (
    <section className="asset-trash" aria-label={`Recently deleted ${noun.many}`}>
      <div className="asset-trash__header">
        <button type="button" className="asset-trash__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight aria-hidden="true" />Recently deleted
          <span className="asset-trash__count" aria-hidden="true">{items.length}</span>
        </button>
        {open && items.length > 0 && (
          <ConfirmInline label="Empty" confirmLabel="Delete all" busy={busy}
            prompt={items.length === 1 ? `Delete this ${noun.one} for good?` : `Delete all ${items.length} ${noun.many} for good?`}
            onConfirm={() => void act(() => emptyTrash({ kind, scope }))} />
        )}
      </div>
      {error && <p className="asset-trash__error" role="alert">{error}</p>}
      {open && (
        <>
          <p className="asset-trash__note">Deleted {noun.many} stay here until you delete them for good.</p>
          <ul className="asset-trash__list">
            {items.map((item) => (
              <li key={item.id} className="asset-trash__row" aria-label={item.name || 'Untitled'}>
                <span className="asset-trash__thumb">
                  {item.thumbnail ? <img src={backendAssetUrlSync(item.thumbnail)} alt="" draggable={false} /> : null}
                </span>
                <span className="asset-trash__meta">
                  <span className="asset-trash__name">{item.name || 'Untitled'}</span>
                  <span className="asset-trash__sub">{deletedLine(item)}</span>
                </span>
                <span className="asset-trash__actions">
                  <button type="button" className="asset-trash__button" disabled={busy}
                    aria-label={`Restore ${item.name || 'Untitled'}`}
                    onClick={() => void act(() => restoreTrashed(kind, item.id), () => onRestored?.(item))}>
                    <RotateCcw aria-hidden="true" />Restore
                  </button>
                  <ConfirmInline label="Delete forever" confirmLabel="Delete forever" prompt="This can’t be undone."
                    busy={busy} onConfirm={() => void act(() => purgeTrashed(kind, item.id))} />
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
  error?: string | null;
  onUndo: () => void;
  onDismiss: () => void;
}

/** "Moved “X” to Recently deleted · Undo", for a few seconds after a delete. */
export function UndoDeleteToast({ name, busy = false, error = null, onUndo, onDismiss }: UndoDeleteToastProps) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || busy || error) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, busy, error, onDismiss]);
  return (
    <div className="asset-trash__toast" role="status" aria-live="polite"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <span className="asset-trash__toast-text">{error ?? `Moved “${name || 'Untitled'}” to Recently deleted`}</span>
      <button type="button" className="asset-trash__toast-undo" disabled={busy} onClick={onUndo}>Undo</button>
      <button type="button" className="asset-trash__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
    </div>
  );
}
