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

/** A node's box on the canvas, in flow coordinates. */
export type NodeRect = { x: number; y: number; width: number; height: number };

/** Size assumed for a node the canvas hasn't measured yet. */
export const UNMEASURED_NODE_SIZE = { width: NODE_SLOT_WIDTH, height: NODE_SLOT_HEIGHT };

/** Space kept between a placed group and the nodes already there. */
const GROUP_GAP = 40;
const GROUP_STEP = 80;
const MAX_GROUP_RING = 60;

export function boundingRect(rects: NodeRect[]): NodeRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clearOf(box: NodeRect, occupied: NodeRect[]): boolean {
  return occupied.every((rect) => (
    box.x + box.width + GROUP_GAP <= rect.x || rect.x + rect.width + GROUP_GAP <= box.x
    || box.y + box.height + GROUP_GAP <= rect.y || rect.y + rect.height + GROUP_GAP <= box.y
  ));
}

/**
 * Where to move a group of nodes (a paste from another project): the shift
 * that centres the group's bounding box on `center`, then the nearest shift
 * from there whose box is clear of every `occupied` box (with a gap),
 * preferring one that also fits inside `view` when given. When no clear spot
 * fits in the view (a zoomed-in, full view), the nearest clear one: the
 * caller brings it into view. The nodes keep their layout relative to each
 * other: callers add the returned offset to every node's position.
 */
export function findOpenGroupOffset(
  group: NodeRect[],
  occupied: NodeRect[],
  center: NodePosition,
  view?: NodeRect,
): NodePosition {
  if (group.length === 0) return { x: 0, y: 0 };
  const box = boundingRect(group);
  const start = { x: center.x - box.width / 2 - box.x, y: center.y - box.height / 2 - box.y };
  const at = (offset: NodePosition): NodeRect => ({ ...box, x: box.x + offset.x, y: box.y + offset.y });
  const inView = (offset: NodePosition) => !view || withinRect(at(offset), view);
  const clear = (offset: NodePosition) => clearOf(at(offset), occupied);
  if (clear(start) && inView(start)) return start;
  let nearestClear: NodePosition | null = clear(start) ? start : null;
  for (let ring = 1; ring <= MAX_GROUP_RING; ring += 1) {
    const candidates: NodePosition[] = [];
    for (let i = -ring; i <= ring; i += 1) {
      candidates.push({ x: i, y: -ring }, { x: i, y: ring });
      if (i !== -ring && i !== ring) candidates.push({ x: -ring, y: i }, { x: ring, y: i });
    }
    const free = candidates
      .map((step) => ({ x: start.x + step.x * GROUP_STEP, y: start.y + step.y * GROUP_STEP }))
      .filter(clear)
      .sort((a, b) => Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y));
    const visible = free.find(inView);
    if (visible) return visible;
    nearestClear ??= free[0] ?? null;
    // Once a clear spot is found, a visible one can only be further out if the
    // view is bigger than this ring; stop when the ring leaves the view.
    if (nearestClear && (!view || ring * GROUP_STEP > Math.max(view.width, view.height))) return nearestClear;
  }
  if (nearestClear) return nearestClear;
  // A canvas packed that far around the view: go right of everything.
  const all = boundingRect(occupied);
  return { x: all.x + all.width + GROUP_GAP - box.x, y: start.y };
}

function withinRect(inner: NodeRect, outer: NodeRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
