import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Box,
  Download,
  ExternalLink,
  Footprints,
  Globe2,
  Orbit,
  RotateCcw,
  X,
} from 'lucide-react';
import type { PortValue } from '../../types';
import { backendAssetUrlSync } from '../../lib/backend';
import {
  initialWorldResolution,
  isSafeMarbleUrl,
  isSafeWorldUrl,
  parseWorldValue,
  worldSplatOptions,
  type WorldSplatResolution,
} from '../../lib/worldValue';
import {
  downloadWorldAsset,
  worldAssetFilename,
  worldImageExtensionFromUrl,
} from '../../lib/worldDownload';
import type { WorldNavigationMode, WorldViewerStatus } from './WorldEnvironmentViewer';
import '../../styles/world-preview.css';

const LazyWorldEnvironmentViewer = lazy(() =>
  import('./WorldEnvironmentViewer').then((module) => ({ default: module.WorldEnvironmentViewer })),
);

export interface WorldPreviewProps {
  value: PortValue['value'];
  compact?: boolean;
}

function prefersLowBandwidth(): boolean {
  if (typeof window === 'undefined') return true;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return Boolean(
    connection?.saveData
    || connection?.effectiveType === 'slow-2g'
    || connection?.effectiveType === '2g'
    || window.matchMedia?.('(pointer: coarse)').matches
    || window.innerWidth < 768,
  );
}

function safeAsset(value: string | undefined): string | undefined {
  return isSafeWorldUrl(value) ? backendAssetUrlSync(value) : undefined;
}

const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function ViewerLoadingFallback({ thumbnail }: { thumbnail?: string }) {
  return (
    <div className="world-modal__lazy-loading" role="status" aria-live="polite">
      {thumbnail && <img src={thumbnail} alt="" aria-hidden="true" />}
      <span className="world-environment-viewer__spinner" aria-hidden="true" />
      <span>Preparing 3D viewer…</span>
    </div>
  );
}

function WorldPreviewComponent({ value, compact = false }: WorldPreviewProps) {
  const world = useMemo(() => parseWorldValue(value), [value]);
  const options = useMemo(() => world ? worldSplatOptions(world) : [], [world]);
  const initialResolution = useMemo(
    () => world ? initialWorldResolution(world, prefersLowBandwidth()) : null,
    [world],
  );
  const [selected, setSelected] = useState<{ worldId: string; resolution: WorldSplatResolution | null } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [navigationMode, setNavigationMode] = useState<WorldNavigationMode>('orbit');
  const [viewerStatus, setViewerStatus] = useState<WorldViewerStatus>('loading');
  const [downloadState, setDownloadState] = useState<{
    key: string;
    status: 'downloading' | 'error';
    message?: string;
  } | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const downloadControllerRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const helpId = useId();

  const resolution = world && selected?.worldId === world.worldId
    && options.some((option) => option.id === selected.resolution)
    ? selected.resolution
    : initialResolution;
  const activeOption = options.find((option) => option.id === resolution) ?? null;
  const thumbnail = world ? safeAsset(world.assets.thumbnail ?? world.assets.panorama) : undefined;

  const close = useCallback(() => {
    downloadControllerRef.current?.abort();
    downloadControllerRef.current = null;
    setDownloadState(null);
    setShowModal(false);
  }, []);
  const open = useCallback(() => {
    setViewerStatus('loading');
    setShowModal(true);
  }, []);

  useEffect(() => {
    if (!showModal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)]
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [close, showModal]);

  useEffect(() => () => downloadControllerRef.current?.abort(), []);

  if (!world) {
    return (
      <div className="world-preview world-preview--invalid" role="status">
        <Box aria-hidden="true" size={22} strokeWidth={1.5} />
        <span>World data unavailable</span>
      </div>
    );
  }

  const marbleUrl = isSafeMarbleUrl(world.marbleUrl) ? world.marbleUrl : undefined;
  const panorama = safeAsset(world.assets.panorama);
  const collider = safeAsset(world.assets.colliderMesh);
  const caption = world.caption || `${world.displayName}, generated with ${world.model}`;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  const startDownload = async (
    key: string,
    url: string,
    filename: string,
  ) => {
    if (downloadState?.status === 'downloading') return;
    const controller = new AbortController();
    downloadControllerRef.current = controller;
    setDownloadState({ key, status: 'downloading' });
    try {
      await downloadWorldAsset(url, filename, { signal: controller.signal });
      if (downloadControllerRef.current === controller) setDownloadState(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'The asset could not be downloaded.';
      if (downloadControllerRef.current === controller) {
        setDownloadState({ key, status: 'error', message });
      }
    } finally {
      if (downloadControllerRef.current === controller) downloadControllerRef.current = null;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`world-preview nodrag nowheel${compact ? ' world-preview--compact' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={`Explore 3D world: ${world.displayName}`}
        title="Explore 3D world"
        data-world-id={world.worldId}
      >
        {thumbnail ? (
          <img className="world-preview__thumbnail" src={thumbnail} alt="" loading="lazy" />
        ) : (
          <span className="world-preview__placeholder" aria-hidden="true">
            <Globe2 size={34} strokeWidth={1.25} />
          </span>
        )}
        <span className="world-preview__shade" aria-hidden="true" />
        <span className="world-preview__badge"><Globe2 size={12} strokeWidth={1.7} /> World</span>
        <span className="world-preview__copy">
          <strong>{world.displayName}</strong>
          <span>{caption}</span>
        </span>
        <span className="world-preview__cta">Explore</span>
      </button>

      {showModal && createPortal(
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
          >
            <header className="world-modal__header">
              <div className="world-modal__heading">
                <span className="world-modal__eyebrow">World Labs environment</span>
                <h2 id={titleId}>{world.displayName}</h2>
              </div>
              <div className="world-modal__header-actions">
                {marbleUrl && (
                  <a className="world-modal__button" href={marbleUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={15} strokeWidth={1.7} aria-hidden="true" />
                    Open in Marble
                  </a>
                )}
                <button
                  ref={closeRef}
                  type="button"
                  className="world-modal__icon-button"
                  onClick={close}
                  aria-label="Close world viewer"
                  title="Close"
                >
                  <X size={18} strokeWidth={1.7} aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="world-modal__toolbar" aria-label="World viewer controls">
              <div
                className="world-modal__segmented world-modal__segmented--quality"
                role="group"
                aria-label="Preview quality"
              >
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={option.id === resolution ? 'is-active' : ''}
                    onClick={() => {
                      setSelected({ worldId: world.worldId, resolution: option.id });
                      setViewerStatus('loading');
                    }}
                    aria-pressed={option.id === resolution}
                    title={option.detail}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
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
                className="world-modal__icon-button"
                onClick={() => setResetToken((token) => token + 1)}
                aria-label="Reset camera"
                title="Reset camera"
              >
                <RotateCcw size={15} strokeWidth={1.7} aria-hidden="true" />
              </button>
              <span className={`world-modal__status world-modal__status--${viewerStatus}`} role="status" aria-live="polite">
                {activeOption ? `${activeOption.detail} · ${viewerStatus}` : 'No splat preview'}
              </span>
            </div>

            <div className="world-modal__stage">
              {activeOption && isSafeWorldUrl(activeOption.url) ? (
                <Suspense fallback={<ViewerLoadingFallback thumbnail={thumbnail} />}>
                  <LazyWorldEnvironmentViewer
                    key={world.worldId}
                    src={activeOption.url}
                    splatVariant={activeOption.id}
                    thumbnail={thumbnail}
                    label={world.displayName}
                    navigationMode={navigationMode}
                    resetToken={resetToken}
                    metricScaleFactor={world.semantics.metricScaleFactor}
                    groundPlaneOffset={world.semantics.groundPlaneOffset}
                    coordinateFrame={world.semantics.coordinateFrame}
                    describedById={helpId}
                    onStatusChange={setViewerStatus}
                  />
                </Suspense>
              ) : (
                <div className="world-modal__no-splat" role="img" aria-label={`${caption}. Interactive splat unavailable.`}>
                  {thumbnail && <img src={thumbnail} alt="" />}
                  <div>
                    <Globe2 size={32} strokeWidth={1.35} aria-hidden="true" />
                    <strong>{options.length > 0 ? 'Choose a preview quality' : 'Spatial preview unavailable'}</strong>
                    <span>
                      {options.length > 0
                        ? 'Only unbounded or unfamiliar splat variants are available, so loading requires an explicit choice.'
                        : 'The panorama and collider remain available below.'}
                    </span>
                  </div>
                </div>
              )}
              <p id={helpId} className="world-modal__help">
                {navigationMode === 'orbit'
                  ? 'Drag to orbit, two-finger drag to pan, and pinch or scroll to zoom.'
                  : 'Drag to look. Use W A S D or arrow keys to move; on touch, use two fingers to move and pinch.'}
              </p>
            </div>

            <footer className="world-modal__footer">
              <div className="world-modal__metadata">
                <span>{world.model}</span>
                <span>{world.promptType}</span>
                <span>{world.semantics.coordinateFrame}</span>
              </div>
              <div className="world-modal__downloads" aria-label="World downloads">
                {activeOption && isSafeWorldUrl(activeOption.url) && (
                  <button
                    type="button"
                    className="world-modal__button"
                    disabled={downloadState?.status === 'downloading'}
                    aria-busy={downloadState?.key === 'splat' && downloadState.status === 'downloading'}
                    onClick={() => void startDownload(
                      'splat',
                      activeOption.url,
                      worldAssetFilename(world.displayName, activeOption.id, 'spz'),
                    )}
                  >
                    <Download size={15} strokeWidth={1.7} aria-hidden="true" />
                    {downloadState?.key === 'splat' && downloadState.status === 'downloading'
                      ? 'Downloading…'
                      : `${activeOption.label} SPZ`}
                  </button>
                )}
                {panorama && (
                  <button
                    type="button"
                    className="world-modal__button"
                    disabled={downloadState?.status === 'downloading'}
                    aria-busy={downloadState?.key === 'panorama' && downloadState.status === 'downloading'}
                    onClick={() => void startDownload(
                      'panorama',
                      panorama,
                      worldAssetFilename(
                        world.displayName,
                        'panorama',
                        worldImageExtensionFromUrl(panorama),
                      ),
                    )}
                  >
                    {downloadState?.key === 'panorama' && downloadState.status === 'downloading'
                      ? 'Downloading…'
                      : 'Panorama'}
                  </button>
                )}
                {collider && (
                  <button
                    type="button"
                    className="world-modal__button"
                    disabled={downloadState?.status === 'downloading'}
                    aria-busy={downloadState?.key === 'collider' && downloadState.status === 'downloading'}
                    onClick={() => void startDownload(
                      'collider',
                      collider,
                      worldAssetFilename(world.displayName, 'collider', 'glb'),
                    )}
                  >
                    {downloadState?.key === 'collider' && downloadState.status === 'downloading'
                      ? 'Downloading…'
                      : 'Collider GLB'}
                  </button>
                )}
                {downloadState?.status === 'error' && (
                  <span className="world-modal__download-error" role="alert">
                    Download failed. {downloadState.message}
                  </span>
                )}
              </div>
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

export const WorldPreview = memo(WorldPreviewComponent);
