import { useEffect, useRef, useState } from 'react';
import { Panel, useReactFlow } from '@xyflow/react';
import { ChevronDown, ChevronLeft, ChevronRight, Eye, Play, X } from 'lucide-react';
import {
  acceptLabel,
  countdown,
  GHOST_WIDTH,
  ghostHeight,
  ghostPosition,
  proposalChanges,
  proposalSummary,
} from '../../lib/canvasProposals';
import { useCanvasProposalsStore, type ProposalEntry } from '../../store/canvasProposalsStore';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/canvasProposals.css';

/** How long Accept/Reject ignore clicks after the shown proposal changes on its own. */
const SWITCH_GUARD_MS = 600;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
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
  const deferredRun = useCanvasProposalsStore((s) => s.deferredRun);
  const accept = useCanvasProposalsStore((s) => s.accept);
  const reject = useCanvasProposalsStore((s) => s.reject);
  const pruneExpired = useCanvasProposalsStore((s) => s.pruneExpired);
  const runDeferred = useCanvasProposalsStore((s) => s.runDeferred);
  const dismissDeferred = useCanvasProposalsStore((s) => s.dismissDeferred);
  const isExecuting = useGraphStore((s) => s.isExecuting);
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
  const current = open.find((entry) => entry.view.id === selectedId) ?? open[0];
  const currentId = current?.view.id ?? null;
  const position = current ? open.indexOf(current) : 0;

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

  if (open.length === 0 && !deferredRun) return null;

  const page = (step: number) => {
    const next = open[(position + step + open.length) % open.length];
    pagedTo.current = next.view.id;
    setSelectedId(next.view.id);
  };
  const settled = () => !guarding.current;
  const changes = current ? proposalChanges(current.view, current.values) : [];

  const show = (entry: ProposalEntry) => {
    const { view } = entry;
    const drag = useCanvasProposalsStore.getState().drag[view.id];
    const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const node of view.nodes) {
      const at = ghostPosition(view, node.ref, drag);
      if (at) boxes.push({ x: at.x, y: at.y, width: GHOST_WIDTH, height: ghostHeight(node) });
    }
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
    <Panel position="bottom-center" className="proposal-bar-panel">
      {current && (
        <div
          className="proposal-bar"
          role="region"
          aria-label={`Proposal from ${current.view.agent.name}`}
          style={{ ['--agent-color' as string]: current.view.agent.color }}
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
            <p className="proposal-bar__note">{current.view.note}</p>
            <p className="proposal-bar__summary">{proposalSummary(current.view)}</p>
            <p className="proposal-bar__meta">
              {current.view.run.length > 0 && current.view.cost.paidRuns > 0 ? 'No price list in Nebula · ' : ''}
              expires in {countdown(current.view.expiresAt, now)}
            </p>
            {changes.some((group) => group.lines.length > 0) && (
              <button
                type="button"
                className="proposal-bar__details-toggle"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((value) => !value)}
              >
                <ChevronDown size={12} aria-hidden="true" className="proposal-bar__chevron" />
                {detailsOpen ? 'Hide what Accept writes' : 'See what Accept writes'}
              </button>
            )}
            {detailsOpen && (
              <div className="proposal-bar__details" aria-label="What Accept writes">
                {changes.map((group) => (
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
            {errors[current.view.id] && (
              <p className="proposal-bar__error" role="alert">{errors[current.view.id]}</p>
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
              disabled={Boolean(pending[current.view.id])}
              onClick={() => {
                if (settled()) void reject(current.view.id);
              }}
            >
              <X size={13} aria-hidden="true" />
              {pending[current.view.id] === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            <button
              type="button"
              className="proposal-bar__button proposal-bar__button--primary"
              disabled={Boolean(pending[current.view.id])}
              onClick={() => {
                if (settled()) void accept(current.view.id);
              }}
            >
              {pending[current.view.id] === 'accept' ? 'Accepting…' : acceptLabel(current.view)}
            </button>
          </div>
        </div>
      )}
      {deferredRun && (
        <div className="proposal-bar proposal-bar--notice" role="status">
          <p className="proposal-bar__summary">
            Added {deferredRun.agentName}&apos;s nodes. Run them when the current run finishes.
          </p>
          <div className="proposal-bar__actions">
            <button
              type="button"
              className="proposal-bar__button proposal-bar__button--primary"
              disabled={isExecuting}
              onClick={() => void runDeferred()}
            >
              <Play size={13} aria-hidden="true" />
              Run
            </button>
            <button type="button" className="proposal-bar__button" aria-label="Dismiss" onClick={dismissDeferred}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
