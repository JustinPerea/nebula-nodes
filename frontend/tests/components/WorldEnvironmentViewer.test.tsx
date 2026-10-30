import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PerspectiveCamera, Vector3, type Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const viewerHarness = vi.hoisted(() => ({
  renderScene: false,
  threeState: null as null | {
    gl: { domElement: HTMLCanvasElement };
    invalidate: () => void;
    camera: unknown;
  },
  meshInitializations: [] as Promise<unknown>[],
  meshes: [] as unknown[],
  frameCallbacks: [] as Array<(state: unknown, delta: number) => void>,
  fetchWorldSplatBytes: vi.fn(),
  getSplat: vi.fn(),
  splatCount: 16,
  controls: [] as unknown[],
}));

vi.mock('@react-three/fiber', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const three = await vi.importActual<typeof import('three')>('three');
  const getThreeState = () => {
    if (!viewerHarness.threeState) {
      viewerHarness.threeState = {
        gl: { domElement: document.createElement('canvas') },
        invalidate: vi.fn(),
        camera: new three.PerspectiveCamera(58, 1, 0.01, 10_000),
      };
    }
    return viewerHarness.threeState;
  };
  const getters = new WeakMap<object, () => unknown>();
  const stableGet = (state: object): (() => unknown) => {
    let get = getters.get(state);
    if (!get) {
      get = () => ({ ...state, size: { width: 800, height: 600 } });
      getters.set(state, get);
    }
    return get;
  };

  return {
    Canvas: ({
      className,
      children,
      onCreated,
    }: {
      className?: string;
      children?: ReactNode;
      onCreated?: (state: { gl: { domElement: HTMLCanvasElement } }) => void;
    }) => {
      const state = getThreeState();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('canvas', {
          className,
          ref: (canvas: HTMLCanvasElement | null) => {
            if (!canvas) return;
            state.gl.domElement = canvas;
            onCreated?.({ gl: state.gl });
          },
        }),
        viewerHarness.renderScene ? children : null,
      );
    },
    useFrame: (callback: (state: unknown, delta: number) => void) => {
      viewerHarness.frameCallbacks.push(callback);
    },
    // The viewer reads `useThree((state) => state.get)` for the object framing's
    // camera and stage size; without a selector, the state itself.
    // R3F's `get` is one function for the store's life; a new one per call
    // re-ran the scene's load effect on every render, a 'ready' loop that
    // failed the camera test under load (PR #203 round 3).
    useThree: (selector?: (state: unknown) => unknown) => {
      const state = getThreeState();
      return selector ? selector({ ...state, get: stableGet(state) }) : state;
    },
  };
});

vi.mock('@sparkjsdev/spark', async () => {
  const three = await vi.importActual<typeof import('three')>('three');

  class MockSparkRenderer extends three.Object3D {
    dispose = vi.fn();
  }

  class MockSplatMesh extends three.Object3D {
    initialized: Promise<this>;
    packedSplats = {
      getNumSplats: () => viewerHarness.splatCount,
      getSplat: (index: number) => viewerHarness.getSplat(index),
    };
    dispose = vi.fn();

    constructor() {
      super();
      const initialization = viewerHarness.meshInitializations.shift() ?? Promise.resolve();
      this.initialized = initialization.then(() => this);
      viewerHarness.meshes.push(this);
    }
  }

  return {
    SparkRenderer: MockSparkRenderer,
    SplatMesh: MockSplatMesh,
    utils: { decompressPartialGzip: vi.fn() },
  };
});

vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const three = await vi.importActual<typeof import('three')>('three');
  return {
    OrbitControls: class MockOrbitControls {
      constructor() {
        viewerHarness.controls.push(this);
      }
      target = new three.Vector3();
      maxDistance = 1_000;
      enableDamping = false;
      dampingFactor = 0;
      screenSpacePanning = false;
      minDistance = 0;
      update = vi.fn();
      dispose = vi.fn();
    },
  };
});

// Spied, not replaced: every Spark dispose must go through it, so Spark's
// "Worker terminate" rejections that follow are marked handled.
vi.mock('../../src/lib/sparkDispose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/sparkDispose')>();
  return { ...actual, disposeSparkQuietly: vi.fn(actual.disposeSparkQuietly) };
});

vi.mock('../../src/lib/worldSplat', () => ({
  fetchWorldSplatBytes: viewerHarness.fetchWorldSplatBytes,
  WorldSplatFormatError: class MockWorldSplatFormatError extends Error {},
  WorldSplatTooLargeError: class MockWorldSplatTooLargeError extends Error {},
}));

import { WorldEnvironmentViewer } from '../../src/components/nodes/WorldEnvironmentViewer';
import { RequestFailedError } from '../../src/lib/errorCopy';
import { disposeSparkQuietly } from '../../src/lib/sparkDispose';
import {
  OBJECT_ORBIT_MAX_DISTANCE_FACTOR, OBJECT_ORBIT_MIN_RADIUS_FACTOR, OBJECT_VIEW_MARGIN, OBJECT_VIEW_UNIT_RADIUS,
} from '../../src/lib/worldNavigation';

describe('WorldEnvironmentViewer', () => {
  beforeEach(() => {
    viewerHarness.renderScene = false;
    viewerHarness.threeState = null;
    viewerHarness.meshInitializations.length = 0;
    viewerHarness.meshes.length = 0;
    viewerHarness.frameCallbacks.length = 0;
    viewerHarness.splatCount = 16;
    viewerHarness.controls.length = 0;
    viewerHarness.fetchWorldSplatBytes.mockReset();
    viewerHarness.fetchWorldSplatBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    viewerHarness.getSplat.mockReset();
    viewerHarness.getSplat.mockImplementation((index: number) => ({
      center: new Vector3((index % 4) - 1.5, Math.floor(index / 8), -Math.floor(index / 4)),
      opacity: 1,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the thumbnail fallback and reports an error when WebGL2 is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const onStatusChange = vi.fn();

    render(
      <WorldEnvironmentViewer
        src="/api/outputs/run/world.spz"
        thumbnail="/api/outputs/run/world.jpg"
        label="Courtyard"
        navigationMode="orbit"
        resetToken={0}
        onStatusChange={onStatusChange}
      />,
    );

    expect(screen.getByRole('img', { name: /Courtyard.*preview unavailable/i }))
      .toHaveTextContent('Interactive preview unavailable');
    expect(screen.queryByRole('application')).toBeNull();
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('error'));
  });

  it('makes the interactive application surface keyboard-focusable', async () => {
    const loseContext = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue({ loseContext }),
    } as unknown as WebGL2RenderingContext);

    render(
      <WorldEnvironmentViewer
        src="/api/outputs/run/world.spz"
        label="Courtyard"
        navigationMode="orbit"
        resetToken={0}
      />,
    );

    const application = screen.getByRole('application', { name: /Courtyard interactive/i });
    expect(application).toHaveAttribute('tabindex', '0');
    expect(application).toHaveClass('world-environment-viewer__interactive-canvas');
    application.focus();
    expect(application).toHaveFocus();
    await waitFor(() => expect(loseContext).toHaveBeenCalledTimes(1));
  });

  it('preserves the Canvas camera across mode and quality changes until explicit reset', async () => {
    viewerHarness.renderScene = true;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    const onStatusChange = vi.fn();
    const props = {
      label: 'Courtyard',
      navigationMode: 'orbit' as const,
      resetToken: 0,
      metricScaleFactor: 1,
      groundPlaneOffset: 2.75,
      coordinateFrame: 'marble_raw_opencv',
      onStatusChange,
    };
    const { rerender } = render(
      <WorldEnvironmentViewer src="/api/outputs/run/world-500k.spz" {...props} />,
    );

    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith('ready'));
    const application = screen.getByRole('application');
    const camera = viewerHarness.threeState?.camera as PerspectiveCamera;
    // 'ready' is reported before the render whose effect places the camera.
    await waitFor(() => expect(camera.position.toArray()).toEqual([0, 2.75, 0]));

    camera.position.set(9, 8, 7);
    camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.7);
    const preservedQuaternion = camera.quaternion.toArray();
    rerender(
      <WorldEnvironmentViewer
        src="/api/outputs/run/world-500k.spz"
        {...props}
        navigationMode="fly"
      />,
    );
    expect(screen.getByRole('application')).toBe(application);
    expect(camera.position.toArray()).toEqual([9, 8, 7]);
    expect(camera.quaternion.toArray()).toEqual(preservedQuaternion);

    rerender(
      <WorldEnvironmentViewer
        src="/api/outputs/run/world-100k.spz"
        {...props}
        navigationMode="fly"
      />,
    );
    await waitFor(() => {
      expect(onStatusChange.mock.calls.filter(([status]) => status === 'ready')).toHaveLength(2);
    });
    expect(screen.getByRole('application')).toBe(application);
    expect(camera.position.toArray()).toEqual([9, 8, 7]);
    expect(camera.quaternion.toArray()).toEqual(preservedQuaternion);

    rerender(
      <WorldEnvironmentViewer
        src="/api/outputs/run/world-100k.spz"
        {...props}
        navigationMode="fly"
        resetToken={1}
      />,
    );
    await waitFor(() => expect(camera.position.toArray()).toEqual([0, 2.75, 0]));
    const direction = camera.getWorldDirection(new Vector3());
    expect(direction.x).toBeCloseTo(0, 8);
    expect(direction.y).toBeCloseTo(0, 8);
    expect(direction.z).toBeCloseTo(-1, 8);
  });

  it('terminally disposes a mesh whose initialization resolves after cancellation', async () => {
    viewerHarness.renderScene = true;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    let resolveInitialization: (() => void) | undefined;
    viewerHarness.meshInitializations.push(new Promise<void>((resolve) => {
      resolveInitialization = resolve;
    }));
    const onStatusChange = vi.fn();
    const { unmount } = render(
      <WorldEnvironmentViewer
        src="/api/outputs/run/world.spz"
        label="Courtyard"
        navigationMode="orbit"
        resetToken={0}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => expect(viewerHarness.meshes).toHaveLength(1));
    const mesh = viewerHarness.meshes[0] as { dispose: ReturnType<typeof vi.fn> };
    unmount();
    expect(mesh.dispose).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialization?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(mesh.dispose).toHaveBeenCalledTimes(2));
    // Both disposes are the quiet one (PR #203 r2 review, NIT-1).
    expect(vi.mocked(disposeSparkQuietly).mock.calls.filter(([target]) => target === mesh)).toHaveLength(2);
    expect(onStatusChange).not.toHaveBeenCalledWith('ready');
  });

  it('frames an object from a 3/4 view on its forward side, at the distance its sphere fits', async () => {
    viewerHarness.renderScene = true;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    // 64 centers on a sphere of radius 0.4 around the origin.
    viewerHarness.splatCount = 64;
    viewerHarness.getSplat.mockImplementation((index: number) => {
      const theta = (index / 64) * Math.PI * 2 * 7;
      const z = (index / 63) * 2 - 1;
      const ring = Math.sqrt(1 - z * z);
      return { center: new Vector3(Math.cos(theta) * ring * 0.4, Math.sin(theta) * ring * 0.4, z * 0.4), opacity: 1 };
    });
    const onStatusChange = vi.fn();
    render(
      <WorldEnvironmentViewer
        src="/api/outputs/run/idol.ply"
        format="ply"
        label="Idol object"
        navigationMode="orbit"
        resetToken={0}
        upAxis="-y"
        forwardAxis="x"
        framing="object"
        onStatusChange={onStatusChange}
      />,
    );
    expect(screen.getByRole('application', { name: 'Idol object, interactive 3D object' })).toBeInTheDocument();
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith('ready'));
    const camera = viewerHarness.threeState?.camera as PerspectiveCamera;
    await waitFor(() => expect(camera.position.length()).toBeGreaterThan(0.5));

    const offset = camera.position.clone();
    const distance = offset.length();
    // Drawn at the unit radius (review r3 LOW-3): the 0.4 sphere is scaled 2.5x.
    const scale = (viewerHarness.meshes.at(-1) as Object3D).scale.x;
    expect(scale * 0.4).toBeCloseTo(OBJECT_VIEW_UNIT_RADIUS, 1);
    const radius = 0.4 * scale;
    // Sphere radius 0.4 (98th percentile), fov 58 at 800x600: the vertical half
    // is the narrower, so r / sin(29 deg) x margin.
    expect(distance).toBeCloseTo((radius / Math.sin((29 * Math.PI) / 180)) * OBJECT_VIEW_MARGIN, 1);
    const direction = offset.normalize();
    // Idol's +X front, 30 degrees off it about +Y and 15 degrees above.
    const pitch = (15 * Math.PI) / 180;
    const yaw = (30 * Math.PI) / 180;
    expect(direction.y).toBeCloseTo(Math.sin(pitch), 2);
    expect(direction.x).toBeCloseTo(Math.cos(pitch) * Math.cos(yaw), 2);
    expect(direction.z).toBeCloseTo(-Math.cos(pitch) * Math.sin(yaw), 2);
    // It looks at the object, and orbit zooms out to 4 framing distances, not
    // an environment's scale.
    const look = camera.getWorldDirection(new Vector3());
    expect(look.dot(direction)).toBeCloseTo(-1, 2);
    const controls = viewerHarness.controls.at(-1) as { maxDistance: number; minDistance: number };
    expect(controls.maxDistance).toBeCloseTo(distance * OBJECT_ORBIT_MAX_DISTANCE_FACTOR, 1);
    // It zooms in to a fifth of its radius, and the clip planes come from it.
    expect(controls.minDistance).toBeCloseTo(radius * OBJECT_ORBIT_MIN_RADIUS_FACTOR, 2);
    expect(camera.near).toBeLessThan(controls.minDistance);
    expect(camera.far).toBeGreaterThanOrEqual(controls.maxDistance + 2 * radius);
  });

  it('opens a 1 mm object at the same share of the stage, zoomable, with clip planes at its scale (review LOW 2)', async () => {
    viewerHarness.renderScene = true;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    viewerHarness.splatCount = 64;
    viewerHarness.getSplat.mockImplementation((index: number) => {
      const theta = (index / 64) * Math.PI * 2 * 7;
      const z = (index / 63) * 2 - 1;
      const ring = Math.sqrt(1 - z * z);
      return { center: new Vector3(Math.cos(theta) * ring * 0.0005, Math.sin(theta) * ring * 0.0005, z * 0.0005),
        scales: new Vector3(1e-5, 1e-5, 1e-5), opacity: 1 };
    });
    const onStatusChange = vi.fn();
    render(
      <WorldEnvironmentViewer src="/api/outputs/run/tiny.ply" format="ply" label="Tiny" navigationMode="orbit"
        resetToken={0} upAxis="-y" forwardAxis="x" framing="object" onStatusChange={onStatusChange} />,
    );
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith('ready'));
    const camera = viewerHarness.threeState?.camera as PerspectiveCamera;
    await waitFor(() => expect(camera.position.length()).toBeGreaterThan(0.0005));
    const distance = camera.position.length();
    // Drawn at the unit radius: scaled 2,000x.
    const scale = (viewerHarness.meshes.at(-1) as Object3D).scale.x;
    expect(scale * 0.0005).toBeCloseTo(OBJECT_VIEW_UNIT_RADIUS, 1);
    const radius = 0.0005 * scale;
    // The same framing as the 0.4 sphere above, to within 2%, a million times smaller.
    expect(distance / ((radius / Math.sin((29 * Math.PI) / 180)) * OBJECT_VIEW_MARGIN)).toBeCloseTo(1, 1);
    const controls = viewerHarness.controls.at(-1) as { minDistance: number; maxDistance: number };
    // Orbit's old 0.01 floor pushed the camera 7x back; the near plane hid it.
    expect(controls.minDistance).toBeLessThan(distance);
    expect(camera.near).toBeLessThan(distance - radius);
  });

  it('draws a ×20,000 object at the unit radius, so its zoom-out limit stays in range (review r3 LOW-3)', async () => {
    viewerHarness.renderScene = true;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    // A normal object (radius 0.35) made 20,000 times larger: radius 7,000.
    viewerHarness.splatCount = 64;
    viewerHarness.getSplat.mockImplementation((index: number) => {
      const theta = (index / 64) * Math.PI * 2 * 7;
      const z = (index / 63) * 2 - 1;
      const ring = Math.sqrt(1 - z * z);
      return { center: new Vector3(Math.cos(theta) * ring * 7_000, Math.sin(theta) * ring * 7_000, z * 7_000),
        scales: new Vector3(140, 140, 140), opacity: 1 };
    });
    const onStatusChange = vi.fn();
    render(
      <WorldEnvironmentViewer src="/api/outputs/run/huge.ply" format="ply" label="Huge" navigationMode="orbit"
        resetToken={0} upAxis="-y" forwardAxis="x" framing="object" onStatusChange={onStatusChange} />,
    );
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith('ready'));
    const camera = viewerHarness.threeState?.camera as PerspectiveCamera;
    await waitFor(() => expect(camera.position.length()).toBeGreaterThan(1));
    const scale = (viewerHarness.meshes.at(-1) as Object3D).scale.x;
    expect(scale * 7_000).toBeCloseTo(OBJECT_VIEW_UNIT_RADIUS, 1);
    const controls = viewerHarness.controls.at(-1) as { minDistance: number; maxDistance: number };
    // The same numbers as any other object: the farthest Gaussian at the
    // zoom-out limit is about a dozen units away, nowhere near 65,000.
    const opening = (OBJECT_VIEW_UNIT_RADIUS / Math.sin((29 * Math.PI) / 180)) * OBJECT_VIEW_MARGIN;
    expect(camera.position.length() / opening).toBeCloseTo(1, 1);
    expect(controls.maxDistance).toBeCloseTo(opening * OBJECT_ORBIT_MAX_DISTANCE_FACTOR, 1);
    expect(controls.maxDistance + OBJECT_VIEW_UNIT_RADIUS).toBeLessThan(100);
    // The far plane covers the whole object from the zoom-out limit.
    expect(camera.far).toBeGreaterThanOrEqual(controls.maxDistance + 2 * OBJECT_VIEW_UNIT_RADIUS);
  });

  it('reports a splat whose file is gone (404) as missing, another failed request as other', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    viewerHarness.renderScene = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    viewerHarness.fetchWorldSplatBytes.mockRejectedValueOnce(new RequestFailedError("Couldn't load the world.", 404));
    const onFailure = vi.fn();
    const { unmount } = render(
      <WorldEnvironmentViewer src="/api/outputs/run/gone.ply" format="ply" label="Idol object"
        navigationMode="orbit" resetToken={0} framing="object" onFailure={onFailure} quietFallback />,
    );
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith('missing'));
    unmount();

    // Any other answer, or a dropped connection, didn't load: worth trying again (GM r3).
    for (const error of [new RequestFailedError("Couldn't load the world.", 500), new TypeError('Failed to fetch')]) {
      viewerHarness.fetchWorldSplatBytes.mockRejectedValueOnce(error);
      const onLoad = vi.fn();
      const view = render(
        <WorldEnvironmentViewer src="/api/outputs/run/broken.ply" format="ply" label="Idol object"
          navigationMode="orbit" resetToken={0} framing="object" onFailure={onLoad} quietFallback />,
      );
      await waitFor(() => expect(onLoad).toHaveBeenCalledWith('load'));
      view.unmount();
    }
    // The file came and passed the check, but Spark couldn't read it: damaged.
    viewerHarness.meshInitializations.push(Promise.reject(new Error('bad splat data')));
    const onOther = vi.fn();
    render(
      <WorldEnvironmentViewer src="/api/outputs/run/odd.ply" format="ply" label="Idol object"
        navigationMode="orbit" resetToken={0} framing="object" onFailure={onOther} quietFallback />,
    );
    await waitFor(() => expect(onOther).toHaveBeenCalledWith('other'));
  });

  it('says no WebGL 2 as its own failure, with nothing on screen when quiet (GM r2, r3)', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const onFailure = vi.fn();
    const { container } = render(
      <WorldEnvironmentViewer src="/api/outputs/run/idol.ply" format="ply" label="Idol object"
        navigationMode="orbit" resetToken={0} framing="object" onFailure={onFailure} quietFallback />,
    );
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith('webgl'));
    expect(container).not.toHaveTextContent(/Interactive preview unavailable|./);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('fetches again on a remount (the dialog\'s Try again) and recovers', async () => {
    viewerHarness.renderScene = true;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    viewerHarness.fetchWorldSplatBytes.mockRejectedValueOnce(new RequestFailedError("Couldn't load the world.", 503));
    const onFailure = vi.fn();
    const onStatusChange = vi.fn();
    const props = { src: '/api/outputs/run/idol.ply', format: 'ply' as const, label: 'Idol object',
      navigationMode: 'orbit' as const, resetToken: 0, framing: 'object' as const, onFailure, onStatusChange,
      quietFallback: true };
    const { rerender } = render(<WorldEnvironmentViewer key="0" {...props} />);
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith('load'));
    expect(viewerHarness.fetchWorldSplatBytes).toHaveBeenCalledTimes(1);
    rerender(<WorldEnvironmentViewer key="1" {...props} />);
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('ready'));
    expect(viewerHarness.fetchWorldSplatBytes.mock.calls.length).toBeGreaterThan(1);
    expect(screen.getByRole('application', { name: 'Idol object, interactive 3D object' })).toBeInTheDocument();
  });
});
