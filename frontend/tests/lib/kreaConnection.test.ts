import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import {
  checkKreaConnection, connectKrea, disconnectKrea, getKreaConnection,
  isKreaAuthorizationUrl, isKreaGateway, kreaModeForParams, nodeKeyStatus,
  withNewKreaMode,
} from '../../src/lib/kreaConnection';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/backend', () => ({ apiFetch: apiFetchMock }));

const image = NODE_DEFINITIONS['krea-image-openai-gpt-image-2'];
const video = NODE_DEFINITIONS['krea-video-kling-kling-3-0'];

describe('Krea connection contract', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('limits OAuth choices to gateway image and video models', () => {
    expect(isKreaGateway(image)).toBe(true);
    expect(isKreaGateway(video)).toBe(true);
    expect(isKreaGateway(NODE_DEFINITIONS['krea-image-style-reference'])).toBe(false);
    expect(isKreaGateway(NODE_DEFINITIONS['krea-2'])).toBe(false);
    expect(isKreaGateway(NODE_DEFINITIONS['nano-banana'])).toBe(false);
  });

  it('applies the selected mode only to new gateway params and preserves old API recipes', () => {
    const old = { prompt: 'a cat' };
    expect(withNewKreaMode(image, old, 'mcp')).toEqual({ ...old, _kreaAuth: 'mcp' });
    expect(old).toEqual({ prompt: 'a cat' });
    expect(kreaModeForParams(old)).toBe('api-token');
    expect(kreaModeForParams({ _kreaAuth: 'mcp' })).toBe('mcp');
    expect(withNewKreaMode(NODE_DEFINITIONS['nano-banana'], old, 'mcp')).toBe(old);
  });

  it('checks the chosen billing connection without accepting the other credential', () => {
    const oauth = { loaded: true, apiKeys: {}, kreaConnection: { status: 'connected' as const } };
    const api = { loaded: true, apiKeys: { KREA_API_TOKEN: 'fixture-only' },
      kreaConnection: { status: 'needs_auth' as const } };
    expect(nodeKeyStatus(image, { _kreaAuth: 'mcp' }, oauth)).toBeUndefined();
    expect(nodeKeyStatus(image, {}, oauth)).toBe('missing');
    expect(nodeKeyStatus(image, { _kreaAuth: 'api-token' }, api)).toBeUndefined();
    expect(nodeKeyStatus(image, { _kreaAuth: 'mcp' }, api)).toBe('missing');
    expect(nodeKeyStatus(video, { _kreaAuth: 'mcp' }, { ...oauth,
      kreaConnection: { status: 'connecting' } })).toBe('missing');
    expect(nodeKeyStatus(image, {}, { ...oauth, loaded: false })).toBeUndefined();
  });

  it('allows only the official consent page to open outside Nebula', () => {
    expect(isKreaAuthorizationUrl('https://www.krea.ai/auth/v1/oauth/authorize?state=fixture')).toBe(true);
    for (const url of ['http://www.krea.ai/auth/v1/oauth/authorize',
      'https://www.krea.ai.evil.test/auth/v1/oauth/authorize',
      'https://user:secret@www.krea.ai/auth/v1/oauth/authorize',
      'https://www.krea.ai/auth/v1/oauth/authorize#token', 'javascript:alert(1)',
      'https://www.krea.ai/other']) expect(isKreaAuthorizationUrl(url)).toBe(false);
  });

  it('uses only connector routes and never generation endpoints', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'disconnected' }) });
    await getKreaConnection();
    await connectKrea();
    await checkKreaConnection();
    await disconnectKrea();
    expect(apiFetchMock.mock.calls).toEqual([
      ['/api/krea/connection', { method: 'GET' }],
      ['/api/krea/connection/connect', { method: 'POST' }],
      ['/api/krea/connection/check', { method: 'POST' }],
      ['/api/krea/connection', { method: 'DELETE' }],
    ]);
  });

  it('keeps transport and response errors out of the visible error message', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('https://private.test/?token=fixture-secret'));
    await expect(connectKrea()).rejects.toThrow('Could not update the Krea connection.');
    apiFetchMock.mockResolvedValueOnce({ ok: false, json: vi.fn() });
    await expect(checkKreaConnection()).rejects.toThrow('Could not update the Krea connection.');
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('token=fixture'); } });
    await expect(getKreaConnection()).rejects.toThrow('Could not update the Krea connection.');
  });
});
