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

/*
 * The person's own focus moves (GM r36 item 6 on PR #199): after a refused
 * delete, a focus change the person made counts as moving on; one Nebula
 * made itself (to a refusal line, back after a toast, a dialog that opens
 * on a timer or an answer) doesn't. A focus change counts as the person's
 * only when it happens in the same task as their own input (a pointer
 * press, a key press: a click's or Tab's default action, or a handler that
 * moves focus because they pressed something). Nebula's own moves come
 * later, from answers, timers and frames, so they never count. Nothing is
 * read from the element itself.
 */
let personInputOpen = false;
let personInputCloses: ReturnType<typeof setTimeout> | null = null;
let personFocusMoves = 0;
function notePersonInput(): void {
  personInputOpen = true;
  if (personInputCloses === null) {
    personInputCloses = setTimeout(() => { personInputOpen = false; personInputCloses = null; }, 0);
  }
}
function noteFocusMove(): void {
  if (personInputOpen) personFocusMoves += 1;
}
if (typeof document !== 'undefined') {
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
    document.addEventListener(type, notePersonInput, true);
  }
  document.addEventListener('focusin', noteFocusMove, true);
}
/** A mark of the person's focus moves so far, taken at a press. It closes
 * the press's own input: a focus move its handler or default action makes
 * after this (a deleted card's focus falling elsewhere) isn't moving on. */
export function personFocusMark(): number {
  personInputOpen = false;
  return personFocusMoves;
}
/** Whether the person moved focus themselves since `mark`. */
export function personMovedFocusSince(mark: number): boolean {
  return personFocusMoves !== mark;
}
