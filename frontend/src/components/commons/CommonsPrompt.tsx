import { useState, type FormEvent } from 'react';

export interface PromptRequest {
  label: string;
  initial: string;
  resolve: (value: string | null) => void;
}

export function PromptDialog({ request, onDone }: { request: PromptRequest; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(request.initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onDone(value);
  };
  return (
    <div className="commons-prompt" role="dialog" aria-modal="true" aria-label={request.label}>
      <form
        className="commons-prompt__card"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDone(null);
          }
        }}
      >
        <label className="commons-field">
          {request.label}
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <div className="commons-prompt__actions">
          <button type="button" className="commons-button" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="commons-button commons-button--primary">OK</button>
        </div>
      </form>
    </div>
  );
}
