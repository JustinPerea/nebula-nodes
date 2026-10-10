import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { NodeRunStatus } from '../../src/components/nodes/NodeRunStatus';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { runRouteProvider } from '../../src/lib/modelDiscovery';
import { formatElapsed } from '../../src/lib/runStatus';
import { useUIStore } from '../../src/store/uiStore';
import type { NodeData } from '../../src/types';

const data = (overrides: Partial<NodeData>): NodeData => ({
  label: 'GPT Image 2.5', definitionId: 'gpt-image-2-5-generate', params: {}, outputs: {}, state: 'idle', ...overrides,
});

describe('formatElapsed', () => {
  it('reads seconds, then minutes with padded seconds', () => {
    expect(formatElapsed(-500)).toBe('0s');
    expect(formatElapsed(6_400)).toBe('6s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
  });
});

describe('runRouteProvider', () => {
  it('follows the backend: own key first, then the FAL fallback, and no provider for local tools', () => {
    const ideogram = NODE_DEFINITIONS['ideogram-v4'];
    expect(runRouteProvider(ideogram, { IDEOGRAM_API_KEY: 'set', FAL_KEY: 'set' })).toBe('ideogram');
    expect(runRouteProvider(ideogram, { FAL_KEY: 'set' })).toBe('fal');
    expect(runRouteProvider(NODE_DEFINITIONS['gpt-image-2-5-generate'], {})).toBe('openai');
    expect(runRouteProvider(NODE_DEFINITIONS['text-input'], {})).toBeNull();
  });
});

describe('NodeRunStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
  });
  afterEach(() => vi.useRealTimers());

  it('shows the provider and a ticking elapsed time while running', () => {
    const definition = NODE_DEFINITIONS['gpt-image-2-5-generate'];
    render(<NodeRunStatus data={data({ state: 'executing', progress: 0, runStartedAt: Date.now() - 4_000 })} definition={definition} />);
    expect(screen.getByRole('status').textContent).toBe('OpenAI · 4s');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByRole('status').textContent).toBe('OpenAI · 6s');
  });

  it('adds reported progress, says Queued while waiting, and hides when idle', () => {
    const definition = NODE_DEFINITIONS['gpt-image-2-5-generate'];
    const { rerender, container } = render(<NodeRunStatus data={data({ state: 'queued' })} definition={definition} />);
    expect(screen.getByRole('status').textContent).toBe('Queued');
    rerender(<NodeRunStatus data={data({ state: 'executing', progress: 0.42, runStartedAt: Date.now() })} definition={definition} />);
    expect(screen.getByRole('status').textContent).toBe('OpenAI · 0s · 42%');
    expect(container.querySelector('.model-node__progress-bar')).not.toBeNull();
    rerender(<NodeRunStatus data={data({ state: 'complete' })} definition={definition} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
