import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { NODE_RENAME_EVENT } from '../../lib/keyboardShortcuts';

interface NodeLabelProps {
  nodeId: string;
  label: string;
  /** The model's own name; shown as a hint once the node has a custom one. */
  displayName?: string;
}

/** A node's title. Double-click to rename; Enter or clicking away saves,
 * Escape cancels, and an empty name goes back to the model's name. */
export function NodeLabel({ nodeId, label, displayName }: NodeLabelProps) {
  const renameNode = useGraphStore((state) => state.renameNode);
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // F2 on the canvas asks the selected node to start renaming.
  useEffect(() => {
    const onRename = (event: Event) => {
      if ((event as CustomEvent<{ nodeId?: string }>).detail?.nodeId === nodeId) setDraft(label);
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
        maxLength={80}
        aria-label="Node name"
        placeholder={displayName}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
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
        setDraft(label);
      }}
    >
      {label}
    </span>
  );
}
