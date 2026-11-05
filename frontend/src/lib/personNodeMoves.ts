/**
 * Which node moves the person caused (GM - Design, PR #211 review 5, item 5:
 * the cause decides, not the position). The agent cursor layer reads it: a
 * cursor resting on a node the person moves (a drag's drop, a keyboard
 * nudge, an Arrange, their own undo or redo) rides it at 0 px; a move anyone
 * else caused (an agent, another tab, a sync) makes it fly, even onto the
 * person's last spot.
 *
 * Each person move is recorded with the move itself: the position object
 * that move put on the node (graphStore's persistNodePositions, the one
 * place drops, nudges and Arrange go through, and its undo and redo). React
 * Flow keeps that object on the node as it is, so the record matches only
 * while the node holds that very move. Any other move puts a new object
 * there, so it never matches, wherever it lands; no position is compared.
 * loadGraph clears the record (node ids restart with a new graph).
 *
 * In the startup entry with the graph store; a few hundred bytes.
 */
type Spot = { x: number; y: number };

/** Nodes remembered at once; past it the oldest go. */
export const PERSON_NODE_MOVES_MAX = 2_000;

const placed = new Map<string, Spot>();

/** The person moved these nodes: each to the position object given, the one
 *  now on the node. */
export function notePersonPlaced(positions: Record<string, Spot>): void {
  for (const [id, spot] of Object.entries(positions)) {
    if (!spot || typeof spot !== 'object') continue;
    placed.delete(id);
    placed.set(id, spot);
  }
  while (placed.size > PERSON_NODE_MOVES_MAX) placed.delete(placed.keys().next().value as string);
}

/** The node's position is the one a person move put there. */
export function placedByPerson(id: string, position: Spot | undefined): boolean {
  return position !== undefined && placed.get(id) === position;
}

/** Forget every node: a new graph, or tests. */
export function forgetPersonPlaced(): void {
  placed.clear();
}
