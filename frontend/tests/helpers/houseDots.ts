import { vi } from 'vitest';

/**
 * jsdom loads no stylesheets, so a port handle has no drawn dot there. This
 * gives every `.react-flow__handle` the house skin's (slava-restraint.css):
 * a 9 px ::before dot, drawn 4 px toward the card at rest
 * (`--sr-handle-rest-offset`). Other elements read the real computed style.
 * Undone by vi.restoreAllMocks().
 */
export function houseDots() {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    if (!element.classList.contains('react-flow__handle')) return original(element, pseudo);
    return {
      width: pseudo === '::before' ? '9px' : '20px',
      getPropertyValue: (name: string) => (name === '--sr-handle-rest-offset' ? '4px' : ''),
    } as unknown as CSSStyleDeclaration;
  });
}
