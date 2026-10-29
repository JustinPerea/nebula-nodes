import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { AutoGrowTextarea } from './AutoGrowTextarea';
import '../styles/prompt-dialog.css';
import { ModalPortal } from './ModalPortal';
import type { ActProps } from '../lib/canvasLock';
import { composing } from '../lib/imeComposing';

export interface PromptRequest {
  label: string;
  initial: string;
  resolve: (value: string | null) => void;
}

/** Shared text-entry dialog for browser and desktop workflows. */
export function PromptDialog({ request, onDone, maxLength, cap, revealCounter = 0, onChange, confirm, onRefused, multiline = false, confirmLabel = 'OK' }: {
  request: PromptRequest;
  onDone: (value: string | null) => void;
  /** Optional cap passed to the input (e.g. 280 for notes to agents). */
  maxLength?: number;
  /** A cap the field can't count itself (the note's: only what shows counts,
   * PR #200 fix round 11). An edit that would pass it is refused whole, a
   * paste too (never cut to fit), with the caret kept; a neutral "N left"
   * shows under the field from `showAt` left, and at once, whatever is
   * left, after a refused edit (GM r20 note 1 and its addendum). GM r23
   * item 3: the next edit that leaves more than `showAt` hides it again, with
   * the row's fade. GM r23 item 4: screen readers hear it politely at 30, 10
   * and 0 left only (the visible counter is not a live region). */
  cap?: { max: number; count: (value: string) => number; showAt: number };
  /** Each change turns the counter on as a refused edit does (review 13
   * NIT-3: the backend refused the note as too long). */
  revealCounter?: number;
  /** Each change of the text (the note dialog keeps it: round 23 of PR #195). */
  onChange?: (value: string) => void;
  /** The OK button's state when something else decides it (the canvas lock's
   * `act()`: disabled, its marks and tooltip). Enter does nothing then. */
  confirm?: ActProps;
  /** Enter or OK pressed while `confirm` is disabled. */
  onRefused?: () => void;
  /** A text that may run to several lines (the note for agents, fix round 1
   * of PR #200, GM bug 2): a textarea that grows to about 4 lines, then
   * scrolls; it opens with the caret at the end and nothing selected, so
   * typing adds to a kept note instead of replacing it (review L-1). Enter
   * sends, Shift+Enter starts a new line. */
  multiline?: boolean;
  /** The confirm button's words ("Send note" for the note). */
  confirmLabel?: string;
}) {
  const [value, setValue] = useState(request.initial);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    const field = input.current;
    field?.focus();
    if (multiline && field) {
      const end = field.value.length;
      field.setSelectionRange(end, end);
      field.scrollTop = field.scrollHeight;
    } else {
      field?.select();
    }
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [multiline]);

  // After a refused edit the counter shows whatever is left, until an edit
  // leaves more than `showAt` (GM r23 item 3).
  const [refused, setRefused] = useState(false);
  const [revealed, setRevealed] = useState(revealCounter);
  if (revealed !== revealCounter) {
    setRevealed(revealCounter);
    if (revealCounter > 0) setRefused(true);
  }
  // Where the caret goes back to after a refused edit: set after the commit
  // that puts the value back (a render), and in a microtask for the case
  // with no render (React puts the controlled value back after the handler).
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  const change = (typed: string, field: HTMLInputElement | HTMLTextAreaElement) => {
    caret.current = null;
    if (!cap || cap.count(typed) <= cap.max || cap.count(typed) <= cap.count(value)) {
      if (cap && cap.max - cap.count(typed) > cap.showAt) setRefused(false);
      setValue(typed);
      onChange?.(typed);
      return;
    }
    // Over the cap: refused whole (GM r20 note 1), never cut to fit. React
    // puts the controlled value back once this handler returns, which moves
    // the caret to the end, so the caret goes back where the edit began in a
    // microtask after that.
    const at = Math.max(0, Math.min(value.length, end(field) - (typed.length - value.length)));
    caret.current = at;
    setRefused(true);
    setValue(value);
    queueMicrotask(() => { if (field.isConnected) field.setSelectionRange(at, at); });
  };
  const left = cap ? Math.max(0, cap.max - cap.count(value)) : 0;
  const counter = cap && (refused || left <= cap.showAt) ? `${left} left` : null;
  // While it fades out it keeps its last words.
  const [lastCounter, setLastCounter] = useState(counter);
  if (counter !== null && counter !== lastCounter) setLastCounter(counter);
  const counterId = useId();
  const described = counter !== null ? counterId : undefined;
  // GM r23 item 4: one polite announcement as the note reaches 30, 10 and 0
  // left (the count then, should a paste jump past one), never each key.
  const [announced, setAnnounced] = useState('');
  const [leftBefore, setLeftBefore] = useState(left);
  if (leftBefore !== left) {
    setLeftBefore(left);
    if (cap && left < leftBefore && ANNOUNCE_AT.some((mark) => leftBefore > mark && left <= mark)) {
      setAnnounced(`${left} ${left === 1 ? 'character' : 'characters'} left`);
    } else if (cap && left > cap.showAt && announced) {
      // Review 14 NIT-3: back above 30 left, the old words go at once.
      setAnnounced('');
    }
  }
  // Review 14 NIT-3: once spoken, the hidden region empties, so a virtual
  // cursor never lands on a count that is no longer true.
  useEffect(() => {
    if (!announced) return;
    const clear = window.setTimeout(() => setAnnounced(''), ANNOUNCE_CLEAR_MS);
    return () => window.clearTimeout(clear);
  }, [announced]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (confirm?.disabled) {
      onRefused?.();
      return;
    }
    onDone(value);
  };
  return (
    <ModalPortal>
    <div className="prompt-dialog" role="dialog" aria-modal="true" aria-label={request.label}>
      <form ref={form} className="prompt-dialog__card" onSubmit={submit} onKeyDown={(event) => {
        if (event.key === 'Enter' && composing(event)) {
          // The input method's Enter ends its composition (Safari: keyCode
          // 229 after compositionend, review 2 L-1): it never sends.
          event.preventDefault();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDone(null);
        } else if (event.key === 'Tab') {
          const controls = form.current?.querySelectorAll<HTMLElement>('input, textarea, button');
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}>
        <label className="prompt-dialog__field">
          {request.label}
          {multiline
            ? <AutoGrowTextarea textareaRef={input as RefObject<HTMLTextAreaElement | null>} rows={1} value={value} maxLength={maxLength}
                aria-describedby={described}
                onChange={(event) => change(event.target.value, event.target)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !composing(event)) {
                    event.preventDefault();
                    form.current?.requestSubmit();
                  }
                }} />
            : <input ref={input as RefObject<HTMLInputElement | null>} value={value} maxLength={maxLength} aria-describedby={described}
                onChange={(event) => change(event.target.value, event.target)} />}
        </label>
        <div className="prompt-dialog__actions">
          {/* Under the field, on the left of the buttons' row, so showing it
              moves nothing; outside the label, so it never joins the
              field's name (the field points at it while it shows). */}
          {cap && (
            <span id={counterId} className="prompt-dialog__counter" data-shown={counter !== null || undefined}
              aria-hidden={counter === null || undefined}>{counter ?? lastCounter}</span>
          )}
          {cap && <span className="prompt-dialog__announce" aria-live="polite" aria-atomic="true">{announced}</span>}
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="prompt-dialog__confirm" {...confirm}>{confirmLabel}</button>
        </div>
      </form>
    </div>
    </ModalPortal>
  );
}

/** Where screen readers hear "N left" (GM r23 item 4). */
const ANNOUNCE_AT = [30, 10, 0];
/** How long an announcement stays in the hidden region: long enough for a
 * polite one to be read after the key that caused it. */
const ANNOUNCE_CLEAR_MS = 5000;

const end = (field: HTMLInputElement | HTMLTextAreaElement) => field.selectionEnd ?? field.value.length;

