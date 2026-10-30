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
import { Download, Orbit, RotateCcw, X } from 'lucide-react';
import type { WorldValueV2 } from '../../types/spatial';
import { gaussianCountText, previewSplat, splatSourceLine } from '../../lib/worldV2Splat';
import { downloadWorldAsset, worldAssetFilename } from '../../lib/worldDownload';
import { failureMessage } from '../../lib/errorCopy';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap';
import type { WorldViewerFailure, WorldViewerStatus } from './WorldEnvironmentViewer';
import { ModalPortal } from '../ModalPortal';
import '../../styles/world-preview.css';

const LazyWorldEnvironmentViewer = lazy(() =>
  import('./WorldEnvironmentViewer').then((module) => ({ default: module.WorldEnvironmentViewer })),
);

/** GM's lines (PR #203 r1 to r3) for a splat the viewer can't show, centred
 * in the stage in place of the splat (never beside a generic one). */
export const SPLAT_DAMAGED_LINE = 'Nebula can’t open this splat. Download it to try a desktop 3D viewer.';
export const SPLAT_TOO_LARGE_LINE = 'This splat is too large to open in the browser. '
  + 'Download it to open in a desktop 3D viewer.';
export const IDOL_SPLAT_GONE_LINE = 'This splat’s file is gone. Run Idol again to make a new one.';
/** The same for a splat another node made (GM r3, k). */
export const SPLAT_GONE_LINE = 'This splat’s file is gone. Run the node that made it again.';
export const SPLAT_NO_WEBGL_LINE = 'This browser can’t show 3D previews. '
  + 'Download the splat to open it in a desktop 3D viewer.';
export const SPLAT_LOAD_LINE = 'Nebula couldn’t load this splat. Try again in a moment.';
export const SPLAT_ORBIT_HINT = 'Drag to orbit. Two-finger drag to pan. Pinch or scroll to zoom.';

function failureLine(failure: WorldViewerFailure, world: WorldValueV2): string {
  if (failure === 'too-large') return SPLAT_TOO_LARGE_LINE;
  if (failure === 'missing') return world.session.model === 'idol' ? IDOL_SPLAT_GONE_LINE : SPLAT_GONE_LINE;
  if (failure === 'webgl') return SPLAT_NO_WEBGL_LINE;
  if (failure === 'load') return SPLAT_LOAD_LINE;
  // 'format' or 'other': the file loaded but won't parse.
  return SPLAT_DAMAGED_LINE;
}

/** A file that is gone, or didn't load, has nothing to download (GM r2, r3). */
function failureKeepsDownload(failure: WorldViewerFailure): boolean {
  return failure !== 'missing' && failure !== 'load';
}

export interface WorldSplatPreviewProps {
  world: WorldValueV2;
  compact?: boolean;
}

/** The "Explore in 3D" button on a World v2 card, and the viewer it opens:
 * the World viewer (WorldEnvironmentViewer, Spark) on the value's splat, PLY
 * or SPZ, turned by its coordinate system and framed as an object from a 3/4
 * view. Orbit only: Fly is for World Labs scenes (GM, PR #203 r1). Loaded on
 * first use (lib/deferredChunks.ts); the viewer and Spark load only when the
 * dialog opens. */
function WorldSplatPreviewComponent({ world, compact = false }: WorldSplatPreviewProps) {
  const splat = previewSplat(world);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WorldViewerStatus>('loading');
  const [failure, setFailure] = useState<WorldViewerFailure | null>(null);
  const [resetToken, setResetToken] = useState(0);
  // Try again remounts the viewer, which fetches the file again.
  const [attempt, setAttempt] = useState(0);
  const [download, setDownload] = useState<{ status: 'downloading' | 'error'; message?: string } | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const helpId = useId();
  const failureId = useId();

  const close = useCallback(() => {
    downloadRef.current?.abort();
    downloadRef.current = null;
    setDownload(null);
    setOpen(false);
  }, []);
  const onStatusChange = useCallback((next: WorldViewerStatus) => {
    setStatus(next);
    if (next !== 'error') setFailure(null);
  }, []);

  useDialogFocusTrap(open, dialogRef, closeRef, close);

  useEffect(() => () => downloadRef.current?.abort(), []);

  if (!splat) return null;

  const startDownload = async () => {
    if (download?.status === 'downloading') return;
    // The button disables itself while it downloads, and a disabled button
    // drops focus to the page: keep it in the dialog.
    if (dialogRef.current?.contains(document.activeElement)) dialogRef.current.focus({ preventScroll: true });
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

  const gaussians = gaussianCountText(splat.pointCount);
  const failed = status === 'error';
  const failureKind: WorldViewerFailure = failure ?? 'other';
  // GM r2: the toolbar's status slot stays empty while the stage says why.
  const statusText = failed
    ? ''
    : status === 'ready'
      ? [gaussians, splat.format.toUpperCase()].filter(Boolean).join(' · ')
      : 'Loading';
  const canDownload = !failed || failureKeepsDownload(failureKind);
  const retry = () => {
    // The button goes away as the viewer reloads: keep focus in the dialog.
    dialogRef.current?.focus({ preventScroll: true });
    setStatus('loading');
    setFailure(null);
    setAttempt((count) => count + 1);
  };

  return (
    <>
      <button
        type="button"
        className={`world-splat-preview__open nodrag nowheel${compact ? ' world-splat-preview__open--compact' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          setStatus('loading');
          setFailure(null);
          setOpen(true);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={`Explore “${world.displayName}” in 3D`}
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
              aria-describedby={failed ? failureId : helpId}
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
              data-testid="world-splat-dialog"
            >
              <header className="world-modal__header">
                <div className="world-modal__heading">
                  <span className="world-modal__eyebrow">{splatSourceLine(world)}</span>
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

              <div className="world-modal__toolbar" role="group" aria-label="3D viewer controls">
                {/* Nothing to reset without a splat (GM r2). */}
                {!failed && (
                  <button
                    type="button"
                    className="world-modal__icon-button world-modal__camera-reset"
                    onClick={() => setResetToken((token) => token + 1)}
                    aria-label="Reset camera"
                    title="Reset camera"
                  >
                    <RotateCcw size={15} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                )}
                <span
                  className={`world-modal__status world-modal__status--${status}`}
                  role="status"
                  aria-live="polite"
                >
                  {statusText}
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
                    key={`${world.id}:${splat.id}:${attempt}`}
                    src={splat.asset.uri}
                    label={world.displayName}
                    navigationMode="orbit"
                    resetToken={resetToken}
                    format={splat.format}
                    upAxis={world.coordinateSystem.upAxis}
                    forwardAxis={world.coordinateSystem.forwardAxis}
                    framing="object"
                    describedById={helpId}
                    onStatusChange={onStatusChange}
                    onFailure={setFailure}
                    quietFallback
                  />
                </Suspense>
                {!failed && <p id={helpId} className="world-modal__help">{SPLAT_ORBIT_HINT}</p>}
                {failed && (
                  <div className="world-modal__failure" role="alert" data-splat-failure={failureKind}>
                    <p id={failureId}>{failureLine(failureKind, world)}</p>
                    {failureKind === 'load' && (
                      <button type="button" className="world-modal__button" onClick={retry}>Try again</button>
                    )}
                  </div>
                )}
              </div>

              {canDownload && (
                <footer className="world-modal__footer">
                  <div className="world-modal__downloads">
                    <button
                      type="button"
                      className="world-modal__button"
                      disabled={download?.status === 'downloading'}
                      aria-busy={download?.status === 'downloading'}
                      onClick={() => void startDownload()}
                    >
                      <Download size={15} strokeWidth={1.7} aria-hidden="true" />
                      {download?.status === 'downloading' ? 'Downloading…' : 'Download splat'}
                    </button>
                    {download?.status === 'error' && (
                      <span className="world-modal__download-error" role="alert">{download.message}</span>
                    )}
                  </div>
                </footer>
              )}
            </section>
          </div>
        </ModalPortal>
      )}
    </>
  );
}

export const WorldSplatPreview = memo(WorldSplatPreviewComponent);
