import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { COMMONS_OFF_COPY } from '../../lib/errorCopy';
import { PAGE_LINES_ATTR } from '../../lib/lineAttrs';
import { useBackendOffline } from '../../lib/useBackendOffline';
import { workspaceLabel } from '../../lib/workspaceLabel';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { CommonsErrorLine } from './CommonsErrorLine';
import { clearCommonsHash } from '../../lib/commonsRoute';
import '../../styles/commons.css';

/**
 * PR #204 round 18d (GM r31 layout M, GM r32 1): the Commons while the backend runs without it.
 * The header keeps only the way back, the title and Updates (no sections, Add to, Add, status,
 * Start or Stop), and the page row says "Commons is turned off for this Nebula." Its line hides
 * beside "Nebula is offline", as every load's line does (GM r23 3); the view stays.
 * `CommonsOffHeader` is the Commons view's own off state; `CommonsOffView` is the screen a tab
 * opened on the Commons shows when the backend said it runs without it (App), with nothing of
 * the Commons read or sent.
 */
export function CommonsOffLine() {
  const offline = useBackendOffline();
  if (offline) return null;
  return (
    <div className="commons-messages" {...{ [PAGE_LINES_ATTR]: '' }}>
      <CommonsErrorLine line={COMMONS_OFF_COPY} />
    </div>
  );
}

export function CommonsOffView() {
  const returnView = useUIStore((s) => s.commonsReturnView);
  const leave = () => {
    useUIStore.getState().exitCommons();
    clearCommonsHash();
  };
  return (
    <div className="commons-view-root">
      <div className="commons-view commons-scope" data-commons-off="">
        <WorkspaceHeader title="Commons" backLabel={workspaceLabel(returnView)} className="commons-toolbar"
          onBack={leave} onHome={() => { leave(); void useProjectStore.getState().goHome(); }} />
        <CommonsOffLine />
      </div>
    </div>
  );
}
