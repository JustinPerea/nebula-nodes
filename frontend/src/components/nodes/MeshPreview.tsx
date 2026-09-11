import {
  memo,
  useState,
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { backendAssetUrlSync } from '../../lib/backend';
import { AssetByteLimitError, readBoundedAssetResponse } from '../../lib/boundedAsset';
import { downloadWorldAsset, worldAssetFilename } from '../../lib/worldDownload';
import { isSafeWorldUrl } from '../../lib/worldValue';

interface MeshPreviewProps {
  src: string;
}

type MeshViewerStatus = 'idle' | 'loading' | 'ready' | 'error' | 'file';

interface MeshViewerState {
  src: string;
  status: MeshViewerStatus;
  viewerSrc?: string;
  errorMessage?: string;
}

// <model-viewer> otherwise fetches and expands a URL without a browser-memory
// ceiling. Interactive preview is opt-in and uses this bounded local Blob.
export const MESH_PREVIEW_MAX_BYTES = 128 * 1024 * 1024;

const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function currentReducedMotionPreference(): boolean {
  return typeof window !== 'undefined'
    && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function meshFormatLabel(src: string) {
  const cleanSrc = src.split(/[?#]/)[0] ?? '';
  const filename = cleanSrc.split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  if (extension && ['ply', 'spz', 'splat', 'ksplat', 'sog'].includes(extension.toLowerCase())) {
    return `${extension.toUpperCase()} splat export`;
  }
  return extension ? `${extension.toUpperCase()} model` : '3D model';
}

function isSplatExport(src: string): boolean {
  return /\.(?:ply|spz|splat|ksplat|sog)(?:[?#]|$)/i.test(src);
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

function isLikelyMeshResponse(src: string, contentType: string | null): boolean {
  const normalizedType = (contentType ?? '').toLowerCase();
  if (normalizedType.includes('text/html')) return false;
  if (normalizedType.includes('model/gltf')) return true;
  if (normalizedType.includes('application/octet-stream')) return true;
  if (normalizedType.includes('application/json') && /\.gltf(?:[?#]|$)/i.test(src)) return true;
  return normalizedType === '' || /\.(glb|gltf|usdz)(?:[?#]|$)/i.test(src);
}

async function ensureModelViewerElement(): Promise<void> {
  await import('@google/model-viewer');
}

function meshDownloadFilename(src: string): string {
  const clean = src.split(/[?#]/, 1)[0] ?? '';
  const extension = clean.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1] ?? 'glb';
  return worldAssetFilename('mesh', 'export', extension);
}

function MeshPreviewComponent({ src }: MeshPreviewProps) {
  const splatExport = isSplatExport(src);
  const [showModal, setShowModal] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(currentReducedMotionPreference);
  const [viewerState, setViewerState] = useState<MeshViewerState>({
    src,
    status: splatExport ? 'file' : 'idle',
  });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewerStatus = splatExport
    ? 'file'
    : viewerState.src === src ? viewerState.status : 'idle';
  const canMountViewer = !splatExport
    && showModal
    && viewerState.src === src
    && Boolean(viewerState.viewerSrc)
    && viewerStatus !== 'error';
  const formatLabel = meshFormatLabel(src);

  const handleClick = useCallback(() => {
    setDownloadError(null);
    setShowModal(true);
  }, []);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
    setDownloadError(null);
  }, []);

  const setCurrentViewerStatus = useCallback((status: MeshViewerStatus) => {
    setViewerState((current) => {
      if (current.src !== src) return current;
      return {
        ...current,
        status,
        viewerSrc: status === 'error' ? undefined : current.viewerSrc,
      };
    });
  }, [src]);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mediaQuery) return;

    const updatePreference = () => setReduceMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener?.('change', updatePreference);
    return () => mediaQuery.removeEventListener?.('change', updatePreference);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let objectUrl: string | null = null;

    // PLY and related splat files are valid export artifacts, but
    // <model-viewer> cannot render them. Present an explicit download state
    // instead of reporting a false load failure.
    if (splatExport || !showModal) return () => controller.abort();

    const prepareViewer = async () => {
      setViewerState({ src, status: 'loading' });
      if (!canUseWebGL()) {
        if (!cancelled) {
          setViewerState({
            src,
            status: 'error',
            errorMessage: 'Interactive preview requires WebGL.',
          });
        }
        return;
      }

      try {
        if (!isSafeWorldUrl(src)) throw new Error('The mesh URL is not safe to preview.');
        const response = await fetch(backendAssetUrlSync(src), {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`The mesh server returned HTTP ${response.status}.`);
        if (!isLikelyMeshResponse(src, response.headers.get('content-type'))) {
          throw new Error('The mesh URL returned an unsupported file type.');
        }
        const bytes = await readBoundedAssetResponse(response, MESH_PREVIEW_MAX_BYTES);
        const contentType = response.headers.get('content-type') || 'model/gltf-binary';
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
        await ensureModelViewerElement();
        if (cancelled) return;
        setViewerState({ src, status: 'loading', viewerSrc: objectUrl });
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          setViewerState({
            src,
            status: 'error',
            errorMessage: error instanceof AssetByteLimitError
              ? 'This model is too large for a safe interactive preview. Download it instead.'
              : error instanceof Error ? error.message : 'Interactive preview unavailable.',
          });
        }
      }
    };

    void prepareViewer();

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [showModal, splatExport, src]);

  useEffect(() => {
    if (!showModal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)]
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [handleClose, showModal]);

  const handleDownload = useCallback(async () => {
    setDownloadError(null);
    try {
      await downloadWorldAsset(src, meshDownloadFilename(src), {
        tooLargeMessage:
          'This mesh is too large for a safe in-browser download. Use the local Nebula output folder instead.',
      });
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'The mesh could not be downloaded.');
    }
  }, [src]);

  return (
    <>
      <div
        ref={triggerRef}
        className={`mesh-preview mesh-preview--${viewerStatus} nodrag nowheel`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        title="Open mesh preview"
        role="button"
        tabIndex={0}
        aria-label={`Open ${formatLabel} preview`}
        data-status={viewerStatus}
      >
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
          <div
            ref={dialogRef}
            className="mesh-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${formatLabel} preview`}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              ref={closeRef}
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
                src={viewerState.viewerSrc}
                camera-controls
                auto-rotate={!reduceMotion}
                shadow-intensity="1"
                alt="3D model preview"
                className="mesh-modal__viewer"
                onLoad={() => setCurrentViewerStatus('ready')}
                onError={() => setCurrentViewerStatus('error')}
              />
            ) : (
            <div className="mesh-modal__fallback" aria-label={`${formatLabel} preview unavailable`}>
              <span className="mesh-preview__mesh" aria-hidden="true" />
              <span className="mesh-modal__fallback-copy">
                {viewerStatus === 'file'
                  ? 'Splat export ready to download'
                  : viewerStatus === 'loading'
                    ? 'Preparing bounded preview…'
                    : viewerState.errorMessage || 'Interactive preview unavailable'}
              </span>
            </div>
            )}
            <div className="mesh-modal__info">
              <span className="mesh-modal__format">
                {formatLabel}
              </span>
              {downloadError && <span className="mesh-modal__download-error" role="alert">{downloadError}</span>}
              <button type="button" className="mesh-modal__download" onClick={() => void handleDownload()}>
                <Download
                  className="mesh-modal__download-icon"
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  focusable="false"
                />
                Download
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export const MeshPreview = memo(MeshPreviewComponent);
