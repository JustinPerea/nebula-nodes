import { describe, expect, it } from 'vitest';
import { overviewThumbnailUrl } from './canvasOverview';

describe('overviewThumbnailUrl', () => {
  it('asks the backend for a thumbnail of a Nebula image or video', () => {
    expect(overviewThumbnailUrl('/api/outputs/2026-10-19/hero.png')).toBe('/api/outputs/2026-10-19/hero.png?thumb=1');
    expect(overviewThumbnailUrl('/api/outputs/uploads/ref.JPG')).toBe('/api/outputs/uploads/ref.JPG?thumb=1');
    expect(overviewThumbnailUrl('/api/outputs/run/clip.mp4')).toBe('/api/outputs/run/clip.mp4?thumb=1');
    expect(overviewThumbnailUrl('http://127.0.0.1:8123/api/outputs/run/hero.webp'))
      .toBe('http://127.0.0.1:8123/api/outputs/run/hero.webp?thumb=1');
    expect(overviewThumbnailUrl('/api/outputs/run/hero.png?v=2')).toBe('/api/outputs/run/hero.png?v=2&thumb=1');
  });

  it('leaves everything else alone', () => {
    for (const src of [
      null, undefined, '',
      '/api/outputs/run/logo.svg',
      '/api/outputs/run/model.glb',
      '/api/presets/thumbnails/abc',
      'https://cdn.example.com/api/outputs/run/hero.png',
      '//cdn.example.com/api/outputs/run/hero.png',
      'data:image/png;base64,AAAA',
      'blob:http://localhost:5173/1234',
    ]) {
      expect(overviewThumbnailUrl(src)).toBeNull();
    }
  });
});
