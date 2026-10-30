import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PerspectiveCamera, Vector3 } from 'three';
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
    useThree: (selector?: (state: unknown) => unknown) => {
      const state = getThreeState();
      return selector
        ? selector({ ...state, get: () => ({ ...state, size: { width: 800, height: 600 } }) })
        : state;
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

vi.mock('../../src/lib/worldSplat', () => ({
  fetchWorldSplatBytes: viewerHarness.fetchWorldSplatBytes,
  WorldSplatFormatError: class MockWorldSplatFormatError extends Error {},
  WorldSplatTooLargeError: class MockWorldSplatTooLargeError extends Error {},
}));

import { WorldEnvironmentViewer } from '../../src/components/nodes/WorldEnvironmentViewer';
import { RequestFailedError } from '../../src/lib/errorCopy';
import { OBJECT_ORBIT_MAX_DISTANCE_FACTOR, OBJECT_VIEW_MARGIN } from '../../src/lib/worldNavigation';

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
    // Sphere radius 0.4 (98th percentile), fov 58 at 800x600: the vertical half
    // is the narrower, so r / sin(29 deg) x margin.
    expect(distance).toBeCloseTo((0.4 / Math.sin((29 * Math.PI) / 180)) * OBJECT_VIEW_MARGIN, 1);
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
    const controls = viewerHarness.controls.at(-1) as { maxDistance: number };
    expect(controls.maxDistance).toBeCloseTo(distance * OBJECT_ORBIT_MAX_DISTANCE_FACTOR, 1);
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

    viewerHarness.fetchWorldSplatBytes.mockRejectedValueOnce(new RequestFailedError("Couldn't load the world.", 500));
    const onOther = vi.fn();
    render(
      <WorldEnvironmentViewer src="/api/outputs/run/broken.ply" format="ply" label="Idol object"
        navigationMode="orbit" resetToken={0} framing="object" onFailure={onOther} quietFallback />,
    );
    await waitFor(() => expect(onOther).toHaveBeenCalledWith('other'));
  });
});
