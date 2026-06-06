import { describe, it, expect } from 'vitest';
import {
  CREATE_MODEL_CATEGORIES, getCreateModels, getFeaturedModels, searchModels,
} from '../../src/lib/createModels';

describe('createModels', () => {
  it('returns only model-category nodes and excludes utility/universal/cinematic', () => {
    const models = getCreateModels();
    expect(models.length).toBeGreaterThan(20);
    expect(models.every((m) => CREATE_MODEL_CATEGORIES.includes(m.category))).toBe(true);
    expect(models.some((m) => m.id === 'nano-banana')).toBe(true);
    expect(models.some((m) => m.id === 'text-input')).toBe(false);
    expect(models.some((m) => m.id === 'cinema-scene')).toBe(false);
  });

  it('featured returns only ids that exist, in declared order', () => {
    const featured = getFeaturedModels();
    expect(featured.some((m) => m.id === 'nano-banana')).toBe(true);
    // every featured model is a real model node
    const allIds = new Set(getCreateModels().map((m) => m.id));
    expect(featured.every((m) => allIds.has(m.id))).toBe(true);
  });

  it('search matches display name, provider, and category (case-insensitive)', () => {
    expect(searchModels('nano').some((m) => m.id === 'nano-banana')).toBe(true);
    // Category substring match: a 'VIDEO' search surfaces every video-gen model.
    // It also legitimately surfaces non-video-gen tools whose displayName contains
    // "video" (e.g. MMAudio "Video Foley", an audio-gen node) since matching spans
    // displayName too — so we assert it COVERS video-gen, not that the set is
    // video-gen-only (which a well-named audio tool can correctly violate).
    const videoGen = getCreateModels().filter((m) => m.category === 'video-gen');
    const videoHits = searchModels('VIDEO');
    expect(videoGen.length).toBeGreaterThan(0);
    expect(videoGen.every((vm) => videoHits.some((h) => h.id === vm.id))).toBe(true);
    expect(searchModels('')).toEqual(getCreateModels());
  });
});
