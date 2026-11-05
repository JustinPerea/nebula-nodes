import { useContext, useState, type FormEvent } from 'react';
import { ModalPortal } from '../ModalPortal';
import { PersonLockLine } from '../PersonLock';
import { PromptLockContext } from './promptLock';

export interface PromptRequest {
  label: string;
  initial: string;
  resolve: (value: string | null) => void;
}

export function PromptDialog({ request, onDone }: { request: PromptRequest; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(request.initial);
  const lock = useContext(PromptLockContext);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onDone(value);
  };
  return (
    <ModalPortal>
    {/* commons-scope: Commons' fields, focus rings and type wherever it renders (review 10, M-1). */}
    <div className="commons-prompt commons-scope" role="dialog" aria-modal="true" aria-label={request.label}>
      <form
        className="commons-prompt__card"
        onSubmit={lock ? lock.guard(submit) : submit}
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
          <button type="submit" className="commons-button commons-button--primary" {...lock?.control()}>OK</button>
        </div>
        {lock && <PersonLockLine lock={lock} place="control" />}
      </form>
    </div>
    </ModalPortal>
  );
}
