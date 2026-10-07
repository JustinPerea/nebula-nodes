import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import '../styles/prompt-dialog.css';

export interface PromptRequest {
  label: string;
  initial: string;
  resolve: (value: string | null) => void;
}

/** Shared text-entry dialog for browser and desktop workflows. */
export function PromptDialog({ request, onDone }: { request: PromptRequest; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(request.initial);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    input.current?.focus();
    input.current?.select();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onDone(value);
  };
  return createPortal(
    <div className="prompt-dialog" role="dialog" aria-modal="true" aria-label={request.label}>
      <form ref={form} className="prompt-dialog__card" onSubmit={submit} onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDone(null);
        } else if (event.key === 'Tab') {
          const controls = form.current?.querySelectorAll<HTMLElement>('input, button');
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
          <input ref={input} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <div className="prompt-dialog__actions">
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="prompt-dialog__confirm">OK</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
