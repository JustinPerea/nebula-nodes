import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const createConnectedApp = vi.fn();
const setConnectedAppColor = vi.fn();
vi.mock('../../../lib/api', () => ({
  createConnectedApp: (...args: unknown[]) => createConnectedApp(...args),
  setConnectedAppColor: (...args: unknown[]) => setConnectedAppColor(...args),
  revokeConnectedApp: vi.fn(),
  setConnectedAppLimit: vi.fn(),
}));

import { ConnectedApps } from './ConnectedApps';
import type { OutsideSpend } from '../../../lib/api';
import { RequestFailedError } from '../../../lib/errorCopy';

const VIEW: OutsideSpend = {
  outside: { spentUsd: 0, kreaPlanRuns: 0 },
  apps: [{ id: 'abc', name: 'My Codex', dailyUsd: 2, createdAt: 1, spentUsd: 0.4, kreaPlanRuns: 0,
    client: 'codex', color: '#FF6B9A' }],
  connect: {
    available: true, reason: null,
    clients: [{ id: 'hermes', label: 'Hermes' }, { id: 'claude-desktop', label: 'Claude Desktop' }],
  },
};

const TOKEN_FILE = '/Users/me/.nebula/app-tokens/0123456789ab.token';
const SETUP = {
  client: 'hermes', label: 'Hermes', kind: 'manual', format: 'yaml', where: '~/.hermes/config.yaml',
  snippet: `mcp_servers:\n  nebula:\n    env:\n      NEBULA_APP_TOKEN_FILE: "${TOKEN_FILE}"\n    trust: untrusted\n`,
  steps: ['Add this under mcp_servers in ~/.hermes/config.yaml.', 'Run /reload-mcp in Hermes, or restart it.'],
  alternative: null,
  tokenFile: TOKEN_FILE,
  cli: null,
  warnings: ['Hermes’s own scheduled jobs, cron tasks and automations can run Nebula nodes with this token.'],
};

describe('Connect your agent', () => {
  beforeEach(() => {
    createConnectedApp.mockReset();
    setConnectedAppColor.mockReset();
  });

  it('lists connected agents with their app and color', () => {
    render(<ConnectedApps view={VIEW} loadError={null} onChanged={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Connect your agent' })).toBeTruthy();
    const row = screen.getByTestId('settings-app-row');
    expect(row.textContent).toContain('My Codex');
    expect(row.textContent).toContain('$0.40 in the last 24 h');
  });

  it('makes a token for the picked client and shows a setup that names its file, not the token', async () => {
    createConnectedApp.mockResolvedValue({
      app: { ...VIEW.apps[0], id: 'new', name: 'My Hermes', client: 'hermes', color: '#3FC1A5' },
      token: 'nebula_app_secret', tokenFile: TOKEN_FILE, setup: SETUP,
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
    expect(panel.textContent).toContain(`NEBULA_APP_TOKEN_FILE: "${TOKEN_FILE}"`);
    expect(panel.textContent).toContain('only your macOS user can read');
    expect(document.body.textContent).not.toContain('nebula_app_secret');
    // Hermes is print-only for the CLI, so no command is offered.
    expect(within(panel).queryByRole('button', { name: 'Copy Hermes nebula command' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Before you paste it' }).textContent).toContain('scheduled jobs');
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Set up My Hermes in Hermes' })).toBeNull();
  });

  it('offers the nebula command for an app the CLI can set up', async () => {
    const cli = `NEBULA_URL=http://127.0.0.1:8000 /repo/backend/.venv/bin/python /repo/nebula mcp connect cursor \\\n  --token-file ${TOKEN_FILE}`;
    createConnectedApp.mockResolvedValue({
      app: { ...VIEW.apps[0], id: 'new', name: 'My Cursor', client: 'cursor' }, token: 'nebula_app_secret',
      tokenFile: TOKEN_FILE, setup: { ...SETUP, client: 'cursor', label: 'Cursor', kind: 'json', cli },
    });
    render(<ConnectedApps view={VIEW} loadError={null} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const panel = await screen.findByRole('region', { name: /Set up .* in Cursor/ });
    expect(within(panel).getByRole('button', { name: 'Copy Cursor nebula command' })).toBeTruthy();
    expect(within(panel).getByLabelText('Cursor nebula command').textContent).toBe(cli);
  });

  it('falls back to a plain token whose value stays hidden until asked for', async () => {
    createConnectedApp.mockResolvedValue({ app: { ...VIEW.apps[0], name: 'Script' }, token: 'nebula_app_plain',
      tokenFile: TOKEN_FILE });
    const view = { ...VIEW, connect: { ...VIEW.connect!, available: false, reason: 'Nebula is running from the packaged app.' } };
    render(<ConnectedApps view={view} loadError={null} onChanged={() => {}} />);
    expect(screen.getByRole('note').textContent).toContain('packaged app');
    expect(screen.queryByRole('combobox', { name: 'Agent app' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Script' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(createConnectedApp).toHaveBeenCalledWith('Script', 5, { color: null }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(TOKEN_FILE);
    expect(screen.queryByRole('textbox', { name: 'Token for Script' })).toBeNull();
    expect(document.body.textContent).not.toContain('nebula_app_plain');
    fireEvent.click(screen.getByRole('button', { name: /Show the token/ }));
    expect((screen.getByRole('textbox', { name: 'Token for Script' }) as HTMLInputElement).value).toBe('nebula_app_plain');
  });

  it('changes a connected agent’s cursor color from its dot', async () => {
    let resolve: (value: unknown) => void = () => {};
    setConnectedAppColor.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onChanged = vi.fn();
    render(<ConnectedApps view={VIEW} loadError={null} onChanged={onChanged} />);
    const row = screen.getByTestId('settings-app-row');
    expect(within(row).queryByRole('radiogroup', { name: 'Cursor color' })).toBeNull();
    const dot = within(row).getByRole('button', { name: 'Change the cursor color for My Codex' });
    fireEvent.click(dot);
    expect(dot.getAttribute('aria-expanded')).toBe('true');
    const picker = within(row).getByRole('radiogroup', { name: 'Cursor color' });
    expect(within(picker).getByRole('radio', { name: 'Color #FF6B9A' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(picker).getByRole('radio', { name: 'Color #7AD3FF' }));
    expect(setConnectedAppColor).toHaveBeenCalledWith('abc', '#7AD3FF');
    // Pending: the row's controls are disabled until the save settles.
    await waitFor(() => expect((within(picker).getByRole('radio', { name: 'Automatic color' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(row).getByRole('combobox', { name: 'My Codex daily limit' }) as HTMLSelectElement).disabled).toBe(true);
    resolve({ app: { ...VIEW.apps[0], color: '#7AD3FF' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(within(row).queryByRole('radiogroup', { name: 'Cursor color' })).toBeNull();
  });

  it('shows a failed color change and keeps the picker open', async () => {
    // Round 3e: a refusal arrives as the API's typed error (apiRequest), not a plain Error,
    // whose own text no surface shows any more.
    setConnectedAppColor.mockRejectedValue(new RequestFailedError("Couldn't save the app color.", 422, { reason: 'color must be #RRGGBB or null' }));
    render(<ConnectedApps view={VIEW} loadError={null} onChanged={() => {}} />);
    const row = screen.getByTestId('settings-app-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Change the cursor color for My Codex' }));
    fireEvent.click(within(row).getByRole('radio', { name: 'Automatic color' }));
    expect(setConnectedAppColor).toHaveBeenCalledWith('abc', null);
    expect((await screen.findByRole('alert')).textContent).toContain('color must be #RRGGBB or null');
    expect(within(row).getByRole('radiogroup', { name: 'Cursor color' })).toBeTruthy();
  });
});
