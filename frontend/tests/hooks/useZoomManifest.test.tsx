import { cleanup, render, waitFor } from '@testing-library/react';
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
