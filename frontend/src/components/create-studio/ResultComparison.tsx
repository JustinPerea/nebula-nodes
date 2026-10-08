import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ResultContext } from '../../lib/resultContext';
import { ResultDetails, ResultMetadata } from './ResultDetails';
import '../../styles/result-comparison.css';

export interface ComparisonResult {
  key: string;
  nodeId: string;
  media: { url: string; kind: 'image' | 'video' };
  context: ResultContext;
}

interface ResultComparisonProps {
  items: readonly [ComparisonResult, ComparisonResult];
  onClose: () => void;
  onReuseSettings?: (context: ResultContext) => void;
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, video[controls], [tabindex]:not([tabindex="-1"])';

function available(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (!element.isConnected || element.matches(':disabled')
    || element.closest('[inert], [hidden], [aria-hidden="true"]')
    || style.display === 'none' || style.visibility === 'hidden') return false;
  // Descendants of a closed recipe disclosure are not in the browser's Tab order.
  const closedDetails = element.closest('details:not([open])');
  return !closedDetails || element === closedDetails.querySelector('summary');
}

/** The pair owns copied media and recipes until the comparison is closed. */
export function ResultComparison({ items, onClose, onReuseSettings }: ResultComparisonProps) {
  const [results] = useState(() => structuredClone(items));
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = new Map<Element, { inert: string | null; hidden: string | null }>();
    const hadScrollLock = document.body.classList.contains('result-comparison-open');
    const focusClose = () => panel.querySelector<HTMLButtonElement>('.result-comparison__close')?.focus();
    // Move focus before hiding the opener's subtree from assistive technology.
    focusClose();
    const isolate = () => {
      for (const sibling of document.body.children) {
        if (sibling === overlay || background.has(sibling)) continue;
        background.set(sibling, { inert: sibling.getAttribute('inert'), hidden: sibling.getAttribute('aria-hidden') });
        sibling.setAttribute('inert', '');
        sibling.setAttribute('aria-hidden', 'true');
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !overlay.contains(event.target)) focusClose();
    };
    const containKey = (event: KeyboardEvent) => {
      // Keep global Canvas shortcuts out of the modal, including a body-level
      // event after browser focus loss. Native video/disclosure defaults remain.
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(available);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const nextIndex = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
        (controls[nextIndex] ?? panel).focus();
      } else if (!(event.target instanceof Node) || !overlay.contains(event.target)) {
        event.preventDefault();
        focusClose();
      }
    };
    document.addEventListener('focusin', containFocus);
    document.addEventListener('keydown', containKey, true);
    document.body.classList.add('result-comparison-open');
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', containFocus);
      document.removeEventListener('keydown', containKey, true);
      for (const [element, prior] of background) {
        if (prior.inert === null) element.removeAttribute('inert');
        else element.setAttribute('inert', prior.inert);
        if (prior.hidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', prior.hidden);
      }
      if (!hadScrollLock) document.body.classList.remove('result-comparison-open');
      if (opener && opener !== document.body && available(opener)) {
        opener.focus({ preventScroll: true });
        if (document.activeElement === opener) return;
      }
      const fallback = document.querySelector<HTMLElement>('[data-result-comparison-fallback]');
      if (fallback && available(fallback)) fallback.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      ref={overlayRef}
      className="result-comparison"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className="result-comparison__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
        <header className="result-comparison__header">
          <div>
            <h2 id={titleId}>Compare results</h2>
            <p id={descriptionId}>Two previews kept for this comparison. Reuse settings prepares a draft; choose Generate to run it.</p>
          </div>
          <button type="button" className="result-comparison__close" aria-label="Close comparison" onClick={onClose}>
            <X size={20} strokeWidth={1.75} />
          </button>
        </header>
        <div className="result-comparison__results">
          {results.map((item, index) => {
            const position = index === 0 ? 'first' : 'second';
            return (
              <section key={item.key} className="result-comparison__result" aria-label={`${index === 0 ? 'First' : 'Second'} result`}>
                <p className="result-comparison__position">{index === 0 ? 'First result' : 'Second result'}</p>
                <div className="result-comparison__stage">
                  {item.media.kind === 'video'
                    ? <video className="result-comparison__media" src={item.media.url} aria-label={`${index === 0 ? 'First' : 'Second'} result video`} controls playsInline tabIndex={0} />
                    : <img className="result-comparison__media" src={item.media.url} alt={`${index === 0 ? 'First' : 'Second'} result`} />}
                </div>
                <div className="result-comparison__context">
                  <ResultMetadata context={item.context} />
                  <ResultDetails context={item.context} />
                  {item.context.reusableDraft && onReuseSettings && (
                    <button type="button" className="result-comparison__reuse" aria-label={`Reuse settings from ${position} result`} onClick={() => {
                      onClose();
                      onReuseSettings(item.context);
                    }}>Reuse settings</button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>, document.body,
  );
}
