import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  return (
    <div className="toolbar">
      <button
        className="toolbar__button"
        onClick={() => executeGraph()}
        disabled={isExecuting || nodeCount === 0}
        title="Run graph (Ctrl+Enter)"
      >
        {isExecuting ? '... Running' : '\u25B6 Run'}
      </button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => fitView({ padding: 0.2, duration: 300 })} title="Fit to screen">Fit</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('library')} title="Toggle node library">Nodes</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => alert('Settings not yet implemented \u2014 coming in Milestone 4')} title="Settings">{'\u2699'}</button>
    </div>
  );
}
