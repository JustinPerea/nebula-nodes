import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import {
  buildCommands,
  filterCommands,
  PALETTE_GROUP_ORDER,
  type PaletteCommand,
} from '../lib/commandPalette';
import { findAvailableNodePosition, type NodePosition } from '../lib/nodePlacement';
import { computeCanvasFitPadding } from '../lib/canvasFit';
import { useFitCanvasView } from '../hooks/useFitCanvasView';
import { canLoadGraph, canSaveGraph, requestGraphLoad, requestGraphSave } from '../lib/graphFileActions';
import { COMMAND_PALETTE_OPEN_EVENT, isPaletteHotkey, paletteOpenRequestApplies } from '../lib/commandPaletteKeys';
import { claimIntent } from '../lib/heldIntents';
import { returnFocusOnSlip } from '../lib/modalFocus';
import { ModalPortal } from './ModalPortal';
import '../styles/command-palette.css';

const NO_NODE_FIELDS: readonly string[] = Object.freeze([]);
const NO_COMMANDS: PaletteCommand[] = [];

/**
 * Global ⌘K / Ctrl+K command palette. Searches + inserts nodes, runs toolbar
 * actions, switches views/panels, and hands a query to the agent. Mounted
 * once at the app root. It deliberately yields to the video/Remotion editor's
 * own Cmd+K (cut clip at playhead) by ignoring the hotkey in those views.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'commands' | 'agent'>('commands');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [reservedInsertPositions, setReservedInsertPositions] = useState<NodePosition[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const { screenToFlowPosition, fitView } = useReactFlow();
  // Fit view includes an open proposal's ghosts.
  const fitCanvasView = useFitCanvasView();
  const addNode = useGraphStore((s) => s.addNode);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isImportingGraph = useGraphStore((s) => s.isImportingGraph);
  const canSave = useGraphStore(canSaveGraph);
  const canLoad = useGraphStore(canLoadGraph);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const enterCreateView = useUIStore((s) => s.enterCreateView);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const selectNode = useUIStore((s) => s.selectNode);
  // Canvas nodes for search-and-focus, read only while the palette is open
  // and only their ids and labels: the closed palette (always mounted) used
  // to rebuild every command, model search text included, on each graph
  // change, a run's progress events too.
  const canvasNodeFields = useGraphStore(useShallow((s) => (open
    ? s.nodes.flatMap((n) => [n.id, (typeof n.data?.label === 'string' && n.data.label) || n.data?.definitionId || n.id])
    : NO_NODE_FIELDS)));

  // Mirrors `open` for the global hotkey handler, which subscribes once. The
  // handlers that open and close set it at once, so a ⌘K right after the
  // palette opens closes it instead of opening it again before an effect runs.
  const openRef = useRef(false);

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setMode('commands');
    setQuery('');
    setSelected(0);
  }, []);

  const addNodeAtCenter = useCallback(
    (definitionId: string) => {
      const currentNodes = useGraphStore.getState().nodes;
      // Prune reservations that have materialized into graph state, then keep
      // the remaining in-flight slots for consecutive palette additions.
      const pendingReservations = reservedInsertPositions.filter(
        (reserved) => !currentNodes.some((node) => (
          Math.abs(node.position.x - reserved.x) < 1
          && Math.abs(node.position.y - reserved.y) < 1
        )),
      );
      const preferred = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const position = findAvailableNodePosition(
        preferred,
        [
          ...currentNodes.map((node) => node.position),
          ...pendingReservations,
        ],
      );
      setReservedInsertPositions([...pendingReservations, position]);
      void addNode(definitionId, position);
    },
    [screenToFlowPosition, addNode, reservedInsertPositions]
  );

  // Existing canvas nodes, for search-and-focus (the "canvas search" affordance).
  const canvasNodes = useMemo(() => {
    const pairs: Array<{ id: string; label: string }> = [];
    for (let i = 0; i < canvasNodeFields.length; i += 2) pairs.push({ id: canvasNodeFields[i], label: canvasNodeFields[i + 1] });
    return pairs;
  }, [canvasNodeFields]);

  const focusNode = useCallback(
    (id: string) => {
      void fitView({ nodes: [{ id }], padding: computeCanvasFitPadding(), duration: 400, maxZoom: 1.5 });
      selectNode(id);
    },
    [fitView, selectNode]
  );

  const commands = useMemo(
    () => !open ? NO_COMMANDS :
      buildCommands({
        addNodeAtCenter,
        runGraph: () => executeGraph(),
        save: requestGraphSave,
        load: requestGraphLoad,
        fitView: () => fitCanvasView(300),
        enterCreateView,
        togglePanel,
        startAgentQuery: () => {
          setMode('agent');
          setQuery('');
        },
        canRun: nodeCount > 0 && !isExecuting && !isImportingGraph,
        canSave,
        canLoad,
        canvasNodes,
        focusNode,
      }),
    [open, addNodeAtCenter, executeGraph, fitCanvasView, enterCreateView, togglePanel, nodeCount, isExecuting, isImportingGraph, canSave, canLoad, canvasNodes, focusNode]
  );

  // And kept in step with `open` after every render.
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Global hotkey. Read viewMode imperatively so we don't resubscribe; yield to
  // the editor's own Cmd+K. Resets happen here (in the handler), not in an effect.
  // This palette is a deferred chunk: a ⌘K or a rail open that came before it
  // arrived was held by its wrapper (DeferredPanels.tsx) and is handed over
  // here, where the palette takes the hotkey over (lib/heldIntents.ts).
  useEffect(() => {
    const openPalette = () => {
      setMode('commands');
      setQuery('');
      setSelected(0);
      openRef.current = true;
      setOpen(true);
    };
    function onKey(e: KeyboardEvent) {
      // The open palette is a modal dialog itself: its own ⌘K closes it,
      // unless another modal dialog is on top of it (review 9, L-1).
      if (!isPaletteHotkey(e, openRef.current ? dialogRef.current : null)) return;
      e.preventDefault();
      if (openRef.current) close();
      else openPalette();
    }
    function onOpenRequest() {
      if (paletteOpenRequestApplies()) openPalette();
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
    const claim = claimIntent('command-palette');
    if (claim.held) openPalette();
    return () => {
      claim.release();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
    };
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

  // Escape leaves the agent prompt, else closes the palette: from the field
  // and, through the dialog (review 10, L-1), from anything else in it.
  const escape = () => {
    if (mode === 'agent') {
      setMode('commands');
      setQuery('');
      inputRef.current?.focus();
    } else {
      close();
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      escape();
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

  // Review 9, L-1: it covers the window, so it is a modal dialog. Focus stays
  // in it: Tab wraps, and a click on its text (a group label) that drops focus
  // on the page brings it back to the search field, so no canvas key (Delete,
  // ⌘Enter, ⌘Z) acts on the graph behind it (lib/canvasShortcutScope.ts).
  // Review 10, L-1: keys with focus on an item (or "Clear search") were lost,
  // since only the field read them. Escape works as from the field; the arrows
  // move the active item, as from the field, and focus with it, passing over
  // an item that can't take focus and stopping at the ends.
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target === inputRef.current && (e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      escape();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('.command-palette__item') ?? [])];
      const at = items.indexOf(e.target as HTMLButtonElement);
      if (at < 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let next = at + step;
      while (next >= 0 && next < items.length && items[next].disabled) next += step;
      if (next < 0 || next >= items.length) return;
      items[next].focus();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])];
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <ModalPortal>
    <div ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Search commands and nodes"
      onMouseDown={close} onKeyDown={onDialogKeyDown} onBlur={(e) => returnFocusOnSlip(e, () => inputRef.current)}>
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
            {flat.length === 0 && <div className="command-palette__empty">
              <p role="status">No commands or nodes match “{query}”.</p>
              <p>Try a provider, model name or task such as “animate a logo”.</p>
              <button type="button" onClick={() => { setQuery(''); setSelected(0); inputRef.current?.focus(); }}>Clear search</button>
            </div>}
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
                      onFocus={() => setSelected(index)}
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
    </div>
    </ModalPortal>
  );
}
