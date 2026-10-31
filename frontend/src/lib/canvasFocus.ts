/** Moves focus to the canvas once it is on screen (review 19 item 6 on PR
 * #199): Projects > Open of the project already loaded returns to the
 * canvas without a load, and focus would otherwise fall to <body> when the
 * Open button unmounts. The canvas root takes focus programmatically only
 * (tabIndex -1), so the Tab order doesn't change. Gives up after about a
 * second if no canvas appears. */
export function focusCanvasSoon(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  let tries = 0;
  const attempt = () => {
    const canvas = document.querySelector<HTMLElement>('.react-flow');
    if (canvas) {
      if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
      canvas.focus({ preventScroll: true });
      return;
    }
    tries += 1;
    if (tries < 60) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}
