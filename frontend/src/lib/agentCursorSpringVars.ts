import {
  AGENT_CURSOR_CLICK,
  AGENT_CURSOR_DASHED,
  AGENT_CURSOR_ERROR,
  AGENT_CURSOR_HALO,
  AGENT_CURSOR_LOOK,
  AGENT_CURSOR_MARK,
  AGENT_CURSOR_PRESS_SPRING,
  AGENT_CURSOR_RING_SPRING,
  AGENT_CURSOR_RUN,
  AGENT_CURSOR_SHAKE_SPRING,
  AGENT_CURSOR_THINK,
  AGENT_CURSOR_TYPE,
} from './agentCursorTuning';
import { AGENT_CURSOR_FADE_SPRING } from './agentCursorPlanner';
import { impulseCurve, stepCurve, thinkCurve } from './agentCursorExpression';
import { SPRING_SOFT, springFromStiffness, springLinear } from './springs';

/** The CSS springs and the expression's numbers, sampled once from
 *  lib/springs.ts, lib/agentCursorExpression.ts and lib/agentCursorTuning.ts
 *  (agentCursor.css reads them): GM retunes in the tuning module alone. */
let springVars: Record<`--${string}`, string> | null = null;
export function cursorSpringVars(): Record<`--${string}`, string> {
  if (springVars) return springVars;
  const soft = springLinear(SPRING_SOFT);
  const ring = stepCurve(AGENT_CURSOR_RING_SPRING);
  const press = impulseCurve(AGENT_CURSOR_PRESS_SPRING);
  const shake = impulseCurve(AGENT_CURSOR_SHAKE_SPRING);
  const turn = stepCurve(AGENT_CURSOR_RING_SPRING);
  const breath = thinkCurve();
  const fade = springLinear(springFromStiffness(AGENT_CURSOR_FADE_SPRING.stiffness, AGENT_CURSOR_FADE_SPRING.damping));
  springVars = {
    '--agent-cursor-soft': `${soft.durationMs}ms ${soft.easing}`,
    '--agent-cursor-ring': `${ring.durationMs}ms ${ring.easing}`,
    '--agent-cursor-ring-from': `${AGENT_CURSOR_CLICK.ringFromPx}px`,
    '--agent-cursor-ring-to': `${AGENT_CURSOR_CLICK.ringToPx}px`,
    '--agent-cursor-ring-stroke-from': `${AGENT_CURSOR_CLICK.strokeFromPx}px`,
    '--agent-cursor-ring-stroke-to': `${AGENT_CURSOR_CLICK.strokeToPx}px`,
    '--agent-cursor-ring-opacity': String(AGENT_CURSOR_CLICK.opacityFrom),
    '--agent-cursor-press': `${press.durationMs}ms ${press.easing}`,
    '--agent-cursor-press-scale': String(AGENT_CURSOR_CLICK.pressScale),
    '--agent-cursor-halo-opacity': String(AGENT_CURSOR_HALO.opacity),
    '--agent-cursor-look-dim': String(AGENT_CURSOR_LOOK.dimOpacity),
    '--agent-cursor-sweep': `${AGENT_CURSOR_LOOK.sweepMs}ms ${turn.easing}`,
    '--agent-cursor-sweep-stroke': `${AGENT_CURSOR_LOOK.strokePx}px`,
    '--agent-cursor-sweep-opacity': String(AGENT_CURSOR_LOOK.arcOpacity),
    '--agent-cursor-breath': `${Math.round(AGENT_CURSOR_THINK.loopMs / 2)}ms ${breath.easing}`,
    '--agent-cursor-breath-trough-opacity': String(AGENT_CURSOR_THINK.troughOpacity),
    '--agent-cursor-breath-peak-opacity': String(AGENT_CURSOR_THINK.peakOpacity),
    '--agent-cursor-breath-trough-blur': `${AGENT_CURSOR_THINK.troughBlurPx}px`,
    '--agent-cursor-breath-peak-blur': `${AGENT_CURSOR_THINK.peakBlurPx}px`,
    '--agent-cursor-breath-scale': String(AGENT_CURSOR_THINK.peakScale),
    '--agent-cursor-orbit': `${AGENT_CURSOR_RUN.orbitMs}ms ${turn.easing}`,
    '--agent-cursor-orbit-stroke': `${AGENT_CURSOR_RUN.strokePx}px`,
    '--agent-cursor-dashed-stroke': `${AGENT_CURSOR_DASHED.strokePx}px`,
    '--agent-cursor-dashed-dash': `${AGENT_CURSOR_DASHED.dashPx} ${AGENT_CURSOR_DASHED.gapPx}`,
    '--agent-cursor-dashed-opacity': String(AGENT_CURSOR_DASHED.opacity),
    '--agent-cursor-mark-left': `${AGENT_CURSOR_MARK.leftPx}px`,
    '--agent-cursor-mark-top': `${AGENT_CURSOR_MARK.topPx}px`,
    '--agent-cursor-mark-box': `${AGENT_CURSOR_MARK.boxPx}px`,
    '--agent-cursor-shake': `${shake.durationMs}ms ${shake.easing}`,
    '--agent-cursor-shake-px': `${AGENT_CURSOR_ERROR.shakePx}px`,
    '--agent-cursor-flash': `${AGENT_CURSOR_ERROR.flashMs}ms ${fade.easing}`,
    '--agent-cursor-flash-opacity': String(AGENT_CURSOR_ERROR.flashOpacity),
    '--agent-cursor-blink': `${AGENT_CURSOR_TYPE.blinkMs}ms ${soft.easing}`,
    '--agent-cursor-caret-width': `${AGENT_CURSOR_TYPE.caretPx}px`,
  };
  return springVars;
}

