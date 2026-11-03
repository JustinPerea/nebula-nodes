import { describe, expect, it } from 'vitest';
import {
  frameAt,
  gestureMs,
  impulseCurve,
  isExpressive,
  nextChangeAt,
  onArrival,
  onEvent,
  onKeystroke,
  stepCurve,
  type Expression,
} from '../src/lib/agentCursorExpression';
import {
  AGENT_CURSOR_ERROR,
  AGENT_CURSOR_LOOK,
  AGENT_CURSOR_MIN_HOLD_MS,
  AGENT_CURSOR_RUN,
  AGENT_CURSOR_SHAKE_SPRING,
  AGENT_CURSOR_TYPE,
} from '../src/lib/agentCursorTuning';
import type { AgentCursorAction } from '../src/lib/agentPresenceActions';

/**
 * The cursor's expression state machine (GM - Design's cursor spec §2, Phase
 * 2): held states, gestures, the 0.4 s minimum hold, a new action replacing
 * the current one at once, and type's caret.
 */
const begin = (action: AgentCursorAction, at = 1000, seq = 1, watched = true) => onArrival(null, action, seq, at, watched)!;

describe('each action', () => {
  it('move and unknown actions express nothing', () => {
    expect(isExpressive('move')).toBe(false);
    expect(onArrival(null, 'move', 1, 0)).toBeNull();
    expect(frameAt(null, 0).action).toBeNull();
  });

  it.each(['look', 'think', 'type', 'propose', 'wait'] as const)('%s is held until the next event', (action) => {
    const e = begin(action);
    expect(frameAt(e, 999).action).toBeNull(); // not before its arrival
    expect(frameAt(e, 1000).action).toBe(action);
    expect(frameAt(e, 1000 + 60_000).action).toBe(action);
    const ended = onEvent(e, 'click', 70_000);
    expect(frameAt(ended, 70_000).action).toBe(action === 'type' ? 'type' : null); // type lingers
  });

  it.each([
    ['click', () => gestureMs('click')],
    ['drag', () => gestureMs('click')],
    ['run', () => AGENT_CURSOR_RUN.orbitMs],
    ['error', () => gestureMs('error')],
  ] as const)('%s plays its gesture once, then rests', (action, ms) => {
    const e = begin(action);
    expect(frameAt(e, 1000)).toMatchObject({ action, gesture: true });
    expect(frameAt(e, 1000 + ms() - 1)).toMatchObject({ action, gesture: true });
    expect(frameAt(e, 1000 + ms()).action).toBeNull();
  });

  it('run turns for 1.2 s, error flashes at least 400 ms and shakes to rest', () => {
    expect(gestureMs('run')).toBe(1200);
    expect(gestureMs('error')).toBeGreaterThanOrEqual(AGENT_CURSOR_ERROR.flashMs);
    expect(gestureMs('error')).toBeGreaterThanOrEqual(impulseCurve(AGENT_CURSOR_SHAKE_SPRING).durationMs);
  });

  it('look sweeps once (1.4 s), then rests dimmed while held', () => {
    const e = begin('look');
    expect(frameAt(e, 1000 + AGENT_CURSOR_LOOK.sweepMs - 1)).toMatchObject({ action: 'look', gesture: true });
    expect(frameAt(e, 1000 + AGENT_CURSOR_LOOK.sweepMs)).toMatchObject({ action: 'look', gesture: false });
  });

  it('think, look and type end when the cursor goes idle; propose and wait wait for the person', () => {
    for (const action of ['think', 'look', 'type'] as const) {
      expect(frameAt(begin(action), 20_999, 21_000).action).toBe(action);
      expect(frameAt(begin(action), 30_000, 21_000).action).toBeNull();
    }
    for (const action of ['propose', 'wait'] as const) expect(frameAt(begin(action), 30_000, 21_000).action).toBe(action);
  });
});

describe('the hold rule', () => {
  it('a bare move keeps a held state on for at least 0.4 s', () => {
    const e = begin('think', 1000);
    const moved = onEvent(e, 'move', 1100);
    expect(moved!.endsAt).toBe(1000 + AGENT_CURSOR_MIN_HOLD_MS);
    expect(frameAt(moved, 1000 + AGENT_CURSOR_MIN_HOLD_MS - 1).action).toBe('think');
    expect(frameAt(moved, 1000 + AGENT_CURSOR_MIN_HOLD_MS).action).toBeNull();
  });

  it('a bare move after the minimum ends it at once', () => {
    const moved = onEvent(begin('think', 1000), 'move', 5000);
    expect(moved!.endsAt).toBe(5000);
  });

  it('an unknown action holds like move (the store reads it as move)', () => {
    expect(onEvent(begin('wait', 1000), 'move', 1001)!.endsAt).toBe(1400);
  });

  it('a new action with a look of its own replaces the current one at once, inside the minimum too', () => {
    const e = begin('think', 1000);
    expect(onEvent(e, 'click', 1050)!.endsAt).toBe(1050);
    expect(frameAt(onEvent(e, 'click', 1050), 1050).action).toBeNull();
    const next = onArrival(onEvent(e, 'click', 1050), 'click', 2, 1300);
    expect(frameAt(next, 1300).action).toBe('click');
  });

  it('a gesture is cut by a new action, not by a bare move', () => {
    const e = begin('run', 1000);
    expect(frameAt(onEvent(e, 'move', 1100), 1500).action).toBe('run');
    expect(frameAt(onEvent(e, 'think', 1100), 1100).action).toBeNull();
  });

  it('the same held action again carries on (no restart of the breath)', () => {
    const e = begin('think', 1000);
    const again = onArrival(onEvent(e, 'think', 2000), 'think', 2, 2100);
    expect(again!.startedAt).toBe(1000);
    expect(again!.seq).toBe(2);
    expect(frameAt(again, 9000).action).toBe('think');
  });

  it('a held state that already ended starts afresh', () => {
    const e = onEvent(begin('think', 1000), 'move', 5000);
    expect(onArrival(e, 'think', 2, 6000)!.startedAt).toBe(6000);
  });
});

describe('a landing nobody watched', () => {
  it('plays no gesture, and a held state shows as it is', () => {
    expect(onArrival(null, 'click', 1, 0, false)).toBeNull();
    expect(onArrival(null, 'error', 1, 0, false)).toBeNull();
    const look = onArrival(null, 'look', 1, 0, false)!;
    expect(frameAt(look, 10)).toMatchObject({ action: 'look', gesture: false });
  });
});

describe("type's caret", () => {
  it('blinks while text arrives, is solid while held, and goes 0.4 s after the state ends', () => {
    let e: Expression | null = begin('type', 1000);
    expect(frameAt(e, 1000).blinking).toBe(true);
    expect(frameAt(e, 1000 + AGENT_CURSOR_TYPE.blinkMs).blinking).toBe(false);
    e = onKeystroke(e, 3000);
    expect(frameAt(e, 3000 + AGENT_CURSOR_TYPE.blinkMs - 1).blinking).toBe(true);
    e = onEvent(e, 'move', 5000);
    expect(frameAt(e, 5000)).toMatchObject({ action: 'type', lingering: true });
    expect(frameAt(e, 5000 + AGENT_CURSOR_TYPE.lingerMs - 1).lingering).toBe(true);
    expect(frameAt(e, 5000 + AGENT_CURSOR_TYPE.lingerMs).action).toBeNull();
  });

  it('a type event on a type state is a keystroke', () => {
    const e = onArrival(begin('type', 1000), 'type', 2, 4000);
    expect(e!.keystrokeAt).toBe(4000);
    expect(e!.startedAt).toBe(1000);
  });

  it('keystrokes only count for type', () => {
    const e = begin('think', 1000);
    expect(onKeystroke(e, 2000)).toBe(e);
  });
});

describe('the next change', () => {
  it('is the gesture end, the minimum, the sweep end or the blink end', () => {
    expect(nextChangeAt(begin('run', 1000), 1000)).toBe(1000 + AGENT_CURSOR_RUN.orbitMs);
    expect(nextChangeAt(begin('look', 1000), 1000)).toBe(1000 + AGENT_CURSOR_LOOK.sweepMs);
    expect(nextChangeAt(onEvent(begin('think', 1000), 'move', 1100), 1100)).toBe(1400);
    expect(nextChangeAt(begin('type', 1000), 1000)).toBe(1000 + AGENT_CURSOR_TYPE.blinkMs);
    expect(nextChangeAt(begin('think', 1000), 1000)).toBeNull();
  });
});

describe('spring curves for CSS (springs only)', () => {
  it('an impulse leaves 0, peaks at 1 and ends at 0; a low-damping one overshoots below 0', () => {
    const values = (easing: string) => easing.slice(7, -1).split(', ').map(Number);
    const shake = values(impulseCurve(AGENT_CURSOR_SHAKE_SPRING).easing);
    expect(shake[0]).toBe(0);
    expect(shake[shake.length - 1]).toBe(0);
    expect(Math.max(...shake)).toBe(1);
    expect(Math.min(...shake)).toBeLessThan(-0.2);
    const step = values(stepCurve({ stiffness: 170, damping: 26, mass: 1 }).easing);
    expect(step[0]).toBe(0);
    expect(step[step.length - 1]).toBe(1);
  });
});
