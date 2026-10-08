import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CinemaShotsRail } from '../../src/components/cinema-studio/CinemaShotsRail';
import { useGraphStore } from '../../src/store/graphStore';
import type { CinemaSceneSpec, CinemaShot } from '../../src/types';

const initialGraph = { ...useGraphStore.getState() };
const select = vi.fn();
const remove = vi.fn();
const reorder = vi.fn();
const add = vi.fn();
const executeNode = vi.fn();
const executeShot = vi.fn();
const scrollIntoView = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

function shots(): CinemaShot[] {
  return [
    { id: 'a', prompt: 'First', output: { status: 'done', imageUrl: '/first.png' } },
    { id: 'b', prompt: 'Second', variations: [{ url: '/second.png', seed: 7 }], selectedVariation: 0 },
    { id: 'c', prompt: 'Third' },
  ];
}

function Rail({ initialShots = shots(), initialSelected = 'a' }: { initialShots?: CinemaShot[]; initialSelected?: string }) {
  const [currentShots, setShots] = useState(initialShots);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const scene: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: currentShots };
  return <CinemaShotsRail cinemaNodeId="scene" scene={scene} selectedShotId={selected}
    onSelect={(id) => { select(id); setSelected(id); }} onAddShot={add}
    onReorder={(ordered) => { reorder(ordered); setShots(ordered); }}
    onRemoveShot={(id) => {
      remove(id);
      const index = currentShots.findIndex((shot) => shot.id === id);
      if (selected === id) setSelected((currentShots[index + 1] ?? currentShots[index - 1])?.id ?? null);
      setShots(currentShots.filter((shot) => shot.id !== id));
    }} />;
}

describe('Cinema shot rail keyboard contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    useGraphStore.setState({ ...initialGraph, activeRuns: [], executeNode, executeShot }, true);
  });
  afterEach(() => {
    useGraphStore.setState(initialGraph, true);
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  it('uses native selection buttons with separate destructive controls and one selection tab stop', () => {
    render(<Rail />);
    const first = screen.getByRole('button', { name: 'Select Shot 1' });
    const second = screen.getByRole('button', { name: 'Select Shot 2' });
    expect(first.tagName).toBe('BUTTON');
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveAttribute('tabindex', '0');
    expect(second).toHaveAttribute('tabindex', '-1');
    expect(first.querySelector('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Shot 1' }).parentElement).not.toBe(first);
    fireEvent.click(second);
    expect(select).toHaveBeenCalledExactlyOnceWith('b');
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(second).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('tabindex', '-1');
    expect(remove).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it('selects and focuses neighboring shots with arrows and bounds Home and End', () => {
    render(<Rail />);
    const first = screen.getByRole('button', { name: 'Select Shot 1' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const second = screen.getByRole('button', { name: 'Select Shot 2' });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(second, { key: 'End' });
    const third = screen.getByRole('button', { name: 'Select Shot 3' });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third, { key: 'ArrowDown' });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third, { key: 'Home' });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(first).toHaveFocus();
    expect(reorder).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it('leaves Enter and Space to native button activation and focus itself changes no selection', () => {
    render(<Rail />);
    const second = screen.getByRole('button', { name: 'Select Shot 2' });
    second.focus();
    fireEvent.keyDown(second, { key: 'Enter' });
    fireEvent.keyDown(second, { key: ' ' });
    // jsdom does not synthesize default native click activation; the selector
    // deliberately has no custom keyboard click that could double-activate.
    expect(select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(second);
    expect(select).toHaveBeenCalledExactlyOnceWith('b');
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it('moves the selected stable shot ID by Alt+arrow and keeps its DOM focus and results', () => {
    const original = shots();
    render(<Rail initialShots={original} initialSelected="b" />);
    const selected = screen.getByRole('button', { name: 'Select Shot 2' });
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowLeft', altKey: true });
    expect(reorder).toHaveBeenLastCalledWith([original[1], original[0], original[2]]);
    expect(screen.getByRole('button', { name: 'Select Shot 1' })).toBe(selected);
    expect(selected).toHaveFocus();
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(reorder.mock.calls[0][0][0]).toBe(original[1]);
    fireEvent.keyDown(selected, { key: 'ArrowRight', altKey: true });
    expect(reorder).toHaveBeenLastCalledWith(original);
    expect(screen.getByRole('button', { name: 'Select Shot 2' })).toBe(selected);
    expect(selected).toHaveFocus();
    expect(select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it('provides explicit move buttons with truthful boundaries and selection focus after reorder', () => {
    render(<Rail />);
    const selected = screen.getByRole('button', { name: 'Select Shot 1' });
    expect(screen.getByRole('button', { name: 'Move Shot 1 earlier' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Shot 1 later' }));
    expect(screen.getByRole('button', { name: 'Select Shot 2' })).toBe(selected);
    expect(selected).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Move Shot 2 later' }));
    expect(screen.getByRole('button', { name: 'Move Shot 3 later' })).toBeDisabled();
    expect(selected).toHaveFocus();
    expect(select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey'] as const)('leaves Alt plus %s arrow shortcuts outside rail ownership', (extraModifier) => {
    render(<Rail initialSelected="b" />);
    const selected = screen.getByRole('button', { name: 'Select Shot 2' });
    selected.focus();
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      const nativeEvent = new KeyboardEvent('keydown', { key, altKey: true, [extraModifier]: true, bubbles: true, cancelable: true });
      fireEvent(selected, nativeEvent);
      expect(nativeEvent.defaultPrevented).toBe(false);
    }
    expect(selected).toHaveFocus();
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(reorder).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it('keeps pointer drag reorder and clears a cancelled drag before a later drop', () => {
    const original = shots();
    render(<Rail initialShots={original} />);
    const firstCard = screen.getByRole('button', { name: 'Select Shot 1' }).parentElement!;
    const thirdCard = screen.getByRole('button', { name: 'Select Shot 3' }).parentElement!;
    fireEvent.dragStart(firstCard);
    fireEvent.dragEnd(firstCard);
    fireEvent.drop(thirdCard);
    expect(reorder).not.toHaveBeenCalled();
    fireEvent.dragStart(firstCard);
    fireEvent.dragOver(thirdCard);
    fireEvent.drop(thirdCard);
    expect(reorder).toHaveBeenCalledExactlyOnceWith([original[1], original[2], original[0]]);
    expect(remove).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('moves focus to a surviving neighbor on selected deletion and Add shot on final deletion', () => {
    render(<Rail initialShots={shots().slice(0, 2)} initialSelected="b" />);
    const deleteSecond = screen.getByRole('button', { name: 'Remove Shot 2' });
    deleteSecond.focus();
    fireEvent.click(deleteSecond);
    const first = screen.getByRole('button', { name: 'Select Shot 1' });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Shot 1' }));
    expect(screen.getByRole('button', { name: '+ Add shot' })).toHaveFocus();
    expect(remove.mock.calls).toEqual([['b'], ['a']]);
    expect(select).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('scrolls a changed selection into view and gives an empty rail a working Add button', () => {
    const view = render(<Rail />);
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Select Shot 3' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    view.unmount();
    render(<Rail initialShots={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add shot' }));
    expect(add).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledExactlyOnceWith('c');
  });

  it('keeps the editor scroll position during authoring/output updates and scrolls only selection or order changes', () => {
    const initialShots = shots();
    const initialScene: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: initialShots };
    const renderRail = (scene: CinemaSceneSpec, selectedShotId: string) => <CinemaShotsRail cinemaNodeId="scene"
      scene={scene} selectedShotId={selectedShotId} onSelect={select} onAddShot={add} onRemoveShot={remove} onReorder={reorder} />;
    const view = render(renderRail(initialScene, 'a'));
    scrollIntoView.mockClear();
    const editedScene: CinemaSceneSpec = { ...initialScene, look: { preset: 'bw-tri-x' },
      shots: [{ ...initialShots[0], prompt: 'Typing the next character', overrides: { palette: { strength: 0.2 } },
        output: { status: 'done', imageUrl: '/new-output.png' } }, ...initialShots.slice(1)] };
    view.rerender(renderRail(editedScene, 'a'));
    expect(scrollIntoView).not.toHaveBeenCalled();
    view.rerender(renderRail(editedScene, 'b'));
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' });
    scrollIntoView.mockClear();
    view.rerender(renderRail({ ...editedScene, shots: [...editedScene.shots].reverse() }, 'b'));
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' });
    expect(select).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });
});
