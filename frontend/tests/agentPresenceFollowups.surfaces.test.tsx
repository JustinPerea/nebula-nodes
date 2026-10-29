import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Follow-ups to PR #195 (review 23, L-4 and the out-of-scope chat item): the
 * controls review 23 found outside the canvas lock, locked.
 * - EditorView's keys (B, ⌘K, Delete/Backspace, M, I, O) edit the edit node:
 *   refused while following an agent's switch (and offline), as the
 *   transport's buttons are. The Remotion editor's Delete and ⌘D the same.
 * - The chat's "Apply to @n2" takes the lock (disabled, marked, GM's
 *   tooltip), and `/clear` is refused whole while following, as offline.
 * - Apply goes once the canvas its node id was read on is replaced (a clear,
 *   a load, a switch): that id may name another node now.
 */

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchChatModels: vi.fn(), fetchPersonalAgents: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: () => () => {}, disconnect: vi.fn() } }));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus, fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchChatModels: apiMocks.fetchChatModels, fetchPersonalAgents: apiMocks.fetchPersonalAgents,
}));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
vi.mock('../src/components/editor/EditorBreadcrumb', () => ({ EditorBreadcrumb: () => null }));
vi.mock('../src/components/editor/TimelineRuler', () => ({ TimelineRuler: () => <div>Ruler</div> }));
vi.mock('../src/components/editor/TimelineTrack', () => ({ TimelineTrack: () => <div>Track</div> }));
vi.mock('../src/components/editor/TimelinePlayhead', () => ({ TimelinePlayhead: () => null }));

import { ChatPanel } from '../src/components/panels/ChatPanel';
import { EditorView } from '../src/components/editor/EditorView';
import { useRemotionKeyboard } from '../src/components/video-editor/useRemotionKeyboard';
import { CHAT_SEND_EVENT } from '../src/lib/chatSend';
import { noteCanvasReplaced } from '../src/lib/canvasReplaced';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const WAIT = 'Wait for “beta” to open.';
const follow = () => act(() => { setFollowingSwitch({ agent: 'Codex', projectName: 'beta' }); });

beforeEach(() => {
  resetCanvasFollowForTests();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetCanvasFollowForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe('EditorView: its editing keys follow the canvas lock', () => {
  const source: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Clip', definitionId: 'video-upload', params: {}, state: 'complete',
      outputs: { video: { type: 'Video', value: '/api/outputs/clip.mp4' } } } };
  const edit: Node<NodeData> = { id: 'n2', type: 'model-node', position: { x: 300, y: 0 },
    data: { label: 'Edit', definitionId: 'video-edit', params: {
      clips: [{ id: 'c1', start: 0, duration: 10, sourceIn: 0, sourceOut: 10, volume: 1, mute: false }],
      sourceDuration: 10, sourceFps: 30 }, state: 'idle', outputs: {} } };
  const wire: Edge = { id: 'e1', source: 'n1', sourceHandle: 'video', target: 'n2', targetHandle: 'video_in' };
  const clips = () => ((useGraphStore.getState().nodes.find((n) => n.id === 'n2')?.data.params.clips as Array<Record<string, unknown>>) ?? []);
  const UNTOUCHED = [{ id: 'c1', start: 0, duration: 10, sourceIn: 0, sourceOut: 10, volume: 1, mute: false }];

  beforeEach(() => {
    useGraphStore.setState({ nodes: [source, edit], edges: [wire] });
    useUIStore.setState({ viewMode: 'editor', editorTargetNodeId: 'n2', selectedClipId: 'c1' } as never);
    (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime = 4;
  });

  it('following: B, ⌘K, M, I, O, Delete and Backspace change nothing', () => {
    render(<EditorView />);
    follow();
    for (const key of ['b', 'm', 'i', 'o']) fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(clips()).toEqual(UNTOUCHED);
    expect(useUIStore.getState().selectedClipId).toBe('c1');
  });

  it('control: not following, M mutes and B cuts', () => {
    render(<EditorView />);
    fireEvent.keyDown(document.body, { key: 'm' });
    expect(clips()[0].mute).toBe(true);
    fireEvent.keyDown(document.body, { key: 'b' });
    expect(clips().length).toBe(2);
  });
});

describe('the Remotion editor keys follow the canvas lock', () => {
  function Harness() {
    useRemotionKeyboard({ remotionNodeId: 'r1', currentFrame: 12 });
    return null;
  }

  it('following: Delete and ⌘D change nothing', () => {
    useUIStore.setState({ selectedTrackItemId: 't1' } as never);
    const remove = vi.fn();
    const duplicate = vi.fn();
    useGraphStore.setState({ deleteTrackItem: remove, duplicateTrackItemAtPlayhead: duplicate } as never);
    render(<Harness />);
    follow();
    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    expect(remove).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
  });
});

describe('the chat: Apply and /clear follow the canvas lock', () => {
  class ChatSocket extends WebSocket {
    static instances: ChatSocket[] = [];
    constructor(url: string | URL) { super(url); ChatSocket.instances.push(this); }
    open() {
      Object.defineProperty(this, 'readyState', { value: WebSocket.OPEN, writable: true, configurable: true });
      this.onopen?.call(this, new Event('open'));
    }
    send() {}
    close() {
      if (this.readyState === WebSocket.CLOSED) return;
      Object.defineProperty(this, 'readyState', { value: WebSocket.CLOSED, writable: true, configurable: true });
      this.onclose?.call(this, new CloseEvent('close'));
    }
    reply(event: Record<string, unknown>) {
      this.onmessage?.call(this, new MessageEvent('message', { data: JSON.stringify(event) }));
    }
  }

  beforeEach(() => {
    vi.clearAllMocks(); ChatSocket.instances = []; vi.stubGlobal('WebSocket', ChatSocket);
    localStorage.clear(); sessionStorage.clear();
    useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } } }));
    apiMocks.fetchClaudeStatus.mockResolvedValue({ installed: true, loggedIn: true });
    apiMocks.fetchCodexStatus.mockResolvedValue({ installed: true, loggedIn: true, mode: 'chatgpt' });
    apiMocks.fetchChatModels.mockImplementation(async (agent: string) => ({
      agent, status: 'ready', auth: { mode: 'claudeai' },
      catalog: { source: 'test', runtimeVersion: 'test', fetchedAt: '2026-10-26T12:00:00Z' },
      models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true, defaultEffort: 'medium',
        supportedEfforts: [{ id: 'medium', label: 'Medium' }] }],
    }));
    apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [] });
    apiMocks.apiFetch.mockImplementation(async () => new Response('{}'));
    useGraphStore.setState({ nodes: [{ id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Prompt', definitionId: 'text-input', params: { value: 'a sky' }, state: 'idle', outputs: {} } }], edges: [] });
  });

  async function openChat() {
    render(<ChatPanel />);
    await waitFor(() => expect(ChatSocket.instances).toHaveLength(1));
    await act(async () => ChatSocket.instances[0].open());
    await waitFor(() => expect(screen.getByPlaceholderText('Message…')).toBeTruthy());
  }

  async function enhanceReply() {
    await openChat();
    // Enhance: the node's Enhance puts its message in the chat and names the node.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(CHAT_SEND_EVENT, { detail: { message: 'Enhance this prompt', sourceNodeId: 'n2' } }));
    });
    const input = screen.getByPlaceholderText('Message…');
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe('Enhance this prompt'));
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: false }); });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    await act(async () => { ChatSocket.instances[0].reply({ type: 'text', text: 'Try:\n```\na warmer sky at dusk\n```\n' }); });
    return screen.findByRole('button', { name: 'Apply to @n2' });
  }

  it('control: Apply puts the reply into @n2', async () => {
    const apply = await enhanceReply();
    expect(apply).not.toBeDisabled();
    fireEvent.click(apply);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('a warmer sky at dusk');
  });

  it('following: Apply is disabled and marked, with GM\'s tooltip, and writes nothing', async () => {
    const apply = await enhanceReply();
    follow();
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute('data-following-disabled');
    expect(apply).toHaveAttribute('title', WAIT);
    fireEvent.click(apply);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('a sky');
  });

  // Fix round 1 (GM answer 4): never remove an action without saying why.
  // Apply stays, disabled in the standard grey, and its tooltip says what
  // happened to the canvas it was written for.
  it('an agent opened another project: Apply stays, disabled, and says who opened what', async () => {
    const apply = await enhanceReply();
    act(() => { noteCanvasReplaced({ kind: 'opened', agent: 'Codex', projectName: 'Second canvas' }); });
    const still = screen.getByRole('button', { name: 'Apply to @n2' });
    expect(still).toBe(apply);
    expect(still).toBeDisabled();
    expect(still).toHaveAttribute('title', 'Codex opened “Second canvas” after this was written.');
    fireEvent.click(still);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('a sky');
  });

  it('no agent behind it: "Nebula opened …"', async () => {
    await enhanceReply();
    act(() => { noteCanvasReplaced({ kind: 'opened', agent: null, projectName: 'Second canvas' }); });
    expect(screen.getByRole('button', { name: 'Apply to @n2' }))
      .toHaveAttribute('title', 'Nebula opened “Second canvas” after this was written.');
  });

  it('the canvas was cleared: "The canvas was cleared after this was written."', async () => {
    await enhanceReply();
    act(() => { noteCanvasReplaced({ kind: 'cleared' }); });
    const apply = screen.getByRole('button', { name: 'Apply to @n2' });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute('title', 'The canvas was cleared after this was written.');
  });

  // Fix round 2 of PR #200 (review 2 N-6): offline, Apply says when it works
  // again (offlineDisabledReason), not its "Paste this into …" tooltip.
  it('offline: Apply is disabled with the reconnect tooltip', async () => {
    const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
    try {
      const apply = await enhanceReply();
      act(() => noteBackendConnection('offline'));
      expect(apply).toBeDisabled();
      expect(apply).toHaveAttribute('data-offline-disabled');
      expect(apply).toHaveAttribute('title', 'This works again when Nebula reconnects.');
    } finally {
      act(() => resetBackendConnectionForTests());
    }
  });

  // GM 2026-10-28 answer 2: enabled, normal ink with its outline; disabled, the shared grey.
  it('enabled Apply reads in the normal ink with its outline, clearly apart from the grey', () => {
    const css = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8');
    const rule = /body\.app-slava-restraint \.chat__codeblock-apply \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/color:\s*var\(--sr-ink\)/);
    expect(rule).toMatch(/border-top:\s*1px solid var\(--sr-edge\)/);
  });

  it('the Apply button is in the one disabled look', () => {
    const shared = readFileSync(join(__dirname, '../src/styles/disabled-buttons.css'), 'utf8');
    expect(shared).toMatch(/\.chat__codeblock-apply\b/);
  });

  it('following: /clear is refused whole; nothing is sent and the command stays typed', async () => {
    await openChat();
    follow();
    const input = screen.getByPlaceholderText('Message…');
    fireEvent.change(input, { target: { value: '/clear' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: false }); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(apiMocks.apiFetch).not.toHaveBeenCalledWith('/api/graph?force=true', expect.anything());
    expect((input as HTMLTextAreaElement).value).toBe('/clear');
  });
});
