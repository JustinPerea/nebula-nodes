import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { InspectorFootContext } from './inspectorFootContext';

/** Renders the Inspector's foot row in the popover's foot when there is one (inspectorFootContext.ts). */
export function InspectorFoot({ children }: { children: ReactNode }) {
  const foot = useContext(InspectorFootContext);
  return foot ? createPortal(children, foot) : <>{children}</>;
}
