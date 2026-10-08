import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import '../styles/workspace-header.css';

interface WorkspaceHeaderProps {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  backDisabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/** One current workspace identity, with its actual return destination. */
export function WorkspaceHeader({ title, onBack, backLabel = 'Canvas', backDisabled = false,
  className = '', children }: WorkspaceHeaderProps) {
  return (
    <header className={`workspace-header ${className}`} aria-label="Workspace">
      <div className="workspace-header__identity">
        {onBack && <button type="button" className="workspace-header__back" onClick={onBack}
          disabled={backDisabled} aria-label={`Back to ${backLabel}`}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{backLabel}</span>
        </button>}
        <h1 className="workspace-header__title" data-workspace-heading tabIndex={-1}>{title}</h1>
      </div>
      {children && <div className="workspace-header__actions">{children}</div>}
    </header>
  );
}
