import { useState, type CSSProperties } from 'react';
import { springCssVars } from './springs';
import { useCanvasProposalsStore } from '../store/canvasProposalsStore';
import { useNowUntil } from '../hooks/useBefore';
import { waitFor, waitKey, waitReasonId, type NodeWait } from './nodeWait';

/** The node's wait, re-read only when its own changes (null when none), and when a hold sentence
 * in its reason ends (one timer, through useNowUntil), so the description drops it then. */
export function useNodeWait(nodeId: string): NodeWait | null {
  const [holdEnd, setHoldEnd] = useState<number | null>(null);
  const now = useNowUntil(holdEnd);
  const key = useCanvasProposalsStore((state) => waitKey(waitFor(state, nodeId, now)));
  const wait = key ? (JSON.parse(key) as NodeWait) : null;
  const next = wait?.holdEnd ?? null;
  if (next !== holdEnd) setHoldEnd(next);
  return wait;
}

/**
 * What a card's header takes while a run waits on its node: the proposal's
 * tint (CSS reads `data-waiting` and `--agent-color`) and the full reason as
 * its accessible description. The header never changes size.
 */
const SPRING_VARS = springCssVars() as CSSProperties;

export function nodeWaitHeaderProps(nodeId: string, wait: NodeWait | null): Record<string, unknown> {
  // The springs are always on the header, so its tint fades out as it fades in.
  if (!wait) return { style: SPRING_VARS };
  return {
    role: 'group',
    'data-waiting': 'true',
    'aria-describedby': waitReasonId(nodeId),
    style: { ...SPRING_VARS, ['--agent-color' as string]: wait.color } as CSSProperties,
  };
}
