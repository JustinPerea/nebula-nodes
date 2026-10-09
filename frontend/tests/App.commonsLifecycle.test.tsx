import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({ ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch }));
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({}), fetchCLIGraph: () => new Promise(() => {}),
}));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: vi.fn().mockResolvedValue({ status: 'disconnected' }),
}));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/components/projects/ProjectCoordinator', () => ({ ProjectCoordinator: () => null }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => <div>Current canvas</div> }));
vi.mock('../src/components/CanvasTabs', () => ({ CanvasTabs: () => null }));
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => null }));
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ProviderRecoveryStatus', () => ({ ProviderRecoveryStatus: () => null }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => null }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => null }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({ NodeInspectorPopover: () => null }));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/panels/Settings', () => ({ Settings: () => null }));
vi.mock('../src/components/panels/ChatPanel', async () => {
  const { useState } = await import('react');
  return { ChatPanel: function Chat() {
    const [value, setValue] = useState('Saved conversation');
    return <button onClick={() => setValue('Continued conversation')}>{value}</button>;
  } };
});
vi.mock('../src/components/commons/CommonsView', async () => {
  const { useUIStore } = await import('../src/store/uiStore');
  return { CommonsView: () => <button onClick={() => useUIStore.getState().exitCommons()}>Return from Commons</button> };
});
import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { useProjectStore } from '../src/store/projectStore';
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
beforeEach(() => { useUIStore.setState(initialUI, true); useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false }, true); api.fetch.mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { headers: { 'content-type': 'application/json' } })); });
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); useProjectStore.setState(initialProjects, true); });

it('lazy navigation retains the shared chat instance and inerts its hidden controls until returning', async () => {
  const { container } = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved conversation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open Commons' }));
  expect(await screen.findByRole('button', { name: 'Return from Commons' })).toBeTruthy();
  const overlay = container.querySelector('.workspace-overlays')!;
  expect(overlay).toHaveClass('workspace-overlays--hidden');
  expect(overlay).toHaveAttribute('inert');
  expect(overlay.textContent).toContain('Continued conversation');
  fireEvent.click(screen.getByRole('button', { name: 'Return from Commons' }));
  await act(async () => {});
  expect(screen.getByText('Current canvas')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continued conversation' })).toBeTruthy();
  expect(overlay).not.toHaveClass('workspace-overlays--hidden');
  expect(overlay).not.toHaveAttribute('inert');
});
