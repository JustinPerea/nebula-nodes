import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 16 of PR #114 (review 15, L1; GM): zoom, pan and selection while
 * offline are local view state. Nothing is sent then (and nothing pulses);
 * once Nebula answers again the current view goes out, so agents read the
 * canvas the person is looking at. Plus GM's library count line offline.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
}));
const view = vi.hoisted(() => ({ publish: vi.fn(async () => undefined) }));
vi.mock('../src/lib/canvasView', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasView')>(),
  publishCanvasView: view.publish,
}));

import { CanvasViewReporter } from '../src/components/canvas/CanvasViewReporter';
import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { noteBackendConnection, resetBackendConnectionForTests, subscribeOfflinePulse } from '../src/lib/backendConnection';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_UI_STATE = { ...useUIStore.getState() };
const settle = (ms = 400) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  view.publish.mockClear();
  useUIStore.setState(INITIAL_UI_STATE, true);
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
});

describe('L1: the canvas view report', () => {
  it('sends nothing while offline, with no pulse, and sends the current view once Nebula answers again', async () => {
    let pulses = 0;
    const stop = subscribeOfflinePulse(() => { pulses += 1; });
    noteBackendConnection('offline');
    render(<ReactFlowProvider><CanvasViewReporter /></ReactFlowProvider>);
    await settle();
    expect(view.publish).not.toHaveBeenCalled();
    expect(pulses).toBe(0);
    act(() => noteBackendConnection('online'));
    await settle();
    expect(view.publish).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('the library while offline (GM, round 16)', () => {
  it('its count line says adding is paused, and goes back to "Choose a node to add" online', () => {
    useUIStore.setState((state) => ({
      libraryCollapsed: { __nebulaLibraryInit: true },
      panels: { ...state.panels, library: { ...state.panels.library, visible: true } },
    }));
    noteBackendConnection('offline');
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse Text nodes' }));
    const count = document.querySelector('.node-library__count')!;
    expect(count.textContent).toMatch(/^\d+ nodes? · Adding is paused while offline$/);
    act(() => noteBackendConnection('online'));
    expect(document.querySelector('.node-library__count')!.textContent).toMatch(/^\d+ nodes? · Choose a node to add$/);
  });
});
