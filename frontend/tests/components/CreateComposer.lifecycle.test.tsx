import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateComposer } from '../../src/components/create-studio/CreateComposer';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { enhancePrompt } from '../../src/lib/enhancePrompt';

vi.mock('../../src/components/create-studio/ParamPills', () => ({ ParamPills: () => null }));
vi.mock('../../src/lib/enhancePrompt', () => ({ enhancePrompt: vi.fn() }));

function composer(onGenerate: () => void, activeCount = 0, isLaunching = false, modelId = 'nano-banana') {
  return <CreateComposer modelDef={NODE_DEFINITIONS[modelId]} prompt="Synthetic prompt" params={{}}
    activeCount={activeCount} maxConcurrent={2} isLaunching={isLaunching} quantity={1}
    onGenerate={onGenerate} onPromptChange={vi.fn()} onSelectModel={vi.fn()} onParamsChange={vi.fn()}
    onAttach={vi.fn()} onQuantityChange={vi.fn()} onOpenStyles={vi.fn()} />;
}

describe('Create composer launch intent', () => {
  it('explains unsupported prefilled models and blocks both button and keyboard launches', () => {
    const generate = vi.fn();
    const view = render(composer(generate, 0, false, 'runway-aleph'));
    expect(view.getByRole('note')).toHaveTextContent('This model needs Canvas input controls');
    const button = view.getByRole('button', { name: 'Generate' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    fireEvent.keyDown(view.getByPlaceholderText('Describe what you want to create…'), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(view.getByPlaceholderText('Describe what you want to create…'), { key: 'Enter', ctrlKey: true });
    expect(generate).not.toHaveBeenCalled();
  });

  it('ignores repeated shortcut events and the second click of a double-click while allowing a fresh second job', () => {
    const generate = vi.fn();
    const view = render(composer(generate, 1));
    const prompt = view.getByPlaceholderText('Describe what you want to create…');
    const button = view.getByRole('button', { name: 'Generating… (1)' });
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true, repeat: true });
    fireEvent.click(button, { detail: 2 });
    expect(generate).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    fireEvent.click(button, { detail: 1 });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('blocks button and shortcut launches while authoring or both shared slots are active', () => {
    const generate = vi.fn();
    const view = render(composer(generate, 1, true));
    const prompt = view.getByPlaceholderText('Describe what you want to create…');
    fireEvent.click(view.getByRole('button', { name: 'Generating… (1)' }));
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
    view.rerender(composer(generate, 2));
    fireEvent.click(view.getByRole('button', { name: 'Generating… (2)' }));
    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['Uploading references…', 'Retry, attach again or remove failed references to generate.'])('blocks button and shortcut until references resolve: %s', (referenceStatus) => {
    const generate = vi.fn();
    const base = composer(generate);
    const view = render(<CreateComposer {...base.props} referencesBlocked referenceStatus={referenceStatus} />);
    expect(view.getByRole('status')).toHaveTextContent(referenceStatus);
    expect(view.getByRole('button', { name: 'Generate' })).toBeDisabled();
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    fireEvent.keyDown(view.getByPlaceholderText('Describe what you want to create…'), { key: 'Enter', metaKey: true });
    expect(generate).not.toHaveBeenCalled();
    view.rerender(<CreateComposer {...base.props} referencesBlocked={false} />);
    expect(generate).not.toHaveBeenCalled();
    fireEvent.keyDown(view.getByPlaceholderText('Describe what you want to create…'), { key: 'Enter', ctrlKey: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(['edit', 'unmount'] as const)('does not apply a late prompt enhancement after %s', async (action) => {
    let finish!: (value: string) => void;
    vi.mocked(enhancePrompt).mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
    const base = composer(vi.fn());
    const changed = vi.fn();
    const view = render(<CreateComposer {...base.props} onPromptChange={changed} />);
    fireEvent.click(view.getByRole('button', { name: 'Enhance' }));
    if (action === 'edit') view.rerender(<CreateComposer {...base.props} prompt="A newer draft edit" onPromptChange={changed} />);
    else view.unmount();
    await act(async () => { finish('Enhanced old prompt'); });
    expect(changed).not.toHaveBeenCalled();
  });
});
