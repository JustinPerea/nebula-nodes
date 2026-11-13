import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import {
  acceptLabel,
  changeCountLabel,
  countdown,
  decisionLine,
  ghostBoxes,
  notReadyLine,
  proposalChangeCount,
  proposalChanges,
  proposalEstimateLabel,
  proposalPlan,
} from '../../lib/canvasProposals';
import { useProposalNotReady } from '../../hooks/useProposalReadiness';
import { isNeutralProposalLine, useCanvasProposalsStore, type ProposalEntry } from '../../store/canvasProposalsStore';
import { InNoticeRegion } from '../InNoticeRegion';
import '../../styles/canvasProposals.css';
import { useCanvasLock } from '../../lib/canvasLock';
import { useLeave } from '../../lib/noticeLeave';
import { PersonLockLine } from '../PersonLock';
import { usePersonLock } from '../../hooks/usePersonLock';
import { LineText } from '../LineText';
import { KEEP_ATTR, SHRINK_ATTR, SHRINK_BODY_ATTR, SHRINK_FOOT_ATTR, SHRINK_HEAD_ATTR, SHRINK_NAME_ATTR } from '../../lib/noticeStackPlace';
import { useGraphStore } from '../../store/graphStore';
import { canvasFocusTarget } from '../../lib/noticeFocus';
import { sayPolitely } from '../../lib/noticeSay';

/** How long Accept/Reject ignore clicks after the shown proposal changes on its own. */
const SWITCH_GUARD_MS = 600;
/** Not-ready lines the bar shows before the rest move to the details. */
const READINESS_LINES = 3;

/** On the canvas while a keyboard decision put focus there (GM r69 Q2): it
 * shows the same ring Tab arrival does (canvas.css); the mark goes on its blur. */
export const DECISION_FOCUS_ATTR = 'data-focus-decided';

/**
 * Where focus goes once a proposal decided from the keyboard closes, and no
 * other proposal's card shows (#216 review 3, GM r57): the Undo notice the
 * decision raised, else the canvas, with the ring Tab arrival shows (GM r69
 * Q2). Never <body>. The notice can draw a frame after the card goes, so
 * the canvas holds focus until it does.
 */
function focusAfterDecision(noticeBefore: number | null, frames = 3): void {
  const notice = useGraphStore.getState().undoNotice;
  const raised = notice && notice.offer && notice.id !== noticeBefore;
  const row = raised ? document.querySelector<HTMLElement>('[data-notice-slot] .canvas-undo-notice:not([data-leaving])') : null;
  if (row) {
    if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
    row.focus({ preventScroll: true });
    return;
  }
  const canvas = canvasFocusTarget();
  if (canvas && document.activeElement !== canvas) canvas.focus({ preventScroll: true });
  // Marked only once it has focus (the card's leave may have put it there
  // already): an inert canvas (a dialog open) takes none, and keeps no mark.
  if (canvas && document.activeElement === canvas && !canvas.hasAttribute(DECISION_FOCUS_ATTR)) {
    canvas.setAttribute(DECISION_FOCUS_ATTR, '');
    canvas.addEventListener('blur', () => canvas.removeAttribute(DECISION_FOCUS_ATTR), { once: true });
  }
  if (raised && frames > 0 && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      // Only while focus is still where this put it.
      if (!canvas || document.activeElement === canvas) focusAfterDecision(noticeBefore, frames - 1);
    });
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Whether the note is longer than its six-line clamp, so the card offers
 * "Show all" (GM - Design, 2026-11-01). Measured while the note is clamped,
 * when it changes (a new observer reports at once) and whenever the card's
 * width does; while it is open the last answer stands.
 */
function useLongNote(note: string | undefined, open: boolean): [RefObject<HTMLParagraphElement | null>, boolean] {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setLong(el.scrollHeight > el.clientHeight + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [note, open]);
  return [ref, long && Boolean(note)];
}

/**
 * The fade masks on the card's scrolling body (GM - Design, PR #216 r2): 16 px
 * on whichever edge hides content, none at the ends. Also says whether it
 * scrolls at all, so it is a named tab stop only then (review 1 LOW-7).
 * Measured on scroll and whenever the body or its content resizes.
 */
function useScrollFades(ref: RefObject<HTMLDivElement | null>, mounted: boolean): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const body = ref.current;
    if (!body) return undefined;
    const read = () => {
      const more = body.scrollHeight - body.clientHeight;
      const top = more > 1 && body.scrollTop > 1;
      const bottom = more > 1 && body.scrollTop < more - 1;
      if (top) body.dataset.fadeTop = 'true';
      else delete body.dataset.fadeTop;
      if (bottom) body.dataset.fadeBottom = 'true';
      else delete body.dataset.fadeBottom;
      setScrolls(more > 1);
    };
    read();
    body.addEventListener('scroll', read, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
    observer?.observe(body);
    if (body.firstElementChild) observer?.observe(body.firstElementChild);
    return () => {
      body.removeEventListener('scroll', read);
      observer?.disconnect();
    };
  }, [ref, mounted]);
  return scrolls;
}

/** Ticks once a second while something is counting down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // The bar stays mounted while empty, so catch up the moment a proposal arrives.
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

/**
 * The decision bar for agents' proposals: who proposed what, what it will
 * run, and Accept / Reject. There is deliberately no keyboard shortcut for
 * Accept, so a stray keypress can never approve paid runs.
 */
export function ProposalBar() {
  const proposals = useCanvasProposalsStore((s) => s.proposals);
  const pending = useCanvasProposalsStore((s) => s.pending);
  const errors = useCanvasProposalsStore((s) => s.errors);
  // Review on its Update (Q112 a) asks for this one; paging moves on from it.
  const focusedId = useCanvasProposalsStore((s) => s.focusedId);
  const accept = useCanvasProposalsStore((s) => s.accept);
  const reject = useCanvasProposalsStore((s) => s.reject);
  // Offline is read-only (round 15 of PR #114), and so is following an
  // agent's switch (GM round 22, A: one state, lib/canvasLock): Accept and
  // Reject are disabled and look it; Show still works.
  const lock = useCanvasLock();
  // GM r30 item 7: while this tab isn't connected as the person (the hold the
  // server's demote sets and its promote clears, lib/personSession), Accept
  // and Reject wait, disabled with their reasons; Show still works.
  // GM, #204 r5 item 2: one state, held or not answered yet since load (useTabHeld). Before
  // the socket's first answer the lock keeps its own look for 150 ms (gatePending), so a
  // normal load never greys: aria-disabled, no reason, a click does nothing.
  // PR #204 round 10 (GM r15, r17 item 2): through the one lock (components/PersonLock):
  // aria-disabled, no tooltip, one line under both buttons, as the Updates rows say it.
  const gate = usePersonLock('review this');
  const gateHeld = gate.locked;
  const pruneExpired = useCanvasProposalsStore((s) => s.pruneExpired);
  const { fitBounds, getInternalNode } = useReactFlow();
  // Track the shown proposal by id, never by position: a proposal that
  // arrives while the person is reading another must not take its place
  // under the Accept button.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // What the person opened, by proposal: paging to another starts closed.
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const noteId = useId();
  const detailsId = useId();
  const shownId = useRef<string | null>(null);
  const pagedTo = useRef<string | null>(null);
  const guarding = useRef(false);

  // Oldest first, so new arrivals join the end of the pager.
  const open: ProposalEntry[] = Object.values(proposals)
    .filter((entry) => !entry.closing)
    .sort((a, b) => a.view.createdAt - b.view.createdAt || a.view.id.localeCompare(b.view.id));
  const now = useNow(open.length > 0);
  const live = open.find((entry) => entry.view.id === (focusedId ?? selectedId)) ?? open[0];
  const cardNode = useRef<HTMLDivElement | null>(null);
  // #216 review 3 (GM r57): Accept or Reject from the keyboard. Its button
  // goes disabled while the decision is out, so focus waits on the card's
  // region; once the proposal closes it goes to the next card's region,
  // else the Undo notice the decision raised, else the canvas. Never
  // <body>. A refused decision leaves it on the card, by its error.
  // Round 3l (GM r69 a): only while focus is still on the card or <body>;
  // put elsewhere meanwhile, it stays there. Read before the card's leave
  // (useLeave, below) moves focus off it, so this runs first.
  const decided = useRef<{ id: string; notice: number | null; kind: 'accept' | 'reject'; agent: string; home: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!decided.current) return;
    const active = document.activeElement;
    decided.current.home = !active || active === document.body || Boolean(cardNode.current?.contains(active));
  });
  // The bar leaves as it entered, a surface (fix round 7 of PR #200, GM r11
  // answer 2): the last proposal stays drawn, inert, until its scale-out
  // ends. Its inline error line leaves as a row.
  const leave = useLeave(live ?? null);
  const current = leave.shown ?? undefined;
  const errorLeave = useLeave(live ? errors[live.view.id] ?? null : null, 'row');
  const currentId = live?.view.id ?? null;
  const position = live ? open.indexOf(live) : 0;
  const notReady = useProposalNotReady(current);
  const shownViewId = current?.view.id ?? null;
  const detailsOpen = shownViewId !== null && detailsFor === shownViewId;
  const noteOpen = shownViewId !== null && noteFor === shownViewId;
  const [noteRef, noteLong] = useLongNote(current?.view.note, noteOpen);
  const bodyEl = useRef<HTMLDivElement | null>(null);
  const [cardMounted, setCardMounted] = useState(false);
  const scrolls = useScrollFades(bodyEl, cardMounted);
  const leaveRef = leave.props.ref;
  const cardRef = useCallback((node: HTMLDivElement | null) => {
    leaveRef(node);
    cardNode.current = node;
    setCardMounted(node !== null);
  }, [leaveRef]);
  useLayoutEffect(() => {
    const was = decided.current;
    if (!was) return;
    const entry = proposals[was.id];
    if (entry && !entry.closing) {
      if (!pending[was.id]) decided.current = null;
      return;
    }
    decided.current = null;
    sayPolitely(decisionLine(was.kind, was.agent));
    if (!was.home) return;
    if (live && cardNode.current) cardNode.current.focus({ preventScroll: true });
    else focusAfterDecision(was.notice);
  }, [proposals, pending, live]);

  useEffect(() => {
    pruneExpired(now);
  }, [now, pruneExpired]);

  // When the shown proposal changes without the person paging (the one they
  // were reading closed), ignore Accept/Reject for a moment so a click aimed
  // at the old one can't land on the new one.
  useEffect(() => {
    const previous = shownId.current;
    const implicit = Boolean(previous && currentId && previous !== currentId && pagedTo.current !== currentId);
    shownId.current = currentId;
    pagedTo.current = null;
    if (!implicit) return;
    guarding.current = true;
    const timer = window.setTimeout(() => {
      guarding.current = false;
    }, SWITCH_GUARD_MS);
    return () => {
      window.clearTimeout(timer);
      guarding.current = false;
    };
  }, [currentId]);

  // The bar itself is in the app's notice region too, on top of its stack:
  // above the canvas notice and the proposal's run-later notice (GM - Design,
  // 2026-10-23: "Yes, move the proposal bar into the region, stacked above
  // the notices. Accept / Reject are decisions and must never sit under a
  // panel."). It still mounts with the canvas, so it shows only there.
  if (!current) return null;

  const page = (step: number) => {
    const next = open[(position + step + open.length) % open.length];
    pagedTo.current = next.view.id;
    setSelectedId(next.view.id);
    useCanvasProposalsStore.getState().focus(null);
  };
  const settled = () => !guarding.current;
  // A click with detail 0 is Enter or Space on the button.
  const byKeyboard = (event: { detail: number }, kind: 'accept' | 'reject') => {
    if (event.detail !== 0) return;
    decided.current = {
      id: current.view.id, notice: useGraphStore.getState().undoNotice?.id ?? null, kind, agent: current.view.agent.name, home: true,
    };
    cardNode.current?.focus({ preventScroll: true });
  };
  const changes = current ? proposalChanges(current.view, current.values) : [];
  // One count, the backend's (GM - Design, PR #216 r3): the same number the
  // Update and MCP show, and the panel lists everything it counts.
  const changeTotal = proposalChangeCount(current.view, changes);
  const hasChangeLines = changeTotal > 0;
  const moreNotReady = notReady.length > READINESS_LINES;
  const hasDetails = hasChangeLines || moreNotReady;
  // The label never changes (GM - Design, 2026-11-01): the chevron and
  // aria-expanded carry the state.
  const detailsLabel = hasChangeLines ? 'What Accept writes' : 'Every node that can\u2019t run';
  const detailsCount = hasChangeLines
    ? changeCountLabel(changeTotal)
    : `${notReady.length} node${notReady.length === 1 ? '' : 's'}`;
  const priced = current.view.run.length > 0 && current.view.cost.paidRuns > 0
    && proposalEstimateLabel(current.view) !== null;
  const plan = proposalPlan(current.view);
  // "List prices, not a quote" belongs to the price alone (GM - Design, PR
  // #216 r1): the plan line's last segment is the run chip's label.
  const price = priced ? proposalEstimateLabel(current.view) : null;
  const priceAt = price && plan.endsWith(` · ${price}`) ? plan.length - price.length : -1;
  const pendingKind = pending[current.view.id];

  const show = (entry: ProposalEntry) => {
    const { view } = entry;
    const drag = useCanvasProposalsStore.getState().drag[view.id];
    const boxes = ghostBoxes(view, drag);
    for (const nodeId of view.references) {
      const node = getInternalNode(nodeId);
      if (!node) continue;
      const { x, y } = node.internals.positionAbsolute;
      boxes.push({ x, y, width: node.measured?.width ?? 240, height: node.measured?.height ?? 160 });
    }
    if (boxes.length === 0) return;
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    void fitBounds(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      { padding: 0.25, duration: prefersReducedMotion() ? 0 : 400 },
    );
  };

  return (
    <InNoticeRegion slot="proposal">
      <div
        className="proposal-bar"
        tabIndex={-1}
        role="region"
        aria-label={`Proposal from ${current.view.agent.name}`}
        style={{ ['--agent-color' as string]: current.view.agent.color }}
        {...{ [SHRINK_ATTR]: '' }}
        {...leave.props}
        ref={cardRef}
      >
        <div className="proposal-bar__head" {...{ [SHRINK_HEAD_ATTR]: '' }}>
          <span className="proposal-bar__dot" aria-hidden="true" />
          {/* One line: a long name truncates; the region's label has it whole. */}
          <span className="proposal-bar__agent" title={current.view.agent.name} {...{ [SHRINK_NAME_ATTR]: '' }}>{current.view.agent.name}</span>
          <span className="proposal-bar__proposes">proposes</span>
          <span className="proposal-bar__aside">
            {open.length > 1 && (
              <span className="proposal-bar__pager">
                <button
                  type="button"
                  aria-label="Previous proposal"
                  onClick={() => page(-1)}
                >
                  <ChevronLeft size={12} aria-hidden="true" />
                </button>
                {position + 1} of {open.length}
                <button
                  type="button"
                  aria-label="Next proposal"
                  onClick={() => page(1)}
                >
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              </span>
            )}
            <span className="proposal-bar__expires">Expires in {countdown(current.view.expiresAt, now)}</span>
          </span>
        </div>
        {/* Inside the card's height cap the header and footer stay put and
            everything between scrolls as one body, with a 16 px fade on
            whichever edge hides content (GM - Design, PR #216 r2-r3). The
            wrapper draws the body's focus ring, outside the mask. */}
        <div className="proposal-bar__scroll" {...{ [SHRINK_BODY_ATTR]: '' }}>
          <div
            ref={bodyEl}
            className="proposal-bar__body"
            {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-label': 'Proposal details' } : {})}
          >
            <div className="proposal-bar__content">
              {/* The whole note reads first: up to six lines, then "Show all". */}
              <div className="proposal-bar__note-area">
                <p
                  ref={noteRef}
                  id={noteId}
                  className="proposal-bar__note"
                  data-long={noteLong ? 'true' : undefined}
                  data-open={noteOpen ? 'true' : undefined}
                >
                  {current.view.note}
                </p>
              </div>
              {noteLong && (
                <button
                  type="button"
                  className="proposal-bar__more"
                  aria-expanded={noteOpen}
                  aria-controls={noteId}
                  onClick={() => setNoteFor(noteOpen ? null : current.view.id)}
                >
                  {noteOpen ? 'Show less' : 'Show all'}
                </button>
              )}
              {plan && (
                // The line the card never gives up (GM r5): the region keeps it in view.
                <p className="proposal-bar__plan" {...{ [KEEP_ATTR]: '' }}>
                  {priceAt < 0 ? plan : (
                    <>
                      {plan.slice(0, priceAt)}
                      <span className="proposal-bar__price" title="List prices, not a quote">{price}</span>
                      {/* The title shows only on hover: screen readers get it as text. */}
                      <span className="proposal-bar__sr-only"> (list prices, not a quote)</span>
                    </>
                  )}
                </p>
              )}
              {notReady.length > 0 && (
                // Accept stays as the Run button does for a node without its
                // key: the run is refused at that node, before anything is spent.
                <ul className="proposal-bar__readiness" aria-label="Can't run here">
                  {notReady.slice(0, READINESS_LINES).map((row, index) => (
                    // The first ⚠ row is kept in view with the plan line (GM r6).
                    <li key={row.ref} className="proposal-bar__not-ready" {...(index === 0 ? { [KEEP_ATTR]: '' } : {})}>
                      <span className="proposal-bar__not-ready-mark" aria-hidden="true">&#x26A0;</span>
                      {notReadyLine(row)}
                    </li>
                  ))}
                  {moreNotReady && (
                    <li className="proposal-bar__not-ready proposal-bar__not-ready--more">
                      and {notReady.length - READINESS_LINES} more in the details
                    </li>
                  )}
                </ul>
              )}
              {hasDetails && (
                <button
                  type="button"
                  className="proposal-bar__disclosure"
                  aria-expanded={detailsOpen}
                  aria-controls={detailsId}
                  onClick={() => setDetailsFor(detailsOpen ? null : current.view.id)}
                >
                  <ChevronRight size={14} aria-hidden="true" className="proposal-bar__chevron" />
                  <span className="proposal-bar__disclosure-label">{detailsLabel}</span>
                  <span className="proposal-bar__disclosure-count">{detailsCount}</span>
                </button>
              )}
              {hasDetails && (
                // Mounted closed, so it opens in place on the layout spring
                // (interpolate-size) and aria-controls always names it.
                <div
                  id={detailsId}
                  className="proposal-bar__details-wrap"
                  data-open={detailsOpen ? 'true' : 'false'}
                  inert={!detailsOpen}
                >
                  {/* A named group, so its label reaches assistive tech (review 1 NIT-8). */}
                  <div className="proposal-bar__details" role="group" aria-label={detailsLabel}>
                    {priced && <p className="proposal-bar__quote">List prices, not a quote</p>}
                    {moreNotReady && (
                      <section className="proposal-bar__group">
                        <h3 className="proposal-bar__group-title">Can&apos;t run here</h3>
                        {notReady.map((row) => (
                          <p key={row.ref} className="proposal-bar__line">{notReadyLine(row)}</p>
                        ))}
                      </section>
                    )}
                    {hasChangeLines && changes.map((group) => (
                      <section key={group.id} className="proposal-bar__group">
                        <h3 className="proposal-bar__group-title">{group.title}</h3>
                        {group.wires ? (
                          // “Prompt” → “Second take” · Prompt, the port muted; removed ones struck through.
                          <ul className="proposal-bar__wires" data-kind={group.kind}>
                            {group.wires.map((wire) => (
                              <li key={wire.id} className="proposal-bar__wire">
                                {group.kind === 'unwired' && <span className="proposal-bar__sr-only">Removed: </span>}
                                <span className="proposal-bar__wire-ends">
                                  {wire.from}
                                  <span className="proposal-bar__arrow" aria-label="to"> → </span>
                                  {wire.to}
                                </span>
                                <span className="proposal-bar__wire-port"> · {wire.port}</span>
                              </li>
                            ))}
                          </ul>
                        ) : group.lines.length === 0 ? (
                          <p className="proposal-bar__line">default settings</p>
                        ) : (
                          <dl className="proposal-bar__lines">
                            {group.lines.map((line) => (
                              <div key={line.key} className="proposal-bar__line">
                                <dt>{line.key}</dt>
                                <dd>
                                  {line.from !== undefined && (
                                    <>
                                      <span className="proposal-bar__from">{line.from}</span>
                                      <span className="proposal-bar__arrow" aria-label="becomes"> → </span>
                                    </>
                                  )}
                                  <span className="proposal-bar__to">{line.to}</span>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </section>
                    ))}
                  </div>
                </div>
              )}
              {errorLeave.shown && (
                // A neutral line (a coded save-limit refusal) reads as a status, not an alert.
                isNeutralProposalLine(errorLeave.shown)
                  ? <p className="proposal-bar__error proposal-bar__error--neutral" role="status" {...errorLeave.props}><LineText text={errorLeave.shown} /></p>
                  : <p className="proposal-bar__error" role="alert" {...errorLeave.props}><LineText text={errorLeave.shown} /></p>
              )}
            </div>
          </div>
        </div>
        {/* The footer: always at the card's foot, never centred against the text. */}
        <div className="proposal-bar__footer" {...{ [SHRINK_FOOT_ATTR]: '' }}>
          <button
            type="button"
            className="proposal-bar__button proposal-bar__button--show"
            aria-label="Show"
            onClick={() => show(current)}
          >
            <Eye size={13} aria-hidden="true" />
            <span className="proposal-bar__show-label">Show</span>
          </button>
          <span className="proposal-bar__decide">
            <button
              type="button"
              className="proposal-bar__button"
              {...lock.act({ disabled: Boolean(pendingKind), kept: 'proposal' })}
              {...gate.control()}
              onClick={(event) => {
                if (gateHeld || !settled()) return;
                byKeyboard(event, 'reject');
                void reject(current.view.id);
              }}
            >
              {pendingKind === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            {/* The app's one primary button, never the agent's colour: it is
                the person's decision (GM - Design, 2026-11-01). */}
            <button
              type="button"
              className="proposal-bar__button proposal-bar__button--primary"
              {...lock.act({ disabled: Boolean(pendingKind), kept: 'proposal' })}
              {...gate.control()}
              onClick={(event) => {
                if (gateHeld || !settled()) return;
                byKeyboard(event, 'accept');
                void accept(current.view.id);
              }}
            >
              {pendingKind === 'accept' ? 'Accepting…' : acceptLabel(current.view)}
            </button>
          </span>
        </div>
        <PersonLockLine lock={gate} place="control" className="proposal-bar__held-line" />
      </div>
    </InNoticeRegion>
  );
}
