/**
 * Dev only (GM r49, ask 2): `?cursorStates=1` plays the cursor's states in
 * sequence on the real build, so GM can tune against it at 1440: look,
 * think, type, run, propose, wait and error, each held a few seconds, on
 * the first node on the canvas (else the middle of the view), then again.
 *
 * It feeds local events straight to the presence store: no backend call,
 * no provider, nothing written. `window.nebulaCursorStates.play('think')`
 * shows one state on demand; `.stop()` ends the loop.
 *
 * Never in the production build: AgentCursorLayer imports it dynamically
 * behind `import.meta.env.DEV`, and scripts/check-dev-only-code.mjs fails
 * the build if this marker reaches dist.
 */
import { useAgentPresenceStore } from '../../store/agentPresenceStore';
import { useGraphStore } from '../../store/graphStore';
import type { AgentCursorAction } from '../../lib/agentPresenceActions';

export const CURSOR_STATES_DRIVER_MARKER = 'nebula-cursor-states-driver';

const SEQUENCE: readonly AgentCursorAction[] = ['look', 'think', 'type', 'run', 'propose', 'wait', 'error'];
/** Long enough to see a gesture finish and its held frame. */
const STEP_MS = 3200;

function target() {
  const node = useGraphStore.getState().nodes[0];
  return node ? { nodeId: node.id } : { x: 0, y: 0 };
}

function play(action: AgentCursorAction): void {
  useAgentPresenceStore.getState().apply({
    type: 'agentPresence',
    agent: { id: CURSOR_STATES_DRIVER_MARKER, name: 'Claude', color: '#E8825A', verified: true },
    target: target(),
    action,
    say: '',
    at: Date.now(),
  });
}

/** Starts the loop; returns its stop. */
export function startCursorStatesDriver(): () => void {
  let step = 0;
  const next = () => {
    play(SEQUENCE[step % SEQUENCE.length]);
    step += 1;
  };
  next();
  const timer = window.setInterval(next, STEP_MS);
  const stop = () => window.clearInterval(timer);
  (window as unknown as { nebulaCursorStates?: unknown }).nebulaCursorStates = { play, stop, sequence: SEQUENCE };
  return stop;
}
