import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { shotPortId } from '../../constants/ports';
import { sceneCardView } from '../../lib/cinemaScene';
import { cinemaSceneProblem, nodeCardBoundaryLine, studioBoundaryLogLine } from '../../lib/studioBoundary';
import '../../styles/node-card-boundary.css';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The handle ids a node has, read from its definition and whatever ports
 * its data still lists, so the wires into a card that can't draw stay drawn. */
function handleIds(data: Record<string, unknown>): { inputs: string[]; outputs: string[] } {
  const definitionId = typeof data.definitionId === 'string' ? data.definitionId : '';
  const definition = NODE_DEFINITIONS[definitionId];
  const ids = (ports: unknown) => (Array.isArray(ports) ? ports : [])
    .flatMap((port) => (isRecord(port) && typeof port.id === 'string' ? [port.id] : []));
  const inputs = [...ids(definition?.inputPorts), ...ids(data.dynamicInputPorts)];
  const outputs = [...ids(definition?.outputPorts), ...ids(data.dynamicOutputPorts)];
  if (definitionId === 'cinema-scene') {
    const params = isRecord(data.params) ? data.params : {};
    outputs.push(...sceneCardView(params.scene).shots.map((shot) => shotPortId(shot.id)));
  }
  return { inputs: [...new Set(inputs)], outputs: [...new Set(outputs)] };
}

interface NodeCardBoundaryProps {
  card: NodeProps;
  children: ReactNode;
}

/**
 * One canvas card that throws while it draws (a scene whose data is damaged,
 * PR #198 review 3, L4) shows GM's boundary line at card size instead of
 * taking the whole canvas down to a white screen. Its wires stay (its
 * handles are drawn from the node's definition and the ports its data
 * lists), the Agent log names the node and what it couldn't read, and the
 * card tries again as soon as its data changes (an undo, an agent's fix).
 */
export class NodeCardBoundary extends Component<NodeCardBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A node card failed to render:', error, info.componentStack);
    if (typeof window === 'undefined') return;
    const data = (this.props.card.data ?? {}) as Record<string, unknown>;
    let field: string | null = null;
    try {
      field = data.definitionId === 'cinema-scene'
        ? cinemaSceneProblem(isRecord(data.params) ? data.params : undefined) : null;
    } catch { field = null; }
    const label = typeof data.label === 'string' && data.label ? data.label : null;
    window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', {
      detail: { source: 'system', message: studioBoundaryLogLine(label, this.props.card.id, field) },
    }));
  }

  componentDidUpdate(previous: NodeCardBoundaryProps): void {
    if (this.state.failed && previous.card.data !== this.props.card.data) this.setState({ failed: false });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const data = (this.props.card.data ?? {}) as Record<string, unknown>;
    const label = typeof data.label === 'string' && data.label ? data.label : null;
    let handles: { inputs: string[]; outputs: string[] } = { inputs: [], outputs: [] };
    try { handles = handleIds(data); } catch { /* a card with no handles still says why */ }
    return (
      <div className={`node-card-boundary${this.props.card.selected ? ' node-card-boundary--selected' : ''}`}
        role="alert" data-node-card-boundary="">
        {handles.inputs.map((id) => (
          <Handle key={`in-${id}`} type="target" position={Position.Left} id={id} className="node-card-boundary__handle" />
        ))}
        <p className="node-card-boundary__line">{nodeCardBoundaryLine(label)}</p>
        {handles.outputs.map((id) => (
          <Handle key={`out-${id}`} type="source" position={Position.Right} id={id} className="node-card-boundary__handle" />
        ))}
      </div>
    );
  }
}
