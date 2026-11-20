import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PromptDialog } from '../src/components/commons/CommonsPrompt';

afterEach(() => cleanup());

describe('the Commons prompt hint', () => {
  it('splits "Why?" (the short caps label) from its hint, which sits outside the caps label in normal text', () => {
    render(<PromptDialog request={{ label: 'Why?', initial: '', hint: 'Optional. It helps the next reading.', resolve: () => {} }} onDone={() => {}} />);
    const field = document.querySelector('.commons-field')!;
    expect(field.textContent).toBe('Why?');
    const hint = document.querySelector('.commons-meta')!;
    expect(hint.textContent).toBe('Optional. It helps the next reading.');
    expect(field.contains(hint)).toBe(false);
    expect(field.querySelector('input')).toHaveAttribute('aria-describedby', hint.id);
  });
  it('has no hint element and no describedby without one', () => {
    render(<PromptDialog request={{ label: 'Rename region', initial: 'a', resolve: () => {} }} onDone={() => {}} />);
    expect(document.querySelector('.commons-meta')).toBeNull();
    expect(document.querySelector('input')).not.toHaveAttribute('aria-describedby');
  });
});
