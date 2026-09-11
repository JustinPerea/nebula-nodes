import { useMemo, useState } from 'react';
import {
  Copy,
  Download,
  Files,
  LayoutGrid,
  MessageCircle,
  Play,
  Trash2,
} from 'lucide-react';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import {
  collectDownloadableOutputs,
  downloadSelectedOutputs,
  selectedNodeIds,
} from '../lib/canvasSelection';


export function SelectionToolbar() {
  const nodes = useGraphStore((state) => state.nodes);
  const isExecuting = useGraphStore((state) => state.isExecuting);
  const executeNode = useGraphStore((state) => state.executeNode);
  const executeCluster = useGraphStore((state) => state.executeCluster);
  const copySelected = useGraphStore((state) => state.copySelected);
  const duplicateSelected = useGraphStore((state) => state.duplicateSelected);
  const autoLayoutSelected = useGraphStore((state) => state.autoLayoutSelected);
  const deleteSelected = useGraphStore((state) => state.deleteSelected);
  const chatVisible = useUIStore((state) => state.panels.chat.visible);
  const togglePanel = useUIStore((state) => state.togglePanel);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const ids = useMemo(() => selectedNodeIds(nodes), [nodes]);
  const outputCount = useMemo(
    () => collectDownloadableOutputs(selectedNodes).length,
    [selectedNodes],
  );
  if (ids.length === 0) return null;

  function openAgent() {
    if (!chatVisible) togglePanel('chat');
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('.chat-panel__textarea')?.focus();
    }, chatVisible ? 0 : 180);
  }

  async function downloadOutputs() {
    if (downloading || outputCount === 0) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadSelectedOutputs(selectedNodes);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading(false);
    }
  }

  function removeSelection() {
    const noun = ids.length === 1 ? 'node' : 'nodes';
    if (window.confirm(`Delete ${ids.length} selected ${noun}?`)) deleteSelected();
  }

  function runSelection() {
    if (ids.length === 1) {
      // Use the established target-node path so the backend derives the
      // authoritative target-plus-ancestors closure from the full graph.
      // Sending a one-node "cluster" drops visible inputs such as the Text
      // Input feeding a World Labs Environment and fails preflight instead.
      void executeNode(ids[0]);
      return;
    }
    void executeCluster(ids);
  }

  return (
    <div
      className="selection-toolbar nodrag nopan"
      role="toolbar"
      aria-label={`Actions for ${ids.length} selected ${ids.length === 1 ? 'node' : 'nodes'}`}
      data-selected-count={ids.length}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="selection-toolbar__count">
        {ids.length} selected
      </span>
      <span className="selection-toolbar__divider" aria-hidden="true" />
      <button type="button" className="selection-toolbar__button" onClick={openAgent} title="Ask agent about selection">
        <MessageCircle size={17} aria-hidden="true" />
        <span>Ask</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button selection-toolbar__button--primary"
        onClick={runSelection}
        disabled={isExecuting}
        title="Run selected nodes"
      >
        <Play size={17} fill="currentColor" aria-hidden="true" />
        <span>Run</span>
      </button>
      <button type="button" className="selection-toolbar__button" onClick={copySelected} title="Copy selected nodes">
        <Copy size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Copy</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button"
        onClick={duplicateSelected}
        disabled={isExecuting}
        title={isExecuting ? 'Wait for the active run to finish' : 'Duplicate selected nodes'}
      >
        <Files size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Duplicate</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button"
        onClick={autoLayoutSelected}
        disabled={ids.length < 2 || isExecuting}
        title="Arrange selected nodes"
      >
        <LayoutGrid size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Arrange</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button"
        onClick={() => void downloadOutputs()}
        disabled={downloading || outputCount === 0}
        title={
          downloadError
            ? downloadError
            : outputCount === 0
              ? 'No downloadable outputs in selection'
              : `Download ${outputCount} selected ${outputCount === 1 ? 'output' : 'outputs'}`
        }
        aria-label={downloading ? 'Downloading selected outputs' : 'Download selected outputs'}
      >
        <Download size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Download</span>
      </button>
      <span className="selection-toolbar__divider" aria-hidden="true" />
      <button
        type="button"
        className="selection-toolbar__button selection-toolbar__button--danger"
        onClick={removeSelection}
        disabled={isExecuting}
        title={isExecuting ? 'Wait for the active run to finish' : 'Delete selected nodes'}
        aria-label="Delete selected nodes"
      >
        <Trash2 size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
