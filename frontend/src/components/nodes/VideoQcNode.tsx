import { memo, type ComponentProps } from 'react';
import { ModelNode } from './ModelNode';

/**
 * Shared canvas renderer for all Video QC analyzers.
 *
 * ModelNode already provides the two surfaces the QC contract needs together:
 * the annotated Image preview and the structured JSON Text preview. Keeping a
 * distinct React Flow type lets the suite evolve as one UI without duplicating
 * port, execution-state, download, and inspector behavior.
 */
function VideoQcNodeComponent(props: ComponentProps<typeof ModelNode>) {
  return <ModelNode {...props} />;
}

export const VideoQcNode = memo(VideoQcNodeComponent);
