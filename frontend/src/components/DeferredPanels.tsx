import { Suspense, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import {
  DeferredAgentLog,
  DeferredAgentNoteOutlineLayer,
  DeferredAgentNotes,
  DeferredAssetsPanel,
  DeferredChatPanel,
  DeferredCommandPalette,
  DeferredConnectionPopup,
  DeferredMaskPainterModal,
  DeferredNodeInspectorPopover,
  DeferredOnboardingOverlay,
  DeferredRunHistoryPanel,
} from '../lib/deferredChunks';
import { CHAT_SEND_EVENT, type ChatSendDetail } from '../lib/chatSend';
import { COMMAND_PALETTE_OPEN_EVENT, isPaletteHotkey, paletteOpenRequestApplies } from '../lib/commandPaletteKeys';
import { dropIntent, heldIntent, holdIntent, isIntentClaimed } from '../lib/heldIntents';
import { DeferredBoundary } from './DeferredBoundary';
import { CONNECTION_LOST_SHORT_COPY } from '../lib/errorCopy';

/**
 * Run History, the onboarding tour and the canvas connection popup ("add a
 * next step" after dropping a wire), loaded on first open.
 *
 * None of them draws anything while closed, so each stays unmounted until it is
 * first opened and then stays mounted (its own exit animation, focus return
 * and Escape handling run exactly as before). App.tsx preloads the chunks on
 * idle, so a first open from the rail, the command palette, the help button
 * or a wire drop renders synchronously. If an open beats the preload the fallback is empty,
 * the same nothing the closed panel draws, and the panel's own entrance plays
 * once when it arrives.
 */
/**
 * Whether the piece has ever been opened, and a count of opens: each new open
 * is an intent to load it, so a chunk that failed retries on the next one
 * (DeferredBoundary's `retryKey`). A failed open also closes the piece again
 * (`onChunkError`), so the rail, the Help button or the next wire drop is an
 * open, not a toggle off of something that draws nothing.
 */
function useOpens(open: boolean): { opened: boolean; opens: number } {
  const [seen, setSeen] = useState({ open, opens: open ? 1 : 0 });
  if (open !== seen.open) setSeen({ open, opens: seen.opens + (open ? 1 : 0) });
  const opens = seen.opens + (open && !seen.open ? 1 : 0);
  return { opened: opens > 0, opens };
}

const closeRunHistory = () => {
  const ui = useUIStore.getState();
  if (ui.panels.history.visible) ui.togglePanel('history');
};
const closeTour = () => useUIStore.setState({ onboardingActive: false, onboardingStep: 0 });
const closeConnectionPopup = () => useUIStore.getState().hideConnectionPopup();

/**
 * The Agent log (bottom right on the canvas). Unlike the panels below it shows
 * at once, with nothing opened first, so it mounts straight away and simply
 * appears when its chunk lands; the empty fallback is what a hidden log draws.
 * If the chunk fails it retries when the browser is back online or the window
 * regains focus (DeferredBoundary), since there is no open to retry on.
 */
export function AgentLog() {
  return (
    <DeferredBoundary chunk={DeferredAgentLog} failed={null}>
      <Suspense fallback={null}>
        <DeferredAgentLog />
      </Suspense>
    </DeferredBoundary>
  );
}

/**
 * The Updates corner in the canvas's top right (PR9a). Like the Agent log it
 * shows at once, so it mounts straight away and appears when its chunk
 * lands; until then (or if the chunk fails, until it retries on focus or
 * reconnect) the store keeps counting, so the chip arrives with the count.
 */
export function AgentNotes() {
  return (
    <DeferredBoundary chunk={DeferredAgentNotes} failed={null}>
      <Suspense fallback={null}>
        <DeferredAgentNotes />
      </Suspense>
    </DeferredBoundary>
  );
}

/** The Updates outlines; mounted inside Canvas (it needs React Flow's viewport). */
export function AgentNoteOutlines() {
  return (
    <DeferredBoundary chunk={DeferredAgentNoteOutlineLayer} failed={null}>
      <Suspense fallback={null}>
        <DeferredAgentNoteOutlineLayer />
      </Suspense>
    </DeferredBoundary>
  );
}

export function RunHistoryPanel() {
  const { opened, opens } = useOpens(useUIStore((s) => s.panels.history.visible));
  if (!opened) return null;
  return (
    <DeferredBoundary chunk={DeferredRunHistoryPanel} retryKey={opens} onChunkError={closeRunHistory} failed={null}>
      <Suspense fallback={null}>
        <DeferredRunHistoryPanel />
      </Suspense>
    </DeferredBoundary>
  );
}

export function OnboardingOverlay() {
  const { opened, opens } = useOpens(useUIStore((s) => s.onboardingActive));
  if (!opened) return null;
  return (
    <DeferredBoundary chunk={DeferredOnboardingOverlay} retryKey={opens} onChunkError={closeTour} failed={null}>
      <Suspense fallback={null}>
        <DeferredOnboardingOverlay />
      </Suspense>
    </DeferredBoundary>
  );
}

/** Mounted inside Canvas (it needs the React Flow context), like the original. */
export function ConnectionPopup() {
  const { opened, opens } = useOpens(useUIStore((s) => s.connectionPopup.visible));
  if (!opened) return null;
  return (
    <DeferredBoundary chunk={DeferredConnectionPopup} retryKey={opens} onChunkError={closeConnectionPopup} failed={null}>
      <Suspense fallback={null}>
        <DeferredConnectionPopup />
      </Suspense>
    </DeferredBoundary>
  );
}

/**
 * The mask painter opens only from the Inspector's Paint Mask button, which
 * preloads it on hover and focus (and App preloads it on idle). If the click
 * still beats the chunk, the fallback is the painter's own overlay and header
 * (with its Close) in the state it shows while it reads the image size, so the
 * dialog appears at once and fills in. If the chunk cannot load, the same
 * shell says so, with Try again next to Close (DeferredBoundary). The next
 * Paint Mask mounts it afresh, which fetches again too.
 */
function MaskPainterShell({ children, onClose, busy = false }: { children: ReactNode; onClose: () => void; busy?: boolean }) {
  return (
    <div className="mask-painter__overlay" role="dialog" aria-label="Mask painter" aria-busy={busy || undefined}>
      <div className="mask-painter__panel">
        <div className="mask-painter__header">
          <span className="mask-painter__title">Paint Mask</span>
          <button type="button" className="mask-painter__icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function MaskPainterModal(props: ComponentProps<typeof DeferredMaskPainterModal>) {
  return (
    <DeferredBoundary
      chunk={DeferredMaskPainterModal}
      failed={({ retry, retrying }) => (
        <MaskPainterShell onClose={props.onClose} busy={retrying}>
          {/* GM's WRAP rule (round 3b): Try again is beside it and loads it again.
              Round 3f: the server is on this computer, not "your connection". */}
          <div className="mask-painter__empty" role="alert">Couldn't load the mask painter. {CONNECTION_LOST_SHORT_COPY}</div>
          <div className="mask-painter__toolbar">
            <div className="mask-painter__spacer" />
            <button type="button" className="mask-painter__cancel" onClick={props.onClose}>Close</button>
            {/* aria-disabled, not disabled: a disabled button drops keyboard focus to the page. */}
            <button type="button" className="mask-painter__save" onClick={retry} aria-disabled={retrying || undefined}>
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
          </div>
        </MaskPainterShell>
      )}
    >
      <Suspense
        fallback={(
          <MaskPainterShell onClose={props.onClose} busy>
            <div className="mask-painter__empty" role="status">Loading the mask painter…</div>
          </MaskPainterShell>
        )}
      >
        <DeferredMaskPainterModal {...props} />
      </Suspense>
    </DeferredBoundary>
  );
}


/**
 * A failed chat chunk closes the chat and forgets a send held for it: the
 * open that send made showed nothing, so a later open (or a focus that
 * brings the chunk in) must not replay an old Enhance message.
 */
const closeChat = () => {
  dropIntent('chat-send');
  const ui = useUIStore.getState();
  if (ui.panels.chat.visible) ui.togglePanel('chat');
};
const closeInspector = () => useUIStore.getState().setInspectorVisible(false);
const closeAssets = () => {
  const ui = useUIStore.getState();
  if (ui.leftDock === 'assets') ui.setLeftDock(null);
};

/**
 * The chat (second pass, 2026-10-22). Closed at every start, but it checks the
 * agent's login while closed, so the first open already shows the status: it
 * mounts straight away, like the Agent log, and its closed state is the
 * nothing it drew before. A node's Enhance (or the palette's agent query) that
 * sends to the chat before the chunk lands is held here: the chat opens at
 * once (the launcher shows it), and the panel takes the message into its input
 * when it arrives (lib/heldIntents.ts). A failed chunk closes the chat again,
 * forgets the held send, and retries on the next open, when back online, or
 * on focus.
 */
export function ChatPanel() {
  const { opens } = useOpens(useUIStore((s) => s.panels.chat.visible));
  useEffect(() => {
    const onSend = (event: Event) => {
      if (isIntentClaimed('chat-send')) return;
      const detail = (event as CustomEvent<ChatSendDetail | undefined>).detail;
      if (!String(detail?.message ?? '').trim()) return;
      holdIntent('chat-send', detail);
      if (!useUIStore.getState().panels.chat.visible) useUIStore.getState().togglePanel('chat');
    };
    window.addEventListener(CHAT_SEND_EVENT, onSend);
    return () => {
      window.removeEventListener(CHAT_SEND_EVENT, onSend);
      // Left this screen before the panel arrived: the send goes with it, as the chat's state does.
      if (!isIntentClaimed('chat-send')) dropIntent('chat-send');
    };
  }, []);
  return (
    <DeferredBoundary chunk={DeferredChatPanel} retryKey={opens} onChunkError={closeChat} failed={null}>
      <Suspense fallback={null}>
        <DeferredChatPanel />
      </Suspense>
    </DeferredBoundary>
  );
}

/**
 * The node Inspector popover (with the Inspector inside). Hidden at every
 * start; it opens on a node's intent (its settings button, a double click), so
 * it mounts on the first open and stays mounted, like Run History.
 */
export function NodeInspectorPopover() {
  const { opened, opens } = useOpens(useUIStore((s) => s.panels.inspector.visible));
  if (!opened) return null;
  return (
    <DeferredBoundary chunk={DeferredNodeInspectorPopover} retryKey={opens} onChunkError={closeInspector} failed={null}>
      <Suspense fallback={null}>
        <DeferredNodeInspectorPopover />
      </Suspense>
    </DeferredBoundary>
  );
}

/**
 * The Assets dock. App mounts it only while open (closed at every start), so
 * each open is a new mount, which retries a chunk that failed before.
 */
export function AssetsPanel() {
  return (
    <DeferredBoundary chunk={DeferredAssetsPanel} onChunkError={closeAssets} failed={null}>
      <Suspense fallback={null}>
        <DeferredAssetsPanel />
      </Suspense>
    </DeferredBoundary>
  );
}

/**
 * The ⌘K palette. It draws nothing until opened, so it mounts straight away
 * and arrives on its own. A ⌘K or a rail open that beats the chunk is held
 * here (a second ⌘K takes it back, as it would close the palette) and the
 * palette opens as soon as it lands (lib/heldIntents.ts); from then on the
 * palette owns the hotkey. If the chunk failed, each held open is an intent
 * that tries it again (`retryKey`), and a load that fails drops the hold
 * (`onChunkError`), so a later focus or reconnect that brings the chunk in
 * never opens the palette for an old ⌘K.
 */
const dropPaletteIntent = () => dropIntent('command-palette');

export function CommandPalette() {
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isIntentClaimed('command-palette') || !isPaletteHotkey(event)) return;
      event.preventDefault();
      if (heldIntent('command-palette')) dropIntent('command-palette');
      else {
        holdIntent('command-palette', true);
        setAsks((n) => n + 1);
      }
    };
    const onOpenRequest = () => {
      if (isIntentClaimed('command-palette') || !paletteOpenRequestApplies()) return;
      holdIntent('command-palette', true);
      setAsks((n) => n + 1);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
      // Left this screen before the palette arrived: it would have closed with it.
      if (!isIntentClaimed('command-palette')) dropIntent('command-palette');
    };
  }, []);
  return (
    <DeferredBoundary chunk={DeferredCommandPalette} retryKey={asks} onChunkError={dropPaletteIntent} failed={null}>
      <Suspense fallback={null}>
        <DeferredCommandPalette />
      </Suspense>
    </DeferredBoundary>
  );
}
