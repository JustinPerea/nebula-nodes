/** Whether a scroll box has more below what it shows. A pixel of slack, so
 * a fractional scroll position at the end reads as the end. */
export function hasMoreBelow(box: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>): boolean {
  return box.scrollTop + box.clientHeight < box.scrollHeight - 1;
}
