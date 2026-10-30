import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import '../../styles/personal-agents.css';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';
import { useLockPending, useTabHeld } from '../../hooks/useTabHeld';
import { HELD_QUESTIONS_LINE } from '../../store/heldAssetProposals';

export type PermissionStatus = 'pending' | 'sent' | 'allowed' | 'denied' | 'timed_out' | 'cancelled';

export interface PermissionRequestPart {
  kind: 'permission';
  requestId: string;
  title: string;
  toolKind: string;
  input: unknown;
  canAllow: boolean;
  timeoutSeconds: number;
  receivedAt: number;
  status: PermissionStatus;
}

const OUTCOME_TEXT: Record<Exclude<PermissionStatus, 'pending' | 'sent'>, string> = {
  allowed: 'Allowed once',
  denied: 'Denied',
  timed_out: 'Denied: no answer in time',
  cancelled: 'Cancelled',
};

function formatInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    const text = JSON.stringify(input, null, 2);
    return text === '{}' ? '' : text;
  } catch {
    return String(input);
  }
}

/** A personal agent asking before it acts (ACP session/request_permission).
 * Nebula offers only "Allow once" and "Deny": an "always" choice would write a
 * rule into the agent's own config, so it's never offered. No answer denies. */
export function PermissionCard({ part, agentName, onDecision }: {
  part: PermissionRequestPart;
  agentName: string;
  onDecision: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const open = part.status === 'pending';
  // Round 16 (L5): offline Allow once is disabled; Deny stays.
  const readOnly = useBackendOffline();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);
  const left = Math.max(0, Math.ceil(part.timeoutSeconds - (now - part.receivedAt) / 1000));
  const input = formatInput(part.input);
  const settled = part.status !== 'pending' && part.status !== 'sent';
  // Review 5 MEDIUM-2 (GM r9 1): an agent's ask with a decision on it, like a question. While
  // this tab isn't connected as the person, Allow once and Deny lock in place (aria-disabled,
  // focusable, GM's line as their tooltip, the 150 ms rule) and unlock on the promote. The
  // agent's own timeout keeps running.
  const tabHeld = useTabHeld() && open;
  const lockPending = useLockPending(tabHeld);
  const lockProps = tabHeld ? {
    'aria-disabled': true as const, 'data-held-pending': lockPending ? '' : undefined,
    title: lockPending ? undefined : HELD_QUESTIONS_LINE,
  } : {};
  const decide = (decision: 'allow' | 'deny') => { if (!tabHeld) onDecision(part.requestId, decision); };
  return (
    <div className={`permission-card permission-card--${part.status}`} data-permission-status={part.status}
      role="group" aria-label={`${agentName} asks permission`}>
      <div className="permission-card__head">
        <ShieldAlert className="permission-card__icon" size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
        <span className="permission-card__who">{agentName} asks to</span>
        <span className="permission-card__kind">{part.toolKind}</span>
      </div>
      <div className="permission-card__title">{part.title}</div>
      {input && <pre className="permission-card__input">{input}</pre>}
      {!part.canAllow && open && (
        <p className="permission-card__note">
          This agent only offers &ldquo;always allow&rdquo;, which Nebula doesn&rsquo;t grant. You can deny it here.
        </p>
      )}
      {open || part.status === 'sent' ? (
        <div className="permission-card__actions">
          {part.canAllow && (
            <button type="button" className={`permission-card__allow${tabHeld ? ' agent-notes-btn--held' : ''}`} disabled={!open || readOnly}
              {...offlineMark(readOnly && open)} {...lockProps}
              onClick={() => decide('allow')}>Allow once</button>
          )}
          <button type="button" className={`permission-card__deny${tabHeld ? ' agent-notes-btn--held' : ''}`} disabled={!open}
            {...lockProps} onClick={() => decide('deny')}>Deny</button>
          <span className="permission-card__timer" aria-live="off">
            {open ? `No answer in ${left}s denies it` : 'Sending…'}
          </span>
        </div>
      ) : settled ? (
        <div className="permission-card__outcome" role="status">{OUTCOME_TEXT[part.status as keyof typeof OUTCOME_TEXT]}</div>
      ) : null}
    </div>
  );
}
