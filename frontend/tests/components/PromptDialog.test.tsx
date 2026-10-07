import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { usePrompt } from '../../src/hooks/usePrompt';

describe('shared text prompt lifecycle', () => {
  it('starts replacements from their own initial value even when label and initial are identical', async () => {
    let ask!: ReturnType<typeof usePrompt>[0];
    function Harness() {
      const [prompt, element] = usePrompt();
      useEffect(() => { ask = prompt; }, [prompt]);
      return element;
    }
    const view = render(<Harness />);
    let first!: Promise<string | null>;
    act(() => { first = ask('Name', 'Original'); });
    fireEvent.change(view.getByRole('textbox', { name: 'Name' }), { target: { value: 'Edited first' } });
    let replacement!: Promise<string | null>;
    await act(async () => {
      replacement = ask('Name', 'Original');
      expect(await first).toBeNull();
    });
    expect(view.getByRole('textbox', { name: 'Name' })).toHaveValue('Original');
    fireEvent.click(view.getByRole('button', { name: 'OK' }));
    expect(await replacement).toBe('Original');
  });

  it('keeps keyboard focus inside the dialog and returns it to the opener', async () => {
    function Harness() {
      const [ask, element] = usePrompt();
      return <><button onClick={() => void ask('Name')}>Open</button>{element}</>;
    }
    const view = render(<Harness />);
    const opener = view.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const input = view.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(view.getByRole('button', { name: 'OK' })).toHaveFocus();
    fireEvent.keyDown(view.getByRole('button', { name: 'OK' }), { key: 'Tab' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('resolves an abandoned prompt on unmount', async () => {
    let result!: Promise<string | null>;
    function Harness() {
      const [ask, element] = usePrompt();
      return <><button onClick={() => { result = ask('Name'); }}>Open</button>{element}</>;
    }
    const view = render(<Harness />);
    fireEvent.click(view.getByRole('button', { name: 'Open' }));
    view.unmount();
    expect(await result).toBeNull();
  });
});
