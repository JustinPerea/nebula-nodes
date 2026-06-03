import { Download, SquareArrowOutUpRight, ImagePlus, Trash2 } from 'lucide-react';
import type { Node } from '@xyflow/react';
import type { NodeData, PortValue } from '../../types';
import { OutputRenderer } from './OutputRenderer';

function firstMediaUrl(outputs: Record<string, PortValue>): string | null {
  for (const t of ['Image', 'Video', 'Audio', 'Mesh', 'SVG'] as const) {
    const o = Object.values(outputs).find((v) => v.type === t && typeof v.value === 'string' && v.value);
    if (o) return o.value as string;
  }
  return null;
}

export interface ResultCardProps {
  node: Node<NodeData> | undefined;
  onOpenInCanvas: () => void;
  onUseAsInput: (url: string) => void;
  onDelete: () => void;
}

export function ResultCard({ node, onOpenInCanvas, onUseAsInput, onDelete }: ResultCardProps) {
  if (!node) return null;
  const url = firstMediaUrl(node.data.outputs);
  return (
    <div className="result-card">
      <div className="result-card__media">
        <OutputRenderer
          outputs={node.data.outputs}
          state={node.data.state}
          streamingText={node.data.streamingText}
          streamingPartials={node.data.streamingPartials}
          streamingSvg={node.data.streamingSvg}
          error={node.data.error}
        />
      </div>
      <div className="result-card__actions">
        {url && <a className="result-card__btn" href={url} download title="Download"><Download size={15} strokeWidth={1.75} /></a>}
        <button className="result-card__btn" type="button" onClick={onOpenInCanvas} title="Open in canvas"><SquareArrowOutUpRight size={15} strokeWidth={1.75} /></button>
        {url && <button className="result-card__btn" type="button" onClick={() => onUseAsInput(url)} title="Use as input"><ImagePlus size={15} strokeWidth={1.75} /></button>}
        <button className="result-card__btn result-card__btn--danger" type="button" onClick={onDelete} title="Delete"><Trash2 size={15} strokeWidth={1.75} /></button>
      </div>
    </div>
  );
}
