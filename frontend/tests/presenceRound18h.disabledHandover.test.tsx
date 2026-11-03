/**
 * PR #204 round 18h (review 16 MEDIUM-1, GM r38 2 and 3e): going offline disables a focused
 * control in place. Chrome's focus fixup then drops focus to <body>, and the handover used to act
 * only when the control left the page. Now a control that is disabled, or sits under [inert],
 * counts as gone: focus goes to the heading at once, and on reconnect, while focus is still where
 * the hook put it, back to that very control. jsdom has no focus fixup, so these tests blur the
 * disabled field by hand, as Chrome would.
 *
 * Review 16 LOW-2: focus never waits on <body> for a line that may come; the heading holds it.
 */
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { focusGone, useFocusHandover } from '../src/hooks/useFocusHandover';

afterEach(cleanup);

function Pane({ offline, inert = false, removed = false, line = false }: { offline: boolean; inert?: boolean; removed?: boolean; line?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const handover = useFocusHandover({ offline, inert, removed, line }, () => root.current,
    () => root.current?.querySelector<HTMLElement>('h2') ?? null);
  return (
    <div ref={root} onFocus={handover.onFocus}>
      <h2 tabIndex={-1}>Settings</h2>
      <div inert={inert}>
        {!removed && <input aria-label="Folder path" disabled={offline} />}
      </div>
      {line && <p data-focus-line="" tabIndex={-1}>Couldn’t load Commons settings.</p>}
      <button type="button">Elsewhere</button>
    </div>
  );
}

const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
const heading = () => document.querySelector('h2');
const nextFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });

describe('a focused control disabled in place counts as gone', () => {
  it('focus goes to the heading at once, and back to the field on reconnect', () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline />);
    act(() => field().blur()); // Chrome's focus fixup
    // The effect ran in the same commit: the field was disabled, so focus is on the heading.
    expect(document.activeElement).toBe(heading());
    rerender(<Pane offline={false} />);
    expect(document.activeElement).toBe(field());
  });

  it('works without the blur too (jsdom keeps focus on a disabled field)', () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline />);
    expect(document.activeElement).toBe(heading());
  });

  it('no handback when the person moved focus meanwhile', () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline />);
    expect(document.activeElement).toBe(heading());
    const elsewhere = document.querySelector<HTMLButtonElement>('button')!;
    act(() => elsewhere.focus());
    rerender(<Pane offline={false} />);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a field under [inert] counts as gone, and comes back when the region does', () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline={false} inert />);
    expect(document.activeElement).toBe(heading());
    rerender(<Pane offline={false} />);
    expect(document.activeElement).toBe(field());
  });

  it('in place, the heading takes focus, not a line (the line is heard through its region)', () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline line />);
    expect(document.activeElement).toBe(heading());
  });

  it('a field still disabled after a later change keeps focus on the heading', () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline />);
    rerender(<Pane offline line />);
    expect(document.activeElement).toBe(heading());
    rerender(<Pane offline={false} line />);
    expect(document.activeElement).toBe(field());
  });

  it('focusGone: removed, disabled, inert; an enabled connected field is not gone', () => {
    const input = document.createElement('input');
    expect(focusGone(input)).toBe(true);
    document.body.append(input);
    expect(focusGone(input)).toBe(false);
    input.disabled = true;
    expect(focusGone(input)).toBe(true);
    input.disabled = false;
    const wrap = document.createElement('div');
    wrap.setAttribute('inert', '');
    wrap.append(input);
    document.body.append(wrap);
    expect(focusGone(input)).toBe(true);
    wrap.remove();
  });
});

describe('review 16 LOW-2: focus never waits on <body>', () => {
  it('a removed control with no line yet: the heading at once, then the line when it comes', async () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline={false} removed />);
    expect(document.activeElement).toBe(heading());
    rerender(<Pane offline={false} removed line />);
    await nextFrame();
    expect(document.activeElement).toBe(document.querySelector('[data-focus-line]'));
  });

  it('H5: the person moving off the waiting heading stops the wait, with no change to restart it', async () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline={false} removed />);
    expect(document.activeElement).toBe(heading());
    const elsewhere = document.querySelector<HTMLButtonElement>('button')!;
    act(() => elsewhere.focus());
    // A line arrives outside React, so the hook's wait (not a new change) is what would find it.
    const late = document.createElement('p');
    late.setAttribute('data-focus-line', '');
    late.tabIndex = -1;
    heading()!.parentElement!.append(late);
    await nextFrame();
    await nextFrame();
    expect(document.activeElement).toBe(elsewhere);
    late.remove();
  });

  it('the person moving focus off the waiting heading stops the wait', async () => {
    const { rerender } = render(<Pane offline={false} />);
    act(() => field().focus());
    rerender(<Pane offline={false} removed />);
    const elsewhere = document.querySelector<HTMLButtonElement>('button')!;
    act(() => elsewhere.focus());
    rerender(<Pane offline={false} removed line />);
    await nextFrame();
    expect(document.activeElement).toBe(elsewhere);
  });
});
