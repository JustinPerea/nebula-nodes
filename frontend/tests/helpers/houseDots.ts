import { vi } from 'vitest';

/**
 * jsdom loads no stylesheets, so a port handle has no drawn dot there. This
 * gives every `.react-flow__handle` the house skin's (slava-restraint.css):
 * a 9 px ::before dot, drawn 4 px toward the card at rest
 * (`--sr-handle-rest-offset`), and the 20 px ::after hover circle with its
 * 1 px border (border-box, as App.css gives every box). Other elements read the real computed style.
 * Undone by vi.restoreAllMocks().
 */
export function houseDots() {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    if (!element.classList.contains('react-flow__handle')) return original(element, pseudo);
    return {
      width: pseudo === '::before' ? '9px' : '20px',
      boxSizing: 'border-box',
      borderLeftWidth: pseudo === '::after' ? '1px' : '0px',
      getPropertyValue: (name: string) => (name === '--sr-handle-rest-offset' ? '4px'
        : name === '--sr-handle-magnet-x' ? element.style.getPropertyValue(name) : ''),
    } as unknown as CSSStyleDeclaration;
  });
}
