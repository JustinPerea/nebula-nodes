import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useUIStore } from '../store/uiStore';
import { studioBoundaryLine, studioBoundaryLogLine, studioDrawFailedLogLine, type DataProblem, type StudioScreen } from '../lib/studioBoundary';
import { WorkspaceHeader } from './WorkspaceHeader';

/** Each studio's own way back to the canvas (uiStore). The Commons' own exit
 * goes back where it was opened from (Create, a studio), which may be the
 * screen that failed, so its boundary goes to the canvas itself (PR #198
 * review 3, L6): "Back to canvas" always lands on the canvas. */
const EXIT: Record<StudioScreen, () => void> = {
  'cinema-editor': () => useUIStore.getState().exitCinemaEditor(),
  editor: () => useUIStore.getState().exitEditor(),
  'remotion-editor': () => useUIStore.getState().exitRemotionEditor(),
  'character-editor': () => useUIStore.getState().exitCharacterEditor(),
  'moodboard-editor': () => useUIStore.getState().exitMoodboardEditor(),
  create: () => useUIStore.getState().exitCreateView(),
  commons: () => useUIStore.setState({ viewMode: 'canvas' }),
  'brand-showcase': () => useUIStore.getState().exitBrandShowcase(),
};

/** The title each studio's header shows (its WorkspaceHeader's). */
const TITLE: Record<StudioScreen, string> = {
  'cinema-editor': 'Cinema',
  editor: 'Video editor',
  'remotion-editor': 'Composition',
  'character-editor': 'Character',
  'moodboard-editor': 'Moodboard',
  create: 'Creator Studio',
  commons: 'Commons',
  'brand-showcase': 'Showcase',
};

/** The studio's header inside the boundary, which can't take the app down
 * with it (review 4, L3): a header that throws gives a plain one with the
 * title and the way back. */
class SafeHeader extends Component<{ title: string; onBack: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error("A studio's header failed to render:", error);
  }

  render(): ReactNode {
    const { title, onBack } = this.props;
    if (!this.state.failed) return <WorkspaceHeader title={title} onBack={onBack} className="studio-boundary__header" />;
    return (
      <header className="workspace-header studio-boundary__header" aria-label="Workspace">
        <div className="workspace-header__identity">
          <button type="button" className="workspace-header__back" onClick={onBack} aria-label="Back to Canvas">
            Canvas
          </button>
          <h1 className="workspace-header__title">{title}</h1>
        </div>
      </header>
    );
  }
}

interface StudioBoundaryProps {
  studio: StudioScreen;
  /** The node the studio edits, when it edits one (Cinema, the editors). */
  node: { id: string; label: string | null } | null;
  /** The field the studio needed that isn't readable ("scene.base"), read
   * when it fails (lib/studioBoundary nodeDataProblem), with whether it is
   * missing or damaged (GM r6 item 4); a bare field name when the caller
   * can't tell; null when the data checks out. It decides the line:
   * "missing or damaged" only with a field. A check that throws counts as
   * damaged data. */
  problem: () => DataProblem | string | null;
  children: ReactNode;
}

/**
 * A studio that throws while it renders (a scene an older Nebula saved
 * without `base`, data an outside app damaged) shows GM's contained line
 * with Back to canvas, instead of taking the whole app down to a white
 * screen (PR #198 review 2, M2). GM, r3 (b): the studio's header stays
 * (project bar, back to Canvas, Updates, and the offline row under it); only
 * the body is replaced. The Agent log gets the node and the field; neither
 * line names who wrote the data. App keys it by screen and node, so opening
 * another one starts clean.
 *
 * Review 4, L3: data that checks out reads GM r5's neutral line ("…but its
 * data is fine. Reload Nebula to try again.") and the Agent log names the
 * error. It logs once per mount: it doesn't retry on data changes (App keys
 * it by screen and node), so review 5's L5 flood can't happen here. Nothing in the fallback can throw out of the boundary: the check is
 * caught and the header has its own boundary (SafeHeader).
 */
export class StudioBoundary extends Component<StudioBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /** What the check found; "data", unknown kind, when the check itself throws. */
  private field(): DataProblem | string | null {
    try { return this.props.problem(); } catch { return { field: 'data', state: 'unknown' }; }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A studio failed to render:', error, info.componentStack);
    const { node } = this.props;
    if (!node || typeof window === 'undefined') return;
    const field = this.field();
    const label = node.label || null;
    // GM r6 item 5 and r8: both lines name the studio, "Couldn't open “X” in
    // <studio>, node n4. …".
    const message = field ? studioBoundaryLogLine(label, node.id, field, this.props.studio)
      : studioDrawFailedLogLine(this.props.studio, label, node.id, error);
    window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', { detail: { source: 'system', message } }));
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { studio, node } = this.props;
    const exit = EXIT[studio];
    // A studio with no node (Create, the Commons) has no data to check.
    const damaged = node ? this.field() !== null : false;
    return (
      <div className="studio-boundary">
        <SafeHeader title={TITLE[studio]} onBack={exit} />
        <div className="studio-boundary__body">
          <div className="studio-boundary__card" role="alert">
            <p className="studio-boundary__line">{studioBoundaryLine(studio, node?.label || null, damaged)}</p>
            <button type="button" className="studio-boundary__back" onClick={exit}>
              Back to canvas
            </button>
          </div>
        </div>
      </div>
    );
  }
}
