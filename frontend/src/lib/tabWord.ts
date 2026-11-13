import { inDesktopShell } from './personSession';

/**
 * The shared tab/window word (GM r29 on PR #199): a line that names the
 * place the person works in says "tab" in the browser and "window" in the
 * desktop app (personSession's inDesktopShell, the preload bridge, which is
 * there before any module loads, so a line built at load time is right).
 * Every line with "tab" or "window" uses it, never a hard-coded word.
 */
export function tabWord(desktop: boolean = inDesktopShell()): 'tab' | 'window' {
  return desktop ? 'window' : 'tab';
}
