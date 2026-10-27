import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useUIStore } from '../store/uiStore';
import { studioBoundaryLine, studioBoundaryLogLine, type StudioScreen } from '../lib/studioBoundary';

/** Each studio's own way back (uiStore). The Commons goes back where it was
 * opened from; every other studio goes to the canvas. */
const EXIT: Record<StudioScreen, 'exitCinemaEditor' | 'exitEditor' | 'exitRemotionEditor' | 'exitCharacterEditor'
  | 'exitMoodboardEditor' | 'exitCreateView' | 'exitCommons' | 'exitBrandShowcase'> = {
  'cinema-editor': 'exitCinemaEditor',
  editor: 'exitEditor',
  'remotion-editor': 'exitRemotionEditor',
  'character-editor': 'exitCharacterEditor',
  'moodboard-editor': 'exitMoodboardEditor',
  create: 'exitCreateView',
  commons: 'exitCommons',
  'brand-showcase': 'exitBrandShowcase',
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
 * screen (PR #198 review 2, M2). The Agent log gets the node and the field;
 * neither line names who wrote the data. App keys it by screen and node, so
 * opening another one starts clean.
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
    return (
      <div className="studio-boundary">
        <div className="studio-boundary__card" role="alert">
          <p className="studio-boundary__line">{studioBoundaryLine(studio, node?.label || null)}</p>
          <button type="button" className="studio-boundary__back" onClick={() => useUIStore.getState()[EXIT[studio]]()}>
            Back to canvas
          </button>
        </div>
      </div>
    );
  }
}
