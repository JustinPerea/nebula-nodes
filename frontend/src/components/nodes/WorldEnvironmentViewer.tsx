import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Euler, MathUtils, Vector2, Vector3, type PerspectiveCamera } from 'three';
import {
  forwardInThree,
  MARBLE_RAW_OPENCV_FRAME,
  marbleRawToThreeTransform,
  upAxisToThreeRotation,
  type WorldAxis,
} from '../../lib/worldTransform';
import {
  objectFraming,
  objectUnitScale,
  placeWorldCamera,
  robustWorldSceneBounds,
  sampleWorldSplatCenters,
  sampleWorldSplatExtents,
  syncWorldFlyAngles,
  worldFlyGestureScale,
  worldFlySpeedMetersPerSecond,
  worldOrbitMaxDistance,
  type WorldSceneBounds,
} from '../../lib/worldNavigation';
import {
  fetchWorldSplatBytes,
  WorldSplatFormatError,
  WorldSplatTooLargeError,
} from '../../lib/worldSplat';
import { RequestFailedError } from '../../lib/errorCopy';
import { disposeSparkQuietly, stopSparkSorting } from '../../lib/sparkDispose';

/** Error copy round 3e (GM): the SPZ format check's line on the card. */
const WORLD_SPZ_FORMAT_LINE = "This world's preview file is damaged or in a format Nebula can't open. "
  + 'Use the panorama or the downloaded splat in a 3D viewer.';
/** GM (PR #203 r1): the same check's line for a World v2 PLY splat (Idol),
 * which has no panorama, and its too-large line. */
export const WORLD_PLY_FORMAT_LINE = 'Nebula can’t open this splat. Download it to try a desktop 3D viewer.';
export const WORLD_PLY_TOO_LARGE_LINE = 'This splat is too large to open in the browser. '
  + 'Download it to open in a desktop 3D viewer.';

export type WorldNavigationMode = 'orbit' | 'fly';
export type WorldViewerStatus = 'loading' | 'ready' | 'error';
/** Why the viewer couldn't show the splat (GM, PR #203 r3, each its own
 * line): its file failed the format check ('format'), is past the size caps
 * ('too-large'), is gone (404, 'missing'), the browser has no WebGL 2
 * ('webgl'), the file didn't load (any other HTTP error or a dropped
 * connection, 'load': worth trying again), or it loaded but Spark couldn't
 * read or draw it ('other'). */
export type WorldViewerFailure = 'format' | 'too-large' | 'missing' | 'webgl' | 'load' | 'other';

/** The failure for an error thrown while the file was fetched and checked. */
function fetchFailure(error: unknown): WorldViewerFailure {
  if (error instanceof WorldSplatTooLargeError) return 'too-large';
  if (error instanceof WorldSplatFormatError) return 'format';
  if (error instanceof RequestFailedError) return error.status === 404 ? 'missing' : 'load';
  // fetchUrl's ConnectionLostError, or a body cut off mid-stream.
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError')
    ? 'load' : 'other';
}

export interface WorldEnvironmentViewerProps {
  src: string;
  splatVariant?: string;
  thumbnail?: string;
  label: string;
  navigationMode: WorldNavigationMode;
  resetToken: number;
  metricScaleFactor?: number;
  groundPlaneOffset?: number;
  coordinateFrame?: string;
  /** The splat's file format (World v2): gzip SPZ, the default, or a 3DGS
   * PLY, each with its own preflight (lib/worldSplat.ts, lib/splatPly.ts). */
  format?: 'spz' | 'ply';
  /** A World v2 coordinate system's axes: the splat turns so `upAxis` is up,
   * and with `framing: 'object'` the camera starts on its `forwardAxis` side. */
  upAxis?: WorldAxis;
  forwardAxis?: WorldAxis;
  /** 'environment' (World Labs: the camera stands inside, at eye height) or
   * 'object' (Idol: the camera stands outside and orbits the object). */
  framing?: 'environment' | 'object';
  describedById?: string;
  onStatusChange?: (status: WorldViewerStatus) => void;
  /** Called with the reason when the status turns to 'error'. */
  onFailure?: (failure: WorldViewerFailure) => void;
  /** The fallback shows nothing: the dialog says the reason in its own
   * words, centred in its stage (the World v2 splat preview, GM PR #203 r2). */
  quietFallback?: boolean;
}

interface ViewerState {
  src: string;
  status: WorldViewerStatus;
  bounds: WorldSceneBounds | null;
  errorMessage?: string;
}

interface LoadedSplat {
  src: string;
  mesh: SplatMesh;
}

interface ViewerErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  onError: () => void;
  resetKey: string;
}

interface ViewerErrorBoundaryState {
  failed: boolean;
  resetKey: string;
}

class ViewerErrorBoundary extends Component<ViewerErrorBoundaryProps, ViewerErrorBoundaryState> {
  state: ViewerErrorBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ViewerErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: ViewerErrorBoundaryProps,
    state: ViewerErrorBoundaryState,
  ): Partial<ViewerErrorBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[nebula] World viewer failed:', error, info.componentStack);
    this.props.onError();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function fileNameForSource(src: string, format: 'spz' | 'ply' = 'spz'): string {
  // Spark picks its reader from the name's extension, so it must match the
  // format the preflight checked.
  try {
    const pathname = new URL(src, window.location.href).pathname;
    const name = pathname.split('/').pop() || `world.${format}`;
    return name.toLowerCase().endsWith(`.${format}`) ? name : `world.${format}`;
  } catch {
    return `world.${format}`;
  }
}

function supportsSparkRenderer(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('canvas');
    const context = probe.getContext('webgl2');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

function WorldSplatScene({
  src,
  splatVariant,
  metricScaleFactor,
  groundPlaneOffset,
  coordinateFrame,
  format,
  upAxis,
  forwardAxis,
  framing,
  onReady,
  onError,
}: {
  src: string;
  splatVariant?: string;
  metricScaleFactor?: number;
  groundPlaneOffset?: number;
  coordinateFrame?: string;
  format?: 'spz' | 'ply';
  upAxis?: WorldAxis;
  forwardAxis?: WorldAxis;
  framing?: 'environment' | 'object';
  onReady: (bounds: WorldSceneBounds) => void;
  onError: (message?: string, failure?: WorldViewerFailure) => void;
}) {
  const { gl, invalidate } = useThree();
  // Read when the splat is framed, not subscribed: a resize mustn't reload it.
  const getThree = useThree((state) => state.get);
  const [loadedSplat, setLoadedSplat] = useState<LoadedSplat | null>(null);
  const splat = loadedSplat?.src === src ? loadedSplat.mesh : null;
  const spark = useMemo(
    () => new SparkRenderer({ renderer: gl, onDirty: invalidate, minSortIntervalMs: 12 }),
    [gl, invalidate],
  );

  useEffect(() => () => {
    spark.removeFromParent();
    // No sort starts after the dispose (a drag's pending one read the
    // disposed target: "No target"; stopSparkSorting).
    stopSparkSorting(spark);
    // Spark's sort worker rejects its pending sort with "Worker terminate"
    // when disposed mid-sort, and nothing in Spark catches it.
    disposeSparkQuietly(spark);
  }, [spark]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let currentMesh: SplatMesh | null = null;

    const load = async () => {
      let fetched = false;
      try {
        const fileBytes = await fetchWorldSplatBytes(src, {
          signal: controller.signal,
          variant: splatVariant,
          format,
        });
        fetched = true;
        if (cancelled) return;

        const mesh = new SplatMesh({
          fileBytes,
          fileName: fileNameForSource(src, format),
        });
        currentMesh = mesh;
        let resetPosition: [number, number, number] | undefined;
        if (coordinateFrame === MARBLE_RAW_OPENCV_FRAME) {
          const transform = marbleRawToThreeTransform(metricScaleFactor, groundPlaneOffset);
          mesh.scale.setScalar(transform.scale);
          mesh.position.set(...transform.position);
          mesh.rotation.set(...transform.rotation);
          mesh.updateMatrixWorld(true);
          resetPosition = [...transform.position];
        } else if (upAxis) {
          mesh.rotation.set(...upAxisToThreeRotation(upAxis));
          mesh.updateMatrixWorld(true);
        }
        await mesh.initialized;
        if (cancelled) {
          // File-byte initialization can finish after the effect cleanup. Dispose
          // again so any late-created PackedSplats/GPU resources are terminally released.
          mesh.removeFromParent();
          disposeSparkQuietly(mesh);
          return;
        }

        mesh.updateMatrixWorld(true);
        let sampledCenters = mesh.packedSplats
          ? sampleWorldSplatCenters(mesh.packedSplats, mesh.matrixWorld)
          : [];
        if (framing === 'object' && mesh.packedSplats) {
          // An object is drawn at one size whatever its file's units
          // (objectUnitScale, review r3 LOW-3), then framed.
          const unit = objectUnitScale(sampledCenters, sampleWorldSplatExtents(mesh.packedSplats, mesh.matrixWorld));
          if (unit !== 1) {
            mesh.scale.multiplyScalar(unit);
            mesh.updateMatrixWorld(true);
            sampledCenters = sampleWorldSplatCenters(mesh.packedSplats, mesh.matrixWorld);
          }
        }
        const fallbackCenter = resetPosition
          ? { x: resetPosition[0], y: resetPosition[1], z: resetPosition[2] }
          : { x: 0, y: 0, z: 0 };
        const bounds = robustWorldSceneBounds(
          sampledCenters,
          fallbackCenter,
        );
        if (resetPosition) bounds.resetPosition = resetPosition;
        if (framing === 'object') {
          const { camera, size } = getThree();
          const fov = (camera as PerspectiveCamera).fov;
          const framed = objectFraming(sampledCenters, forwardInThree(upAxis ?? 'y', forwardAxis ?? 'z'), {
            fovDegrees: fov, aspect: size.height > 0 ? size.width / size.height : 1,
            extents: mesh.packedSplats ? sampleWorldSplatExtents(mesh.packedSplats, mesh.matrixWorld) : [],
          });
          bounds.resetPosition = framed.resetPosition;
          bounds.resetTarget = framed.resetTarget;
          bounds.orbitMaxDistance = framed.orbitMaxDistance;
          bounds.orbitMinDistance = framed.orbitMinDistance;
          bounds.near = framed.near;
          bounds.far = framed.far;
        }
        setLoadedSplat({ src, mesh });
        onReady(bounds);
      } catch (error) {
        if (!cancelled && !isAbortError(error)) {
          console.warn('[nebula] World splat load failed:', error);
          // Error copy round 3e (GM): the format check's own text ("not a
          // valid supported SPZ file (invalid NGSP magic)") stays in the
          // console above; the card reads a written line.
          // Past the fetch, the bytes passed the check: Spark couldn't read or draw them.
          const failure: WorldViewerFailure = fetched ? 'other' : fetchFailure(error);
          onError(
            error instanceof WorldSplatTooLargeError ? (format === 'ply' ? WORLD_PLY_TOO_LARGE_LINE : error.message)
              : error instanceof WorldSplatFormatError
                ? (format === 'ply' ? WORLD_PLY_FORMAT_LINE : WORLD_SPZ_FORMAT_LINE)
              : undefined,
            failure,
          );
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
      if (currentMesh) {
        currentMesh.removeFromParent();
        disposeSparkQuietly(currentMesh);
      }
    };
  }, [coordinateFrame, format, forwardAxis, framing, getThree, groundPlaneOffset, metricScaleFactor, onError,
    onReady, splatVariant, src, upAxis]);

  return (
    <>
      <primitive object={spark} dispose={null} />
      {splat && <primitive object={splat} dispose={null} />}
    </>
  );
}

const ENVIRONMENT_ORBIT_MIN_DISTANCE = 0.01;

function syncOrbitControls(
  controls: OrbitControls,
  bounds: WorldSceneBounds | null,
  target: Vector3,
): void {
  controls.maxDistance = bounds ? bounds.orbitMaxDistance ?? worldOrbitMaxDistance(bounds.radius) : 1_000;
  controls.minDistance = bounds?.orbitMinDistance ?? ENVIRONMENT_ORBIT_MIN_DISTANCE;
  controls.target = target;
  controls.update();
}

function makeCanvasKeyboardFocusable(canvas: HTMLCanvasElement): void {
  canvas.tabIndex = 0;
}

function configureAccessibleCanvas(
  canvas: HTMLCanvasElement,
  label: string,
  describedById?: string,
  framing: 'environment' | 'object' = 'environment',
): void {
  makeCanvasKeyboardFocusable(canvas);
  // R3F applies the Canvas className to its wrapper. Mark the actual WebGL
  // canvas so its keyboard focus treatment cannot depend on renderer markup.
  canvas.classList.add('world-environment-viewer__interactive-canvas');
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', framing === 'object'
    ? `${label}, interactive 3D object`
    : `${label} interactive 3D environment`);
  if (describedById) canvas.setAttribute('aria-describedby', describedById);
  else canvas.removeAttribute('aria-describedby');
}

interface FlyFrameVectors {
  move: Vector3;
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

function advanceFlyCamera(
  camera: PerspectiveCamera,
  keys: Set<string>,
  pendingPan: Vector3,
  vectors: FlyFrameVectors,
  radius: number,
  delta: number,
): void {
  const { move, forward, right, up } = vectors;
  move.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.z -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.z += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.x += 1;
  if (keys.has('KeyE') || keys.has('Space')) move.y += 1;
  if (keys.has('KeyQ') || keys.has('ShiftLeft')) move.y -= 1;

  const speed = worldFlySpeedMetersPerSecond(radius) * Math.min(delta, 0.05);
  camera.getWorldDirection(forward);
  forward.normalize();
  right.crossVectors(forward, up).normalize();
  if (move.lengthSq() > 0) {
    move.normalize();
    camera.position.addScaledVector(forward, -move.z * speed);
    camera.position.addScaledVector(right, move.x * speed);
    camera.position.addScaledVector(up, move.y * speed);
  }

  if (pendingPan.lengthSq() > 0) {
    const gestureScale = worldFlyGestureScale(radius);
    camera.position.addScaledVector(right, pendingPan.x * gestureScale);
    camera.position.addScaledVector(up, -pendingPan.y * gestureScale);
    camera.position.addScaledVector(forward, -pendingPan.z * gestureScale);
    pendingPan.set(0, 0, 0);
  }
}

function OrbitNavigation({
  bounds,
  resetToken,
  target,
}: {
  bounds: WorldSceneBounds | null;
  resetToken: number;
  target: Vector3;
}) {
  const { camera, gl } = useThree();
  const perspectiveCamera = camera as PerspectiveCamera;
  // Made in an effect, with its cleanup (review r3 LOW-4): the constructor
  // attaches its listeners, so a memo's discarded copy (StrictMode renders
  // twice) stayed on the canvas and every wheel zoomed twice.
  const controlsRef = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const next = new OrbitControls(perspectiveCamera, gl.domElement);
    next.enableDamping = true;
    next.dampingFactor = 0.08;
    next.screenSpacePanning = true;
    next.minDistance = ENVIRONMENT_ORBIT_MIN_DISTANCE;
    next.target = target;
    controlsRef.current = next;
    return () => {
      if (controlsRef.current === next) controlsRef.current = null;
      next.dispose();
    };
  }, [gl, perspectiveCamera, target]);

  // After the one above in the same commit, so new controls get the bounds.
  useEffect(() => {
    const controls = controlsRef.current;
    if (controls) syncOrbitControls(controls, bounds, target);
  }, [bounds, gl, perspectiveCamera, resetToken, target]);

  useFrame(() => controlsRef.current?.update());
  return null;
}

interface PointerPosition {
  x: number;
  y: number;
  pointerType: string;
}

function FlyNavigation({
  bounds,
  resetToken,
  target,
}: {
  bounds: WorldSceneBounds | null;
  resetToken: number;
  target: Vector3;
}) {
  const { camera, gl } = useThree();
  const perspectiveCamera = camera as PerspectiveCamera;

  const pressedKeys = useRef(new Set<string>());
  const pointers = useRef(new Map<number, PointerPosition>());
  const yawPitch = useRef(new Vector2());
  const pendingPan = useRef(new Vector3());
  const lastGesture = useRef<{ midpointX: number; midpointY: number; distance: number } | null>(null);
  const frameVectors = useMemo<FlyFrameVectors>(() => ({
    move: new Vector3(),
    forward: new Vector3(),
    right: new Vector3(),
    up: new Vector3(0, 1, 0),
  }), []);
  const euler = useMemo(() => new Euler(0, 0, 0, 'YXZ'), []);

  useEffect(() => {
    if (!bounds) return;
    syncWorldFlyAngles(perspectiveCamera, euler, yawPitch.current);
  }, [bounds, euler, perspectiveCamera, resetToken]);

  useEffect(() => {
    const canvas = gl.domElement;
    const activeKeys = pressedKeys.current;
    const activePointers = pointers.current;
    makeCanvasKeyboardFocusable(canvas);

    const rotateCamera = (dx: number, dy: number) => {
      yawPitch.current.x -= dx * 0.0025;
      yawPitch.current.y = MathUtils.clamp(yawPitch.current.y - dy * 0.0025, -Math.PI * 0.49, Math.PI * 0.49);
      euler.set(yawPitch.current.y, yawPitch.current.x, 0, 'YXZ');
      perspectiveCamera.quaternion.setFromEuler(euler);
    };

    const onPointerDown = (event: PointerEvent) => {
      canvas.focus({ preventScroll: true });
      syncWorldFlyAngles(perspectiveCamera, euler, yawPitch.current);
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pointerType: event.pointerType });
      canvas.setPointerCapture?.(event.pointerId);
      lastGesture.current = null;
    };
    const onPointerMove = (event: PointerEvent) => {
      const previous = activePointers.get(event.pointerId);
      if (!previous) return;
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pointerType: event.pointerType });

      const active = [...activePointers.values()];
      if (active.length === 1) {
        rotateCamera(event.clientX - previous.x, event.clientY - previous.y);
        lastGesture.current = null;
        return;
      }

      const first = active[0];
      const second = active[1];
      const midpointX = (first.x + second.x) * 0.5;
      const midpointY = (first.y + second.y) * 0.5;
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const last = lastGesture.current;
      if (last) {
        pendingPan.current.x += (midpointX - last.midpointX) * -0.004;
        pendingPan.current.y += (midpointY - last.midpointY) * 0.004;
        pendingPan.current.z += (distance - last.distance) * -0.008;
      }
      lastGesture.current = { midpointX, midpointY, distance };
    };
    const onPointerUp = (event: PointerEvent) => {
      activePointers.delete(event.pointerId);
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      lastGesture.current = null;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      pendingPan.current.z += event.deltaY * 0.002;
      pendingPan.current.x += event.deltaX * 0.001;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      activeKeys.add(event.code);
      if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => activeKeys.delete(event.code);
    const onBlur = () => activeKeys.clear();
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('blur', onBlur);
    canvas.addEventListener('contextmenu', onContextMenu);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('contextmenu', onContextMenu);
      activeKeys.clear();
      activePointers.clear();
    };
  }, [euler, gl, perspectiveCamera]);

  useFrame((_, delta) => {
    const radius = bounds?.radius ?? 3;
    advanceFlyCamera(
      perspectiveCamera,
      pressedKeys.current,
      pendingPan.current,
      frameVectors,
      radius,
      delta,
    );
    perspectiveCamera.getWorldDirection(frameVectors.forward).normalize();
    target
      .copy(perspectiveCamera.position)
      .addScaledVector(frameVectors.forward, MathUtils.clamp(radius * 0.18, 2.5, 8));
  });

  return null;
}

function WorldNavigation({
  bounds,
  navigationMode,
  resetToken,
}: {
  bounds: WorldSceneBounds | null;
  navigationMode: WorldNavigationMode;
  resetToken: number;
}) {
  const { camera } = useThree();
  const perspectiveCamera = camera as PerspectiveCamera;
  const target = useMemo(() => new Vector3(), []);
  const appliedResetToken = useRef<number | null>(null);

  useEffect(() => {
    if (!bounds) return;
    if (appliedResetToken.current !== null && appliedResetToken.current === resetToken) return;
    placeWorldCamera(perspectiveCamera, target, bounds);
    appliedResetToken.current = resetToken;
  }, [bounds, perspectiveCamera, resetToken, target]);

  return navigationMode === 'orbit' ? (
    <OrbitNavigation bounds={bounds} resetToken={resetToken} target={target} />
  ) : (
    <FlyNavigation bounds={bounds} resetToken={resetToken} target={target} />
  );
}

function ViewerFallback({
  thumbnail,
  label,
  detail,
  quiet = false,
}: {
  thumbnail?: string;
  label: string;
  detail?: string;
  quiet?: boolean;
}) {
  // The dialog says why in its own line (GM, PR #203 r2: the specific line
  // replaces "Interactive preview unavailable", never both).
  if (quiet) return <div className="world-environment-viewer__fallback" aria-hidden="true" />;
  return (
    <div className="world-environment-viewer__fallback" role="img" aria-label={`${label}. Interactive 3D preview unavailable.`}>
      {thumbnail && <img src={thumbnail} alt="" loading="lazy" />}
      <div className="world-environment-viewer__fallback-copy">
        <strong>Interactive preview unavailable</strong>
        <span>{detail ?? 'Use the panorama or downloaded splat in a compatible 3D viewer.'}</span>
      </div>
    </div>
  );
}

export function WorldEnvironmentViewer({
  src,
  splatVariant,
  thumbnail,
  label,
  navigationMode,
  resetToken,
  metricScaleFactor,
  groundPlaneOffset,
  coordinateFrame,
  format,
  upAxis,
  forwardAxis,
  framing,
  describedById,
  onStatusChange,
  onFailure,
  quietFallback = false,
}: WorldEnvironmentViewerProps) {
  const [viewerState, setViewerState] = useState<ViewerState>({
    src,
    status: 'loading',
    bounds: null,
  });
  const supported = useMemo(() => supportsSparkRenderer(), []);
  const status: WorldViewerStatus = !supported
    ? 'error'
    : viewerState.src === src ? viewerState.status : 'loading';
  const bounds = viewerState.src === src ? viewerState.bounds : null;

  const updateStatus = useCallback((
    next: WorldViewerStatus,
    nextBounds: WorldSceneBounds | null = null,
    errorMessage?: string,
  ) => {
    setViewerState({ src, status: next, bounds: nextBounds, errorMessage });
    onStatusChange?.(next);
  }, [onStatusChange, src]);

  const handleReady = useCallback((nextBounds: WorldSceneBounds) => {
    updateStatus('ready', nextBounds);
  }, [updateStatus]);

  const handleError = useCallback((message?: string, failure: WorldViewerFailure = 'other') => {
    updateStatus('error', null, message);
    onFailure?.(failure);
  }, [onFailure, updateStatus]);
  const handleBoundaryError = useCallback(() => handleError(undefined, 'other'), [handleError]);

  useEffect(() => {
    onStatusChange?.(supported ? 'loading' : 'error');
    if (!supported) onFailure?.('webgl');
  }, [onFailure, onStatusChange, src, supported]);

  const fallback = (
    <ViewerFallback
      thumbnail={thumbnail}
      label={label}
      quiet={quietFallback}
      detail={(viewerState.src === src ? viewerState.errorMessage : undefined)
        ?? (format === 'ply' ? WORLD_PLY_FORMAT_LINE : undefined)}
    />
  );
  if (!supported || status === 'error') return fallback;

  return (
    <div
      className={`world-environment-viewer world-environment-viewer--${status}`}
    >
      {thumbnail && <img className="world-environment-viewer__backdrop" src={thumbnail} alt="" aria-hidden="true" />}
      <ViewerErrorBoundary fallback={fallback} onError={handleBoundaryError} resetKey={src}>
        <Canvas
          className="world-environment-viewer__canvas"
          camera={{ fov: 58, near: 0.01, far: 10_000, position: [0, 1.6, 4] }}
          dpr={[1, 1.5]}
          frameloop="always"
          gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
          fallback={fallback}
          onCreated={({ gl }) => configureAccessibleCanvas(gl.domElement, label, describedById, framing)}
        >
          <color attach="background" args={['#05070a']} />
          <WorldSplatScene
            src={src}
            splatVariant={splatVariant}
            metricScaleFactor={metricScaleFactor}
            groundPlaneOffset={groundPlaneOffset}
            coordinateFrame={coordinateFrame}
            format={format}
            upAxis={upAxis}
            forwardAxis={forwardAxis}
            framing={framing}
            onReady={handleReady}
            onError={handleError}
          />
          <WorldNavigation
            bounds={bounds}
            navigationMode={navigationMode}
            resetToken={resetToken}
          />
        </Canvas>
      </ViewerErrorBoundary>
      {status === 'loading' && (
        <div className="world-environment-viewer__loading" role="status" aria-live="polite">
          <span className="world-environment-viewer__spinner" aria-hidden="true" />
          Loading spatial preview…
        </div>
      )}
    </div>
  );
}
