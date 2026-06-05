import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PresetCard } from '../../src/components/create-studio/PresetCard';
import type { Preset } from '../../src/lib/createPresets';

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'test-id-01',
    name: 'Cinematic Noir',
    category: 'Cinematic',
    prompt: 'high-contrast film noir',
    params: {},
    modelId: 'nano-banana',
    refImages: [],
    thumbnail: '',
    version: 1,
    scope: 'global',
    projectId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('PresetCard', () => {
  it('renders an <img> when thumbnail is set', () => {
    const preset = makePreset({ thumbnail: '/api/presets/thumbnails/cinematic-noir' });
    const { container } = render(<PresetCard preset={preset} onApply={() => {}} />);
    const img = container.querySelector('img.preset-card__thumb');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/api/presets/thumbnails/cinematic-noir');
    expect(container.querySelector('.preset-card__gradient')).toBeNull();
  });

  it('renders the gradient fallback when thumbnail is empty', () => {
    const preset = makePreset({ thumbnail: '' });
    const { container } = render(<PresetCard preset={preset} onApply={() => {}} />);
    expect(container.querySelector('.preset-card__gradient')).not.toBeNull();
    expect(container.querySelector('img.preset-card__thumb')).toBeNull();
  });

  it('falls back to gradient when the img fires onError', () => {
    const preset = makePreset({ thumbnail: '/api/presets/thumbnails/broken' });
    const { container } = render(<PresetCard preset={preset} onApply={() => {}} />);
    // Initially shows the img
    const img = container.querySelector('img.preset-card__thumb');
    expect(img).not.toBeNull();
    // Simulate a broken image load
    fireEvent.error(img!);
    // After error, gradient appears and img is gone
    expect(container.querySelector('.preset-card__gradient')).not.toBeNull();
    expect(container.querySelector('img.preset-card__thumb')).toBeNull();
  });

  it('calls onApply with the preset when clicked', () => {
    const preset = makePreset();
    let applied: Preset | null = null;
    render(<PresetCard preset={preset} onApply={(p) => { applied = p; }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(applied).toBe(preset);
  });
});
