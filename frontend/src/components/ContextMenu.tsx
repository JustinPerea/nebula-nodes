import { useEffect, useRef } from 'react';
import { useUIStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import '../styles/panels.css';

interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

export function ContextMenu() {
  const { visible, position, nodeId } = useUIStore((s) => s.contextMenu);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);
  const executeNode = useGraphStore((s) => s.executeNode);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const deleteNode = useGraphStore((s) => s.deleteNode);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!visible) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideContextMenu();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
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

  if (!visible || !nodeId) return null;

  const items: MenuItem[] = [
    {
      label: 'Run This Node',
      disabled: isExecuting,
      action: () => {
        executeNode(nodeId);
        hideContextMenu();
      },
    },
    {
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      action: () => {
        duplicateNode(nodeId);
        hideContextMenu();
      },
    },
    {
      label: 'Delete',
      shortcut: 'Del',
      danger: true,
      action: () => {
        deleteNode(nodeId);
        hideContextMenu();
      },
    },
  ];

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu__item ${item.danger ? 'context-menu__item--danger' : ''}`}
          onClick={item.action}
          disabled={item.disabled}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="context-menu__shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
