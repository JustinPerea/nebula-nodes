import { useEffect, useRef } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { KEEP_MINE, theirsLabel } from '../../lib/sceneSaveCopy';
import { useCanvasLock, type ActProps } from '../../lib/canvasLock';
import { useHeldLook } from '../../hooks/useHeldLook';
import { canvasFocusTarget, nextNoticeTarget } from '../../lib/noticeFocus';
import type { SceneClashNotice } from '../../store/graphStore';

/**
 * GM r9 decision 2 (PR #198 review 6, H2): a Cinema scene changed somewhere
 * else on a field the person changed too. GM's line, with [Keep mine] and
 * [Use Codex's] ([Use theirs] with no agent). It stays until the person
 * chooses: meanwhile the card is marked "Unsaved" and every save sends the
 * other change for the fields that clash, so nothing is overwritten unasked.
 * One prompt per scene, in the region's own slot (lib/noticeSlots.ts).
 * GM r23 answer 2: a prompt asked again in place of a notice that had focus
 * (the delete toast's [Undo]) takes focus itself: it has no ×, and focus
 * never lands on [Keep mine].
 * GM r30: once answered, the prompt stays while the answer's save is on its
 * way (`sending`): aria-busy, both buttons held (aria-disabled at once,
 * grey after a moment, labels as they are, no reason tooltip), so a second
 * press sends nothing. It goes when that save is answered.
 * Focus (round 21, the coordinator's ruling on the drop flagged for
 * review): when an answered prompt goes with focus in it, focus never
 * drops to the page (useAnsweredFocus).
 */
export function SceneClashNotices() {
  const clashes = useGraphStore((state) => state.sceneClashes);
  const resolve = useGraphStore((state) => state.resolveSceneClash);
  // A choice saves: read-only while following or offline, as every edit is.
  const lock = useCanvasLock();
  const entries = Object.entries(clashes);
  const prompts = useRef(new Map<number, HTMLDivElement>());
  const focusId = entries.find(([, clash]) => clash.focus)?.[1].id;
  const focused = useRef<number | null>(null);
  useEffect(() => {
    if (focusId === undefined || focused.current === focusId) return;
    focused.current = focusId;
    const active = document.activeElement;
    // Only when focus went with the notice it replaced, never from where the person moved.
    if (active && active !== document.body && active.isConnected && !active.closest('.canvas-undo-notice')) return;
    prompts.current.get(focusId)?.focus();
  }, [focusId]);
  const answered = useAnsweredFocus(entries);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([nodeId, clash]) => (
        <ClashPrompt key={clash.id} nodeId={nodeId} clash={clash} act={lock.act()} resolve={resolve} onAnswer={answered}
          promptRef={(element) => { if (element) prompts.current.set(clash.id, element); else prompts.current.delete(clash.id); }} />
      ))}
    </>
  );
}

function ClashPrompt({ nodeId, clash, act, resolve, onAnswer, promptRef }: { nodeId: string; clash: SceneClashNotice; act: ActProps;
  resolve: (nodeId: string, keep: 'mine' | 'theirs') => void; onAnswer: (answer: Answered) => void;
  promptRef: (element: HTMLDivElement | null) => void }) {
  const sending = Boolean(clash.sending);
  const held = useHeldLook(sending);
  const answer = (keep: 'mine' | 'theirs', event: { detail: number }) => {
    if (sending) return;
    // A click with no pointer count is the keyboard's (Enter or Space).
    onAnswer({ nodeId, id: clash.id, keyboard: event.detail === 0 });
    resolve(nodeId, keep);
  };
  return (
    <div className="canvas-undo-notice scene-clash-notice" role="alert" aria-live="assertive" aria-busy={sending || undefined}
      data-scene-clash={nodeId} tabIndex={-1} ref={promptRef}>
      <span className="canvas-undo-notice__text">{clash.line}</span>
      <button type="button" className="canvas-undo-notice__action" {...act} {...held} onClick={(event) => answer('mine', event)}>
        {KEEP_MINE}
      </button>
      <button type="button" className="canvas-undo-notice__action canvas-undo-notice__action--quiet"
        {...act} {...held} onClick={(event) => answer('theirs', event)}>
        {theirsLabel(clash.agent)}
      </button>
    </div>
  );
}

interface Answered { nodeId: string; id: number; keyboard: boolean }

/**
 * Where focus goes when an answered prompt leaves the region (round 21):
 * only when focus went with it (on the page, or gone), never from where the
 * person moved meanwhile.
 * - The answer's save failed: the stop line that took the prompt's place,
 *   onto its [Try again].
 * - Asked again: the new prompt itself (no ×; never Keep mine).
 * - Otherwise the notice stack's × rule: the next stop line (the line
 *   itself, never its [Try again]), else the next notice's ×, else the
 *   canvas.
 * The ring shows only when the answer came from the keyboard
 * (focusVisible; a browser that ignores it uses its own heuristic, which
 * follows the same input).
 */
function useAnsweredFocus(entries: [string, SceneClashNotice][]): (answer: Answered) => void {
  const answered = useRef<Answered | null>(null);
  const ids = entries.map(([, clash]) => clash.id).join(' ');
  useEffect(() => {
    const was = answered.current;
    if (!was || entries.some(([, clash]) => clash.id === was.id)) return;
    answered.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const again = entries.find(([nodeId]) => nodeId === was.nodeId);
    const stopped = Array.from(document.querySelectorAll<HTMLElement>('[data-scene-stop]'))
      .find((line) => (line.getAttribute('data-scene-ids') ?? '').split(' ').includes(was.nodeId));
    const target = (stopped ? stopped.querySelector<HTMLElement>('button') ?? stopped : null)
      ?? (again ? document.querySelector<HTMLElement>(`[data-scene-clash="${again[0]}"]`) : null)
      ?? nextNoticeTarget('scene-clash') ?? canvasFocusTarget();
    target?.focus({ focusVisible: was.keyboard });
    // entries is read through `ids`: a new array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return (answer) => { answered.current = answer; };
}
