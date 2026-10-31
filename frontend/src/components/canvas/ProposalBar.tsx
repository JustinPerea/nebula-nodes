import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronDown, ChevronLeft, ChevronRight, Eye, X } from 'lucide-react';
import {
  acceptLabel,
  countdown,
  ghostBoxes,
  notReadyLine,
  proposalChanges,
  proposalSummary,
} from '../../lib/canvasProposals';
import { useProposalNotReady } from '../../hooks/useProposalReadiness';
import { useCanvasProposalsStore, type ProposalEntry } from '../../store/canvasProposalsStore';
import { InNoticeRegion } from '../InNoticeRegion';
import '../../styles/canvasProposals.css';
import { useCanvasLock } from '../../lib/canvasLock';
import { useLeave } from '../../lib/noticeLeave';
import { PersonLockLine } from '../PersonLock';
import { usePersonLock } from '../../hooks/usePersonLock';
import { LineText } from '../LineText';

/** How long Accept/Reject ignore clicks after the shown proposal changes on its own. */
const SWITCH_GUARD_MS = 600;
/** Not-ready lines the bar shows before the rest move to the details. */
const READINESS_LINES = 3;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Whether the note's three-line clamp hides some of it, so the bar can
 * offer the whole note in its details. Measured when the note changes (a
 * new observer reports at once) and whenever the bar's width does.
 */
function useClamped(note: string | undefined): [RefObject<HTMLParagraphElement | null>, boolean] {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setClamped(el.scrollHeight > el.clientHeight + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [note]);
  return [ref, clamped && Boolean(note)];
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const shownId = useRef<string | null>(null);
  const pagedTo = useRef<string | null>(null);
  const guarding = useRef(false);

  // Oldest first, so new arrivals join the end of the pager.
  const open: ProposalEntry[] = Object.values(proposals)
    .filter((entry) => !entry.closing)
    .sort((a, b) => a.view.createdAt - b.view.createdAt || a.view.id.localeCompare(b.view.id));
  const now = useNow(open.length > 0);
  const live = open.find((entry) => entry.view.id === (focusedId ?? selectedId)) ?? open[0];
  // The bar leaves as it entered, a surface (fix round 7 of PR #200, GM r11
  // answer 2): the last proposal stays drawn, inert, until its scale-out
  // ends. Its inline error line leaves as a row.
  const leave = useLeave(live ?? null);
  const current = leave.shown ?? undefined;
  const errorLeave = useLeave(live ? errors[live.view.id] ?? null : null, 'row');
  const currentId = live?.view.id ?? null;
  const position = live ? open.indexOf(live) : 0;
  const notReady = useProposalNotReady(current);
  const [noteRef, noteClamped] = useClamped(current?.view.note);

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
  const changes = current ? proposalChanges(current.view, current.values) : [];
  const hasChangeLines = changes.some((group) => group.lines.length > 0);
  const moreNotReady = notReady.length > READINESS_LINES;
  const hasDetails = hasChangeLines || noteClamped || moreNotReady;
  const detailsLabel = hasChangeLines
    ? (detailsOpen ? 'Hide what Accept writes' : 'See what Accept writes')
    : noteClamped
      ? (detailsOpen ? 'Hide the note' : 'Read the whole note')
      : (detailsOpen ? 'Hide the list' : "See every node that can't run");

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
        {...leave.props}
      >
        <div className="proposal-bar__main">
          <div className="proposal-bar__who">
            <span className="proposal-bar__dot" aria-hidden="true" />
            <span className="proposal-bar__agent">{current.view.agent.name}</span>
            <span className="proposal-bar__proposes">proposes</span>
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
          </div>
          <p ref={noteRef} className="proposal-bar__note">{current.view.note}</p>
          <p className="proposal-bar__summary">{proposalSummary(current.view)}</p>
          {notReady.length > 0 && (
            // Accept stays as the Run button does for a node without its
            // key: the run is refused at that node, before anything is spent.
            <ul className="proposal-bar__readiness" aria-label="Can't run here">
              {notReady.slice(0, READINESS_LINES).map((row) => (
                <li key={row.ref} className="proposal-bar__not-ready">
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
          <p className="proposal-bar__meta">
            {current.view.run.length > 0 && current.view.cost.paidRuns > 0
              ? (current.view.cost.estimate ? 'List prices, not a quote · ' : 'No list price · ')
              : ''}
            expires in {countdown(current.view.expiresAt, now)}
          </p>
          {hasDetails && (
            <button
              type="button"
              className="proposal-bar__details-toggle"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((value) => !value)}
            >
              <ChevronDown size={12} aria-hidden="true" className="proposal-bar__chevron" />
              {detailsLabel}
            </button>
          )}
          {detailsOpen && hasDetails && (
            <div className="proposal-bar__details" aria-label={hasChangeLines ? 'What Accept writes' : 'Details'}>
              {noteClamped && (
                <section className="proposal-bar__group">
                  <h3 className="proposal-bar__group-title">Note</h3>
                  <p className="proposal-bar__note-full">{current.view.note}</p>
                </section>
              )}
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
                  {group.lines.length === 0 ? (
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
          )}
          {errorLeave.shown && (
            <p className="proposal-bar__error" role="alert" {...errorLeave.props}><LineText text={errorLeave.shown} /></p>
          )}
        </div>
        <div className="proposal-bar__actions">
          <button
            type="button"
            className="proposal-bar__button"
            onClick={() => show(current)}
          >
            <Eye size={13} aria-hidden="true" />
            Show
          </button>
          <button
            type="button"
            className="proposal-bar__button"
            {...lock.act({ disabled: Boolean(pending[current.view.id]) })}
            {...gate.control()}
            onClick={() => {
              if (gateHeld) return;
              if (settled()) void reject(current.view.id);
            }}
          >
            <X size={13} aria-hidden="true" />
            {pending[current.view.id] === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
          <button
            type="button"
            className="proposal-bar__button proposal-bar__button--primary"
            {...lock.act({ disabled: Boolean(pending[current.view.id]) })}
            {...gate.control()}
            onClick={() => {
              if (gateHeld) return;
              if (settled()) void accept(current.view.id);
            }}
          >
            {pending[current.view.id] === 'accept' ? 'Accepting…' : acceptLabel(current.view)}
          </button>
        </div>
        <PersonLockLine lock={gate} place="control" className="proposal-bar__held-line" />
      </div>
    </InNoticeRegion>
  );
}
