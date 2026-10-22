import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(), apiFetch: transport.apiFetch,
}));

import { useInputSizeStore } from '../../src/store/inputSizeStore';

function reply(sizes: Record<string, unknown>) {
  return { ok: true, json: async () => ({ sizes }) } as Response;
}

describe('input sizes for the run estimate', () => {
  beforeEach(() => {
    transport.apiFetch.mockReset();
    useInputSizeStore.setState({ sizes: {} });
  });

  it('asks the backend once per file and keeps the answer', async () => {
    transport.apiFetch.mockResolvedValue(reply({ '/out/a.png': { width: 1000, height: 1000 } }));
    const { request } = useInputSizeStore.getState();
    request([{ ref: '/out/a.png', kind: 'Image' }]);
    request([{ ref: '/out/a.png', kind: 'Image' }]);
    await vi.waitFor(() => expect(useInputSizeStore.getState().sizes['/out/a.png']).toEqual({ width: 1000, height: 1000 }));
    expect(transport.apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = transport.apiFetch.mock.calls[0];
    expect(path).toBe('/api/pricing/input-sizes');
    expect(JSON.parse(String(init.body))).toEqual({ refs: [{ ref: '/out/a.png', kind: 'Image' }] });
  });

  it('asks again after a failed request', async () => {
    transport.apiFetch.mockRejectedValueOnce(new Error('offline'));
    useInputSizeStore.getState().request([{ ref: '/out/b.png', kind: 'Image' }]);
    await vi.waitFor(() => expect(transport.apiFetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    transport.apiFetch.mockResolvedValue(reply({ '/out/b.png': null }));
    await vi.waitFor(() => {
      useInputSizeStore.getState().request([{ ref: '/out/b.png', kind: 'Image' }]);
      expect(useInputSizeStore.getState().sizes).toHaveProperty('/out/b.png', null);
    });
  });
});
