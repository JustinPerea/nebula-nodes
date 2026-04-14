import { memo, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import '@google/model-viewer';

interface MeshPreviewProps {
  src: string;
}

function MeshPreviewComponent({ src }: MeshPreviewProps) {
  const [showModal, setShowModal] = useState(false);

  const handleClick = useCallback(() => {
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

  useEffect(() => {
    if (!showModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowModal(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showModal]);

  return (
    <>
      <div className="mesh-preview nodrag nowheel" onClick={handleClick} title="Click to expand">
        <model-viewer
          src={src}
          camera-controls
          auto-rotate
          shadow-intensity="0"
          style={{ width: '100%', height: '150px', backgroundColor: '#161616' }}
        />
      </div>

      {showModal && createPortal(
        <div className="mesh-modal-overlay" onClick={handleClose}>
          <div className="mesh-modal" onClick={(e) => e.stopPropagation()}>
            <button className="mesh-modal__close" onClick={handleClose} aria-label="Close">
              &times;
            </button>
            <model-viewer
              src={src}
              camera-controls
              auto-rotate
              shadow-intensity="1"
              alt="3D model preview"
              style={{ width: '100%', height: '100%', backgroundColor: '#161616' }}
            />
            <div className="mesh-modal__info">
              <span className="mesh-modal__format">
                {src.split('.').pop()?.toUpperCase() || '3D'} model
              </span>
              <a href={src} download className="mesh-modal__download">
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
