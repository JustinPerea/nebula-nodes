import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModelPicker } from '../../src/components/create-studio/ModelPicker';
import { CreateComposer } from '../../src/components/create-studio/CreateComposer';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { getCreateModels } from '../../src/lib/createModels';

const KREA_IMAGE = 'krea-image-openai-gpt-image-2';
const KREA_VIDEO = 'krea-video-kling-kling-3-0';

function modelName(id: string) {
  const model = NODE_DEFINITIONS[id];
  expect(model, `Missing catalog model ${id}`).toBeDefined();
  return `${model.displayName}, ${model.category}, ${model.apiProvider}`;
}

function modelRow(id: string) {
  return screen.getByRole('button', { name: modelName(id) });
}

describe('Create model picker provider filter', () => {
  it('defaults to all providers and retains featured model selection', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ModelPicker value="nano-banana" onSelect={onSelect} onClose={onClose} />);
    expect(screen.getByRole('combobox', { name: 'Model provider' })).toHaveValue('');
    expect(screen.getByRole('option', { name: 'All providers' })).toBeInTheDocument();
    expect(modelRow('nano-banana')).toHaveAttribute('aria-pressed', 'true');
    expect(modelRow('krea-2-generate')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows original and gateway Krea image/video models together without other providers', () => {
    render(<ModelPicker value={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model provider' }), { target: { value: 'krea' } });
    expect(modelRow('krea-2-generate')).toBeInTheDocument();
    expect(modelRow(KREA_IMAGE)).toBeInTheDocument();
    expect(modelRow(KREA_VIDEO)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: modelName('nano-banana') })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(getCreateModels().filter((model) => model.apiProvider === 'krea').length);
  });

  it('combines search with provider filtering and retains the query when switching providers', () => {
    render(<ModelPicker value={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    const provider = screen.getByRole('combobox', { name: 'Model provider' });
    const search = screen.getByRole('textbox', { name: 'Search models' });
    fireEvent.change(provider, { target: { value: 'krea' } });
    fireEvent.change(search, { target: { value: 'GPT Image' } });
    expect(modelRow(KREA_IMAGE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Kling.*video-gen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: modelName('gpt-image-1-generate') })).not.toBeInTheDocument();
    fireEvent.change(provider, { target: { value: 'openai' } });
    expect(search).toHaveValue('GPT Image');
    expect(modelRow('gpt-image-1-generate')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\(Krea\)/ })).not.toBeInTheDocument();
  });

  it('preserves selected gateway models and closes after choosing the exact definition', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ModelPicker value={KREA_VIDEO} onSelect={onSelect} onClose={onClose} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model provider' }), { target: { value: 'krea' } });
    expect(modelRow(KREA_VIDEO)).toHaveAttribute('aria-pressed', 'true');
    expect(modelRow(KREA_IMAGE)).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(modelRow(KREA_IMAGE));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(KREA_IMAGE);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('labels an empty filtered search without losing its provider choice', () => {
    render(<ModelPicker value={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model provider' }), { target: { value: 'krea' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'does-not-match-any-model' } });
    expect(screen.getByRole('status')).toHaveTextContent('No models match this search and provider.');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'Model provider' })).toHaveValue('krea');
  });

  it('keeps Escape closing behavior while the provider control has focus', () => {
    const onClose = vi.fn();
    render(<ModelPicker value={null} onSelect={vi.fn()} onClose={onClose} />);
    const provider = screen.getByRole('combobox', { name: 'Model provider' });
    provider.focus();
    fireEvent.keyDown(provider, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('handles Escape once from search and isolates it from the workspace', () => {
    const onClose = vi.fn();
    const workspaceEscape = vi.fn();
    document.addEventListener('keydown', workspaceEscape);
    render(<ModelPicker value={null} onSelect={vi.fn()} onClose={onClose} />);
    const search = screen.getByRole('textbox', { name: 'Search models' });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(workspaceEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', workspaceEscape);
  });

  it('keeps keyboard focus in the picker and returns to its opener on dismissal', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<ModelPicker value={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    const search = screen.getByRole('textbox', { name: 'Search models' });
    const rows = screen.getAllByRole('button');
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });
    expect(rows.at(-1)).toHaveFocus();
    fireEvent.keyDown(rows.at(-1)!, { key: 'Tab' });
    expect(search).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('closes on the outside surface without treating filter interactions as dismissal', () => {
    const onClose = vi.fn();
    render(<ModelPicker value={null} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Model provider' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes filtered Krea selection from the actual Create composer without starting generation', () => {
    const onSelectModel = vi.fn();
    const onGenerate = vi.fn();
    render(<CreateComposer modelDef={null} prompt="Logo animation" params={{}} activeCount={0} maxConcurrent={2} quantity={1}
      onPromptChange={vi.fn()} onSelectModel={onSelectModel} onParamsChange={vi.fn()} onGenerate={onGenerate}
      onAttach={vi.fn()} onQuantityChange={vi.fn()} onOpenStyles={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select model' }));
    expect(screen.getByRole('dialog', { name: 'Choose a model' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model provider' }), { target: { value: 'krea' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'Kling' } });
    fireEvent.click(modelRow(KREA_VIDEO));
    expect(onSelectModel).toHaveBeenCalledWith(KREA_VIDEO);
    expect(screen.queryByRole('dialog', { name: 'Choose a model' })).not.toBeInTheDocument();
    expect(onGenerate).not.toHaveBeenCalled();
  });
});
