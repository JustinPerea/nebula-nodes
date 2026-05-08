import { memo, useState, useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import '@google/model-viewer';

interface MeshPreviewProps {
  src: string;
}

type MeshViewerStatus = 'loading' | 'ready' | 'error';

function meshFormatLabel(src: string) {
  const cleanSrc = src.split(/[?#]/)[0] ?? '';
  const filename = cleanSrc.split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  return extension ? `${extension.toUpperCase()} model` : '3D model';
}

function MeshPreviewComponent({ src }: MeshPreviewProps) {
  const [showModal, setShowModal] = useState(false);
  const [viewerState, setViewerState] = useState<{ src: string; status: MeshViewerStatus }>({
    src,
    status: 'loading',
  });
  const viewerStatus = viewerState.src === src ? viewerState.status : 'loading';
  const formatLabel = meshFormatLabel(src);

  const handleClick = useCallback(() => {
    setShowModal(true);
  }, []);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

  const setCurrentViewerStatus = useCallback((status: MeshViewerStatus) => {
    setViewerState({ src, status });
  }, [src]);

  useEffect(() => {
    if (!showModal) return;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setShowModal(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showModal]);

  return (
    <>
      <div
        className={`mesh-preview mesh-preview--${viewerStatus} nodrag nowheel`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        title="Open mesh preview"
        role="button"
        tabIndex={0}
        aria-label={`Open ${formatLabel} preview`}
        data-status={viewerStatus}
      >
        <model-viewer
          src={src}
          camera-controls
          auto-rotate
          shadow-intensity="0"
          alt={`${formatLabel} preview`}
          className="mesh-preview__viewer"
          onLoad={() => setCurrentViewerStatus('ready')}
          onError={() => setCurrentViewerStatus('error')}
        />
        <div className="mesh-preview__placeholder" aria-hidden="true">
          <span className="mesh-preview__mesh" />
        </div>
        <div className="mesh-preview__hud" aria-hidden="true">
          <span>{formatLabel}</span>
          <span>{viewerStatus}</span>
        </div>
      </div>

      {showModal && createPortal(
        <div className="mesh-modal-overlay" onClick={handleClose}>
          <div className="mesh-modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="mesh-modal__close"
              onClick={handleClose}
              aria-label="Close"
              title="Close"
            >
              <X
                className="mesh-modal__close-icon"
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                focusable="false"
              />
            </button>
            <model-viewer
              src={src}
              camera-controls
              auto-rotate
              shadow-intensity="1"
              alt="3D model preview"
              className="mesh-modal__viewer"
            />
            <div className="mesh-modal__info">
              <span className="mesh-modal__format">
                {formatLabel}
              </span>
              <a href={src} download className="mesh-modal__download">
                <Download
                  className="mesh-modal__download-icon"
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  focusable="false"
                />
                Download
              </a>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export const MeshPreview = memo(MeshPreviewComponent);
