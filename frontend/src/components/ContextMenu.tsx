import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useUIStore } from '../store/uiStore';
import { sceneDeleteDisabledTitle, useGraphStore } from '../store/graphStore';
import { useCanvasPinsStore } from '../store/canvasPinsStore';
import { isBackendNodeId } from '../lib/canvasPins';
import { floatingBottomLimit } from '../lib/bottomBar';
import { useCanvasLock } from '../lib/canvasLock';
import '../styles/panels.css';
import { keyBlockedByModal } from '../lib/canvasShortcutScope';
import { runKeyLockLine, withKeyLock } from '../lib/runKeyLock';

/** How close the menu may come to the window's edges. */
const MENU_EDGE = 8;

interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled, when that isn't offline; e.g. why Run is disabled. */
  title?: string;
  /** This tab's run locks it now: the run's line wins (lib/canvasLock). */
  run?: boolean;
  /** Locked by a missing key, when nothing else holds it (withKeyLock). */
  keyLock?: string | null;
  action: () => void;
}

export function ContextMenu() {
  const { visible, position, nodeId, flowPosition } = useUIStore((s) => s.contextMenu);
  const composeNote = useCanvasPinsStore((s) => s.compose);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);
  const executeNode = useGraphStore((s) => s.executeNode);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const deleteNode = useGraphStore((s) => s.deleteNode);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  // A scene with a shot rendering can't be deleted yet (GM, PR #198 r3 item 1).
  const sceneHeld = useGraphStore((s) => (nodeId ? sceneDeleteDisabledTitle(s, [nodeId]) : null));
  // A run waiting for its inputs counts as starting (review 15, M-B).
  const runStarting = useGraphStore((s) => s.runStarting);
  // Offline is read-only (round 15 of PR #114), and so is following an
  // agent's switch (GM round 22, A: one state, lib/canvasLock): every item
  // here edits, so each is disabled and looks it, with "Wait for “<project>”
  // to open." while following.
  const lock = useCanvasLock();
  const graphNodes = useGraphStore((s) => s.nodes);
  const graphEdges = useGraphStore((s) => s.edges);
  const keyLockId = useId();
  const settingsCache = useUIStore((s) => s.settingsCache);
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Opened at the pointer, then kept whole: inside the window and above the
  // canvas's bottom bar (the Inspector's bug, GM - Design 2026-10-23), so its
  // last item (Delete) is never cut off or under the bar.
  useLayoutEffect(() => {
    if (!visible) return;
    const measure = () => {
      const box = menuRef.current?.getBoundingClientRect();
      if (!box) return;
      const left = Math.max(MENU_EDGE, Math.min(position.x, window.innerWidth - box.width - MENU_EDGE));
      // The Canvas actions panel pushes it up only when it is over the panel (lib/bottomBar.ts).
      const bottom = floatingBottomLimit(MENU_EDGE, window.innerHeight, { left, right: left + box.width });
      setPlace({ left, top: Math.max(MENU_EDGE, Math.min(position.y, bottom - box.height)) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [visible, position, nodeId]);
  const style = { left: place?.left ?? position.x, top: place?.top ?? position.y };

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!visible) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideContextMenu();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      // A modal dialog over the menu owns Escape (review 8, L-d).
      if (e.key === 'Escape' && !keyBlockedByModal(menuRef.current)) {
        hideContextMenu();
      }
    }

    // Use setTimeout to avoid the same click that opened the menu from closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, hideContextMenu]);

  if (!visible) return null;
  if (!nodeId) {
    // Right-click on the empty canvas: the only thing to do here is leave a note.
    if (!flowPosition) return null;
    return (
      <div ref={menuRef} className="context-menu" style={style}>
        <button
          className="context-menu__item"
          {...lock.act()}
          onClick={() => {
            composeNote({ position: flowPosition });
            hideContextMenu();
          }}
        >
          <span>Leave a note for agents here…</span>
        </button>
      </div>
    );
  }

  // A node that can't run without its key (Idol's Hugging Face token), this
  // one or one feeding it: locked as the other Runs are (withKeyLock).
  const keyLock = runKeyLockLine(graphNodes, graphEdges, { kind: 'node', nodeId }, settingsCache);
  const items: MenuItem[] = [
    {
      label: 'Run This Node',
      // The run lock's line wins (M2): run, follow, offline; then the key (withKeyLock).
      run: isExecuting || runStarting,
      keyLock,
      action: () => {
        if (keyLock) return;
        executeNode(nodeId);
        hideContextMenu();
      },
    },
    {
      label: 'Leave a note for agents…',
      // Agents only see nodes the backend knows (ids like n4).
      disabled: !isBackendNodeId(nodeId),
      action: () => {
        composeNote({ nodeId });
        hideContextMenu();
      },
    },
    {
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      run: isExecuting,
      action: () => {
        duplicateNode(nodeId);
        hideContextMenu();
      },
    },
    {
      label: 'Delete',
      shortcut: 'Del',
      danger: true,
      run: isExecuting,
      disabled: sceneHeld !== null,
      title: sceneHeld ?? undefined,
      action: () => {
        // A World Labs hold refuses, with its notice; otherwise it deletes at
        // once and says "Deleted the node." with Undo (GM, 2026-10-23).
        if (useGraphStore.getState().allowCanvasDelete([nodeId])) deleteNode(nodeId);
        hideContextMenu();
      },
    },
  ];

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={style}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu__item ${item.danger ? 'context-menu__item--danger' : ''}`}
          onClick={item.action}
          {...withKeyLock(lock.act({ disabled: item.disabled, title: item.title }, { run: item.run }), item.keyLock, keyLockId)}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="context-menu__shortcut">{item.shortcut}</span>}
        </button>
      ))}
      {keyLock && <span id={keyLockId} className="toolbar__sr-only">{keyLock}</span>}
    </div>
  );
}
