import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Inspector } from '../../src/components/panels/Inspector';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
  // The character node's picker lists saved characters.
  fetchCharacters: vi.fn(async () => []),
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

describe('Inspector maker size note', () => {
  const ideogramKeys = { IDEOGRAM_API_KEY: 'fixture-only', KREA_API_TOKEN: 'fixture-only' };
  function withKeys(apiKeys: Record<string, string>) {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys } });
  }

  it('says what Ideogram makes when the maker route runs and the size changes', () => {
    withKeys(ideogramKeys);
    renderModel('krea-image-ideogram-ideogram-3', { _kreaAuth: 'api-token', width: 1000, height: 560 });
    expect(screen.getByText('Ideogram makes 1312x736, the closest it can get to your 1000x560.')).toBeVisible();
  });

  it.each([
    // The maker can make it: nothing to say.
    [ideogramKeys, { _kreaAuth: 'api-token', width: 1280, height: 768 }],
    // The Krea copy runs it: how Krea sizes it isn't known, so nothing is claimed.
    [{ KREA_API_TOKEN: 'fixture-only' }, { _kreaAuth: 'api-token', width: 1000, height: 560 }],
    // The Krea plan is the person's choice, whatever keys are set.
    [ideogramKeys, { _kreaAuth: 'mcp', width: 1000, height: 560 }],
  ])('shows no size note with %o and %o', (apiKeys, params) => {
    withKeys(apiKeys);
    renderModel('krea-image-ideogram-ideogram-3', params);
    expect(screen.queryByText(/closest it can get/)).toBeNull();
  });

  it('shows no size note when a wired style image keeps the run on Krea', () => {
    withKeys(ideogramKeys);
    useGraphStore.setState({
      nodes: [
        { id: 'test-krea', position: { x: 0, y: 0 },
          data: { definitionId: 'krea-image-ideogram-ideogram-3', label: 'Krea test',
            params: { _kreaAuth: 'api-token', width: 1000, height: 560 }, outputs: {}, state: 'idle' } },
        { id: 'style', position: { x: -200, y: 0 },
          data: { definitionId: 'image-input', label: 'Style', params: {}, outputs: {}, state: 'idle' } },
      ],
      edges: [{ id: 'e-style', source: 'style', sourceHandle: 'image', target: 'test-krea', targetHandle: 'style_images' }],
    });
    useUIStore.setState({ selectedNodeId: 'test-krea' });
    render(<Inspector embedded />);
    expect(screen.queryByText(/closest it can get/)).toBeNull();
  });

  it.each([
    // BytePlus runs it with a start image: the aspect ratio isn't used.
    [{ BYTEPLUS_API_KEY: 'fixture-only', KREA_API_TOKEN: 'fixture-only' }, true],
    // The Krea copy runs it: nothing is claimed.
    [{ KREA_API_TOKEN: 'fixture-only' }, false],
  ])('says when Seedance 2.5 keeps the start image shape with %o', (apiKeys, shown) => {
    withKeys(apiKeys);
    renderModel('krea-video-bytedance-seedance-2-5',
      { _kreaAuth: 'api-token', start_image: 'https://example.com/start.png', aspect_ratio: '9:16' });
    const note = "BytePlus makes this video in your start image's shape: Seedance 2.5 doesn't use the 9:16 aspect ratio when it starts from an image.";
    if (shown) expect(screen.getByText(note)).toBeVisible();
    else expect(screen.queryByText(note)).toBeNull();
  });

  it('shows what the last run said', () => {
    withKeys(ideogramKeys);
    useGraphStore.setState({
      nodes: [{ id: 'test-krea', position: { x: 0, y: 0 },
        data: { definitionId: 'krea-image-ideogram-ideogram-3', label: 'Krea test', params: { width: 1000, height: 560 },
          outputs: {}, state: 'complete', runNotes: ['Ideogram made 1312x736, the closest it could get to your 1000x560.'] } }],
      edges: [],
    });
    useUIStore.setState({ selectedNodeId: 'test-krea' });
    render(<Inspector embedded />);
    expect(screen.getByText('Last run')).toBeVisible();
    expect(screen.getByText('Ideogram made 1312x736, the closest it could get to your 1000x560.')).toBeVisible();
  });
});

describe('Canvas inspector enum controls', () => {
  it('uses the default Seedream model for capability visibility and hides 5 Lite seed', () => {
    renderModel('seedream-4-5');
    expect(screen.getByRole('spinbutton', { name: 'Seed' })).toBeVisible();
    const size = screen.getByRole('combobox', { name: 'Size' });
    expect(size.querySelector('option[value="auto_3K"]')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: '5.0-lite' } });
    expect(screen.queryByRole('spinbutton', { name: 'Seed' })).toBeNull();
    expect(size.querySelector('option[value="auto_3K"]')).toHaveTextContent('Auto 3K');
    fireEvent.change(size, { target: { value: 'auto_3K' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: '4.5' } });
    expect(size).toHaveValue('auto_3K');
    expect(size.querySelector('option[value="auto_3K"]')).toHaveTextContent('Auto 3K (unavailable for selected model)');
    expect(size.querySelector('option[value="auto_3K"]')).toBeDisabled();
    expect(currentParams()).toEqual({ model: '4.5', image_size: 'auto_3K' });
    fireEvent.change(size, { target: { value: 'square_hd' } });
    expect(currentParams()).toEqual({ model: '4.5', image_size: 'square_hd' });
  });

  it.each([
    ['character', 'strength_override', 'Strength Override'],
    ['identity-edit', 'identity_strength', 'Identity Strength'],
  ])('preserves the unavailable strength value for %s', (definitionId, key, label) => {
    renderModel(definitionId, { [key]: 0.37 });
    const control = screen.getByRole('textbox', { name: label });
    expect(control).toBeDisabled();
    expect(control).toHaveValue('0.37');
    expect(screen.getByText(/Unavailable:.*without.*strength control/)).toBeVisible();
    fireEvent.change(control, { target: { value: '0.9' } });
    expect(currentParams()).toEqual({ [key]: 0.37 });
  });

  it.each([
    [{ _kreaAuth: 'api-token' }, { GOOGLE_API_KEY: 'fixture-only', KREA_API_TOKEN: 'fixture-only' }, false],
    [{ _kreaAuth: 'api-token' }, { KREA_API_TOKEN: 'fixture-only' }, true],
    // The Krea plan is the person's choice: a Google key never takes it over.
    [{ _kreaAuth: 'mcp' }, { GOOGLE_API_KEY: 'fixture-only' }, true],
  ])('shows Krea-only sizing on a Krea copy only when Krea runs it (%o, %o)', (params, apiKeys, kreaFields) => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys } });
    renderModel('krea-image-google-nano-banana-pro', params);
    expect(screen.queryByLabelText('Width') !== null).toBe(kreaFields);
    expect(screen.getByRole('combobox', { name: 'Resolution' })).toBeVisible();
  });

  it('keeps Krea-only sizing visible when a saved size keeps the run on Krea', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true,
      apiKeys: { GOOGLE_API_KEY: 'fixture-only', KREA_API_TOKEN: 'fixture-only' } } });
    renderModel('krea-image-google-nano-banana-pro', { _kreaAuth: 'api-token', width: 1920, height: 1080 });
    expect(screen.getByLabelText('Width')).toBeVisible();
  });

  it('shows the Krea params when a Krea-only input arrives by wire, as the run goes to Krea', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true,
      apiKeys: { BYTEPLUS_API_KEY: 'fixture-only', KREA_API_TOKEN: 'fixture-only' } } });
    renderModel('krea-image-bytedance-seedream-4', { _kreaAuth: 'api-token', width: 2048, height: 2048 });
    // On BytePlus: Krea's seed isn't a BytePlus field, so it is hidden.
    expect(screen.queryByLabelText('Seed')).toBeNull();
    cleanup();
    useGraphStore.setState({ edges: [{ id: 'e', source: 'refs', target: 'test-krea', sourceHandle: 'images',
      targetHandle: 'style_images' }] });
    render(<Inspector embedded />);
    // Wired style images keep the run on Krea (directRoute.blockedBy), so Krea's own params show.
    expect(screen.getByLabelText('Seed')).toBeVisible();
  });

  it('lets an Ideogram key opt a reframe saved without a resolution into the direct route', () => {
    // An agent-made node (no seeded defaults) with only the Ideogram key: the
    // run needs `resolution` to go direct, so it shows unset until picked.
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true,
      apiKeys: { IDEOGRAM_API_KEY: 'fixture-only' } } });
    renderModel('ideogram-reframe', {});
    const resolution = screen.getByRole('combobox', { name: 'Target Resolution' });
    expect(resolution).toHaveValue('');
    expect(resolution.querySelector('option[value=""]')).toHaveTextContent('Choose…');
    expect(screen.getByRole('combobox', { name: 'Target Size' })).toBeVisible();
    fireEvent.change(resolution, { target: { value: '1024x1024' } });
    expect(currentParams()).toEqual({ resolution: '1024x1024' });
    // Now the direct route runs it: fal's sizing goes away.
    expect(screen.queryByRole('combobox', { name: 'Target Size' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Target Resolution' })).toHaveValue('1024x1024');
  });

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

describe('Inspector per-model Max Tokens', () => {
  function model() {
    return screen.getByRole('combobox', { name: 'Model' });
  }
  function maxTokens() {
    return document.querySelector('[data-inspector-param="max_tokens"] input') as HTMLInputElement;
  }

  it('moves an untouched Max Tokens with the model and notes it under the field', () => {
    renderModel('claude-chat', { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, temperature: 1 });
    fireEvent.change(model(), { target: { value: 'claude-opus-5-5' } });
    expect(currentParams()).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 64000 });
    expect(maxTokens()).toHaveValue(64000);
    expect(document.querySelector('[data-inspector-param="max_tokens"] [data-inspector-default-note]'))
      .toHaveTextContent('Max Tokens moved to 64,000, the Claude Opus 5.5 default.');
    fireEvent.change(model(), { target: { value: 'claude-haiku-4-5-20251001' } });
    expect(currentParams()).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096 });
    expect(screen.getByText('Max Tokens moved to 4,096, the Claude Haiku 4.5 default.')).toBeVisible();
  });

  it('shows the model\'s default when the node stores no Max Tokens (an agent-made node)', () => {
    renderModel('claude-chat', { model: 'claude-haiku-4-5-20251001' });
    expect(maxTokens()).toHaveValue(4096);
  });

  it('keeps an edited Max Tokens and says what the new default is', () => {
    renderModel('gemini-chat', { model: 'gemini-3.6-flash', max_tokens: 12000 });
    fireEvent.change(model(), { target: { value: 'gemini-4-argon' } });
    expect(currentParams()).toMatchObject({ model: 'gemini-4-argon', max_tokens: 12000 });
    expect(screen.getByText('Max Tokens stays at 12,000, the value you set. The Gemini 4 Argon default is 65,536.')).toBeVisible();
    // The note is about that change; the next edit clears it.
    fireEvent.change(maxTokens(), { target: { value: '30000' } });
    expect(screen.queryByText(/Gemini 4 Argon default/)).toBeNull();
  });
});
