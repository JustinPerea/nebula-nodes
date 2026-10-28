import { afterEach, describe, expect, it } from 'vitest';
import { isModalDialogOpen, keyBlockedByModal } from '../src/lib/canvasShortcutScope';

// Review 9, nits a and b: a modal inside a hidden, inert or display:none
// ancestor doesn't count, and the one on top is the last one opened.

afterEach(() => {
  document.body.innerHTML = '';
});

describe('nit a: a modal that is not shown does not count', () => {
  it.each([
    ['hidden', (el: HTMLElement) => el.setAttribute('hidden', '')],
    ['inert', (el: HTMLElement) => el.setAttribute('inert', '')],
    ['display:none', (el: HTMLElement) => { el.style.display = 'none'; }],
  ])('inside a %s ancestor', (_name, hide) => {
    const holder = document.createElement('div');
    holder.innerHTML = '<div><div role="dialog" aria-modal="true"></div></div>';
    document.body.appendChild(holder);
    expect(isModalDialogOpen()).toBe(true);
    hide(holder.firstElementChild as HTMLElement);
    expect(isModalDialogOpen()).toBe(false);
    expect(keyBlockedByModal()).toBe(false);
  });
});

describe('nit b: the modal on top is the last one opened, wherever it sits on the page', () => {
  it('reads the layer, not the page order', () => {
    document.body.innerHTML = `
      <div data-modal-layer="7"><div id="top" role="dialog" aria-modal="true"><button id="topButton"></button></div></div>
      <div data-modal-layer="3"><div id="under" role="dialog" aria-modal="true"><button id="underButton"></button></div></div>`;
    expect(keyBlockedByModal(document.getElementById('topButton'))).toBe(false);
    expect(keyBlockedByModal(document.getElementById('underButton'))).toBe(true);
  });
});
