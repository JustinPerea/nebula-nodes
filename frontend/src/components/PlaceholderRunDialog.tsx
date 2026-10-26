import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent } from 'react';
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
 */
export function PlaceholderRunDialog({ model, onDone }: {
  model: PlaceholderRunConfirm;
  onDone: (ok: boolean) => void;
}) {
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
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
          <button type="button" className="prompt-dialog__confirm" onClick={() => onDone(true)}>{model.runLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
