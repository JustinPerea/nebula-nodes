import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import {
  Background, BackgroundVariant, Panel, ReactFlow, ReactFlowProvider, getViewportForBounds, useReactFlow, useStore, useStoreApi,
  type Node, type NodeChange, type NodeTypes, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { MoodboardImage } from '../../types';
import { CANVAS_INTERACTION_PROPS } from '../../lib/canvasNavigation';
import { springViewport } from '../../lib/viewportSpring';
import { useBoardCanvasStore, useBoardSelection } from '../../store/boardCanvasStore';
import { BoardCardNode } from './BoardCardNode';
import { BoardWideContext, createBoardNodeBuilder, wideFrom } from './boardNodes';
import { visibleFlowCenter } from '../../lib/visibleFlowRect';
import { isStudioShortcutTarget, studioKey } from './studioKeys';
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
  /** Image files dropped on the board (or added with its button), and the
   *  point in board coordinates they gather around: the pointer, or the
   *  middle of the view. */
  onDropFiles: (files: File[], at: { x: number; y: number }) => void;
  /** Files are uploading: the Add images button waits. */
  uploading?: boolean;
}

const nodeTypes: NodeTypes = { card: BoardCardNode };
/** Arrow keys move the selected cards in 5 px steps; they go as one move this long after the last. */
export const KEY_MOVE_SETTLE_MS = 400;
const FIT_PADDING = 0.12;
// Low enough to fit a 300-reference board (about 2,500 x 22,000 board px) in view.
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
// Props React Flow gets the same object for on every render: a new one (an
// inline `[]` or `{}`) would make it update its store on each pointer move.
const NO_EDGES: [] = [];
const FIT_VIEW_OPTIONS = { padding: FIT_PADDING, maxZoom: 1 };
const PRO_OPTIONS = { hideAttribution: true };
// React Flow's screen-reader words, about references instead of nodes.
const ARIA_LABELS = {
  'node.a11yDescription.default':
    'Press Enter or Space to select a reference. Arrow keys move the selected references; Delete removes them.',
  'node.a11yDescription.ariaLiveMessage': ({ direction }: { direction: string; x: number; y: number }) =>
    `Moved the selected references ${direction}.`,
};

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

function BoardFlow({ boardKey, images, onMove, onDropFiles, uploading = false }: BoardCanvasProps) {
  const { screenToFlowPosition, getViewport, setViewport, getNodesBounds } = useReactFlow();
  const flowStore = useStoreApi();
  const selection = useBoardSelection(boardKey);
  const setSelection = useBoardCanvasStore((state) => state.setSelection);
  const savedViewport = useRef(useBoardCanvasStore.getState().viewports[boardKey]).current;

  // Where cards being dragged or nudged are, until the move is sent.
  const [moving, setMoving] = useState<Record<string, { x: number; y: number }>>({});
  const movingRef = useRef(moving);
  movingRef.current = moving;
  const dragging = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const keyTimer = useRef<number | null>(null);

  const build = useMemo(() => createBoardNodeBuilder(), []);
  const selected = useMemo(() => new Set(selection), [selection]);
  const nodes = useMemo(() => build(images, selected, moving), [build, images, selected, moving]);
  // Which cards show their file rather than the thumbnail: worked out here once
  // per zoom, for every card (BoardWideContext).
  const widths = useMemo(() => [...new Set(images.flatMap((image) => (image.placements ?? []).map((card) => card.w)))]
    .sort((a, b) => a - b), [images]);
  const wide = useStore(useCallback((state: { transform: [number, number, number] }) => wideFrom(widths, state.transform[2]), [widths]));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
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
  const springTo = useCallback((to: Viewport) => {
    stopSpring.current?.();
    stopSpring.current = springViewport(getViewport(), to, (viewport) => { void setViewport(viewport); });
    // Where the camera lands is kept for the visit, as a pan or scroll is
    // (onMoveEnd fires only for the person's own moves, not these).
    useBoardCanvasStore.getState().setViewport(boardKey, to);
  }, [getViewport, setViewport, boardKey]);
  useEffect(() => () => stopSpring.current?.(), []);

  const fit = useCallback(() => {
    const { width, height } = flowStore.getState();
    if (!width || !height || nodesRef.current.length === 0) return;
    springTo(getViewportForBounds(getNodesBounds(nodesRef.current), width, height, MIN_ZOOM, 1, FIT_PADDING));
  }, [flowStore, getNodesBounds, springTo]);

  const zoomBy = useCallback((factor: number) => {
    const { width, height } = flowStore.getState();
    const from = getViewport();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, from.zoom * factor));
    // Keep the centre of the view where it is.
    const cx = width / 2;
    const cy = height / 2;
    springTo({ zoom, x: cx - ((cx - from.x) / from.zoom) * zoom, y: cy - ((cy - from.y) / from.zoom) * zoom });
  }, [flowStore, getViewport, springTo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || studioKey(event) !== 'fit' || !isStudioShortcutTarget(event.target)) return;
      event.preventDefault();
      fit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fit]);

  const rememberViewport = useCallback((_event: unknown, viewport: Viewport) => {
    useBoardCanvasStore.getState().setViewport(boardKey, viewport);
  }, [boardKey]);

  const addFiles = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    const at = visibleFlowCenter(wrapperRef.current, screenToFlowPosition);
    if (at) {
      onDropFiles(files, at);
      return;
    }
    // No size yet: to the right of the cards.
    const cards = nodesRef.current;
    const right = cards.reduce((edge, node) => Math.max(edge, node.position.x + (node.width ?? 0)), 0);
    onDropFiles(files, { x: right + 280, y: cards.length ? Math.min(...cards.map((node) => node.position.y)) + 135 : 0 });
  };

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
    onDropFiles(files, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  return (
    <div ref={wrapperRef} className={`moodboard-board${dropping ? ' moodboard-board--drop' : ''}`}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {/* Behind the cards, for the reader's ripple while Analyze runs (PR10b). */}
      <div className="moodboard-board__underlay" aria-hidden="true" data-layer="ripple" />
      <BoardWideContext.Provider value={wide}>
        <ReactFlow
          className="moodboard-board__flow"
          nodes={nodes}
          edges={NO_EDGES}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={onSelectionDragStop}
          onMoveEnd={rememberViewport}
          defaultViewport={savedViewport}
          fitView={!savedViewport}
          fitViewOptions={FIT_VIEW_OPTIONS}
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
          <Panel position="bottom-left" className="moodboard-board__controls">
            <button type="button" className="moodboard-board__control" onClick={() => zoomBy(1 / ZOOM_STEP)}
              aria-label="Zoom out" title="Zoom out">−</button>
            <button type="button" className="moodboard-board__control" onClick={() => zoomBy(ZOOM_STEP)}
              aria-label="Zoom in" title="Zoom in">+</button>
            <button type="button" className="moodboard-board__control moodboard-board__control--text" onClick={fit}
              aria-label="Fit the board" title="Fit the board (Shift+1)">Fit</button>
            <label className={`moodboard-board__control moodboard-board__control--text${uploading ? ' moodboard-board__control--busy' : ''}`}
              title="Add images to the middle of the view">
              <span aria-hidden="true">{uploading ? 'Uploading' : 'Add images'}</span>
              <input className="moodboard-board__file" type="file" accept="image/*" multiple disabled={uploading}
                aria-label="Add images" onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
            </label>
          </Panel>
        </ReactFlow>
      </BoardWideContext.Provider>
      {nodes.length === 0 && (
        <div className="moodboard-board__empty" role="note">
          <span className="moodboard-board__empty-title">No references yet</span>
          <span className="moodboard-board__empty-hint">Drop images here. They land where you drop them.</span>
        </div>
      )}
    </div>
  );
}
