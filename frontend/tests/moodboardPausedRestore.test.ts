import { afterEach, describe, expect, it } from 'vitest';
import { cascaded } from './helpers/cssCascade';

/**
 * #210 round 6q (GM r95): offline, the project line's Restore project is
 * aria-disabled (it keeps focus, a press pulses the banner). It takes the
 * paused look every other paused control has (styles/disabled-buttons.css,
 * the outline list: grey label, faint edge, no fill, no extra opacity, and no
 * hover change), not the toolbar button's enabled look under the 0.6 lock.
 */
const PAUSED = ['color', 'border-color', 'background', 'box-shadow', 'opacity'];

const button = (className: string, paused: boolean) => {
  document.body.className = 'app-slava-restraint';
  const line = document.createElement('div');
  line.className = 'moodboard-studio__notice moodboard-studio__notice--neutral moodboard-studio__notice--action';
  const it = document.createElement('button');
  it.className = className;
  if (paused) {
    it.setAttribute('aria-disabled', 'true');
    it.setAttribute('data-offline-disabled', '');
  }
  line.append(it);
  document.body.append(line);
  return it;
};
/** The winning value of each property, at rest and on hover. */
const look = (element: Element) => {
  const won = cascaded(element);
  return Object.fromEntries(PAUSED.flatMap((prop) => ['', ':hover'].map((state) => [`${state}|${prop}`, won.get(`${state}|${prop}`)?.value ?? null])));
};

afterEach(() => { document.body.innerHTML = ''; document.body.className = ''; });

describe('Restore project offline looks paused (GM r95)', () => {
  const RESTORE = 'moodboard-studio-toolbar__button moodboard-studio__notice-action';

  it('the same look as another paused outline button (the proposal card\'s), at rest and on hover', () => {
    const restore = look(button(RESTORE, true));
    const other = look(button('proposal-bar__button', true));
    expect(restore).toEqual(other);
    expect(restore['|color']).toMatch(/--disabled-label/);
    expect(restore['|opacity']).toBe('1');
    expect(restore[':hover|color']).toMatch(/--disabled-label/);
  });

  it('enabled, it keeps its own look (the paused one is only for aria-disabled)', () => {
    const live = look(button(RESTORE, false));
    expect(live['|color']).toBe('var(--sr-ink)');
    expect(live[':hover|color']).toBe('#f59e0b');
  });
});
