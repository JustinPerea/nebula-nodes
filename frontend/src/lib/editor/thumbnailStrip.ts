/**
 * Lazily generate timeline thumbnails by seeking an offscreen <video> and
 * drawing into a canvas. Cache as data URLs keyed by clip+time.
 */

const cache = new Map<string, string>();

export interface ThumbnailRequest {
  sourceUrl: string;
  time: number;
  width: number;
}

export async function getThumbnail({ sourceUrl, time, width }: ThumbnailRequest): Promise<string> {
  const key = `${sourceUrl}|${time.toFixed(2)}|${width}`;
  const cached = cache.get(key);
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.muted = true;
    video.src = sourceUrl;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(time, video.duration - 0.05);
    });

    video.addEventListener('seeked', () => {
      try {
        const aspect = (video.videoHeight / video.videoWidth) || 9 / 16;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.round(width * aspect);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2d context unavailable');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        cache.set(key, dataUrl);
        cleanup();
        resolve(dataUrl);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

    video.addEventListener('error', () => {
      cleanup();
      reject(new Error(`Failed to load source for thumbnail: ${sourceUrl}`));
    });
  });
}

export function clearThumbnailCache(): void {
  cache.clear();
}
