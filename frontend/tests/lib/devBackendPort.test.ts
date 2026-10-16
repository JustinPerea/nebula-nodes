// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKEND_PORTS,
  assertBackendEnvConsistent,
  backendPortsFor,
  devProxyPort,
  originAllowedByPin,
  pinnedBackendPort,
} from '../../src/lib/devBackendPort';
import viteConfig, { devBackendProxy } from '../../vite.config';

const TODAYS_PORTS = [8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010];

describe('backendPortsFor', () => {
  it('with nothing set, scans 8000-8010 exactly as before', () => {
    expect(DEFAULT_BACKEND_PORTS).toEqual(TODAYS_PORTS);
    expect(backendPortsFor({})).toEqual(TODAYS_PORTS);
    expect(backendPortsFor({ port: '', ports: '  ' })).toEqual(TODAYS_PORTS);
  });

  it('with VITE_NEBULA_BACKEND_PORT set, returns only that port', () => {
    expect(backendPortsFor({ port: '8155' })).toEqual([8155]);
    expect(backendPortsFor({ port: ' 8155 ' })).toEqual([8155]);
  });

  it('the pin wins over the VITE_NEBULA_BACKEND_PORTS scan list', () => {
    expect(backendPortsFor({ port: '8155', ports: '8000,8001' })).toEqual([8155]);
  });

  it('keeps VITE_NEBULA_BACKEND_PORTS working on its own', () => {
    expect(backendPortsFor({ ports: '8101, 8102,8101' })).toEqual([8101, 8102]);
    expect(backendPortsFor({ ports: 'junk' })).toEqual(TODAYS_PORTS);
  });

  it('a pin that is set but not a port fails closed instead of scanning', () => {
    for (const bad of ['abc', '0', '65536', '81.5', '8155,8156', '-1']) {
      expect(() => backendPortsFor({ port: bad })).toThrow(/VITE_NEBULA_BACKEND_PORT/);
    }
  });

  it('a returned list is a copy, so callers cannot change the defaults', () => {
    const ports = backendPortsFor({});
    ports.push(9999);
    expect(backendPortsFor({})).toEqual(TODAYS_PORTS);
  });
});

describe('pin helpers', () => {
  it('pinnedBackendPort is null when unset', () => {
    expect(pinnedBackendPort(undefined)).toBeNull();
    expect(pinnedBackendPort('')).toBeNull();
    expect(pinnedBackendPort('8155')).toBe(8155);
  });

  it('devProxyPort is 8000 unless pinned', () => {
    expect(devProxyPort({})).toBe(8000);
    expect(devProxyPort({ ports: '8101' })).toBe(8000);
    expect(devProxyPort({ port: '8155' })).toBe(8155);
  });

  it('originAllowedByPin allows anything unpinned and only the pin when pinned', () => {
    expect(originAllowedByPin('http://127.0.0.1:8000', {})).toBe(true);
    expect(originAllowedByPin('http://127.0.0.1:8155', { port: '8155' })).toBe(true);
    expect(originAllowedByPin('http://localhost:8155', { port: '8155' })).toBe(true);
    expect(originAllowedByPin('http://127.0.0.1:8000', { port: '8155' })).toBe(false);
    expect(originAllowedByPin('http://127.0.0.1', { port: '8155' })).toBe(false);
    expect(originAllowedByPin('not a url', { port: '8155' })).toBe(false);
  });

  it('a pin and an API base on another port contradict each other', () => {
    expect(() => assertBackendEnvConsistent({ port: '8155', apiBase: 'http://127.0.0.1:8000' })).toThrow(
      /name different backends/,
    );
    expect(() => assertBackendEnvConsistent({ port: '8155', apiBase: 'http://127.0.0.1:8155' })).not.toThrow();
    expect(() => assertBackendEnvConsistent({ apiBase: 'http://127.0.0.1:8000' })).not.toThrow();
  });
});

describe('vite.config proxy target', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  type ProxyEntry = { target: string };
  const resolveProxy = async () => {
    const factory = viteConfig as unknown as (env: { mode: string; command: string }) => {
      server?: { proxy?: Record<string, ProxyEntry> };
    };
    const config = await factory({ mode: 'development', command: 'serve' });
    return config.server?.proxy ?? {};
  };

  it('proxies /api and /ws to 127.0.0.1:8000 with nothing set', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '');
    vi.stubEnv('VITE_NEBULA_API_BASE', '');
    const proxy = await resolveProxy();
    expect(proxy['/api'].target).toBe('http://127.0.0.1:8000');
    expect(proxy['/ws'].target).toBe('ws://127.0.0.1:8000');
  });

  it('follows VITE_NEBULA_BACKEND_PORT from the shell', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    vi.stubEnv('VITE_NEBULA_API_BASE', '');
    const proxy = await resolveProxy();
    expect(proxy['/api'].target).toBe('http://127.0.0.1:8155');
    expect(proxy['/ws'].target).toBe('ws://127.0.0.1:8155');
  });

  it('refuses to start when the pin contradicts VITE_NEBULA_API_BASE', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    vi.stubEnv('VITE_NEBULA_API_BASE', 'http://127.0.0.1:8000');
    await expect(resolveProxy()).rejects.toThrow(/name different backends/);
  });

  it('devBackendProxy is the same helper the config uses', () => {
    expect(devBackendProxy({ port: '8155' })['/api'].target).toBe('http://127.0.0.1:8155');
    expect(devBackendProxy({})['/api'].target).toBe('http://127.0.0.1:8000');
  });
});
