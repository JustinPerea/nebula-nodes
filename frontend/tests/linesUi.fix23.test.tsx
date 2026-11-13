/**
 * PR #199 round 23, lane C (review 21 lines-ui).
 * - LOW-1: a live region is painted empty before its text arrives. The text
 *   comes from the second animation frame after the commit; a change or an
 *   unmount cancels a pending set.
 * - GM r36 4: the unlock's tooltip is GM's sentence, built from nothing.
 */
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnnounced } from '../src/lib/useAnnounced';
import { UNLOCK_TITLE } from '../src/lib/worldLabsWaiting';
import { frames } from './helpers/frames';

function Probe({ text }: { text: string | null }) {
  const shown = useAnnounced(text);
  return <p data-testid="p">{shown}</p>;
}

describe('review 21 LOW-1: useAnnounced paints the region empty first', () => {
  const clock = frames();
  beforeEach(() => clock.install());
  afterEach(() => clock.uninstall());

  it('the text is still empty after the commit and after the first frame; it arrives on the second', () => {
    const { container } = render(<Probe text="Line" />);
    expect(container.textContent).toBe('');
    clock.step();
    expect(container.textContent).toBe('');
    clock.step();
    expect(container.textContent).toBe('Line');
    expect(clock.pending()).toBe(0);
  });

  it('a change before the frames cancels the pending set: the old line never shows', () => {
    const { container, rerender } = render(<Probe text="First" />);
    clock.step();
    rerender(<Probe text="Second" />);
    expect(clock.pending()).toBe(1);
    clock.step();
    expect(container.textContent).toBe('');
    clock.step();
    expect(container.textContent).toBe('Second');
  });

  it('a change after the old line shows leaves it until the new one arrives, then swaps', () => {
    const { container, rerender } = render(<Probe text="First" />);
    clock.flush();
    rerender(<Probe text="Second" />);
    expect(container.textContent).toBe('First');
    clock.flush();
    expect(container.textContent).toBe('Second');
  });

  it('no line empties the region at once and queues nothing', () => {
    const { container, rerender } = render(<Probe text="First" />);
    clock.flush();
    rerender(<Probe text={null} />);
    expect(container.textContent).toBe('');
    expect(clock.pending()).toBe(0);
  });

  it('an unmount cancels both frames', () => {
    const first = render(<Probe text="Line" />);
    expect(clock.pending()).toBe(1);
    first.unmount();
    expect(clock.pending()).toBe(0);
    const second = render(<Probe text="Line" />);
    clock.step();
    expect(clock.pending()).toBe(1);
    second.unmount();
    expect(clock.pending()).toBe(0);
  });
});

describe('GM r36 4: the unlock’s tooltip', () => {
  it('is GM’s sentence, curly, and is not built from the word unlock', () => {
    expect(UNLOCK_TITLE).toBe('Press this only after you’ve checked the run in Marble.');
    expect(UNLOCK_TITLE).not.toMatch(/unlock/i);
  });
});
