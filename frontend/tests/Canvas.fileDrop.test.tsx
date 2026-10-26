import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Files dropped from Finder onto the canvas (fix/canvas-drop-files,
// 2026-10-24): every file in a drop is handled. Images, video, audio, PDF and
// text each go to /api/uploads with create_node and the flow-space drop point
// (several fan out from it); anything else, and an upload that fails, gets a
// written line in the canvas notice.

type DropProps = { children: React.ReactNode; fitView?: boolean };
const flow = vi.hoisted(() => ({
  props: null as DropProps | null,
  fitView: vi.fn(),
}));
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: (props: DropProps) => {
    flow.props = props;
    return <div>{props.children}</div>;
  },
  Background: () => null,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // The flow-space point is the screen point halved, so a test sees it was used.
  useReactFlow: () => ({ fitView: flow.fitView, viewportInitialized: true,
    screenToFlowPosition: (point: { x: number; y: number }) => ({ x: point.x / 2, y: point.y / 2 }) }),
  useInternalNode: () => undefined,
  useStore: () => 1,
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));
vi.mock('../src/components/SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('../src/components/CanvasNavigation', () => ({ CanvasNavigation: () => null }));
vi.mock('../src/components/canvas/CanvasViewReporter', () => ({ CanvasViewReporter: () => null }));
vi.mock('../src/components/canvas/ArrangeController', () => ({ ArrangeController: () => null }));
vi.mock('../src/components/canvas/AgentCursorLayer', () => ({ AgentCursorLayer: () => null }));
vi.mock('../src/components/canvas/PinLayer', () => ({ PinLayer: () => null }));
vi.mock('../src/components/canvas/PinComposer', () => ({ PinComposer: () => null }));
vi.mock('../src/components/canvas/ProposalLayer', () => ({ ProposalLayer: () => null }));
vi.mock('../src/components/canvas/ProposalBar', () => ({ ProposalBar: () => null }));
vi.mock('../src/components/ContextMenu', () => ({ ContextMenu: () => null }));
vi.mock('../src/store/canvasPinsStore', () => ({ useCanvasPinsStore: { getState: () => ({ pins: [] }) } }));
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Canvas } from '../src/components/Canvas';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { ConnectionLostError } from '../src/lib/errorCopy';

const TYPES = 'Nebula takes images, video, audio, PDFs and text files.';
const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

function file(name: string, type = ''): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

type Transfer = { files: File[]; types: string[]; getData: (kind: string) => string };

/** Drop on the canvas wrapper (Canvas's onDrop), as the browser does. */
function fireDrop(at = { x: 600, y: 400 }, dataTransfer: Transfer) {
  const wrapper = document.querySelector('.canvas-wrapper');
  if (!wrapper) throw new Error('no canvas wrapper');
  const event = createEvent.drop(wrapper, { dataTransfer });
  // jsdom has no DragEvent, so the point is set on the event by hand.
  Object.defineProperty(event, 'clientX', { value: at.x });
  Object.defineProperty(event, 'clientY', { value: at.y });
  fireEvent(wrapper, event);
}

function dropFiles(files: File[], at?: { x: number; y: number }) {
  fireDrop(at, { files, types: ['Files'], getData: () => '' });
}

/** Each /api/uploads call's form, as {name, create_node, x, y}. */
function uploads() {
  return api.fetch.mock.calls
    .filter(([path]) => path === '/api/uploads')
    .map(([, init]) => {
      const form = (init as RequestInit).body as FormData;
      return {
        name: (form.get('file') as File).name,
        create_node: form.get('create_node'),
        x: Number(form.get('x')),
        y: Number(form.get('y')),
      };
    });
}

function notice(): string | undefined {
  return useGraphStore.getState().undoNotice?.text;
}

async function drop(files: File[], at?: { x: number; y: number }) {
  render(<Canvas />);
  await act(async () => { dropFiles(files, at); });
  // Let every size read, then every upload and its fit grace, settle.
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.fetch.mockReset().mockImplementation(async () => new Response('{}', { status: 200 }));
  flow.fitView.mockReset().mockResolvedValue(true);
  flow.props = null;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  useUIStore.setState({ ...initialUI, viewMode: 'canvas', canvasFocusRequest: null }, true);
  useGraphStore.setState({ nodes: [], edges: [], undoNotice: null, isExecuting: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe('Canvas file drop', () => {
  it.each([
    ['brief.pdf', 'application/pdf'],
    ['tone.wav', 'audio/wav'],
    ['song.mp3', 'audio/mpeg'],
    ['notes.txt', 'text/plain'],
    ['readme.md', ''],
    ['photo.png', 'image/png'],
    ['clip.mp4', 'video/mp4'],
  ])('uploads %s with create_node at the flow-space drop point', async (name, type) => {
    await drop([file(name, type)], { x: 600, y: 400 });
    expect(uploads()).toEqual([{ name, create_node: 'true', x: 300, y: 200 }]);
    expect(notice()).toBeUndefined();
  });

  it('fans several files out from the drop point without overlap', async () => {
    const names = ['a.png', 'b.pdf', 'c.wav', 'd.txt', 'e.mp4'];
    await drop(names.map((name) => file(name)), { x: 200, y: 100 });
    const sent = uploads();
    expect(sent.map((entry) => entry.name)).toEqual(names);
    expect(sent[0]).toMatchObject({ x: 100, y: 50 });
    const spots = new Set(sent.map((entry) => `${entry.x},${entry.y}`));
    expect(spots.size).toBe(names.length);
    // Deterministic: the same drop makes the same layout.
    const first = sent.map(({ x, y }) => ({ x, y }));
    cleanup();
    api.fetch.mockClear();
    await drop(names.map((name) => file(name)), { x: 200, y: 100 });
    expect(uploads().map(({ x, y }) => ({ x, y }))).toEqual(first);
    // No two cards closer than a card's width across or a card's height down.
    for (const one of first) {
      for (const other of first) {
        if (one === other) continue;
        expect(Math.abs(one.x - other.x) >= 300 || Math.abs(one.y - other.y) >= 300).toBe(true);
      }
    }
  });

  it('steps rows by the plain card height when no file gives a size', async () => {
    const names = ['a.pdf', 'b.wav', 'c.txt', 'd.md'];
    await drop(names.map((name) => file(name)), { x: 200, y: 100 });
    expect(uploads().map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 100, y: 50 }, { x: 400, y: 50 }, { x: 700, y: 50 }, { x: 100, y: 470 }]);
  });

  it('stacks rows under the tallest card, so portrait photos do not overlap', async () => {
    // 1179x2556 phone screenshots: a 240px-wide card is 70 + 520 = 590px tall.
    const sizes: Record<string, { width: number; height: number }> = {
      'a.png': { width: 1179, height: 2556 }, 'b.png': { width: 1179, height: 2556 },
      'c.png': { width: 1600, height: 900 }, 'd.png': { width: 1179, height: 2556 },
    };
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: (blob: File) => `blob:${blob.name}`, revokeObjectURL: vi.fn() }));
    class FakeImage {
      naturalWidth = 0; naturalHeight = 0;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(url: string) {
        const size = sizes[url.slice('blob:'.length)];
        queueMicrotask(() => {
          if (!size) { this.onerror?.(); return; }
          this.naturalWidth = size.width; this.naturalHeight = size.height; this.onload?.();
        });
      }
    }
    vi.stubGlobal('Image', FakeImage);
    await drop(Object.keys(sizes).map((name) => file(name, 'image/png')), { x: 200, y: 100 });
    const sent = uploads();
    expect(sent.map((entry) => entry.name)).toEqual(Object.keys(sizes));
    expect(sent.slice(0, 3).map((entry) => entry.y)).toEqual([50, 50, 50]);
    const tallest = 70 + (240 * 2556) / 1179;
    expect(sent[3].x).toBe(100);
    expect(sent[3].y).toBeGreaterThanOrEqual(50 + tallest);
  });

  it('sizes a portrait clip card by its shape, and never shorter than a plain card', async () => {
    const { dropCardHeight, dropSpots, DROP_CARD_HEIGHT } = await import('../src/lib/canvasFileDrop');
    const clip = dropCardHeight({ width: 1080, height: 1920 });
    expect(clip).toBeGreaterThanOrEqual(70 + (240 * 1920) / 1080);
    expect(dropCardHeight({ width: 1920, height: 1080 })).toBe(DROP_CARD_HEIGHT);
    expect(dropCardHeight(null)).toBe(DROP_CARD_HEIGHT);
    const spots = dropSpots({ x: 0, y: 0 }, [DROP_CARD_HEIGHT, clip, DROP_CARD_HEIGHT, DROP_CARD_HEIGHT]);
    expect(spots[3]).toEqual({ x: 0, y: clip + 40 });
  });

  it('says so when a file is not one Nebula takes, and uploads the rest', async () => {
    await drop([file('archive.zip', 'application/zip'), file('a.png', 'image/png')]);
    expect(uploads().map((entry) => entry.name)).toEqual(['a.png']);
    expect(uploads()[0]).toMatchObject({ x: 300, y: 200 });
    expect(notice()).toBe(`Couldn't add “archive.zip”. ${TYPES}`);
    expect(useGraphStore.getState().undoNotice?.tone).toBe('error');
  });

  it('says so when an upload fails, with the reason', async () => {
    api.fetch.mockImplementation(async () => new Response('', { status: 503 }));
    await drop([file('side.png', 'image/png')]);
    expect(notice()).toBe("Couldn't upload “side.png”. Nebula didn't respond. Try again.");
  });

  it('says so when the server does not answer', async () => {
    // As apiFetch throws no answer (typeerror, 2026-10-24: a bare TypeError isn't one).
    api.fetch.mockImplementation(async () => { throw new ConnectionLostError(new TypeError('Failed to fetch')); });
    await drop([file('tone.wav', 'audio/wav')]);
    expect(notice()).toBe(
      "Couldn't upload “tone.wav”. Nebula's server isn't answering. Make sure it's running, then try again.");
  });

  it('gives a drop one notice: a count over the shared reason (GM)', async () => {
    api.fetch.mockImplementation(async () => new Response('{}', { status: 200 }));
    await drop([file('a.zip'), file('b.exe'), file('c.png', 'image/png')]);
    expect(notice()).toBe(`Couldn't add 2 of 3 files.\n${TYPES}`);
  });

  it('says "the n files" when none went in', async () => {
    await drop([file('a.zip'), file('b.exe'), file('c.dmg'), file('d.key')]);
    expect(uploads()).toEqual([]);
    expect(notice()).toBe(`Couldn't add the 4 files.\n${TYPES}`);
  });

  it('names the files when the reasons differ, two then "and k more"', async () => {
    api.fetch.mockImplementation(async () => new Response('', { status: 503 }));
    await drop([file('a.zip'), file('b.png', 'image/png')]);
    expect(notice()).toBe("Couldn't add the 2 files.\nNot added: “a.zip”, “b.png”.");
    await drop([file('a.zip'), file('b.png', 'image/png'), file('c.png', 'image/png'), file('d.exe'), file('e.pdf', 'application/pdf')]);
    expect(notice()).toBe("Couldn't add the 5 files.\nNot added: “a.zip”, “b.png” and 3 more.");
  });

  it('shows no notice when every file goes in', async () => {
    api.fetch.mockImplementation(async () => new Response('{}', { status: 200 }));
    await drop([file('a.png', 'image/png'), file('b.pdf', 'application/pdf')]);
    expect(notice()).toBeUndefined();
  });

  it('takes one undo step per dropped file and gives back a failed one', async () => {
    const begin = vi.spyOn(useGraphStore.getState(), 'beginUndoStep');
    const cancel = vi.spyOn(useGraphStore.getState(), 'cancelUndoStep');
    let calls = 0;
    api.fetch.mockImplementation(async () => (++calls === 2
      ? new Response('', { status: 503 }) : new Response('{}', { status: 200 })));
    await drop([file('a.png', 'image/png'), file('b.pdf', 'application/pdf'), file('z.zip')]);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(begin.mock.results[1].value);
  });

  it('does not refit the camera over the nodes the person just dropped', async () => {
    let finish!: () => void;
    api.fetch.mockImplementation(() => new Promise<Response>((resolve) => {
      finish = () => resolve(new Response('{}', { status: 200 }));
    }));
    render(<Canvas />);
    await act(async () => { dropFiles([file('a.png', 'image/png')]); });
    // The drop reads each card's size first (jsdom's Image never loads, so
    // that waits out DROP_SIZE_TIMEOUT_MS); let it reach the upload.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(api.fetch).toHaveBeenCalled();
    // The backend's graphSync lands while the upload is still answering.
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { addedCount: 1, totalCount: 1 } }));
    });
    await act(async () => { finish(); await vi.runOnlyPendingTimersAsync(); });
    expect(flow.fitView).not.toHaveBeenCalled();
    // An agent's node later still fits as before.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { addedCount: 1, totalCount: 2 } }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(flow.fitView).toHaveBeenCalledTimes(1);
  });

  it("cancels the empty canvas's waiting first fit, so a drop onto it isn't zoomed away", async () => {
    render(<Canvas />);
    // A canvas that mounted empty waits to fit its first nodes (React Flow's fitView prop).
    expect(flow.props?.fitView).toBe(true);
    await act(async () => { dropFiles([file('a.png', 'image/png')]); });
    expect(flow.props?.fitView).toBe(false);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  });

  it('still adds a library node dragged from the node panel', async () => {
    const addNode = vi.spyOn(useGraphStore.getState(), 'addNode').mockResolvedValue(undefined as never);
    render(<Canvas />);
    await act(async () => {
      fireDrop({ x: 40, y: 20 }, { files: [], types: ['application/nebula-node'],
        getData: (kind: string) => (kind === 'application/nebula-node' ? 'text-input' : '') });
    });
    expect(addNode).toHaveBeenCalledWith('text-input', { x: 20, y: 10 });
    expect(uploads()).toEqual([]);
  });
});
