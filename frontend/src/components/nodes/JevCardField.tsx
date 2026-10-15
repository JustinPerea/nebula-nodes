import { useId } from 'react';
import type { ModelNodeDefinition } from '../../types';
import { useGraphStore } from '../../store/graphStore';
import type { JevCardField as JevCardFieldSpec } from '../../lib/jevView';

interface JevCardFieldProps {
  nodeId: string;
  definition: ModelNodeDefinition;
  field: JevCardFieldSpec;
  params: Record<string, unknown>;
  /** A wired input port of the same name, whose text the handler uses first. */
  portWired?: boolean;
  portLabel?: string;
}

// Typing here must stay in the field: the key and mouse handlers keep
// Backspace/Delete and shortcuts away from the canvas (React Flow already
// skips its delete key inside form fields, the app's own window listeners
// don't), and nodrag/nowheel stop React Flow dragging the node or zooming.
const stop = (event: React.SyntheticEvent) => event.stopPropagation();

/** The Jev setting you type on the card face: Decide and Pick Best's question,
 * Box's target. It writes the node param through updateNodeData, the same
 * path the Inspector uses, so the two always show the same value. */
export function JevCardField({ nodeId, definition, field, params, portWired = false, portLabel }: JevCardFieldProps) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const inputId = useId();
  const param = definition.params.find((p) => p.key === field.key);
  const value = typeof params[field.key] === 'string' ? (params[field.key] as string) : '';
  const placeholder = param?.placeholder ?? (typeof param?.default === 'string' ? param.default : '');

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    event.stopPropagation();
    updateNodeData(nodeId, { params: { ...params, [field.key]: event.target.value } });
  };

  const shared = {
    id: inputId,
    value,
    onChange,
    onKeyDown: stop,
    onMouseDown: stop,
    onPointerDown: stop,
    placeholder,
    spellCheck: true,
  };

  return (
    <div className={`model-node__inline-textarea model-node__jev-field${field.multiline ? '' : ' model-node__jev-field--single'}`}>
      <label className="model-node__jev-field-label" htmlFor={inputId}>{field.label}</label>
      {field.multiline ? (
        <textarea {...shared} className="model-node__textarea model-node__jev-input nodrag nowheel" rows={2} />
      ) : (
        <input {...shared} type="text" className="model-node__textarea model-node__jev-input nodrag nowheel" />
      )}
      {portWired && (
        <span className="model-node__jev-field-note">Used when the {portLabel ?? field.label} input is empty</span>
      )}
    </div>
  );
}
