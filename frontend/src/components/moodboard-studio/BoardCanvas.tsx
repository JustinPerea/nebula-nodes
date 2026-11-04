import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MutableRefObject, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import {
  Background, BackgroundVariant, Panel, ReactFlow, ReactFlowProvider, useReactFlow, useStore, useStoreApi,
  type Node, type NodeChange, type NodeProps, type NodeTypes, type Rect, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { MoodboardImage } from '../../types';
import { CANVAS_INTERACTION_PROPS } from '../../lib/canvasNavigation';
import { springProgress, springViewport } from '../../lib/viewportSpring';
import { placeholderLabel, placeholderSpokenName, type BoardPlaceholder } from './boardPlaceholder';
import { useBoardCanvasStore, useBoardSelection, type BoardPlaced } from '../../store/boardCanvasStore';
import { BoardCardNode } from './BoardCardNode';
import { BoardFillContext, BoardWideContext, createBoardNodeBuilder, isProvisionalCard, wideFrom, type BoardFill } from './boardNodes';
import { visibleFlowCenter } from '../../lib/visibleFlowRect';
import type { NodeRect } from '../../lib/nodePlacement';
import { useBottomBarClearance } from '../../hooks/useBottomBarClearance';
import { BOTTOM_BAR_ATTR, NOTICE_BAND_ATTR } from '../../lib/bottomBar';
import type { SeenArea } from '../../lib/boardPlacement';
import { OutsideChip } from './OutsideChip';
import { offlineMark } from '../../lib/useBackendOffline';
import { offlineDisabledReason } from '../../lib/errorCopy';
import { isStudioShortcutTarget, studioKey } from './studioKeys';
import { createBoardFitFollow, sameCamera, type BoardFitFollow } from './boardFitFollow';
import { BOARD_FALLBACK_INSETS, frameInInsets, insideInsets, measureBoardViewInsets, type ViewInsets } from '../../lib/boardViewInsets';
import '../../styles/moodboard-board.css';

/** A card moved on the board: where its top-left now is, in whole board pixels. */
export interface BoardMove {
  placement: string;
  x: number;
  y: number;
}

export interface BoardCanvasProps {
  /** The board draft's key: selection and camera are kept per board. */
  boardKey: string;
  images: MoodboardImage[];
  /** One step: every card a drag (or a run of arrow keys) moved. */
  onMove: (moves: BoardMove[]) => void;
  /** Image files dropped on the board (or added with its button), and where
   *  they go (lib/boardPlacement): the point they gather around, the view
   *  they should land in, and whether it was aimed (a drop). */
  onDropFiles: (files: File[], target: BoardTarget) => void;
  /** Set by the board to where a paste goes: the last pointer position over
   *  the board, else the middle of the view, and the view at paste time
   *  (Cmd+V, Justin decided 2026-10-31). The Studio's paste reads it. */
  pasteTarget?: MutableRefObject<(() => BoardTarget) | null>;
  /** Spots held for files still uploading (GM r4 answer 1): drawn as placeholder tiles. */
  placeholders?: BoardPlaceholder[];
  /** Tiles just added outside the view: the board shows its edge chip for them. */
  outside?: OutsideTiles | null;
  /** The chip went: pressed, the tiles came into view, Esc. */
  onOutsideDone?: () => void;
  /** Filled placeholders whose image has finished fading in: the Studio drops them. */
  onPlaceholdersFilled?: (ids: string[]) => void;
  /** Nebula is offline (GM r12 2): editing is paused, so Add images is
   *  disabled with the offline reason and an empty board shows no drop hint. */
  offline?: boolean;
  /** The Studio's notice stack over the board's top (#210 round 6q, GM r95): while a line shows, the band down to
   *  its bottom is outside the view (lib/boardViewInsets), so a fit or a refit never frames a card under a line. */
  notices?: RefObject<HTMLElement | null>;
}

/** Where new tiles go: the point they gather around and the visible board, in
 *  board coordinates (null before the board has a size). `aim` is a drop. */
export interface BoardTarget {
  at: { x: number; y: number };
  view: NodeRect | null;
  /** What of the board is really seen, for the outside chip's area rule
   *  (GM r15 2, lib/boardPlacement SeenArea). Left out, the view. */
  seen?: SeenArea | null;
  aim: boolean;
  /** The view's bottom edge is the toolbar's top (lib/boardPlacement `band`). */
  band?: boolean;
}

export type { BoardPlaceholder } from './boardPlaceholder';

/** Tiles placed outside the view (GM, #210 answer 1): their rects, the first
 *  one's image for the chip's thumbnail (once uploaded), and how many. */
export interface OutsideTiles {
  id: number;
  rects: NodeRect[];
  thumb: string | null;
}

/** What a placeholder node carries: its label, and once filled, the id of the
 *  image that took its spot (focus moves on to that image's card). */
type PlaceholderData = { label: string; fillId?: string };

/** A placeholder tile (GM r5): a calm fill, a dashed edge one screen pixel
 *  wide at any zoom, and its label (the file's name) in the top-left corner.
 *  The edge is an SVG stroke whose width divides by the zoom (the CSS): a
 *  CSS border of 1px / zoom is snapped to whole pixels by Chrome before the
 *  zoom scales it, so it drew 3 px at zoom 3 and 0.75 px at 0.25, and
 *  non-scaling-stroke ignores the board's CSS scale() (live, r4). */
function BoardPlaceholderNode({ data }: NodeProps<Node<PlaceholderData, 'placeholder'>>) {
  return (
    <div className="moodboard-board__placeholder">
      <svg className="moodboard-board__placeholder-edge" aria-hidden="true" focusable="false">
        <rect className="moodboard-board__placeholder-stroke" />
      </svg>
      <span className="moodboard-board__placeholder-label">{data.label}</span>
    </div>
  );
}

const nodeTypes: NodeTypes = { card: BoardCardNode, placeholder: BoardPlaceholderNode };
const NO_PLACEHOLDERS: BoardPlaceholder[] = [];
/** Arrow keys move the selected cards in 5 px steps; they go as one move this long after the last. */
export const KEY_MOVE_SETTLE_MS = 400;
const FIT_PADDING = 0.12;
/** The view is fitted to the whole board (BoardFlow's `placed`). */
const WHOLE_BOARD: BoardPlaced = Object.freeze({ kind: 'board' });
// Low enough to fit a 300-reference board (about 2,500 x 22,000 board px) in view.
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
/** How long focus follows a tile the chip showed (its upload may still run). */
const FOLLOW_FOCUS_MS = 10_000;
/** The longest a filled image waits for its card to draw and decode before its fade starts anyway. */
export const FILL_DECODE_WAIT_MS = 1500;
/** How long focus parked on the board waits for a removed tile's card to be drawn. */
const HANDOFF_WAIT_MS = 2000;
/**
 * How far the pointer can move between press and release and still be a
 * click, not a drag: React Flow's own default for the pane, passed to it
 * explicitly so the board's click and the camera's "no move" (outsideMove)
 * are the same distance.
 */
export const PANE_CLICK_DISTANCE = 1;
// Props React Flow gets the same object for on every render: a new one (an
// inline `[]` or `{}`) would make it update its store on each pointer move.
const NO_EDGES: [] = [];
const PRO_OPTIONS = { hideAttribution: true };
// React Flow's screen-reader words, about references instead of nodes.
const ARIA_LABELS = {
  'node.a11yDescription.default':
    'Press Enter or Space to select a reference. Arrow keys move the selected references; Delete removes them.',
  'node.a11yDescription.ariaLiveMessage': ({ direction }: { direction: string; x: number; y: number }) =>
    `Moved the selected references ${direction}.`,
};

/** Runs `start` once the card `find` returns has decoded its image (or has
 *  none), or after FILL_DECODE_WAIT_MS at most (review 4, NIT-3). Returns a cancel. */
function whenDecoded(find: () => HTMLElement | null, start: () => void): () => void {
  let stopped = false;
  let frame = 0;
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    if (frame) window.cancelAnimationFrame(frame);
  };
  const go = () => {
    if (stopped) return;
    stop();
    start();
  };
  const timer = window.setTimeout(go, FILL_DECODE_WAIT_MS);
  const look = () => {
    frame = 0;
    if (stopped) return;
    const card = find();
    // Not drawn yet (React Flow draws it a commit later): look again next frame.
    if (!card) { frame = window.requestAnimationFrame(look); return; }
    const image = card.querySelector('img');
    if (!image || typeof image.decode !== 'function') { go(); return; }
    image.decode().then(go, go);
  };
  look();
  return stop;
}

/**
 * The Board view (moodboard canvas plan C1, PR5): the board's references as
 * cards on a second React Flow canvas, where the server placed them.
 *
 * It has its own ReactFlowProvider. App.tsx wraps every view in one
 * provider, so without its own the cards would land in the main canvas's
 * store. It never touches graphStore, uiStore's canvasViewport or
 * canvasZoomedOut, or publishCanvasSelection: selection and the camera live
 * in boardCanvasStore.
 *
 * A drag sends nothing while it runs: when it ends, every card it moved is
 * one `onMove`, which the Studio turns into `place` ops and one undo step.
 * Only the cards in view are rendered (300 references stay smooth).
 */
export function BoardCanvas(props: BoardCanvasProps) {
  return (
    <ReactFlowProvider>
      <BoardFlow {...props} />
    </ReactFlowProvider>
  );
}

/** The dot grid, the same on screen at any zoom (16 px apart, 1.2 px dots,
 *  as the main canvas draws at 100%): a board is mostly seen zoomed out, where
 *  React Flow's scaled dots vanish. */
function BoardDots() {
  const zoom = useStore((state) => state.transform[2]) || 1;
  return <Background variant={BackgroundVariant.Dots} gap={16 / zoom} size={1.2 / zoom} className="moodboard-board__dots"
    color="var(--mb-board-dot)" />;
}

function BoardFlow({ boardKey, images, onMove, onDropFiles, pasteTarget: pasteTargetRef,
  placeholders = NO_PLACEHOLDERS, outside = null, onOutsideDone, onPlaceholdersFilled, offline = false, notices }: BoardCanvasProps) {
  const { screenToFlowPosition, getViewport, setViewport, getNodesBounds } = useReactFlow();
  const flowStore = useStoreApi();
  const selection = useBoardSelection(boardKey);
  const setSelection = useBoardCanvasStore((state) => state.setSelection);
  const savedViewport = useRef(useBoardCanvasStore.getState().viewports[boardKey]).current;
  // Fitted (#209, GM (a)): a fresh open is, and so is a camera kept from
  // earlier in the visit that was fitted when it was kept. Either is fit at
  // once to the column the board has now, at the first size it's measured
  // at (boardFitFollow): a fitted camera kept at another column size, or with
  // cards added since, would be a stale fit. A camera the person moved opens
  // exactly as kept.
  // "The view is fitted" travels with the kept camera (#210 round 6s, GM
  // r105 2): List and back isn't a pan, so the flag comes back with it. A
  // whole-board fit reopens fitted (above); a Show's or the chip's framing
  // reopens where it was and frames its cards again if they changed while
  // the view was away (reframeOnOpen).
  const savedPlaced = useRef(savedViewport ? useBoardCanvasStore.getState().placed[boardKey] ?? null : null).current;
  const startsFitted = useRef(!savedViewport || useBoardCanvasStore.getState().fitted[boardKey] === true
    || savedPlaced?.kind === 'board').current;

  // Where cards being dragged or nudged are, until the move is sent.
  const [moving, setMoving] = useState<Record<string, { x: number; y: number }>>({});
  const movingRef = useRef(moving);
  movingRef.current = moving;
  const dragging = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // The toolbar (its panel), for the view and the framings that clear it.
  const controlsRef = useRef<HTMLDivElement>(null);
  // The zoom, as `--mb-board-zoom` on the board, so the placeholder's edge and
  // label keep their screen size (the CSS divides by it). Written on the
  // element as the zoom changes, so a zoom frame re-renders nothing.
  useLayoutEffect(() => {
    let last = 0;
    const apply = (zoom: number | undefined) => {
      const next = zoom || 1;
      if (next === last) return;
      last = next;
      wrapperRef.current?.style.setProperty('--mb-board-zoom', String(next));
    };
    apply(flowStore.getState().transform?.[2]);
    return flowStore.subscribe((state) => apply(state.transform?.[2]));
  }, [flowStore]);
  const keyTimer = useRef<number | null>(null);

  const build = useMemo(() => createBoardNodeBuilder(), []);
  const selected = useMemo(() => new Set(selection), [selection]);
  // The images now filling a held spot, by id: only their cards' nodes change
  // when a placeholder fills or goes (review 4, LOW-5).
  const fillIdsKey = placeholders.flatMap((spot) => (spot.filled ? [spot.filled.imageId] : [])).join('\n');
  const fillIds = useMemo(() => new Set(fillIdsKey ? fillIdsKey.split('\n') : []), [fillIdsKey]);
  const nodes = useMemo(() => build(images, selected, moving, fillIds), [build, images, selected, moving, fillIds]);
  // Which cards show their file rather than the thumbnail: worked out here once
  // per zoom, for every card (BoardWideContext).
  const widths = useMemo(() => [...new Set(images.flatMap((image) => (image.placements ?? []).map((card) => card.w)))]
    .sort((a, b) => a - b), [images]);
  const wide = useStore(useCallback((state: { transform: [number, number, number] }) => wideFrom(widths, state.transform[2]), [widths]));
  const nodesRef = useRef(nodes);
  // The held spots' nodes, for Fit (set where they are made, below).
  const heldNodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;
  // The placeholders, then the cards over them (a filled spot's image fades
  // in on top of its placeholder). Not selectable, not dragged. A List add
  // holds no spot and isn't drawn here.
  const held = useMemo(() => placeholders.filter((spot) => !spot.listOnly), [placeholders]);
  const shown = useMemo<Node[]>(() => (held.length === 0 ? nodes : [...held.map((spot) => ({
    id: spot.id, type: 'placeholder', position: { x: spot.x, y: spot.y }, width: spot.width, height: spot.height,
    measured: { width: spot.width, height: spot.height }, draggable: false, selectable: false, focusable: true,
    // Its spoken name says what is coming (GM r8 answer 6). It can't be
    // selected, moved or deleted, so React Flow's description of those keys
    // (aria-describedby) is dropped.
    ariaLabel: placeholderSpokenName(spot.source), domAttributes: { 'aria-describedby': undefined },
    data: { label: placeholderLabel(spot.source), fillId: spot.filled?.imageId } satisfies PlaceholderData,
  })), ...nodes]), [nodes, held]);
  heldNodesRef.current = shown.length === nodes.length ? [] : shown.slice(0, shown.length - nodes.length);
  // Images taking their spot: each fades in over its placeholder on the
  // board's spring (GM r5, corrected: a spring, not a timed fade), written
  // straight to the card's opacity per frame; reduced motion swaps at once.
  // The fade waits until the card's image has decoded (review 4, NIT-3), so
  // a slow first load never fades in an empty card; the placeholder shows
  // meanwhile. Then the placeholder goes. Keyed by the new image's id.
  const fillProgress = useRef(new Map<string, number>());
  const fill = useMemo<BoardFill>(() => ({ progress: (imageId) => fillProgress.current.get(imageId) ?? 0 }), []);
  const fades = useRef(new Map<string, () => void>());
  const filledDone = useRef(onPlaceholdersFilled);
  filledDone.current = onPlaceholdersFilled;
  useEffect(() => {
    for (const id of fillProgress.current.keys()) if (!fillIds.has(id)) fillProgress.current.delete(id);
    for (const spot of held) {
      const imageId = spot.filled?.imageId;
      if (!imageId || fades.current.has(spot.id)) continue;
      const selector = `.moodboard-card[data-fill-id="${CSS.escape(imageId)}"]`;
      const set = (progress: number) => {
        const clamped = Math.min(1, Math.max(0, progress));
        fillProgress.current.set(imageId, clamped);
        const opacity = String(clamped);
        for (const card of wrapperRef.current?.querySelectorAll<HTMLElement>(selector) ?? []) card.style.opacity = opacity;
      };
      // What stops this fill now: the wait for the image, then its spring.
      let stop = () => {};
      let finished = false;
      const finish = () => {
        finished = true;
        fades.current.delete(spot.id);
        filledDone.current?.([spot.id]);
      };
      fades.current.set(spot.id, () => stop());
      let spring: (() => void) | null = null;
      const wait = whenDecoded(() => wrapperRef.current?.querySelector<HTMLElement>(selector) ?? null, () => {
        spring = springProgress(set, finish);
      });
      stop = () => { wait(); spring?.(); };
      // Under reduced motion (or a card already decoded) it may be over already.
      if (finished) fades.current.delete(spot.id);
    }
  }, [held, fillIds]);
  useEffect(() => () => {
    for (const cancel of fades.current.values()) cancel();
    fades.current.clear();
  }, []);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // A selected card that left the board (removed here or elsewhere) is no longer selected.
  useEffect(() => {
    const current = useBoardCanvasStore.getState().selection[boardKey] ?? [];
    const present = new Set(nodes.map((node) => node.id));
    const kept = current.filter((id) => present.has(id));
    if (kept.length !== current.length) setSelection(boardKey, kept);
  }, [nodes, boardKey, setSelection]);

  /** Send the moves of `ids` (cards that ended a drag or a run of arrow keys) as one step. */
  const commit = useCallback((ids: string[]) => {
    const at = movingRef.current;
    const cards = new Map(imagesRef.current.flatMap((image) => (image.placements ?? []).map((card) => [card.id, card] as const)));
    const moves: BoardMove[] = [];
    for (const id of ids) {
      const to = at[id];
      const card = cards.get(id);
      if (!to || !card) continue;
      const x = Math.round(to.x) || 0;
      const y = Math.round(to.y) || 0;
      if (x !== card.x || y !== card.y) moves.push({ placement: id, x, y });
    }
    if (moves.length) onMoveRef.current(moves);
    setMoving((previous) => {
      const next = { ...previous };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);

  const settleKeys = useCallback(() => {
    if (keyTimer.current !== null) window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => {
      keyTimer.current = null;
      if (!dragging.current) commit(Object.keys(movingRef.current));
    }, KEY_MOVE_SETTLE_MS);
  }, [commit]);

  // Arrow-key moves still waiting when the view closes go now.
  useEffect(() => () => {
    if (keyTimer.current === null) return;
    window.clearTimeout(keyTimer.current);
    keyTimer.current = null;
    commit(Object.keys(movingRef.current));
  }, [commit]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let moved: Record<string, { x: number; y: number }> | null = null;
    let byKeys = false;
    let pick: Set<string> | null = null;
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        moved = { ...(moved ?? {}), [change.id]: { x: change.position.x, y: change.position.y } };
        if (change.dragging) dragging.current = true;
        else if (!dragging.current) byKeys = true;
      } else if (change.type === 'select') {
        pick ??= new Set(useBoardCanvasStore.getState().selection[boardKey] ?? []);
        if (change.selected) pick.add(change.id);
        else pick.delete(change.id);
      }
    }
    if (moved) {
      const update = moved;
      setMoving((previous) => ({ ...previous, ...update }));
    }
    if (pick) {
      const chosen = pick;
      setSelection(boardKey, nodesRef.current.filter((node) => chosen.has(node.id)).map((node) => node.id));
    }
    if (byKeys) settleKeys();
  }, [boardKey, setSelection, settleKeys]);

  const endDrag = useCallback((dragged: Node[]) => {
    dragging.current = false;
    commit(dragged.map((node) => node.id));
  }, [commit]);
  const onNodeDragStop = useCallback((_event: unknown, _node: Node, dragged: Node[]) => endDrag(dragged), [endDrag]);
  const onSelectionDragStop = useCallback((_event: unknown, dragged: Node[]) => endDrag(dragged), [endDrag]);

  // One camera spring at a time: a new move stops the one still running.
  const stopSpring = useRef<(() => void) | null>(null);
  // Where the running spring is going (null when none is): the store already
  // holds it, so React Flow's move end for a frame on the way (it can fire
  // 150 ms later, after the view has closed) doesn't keep a camera mid-spring.
  const springTarget = useRef<Viewport | null>(null);
  // True while this view moves the camera itself: React Flow calls the move
  // callbacks inside setViewport, and that move is the camera's own.
  const ownMove = useRef(false);
  /** The camera as React Flow holds it now. */
  const readCamera = useCallback((): Viewport => {
    const [x, y, zoom] = flowStore.getState().transform;
    return { x, y, zoom };
  }, [flowStore]);
  // The camera as this view last saw it: where its own move left it, or
  // where the last outside move did. A move callback with the camera still
  // there moved nothing (#209 review 4 LOW-1: a right or middle press, or
  // Space+click, with no drag, reaches onMoveStart before any pan).
  const seen = useRef<Viewport | null>(null);
  // An outside move's camera not kept yet: a pan or pinch keeps its camera
  // once, when it ends, not on every frame (#209 review 4 NIT-3).
  const unkept = useRef(false);
  const moveCamera = useCallback((viewport: Viewport) => {
    ownMove.current = true;
    try {
      void setViewport(viewport);
    } finally {
      ownMove.current = false;
      seen.current = readCamera();
    }
  }, [setViewport, readCamera]);
  // The view insets (lib/boardViewInsets, GM #213 round 3): the control
  // bar's band is outside, so a fit or a Show frames its cards above it, and
  // so is the notice stack's band while a line shows (#210 round 6q, GM r95),
  // measured when the fit is made. The last measured insets are kept for
  // when there is no layout to measure (the view closing).
  const noticesRef = useRef(notices);
  noticesRef.current = notices;
  const insetsRef = useRef<ViewInsets | null>(null);
  const viewInsets = useCallback((): ViewInsets => {
    const measured = measureBoardViewInsets(wrapperRef.current, controlsRef.current, noticesRef.current?.current);
    if (measured) insetsRef.current = measured;
    return insetsRef.current ?? BOARD_FALLBACK_INSETS;
  }, []);
  /** The camera that frames `bounds` in a `width` x `height` column, inside the view insets. */
  const frame = useCallback((bounds: Rect, width: number, height: number): Viewport =>
    frameInInsets(bounds, width, height, viewInsets(), { minZoom: MIN_ZOOM, maxZoom: 1, padding: FIT_PADDING }), [viewInsets]);
  /**
   * The whole-board fit in a column this size: the one fit computation, for
   * Fit, the fit on open and the follower alike. Held spots count, as cards
   * on their way in (GM r8 answer 4; GM r11 2: a Fit with a held spot is a
   * fit, and follows its column). Null only when there are no cards and no
   * held spots.
   */
  const fitFor = useCallback((width: number, height: number): Viewport | null => {
    const all = [...nodesRef.current, ...heldNodesRef.current];
    return all.length === 0 ? null : frame(getNodesBounds(all), width, height);
  }, [frame, getNodesBounds]);
  const fitForRef = useRef(fitFor);
  fitForRef.current = fitFor;
  // A whole-board fit's refit while its column resizes (#209): `follow` knows
  // whether the camera is on the fit, by comparing it.
  const fitRef = useRef<(instant: boolean) => boolean>(() => false);
  const follow = useRef<BoardFitFollow | null>(null);
  follow.current ??= createBoardFitFollow({
    fitted: startsFitted,
    camera: readCamera,
    fitFor: (width, height) => fitForRef.current(width, height),
    refit: (instant) => fitRef.current(instant),
  });
  // The view is fitted (#210 round 6r, GM r101): the camera is where the app
  // last framed it: a fit (Fit, Shift+1, the fit on open, a refit) frames the
  // whole board (`kind: 'board'`), an Update's Show the cards it names. Only
  // the person clears it, by moving the camera (a pan, a pinch, a wheel, the
  // zoom buttons, a keyboard zoom); a refit or an
  // agent's change to the board doesn't. While it is set, a notice line
  // appearing or going frames the same cards again in the new view insets
  // (followNotices); once cleared, a line never moves the camera (#213 r3).
  // The outside chip's press counts as a Show (round 6s, GM r105 1): it sets
  // the flag for the area of the tiles it brings into view. The flag is kept
  // with the camera for the visit (the store's `placed`), so it comes back
  // with the camera from List (savedPlaced).
  const placed = useRef<BoardPlaced | null>(savedPlaced);
  const place = useCallback((value: BoardPlaced | null) => {
    placed.current = value;
    useBoardCanvasStore.getState().setPlaced(boardKey, value);
  }, [boardKey]);
  /**
   * Spring the camera to `to`. A spring that lands on the fit is a fit (GM,
   * #213 round 3: Fit, a refit, or a zoom or Show that lands there), so a
   * resize while it runs refits it as it would a Fit.
   */
  const springTo = useCallback((to: Viewport) => {
    const fitted = follow.current!.onFit(to);
    if (fitted) follow.current!.headingToFit();
    else follow.current!.aside();
    // A new move takes over from the one still running (a refit while the
    // window is dragged starts from where the last one had got to).
    stopSpring.current?.();
    springTarget.current = to;
    stopSpring.current = springViewport(getViewport(), to, (viewport) => {
      moveCamera(viewport);
      if (viewport !== to) return;
      // The last frame (viewportSpring applies `to` itself): the spring has landed.
      springTarget.current = null;
      follow.current!.springEnded();
    });
    // Where the camera lands is kept for the visit, as a pan or scroll is,
    // fitted when it lands on the fit (zoom in, then back out).
    useBoardCanvasStore.getState().setViewport(boardKey, to, fitted);
  }, [getViewport, moveCamera, boardKey]);
  useEffect(() => () => {
    stopSpring.current?.();
    follow.current?.dispose();
  }, []);

  // The camera, kept for the visit with whether it is still fitted, read
  // from the camera itself (a move's own viewport can be a spring frame
  // React Flow reports 150 ms late). While a spring runs, the store holds
  // where it lands (springTo). Once the view has closed, React Flow's store
  // holds its reset camera (0, 0, 1), so a late move end keeps nothing
  // (#213 review 1 MEDIUM-1).
  const closed = useRef(false);
  const keepCamera = useCallback(() => {
    unkept.current = false;
    if (springTarget.current || closed.current) return;
    useBoardCanvasStore.getState().setViewport(boardKey, getViewport(), follow.current!.fitted);
  }, [boardKey, getViewport]);
  /** The camera that frames what `at` names again in a column this size: the
   *  whole board, a Show's cards (those still on the board), or the chip's
   *  area. Null when there is nothing to frame. */
  const framePlaced = useCallback((at: BoardPlaced, width: number, height: number): Viewport | null => {
    if (at.kind === 'board') return fitFor(width, height);
    if (at.kind === 'area') return frame(at.bounds, width, height);
    const wanted = new Set(at.ids);
    const targets = nodesRef.current.filter((node) => wanted.has(node.id));
    return targets.length === 0 ? null : frame(getNodesBounds(targets), width, height);
  }, [fitFor, frame, getNodesBounds]);
  /** Fit the whole board to its column: on the spring, or at once (on open). False when there is nothing to fit. */
  const fit = useCallback((instant = false) => {
    const { width, height, panZoom } = flowStore.getState();
    if (!width || !height) return false;
    // React Flow can measure the board before its camera exists; the fit on
    // open waits for it (it can't move a camera that isn't there yet).
    if (instant && !panZoom) return false;
    const to = fitFor(width, height);
    if (!to) return false;
    // The fit on open of a camera kept from earlier in the visit keeps the
    // flag it was kept with (GM r105 2): the fit doesn't make it the app's.
    if (!instant || !savedViewport) place(WHOLE_BOARD);
    if (!instant) {
      springTo(to);
      return true;
    }
    // Only on open (the first size), before any spring has run.
    moveCamera(to);
    useBoardCanvasStore.getState().setViewport(boardKey, to, true);
    return true;
  }, [flowStore, fitFor, springTo, moveCamera, boardKey, place, savedViewport]);
  fitRef.current = fit;
  // Cards that arrive after the board mounts (it opens before they load) get
  // the fit on open once there are some.
  const hasCards = nodes.length > 0;
  // A camera a Show or the chip framed, kept from earlier in the visit (GM
  // r105 2), opens where it was kept; if what it framed changed while the
  // view was away (a card moved, the notice band changed), it is framed again
  // at once, as a whole-board fit is on open. Once, when the view has its
  // size, its camera and its cards; a move the person makes first clears
  // the flag, so there is nothing to frame.
  const reframePending = useRef(savedPlaced !== null && savedPlaced.kind !== 'board' && !startsFitted);
  const reframeOnOpen = useCallback(() => {
    const at = placed.current;
    if (!reframePending.current || !at) return;
    const { width, height, panZoom } = flowStore.getState();
    if (!width || !height || !panZoom) return;
    if (at.kind === 'cards' && nodesRef.current.length === 0) return;
    reframePending.current = false;
    const to = framePlaced(at, width, height);
    if (!to || sameCamera(readCamera(), to)) return;
    moveCamera(to);
    useBoardCanvasStore.getState().setViewport(boardKey, to, follow.current!.onFit(to));
  }, [flowStore, framePlaced, readCamera, moveCamera, boardKey]);
  const reframeOnOpenRef = useRef(reframeOnOpen);
  reframeOnOpenRef.current = reframeOnOpen;
  useEffect(() => {
    if (!hasCards) return;
    follow.current!.ready();
    reframeOnOpenRef.current();
  }, [hasCards]);

  // React Flow's camera (its d3 pan-zoom). It can make it again, at its
  // default viewport, while this view stays mounted: React runs effects twice
  // in development (StrictMode), and React Flow makes its camera in one. The
  // camera kept for the visit is put back then, as on reopening.
  const knownCamera = useRef<unknown>(null);
  const cameraMade = useCallback((panZoom: unknown) => {
    if (!panZoom || panZoom === knownCamera.current) return;
    const again = knownCamera.current !== null;
    knownCamera.current = panZoom;
    if (!again) {
      seen.current = readCamera();
      follow.current!.ready();
      reframeOnOpenRef.current();
      return;
    }
    stopSpring.current?.();
    stopSpring.current = null;
    springTarget.current = null;
    // A move the person made that isn't kept yet is the camera to put back
    // (the store still holds the one before it).
    const moved = unkept.current ? seen.current : null;
    seen.current = readCamera();
    if (moved) {
      moveCamera(moved);
      keepCamera();
      return;
    }
    const { viewports, fitted } = useBoardCanvasStore.getState();
    const kept = viewports[boardKey];
    if (!kept || fitted[boardKey]) follow.current!.reopen();
    else moveCamera(kept);
  }, [boardKey, moveCamera, readCamera, keepCamera]);

  // The column React Flow measures (its own ResizeObserver on the board):
  // a new size refits while the board is fitted (boardFitFollow).
  useEffect(() => {
    const at = flowStore.getState();
    cameraMade(at.panZoom);
    follow.current!.resize(at.width, at.height);
    return flowStore.subscribe((state, previous) => {
      if (state.panZoom !== previous.panZoom) cameraMade(state.panZoom);
      if (state.width !== previous.width || state.height !== previous.height) {
        follow.current!.resize(state.width, state.height);
        reframeOnOpenRef.current();
      }
    });
  }, [flowStore, cameraMade]);

  // An Update's Show (Q113 c): spring the camera to the cards it names, once
  // the view has its size (a Show from List mounts this view first).
  const frameRequest = useBoardCanvasStore((state) => state.frameRequest);
  useEffect(() => {
    if (!frameRequest || frameRequest.boardKey !== boardKey) return;
    let request = 0;
    let tries = 0;
    const attempt = () => {
      request = 0;
      const { width, height } = flowStore.getState();
      if ((!width || !height) && tries++ < 60) {
        request = window.requestAnimationFrame(attempt);
        return;
      }
      if (useBoardCanvasStore.getState().frameRequest?.seq === frameRequest.seq) {
        useBoardCanvasStore.setState({ frameRequest: null });
      }
      const wanted = new Set(frameRequest.placementIds);
      const targets = nodesRef.current.filter((node) => wanted.has(node.id));
      if (!width || !height || targets.length === 0) return;
      place({ kind: 'cards', ids: targets.map((node) => node.id) });
      springTo(frame(getNodesBounds(targets), width, height));
    };
    request = window.requestAnimationFrame(attempt);
    return () => { if (request) window.cancelAnimationFrame(request); };
  }, [frameRequest, boardKey, flowStore, getNodesBounds, springTo, frame, place]);

  const zoomBy = useCallback((factor: number) => {
    const { width, height } = flowStore.getState();
    const from = getViewport();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, from.zoom * factor));
    // Keep the centre of the view where it is.
    const cx = width / 2;
    const cy = height / 2;
    place(null);
    springTo({ zoom, x: cx - ((cx - from.x) / from.zoom) * zoom, y: cy - ((cy - from.y) / from.zoom) * zoom });
  }, [flowStore, getViewport, springTo, place]);

  // A notice line appearing or going while the view is fitted (#210 round
  // 6r, GM r101): the same cards are framed again in the new view insets, on
  // the board's spring (a jump under reduced motion), so the line never
  // covers a card the app placed. Its band is read from the stack each time
  // the stack changes size (a line comes, goes, or wraps to more rows).
  const followNotices = useCallback(() => {
    const at = placed.current;
    if (!at || closed.current) return;
    if (at.kind === 'board') {
      fit(false);
      return;
    }
    const { width, height } = flowStore.getState();
    const to = width && height ? framePlaced(at, width, height) : null;
    if (to) springTo(to);
  }, [fit, flowStore, springTo, framePlaced]);
  const followNoticesRef = useRef(followNotices);
  followNoticesRef.current = followNotices;
  useEffect(() => {
    const stack = notices?.current;
    if (!stack || typeof ResizeObserver !== 'function') return;
    let band = viewInsets().top;
    const observer = new ResizeObserver(() => {
      const now = viewInsets().top;
      if (now === band) return;
      band = now;
      followNoticesRef.current();
    });
    observer.observe(stack);
    return () => observer.disconnect();
  }, [notices, viewInsets]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || studioKey(event) !== 'fit' || !isStudioShortcutTarget(event.target)) return;
      event.preventDefault();
      fit(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fit]);

  // Any camera move this view didn't make takes the camera from a spring
  // still running, so the spring can't undo it: a person's pan, pinch or
  // wheel, and the moves React Flow makes for them with no source event (the
  // autopan while a card is dragged to the edge, the pan to a card focused
  // from the keyboard). It's caught at onMove as well as onMoveStart: after a
  // single mouse-wheel notch, React Flow's pan-on-scroll stops calling
  // onMoveStart (@xyflow/system 0.0.76). Whether the board is still fitted is
  // read from the camera (boardFitFollow), not from these calls.
  //
  // A move is one only when the camera changed (#209 review 4 LOW-1, GM): a
  // right or middle press, or Space+click, reaches onMoveStart on the press,
  // before any pan, and a press with no drag moves nothing, so a refit
  // carries on to the fit. React Flow applies a move to its store before it
  // calls back (the d3 zoom event; pan-on-scroll's first event too).
  //
  // The camera is kept for the visit once a gesture: at onMoveStart (one
  // mouse-wheel notch reports nothing else, ever) and at onMoveEnd, not on
  // each onMove frame. Only this view reads the kept camera, when it mounts
  // and when React Flow makes its camera again (cameraMade): a gesture still
  // unkept then, or when the view closes, is kept from `seen`.
  //
  // A press that hasn't gone past the click distance is a click, not a drag
  // (#213 review 1 LOW-1, GM: the board's own click distance): d3 puts the
  // pressed board point back under the pointer on every mousemove, even a
  // 1 px jitter, and while a refit spring runs that moves the camera back
  // toward where it was at the press. That isn't the person's move: the
  // camera goes straight back to where this view had it (before the frame
  // paints), and a refit carries on to the fit.
  const press = useRef<{ x: number; y: number; far: boolean } | null>(null);
  const outsideMove = useCallback((keep: boolean, event?: unknown) => {
    if (ownMove.current || closed.current) return;
    const now = readCamera();
    const was = seen.current;
    if (was && was.x === now.x && was.y === now.y && was.zoom === now.zoom) return;
    const held = press.current;
    if (held && !held.far && was && event instanceof MouseEvent && event.type === 'mousemove') {
      const dx = event.clientX - held.x;
      const dy = event.clientY - held.y;
      if (dx * dx + dy * dy <= PANE_CLICK_DISTANCE * PANE_CLICK_DISTANCE) {
        moveCamera(was);
        return;
      }
      held.far = true;
    }
    seen.current = now;
    stopSpring.current?.();
    stopSpring.current = null;
    springTarget.current = null;
    place(null);
    follow.current!.taken();
    if (keep) keepCamera();
    else unkept.current = true;
  }, [readCamera, keepCamera, moveCamera, place]);
  const onCameraMoveStart = useCallback((event: unknown) => {
    // d3 starts a drag gesture on the press (a right or middle button, or
    // the left with Space held); the camera's own moves start none.
    if (!ownMove.current) {
      press.current = event instanceof MouseEvent && event.type === 'mousedown'
        ? { x: event.clientX, y: event.clientY, far: false } : null;
    }
    outsideMove(true, event);
  }, [outsideMove]);
  const onCameraMove = useCallback((event: unknown) => outsideMove(false, event), [outsideMove]);
  // Only a move end the person made (d3's end carries their mouseup or
  // wheel) ends a press (GM r5). React Flow also ends a gesture on a 150 ms
  // timer, with no source event, after the camera's own moves (each spring
  // frame is one), and that timer can fire while a press is still held: it
  // keeps the camera, but the press goes on.
  const onCameraMoveEnd = useCallback((event: unknown) => {
    if (event) press.current = null;
    keepCamera();
  }, [keepCamera]);
  // The view closes (List, another board, another screen). A gesture's
  // camera not kept yet (React Flow's move end comes 150 ms after a scroll
  // pan, and a drag's at its release) is kept now, from `seen`: this runs as
  // a layout cleanup, before React Flow's own (its StoreUpdater, a child)
  // resets its store to the camera (0, 0, 1) (#213 review 1 MEDIUM-1). The
  // spring stops here too, so no frame moves a camera React Flow has reset.
  // From here on nothing is kept (`closed`): React Flow's late move end
  // would read the reset camera.
  useLayoutEffect(() => {
    closed.current = false;
    return () => {
      stopSpring.current?.();
      stopSpring.current = null;
      if (unkept.current && !springTarget.current && seen.current) {
        useBoardCanvasStore.getState().setViewport(boardKey, seen.current, follow.current!.onFit(seen.current));
      }
      unkept.current = false;
      closed.current = true;
    };
  }, [boardKey]);

  /** The middle of the view, or right of the cards before the board has a size. */
  const viewPoint = () => {
    const at = visibleFlowCenter(wrapperRef.current, screenToFlowPosition);
    if (at) return at;
    // No size yet: to the right of the cards.
    const cards = nodesRef.current;
    const right = cards.reduce((edge, node) => Math.max(edge, node.position.x + (node.width ?? 0)), 0);
    return { x: right + 280, y: cards.length ? Math.min(...cards.map((node) => node.position.y)) + 135 : 0 };
  };

  // The toolbar is the board's bottom bar: the app's notices stack above it
  // (lib/bottomBar.ts, GM #210 item 6), and new tiles land above it.
  useBottomBarClearance([controlsRef]);

  /** The board the person can see, in board coordinates, inside the view
   *  insets (lib/boardViewInsets, #213: the toolbar's band is outside), so a
   *  tile placed in it is fully visible. Fit, an Update's Show and the
   *  chip's press frame into the same view (`frame`). */
  const viewRect = (): NodeRect | null => {
    const box = wrapperRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const inside = insideInsets(box.width, box.height, viewInsets());
    const topLeft = screenToFlowPosition({ x: box.left + inside.x, y: box.top + inside.y });
    const bottomRight = screenToFlowPosition({ x: box.left + inside.x + inside.width, y: box.top + inside.y + inside.height });
    if (bottomRight.x <= topLeft.x || bottomRight.y <= topLeft.y) return null;
    return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
  };

  /**
   * What of the board the person really sees (GM r15 2), in board
   * coordinates: the board's pane clipped to the window, less the boxes that
   * cover it there, each as it really is: the toolbar pill (every
   * `data-bottom-bar` box), the notice region's reserved band across its own
   * width, and the notices on screen now (the app's stack and the Studio's
   * lines). Not placement's view: a tile beside the pill, below the
   * toolbar's line, is seen. Placement keeps its own view and band.
   */
  const seenArea = (): SeenArea | null => {
    const box = wrapperRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const toBoard = (rect: { left: number; top: number; right: number; bottom: number }): NodeRect | null => {
      const left = Math.max(rect.left, box.left, 0);
      const top = Math.max(rect.top, box.top, 0);
      const right = Math.min(rect.right, box.right, window.innerWidth);
      const bottom = Math.min(rect.bottom, box.bottom, window.innerHeight);
      if (right <= left || bottom <= top) return null;
      const a = screenToFlowPosition({ x: left, y: top });
      const b = screenToFlowPosition({ x: right, y: bottom });
      return b.x > a.x && b.y > a.y ? { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y } : null;
    };
    const view = toBoard(box);
    if (!view) return null;
    const covering = [
      ...document.querySelectorAll<HTMLElement>(`[${BOTTOM_BAR_ATTR}]`),
      ...document.querySelectorAll<HTMLElement>(`[${NOTICE_BAND_ATTR}]`),
      ...document.querySelectorAll<HTMLElement>('.notice-region__stack > *, .moodboard-studio__notice'),
    ];
    const covers = covering.map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .flatMap((rect) => toBoard(rect) ?? []);
    return { view, covers };
  };

  const addFiles = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    onDropFiles(files, { at: viewPoint(), view: viewRect(), seen: seenArea(), aim: false });
  };

  // The pointer over the board, in screen pixels (null once it leaves): a
  // paste lands there, read through screenToFlowPosition at paste time so a
  // pan or zoom since is counted.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointer.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerLeave = () => { pointer.current = null; };
  const pasteAt = useRef<() => BoardTarget>(() => ({ at: { x: 0, y: 0 }, view: null, aim: false }));
  pasteAt.current = () => ({ at: pointer.current ? screenToFlowPosition(pointer.current) : viewPoint(),
    view: viewRect(), seen: seenArea(), aim: false });
  useEffect(() => {
    if (!pasteTargetRef) return undefined;
    const read = () => pasteAt.current();
    pasteTargetRef.current = read;
    return () => { if (pasteTargetRef.current === read) pasteTargetRef.current = null; };
  }, [pasteTargetRef]);

  /** Focus on the board itself (GM r4 answer 6: never the page body). */
  // The board takes focus; if it can't (hidden, or with no size), the view
  // switch does, so focus never falls to the page body (review 5, NIT-6).
  const focusBoard = useCallback(() => {
    wrapperRef.current?.focus({ preventScroll: true });
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>('.moodboard-view-switch__option[aria-checked="true"]')?.focus({ preventScroll: true });
  }, []);

  // After a chip press from the keyboard, focus follows the first pasted
  // tile (GM r4 answer 6): onto it once it is drawn in view, and onto it
  // again when its placeholder becomes the card (a new element). Only while
  // focus would otherwise be on the board or nowhere, and for a short while.
  const focusFollow = useRef<{ x: number; y: number; until: number } | null>(null);
  const focusFollowed = useCallback(() => {
    const spot = focusFollow.current;
    if (!spot || Date.now() > spot.until) {
      focusFollow.current = null;
      return true;
    }
    const active = document.activeElement;
    if (active && active !== document.body && active !== wrapperRef.current) return true;
    // The card at the spot before its placeholder (both sit there while it fades in, review 4 NIT-2).
    const there = shownRef.current.filter((item) => item.position.x === spot.x && item.position.y === spot.y);
    const node = there.find((item) => item.type === 'card') ?? there[0];
    const element = node ? wrapperRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${node.id}"]`) : null;
    if (!element) return false;
    element.focus({ preventScroll: true });
    return true;
  }, []);
  useEffect(() => { focusFollowed(); }, [shown, focusFollowed]);
  useEffect(() => () => { focusFollow.current = null; }, []);

  // Focus on a tile that is being replaced moves on to what replaces it
  // (review 4, HIGH-1 and MEDIUM-2; GM: never the page body, never pulled
  // from elsewhere): a placeholder its image has filled hands focus to that
  // image's card as soon as the card is drawn, however long the upload took;
  // a provisional card hands it to its saved card. React Flow adds and drops
  // node elements a commit after the board's own effects, so this runs on
  // every change of the board's DOM (a MutationObserver, before paint), not
  // only in an effect. If the focused tile's element goes first, focus is
  // parked on the board (never the body) and moves on when the card comes.
  // Focus anywhere else is left where the person put it.
  const focused = useRef<{ element: HTMLElement; imageId: string | null } | null>(null);
  const parked = useRef<{ imageId: string; until: number } | null>(null);
  const handOff = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const nodes = shownRef.current;
    /** What a tile stands for: a filled placeholder's image, or a card's. */
    const imageOf = (id: string | null) => {
      const node = id ? nodes.find((item) => item.id === id) : undefined;
      if (!node) return undefined;
      return node.type === 'placeholder' ? (node.data as PlaceholderData).fillId ?? null : (node.data as { imageId: string }).imageId;
    };
    /** The drawn card for `imageId`, other than `not`: a saved one before a provisional one. */
    const cardFor = (imageId: string, not: string | null) => {
      const cards = nodes.filter((item) => item.type === 'card' && item.id !== not && (item.data as { imageId: string }).imageId === imageId);
      for (const card of [...cards.filter((item) => !isProvisionalCard(item.id)), ...cards]) {
        const element = wrapper.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(card.id)}"]`);
        if (element) return element;
      }
      return null;
    };
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== wrapper && wrapper.contains(active) && active.classList.contains('react-flow__node')) {
      parked.current = null;
      const id = active.getAttribute('data-id');
      const node = id ? nodes.find((item) => item.id === id) : undefined;
      const known = imageOf(id);
      const imageId = known === undefined ? (focused.current?.element === active ? focused.current.imageId : null) : known;
      focused.current = { element: active, imageId };
      // A saved card that is still on the board stays: it is what the person focused.
      if (!imageId || (node?.type === 'card' && !isProvisionalCard(node.id))) return;
      const next = cardFor(imageId, id);
      if (next) next.focus({ preventScroll: true });
      return;
    }
    if (active === null || active === document.body) {
      const gone = focused.current;
      focused.current = null;
      // Only a tile that left the page: a click on nothing leaves it connected, and focus where the person put it.
      if (!gone || gone.element.isConnected) return;
      // Its image as the board has it now: a placeholder filled in the commit that dropped its element counts.
      const goneImage = gone.imageId ?? imageOf(gone.element.getAttribute('data-id')) ?? null;
      const next = goneImage ? cardFor(goneImage, null) : null;
      if (next) { next.focus({ preventScroll: true }); return; }
      wrapper.focus({ preventScroll: true });
      if (goneImage) parked.current = { imageId: goneImage, until: Date.now() + HANDOFF_WAIT_MS };
      return;
    }
    if (active === wrapper && parked.current) {
      if (Date.now() > parked.current.until) { parked.current = null; return; }
      const next = cardFor(parked.current.imageId, null);
      if (next) { parked.current = null; next.focus({ preventScroll: true }); }
      return;
    }
    // Focus went somewhere else on its own: nothing to follow.
    focused.current = null;
    parked.current = null;
  }, []);
  useLayoutEffect(() => { handOff(); }, [shown, handOff]);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => handOff()) : null;
    observer?.observe(wrapper, { childList: true, subtree: true });
    const onFocusIn = () => handOff();
    // Backstop: a focused element dropped with no successor yet drops focus
    // to nowhere (relatedTarget null); look again on the next frames.
    let frames = 0;
    let frame = 0;
    const retry = () => {
      frame = 0;
      handOff();
      if (frames++ < 30 && (parked.current || document.activeElement === document.body)) frame = window.requestAnimationFrame(retry);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget !== null) return;
      frames = 0;
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(retry);
    };
    wrapper.addEventListener('focusin', onFocusIn);
    wrapper.addEventListener('focusout', onFocusOut);
    return () => {
      observer?.disconnect();
      wrapper.removeEventListener('focusin', onFocusIn);
      wrapper.removeEventListener('focusout', onFocusOut);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [handOff]);

  /** The chip's press: the tiles into view on the board's fit spring (for a
   *  tile bigger than the view, a zoom out until it is whole, GM r4 answer
   *  9). It is a Show (round 6s, GM r105 1): the view is fitted to the
   *  tiles' area, so a line then frames them again, clear of it. With
   *  `focus`, focus goes to the first tile. */
  const showOutside = useCallback((rects: NodeRect[], focus: boolean) => {
    const { width, height } = flowStore.getState();
    if (!width || !height || rects.length === 0) return;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const bounds = { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x,
      height: Math.max(...rects.map((r) => r.y + r.height)) - y };
    place({ kind: 'area', bounds });
    springTo(frame(bounds, width, height));
    if (!focus) return;
    // The board holds focus until the tile is drawn (it is culled until in view).
    focusBoard();
    focusFollow.current = { x: rects[0].x, y: rects[0].y, until: Date.now() + FOLLOW_FOCUS_MS };
    let frames = 0;
    const tick = () => {
      if (focusFollowed() || frames++ > 120) return;
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }, [flowStore, springTo, focusBoard, focusFollowed, frame, place]);

  const [dropping, setDropping] = useState(false);
  const carriesFiles = (event: ReactDragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
    setDropping(false);
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    setDropping(false);
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (!carriesFiles(event) && files.length === 0) return;
    event.preventDefault();
    if (files.length === 0) return;
    const bar = controlsRef.current?.getBoundingClientRect();
    onDropFiles(files, { at: screenToFlowPosition({ x: event.clientX, y: event.clientY }), view: viewRect(), seen: seenArea(), aim: true,
      band: Boolean(bar && bar.height > 0) });
  };

  return (
    <div ref={wrapperRef} className={`moodboard-board${dropping ? ' moodboard-board--drop' : ''}`} tabIndex={-1}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
      {/* Behind the cards, for the reader's ripple while Analyze runs (PR10b). */}
      <div className="moodboard-board__underlay" aria-hidden="true" data-layer="ripple" />
      <BoardFillContext.Provider value={fill}>
      <BoardWideContext.Provider value={wide}>
        <ReactFlow
          className="moodboard-board__flow"
          nodes={shown}
          edges={NO_EDGES}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={onSelectionDragStop}
          onMoveStart={onCameraMoveStart}
          onMove={onCameraMove}
          onMoveEnd={onCameraMoveEnd}
          paneClickDistance={PANE_CLICK_DISTANCE}
          defaultViewport={startsFitted ? undefined : savedViewport}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          deleteKeyCode={null}
          nodesConnectable={false}
          proOptions={PRO_OPTIONS}
          {...CANVAS_INTERACTION_PROPS}
          onlyRenderVisibleElements
          ariaLabelConfig={ARIA_LABELS}
        >
          <BoardDots />
          <Panel ref={controlsRef} position="bottom-left" className="moodboard-board__controls" {...{ [BOTTOM_BAR_ATTR]: '' }}>
            <button type="button" className="moodboard-board__control" onClick={() => zoomBy(1 / ZOOM_STEP)}
              aria-label="Zoom out" title="Zoom out">−</button>
            <button type="button" className="moodboard-board__control" onClick={() => zoomBy(ZOOM_STEP)}
              aria-label="Zoom in" title="Zoom in">+</button>
            <button type="button" className="moodboard-board__control moodboard-board__control--text" onClick={() => fit(false)}
              aria-label="Fit the board" title="Fit the board (Shift+1)">Fit</button>
            {/* Live while files upload (GM): each upload is its own placeholder, so the toolbar has no status. */}
            <label className={`moodboard-board__control moodboard-board__control--text${offline ? ' moodboard-board__control--disabled' : ''}`}
              title={offline ? offlineDisabledReason('add images') : 'Add images to the middle of the view'} {...offlineMark(offline)}>
              <span aria-hidden="true">Add images</span>
              <input className="moodboard-board__file" type="file" accept="image/*" multiple disabled={offline}
                aria-label="Add images" onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
            </label>
          </Panel>
        </ReactFlow>
      </BoardWideContext.Provider>
      </BoardFillContext.Provider>
      {outside && onOutsideDone && (
        <OutsideChip key={outside.id} tiles={outside} viewOf={viewRect} seenOf={seenArea} onShow={showOutside} onDone={onOutsideDone}
          focusBoard={focusBoard} />
      )}
      {nodes.length === 0 && held.length === 0 && (
        <div className="moodboard-board__empty" role="note">
          <span className="moodboard-board__empty-title">No references yet</span>
          {/* Not while offline (GM r12 2): a drop is paused then; the hint comes back on reconnect. */}
          {!offline && <span className="moodboard-board__empty-hint">Drop images here. They land where you drop them.</span>}
        </div>
      )}
    </div>
  );
}
