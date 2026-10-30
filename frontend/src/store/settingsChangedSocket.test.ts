import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../lib/wsClient';

let handler: ((event: ExecutionEvent) => void) | null = null;
vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: (fn: (event: ExecutionEvent) => void) => { handler = fn; return () => {}; } } }));

const { SETTINGS_SAVED_EVENT } = await import('./settingsChangedSocket');

const send = (event: unknown) => handler?.(event as ExecutionEvent);

/**
 * Review 8 of PR #203, NIT-3: a key change made anywhere (a second window,
 * the CLI, the desktop bridge) reaches this tab as `settingsChanged`, and the
 * tab reads its settings again through the signal a save here sends, so
 * every cache that listens refreshes (App's settings cache, provider
 * readiness, the zoom manifest).
 */
describe('a key change from another client', () => {
  const heard = vi.fn();
  window.addEventListener(SETTINGS_SAVED_EVENT, heard);
  afterEach(() => heard.mockReset());

  it('is the same signal as a save in this tab', () => {
    expect(SETTINGS_SAVED_EVENT).toBe('nebula:settings-saved');
  });

  it('makes the tab read its settings again', () => {
    send({ type: 'settingsChanged' });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('so does a socket that comes back, since a change made while it was away sent nothing it heard', () => {
    send({ type: 'socketReconnected' });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('nothing else does', () => {
    send({ type: 'projectsChanged', change: 'saved', projectId: 'p1' });
    send({ type: 'graphComplete', duration: 1, nodesExecuted: 1 });
    expect(heard).not.toHaveBeenCalled();
  });
});
