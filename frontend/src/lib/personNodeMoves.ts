/**
 * Where the person last put each node themselves: a drag's drop, a keyboard
 * nudge or an Arrange (graphStore's persistNodePositions, the one place all
 * three go through). The agent cursor layer reads it: a cursor resting on a
 * node the person moves rides it at 0 px, never a flight (GM - Design, PR
 * #211 review 4, item 2). A sync, an undo or another agent's move puts the
 * node somewhere else, so it doesn't match, and a resting cursor flies there.
 *
 * In the startup entry with the graph store; a few hundred bytes.
 */
type Spot = { x: number; y: number };

/** Nodes remembered at once; past it the oldest go. */
export const PERSON_NODE_MOVES_MAX = 2_000;

const placed = new Map<string, Spot>();

export function notePersonPlaced(positions: Record<string, Spot>): void {
  for (const [id, spot] of Object.entries(positions)) {
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) continue;
    placed.delete(id);
    placed.set(id, { x: spot.x, y: spot.y });
  }
  while (placed.size > PERSON_NODE_MOVES_MAX) placed.delete(placed.keys().next().value as string);
}

/** The node is where the person last put it. */
export function placedByPerson(id: string, position: Spot | undefined): boolean {
  const spot = placed.get(id);
  return spot !== undefined && position !== undefined && spot.x === position.x && spot.y === position.y;
}

/** Forget every node (tests). */
export function forgetPersonPlaced(): void {
  placed.clear();
}
