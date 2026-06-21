/**
 * Browser-side job-completion notifications. Pure glue around the Notification
 * API, the tab title, the favicon, and a WebAudio beep — the graph store calls
 * `notifyJobComplete` on `graphComplete`/`validationError`, and `startWorkingBadge`
 * when a run begins. Everything is feature-detected and exception-guarded so a
 * missing API or a tainted favicon never breaks execution.
 */

export interface NotificationPrefs {
  enabled: boolean;
  sound: boolean;
}

export const NOTIFICATIONS_KEY = 'nebula:notifications';
export const LONG_JOB_THRESHOLD_SEC = 30;

export function getNotificationPrefs(): NotificationPrefs {
  if (typeof window === 'undefined') return { enabled: false, sound: false };
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_KEY);
    if (!raw) return { enabled: false, sound: false };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { enabled: !!parsed.enabled, sound: !!parsed.sound };
  } catch {
    return { enabled: false, sound: false };
  }
}

export function setNotificationPrefs(prefs: NotificationPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota/availability errors */
  }
}

/** Request Notification permission (must be called from a user gesture). */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

/** Pure decision helper — unit-testable without the DOM. */
export function shouldNotifyFor(opts: {
  hidden: boolean;
  durationSec: number;
  threshold: number;
  enabled: boolean;
}): boolean {
  if (!opts.enabled) return false;
  return opts.hidden || opts.durationSec >= opts.threshold;
}

// --- tab title + favicon badge -------------------------------------------------

let originalTitle: string | null = null;
let originalFavicon: string | null = null;
let restoreArmed = false;

function faviconLink(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

let visibilityHandler: (() => void) | null = null;

function armRestore(): void {
  if (restoreArmed || typeof document === 'undefined') return;
  restoreArmed = true;
  const onVisible = () => {
    if (!document.hidden) restoreBadges();
  };
  visibilityHandler = onVisible;
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', restoreBadges, { once: true });
}

function restoreBadges(): void {
  if (typeof document === 'undefined') return;
  if (originalTitle !== null) {
    document.title = originalTitle;
    originalTitle = null;
  }
  const link = faviconLink();
  if (link && originalFavicon !== null) {
    link.href = originalFavicon;
    originalFavicon = null;
  }
  // Remove the visibility listener we armed so repeated runs don't stack handlers.
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  restoreArmed = false;
}

/** Show a "working" tab-title badge while the tab is backgrounded. Idempotent. */
export function startWorkingBadge(): void {
  if (typeof document === 'undefined') return;
  if (!document.hidden) return; // only badge when the user isn't watching
  if (originalTitle === null) originalTitle = document.title;
  document.title = `● Working… — ${baseTitle()}`;
  armRestore();
}

function baseTitle(): string {
  const base = originalTitle ?? (typeof document !== 'undefined' ? document.title : 'Nebula Nodes');
  // Strip any prior badge prefix so we don't stack them.
  return base.replace(/^([●✓✗]\s.*?—\s)/, '').trim() || 'Nebula Nodes';
}

function setFaviconDot(color: string): void {
  const link = faviconLink();
  if (!link || typeof document === 'undefined') return;
  try {
    if (originalFavicon === null) originalFavicon = link.href;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        ctx.beginPath();
        ctx.arc(size - 8, 8, 7, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        link.href = canvas.toDataURL('image/png');
      } catch {
        /* tainted canvas etc. — title badge still applies */
      }
    };
    img.src = link.href;
  } catch {
    /* ignore — title-only fallback */
  }
}

// --- completion sound ----------------------------------------------------------

let audioCtx: AudioContext | null = null;

/** Create/resume the AudioContext from a user gesture so later beeps are allowed. */
export function primeAudio(): void {
  if (typeof window === 'undefined') return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep(ok: boolean): void {
  try {
    if (!audioCtx) primeAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const tones = ok ? [660, 880] : [330];
    tones.forEach((freq, i) => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch {
    /* audio is best-effort */
  }
}

// --- completion entry point ----------------------------------------------------

export function notifyJobComplete(opts: {
  ok: boolean;
  durationSec: number;
  nodesExecuted: number;
  message?: string;
}): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const prefs = getNotificationPrefs();
  const hidden = document.hidden;
  const fire = shouldNotifyFor({
    hidden,
    durationSec: opts.durationSec,
    threshold: LONG_JOB_THRESHOLD_SEC,
    enabled: prefs.enabled,
  });
  if (!fire) {
    // Still restore any working badge that may be showing.
    restoreBadges();
    return;
  }

  // Tab title + favicon badge while backgrounded.
  if (hidden) {
    if (originalTitle === null) originalTitle = document.title;
    document.title = `${opts.ok ? '✓ Done' : '✗ Failed'} — ${baseTitle()}`;
    setFaviconDot(opts.ok ? '#34c759' : '#ff3b30');
    armRestore();
  } else {
    restoreBadges();
  }

  // OS notification.
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const body =
        opts.message ??
        `${opts.nodesExecuted} ${opts.nodesExecuted === 1 ? 'node' : 'nodes'} · ${opts.durationSec.toFixed(1)}s`;
      const n = new Notification(opts.ok ? 'Pipeline complete' : 'Pipeline failed', {
        body,
        icon: '/favicon.svg',
        tag: 'nebula-job',
        // Always suppress the OS sound: when sound is on we play our own tone via
        // beep(); when it's off the user wants silence. Either way the OS must not ding.
        silent: true,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* notification construction can throw on some platforms */
    }
  }

  if (prefs.sound) beep(opts.ok);
}
