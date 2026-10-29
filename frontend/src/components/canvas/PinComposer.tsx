import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PromptDialog, type PromptRequest } from '../PromptDialog';
import { KEPT_FEWER, KEPT_SHOWN, keptMoreLabel, keptNoteDisplay, keptNoteLine, fitNote, NOTE_KEPT_COPY, pinDisplayText, type KeptNote } from '../../lib/canvasPins';
import { useCurrentProjectId } from '../../lib/currentProject';
import { getProjectContext } from '../../lib/projectContext';
import { useCanvasPinsStore } from '../../store/canvasPinsStore';
import { useProjectStore } from '../../store/projectStore';
import { refuseCanvasEdit, useCanvasLock } from '../../lib/canvasLock';
import { InNoticeRegion } from '../InNoticeRegion';
import { useLeave, useLeavingRows } from '../../lib/noticeLeave';
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
 * see; the note waits there as its draft.
 * Fix round 4 (review 4 LOW-1, N-3, N-5, N-6; GM round 5 answers 2 and 5):
 * the newest two show, with "Show 7 more" (the real count) opening the
 * whole list, which scrolls inside a cap so it never reaches the project bar
 * or the selection toolbar; each note keeps its line breaks, clamped to 2
 * lines (blank-line runs collapsed), and names its project as it is called
 * now; a failed send's error goes once the person leaves its project. */
export function PinComposer() {
  const composer = useCanvasPinsStore((s) => s.composer);
  const submit = useCanvasPinsStore((s) => s.submit);
  const cancel = useCanvasPinsStore((s) => s.cancelCompose);
  const setDraft = useCanvasPinsStore((s) => s.setDraft);
  const error = useCanvasPinsStore((s) => s.error);
  const errorTone = useCanvasPinsStore((s) => s.errorTone);
  const errorProject = useCanvasPinsStore((s) => s.errorProject);
  const clearError = useCanvasPinsStore((s) => s.clearError);
  const kept = useCanvasPinsStore((s) => s.kept);
  const dismissKept = useCanvasPinsStore((s) => s.dismissKept);
  const lock = useCanvasLock();
  // Re-renders on a project change; the key is the canvas's own (projectKey).
  const openId = useCurrentProjectId();
  const here = getProjectContext()?.id ?? openId ?? '';
  const projects = useProjectStore((s) => s.projects);
  const nameOf = (id: string) => projects.find((project) => project.id === id)?.name ?? null;
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hidden = Math.max(0, kept.length - KEPT_SHOWN);
  const open = showAll && hidden > 0;
  const shown = open ? kept : kept.slice(-KEPT_SHOWN);
  // Fix round 6 (GM r9 answer 2, motion by kind): a note kept while the stack
  // is already showing is content inside that surface, so its row expands
  // into place (noticeRegion.css notice-row-in); the stack's first note is
  // the surface arriving, which scales in. Rows "Show 7 more" reveals were
  // already kept, so they don't expand. A row stays marked until its own
  // expand ends, so a re-render mid-spring never cuts it short.
  const [keptBefore, setKeptBefore] = useState(kept);
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  if (keptBefore !== kept) {
    setKeptBefore(kept);
    const had = new Set(keptBefore.map((note) => note.project));
    const added = had.size ? kept.filter((note) => !had.has(note.project)).map((note) => note.project) : [];
    const still = [...entering].filter((project) => kept.some((note) => note.project === project));
    if (added.length || still.length !== entering.size) setEntering(new Set([...still, ...added]));
  }
  const entered = (project: string) => setEntering((now) => {
    if (!now.has(project)) return now;
    const next = new Set(now);
    next.delete(project);
    return next;
  });
  // Fix round 7 (GM r10 and r11 answer 2): the reverse. A note that goes
  // collapses in place, and the rows around it close up; when the last one
  // goes, the stack scales out as a surface, with its last note still in it
  // (lib/noticeLeave.ts). The open list re-sizes after a collapse ends (its
  // row count changes then), never at its start.
  const stackLeave = useLeave(kept.length > 0 ? true : null);
  const { rows, rowProps } = useLeavingRows(shown, (note) => note.project, { hold: stackLeave.leaving });
  // A red error shows once the dialog has closed; a neutral notice (GM r18
  // Q1) shows beside the dialog it leaves open. The tone goes with the text,
  // so a leaving toast keeps its look.
  const toast = useMemo(() => (error ? { text: error, tone: errorTone } : null), [error, errorTone]);
  const errorLeave = useLeave(toast && (!composer || toast.tone === 'notice') && (errorProject === null || errorProject === here) ? toast : null);

  // Back to the newest two once no note is hidden (the next one kept starts
  // collapsed again).
  useEffect(() => {
    if (hidden === 0 && showAll) setShowAll(false);
  }, [hidden, showAll]);
  // The whole list opens on its newest note (at the bottom), and its top
  // edge never cuts a note (fix round 5 of PR #200, review 5 LOW-1, GM r7
  // answer 3: snap). Its height is the newest notes that fit the cap, whole,
  // so its last scroll position is a row's top, and the rows snap to their
  // tops (canvasPins.css), so every position it rests at starts on a note.
  // A note cut at the bottom edge while it rests mid-list is accepted by
  // design (fix round 6, GM r9 answer 1: it's the usual sign there's more
  // below); it is sized once on open, when a note arrives and after a
  // note's collapse ends, never after a scroll, so it never jumps under the
  // person's wheel. A note arriving while it is open fades in place (fix
  // round 7, GM r11 answer 1), and this runs in the same layout pass, so the
  // list rests on whole rows in the very frame the note appears.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const place = () => {
      list.style.removeProperty('--kept-list-h');
      // A row still expanding measures its whole height, not its spring's
      // first frame (the expand restarts from its start, before any paint).
      list.dataset.measuring = 'true';
      const rows = [...list.children] as HTMLElement[];
      if (!rows.length) {
        delete list.dataset.measuring;
        return;
      }
      const cap = Math.min(window.innerHeight * 0.4, 360);
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      let height = 0;
      let top = rows[rows.length - 1].offsetTop;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const next = height + rows[i].offsetHeight + (height ? gap : 0);
        if (next > cap && height) break;
        height = next;
        top = rows[i].offsetTop;
      }
      list.style.setProperty('--kept-list-h', `${Math.ceil(height)}px`);
      list.scrollTop = top - rows[0].offsetTop;
      delete list.dataset.measuring;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, rows.length]);

  // Review 5 N-1 (GM r7): the × of a kept note moves focus to the next note's
  // ×, or the previous one's when it was the last, or, once none is left, back
  // to whatever had focus before the person came into the notes (the canvas
  // when nothing did). Never to <body>.
  const stackRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const focusAfter = useRef<string | null>(null);
  const dismiss = (project: string) => {
    const index = shown.findIndex((note) => note.project === project);
    const stackHasFocus = Boolean(stackRef.current?.contains(document.activeElement));
    const neighbour = shown[index + 1] ?? shown[index - 1] ?? kept.find((note) => note.project !== project) ?? null;
    focusAfter.current = stackHasFocus ? (neighbour ? neighbour.project : '') : null;
    if (stackHasFocus && !neighbour) {
      const opener = openerRef.current;
      // <body> is no opener: focus that came from nowhere goes to the canvas.
      const back = opener?.isConnected && opener !== document.body ? opener : document.querySelector<HTMLElement>('.canvas-wrapper');
      back?.focus({ preventScroll: true });
      focusAfter.current = null;
    }
    dismissKept(project);
  };
  useLayoutEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    const row = [...(stackRef.current?.querySelectorAll<HTMLElement>('.canvas-pin-toast--kept') ?? [])].find((el) => el.dataset.project === target);
    row?.querySelector<HTMLElement>('button[aria-label="Dismiss"]')?.focus({ preventScroll: true });
  }, [kept]);

  // Review 4 N-6: a failed send's error belongs to the visit it failed on.
  // Leaving its project clears it, so it never comes back much later; the
  // note waits there as its draft.
  const lastHere = useRef(here);
  useEffect(() => {
    const left = lastHere.current;
    lastHere.current = here;
    if (left !== here && useCanvasPinsStore.getState().errorProject === left) clearError();
  }, [here, clearError]);

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
          // Only what shows counts (GM r12 answer 3), as the backend counts it.
          fit={fitNote}
          // GM bug 2 (fix round 1 of PR #200): a textarea that grows, the
          // caret at the end of a kept note, and "Send note".
          multiline
          confirmLabel="Send note"
          onChange={setDraft}
          confirm={lock.act({ offline: 'send notes' })}
          onRefused={() => { refuseCanvasEdit(); }}
          onDone={(value) => {
            if (value === null || !value.trim()) cancel();
            else void submit(value);
          }}
        />
      )}
      {/* In the app's notice region, like every toast (GM - Design, 2026-10-23). */}
      {errorLeave.shown && (
        <InNoticeRegion slot="pin">
          <div className={`canvas-pin-toast canvas-pin-toast--${errorLeave.shown.tone === 'notice' ? 'notice' : 'error'}`}
            role={errorLeave.shown.tone === 'notice' ? 'status' : 'alert'} {...errorLeave.props}>
            <span>{errorLeave.shown.text}</span>
            <button type="button" onClick={clearError} aria-label="Dismiss">×</button>
          </div>
        </InNoticeRegion>
      )}
      {/* Kept notes, one per project, oldest first (newest at the bottom);
          beside the open dialog too (GM 2026-10-28 answer 1). */}
      {stackLeave.shown && (
        <InNoticeRegion slot="pin">
          <div className="canvas-pin-kept-stack" data-open={open || undefined}
            ref={(node) => { stackRef.current = node; stackLeave.props.ref(node); }}
            data-leaving={stackLeave.props['data-leaving']} inert={stackLeave.props.inert}
            onAnimationEnd={stackLeave.props.onAnimationEnd}
            onFocus={(event) => {
              const from = event.relatedTarget as HTMLElement | null;
              if (from && !event.currentTarget.contains(from)) openerRef.current = from;
            }}>
            {hidden > 0 && (
              <button type="button" className="canvas-pin-kept-more" aria-expanded={open}
                onClick={() => setShowAll(!open)}>{open ? KEPT_FEWER : keptMoreLabel(hidden)}</button>
            )}
            <div ref={listRef} className="canvas-pin-kept-list">
              {rows.map(({ key, item: note, leaving }) => {
                const leave = rowProps(key, leaving);
                return (
                <div key={key} className="canvas-pin-toast canvas-pin-toast--kept" role="status" data-project={note.project}
                  data-entering={(!leaving && entering.has(note.project)) || undefined}
                  ref={leave.ref} data-leaving={leave['data-leaving']} inert={leave.inert}
                  onAnimationEnd={(event) => {
                    leave.onAnimationEnd(event);
                    if (event.target === event.currentTarget && !leaving) entered(note.project);
                  }}>
                  <span className="canvas-pin-toast__text">
                    {keptNoteLine(note, here, nameOf(note.project))}
                    {/* GM r24 and round 5 answer 5: the note on its own line, in
                        quotes, with its line breaks, clamped to 2 lines with "…";
                        Copy note copies all of it. */}
                    <q className="canvas-pin-toast__note" title={pinDisplayText(note.text, { fold: false })}>{keptNoteDisplay(note.text)}</q>
                  </span>
                  <button type="button" className="canvas-pin-toast__copy" onClick={() => copyKept(note)}>{NOTE_KEPT_COPY}</button>
                  <button type="button" onClick={() => dismiss(note.project)} aria-label="Dismiss">×</button>
                </div>
                );
              })}
            </div>
          </div>
        </InNoticeRegion>
      )}
    </>
  );
}
