import { apiRequest } from './apiRequest';
import { clipSpeed, type EditClip } from './editor/virtualPlayback';
import type { VideoGraphManifest } from '../types/video';

export type RenderJobStatus = 'running' | 'complete' | 'failed' | 'cancelled';

export interface RenderJob {
  id: string;
  kind: 'video-edit' | 'remotion';
  status: RenderJobStatus;
  progress: number;
  outputUrl: string | null;
  error: string | null;
}

export type VideoExportFormat = 'mp4' | 'mov' | 'webm' | 'gif';
export type VideoExportResolution = 'source' | '1080p' | '720p' | '480p';
export type VideoExportQuality = 'high' | 'balanced' | 'small';

/** Each call names its action (GM, error-copy round 2); apiRequest says
 * the reason, never the status. */
async function job(heading: string, path: string, init?: RequestInit): Promise<RenderJob> {
  const response = await apiRequest(heading, path, init);
  return response.json() as Promise<RenderJob>;
}

export async function startVideoExport(input: {
  sourceUrl: string;
  clips: EditClip[];
  format: VideoExportFormat;
  resolution: VideoExportResolution;
  quality: VideoExportQuality;
}): Promise<RenderJob> {
  const clips = input.clips.map((clip) => ({ ...clip, speed: clipSpeed(clip) }));
  return job("Couldn't export the video.", '/api/video-edit/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, clips }),
  });
}

export async function startRemotionRender(manifest: VideoGraphManifest): Promise<RenderJob> {
  return job("Couldn't start the render.", '/api/remotion-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
}

export async function getRenderJob(jobId: string): Promise<RenderJob> {
  return job("Couldn't check the render.", `/api/render-jobs/${encodeURIComponent(jobId)}`);
}

export async function cancelRenderJob(jobId: string): Promise<RenderJob> {
  return job("Couldn't cancel the render.", `/api/render-jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}
