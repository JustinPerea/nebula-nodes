const KEY = 'extraction.token'
const PREFIX = '#token='

let held: string | null = null

function readStored(win: Window): string | null {
  try {
    return win.sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

/**
 * Take the launch token from the address fragment (`#token=...`), keep it for this tab and
 * clear the fragment so it isn't left in the address bar or history. With no fragment, the
 * token kept earlier in this tab is used. Returns null when there is none.
 */
export function takeToken(win: Window = window): string | null {
  const hash = win.location.hash
  if (hash.startsWith(PREFIX)) {
    const token = decodeURIComponent(hash.slice(PREFIX.length)).trim()
    win.history.replaceState(null, '', win.location.pathname + win.location.search)
    if (token) {
      held = token
      try {
        win.sessionStorage.setItem(KEY, token)
      } catch {
        // Storage can be blocked. The token stays in memory for this load.
      }
      return token
    }
  }
  return held ?? readStored(win)
}

/** Forget the held token (tests, and a refused token). */
export function forgetToken(win: Window = window): void {
  held = null
  try {
    win.sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to remove.
  }
}
