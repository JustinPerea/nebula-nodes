import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Download, Footprints, Orbit, RotateCcw, X } from 'lucide-react';
import type { WorldValueV2 } from '../../types/spatial';
import { previewSplat } from '../../lib/worldV2Splat';
import { downloadWorldAsset, worldAssetFilename } from '../../lib/worldDownload';
import { failureMessage } from '../../lib/errorCopy';
import { keyBlockedByModal } from '../../lib/canvasShortcutScope';
import type { WorldNavigationMode, WorldViewerStatus } from './WorldEnvironmentViewer';
import { ModalPortal } from '../ModalPortal';
import '../../styles/world-preview.css';

const LazyWorldEnvironmentViewer = lazy(() =>
  import('./WorldEnvironmentViewer').then((module) => ({ default: module.WorldEnvironmentViewer })),
);

const PROVIDER_NAMES: Readonly<Record<string, string>> = { speridlabs: 'Speridlabs', worldlabs: 'World Labs' };
const MODEL_NAMES: Readonly<Record<string, string>> = { idol: 'Idol' };

function sourceLine(world: WorldValueV2): string {
  const model = world.session.model ? MODEL_NAMES[world.session.model] ?? world.session.model : null;
  const provider = world.session.provider ? PROVIDER_NAMES[world.session.provider] ?? world.session.provider : null;
  return [model, provider].filter(Boolean).join(' · ') || '3D splat';
}

const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface WorldSplatPreviewProps {
  world: WorldValueV2;
  compact?: boolean;
}

/** The "Explore in 3D" button on a World v2 card, and the viewer it opens:
 * the World viewer (WorldEnvironmentViewer, Spark) on the value's splat, PLY
 * or SPZ, turned by its coordinate system and framed as an object. Loaded on
 * first use (lib/deferredChunks.ts); the viewer and Spark load only when the
 * dialog opens. */
function WorldSplatPreviewComponent({ world, compact = false }: WorldSplatPreviewProps) {
  const splat = previewSplat(world);
  const [open, setOpen] = useState(false);
  const [navigationMode, setNavigationMode] = useState<WorldNavigationMode>('orbit');
  const [status, setStatus] = useState<WorldViewerStatus>('loading');
  const [resetToken, setResetToken] = useState(0);
  const [download, setDownload] = useState<{ status: 'downloading' | 'error'; message?: string } | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const helpId = useId();

  const close = useCallback(() => {
    downloadRef.current?.abort();
    downloadRef.current = null;
    setDownload(null);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyBlockedByModal(dialogRef.current)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [close, open]);

  useEffect(() => () => downloadRef.current?.abort(), []);

  if (!splat) return null;

  const startDownload = async () => {
    if (download?.status === 'downloading') return;
    const controller = new AbortController();
    downloadRef.current = controller;
    setDownload({ status: 'downloading' });
    try {
      await downloadWorldAsset(splat.asset.uri, worldAssetFilename(world.displayName, 'splat', splat.format), {
        signal: controller.signal,
        heading: "Couldn't download the splat.",
      });
      if (downloadRef.current === controller) setDownload(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (downloadRef.current === controller) {
        setDownload({ status: 'error', message: failureMessage(error, "Couldn't download the splat.") });
      }
    } finally {
      if (downloadRef.current === controller) downloadRef.current = null;
    }
  };

  const gaussians = splat.pointCount ? `${splat.pointCount.toLocaleString()} Gaussians` : null;

  return (
    <>
      <button
        type="button"
        className={`world-splat-preview__open nodrag nowheel${compact ? ' world-splat-preview__open--compact' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          setStatus('loading');
          setOpen(true);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={`Explore in 3D: ${world.displayName}`}
        data-splat-format={splat.format}
      >
        <Orbit size={14} strokeWidth={1.7} aria-hidden="true" />
        Explore in 3D
      </button>

      {open && (
        <ModalPortal>
          <div
            className="world-modal-overlay nodrag nowheel"
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onClick={close}
          >
            <section
              ref={dialogRef}
              className="world-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={helpId}
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
              data-testid="world-splat-dialog"
            >
              <header className="world-modal__header">
                <div className="world-modal__heading">
                  <span className="world-modal__eyebrow">{sourceLine(world)}</span>
                  <h2 id={titleId}>{world.displayName}</h2>
                </div>
                <div className="world-modal__header-actions">
                  <button
                    ref={closeRef}
                    type="button"
                    className="world-modal__icon-button"
                    onClick={close}
                    aria-label="Close 3D viewer"
                    title="Close"
                  >
                    <X size={18} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                </div>
              </header>

              <div className="world-modal__toolbar" aria-label="3D viewer controls">
                <div className="world-modal__segmented" role="group" aria-label="Navigation mode">
                  <button
                    type="button"
                    className={navigationMode === 'orbit' ? 'is-active' : ''}
                    aria-pressed={navigationMode === 'orbit'}
                    onClick={() => setNavigationMode('orbit')}
                  >
                    <Orbit size={14} strokeWidth={1.7} aria-hidden="true" /> Orbit
                  </button>
                  <button
                    type="button"
                    className={navigationMode === 'fly' ? 'is-active' : ''}
                    aria-pressed={navigationMode === 'fly'}
                    onClick={() => setNavigationMode('fly')}
                  >
                    <Footprints size={14} strokeWidth={1.7} aria-hidden="true" /> Fly
                  </button>
                </div>
                <button
                  type="button"
                  className="world-modal__icon-button world-modal__camera-reset"
                  onClick={() => setResetToken((token) => token + 1)}
                  aria-label="Reset camera"
                  title="Reset camera"
                >
                  <RotateCcw size={15} strokeWidth={1.7} aria-hidden="true" />
                </button>
                <span className={`world-modal__status world-modal__status--${status}`} role="status" aria-live="polite">
                  {[gaussians, splat.format.toUpperCase(), status].filter(Boolean).join(' · ')}
                </span>
              </div>

              <div className="world-modal__stage">
                <Suspense
                  fallback={(
                    <div className="world-modal__lazy-loading" role="status" aria-live="polite">
                      <span className="world-environment-viewer__spinner" aria-hidden="true" />
                      <span>Preparing 3D viewer…</span>
                    </div>
                  )}
                >
                  <LazyWorldEnvironmentViewer
                    key={`${world.id}:${splat.id}`}
                    src={splat.asset.uri}
                    label={world.displayName}
                    navigationMode={navigationMode}
                    resetToken={resetToken}
                    format={splat.format}
                    upAxis={world.coordinateSystem.upAxis}
                    forwardAxis={world.coordinateSystem.forwardAxis}
                    framing="object"
                    describedById={helpId}
                    onStatusChange={setStatus}
                  />
                </Suspense>
                <p id={helpId} className="world-modal__help">
                  {navigationMode === 'orbit'
                    ? 'Drag to orbit, two-finger drag to pan, and pinch or scroll to zoom.'
                    : 'Drag to look. Use W A S D or arrow keys to move; on touch, use two fingers to move and pinch.'}
                </p>
              </div>

              <footer className="world-modal__footer">
                <div className="world-modal__metadata">
                  {gaussians && <span>{gaussians}</span>}
                  <span>{`${world.coordinateSystem.upAxis} up`}</span>
                </div>
                <div className="world-modal__downloads" aria-label="Splat download">
                  <button
                    type="button"
                    className="world-modal__button"
                    disabled={download?.status === 'downloading'}
                    aria-busy={download?.status === 'downloading'}
                    onClick={() => void startDownload()}
                  >
                    <Download size={15} strokeWidth={1.7} aria-hidden="true" />
                    {download?.status === 'downloading' ? 'Downloading…' : `Splat ${splat.format.toUpperCase()}`}
                  </button>
                  {download?.status === 'error' && (
                    <span className="world-modal__download-error" role="alert">{download.message}</span>
                  )}
                </div>
              </footer>
            </section>
          </div>
        </ModalPortal>
      )}
    </>
  );
}

export const WorldSplatPreview = memo(WorldSplatPreviewComponent);
