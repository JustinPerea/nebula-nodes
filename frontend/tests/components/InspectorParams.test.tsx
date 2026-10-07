import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Inspector } from '../../src/components/panels/Inspector';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
});

afterEach(() => {
  cleanup();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
});

function renderModel(definitionId: string, params: Record<string, unknown> = {}) {
  useGraphStore.setState({
    nodes: [{ id: 'test-krea', position: { x: 0, y: 0 },
      data: { definitionId, label: 'Krea test', params, outputs: {}, state: 'idle' } }],
    edges: [],
  });
  useUIStore.setState({ selectedNodeId: 'test-krea' });
  render(<Inspector embedded />);
}

function currentParams() {
  return useGraphStore.getState().nodes[0].data.params;
}

describe('Canvas inspector enum controls', () => {
  it('writes original numeric Krea duration choices and preserves the default', () => {
    renderModel('krea-video-kling-kling-2-5', { prompt: 'Orbit the logo' });
    const duration = screen.getByRole('combobox', { name: 'Duration' });
    expect(duration).toHaveValue('5');
    expect(duration.querySelector('option[value=""]')).toBeNull();
    fireEvent.change(duration, { target: { value: '10' } });
    expect(currentParams()).toEqual({ prompt: 'Orbit the logo', duration: 10 });
  });

  it('shows Default for unset optional enums and removes a cleared choice', () => {
    renderModel('krea-image-openai-gpt-image-2', { prompt: 'A wordmark' });
    const aspect = screen.getByRole('combobox', { name: 'Aspect ratio' });
    expect(aspect).toHaveValue('');
    expect(aspect.querySelector('option[value=""]')).toHaveTextContent('Default');
    fireEvent.change(aspect, { target: { value: '1:1' } });
    expect(currentParams()).toEqual({ prompt: 'A wordmark', aspect_ratio: '1:1' });
    fireEvent.change(aspect, { target: { value: '' } });
    expect(currentParams()).toEqual({ prompt: 'A wordmark' });
    expect(aspect).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Quality' })).toHaveValue('high');
  });

  it('shows Choose for required enums with no default until a choice is saved', () => {
    renderModel('krea-image-krea-krea-2-medium', { prompt: 'A wordmark' });
    const aspect = screen.getByRole('combobox', { name: 'Aspect ratio' });
    expect(aspect).toHaveValue('');
    expect(aspect.querySelector('option[value=""]')).toHaveTextContent('Choose…');
    expect(currentParams()).not.toHaveProperty('aspect_ratio');
    fireEvent.change(aspect, { target: { value: '1:1' } });
    expect(currentParams()).toEqual({ prompt: 'A wordmark', aspect_ratio: '1:1' });
  });

  it('represents optional booleans without defaults as Default, On, or Off', () => {
    renderModel('krea-video-bytedance-seedance-2', { prompt: 'Orbit the logo' });
    const audio = screen.getByRole('combobox', { name: 'Generate audio' });
    expect(audio).toHaveValue('');
    fireEvent.change(audio, { target: { value: 'true' } });
    expect(currentParams()).toEqual({ prompt: 'Orbit the logo', generate_audio: true });
    fireEvent.change(audio, { target: { value: 'false' } });
    expect(currentParams()).toEqual({ prompt: 'Orbit the logo', generate_audio: false });
    fireEvent.change(audio, { target: { value: '' } });
    expect(currentParams()).toEqual({ prompt: 'Orbit the logo' });
  });

  it('keeps actual boolean defaults as checkboxes', () => {
    renderModel('krea-video-kling-kling-3-0');
    const audio = screen.getByRole('checkbox', { name: 'Generate audio' });
    expect(audio).not.toBeChecked();
    fireEvent.click(audio);
    expect(currentParams()).toEqual({ generate_audio: true });
  });

  it('preserves an explicit empty enum value such as PixVerse None', () => {
    renderModel('pixverse-v4-5', { style: 'anime' });
    const style = screen.getByRole('combobox', { name: 'Style' });
    expect(style.querySelectorAll('option[value=""]')).toHaveLength(1);
    expect(style.querySelector('option[value=""]')).toHaveTextContent('None');
    fireEvent.change(style, { target: { value: '' } });
    expect(currentParams()).toEqual({ style: '' });
  });
});
