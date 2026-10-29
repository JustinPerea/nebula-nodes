import { useEffect, useRef } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { KEEP_MINE, theirsLabel } from '../../lib/sceneSaveCopy';
import { useCanvasLock } from '../../lib/canvasLock';

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
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([nodeId, clash]) => (
        <div key={clash.id} className="canvas-undo-notice scene-clash-notice" role="alert" aria-live="assertive"
          data-scene-clash={nodeId} tabIndex={-1}
          ref={(element) => { if (element) prompts.current.set(clash.id, element); else prompts.current.delete(clash.id); }}>
          <span className="canvas-undo-notice__text">{clash.line}</span>
          <button type="button" className="canvas-undo-notice__action" {...lock.act()} onClick={() => resolve(nodeId, 'mine')}>
            {KEEP_MINE}
          </button>
          <button type="button" className="canvas-undo-notice__action canvas-undo-notice__action--quiet"
            {...lock.act()} onClick={() => resolve(nodeId, 'theirs')}>
            {theirsLabel(clash.agent)}
          </button>
        </div>
      ))}
    </>
  );
}
