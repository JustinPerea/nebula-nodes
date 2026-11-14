import { DeferredAgentScreenLayer } from '../lib/deferredChunks';
import { deferredAtOnce } from './deferredAtOnce';
// The agent cursors' socket feed subscribes at import and stays in the entry
// (see canvas/DeferredCanvasOverlays.tsx): the screen layer is mounted on
// screens where the canvas never is (a Studio), so it holds presence that
// arrives before the cursor chunk here too.
import '../store/agentPresenceFeed';

/**
 * The agent cursors on every surface beside the canvas (Phase 3, "Anywhere"):
 * the Moodboard panel and Studio. One mount at the app root, on every screen
 * but Home and the brand showcase. It draws nothing until its chunk lands and
 * a cursor has a target on a surface (no first paint has one: presence
 * arrives over the socket), and App preloads the chunk on idle.
 */
export const AgentScreenLayer = deferredAtOnce(DeferredAgentScreenLayer, 'AgentScreenLayer');
