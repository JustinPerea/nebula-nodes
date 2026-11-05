import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// The Inspector's own file control (fix/canvas-drop-files, 2026-10-24): the
// same /api/uploads route as a canvas drop, so audio now uploads; a failed
// upload says so in the canvas notice instead of only the console, and a
// preview image is drawn only for an image.

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

function inputNode(definitionId: string, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { label: 'Input', definitionId, params: { filePath: '', ...params }, state: 'idle', outputs: {} } };
}

function show(node: Node<NodeData>) {
  useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null });
  useUIStore.getState().selectNode('n1');
  return render(<Inspector embedded />);
}

async function choose(container: HTMLElement, file: File) {
  const input = container.querySelector('.inspector__file-input') as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** /api/uploads answers with `upload()`; the Inspector's other reads get {}. */
function answer(upload: () => Response) {
  api.fetch.mockImplementation(async (path: string) => (path === '/api/uploads' ? upload() : new Response('{}')));
}

beforeEach(() => {
  api.fetch.mockReset();
  answer(() => new Response('{}'));
  useUIStore.setState(initialUI, true);
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("the Inspector's file control", () => {
  it('fills an Audio Input from the upload', async () => {
    answer(() => new Response(JSON.stringify({
      filePath: '/out/chat-uploads/abc.wav', url: '/api/outputs/chat-uploads/abc.wav' }), { status: 200 }));
    const { container } = show(inputNode('audio-input'));
    await choose(container, new File([new Uint8Array(8)], 'tone.wav', { type: 'audio/wav' }));
    expect(api.fetch).toHaveBeenCalledWith('/api/uploads', expect.objectContaining({ method: 'POST' }));
    await waitFor(() => expect(useGraphStore.getState().nodes[0].data.params.filePath).toBe('/out/chat-uploads/abc.wav'));
  });

  it('keeps the name the file was picked with, for the card and the button', async () => {
    answer(() => new Response(JSON.stringify({
      filePath: '/out/chat-uploads/abc.pdf', url: '/api/outputs/chat-uploads/abc.pdf' }), { status: 200 }));
    const { container } = show(inputNode('document-input'));
    await choose(container, new File([new Uint8Array(8)], 'quarterly-report-final-version-2026.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(useGraphStore.getState().nodes[0].data.params._fileName)
      .toEqual({ file: 'abc.pdf', name: 'quarterly-report-final-version-2026.pdf' }));
    // Cut in the middle so the extension stays (GM r46 on #222); whole in its title.
    const name = container.querySelector('.inspector__file-button span');
    expect(name?.textContent).toBe('quarterly-report-final-….pdf');
    expect(name?.getAttribute('title')).toBe('quarterly-report-final-version-2026.pdf');
  });

  it('says so when the upload fails', async () => {
    answer(() => new Response('', { status: 503 }));
    const { container } = show(inputNode('audio-input'));
    await choose(container, new File([new Uint8Array(8)], 'tone.wav', { type: 'audio/wav' }));
    await waitFor(() => expect(useGraphStore.getState().undoNotice?.text)
      .toBe("Couldn't upload “tone.wav”. Nebula didn't respond. Try again."));
    expect(useGraphStore.getState().nodes[0].data.params.filePath).toBe('');
  });

  it('draws a preview image only for an image', () => {
    const audio = show(inputNode('audio-input', { _previewUrl: '/api/outputs/chat-uploads/abc.wav' }));
    expect(audio.container.querySelector('.inspector__file-preview')).toBeNull();
    cleanup();
    const video = show(inputNode('video-input', { _previewUrl: '/api/outputs/chat-uploads/abc.mp4' }));
    expect(video.container.querySelector('.inspector__file-preview')).toBeNull();
    cleanup();
    const image = show(inputNode('image-input', { _previewUrl: '/api/outputs/chat-uploads/abc.png' }));
    expect(image.container.querySelector('.inspector__file-preview')).not.toBeNull();
  });

  // #226 round 3 (GM r82): the stored image's size gives the preview its
  // aspect ratio before it decodes, so the floating Inspector measures its
  // whole body on the first frame it opens.
  it('keeps the size /api/uploads reports with the preview, and a file without one drops the last', async () => {
    answer(() => new Response(JSON.stringify({ filePath: '/out/chat-uploads/abc.png', url: '/api/outputs/chat-uploads/abc.png',
      previewSize: { width: 640, height: 360 } }), { status: 200 }));
    const { container } = show(inputNode('style-reference'));
    await choose(container, new File([new Uint8Array(8)], 'ref.png', { type: 'image/png' }));
    await waitFor(() => expect(useGraphStore.getState().nodes[0].data.params._previewSize).toEqual({ width: 640, height: 360 }));
    const preview = container.querySelector<HTMLImageElement>('.inspector__file-preview')!;
    expect(preview.getAttribute('width')).toBe('640');
    expect(preview.getAttribute('height')).toBe('360');
    // Another file, its size unknown (an animated GIF, say): no stale size kept.
    answer(() => new Response(JSON.stringify({ filePath: '/out/chat-uploads/def.gif', url: '/api/outputs/chat-uploads/def.gif' }),
      { status: 200 }));
    await choose(container, new File([new Uint8Array(8)], 'loop.gif', { type: 'image/gif' }));
    await waitFor(() => expect(useGraphStore.getState().nodes[0].data.params.filePath).toBe('/out/chat-uploads/def.gif'));
    expect('_previewSize' in useGraphStore.getState().nodes[0].data.params).toBe(false);
    expect(container.querySelector('.inspector__file-preview')!.hasAttribute('width')).toBe(false);
  });

  it('draws a preview with no size attributes for a missing or broken stored size', () => {
    for (const broken of [undefined, null, 'wide', { width: 640 }, { width: 0, height: 10 }, { width: -1, height: 10 },
      { width: Number.NaN, height: 10 }, { width: 1e9, height: 10 }]) {
      const view = show(inputNode('image-input', { _previewUrl: '/api/outputs/chat-uploads/abc.png', _previewSize: broken }));
      const preview = view.container.querySelector('.inspector__file-preview')!;
      expect(preview.hasAttribute('width'), JSON.stringify(broken)).toBe(false);
      expect(preview.hasAttribute('height'), JSON.stringify(broken)).toBe(false);
      cleanup();
    }
  });

  it('keeps the preview at the panel\'s width with its own ratio (height: auto)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(__dirname, '../src/styles/panels.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, selector]) => selector.trim() === '.inspector__file-preview');
    expect(rule?.[2]).toMatch(/width:\s*100%/);
    expect(rule?.[2]).toMatch(/height:\s*auto/);
  });
});
