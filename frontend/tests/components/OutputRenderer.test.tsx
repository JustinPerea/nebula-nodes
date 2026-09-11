import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/nodes/WorldPreview', () => ({
  WorldPreview: ({ value }: { value: unknown }) => (
    <div data-testid="world-preview">{JSON.stringify(value)}</div>
  ),
}));

vi.mock('../../src/components/nodes/MeshPreview', () => ({
  MeshPreview: ({ src }: { src: string }) => <div data-testid="mesh-preview">{src}</div>,
}));

import { OutputRenderer } from '../../src/components/create-studio/OutputRenderer';

describe('OutputRenderer World output', () => {
  it('prioritizes the structured World over derivative thumbnail, panorama, and collider outputs', () => {
    render(
      <OutputRenderer
        state="complete"
        outputs={{
          thumbnail: { type: 'Image', value: '/api/outputs/thumb.jpg' },
          collider: { type: 'Mesh', value: '/api/outputs/collider.glb' },
          caption: { type: 'Text', value: 'A courtyard' },
          world: {
            type: 'World',
            value: {
              schemaVersion: 1,
              provider: 'worldlabs',
              worldId: 'world-123',
              assets: { splats: { '100k': '/api/outputs/world.spz' } },
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId('world-preview')).toHaveTextContent('world-123');
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('model-viewer')).toBeNull();
  });

  it('routes PLY exports through the format-aware MeshPreview', () => {
    render(
      <OutputRenderer
        state="complete"
        outputs={{
          file: { type: 'Mesh', value: '/api/outputs/world-full.ply' },
          format: { type: 'Text', value: 'ply' },
        }}
      />,
    );

    expect(screen.getByTestId('mesh-preview')).toHaveTextContent('/api/outputs/world-full.ply');
    expect(document.querySelector('model-viewer')).toBeNull();
  });
});
