import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Lightbox } from '../../src/components/create-studio/Lightbox';
import type { ViewableMedia } from '../../src/lib/createGallery';

const items: ViewableMedia[] = [
  { url: '/api/outputs/a.png', kind: 'image' },
  { url: '/api/outputs/b.mp4', kind: 'video' },
];

afterEach(() => {
  document.body.classList.remove('lightbox-open');
});

describe('Lightbox', () => {
  it('renders the current image and a counter', () => {
    render(<Lightbox items={items} index={0} onClose={() => {}} onIndexChange={() => {}} />);
    const img = document.querySelector('.lightbox__media') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('/api/outputs/a.png');
    expect(document.querySelector('.lightbox__counter')?.textContent).toBe('1 / 2');
  });

  it('renders a <video> for a video item', () => {
    render(<Lightbox items={items} index={1} onClose={() => {}} onIndexChange={() => {}} />);
    expect(document.querySelector('video.lightbox__media')).not.toBeNull();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<Lightbox items={items} index={0} onClose={onClose} onIndexChange={() => {}} />);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates with ArrowRight / the next button and hides prev at the first item', () => {
    const onIndexChange = vi.fn();
    render(<Lightbox items={items} index={0} onClose={() => {}} onIndexChange={onIndexChange} />);
    expect(document.querySelector('.lightbox__nav--prev')).toBeNull(); // no prev at index 0
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(document.querySelector('.lightbox__nav--next')!);
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  it('closes on backdrop click but not when clicking the media stage', () => {
    const onClose = vi.fn();
    render(<Lightbox items={items} index={0} onClose={onClose} onIndexChange={() => {}} />);
    fireEvent.click(document.querySelector('.lightbox__stage')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.lightbox')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks body scroll while open and restores on unmount', () => {
    const { unmount } = render(<Lightbox items={items} index={0} onClose={() => {}} onIndexChange={() => {}} />);
    expect(document.body.classList.contains('lightbox-open')).toBe(true);
    unmount();
    expect(document.body.classList.contains('lightbox-open')).toBe(false);
  });

  it('takes focus, traps Tab in both directions, and restores its opener on close', () => {
    const opener = document.createElement('button');
    opener.textContent = 'View result';
    document.body.appendChild(opener);
    opener.focus();
    const view = render(<Lightbox items={items} index={0} onClose={() => {}} onIndexChange={() => {}} />);
    const close = view.getByRole('button', { name: 'Close (Esc)' });
    const next = view.getByRole('button', { name: 'Next' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: 'Tab' });
    expect(close).toHaveFocus();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('closes only once from the close button', () => {
    const onClose = vi.fn();
    const view = render(<Lightbox items={items} index={0} onClose={onClose} onIndexChange={() => {}} />);
    fireEvent.click(view.getByRole('button', { name: 'Close (Esc)' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps focus inside when navigation removes the focused boundary button', () => {
    const view = render(<Lightbox items={items} index={0} onClose={() => {}} onIndexChange={() => {}} />);
    view.getByRole('button', { name: 'Next' }).focus();
    view.rerender(<Lightbox items={items} index={1} onClose={() => {}} onIndexChange={() => {}} />);
    expect(view.getByRole('button', { name: 'Close (Esc)' })).toHaveFocus();
  });

  it('includes the video player in the Tab loop and preserves its native arrow keys', () => {
    const onIndexChange = vi.fn();
    const view = render(<Lightbox items={items} index={1} onClose={() => {}} onIndexChange={onIndexChange} />);
    const video = document.querySelector('video.lightbox__media') as HTMLVideoElement;
    video.focus();
    fireEvent.keyDown(video, { key: 'ArrowLeft' });
    expect(onIndexChange).not.toHaveBeenCalled();
    fireEvent.keyDown(video, { key: 'Tab' });
    expect(view.getByRole('button', { name: 'Close (Esc)' })).toHaveFocus();
  });

  it('ignores arrow keys originating outside the dialog', () => {
    const onIndexChange = vi.fn();
    render(<Lightbox items={items} index={0} onClose={() => {}} onIndexChange={onIndexChange} />);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('does not lock scroll or take focus when there is no media', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = render(<Lightbox items={[]} index={0} onClose={() => {}} onIndexChange={() => {}} />);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(document.body.classList.contains('lightbox-open')).toBe(false);
    view.unmount();
    opener.remove();
  });
});
