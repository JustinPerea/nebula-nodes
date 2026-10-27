import { useEffect, useRef, useState } from 'react';
import { lastForeignToucher, useGraphStore } from '../../store/graphStore';
import { droppedRenameLine } from '../../lib/canvasUndo';
import { NODE_RENAME_EVENT } from '../../lib/keyboardShortcuts';
import { isBackendOffline, refuseEditWhileOffline } from '../../lib/backendConnection';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';

interface NodeLabelProps {
  nodeId: string;
  label: string;
  /** The model's own name; shown as a hint once the node has a custom one. */
  displayName?: string;
}

/** A node's title. Double-click to rename; Enter or clicking away saves,
 * Escape cancels, and an empty name goes back to the model's name.
 *
 * Offline (round 15 of PR #114, review 14 L5; GM: "no line. The draft keeps
 * its text and shows the same disabled styling as other fields"): a rename
 * can't start, and one being typed when the connection drops stays open with
 * its draft, disabled, until reconnect. Losing focus then doesn't save or
 * drop it; after reconnect Enter saves it and Escape cancels it.
 *
 * Round 16 (review 15 nit): on reconnect the draft gets focus back, unless an
 * agent renamed the node meanwhile. Then the draft is dropped, so the
 * agent's name isn't overwritten, and GM's toast says so (no refocus). */
export function NodeLabel({ nodeId, label, displayName }: NodeLabelProps) {
  const renameNode = useGraphStore((state) => state.renameNode);
  const readOnly = useBackendOffline();
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** The name when this rename started: a different one on reconnect means
   * someone else renamed the node while the tab was offline. */
  const startedFrom = useRef(label);
  const wasReadOnly = useRef(readOnly);
  const begin = () => { startedFrom.current = label; setDraft(label); };

  useEffect(() => {
    const reconnected = wasReadOnly.current && !readOnly;
    wasReadOnly.current = readOnly;
    if (!reconnected || draft === null) return;
    if (label !== startedFrom.current) {
      useGraphStore.getState().notify(droppedRenameLine(lastForeignToucher(nodeId), label, draft), 'info');
      setDraft(null);
      return;
    }
    inputRef.current?.focus();
    // Only on the offline-to-online flip; the draft and label are read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // F2 on the canvas asks the selected node to start renaming.
  useEffect(() => {
    const onRename = (event: Event) => {
      if ((event as CustomEvent<{ nodeId?: string }>).detail?.nodeId !== nodeId) return;
      if (refuseEditWhileOffline()) return;
      startedFrom.current = label;
      setDraft(label);
    };
    window.addEventListener(NODE_RENAME_EVENT, onRename);
    return () => window.removeEventListener(NODE_RENAME_EVENT, onRename);
  }, [nodeId, label]);

  useEffect(() => {
    if (draft === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    // Only on entering edit mode, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft === null]);

  if (draft !== null) {
    const finish = (save: boolean) => {
      if (save) renameNode(nodeId, draft);
      setDraft(null);
    };
    return (
      <input
        ref={inputRef}
        className="model-node__label model-node__label-input nodrag nopan"
        value={draft}
        disabled={readOnly}
        {...offlineMark(readOnly)}
        maxLength={80}
        aria-label="Node name"
        placeholder={displayName}
        onChange={(event) => setDraft(event.target.value)}
        // Offline, the field is disabled and loses focus: keep the draft.
        onBlur={() => { if (!isBackendOffline()) finish(true); }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') finish(true);
          else if (event.key === 'Escape') finish(false);
        }}
      />
    );
  }

  const custom = displayName && label !== displayName;
  return (
    <span
      className="model-node__label"
      title={custom ? `${displayName} · double-click to rename` : 'Double-click to rename'}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (refuseEditWhileOffline()) return;
        begin();
      }}
    >
      {label}
    </span>
  );
}
