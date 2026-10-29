import { useEffect, useMemo, useRef } from 'react';
import { sceneStopLines, useGraphStore } from '../../store/graphStore';
import { useCanvasLock } from '../../lib/canvasLock';
import { NOTICE_SLOTS } from '../../lib/noticeSlots';
import { TRY_AGAIN } from '../../lib/sceneSaveCopy';

/**
 * GM r28: a scene's stop line is a state, never lost. The lines sit in
 * their own slot above the event slot (lib/noticeSlots.ts 'scene-stop'),
 * one per cause, naming their scenes with the shared rule (up to 3 by name,
 * from 4 a count); no event pushes them out. [Try again] retries every
 * scene its line names, each once: the scenes that fail stay in the line,
 * and a scene whose stop clears leaves it, so the line shrinks or goes.
 * While a try is on its way the line stays, its [Try again] disabled (GM
 * r29 call 2: aria-disabled, so focus stays on it), so a second press can't
 * queue another.
 * No hold and no ×: the line goes when the stop does. A scene whose clash
 * waits is asked by its prompt instead, and the scene whose "Unsaved"
 * popover is open is left out while it is (its line is there).
 *
 * Focus (review 18 LOW-1, GM r29): a line that had focus and comes back
 * under another cause gives focus to its [Try again]; one that goes for good
 * hands it on by the notice stack's × rule (useStopLineFocus).
 */
export function SceneStopLines() {
  const nodes = useGraphStore((state) => state.nodes);
  const stoppedScenes = useGraphStore((state) => state.stoppedScenes);
  const sceneStops = useGraphStore((state) => state.sceneStops);
  const sceneTries = useGraphStore((state) => state.sceneTries);
  const scenePopover = useGraphStore((state) => state.scenePopover);
  const retry = useGraphStore((state) => state.retrySceneSave);
  // A try saves: read-only while following or offline, as every edit is.
  const lock = useCanvasLock();
  const lines = useMemo(() => sceneStopLines({ nodes, stoppedScenes, sceneStops, sceneTries, scenePopover }),
    [nodes, stoppedScenes, sceneStops, sceneTries, scenePopover]);
  const { track, buttonRef } = useStopLineFocus(lines);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <div key={line.key} className="canvas-undo-notice scene-stop-line" role="status" aria-live="polite" data-scene-stop={line.key}
          tabIndex={-1} {...track(line)}>
          <span className="canvas-undo-notice__text">{line.text}</span>
          {/* GM r29 call 2: disabled while its try is on its way, the label as it is. */}
          <button type="button" className="canvas-undo-notice__action" {...lock.act()} aria-disabled={line.trying || undefined}
            ref={buttonRef(line.key)}
            onClick={() => { if (line.trying) return; for (const nodeId of line.nodeIds) retry(nodeId); }}>
            {TRY_AGAIN}
          </button>
        </div>
      ))}
    </>
  );
}

type Line = ReturnType<typeof sceneStopLines>[number];

/**
 * Review 18 LOW-1 (GM r29 approved): where focus goes when the stop line it
 * was in leaves the page. Only when focus went with the line (it is on the
 * body or gone), never from where the person moved meanwhile.
 * - The line's scenes are in a line again (a try that came back under
 *   another cause): that line's [Try again].
 * - Gone for good (the stop cleared by itself, or every scene saved): the
 *   notice stack's × rule (ProjectHome useNoticeStackFocus): the stop line
 *   now in its place, else the one before, as a notice (its tabindex; never
 *   its [Try again], so a second Enter can't act); with no stop line left,
 *   the next notice below in the region, else the one above, onto its ×,
 *   else the notice itself when it takes focus (the clash prompt); else the
 *   canvas. A plain focus(): the ring follows the input (GM r17).
 */
function useStopLineFocus(lines: Line[]) {
  const focused = useRef<{ key: string; nodeIds: string[] } | null>(null);
  const previous = useRef<string[]>([]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const lineEls = useRef(new Map<string, HTMLDivElement>());
  const joined = lines.map((line) => `${line.key}:${line.nodeIds.join(',')}`).join(' ');
  useEffect(() => {
    const before = previous.current;
    previous.current = lines.map((line) => line.key);
    const was = focused.current;
    if (!was) return;
    const same = lines.find((line) => line.key === was.key);
    if (same) { focused.current = { key: same.key, nodeIds: same.nodeIds }; return; }
    focused.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const back = lines.find((line) => line.nodeIds.some((id) => was.nodeIds.includes(id)));
    if (back) {
      buttons.current.get(back.key)?.focus();
      return;
    }
    const index = before.indexOf(was.key);
    const left = lines.map((line) => lineEls.current.get(line.key)).filter((el): el is HTMLDivElement => Boolean(el));
    if (left.length > 0) { left[Math.min(Math.max(index, 0), left.length - 1)].focus(); return; }
    (otherNoticeTarget() ?? document.querySelector<HTMLElement>('.canvas-wrapper'))?.focus();
    // lines is read through `joined`: a new array each render, the same lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return {
    track: (line: Line) => ({
      ref: (element: HTMLDivElement | null) => { if (element) lineEls.current.set(line.key, element); else lineEls.current.delete(line.key); },
      onFocus: () => { focused.current = { key: line.key, nodeIds: line.nodeIds }; },
      onBlur: (event: { relatedTarget: EventTarget | null }) => {
        // Moving elsewhere forgets it; focus that goes with the line (no
        // related target) is what the rule above catches.
        if (event.relatedTarget) focused.current = null;
      },
    }),
    buttonRef: (key: string) => (element: HTMLButtonElement | null) => {
      if (element) buttons.current.set(key, element); else buttons.current.delete(key);
    },
  };
}

/** The notice the × rule hands focus to once no stop line is left: the
 * nearest one below the stop lines' slot, else above, onto its ×, else the
 * notice itself when it takes focus. Null when none can. */
function otherNoticeTarget(): HTMLElement | null {
  const at = NOTICE_SLOTS.indexOf('scene-stop');
  const below = NOTICE_SLOTS.slice(at + 1);
  const above = NOTICE_SLOTS.slice(0, at).reverse();
  for (const slot of [...below, ...above]) {
    const box = document.querySelector<HTMLElement>(`[data-notice-slot="${slot}"]`);
    for (const notice of Array.from(box?.children ?? []) as HTMLElement[]) {
      const close = notice.querySelector<HTMLElement>('button[aria-label="Dismiss"]:not(:disabled)');
      if (close) return close;
      if (notice.getAttribute('tabindex') === '-1') return notice;
    }
  }
  return null;
}
