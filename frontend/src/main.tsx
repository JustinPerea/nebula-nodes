import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { projectFlowsModule } from './store/projectFlowsLoader';

// The project flows' chunk (store/projectFlows) starts loading before the
// first render, so its fetch overlaps it; a failure here is retried by the
// press that needs it (store/projectStore's stubs).
void projectFlowsModule.load().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
