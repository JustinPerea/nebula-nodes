import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PromptDialog } from '../src/components/commons/CommonsPrompt';
import { resolvedStyle, styleDifferences } from './helpers/cssCascade';

// Review 10, M-1: Commons' prompt ("Add to → New collection…", "Why?
// (optional…)", "Label this region", "Rename region") moved to the body with
// ModalPortal, outside .commons-view, which its field, button-focus and type
// rules were scoped to. Its field turned into the browser's white box (Arial
// 13.3px, black text, 2px grey border, no padding, black focus ring). Its
// rules are now scoped to a class it carries itself (commons-scope), so it
// looks the same wherever it renders. Checked with the app's own stylesheets
// (helpers/cssCascade.ts), resting and focused.

describe("Commons' prompt keeps its styling on the body", () => {
  beforeEach(() => { document.body.className = 'app-slava-restraint'; });
  afterEach(() => {
    cleanup();
    document.body.className = '';
    document.body.innerHTML = '';
  });

  const open = () => {
    render(<PromptDialog request={{ label: 'New collection name', initial: 'Moodboard', resolve: () => {} }} onDone={() => {}} />);
    const root = document.querySelector('.commons-prompt')!;
    expect(root.closest('.modal-portal')).not.toBeNull();
    return root;
  };

  it('every element resolves as it did inside the Commons view', () => {
    const root = open();
    const view = document.createElement('div');
    view.className = 'commons-view';
    document.body.appendChild(view);
    expect(styleDifferences(root, view)).toEqual([]);
  });

  it('the field: the dark Slava field, Inter 12px, 1px border, 5px 7px padding, the Slava focus ring', () => {
    const input = open().querySelector('input')!;
    const style = resolvedStyle(input);
    expect(style['|padding']).toBe('5px 7px');
    expect(style['|font-size']).toBe('12px');
    expect(style['|font']).toBe('inherit');
    expect(style['|font-family']).toBe('var(--sr-ui)');
    expect(style['|border']).toBe('1px solid var(--sr-edge)');
    expect(style['|background']).toBe('var(--sr-surface-control)');
    expect(style['|color']).toBe('var(--sr-ink)');
    expect(style[':focus-visible|outline']).toBe('var(--sr-focus-outline)');
    expect(style[':focus-visible|outline-offset']).toBe('var(--sr-focus-offset)');
  });

  it('its buttons: the Slava focus ring and type', () => {
    for (const button of open().querySelectorAll('button')) {
      const style = resolvedStyle(button);
      expect(style[':focus-visible|outline']).toBe('var(--sr-focus-outline)');
      expect(style['|font-family']).toBe('var(--sr-ui)');
      expect(style['|font-size']).toBe('12px');
    }
  });

  it('its card keeps its spring', () => {
    const card = open().querySelector('.commons-prompt__card')!;
    expect(resolvedStyle(card)['|--commons-spring']).toBe('cubic-bezier(0.2, 0.9, 0.3, 1.2)');
  });
});
