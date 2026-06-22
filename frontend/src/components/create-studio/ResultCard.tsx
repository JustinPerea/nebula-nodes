import { useState } from 'react';
import { Download, SquareArrowOutUpRight, ImagePlus, Trash2, FolderOpen, FolderDown, Maximize2 } from 'lucide-react';
import type { Node } from '@xyflow/react';
import type { NodeData, PortValue } from '../../types';
import { OutputRenderer } from './OutputRenderer';
import { downloadTranscoded, DOWNLOAD_FORMATS } from '../../lib/createTranscode';

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
  onReveal?: (url: string) => void;
  onSaveToFolder?: (url: string) => void;
  onZoom?: () => void;
}

export function ResultCard({ node, onOpenInCanvas, onUseAsInput, onDelete, onReveal, onSaveToFolder, onZoom }: ResultCardProps) {
  const [saved, setSaved] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);

  if (!node) return null;
  const url = firstMediaUrl(node.data.outputs);

  // Only completed image/video results are zoomable. Images get a full-area
  // click target; video gets only the corner button so its controls stay live.
  const complete = node.data.state === 'complete';
  const outs = node.data.outputs;
  const hasVideo = complete && Object.values(outs).some((o) => o.type === 'Video' && o.value);
  const hasImage = complete && Object.values(outs).some((o) => (o.type === 'Image' || o.type === 'SVG') && o.value);
  const mediaKind = hasVideo ? 'video' : hasImage ? 'image' : 'other';
  const canZoom = mediaKind !== 'other' && !!onZoom;
  const imageClickable = mediaKind === 'image' && canZoom;
  // Raster images (not SVG) can be downloaded in a chosen format via the server.
  const isRaster = complete && Object.values(outs).some((o) => o.type === 'Image' && o.value);

  const handleSave = () => {
    if (!url || !onSaveToFolder) return;
    onSaveToFolder(url);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleFormat = (fmt: (typeof DOWNLOAD_FORMATS)[number]) => {
    setDlOpen(false);
    if (url) void downloadTranscoded(url, fmt).catch((err) => console.error('[nebula] transcode download failed:', err));
  };

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
        {canZoom && (
          <button
            type="button"
            className="result-card__zoom-btn"
            onClick={() => onZoom?.()}
            title="View full screen"
            aria-label="View full screen"
          >
            <Maximize2 size={15} strokeWidth={1.75} />
          </button>
        )}
        {imageClickable && (
          <button
            type="button"
            className="result-card__zoom-overlay"
            onClick={() => onZoom?.()}
            aria-label="View full screen"
          />
        )}
      </div>
      <div className="result-card__actions">
        {url && isRaster ? (
          <span className="result-card__dl">
            <button
              type="button"
              className="result-card__btn"
              onClick={() => setDlOpen((v) => !v)}
              title="Download as…"
              aria-haspopup="menu"
              aria-expanded={dlOpen}
            >
              <Download size={15} strokeWidth={1.75} />
            </button>
            {dlOpen && (
              <div className="result-card__dl-menu" role="menu">
                <a className="result-card__dl-item" href={url} download role="menuitem" onClick={() => setDlOpen(false)}>
                  Original
                </a>
                {DOWNLOAD_FORMATS.map((fmt) => (
                  <button key={fmt} type="button" className="result-card__dl-item" role="menuitem" onClick={() => handleFormat(fmt)}>
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </span>
        ) : (
          url && <a className="result-card__btn" href={url} download title="Download"><Download size={15} strokeWidth={1.75} /></a>
        )}
        <button className="result-card__btn" type="button" onClick={onOpenInCanvas} title="Open in canvas"><SquareArrowOutUpRight size={15} strokeWidth={1.75} /></button>
        {url && <button className="result-card__btn" type="button" onClick={() => onUseAsInput(url)} title="Use as input"><ImagePlus size={15} strokeWidth={1.75} /></button>}
        {url && onReveal && (
          <button className="result-card__btn" type="button" onClick={() => onReveal(url)} title="Reveal in Finder">
            <FolderOpen size={15} strokeWidth={1.75} />
          </button>
        )}
        {url && onSaveToFolder && (
          <button className="result-card__btn" type="button" onClick={handleSave} title={saved ? 'Saved!' : 'Save to folder'}>
            <FolderDown size={15} strokeWidth={1.75} />
          </button>
        )}
        <button className="result-card__btn result-card__btn--danger" type="button" onClick={onDelete} title="Delete"><Trash2 size={15} strokeWidth={1.75} /></button>
      </div>
    </div>
  );
}
