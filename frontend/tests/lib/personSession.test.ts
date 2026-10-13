import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserPersonCredential, forgetPersonCredential, loopbackOrigin, personCredential,
  personRequiredMessage, personUnavailableReason, resetPersonSessionForTests,
} from '../../src/lib/personSession';

const TOKEN = 'person-token-0000000000000000000000000000';

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState({}, '', '/');
  resetPersonSessionForTests();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).nebulaDesktop;
  vi.unstubAllGlobals();
});

describe('person session', () => {
  it('accepts only plain loopback origins', () => {
    expect(loopbackOrigin('http://127.0.0.1:8131')).toBe('http://127.0.0.1:8131');
    expect(loopbackOrigin('http://localhost:8000/')).toBe('http://localhost:8000');
    expect(loopbackOrigin('https://evil.example')).toBeNull();
    expect(loopbackOrigin('http://127.0.0.1:8000/api')).toBeNull();
    expect(loopbackOrigin('http://user:pw@127.0.0.1:8000')).toBeNull();
    expect(loopbackOrigin('file:///tmp')).toBeNull();
  });

  it('strips a malformed token from the address bar and keeps nothing', () => {
    history.replaceState({}, '', '/#nebula-person=short&backend=http://127.0.0.1:8000');
    expect(browserPersonCredential()).toBeNull();
    expect(location.hash).toBe('');
    expect(sessionStorage.length).toBe(0);
  });

  it('migrates the old Commons token to the default backend once', () => {
    sessionStorage.setItem('nebula.commons.token', TOKEN);
    expect(browserPersonCredential()).toEqual({ token: TOKEN, backend: 'http://127.0.0.1:8000' });
    expect(sessionStorage.getItem('nebula.commons.token')).toBeNull();
    forgetPersonCredential();
    expect(browserPersonCredential()).toBeNull();
  });

  it('ignores stored junk instead of trusting it', () => {
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'https://evil.example' }));
    expect(browserPersonCredential()).toBeNull();
    sessionStorage.setItem('nebula.person', '{not json');
    expect(browserPersonCredential()).toBeNull();
  });

  it('never reads a browser link inside the desktop app', async () => {
    const token = vi.fn().mockResolvedValue({ ok: false, error: 'DEV_RENDERER' });
    Object.defineProperty(window, 'nebulaDesktop', {
      value: { apiBaseUrl: 'http://127.0.0.1:56789', person: { token } }, configurable: true, writable: true,
    });
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=http://127.0.0.1:56789`);
    expect(await personCredential()).toBeNull();
    expect(personUnavailableReason()).toBe('dev-renderer');
    expect(personRequiredMessage()).toMatch(/NEBULA_DESKTOP_DEV_PERSON=1/);
  });

  it('takes in a link pasted into an open tab (hash change only) and says so once', () => {
    const connected = vi.fn();
    window.addEventListener('nebula:person-connected', connected);
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=http://127.0.0.1:8131`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(location.hash).toBe('');
    expect(JSON.parse(sessionStorage.getItem('nebula.person')!)).toEqual({ token: TOKEN, backend: 'http://127.0.0.1:8131' });
    expect(connected).toHaveBeenCalledTimes(1);
    expect(browserPersonCredential()).toEqual({ token: TOKEN, backend: 'http://127.0.0.1:8131' });
    expect(connected).toHaveBeenCalledTimes(1);
    window.removeEventListener('nebula:person-connected', connected);
  });

  it('treats a rejected IPC call as no person', async () => {
    const token = vi.fn().mockRejectedValue(new Error('no handler'));
    Object.defineProperty(window, 'nebulaDesktop', {
      value: { apiBaseUrl: 'http://127.0.0.1:56789', person: { token } }, configurable: true, writable: true,
    });
    expect(await personCredential()).toBeNull();
    expect(personUnavailableReason()).toBe('desktop-unavailable');
  });
});
