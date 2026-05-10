import { memo, useState, useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';

interface MeshPreviewProps {
  src: string;
}

type MeshViewerStatus = 'loading' | 'ready' | 'error';

interface MeshViewerState {
  src: string;
  status: MeshViewerStatus;
  canMountViewer: boolean;
}

function meshFormatLabel(src: string) {
  const cleanSrc = src.split(/[?#]/)[0] ?? '';
  const filename = cleanSrc.split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  return extension ? `${extension.toUpperCase()} model` : '3D model';
}

function canUseWebGL(): boolean {
  if (typeof document === 'undefined') return false;

  try {
    const canvas = document.createElement('canvas');
    const context = (
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')
    ) as WebGLRenderingContext | WebGL2RenderingContext | null;
    const loseContext = context?.getExtension?.('WEBGL_lose_context');
    loseContext?.loseContext?.();
    return Boolean(context);
  } catch {
    return false;
  }
}

function sameOriginHttpUrl(src: string): URL | null {
  if (typeof window === 'undefined') return null;

  try {
    const url = new URL(src, window.location.href);
    if (url.origin !== window.location.origin) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function isLikelyMeshResponse(src: string, contentType: string | null): boolean {
  const normalizedType = (contentType ?? '').toLowerCase();
  if (normalizedType.includes('text/html')) return false;
  if (normalizedType.includes('model/gltf')) return true;
  if (normalizedType.includes('application/octet-stream')) return true;
  if (normalizedType.includes('application/json') && /\.gltf(?:[?#]|$)/i.test(src)) return true;
  return normalizedType === '' || /\.(glb|gltf|usdz)(?:[?#]|$)/i.test(src);
}

async function canLoadMeshSource(src: string, signal: AbortSignal): Promise<boolean> {
  const url = sameOriginHttpUrl(src);
  if (!url) return true;

  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal });
    if (!response.ok) return response.status === 405;
    return isLikelyMeshResponse(src, response.headers.get('content-type'));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return false;
  }
}

async function ensureModelViewerElement(): Promise<void> {
  await import('@google/model-viewer');
}

function MeshPreviewComponent({ src }: MeshPreviewProps) {
  const [showModal, setShowModal] = useState(false);
  const [viewerState, setViewerState] = useState<MeshViewerState>({
    src,
    status: 'loading',
    canMountViewer: false,
  });
  const viewerStatus = viewerState.src === src ? viewerState.status : 'loading';
  const canMountViewer = viewerState.src === src && viewerState.canMountViewer && viewerStatus !== 'error';
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
    setViewerState((current) => {
      if (current.src !== src) return current;
      return {
        src,
        status,
        canMountViewer: status === 'error' ? false : current.canMountViewer,
      };
    });
  }, [src]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setViewerState({ src, status: 'loading', canMountViewer: false });

    const prepareViewer = async () => {
      if (!canUseWebGL()) {
        if (!cancelled) setViewerState({ src, status: 'error', canMountViewer: false });
        return;
      }

      try {
        const sourceOk = await canLoadMeshSource(src, controller.signal);
        if (sourceOk) await ensureModelViewerElement();
        if (!cancelled) {
          setViewerState({
            src,
            status: sourceOk ? 'loading' : 'error',
            canMountViewer: sourceOk,
          });
        }
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          setViewerState({ src, status: 'error', canMountViewer: false });
        }
      }
    };

    void prepareViewer();

    return () => {
      cancelled = true;
      controller.abort();
    };
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
        {canMountViewer && (
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
        )}
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
            {canMountViewer ? (
              <model-viewer
                src={src}
                camera-controls
                auto-rotate
                shadow-intensity="1"
                alt="3D model preview"
                className="mesh-modal__viewer"
              />
            ) : (
              <div className="mesh-modal__fallback" aria-label={`${formatLabel} preview unavailable`}>
                <span className="mesh-preview__mesh" aria-hidden="true" />
              </div>
            )}
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
