import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject, TextareaHTMLAttributes } from 'react';

/** Fit a textarea to its text: no shorter than its `rows`, no taller than its
 * CSS `max-height`, past which it scrolls. */
function fitTextareaHeight(element: HTMLTextAreaElement): void {
  element.style.height = 'auto';
  const style = getComputedStyle(element);
  // scrollHeight is the text plus padding: a border-box height adds the
  // borders, a content-box one takes the padding off.
  const wanted = style.boxSizing === 'border-box'
    ? element.scrollHeight + Math.max(0, element.offsetHeight - element.clientHeight)
    : element.scrollHeight - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0);
  const max = Number.parseFloat(style.maxHeight);
  const capped = Number.isFinite(max) && max > 0 && wanted > max;
  element.style.height = `${capped ? max : wanted}px`;
  element.style.overflowY = capped ? 'auto' : 'hidden';
}

/**
 * A textarea that grows with its text, up to its CSS `max-height`, then
 * scrolls. Measured in script rather than with CSS `field-sizing: content`,
 * which Safari (the desktop app's other engine) doesn't have; it measures
 * again when the text or the width changes.
 */
export function AutoGrowTextarea({ textareaRef, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** The element, for a caller that focuses it or places the caret. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = useCallback(() => { if (ref.current) fitTextareaHeight(ref.current); }, []);
  useLayoutEffect(fit, [fit, props.value]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      // Only a new width re-wraps the text; fitting changes the height.
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  return <textarea ref={(element) => { ref.current = element; if (textareaRef) textareaRef.current = element; }} {...props} />;
}
