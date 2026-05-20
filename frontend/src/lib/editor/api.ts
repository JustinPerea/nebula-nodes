import type { EditClip } from './virtualPlayback';

interface PreviewRenderResponse {
  previewUrl: string;
}

export async function renderPreview(req: { sourceUrl: string; clips: EditClip[] }): Promise<string> {
  const response = await fetch('/api/video-edit/preview-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Render preview failed: ${detail}`);
  }
  const body = (await response.json()) as PreviewRenderResponse;
  return body.previewUrl;
}
