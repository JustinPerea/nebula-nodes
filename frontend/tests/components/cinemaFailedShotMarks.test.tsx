import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import { CinemaShotsRail } from '../../src/components/cinema-studio/CinemaShotsRail';
import { CinemaSceneNode } from '../../src/components/nodes/CinemaSceneNode';
import { resetDeletedSceneEditsForTests, useGraphStore } from '../../src/store/graphStore';
import type { CinemaSceneSpec, CinemaShot, NodeData } from '../../src/types';

/** The failed shot's marks (design): the rail badge's name and the ⚠ beside the card's port. The glyphs stay. */

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

const previous = { ...useGraphStore.getState() };
afterEach(() => {
  cleanup();
  resetDeletedSceneEditsForTests();
  useGraphStore.setState(previous, true);
});

const shots: CinemaShot[] = [
  { id: 'a', prompt: 'One', output: { status: 'done', imageUrl: '/a.png' } },
  { id: 'b', prompt: 'Two', output: { status: 'error', error: 'Shot generation failed.' } },
  { id: 'c', prompt: 'Three', output: { status: 'running' } },
];
const scene: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots };

describe('the failed shot’s badge in the rail', () => {
  it('is named “Shot 2 failed” and keeps its glyph; the other badges keep their names', () => {
    useGraphStore.setState({ ...previous, activeRuns: [] }, true);
    render(<CinemaShotsRail cinemaNodeId="scene" scene={scene} selectedShotId="a" onSelect={vi.fn()} onAddShot={vi.fn()}
      onReorder={vi.fn()} onRemoveShot={vi.fn()} />);
    const failed = screen.getByRole('status', { name: 'Shot 2 failed' });
    expect(failed.textContent).toBe('⚠');
    expect(screen.getByRole('status', { name: 'Complete shot 1' }).textContent).toBe('✓');
    expect(screen.getByRole('status', { name: 'Generating shot 3' }).textContent).toBe('●');
  });
});

describe('the ⚠ beside a failed shot’s output port on the scene card', () => {
  it('has a tooltip and an accessible name, on the failed shot only', () => {
    const node: Node<NodeData> = { id: 's1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
      data: { definitionId: 'cinema-scene', label: 'Cinema Scene', params: { scene }, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    const { container } = render(<CinemaSceneNode {...({ id: 's1', data: node.data, selected: false } as NodeProps)} />);
    const labels = [...container.querySelectorAll<HTMLElement>('.cinema-scene-node__shot-label')];
    expect(labels.map((label) => label.textContent?.trim())).toEqual(['1', '2 ⚠', '3']);
    const mark = labels[1];
    expect(mark.getAttribute('title')).toBe('Shot 2 failed. Open Studio to see why.');
    expect(screen.getByRole('img', { name: 'Shot 2 failed. Open Studio to see why.' })).toBe(mark);
    expect(labels[0].hasAttribute('title')).toBe(false);
    expect(labels[2].hasAttribute('aria-label')).toBe(false);
  });
});
