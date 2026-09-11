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
    useThree: () => getThreeState(),
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

describe('WorldEnvironmentViewer', () => {
  beforeEach(() => {
    viewerHarness.renderScene = false;
    viewerHarness.threeState = null;
    viewerHarness.meshInitializations.length = 0;
    viewerHarness.meshes.length = 0;
    viewerHarness.frameCallbacks.length = 0;
    viewerHarness.splatCount = 16;
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
    expect(camera.position.toArray()).toEqual([0, 2.75, 0]);

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
});
