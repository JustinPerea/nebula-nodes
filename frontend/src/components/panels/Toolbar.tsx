import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const resetExecution = useGraphStore((s) => s.resetExecution);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);

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
      <button className="toolbar__button" onClick={() => fitView({ padding: 0.2, duration: 300 })} title="Fit to screen">Fit</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('library')} title="Toggle node library">Nodes</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('settings')} title="Settings">{'\u2699'}</button>
    </div>
  );
}
