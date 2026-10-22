import { type EditClip, clipSpeed } from './virtualPlayback';
import { apiRequest } from '../apiRequest';

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
  const response = await apiRequest("Couldn't render the preview.", '/api/video-edit/preview-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = (await response.json()) as PreviewRenderResponse;
  return responseBody.previewUrl;
}
