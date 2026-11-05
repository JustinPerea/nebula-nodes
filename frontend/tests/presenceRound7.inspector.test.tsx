// PR #204 round 7, review 5 LOW-4: the Inspector's upload line carries its own refusal, so it is
// read against the promote its request went out under (Inspector.tsx's notify with { error }).
// Harness from Inspector.fileUpload.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import * as session from '../src/lib/personSession';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const shown = () => { const s = useGraphStore.getState(); return s.undoNotice?.text ?? s.messageNotice?.text ?? null; };

beforeEach(() => {
  api.fetch.mockReset();
  useUIStore.setState(initialUI, true);
  session.resetPersonSessionForTests();
});
afterEach(() => {
  cleanup();
  session.notePersonPromoted();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("review 5 LOW-4: the Inspector's upload line and its own stamp", () => {
  it('refused before the promote and answered after it: the line goes at once', async () => {
    let answer!: () => void;
    api.fetch.mockImplementation(async (path: string) => {
      if (path !== '/api/uploads') return new Response('{}');
      const sentAt = session.personPromotions();
      await new Promise<void>((resolve) => { answer = resolve; });
      const response = new Response(JSON.stringify({ detail: 'Only the person can upload.', code: 'person_required' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } });
      session.noteSentUnder(response, sentAt);
      return response;
    });
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Input', definitionId: 'audio-input', params: { filePath: '' }, state: 'idle', outputs: {} } }] as Node<NodeData>[],
      edges: [], undoNotice: null, messageNotice: null });
    useUIStore.getState().selectNode('n1');
    const { container } = render(<Inspector embedded />);
    session.reportPersonRequired();
    const input = container.querySelector('.inspector__file-input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File([new Uint8Array(8)], 'tone.wav', { type: 'audio/wav' })] } }); await flush(); });
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    session.notePersonPromoted();
    await act(async () => { answer(); await flush(); await flush(); });
    expect(shown()).toBeNull();
  });
});
