import { type EditClip, clipSpeed } from './virtualPlayback';

interface PreviewRenderResponse {
  previewUrl: string;
}

/**
 * Backend contract: the ffmpeg pipeline operates on sourceIn/sourceOut/speed.
 * The frontend stores duration as primary; speed derives from the ratio.
 * Augment each clip with its derived speed before sending.
 */
function augmentForBackend(clip: EditClip): EditClip & { speed: number } {
  return { ...clip, speed: clipSpeed(clip) };
}

export async function renderPreview(req: { sourceUrl: string; clips: EditClip[] }): Promise<string> {
  const body = {
    sourceUrl: req.sourceUrl,
    clips: req.clips.map(augmentForBackend),
  };
  const response = await fetch('/api/video-edit/preview-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Render preview failed: ${detail}`);
  }
  const responseBody = (await response.json()) as PreviewRenderResponse;
  return responseBody.previewUrl;
}
