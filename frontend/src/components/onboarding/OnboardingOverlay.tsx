import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ONBOARDING_HELP_SELECTOR, ONBOARDING_TOUR, placeOnboardingTooltip, type OnboardingPlacement } from '../../lib/onboarding';
import { useUIStore } from '../../store/uiStore';
import './onboarding.css';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function available(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return element.isConnected && !element.matches(':disabled')
    && !element.closest('[inert], [hidden], [aria-hidden="true"]')
    && style.display !== 'none' && style.visibility !== 'hidden';
}

export function OnboardingOverlay() {
  const active = useUIStore((s) => s.onboardingActive);
  const step = useUIStore((s) => s.onboardingStep);
  const next = useUIStore((s) => s.nextOnboardingStep);
  const prev = useUIStore((s) => s.prevOnboardingStep);
  const finish = useUIStore((s) => s.finishOnboarding);
  const setLeftDock = useUIStore((s) => s.setLeftDock);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [layout, setLayout] = useState<{ step: number; placement: OnboardingPlacement } | null>(null);
  const tourStep = ONBOARDING_TOUR[step - 1];
  const placement = layout?.step === step ? layout.placement : null;

  const advance = useCallback(() => {
    if (step >= ONBOARDING_TOUR.length) finish();
    else next();
  }, [step, next, finish]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const card = cardRef.current;
    if (!active || !overlay || !card) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = new Map<Element, { inert: string | null; hidden: string | null }>();
    // Let the card's own scroll region reveal its focused control at high zoom.
    const focusCard = () => (card.querySelector<HTMLElement>('[data-onboarding-primary]') ?? card).focus();
    // Move focus before hiding the opener's subtree from assistive technology.
    focusCard();
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
      if (event.target instanceof Node && !overlay.contains(event.target)) focusCard();
    };
    document.addEventListener('focusin', containFocus);
    const containUnfocusedKey = (event: globalThis.KeyboardEvent) => {
      if (event.target instanceof Node && overlay.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') finish();
      else focusCard();
    };
    document.addEventListener('keydown', containUnfocusedKey, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', containFocus);
      document.removeEventListener('keydown', containUnfocusedKey, true);
      for (const [element, prior] of background) {
        if (prior.inert === null) element.removeAttribute('inert');
        else element.setAttribute('inert', prior.inert);
        if (prior.hidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', prior.hidden);
      }
      if (opener && opener !== document.body && opener !== document.documentElement && available(opener)) {
        opener.focus({ preventScroll: true });
        if (document.activeElement === opener) return;
      }
      const help = document.querySelector<HTMLElement>(ONBOARDING_HELP_SELECTOR);
      if (help && available(help)) help.focus({ preventScroll: true });
    };
  }, [active, finish]);

  useLayoutEffect(() => {
    if (!active) return;
    (cardRef.current?.querySelector<HTMLElement>('[data-onboarding-primary]') ?? cardRef.current)?.focus();
  }, [active, step]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const overlay = overlayRef.current;
    if (!active || !tourStep || !card || !overlay) return;
    let target: HTMLElement | null = null;
    let disposed = false;
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    const measure = () => {
      if (disposed) return;
      const candidate = document.querySelector<HTMLElement>(tourStep.selector);
      if (candidate !== target) {
        if (target) resizeObserver?.unobserve(target);
        target = candidate;
        if (target) resizeObserver?.observe(target);
      }
      const style = target ? window.getComputedStyle(target) : null;
      const rect = target && !target.closest('[hidden]') && style?.display !== 'none' && style?.visibility !== 'hidden'
        ? target.getBoundingClientRect() : null;
      const nextPlacement = placeOnboardingTooltip(rect, card.getBoundingClientRect(), {
        width: window.innerWidth, height: window.innerHeight,
      });
      setLayout((previous) => previous?.step === step && JSON.stringify(previous.placement) === JSON.stringify(nextPlacement)
        ? previous : { step, placement: nextPlacement });
    };
    resizeObserver?.observe(card);
    // Measure before paint, then keep ownership tied to the current selector.
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const mutations = new MutationObserver((records) => {
      // The card's own position updates must not start a measurement loop.
      if (records.some((record) => !overlay.contains(record.target))) measure();
    });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-onboarding-target'] });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [active, step, tourStep]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Inert prevents pointer/focus interaction; containment also stops global
    // workspace shortcuts from executing underneath the tour.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      finish();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const controls = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(available);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
      (controls[nextIndex] ?? cardRef.current)?.focus();
    }
  };

  if (!active) return null;
  const highlight = placement?.highlight;
  const cardStyle = placement ? { top: placement.top, left: placement.left } : undefined;

  return createPortal(
    <div
      className={`onboarding${step > 0 ? ' onboarding--tour' : ''}`}
      ref={overlayRef}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.target instanceof Node && !cardRef.current?.contains(event.target)) event.preventDefault();
      }}
    >
      {highlight ? (
        <div className="onboarding__spotlight" aria-hidden="true" style={{
          top: highlight.top, left: highlight.left, width: highlight.width, height: highlight.height,
        }} />
      ) : <div className="onboarding__backdrop" aria-hidden="true" />}
      <div
        ref={cardRef}
        className={step === 0 ? 'onboarding__welcome' : 'onboarding__tooltip'}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        {step === 0 ? (
          <>
            <p className="onboarding__eyebrow">A quick introduction</p>
            <h2 id={titleId} className="onboarding__title">Welcome to Nebula Nodes</h2>
            <p id={descriptionId} className="onboarding__subtitle">
              Find a model, connect your provider and create from a prompt or a connected canvas. Take a quick tour, or start browsing.
            </p>
            <div className="onboarding__actions">
              <button className="onboarding__cta onboarding__cta--primary" data-onboarding-primary onClick={next}>Take the tour</button>
              <button className="onboarding__cta" onClick={() => { setLeftDock('library'); finish(); }}>Start browsing</button>
            </div>
            <p className="onboarding__hint">Reopen the tour from Help on the canvas.</p>
            <button className="onboarding__skip" onClick={finish}>Skip</button>
          </>
        ) : (
          <>
            <p className="onboarding__eyebrow">Getting started · {step} of {ONBOARDING_TOUR.length}</p>
            <h2 id={titleId} className="onboarding__tooltip-title">{tourStep?.title ?? 'Ready to create'}</h2>
            <p id={descriptionId} className="onboarding__tooltip-body">{tourStep?.body ?? 'Return to your canvas to get started.'}</p>
            <div className="onboarding__tooltip-row">
              <button className="onboarding__skip" onClick={finish}>Skip tour</button>
              <div className="onboarding__tooltip-buttons">
                <button className="onboarding__cta onboarding__cta--small" onClick={prev}>Back</button>
                <button className="onboarding__cta onboarding__cta--small onboarding__cta--primary" data-onboarding-primary onClick={advance}>
                  {step >= ONBOARDING_TOUR.length ? 'Done' : 'Next'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>, document.body,
  );
}
