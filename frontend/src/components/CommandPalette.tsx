import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import {
  buildCommands,
  filterCommands,
  PALETTE_GROUP_ORDER,
  type PaletteCommand,
} from '../lib/commandPalette';
import '../styles/command-palette.css';

/**
 * Global ⌘K / Ctrl+K command palette. Searches + inserts nodes, runs toolbar
 * actions, switches views/panels/skins, and hands a query to the agent. Mounted
 * once at the app root. It deliberately yields to the video/Remotion editor's
 * own Cmd+K (cut clip at playhead) by ignoring the hotkey in those views.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'commands' | 'agent'>('commands');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { screenToFlowPosition, fitView } = useReactFlow();
  const addNode = useGraphStore((s) => s.addNode);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const enterCreateView = useUIStore((s) => s.enterCreateView);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setSkin = useUIStore((s) => s.setSkin);

  const close = useCallback(() => {
    setOpen(false);
    setMode('commands');
    setQuery('');
    setSelected(0);
  }, []);

  const addNodeAtCenter = useCallback(
    (definitionId: string) => {
      const center = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      void addNode(definitionId, center);
    },
    [screenToFlowPosition, addNode]
  );

  const commands = useMemo(
    () =>
      buildCommands({
        addNodeAtCenter,
        runGraph: () => executeGraph(),
        save: () => window.dispatchEvent(new CustomEvent('nebula:save')),
        load: () => window.dispatchEvent(new CustomEvent('nebula:load')),
        fitView: () => fitView(),
        enterCreateView,
        togglePanel,
        setSkin,
        startAgentQuery: () => {
          setMode('agent');
          setQuery('');
        },
        canRun: nodeCount > 0 && !isExecuting,
      }),
    [addNodeAtCenter, executeGraph, fitView, enterCreateView, togglePanel, setSkin, nodeCount, isExecuting]
  );

  // Mirror `open` into a ref so the global hotkey handler stays subscribed once.
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Global hotkey. Read viewMode imperatively so we don't resubscribe; yield to
  // the editor's own Cmd+K. Resets happen here (in the handler), not in an effect.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        const vm = useUIStore.getState().viewMode;
        if (vm === 'editor' || vm === 'remotion-editor') return;
        e.preventDefault();
        if (openRef.current) {
          close();
        } else {
          setMode('commands');
          setQuery('');
          setSelected(0);
          setOpen(true);
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // Focus the input when the palette opens (DOM side effect only).
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const groups = useMemo(
    () =>
      PALETTE_GROUP_ORDER.map((group) => ({
        group,
        items: filtered.filter((c) => c.group === group),
      })).filter((g) => g.items.length > 0),
    [filtered]
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // Derive a safe selection at render rather than clamping via an effect.
  const safeSelected = flat.length === 0 ? 0 : Math.min(selected, flat.length - 1);

  const run = useCallback(
    (cmd: PaletteCommand | undefined) => {
      if (!cmd || cmd.enabled === false) return;
      close();
      cmd.perform();
    },
    [close]
  );

  const submitAgent = useCallback(() => {
    const message = query.trim();
    if (!message) return;
    window.dispatchEvent(new CustomEvent('nebula:chat-send', { detail: { message } }));
    close();
  }, [query, close]);

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (mode === 'agent') {
        setMode('commands');
        setQuery('');
      } else {
        close();
      }
      return;
    }
    if (mode === 'agent') {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAgent();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(flat[safeSelected]);
    }
  };

  if (!open) return null;

  const indexById = new Map(flat.map((c, i) => [c.id, i] as const));

  return createPortal(
    <div className="command-palette" onMouseDown={close}>
      <div className="command-palette__panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette__input"
          value={query}
          placeholder={mode === 'agent' ? 'Describe what to build, then Enter…' : 'Search commands and nodes…'}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onInputKeyDown}
        />
        {mode === 'agent' ? (
          <div className="command-palette__agent-hint">
            Enter sends to the agent · Esc to go back
          </div>
        ) : (
          <div className="command-palette__list">
            {flat.length === 0 && <div className="command-palette__empty">No matches</div>}
            {groups.map((g) => (
              <div key={g.group} className="command-palette__group">
                <div className="command-palette__group-label">{g.group}</div>
                {g.items.map((cmd) => {
                  const index = indexById.get(cmd.id) ?? 0;
                  const isSel = index === safeSelected;
                  const disabled = cmd.enabled === false;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      className={`command-palette__item${isSel ? ' command-palette__item--selected' : ''}${disabled ? ' command-palette__item--disabled' : ''}`}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => run(cmd)}
                      disabled={disabled}
                    >
                      <span className="command-palette__item-title">{cmd.title}</span>
                      {cmd.subtitle && (
                        <span className="command-palette__item-sub">{cmd.subtitle}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
