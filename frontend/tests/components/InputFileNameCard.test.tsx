import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { resetUploadNamesForTests } from '../../src/lib/uploadNames';

// GM - Design, drop follow-ups (2026-10-24): every input card (Image, Video,
// Audio, Document) names the file it holds, an image under its picture, cut in the middle when long so the
// extension stays.

// Nebula's upload record (GET /api/uploads/names, lib/uploadNames.ts).
const record = vi.hoisted(() => ({ names: {} as Record<string, string> }));
vi.mock('../../src/lib/backend', async (original) => ({
  ...await original<typeof import('../../src/lib/backend')>(),
  apiFetch: vi.fn((path: string) => {
    const asked = new URLSearchParams(path.split('?')[1] ?? '').getAll('file');
    const names = Object.fromEntries(asked.filter((f) => record.names[f]).map((f) => [f, record.names[f]]));
    return Promise.resolve(new Response(JSON.stringify({ names }), { status: 200 }));
  }),
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

const STORED = '3fa94c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f';

function inputNode(definitionId: string, ext: string, name: string | null): Node<NodeData> {
  const file = `${STORED}.${ext}`;
  const params: Record<string, unknown> = { filePath: `/out/chat-uploads/${file}`, _previewUrl: `/api/outputs/chat-uploads/${file}` };
  if (name) params._fileName = { file, name };
  return { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label: definitionId, params, state: 'idle', outputs: {} } };
}

function renderNode(n: Node<NodeData>) {
  useGraphStore.setState({ nodes: [n], edges: [] });
  return render(<ModelNode {...({ id: n.id, data: n.data, selected: false } as NodeProps)} />);
}

beforeEach(() => {
  useUIStore.setState({ selectedNodeId: null });
  resetUploadNamesForTests();
  record.names = {};
});

describe("an input card's file name", () => {
  it.each([
    ['audio-input', 'wav', 'tone.wav'],
    ['document-input', 'pdf', 'brief.pdf'],
    ['image-input', 'png', 'moodboard-ref.png'],
    ['video-input', 'mp4', 'take-03.mp4'],
  ])('%s shows the name of the file it holds', (definitionId, ext, name) => {
    const { container } = renderNode(inputNode(definitionId, ext, name));
    const line = container.querySelector('.model-node__file-name');
    expect(line?.textContent).toBe(name);
  });

  it('names an image under its picture (GM: every input card names its file)', () => {
    const { container } = renderNode(inputNode('image-input', 'png', 'moodboard-ref.png'));
    const picture = container.querySelector('.model-node__preview');
    const line = container.querySelector('.model-node__file-name');
    expect(picture).not.toBeNull();
    expect(line?.getAttribute('title')).toBe('moodboard-ref.png');
    expect(picture!.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('cuts a long name in the middle and keeps the whole name in the title', () => {
    const name = 'quarterly-report-final-version-2026.pdf';
    const { container } = renderNode(inputNode('document-input', 'pdf', name));
    const line = container.querySelector('.model-node__file-name');
    expect(line?.textContent).not.toBe(name);
    expect(line?.textContent?.endsWith('….pdf')).toBe(true);
    expect(line?.getAttribute('title')).toBe(name);
  });

  it('shows nothing for a card with no file', () => {
    const empty = { ...inputNode('audio-input', 'wav', null) };
    empty.data = { ...empty.data, params: { filePath: '' } };
    expect(renderNode(empty).container.querySelector('.model-node__file-name')).toBeNull();
  });

  // GM r48 Q1 on #222: the name it was uploaded with, from Nebula's upload
  // record when the node keeps none (an agent set the file), and never a
  // bare content hash.
  it('names a stored file with no kept name by the upload record, else "Uploaded file", never the hash', async () => {
    const { container } = renderNode(inputNode('audio-input', 'wav', null));
    const line = () => container.querySelector('.model-node__file-name');
    expect(line()?.textContent).toBe('Uploaded file');
    expect(container.textContent).not.toContain(STORED);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });
    expect(line()?.textContent).toBe('Uploaded file');
    resetUploadNamesForTests();
    record.names[`${STORED}.wav`] = 'field-recording-take-3.wav';
    const named = renderNode(inputNode('audio-input', 'wav', null));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });
    expect(named.container.querySelector('.model-node__file-name')?.textContent).toBe('field-recording-take-3.wav');
  });

});
