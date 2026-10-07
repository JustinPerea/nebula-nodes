import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ParamPills } from '../../src/components/create-studio/ParamPills';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../../src/types';

const GPT_IMAGE = NODE_DEFINITIONS['krea-image-openai-gpt-image-2'];

function ControlledPills({
  def = GPT_IMAGE,
  initial = {},
  onChange,
}: {
  def?: ModelNodeDefinition;
  initial?: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [params, setParams] = useState(initial);
  return <ParamPills def={def} params={params} onChange={(next) => {
    setParams(next);
    onChange(next);
  }} />;
}

describe('Create parameter values', () => {
  it('shows unset optional Krea dimensions as blank without writing a value', () => {
    const onChange = vi.fn();
    render(<ControlledPills onChange={onChange} />);
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(null);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('omits a cleared optional number and keeps unrelated parameters', () => {
    const onChange = vi.fn();
    render(<ControlledPills initial={{ width: 1024, quality: 'high' }} onChange={onChange} />);
    const width = screen.getByRole('spinbutton', { name: 'Width' });
    fireEvent.change(width, { target: { value: '' } });
    expect(width).toHaveValue(null);
    expect(onChange).toHaveBeenLastCalledWith({ quality: 'high' });
    fireEvent.change(width, { target: { value: '1536' } });
    expect(onChange).toHaveBeenLastCalledWith({ width: 1536, quality: 'high' });
  });

  it('keeps required Krea numbers blank until entered and leaves a cleared value for validation', () => {
    const onChange = vi.fn();
    render(<ControlledPills def={NODE_DEFINITIONS['krea-image-bfl-flux-1-1-pro']} onChange={onChange} />);
    const width = screen.getByRole('spinbutton', { name: 'Width' });
    expect(width).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(null);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(width, { target: { value: '1024' } });
    expect(onChange).toHaveBeenLastCalledWith({ width: 1024 });
    fireEvent.change(width, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ width: '' });
    expect(width).toHaveValue(null);
  });

  it('offers provider Default for optional enums without a schema default and omits a cleared choice', () => {
    const onChange = vi.fn();
    render(<ControlledPills initial={{ quality: 'high' }} onChange={onChange} />);
    const aspect = screen.getByRole('combobox', { name: 'Aspect ratio' });
    expect(aspect).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Resolution' })).toHaveValue('');
    fireEvent.change(aspect, { target: { value: '1:1' } });
    expect(onChange).toHaveBeenLastCalledWith({ quality: 'high', aspect_ratio: '1:1' });
    fireEvent.change(aspect, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ quality: 'high' });
    expect(aspect).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Quality' })).toHaveValue('high');
  });

  it('preserves numeric Krea enum values when duration changes', () => {
    const onChange = vi.fn();
    render(<ControlledPills def={NODE_DEFINITIONS['krea-video-kling-kling-2-5']} onChange={onChange} />);
    const duration = screen.getByRole('combobox', { name: 'Duration' });
    expect(duration).toHaveValue('5');
    fireEvent.change(duration, { target: { value: '10' } });
    expect(onChange).toHaveBeenLastCalledWith({ duration: 10 });
  });

  it('cycles an optional boolean with no default through Default, On, Off, and omission', () => {
    const onChange = vi.fn();
    render(<ControlledPills def={NODE_DEFINITIONS['krea-video-bytedance-seedance-2']}
      initial={{ prompt: 'Orbit the logo' }} onChange={onChange} />);
    const audio = screen.getByRole('button', { name: 'Generate audio: Default' });
    expect(audio).toHaveAttribute('aria-pressed', 'mixed');
    fireEvent.click(audio);
    expect(audio).toHaveTextContent('Generate audio: On');
    expect(onChange).toHaveBeenLastCalledWith({ prompt: 'Orbit the logo', generate_audio: true });
    fireEvent.click(audio);
    expect(audio).toHaveTextContent('Generate audio: Off');
    expect(onChange).toHaveBeenLastCalledWith({ prompt: 'Orbit the logo', generate_audio: false });
    fireEvent.click(audio);
    expect(audio).toHaveTextContent('Generate audio: Default');
    expect(onChange).toHaveBeenLastCalledWith({ prompt: 'Orbit the logo' });
  });

  it('keeps booleans with actual defaults as ordinary toggles', () => {
    const onChange = vi.fn();
    render(<ControlledPills def={NODE_DEFINITIONS['krea-video-kling-kling-3-0']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate audio: Off' }));
    expect(onChange).toHaveBeenLastCalledWith({ generate_audio: true });
  });

  it('preserves an existing explicit empty enum choice without an extra Default option', () => {
    const onChange = vi.fn();
    render(<ControlledPills def={NODE_DEFINITIONS['pixverse-v4-5']}
      initial={{ style: 'anime' }} onChange={onChange} />);
    const style = screen.getByRole('combobox', { name: 'Style' });
    expect(style.querySelectorAll('option[value=""]')).toHaveLength(1);
    expect(style.querySelector('option[value=""]')).toHaveTextContent('None');
    fireEvent.change(style, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ style: '' });
  });

  it('keeps actual numeric defaults and explicit required enum choices', () => {
    const onChange = vi.fn();
    const def = {
      ...GPT_IMAGE,
      params: [
        { key: 'required_count', label: 'Required count', type: 'integer' as const, required: true, min: 1 },
        { key: 'default_count', label: 'Default count', type: 'integer' as const, required: false, default: 4 },
        { key: 'required_choice', label: 'Required choice', type: 'enum' as const, required: true,
          options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] },
      ],
    };
    render(<ControlledPills def={def} initial={{ required_count: 2, default_count: 6 }} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Required count' }), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ required_count: '', default_count: 6 });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Default count' }), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ required_count: '', default_count: 4 });
    expect(screen.getByRole('combobox', { name: 'Required choice' })).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Choose…' })).toBeInTheDocument();
  });
});
