import { useCallback, useEffect, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import './onboarding.css';

interface TourStep {
  selector: string;
  title: string;
  body: string;
}

// Targets are the always-mounted canvas panel-launcher buttons (App.tsx).
const TOUR: TourStep[] = [
  { selector: '.panel-launcher--nodes', title: 'Node Library', body: 'Drag any of 138 nodes onto the canvas and wire them up.' },
  { selector: '.panel-launcher--create', title: 'Create', body: 'Prefer prompts? Generate in a prompt-first view — no wiring needed.' },
  { selector: '.panel-launcher--chat', title: 'Agent', body: 'Or just describe what you want — the agent builds the graph for you.' },
  { selector: '.panel-launcher--assets', title: 'Assets', body: 'Reusable characters, moodboards, and styles — drag any onto the canvas.' },
];

export function OnboardingOverlay() {
  const active = useUIStore((s) => s.onboardingActive);
  const step = useUIStore((s) => s.onboardingStep);
  const next = useUIStore((s) => s.nextOnboardingStep);
  const prev = useUIStore((s) => s.prevOnboardingStep);
  const finish = useUIStore((s) => s.finishOnboarding);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const loadSampleGraph = useGraphStore((s) => s.loadSampleGraph);

  const [rect, setRect] = useState<DOMRect | null>(null);

  const tourIndex = step - 1;
  const tourStep = tourIndex >= 0 && tourIndex < TOUR.length ? TOUR[tourIndex] : null;

  const advance = useCallback(() => {
    if (tourIndex >= TOUR.length - 1) finish();
    else next();
  }, [tourIndex, next, finish]);

  // Esc to skip the whole thing.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  // Measure the current tour target's position (recompute on resize). If the
  // target isn't in the DOM we fall back to a centered tooltip (no spotlight).
  useEffect(() => {
    // Stale rect from a prior step never renders (component returns null when
    // inactive / on the welcome card), so there's no need to clear it here.
    if (!active || !tourStep) return;
    const measure = () => {
      const el = document.querySelector(tourStep.selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active, tourStep]);

  if (!active) return null;

  // --- Welcome card (step 0) ---
  if (step === 0) {
    return (
      <div className="onboarding" role="dialog" aria-modal="true" aria-label="Welcome to Nebula Nodes">
        <div className="onboarding__backdrop" />
        <div className="onboarding__welcome">
          <h2 className="onboarding__title">Welcome to Nebula Nodes</h2>
          <p className="onboarding__subtitle">
            A multi-surface AI studio. Build by dragging nodes, prompting in Create, or asking the agent.
          </p>
          <div className="onboarding__actions">
            <button className="onboarding__cta onboarding__cta--primary" onClick={next}>
              Take the tour
            </button>
            <button
              className="onboarding__cta"
              onClick={() => {
                loadSampleGraph();
                finish();
              }}
            >
              Load a sample graph
            </button>
            <button
              className="onboarding__cta"
              onClick={() => {
                if (!useUIStore.getState().panels.chat.visible) togglePanel('chat');
                finish();
              }}
            >
              Describe what you want
            </button>
          </div>
          <button className="onboarding__skip" onClick={finish}>
            Skip
          </button>
        </div>
      </div>
    );
  }

  // --- Spotlight tour (steps 1..N) ---
  // Position below the target, but flip above (and clamp) when it would overflow
  // the bottom of the viewport, so the tooltip is always on-screen.
  const TOOLTIP_H = 170;
  const left = rect
    ? Math.max(12, Math.min(rect.left + rect.width / 2 - 150, window.innerWidth - 312))
    : 0;
  const fitsBelow = rect ? rect.bottom + 12 + TOOLTIP_H < window.innerHeight : false;
  const top = rect ? (fitsBelow ? rect.bottom + 12 : Math.max(12, rect.top - TOOLTIP_H - 12)) : 0;
  const tooltipStyle: React.CSSProperties = rect
    ? { top, left }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="onboarding onboarding--tour" role="dialog" aria-modal="true">
      {rect ? (
        <div
          className="onboarding__spotlight"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      ) : (
        <div className="onboarding__backdrop" />
      )}
      {tourStep && (
        <div className="onboarding__tooltip" style={tooltipStyle}>
          <div className="onboarding__tooltip-title">{tourStep.title}</div>
          <div className="onboarding__tooltip-body">{tourStep.body}</div>
          <div className="onboarding__tooltip-row">
            <span className="onboarding__progress">
              {tourIndex + 1} / {TOUR.length}
            </span>
            <div className="onboarding__tooltip-buttons">
              {tourIndex > 0 && (
                <button className="onboarding__cta onboarding__cta--small" onClick={prev}>
                  Back
                </button>
              )}
              <button className="onboarding__cta onboarding__cta--small onboarding__cta--primary" onClick={advance}>
                {tourIndex >= TOUR.length - 1 ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
          <button className="onboarding__skip onboarding__skip--small" onClick={finish}>
            Skip tour
          </button>
        </div>
      )}
    </div>
  );
}
