import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { WAITING_FOR_OK } from '../../lib/canvasProposals';
import { waitDescription, waitKey, waitReasonId, type NodeWait } from '../../lib/nodeWait';
import { springCssVars, springLinear, SPRING_SOFT } from '../../lib/springs';
import '../../styles/node-wait.css';

const SPRING_VARS = springCssVars() as CSSProperties;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * The header's right side. While a run waits, "Waiting for your OK" (one
 * label for one proposal or several: the count is in the description, GM
 * - Design r3 item 1) replaces what is there (the model chip), in the same
 * box: both sit in one grid cell and crossfade on the opacity
 * spring (SOFT), so the node never changes size. The title truncates before
 * the label does. Under reduced motion it changes at once.
 *
 * The count and the reason lines are not drawn here: the bar ("1 of 2") and
 * the Updates card show them. They are the header's description for
 * assistive tech (a visually hidden line named by its aria-describedby).
 */
export function NodeWaitSwap({ nodeId, wait, children }: { nodeId: string; wait: NodeWait | null; children?: ReactNode }) {
  // The last wait, kept while the label fades out; `on` drives the opacity.
  const [held, setHeld] = useState<NodeWait | null>(wait);
  const [on, setOn] = useState(() => wait !== null && prefersReducedMotion());
  const key = waitKey(wait);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    if (wait) {
      setHeld(wait);
      if (prefersReducedMotion()) setOn(true);
    } else {
      setOn(false);
    }
  }
  useEffect(() => {
    if (key) {
      if (prefersReducedMotion()) return undefined;
      // Mounted at 0, turned on the next frame, so the opacity springs in.
      const frame = requestAnimationFrame(() => setOn(true));
      return () => cancelAnimationFrame(frame);
    }
    // Fades on SOFT, then goes (at once under reduced motion).
    const timer = setTimeout(() => setHeld(null), prefersReducedMotion() ? 0 : springLinear(SPRING_SOFT).durationMs);
    return () => clearTimeout(timer);
  }, [key]);

  const shown = wait ?? held;
  if (!shown && !children) return null;
  return (
    <span className="node-wait-swap" data-waiting={wait ? 'true' : 'false'} data-on={on ? 'true' : 'false'}
      style={{ ...SPRING_VARS, ...(shown ? { ['--agent-color' as string]: shown.color } : {}) } as CSSProperties}>
      {children && <span className="node-wait-swap__rest" inert={wait ? true : undefined}>{children}</span>}
      {shown && (
        <>
          <span className="node-wait-swap__label" role="status">
            {WAITING_FOR_OK}
          </span>
          <span id={waitReasonId(nodeId)} className="node-wait-swap__reason">{waitDescription(shown)}</span>
        </>
      )}
    </span>
  );
}
