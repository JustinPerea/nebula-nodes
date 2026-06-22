import { useEffect, useRef, useState } from 'react';
import { X, Square, Trash2 } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import {
  formatRunAge,
  formatRunDuration,
  runTriggerLabel,
  type RunRecord,
} from '../../lib/runHistory';
import '../../styles/panels.css';
import '../../styles/run-history.css';

const STATUS_LABEL: Record<RunRecord['status'], string> = {
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Run History panel — a session-scoped, newest-first record of every graph /
 * single-node / selection run (status · duration · nodes · age). Cancel stops
 * the active run (reuses `resetExecution`, the existing cancel path); Clear
 * empties the list. Frontend-only (Phase 1 of g-queue-history-manager).
 */
export function RunHistoryPanel() {
  const visible = useUIStore((s) => s.panels.history.visible);
  const position = useUIStore((s) => s.panels.history.position);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);

  const runHistory = useGraphStore((s) => s.runHistory);
  const clearRunHistory = useGraphStore((s) => s.clearRunHistory);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const resetExecution = useGraphStore((s) => s.resetExecution);

  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Drag the panel by its header (mirrors NodeLibrary / Inspector).
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('history', { x: dragRef.current.panelX + dx, y: dragRef.current.panelY + dy });
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setPanelPosition]);

  // Keep relative ages fresh while the panel is open (1s tick). Cheap; only the
  // age labels re-derive. Skips entirely while hidden.
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [visible]);

  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);
  if (!shouldRender) return null;

  return (
    <div
      className={`panel panel--history${exiting ? ' panel--exiting' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="panel__header"
        onMouseDown={(e) => {
          dragRef.current = { startX: e.clientX, startY: e.clientY, panelX: position.x, panelY: position.y };
        }}
      >
        <span className="panel__title">Run History</span>
        <div className="run-history__header-actions">
          <button
            type="button"
            className="panel__header-action run-history__action"
            onClick={resetExecution}
            disabled={!isExecuting}
            aria-label="Cancel running execution"
            title={isExecuting ? 'Cancel running execution' : 'Nothing running'}
          >
            <Square size={13} strokeWidth={2} aria-hidden="true" focusable="false" />
          </button>
          <button
            type="button"
            className="panel__header-action run-history__action"
            onClick={clearRunHistory}
            disabled={runHistory.length === 0}
            aria-label="Clear run history"
            title="Clear run history"
          >
            <Trash2 size={13} strokeWidth={1.85} aria-hidden="true" focusable="false" />
          </button>
          <button
            type="button"
            className="panel__header-action panel__close"
            onClick={() => togglePanel('history')}
            aria-label="Close run history panel"
            title="Close"
          >
            <X className="panel__close-icon" size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </button>
        </div>
      </div>

      <div className="panel__body panel__body--history">
        {runHistory.length === 0 ? (
          <div className="run-history__empty">No runs yet this session.</div>
        ) : (
          <ul className="run-history__list">
            {runHistory.map((r) => (
              <li key={r.id} className="run-history__item">
                <span
                  className={`run-history__dot run-history__dot--${r.status}`}
                  aria-hidden="true"
                />
                <span className="run-history__meta">
                  <span className="run-history__row">
                    <span className="run-history__trigger">{runTriggerLabel(r.trigger)}</span>
                    <span className={`run-history__status run-history__status--${r.status}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </span>
                  <span className="run-history__sub">
                    {formatRunAge(now, r.startedAt)}
                    {r.status !== 'running' && r.durationSec != null && (
                      <> · {formatRunDuration(r.durationSec)}</>
                    )}
                    {r.nodesExecuted != null && (
                      <> · {r.nodesExecuted} node{r.nodesExecuted === 1 ? '' : 's'}</>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
