import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';

// The canvas Character node is the launcher for its character (lib/agentAnchors),
// as the Moodboard node is for its board; a node with none attached carries nothing.
const net = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  apiFetch: net.apiFetch,
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(() => () => {}) } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id }: { id?: string }) => <span data-testid={`handle-${id}`} />,
}));

import { CharacterNode } from '../../src/components/nodes/CharacterNode';
import { useStoredAssetsStore } from '../../src/store/storedAssetsStore';
import { setOpenProject } from '../../src/test/projectState';

beforeEach(() => {
  setOpenProject(['project-1', 'Project one']);
  net.apiFetch.mockReset().mockImplementation(async (path: string) => ({
    ok: true, status: 200,
    json: async () => (path === '/api/characters/c1'
      ? { id: 'c1', name: 'Rina', thumbnail: '/api/outputs/rina.png', referenceViews: [] } : {}),
  }));
  useStoredAssetsStore.setState({ entries: {} });
});
afterEach(() => cleanup());

const node = (params: Record<string, unknown>) => render(<CharacterNode {...({ id: 'n2', data: { params }, selected: false } as unknown as NodeProps)} />);

describe('the Character node', () => {
  it('is the launcher for its character', async () => {
    const { container } = node({ character: 'c1' });
    await screen.findByText('◐ Rina');
    expect(container.querySelector('.character-node')!.getAttribute('data-agent-launcher')).toBe('character:c1');
  });

  it('carries none when no character is attached', () => {
    const { container } = node({});
    expect(container.querySelector('.character-node')!.hasAttribute('data-agent-launcher')).toBe(false);
  });
});
