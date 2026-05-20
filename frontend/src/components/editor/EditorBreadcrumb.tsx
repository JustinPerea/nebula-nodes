import type { Node } from '@xyflow/react';

interface Props {
  sourceNode: Node;
  editNode: Node;
}

export function EditorBreadcrumb({ sourceNode, editNode }: Props) {
  const sourceLabel = (sourceNode.data as any).label ?? sourceNode.data.definitionId;
  const sourceIsVfr = Boolean((editNode.data as any).params?.sourceIsVfr);

  return (
    <>
      <div className="editor-breadcrumb">
        <span className="editor-breadcrumb__label">EDITING</span>
        <span className="editor-breadcrumb__source">{sourceLabel} · {sourceNode.id}</span>
        <span className="editor-breadcrumb__arrow">→</span>
        <span className="editor-breadcrumb__edit">{editNode.id}</span>
        <span className="editor-breadcrumb__shortcuts">⌘S save · ⎋ canvas</span>
      </div>
      {sourceIsVfr && (
        <div className="editor-breadcrumb__vfr">
          ⚠ Variable frame rate source — virtual preview may differ from rendered output. Use Render Preview to verify.
        </div>
      )}
    </>
  );
}
