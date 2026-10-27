import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useUIStore } from '../store/uiStore';
import { studioBoundaryLine, studioBoundaryLogLine, type StudioScreen } from '../lib/studioBoundary';
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

interface StudioBoundaryProps {
  studio: StudioScreen;
  /** The node the studio edits, when it edits one (Cinema, the editors). */
  node: { id: string; label: string | null } | null;
  /** The field the studio needed that isn't there ("scene.base"), read when
   * it fails, for the Agent log; null when nothing is missing. */
  problem: () => string | null;
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
 */
export class StudioBoundary extends Component<StudioBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A studio failed to render:', error, info.componentStack);
    const { node } = this.props;
    if (!node || typeof window === 'undefined') return;
    let field: string | null = null;
    try { field = this.props.problem(); } catch { field = null; }
    window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', {
      detail: { source: 'system', message: studioBoundaryLogLine(node.label, node.id, field) },
    }));
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { studio, node } = this.props;
    const exit = EXIT[studio];
    return (
      <div className="studio-boundary">
        <WorkspaceHeader title={TITLE[studio]} onBack={exit} className="studio-boundary__header" />
        <div className="studio-boundary__body">
          <div className="studio-boundary__card" role="alert">
            <p className="studio-boundary__line">{studioBoundaryLine(studio, node?.label || null)}</p>
            <button type="button" className="studio-boundary__back" onClick={exit}>
              Back to canvas
            </button>
          </div>
        </div>
      </div>
    );
  }
}
