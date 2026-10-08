import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultComparison, type ComparisonResult } from '../../src/components/create-studio/ResultComparison';
import type { ResultContext } from '../../src/lib/resultContext';

function context(index: number): ResultContext {
  return {
    key: `run-${index}:n${index}`,
    modelName: `Saved model ${index}`,
    definitionId: 'nano-banana',
    prompt: `The complete prompt for result ${index}, including the precise composition and color choice.`,
    timestamp: Date.UTC(2026, 9, 8, 12, index),
    provenance: 'saved-run',
    params: { aspect_ratio: '1:1', seed: 17 + index },
    refs: ['/api/outputs/synthetic-logo.png'],
    runId: `run-${index}`,
    reusableDraft: { modelId: 'nano-banana', prompt: `Saved prompt ${index}`, params: { aspect_ratio: '1:1', seed: 17 + index }, refs: [{ filePath: '/api/outputs/synthetic-logo.png', previewUrl: '/api/outputs/synthetic-logo.png' }], quantity: 1 },
  };
}

function pair(kind: 'image' | 'video' = 'image'): [ComparisonResult, ComparisonResult] {
  return [1, 2].map((index) => ({
    key: `run-${index}:n${index}`,
    nodeId: `n${index}`,
    media: { url: `/api/outputs/synthetic-${index}.${kind === 'image' ? 'png' : 'mp4'}`, kind },
    context: context(index),
  })) as [ComparisonResult, ComparisonResult];
}

let workspace: HTMLDivElement;
let opener: HTMLButtonElement;
let fallback: HTMLButtonElement;
let priorInert: HTMLDivElement;

beforeEach(() => {
  workspace = document.createElement('div');
  opener = document.createElement('button');
  opener.textContent = 'Compare these results';
  fallback = document.createElement('button');
  fallback.textContent = 'Gallery';
  fallback.dataset.resultComparisonFallback = '';
  workspace.append(opener, fallback);
  document.body.append(workspace);
  priorInert = document.createElement('div');
  priorInert.setAttribute('inert', 'already-inert');
  priorInert.setAttribute('aria-hidden', 'true');
  document.body.append(priorInert);
  opener.focus();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  workspace.remove();
  priorInert.remove();
  document.body.classList.remove('result-comparison-open');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Closable({ items = pair(), onReuseSettings }: { items?: [ComparisonResult, ComparisonResult]; onReuseSettings?: (recipe: ResultContext) => void }) {
  const [open, setOpen] = useState(true);
  return open ? <ResultComparison items={items} onClose={() => setOpen(false)} onReuseSettings={onReuseSettings} /> : null;
}

describe('pinned result comparison', () => {
  it('labels both media and retains the full saved recipes and recorded time', () => {
    render(<ResultComparison items={pair()} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Compare results' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('region', { name: 'First result' })).toHaveTextContent('Saved model 1');
    expect(within(dialog).getByRole('region', { name: 'Second result' })).toHaveTextContent('Saved model 2');
    expect(within(dialog).getByRole('img', { name: 'First result' })).toHaveAttribute('src', '/api/outputs/synthetic-1.png');
    expect(within(dialog).getByRole('img', { name: 'Second result' })).toHaveAttribute('src', '/api/outputs/synthetic-2.png');
    expect(within(dialog).getAllByText('Saved recipe')).toHaveLength(2);
    const firstDetails = dialog.querySelector('details')!;
    firstDetails.setAttribute('open', '');
    expect(firstDetails).toHaveTextContent(context(1).prompt);
    expect(firstDetails).toHaveTextContent('1 recorded reference');
    expect(firstDetails).toHaveTextContent('/api/outputs/synthetic-logo.png');
    expect(firstDetails).toHaveTextContent('Run run-1');
    expect(dialog.querySelector('time')).toHaveAttribute('dateTime', new Date(context(1).timestamp!).toISOString());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the chosen output and recipe pinned if the source props change during comparison', () => {
    const items = pair();
    const view = render(<ResultComparison items={items} onClose={() => {}} />);
    items[0].media.url = '/api/outputs/later-generation.png';
    items[0].context.prompt = 'A later edited prompt';
    items[0].context.params.seed = 999;
    view.rerender(<ResultComparison items={items} onClose={() => {}} />);
    expect(screen.getByRole('img', { name: 'First result' })).toHaveAttribute('src', '/api/outputs/synthetic-1.png');
    const firstDetails = screen.getByRole('region', { name: 'First result' }).querySelector('details')!;
    firstDetails.setAttribute('open', '');
    expect(firstDetails).toHaveTextContent(context(1).prompt);
    expect(firstDetails).not.toHaveTextContent('A later edited prompt');
    expect(firstDetails).not.toHaveTextContent('999');
  });

  it('closes before reusing only the chosen recipe without making any requests', () => {
    const events: string[] = [];
    const items = pair();
    const onReuseSettings = vi.fn(() => { events.push('reuse'); });
    render(<ResultComparison items={items} onClose={() => { events.push('close'); }} onReuseSettings={onReuseSettings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reuse settings from second result' }));
    expect(events).toEqual(['close', 'reuse']);
    expect(onReuseSettings).toHaveBeenCalledExactlyOnceWith(items[1].context);
    expect(items[1].context.reusableDraft?.quantity).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explains an unrecorded output and does not offer unsupported recipe reuse', () => {
    const items = pair();
    delete items[0].context.reusableDraft;
    delete items[0].context.timestamp;
    delete items[0].context.runId;
    items[0].context.provenance = 'unrecorded';
    items[0].context.reuseUnavailableReason = 'The original inputs were not recorded.';
    render(<ResultComparison items={items} onClose={() => {}} onReuseSettings={vi.fn()} />);
    const first = screen.getByRole('region', { name: 'First result' });
    const details = first.querySelector('details')!;
    details.setAttribute('open', '');
    expect(first).toHaveTextContent('Current settings · recipe not recorded');
    expect(first).toHaveTextContent('The original inputs were not recorded.');
    expect(first.querySelector('time')).toBeNull();
    expect(within(first).queryByRole('button', { name: /Reuse settings/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reuse settings from second result' })).toBeInTheDocument();
  });

  it('shows both video players with native controls and never starts autoplay', () => {
    render(<ResultComparison items={pair('video')} onClose={() => {}} />);
    const videos = document.querySelectorAll<HTMLVideoElement>('.result-comparison video');
    expect(videos).toHaveLength(2);
    videos.forEach((video) => {
      expect(video).toHaveAttribute('controls');
      expect(video).toHaveAttribute('playsInline');
      expect(video).not.toHaveAttribute('autoPlay');
      expect(video).not.toHaveAttribute('loop');
    });
    videos[0].focus();
    const nativeArrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    fireEvent(videos[0], nativeArrow);
    expect(nativeArrow.defaultPrevented).toBe(false);
    expect(videos[0]).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('comparison modal ownership', () => {
  it('takes focus, includes video and recipe disclosures in the Tab loop, and restores its opener', () => {
    const view = render(<ResultComparison items={pair('video')} onClose={() => {}} onReuseSettings={vi.fn()} />);
    const close = screen.getByRole('button', { name: 'Close comparison' });
    const last = screen.getByRole('button', { name: 'Reuse settings from second result' });
    expect(close).toHaveFocus();
    expect(workspace).toHaveAttribute('inert');
    expect(workspace).toHaveAttribute('aria-hidden', 'true');
    expect(document.body.classList.contains('result-comparison-open')).toBe(true);
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.querySelector('video')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getAllByText('Saved recipe')[0]).toHaveFocus();
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();
    view.unmount();
    expect(opener).toHaveFocus();
    expect(workspace).not.toHaveAttribute('inert');
    expect(workspace).not.toHaveAttribute('aria-hidden');
    expect(priorInert).toHaveAttribute('inert', 'already-inert');
    expect(priorInert).toHaveAttribute('aria-hidden', 'true');
    expect(document.body.classList.contains('result-comparison-open')).toBe(false);
  });

  it('contains outside focus and workspace shortcuts, and captures Escape once after focus loss', () => {
    const backgroundKey = vi.fn();
    document.addEventListener('keydown', backgroundKey);
    const close = vi.fn();
    const view = render(<ResultComparison items={pair()} onClose={close} />);
    const closeButton = screen.getByRole('button', { name: 'Close comparison' });
    opener.focus();
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: 'Enter', ctrlKey: true });
    const shortcut = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    fireEvent(document.body, shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(backgroundKey).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(backgroundKey).not.toHaveBeenCalled();
    view.unmount();
    document.removeEventListener('keydown', backgroundKey);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('restores a stable gallery control when the original opener has been removed', () => {
    render(<Closable />);
    opener.remove();
    fireEvent.click(screen.getByRole('button', { name: 'Close comparison' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fallback).toHaveFocus();
    expect(workspace).not.toHaveAttribute('inert');
  });

  it('isolates a newly mounted background portal and restores its exact prior accessibility state', async () => {
    render(<Closable />);
    const laterPortal = document.createElement('div');
    laterPortal.setAttribute('aria-hidden', 'false');
    const otherButton = document.createElement('button');
    laterPortal.append(otherButton);
    document.body.append(laterPortal);
    try {
      await waitFor(() => expect(laterPortal).toHaveAttribute('inert'));
      expect(laterPortal).toHaveAttribute('aria-hidden', 'true');
      otherButton.focus();
      expect(screen.getByRole('button', { name: 'Close comparison' })).toHaveFocus();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(laterPortal).not.toHaveAttribute('inert');
      expect(laterPortal).toHaveAttribute('aria-hidden', 'false');
      expect(opener).toHaveFocus();
    } finally { laterPortal.remove(); }
  });

  it('prevents backdrop focus loss and dismisses only an actual backdrop click', () => {
    const close = vi.fn();
    render(<ResultComparison items={pair()} onClose={close} />);
    const backdrop = document.querySelector('.result-comparison')!;
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    fireEvent(backdrop, pointer);
    expect(pointer.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('dialog'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
