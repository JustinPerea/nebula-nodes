import { Component, type ReactNode } from 'react';
import { isChunkLoadError, type DeferredChunk, type RetryTrigger } from '../lib/lazyWithPreload';

export interface DeferredRetryState {
  /** Try loading the chunk again now (the mask painter's Try again). */
  retry: () => void;
  /** A retry is in flight. */
  retrying: boolean;
}

interface DeferredBoundaryProps {
  /** The deferred component inside, from lib/deferredChunks.ts. */
  chunk: DeferredChunk;
  /**
   * What to draw if the chunk cannot load: the same placeholder as while
   * loading, or a way out (a function gets `retry` for a Try again button).
   */
  failed: ReactNode | ((state: DeferredRetryState) => ReactNode);
  /** Changes on each intent to open the piece; a change while failed retries once. */
  retryKey?: unknown;
  /** Called when the chunk fails to load (and when a retry fails), e.g. to close a panel that now draws nothing. */
  onChunkError?: () => void;
  children: ReactNode;
}

interface DeferredBoundaryState {
  error: boolean;
  /** The error was the chunk failing to load (retryable), not the loaded component throwing. */
  chunkError: boolean;
  retrying: boolean;
}

/**
 * Error boundary for a deferred chunk (lib/deferredChunks.ts). Before the
 * split these pieces lived in the startup entry and could not fail to load;
 * now a failed chunk fetch (the web build replaced under an open tab,
 * offline, a flaky disk) rejects inside React.lazy. Without this boundary that
 * error would unmount the whole app. With it, only this piece shows `failed`
 * and the canvas around it keeps working.
 *
 * A failed chunk loads again without a reload. While failed, the boundary
 * makes one load attempt per trigger: the next intent to open the piece (a new
 * `retryKey`, `retry` from `failed`, or a new mount that meets an old
 * failure), the window's 'online' event, and
 * window focus (skipped offline and spaced out by lazyWithPreload). It clears
 * its error only once the chunk is in, from its own attempt or anyone else's
 * (the idle preload, a hover, another piece using the same chunk), so the
 * piece renders synchronously with no loading fallback. A failed attempt
 * changes nothing on screen and schedules nothing, so a dead chunk never
 * loops. An error thrown by the loaded component itself is not retried, and
 * neither is a load error of another deferred chunk rendered inside this one
 * (that chunk's own boundary retries it). How an attempt reaches the network
 * in Chromium, which keeps a failed import, is in lib/lazyWithPreload.ts.
 */
export class DeferredBoundary extends Component<DeferredBoundaryProps, DeferredBoundaryState> {
  state: DeferredBoundaryState = { error: false, chunkError: false, retrying: false };

  private unsubscribe: (() => void) | undefined;
  private mounted = false;
  /** Failed to load and waiting for a trigger or for the chunk to arrive. */
  private waiting = false;
  /** Failed loads of the chunk before this boundary mounted. */
  private readonly failuresAtMount: number;

  constructor(props: DeferredBoundaryProps) {
    super(props);
    this.failuresAtMount = props.chunk.failures();
  }

  static getDerivedStateFromError(): Partial<DeferredBoundaryState> {
    return { error: true };
  }

  componentDidMount() {
    this.mounted = true;
    // StrictMode replays a mount (unmount, then mount) in development, and the
    // unmount took the listeners down (state may not show the error yet).
    if (this.waiting) this.listen();
  }

  componentDidCatch(error: unknown) {
    const { chunk } = this.props;
    // Only this boundary's own chunk: a deferred piece deeper down that failed
    // to load is its own boundary's to retry, and treating it as ours would
    // recover, draw it, catch it again, and loop.
    const chunkError = isChunkLoadError(error, chunk) || !chunk.isLoaded();
    if (!chunkError) {
      console.warn('[nebula] A deferred part of the app failed while drawing.', error);
      return;
    }
    console.warn('[nebula] A deferred part of the app could not load; it retries on the next open, when back online, or on focus.', error);
    this.props.onChunkError?.();
    // Someone else may have brought the chunk in between the rejection and now.
    if (chunk.isLoaded()) {
      this.recover();
      return;
    }
    this.setState({ chunkError: true });
    this.waiting = true;
    this.listen();
    // Mounting the piece is an intent to open it (the next Paint Mask). If the
    // failure it caught is an old one, from before this mount, fetch once now
    // (not while offline). If the load failed while this boundary was up, it
    // already tried.
    if (chunk.failures() === this.failuresAtMount) this.attempt('mount', true);
  }

  componentDidUpdate(prevProps: DeferredBoundaryProps) {
    if (this.state.chunkError && prevProps.retryKey !== this.props.retryKey) this.attempt('intent');
  }

  componentWillUnmount() {
    this.mounted = false;
    this.stopListening();
  }

  private readonly onOnline = () => this.attempt('online');
  private readonly onFocus = () => this.attempt('focus');
  private readonly retryNow = () => this.attempt('intent');

  private listen() {
    if (this.unsubscribe) return;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('focus', this.onFocus);
    const unsubscribeChunk = this.props.chunk.subscribe(() => this.recover());
    this.unsubscribe = () => {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('focus', this.onFocus);
      unsubscribeChunk();
    };
  }

  private stopListening() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private attempt(trigger: RetryTrigger, caught = false) {
    if (!(caught || this.state.chunkError) || this.state.retrying) return;
    this.setState({ retrying: true });
    this.props.chunk.retry(trigger).then(
      () => this.recover(),
      () => {
        if (!this.mounted) return;
        this.setState({ retrying: false });
        // The attempt failed too: close again what this open showed nothing for.
        this.props.onChunkError?.();
      },
    );
  }

  private recover() {
    this.waiting = false;
    this.stopListening();
    if (this.mounted) this.setState({ error: false, chunkError: false, retrying: false });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { failed } = this.props;
    return typeof failed === 'function' ? failed({ retry: this.retryNow, retrying: this.state.retrying }) : failed;
  }
}
