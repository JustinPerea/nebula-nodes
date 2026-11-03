import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../lib/apiRequest', () => ({ apiRequest }));

import { noteActivity, receiveRows, receiveSync, replyAnnouncement, terminalListening, usePersonThreadStore } from './personThreadStore';
import { useUIStore } from './uiStore';
import { RequestFailedError } from '../lib/errorCopy';
import { LISTENER_DROPPED_LINE, SERVER_FAILED_LINE, type ThreadRow } from '../lib/personThread';
import type { AgentPresenceEvent } from '../lib/wsClient';

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';

function answer(row: Record<string, unknown>) {
  return { json: async () => ({ projectId: 'p1', row }) };
}

function reply(id: string, at: number, text = 'Done.'): ThreadRow {
  return { id, kind: 'reply', at, text, agent: CLAUDE, session: { key: KEY, ordinal: 1 }, sessionKey: KEY };
}

beforeEach(() => {
  usePersonThreadStore.getState().reset();
  useUIStore.setState({ agentLogOpen: false });
  apiRequest.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sending', () => {
  it('posts the draft with its nodes and one client id, clears the draft, and adds the row', async () => {
    apiRequest.mockResolvedValue(answer({ id: 'm1', kind: 'message', at: 1, text: 'Warmer', state: 'sent', clientId: 'c-x' }));
    const store = usePersonThreadStore.getState();
    store.setDraft('W', () => ['n1', 'n2']);
    store.setDraft('Warmer ', () => ['n9']);
    expect(usePersonThreadStore.getState().contextIds).toEqual(['n1', 'n2']);
    const sent = usePersonThreadStore.getState().send('ch_1');
    expect(usePersonThreadStore.getState().draft).toBe('');
    expect(usePersonThreadStore.getState().pending?.text).toBe('Warmer');
    expect(await sent).toBe(true);
    const [, path, init] = apiRequest.mock.calls[0];
    expect(path).toBe('/api/canvas/thread/messages');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ text: 'Warmer', to: 'ch_1', nodeIds: ['n1', 'n2'] });
    expect(body.clientId).toMatch(/^c-[A-Za-z0-9_-]+$/);
    expect(usePersonThreadStore.getState().pending).toBeNull();
    expect(usePersonThreadStore.getState().rows.map((r) => r.id)).toEqual(['m1']);
    expect(usePersonThreadStore.getState().contextIds).toEqual([]);
  });

  it('an emptied draft lets its nodes go', () => {
    const store = usePersonThreadStore.getState();
    store.setDraft('a', () => ['n1']);
    store.setDraft('', () => ['n1']);
    expect(usePersonThreadStore.getState().contextIds).toEqual([]);
  });

  it('sends nothing empty, nothing over the limit, nothing while a send is in flight', async () => {
    const store = usePersonThreadStore.getState();
    expect(await store.send('ch_1')).toBe(false);
    usePersonThreadStore.setState({ draft: 'x'.repeat(2001) });
    expect(await usePersonThreadStore.getState().send('ch_1')).toBe(false);
    usePersonThreadStore.setState({ draft: 'hi', pending: { clientId: 'c', text: 't', to: 'ch_1', nodeIds: [], startedAt: 0 } });
    expect(await usePersonThreadStore.getState().send('ch_1')).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('keeps the draft on a failure, and Try again reuses the client id', async () => {
    apiRequest.mockRejectedValueOnce(new RequestFailedError("Couldn't send your message.", 503));
    usePersonThreadStore.getState().setDraft('Warmer', () => ['n1']);
    expect(await usePersonThreadStore.getState().send('ch_1')).toBe(false);
    const state = usePersonThreadStore.getState();
    expect(state.draft).toBe('Warmer');
    expect(state.contextIds).toEqual(['n1']);
    expect(state.failure).toMatchObject({ kind: 'server', line: SERVER_FAILED_LINE });
    const first = JSON.parse(apiRequest.mock.calls[0][2].body).clientId;
    apiRequest.mockResolvedValueOnce(answer({ id: 'm1', kind: 'message', at: 1, text: 'Warmer', state: 'sent' }));
    expect(await usePersonThreadStore.getState().send('ch_1')).toBe(true);
    expect(JSON.parse(apiRequest.mock.calls[1][2].body).clientId).toBe(first);
    expect(usePersonThreadStore.getState().failure).toBeNull();
  });

  it('reads a listener that dropped at send as its own line', async () => {
    apiRequest.mockRejectedValueOnce(new RequestFailedError("Couldn't send your message.", 409, { code: 'listener_stopped' }));
    usePersonThreadStore.getState().setDraft('Warmer');
    await usePersonThreadStore.getState().send('ch_1');
    expect(usePersonThreadStore.getState().failure).toMatchObject({ kind: 'stopped', line: LISTENER_DROPPED_LINE });
  });

  it('holds "Sending…" 400 ms once it showed', async () => {
    vi.useFakeTimers();
    let resolve: (value: unknown) => void = () => {};
    apiRequest.mockReturnValue(new Promise((r) => { resolve = r; }));
    usePersonThreadStore.getState().setDraft('Warmer');
    const sent = usePersonThreadStore.getState().send('ch_1');
    await vi.advanceTimersByTimeAsync(350);
    resolve(answer({ id: 'm1', kind: 'message', at: 1, text: 'Warmer', state: 'sent' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(usePersonThreadStore.getState().pending).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60);
    await sent;
    expect(usePersonThreadStore.getState().pending).toBeNull();
  });
});

describe('what the socket brings', () => {
  it('counts replies unread while the panel is closed and announces each once', () => {
    receiveSync('p1', []);
    receiveRows('p1', [reply('r1', 10, 'Done. I moved it.')]);
    expect(usePersonThreadStore.getState().unread).toBe(1);
    expect(usePersonThreadStore.getState().announcement).toEqual({ id: 'r1', text: 'Claude replied. Done. I moved it.' });
    // The same row again (a second tab's broadcast) is not new.
    receiveRows('p1', [reply('r1', 10, 'Done. I moved it.')]);
    expect(usePersonThreadStore.getState().unread).toBe(1);
    useUIStore.setState({ agentLogOpen: true });
    expect(usePersonThreadStore.getState().unread).toBe(0);
    receiveRows('p1', [reply('r2', 20)]);
    expect(usePersonThreadStore.getState().unread).toBe(0);
  });

  it('drops another project’s rows', () => {
    receiveSync('p1', []);
    receiveRows('p2', [reply('r1', 10)]);
    expect(usePersonThreadStore.getState().rows).toEqual([]);
  });

  it('names the reply as its cursor does', () => {
    expect(replyAnnouncement({ ...reply('r', 1, 'Hi'), session: { key: KEY, ordinal: 2 } })).toBe('Claude · 2 replied. Hi');
  });

  it('keeps each session’s latest event and line', () => {
    const event = (at: number, log?: string): AgentPresenceEvent => ({
      type: 'agentPresence', agent: CLAUDE, action: 'move', say: '', at, session: { key: KEY, ordinal: 1 }, ...(log ? { log } : {}),
    });
    noteActivity(event(10, 'Changing “Prompt”'));
    noteActivity(event(20));
    expect(usePersonThreadStore.getState().activity[KEY]).toEqual({ at: 20, line: 'Changing “Prompt”' });
    noteActivity(event(5, 'old'));
    expect(usePersonThreadStore.getState().activity[KEY].at).toBe(20);
  });

  it('reads "Personal agent" only while a session listens', () => {
    expect(terminalListening({ listeners: [] })).toBe(false);
    const entry = { listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening' as const, reason: null,
      projectId: null, since: 0, seenAt: 0, session: null };
    expect(terminalListening({ listeners: [entry] })).toBe(true);
    expect(terminalListening({ listeners: [{ ...entry, state: 'stopped' }] })).toBe(false);
  });
});
