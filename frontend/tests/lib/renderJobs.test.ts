import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import {
  cancelRenderJob,
  getRenderJob,
  startRemotionRender,
  startVideoExport,
} from '../../src/lib/renderJobs';

const running = {
  id: 'job-1',
  kind: 'video-edit',
  status: 'running',
  progress: 0,
  outputUrl: null,
  error: null,
};

describe('render job API', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => running });
  });

  it('sends derived clip speed and selected final format controls', async () => {
    await startVideoExport({
      sourceUrl: '/api/outputs/source.mp4',
      clips: [{
        id: 'c1', start: 0, duration: 1, sourceIn: 0, sourceOut: 2,
        volume: 1, mute: false,
      }],
      format: 'webm',
      resolution: '720p',
      quality: 'high',
    });

    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ format: 'webm', resolution: '720p', quality: 'high' });
    expect(body.clips[0].speed).toBe(2);
  });

  it('passes the exact manifest object as Remotion input', async () => {
    const manifest = { graph: { nodes: [{ id: 'n1' }], edges: [] }, timeline: [] };
    await startRemotionRender(manifest);
    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body)).toEqual({ manifest });
  });

  it('uses job-specific poll and cancel endpoints', async () => {
    await getRenderJob('job/unsafe');
    await cancelRenderJob('job/unsafe');
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/render-jobs/job%2Funsafe');
    expect(apiFetchMock.mock.calls[1]).toEqual([
      '/api/render-jobs/job%2Funsafe',
      { method: 'DELETE' },
    ]);
  });
});
