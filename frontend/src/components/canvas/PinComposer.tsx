import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PromptDialog, type PromptRequest } from '../PromptDialog';
import { KEPT_FEWER, KEPT_SHOWN, keptMoreLabel, keptNoteDisplay, keptNoteLine, MAX_PIN_TEXT, noteLength, NOTE_KEPT_COPY, PIN_REFUSAL_COPY,
  pinDisplayText, pinTextSettled, pinTextSettling, type KeptNote } from '../../lib/canvasPins';
import { useGraphStore } from '../../store/graphStore';
import { personBannerShown, personGateHeld, subscribePersonBanner, subscribePersonGate } from '../../lib/personSession';
import { useCurrentProjectId } from '../../lib/currentProject';
import { getProjectContext } from '../../lib/projectContext';
import { useCanvasPinsStore } from '../../store/canvasPinsStore';
import { wsClient } from '../../lib/wsClient';
import { useProjectStore } from '../../store/projectStore';
import { refuseCanvasEdit, useCanvasLock } from '../../lib/canvasLock';
import { InNoticeRegion } from '../InNoticeRegion';
import { dialogStart, openModalDialog } from '../../lib/modalFocus';
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
/** The note's cap in the dialog: 280 shown characters, counted as the
 * backend counts them; "N left" from 30 left (GM r20 note 1). */
const NOTE_CAP = { max: MAX_PIN_TEXT, count: noteLength, showAt: 30 };
/** GM r27 item 4: how long a pin_node_gone refusal holds Send note while the
 * canvas still shows the node and no sync has named it. */
const NODE_GONE_RECHECK_MS = 5000;

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
  const targetGone = useCanvasPinsStore((s) => s.targetGone);
  const targetRemoved = useCanvasPinsStore((s) => s.targetRemoved);
  const tooLongRefusals = useCanvasPinsStore((s) => s.tooLongRefusals);
  const errorPersonGate = useCanvasPinsStore((s) => s.errorPersonGate);
  // GM r24: while the person-gate banner shows (it was up as the dialog
  // opened, or came up while it was open), Send note waits, disabled in the
  // shared style with its reason; a refused send's toast then leaves the fix
  // to the banner.
  // GM r27 item 2: and after the banner's ×, while the tab still isn't
  // connected as the person (× hides the banner, not the condition).
  const bannerUp = useSyncExternalStore(subscribePersonBanner, personBannerShown);
  const gateHeld = useSyncExternalStore(subscribePersonGate, personGateHeld);
  const gateBanner = bannerUp || gateHeld;
  const lock = useCanvasLock();
  // Review 13 L-2: the dialog counts only once the Unicode data is in (its
  // own chunk, fetched as lib/canvasPins loads; a few milliseconds at most).
  const [textReady, setTextReady] = useState(pinTextSettled);
  useEffect(() => {
    if (textReady) return;
    let live = true;
    void pinTextSettling().then(() => { if (live) setTextReady(true); });
    return () => { live = false; };
  }, [textReady]);
  // GM r23 item 2: the node the dialog is for left the canvas (the person
  // or an agent removed it): Send note is disabled with the line as its
  // reason, and the line shows once; Cancel and the typed text stay.
  // A node the canvas had for this dialog and then lost: never one it
  // hasn't loaded yet.
  const targetNode = composer && 'nodeId' in composer ? composer.nodeId : null;
  const nodeHere = useGraphStore((s) => targetNode !== null && s.nodes.some((node) => node.id === targetNode));
  const sawNode = useRef<string | null>(null);
  // Review 14 LOW-2: the node this dialog lost, so its return (Undo, an
  // agent's restore, a sync) makes Send note live again; only a real
  // missing -> present change, never a refusal while the canvas still has it.
  const lostNode = useRef<string | null>(null);
  const targetReturned = useCanvasPinsStore((s) => s.targetReturned);
  useEffect(() => {
    if (targetNode === null) { sawNode.current = null; lostNode.current = null; }
    else if (nodeHere) {
      sawNode.current = targetNode;
      if (lostNode.current === targetNode) { lostNode.current = null; targetReturned(); }
    } else if (sawNode.current === targetNode || targetGone) {
      lostNode.current = targetNode;
      targetRemoved();
    }
  }, [targetNode, nodeHere, targetGone, targetRemoved, targetReturned]);
  // GM r27 item 4 (review 15 NIT 3): Nebula refused with pin_node_gone while
  // the canvas still shows the node (its sync not in yet). Send note comes
  // back on the next sync that names the node, or after 5 s, whichever is
  // first; a sync that drops it leaves it disabled under the rule above.
  useEffect(() => {
    if (!targetGone || !nodeHere || targetNode === null || lostNode.current === targetNode) return;
    const timer = window.setTimeout(() => {
      if (useGraphStore.getState().nodes.some((node) => node.id === targetNode)) targetReturned();
    }, NODE_GONE_RECHECK_MS);
    const stop = wsClient.subscribe((event) => {
      if (event.type === 'graphSync' && event.nodes.some((node) => (node as { id?: unknown })?.id === targetNode)) targetReturned();
    });
    return () => { window.clearTimeout(timer); stop(); };
  }, [targetGone, nodeHere, targetNode, targetReturned]);
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
  // A refusal is one neutral line (GM r20 Q1), beside the dialog it leaves
  // open, or alone after a failed delete.
  // GM r24: a send the person gate refused says only "Your note wasn’t
  // added." while the banner (which says how to fix it) shows; the full
  // Q116a line when it doesn't.
  // The toast defers to the banner only while the banner shows (GM r24); once
  // it's dismissed, a refused send's toast says the full Q116a line (GM r27
  // item 2: "keep the full Q116a line"), and Send note stays held (gateBanner).
  const errorLine = errorPersonGate && bannerUp ? PIN_REFUSAL_COPY.notAdded : error;
  const errorLeave = useLeave(errorLine && (errorProject === null || errorProject === here) ? errorLine : null);

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
    if (stackHasFocus && !neighbour && openModalDialog()) {
      // GM r25: a dialog is open: back to its field.
      dialogStart(openModalDialog())?.focus({ preventScroll: true });
      focusAfter.current = null;
    } else if (stackHasFocus && !neighbour) {
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
      {request && textReady && (
        <PromptDialog
          request={request}
          // Only what shows counts (GM r12 answer 3), as the backend counts it;
          // a neutral "N left" from 30 left (GM r20 note 1).
          cap={NOTE_CAP}
          // Review 13 NIT-3: a note_too_long refusal turns "N left" on.
          revealCounter={tooLongRefusals}
          // GM bug 2 (fix round 1 of PR #200): a textarea that grows, the
          // caret at the end of a kept note, and "Send note".
          multiline
          confirmLabel="Send note"
          onChange={setDraft}
          confirm={lock.act({ offline: 'send notes', ...(targetGone ? { disabled: true, title: PIN_REFUSAL_COPY.nodeGone }
            : gateBanner ? { disabled: true, title: PIN_REFUSAL_COPY.sendWhenConnected } : {}) })}
          onRefused={() => { if (!targetGone && !gateBanner) refuseCanvasEdit(); }}
          onDone={(value) => {
            if (value === null || !value.trim()) cancel();
            else void submit(value);
          }}
        />
      )}
      {/* In the app's notice region, like every toast (GM - Design, 2026-10-23). */}
      {errorLeave.shown && (
        <InNoticeRegion slot="pin">
          <div className="canvas-pin-toast canvas-pin-toast--notice" role="status" {...errorLeave.props}>
            <span>{errorLeave.shown}</span>
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
