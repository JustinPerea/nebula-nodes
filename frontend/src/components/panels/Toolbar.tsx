import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);

  return (
    <div className="toolbar">
      <button
        className="toolbar__button"
        onClick={() => {
          alert('Execution not yet implemented — coming in Milestone 2');
        }}
        title="Run graph (Ctrl+Enter)"
      >
        ▶ Run
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => fitView({ padding: 0.2, duration: 300 })}
        title="Fit to screen"
      >
        Fit
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => togglePanel('library')}
        title="Toggle node library"
      >
        Nodes
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => {
          alert('Settings not yet implemented — coming in Milestone 4');
        }}
        title="Settings"
      >
        ⚙
      </button>
    </div>
  );
}
