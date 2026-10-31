import { X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { useAnnounced } from '../lib/useAnnounced';
import type { ReopenHoldPlace } from '../lib/reopenHold';

/** The held-reopen line's Forget ID form, beside Run History in the rail
 * (GM r32, 2 on PR #199). The Marble forms are the World Labs notice's own
 * second line (ProviderRecoveryStatus, GM r33, 6); the Stop form is the
 * canvas notice by Stop. One polite status region, announced once per line:
 * it mounts empty and gets its text once in the page (useAnnounced). While
 * Run History is open the callout isn't there (it would cover the panel's
 * list): the panel's safeguards section shows the same line at its top
 * (review 20 LOW-1, GM r34 A4). */
export function ReopenHoldCallout({ place }: { place: Extract<ReopenHoldPlace, 'runHistory'> }) {
  const held = useProjectStore((state) => state.heldReopenLine);
  const dismiss = useProjectStore((state) => state.dismissHeldReopenLine);
  const historyOpen = useUIStore((state) => state.leftDock === 'history');
  const line = held && held.place === place && !historyOpen ? held.line : null;
  return line ? <Callout place={place} line={line} onDismiss={dismiss} /> : null;
}

function Callout({ place, line, onDismiss: dismiss }: { place: ReopenHoldPlace; line: string; onDismiss: () => void }) {
  const announced = useAnnounced(line);
  return (
    <div className={`reopen-hold-callout reopen-hold-callout--${place}`} role="status" aria-live="polite"
      data-reopen-hold-callout={place}>
      <span>{announced}</span>
      <button type="button" className="reopen-hold-callout__close" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
        <X size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}
