/** The address asks for the Commons (#commons, or view=commons among other keys). */
export function commonsRouteWanted(): boolean {
  return window.location.hash === '#commons'
    || new URLSearchParams(window.location.hash.slice(1)).get('view') === 'commons';
}

/** Take #commons (or view=commons) off the address without a new history entry. */
export function clearCommonsHash(): void {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (window.location.hash === '#commons' || hash.get('view') === 'commons') {
    hash.delete('view');
    const rest = window.location.hash === '#commons' ? '' : hash.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (rest ? `#${rest}` : ''));
  }
}
