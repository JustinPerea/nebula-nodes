/**
 * PR #204 round 18l (review 17 MEDIUM-1): the focus-fixup helper, and the rule for where it must be
 * installed.
 *
 * Why not "every test that asserts activeElement after an async action": 78 test files assert
 * document.activeElement and 61 of them await something, most about canvas, menus and dialogs where
 * no control is disabled in place. Requiring the helper there adds noise without catching the bug
 * class. The bug class is a control disabled (or put under [inert]) while it holds focus, which in
 * this app happens in the Commons panes, the focus handover (useFocusHandover) and the Settings
 * sections that use it. So the rule: a test file that asserts document.activeElement and renders
 * from src/components/commons/, uses useFocusHandover, renders AgentSpendSection or
 * PersonalAgentsSection, or speaks of the focus fixup installs the helper. No file blurs by hand
 * "as Chrome would": the helper does it.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { fixupWouldBlur, installFocusFixup } from './helpers/focusFixup';

afterEach(cleanup);

const TESTS = __dirname;
const testFiles = readdirSync(TESTS).filter((name) => /\.test\.tsx?$/.test(name));
const source = (name: string) => readFileSync(join(TESTS, name), 'utf8');

/** Where a control can be disabled or made inert while it holds focus. */
const NEEDS_FIXUP = /src\/components\/commons\/|useFocusHandover|AgentSpendSection|PersonalAgentsSection|focus fixup/;
const ASSERTS_FOCUS = /document\.activeElement/;
const INSTALLS = /\b(?:withFocusFixup|installFocusFixup)\(/;
const BY_HAND = /\.blur\(\)\);?\s*\/\/[^\n]*(?:Chrome|fixup)/;

function Toggle({ inert = false }: { inert?: boolean }) {
  const [off, setOff] = useState(false);
  return <div inert={inert}><button type="button" disabled={off} onClick={() => setOff(true)}>Go</button></div>;
}

describe('the helper copies Chrome', () => {
  it('blurs a focused control once it is disabled (on the next microtask, like a frame)', async () => {
    const fixup = installFocusFixup();
    try {
      render(<Toggle />);
      const button = document.querySelector('button')!;
      act(() => button.focus());
      act(() => button.click());
      expect(button.disabled).toBe(true);
      await act(async () => { await Promise.resolve(); });
      expect(document.activeElement).toBe(document.body);
    } finally { fixup.disconnect(); }
  });

  it('flush() does it synchronously; under [inert] too', () => {
    const fixup = installFocusFixup();
    try {
      const { rerender } = render(<Toggle />);
      act(() => document.querySelector('button')!.focus());
      rerender(<Toggle inert />);
      expect(document.activeElement?.tagName).toBe('BUTTON');
      fixup.flush();
      expect(document.activeElement).toBe(document.body);
    } finally { fixup.disconnect(); }
  });

  it('leaves an enabled control alone, and does nothing once disconnected', async () => {
    const fixup = installFocusFixup();
    render(<Toggle />);
    const button = document.querySelector('button')!;
    act(() => button.focus());
    button.setAttribute('data-x', '1');
    fixup.flush();
    expect(document.activeElement).toBe(button);
    fixup.disconnect();
    act(() => button.click());
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(button);
  });

  it('fixupWouldBlur: disabled, inert ancestor; not body, not an enabled control', () => {
    const wrap = document.createElement('div');
    const button = document.createElement('button');
    wrap.append(button); document.body.append(wrap);
    expect(fixupWouldBlur(button)).toBe(false);
    expect(fixupWouldBlur(document.body)).toBe(false);
    expect(fixupWouldBlur(null)).toBe(false);
    wrap.setAttribute('inert', '');
    expect(fixupWouldBlur(button)).toBe(true);
    wrap.removeAttribute('inert');
    button.disabled = true;
    expect(fixupWouldBlur(button)).toBe(true);
    wrap.remove();
  });
});

describe('ratchet: focus tests where a control can be disabled in place install the fixup', () => {
  const covered = testFiles.filter((name) => name !== 'focusFixup.ratchet.test.tsx'
    && ASSERTS_FOCUS.test(source(name)) && NEEDS_FIXUP.test(source(name)));

  it('the rule finds the files it is about (the Commons close, the handover tests)', () => {
    expect(covered.length).toBeGreaterThanOrEqual(18);
    for (const name of ['commonsCopy.ratchet.test.tsx', 'commonsCloseBatch.test.tsx',
      'presenceRound18h.disabledHandover.test.tsx', 'presenceRound18h.settingsHandover.test.tsx']) {
      expect(covered).toContain(name);
    }
  });

  it('each installs the helper', () => {
    expect(covered.filter((name) => !INSTALLS.test(source(name)))).toEqual([]);
  });

  it('no test blurs by hand as Chrome would', () => {
    expect(testFiles.filter((name) => name !== 'focusFixup.ratchet.test.tsx' && BY_HAND.test(source(name)))).toEqual([]);
  });

  it('the patterns catch what they are for', () => {
    expect(BY_HAND.test("act(() => field().blur()); // Chrome's focus fixup")).toBe(true);
    expect(BY_HAND.test('act(() => toggle.blur()); // as the fixup would')).toBe(true);
    expect(BY_HAND.test('act(() => toggle.blur());')).toBe(false);
    expect(INSTALLS.test('withFocusFixup();')).toBe(true);
    expect(INSTALLS.test("import { withFocusFixup } from './helpers/focusFixup';")).toBe(false);
    expect(NEEDS_FIXUP.test("from '../src/components/commons/CommonsCloseBatch'")).toBe(true);
  });
});
