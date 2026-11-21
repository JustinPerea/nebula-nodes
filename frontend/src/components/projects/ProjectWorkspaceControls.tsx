import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Home } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';
import { useGraphStore } from '../../store/graphStore';
import { besideButton } from '../../lib/errorCopy';
import { HEADER_TOOLTIP, headerLine } from '../../lib/savePausedCopy';
import { followingSwitch, openingLine, openingName, subscribeFollowingSwitch, subscribeFollowPulse, useFollowingSwitch } from '../../lib/canvasFollow';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';
import { isBackendOffline, refuseEditWhileOffline } from '../../lib/backendConnection';
import { keptLockTitle, useKeptCanvas } from '../../lib/keptCanvas';
import { KEPT_MARK } from '../../lib/canvasLock';
import { useSettleDelay } from '../../lib/saveSettle';
import './ProjectWorkspaceControls.css';

/** `onHome`: the screen's own way to Projects (the Commons asks first); `homeBusy`: it waits on a save. */
export function ProjectWorkspaceControls({ onHome, homeBusy = false }: { onHome?: (button: HTMLButtonElement) => void; homeBusy?: boolean }) {
  const project = useProjectStore((state) => state.activeProject);
  const screen = useProjectStore((state) => state.screen);
  const status = useProjectStore((state) => state.saveStatus);
  const busy = useProjectStore((state) => state.busy);
  const saveError = useProjectStore((state) => state.saveError);
  const pausedBytes = useProjectStore((state) => state.savePaused?.bytes ?? null);
  const panelOpen = useProjectStore((state) => state.sizePanelOpen);
  const nodeCount = useGraphStore((state) => state.nodes.length);
  const scenesUnsaved = useGraphStore((state) => Object.keys(state.unsavedScenes).length > 0);
  const settled = status === 'saved' && !scenesUnsaved;
  const settledDelay = useSettleDelay(settled);
  // Design, PR #114: while offline "Not saved" and Try again hide (the
  // banner says it); a retry couldn’t reach Nebula anyway.
  const offline = useBackendOffline();
  const failedLineId = useId();
  const failedLine = saveError ? besideButton(saveError) : 'Nebula couldn’t save the project. Try again.';
  const [draft, setDraft] = useState<string | null>(null);
  // While the tab follows an agent's switch the bar says
  // "Opening “<project>”…" where the save state is. It never gets narrower
  // than it was as the follow starts (measured then), and grows to fit the
  // name (PR #200: only a name past 24 characters is cut).
  const following = useFollowingSwitch();
  // Projects would strand a kept canvas (PR #199), so it holds, with the
  // kept line for its verb (a press pulses it).
  const kept = useKeptCanvas();
  const bar = useRef<HTMLDivElement | null>(null);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);
  // Measured when the follow starts, before the bar redraws with the line.
  useEffect(() => subscribeFollowingSwitch(() => {
    const measured = bar.current?.getBoundingClientRect().width ?? null;
    setLockedWidth((width) => (followingSwitch() ? width ?? measured : null));
  }), []);
  // The canvas pill is centred, so a bar that grows would move the Canvas
  // and Creator Studio tabs after it. While following, the pill grows to
  // the left instead: it is shifted by half of what the bar grew
  // (CanvasTabs.css --follow-grow), and the tabs stay put.
  useLayoutEffect(() => {
    const wrap = bar.current?.closest<HTMLElement>('.canvas-tabs-wrap');
    if (!wrap) return;
    const grew = following && lockedWidth !== null
      ? Math.max(0, Math.round((bar.current?.getBoundingClientRect().width ?? lockedWidth) - lockedWidth)) : 0;
    if (grew === 0) return;
    wrap.style.setProperty('--follow-grow', `${grew}px`);
    return () => { wrap.style.removeProperty('--follow-grow'); };
  });
  // While following, the pill sits above a full-screen modal's scrim (the
  // mask painter's), so the bar that says why it is read-only shows
  // (slava-restraint.css .canvas-tabs-wrap[data-following]).
  useLayoutEffect(() => {
    const wrap = bar.current?.closest<HTMLElement>('.canvas-tabs-wrap');
    if (!wrap || !following) return;
    wrap.setAttribute('data-following', '');
    return () => { wrap.removeAttribute('data-following'); };
  }, [following]);
  // A refused edit nudges the line (lib/canvasFollow.ts pulseFollowing).
  const [pulse, setPulse] = useState(0);
  useEffect(() => subscribeFollowPulse(() => setPulse((count) => count + 1)), []);
  if (!project || screen !== 'workspace') return null;
  const finishRename = (save: boolean) => {
    const name = draft?.trim() ?? '';
    if (save && name && name !== project.name) void useProjectStore.getState().rename(project.id, name);
    setDraft(null);
  };
  // The bar follows the card: a scene card with edits Nebula doesn't have
  // makes the bar say "Unsaved changes" too. It wins over the project's own
  // "Saving…", which would read as safe.
  const label = status === 'error' ? 'Save failed' : scenesUnsaved ? 'Unsaved changes'
    : status === 'saving' ? 'Saving…' : status === 'unsaved' ? 'Unsaved changes' : 'Saved';
  return (
    <div ref={bar} className={`project-workspace-controls${following ? ' project-workspace-controls--following' : ''}`}
      // While following, the whole bar names the project being opened in
      // full (its tooltip and label); the slot may cut it.
      {...(following ? { role: 'group', title: openingLine(following.projectName), 'aria-label': openingLine(following.projectName) } : {})}
      style={following && lockedWidth ? { minWidth: lockedWidth } : undefined}>
      <button type="button" className="project-workspace-controls__home" aria-label={homeBusy ? 'Saving…' : 'Back to projects'}
        aria-busy={homeBusy || undefined} {...(kept ? { [KEPT_MARK]: '', disabled: true, title: keptLockTitle('home') }
          : { title: 'Projects', disabled: busy })}
        onClick={(event) => (onHome ? onHome(event.currentTarget) : void useProjectStore.getState().goHome())}>
        <Home size={16} aria-hidden="true" />
        {homeBusy && <span className="project-workspace-controls__busy">Saving…</span>}
      </button>
      {following
        // The old project's name goes; the name slot reads
        // "Opening “<project>”…", the name in full. Only a name past 24
        // characters is cut inside itself (openingName), keeping the closing
        // quote and ellipsis; the title and label keep all of it.
        ? <span key={pulse} className={`project-workspace-controls__opening${pulse > 0 ? ' project-workspace-controls__opening--pulse' : ''}`}
            role="status" title={openingLine(following.projectName)} aria-label={openingLine(following.projectName)}>
            <span className="project-workspace-controls__opening-fixed" aria-hidden="true">Opening “</span>
            {/* Its own direction: an RTL name, with its "…"
                inside, reads cut at its logical end. */}
            <bdi className="project-workspace-controls__opening-name" aria-hidden="true">{openingName(following.projectName)}</bdi>
            <span className="project-workspace-controls__opening-fixed" aria-hidden="true">”…</span>
          </span>
        : draft !== null
        ? <input className="project-workspace-controls__name project-workspace-controls__name-input" aria-label="Project name"
            autoFocus maxLength={120} value={draft} onFocus={(event) => event.target.select()}
            // Offline (PR #114): disabled with its draft kept, as a node's rename.
            disabled={offline} {...offlineMark(offline)}
            onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (!isBackendOffline()) finishRename(true); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); finishRename(true); }
              else if (event.key === 'Escape') { event.preventDefault(); finishRename(false); }
            }} />
        : <button type="button" className="project-workspace-controls__name" title={`${project.name} · double-click to rename`}
            aria-label={`Rename project ${project.name}`} disabled={busy}
            onDoubleClick={() => { if (!refuseEditWhileOffline()) setDraft(project.name); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'F2') {
                event.preventDefault();
                if (!refuseEditWhileOffline()) setDraft(project.name);
              }
            }}>{project.name}</button>}
      {following
        ? null
        : status === 'paused' && pausedBytes !== null
        // The persistent state, where "Saved" usually is, in Save failed's
        // warning colour; it opens the "what's large" panel.
        ? <button type="button" className="project-workspace-controls__retry project-workspace-controls__paused"
            data-size-status="" title={HEADER_TOOLTIP} aria-haspopup="dialog" aria-expanded={panelOpen}
            onClick={() => useProjectStore.getState().openSizePanel()}>{headerLine(pausedBytes)}</button>
        : status === 'error' && offline ? null
        : status === 'error'
        // This Try again saves, so the line it is described by is the save's own failure (in the because form,
        // ending in "Try again."), never another action's. The header says "Not saved" and keeps the sentence in
        // the button's title and its accessible description: a title is not read by every screen reader or shown on touch.
        ? <span className="project-workspace-controls__failed" role="group" aria-label="Save status">
            <span className="project-workspace-controls__not-saved">Not saved</span>
            <button type="button" className="canvas-undo-notice__action canvas-undo-notice__action--quiet project-workspace-controls__retry" title={failedLine} aria-describedby={failedLineId}
              onClick={() => void useProjectStore.getState().retrySave()}>Try again</button>
            <span id={failedLineId} hidden>{failedLine}</span>
          </span>
        : <span className={`project-workspace-controls__status${settled ? ' project-workspace-controls__status--settled' : ''}`}
            style={settledDelay ? { animationDelay: settledDelay } : undefined} role="status">{label}</span>}
      {/* While following, the save state and the count (the canvas that is going) give their room to the
          opening line, which takes the whole slot at the locked width. */}
      {!following && <span className="project-workspace-controls__count">{nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}</span>}
    </div>
  );
}
