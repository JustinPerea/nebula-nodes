import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreateComposer } from '../../src/components/create-studio/CreateComposer';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { useUIStore } from '../../src/store/uiStore';

const initialUi = useUIStore.getState();
afterEach(() => { cleanup(); useUIStore.setState(initialUi, true); });

function composer(params: Record<string, unknown>) {
  return <CreateComposer modelDef={NODE_DEFINITIONS['krea-image-openai-gpt-image-2']}
    prompt="a logo" params={params} activeCount={0} maxConcurrent={2} quantity={1}
    onPromptChange={vi.fn()} onSelectModel={vi.fn()} onParamsChange={vi.fn()}
    onGenerate={vi.fn()} onAttach={vi.fn()} onQuantityChange={vi.fn()} onOpenStyles={vi.fn()} />;
}

describe('Create Krea connection control', () => {
  it('opens connection settings from Create without changing workspace or recipe state', () => {
    useUIStore.setState({ viewMode: 'create', settingsCache: { apiKeys: {}, loaded: true,
      kreaConnection: { status: 'needs_auth' } } });
    const element = composer({ _kreaAuth: 'mcp' });
    render(element);
    expect(screen.getByText('Krea sign-in required')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings for GPT Image 2 (Krea)' }));
    expect(useUIStore.getState().panels.settings.visible).toBe(true);
    expect(useUIStore.getState().viewMode).toBe('create');
    expect(useUIStore.getState().settingsProviderTarget).toEqual({ kind: 'krea-mcp' });
    expect(element.props.params).toEqual({ _kreaAuth: 'mcp' });
    expect(element.props.onGenerate).not.toHaveBeenCalled();
  });

  it('does not show OAuth readiness warnings for an API recipe or a connected MCP recipe', () => {
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true,
      kreaConnection: { status: 'connected' } } });
    const { rerender } = render(composer({ _kreaAuth: 'mcp' }));
    expect(screen.queryByText('Krea sign-in required')).not.toBeInTheDocument();
    expect(screen.getByText('Krea signed in')).toBeInTheDocument();
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true,
      kreaConnection: { status: 'disconnected' } } });
    rerender(composer({}));
    expect(screen.queryByText('Krea sign-in required')).not.toBeInTheDocument();
    expect(screen.getByText('Setup required')).toBeInTheDocument();
  });
});
