/**
 * Whether a scroll viewport has more than 1 px of content below its view:
 * ScrollFade's bottom cue, and the floating Inspector's foot hairline (GM r87,
 * r98), read the same way.
 */
export function hasMoreBelow(viewport: HTMLElement) {
  return viewport.clientHeight > 0
    && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1;
}
