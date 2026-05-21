import type { Node } from '@xyflow/react';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import type { NodeData } from '../../types';

interface Props {
  sourceNode: Node<NodeData>;
  editNode: Node<NodeData>;
}

export function EditorBreadcrumb({ sourceNode, editNode }: Props) {
  const sourceLabel = sourceNode.data.label ?? sourceNode.data.definitionId;
  const sourceIsVfr = Boolean(editNode.data.params.sourceIsVfr);

  return (
    <>
      <div className="editor-breadcrumb">
        <span className="editor-breadcrumb__label">EDITING</span>
        <span className="editor-breadcrumb__source">{sourceLabel} · {sourceNode.id}</span>
        <ArrowRight className="editor-breadcrumb__arrow" aria-hidden="true" focusable="false" />
        <span className="editor-breadcrumb__edit">{editNode.id}</span>
      </div>
      {sourceIsVfr && (
        <div className="editor-breadcrumb__vfr">
          <TriangleAlert className="editor-breadcrumb__vfr-icon" aria-hidden="true" focusable="false" />
          <span>Variable frame rate source. Render Preview is the source of truth.</span>
        </div>
      )}
    </>
  );
}
