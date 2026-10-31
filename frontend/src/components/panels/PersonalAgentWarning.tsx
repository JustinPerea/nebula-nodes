import { useEffect, useRef, useState } from 'react';
import '../../styles/personal-agents.css';
import { failureMessage } from '../../lib/errorCopy';
import { clearSetterOnPromote } from '../../lib/clearsOnPromote';
import { ModalPortal } from '../ModalPortal';
import { LineText } from '../LineText';
import { PersonLockLine } from '../PersonLock';
import { usePersonLock } from '../../hooks/usePersonLock';

/** The one-time notice before Nebula starts any of the person's own agents.
 * The backend refuses to start one until this is acknowledged. */
export function PersonalAgentWarning({ agentName, onAccept, onCancel }: {
  agentName: string;
  onAccept: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // PR #204 round 10 (GM r15): the acknowledgement is the person's alone
  // (POST /api/personal-agents/acknowledge-warning: require_person).
  const lock = usePersonLock('use your agents');
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    cancelButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const accept = async () => {
    if (lock.locked) return;
    setBusy(true);
    setError(null);
    try {
      await onAccept();
    } catch (exc) {
      const line = failureMessage(exc, "Couldn't save your answer.");
      setError(line);
      clearSetterOnPromote(exc, setError, line, null); // clears-on-promote: settings.agent-warning (GM, #204 r3)
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
    <div className="personal-warning" role="dialog" aria-modal="true" aria-labelledby="personal-warning-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
        if (event.key === 'Tab') {
          const controls = card.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <div className="personal-warning__card" ref={card}>
        <h2 id="personal-warning-title" className="personal-warning__title">Before you start {agentName}</h2>
        <p className="personal-warning__lead">
          This is your own agent, running with your own setup. Nebula starts it and shows it here, but it isn&rsquo;t
          sandboxed.
        </p>
        <ul className="personal-warning__list">
          <li>It keeps its own shell, network and file access, its memory, and its own model keys and billing.</li>
          <li>
            Nebula only limits what it does through Nebula&rsquo;s tools. Those runs count against the shared budget
            for agents outside Nebula&rsquo;s chats, set in Settings &gt; Preferences.
          </li>
          <li>Approval cards appear only for what the agent chooses to ask about. Nebula can&rsquo;t ask for it.</li>
          <li>
            Anything on your canvas that you share with it can be remembered by the agent and reused in its other
            conversations and channels.
          </li>
        </ul>
        {error && <p className="personal-warning__error" role="alert"><LineText text={error} /></p>}
        <div className="personal-warning__actions">
          <button type="button" ref={cancelButton} onClick={onCancel} disabled={busy}>Not now</button>
          <button type="button" className="personal-warning__accept" onClick={() => void accept()} disabled={busy}
            {...lock.control()}>
            I understand, start it
          </button>
        </div>
        <PersonLockLine lock={lock} />
      </div>
    </div>
    </ModalPortal>
  );
}
