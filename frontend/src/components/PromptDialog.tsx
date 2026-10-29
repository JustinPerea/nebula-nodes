import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
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
export function PromptDialog({ request, onDone, maxLength, fit, onChange, confirm, onRefused, multiline = false, confirmLabel = 'OK' }: {
  request: PromptRequest;
  onDone: (value: string | null) => void;
  /** Optional cap passed to the input (e.g. 280 for notes to agents). */
  maxLength?: number;
  /** A cap the field can't count itself (the note's: only what shows counts,
   * PR #200 fix round 11): each change goes through it, the way maxLength
   * trims a paste. */
  fit?: (value: string) => string;
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

  const change = (typed: string) => {
    const next = fit ? fit(typed) : typed;
    setValue(next);
    onChange?.(next);
  };

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
                onChange={(event) => change(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !composing(event)) {
                    event.preventDefault();
                    form.current?.requestSubmit();
                  }
                }} />
            : <input ref={input as RefObject<HTMLInputElement | null>} value={value} maxLength={maxLength}
                onChange={(event) => change(event.target.value)} />}
        </label>
        <div className="prompt-dialog__actions">
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="prompt-dialog__confirm" {...confirm}>{confirmLabel}</button>
        </div>
      </form>
    </div>
    </ModalPortal>
  );
}
