import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { rowSegments, type PlaceholderRunConfirm, type PlaceholderRunRow } from '../lib/placeholderRunConfirm';
import { returnFocusOnSlip } from '../lib/modalFocus';
import '../styles/prompt-dialog.css';
import '../styles/placeholder-run-dialog.css';
import { ModalPortal } from './ModalPortal';

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
 *
 * GM - Design, round 6: the line also shows once anything it says changes in
 * place after it first showed (note 2), and stays; a screen reader hears it
 * through a polite live region at each such change (review 5, L7). A paid
 * node of the run that is no placeholder has a muted row with no dot (item
 * 3). Run hands back the words it was showing when it was clicked (review 5,
 * L6), so the run sends what the person saw, not what was about to be drawn.
 *
 * Review 6, M1 (GM - Design: "rows scroll with everything else pinned: yes.
 * The scroll area must be reachable by keyboard, and initial focus stays on
 * Cancel."): with many paid nodes the rows scroll inside the card, which
 * never grows past the window (placeholder-run-dialog.css), so the heading,
 * the changed line, the total, the footnotes and the buttons stay on screen.
 * A list that scrolls is a Tab stop named by the heading; one that fits isn't.
 * Review 6, L-b: the line for placeholders that left the run sits under the intro.
 * GM - Design on review 8 L-b: on a replay still being set up, the line that
 * says the replay uses the saved settings sits between them.
 * Review 7, M-1: focus never leaves it while it is open (the rows that stop
 * scrolling hand focus to Cancel; a slip to the page comes back to Cancel),
 * and no canvas shortcut acts behind it (lib/canvasShortcutScope.ts
 * isModalDialogOpen: it is aria-modal).
 */
export const CHANGED_LINE = 'This run changed since you last reviewed it.';
/** How long Run ignores clicks after the dialog's numbers change (GM: "~500 ms"). */
export const RUN_CLICK_GUARD_MS = 500;

/** What the person reads before Run: a change to any of it holds Run back. */
function signature(model: PlaceholderRunConfirm): string {
  return JSON.stringify([model.heading, model.intro, model.savedLine, model.leftLine, model.rows, model.freeLine, model.totalLine,
    model.notes, model.runLabel]);
}

/** Whether the rows overflow their box: then the list scrolls and takes keyboard focus. */
function useScrolls(list: RefObject<HTMLUListElement | null>, rows: number): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const measure = () => setScrolls(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [list, rows]);
  return scrolls;
}

/**
 * A row's segments (rowSegments), each one unit on the line (GM - Design,
 * round 12): the row wraps only between them, never inside "Grain model:
 * gaussian" or “Name”. The " ·" stays with the segment before it, so a
 * wrapped line starts with a segment, at the row's indent. The agent's dot
 * leads the first segment, with the name.
 */
function RowSegments({ row }: { row: PlaceholderRunRow }) {
  const [name, ...rest] = rowSegments(row);
  const separator = (index: number) => (index < rest.length ? ' ·' : '');
  return (
    <>
      <span className="placeholder-run__seg placeholder-run__seg--lead">
        {row.agent && <span className="placeholder-run__dot" data-verified={String(row.agent.verified)} aria-hidden="true" />}
        <span className="placeholder-run__name">{name}</span>{separator(0)}
      </span>
      {rest.map((segment, index) => (
        <Fragment key={index}>{' '}<span className="placeholder-run__seg">{segment}{separator(index + 1)}</span></Fragment>
      ))}
    </>
  );
}

export function PlaceholderRunDialog({ model, changed = false, onDone }: {
  model: PlaceholderRunConfirm;
  /** Asked again because the run changed since the person last saw it. */
  changed?: boolean;
  /** `shown`: the words on screen when Run or Cancel was clicked. */
  onDone: (ok: boolean, shown: PlaceholderRunConfirm) => void;
}) {
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const scrolls = useScrolls(list, model.rows.length);
  const shown = useRef<string | null>(null);
  const heldUntil = useRef(0);
  const current = signature(model);
  // How many times its words changed in place since it first showed: the
  // changed line stays from the first, and each one is announced afresh.
  const [track, setTrack] = useState({ last: current, changes: 0 });
  if (track.last !== current) setTrack({ last: current, changes: track.changes + 1 });
  const changes = track.last !== current ? track.changes + 1 : track.changes;
  // Before any click can land: a layout effect runs in the same task as the commit.
  useLayoutEffect(() => {
    if (current === shown.current) return;
    const opening = shown.current === null;
    shown.current = current;
    if (!opening || changed) heldUntil.current = Date.now() + RUN_CLICK_GUARD_MS;
  }, [current, changed]);
  const run = () => {
    if (Date.now() < heldUntil.current) return;
    onDone(true, model);
  };
  // A no-break space on every other change makes the region's text differ, so it is read again.
  const announced = changes > 0 ? `${CHANGED_LINE}${changes % 2 === 0 ? '\u00a0' : ''}` : '';
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  // Review 7, M-1: focus never falls out of the open dialog. The rows that
  // stop scrolling (an agent deleted placeholders, the window grew) leave the
  // Tab order; if they had focus, it moves to Cancel before the browser can
  // drop it on the page, where Cmd+Enter would run the graph behind the dialog.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    const was = scrolled.current;
    scrolled.current = scrolls;
    if (scrolls || !was) return;
    const active = document.activeElement;
    if (active === list.current || active === document.body || active === null) cancel.current?.focus();
  }, [scrolls]);
  // Any other slip to the page (a click on the backdrop, an element that
  // went away) comes back to Cancel, once the browser has settled where focus is.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => returnFocusOnSlip(event, () => cancel.current);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDone(false, model);
    } else if (event.key === 'Tab') {
      // The Tab stops: the rows when they scroll (review 6, M1), then the buttons.
      const stops = card.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
      if (!stops?.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  return (
    <ModalPortal>
    <div className="prompt-dialog placeholder-run" role="alertdialog" aria-modal="true"
      aria-labelledby={headingId} aria-describedby={bodyId} onKeyDown={onKeyDown} onBlur={onBlur}>
      <div ref={card} className="prompt-dialog__card placeholder-run__card">
        <h2 id={headingId} className="placeholder-run__heading">{model.heading}</h2>
        <div id={bodyId} className="placeholder-run__body">
          <p className="prompt-dialog__line">{model.intro}</p>
          {model.savedLine && <p className="prompt-dialog__line placeholder-run__saved">{model.savedLine}</p>}
          {model.leftLine && <p className="prompt-dialog__line placeholder-run__left">{model.leftLine}</p>}
          {(changed || changes > 0) && <p className="prompt-dialog__line placeholder-run__changed">{CHANGED_LINE}</p>}
          <ul ref={list} className="placeholder-run__rows"
            {...(scrolls ? { tabIndex: 0, 'aria-labelledby': headingId } : {})}>
            {model.rows.map((row) => (
              <li key={row.nodeId} className={row.agent ? 'placeholder-run__row' : 'placeholder-run__row placeholder-run__row--muted'}
                style={row.agent ? { '--prd-color': row.agent.color } as CSSProperties : undefined}>
                <RowSegments row={row} />
              </li>
            ))}
          </ul>
          {model.freeLine && <p className="prompt-dialog__line placeholder-run__free">{model.freeLine}</p>}
          {model.totalLine && <p className="prompt-dialog__line placeholder-run__total">{model.totalLine}</p>}
          {model.notes.map((note) => <p key={note} className="prompt-dialog__line placeholder-run__note">{note}</p>)}
        </div>
        <p className="placeholder-run__live" aria-live="polite">{announced}</p>
        <div className="prompt-dialog__actions">
          <button type="button" ref={cancel} onClick={() => onDone(false, model)}>Cancel</button>
          <button type="button" className="prompt-dialog__confirm" onClick={run}>{model.runLabel}</button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
