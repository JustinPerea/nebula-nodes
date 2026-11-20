import { BackendConnectionStatus } from './BackendConnectionStatus';
import { firstLoadLineShown } from './projects/homeLine';
import { useProjectStore } from '../store/projectStore';

/** The offline banner as the app places it. Design: on Projects it stays away while the first-load
 * line is on screen (that line names what waits); it keeps probing, and returns once the line goes. */
export function ConnectionBanner({ placement }: { placement: 'home' | 'workspace' | 'studio' }) {
  const lineShown = useProjectStore(firstLoadLineShown);
  return <BackendConnectionStatus placement={placement} bannerHidden={placement === 'home' && lineShown} />;
}
