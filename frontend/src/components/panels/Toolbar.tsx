import { useEffect, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { saveToFile, loadFromFile } from '../../lib/graphFile';
import { fetchCLIGraph } from '../../lib/api';
import type { NodeData } from '../../types';
import type { Node } from '@xyflow/react';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView, getViewport } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const resetExecution = useGraphStore((s) => s.resetExecution);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  const handleSave = useCallback(async () => {
    const { nodes, edges } = useGraphStore.getState();
    const viewport = getViewport();
    await saveToFile(nodes as Node<NodeData>[], edges, viewport);
  }, [getViewport]);

  const handleLoad = useCallback(async () => {
    const result = await loadFromFile();
    if (!result) return; // User cancelled

    if (result.warnings.length > 0) {
      console.warn('[nebula] Load warnings:', result.warnings);
    }

    useGraphStore.getState().loadGraph(
      result.nodes as Node<NodeData>[],
      result.edges,
    );

    // Fit to loaded graph after a tick
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
  }, [fitView]);

  const handleClear = useCallback(() => {
    const { nodes } = useGraphStore.getState();
    const msg =
      nodes.length > 0
        ? `Clear the canvas and wipe cli_graph? ${nodes.length} node${nodes.length === 1 ? '' : 's'} will be removed. This can't be undone from here (save first if you want a copy).`
        : `Wipe cli_graph? This removes any phantom nodes from prior sessions.`;
    if (!window.confirm(msg)) return;
    useGraphStore.getState().clearGraph();
    // Also wipe the backend's in-memory cli_graph so Claude starts fresh and
    // nothing from prior sessions comes back on the next graphSync.
    fetch('http://localhost:8000/api/graph', { method: 'DELETE' }).catch(() => {});
  }, []);

  const handleImportCLI = useCallback(async () => {
    try {
      const data = await fetchCLIGraph();
      if (data.empty) {
        alert('CLI graph is empty — build one with the nebula CLI first.');
        return;
      }
      useGraphStore.getState().loadGraph(
        data.nodes as Node<NodeData>[],
        data.edges,
      );
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
    } catch {
      alert('Could not fetch CLI graph — is the backend running?');
    }
  }, [fitView]);

  // Listen for custom events from keyboard shortcuts (Ctrl+S, Ctrl+O)
  useEffect(() => {
    function onSave() {
      handleSave();
    }
    function onLoad() {
      handleLoad();
    }
    window.addEventListener('nebula:save', onSave);
    window.addEventListener('nebula:load', onLoad);
    return () => {
      window.removeEventListener('nebula:save', onSave);
      window.removeEventListener('nebula:load', onLoad);
    };
  }, [handleSave, handleLoad]);

  return (
    <div className="toolbar">
      {isExecuting ? (
        <button
          className="toolbar__button"
          onClick={() => resetExecution()}
          title="Cancel execution"
        >
          &#x25A0; Stop
        </button>
      ) : (
        <button
          className="toolbar__button"
          onClick={() => executeGraph()}
          disabled={nodeCount === 0}
          title="Run graph (Ctrl+Enter)"
        >
          {'\u25B6 Run'}
        </button>
      )}
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={handleSave} title="Save graph (Ctrl+S)">Save</button>
      <button className="toolbar__button" onClick={handleLoad} title="Load graph (Ctrl+O)">Load</button>
      <button className="toolbar__button" onClick={handleImportCLI} title="Import graph built by nebula CLI">CLI</button>
      <button className="toolbar__button" onClick={handleClear} title="Clear canvas and backend cli_graph">Clear</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => fitView({ padding: 0.2, duration: 300 })} title="Fit to screen">Fit</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('library')} title="Toggle node library">Nodes</button>
      <button className="toolbar__button" onClick={() => togglePanel('chat')} title="Toggle chat panel">Chat</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('settings')} title="Settings">{'\u2699'}</button>
    </div>
  );
}
