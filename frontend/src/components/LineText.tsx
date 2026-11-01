import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { isBecauseLine, registerLine, type LineRegistration } from '../lib/notConnectedLine';
import { useBackendOffline } from '../lib/useBackendOffline';
import '../styles/becauseLine.css';

const ANCHOR_STYLE = { display: 'none' } as const;
export const BECAUSE_ATTR = 'data-line-because';

/**
 * A line's words, registered while they are mounted (lib/notConnectedLine, PR #204 round 9): a
 * "because" line or the general words send the general notice away while they are on screen; a
 * lock or a dev setup's line keeps it. Text of no kind registers nothing, so any failure line can
 * render through it. Every surface that shows a line from the not-connected copy helpers renders
 * it through this (tests/lineRegistration.ratchet.test.ts).
 *
 * The words stay where the surface put them: with no `className` they render as bare text in the
 * surface's own element (its role, class and tooltip unchanged), and an empty anchor that never
 * displays finds that element, which is what registers. With a `className` they render in a span
 * of that class, which registers. `children` lays the same words out differently (a name in
 * monospace); `text` is what registers. No text renders nothing.
 *
 * GM r14 (4): a because line marks the element it registers on (`data-line-because`), and one
 * shared sheet (styles/becauseLine.css) keeps it out of the warning colour on every surface.
 *
 * Round 15 (review 12 LOW-1, GM r23 3: offline comes first): a because line is hidden while Nebula
 * is offline, wherever it is drawn, since the offline notice says what is wrong and connecting the
 * tab wouldn't be enough. Back online it shows again if it still applies. With no `className` the
 * surface's element is hidden too when the line is all it holds (a `role="alert"` paragraph, a
 * toast's span), so no empty box is left; with one, the span is. Any other line is unchanged.
 */
export function LineText({ text, className, children }: { text: string | null | undefined; className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const own = className !== undefined;
  const registration = useRef<LineRegistration | null>(null);
  const words = text || null;
  const offline = useBackendOffline();
  const hide = offline && words !== null && isBecauseLine(words);
  // Review 8 MEDIUM-3 (round 10): one registration while the line is mounted (keyed to its
  // element), its words updated in place below, so a change of words keeps what the observer
  // said and the notice never flashes back. Unmounted (or no words): unregistered.
  useLayoutEffect(() => {
    const element = own ? ref.current : ref.current?.parentElement;
    if (!element || words === null) return undefined;
    const held = registerLine(element, words);
    registration.current = held;
    return () => {
      held();
      registration.current = null;
      element.removeAttribute(BECAUSE_ATTR);
    };
    // The words are read once here, then by the update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [own, words === null]);
  useLayoutEffect(() => {
    const element = own ? ref.current : ref.current?.parentElement;
    if (!element || words === null) return;
    registration.current?.update(words);
    if (isBecauseLine(words)) element.setAttribute(BECAUSE_ATTR, own ? 'own' : '');
    else element.removeAttribute(BECAUSE_ATTR);
  }, [own, words]);
  // Offline first, bare: the surface's element goes too when the line is all it holds.
  useLayoutEffect(() => {
    const anchor = ref.current;
    const element = anchor?.parentElement;
    if (own || !hide || !element || element.hidden) return undefined;
    const alone = [...element.childNodes].every((node) => node === anchor
      || (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim()));
    if (!alone) return undefined;
    element.hidden = true;
    return () => { element.hidden = false; };
  }, [own, hide]);
  if (!text) return null;
  if (own) return <span ref={ref} className={className} hidden={hide || undefined}>{hide ? null : children ?? text}</span>;
  return <>{hide ? null : children ?? text}<span ref={ref} data-line-anchor="" style={ANCHOR_STYLE} /></>;
}
