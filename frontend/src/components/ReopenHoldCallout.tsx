import { X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import type { ReopenHoldPlace } from '../lib/reopenHold';

/** The held-reopen line's World Labs forms, by the control that clears them
 * (GM r32, 2 on PR #199): the Marble forms under the World Labs notice at
 * the top, the Forget ID form beside Run History in the rail. The Stop form
 * is the canvas notice by Stop. One polite status region, announced once
 * per line. */
export function ReopenHoldCallout({ place }: { place: Exclude<ReopenHoldPlace, 'stop'> }) {
  const held = useProjectStore((state) => state.heldReopenLine);
  const dismiss = useProjectStore((state) => state.dismissHeldReopenLine);
  if (!held || held.place !== place) return null;
  return (
    <div className={`reopen-hold-callout reopen-hold-callout--${place}`} role="status" aria-live="polite"
      data-reopen-hold-callout={place}>
      <span key={held.line}>{held.line}</span>
      <button type="button" className="reopen-hold-callout__close" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
        <X size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}
