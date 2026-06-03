import { describe, it, expect, beforeAll } from 'vitest';
import { getBackendBaseUrl, backendAssetUrlSync } from '../../src/lib/backend';

// In test mode discovery resolves to http://localhost:8000 and caches it, so
// backendAssetUrlSync can rewrite server-relative asset paths to an absolute
// backend origin (the real-world case: frontend and backend on different ports).
beforeAll(async () => {
  await getBackendBaseUrl();
});

describe('backendAssetUrlSync', () => {
  it('rewrites /api/outputs/ paths to the discovered backend origin', () => {
    expect(backendAssetUrlSync('/api/outputs/run/x.png')).toBe(
      'http://localhost:8000/api/outputs/run/x.png',
    );
  });

  it('rewrites /api/presets/thumbnails/ paths to the discovered backend origin', () => {
    // Regression: seeded preset thumbnails were left relative and resolved
    // against the frontend origin, so they 404'd whenever the backend wasn't
    // same-origin. They must be rewritten like generated media.
    expect(backendAssetUrlSync('/api/presets/thumbnails/cinematic-noir')).toBe(
      'http://localhost:8000/api/presets/thumbnails/cinematic-noir',
    );
  });

  it('leaves non-asset paths and plain strings untouched', () => {
    // /api/presets/<id> is a JSON endpoint, not an asset — must NOT be rewritten.
    expect(backendAssetUrlSync('/api/presets/abc123')).toBe('/api/presets/abc123');
    expect(backendAssetUrlSync('just-a-string')).toBe('just-a-string');
  });
});
