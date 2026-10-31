import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../lib/wsClient';

let handler: ((event: ExecutionEvent) => void) | null = null;
vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: (fn: (event: ExecutionEvent) => void) => { handler = fn; return () => {}; } } }));

const { SETTINGS_SAVED_EVENT } = await import('./settingsChangedSocket');

const send = (event: unknown) => handler?.(event as ExecutionEvent);

/**
 * Review 8 of PR #203, NIT-3: a key change made anywhere (a second window,
 * a script with the person token, the desktop bridge; the CLI only reads keys) reaches this tab as `settingsChanged`, and the
 * tab reads its settings again through the signal a save here sends, so
 * every cache that listens refreshes (App's settings cache, provider
 * readiness, the zoom manifest). GM, PR #203 r19 item 7: the signal names the
 * keys that changed, so only those keys' connection checks are cleared.
 */
describe('a key change from another client', () => {
  const heard = vi.fn();
  window.addEventListener(SETTINGS_SAVED_EVENT, heard);
  afterEach(() => heard.mockReset());
  const detail = (spy: typeof heard) => (spy.mock.calls[0][0] as CustomEvent).detail;

  it('is the same signal as a save in this tab', () => {
    expect(SETTINGS_SAVED_EVENT).toBe('nebula:settings-saved');
  });

  it('makes the tab read its settings again, saying it came from elsewhere and which keys changed', () => {
    send({ type: 'settingsChanged', keys: ['OPENAI_API_KEY', 7] });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(detail(heard)).toEqual({ source: 'remote', keys: ['OPENAI_API_KEY'] });
  });

  it('a signal with no keys (an older backend) names none, so every check is cleared', () => {
    send({ type: 'settingsChanged' });
    expect(detail(heard)).toEqual({ source: 'remote' });
  });

  it('so does a socket that comes back, since a change made while it was away sent nothing it heard', () => {
    send({ type: 'socketReconnected' });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(detail(heard)).toEqual({ source: 'reconnect' });
  });

  it('nothing else does', () => {
    send({ type: 'projectsChanged', change: 'saved', projectId: 'p1' });
    send({ type: 'graphComplete', duration: 1, nodesExecuted: 1 });
    expect(heard).not.toHaveBeenCalled();
  });
});
