import { useEffect, useState, type CSSProperties } from 'react';
import { WAITING_FOR_OK } from '../../lib/canvasProposals';
import { bandKey, waitBandFor, type WaitBand } from '../../lib/nodeWaitBand';
import { springCssVars, springLinear, SPRING_SOFT } from '../../lib/springs';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import '../../styles/node-wait-band.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * "Waiting for your OK" at the top of the node card, above its title, in the
 * proposal's accent, inside the node's own box, so it never covers a
 * neighbour. The node grows by the band's height while it is up and shrinks
 * back on accept or reject, on the springs (POP in, SOFT out); under reduced
 * motion it changes at once.
 */
export function NodeWaitBand({ nodeId }: { nodeId: string }) {
  const key = useCanvasProposalsStore((state) => bandKey(waitBandFor(state, nodeId)));
  const band = key ? (JSON.parse(key) as WaitBand) : null;
  // The last band, kept while it shrinks away; `open` drives the height.
  const [held, setHeld] = useState<WaitBand | null>(band);
  const [open, setOpen] = useState(() => band !== null && prefersReducedMotion());
  // A new band (or none): adjusted while rendering, not in an effect.
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    if (band) {
      setHeld(band);
      if (prefersReducedMotion()) setOpen(true);
    } else {
      setOpen(false);
    }
  }

  useEffect(() => {
    if (key) {
      if (prefersReducedMotion()) return undefined;
      // Mounted closed, opened on the next frame, so the height springs open.
      const frame = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(frame);
    }
    // Shrinks on SOFT, then goes (at once under reduced motion).
    const timer = setTimeout(() => setHeld(null), prefersReducedMotion() ? 0 : springLinear(SPRING_SOFT).durationMs);
    return () => clearTimeout(timer);
  }, [key]);

  const shown = band ?? held;
  if (!shown) return null;
  return (
    <div className="node-wait-band" data-open={open ? 'true' : 'false'} data-proposal={shown.proposalId}
      style={{ ...springCssVars(), ['--agent-color' as string]: shown.color } as CSSProperties}>
      <div className="node-wait-band__clip">
        <p className="node-wait-band__tag" role="status" aria-describedby={shown.describedBy ?? undefined}>
          <span className="node-wait-band__status">
            {shown.count > 1 ? `${WAITING_FOR_OK} · ${shown.count}` : WAITING_FOR_OK}
          </span>
          <span className="node-wait-band__line">{shown.line}</span>
        </p>
      </div>
    </div>
  );
}
