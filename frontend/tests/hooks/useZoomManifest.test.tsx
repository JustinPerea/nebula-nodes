import { act, cleanup, render, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSettingsMock = vi.fn();
const apiFetchMock = vi.fn();

vi.mock('../../src/lib/api', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
}));

vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useZoomManifest } from '../../src/hooks/useZoomManifest';
import { useAgentLogStore } from '../../src/store/agentLogStore';

function Harness() {
  useZoomManifest();
  return null;
}

function mountHarness() {
  return render(
    <ReactFlowProvider>
      <Harness />
    </ReactFlowProvider>,
  );
}

describe('useZoomManifest telemetry gate', () => {
  beforeEach(() => {
    getSettingsMock.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => cleanup());

  it('does not initialize telemetry when the setting is absent or false', async () => {
    getSettingsMock.mockResolvedValue({});
    mountHarness();

    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('initializes telemetry only after explicit opt-in', async () => {
    getSettingsMock.mockResolvedValue({ zoomTelemetryEnabled: true });
    mountHarness();

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/zoom-manifest/init', { method: 'POST' });
    });
  });
});

describe('useZoomManifest reads the nodes from the Agent log row, never from its words', () => {
  const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5' };
  const entries = () => apiFetchMock.mock.calls.filter(([path]) => path === '/api/zoom-manifest/entry');

  beforeEach(() => {
    getSettingsMock.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: true });
    useAgentLogStore.getState().clear();
    document.body.innerHTML = '';
    for (const id of ['n1', 'n2']) {
      const el = document.createElement('div');
      el.className = 'react-flow__node';
      el.setAttribute('data-id', id);
      document.body.appendChild(el);
    }
  });

  afterEach(() => cleanup());

  it('records each node of an agent action once, with the row\'s words as the action', async () => {
    getSettingsMock.mockResolvedValue({ zoomTelemetryEnabled: true });
    mountHarness();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/zoom-manifest/init', { method: 'POST' }));
    await act(async () => {});
    act(() => {
      useAgentLogStore.getState().add({
        ts: 1, source: 'agent', agent: CLAUDE, message: 'Connecting “Hero prompt” to “GPT Image 2.5”', nodeIds: ['n1', 'n2'],
      });
    });
    await waitFor(() => expect(entries()).toHaveLength(2));
    expect(entries().map(([, init]) => JSON.parse((init as { body: string }).body))).toEqual([
      expect.objectContaining({ node_id: 'n1', action: 'Connecting “Hero prompt” to “GPT Image 2.5”' }),
      expect.objectContaining({ node_id: 'n2', action: 'Connecting “Hero prompt” to “GPT Image 2.5”' }),
    ]);
  });

  it('records nothing for a row with no nodeIds, even when its words look like an id', async () => {
    getSettingsMock.mockResolvedValue({ zoomTelemetryEnabled: true });
    mountHarness();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/zoom-manifest/init', { method: 'POST' }));
    await act(async () => {});
    act(() => {
      useAgentLogStore.getState().add({ ts: 1, source: 'agent', agent: CLAUDE, message: 'Cleared the canvas' });
      useAgentLogStore.getState().add({ ts: 2, source: 'claude', message: 'Added image-input (n1)' });
    });
    await act(async () => {});
    expect(entries()).toHaveLength(0);
  });

  it('records nothing while telemetry is off', async () => {
    getSettingsMock.mockResolvedValue({});
    mountHarness();
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    act(() => {
      useAgentLogStore.getState().add({ ts: 1, source: 'agent', agent: CLAUDE, message: 'Added “Text Input”', nodeIds: ['n1'] });
    });
    await act(async () => {});
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
