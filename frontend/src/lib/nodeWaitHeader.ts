import { type CSSProperties } from 'react';
import { springCssVars } from './springs';
import { useCanvasProposalsStore } from '../store/canvasProposalsStore';
import { waitFor, waitKey, waitReasonId, type NodeWait } from './nodeWait';

/** The node's wait, re-read only when its own changes (null when none). */
export function useNodeWait(nodeId: string): NodeWait | null {
  const key = useCanvasProposalsStore((state) => waitKey(waitFor(state, nodeId)));
  return key ? (JSON.parse(key) as NodeWait) : null;
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
