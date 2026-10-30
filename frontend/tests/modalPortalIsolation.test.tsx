import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModalPortal } from '../src/components/ModalPortal';

// GM, PR #203 r13 item 1 (round 6 review, stacking LOW-1): one isolation for
// every modal, in the portal. While it holds an aria-modal dialog, every
// other child of <body> is inert and aria-hidden (the notice region stays
// usable, and so does a modal opened over it); on close each element's own
// attributes are back and focus returns to the control that opened it, else
// the dialog's fallback.

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function page() {
  const root = document.createElement('div');
  root.id = 'page';
  const opener = document.createElement('button');
  opener.textContent = 'Opener';
  const fallback = document.createElement('button');
  fallback.textContent = 'Fallback';
  root.append(opener, fallback);
  const notices = document.createElement('div');
  notices.setAttribute('data-notice-region', '');
  const was = document.createElement('div');
  was.setAttribute('inert', '');
  was.setAttribute('aria-hidden', 'true');
  document.body.append(root, notices, was);
  return { root, opener, fallback, notices, was };
}

function Dialog({ modal = true, fallback }: { modal?: boolean; fallback?: () => HTMLElement | null }) {
  return (
    <ModalPortal fallbackFocus={fallback}>
      <div role="dialog" aria-modal={modal ? 'true' : undefined}><button type="button" autoFocus>Inside</button></div>
    </ModalPortal>
  );
}

function Host({ fallback, modal }: { fallback?: () => HTMLElement | null; modal?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-close onClick={() => setOpen(false)}>close</button>
      {open && <Dialog fallback={fallback} modal={modal} />}
    </>
  );
}

describe('ModalPortal isolates the page behind an aria-modal dialog', () => {
  it('hides every other body child, keeps the notices, and puts back each one\'s own attributes', async () => {
    const { root, opener, notices, was } = page();
    opener.focus();
    const view = render(<Dialog />, { container: document.body.appendChild(document.createElement('div')) });
    const host = view.container;
    for (const element of [root, host]) {
      expect(element).toHaveAttribute('inert', '');
      expect(element).toHaveAttribute('aria-hidden', 'true');
    }
    expect(notices).not.toHaveAttribute('inert');
    expect(document.querySelector('.modal-portal')).not.toHaveAttribute('inert');
    view.unmount();
    for (const element of [root, host]) {
      expect(element).not.toHaveAttribute('inert');
      expect(element).not.toHaveAttribute('aria-hidden');
    }
    // An element that was inert before stays as it was.
    expect(was).toHaveAttribute('inert', '');
    expect(was).toHaveAttribute('aria-hidden', 'true');
    // Focus goes back once the close's other effects have run (a microtask).
    await act(async () => {});
    expect(opener).toHaveFocus();
  });

  it('hides nothing for a portal with no aria-modal dialog', () => {
    const { root } = page();
    render(<Dialog modal={false} />);
    expect(root).not.toHaveAttribute('inert');
  });

  it('returns focus to the dialog\'s fallback when the opener is gone', async () => {
    const { opener, fallback } = page();
    opener.focus();
    const container = document.body.appendChild(document.createElement('div'));
    render(<Host fallback={() => fallback} />, { container });
    opener.remove();
    await act(async () => { (container.querySelector('[data-close]') as HTMLButtonElement).click(); });
    expect(fallback).toHaveFocus();
  });

  it('a modal opened over another stays usable, and closing it leaves the first one\'s isolation in place', () => {
    const { root, opener } = page();
    opener.focus();
    const first = render(<Dialog />, { container: document.body.appendChild(document.createElement('div')) });
    const second = render(<Dialog />, { container: document.body.appendChild(document.createElement('div')) });
    const portals = document.querySelectorAll('.modal-portal');
    expect(portals).toHaveLength(2);
    expect(portals[1]).not.toHaveAttribute('inert');
    expect(portals[0]).toHaveAttribute('inert', '');
    second.unmount();
    expect(portals[0]).not.toHaveAttribute('inert');
    expect(root).toHaveAttribute('inert', '');
    first.unmount();
    expect(root).not.toHaveAttribute('inert');
  });
});
