import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../asset-move/anchoredPopover';
import { springCssVars } from '../../lib/springs';
import type { LeaveAsking, LeaveChoice } from './commonsLeave';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';

/**
 * The Commons' leave popover (commons-leave). GM - Design's copy, verbatim:
 * "Your labels aren't saved." with Save and leave (primary), Discard and
 * leave, Stay; after a failed save "Couldn't save your labels." and the
 * reason, and no Save and leave when saving again can't work (a conflict:
 * Discard and leave, Stay, focus on Stay); for a grading run alone "Agent
 * review is still running." with Stop and leave (primary), Stay. Anchored to the clicked control (the toolbar
 * menu's anchoring); focus starts on the primary choice and Tab stays among
 * the choices; Escape or a press outside is Stay. It springs in on the
 * corner's POP spring, and not at all with reduced motion (commons.css).
 */
export function CommonsLeavePopover({ asking, unsaved, running, onChoose, onStay }: {
  asking: LeaveAsking;
  unsaved: boolean;
  running: boolean;
  onChoose: (choice: LeaveChoice) => void;
  /** `returnFocus`: back to the clicked control (Escape and Stay; not a press elsewhere). */
  onStay: (returnFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Round 16 (L4): offline Save and leave is disabled (it would be refused),
  // and focus starts on Stay; Discard and leave stays, since it sends nothing.
  const readOnly = useBackendOffline();
  const anchorRef = useMemo(() => ({ current: asking.anchor }), [asking.anchor]);
  const lineId = useId();
  const reasonId = useId();
  const dismiss = useCallback(() => {
    onStay(false);
    // A press on nothing focusable leaves focus nowhere: give it back to the control.
    window.requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        if (asking.anchor?.isConnected) asking.anchor.focus();
      }
    });
  }, [onStay, asking.anchor]);
  // Asked from the Updates corner: open beside the list or card, not over it (GM).
  const outside = asking.anchor?.closest<HTMLElement>('.agent-notes-panel, .agent-note-card') ?? null;
  const position = useAnchoredPopover(anchorRef, panelRef, dismiss, 'auto', 280, outside, asking.seq);

  // Every opening (a failure lands as a new one) puts focus on its first
  // choice: the primary, or Stay when saving again can't work.
  useEffect(() => {
    if (position) panelRef.current?.querySelector<HTMLElement>('[data-leave-first]')?.focus();
  }, [position, asking.seq, readOnly]);

  const failed = asking.failure !== null;
  // GM: a conflict (or another refusal saving again would get) drops Save and
  // leave; Stay is where the person can reload.
  const settled = failed && !asking.retry;
  // Labels to save come first; a grading run alone gets its own ask.
  const labels = failed || unsaved || !running;
  const line = failed ? "Couldn't save your labels." : labels ? "Your labels aren't saved." : 'Agent review is still running.';
  const reason = failed ? asking.failure : null;
  const anchorKind = asking.anchor?.matches('.workspace-header__back') ? 'back'
    : asking.anchor?.matches('.project-workspace-controls__home') ? 'home' : 'other';

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onStay(true);
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  };

  const choose = (choice: LeaveChoice) => { if (!asking.pending) onChoose(choice); };
  const saving = asking.pending && asking.slow;
  const style = { ...springCssVars(), ...(position ? { left: position.left, top: position.top } : {}) } as CSSProperties;

  return createPortal(
    // tabIndex -1: a press on the popover's text or padding focuses the
    // panel (not the page), so Escape and the Tab loop keep working.
    <div ref={panelRef} role="alertdialog" tabIndex={-1} aria-modal="false" aria-labelledby={lineId}
      aria-describedby={reason ? reasonId : undefined} data-leave-popover="" data-anchor={anchorKind}
      className={`commons-leave${position ? ' commons-leave--open' : ''}`} style={style} onKeyDown={onKeyDown}>
      <p id={lineId} className="commons-leave__line">{line}</p>
      {/* An alert: a failed Save and leave lands here in place, with focus
          still on the button, so it has to be announced; keyed by the
          opening so the same reason a second time is announced again. */}
      {reason && <p key={asking.seq} id={reasonId} className="commons-leave__reason" role="alert">{reason}</p>}
      {labels && running && <p className="commons-leave__reason">Agent review is still running.</p>}
      <div className="commons-leave__actions">
        {labels ? (
          <>
            {!settled && (
              <button type="button" className="commons-button commons-button--primary" data-leave-first={readOnly ? undefined : ''}
                aria-busy={saving || undefined} disabled={readOnly} {...offlineMark(readOnly)}
                onClick={() => choose('save')}>{saving ? 'Saving…' : 'Save and leave'}</button>
            )}
            <button type="button" className="commons-button commons-button--danger" onClick={() => choose('discard')}>Discard and leave</button>
          </>
        ) : (
          <button type="button" className="commons-button commons-button--primary" data-leave-first="" onClick={() => choose('stop')}>Stop and leave</button>
        )}
        <button type="button" className="commons-button" data-leave-first={settled || (labels && readOnly) ? '' : undefined}
          onClick={() => onStay(true)}>Stay</button>
      </div>
    </div>,
    document.body,
  );
}
