import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { AutoGrowTextarea } from './AutoGrowTextarea';

// JSDOM lays nothing out: give the textarea a scrollHeight that follows its text.
const LINE = 16;
function fakeLayout(element: HTMLTextAreaElement) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true, get: () => Math.max(2, element.value.split('\n').length) * LINE,
  });
}

function Notes({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <AutoGrowTextarea aria-label="Notes" rows={2} value={value} style={{ maxHeight: `${LINE * 5}px` }}
      onChange={(event) => setValue(event.target.value)} />
  );
}

describe('AutoGrowTextarea', () => {
  it('grows with its text, then stops at max-height and scrolls', () => {
    render(<Notes initial="one" />);
    const textarea = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fakeLayout(textarea);
    fireEvent.change(textarea, { target: { value: 'one\ntwo\nthree' } });
    expect(textarea.style.height).toBe(`${LINE * 3}px`);
    expect(textarea.style.overflowY).toBe('hidden');

    fireEvent.change(textarea, { target: { value: 'a\nb\nc\nd\ne\nf\ng\nh' } });
    expect(textarea.style.height).toBe(`${LINE * 5}px`);
    expect(textarea.style.overflowY).toBe('auto');

    fireEvent.change(textarea, { target: { value: 'short' } });
    expect(textarea.style.height).toBe(`${LINE * 2}px`);
    expect(textarea.style.overflowY).toBe('hidden');
  });
});
