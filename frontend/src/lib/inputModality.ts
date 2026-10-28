/**
 * Whether the person's last input was the keyboard, for focus Nebula moves
 * itself (review 6 of PR #199, N-4; GM: "Focus moves only from the
 * keyboard; ring only on :focus-visible"). A pointer press clears it, a key
 * press (not a shortcut with a modifier) sets it. The listeners are in the
 * capture phase, so they see input before any handler acts on it.
 */
let keyboard = false;
let installed = false;

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('keydown', (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboard = true;
  }, true);
  const pointer = () => { keyboard = false; };
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('mousedown', pointer, true);
  document.addEventListener('touchstart', pointer, true);
}

install();

export function lastInputWasKeyboard(): boolean {
  install();
  return keyboard;
}
