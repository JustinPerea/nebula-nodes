import { Component, type ReactNode } from 'react';

interface DeferredBoundaryProps {
  /** What to draw if the chunk cannot load: the same placeholder as while loading, or a way out. */
  failed: ReactNode;
  children: ReactNode;
}

/**
 * Error boundary for a deferred chunk (lib/deferredChunks.ts). Before the
 * split these pieces lived in the startup entry and could not fail to load;
 * now a failed chunk fetch (the web build replaced under an open tab, a flaky
 * disk) rejects inside React.lazy. Without this boundary that error would
 * unmount the whole app. With it, only this piece shows `failed` and the
 * canvas around it keeps working. React.lazy keeps the rejection, so a reload
 * is what retries it.
 */
export class DeferredBoundary extends Component<DeferredBoundaryProps, { error: boolean }> {
  state = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[nebula] A deferred part of the app could not load; reload to retry.', error);
  }

  render() {
    return this.state.error ? this.props.failed : this.props.children;
  }
}
