import { useEffect, useRef, useState } from 'react';
import { Home } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';
import { useGraphStore } from '../../store/graphStore';
import { shortLine } from '../../lib/errorCopy';
import { HEADER_TOOLTIP, headerLine } from '../../lib/savePausedCopy';
import { followingSwitch, openingLine, openingName, subscribeFollowingSwitch, subscribeFollowPulse, useFollowingSwitch } from '../../lib/canvasFollow';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';
import { isBackendOffline, refuseEditWhileOffline } from '../../lib/backendConnection';
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
  // GM, round 14 of PR #114: while offline "Save failed · Retry" hides (the
  // banner says it); a retry couldn't reach Nebula anyway.
  const offline = useBackendOffline();
  const [draft, setDraft] = useState<string | null>(null);
  // Round 20 (GM follow-up 1): while the tab follows an agent's switch the
  // bar says "Opening “<project>”…" where the save state is. It never gets
  // narrower than it was as the follow starts (measured then), and grows to
  // fit the name (fix round 1 of PR #200, GM bug 1: only a name past 24
  // characters is cut).
  const following = useFollowingSwitch();
  const bar = useRef<HTMLDivElement | null>(null);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);
  // Measured when the follow starts, before the bar redraws with the line.
  useEffect(() => subscribeFollowingSwitch(() => {
    const measured = bar.current?.getBoundingClientRect().width ?? null;
    setLockedWidth((width) => (followingSwitch() ? width ?? measured : null));
  }), []);
  // A refused edit nudges the line (lib/canvasFollow.ts pulseFollowing).
  const [pulse, setPulse] = useState(0);
  useEffect(() => subscribeFollowPulse(() => setPulse((count) => count + 1)), []);
  if (!project || screen !== 'workspace') return null;
  const finishRename = (save: boolean) => {
    const name = draft?.trim() ?? '';
    if (save && name && name !== project.name) void useProjectStore.getState().rename(project.id, name);
    setDraft(null);
  };
  const label = status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : status === 'unsaved' ? 'Unsaved changes' : 'Saved';
  return (
    <div ref={bar} className={`project-workspace-controls${following ? ' project-workspace-controls--following' : ''}`}
      // GM round 22 (B): while following, the whole bar names the project
      // being opened in full (its tooltip and label); the slot may cut it.
      {...(following ? { role: 'group', title: openingLine(following.projectName), 'aria-label': openingLine(following.projectName) } : {})}
      style={following && lockedWidth ? { minWidth: lockedWidth } : undefined}>
      <button type="button" className="project-workspace-controls__home" aria-label={homeBusy ? 'Saving…' : 'Back to projects'}
        aria-busy={homeBusy || undefined} title="Projects" disabled={busy}
        onClick={(event) => (onHome ? onHome(event.currentTarget) : void useProjectStore.getState().goHome())}>
        <Home size={16} aria-hidden="true" />
        {homeBusy && <span className="project-workspace-controls__busy">Saving…</span>}
      </button>
      {following
        // GM round 21 (item 1): the old project's name goes; the name slot
        // reads "Opening “<project>”…", the name in full. Only a name past
        // 24 characters is cut inside itself (openingName), keeping the
        // closing quote and ellipsis; the title and label keep all of it.
        ? <span key={pulse} className={`project-workspace-controls__opening${pulse > 0 ? ' project-workspace-controls__opening--pulse' : ''}`}
            role="status" title={openingLine(following.projectName)} aria-label={openingLine(following.projectName)}>
            <span className="project-workspace-controls__opening-fixed" aria-hidden="true">Opening “</span>
            <span className="project-workspace-controls__opening-name" aria-hidden="true">{openingName(following.projectName)}</span>
            <span className="project-workspace-controls__opening-fixed" aria-hidden="true">”…</span>
          </span>
        : draft !== null
        ? <input className="project-workspace-controls__name project-workspace-controls__name-input" aria-label="Project name"
            autoFocus maxLength={120} value={draft} onFocus={(event) => event.target.select()}
            // Offline (round 15 of PR #114): disabled with its draft kept, as a node's rename.
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
        // Q118 (GM): the persistent state, where "Saved" usually is, in Save
        // failed's warning colour; it opens the "what's large" panel.
        ? <button type="button" className="project-workspace-controls__retry project-workspace-controls__paused"
            data-size-status="" title={HEADER_TOOLTIP} aria-haspopup="dialog" aria-expanded={panelOpen}
            onClick={() => useProjectStore.getState().openSizePanel()}>{headerLine(pausedBytes)}</button>
        : status === 'error' && offline ? null
        : status === 'error'
        // Round 3b: this Retry saves, so its tooltip is the save's own failure
        // (short: the button is the retry), never another action's.
        ? <button type="button" className="project-workspace-controls__retry" title={saveError ? shortLine(saveError) : 'Retry saving'}
            onClick={() => void useProjectStore.getState().retrySave()}>Save failed · Retry</button>
        : <span className={`project-workspace-controls__status${status === 'saved' ? ' project-workspace-controls__status--settled' : ''}`}
            role="status">{label}</span>}
      {/* While following, the save state and the count (the canvas that is going) give their room to the
          opening line, which takes the whole slot at the locked width (GM round 22, B). */}
      {!following && <span className="project-workspace-controls__count">{nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}</span>}
    </div>
  );
}
