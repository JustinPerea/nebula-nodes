import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PlaceholderRunConfirm } from '../lib/placeholderRunConfirm';
import '../styles/prompt-dialog.css';
import '../styles/placeholder-run-dialog.css';

/**
 * Q133 (Justin, 2026-10-25): before the person's direct run makes an agent's
 * paid placeholder normal, Nebula always asks, whatever "Ask before costly
 * runs" says. GM - Design's copy and layout, verbatim (lib/placeholderRunConfirm.ts
 * builds the words): the heading, the line under it, one row per paid
 * placeholder with its agent's dot (a ring when it named itself), the free
 * ones in one line, the whole run's total, then Cancel and "Run for $X".
 *
 * The app's own dialog, never window.confirm: focus on Cancel (Enter never
 * spends by accident), Escape is Cancel, Tab stays inside. Loaded only when
 * it is needed (askPlaceholderRun.tsx, lib/deferredChunks.ts placeholderRunDialogModule).
 *
 * GM - Design, round 5 (review 4, M3): a dialog back because the run changed
 * (`changed`) says so above the rows, and Run takes no click for 500 ms after
 * it opens or after a row, the total or the button changes while it is open,
 * so a click already on its way can't confirm a price it didn't see. Focus
 * stays where it was (the same buttons re-render in place).
 */
export const CHANGED_LINE = 'This run changed since you last reviewed it.';
/** How long Run ignores clicks after the dialog's numbers change (GM: "~500 ms"). */
export const RUN_CLICK_GUARD_MS = 500;

/** What the person reads before Run: a change to any of it holds Run back. */
function signature(model: PlaceholderRunConfirm): string {
  return JSON.stringify([model.rows, model.freeLine, model.totalLine, model.notes, model.runLabel]);
}

export function PlaceholderRunDialog({ model, changed = false, onDone }: {
  model: PlaceholderRunConfirm;
  /** Asked again because the run changed since the person last saw it. */
  changed?: boolean;
  onDone: (ok: boolean) => void;
}) {
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const shown = useRef<string | null>(null);
  const heldUntil = useRef(0);
  const current = signature(model);
  // Before any click can land: a layout effect runs in the same task as the commit.
  useLayoutEffect(() => {
    if (current === shown.current) return;
    const opening = shown.current === null;
    shown.current = current;
    if (!opening || changed) heldUntil.current = Date.now() + RUN_CLICK_GUARD_MS;
  }, [current, changed]);
  const run = () => {
    if (Date.now() < heldUntil.current) return;
    onDone(true);
  };
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDone(false);
    } else if (event.key === 'Tab') {
      const buttons = card.current?.querySelectorAll<HTMLElement>('button');
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  return createPortal(
    <div className="prompt-dialog placeholder-run" role="alertdialog" aria-modal="true"
      aria-labelledby={headingId} aria-describedby={bodyId} onKeyDown={onKeyDown}>
      <div ref={card} className="prompt-dialog__card placeholder-run__card">
        <h2 id={headingId} className="placeholder-run__heading">{model.heading}</h2>
        <div id={bodyId} className="placeholder-run__body">
          <p className="prompt-dialog__line">{model.intro}</p>
          {changed && <p className="prompt-dialog__line placeholder-run__changed">{CHANGED_LINE}</p>}
          <ul className="placeholder-run__rows">
            {model.rows.map((row) => (
              <li key={row.nodeId} className="placeholder-run__row" style={{ '--prd-color': row.agent.color } as CSSProperties}>
                <span className="placeholder-run__dot" data-verified={String(row.agent.verified)} aria-hidden="true" />
                <span className="placeholder-run__name">{row.name}</span>
                {[row.model, row.price].filter(Boolean).map((part) => ` · ${part}`).join('')}
              </li>
            ))}
          </ul>
          {model.freeLine && <p className="prompt-dialog__line placeholder-run__free">{model.freeLine}</p>}
          {model.totalLine && <p className="prompt-dialog__line placeholder-run__total">{model.totalLine}</p>}
          {model.notes.map((note) => <p key={note} className="prompt-dialog__line placeholder-run__note">{note}</p>)}
        </div>
        <div className="prompt-dialog__actions">
          <button type="button" ref={cancel} onClick={() => onDone(false)}>Cancel</button>
          <button type="button" className="prompt-dialog__confirm" onClick={run}>{model.runLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
