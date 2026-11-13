import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ModalPortal } from '../ModalPortal';
import { useCanvasLock } from '../../lib/canvasLock';
import { usePersonLock } from '../../hooks/usePersonLock';
import { PersonLockLine } from '../PersonLock';
import { emptyTrashLine } from '../../lib/projectPurgeCopy';
import { isKeptUpdateLine, useProjectStore } from '../../store/projectStore';
import { LineText } from '../LineText';
import { CHOOSE_A_PROJECT_TO_DELETE, KEPT_SOURCE_DELETE_LINE } from './restoreCopyCore';
import { ProjectCounts } from './projectFacts';
import { editedDate } from './editedDate';
import { useAlertDialog } from './useAlertDialog';
import '../../styles/prompt-dialog.css';
import './KeptDeleteChooser.css';

export const CLOSE_CHOOSER = 'Close';
export const EMPTY_RECENTLY_DELETED = 'Empty Recently deleted';

/**
 * GM r24 (b) on PR #199: the kept save the project limit or the storage cap
 * refused is fixed by deleting, and kept mode locks Projects, so the notice's
 * [Choose a project to delete] opens this: each project with its Delete
 * (it goes to Recently deleted with the app's Undo toast, as Projects
 * home's Delete does, and Projects can restore it), and, when
 * Recently deleted has items, [Empty Recently deleted] (the storage cap's
 * other cure; deleting for good is the person's alone, so it asks first and
 * locks as Projects does). The same modal rules as the Discard confirm
 * (useAlertDialog). Nothing here saves: the person presses [Save as a
 * project] again once there is room.
 */
export function KeptDeleteChooser({ onClose, returnTo }: { onClose: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const headingId = useId();
  const projects = useProjectStore((state) => state.projects);
  const trash = useProjectStore((state) => state.trash);
  const busy = useProjectStore((state) => state.busy);
  // The kept canvas's own project: its Delete is refused by the store (PR #199 r27), so it shows
  // disabled with the reason instead of a button that can only fail.
  const sourceId = useProjectStore((state) => state.keptEdits?.sourceId ?? null);
  const activeId = useProjectStore((state) => state.activeProject?.id ?? null);
  // A failure of this dialog's own actions (Delete refused as out of date or held, Undo, Empty), in the
  // words the store gives it: projectStore.error is only drawn on Projects home, which kept mode locks.
  const failure = useProjectStore((state) => (isKeptUpdateLine(state.error) ? null : state.error));
  // Cleared on open (an older failure isn't this dialog's) and on close (no surface draws it after,
  // so it would surface later on Projects home as a stale line; PR #199 r27 check).
  useEffect(() => {
    const clearOwnFailure = () => {
      const { error } = useProjectStore.getState();
      if (error && !isKeptUpdateLine(error)) useProjectStore.setState({ error: null, errorDetails: null, errorRetry: null });
    };
    clearOwnFailure();
    return clearOwnFailure;
  }, []);
  const lock = useCanvasLock();
  const purgeLock = usePersonLock('delete projects for good');
  const [armed, setArmed] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Escape disarms an armed Empty first, as the app's Empty does, and only then closes the dialog.
  useAlertDialog({ overlay, card, initialFocus: close, onClose: () => { if (armed) setArmed(false); else onClose(); }, returnTo });
  const held = busy || lock.offline;
  const detail = emptyTrashLine(trash);
  const prompt = `Delete ${trash.length === 1 ? 'this project' : `all ${trash.length} projects`} for good?${detail ? ` ${detail}` : ''}`;
  return (
    <ModalPortal>
      <div ref={overlay} className="prompt-dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}>
        <div ref={card} className="prompt-dialog__card kept-delete-chooser" role="dialog" aria-modal="true"
          aria-labelledby={headingId} data-kept-delete-chooser="">
          <h2 id={headingId} className="prompt-dialog__heading">{CHOOSE_A_PROJECT_TO_DELETE}</h2>
          <ul className="kept-delete-chooser__list">
            {projects.map((project) => {
              const keptSource = project.id === sourceId || project.id === activeId;
              return (
              <li key={project.id} className="kept-delete-chooser__row">
                <span className="kept-delete-chooser__facts">
                  <span className="kept-delete-chooser__name">{project.name}</span>
                  <span className="kept-delete-chooser__meta">{editedDate(project.updatedAt)} · <ProjectCounts project={project} /></span>
                  {keptSource && <span className="kept-delete-chooser__why" data-kept-source-why="">{KEPT_SOURCE_DELETE_LINE}</span>}
                </span>
                <span className="prompt-dialog__actions">
                  <button type="button" className="kept-delete-chooser__delete" aria-label={`Delete ${project.name}`} title={keptSource ? KEPT_SOURCE_DELETE_LINE : 'Move to Recently deleted'} disabled={held || keptSource}
                    data-kept-delete-project={project.id} onClick={() => void useProjectStore.getState().remove(project.id)}>Delete</button>
                </span>
              </li>
              );
            })}
          </ul>
          {failure && <p className="kept-delete-chooser__error" role="alert" data-kept-chooser-error=""><LineText text={failure} /></p>}
          {/* Delete is the app's own: it moves the project to Recently deleted and the notice's Undo toast
              (KeptEditsNotice, which stays when this closes) offers Undo, as Projects home's does. */}
          {trash.length > 0 && (
            <div className="kept-delete-chooser__trash" role="group" aria-label="Recently deleted">
              {armed ? (
                <>
                  <span className="kept-delete-chooser__prompt">{prompt}</span>
                  <PersonLockLine lock={purgeLock} place="control" />
                  <div className="prompt-dialog__actions">
                    <button type="button" autoFocus disabled={busy} onClick={() => setArmed(false)}>Cancel</button>
                    <button type="button" className="prompt-dialog__danger" disabled={held} {...purgeLock.control()} data-kept-empty-confirm=""
                      onClick={() => { setArmed(false); if (!purgeLock.locked) void useProjectStore.getState().emptyTrash(); }}>
                      {trash.length === 1 ? 'Delete forever' : 'Delete all'}</button>
                  </div>
                </>
              ) : (
                <div className="prompt-dialog__actions">
                  <button type="button" className="kept-delete-chooser__trigger--danger" disabled={held} {...purgeLock.control()} data-kept-empty=""
                    onClick={() => { if (!purgeLock.locked) setArmed(true); }}>{EMPTY_RECENTLY_DELETED}</button>
                </div>
              )}
            </div>
          )}
          <div className="prompt-dialog__actions">
            <button type="button" ref={close} onClick={onClose} data-kept-delete-close="">{CLOSE_CHOOSER}</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
