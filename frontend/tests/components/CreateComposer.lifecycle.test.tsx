import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateComposer } from '../../src/components/create-studio/CreateComposer';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';

vi.mock('../../src/components/create-studio/ParamPills', () => ({ ParamPills: () => null }));

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
});
