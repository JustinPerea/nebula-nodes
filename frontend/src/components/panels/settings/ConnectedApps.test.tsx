import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const createConnectedApp = vi.fn();
vi.mock('../../../lib/api', () => ({
  createConnectedApp: (...args: unknown[]) => createConnectedApp(...args),
  revokeConnectedApp: vi.fn(),
  setConnectedAppLimit: vi.fn(),
}));

import { ConnectedApps } from './ConnectedApps';
import type { OutsideSpend } from '../../../lib/api';

const VIEW: OutsideSpend = {
  outside: { spentUsd: 0, kreaPlanRuns: 0 },
  apps: [{ id: 'abc', name: 'My Codex', dailyUsd: 2, createdAt: 1, spentUsd: 0.4, kreaPlanRuns: 0,
    client: 'codex', color: '#FF6B9A' }],
  connect: {
    available: true, reason: null,
    clients: [{ id: 'hermes', label: 'Hermes' }, { id: 'claude-desktop', label: 'Claude Desktop' }],
  },
};

const SETUP = {
  client: 'hermes', label: 'Hermes', kind: 'manual', format: 'yaml', where: '~/.hermes/config.yaml',
  snippet: 'mcp_servers:\n  nebula:\n    env:\n      NEBULA_APP_TOKEN: "nebula_app_secret"\n    trust: untrusted\n',
  steps: ['Add this under mcp_servers in ~/.hermes/config.yaml.', 'Run /reload-mcp in Hermes, or restart it.'],
  alternative: null,
  warnings: ['Hermes’s own scheduled jobs, cron tasks and automations can run Nebula nodes with this token.'],
};

describe('Connect your agent', () => {
  beforeEach(() => createConnectedApp.mockReset());

  it('lists connected agents with their app and color', () => {
    render(<ConnectedApps view={VIEW} loadError={null} onChanged={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Connect your agent' })).toBeTruthy();
    const row = screen.getByTestId('settings-app-row');
    expect(row.textContent).toContain('My Codex');
    expect(row.textContent).toContain('$0.40 in the last 24 h');
  });

  it('makes a token for the picked client and shows its setup once', async () => {
    createConnectedApp.mockResolvedValue({
      app: { ...VIEW.apps[0], id: 'new', name: 'My Hermes', client: 'hermes', color: '#3FC1A5' },
      token: 'nebula_app_secret', setup: SETUP,
    });
    const onChanged = vi.fn();
    render(<ConnectedApps view={VIEW} loadError={null} onChanged={onChanged} />);
    expect((screen.getByRole('textbox', { name: 'Agent name' }) as HTMLInputElement).value).toBe('My Hermes');
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent app' }), { target: { value: 'claude-desktop' } });
    expect((screen.getByRole('textbox', { name: 'Agent name' }) as HTMLInputElement).value).toBe('My Claude Desktop');
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent app' }), { target: { value: 'hermes' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Color #3FC1A5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(createConnectedApp).toHaveBeenCalledWith('My Hermes', 5, { client: 'hermes', color: '#3FC1A5' }));
    const panel = await screen.findByRole('region', { name: 'Set up My Hermes in Hermes' });
    expect(panel.textContent).toContain('NEBULA_APP_TOKEN: "nebula_app_secret"');
    expect(panel.textContent).toContain('only time it can show it');
    expect(screen.getByRole('list', { name: 'Before you paste it' }).textContent).toContain('scheduled jobs');
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/nebula_app_secret/)).toBeNull();
  });

  it('falls back to a plain token when this backend cannot point apps at a checkout', async () => {
    createConnectedApp.mockResolvedValue({ app: { ...VIEW.apps[0], name: 'Script' }, token: 'nebula_app_plain' });
    const view = { ...VIEW, connect: { ...VIEW.connect!, available: false, reason: 'Nebula is running from the packaged app.' } };
    render(<ConnectedApps view={view} loadError={null} onChanged={() => {}} />);
    expect(screen.getByRole('note').textContent).toContain('packaged app');
    expect(screen.queryByRole('combobox', { name: 'Agent app' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Script' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(createConnectedApp).toHaveBeenCalledWith('Script', 5, { color: null }));
    expect(((await screen.findByRole('textbox', { name: 'Token for Script' })) as HTMLInputElement).value).toBe('nebula_app_plain');
  });
});
