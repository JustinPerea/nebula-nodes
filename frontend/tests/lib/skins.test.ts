import { beforeEach, describe, expect, it } from 'vitest';
import { applySkinBodyClass, DEFAULT_SKIN, loadSkin, persistSkin } from '../../src/lib/skins';

describe('skins', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.className = '';
  });

  it('uses Slava Restraint as the fresh-session default', () => {
    expect(DEFAULT_SKIN).toBe('slava-restraint');
    expect(loadSkin()).toBe('slava-restraint');
  });

  it('keeps explicitly persisted legacy skins selectable', () => {
    persistSkin('default');
    expect(loadSkin()).toBe('default');

    persistSkin('hermes');
    expect(loadSkin()).toBe('hermes');
  });

  it('preserves the Hermes tone migration when no skin is saved', () => {
    window.localStorage.setItem('nebula:hermes-tone', 'classic');
    expect(loadSkin()).toBe('hermes');
  });

  it('applies only the active skin body class', () => {
    applySkinBodyClass('slava-restraint', { animate: false });
    expect(document.body.classList.contains('app-slava-restraint')).toBe(true);

    applySkinBodyClass('hermes', { animate: false });
    expect(document.body.classList.contains('app-slava-restraint')).toBe(false);
    expect(document.body.classList.contains('app-hermes')).toBe(true);

    applySkinBodyClass('default', { animate: false });
    expect(document.body.classList.contains('app-hermes')).toBe(false);
    expect(document.body.className).toBe('');
  });
});
