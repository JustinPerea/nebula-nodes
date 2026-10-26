import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import '../../styles/prompt-dialog.css';
import {
  CONFIRM_LINE, EDITS_DOWNLOAD_HEADING, EDITS_NOT_WRITTEN, UNSAVED_EDITS_HEADING, agentOpeningLine, keptConfirmLine,
} from './unsavedEditsCopy';
import { TOO_BIG_TO_DOWNLOAD } from '../../lib/graphFileShared';

/**
 * Q116 a) (Justin, 2026-10-23): "a): "Download your edits" plus "Continue
 * without them"." A stale tab's unsaved edits that Nebula refused for good
 * as a recovered project (store/projectStore.ts holdRefusedEdits). GM -
 * Design's copy, verbatim. Kept in the startup entry with Projects home: the
 * screen shows up when Nebula was updated under the tab, exactly when an old
 * build's deferred chunk may be gone.
 *
 * The held edits' screen: announced as the screen's errors are (an alert),
 * "Download your edits" first and primary, "Continue without them" asks first.
 * After a download that couldn't be written (`downloadFailed`), GM's line 2
 * is the body in place of the reason; the heading and both choices stay.
 * After a download past the browser's string cap (`downloadTooBig`), GM's
 * pair (2026-10-25): "Couldn't download your edits." over "It's too big to
 * download in a browser."; both choices stay.
 * `keptIn`: the edits are the open project's own canvas, kept in that
 * project by the backend's switch, and the confirm says so (Q118 review).
 * `agentOpening`: an agent's switch is what left the project; GM's line
 * (2026-10-24) names it and the project it opens, above the rest. */
export function UnsavedEditsNotice({ reason, downloadFailed = false, downloadTooBig = false, keptIn, agentOpening, busy, onDownload, onContinue }: {
  reason: string; downloadFailed?: boolean; downloadTooBig?: boolean; keptIn?: string; agentOpening?: { agent: string; projectName: string };
  busy: boolean; onDownload: () => void; onContinue: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const continueButton = useRef<HTMLButtonElement>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);
  // A cancelled save picker: Download was disabled while it waited, which
  // drops focus from it. Give it back once the choices are live again, if
  // focus went nowhere else (Q116 a review).
  const wasBusy = useRef(busy);
  useEffect(() => {
    const was = wasBusy.current;
    wasBusy.current = busy;
    if (!was || busy) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) downloadButton.current?.focus();
  }, [busy]);
  return (
    <div className="project-home__error project-home__edits" role="alert">
      <span className="project-home__edits-text">
        {agentOpening && <span>{agentOpeningLine(agentOpening.agent, agentOpening.projectName)}</span>}
        <strong className="project-home__edits-heading">{downloadTooBig ? EDITS_DOWNLOAD_HEADING : UNSAVED_EDITS_HEADING}</strong>
        <span>{downloadTooBig ? TOO_BIG_TO_DOWNLOAD : downloadFailed ? EDITS_NOT_WRITTEN : reason}</span>
      </span>
      <span className="project-home__edits-actions">
        <button type="button" ref={downloadButton} className="project-home__edits-primary" disabled={busy} onClick={onDownload}>Download your edits</button>
        <button type="button" ref={continueButton} disabled={busy} onClick={() => setConfirming(true)}>Continue without them</button>
      </span>
      {confirming && <ContinueWithoutEditsConfirm line={keptIn ? keptConfirmLine(keptIn) : CONFIRM_LINE}
        onCancel={() => { setConfirming(false); continueButton.current?.focus(); }}
        onConfirm={() => { setConfirming(false); onContinue(); }} />}
    </div>
  );
}

/** GM's confirm, in the app's own dialog (never window.confirm): focus on
 * Cancel, Escape is Cancel, Tab stays inside. */
function ContinueWithoutEditsConfirm({ line, onCancel, onConfirm }: {
  line: string; onCancel: () => void; onConfirm: () => void;
}) {
  const lineId = useId();
  const card = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Tab') {
      const buttons = card.current?.querySelectorAll<HTMLElement>('button');
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  return createPortal(
    <div className="prompt-dialog">
      <div ref={card} className="prompt-dialog__card" role="alertdialog" aria-modal="true" aria-labelledby={lineId}
        onKeyDown={onKeyDown}>
        <p id={lineId} className="prompt-dialog__line">{line}</p>
        <div className="prompt-dialog__actions">
          <button type="button" className="prompt-dialog__danger" onClick={onConfirm}>Continue without them</button>
          <button type="button" ref={cancel} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
