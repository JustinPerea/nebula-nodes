import { apiFetch } from './backend';
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

async function parseJobResponse(response: Response, action: string): Promise<RenderJob> {
  if (!response.ok) {
    let detail = '';
    try { detail = ((await response.json()) as { detail?: string }).detail ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `${action} failed: ${response.status}`);
  }
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
  const response = await apiFetch('/api/video-edit/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, clips }),
  });
  return parseJobResponse(response, 'Video export');
}

export async function startRemotionRender(manifest: VideoGraphManifest): Promise<RenderJob> {
  const response = await apiFetch('/api/remotion-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  return parseJobResponse(response, 'Remotion export');
}

export async function getRenderJob(jobId: string): Promise<RenderJob> {
  const response = await apiFetch(`/api/render-jobs/${encodeURIComponent(jobId)}`);
  return parseJobResponse(response, 'Render status');
}

export async function cancelRenderJob(jobId: string): Promise<RenderJob> {
  const response = await apiFetch(`/api/render-jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
  return parseJobResponse(response, 'Render cancellation');
}
