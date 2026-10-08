import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { VideoPreview } from '../../src/components/editor/VideoPreview';
import { WorkspaceHeader } from '../../src/components/WorkspaceHeader';
import { useUIStore } from '../../src/store/uiStore';
import type { NodeData } from '../../src/types';

const INITIAL_UI = useUIStore.getState();
const togglePlaying = vi.fn();
const edit: Node<NodeData> = { id: 'synthetic-edit', position: { x: 0, y: 0 }, data: {
  label: 'Synthetic edit', definitionId: 'video-edit', state: 'idle', outputs: {}, params: { clips: [] },
} };
beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ ...INITIAL_UI, isPlaying: false, renderedPreviewUrl: null, togglePlaying }, true);
});
afterEach(() => { cleanup(); useUIStore.setState(INITIAL_UI, true); });

describe('Video editor Space ownership', () => {
  it('toggles the virtual preview once for bare Space outside controls, then removes its listener', () => {
    const view = render(<><VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} /><div data-testid="surface" /></>);
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    fireEvent(screen.getByTestId('surface'), event);
    expect(togglePlaying).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    view.unmount();
    fireEvent.keyDown(window, { key: ' ' });
    expect(togglePlaying).toHaveBeenCalledTimes(1);
  });

  it.each([
    { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
  ])('leaves repeated or modified Space alone: %j', (modifiers) => {
    render(<VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} />);
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...modifiers });
    fireEvent(document.body, event);
    expect(togglePlaying).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('respects a nearer handler that already prevented Space', () => {
    render(<><VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} />
      <div data-testid="owned-surface" onKeyDown={(event) => event.preventDefault()} /></>);
    fireEvent.keyDown(screen.getByTestId('owned-surface'), { key: ' ' });
    expect(togglePlaying).not.toHaveBeenCalled();
  });

  it('leaves Space on the shared Back button and its nested icon available for native activation', () => {
    const onBack = vi.fn();
    render(<><WorkspaceHeader title="Video editor" onBack={onBack} />
      <VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} /></>);
    const back = screen.getByRole('button', { name: 'Back to Canvas' });
    for (const target of [back, back.querySelector('svg')!]) {
      const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(togglePlaying).not.toHaveBeenCalled();
    // JSDOM has no native Space-to-click synthesis; the click verifies that the
    // shared button's action remains wired after its default is left available.
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('preserves native typing, links, disclosures, custom controls and rendered media Space', () => {
    useUIStore.setState({ renderedPreviewUrl: '/synthetic-render.mp4' });
    const view = render(<><VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} />
      <input aria-label="Input" /><textarea aria-label="Prompt" /><select aria-label="Preset"><option>One</option></select>
      <a href="#synthetic">Link</a><details><summary>Settings</summary></details>
      <div contentEditable suppressContentEditableWarning data-testid="editable"><span>Editable child</span></div>
      <div role="button" tabIndex={0}>Custom button</div><div role="slider" tabIndex={0}>Slider</div>
    </>);
    const targets = [screen.getByRole('textbox', { name: 'Input' }), screen.getByRole('textbox', { name: 'Prompt' }),
      screen.getByRole('combobox'), screen.getByRole('link'), screen.getByText('Settings'),
      screen.getByText('Editable child'), screen.getByRole('button', { name: 'Custom button' }),
      screen.getByRole('slider'), view.container.querySelector('video[controls]')!];
    for (const target of targets) {
      const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(togglePlaying).not.toHaveBeenCalled();
  });
});
