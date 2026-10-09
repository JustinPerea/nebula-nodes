import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelCatalog } from '../../src/lib/api';
import { ChatModelPicker, type ChatModelPickerProps } from '../../src/components/panels/ChatModelPicker';

const catalog: ChatModelCatalog = {
  agent: 'claude', status: 'ready', auth: { mode: 'claudeai' },
  catalog: { source: 'installed-cli', runtimeVersion: 'test', fetchedAt: '2026-10-09T12:00:00Z' },
  models: [
    { id: 'sonnet', label: 'Sonnet', description: 'Everyday work', isDefault: true, defaultEffort: 'medium',
      supportedEfforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] },
    { id: 'opus', label: 'Opus', isDefault: false, defaultEffort: 'high',
      supportedEfforts: [{ id: 'high', label: 'High' }, { id: 'max', label: 'Max', description: 'Most thinking' }] },
  ],
};

function props(overrides: Partial<ChatModelPickerProps> = {}): ChatModelPickerProps {
  return {
    agent: 'claude', model: null, effort: null, catalog, loading: false, error: null, disabled: false,
    onAgentChange: vi.fn(), onModelChange: vi.fn(), onEffortChange: vi.fn(), onRetry: vi.fn(), ...overrides,
  };
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' }));
  return screen.getByRole('dialog', { name: 'Chat model settings' });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ChatModelPicker', () => {
  it('shows the discovered default model and effort without persisting a guessed selection', () => {
    const state = props();
    render(<ChatModelPicker {...state} />);
    const trigger = screen.getByRole('button', { name: 'Choose chat model' });
    expect(trigger).toHaveTextContent('Sonnet');
    expect(trigger).toHaveTextContent('Medium · default');
    open();
    expect(screen.getByRole('radio', { name: 'Sonnet' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'CLI default' })).toBeChecked();
    expect(state.onModelChange).not.toHaveBeenCalled();
    expect(state.onEffortChange).not.toHaveBeenCalled();
  });

  it('Escape dismisses only the picker and restores its trigger focus', () => {
    const ancestorEscape = vi.fn();
    render(<div onKeyDown={ancestorEscape}><ChatModelPicker {...props()} /></div>);
    const dialog = open();
    expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose chat model' })).toHaveFocus();
    expect(ancestorEscape).not.toHaveBeenCalled();
  });

  it('keeps Tab and reverse Tab within the picker controls', () => {
    render(<ChatModelPicker {...props()} />);
    const dialog = open();
    const first = screen.getByRole('button', { name: 'Close chat model settings' });
    const last = screen.getByRole('radio', { name: 'CLI default' });
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    expect(dialog).toBeInTheDocument();
  });

  it('traps the selected effort rather than unchecked later radio choices', () => {
    render(<ChatModelPicker {...props({ effort: 'medium' })} />);
    open();
    const selectedEffort = screen.getByRole('radio', { name: 'Medium' });
    const first = screen.getByRole('button', { name: 'Close chat model settings' });
    selectedEffort.focus();
    fireEvent.keyDown(selectedEffort, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(selectedEffort).toHaveFocus();
  });

  it('chooses the exact catalog model and leaves effort selection open', () => {
    const state = props();
    const view = render(<ChatModelPicker {...state} />);
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Opus' }));
    expect(state.onModelChange).toHaveBeenCalledExactlyOnceWith('opus');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(<ChatModelPicker {...state} model="opus" />);
    expect(screen.getByRole('radio', { name: 'Opus' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Max' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Medium' })).not.toBeInTheDocument();
    expect(state.onEffortChange).not.toHaveBeenCalled();
  });

  it('emits offered effort IDs and null for CLI default, without sending or fetching', () => {
    const state = props({ model: 'opus' });
    const view = render(<ChatModelPicker {...state} />);
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Max' }));
    expect(state.onEffortChange).toHaveBeenCalledExactlyOnceWith('max');
    view.rerender(<ChatModelPicker {...state} effort="max" />);
    fireEvent.click(screen.getByRole('radio', { name: 'CLI default' }));
    expect(state.onEffortChange).toHaveBeenLastCalledWith(null);
    expect(state.onModelChange).not.toHaveBeenCalled();
    expect(state.onRetry).not.toHaveBeenCalled();
    expect(state.onAgentChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('switches providers explicitly and never shows the previous provider catalog', () => {
    const state = props();
    const view = render(<ChatModelPicker {...state} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(state.onAgentChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(state.onAgentChange).toHaveBeenCalledExactlyOnceWith('codex');
    view.rerender(<ChatModelPicker {...state} agent="codex" />);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Model catalog is unavailable');
    expect(screen.getByText('Uses your existing Codex connection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Codex' })).toHaveFocus();
  });

  it('shows loading rather than cached choices while model discovery is pending', () => {
    const state = props({ loading: true });
    render(<ChatModelPicker {...state} />);
    const dialog = open();
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading models…');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry model discovery' })).not.toBeInTheDocument();
    expect(state.onRetry).not.toHaveBeenCalled();
  });

  it.each([
    ['not_installed', 'Claude Code is not installed.'],
    ['not_authenticated', 'Sign in to Claude Code, then retry.'],
    ['unavailable', 'Model catalog is unavailable.'],
  ] as const)('offers explicit retry for %s without fabricated models', (status, message) => {
    const state = props({ catalog: { ...catalog, status } });
    render(<ChatModelPicker {...state} />);
    open();
    expect(screen.getByRole('status')).toHaveTextContent(message);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry model discovery' }));
    expect(state.onRetry).toHaveBeenCalledOnce();
    expect(state.onModelChange).not.toHaveBeenCalled();
  });

  it('reports discovery errors and empty catalogs instead of creating fallback choices', () => {
    const state = props({ error: 'Local model discovery timed out' });
    const view = render(<ChatModelPicker {...state} />);
    open();
    expect(screen.getByRole('status')).toHaveTextContent('Local model discovery timed out');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    view.rerender(<ChatModelPicker {...state} error={null} catalog={{ ...catalog, models: [] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('No models are available from this CLI');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('requires explicit replacement of a removed saved model or unsupported saved effort', () => {
    const state = props({ model: 'removed-model', effort: 'removed-effort' });
    const view = render(<ChatModelPicker {...state} />);
    open();
    expect(screen.getByRole('status')).toHaveTextContent('Saved model is unavailable');
    expect(screen.getByRole('radio', { name: 'Sonnet' })).not.toBeChecked();
    expect(screen.queryByRole('group', { name: 'Thinking effort' })).not.toBeInTheDocument();
    view.rerender(<ChatModelPicker {...state} model="sonnet" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved thinking effort is unavailable');
    expect(screen.getByRole('radio', { name: 'CLI default' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'High' })).not.toBeChecked();
    expect(state.onModelChange).not.toHaveBeenCalled();
    expect(state.onEffortChange).not.toHaveBeenCalled();
  });

  it('disables opening while busy, closes an open picker, and does not reopen after work finishes', () => {
    const state = props({ disabled: true });
    const view = render(<ChatModelPicker {...state} />);
    const trigger = screen.getByRole('button', { name: 'Choose chat model' });
    fireEvent.click(trigger);
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<ChatModelPicker {...state} disabled={false} />);
    open();
    view.rerender(<ChatModelPicker {...state} disabled />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<ChatModelPicker {...state} disabled={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state.onAgentChange).not.toHaveBeenCalled();
    expect(state.onModelChange).not.toHaveBeenCalled();
  });

  it('dismisses on outside interaction while preserving focus on the external control', () => {
    render(<><ChatModelPicker {...props()} /><button>Another control</button></>);
    const dialog = open();
    fireEvent.pointerDown(within(dialog).getByRole('radio', { name: 'High' }));
    expect(dialog).toBeInTheDocument();
    const external = screen.getByRole('button', { name: 'Another control' });
    external.focus();
    fireEvent.pointerDown(external);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(external).toHaveFocus();
  });

  it('distinguishes a ChatGPT connection from an API-billed Codex connection', () => {
    const state = props({ agent: 'codex', catalog: { ...catalog, agent: 'codex', auth: { mode: 'chatgpt', planType: 'plus' } } });
    const view = render(<ChatModelPicker {...state} />);
    open();
    expect(screen.getByText('Connected to ChatGPT')).toBeInTheDocument();
    view.rerender(<ChatModelPicker {...state} catalog={{ ...catalog, agent: 'codex', auth: { mode: 'api_key' } }} />);
    expect(screen.getByText('Using API billing')).toBeInTheDocument();
    expect(screen.queryByText(/Connected to ChatGPT/)).not.toBeInTheDocument();
  });
  it.each(['bedrock', 'vertex', 'foundry', 'bearer_token'])('shows billing separately from subscription login for %s', (mode) => {
    render(<ChatModelPicker {...props({ catalog: { ...catalog, auth: { mode, planType: 'max' } } })} />);
    open();
    expect(screen.getByText(mode === 'bearer_token' ? 'Using API billing' : 'Using provider billing')).toBeInTheDocument();
    expect(screen.queryByText(/Local CLI connection ready| · max/)).not.toBeInTheDocument();
  });

});
