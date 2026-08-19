export type NodePosition = { x: number; y: number };

const NODE_SLOT_WIDTH = 320;
const NODE_SLOT_HEIGHT = 220;
const MAX_PLACEMENT_RING = 12;

function overlapsOccupiedSlot(candidate: NodePosition, occupied: NodePosition[]): boolean {
  return occupied.some((position) => (
    Math.abs(candidate.x - position.x) < NODE_SLOT_WIDTH
    && Math.abs(candidate.y - position.y) < NODE_SLOT_HEIGHT
  ));
}

/**
 * Return a nearby open slot for click/keyboard node insertion.
 *
 * The node library is asynchronous: several activations can arrive before the
 * backend graph-sync adds the first node. Callers therefore include both live
 * node positions and locally reserved positions in `occupied`.
 */
export function findAvailableNodePosition(
  preferred: NodePosition,
  occupied: NodePosition[],
): NodePosition {
  if (!overlapsOccupiedSlot(preferred, occupied)) return preferred;

  for (let ring = 1; ring <= MAX_PLACEMENT_RING; ring += 1) {
    const offsets: Array<[number, number]> = [
      [ring, 0],
      [0, ring],
      [-ring, 0],
      [0, -ring],
    ];

    for (let step = 1; step <= ring; step += 1) {
      offsets.push(
        [ring, step],
        [ring, -step],
        [-ring, step],
        [-ring, -step],
        [step, ring],
        [-step, ring],
        [step, -ring],
        [-step, -ring],
      );
    }

    for (const [column, row] of offsets) {
      const candidate = {
        x: preferred.x + column * NODE_SLOT_WIDTH,
        y: preferred.y + row * NODE_SLOT_HEIGHT,
      };
      if (!overlapsOccupiedSlot(candidate, occupied)) return candidate;
    }
  }

  return {
    x: preferred.x + (MAX_PLACEMENT_RING + 1) * NODE_SLOT_WIDTH,
    y: preferred.y,
  };
}
