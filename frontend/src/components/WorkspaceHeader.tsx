import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ProjectWorkspaceControls } from './projects/ProjectWorkspaceControls';
import '../styles/workspace-header.css';

interface WorkspaceHeaderProps {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  backDisabled?: boolean;
  className?: string;
  navigation?: ReactNode;
  children?: ReactNode;
}

/** One current workspace identity, with its actual return destination. */
export function WorkspaceHeader({ title, onBack, backLabel = 'Canvas', backDisabled = false,
  className = '', navigation, children }: WorkspaceHeaderProps) {
  return (
    <header className={`workspace-header ${className}`} aria-label="Workspace">
      <div className="workspace-header__identity">
        <ProjectWorkspaceControls />
        {onBack && <button type="button" className={`workspace-header__back${navigation ? ' workspace-header__back--navigation' : ''}`} onClick={onBack}
          disabled={backDisabled} aria-label={`Back to ${backLabel}`} title={navigation ? `Back to ${backLabel}` : undefined}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span className={navigation ? 'workspace-header__navigation-label' : undefined}>{backLabel}</span>
        </button>}
        <h1 className={`workspace-header__title${navigation ? ' workspace-header__navigation-label' : ''}`} data-workspace-heading tabIndex={-1}>{title}</h1>
        {navigation}
      </div>
      {children && <div className="workspace-header__actions">{children}</div>}
    </header>
  );
}
