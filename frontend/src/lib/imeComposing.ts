import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * A key the input method is using to end or commit a composition: never the
 * app's Enter. Chrome marks it with `isComposing`; Safari fires
 * compositionend before that keydown, so `isComposing` is false there and
 * only `keyCode` 229 says so (review 2 of PR #200, L-1). Shared by every
 * field where Enter acts (CommandPalette, PromptDialog).
 */
export function composing(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return native.isComposing || event.keyCode === 229 || native.keyCode === 229;
}
