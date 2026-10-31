/**
 * Review r3 LOW-4: OrbitControls attach their listeners when they are made.
 * Made in a memo, StrictMode's second render left a discarded copy on the
 * canvas, so every wheel zoomed twice. Here the real OrbitControls run under
 * StrictMode: one wheel event zooms once.
 */
import { act, render, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  state: null as null | { gl: { domElement: HTMLCanvasElement }; camera: unknown; invalidate: () => void },
  frames: new Set<(state: unknown, delta: number) => void>(),
}));

vi.mock('@react-three/fiber', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const three = await vi.importActual<typeof import('three')>('three');
  const state = () => {
    if (!harness.state) {
      harness.state = {
        gl: { domElement: document.createElement('canvas') },
        camera: new three.PerspectiveCamera(58, 1, 0.01, 10_000),
        invalidate: vi.fn(),
      };
    }
    return harness.state;
  };
  const get = () => ({ ...state(), size: { width: 800, height: 600 } });
  return {
    Canvas: ({ className, children, onCreated }: {
      className?: string; children?: ReactNode; onCreated?: (s: { gl: { domElement: HTMLCanvasElement } }) => void;
    }) => {
      const current = state();
      return React.createElement(React.Fragment, null,
        React.createElement('canvas', { className, 'data-testid': 'stage', ref: (canvas: HTMLCanvasElement | null) => {
          if (!canvas) return;
          current.gl.domElement = canvas;
          onCreated?.({ gl: current.gl });
        } }),
        children);
    },
    // Each mounted callback, once: the frame loop runs what is mounted now.
    useFrame: (callback: (state: unknown, delta: number) => void) => {
      React.useEffect(() => {
        harness.frames.add(callback);
        return () => { harness.frames.delete(callback); };
      });
    },
    useThree: (selector?: (s: unknown) => unknown) => (selector ? selector({ ...state(), get }) : state()),
  };
});

vi.mock('@sparkjsdev/spark', async () => {
  const three = await vi.importActual<typeof import('three')>('three');
  class SparkRenderer extends three.Object3D { dispose = vi.fn(); }
  class SplatMesh extends three.Object3D {
    // Never loads: the controls are what this test looks at.
    initialized = new Promise<this>(() => undefined);
    dispose = vi.fn();
  }
  return { SparkRenderer, SplatMesh, utils: { decompressPartialGzip: vi.fn() } };
});

vi.mock('../../src/lib/worldSplat', () => ({
  fetchWorldSplatBytes: () => new Promise(() => undefined),
  WorldSplatFormatError: class extends Error {},
  WorldSplatTooLargeError: class extends Error {},
}));

import { WorldEnvironmentViewer } from '../../src/components/nodes/WorldEnvironmentViewer';

function frame() {
  for (const callback of [...harness.frames]) callback({}, 1 / 60);
}

describe('the orbit viewer under StrictMode (review r3 LOW-4)', () => {
  afterEach(() => {
    harness.state = null;
    harness.frames.clear();
    vi.restoreAllMocks();
  });

  it('zooms once per wheel event', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGL2RenderingContext);
    const { getByTestId } = render(
      <StrictMode>
        <WorldEnvironmentViewer src="/api/outputs/run/idol.ply" format="ply" label="Idol object"
          navigationMode="orbit" resetToken={0} framing="object" />
      </StrictMode>,
    );
    const camera = harness.state!.camera as PerspectiveCamera;
    await waitFor(() => expect(harness.frames.size).toBeGreaterThan(0));
    camera.position.set(0, 0, 10);
    // Let damping settle at the start, then one wheel tick.
    for (let i = 0; i < 120; i += 1) frame();
    const before = camera.position.length();
    act(() => {
      getByTestId('stage').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true }));
    });
    for (let i = 0; i < 240; i += 1) frame();
    const ratio = camera.position.length() / before;
    // OrbitControls dolly by 0.95 per normalised wheel step (zoomSpeed 1,
    // deltaY 100): one copy gives 1 / 0.95, two gave 1 / 0.95².
    expect(ratio).toBeCloseTo(1 / 0.95, 3);
  });
});
