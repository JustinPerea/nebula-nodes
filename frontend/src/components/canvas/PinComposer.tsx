import { useMemo } from 'react';
import { PromptDialog, type PromptRequest } from '../PromptDialog';
import { keptNoteLine, MAX_PIN_TEXT, NOTE_KEPT_COPY, type KeptNote } from '../../lib/canvasPins';
import { useCurrentProjectId } from '../../lib/currentProject';
import { getProjectContext } from '../../lib/projectContext';
import { useCanvasPinsStore } from '../../store/canvasPinsStore';
import { refuseCanvasEdit, useCanvasLock } from '../../lib/canvasLock';
import { InNoticeRegion } from '../InNoticeRegion';
import '../../styles/canvasPins.css';

/** The "Note for agents" dialog, opened from the context menu or the selection toolbar.
 *
 * Round 23 of PR #195 (review 22, M-1): part of the canvas's read-only
 * state. Its OK takes the canvas lock (lib/canvasLock: disabled, marked,
 * "Wait for “X” to open." while following); offline the dialog stays open
 * with the text, as before. A follow or a replacement closes it (its target
 * is a node of the canvas that went), and what was typed comes back in a
 * notice with a Copy button, never pinned to the canvas that replaced it.
 * Follow-up (GM, 2026-10-27): opening Note again starts with that text.
 * Fix round 2 of PR #200 (GM 2026-10-28 answer 1): on its own project only.
 * On another project the dialog starts empty and the notice stays (it is
 * shown beside the open dialog too) until its × drops it.
 * Fix round 3 (review 3 M-2, GM's round 3 answer, verbatim): one note per
 * project. Notices stack, newest at the bottom, each with its own Copy note
 * and ×; on another project each names its own ("Your note for “Alpha”
 * wasn’t sent because …"). A failed send's error shows on its own project
 * only (review 3 N-3): elsewhere it would be about a note the person can't
 * see; the note waits there as its draft. */
export function PinComposer() {
  const composer = useCanvasPinsStore((s) => s.composer);
  const submit = useCanvasPinsStore((s) => s.submit);
  const cancel = useCanvasPinsStore((s) => s.cancelCompose);
  const setDraft = useCanvasPinsStore((s) => s.setDraft);
  const error = useCanvasPinsStore((s) => s.error);
  const errorProject = useCanvasPinsStore((s) => s.errorProject);
  const clearError = useCanvasPinsStore((s) => s.clearError);
  const kept = useCanvasPinsStore((s) => s.kept);
  const dismissKept = useCanvasPinsStore((s) => s.dismissKept);
  const lock = useCanvasLock();
  // Re-renders on a project change; the key is the canvas's own (projectKey).
  const openId = useCurrentProjectId();
  const here = getProjectContext()?.id ?? openId ?? '';

  // The dialog starts with the kept note, or the draft × or Esc left (GM,
  // 2026-10-27), of this project only (2026-10-28): compose put it in
  // `draft` as it opened.
  const request = useMemo<PromptRequest | null>(
    () => (composer ? { label: 'Note for agents', initial: useCanvasPinsStore.getState().draft, resolve: () => {} } : null),
    [composer],
  );

  const copyKept = (note: KeptNote) => {
    void navigator.clipboard?.writeText(note.text).catch(() => {});
  };

  return (
    <>
      {request && (
        <PromptDialog
          request={request}
          maxLength={MAX_PIN_TEXT}
          // GM bug 2 (fix round 1 of PR #200): a textarea that grows, the
          // caret at the end of a kept note, and "Send note".
          multiline
          confirmLabel="Send note"
          onChange={setDraft}
          confirm={lock.act()}
          onRefused={() => { refuseCanvasEdit(); }}
          onDone={(value) => {
            if (value === null || !value.trim()) cancel();
            else void submit(value);
          }}
        />
      )}
      {/* In the app's notice region, like every toast (GM - Design, 2026-10-23). */}
      {error && !composer && (errorProject === null || errorProject === here) && (
        <InNoticeRegion slot="pin">
          <div className="canvas-pin-toast" role="alert">
            <span>{error}</span>
            <button type="button" onClick={clearError} aria-label="Dismiss">×</button>
          </div>
        </InNoticeRegion>
      )}
      {/* Kept notes, one per project, oldest first (newest at the bottom);
          beside the open dialog too (GM 2026-10-28 answer 1). */}
      {kept.length > 0 && (
        <InNoticeRegion slot="pin">
          <div className="canvas-pin-kept-stack">
            {kept.map((note) => (
              <div key={note.project} className="canvas-pin-toast canvas-pin-toast--kept" role="status" data-project={note.project}>
                <span className="canvas-pin-toast__text">
                  {keptNoteLine(note, here)}
                  {/* GM r24: the note on its own line, in quotes, clamped to 2
                      lines with "…"; Copy note copies all of it. */}
                  <q className="canvas-pin-toast__note" title={note.text}>{note.text}</q>
                </span>
                <button type="button" className="canvas-pin-toast__copy" onClick={() => copyKept(note)}>{NOTE_KEPT_COPY}</button>
                <button type="button" onClick={() => dismissKept(note.project)} aria-label="Dismiss">×</button>
              </div>
            ))}
          </div>
        </InNoticeRegion>
      )}
    </>
  );
}
